import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectUrls } from '../lib/collect-urls.js';

function fakeHexo(posts) {
  return {
    locals: {
      get(name) {
        if (name !== 'posts') throw new Error('unexpected: ' + name);
        return { data: posts, toArray: () => posts };
      }
    }
  };
}

test('collectUrls returns urls + hashes for all eligible posts', () => {
  const posts = [
    { permalink: 'https://x/a/', date: '2026-01-01', published: true, noindex: false, ping: true },
    { permalink: 'https://x/b/', date: '2026-02-01', published: true, noindex: false, ping: true }
  ];
  const result = collectUrls(fakeHexo(posts));
  assert.equal(result.length, 2);
  assert.equal(result[0].url, 'https://x/b/');
  assert.equal(result[1].url, 'https://x/a/');
  assert.match(result[0].contentHash, /^sha256:[0-9a-f]{64}$/);
});

test('collectUrls skips noindex posts', () => {
  const posts = [
    { permalink: 'https://x/a/', date: '2026-01-01', published: true, noindex: true, ping: true },
    { permalink: 'https://x/b/', date: '2026-02-01', published: true, noindex: false, ping: true }
  ];
  const result = collectUrls(fakeHexo(posts));
  assert.deepEqual(result.map(r => r.url), ['https://x/b/']);
});

test('collectUrls skips ping:false posts', () => {
  const posts = [
    { permalink: 'https://x/a/', date: '2026-01-01', published: true, noindex: false, ping: false },
    { permalink: 'https://x/b/', date: '2026-02-01', published: true, noindex: false, ping: true }
  ];
  const result = collectUrls(fakeHexo(posts));
  assert.deepEqual(result.map(r => r.url), ['https://x/b/']);
});

test('collectUrls skips unpublished posts', () => {
  const posts = [
    { permalink: 'https://x/a/', date: '2026-01-01', published: false, noindex: false, ping: true },
    { permalink: 'https://x/b/', date: '2026-02-01', published: true, noindex: false, ping: true }
  ];
  const result = collectUrls(fakeHexo(posts));
  assert.deepEqual(result.map(r => r.url), ['https://x/b/']);
});

test('collectUrls treats undefined ping/noindex as defaults', () => {
  const posts = [
    { permalink: 'https://x/a/', date: '2026-01-01' }
  ];
  const result = collectUrls(fakeHexo(posts));
  assert.equal(result.length, 1);
  assert.equal(result[0].url, 'https://x/a/');
});

test('collectUrls uses updated when present for sort', () => {
  const posts = [
    { permalink: 'https://x/a/', date: '2026-01-01', updated: '2026-03-01' },
    { permalink: 'https://x/b/', date: '2026-02-01' }
  ];
  const result = collectUrls(fakeHexo(posts));
  assert.equal(result[0].url, 'https://x/a/');
});
