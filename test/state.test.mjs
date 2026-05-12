import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync, readdirSync, symlinkSync, chmodSync, openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readState, diff, commit } from '../lib/state.js';

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
    assert.deepEqual(s.urls, {});
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

test('commit writes file atomically and updates entries', () => {
  const { file, cleanup } = tmp();
  try {
    const state = { version: 1, lastRun: null, urls: {} };
    commit(file, state, [{ url: 'https://x/', contentHash: 'sha256:abc' }]);
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

test('commit refuses to write through a symlinked state file', () => {
  const { dir, file, cleanup } = tmp();
  try {
    const decoy = join(dir, 'decoy.json');
    writeFileSync(decoy, 'do not overwrite me');
    symlinkSync(decoy, file);
    assert.throws(
      () => commit(file, { version: 1, lastRun: null, urls: {} }, [{ url: 'https://x/', contentHash: 'sha256:abc' }]),
      /symlink, refusing for security/
    );
    // Decoy must be untouched.
    assert.equal(readFileSync(decoy, 'utf8'), 'do not overwrite me');
  } finally { cleanup(); }
});

test('commit does not leave temp files behind on success', () => {
  const { dir, file, cleanup } = tmp();
  try {
    commit(file, { version: 1, lastRun: null, urls: {} }, [{ url: 'https://x/', contentHash: 'sha256:abc' }]);
    const entries = readdirSync(dir);
    assert.deepEqual(entries.sort(), ['state.json']);
  } finally { cleanup(); }
});

test('commit acquires an exclusive lock and serialises concurrent writers', async () => {
  const { file, cleanup } = tmp();
  try {
    // Seed empty state
    commit(file, { version: 1, lastRun: null, urls: {} }, []);

    // Run two parallel commits, each adding a distinct URL.
    // Without locking, the loser's url would be missing.
    await Promise.all([
      Promise.resolve().then(() => commit(file, readState(file), [
        { url: 'https://x/a/', contentHash: 'sha256:a' }
      ])),
      Promise.resolve().then(() => commit(file, readState(file), [
        { url: 'https://x/b/', contentHash: 'sha256:b' }
      ]))
    ]);

    const final = readState(file);
    assert.ok(final.urls['https://x/a/'], 'URL a must survive concurrent commit');
    assert.ok(final.urls['https://x/b/'], 'URL b must survive concurrent commit');
  } finally { cleanup(); }
});

test('commit clears its lock file on success', () => {
  const { file, cleanup } = tmp();
  try {
    commit(file, { version: 1, lastRun: null, urls: {} }, [
      { url: 'https://x/', contentHash: 'sha256:a' }
    ]);
    assert.equal(existsSync(file + '.lock'), false, 'lock must be released after commit');
  } finally { cleanup(); }
});

test('commit clears its lock file when underlying write throws', () => {
  const { dir, file, cleanup } = tmp();
  try {
    // Make the parent directory non-writable to force writeFileSync to throw.
    // (Note: when running as root chmod is bypassed; the test then skips itself.)
    if (process.getuid && process.getuid() === 0) return; // skip as root
    chmodSync(dir, 0o500);
    try {
      assert.throws(() => commit(file, { version: 1, lastRun: null, urls: {} }, [
        { url: 'https://x/', contentHash: 'sha256:a' }
      ]));
    } finally {
      chmodSync(dir, 0o700);
    }
    assert.equal(existsSync(file + '.lock'), false, 'lock must be released on error');
  } finally { cleanup(); }
});

test('commit re-reads state inside the lock so concurrent updates are not lost', () => {
  const { file, cleanup } = tmp();
  try {
    // Writer A reads, writer B reads — both have same stale snapshot.
    const snapshotForA = readState(file);  // empty
    const snapshotForB = readState(file);  // empty

    // Both commit. B should not clobber A.
    commit(file, snapshotForA, [{ url: 'https://x/a/', contentHash: 'sha256:a' }]);
    commit(file, snapshotForB, [{ url: 'https://x/b/', contentHash: 'sha256:b' }]);

    const final = readState(file);
    assert.ok(final.urls['https://x/a/']);
    assert.ok(final.urls['https://x/b/']);
  } finally { cleanup(); }
});

test('commit throws a clear timeout error when the lock is already held', () => {
  const { file, cleanup } = tmp();
  try {
    // Pre-create the lock to simulate another holder.
    const lockPath = file + '.lock';
    const fd = openSync(lockPath, 'wx');
    closeSync(fd);
    try {
      assert.throws(
        () => commit(file, { version: 1, lastRun: null, urls: {} }, [
          { url: 'https://x/', contentHash: 'sha256:a' }
        ], { lockTimeoutMs: 50 }),
        /state lock timeout/
      );
    } finally {
      // Release the simulated holder.
      rmSync(lockPath, { force: true });
    }
  } finally { cleanup(); }
});
