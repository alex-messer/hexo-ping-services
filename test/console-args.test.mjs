import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from '../scripts/console.js';

test('parseArgs returns defaults for empty argv', () => {
  const r = parseArgs({});
  assert.equal(r.all, false);
  assert.equal(r.dryRun, false);
  assert.equal(r.verbose, false);
  assert.deepEqual(r.urls, []);
});

test('parseArgs reads --all', () => {
  const r = parseArgs({ all: true });
  assert.equal(r.all, true);
});

test('parseArgs reads --dry-run and --verbose', () => {
  const r = parseArgs({ 'dry-run': true, verbose: true });
  assert.equal(r.dryRun, true);
  assert.equal(r.verbose, true);
});

// R1-F5: --no-state and --since were silent no-ops; both removed from
// parser and help text. Tests assert the keys are absent so the regression
// (re-introducing a silent no-op) is caught immediately.
test('parseArgs does NOT expose noState (R1-F5: removed silent no-op)', () => {
  const r = parseArgs({ 'no-state': true });
  assert.equal(r.noState, undefined);
  assert.equal('noState' in r, false);
});

test('parseArgs does NOT expose since (R1-F5: removed silent no-op)', () => {
  const r = parseArgs({ since: '2026-05-01' });
  assert.equal(r.since, undefined);
  assert.equal('since' in r, false);
});

test('parseArgs reads --urls as csv', () => {
  const r = parseArgs({ urls: 'https://x/a/,https://x/b/' });
  assert.deepEqual(r.urls, ['https://x/a/', 'https://x/b/']);
});
