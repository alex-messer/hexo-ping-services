<!-- Thanks for opening a PR. Fill in the relevant sections; delete the ones that don't apply. -->

## Summary

<!-- One-line description of what this changes. -->

## Motivation

<!-- What problem does this solve? Reference an issue or specific use case. -->

## Type of change

- [ ] Bug fix (`fix:`)
- [ ] New feature (`feat:`)
- [ ] Breaking change (`feat!:` or `fix!:`)
- [ ] Refactor (`refactor:`)
- [ ] Documentation only (`docs:`)
- [ ] CI / build / chore (`ci:` / `build:` / `chore:`)

## Test plan

<!-- How did you verify this change? -->

- [ ] `npm test` passes locally on Node 22
- [ ] Coverage (`npm run test:coverage`) stays ≥97% functions / ≥95% lines
- [ ] If this changes engine behaviour, an integration test against a real Hexo instance was added or extended

## Security checklist

If this PR touches network calls, file I/O, or the lock file, please confirm:

- [ ] Endpoint validated by `lib/url-guard.js` (no SSRF to private hosts)
- [ ] `fetch()` calls include `redirect: 'manual'`
- [ ] File paths validated to stay inside `hexo.base_dir`
- [ ] Symlink targets refused via `lstatSync`
- [ ] No new secrets leaked through error messages or stdout

## Breaking changes

<!-- If yes, describe the migration path. -->

## Conventional commit message

<!-- The commit-msg hook enforces commitlint. Example:
     feat(websub): add hub.secret HMAC support
-->
