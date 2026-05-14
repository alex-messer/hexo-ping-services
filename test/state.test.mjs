import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync, readdirSync,
  symlinkSync, chmodSync, openSync, closeSync, writeSync, statSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import stateMod from '../lib/state.js';
const { readState, diff, commit, _internal } = stateMod;

function tmp() {
  const d = mkdtempSync(join(tmpdir(), 'hps-state-'));
  return { dir: d, file: join(d, 'state.json'), cleanup: () => rmSync(d, { recursive: true, force: true }) };
}

test('readState returns empty state for missing file', () => {
  const { file, cleanup } = tmp();
  try {
    const s = readState(file);
    assert.equal(s.version, 1);
    assert.equal(s.lastRun, null);
    assert.deepEqual({ ...s.urls }, {});
  } finally { cleanup(); }
});

test('readState reads existing file', () => {
  const { file, cleanup } = tmp();
  try {
    writeFileSync(file, JSON.stringify({
      version: 1,
      lastRun: '2026-01-01T00:00:00.000Z',
      urls: { 'https://x/': { lastPinged: '2026-01-01T00:00:00.000Z', contentHash: 'sha256:abc' } }
    }));
    const s = readState(file);
    assert.equal(s.urls['https://x/'].contentHash, 'sha256:abc');
  } finally { cleanup(); }
});

test('diff returns new urls', () => {
  const state = { version: 1, lastRun: null, urls: {} };
  const items = [{ url: 'https://x/', contentHash: 'sha256:abc' }];
  assert.deepEqual(diff(state, items), ['https://x/']);
});

test('diff returns changed urls', () => {
  const state = { version: 1, lastRun: null, urls: { 'https://x/': { lastPinged: 't', contentHash: 'sha256:old' } } };
  const items = [{ url: 'https://x/', contentHash: 'sha256:new' }];
  assert.deepEqual(diff(state, items), ['https://x/']);
});

test('diff returns empty when state matches', () => {
  const state = { version: 1, lastRun: null, urls: { 'https://x/': { lastPinged: 't', contentHash: 'sha256:abc' } } };
  const items = [{ url: 'https://x/', contentHash: 'sha256:abc' }];
  assert.deepEqual(diff(state, items), []);
});

test('commit writes file atomically and updates entries', async () => {
  const { file, cleanup } = tmp();
  try {
    const state = { version: 1, lastRun: null, urls: {} };
    await commit(file, state, [{ url: 'https://x/', contentHash: 'sha256:abc' }]);
    assert.ok(existsSync(file));
    const reloaded = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(reloaded.version, 1);
    assert.ok(reloaded.lastRun);
    assert.equal(reloaded.urls['https://x/'].contentHash, 'sha256:abc');
    assert.ok(reloaded.urls['https://x/'].lastPinged);
  } finally { cleanup(); }
});

test('readState refuses to follow a symlinked state file', () => {
  const { dir, file, cleanup } = tmp();
  try {
    const target = join(dir, 'target.json');
    writeFileSync(target, JSON.stringify({ version: 1, lastRun: 't', urls: {} }));
    symlinkSync(target, file);
    assert.throws(() => readState(file), /symlink, refusing for security/);
  } finally { cleanup(); }
});

test('commit refuses to write through a symlinked state file', async () => {
  const { dir, file, cleanup } = tmp();
  try {
    const decoy = join(dir, 'decoy.json');
    writeFileSync(decoy, 'do not overwrite me');
    symlinkSync(decoy, file);
    await assert.rejects(
      commit(file, { version: 1, lastRun: null, urls: {} }, [{ url: 'https://x/', contentHash: 'sha256:abc' }]),
      /symlink, refusing for security/
    );
    // Decoy must be untouched.
    assert.equal(readFileSync(decoy, 'utf8'), 'do not overwrite me');
  } finally { cleanup(); }
});

test('commit does not leave temp files behind on success', async () => {
  const { dir, file, cleanup } = tmp();
  try {
    await commit(file, { version: 1, lastRun: null, urls: {} }, [{ url: 'https://x/', contentHash: 'sha256:abc' }]);
    const entries = readdirSync(dir);
    assert.deepEqual(entries.sort(), ['state.json']);
  } finally { cleanup(); }
});

test('commit acquires an exclusive lock and serialises concurrent writers', async () => {
  const { file, cleanup } = tmp();
  try {
    // Seed empty state
    await commit(file, { version: 1, lastRun: null, urls: {} }, []);

    // Run two parallel commits, each adding a distinct URL.
    // Without locking, the loser's url would be missing.
    await Promise.all([
      commit(file, readState(file), [
        { url: 'https://x/a/', contentHash: 'sha256:a' }
      ]),
      commit(file, readState(file), [
        { url: 'https://x/b/', contentHash: 'sha256:b' }
      ])
    ]);

    const final = readState(file);
    assert.ok(final.urls['https://x/a/'], 'URL a must survive concurrent commit');
    assert.ok(final.urls['https://x/b/'], 'URL b must survive concurrent commit');
  } finally { cleanup(); }
});

test('commit clears its lock file on success', async () => {
  const { file, cleanup } = tmp();
  try {
    await commit(file, { version: 1, lastRun: null, urls: {} }, [
      { url: 'https://x/', contentHash: 'sha256:a' }
    ]);
    assert.equal(existsSync(file + '.lock'), false, 'lock must be released after commit');
  } finally { cleanup(); }
});

test('commit clears its lock file when underlying write throws', async () => {
  const { dir, file, cleanup } = tmp();
  try {
    // Make the parent directory non-writable to force the underlying write to throw.
    // (Note: when running as root chmod is bypassed; the test then skips itself.)
    if (process.getuid && process.getuid() === 0) return; // skip as root
    chmodSync(dir, 0o500);
    try {
      await assert.rejects(commit(file, { version: 1, lastRun: null, urls: {} }, [
        { url: 'https://x/', contentHash: 'sha256:a' }
      ]));
    } finally {
      chmodSync(dir, 0o700);
    }
    assert.equal(existsSync(file + '.lock'), false, 'lock must be released on error');
  } finally { cleanup(); }
});

test('commit re-reads state inside the lock so concurrent updates are not lost', async () => {
  const { file, cleanup } = tmp();
  try {
    // Writer A reads, writer B reads — both have same stale snapshot.
    const snapshotForA = readState(file);  // empty
    const snapshotForB = readState(file);  // empty

    // Both commit. B should not clobber A.
    await commit(file, snapshotForA, [{ url: 'https://x/a/', contentHash: 'sha256:a' }]);
    await commit(file, snapshotForB, [{ url: 'https://x/b/', contentHash: 'sha256:b' }]);

    const final = readState(file);
    assert.ok(final.urls['https://x/a/']);
    assert.ok(final.urls['https://x/b/']);
  } finally { cleanup(); }
});

test('commit throws a clear timeout error when the lock is already held by a LIVE process', async () => {
  const { file, cleanup } = tmp();
  try {
    // Seed the lock with our own PID so the stale-PID probe sees it as live.
    const lockPath = file + '.lock';
    const fd = openSync(lockPath, 'wx');
    writeSync(fd, String(process.pid));
    closeSync(fd);
    try {
      await assert.rejects(
        commit(file, { version: 1, lastRun: null, urls: {} }, [
          { url: 'https://x/', contentHash: 'sha256:a' }
        ], { lockTimeoutMs: 50 }),
        /state lock timeout/
      );
    } finally {
      rmSync(lockPath, { force: true });
    }
  } finally { cleanup(); }
});

test('commit refuses to follow a pre-planted .tmp symlink', async () => {
  const { dir, file, cleanup } = tmp();
  try {
    const decoy = join(dir, 'decoy.txt');
    writeFileSync(decoy, 'sensitive');
    const tmpPath = join(dir, '.' + 'state.json' + '.tmp');
    symlinkSync(decoy, tmpPath);
    await assert.rejects(
      commit(file, { version: 1, lastRun: null, urls: {} }, [
        { url: 'https://x/', contentHash: 'sha256:a' }
      ]),
      /\.tmp file is a symlink/
    );
    assert.equal(readFileSync(decoy, 'utf8'), 'sensitive');
  } finally { cleanup(); }
});

test('committed state file has mode 0o600', async () => {
  const { file, cleanup } = tmp();
  try {
    if (process.platform === 'win32') return; // POSIX modes don't apply
    await commit(file, { version: 1, lastRun: null, urls: {} }, [
      { url: 'https://x/', contentHash: 'sha256:a' }
    ]);
    const mode = statSync(file).mode & 0o777;
    assert.equal(mode, 0o600, `state file mode must be 0o600, got 0o${mode.toString(8)}`);
  } finally { cleanup(); }
});

test('stale lock (dead PID) is unlinked and lock is re-acquired', async () => {
  const { file, cleanup } = tmp();
  try {
    // 999999 is above pid_max on every common CI kernel, so process.kill(0) returns ESRCH.
    const lockPath = file + '.lock';
    const fd = openSync(lockPath, 'wx');
    writeSync(fd, '999999');
    closeSync(fd);
    await commit(file, { version: 1, lastRun: null, urls: {} }, [
      { url: 'https://x/recovered/', contentHash: 'sha256:r' }
    ], { lockTimeoutMs: 1000 });
    const final = readState(file);
    assert.ok(final.urls['https://x/recovered/']);
    assert.equal(existsSync(lockPath), false, 'lock must be released after recovery');
  } finally { cleanup(); }
});

test('live PID in lock is respected (timeout, no unlink)', async () => {
  const { file, cleanup } = tmp();
  try {
    // process.pid is by definition alive.
    const lockPath = file + '.lock';
    const fd = openSync(lockPath, 'wx');
    writeSync(fd, String(process.pid));
    closeSync(fd);
    await assert.rejects(
      commit(file, { version: 1, lastRun: null, urls: {} }, [
        { url: 'https://x/', contentHash: 'sha256:x' }
      ], { lockTimeoutMs: 50 }),
      /state lock timeout/
    );
    assert.equal(existsSync(lockPath), true);
    rmSync(lockPath, { force: true });
  } finally { cleanup(); }
});

test('garbage / empty lock body is fail-safe (treated as live)', async () => {
  const { file, cleanup } = tmp();
  try {
    const lockPath = file + '.lock';
    writeFileSync(lockPath, 'not-a-pid');
    await assert.rejects(
      commit(file, { version: 1, lastRun: null, urls: {} }, [
        { url: 'https://x/', contentHash: 'sha256:x' }
      ], { lockTimeoutMs: 50 }),
      /state lock timeout/
    );
    assert.equal(existsSync(lockPath), true);
    rmSync(lockPath, { force: true });
  } finally { cleanup(); }
});

test('PID 0 in lock is fail-safe (treated as live)', async () => {
  const { file, cleanup } = tmp();
  try {
    const lockPath = file + '.lock';
    writeFileSync(lockPath, '0');
    await assert.rejects(
      commit(file, { version: 1, lastRun: null, urls: {} }, [
        { url: 'https://x/', contentHash: 'sha256:x' }
      ], { lockTimeoutMs: 50 }),
      /state lock timeout/
    );
    assert.equal(existsSync(lockPath), true);
    rmSync(lockPath, { force: true });
  } finally { cleanup(); }
});

test('lock file is written with our PID', async () => {
  const { file, cleanup } = tmp();
  try {
    const lockPath = file + '.lock';
    const acquired = await _internal.acquireLock(file, 1000);
    try {
      const body = readFileSync(acquired, 'utf8');
      assert.equal(body.trim(), String(process.pid));
    } finally {
      _internal.releaseLock(acquired);
    }
    assert.equal(existsSync(lockPath), false);
  } finally { cleanup(); }
});

test('readState discards __proto__ key from state.urls', () => {
  const { file, cleanup } = tmp();
  try {
    // Write raw bytes — JSON.stringify omits __proto__ keys, so we'd never reproduce them otherwise.
    writeFileSync(file, '{"version":1,"lastRun":"t","urls":{"__proto__":{"polluted":true},"not a url":{"contentHash":"x"},"https://valid/":{"contentHash":"sha256:v"}}}');
    const s = readState(file);
    assert.equal(s.urls['https://valid/'].contentHash, 'sha256:v');
    assert.equal(Object.prototype.hasOwnProperty.call(s.urls, '__proto__'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(s.urls, 'not a url'), false);
    assert.equal(({}).polluted, undefined);
  } finally { cleanup(); }
});

test('commit does not write __proto__ key even if passed', async () => {
  const { file, cleanup } = tmp();
  try {
    await commit(file, { version: 1, lastRun: null, urls: {} }, [
      { url: '__proto__', contentHash: 'sha256:bad' },
      { url: 'https://ok/', contentHash: 'sha256:ok' }
    ]);
    const onDisk = JSON.parse(readFileSync(file, 'utf8'));
    const ownKeys = Object.keys(onDisk.urls);
    assert.ok(!ownKeys.includes('__proto__'), '__proto__ must not be persisted');
    assert.ok(ownKeys.includes('https://ok/'));
  } finally { cleanup(); }
});

test('commit yields to the event loop while waiting for a held lock', async () => {
  const { file, cleanup } = tmp();
  try {
    // Hold the lock with our own PID so stale-PID recovery doesn't unlink it.
    const lockPath = file + '.lock';
    const fd = openSync(lockPath, 'wx');
    writeSync(fd, String(process.pid));
    closeSync(fd);
    // If acquireLock busy-spun, this interval callback would never fire before the timeout.
    let flipped = false;
    const timer = setInterval(() => { flipped = true; }, 10);
    try {
      await assert.rejects(
        commit(file, { version: 1, lastRun: null, urls: {} }, [
          { url: 'https://x/', contentHash: 'sha256:x' }
        ], { lockTimeoutMs: 200 }),
        /state lock timeout/
      );
    } finally {
      clearInterval(timer);
      rmSync(lockPath, { force: true });
    }
    assert.ok(flipped, 'event loop must remain responsive during lock wait');
  } finally { cleanup(); }
});
