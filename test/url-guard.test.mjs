import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPrivateHost, assertPublicHttpUrl } from '../lib/url-guard.js';

// Ensure the test-only escape hatch from the mock helper is OFF for this suite.
delete process.env.HEXO_PING_ALLOW_PRIVATE_HOSTS;

test('isPrivateHost: empty hostname is treated as private', () => {
  assert.equal(isPrivateHost(''), true);
  assert.equal(isPrivateHost(undefined), true);
  assert.equal(isPrivateHost(null), true);
});

test('isPrivateHost: localhost variants', () => {
  assert.equal(isPrivateHost('localhost'), true);
  assert.equal(isPrivateHost('LOCALHOST'), true);
  assert.equal(isPrivateHost('ip6-localhost'), true);
  assert.equal(isPrivateHost('ip6-loopback'), true);
});

test('isPrivateHost: IPv4 loopback 127.x.x.x', () => {
  assert.equal(isPrivateHost('127.0.0.1'), true);
  assert.equal(isPrivateHost('127.255.255.254'), true);
});

test('isPrivateHost: RFC1918 10.0.0.0/8', () => {
  assert.equal(isPrivateHost('10.0.0.1'), true);
  assert.equal(isPrivateHost('10.255.255.255'), true);
});

test('isPrivateHost: RFC1918 192.168.0.0/16', () => {
  assert.equal(isPrivateHost('192.168.1.1'), true);
});

test('isPrivateHost: RFC1918 172.16-31.x.x', () => {
  assert.equal(isPrivateHost('172.16.0.1'), true);
  assert.equal(isPrivateHost('172.19.0.1'), true);
  assert.equal(isPrivateHost('172.20.0.1'), true);
  assert.equal(isPrivateHost('172.31.255.255'), true);
  // Just outside the range — must be considered public:
  assert.equal(isPrivateHost('172.15.0.1'), false);
  assert.equal(isPrivateHost('172.32.0.1'), false);
});

test('isPrivateHost: link-local 169.254/16 (includes IMDS 169.254.169.254)', () => {
  assert.equal(isPrivateHost('169.254.169.254'), true);
  assert.equal(isPrivateHost('169.254.0.1'), true);
});

test('isPrivateHost: 0.0.0.0/8 wildcard', () => {
  assert.equal(isPrivateHost('0.0.0.0'), true);
  assert.equal(isPrivateHost('0.1.2.3'), true);
});

test('isPrivateHost: IPv6 loopback and ULA', () => {
  assert.equal(isPrivateHost('::1'), true);
  assert.equal(isPrivateHost('::'), true);
  assert.equal(isPrivateHost('fc00::1'), true);
  assert.equal(isPrivateHost('fd12:3456:789a::1'), true);
});

test('isPrivateHost: IPv6 link-local fe80::/10', () => {
  assert.equal(isPrivateHost('fe80::abc'), true);
});

test('isPrivateHost: public hostnames pass through', () => {
  assert.equal(isPrivateHost('api.indexnow.org'), false);
  assert.equal(isPrivateHost('www.bing.com'), false);
  assert.equal(isPrivateHost('8.8.8.8'), false);
  assert.equal(isPrivateHost('203.0.113.1'), false);
  assert.equal(isPrivateHost('2606:4700::1111'), false);
});

test('assertPublicHttpUrl: invalid URL throws', () => {
  assert.throws(() => assertPublicHttpUrl('not a url'), /invalid URL/);
  assert.throws(() => assertPublicHttpUrl(''), /invalid URL/);
});

test('assertPublicHttpUrl: non-http(s) schemes throw', () => {
  assert.throws(() => assertPublicHttpUrl('file:///etc/passwd'), /only http\(s\) URLs allowed/);
  assert.throws(() => assertPublicHttpUrl('ftp://example.com/'), /only http\(s\) URLs allowed/);
  assert.throws(() => assertPublicHttpUrl('javascript:alert(1)'), /only http\(s\) URLs allowed/);
});

test('assertPublicHttpUrl: private host rejected', () => {
  assert.throws(() => assertPublicHttpUrl('http://127.0.0.1/x'), /refusing private\/loopback host/);
  assert.throws(() => assertPublicHttpUrl('http://169.254.169.254/latest/meta-data/'), /refusing private\/loopback host/);
  assert.throws(() => assertPublicHttpUrl('http://10.0.0.1/'), /refusing private\/loopback host/);
});

test('assertPublicHttpUrl: public URL passes and returns parsed URL', () => {
  const u = assertPublicHttpUrl('https://api.indexnow.org/IndexNow');
  assert.equal(u.hostname, 'api.indexnow.org');
  assert.equal(u.protocol, 'https:');
});

test('assertPublicHttpUrl: env-var escape hatch permits loopback', () => {
  process.env.HEXO_PING_ALLOW_PRIVATE_HOSTS = '1';
  try {
    const u = assertPublicHttpUrl('http://127.0.0.1:1234/ping');
    assert.equal(u.hostname, '127.0.0.1');
  } finally {
    delete process.env.HEXO_PING_ALLOW_PRIVATE_HOSTS;
  }
});
