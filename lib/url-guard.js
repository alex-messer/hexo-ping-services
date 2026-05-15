'use strict';

const dns = require('node:dns');

// SSRF defense: refuse hostnames that resolve to private, loopback, or
// link-local address ranges. Pattern-based check on the literal hostname only —
// does NOT resolve DNS, so a public hostname pointing at a private IP can still
// slip through. That's an acceptable trade-off for a build-time tool: at minimum
// we block the obvious cases (configured 127.0.0.1, 169.254.169.254 IMDS, …).

// URL.hostname canonicalizes IPv4-mapped IPv6 to packed-hex (e.g. "::ffff:a9fe:a9fe"),
// so both packed-hex and dotted-quad forms (with or without brackets) must be unwrapped.
function unwrapIpv4MappedIpv6(hostname) {
  let h = hostname.toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  const dotted = /^::ffff:(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (dotted) {
    return `${dotted[1]}.${dotted[2]}.${dotted[3]}.${dotted[4]}`;
  }
  const packed = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h);
  if (packed) {
    const hi = parseInt(packed[1], 16);
    const lo = parseInt(packed[2], 16);
    if (Number.isFinite(hi) && Number.isFinite(lo) && hi <= 0xffff && lo <= 0xffff) {
      const a = (hi >> 8) & 0xff;
      const b = hi & 0xff;
      const c = (lo >> 8) & 0xff;
      const d = lo & 0xff;
      return `${a}.${b}.${c}.${d}`;
    }
  }
  return null;
}

function isPrivateIpv4(lc) {
  if (/^127\./.test(lc)) return true;
  if (/^10\./.test(lc)) return true;
  if (/^192\.168\./.test(lc)) return true;
  if (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(lc)) return true;
  if (/^169\.254\./.test(lc)) return true;
  if (/^0\./.test(lc)) return true;
  return false;
}

function isPrivateHost(hostname) {
  if (!hostname) return true;
  const lc = hostname.toLowerCase();
  if (lc === 'localhost' || lc === 'ip6-localhost' || lc === 'ip6-loopback') return true;
  // IPv4 patterns
  if (isPrivateIpv4(lc)) return true;
  // IPv6 patterns
  if (lc === '::1' || lc === '::') return true;
  // Bracketed IPv6 literals (URL hostnames keep the brackets).
  if (lc === '[::1]' || lc === '[::]') return true;
  if (/^\[?f[cd][0-9a-f]{2}:/i.test(lc)) return true; // fc00::/7 ULA
  if (/^\[?fe80:/i.test(lc)) return true;             // link-local
  const mapped = unwrapIpv4MappedIpv6(lc);
  if (mapped) {
    // Even a "public" IPv4 wrapped in ::ffff: is refused: real callers don't
    // use this representation for public hosts, so it's safer to reject all.
    if (isPrivateIpv4(mapped)) return true;
    return true;
  }
  return false;
}

let _bypassWarned = false;

// Test-only escape hatch: HEXO_PING_ALLOW_PRIVATE_HOSTS=1 is only honored when
// NODE_ENV === 'test'. Outside of tests it's silently ignored after a one-shot warning.
function privateHostsAllowed() {
  if (process.env.HEXO_PING_ALLOW_PRIVATE_HOSTS !== '1') return false;
  if (process.env.NODE_ENV === 'test') return true;
  if (!_bypassWarned) {
    _bypassWarned = true;
    process.stderr.write(
      'hexo-ping-services: warning — HEXO_PING_ALLOW_PRIVATE_HOSTS is set but NODE_ENV is not "test"; ignoring (private/loopback hosts will be refused).\n'
    );
  }
  return false;
}

// Opt-in DNS-rebinding mitigation: resolves the hostname and rejects if any
// returned address is in a private range. Off by default to avoid latency on
// short-lived CLI runs where TOCTOU exposure is minimal. Returns the validated
// address records so the caller can pin the connection to those exact IPs and
// skip a second, attacker-controllable resolution at connect time.
async function resolveAndAssertPublic(hostname) {
  let addrs;
  try {
    addrs = await dns.promises.lookup(hostname, { all: true });
  } catch (err) {
    const e = new Error(
      `hexo-ping-services: refusing host that fails DNS resolution: ${hostname} (${err.code || err.message})`
    );
    e.cause = err;
    throw e;
  }
  if (!addrs || addrs.length === 0) {
    throw new Error(`hexo-ping-services: refusing host with no DNS addresses: ${hostname}`);
  }
  for (const { address } of addrs) {
    if (isPrivateHost(address)) {
      throw new Error(
        `hexo-ping-services: refusing host that resolves to private/loopback address: ${hostname} -> ${address}`
      );
    }
  }
  return addrs;
}

// Builds a dns.lookup-compatible function that only ever yields the addresses
// validated above. Because the engines hand this to https.request, the connect
// path can never re-resolve the hostname — closing the TOCTOU window where a
// ~0-TTL record rebinds between validation and connection.
function makePinnedLookup(addrs) {
  const pinned = addrs.map(({ address, family }) => ({ address, family }));
  return function pinnedLookup(_hostname, options, callback) {
    const cb = typeof options === 'function' ? options : callback;
    const all = options && typeof options === 'object' ? options.all : false;
    if (all) {
      process.nextTick(cb, null, pinned);
    } else {
      process.nextTick(cb, null, pinned[0].address, pinned[0].family);
    }
  };
}

function assertPublicHttpUrl(rawUrl, options) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new Error('hexo-ping-services: invalid URL: ' + rawUrl);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('hexo-ping-services: only http(s) URLs allowed, got ' + u.protocol);
  }
  const bypass = privateHostsAllowed();
  if (!bypass && isPrivateHost(u.hostname)) {
    throw new Error('hexo-ping-services: refusing private/loopback host: ' + u.hostname);
  }
  if (options && options.resolveDns && !bypass) {
    return resolveAndAssertPublic(u.hostname).then((addrs) => {
      u.validatedAddresses = addrs;
      u.pinnedLookup = makePinnedLookup(addrs);
      return u;
    });
  }
  return u;
}

function _resetBypassWarned() { _bypassWarned = false; }

module.exports = {
  isPrivateHost,
  assertPublicHttpUrl,
  _internal: { unwrapIpv4MappedIpv6, _resetBypassWarned, makePinnedLookup }
};
