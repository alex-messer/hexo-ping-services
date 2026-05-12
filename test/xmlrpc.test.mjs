import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPingPayload, pingEndpoint, pingAll } from '../lib/xmlrpc.js';
import { startMockServer } from './helpers/mock-http.mjs';

test('buildPingPayload emits weblogUpdates.ping with 2 string params', () => {
  const xml = buildPingPayload('EinfachAleks', 'https://einfach-aleks.com/');
  assert.match(xml, /<methodName>weblogUpdates\.ping<\/methodName>/);
  assert.match(xml, /<string>EinfachAleks<\/string>/);
  assert.match(xml, /<string>https:\/\/einfach-aleks\.com\/<\/string>/);
});

test('buildPingPayload emits extendedPing with 4 params when feedUrl is given', () => {
  const xml = buildPingPayload('Site', 'https://x/', 'https://x/atom.xml');
  assert.match(xml, /<methodName>weblogUpdates\.extendedPing<\/methodName>/);
  assert.match(xml, /<string>https:\/\/x\/atom\.xml<\/string>/);
  const params = xml.match(/<string>/g);
  assert.equal(params.length, 4);
});

test('buildPingPayload escapes XML special chars in siteName', () => {
  const xml = buildPingPayload('AT&T <Lab>', 'https://x/');
  assert.match(xml, /<string>AT&amp;T &lt;Lab&gt;<\/string>/);
});

test('pingEndpoint returns ok on plain <params> response', async () => {
  const server = await startMockServer(async () => ({
    status: 200,
    headers: { 'content-type': 'text/xml' },
    body: '<?xml version="1.0"?><methodResponse><params><param><value><boolean>0</boolean></value></param></params></methodResponse>'
  }));
  try {
    const r = await pingEndpoint(server.url, '<?xml ?><dummy/>', { timeoutMs: 1000 });
    assert.equal(r.status, 'ok');
    assert.equal(r.httpStatus, 200);
  } finally { await server.close(); }
});

test('pingEndpoint detects <fault> in response', async () => {
  const server = await startMockServer(async () => ({
    status: 200,
    headers: { 'content-type': 'text/xml' },
    body: '<?xml version="1.0"?><methodResponse><fault><value><struct><member><name>faultString</name><value><string>Throttled</string></value></member></struct></value></fault></methodResponse>'
  }));
  try {
    const r = await pingEndpoint(server.url, '<?xml ?><dummy/>', { timeoutMs: 1000 });
    assert.equal(r.status, 'fault');
    assert.match(r.fault, /Throttled/);
  } finally { await server.close(); }
});

test('pingEndpoint returns error on non-200', async () => {
  const server = await startMockServer(async () => ({ status: 503, body: 'busy' }));
  try {
    const r = await pingEndpoint(server.url, '<dummy/>', { timeoutMs: 1000 });
    assert.equal(r.status, 'error');
    assert.equal(r.httpStatus, 503);
  } finally { await server.close(); }
});

test('pingEndpoint respects timeoutMs', async () => {
  const server = await startMockServer(async () => {
    await new Promise(r => setTimeout(r, 200));
    return { status: 200, body: '<methodResponse><params/></methodResponse>' };
  });
  try {
    const r = await pingEndpoint(server.url, '<dummy/>', { timeoutMs: 50 });
    assert.equal(r.status, 'error');
  } finally { await server.close(); }
});

test('pingEndpoint blocks private/loopback endpoint without HTTP', async () => {
  const prev = process.env.HEXO_PING_ALLOW_PRIVATE_HOSTS;
  delete process.env.HEXO_PING_ALLOW_PRIVATE_HOSTS;
  try {
    const r = await pingEndpoint('http://127.0.0.1:1/', '<dummy/>', { timeoutMs: 1000 });
    assert.equal(r.status, 'blocked');
    assert.match(r.error, /private\/loopback host/);
  } finally {
    if (prev !== undefined) process.env.HEXO_PING_ALLOW_PRIVATE_HOSTS = prev;
  }
});

test('pingEndpoint blocks non-http(s) scheme', async () => {
  const prev = process.env.HEXO_PING_ALLOW_PRIVATE_HOSTS;
  delete process.env.HEXO_PING_ALLOW_PRIVATE_HOSTS;
  try {
    const r = await pingEndpoint('file:///etc/passwd', '<dummy/>', { timeoutMs: 1000 });
    assert.equal(r.status, 'blocked');
  } finally {
    if (prev !== undefined) process.env.HEXO_PING_ALLOW_PRIVATE_HOSTS = prev;
  }
});

test('pingAll caps parallelism via concurrency parameter', async () => {
  // Build 6 servers; with concurrency=2, at most 2 may be in flight at once.
  let inFlight = 0;
  let peak = 0;
  const make = () => startMockServer(async () => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise(r => setTimeout(r, 30));
    inFlight--;
    return { status: 200, body: '<methodResponse><params/></methodResponse>' };
  });
  const servers = await Promise.all([make(), make(), make(), make(), make(), make()]);
  try {
    const results = await pingAll(
      servers.map(s => s.url),
      'Site', 'https://x/', null,
      { timeoutMs: 2000, concurrency: 2 }
    );
    assert.equal(results.length, 6);
    assert.ok(peak <= 2, `peak in-flight must be <= 2, got ${peak}`);
  } finally {
    await Promise.all(servers.map(s => s.close()));
  }
});

test('pingAll calls every endpoint, collects results', async () => {
  const okServer = await startMockServer(async () => ({
    status: 200,
    body: '<methodResponse><params/></methodResponse>'
  }));
  const faultServer = await startMockServer(async () => ({
    status: 200,
    body: '<methodResponse><fault><value><string>nope</string></value></fault></methodResponse>'
  }));
  try {
    const results = await pingAll(
      [okServer.url, faultServer.url],
      'Site', 'https://x/', null,
      { timeoutMs: 1000 }
    );
    assert.equal(results.length, 2);
    const statuses = results.map(r => r.status).sort();
    assert.deepEqual(statuses, ['fault', 'ok']);
  } finally {
    await okServer.close();
    await faultServer.close();
  }
});
