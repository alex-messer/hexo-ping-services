# hexo-ping-services

[![npm version](https://img.shields.io/npm/v/hexo-ping-services.svg)](https://www.npmjs.com/package/hexo-ping-services)
[![npm downloads](https://img.shields.io/npm/dm/hexo-ping-services.svg)](https://www.npmjs.com/package/hexo-ping-services)
[![node](https://img.shields.io/node/v/hexo-ping-services.svg)](https://nodejs.org/)
[![license](https://img.shields.io/npm/l/hexo-ping-services.svg)](./LICENSE)

Notify [IndexNow](https://www.indexnow.org/) (Bing, Yandex, Naver, Seznam, Yep),
a curated XML-RPC `weblogUpdates.ping` endpoint set, and [WebSub](https://www.w3.org/TR/websub/)
hubs whenever your Hexo blog publishes a new post or updates an existing one.

- **Zero runtime dependencies.** Node stdlib `https`/`http` + a 30-line XML-RPC encoder.
- **State-aware.** A small `.hexo-ping-state.json` file remembers the last-pinged
  content hash per URL, so unchanged posts aren't re-pinged on every build.
- **Hardened.** Multi-layer SSRF defense (IPv4, IPv6 literals, 6to4/NAT64/IPv4-compat encodings).
  Request timeouts cover both headers and body read (Slowloris DoS mitigation).
  Config values sanitized in output (terminal injection hardening).
- **Tested.** 228 unit tests run on Node 22 + 24 via `node --test`.

## Why

WordPress has shipped `weblogUpdates.ping` since 2003. The modern equivalents
are IndexNow (one POST → Bing, Yandex, Naver, Seznam, Yep) and WebSub (push
notifications to feed readers). Hexo had no maintained plugin combining them —
this package fills that gap.

## Install

From the npm registry:

```sh
npm install --save-dev hexo-ping-services
# or: pnpm add -D hexo-ping-services
# or: yarn add -D hexo-ping-services
```

Requirements: Node `>=22`, Hexo `^7 || ^8` (peer-dep, supplied by your site).

Verify:

```sh
npx hexo ping --dry-run
```

## Configure

Add a `ping:` block to your `_config.yml`:

```yaml
ping:
  enabled: true
  run_after_generate: false     # opt-in: auto-ping after `hexo generate`
  indexnow:
    enabled: true
    key: <32-128 hex chars>     # generate with: node -e "console.log(crypto.randomBytes(32).toString('hex'))"
    key_location: /indexnow.txt # public path served by your site
  xmlrpc:
    enabled: true
    endpoints:
      - https://rpc.pingomatic.com/
      - https://rpc.twingly.com/
    feed_url: /atom.xml         # optional → uses extendedPing if set
  websub:
    enabled: false              # opt-in
    hubs:
      - https://pubsubhubbub.appspot.com/
      - https://push.superfeedr.com/
    feed_url: /atom.xml         # absolute or relative-to-site URL
  state_file: .hexo-ping-state.json
  timeout_ms: 5000
  validate_dns: true            # resolve outbound hostnames and reject DNS rebinding to private IPs; set false to skip (~10 ms per unique host)
```

Then create the IndexNow key file: place a single line containing the same key
at `source/<key>.txt` (Hexo will copy it to `public/<key>.txt` on build), and
make sure `key_location` matches.

Add the state file to `.gitignore`:

```
.hexo-ping-state.json
```

## Use

### Command line

```sh
npx hexo ping                                                       # ping only new/changed posts (default)
npx hexo ping --all                                                 # ignore state, ping every indexable URL
npx hexo ping --dry-run                                             # show what would be pinged, no HTTP
npx hexo ping --urls=https://example.com/foo/,https://example.com/bar/
npx hexo ping --verbose                                             # per-endpoint JSON logs
```

### CI (recommended)

After your deploy step:

```yaml
- name: Notify search engines
  run: npx hexo ping
```

### After-generate filter (optional)

Set `ping.run_after_generate: true` in config to fire after every `hexo generate`.
Default is `false` — recommended because `hexo server` would otherwise ping on
every local rebuild.

## Per-post opt-out

Skip individual posts via frontmatter:

```yaml
---
title: Draft thoughts
ping: false
---
```

Posts with `noindex: true` are also skipped.

## Engines

### IndexNow

Sends a single `POST https://api.indexnow.org/IndexNow` with all dirty URLs
(automatic batching at 10.000 per request). Bing, Yandex, Naver, Seznam, and
Yep all participate — one call notifies all of them.

Status codes:
- `200`/`202` → ok
- `422` → invalid URLs (warning)
- `429` → rate-limited (warning)
- `403` → key file unreachable (error → exit 1)

### XML-RPC `weblogUpdates.ping`

Sends a `methodCall` to each configured endpoint. Default set as of 2026:
`rpc.pingomatic.com` (aggregator), `rpc.twingly.com`. Failures here are
fire-and-forget (warnings, no exit-1).

When `feed_url` is set, sends `weblogUpdates.extendedPing` (4 params) instead
of plain `ping` (2 params).

### WebSub

[WebSub](https://www.w3.org/TR/websub/) (W3C Recommendation, formerly
PubSubHubbub) is a push-based notification protocol for feed updates. When
enabled, this engine POSTs `hub.mode=publish&hub.url=<feed-url>` (form-urlencoded)
to every configured hub. The hub then fans the new content out to all
subscribers — push instead of poll for RSS/Atom readers.

Suggested hub set (operational 2026-05):
`https://pubsubhubbub.appspot.com/` (Google legacy),
`https://push.superfeedr.com/` (commercial, accepts free publish).

Status codes:
- `2xx` → ok
- `429` → rate-limited (warning)
- everything else → error (warning, no exit-1)

Disabled by default. To enable, set `websub.enabled: true` and list at least
one hub.

## License

MIT © alex-messer
