import { test } from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns';
import { startMockServer } from './helpers/mock-http.mjs';
import { request, TRUNCATED_SENTINEL } from '../lib/http-client.js';
import urlGuard from '../lib/url-guard.js';
const { _internal: { makePinnedLookup } } = urlGuard;

test('request connects to the pinned IP and never consults the platform resolver (MED-01)', async () => {
  // The mock server listens on 127.0.0.1. We hand request() a URL whose
  // hostname is a public-looking name that does NOT resolve there, plus a
  // lookup pinned to the server's real address. The platform callback resolver
  // — the path http.request would take WITHOUT a pin — is rigged to fail. A
  // successful connection therefore proves the pinned IP carried the request,
  // so a rebinding second resolution is structurally impossible.
  const server = await startMockServer(async () => ({ status: 200, body: 'pinned-ok' }));
  const { hostname: ip, port } = new URL(server.url);
  const pinnedLookup = makePinnedLookup([{ address: ip, family: 4 }]);

  const origLookup = dns.lookup;
  dns.lookup = (_host, _opts, cb) => {
    const fn = typeof _opts === 'function' ? _opts : cb;
    fn(new Error('platform resolver must not be consulted when a pin is supplied'));
  };
  try {
    const resp = await request(`http://attacker.example.com:${port}/`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'x',
      timeoutMs: 2000,
      lookup: pinnedLookup
    });
    assert.equal(resp.status, 200);
    const body = await resp.text();
    assert.equal(body, 'pinned-ok');
  } finally {
    dns.lookup = origLookup;
    await server.close();
  }
});

test('request does not follow redirects: a 3xx is returned as a terminal response', async () => {
  const target = await startMockServer(async () => ({ status: 200, body: 'reached' }));
  const redir = await startMockServer(async () => ({
    status: 302, headers: { location: target.url }, body: ''
  }));
  try {
    const resp = await request(redir.url, { method: 'GET', timeoutMs: 1000 });
    assert.equal(resp.status, 302);
    resp.stream.resume();
  } finally {
    await target.close();
    await redir.close();
  }
});

test('request surfaces a network-error-shaped rejection on timeout', async () => {
  const server = await startMockServer(async () => {
    await new Promise(r => setTimeout(r, 200));
    return { status: 200, body: '' };
  });
  try {
    await assert.rejects(
      request(server.url, { method: 'GET', timeoutMs: 30 }),
      (err) => err instanceof Error
    );
  } finally {
    await server.close();
  }
});

test('request readBodyCapped truncates an oversized body to the sentinel', async () => {
  const big = 'a'.repeat(200 * 1024);
  const server = await startMockServer(async () => ({ status: 200, body: big }));
  try {
    const resp = await request(server.url, { method: 'GET', timeoutMs: 2000 });
    const body = await resp.readBodyCapped(64 * 1024);
    assert.equal(body, TRUNCATED_SENTINEL);
  } finally {
    await server.close();
  }
});

test('request readBodyCapped returns the full body when under the cap', async () => {
  const server = await startMockServer(async () => ({ status: 200, body: 'small body' }));
  try {
    const resp = await request(server.url, { method: 'GET', timeoutMs: 2000 });
    const body = await resp.readBodyCapped(64 * 1024);
    assert.equal(body, 'small body');
  } finally {
    await server.close();
  }
});

// R1-F2: Slowloris — body-read must be bounded by the overall request timeout.
// A server that sends headers immediately then dribbles body bytes MUST NOT
// hold the worker indefinitely. Before the fix, clearTimeout(timer) ran on
// header arrival and the body phase had no time bound.
test('R1-F2: request aborts when body read exceeds timeoutMs (slowloris-style server)', async () => {
  const { createServer } = await import('node:http');
  const server = createServer((req, res) => {
    // Send headers immediately so the response callback fires…
    res.writeHead(200, { 'content-type': 'text/xml', 'content-length': '8192' });
    res.write('a'); // first body byte
    // …then never send the remaining bytes. Without the fix, readBodyCapped
    // waits forever (until the OS-level socket timeout, if any).
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const started = Date.now();
  try {
    const resp = await request(`http://127.0.0.1:${port}/`, { method: 'GET', timeoutMs: 150 });
    assert.equal(resp.status, 200);
    // The header arrived fine. Now readBodyCapped MUST reject within the
    // total deadline (timeoutMs), not hang waiting for more bytes.
    await assert.rejects(
      resp.readBodyCapped(64 * 1024),
      (err) => err instanceof Error
    );
    const elapsed = Date.now() - started;
    // Must abort well before any default OS / Node-level timeout (~minutes).
    // Generous bound (4×) avoids CI flakiness while still proving the bound.
    assert.ok(elapsed < 4 * 150 + 500, `body read should respect timeoutMs (elapsed=${elapsed}ms)`);
  } finally {
    server.closeAllConnections?.();
    await new Promise(r => server.close(r));
  }
});

test('request lowercases response header names and exposes status', async () => {
  const server = await startMockServer(async () => ({
    status: 429,
    headers: { 'Retry-After': '7', 'content-type': 'application/json' },
    body: ''
  }));
  try {
    const resp = await request(server.url, { method: 'GET', timeoutMs: 1000 });
    resp.stream.resume();
    assert.equal(resp.status, 429);
    assert.equal(resp.headers['retry-after'], '7');
  } finally {
    await server.close();
  }
});
