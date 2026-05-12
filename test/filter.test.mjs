import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerFilter } from '../scripts/filter.js';
import { startMockServer } from './helpers/mock-http.mjs';

function tmpDir(prefix) {
  const d = mkdtempSync(join(tmpdir(), prefix));
  return { dir: d, cleanup: () => rmSync(d, { recursive: true, force: true }) };
}

function makeFakeHexo({ posts = [], pingConfig, baseDir }) {
  const filterHandlers = new Map();
  return {
    base_dir: baseDir,
    config: {
      title: 'EinfachAleks',
      url: 'https://einfach-aleks.com',
      ping: pingConfig
    },
    locals: { get: (n) => n === 'posts' ? { data: posts } : null },
    log: { info: () => {}, warn: () => {} },
    extend: {
      console: { register: () => {} },
      filter: {
        register: (event, handler) => {
          if (!filterHandlers.has(event)) filterHandlers.set(event, []);
          filterHandlers.get(event).push(handler);
        }
      }
    },
    _invokeFilter(event) {
      const arr = filterHandlers.get(event) || [];
      return Promise.all(arr.map(h => h.call(this)));
    }
  };
}

test('after_generate filter is a no-op when run_after_generate=false', async () => {
  const { dir, cleanup } = tmpDir('hps-filter-noop-');
  try {
    const logs = [];
    const hexo = makeFakeHexo({
      baseDir: dir,
      posts: [{ permalink: 'https://x/a/', date: '2026-01-01' }],
      pingConfig: {
        indexnow: { key: 'abc', key_location: '/abc.txt' },
        xmlrpc: { endpoints: [] }
      }
    });
    hexo.log = { info: (m) => logs.push(['info', m]), warn: (m) => logs.push(['warn', m]) };
    registerFilter(hexo);
    await hexo._invokeFilter('after_generate');
    assert.equal(logs.length, 0, 'no log when run_after_generate=false');
  } finally { cleanup(); }
});

test('after_generate filter runs and logs info when run_after_generate=true', async () => {
  const { dir, cleanup } = tmpDir('hps-filter-run-');
  const indexnow = await startMockServer(async () => ({ status: 200, body: '' }));
  try {
    const logs = [];
    const hexo = makeFakeHexo({
      baseDir: dir,
      posts: [{ permalink: 'https://x/a/', date: '2026-01-01' }],
      pingConfig: {
        run_after_generate: true,
        indexnow: { key: 'abc', key_location: '/abc.txt', endpoint: indexnow.url },
        xmlrpc: { endpoints: [] }
      }
    });
    hexo.log = { info: (m) => logs.push(['info', m]), warn: (m) => logs.push(['warn', m]) };
    registerFilter(hexo);
    await hexo._invokeFilter('after_generate');
    const info = logs.find(([lvl]) => lvl === 'info');
    assert.ok(info, 'info log must be emitted');
    assert.match(info[1], /pinged 1 URL/);
  } finally {
    await indexnow.close();
    cleanup();
  }
});

test('after_generate filter logs warn when runPing throws inside try', async () => {
  const { dir, cleanup } = tmpDir('hps-filter-warn-');
  try {
    const logs = [];
    const hexo = makeFakeHexo({
      baseDir: dir,
      posts: [{ permalink: 'https://x/a/', date: '2026-01-01' }],
      pingConfig: {
        run_after_generate: true,
        indexnow: { key: 'abc', key_location: '/abc.txt' },
        xmlrpc: { endpoints: [] }
      }
    });
    // Sabotage hexo.config.url so new URL() inside runPing throws when
    // building the indexnow host. This trips the inner catch in the filter.
    hexo.config.url = 'not-a-url';
    hexo.log = { info: (m) => logs.push(['info', m]), warn: (m) => logs.push(['warn', m]) };
    registerFilter(hexo);
    await hexo._invokeFilter('after_generate');
    const warn = logs.find(([lvl]) => lvl === 'warn');
    assert.ok(warn, 'warn log must be emitted on runPing error');
    assert.match(warn[1], /hexo-ping-services \(after_generate\)/);
  } finally { cleanup(); }
});
