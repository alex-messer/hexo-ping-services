import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readState, diff, commit } from '../lib/state.mjs';

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

test('commit does not leave temp files behind on success', () => {
  const { dir, file, cleanup } = tmp();
  try {
    commit(file, { version: 1, lastRun: null, urls: {} }, [{ url: 'https://x/', contentHash: 'sha256:abc' }]);
    const entries = readdirSync(dir);
    assert.deepEqual(entries.sort(), ['state.json']);
  } finally { cleanup(); }
});
