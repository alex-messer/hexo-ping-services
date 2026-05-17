import { test } from 'node:test';
import assert from 'node:assert/strict';
import urlGuard from '../lib/url-guard.js';
const { isPrivateHost, assertPublicHttpUrl, _internal } = urlGuard;

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

test('assertPublicHttpUrl: env-var escape hatch permits loopback when NODE_ENV=test', () => {
  const prevAllow = process.env.HEXO_PING_ALLOW_PRIVATE_HOSTS;
  const prevNodeEnv = process.env.NODE_ENV;
  process.env.HEXO_PING_ALLOW_PRIVATE_HOSTS = '1';
  process.env.NODE_ENV = 'test';
  try {
    const u = assertPublicHttpUrl('http://127.0.0.1:1234/ping');
    assert.equal(u.hostname, '127.0.0.1');
  } finally {
    if (prevAllow === undefined) delete process.env.HEXO_PING_ALLOW_PRIVATE_HOSTS;
    else process.env.HEXO_PING_ALLOW_PRIVATE_HOSTS = prevAllow;
    if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevNodeEnv;
  }
});

test('isPrivateHost: ::ffff:169.254.169.254 (IMDS via IPv4-mapped IPv6)', () => {
  assert.equal(isPrivateHost('::ffff:169.254.169.254'), true);
  assert.equal(isPrivateHost('[::ffff:169.254.169.254]'), true);
});

test('isPrivateHost: ::ffff:7f00:1 (loopback via packed-hex form)', () => {
  // 7f00:0001 == 127.0.0.1
  assert.equal(isPrivateHost('::ffff:7f00:1'), true);
  assert.equal(isPrivateHost('[::ffff:7f00:1]'), true);
});

test('isPrivateHost: ::ffff:a00:1 (10.0.0.1 via packed-hex)', () => {
  // 0a00:0001 == 10.0.0.1
  assert.equal(isPrivateHost('::ffff:a00:1'), true);
  assert.equal(isPrivateHost('[::ffff:a00:1]'), true);
});

test('isPrivateHost: ::ffff:c0a8:101 (192.168.1.1 via packed-hex)', () => {
  // c0a8:0101 == 192.168.1.1
  assert.equal(isPrivateHost('::ffff:c0a8:101'), true);
  assert.equal(isPrivateHost('[::ffff:c0a8:101]'), true);
});

test('isPrivateHost: ::ffff:a9fe:a9fe (169.254.169.254 packed-hex IMDS)', () => {
  // a9fe:a9fe == 169.254.169.254
  assert.equal(isPrivateHost('::ffff:a9fe:a9fe'), true);
  assert.equal(isPrivateHost('[::ffff:a9fe:a9fe]'), true);
});

test('assertPublicHttpUrl rejects IPv4-mapped IPv6 URLs', () => {
  const cases = [
    'http://[::ffff:169.254.169.254]/latest/meta-data/',
    'http://[::ffff:7f00:1]/',
    'http://[::ffff:a00:1]/',
    'http://[::ffff:c0a8:101]/',
    'http://[::ffff:a9fe:a9fe]/'
  ];
  for (const c of cases) {
    assert.throws(
      () => assertPublicHttpUrl(c),
      /refusing private\/loopback host/,
      `must reject ${c}`
    );
  }
});

test('unwrapIpv4MappedIpv6 returns dotted-quad for valid forms', () => {
  const f = _internal.unwrapIpv4MappedIpv6;
  assert.equal(f('::ffff:169.254.169.254'), '169.254.169.254');
  assert.equal(f('[::ffff:169.254.169.254]'), '169.254.169.254');
  assert.equal(f('::ffff:7f00:1'), '127.0.0.1');
  assert.equal(f('::ffff:a9fe:a9fe'), '169.254.169.254');
  assert.equal(f('::ffff:a00:1'), '10.0.0.1');
  assert.equal(f('::ffff:c0a8:101'), '192.168.1.1');
});

test('unwrapIpv4MappedIpv6 returns null for non-mapped IPv6', () => {
  const f = _internal.unwrapIpv4MappedIpv6;
  assert.equal(f('::1'), null);
  assert.equal(f('2606:4700::1111'), null);
  assert.equal(f('fe80::abc'), null);
  assert.equal(f('api.indexnow.org'), null);
});

test('bypass IGNORED when NODE_ENV is not test, warning to stderr', () => {
  _internal._resetBypassWarned();
  const prevAllow = process.env.HEXO_PING_ALLOW_PRIVATE_HOSTS;
  const prevNodeEnv = process.env.NODE_ENV;
  process.env.HEXO_PING_ALLOW_PRIVATE_HOSTS = '1';
  process.env.NODE_ENV = 'production';
  const captured = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = (s) => { captured.push(String(s)); return true; };
  try {
    assert.throws(
      () => assertPublicHttpUrl('http://127.0.0.1:1234/ping'),
      /refusing private\/loopback host/
    );
  } finally {
    process.stderr.write = orig;
    if (prevAllow === undefined) delete process.env.HEXO_PING_ALLOW_PRIVATE_HOSTS;
    else process.env.HEXO_PING_ALLOW_PRIVATE_HOSTS = prevAllow;
    if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevNodeEnv;
    _internal._resetBypassWarned();
  }
  assert.match(captured.join(''), /HEXO_PING_ALLOW_PRIVATE_HOSTS is set but NODE_ENV is not/);
});

test('bypass warning is emitted at most once per process', () => {
  _internal._resetBypassWarned();
  const prevAllow = process.env.HEXO_PING_ALLOW_PRIVATE_HOSTS;
  const prevNodeEnv = process.env.NODE_ENV;
  process.env.HEXO_PING_ALLOW_PRIVATE_HOSTS = '1';
  process.env.NODE_ENV = 'production';
  const captured = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = (s) => { captured.push(String(s)); return true; };
  try {
    for (let i = 0; i < 5; i++) {
      try { assertPublicHttpUrl('http://127.0.0.1/'); } catch { /* expected */ }
    }
  } finally {
    process.stderr.write = orig;
    if (prevAllow === undefined) delete process.env.HEXO_PING_ALLOW_PRIVATE_HOSTS;
    else process.env.HEXO_PING_ALLOW_PRIVATE_HOSTS = prevAllow;
    if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevNodeEnv;
    _internal._resetBypassWarned();
  }
  const matches = captured.join('').match(/HEXO_PING_ALLOW_PRIVATE_HOSTS is set but NODE_ENV is not/g) || [];
  assert.equal(matches.length, 1, 'warning must be one-shot per process');
});

test('resolveDns:true rejects hostname whose DNS resolves to private IP (DNS rebinding)', async () => {
  const dnsMod = await import('node:dns');
  const orig = dnsMod.promises.lookup;
  dnsMod.promises.lookup = async () => [{ address: '10.0.0.1', family: 4 }];
  try {
    await assert.rejects(
      assertPublicHttpUrl('https://attacker.example.com/', { resolveDns: true }),
      /resolves to private\/loopback address/
    );
  } finally {
    dnsMod.promises.lookup = orig;
  }
});

test('resolveDns:true allows public DNS resolution', async () => {
  const dnsMod = await import('node:dns');
  const orig = dnsMod.promises.lookup;
  dnsMod.promises.lookup = async () => [
    { address: '93.184.216.34', family: 4 },
    { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 }
  ];
  try {
    const u = await assertPublicHttpUrl('https://example.com/', { resolveDns: true });
    assert.equal(u.hostname, 'example.com');
  } finally {
    dnsMod.promises.lookup = orig;
  }
});

test('resolveDns:true rejects when ANY resolved address (multi-A record) is private', async () => {
  const dnsMod = await import('node:dns');
  const orig = dnsMod.promises.lookup;
  dnsMod.promises.lookup = async () => [
    { address: '93.184.216.34', family: 4 },
    { address: '192.168.1.1', family: 4 }
  ];
  try {
    await assert.rejects(
      assertPublicHttpUrl('https://example.com/', { resolveDns: true }),
      /resolves to private\/loopback address/
    );
  } finally {
    dnsMod.promises.lookup = orig;
  }
});

test('resolveDns:true rejects ENOTFOUND', async () => {
  const dnsMod = await import('node:dns');
  const orig = dnsMod.promises.lookup;
  const err = new Error('getaddrinfo ENOTFOUND nope.invalid');
  err.code = 'ENOTFOUND';
  dnsMod.promises.lookup = async () => { throw err; };
  try {
    await assert.rejects(
      assertPublicHttpUrl('https://nope.invalid/', { resolveDns: true }),
      /fails DNS resolution/
    );
  } finally {
    dnsMod.promises.lookup = orig;
  }
});

test('default behavior (no resolveDns) still returns parsed URL synchronously', () => {
  const u = assertPublicHttpUrl('https://api.indexnow.org/IndexNow');
  assert.equal(u.hostname, 'api.indexnow.org');
  assert.equal(typeof u.then, 'undefined');
});

// R1-F1: SSRF bypass via 6to4 / IPv4-compatible / NAT64 IPv6 encodings ------
// Each encoding embeds an IPv4 in an IPv6 address. With `validate_dns:false`
// the DNS path is skipped, so the synchronous string-guard MUST reject these.

test('R1-F1: isPrivateHost rejects 6to4 wrapping IMDS 169.254.169.254', () => {
  // 2002:a9fe:a9fe:: embeds 169.254.169.254 (a9fe.a9fe)
  assert.equal(isPrivateHost('2002:a9fe:a9fe::1'), true);
  assert.equal(isPrivateHost('[2002:a9fe:a9fe::1]'), true);
});

test('R1-F1: isPrivateHost rejects 6to4 wrapping loopback 127.0.0.1', () => {
  // 2002:7f00:0001:: embeds 127.0.0.1
  assert.equal(isPrivateHost('2002:7f00:1::1'), true);
  assert.equal(isPrivateHost('[2002:7f00:1::1]'), true);
});

test('R1-F1: isPrivateHost rejects 6to4 wrapping 10.0.0.1', () => {
  // 2002:0a00:0001:: embeds 10.0.0.1
  assert.equal(isPrivateHost('2002:a00:1::'), true);
});

test('R1-F1: isPrivateHost rejects NAT64 prefix 64:ff9b::/96 entirely', () => {
  // RFC 6052 — entire prefix is reserved, conservatively reject all.
  assert.equal(isPrivateHost('64:ff9b::a9fe:a9fe'), true);  // IMDS via NAT64
  assert.equal(isPrivateHost('[64:ff9b::a9fe:a9fe]'), true);
  assert.equal(isPrivateHost('64:ff9b::7f00:1'), true);     // loopback via NAT64
  assert.equal(isPrivateHost('64:ff9b::8.8.8.8'), true);    // even a "public" IPv4 mapped through NAT64
});

test('R1-F1: isPrivateHost rejects IPv4-compatible ::a.b.c.d (deprecated, no legitimate use)', () => {
  // Dotted form (rare in URL.hostname output)
  assert.equal(isPrivateHost('::169.254.169.254'), true);
  // Packed-hex form (what URL canonicalises to)
  assert.equal(isPrivateHost('::a9fe:a9fe'), true);
  assert.equal(isPrivateHost('[::a9fe:a9fe]'), true);
  assert.equal(isPrivateHost('::7f00:1'), true);   // 127.0.0.1
  assert.equal(isPrivateHost('::a00:1'), true);    // 10.0.0.1
});

test('R1-F1: isPrivateHost still allows ::1 and :: literals (not IPv4-compat)', () => {
  // Sanity: the new IPv4-compat unwrap MUST NOT swallow the loopback / unspecified literals
  // (they were already covered by the explicit branch above; this guards against regressions).
  assert.equal(isPrivateHost('::1'), true);
  assert.equal(isPrivateHost('::'), true);
});

test('R1-F1: assertPublicHttpUrl rejects 6to4 / NAT64 / IPv4-compat URLs synchronously (validate_dns:false path)', () => {
  const cases = [
    'http://[2002:a9fe:a9fe::1]/latest/meta-data/',  // 6to4 -> IMDS
    'http://[2002:7f00:1::1]/',                       // 6to4 -> 127.0.0.1
    'http://[64:ff9b::a9fe:a9fe]/latest/meta-data/',  // NAT64 -> IMDS
    'http://[64:ff9b::7f00:1]/',                      // NAT64 -> loopback
    'http://[::a9fe:a9fe]/latest/meta-data/',         // IPv4-compat -> IMDS
    'http://[::7f00:1]/'                              // IPv4-compat -> loopback
  ];
  for (const c of cases) {
    assert.throws(
      () => assertPublicHttpUrl(c),
      /refusing private\/loopback host/,
      `must reject ${c}`
    );
  }
});

test('R1-F1: internal unwrap helpers extract the embedded IPv4 correctly', () => {
  assert.equal(_internal.unwrap6to4('2002:a9fe:a9fe::1'), '169.254.169.254');
  assert.equal(_internal.unwrap6to4('[2002:7f00:1::]'), '127.0.0.1');
  assert.equal(_internal.unwrap6to4('2606:4700::1111'), null);
  assert.equal(_internal.unwrapIpv4CompatIpv6('::a9fe:a9fe'), '169.254.169.254');
  assert.equal(_internal.unwrapIpv4CompatIpv6('::1'), null);  // explicitly null for literal
  assert.equal(_internal.unwrapIpv4CompatIpv6('::ffff:a9fe:a9fe'), null);  // ::ffff: path
  assert.equal(_internal.isNat64Prefix('64:ff9b::a9fe:a9fe'), true);
  assert.equal(_internal.isNat64Prefix('[64:ff9b::1]'), true);
  assert.equal(_internal.isNat64Prefix('2606:4700::1111'), false);
});

test('resolveDns:true pins the validated IP so a rebinding re-resolution is structurally impossible (MED-01)', async () => {
  const dnsMod = await import('node:dns');
  const orig = dnsMod.promises.lookup;
  // Validation sees a public IP...
  dnsMod.promises.lookup = async () => [{ address: '93.184.216.34', family: 4 }];
  let u;
  try {
    u = await assertPublicHttpUrl('https://attacker.example.com/', { resolveDns: true });
  } finally {
    dnsMod.promises.lookup = orig;
  }
  assert.deepEqual(u.validatedAddresses, [{ address: '93.184.216.34', family: 4 }]);
  assert.equal(typeof u.pinnedLookup, 'function');

  // ...and the pinned lookup the engine hands to https.request only ever yields
  // that exact validated address — it never consults the resolver again, so a
  // ~0-TTL record that has since rebound to a private IP can't take effect.
  const allResult = await new Promise((resolve, reject) => {
    u.pinnedLookup('attacker.example.com', { all: true }, (err, addrs) =>
      err ? reject(err) : resolve(addrs));
  });
  assert.deepEqual(allResult, [{ address: '93.184.216.34', family: 4 }]);

  const singleResult = await new Promise((resolve, reject) => {
    u.pinnedLookup('attacker.example.com', {}, (err, address, family) =>
      err ? reject(err) : resolve({ address, family }));
  });
  assert.deepEqual(singleResult, { address: '93.184.216.34', family: 4 });
});
