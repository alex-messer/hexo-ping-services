import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashOf } from '../lib/hash.mjs';

test('hashOf returns deterministic sha256: hex for identical input', () => {
  const a = hashOf({ permalink: 'https://example.com/a/', date: '2026-01-01' });
  const b = hashOf({ permalink: 'https://example.com/a/', date: '2026-01-01' });
  assert.equal(a, b);
  assert.match(a, /^sha256:[0-9a-f]{64}$/);
});

test('hashOf differs when permalink differs', () => {
  const a = hashOf({ permalink: 'https://example.com/a/', date: '2026-01-01' });
  const b = hashOf({ permalink: 'https://example.com/b/', date: '2026-01-01' });
  assert.notEqual(a, b);
});

test('hashOf differs when date differs', () => {
  const a = hashOf({ permalink: 'https://example.com/a/', date: '2026-01-01' });
  const b = hashOf({ permalink: 'https://example.com/a/', date: '2026-01-02' });
  assert.notEqual(a, b);
});

test('hashOf uses updated when present, falling back to date', () => {
  const a = hashOf({ permalink: 'https://example.com/a/', date: '2026-01-01', updated: '2026-02-01' });
  const b = hashOf({ permalink: 'https://example.com/a/', date: '2026-01-01' });
  assert.notEqual(a, b, 'updated must affect the hash when present');
});

test('hashOf coerces Date objects via toISOString', () => {
  const d = new Date('2026-01-01T00:00:00.000Z');
  const a = hashOf({ permalink: 'https://example.com/a/', date: d });
  const b = hashOf({ permalink: 'https://example.com/a/', date: '2026-01-01T00:00:00.000Z' });
  assert.equal(a, b);
});
