import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readState } from '../lib/state.js';
import { runPing } from '../lib/run.js';
import { submitIndexNow } from '../lib/indexnow.js';
import { pingEndpoint } from '../lib/xmlrpc.js';
import { startMockServer } from './helpers/mock-http.mjs';

function tmp(prefix) {
  const d = mkdtempSync(join(tmpdir(), prefix));
  return { dir: d, file: join(d, 'state.json'), cleanup: () => rmSync(d, { recursive: true, force: true }) };
}

// state.js: parse failure path (line 17-18) ---------------------------------

test('readState falls back to empty on malformed JSON', () => {
  const { file, cleanup } = tmp('hps-state-bad-');
  try {
    writeFileSync(file, '{not valid json');
    const s = readState(file);
    assert.equal(s.version, 1);
    assert.equal(s.lastRun, null);
    assert.deepEqual(s.urls, {});
  } finally { cleanup(); }
});

test('readState falls back to empty on version mismatch', () => {
  const { file, cleanup } = tmp('hps-state-ver-');
  try {
    writeFileSync(file, JSON.stringify({ version: 2, lastRun: 't', urls: { 'https://x/': {} } }));
    const s = readState(file);
    assert.equal(s.version, 1);
    assert.equal(s.lastRun, null);
    assert.deepEqual(s.urls, {});
  } finally { cleanup(); }
});

// indexnow.js: empty URLs short-circuit -------------------------------------

test('submitIndexNow returns [] for empty urls without HTTP', async () => {
  const out = await submitIndexNow(
    { endpoint: 'http://127.0.0.1:1/should-never-be-called', host: 'x', key: 'k', keyLocation: '/k.txt' },
    []
  );
  assert.deepEqual(out, []);
});

// xmlrpc.js: <fault> with no <string> falls back to "unspecified" -----------

test('pingEndpoint reports fault="unspecified" when <fault> has no <string>', async () => {
  const srv = await startMockServer(async () => ({
    status: 200,
    headers: { 'content-type': 'text/xml' },
    body: '<methodResponse><fault><value><struct/></value></fault></methodResponse>'
  }));
  try {
    const r = await pingEndpoint(srv.url, '<x/>', { timeoutMs: 1000 });
    assert.equal(r.status, 'fault');
    assert.equal(r.fault, 'unspecified');
  } finally {
    await srv.close();
  }
});

// run.js: absolute stateFile path (line 23) ---------------------------------

function fakeHexo(posts, baseDir, configOverride = {}) {
  return {
    base_dir: baseDir,
    config: {
      title: 'EinfachAleks',
      url: 'https://einfach-aleks.com',
      ping: {
        indexnow: { key: 'abc123', key_location: '/abc.txt', ...configOverride.indexnow },
        xmlrpc: configOverride.xmlrpc || { endpoints: [] },
        ...configOverride.top
      }
    },
    locals: { get: (n) => n === 'posts' ? { data: posts } : null }
  };
}

test('runPing honors absolute state_file path inside base_dir', async () => {
  const { dir, cleanup } = tmp('hps-run-abs-');
  // Absolute path is allowed when it still resolves under hexo.base_dir.
  const absState = join(dir, 'sub', 'absolute-state.json');
  const indexnow = await startMockServer(async () => ({ status: 200, body: '' }));
  try {
    // Ensure parent dir exists for the state writer.
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(dir, 'sub'), { recursive: true });
    const hexo = fakeHexo(
      [{ permalink: 'https://x/a/', date: '2026-01-01' }],
      dir,
      {
        indexnow: { endpoint: indexnow.url },
        xmlrpc: { endpoints: [] },
        top: { state_file: absState }
      }
    );
    await runPing(hexo, {});
    assert.ok(existsSync(absState), 'state file must be written at the absolute path');
  } finally {
    await indexnow.close();
    cleanup();
  }
});

// run.js: indexnow.key_location starts with http -> absolute keyLocation
test('runPing accepts absolute indexnow key_location URL', async () => {
  const { dir, cleanup } = tmp('hps-run-keyloc-');
  let received;
  const indexnow = await startMockServer(async ({ body }) => {
    received = JSON.parse(body);
    return { status: 200, body: '' };
  });
  try {
    const hexo = fakeHexo(
      [{ permalink: 'https://x/a/', date: '2026-01-01' }],
      dir,
      {
        indexnow: {
          endpoint: indexnow.url,
          key_location: 'https://cdn.example.com/keys/abc123.txt'
        },
        xmlrpc: { endpoints: [] }
      }
    );
    await runPing(hexo, {});
    assert.equal(received.keyLocation, 'https://cdn.example.com/keys/abc123.txt');
  } finally {
    await indexnow.close();
    cleanup();
  }
});

// run.js: xmlrpc.feed_url starts with http -> absolute feedUrl
test('runPing accepts absolute xmlrpc feed_url URL', async () => {
  const { dir, cleanup } = tmp('hps-run-feed-');
  let receivedBody;
  const xmlrpc = await startMockServer(async ({ body }) => {
    receivedBody = body;
    return {
      status: 200,
      headers: { 'content-type': 'text/xml' },
      body: '<methodResponse><params/></methodResponse>'
    };
  });
  const indexnow = await startMockServer(async () => ({ status: 200, body: '' }));
  try {
    const hexo = fakeHexo(
      [{ permalink: 'https://x/a/', date: '2026-01-01' }],
      dir,
      {
        indexnow: { endpoint: indexnow.url },
        xmlrpc: { endpoints: [xmlrpc.url], feed_url: 'https://example.com/atom.xml' }
      }
    );
    await runPing(hexo, {});
    assert.ok(receivedBody.includes('https://example.com/atom.xml'));
    assert.ok(receivedBody.includes('weblogUpdates.extendedPing'));
  } finally {
    await xmlrpc.close();
    await indexnow.close();
    cleanup();
  }
});

// run.js: xmlrpc.feed_url is relative path -> joined to url
test('runPing resolves relative xmlrpc feed_url against site URL', async () => {
  const { dir, cleanup } = tmp('hps-run-feed-rel-');
  let receivedBody;
  const xmlrpc = await startMockServer(async ({ body }) => {
    receivedBody = body;
    return {
      status: 200,
      headers: { 'content-type': 'text/xml' },
      body: '<methodResponse><params/></methodResponse>'
    };
  });
  const indexnow = await startMockServer(async () => ({ status: 200, body: '' }));
  try {
    const hexo = fakeHexo(
      [{ permalink: 'https://x/a/', date: '2026-01-01' }],
      dir,
      {
        indexnow: { endpoint: indexnow.url },
        xmlrpc: { endpoints: [xmlrpc.url], feed_url: '/atom.xml' }
      }
    );
    await runPing(hexo, {});
    assert.ok(receivedBody.includes('https://einfach-aleks.com/atom.xml'));
  } finally {
    await xmlrpc.close();
    await indexnow.close();
    cleanup();
  }
});
