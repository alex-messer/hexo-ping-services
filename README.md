# hexo-ping-services

Notify [IndexNow](https://www.indexnow.org/) (Bing, Yandex, Naver, Seznam, Yep)
and a curated XML-RPC `weblogUpdates.ping` endpoint set whenever your Hexo blog
publishes a new post or updates an existing one.

- **Zero runtime dependencies.** Native `fetch` + a 30-line XML-RPC encoder.
- **State-aware.** A small `.hexo-ping-state.json` file remembers the last-pinged
  content hash per URL, so unchanged posts aren't re-pinged on every build.
- **Tested.** ~50 unit tests run on Node 22 + 24 via `node --test`.

## Why

WordPress has shipped `weblogUpdates.ping` since 2003. The modern equivalent is
IndexNow (one POST → Bing, Yandex, Naver, Seznam, Yep). Hexo had no maintained
plugin combining both — this package fills that gap.

## Install

```sh
pnpm add -D hexo-ping-services
# or: npm install --save-dev hexo-ping-services
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
  state_file: .hexo-ping-state.json
  timeout_ms: 5000
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
pnpm exec hexo ping              # ping only new/changed posts (default)
pnpm exec hexo ping --all        # ignore state, ping every indexable URL
pnpm exec hexo ping --dry-run    # show what would be pinged, no HTTP
pnpm exec hexo ping --urls=https://example.com/foo/,https://example.com/bar/
pnpm exec hexo ping --verbose    # per-endpoint JSON logs
```

### CI (recommended)

After your deploy step:

```yaml
- name: Notify search engines
  run: pnpm exec hexo ping
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

## License

MIT © alex-messer
