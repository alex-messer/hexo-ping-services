'use strict';

// SSRF defense: refuse hostnames that resolve to private, loopback, or
// link-local address ranges. Pattern-based check on the literal hostname only —
// does NOT resolve DNS, so a public hostname pointing at a private IP can still
// slip through. That's an acceptable trade-off for a build-time tool: at minimum
// we block the obvious cases (configured 127.0.0.1, 169.254.169.254 IMDS, …).
function isPrivateHost(hostname) {
  if (!hostname) return true;
  const lc = hostname.toLowerCase();
  if (lc === 'localhost' || lc === 'ip6-localhost' || lc === 'ip6-loopback') return true;
  // IPv4 patterns
  if (/^127\./.test(lc)) return true;
  if (/^10\./.test(lc)) return true;
  if (/^192\.168\./.test(lc)) return true;
  if (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(lc)) return true;
  if (/^169\.254\./.test(lc)) return true;
  if (/^0\./.test(lc)) return true;
  // IPv6 patterns
  if (lc === '::1' || lc === '::') return true;
  if (/^\[?f[cd][0-9a-f]{2}:/i.test(lc)) return true; // fc00::/7 ULA
  if (/^\[?fe80:/i.test(lc)) return true;             // link-local
  return false;
}

// Test-only escape hatch: when set, isPrivateHost is bypassed so the in-process
// mock HTTP server (bound to 127.0.0.1) can be reached. Never set this in prod.
function privateHostsAllowed() {
  return process.env.HEXO_PING_ALLOW_PRIVATE_HOSTS === '1';
}

function assertPublicHttpUrl(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new Error('hexo-ping-services: invalid URL: ' + rawUrl);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('hexo-ping-services: only http(s) URLs allowed, got ' + u.protocol);
  }
  if (!privateHostsAllowed() && isPrivateHost(u.hostname)) {
    throw new Error('hexo-ping-services: refusing private/loopback host: ' + u.hostname);
  }
  return u;
}

module.exports = { isPrivateHost, assertPublicHttpUrl };
