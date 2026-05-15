'use strict';
const {
  readFileSync,
  writeSync,
  renameSync,
  existsSync,
  lstatSync,
  openSync,
  closeSync,
  unlinkSync,
  constants: FS_CONST
} = require('node:fs');
const { randomBytes } = require('node:crypto');
const { dirname, basename, join } = require('node:path');

const EMPTY = () => ({ version: 1, lastRun: null, urls: {} });
const LOCK_TIMEOUT_MS = 5000;
const LOCK_RETRY_MS = 25;
const LOCK_MAX_STALE_RECOVERIES = 3;
// O_NOFOLLOW may be undefined on Windows; fall back to 0 (O_EXCL still refuses to overwrite a symlink).
const O_NOFOLLOW = FS_CONST.O_NOFOLLOW || 0;

// Refuse symlinks for the state file to defeat link-replacement attacks where
// an attacker pre-creates the file as a symlink to /etc/passwd (or any other
// path) and tricks `commit` into clobbering it via the atomic rename.
function refuseSymlink(filePath) {
  try {
    const st = lstatSync(filePath);
    if (st.isSymbolicLink()) {
      throw new Error('hexo-ping-services: state file is a symlink, refusing for security');
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err.code === 'ESRCH') return false;
    // EPERM means the PID exists but we can't signal it — still alive.
    return true;
  }
}

function lockBodyPid(lockPath) {
  try {
    const body = readFileSync(lockPath, 'utf8').trim();
    const pid = parseInt(body, 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

// Atomically take over a lock believed stale. rename(2) of the canonical lock
// path is the serialization point: of N processes racing to recover the same
// stale lock, exactly one rename succeeds; the rest get ENOENT and must retry
// the acquire from the top. The winner then re-checks the file it claimed —
// if a live holder re-created the lock between our staleness probe and our
// rename, we grabbed *their* lock, so we put it back untouched. Only a still-
// stale claimed file is unlinked. Returns true if the caller should retry.
function takeOverStaleLock(lockPath, stalePid) {
  const claimed = lockPath + '.stale-' + process.pid + '-' + randomBytes(6).toString('hex');
  try {
    renameSync(lockPath, claimed);
  } catch (err) {
    if (err.code === 'ENOENT') return true;
    throw err;
  }
  const claimedPid = lockBodyPid(claimed);
  if (claimedPid !== null && claimedPid !== stalePid && isPidAlive(claimedPid)) {
    try {
      renameSync(claimed, lockPath);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    return true;
  }
  try { unlinkSync(claimed); } catch { /* already gone */ }
  return true;
}

async function acquireLock(filePath, timeoutMs) {
  const lockPath = filePath + '.lock';
  const deadline = Date.now() + timeoutMs;
  let staleRecoveries = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    let fd;
    try {
      fd = openSync(
        lockPath,
        FS_CONST.O_CREAT | FS_CONST.O_EXCL | FS_CONST.O_WRONLY | O_NOFOLLOW,
        0o600
      );
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      // Unparseable PID or read failure is treated as a live holder (fail-safe).
      const pid = lockBodyPid(lockPath);
      const dead = pid !== null && !isPidAlive(pid);
      if (dead && staleRecoveries < LOCK_MAX_STALE_RECOVERIES) {
        staleRecoveries++;
        if (typeof acquireLock._onStaleConfirmed === 'function') {
          // eslint-disable-next-line no-await-in-loop
          await acquireLock._onStaleConfirmed();
        }
        takeOverStaleLock(lockPath, pid);
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(`hexo-ping-services: state lock timeout after ${timeoutMs}ms`);
      }
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, LOCK_RETRY_MS));
      continue;
    }
    try {
      writeSync(fd, String(process.pid));
    } finally {
      closeSync(fd);
    }
    return lockPath;
  }
}

function releaseLock(lockPath) {
  try { unlinkSync(lockPath); } catch (_err) { /* best-effort */ }
}

function readState(filePath) {
  refuseSymlink(filePath);
  if (!existsSync(filePath)) return EMPTY();
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    if (parsed.version !== 1) return EMPTY();
    return {
      version: 1,
      lastRun: parsed.lastRun ?? null,
      urls: sanitizeUrlMap(parsed.urls)
    };
  } catch {
    return EMPTY();
  }
}

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
function sanitizeUrlMap(raw) {
  const out = Object.create(null);
  if (!raw || typeof raw !== 'object') return out;
  for (const k of Object.keys(raw)) {
    if (DANGEROUS_KEYS.has(k)) continue;
    try { new URL(k); } catch { continue; }
    out[k] = raw[k];
  }
  return out;
}

function diff(state, items) {
  const out = [];
  for (const item of items) {
    const prev = state.urls[item.url];
    if (!prev || prev.contentHash !== item.contentHash) out.push(item.url);
  }
  return out;
}

function writeTmpAtomicallyThenRename(target, json) {
  const tmp = join(dirname(target), '.' + basename(target) + '.tmp');
  try {
    const st = lstatSync(tmp);
    if (st.isSymbolicLink()) {
      throw new Error('hexo-ping-services: state .tmp file is a symlink, refusing for security');
    }
    unlinkSync(tmp);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  let fd;
  try {
    fd = openSync(
      tmp,
      FS_CONST.O_CREAT | FS_CONST.O_EXCL | FS_CONST.O_WRONLY | O_NOFOLLOW,
      0o600
    );
  } catch (err) {
    // EEXIST/ELOOP here means a symlink (or symlink race) was planted at `tmp`.
    if (err.code === 'EEXIST' || err.code === 'ELOOP') {
      const e = new Error('hexo-ping-services: state .tmp file is a symlink, refusing for security');
      e.code = err.code;
      e.cause = err;
      throw e;
    }
    throw err;
  }
  try {
    writeSync(fd, json);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, target);
}

// Concurrency-safe commit: acquires <filePath>.lock via O_CREAT|O_EXCL,
// re-reads the on-disk state inside the critical section, merges the
// caller's pingedItems on top of the fresh snapshot, atomically rewrites
// the state file, and unlinks the lock in a `finally` block.
//
// The third positional argument from v0.1.x (caller-supplied state) is now
// ignored — we always re-read inside the lock so two concurrent runs can
// no longer lose updates to each other. The signature is kept for
// backwards compatibility with v0.1.x call sites.
async function commit(filePath, _ignoredCallerState, pingedItems, options) {
  refuseSymlink(filePath);
  const lockTimeoutMs = (options && options.lockTimeoutMs) || LOCK_TIMEOUT_MS;
  const lockPath = await acquireLock(filePath, lockTimeoutMs);
  try {
    const fresh = readState(filePath);
    const now = new Date().toISOString();
    const mergedUrls = Object.create(null);
    for (const k of Object.keys(fresh.urls)) {
      if (DANGEROUS_KEYS.has(k)) continue;
      mergedUrls[k] = fresh.urls[k];
    }
    for (const item of pingedItems) {
      if (DANGEROUS_KEYS.has(item.url)) continue;
      mergedUrls[item.url] = { lastPinged: now, contentHash: item.contentHash };
    }
    const next = { version: 1, lastRun: now, urls: mergedUrls };
    writeTmpAtomicallyThenRename(filePath, JSON.stringify(next, null, 2));
  } finally {
    releaseLock(lockPath);
  }
}

const _internal = { acquireLock, releaseLock, isPidAlive, sanitizeUrlMap, takeOverStaleLock };
Object.defineProperty(_internal, '_onStaleConfirmed', {
  get() { return acquireLock._onStaleConfirmed; },
  set(fn) { acquireLock._onStaleConfirmed = fn; }
});

module.exports = {
  readState,
  diff,
  commit,
  _internal
};
