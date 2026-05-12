'use strict';
const {
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
  lstatSync,
  openSync,
  closeSync,
  unlinkSync,
  constants: FS_CONST
} = require('node:fs');
const { dirname, basename, join } = require('node:path');

const EMPTY = () => ({ version: 1, lastRun: null, urls: {} });
const LOCK_TIMEOUT_MS = 5000;
const LOCK_RETRY_MS = 25;

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

// Short synchronous sleep for the lock-retry loop. Spin-wait is fine because
// the critical section (read + write a small JSON file) is held <10ms in
// practice, so contention is rare and brief.
function sleepBusy(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { /* spin */ }
}

// Acquire an exclusive lock by creating <filePath>.lock with O_CREAT|O_EXCL.
// Retries on EEXIST until timeoutMs elapses, then throws.
function acquireLock(filePath, timeoutMs) {
  const lockPath = filePath + '.lock';
  const deadline = Date.now() + timeoutMs;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const fd = openSync(
        lockPath,
        FS_CONST.O_CREAT | FS_CONST.O_EXCL | FS_CONST.O_WRONLY,
        0o600
      );
      closeSync(fd);
      return lockPath;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      if (Date.now() > deadline) {
        throw new Error(`hexo-ping-services: state lock timeout after ${timeoutMs}ms`);
      }
      sleepBusy(LOCK_RETRY_MS);
    }
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
      urls: parsed.urls ?? {}
    };
  } catch {
    return EMPTY();
  }
}

function diff(state, items) {
  const out = [];
  for (const item of items) {
    const prev = state.urls[item.url];
    if (!prev || prev.contentHash !== item.contentHash) out.push(item.url);
  }
  return out;
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
function commit(filePath, _ignoredCallerState, pingedItems, options) {
  refuseSymlink(filePath);
  const lockTimeoutMs = (options && options.lockTimeoutMs) || LOCK_TIMEOUT_MS;
  const lockPath = acquireLock(filePath, lockTimeoutMs);
  try {
    const fresh = readState(filePath);
    const now = new Date().toISOString();
    const next = { version: 1, lastRun: now, urls: { ...fresh.urls } };
    for (const item of pingedItems) {
      next.urls[item.url] = { lastPinged: now, contentHash: item.contentHash };
    }
    const tmp = join(dirname(filePath), '.' + basename(filePath) + '.tmp');
    writeFileSync(tmp, JSON.stringify(next, null, 2));
    renameSync(tmp, filePath);
  } finally {
    releaseLock(lockPath);
  }
}

module.exports = { readState, diff, commit };
