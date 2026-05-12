# Changelog

All notable changes to `hexo-ping-services` are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
