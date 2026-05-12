import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPing } from '../lib/run.mjs';
import { startMockServer } from './helpers/mock-http.mjs';

function fakeHexo(posts, baseDir, configOverride = {}) {
  return {
    base_dir: baseDir,
    config: {
      title: 'EinfachAleks',
      url: 'https://einfach-aleks.com',
      ping: {
        indexnow: { key: 'abc123', key_location: '/abc.txt', ...(configOverride.indexnow || {}) },
        xmlrpc: configOverride.xmlrpc || { endpoints: [] },
        ...(configOverride.top || {})
      }
    },
    locals: { get: (n) => n === 'posts' ? { data: posts } : null }
  };
}

test('runPing dry-run returns plan without HTTP', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hps-run-'));
  try {
    const hexo = fakeHexo(
      [{ permalink: 'https://x/a/', date: '2026-01-01' }],
      dir
    );
    const result = await runPing(hexo, { dryRun: true });
    assert.deepEqual(result.plan, ['https://x/a/']);
    assert.equal(result.indexnowResults, null);
    assert.equal(result.xmlrpcResults, null);
    assert.equal(existsSync(join(dir, '.hexo-ping-state.json')), false, 'state file must not be written on dry-run');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('runPing executes IndexNow + XML-RPC and writes state', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hps-run-'));
  const indexnow = await startMockServer(async () => ({ status: 200, body: '' }));
  const xmlrpc = await startMockServer(async () => ({
    status: 200, headers: { 'content-type': 'text/xml' },
    body: '<methodResponse><params/></methodResponse>'
  }));
  try {
    const hexo = fakeHexo(
      [{ permalink: 'https://x/a/', date: '2026-01-01' }],
      dir,
      {
        indexnow: { endpoint: indexnow.url },
        xmlrpc: { endpoints: [xmlrpc.url] }
      }
    );
    const result = await runPing(hexo, {});
    assert.equal(result.plan.length, 1);
    assert.equal(result.indexnowResults[0].status, 'ok');
    assert.equal(result.xmlrpcResults[0].status, 'ok');
    const state = JSON.parse(readFileSync(join(dir, '.hexo-ping-state.json'), 'utf8'));
    assert.equal(Object.keys(state.urls).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await indexnow.close();
    await xmlrpc.close();
  }
});

test('runPing second invocation skips unchanged posts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hps-run-'));
  const indexnow = await startMockServer(async () => ({ status: 200, body: '' }));
  try {
    const hexo = fakeHexo(
      [{ permalink: 'https://x/a/', date: '2026-01-01' }],
      dir,
      { indexnow: { endpoint: indexnow.url }, xmlrpc: { endpoints: [] } }
    );
    await runPing(hexo, {});
    const second = await runPing(hexo, {});
    assert.equal(second.plan.length, 0, 'unchanged post must not be re-pinged');
    assert.equal(second.indexnowResults.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await indexnow.close();
  }
});

test('runPing all=true ignores state', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hps-run-'));
  const indexnow = await startMockServer(async () => ({ status: 200, body: '' }));
  try {
    const hexo = fakeHexo(
      [{ permalink: 'https://x/a/', date: '2026-01-01' }],
      dir,
      { indexnow: { endpoint: indexnow.url }, xmlrpc: { endpoints: [] } }
    );
    await runPing(hexo, {});
    const second = await runPing(hexo, { all: true });
    assert.equal(second.plan.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await indexnow.close();
  }
});

test('runPing explicit urls override post collection', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hps-run-'));
  const indexnow = await startMockServer(async () => ({ status: 200, body: '' }));
  try {
    const hexo = fakeHexo([], dir, {
      indexnow: { endpoint: indexnow.url },
      xmlrpc: { endpoints: [] }
    });
    const result = await runPing(hexo, { urls: ['https://x/manual/'] });
    assert.deepEqual(result.plan, ['https://x/manual/']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await indexnow.close();
  }
});

test('runPing short-circuits when ping.enabled=false', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hps-run-'));
  try {
    const hexo = fakeHexo([], dir, { top: { enabled: false } });
    const result = await runPing(hexo, {});
    assert.equal(result.plan.length, 0);
    assert.equal(result.indexnowResults, null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
