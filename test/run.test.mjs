import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPing } from '../lib/run.js';
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

test('runPing rejects state_file outside base_dir (path traversal)', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'hps-run-base-'));
  const outsideDir = mkdtempSync(join(tmpdir(), 'hps-run-outside-'));
  try {
    const hexo = fakeHexo(
      [{ permalink: 'https://x/a/', date: '2026-01-01' }],
      baseDir,
      {
        xmlrpc: { endpoints: [] },
        top: { state_file: join(outsideDir, 'state.json') }
      }
    );
    await assert.rejects(runPing(hexo, {}), /ping\.state_file .* must be inside hexo\.base_dir/);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  }
});

test('runPing rejects state_file using ../ to escape base_dir', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'hps-run-base-'));
  try {
    const hexo = fakeHexo(
      [{ permalink: 'https://x/a/', date: '2026-01-01' }],
      baseDir,
      {
        xmlrpc: { endpoints: [] },
        top: { state_file: '../../../etc/state.json' }
      }
    );
    await assert.rejects(runPing(hexo, {}), /ping\.state_file .* must be inside hexo\.base_dir/);
  } finally { rmSync(baseDir, { recursive: true, force: true }); }
});

test('state_file rejection error does not leak absolute paths', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'hps-run-leak-'));
  try {
    const hexo = fakeHexo(
      [{ permalink: 'https://x/a/', date: '2026-01-01' }],
      baseDir,
      {
        xmlrpc: { endpoints: [] },
        top: { state_file: '../../../etc/state.json' }
      }
    );
    let caught;
    try { await runPing(hexo, {}); } catch (e) { caught = e; }
    assert.ok(caught, 'must reject');
    assert.doesNotMatch(caught.message, /\/home\//);
    assert.doesNotMatch(caught.message, /\/Users\//);
    assert.doesNotMatch(caught.message, /C:\\/);
    assert.doesNotMatch(caught.message, /\/tmp\//);
    assert.ok(caught.absolutePaths, 'absolutePaths must be set for debug logging');
    assert.ok(caught.absolutePaths.stateAbs);
    assert.ok(caught.absolutePaths.baseAbs);
  } finally { rmSync(baseDir, { recursive: true, force: true }); }
});

async function withGuardEnabled(fn) {
  const prev = process.env.HEXO_PING_ALLOW_PRIVATE_HOSTS;
  delete process.env.HEXO_PING_ALLOW_PRIVATE_HOSTS;
  try { return await fn(); }
  finally { if (prev !== undefined) process.env.HEXO_PING_ALLOW_PRIVATE_HOSTS = prev; }
}

test('runPing rejects file:/// site URL when composing keyLocation', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'hps-run-file-'));
  try {
    const hexo = fakeHexo(
      [{ permalink: 'https://x/a/', date: '2026-01-01' }],
      baseDir,
      { xmlrpc: { endpoints: [] } }
    );
    hexo.config.url = 'file:///etc/';
    await withGuardEnabled(() => assert.rejects(
      runPing(hexo, {}),
      /composed .* (only http\(s\) URLs allowed|invalid URL)/
    ));
  } finally { rmSync(baseDir, { recursive: true, force: true }); }
});

test('runPing rejects IMDS site URL (169.254.169.254)', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'hps-run-imds-'));
  try {
    const hexo = fakeHexo(
      [{ permalink: 'https://x/a/', date: '2026-01-01' }],
      baseDir,
      { xmlrpc: { endpoints: [] } }
    );
    hexo.config.url = 'http://169.254.169.254/';
    await withGuardEnabled(() => assert.rejects(
      runPing(hexo, {}),
      /composed .* refusing private\/loopback host/
    ));
  } finally { rmSync(baseDir, { recursive: true, force: true }); }
});

test('runPing rejects IPv4-mapped IPv6 IMDS site URL', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'hps-run-imds6-'));
  try {
    const hexo = fakeHexo(
      [{ permalink: 'https://x/a/', date: '2026-01-01' }],
      baseDir,
      { xmlrpc: { endpoints: [] } }
    );
    hexo.config.url = 'http://[::ffff:169.254.169.254]/';
    await withGuardEnabled(() => assert.rejects(
      runPing(hexo, {}),
      /composed .* refusing private\/loopback host/
    ));
  } finally { rmSync(baseDir, { recursive: true, force: true }); }
});

test('runPing does NOT commit state when every engine fails', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hps-run-'));
  // IndexNow returns 403 (forbidden), XML-RPC returns 503 (error).
  const indexnow = await startMockServer(async () => ({ status: 403, body: '' }));
  const xmlrpc = await startMockServer(async () => ({ status: 503, body: 'busy' }));
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
    assert.equal(result.indexnowResults[0].status, 'forbidden');
    assert.equal(result.xmlrpcResults[0].status, 'error');
    assert.equal(
      existsSync(join(dir, '.hexo-ping-state.json')),
      false,
      'state file MUST NOT be written when every engine failed'
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await indexnow.close();
    await xmlrpc.close();
  }
});

test('runPing commits state when at least one engine succeeds', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hps-run-'));
  // IndexNow fails (403), XML-RPC succeeds (200) — partial success commits.
  const indexnow = await startMockServer(async () => ({ status: 403, body: '' }));
  const xmlrpc = await startMockServer(async () => ({
    status: 200, body: '<methodResponse><params/></methodResponse>'
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
    await runPing(hexo, {});
    assert.equal(existsSync(join(dir, '.hexo-ping-state.json')), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await indexnow.close();
    await xmlrpc.close();
  }
});

test('runPing passes concurrency parameter to pingAll', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hps-run-'));
  let inFlight = 0;
  let peak = 0;
  const make = () => startMockServer(async () => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise(r => setTimeout(r, 30));
    inFlight--;
    return { status: 200, body: '<methodResponse><params/></methodResponse>' };
  });
  const servers = await Promise.all([make(), make(), make(), make()]);
  const indexnow = await startMockServer(async () => ({ status: 200, body: '' }));
  try {
    const hexo = fakeHexo(
      [{ permalink: 'https://x/a/', date: '2026-01-01' }],
      dir,
      {
        indexnow: { endpoint: indexnow.url },
        xmlrpc: { endpoints: servers.map(s => s.url) },
        top: { concurrency: 2 }
      }
    );
    await runPing(hexo, {});
    assert.ok(peak <= 2, `peak in-flight must be <= 2, got ${peak}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await Promise.all(servers.map(s => s.close()));
    await indexnow.close();
  }
});

test('runPing fans out to websub hubs when websub.enabled with hubs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hps-run-'));
  let captured = null;
  const hub = await startMockServer(async ({ body, headers }) => {
    captured = { body, contentType: headers['content-type'] };
    return { status: 204, body: '' };
  });
  const indexnow = await startMockServer(async () => ({ status: 200, body: '' }));
  try {
    const hexo = fakeHexo(
      [{ permalink: 'https://x/a/', date: '2026-01-01' }],
      dir,
      {
        indexnow: { endpoint: indexnow.url },
        xmlrpc: { endpoints: [] },
        top: {
          websub: { enabled: true, hubs: [hub.url], feed_url: '/atom.xml' }
        }
      }
    );
    const result = await runPing(hexo, {});
    assert.equal(result.websubResults.length, 1);
    assert.equal(result.websubResults[0].status, 'ok');
    assert.equal(result.websubResults[0].httpStatus, 204);
    assert.match(captured.contentType, /application\/x-www-form-urlencoded/);
    const params = new URLSearchParams(captured.body);
    assert.equal(params.get('hub.mode'), 'publish');
    assert.equal(params.get('hub.url'), 'https://einfach-aleks.com/atom.xml');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await hub.close();
    await indexnow.close();
  }
});

test('runPing default websubResults is empty array when websub disabled', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hps-run-'));
  const indexnow = await startMockServer(async () => ({ status: 200, body: '' }));
  try {
    const hexo = fakeHexo(
      [{ permalink: 'https://x/a/', date: '2026-01-01' }],
      dir,
      { indexnow: { endpoint: indexnow.url }, xmlrpc: { endpoints: [] } }
    );
    const result = await runPing(hexo, {});
    assert.deepEqual(result.websubResults, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await indexnow.close();
  }
});

test('runPing commits state when only websub engine succeeds', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hps-run-'));
  // IndexNow fails (403), no xmlrpc, websub succeeds.
  const indexnow = await startMockServer(async () => ({ status: 403, body: '' }));
  const hub = await startMockServer(async () => ({ status: 204, body: '' }));
  try {
    const hexo = fakeHexo(
      [{ permalink: 'https://x/a/', date: '2026-01-01' }],
      dir,
      {
        indexnow: { endpoint: indexnow.url },
        xmlrpc: { endpoints: [] },
        top: { websub: { enabled: true, hubs: [hub.url], feed_url: '/atom.xml' } }
      }
    );
    await runPing(hexo, {});
    assert.equal(existsSync(join(dir, '.hexo-ping-state.json')), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await hub.close();
    await indexnow.close();
  }
});

test('runPing accepts absolute websub feed_url', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hps-run-'));
  let captured = null;
  const hub = await startMockServer(async ({ body }) => {
    captured = body;
    return { status: 204, body: '' };
  });
  const indexnow = await startMockServer(async () => ({ status: 200, body: '' }));
  try {
    const hexo = fakeHexo(
      [{ permalink: 'https://x/a/', date: '2026-01-01' }],
      dir,
      {
        indexnow: { endpoint: indexnow.url },
        xmlrpc: { endpoints: [] },
        top: {
          websub: {
            enabled: true,
            hubs: [hub.url],
            feed_url: 'https://feeds.example.com/blog.xml'
          }
        }
      }
    );
    await runPing(hexo, {});
    const params = new URLSearchParams(captured);
    assert.equal(params.get('hub.url'), 'https://feeds.example.com/blog.xml');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await hub.close();
    await indexnow.close();
  }
});

test('runPing rejects pseudo-http key_location like httpevil.example.com/x.txt', async () => {
  // M1 fix: keyLocation that "starts with http" but isn't really an http URL
  // must be treated as a path and joined to the site URL.
  const dir = mkdtempSync(join(tmpdir(), 'hps-run-'));
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
          key_location: 'httpevil.example.com/x.txt' // looks like http but not a URL
        },
        xmlrpc: { endpoints: [] }
      }
    );
    await runPing(hexo, {});
    // Should have been treated as a relative path and joined to siteUrl:
    assert.equal(received.keyLocation, 'https://einfach-aleks.comhttpevil.example.com/x.txt');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await indexnow.close();
  }
});
