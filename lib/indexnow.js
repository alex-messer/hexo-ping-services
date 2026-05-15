'use strict';

const { assertPublicHttpUrl } = require('./url-guard.js');
const { request } = require('./http-client.js');

const DEFAULT_ENDPOINT = 'https://api.indexnow.org/IndexNow';
const BATCH = 10000;
const DEFAULT_TIMEOUT = 5000;
const DEFAULT_RETRY_MAX = 3;
const DEFAULT_RETRY_BASE_MS = 250;
const DEFAULT_RETRY_MAX_BACKOFF_MS = 5000;
const RETRY_AFTER_MAX_MS = 300 * 1000;

// Known IndexNow ingestion endpoints. Submitting the secret `key` to a host
// outside this set is not blocked (third-party proxies/aggregators exist) but
// produces a single stderr warning so misconfiguration is visible.
const KNOWN_INDEXNOW_HOSTS = new Set([
  'api.indexnow.org',
  'www.bing.com',
  'yandex.com',
  'search.seznam.cz',
  'searchadvisor.naver.com',
  'indexnow.yep.com'
]);

function statusFromHttp(code) {
  if (code === 200 || code === 202) return 'ok';
  if (code === 422) return 'invalid';
  if (code === 429) return 'rate-limited';
  if (code === 403) return 'forbidden';
  return 'error';
}

// Parse RFC 7231 Retry-After: delta-seconds OR HTTP-date. Returns ms or null.
function parseRetryAfter(raw) {
  if (!raw) return null;
  const trimmed = String(raw).trim();
  if (trimmed === '') return null;
  // Pure non-negative integer => delta-seconds.
  if (/^\d+$/.test(trimmed)) {
    const sec = parseInt(trimmed, 10);
    if (Number.isFinite(sec) && sec >= 0) {
      return Math.min(RETRY_AFTER_MAX_MS, sec * 1000);
    }
  }
  const when = Date.parse(trimmed);
  if (Number.isFinite(when)) {
    const delta = when - Date.now();
    if (delta <= 0) return 0;
    return Math.min(RETRY_AFTER_MAX_MS, delta);
  }
  return null;
}

async function submitBatch(config, parsedUrl, chunk, batch) {
  const endpoint = parsedUrl.href;
  const lookup = parsedUrl.pinnedLookup || null;
  const timeout = config.timeoutMs ?? DEFAULT_TIMEOUT;
  const retryMax = config.retryMax ?? DEFAULT_RETRY_MAX;
  const retryBaseMs = config.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
  const retryMaxBackoffMs = config.retryMaxBackoffMs ?? DEFAULT_RETRY_MAX_BACKOFF_MS;

  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const start = Date.now();
    let resp;
    let networkErr;
    try {
      resp = await request(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          host: config.host,
          key: config.key,
          keyLocation: config.keyLocation,
          urlList: chunk
        }),
        timeoutMs: timeout,
        lookup
      });
      resp.stream.resume();
    } catch (err) {
      networkErr = err;
    }

    const durationMs = Date.now() - start;
    if (networkErr) {
      return {
        batch,
        urls: chunk.length,
        status: 'error',
        httpStatus: 0,
        durationMs,
        retries: attempt,
        error: networkErr.message
      };
    }

    if (resp.status === 429 && attempt < retryMax) {
      const ra = parseRetryAfter(resp.headers['retry-after']);
      const backoff = retryBaseMs * Math.pow(2, attempt);
      const delay = Math.min(retryMaxBackoffMs, Math.max(ra ?? 0, backoff));
      attempt++;
      await new Promise((r) => setTimeout(r, delay));
      continue;
    }

    return {
      batch,
      urls: chunk.length,
      status: statusFromHttp(resp.status),
      httpStatus: resp.status,
      durationMs,
      retries: attempt
    };
  }
}

async function submitIndexNow(config, urls) {
  if (!urls.length) return [];
  const endpoint = config.endpoint || DEFAULT_ENDPOINT;

  let parsedUrl;
  try {
    parsedUrl = await assertPublicHttpUrl(endpoint, { resolveDns: config.validateDns !== false });
  } catch (err) {
    return [{
      batch: 0,
      urls: urls.length,
      status: 'blocked',
      httpStatus: 0,
      durationMs: 0,
      error: err.message
    }];
  }
  if (!KNOWN_INDEXNOW_HOSTS.has(parsedUrl.hostname.toLowerCase())) {
    process.stderr.write(
      `hexo-ping-services: warning — IndexNow endpoint ${parsedUrl.hostname} is not on the known-host allowlist; key will be sent in clear.\n`
    );
  }

  const results = [];
  for (let i = 0, batch = 0; i < urls.length; i += BATCH, batch++) {
    const chunk = urls.slice(i, i + BATCH);
    // eslint-disable-next-line no-await-in-loop
    const result = await submitBatch(config, parsedUrl, chunk, batch);
    results.push(result);
  }
  return results;
}

module.exports = {
  submitIndexNow,
  KNOWN_INDEXNOW_HOSTS,
  _internal: { parseRetryAfter, RETRY_AFTER_MAX_MS }
};
