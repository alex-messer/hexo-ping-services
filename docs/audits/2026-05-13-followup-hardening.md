# Follow-up Hardening — MED-01 & HIGH-03

**Status:** Open — deferred from the 2026-05-13 security campaign.
**Source:** `2026-05-13-security-audit.md` (findings), `2026-05-13-security-fixes.md` (remediation + `## Accepted Residual Risks`).
**Why this exists:** The 2026-05-13 audit campaign remediated all findings and cleared the maintainer's 90 % review gate. Two findings were shipped as *documented, accepted residual risks* rather than fully hardened, because their residual is theoretical-only in this plugin's deployment model (a build-time, one-shot CLI tool). This document is the follow-up ticket to close them.

**Target:** Lift the skeptical-review confidence from 91 % toward the 93 % ideal. Both items require real code changes, not re-scoring.

---

## MED-01 — Pin the validated IP for the connection

**What remains:** `assertPublicHttpUrl(url, { resolveDns: true })` pre-resolves the hostname and validates every resolved IP against the private-range matcher, and this is wired default-on into all three engines. But the subsequent `fetch()` call hands undici the hostname *string*; undici performs its own independent name resolution at TCP-connect time. The validated IP is not pinned, leaving a time-of-check/time-of-use window: a ~0-TTL DNS record could resolve to a public IP at validation and a private IP at connect.

**Why it was accepted:** Reaching it requires the blog to be configured to ping a hostname whose DNS the maintainer does not control, that name server serving a ~0-TTL record, and the two resolutions diverging within the sub-second connect window of a one-shot build. The dominant precondition (config pointing at an untrusted endpoint) is itself outside the plugin's threat model.

**Hardening approach:** Construct an `undici` `Agent` whose `connect.lookup` returns the address already validated by `resolveAndAssertPublic`, so the check-to-connect path connects to the exact IP that was validated. Pass that dispatcher to the engine `fetch()` calls.

**Affected files:** `lib/url-guard.js`, `lib/indexnow.js`, `lib/xmlrpc.js`, `lib/websub.js`.

**Verification to add:** a test that stubs DNS to return a public IP on the validation lookup and a private IP on a second lookup, and asserts the connection still targets the validated IP (or is refused).

---

## HIGH-03 — Close the multi-process stale-lock unlink race

**What remains:** The PID-stamped lock file with liveness probe and bounded stale-recovery correctly fixes the permanent-DoS from an abandoned lock. A narrow time-of-check/time-of-use window remains: if two processes concurrently observe the same dead PID, one process can `unlinkSync` a lock the other has just legitimately re-created, allowing both into the critical section (a lost state-file update).

**Why it was accepted:** This requires two concurrent builds of the *same site directory* — abnormal for a one-shot build tool, normally invoked once per build. Single-process operation (the norm) is fully correct. The state file is an optimization cache (skip re-pinging unchanged URLs), so a lost update degrades to a redundant ping on the next build, not a security or data-integrity failure.

**Hardening approach:** Make the stale-lock takeover atomic — e.g. verify the lock content is still the stale PID immediately before `unlinkSync`, or switch to rename-based locking (write a uniquely-named temp lock, `rename` it into place, treat `EEXIST`/loss as "did not acquire").

**Affected files:** `lib/state.js`.

**Verification to add:** a test simulating two acquirers seeing the same stale PID, asserting exactly one enters the critical section.

---

## Done criteria

- [ ] MED-01 hardened: validated IP pinned through to connect; test added.
- [ ] HIGH-03 hardened: stale-lock takeover is atomic; test added.
- [ ] Full suite green.
- [ ] Skeptical re-review confidence ≥ 93 %.
- [ ] `## Accepted Residual Risks` section in `2026-05-13-security-fixes.md` updated to reflect closure.
