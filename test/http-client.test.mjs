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
