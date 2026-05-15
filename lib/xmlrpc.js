'use strict';

const { assertPublicHttpUrl } = require('./url-guard.js');
const { request } = require('./http-client.js');

const DEFAULT_TIMEOUT = 5000;
const DEFAULT_CONCURRENCY = 5;
// Treat overflow as a non-fault success: marking the URL failed would retry
// and amplify a malicious or runaway server pumping a huge body.
const MAX_RESPONSE_BYTES = 64 * 1024;
const TRUNCATED_SENTINEL = '<response truncated>';

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function param(s) {
  return `<param><value><string>${escapeXml(s)}</string></value></param>`;
}

function buildPingPayload(siteName, siteUrl, feedUrl) {
  const method = feedUrl ? 'weblogUpdates.extendedPing' : 'weblogUpdates.ping';
  const params = feedUrl
    ? [siteName, siteUrl, siteUrl, feedUrl]
    : [siteName, siteUrl];
  return `<?xml version="1.0"?><methodCall><methodName>${method}</methodName><params>${params.map(param).join('')}</params></methodCall>`;
}

async function readBodyCapped(resp, maxBytes) {
  // http-client responses expose a byte-capped streaming reader directly.
  if (typeof resp.readBodyCapped === 'function') {
    return resp.readBodyCapped(maxBytes);
  }
  // WHATWG Response path, retained for the _internal unit tests.
  const reader = resp.body && resp.body.getReader ? resp.body.getReader() : null;
  if (!reader) {
    const text = await resp.text();
    return text.length > maxBytes ? TRUNCATED_SENTINEL : text;
  }
  const decoder = new TextDecoder('utf-8');
  let received = 0;
  let parts = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) {
        try { await reader.cancel(); } catch { /* ignore */ }
        return TRUNCATED_SENTINEL;
      }
      parts += decoder.decode(value, { stream: true });
    }
    parts += decoder.decode();
    return parts;
  } finally {
    try { reader.releaseLock(); } catch { /* ignore */ }
  }
}

async function pingEndpoint(endpoint, payload, { timeoutMs = DEFAULT_TIMEOUT, validateDns = true } = {}) {
  const start = Date.now();
  let parsedUrl;
  try {
    parsedUrl = await assertPublicHttpUrl(endpoint, { resolveDns: validateDns });
  } catch (err) {
    return { endpoint, status: 'blocked', httpStatus: 0, durationMs: 0, error: err.message };
  }
  try {
    const resp = await request(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'text/xml; charset=utf-8' },
      body: payload,
      timeoutMs,
      lookup: parsedUrl.pinnedLookup || null
    });
    const body = await readBodyCapped(resp, MAX_RESPONSE_BYTES);
    const durationMs = Date.now() - start;
    if (resp.status !== 200) {
      return { endpoint, status: 'error', httpStatus: resp.status, durationMs };
    }
    if (body.includes('<fault>')) {
      const m = body.match(/<string>([^<]*)<\/string>/);
      return { endpoint, status: 'fault', httpStatus: 200, durationMs, fault: m ? m[1] : 'unspecified' };
    }
    return { endpoint, status: 'ok', httpStatus: 200, durationMs };
  } catch (err) {
    return { endpoint, status: 'error', httpStatus: 0, durationMs: Date.now() - start, error: err.message };
  }
}

async function pingAll(endpoints, siteName, siteUrl, feedUrl, { timeoutMs = DEFAULT_TIMEOUT, concurrency = DEFAULT_CONCURRENCY, validateDns = true } = {}) {
  const payload = buildPingPayload(siteName, siteUrl, feedUrl);
  const results = new Array(endpoints.length);
  let next = 0;
  async function worker() {
    while (true) {
      const idx = next++;
      if (idx >= endpoints.length) return;
      results[idx] = await pingEndpoint(endpoints[idx], payload, { timeoutMs, validateDns });
    }
  }
  const workerCount = Math.max(1, Math.min(concurrency, endpoints.length));
  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
}

module.exports = {
  buildPingPayload,
  pingEndpoint,
  pingAll,
  _internal: { readBodyCapped, MAX_RESPONSE_BYTES, TRUNCATED_SENTINEL }
};
