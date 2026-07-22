# Changelog

All notable changes to `hexo-ping-services` are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.4] - 2026-07-22

### Security

- **`brace-expansion` DoS pin** (GHSA-3jxr-9vmj-r5cp). Added an `overrides` entry pinning
  the transitive `brace-expansion` dependency (pulled in via `c8` → `minimatch`) to
  `>=5.0.7`, closing an exponential-time DoS in `expand()`. Dev-tooling only; never
  shipped in the published package.
- **`js-yaml` quadratic-DoS fix** (GHSA-h67p-54hq-rp68). Transitively resolved to `4.3.0`
  (patched) via the devDependency upgrade below. Dev-tooling only.

### Changed

- Upgraded devDependencies to latest: `@commitlint/cli` 21.2.1, `@commitlint/config-conventional`
  21.2.0, `c8` 12.0.0 (major), `lefthook` 2.1.10, `oxlint` 1.75.0.
- Regenerated `package-lock.json` under Node 22/npm 10 so `npm ci` passes cleanly on both
  CI matrix legs (Node 22 and Node 24) — npm 10's stricter lockfile validation was rejecting
  a lockfile last written by npm 11.
- Corrected README: fixed stale test count, removed outdated version-pin/git-source install
  snippets, switched CLI examples from `pnpm exec` to `npx`.

## [0.3.3] - 2026-05-15

### Security

- **SSRF bypass via 6to4 / IPv4-compatible / NAT64 IPv6 encodings** (R1-F1, High).
  `lib/url-guard.js` now unwraps and rejects three additional IPv6 encoding schemes
  that embed private IPv4 addresses: RFC 3056 6to4 (`2002::/16`), RFC 4291 IPv4-compatible
  (`::a.b.c.d`, deprecated), and RFC 6052 NAT64 (`64:ff9b::/96`). With `validate_dns: true`
  (the default), DNS lookup already blocked these; with `validate_dns: false` (explicit opt-out),
  they now fail the synchronous pattern check before reaching the resolver.

- **Body-read Slowloris DoS via missing timeout** (R1-F2, Medium). `lib/http-client.js`
  no longer clears the request timeout when response headers arrive. A malicious or slow
  server that sends headers then drips the body byte-by-byte can no longer hold a worker
  thread indefinitely. The AbortController deadline now covers both header and body phases.

- **Terminal injection via unescaped endpoint/hub URLs** (R1-F3, Medium). `scripts/console.js`
  now sanitizes `r.endpoint` and `r.hub` fields in human-readable output, preventing ANSI
  escape sequences and control characters embedded in `_config.yml` from executing on the
  operator's terminal or in CI logs.

- **Log-line injection via U+2028/U+2029** (R1-F4, Low). `scripts/console.js` now strips
  LINE SEPARATOR and PARAGRAPH SEPARATOR Unicode codepoints from output, closing a
  log-splitting vector alongside the prior bidi-override fixes.

### Changed

- **Removed unimplemented CLI flags** (R1-F5, Info). The `--since` and `--no-state` command-line
  options were parsed but never wired into the ping logic, creating silent no-op behavior.
  Both have been removed from the parser and help text. If/when they are implemented,
  both the parser entry, help text, and runPing wiring should be added in the same commit.

### Coverage

- 228 tests (216 prior + 13 new R1 regression tests; -1 empty placeholder
  `test/scripts.test.mjs` removed). All regression tests for R1-F1 through
  R1-F5 pass. Functions 100%, lines ≥99.8%.

### Cleanup (Bottom-Up principles pass)

- **YAGNI**: removed empty `test/scripts.test.mjs` placeholder; removed
  unused `let calls = 0` and `calls++` in `test/indexnow.test.mjs` (declared
  but never asserted).
- **DRY**: extracted the worker-pool pattern duplicated in `lib/xmlrpc.js`
  (`pingAll`) and `lib/websub.js` (`publishToHubs`) into a single
  `lib/pool.js#parallelMap(items, task, concurrency)` helper. Both engines
  now delegate; positional-index result semantics and empty-input
  short-circuit preserved.
- **Clean code**: applied `oxlint --fix` — six `unicorn/prefer-string-starts-ends-with`
  rewrites in `lib/url-guard.js` (regex anchors → `String#startsWith` for
  literal prefixes; complex `172.16-31.*.*` pattern intentionally kept as
  regex) and two `unicorn/no-useless-fallback-in-spread` simplifications in
  `test/coverage-extras.test.mjs` + `test/run.test.mjs`. Lint now reports
  0 warnings / 0 errors.

### Maintenance

- Bumped `c8` devDependency from `^10.1.0` to `^11.0.0` (latest). `hexo`
  devDependency stays at `^8.1.2` (latest). Coverage runner now requires
  Node `20 || >=22` matching c8 11's engine declaration; the package's own
  `engines.node` floor remains `>=22` per the previous release. Runtime has
  zero dependencies, so end-users are unaffected.

### Tooling

- Added `lefthook` (`^2.1.6`), `oxlint` (`^1.65.0`), `@commitlint/cli` and
  `@commitlint/config-conventional` (`^21.0.1`) as devDependencies — all
  runtime-zero-dep promise preserved (none are bundled).
- New npm scripts: `lint` (`oxlint`), `lint:fix` (`oxlint --fix`), and
  `prepare` (`lefthook install || true`) which wires the git hooks after
  `npm install` on a contributor's machine.
- `lefthook.yml` runs `oxlint` on staged JS files (pre-commit), runs
  `commitlint` against the commit message (commit-msg), and runs `npm test`
  before push.
- `.oxlintrc.json` allows the `_`-prefix convention for unused
  catch/argument/var bindings to match Node-idiomatic style.
- Contributors need Git `>=2.31.0` for `lefthook install`; older Git
  silently skips hook setup (the `|| true` in `prepare` keeps `npm install`
  from failing on legacy systems).

## [0.3.2] - 2026-05-15

### Fixed

- Shared `http-client.js` instance + atomic stale-lock takeover in `lib/state.js`.
  Multiple concurrent `hexo ping` runs no longer fail with "EEXIST" lock collisions
  when the first process crashes without cleanup. Lock acquisition now retries and
  takes over stale locks (>5s old) atomically.

## [0.3.1] - 2026-05-12

### Added
- IndexNow retries with exponential backoff on HTTP 429
  (rate-limited). Default 3 attempts, base 250ms doubling each retry,
  capped at 5s. Honors `Retry-After` response header (delta-seconds
  or HTTP-date). Results now include a `retries: N` field. Other
  non-2xx statuses (403, 422, 5xx, etc.) are NOT retried.

### Coverage
- 141 tests (+7 new). Functions 100%, lines stay ≥99.8%.

## [0.3.0] - 2026-05-12

### Added
- **WebSub publish engine** (`lib/websub.js`). Third engine alongside
  IndexNow and XML-RPC. Sends `hub.mode=publish&hub.url=<feed>` to each
  configured hub as `application/x-www-form-urlencoded`. Reuses
  `lib/url-guard.js` for SSRF protection (private-host refusal +
  `redirect: 'manual'`) and is opt-in (`ping.websub.enabled: false` by
  default).
- Config: new `ping.websub.{enabled, hubs, feed_url}` block. Cap of 16
  hubs (tighter than XML-RPC's 32 — subscriber fan-out amplifies
  downstream). Cap of 2048 chars on `feed_url`.
- Tests: 11 unit tests covering payload shape, URL-encoding of
  special chars, status mapping for 200/202/204/429/non-2xx, timeout
  behaviour, SSRF refusal, redirect:manual posture, and concurrency
  cap.

### Coverage
- 134 tests pass on Node 22 + 24. Functions 100%, lines 99.87%.

## [0.2.0] - 2026-05-12

### Fixed
- **Concurrent-writer race** in `lib/state.js:commit()` (M4 from the
  v0.1.1 Red Team audit). Two parallel `runPing` invocations (e.g., an
  `after_generate` filter firing while a manual `hexo ping` is in
  flight) no longer lose updates. `commit()` now acquires a
  `<state-file>.lock` sidecar via `O_CREAT | O_EXCL`, re-reads the
  on-disk state inside the critical section, merges the caller's
  `pingedItems` on top of the fresh snapshot, atomically rewrites
  (temp+rename), and unlinks the lock. Lock timeout 5000ms (overridable
  via `options.lockTimeoutMs`), retry every 25ms. Native — zero new
  runtime deps.

### Changed
- `commit(filePath, _ignoredCallerState, pingedItems)`: the second
  argument is now ignored on purpose — re-read happens inside the
  lock. Signature kept for v0.1.x call-site compatibility.

### Coverage
- 113 tests (108 prior + 5 new). Functions 100%, lines 99.84%.

## [0.1.2] - 2026-05-12

### Fixed
- `hexo ping` CLI now calls `await hexo.load()` before reading
  `hexo.locals.get('posts')`. Without it, Hexo's custom-console-command
  context delivers an empty `locals.posts`, so the plugin reported "no
  URLs to ping" even on a populated blog. The `after_generate` filter
  path was unaffected (generate already triggers load as a side
  effect).
- New integration test (`test/integration.test.mjs`) verifies
  `hexo.load` is invoked from the CLI path.

### Coverage
- 108 tests (107 prior + 1 new). Functions 100%, lines 99.83%.

## [0.1.1] - 2026-05-12

### Fixed
- **CommonJS migration.** Hexo's plugin loader uses `require()` in a
  vm context that doesn't register a dynamic-import callback, so the
  v0.1.0 `await import('./scripts/console.mjs')` pattern threw
  `ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING` on every host build.
  Converted `lib/*.mjs` + `scripts/*.mjs` + `index.js` to pure CJS.
  Tests stay ESM (`*.test.mjs`) and import from the new `.js` paths.

### Security (Red Team review fixes folded into the same commit)
- **H1 SSRF protection**: `lib/url-guard.js` refuses private hostnames
  (127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16,
  169.254.0.0/16 incl. IMDS, ::1, fc00::/7, fe80::/10). Both engines
  use `redirect: 'manual'` so a public host cannot 302 into a private
  IP. New `status: 'blocked'` result for refused endpoints.
- **H2 path-traversal protection**: `lib/run.js` resolves the absolute
  state-file path and asserts it stays inside `hexo.base_dir`. Refuses
  absolute paths or `../` escapes.
- **H3 symlink refusal**: `lib/state.js:refuseSymlink()` uses
  `lstatSync()` to reject symlinks on both read and commit. Closes a
  latent info-disclosure / file-clobber primitive.
- **H4 IndexNow key exfiltration warning**: `lib/indexnow.js` keeps an
  allowlist of known IndexNow endpoints (api.indexnow.org, Bing,
  Yandex, Seznam, Naver, Yep). Non-allowlisted hosts trigger a single
  stderr warning before the POST — the request still goes through (a
  user may legitimately want a private proxy), but accidental
  misconfiguration is visible.
- **M1 URL-resolution heuristic**: `lib/run.js` now uses
  `/^https?:\/\//i` regex instead of `startsWith('http')` to detect
  whether `keyLocation` and `feedUrl` are already absolute URLs.
- **M2 DoS via unbounded fan-out**: `lib/xmlrpc.js:pingAll` now uses a
  worker-pool semaphore bounded by `concurrency` (default 5). Config
  caps `xmlrpc.endpoints.length` ≤ 32, `feed_url.length` ≤ 2048,
  `indexnow.key.length` ≤ 256.
- **M3 state commits on total engine failure**: `lib/run.js` only
  persists state when at least one engine returns `status: 'ok'`. URLs
  whose engines all errored will retry next run.

### Coverage
- 107 tests (50 prior + 21 SSRF/url-guard + 36 other defensive paths).
  Functions 100%, lines 99.83%, branches 92.62%.

## [0.1.0] - 2026-05-11

### Added
- Initial preview release.
- IndexNow engine: `lib/indexnow.js`. Posts `{host, key, keyLocation,
  urlList}` to `https://api.indexnow.org/IndexNow` (overridable). One
  POST notifies Bing, Yandex, Naver, Seznam, and Yep. Automatic
  batching at 10,000 URLs/request. 5s timeout via `AbortController`.
- XML-RPC `weblogUpdates.ping` engine: `lib/xmlrpc.js`. Native
  payload encoder (~30 LOC, no `xmlrpc` dep). Detects `<fault>` in
  the response. Fire-and-forget per endpoint (warnings don't fail the
  run). Default endpoint set: `rpc.pingomatic.com` (aggregator),
  `rpc.twingly.com`.
- Content-hash diff state: `lib/state.js` reads/writes
  `.hexo-ping-state.json` (gitignored on the consumer side). Each
  entry tracks `lastPinged` and a SHA-256 hash of the post permalink
  plus its `(updated || date)` stamp — re-pings only on actual
  content/timestamp change.
- Hexo integration: `hexo ping` console command (`scripts/console.js`)
  with `--all`, `--dry-run`, `--verbose`, `--no-state`, `--since`,
  `--urls` flags. Optional `after_generate` filter (opt-in via
  `ping.run_after_generate: true`) for fire-on-publish flows.
- Per-post opt-out via frontmatter: `ping: false` or
  `noindex: true`.
- Zero runtime dependencies. Native `fetch` only. `hexo ^7 || ^8`
  declared as peerDependency.

### Coverage
- 50 unit tests on Node 22 + 24. Mock HTTP via
  `test/helpers/mock-http.mjs` (native `node:http.createServer`).

[0.3.1]: https://github.com/alex-messer/hexo-ping-services/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/alex-messer/hexo-ping-services/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/alex-messer/hexo-ping-services/compare/v0.1.2...v0.2.0
[0.1.2]: https://github.com/alex-messer/hexo-ping-services/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/alex-messer/hexo-ping-services/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/alex-messer/hexo-ping-services/releases/tag/v0.1.0
