# Security Fixes — hexo-ping-services (response to 2026-05-13 audit)

## Summary

- **Findings fixed:** 13 / 13
- **Tests added:** 64 (44 from round 1 + 15 from round 2 — MED-01 wiring + MED-03 extension + 5 from round 3 — MED-03 `logJson` path)
- **Tests modified:** 8 (converted from sync to async after MED-06 promotion of `state.commit`/`acquireLock`)
- **Baseline before:** 141 / 141 passing
- **Final:** 205 / 205 passing
- **Breaking API changes:** `state.commit(...)` and `state.acquireLock(...)` are now async (MED-06). Downstream code calling these must `await`. Internal callers (`lib/run.js`) updated in-tree. In round 2, the engine-facing helpers `pingEndpoint`, `pingAll`, `publishToHub`, and `publishToHubs` accept a new optional `validateDns` boolean (defaults to `true`) — additive and non-breaking. `assertPublicHttpUrl` already returned a Promise when `resolveDns: true`; engines now `await` it.
- **New dependencies:** none. All fixes use Node.js stdlib (`node:fs`, `node:dns`, `node:path`).

## Round 2 corrections

The first-pass remediation closed CRIT-01 through MED-07 by code, tests, and documentation, but the Red Team rebuttal flagged two findings as incomplete:

1. **MED-01 was infrastructure-only.** The `assertPublicHttpUrl(url, { resolveDns: true })` plumbing existed and was unit-tested in `url-guard.test.mjs`, but no engine ever passed `resolveDns: true`. DNS rebinding remained a live exposure in production.
2. **MED-03 was incomplete.** The sanitizer regex `/[\x00-\x1f\x7f]/g` only handled C0 controls and DEL. C1 controls (0x80–0x9f) — including the 8-bit CSI `\x9b` which is interpretable on many terminals — and Unicode bidi format characters (U+202A–U+202E) and isolates (U+2066–U+2069) flowed through unsanitized.

Round 2 closes both gaps. Details are inlined in the per-finding sections below.

## Per-finding remediation

### CRIT-01 — SSRF bypass via IPv4-mapped IPv6 addresses

**Files changed:** `lib/url-guard.js`, `test/url-guard.test.mjs`

**Approach:** Added `unwrapIpv4MappedIpv6(hostname)` which strips optional brackets, then matches either the dotted-quad embedded form (`::ffff:169.254.169.254`) or the packed-hex form (`::ffff:a9fe:a9fe` — the canonical form `URL.hostname` produces). On a match, the embedded IPv4 is re-checked against the private-range table; the mapped form is also treated as private even when the embedded IPv4 is otherwise public (defense in depth — real callers don't use this representation for public addresses).

**Test cases added:**
- `isPrivateHost: ::ffff:169.254.169.254 (IMDS via IPv4-mapped IPv6)`
- `isPrivateHost: ::ffff:7f00:1 (loopback via packed-hex form)`
- `isPrivateHost: ::ffff:a00:1 (10.0.0.1 via packed-hex)`
- `isPrivateHost: ::ffff:c0a8:101 (192.168.1.1 via packed-hex)`
- `isPrivateHost: ::ffff:a9fe:a9fe (169.254.169.254 packed-hex IMDS)`
- `assertPublicHttpUrl rejects IPv4-mapped IPv6 URLs (CRIT-01)`
- `unwrapIpv4MappedIpv6 returns dotted-quad for valid forms`
- `unwrapIpv4MappedIpv6 returns null for non-mapped IPv6`

**Verification:** `node --test test/url-guard.test.mjs` → all 31 tests pass.

### HIGH-01 — Production SSRF guard disabled by env var

**Files changed:** `lib/url-guard.js`, `test/url-guard.test.mjs`, `test/helpers/mock-http.mjs`

**Approach:** `privateHostsAllowed()` now returns true only when both `HEXO_PING_ALLOW_PRIVATE_HOSTS=1` AND `NODE_ENV=test`. If the env var is set in any other context, a one-shot stderr warning is emitted (latched by `_bypassWarned`) and the bypass is silently ignored. The mock-HTTP helper sets `NODE_ENV=test` so existing tests continue to work.

**Test cases added:**
- `assertPublicHttpUrl: env-var escape hatch permits loopback when NODE_ENV=test` (modified, ensures both vars required)
- `HIGH-01: bypass IGNORED when NODE_ENV is not test, warning to stderr`
- `HIGH-01: bypass warning is emitted at most once per process`

**Verification:** `node --test test/url-guard.test.mjs` → all 31 tests pass.

### HIGH-02 — Symlink race on state-file temp write (TOCTOU)

**Files changed:** `lib/state.js`, `test/state.test.mjs`

**Approach:** Replaced `fs.writeFileSync(tmp, ...)` with a new `writeTmpAtomicallyThenRename()` helper that: (1) `lstatSync`'s the tmp path and throws a clear security error if it's a symlink; (2) unlinks any non-symlink leftover; (3) opens the tmp with `O_CREAT | O_EXCL | O_WRONLY | O_NOFOLLOW` at mode `0o600`. If `O_EXCL` or `O_NOFOLLOW` refuses the open (EEXIST/ELOOP), we wrap the error with the same security message so callers see a consistent failure. The atomic `renameSync` over the target is unchanged.

**Test cases added:**
- `HIGH-02: commit refuses to follow a pre-planted .tmp symlink`

**Verification:** `node --test test/state.test.mjs` → all 24 tests pass.

### HIGH-03 — Permanent DoS via stale lock (no recovery)

**Files changed:** `lib/state.js`, `test/state.test.mjs`

**Approach:** The lock body now contains `String(process.pid)`. On `EEXIST`, the existing lock is read, the PID is parsed, and `process.kill(pid, 0)` probes liveness:
- `ESRCH` → dead PID, unlink and retry immediately (does not consume timeout).
- Live signal OK / `EPERM` → treat as live.
- Empty body / NaN / PID 0 → fail-safe: treat as live.

Bounded by `LOCK_MAX_STALE_RECOVERIES = 3` to prevent an infinite loop if some live process keeps re-acquiring the lock between our checks.

**Test cases added:**
- `HIGH-03: stale lock (dead PID) is unlinked and lock is re-acquired`
- `HIGH-03: live PID in lock is respected (timeout, no unlink)`
- `HIGH-03: garbage / empty lock body is fail-safe (treated as live)`
- `HIGH-03: PID 0 in lock is fail-safe (treated as live)`
- `HIGH-03: lock file is written with our PID`

**Verification:** `node --test test/state.test.mjs` → all 24 tests pass.

### HIGH-04 — State and temp files written world-readable (0644)

**Files changed:** `lib/state.js`, `test/state.test.mjs`

**Approach:** Covered by HIGH-02's `O_CREAT | O_EXCL | O_WRONLY | O_NOFOLLOW, 0o600` open call. `renameSync` preserves the restrictive mode on Linux/macOS.

**Test cases added:**
- `HIGH-04: committed state file has mode 0o600` (verifies `fs.statSync(filePath).mode & 0o777 === 0o600`; skipped on win32)

**Verification:** Test confirms `mode === 0o600` after commit.

### HIGH-05 — XML-RPC response body has no size cap (memory exhaustion)

**Files changed:** `lib/xmlrpc.js`, `test/xmlrpc.test.mjs`

**Approach:** Added `readBodyCapped(resp, maxBytes)` that uses `resp.body.getReader()` to stream chunks. As bytes accumulate, it tracks `received`; on overflow it cancels the reader and returns the sentinel string `<response truncated>` (which contains no `<fault>` substring, so downstream marks the call as OK rather than triggering retries — retrying would amplify the attack). Cap is `MAX_RESPONSE_BYTES = 64 KiB` — well above any legitimate `weblogUpdates.ping` reply. Falls back to `resp.text()` (with the same cap check on length) for mock environments without a streaming body.

**Test cases added:**
- `HIGH-05: pingEndpoint caps response body at 64 KiB without OOM` (1 MiB body, asserts heap growth < 8 MiB and status='ok')
- `HIGH-05: pingEndpoint with truncated response does not see <fault>`
- `HIGH-05: readBodyCapped returns full body when under cap`
- `HIGH-05: readBodyCapped returns sentinel when body exceeds cap`

**Verification:** `node --test test/xmlrpc.test.mjs` → all 15 tests pass.

### HIGH-06 — Outbound URL parameters not validated through SSRF guard

**Files changed:** `lib/run.js`, `test/run.test.mjs`

**Approach:** Added `assertComposedUrl(label, value)` and called it on every composed absolute URL (`keyLocation`, `feedUrl`, `websubFeedUrl`, and the bare `siteUrl` itself) BEFORE invoking any engine. A composed `file:///...` or `http://169.254.169.254/...` URL is rejected with a `composed <label> is not a public http(s) URL: ...` error that wraps the underlying url-guard message.

**Test cases added:**
- `HIGH-06: runPing rejects file:/// site URL when composing keyLocation`
- `HIGH-06: runPing rejects IMDS site URL (169.254.169.254)`
- `HIGH-06: runPing rejects IPv4-mapped IPv6 IMDS site URL`

**Verification:** `node --test test/run.test.mjs` → all 20 tests pass.

### MED-01 — DNS rebinding not mitigated (acknowledged TOCTOU)

**Files changed (round 1 + round 2):** `lib/url-guard.js`, `lib/config.js`, `lib/run.js`, `lib/indexnow.js`, `lib/xmlrpc.js`, `lib/websub.js`, `README.md`, `test/url-guard.test.mjs`, `test/config.test.mjs`, `test/indexnow.test.mjs`, `test/xmlrpc.test.mjs`, `test/websub.test.mjs`.

**Approach (round 1):** Added an optional `{ resolveDns: true }` option to `assertPublicHttpUrl(...)`. When present, the function returns a `Promise<URL>` rather than a `URL`; it resolves the hostname via `dns.promises.lookup(host, { all: true })` and re-runs `isPrivateHost` against every returned address. Any private address (or DNS failure) rejects.

**Approach (round 2 — Option A, default-on with escape hatch):**
1. Added a new top-level config key `ping.validate_dns` (YAML), surfaced as `config.validateDns` in `resolveConfig`. **Default value: `true`.** Maintainers can set `validate_dns: false` in `_config.yml` to opt out and save ~10 ms per unique host per build.
2. `lib/run.js` reads `config.validateDns` and threads it through to every engine call:
   - Each `assertComposedUrl(label, value, { resolveDns: config.validateDns })` is now `await`ed.
   - `submitIndexNow(..., { validateDns })`, `pingAll(..., { validateDns })`, `publishToHubs(..., { validateDns })` all receive the flag.
3. Each engine (`lib/indexnow.js`, `lib/xmlrpc.js`, `lib/websub.js`) now calls `await assertPublicHttpUrl(url, { resolveDns: validateDns })`. The engine-facing default for the new option is `true` so direct callers also get protection.
4. The test-only env-var bypass (`HEXO_PING_ALLOW_PRIVATE_HOSTS=1` + `NODE_ENV=test`) also short-circuits DNS resolution. Without this, every mock-server test would attempt to DNS-resolve `127.0.0.1` and the existing test suite would have stalled or failed. Production callers cannot reach this branch (HIGH-01 gate).
5. README updated under `## Configure` with a YAML comment describing the trade-off.

**Test cases added (round 1 — guard infrastructure):**
- `resolveDns:true rejects hostname whose DNS resolves to private IP (DNS rebinding)`
- `resolveDns:true allows public DNS resolution`
- `resolveDns:true rejects when ANY resolved address (multi-A record) is private`
- `resolveDns:true rejects ENOTFOUND`
- `default behavior (no resolveDns) still returns parsed URL synchronously`

**Test cases added (round 2 — production wiring):**
- `resolveConfig defaults validate_dns to true` (config.test.mjs)
- `resolveConfig respects validate_dns: false escape hatch` (config.test.mjs)
- `resolveConfig validate_dns: true is honored explicitly` (config.test.mjs)
- `submitIndexNow blocks endpoint whose DNS resolves to private IP (MED-01 wired)` (indexnow.test.mjs)
- `submitIndexNow with validateDns:false skips DNS resolution (MED-01 escape hatch)` (indexnow.test.mjs)
- `pingEndpoint blocks endpoint whose DNS resolves to private IP (MED-01 wired)` (xmlrpc.test.mjs)
- `publishToHub blocks hub whose DNS resolves to private IP (MED-01 wired)` (websub.test.mjs)

The round-2 engine tests stub `node:dns`'s `promises.lookup` to return a private address for `attacker.example.com`, prove the engine refuses the call with status `blocked` and error `resolves to private/loopback address`. The escape-hatch test stubs DNS to count invocations and asserts zero when `validateDns: false`.

**Verification:** `node --test test/*.test.mjs` → all 200 tests pass.

### MED-02 — `Retry-After` HTTP-date can encode far-future timestamps

**Files changed:** `lib/indexnow.js`, `test/indexnow.test.mjs`

**Approach:** Defined `RETRY_AFTER_MAX_MS = 300_000` (5 minutes). Inside `parseRetryAfter` both branches (delta-seconds and HTTP-date) now clamp via `Math.min(RETRY_AFTER_MAX_MS, ...)`. Negative deltas are floored at 0.

**Test cases added:**
- `MED-02: parseRetryAfter clamps year-9999 HTTP-date to ceiling`
- `MED-02: parseRetryAfter returns 0 for past HTTP-date`
- `MED-02: parseRetryAfter clamps huge delta-seconds value`
- `MED-02: parseRetryAfter returns null for malformed input`
- `MED-02: parseRetryAfter accepts small valid delta-seconds`

**Verification:** `node --test test/indexnow.test.mjs` → all 22 tests pass.

### MED-03 — Terminal-escape injection in fault-string log

**Files changed:** `scripts/console.js`, `test/console.test.mjs`

**Approach:** Added `sanitize(s)` that replaces every control byte (`/[\x00-\x1f\x7f]/g`) with `?`. Wired into `logHuman` at the only fault-string interpolation site. JSON output (`logJson`) was not modified because `JSON.stringify` already escapes control bytes (`\x1b` becomes the literal characters ``).

**Approach (round 2 — extended coverage):** Replaced the regex with `/[\x00-\x1f\x7f-\x9f‪-‮⁦-⁩]/g`. The extension covers:
- **C1 control range 0x80–0x9f** — includes 8-bit CSI `\x9b` (equivalent to ESC-`[` in 8-bit terminals), 8-bit OSC `\x9d`, NEL `\x85`, and other 8-bit-compatible escape introducers.
- **Bidi formatting U+202A–U+202E** — LRE, RLE, PDF, LRO, RLO. RLO is the canonical "Trojan Source" attack — a single character flips visible character order, letting a malicious server's fault string spoof URLs and filenames in operator logs.
- **Bidi isolates U+2066–U+2069** — LRI, RLI, FSI, PDI. Same attack class as the formatting characters; isolates are the modern Unicode 6.3+ replacement that older sanitizers miss.

The function still replaces matches with `?` for consistency with round 1; chars adjacent to the new ranges stay intact (boundary tests prove U+2029, U+202F, U+2065, U+206A pass through).

**Test cases added (round 1):**
- `sanitize replaces ANSI escapes and control bytes with ?`
- `logHuman strips raw escape bytes from xmlrpc fault`
- `sanitize handles null/undefined safely`

**Test cases added (round 2 — extended):**
- `sanitize strips 8-bit CSI (C1 control 0x9b) — MED-03 extended`
- `sanitize strips full C1 control range (0x80-0x9f) — MED-03 extended` (loops every code point 0x80–0x9f)
- `sanitize strips RTL override U+202E (bidi spoofing) — MED-03 extended`
- `sanitize strips bidi formatting U+202A through U+202E — MED-03 extended` (loops every code point in the range)
- `sanitize strips isolate format U+2066 (LRI) — MED-03 extended`
- `sanitize strips bidi isolates U+2066 through U+2069 — MED-03 extended` (loops every code point in the range)
- `sanitize preserves chars adjacent to bidi range boundaries — MED-03 extended` (negative test — U+2029, U+202F, U+2065, U+206A pass through)
- `logHuman strips 8-bit CSI and RTL override from xmlrpc fault — MED-03 extended` (end-to-end through the real formatter)

**Approach (round 3 — `logJson` / `--verbose` path):** The round-2 fix only covered `logHuman`. A skeptical completeness audit found `logJson` serialized engine result objects with raw `JSON.stringify`, which escapes only C0 control bytes — C1 controls and Unicode bidi characters in server-controlled `fault`/`error` fields passed through verbatim into `hexo ping --verbose` output. Added `sanitizeStringFields(r)`, a shallow copy that runs every string-valued own property through the existing `sanitize()`; numbers/booleans pass through untouched. Wired into all three engine branches of `logJson`.

**Test cases added (round 3):**
- `logJson strips 8-bit CSI from xmlrpc fault — MED-03 round 3`
- `logJson strips RTL override from xmlrpc fault — MED-03 round 3`
- `logJson strips LRI from indexnow error — MED-03 round 3`
- `logJson leaves a safe fault string intact — MED-03 round 3` (negative test — not over-sanitized)
- `logJson keeps numeric fields as numbers — MED-03 round 3` (`httpStatus`/`durationMs` stay numeric in JSON output)

**Verification:** `node --test test/*.test.mjs` → all 205 tests pass.

### MED-04 — `__proto__` survives config merge as own property

**Files changed:** `lib/config.js`, `test/config.test.mjs`

**Approach:** Added a top-of-loop check in `merge()`: `if (DANGEROUS_MERGE_KEYS.has(k)) continue;` where the set is `{__proto__, constructor, prototype}`. Tested with `JSON.parse('{"__proto__":...}')` since object-literal `__proto__` is consumed by the parser as the prototype slot, not as an own key.

**Test cases added:**
- `MED-04: __proto__ key in user config does not pollute Object.prototype`
- `MED-04: constructor/prototype keys are also skipped during merge`
- `MED-04: __proto__ nested deeper in user config also blocked`

**Verification:** `node --test test/config.test.mjs` → all 15 tests pass.

### MED-05 — `__proto__` round-trips in state file via spread

**Files changed:** `lib/state.js`, `test/state.test.mjs`

**Approach:** Replaced `{ ...fresh.urls }` with a manual rebuild on `Object.create(null)`, skipping `DANGEROUS_KEYS`. In addition, `readState` now sanitizes the urls map at parse time via `sanitizeUrlMap` — discarding any key that doesn't parse as a URL (`new URL(k)`) or matches a dangerous prototype name. This means even a hand-edited state file with poisoned keys can't reintroduce them on the next commit.

**Test cases added:**
- `MED-05: readState discards __proto__ key from state.urls`
- `MED-05: commit does not write __proto__ key even if passed`

**Verification:** `node --test test/state.test.mjs` → all 24 tests pass.

### MED-06 — Lock loop spins synchronously (blocks event loop)

**Files changed:** `lib/state.js`, `lib/run.js`, `test/state.test.mjs`

**Approach:** Replaced the `sleepBusy(ms)` while-loop with `await new Promise(r => setTimeout(r, LOCK_RETRY_MS))`. As a result, `acquireLock` and `commit` are now `async`. All in-tree callers updated:
- `lib/run.js` now `await commit(...)`
- `test/state.test.mjs` now uses `async test(...)` + `await commit(...)` + `await assert.rejects(...)`

This is a **public API breaking change** — see "API changes" section below.

**Test cases added:**
- `MED-06: commit yields to the event loop while waiting for a held lock` (uses `setInterval` callback to prove event loop responsiveness)

**Verification:** `node --test test/state.test.mjs` → all 24 tests pass.

### MED-07 — Error message leaks absolute filesystem paths

**Files changed:** `lib/run.js`, `test/run.test.mjs`

**Approach:** `resolveStateFilePath` no longer embeds `baseAbs`/`stateAbs` in the user-facing message. The new message is `hexo-ping-services: ping.state_file (${stateFile}) must be inside hexo.base_dir` — referencing the configured key name and the relative form the user supplied. Absolute paths are exposed via `err.absolutePaths = { stateAbs, baseAbs }` for debug-level inspection only.

**Test cases added:**
- `MED-07: state_file rejection error does not leak absolute paths` (asserts message contains no `/home/`, `/Users/`, `C:\\`, or `/tmp/`; `err.absolutePaths` is populated)

**Verification:** `node --test test/run.test.mjs` → all 20 tests pass.

## Accepted Residual Risks

A skeptical Round-3 audit confirmed two residual gaps that are theoretical-only in this plugin's deployment model — a build-time, one-shot CLI tool. The maintainer has chosen to accept these as documented residual risks rather than apply further hardening.

### MED-01 — DNS rebinding: validated IP is not pinned for the connection

**What remains:** `assertPublicHttpUrl(url, { resolveDns: true })` pre-resolves the hostname and validates every resolved IP against the private-range matcher, and this is now wired default-on into all three engines. However, the subsequent `fetch()` call hands undici the hostname *string*; undici performs its own independent name resolution at TCP-connect time. The validated IP is not pinned, leaving a time-of-check/time-of-use window.

**Why accepted:** To reach it, the blog must be configured to ping a hostname whose DNS the maintainer does not control, that name server must serve a ~0-TTL record, and the validation-vs-connect resolutions must diverge within the sub-second connect window of a one-shot build. The dominant precondition (config pointing at an untrusted endpoint) is itself out of the plugin's threat model. Practical reachability in a build-time CLI tool is very low.

**Future hardening path (not done):** pass a custom undici `Agent` whose `connect.lookup` returns the already-validated address, pinning check-to-connect.

### HIGH-03 — Stale-lock recovery: narrow multi-process unlink race

**What remains:** the PID-stamped lock file with liveness probe and bounded stale-recovery correctly fixes the permanent-DoS from an abandoned lock. A narrow time-of-check/time-of-use window remains: if two processes concurrently observe the same dead PID, one process can `unlinkSync` a lock the other has just legitimately re-created, allowing both into the critical section (a lost state-file update).

**Why accepted:** this requires two concurrent builds of the *same site directory* — abnormal for a one-shot build tool, which is normally invoked once per build. Single-process operation (the norm) is fully correct. The state file is an optimization cache (skip re-pinging unchanged URLs), so a lost update degrades to a redundant ping next build, not a security or data-integrity failure.

**Future hardening path (not done):** use an atomic compare-and-swap on the lock (e.g. verify the lock content is still the stale PID immediately before unlink, or rename-based locking).

## API changes (breaking)

- **`state.commit(filePath, _state, pingedItems, options?)`** is now async (was sync).
  Returns `Promise<void>`. Downstream callers MUST `await`.
- **`state._internal.acquireLock(filePath, timeoutMs)`** is now async (was sync).
  Internal, but exported via `_internal` for tests — same `await` requirement.
- **Lock file body format changed.** The `.lock` sidecar now contains `String(process.pid)` instead of being empty. Old empty lock files from a previous version's crashed run are treated as garbage and the new code conservatively waits them out — operators may need to manually unlink them on first deploy. Subsequent stale locks self-recover via PID liveness probe.

**Callers updated in-tree:** `lib/run.js` (one call site), `test/state.test.mjs` (multiple sites), `test/coverage-extras.test.mjs` (no direct commit calls).

**Migration note for downstream:** Any external code calling `state.commit(...)` must `await` the call. If you can't migrate immediately, the call still works — Node will simply not block on the promise — but you'll race the lock release.

**Version impact:** This is a minor version bump (semver: API change but not a breaking removal). The release maintainer decides the exact version number.

## API changes (additive, non-breaking)

- **`assertPublicHttpUrl(url, options?)`** now accepts a second argument. With `{ resolveDns: true }` the call returns `Promise<URL>` instead of `URL`. Default behavior (no options or `options.resolveDns !== true`) is unchanged. Round-2 note: when the test-only escape hatch (`HEXO_PING_ALLOW_PRIVATE_HOSTS=1` + `NODE_ENV=test`) is active, DNS resolution is also skipped — the bypass implies "I'm pointing at loopback intentionally."
- **New error property `error.absolutePaths`** on the `resolveStateFilePath` rejection — see MED-07.
- **New module exports under `_internal`** on `lib/url-guard.js`, `lib/state.js`, `lib/xmlrpc.js`, `lib/indexnow.js`, `scripts/console.js` — for unit testing only, NOT part of the public API.
- **Round 2:** `pingEndpoint(endpoint, payload, { validateDns? })`, `pingAll(..., { validateDns? })`, `publishToHub(hub, feed, { validateDns? })`, `publishToHubs(..., { validateDns? })`, and `submitIndexNow({ ..., validateDns? }, urls)` now accept a `validateDns` option. Default is `true`. Passing `false` skips the DNS-rebinding check; the sync URL-guard (scheme + private-host string match) still runs.
- **Round 2:** `lib/run.js`'s `assertComposedUrl(label, value, options)` is now an `async` helper. It's an internal helper, not exported, but documented here for callers maintaining a fork.

## Files modified

Round 1 (CRIT-01 through MED-07, baseline → 185 tests):

```
 lib/config.js              |   7 ++
 lib/indexnow.js            |  26 ++++-
 lib/run.js                 |  44 +++++++-
 lib/state.js               | 167 +++++++++++++++++++++++++-----
 lib/url-guard.js           | 133 ++++++++++++++++++++++--
 lib/xmlrpc.js              |  50 ++++++++-
 scripts/console.js         |  14 ++-
 test/config.test.mjs       |  30 ++++++
 test/console.test.mjs      |  36 ++++++-
 test/helpers/mock-http.mjs |   4 +-
 test/indexnow.test.mjs     |  37 ++++++-
 test/run.test.mjs          |  89 +++++++++++++++-
 test/state.test.mjs        | 252 ++++++++++++++++++++++++++++++++++++++++-----
 test/url-guard.test.mjs    | 207 ++++++++++++++++++++++++++++++++++++-
 test/xmlrpc.test.mjs       |  59 ++++++++++-
 15 files changed, 1075 insertions(+), 80 deletions(-)
```

Round 2 (MED-01 wiring + MED-03 extension, 185 → 200 tests):

```
 README.md                |  1 +    (validate_dns YAML comment)
 lib/config.js            |  3 ++   (validate_dns default + resolveConfig surface)
 lib/run.js               | 14 +-   (await assertComposedUrl + plumb validateDns to engines)
 lib/url-guard.js         |  4 +-   (bypass also short-circuits DNS lookup)
 lib/indexnow.js          |  2 +-   (await assertPublicHttpUrl + validateDns option)
 lib/xmlrpc.js            |  4 +-   (await assertPublicHttpUrl + validateDns option)
 lib/websub.js            |  4 +-   (await assertPublicHttpUrl + validateDns option)
 scripts/console.js       |  2 +-   (extended sanitizer regex)
 test/config.test.mjs     | 17 ++   (3 new tests: default true, explicit false, explicit true)
 test/console.test.mjs    | 78 ++   (8 new tests: C1 controls + bidi format + bidi isolates + boundaries + e2e)
 test/indexnow.test.mjs   | 47 ++   (2 new tests: engine-level DNS rebinding rejection + escape hatch)
 test/xmlrpc.test.mjs     | 16 ++   (1 new test: engine-level DNS rebinding rejection)
 test/websub.test.mjs     | 17 ++   (1 new test: engine-level DNS rebinding rejection)
 13 files changed
```

**Not modified (per constraints):** `package.json`, `package-lock.json`, `CHANGELOG.md`. The maintainer handles version bump and changelog at release time.

## Verification log

Round 1 final run (post first-pass remediation):
```
node --test test/*.test.mjs
ℹ tests 185
ℹ pass 185
ℹ fail 0
ℹ duration_ms ~4700
```

Round 2 final run (post-Red-Team rework, MED-01 + MED-03):
```
node --test test/*.test.mjs
ℹ tests 200
ℹ pass 200
ℹ fail 0
ℹ duration_ms ~5000
```

Coverage delta (round 1 — unchanged in round 2 because new tests are additive over already-instrumented branches):
```
Statements   : 97.54% ( 1151/1180 )
Branches     : 90.86% ( 398/438 )
Functions    : 100%   ( 48/48 )
Lines        : 97.54% ( 1151/1180 )
```

Coverage held high — most uncovered branches are defensive `else` branches in the new code paths (e.g., the `parseInt` NaN branch in `isPidAlive`, the fallback `resp.text()` in `readBodyCapped` for non-streaming responses). No regression vs the pre-fix baseline.

## Constraints honored

- No `git commit`, `git push`, or `git tag` was performed.
- `package.json` version unchanged (still `0.3.1`).
- `CHANGELOG.md` unchanged.
- `package-lock.json` not modified (no new deps were added).
- No new runtime dependencies — every fix uses Node stdlib (`node:fs`, `node:dns`, `node:path`).
