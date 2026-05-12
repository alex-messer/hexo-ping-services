import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startMockServer } from './helpers/mock-http.mjs';
import { publishToHub, publishToHubs } from '../lib/websub.js';

test('publishToHub POSTs form-urlencoded body with hub.mode + hub.url', async () => {
  let captured = null;
  const server = await startMockServer(async ({ method, body, headers }) => {
    captured = { method, body, contentType: headers['content-type'] };
    return { status: 204, body: '' };
  });
  try {
    const result = await publishToHub(server.url, 'https://einfach-aleks.com/atom.xml', { timeoutMs: 1000 });
    assert.equal(captured.method, 'POST');
    assert.match(captured.contentType, /application\/x-www-form-urlencoded/);
    const params = new URLSearchParams(captured.body);
    assert.equal(params.get('hub.mode'), 'publish');
    assert.equal(params.get('hub.url'), 'https://einfach-aleks.com/atom.xml');
    assert.equal(result.status, 'ok');
    assert.equal(result.httpStatus, 204);
  } finally { await server.close(); }
});

test('publishToHub url-encodes feed urls with special chars', async () => {
  let captured = null;
  const server = await startMockServer(async ({ body }) => {
    captured = body;
    return { status: 204, body: '' };
  });
  try {
    await publishToHub(server.url, 'https://x/feed?q=a&b', { timeoutMs: 1000 });
    const params = new URLSearchParams(captured);
    assert.equal(params.get('hub.url'), 'https://x/feed?q=a&b');
  } finally { await server.close(); }
});

test('publishToHub maps 200 and 202 and 204 to ok', async () => {
  for (const status of [200, 202, 204]) {
    const server = await startMockServer(async () => ({ status, body: '' }));
    try {
      const r = await publishToHub(server.url, 'https://x/feed', { timeoutMs: 1000 });
      assert.equal(r.status, 'ok', `HTTP ${status} should map to ok`);
    } finally { await server.close(); }
  }
});

test('publishToHub maps 429 to rate-limited', async () => {
  const server = await startMockServer(async () => ({ status: 429, body: '' }));
  try {
    const r = await publishToHub(server.url, 'https://x/feed', { timeoutMs: 1000 });
    assert.equal(r.status, 'rate-limited');
  } finally { await server.close(); }
});

test('publishToHub maps non-2xx to error', async () => {
  const server = await startMockServer(async () => ({ status: 500, body: 'boom' }));
  try {
    const r = await publishToHub(server.url, 'https://x/feed', { timeoutMs: 1000 });
    assert.equal(r.status, 'error');
    assert.equal(r.httpStatus, 500);
  } finally { await server.close(); }
});

test('publishToHub respects timeoutMs', async () => {
  const server = await startMockServer(async () => {
    await new Promise(r => setTimeout(r, 200));
    return { status: 204, body: '' };
  });
  try {
    const r = await publishToHub(server.url, 'https://x/feed', { timeoutMs: 50 });
    assert.equal(r.status, 'error');
  } finally { await server.close(); }
});

test('publishToHub refuses private hosts (SSRF guard, reuses url-guard)', async () => {
  // Temporarily disable the loopback exemption so the guard runs as in prod.
  const prev = process.env.HEXO_PING_ALLOW_PRIVATE_HOSTS;
  delete process.env.HEXO_PING_ALLOW_PRIVATE_HOSTS;
  try {
    const r = await publishToHub('http://127.0.0.1:9999/', 'https://x/feed', { timeoutMs: 100 });
    assert.equal(r.status, 'blocked');
  } finally {
    if (prev !== undefined) process.env.HEXO_PING_ALLOW_PRIVATE_HOSTS = prev;
  }
});

test('publishToHub uses redirect:manual to prevent redirect-to-private SSRF', async () => {
  const target = await startMockServer(async () => ({ status: 204, body: '' }));
  const redir = await startMockServer(async () => ({ status: 301, headers: { location: target.url }, body: '' }));
  try {
    const r = await publishToHub(redir.url, 'https://x/feed', { timeoutMs: 1000 });
    // With redirect:manual, the 301 itself counts as a non-2xx → error.
    assert.equal(r.status, 'error');
    assert.equal(r.httpStatus, 301);
  } finally { await target.close(); await redir.close(); }
});

test('publishToHubs fans out to each hub with concurrency cap', async () => {
  const a = await startMockServer(async () => ({ status: 204, body: '' }));
  const b = await startMockServer(async () => ({ status: 204, body: '' }));
  try {
    const results = await publishToHubs([a.url, b.url], 'https://x/feed', { timeoutMs: 1000, concurrency: 1 });
    assert.equal(results.length, 2);
    assert.deepEqual(results.map(r => r.status).sort(), ['ok', 'ok']);
  } finally { await a.close(); await b.close(); }
});

test('publishToHubs returns empty when no hubs configured', async () => {
  const r = await publishToHubs([], 'https://x/feed', { timeoutMs: 1000 });
  assert.deepEqual(r, []);
});
