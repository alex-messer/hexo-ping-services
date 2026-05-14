# Security Audit — hexo-ping-services v0.3.1

**Date:** 2026-05-13
**Scope:** Static read-only review of `lib/`, `scripts/`, `index.js`, `test/`, `package.json`.
**Method:** Two parallel read-only DeepDive agents — one focused on network/HTTP attack surface, one on state/concurrency/filesystem. Findings consolidated and deduplicated below.

## Executive summary

| Severity | Count |
|---|---|
| Critical | 1 |
| High     | 5 |
| Medium   | 7 |

One critical SSRF bypass undermines the entire IndexNow/XML-RPC/WebSub guard surface. Three high-severity filesystem issues sit in the lockfile/state-persistence path. Five medium findings are defense-in-depth hardening.

No runtime dependency vulnerabilities (`npm audit` clean as of audit date; devDeps only).

## Findings

### CRIT-01 — SSRF bypass via IPv4-mapped IPv6 addresses
**File:** `lib/url-guard.js:8-24`
**Attack:** `isPrivateHost` matches the literal `URL.hostname` string. URLs such as `http://[::ffff:169.254.169.254]/latest/meta-data/` produce `.hostname = "[::ffff:a9fe:a9fe]"`, which none of the private-range regexes match. The guard returns success; `assertPublicHttpUrl` lets the request proceed. All three engines (IndexNow, XML-RPC, WebSub) inherit this gap. In a CI/serverless build environment, attacker-controlled `_config.yml` entries reach AWS/GCP/Azure IMDS (`169.254.169.254`), loopback (`::ffff:7f00:1`), or RFC1918 (`::ffff:a00:1`, `::ffff:c0a8:101`).
**Mitigation:** In `isPrivateHost`, strip the `::ffff:` prefix (with or without brackets), extract the embedded IPv4 octets, and re-run the RFC1918/link-local/loopback checks against the unwrapped form.

### HIGH-01 — Production SSRF guard disabled by env var
**File:** `lib/url-guard.js:28-30, 42` (callers: all engines)
**Attack:** `HEXO_PING_ALLOW_PRIVATE_HOSTS=1` short-circuits every SSRF check. The variable is read from `process.env` unconditionally at every call site; the doc-comment "test-only" is not enforced. A misconfigured deployment, leaked CI secret, or compromised env injection completely disables SSRF protection.
**Mitigation:** Gate the bypass on `NODE_ENV === 'test'` (or an explicit `--allow-private` CLI flag). If the env var is set in any other context, emit a loud `stderr` warning. Reject silently following the flag in production.

### HIGH-02 — Symlink race on state-file temp write (TOCTOU)
**File:** `lib/state.js:115-116`
**Attack:** `refuseSymlink` is called on `filePath` but never on the `.tmp` sibling. `fs.writeFileSync(tmp, ...)` follows symlinks by default. An attacker with prior write access to the Hexo working directory can pre-create `.hexo-ping-state.json.tmp` as a symlink to any file writable by the Hexo process (e.g., `~/.ssh/authorized_keys`, a crontab). The next ping run overwrites the target with controlled JSON.
**Mitigation:** Call `refuseSymlink(tmp)` before write, or open the tmp fd directly with `O_CREAT | O_EXCL | O_WRONLY | O_NOFOLLOW` and stream the body to that fd; the existing `renameSync` then completes the atomic publish.

### HIGH-03 — Permanent DoS via stale lock (no recovery)
**File:** `lib/state.js:43-64`
**Attack:** The `.lock` file body is empty — no PID, no timestamp. If the holder is killed (SIGKILL, OOM, host shutdown), the lock persists. Every subsequent invocation spins 5 s and then throws `state lock timeout`. State persistence is permanently broken until an operator manually unlinks the lock.
**Mitigation:** Write `String(process.pid)` into the lock body. On `EEXIST`, read it back and probe liveness via `process.kill(pid, 0)`. If `ESRCH`, unlink and retry once. Bound retry depth to prevent infinite loops if the lock is re-acquired by another live process.

### HIGH-04 — State and temp files written world-readable (0644)
**File:** `lib/state.js:115-116`
**Attack:** `fs.writeFileSync(tmp, ...)` uses no `mode` argument; Node defaults to `0o666` masked by umask (typically `0o022` → `0o644`). On multi-tenant CI runners, any local user can read the full URL corpus, content hashes, and ping timestamps — production site topology leakage.
**Mitigation:** Pass `{ mode: 0o600 }` to the `writeFileSync` call. Verify the resulting `renameSync` preserves the restrictive mode (it does on Linux).

### HIGH-05 — XML-RPC response body has no size cap (memory exhaustion)
**File:** `lib/xmlrpc.js:44`
**Attack:** `resp.text()` buffers the entire response before the request `AbortController` 5 s timer fires. A malicious XML-RPC server streaming 128 MiB at line rate completes the buffer well under 5 s. In Hexo-on-Lambda or memory-constrained CI runners this is an OOM trigger.
**Mitigation:** Stream the response with a hard byte cap (64 KiB is sufficient for any well-formed XML-RPC `weblogUpdates.ping` reply); abort and discard on overflow.

### HIGH-06 — Outbound URL parameters not validated through SSRF guard
**File:** `lib/run.js:54-66`
**Attack:** `keyLocation`, `feedUrl`, and `websubFeedUrl` are built from `hexo.config.url + relative path` and embedded into outbound request bodies (IndexNow JSON, XML-RPC payload, WebSub `hub.url`). They are not validated by `assertPublicHttpUrl`. A `_config.yml` with `url: file:///etc/`, `url: http://169.254.169.254/`, or a `data:` scheme produces request bodies advertising internal URLs to third-party indexers — those indexers may then fetch the advertised URL as part of validation, leaking internal data.
**Mitigation:** Run `assertPublicHttpUrl` on each composed absolute URL before passing it into the engine functions.

### MED-01 — DNS rebinding not mitigated (acknowledged TOCTOU)
**File:** `lib/url-guard.js`
**Attack:** The guard validates the hostname string but never resolves it. A TTL-0 DNS record can return a public IP at validation and an internal IP at connect. The file's own comment acknowledges this. Risk is low in a one-shot CLI build; higher when `run_after_generate: true` is enabled in a long-lived cloud build process.
**Mitigation:** Use `dns.lookup()` to pre-resolve, validate the resulting IP(s) against the private-range list, then connect with `lookup` pinned to that IP (or pass `family`/`hints` to constrain). Standard library only — no new deps.

### MED-02 — `Retry-After` HTTP-date can encode far-future timestamps
**File:** `lib/indexnow.js:33-44`
**Attack:** `parseRetryAfter` accepts HTTP-date strings via `Date.parse()`. A year-9999 date produces a huge millisecond delta. Downstream `Math.min(retryMaxBackoffMs, ...)` clamps it for the retry path, but the unbounded value lives briefly in user code. Defense-in-depth issue.
**Mitigation:** Clamp the computed `when - Date.now()` to a hard ceiling (e.g., 300 s) inside `parseRetryAfter` itself.

### MED-03 — Terminal-escape injection in fault-string log
**File:** `scripts/console.js:32` (input source: `lib/xmlrpc.js:51`)
**Attack:** XML-RPC fault strings extracted via a permissive regex are written verbatim to stderr (`fault="${r.fault}"`). A malicious server can inject ANSI escape sequences (color spoofing, cursor moves, clear-screen) into operator logs and CI dashboards.
**Mitigation:** Strip or hex-escape non-printable characters before logging. A simple `s.replace(/[\x00-\x1f\x7f]/g, '?')` is sufficient.

### MED-04 — `__proto__` survives config merge as own property
**File:** `lib/config.js:33-39`
**Attack:** `Object.entries()` on a `JSON.parse`-derived object iterates `__proto__` as a regular string key. The recursive `merge` assigns it. Live tests show Node 22 does not actually mutate `Object.prototype`, but `__proto__` becomes an own enumerable on intermediate accumulators and is later silently dropped — surface area for future regression if the merge logic changes.
**Mitigation:** Skip keys matching `__proto__`, `constructor`, `prototype` at the top of the merge loop. Or use `Object.create(null)` as the accumulator.

### MED-05 — `__proto__` round-trips in state file via spread
**File:** `lib/state.js:111`
**Attack:** `{ ...fresh.urls }` preserves `__proto__` as an own enumerable property; `JSON.stringify` writes it back to disk. No prototype mutation today, but a future URL-lookup that does `urls[someKey]` could see unexpected entries and a future merge could legitimately propagate them.
**Mitigation:** Validate `fresh.urls` keys as URLs (`new URL(k)`) before spreading, or rebuild on `Object.create(null)`.

### MED-06 — Lock loop spins synchronously (blocks event loop)
**File:** `lib/state.js:36-38`
**Attack:** `sleepBusy` is a tight `while (Date.now() < end)` CPU spin. With `LOCK_TIMEOUT_MS = 5000` and 25 ms retries, a contested write blocks the event loop for up to 5 s — freezing all other timers, in-flight HTTP responses, and Hexo's own async work. Not a security issue per se but a reliability footgun, especially after a stale lock (HIGH-03).
**Mitigation:** Replace `sleepBusy` with `await new Promise(r => setTimeout(r, LOCK_RETRY_MS))`. Promotes `acquireLock` and `commit` to async — a public API change worth a minor version bump.

### MED-07 — Error message leaks absolute filesystem paths
**File:** `lib/run.js:18-20`
**Attack:** `resolveStateFilePath` throws an `Error` whose message embeds `baseAbs` and `stateAbs`. This propagates to stderr (`console.js:89`) and `this.log.warn` (`filter.js:13`). In hosted CI logs (publicly visible build outputs) this discloses the runner's container layout and home-directory name.
**Mitigation:** Log absolute paths at debug level only; the user-facing error message should reference the configured key (e.g., `ping.state_file`) and the relative form.

## Prioritized remediation roadmap

1. **Patch CRIT-01 immediately.** Without the IPv4-mapped IPv6 fix, every other URL-guard finding is moot — the guard is bypassable. Tracking commit should add a test case using `http://[::ffff:169.254.169.254]/`.
2. **Combine HIGH-02 + HIGH-04 in one commit** (`state.js` write path): add `O_NOFOLLOW`, `mode: 0o600`, and `refuseSymlink(tmp)`.
3. **Patch HIGH-03** (stale lock recovery). Pair with MED-06 (async sleep) in the same patch since both touch `acquireLock`/`commit`.
4. **Patch HIGH-01** (env-var gating). One-line check + warning.
5. **Patch HIGH-05** (XML-RPC body cap) and HIGH-06 (outbound URL validation) together — both about input we treat as trusted but aren't.
6. **Hardening sweep (MEDs)** as one PR: prototype guards (MED-04, MED-05), HTTP-date clamp (MED-02), log sanitization (MED-03), path-leak fix (MED-07), DNS rebinding mitigation (MED-01).

## Audit coverage

**Reviewed:**
- `index.js`
- `lib/url-guard.js`, `lib/indexnow.js`, `lib/xmlrpc.js`, `lib/websub.js`, `lib/config.js`, `lib/run.js`, `lib/collect-urls.js`, `lib/hash.js`, `lib/state.js`
- `scripts/console.js`, `scripts/filter.js`
- `test/url-guard.test.mjs`, `test/indexnow.test.mjs`, `test/helpers/mock-http.mjs`
- `package.json`; full diff of commit `54090db` (lockfile sidecar introduction)
- Live runtime probes for `O_EXCL` symlink behavior, prototype pollution via spread, regex backtracking, umask/file modes

**Not reviewed (low signal vs effort):**
- Remaining `test/*.test.mjs` — test code, not attack surface
- `coverage/tmp/*.json` — generated artefacts
- `node_modules/` — no runtime deps; `npm audit` clean (devDeps `c8`, `hexo` only)

## Constraints honored

Both DeepDive agents operated read-only. No file in the project tree was modified during the audit. All mitigations are described, not applied — application is left to the maintainer.
