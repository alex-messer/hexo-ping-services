import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from '../scripts/console.mjs';

test('parseArgs returns defaults for empty argv', () => {
  const r = parseArgs({});
  assert.equal(r.all, false);
  assert.equal(r.dryRun, false);
  assert.equal(r.verbose, false);
  assert.equal(r.noState, false);
  assert.equal(r.since, null);
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

test('parseArgs reads --no-state', () => {
  const r = parseArgs({ 'no-state': true });
  assert.equal(r.noState, true);
});

test('parseArgs reads --since=ISO', () => {
  const r = parseArgs({ since: '2026-05-01' });
  assert.equal(r.since, '2026-05-01');
});

test('parseArgs reads --urls as csv', () => {
  const r = parseArgs({ urls: 'https://x/a/,https://x/b/' });
  assert.deepEqual(r.urls, ['https://x/a/', 'https://x/b/']);
});
