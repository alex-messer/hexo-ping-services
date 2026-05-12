'use strict';

const { assertPublicHttpUrl } = require('./url-guard.js');

const DEFAULT_ENDPOINT = 'https://api.indexnow.org/IndexNow';
const BATCH = 10000;
const DEFAULT_TIMEOUT = 5000;

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

async function submitIndexNow(config, urls) {
  if (!urls.length) return [];
  const endpoint = config.endpoint || DEFAULT_ENDPOINT;
  const timeout = config.timeoutMs ?? DEFAULT_TIMEOUT;

  let parsedUrl;
  try {
    parsedUrl = assertPublicHttpUrl(endpoint);
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
    const start = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const resp = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          host: config.host,
          key: config.key,
          keyLocation: config.keyLocation,
          urlList: chunk
        }),
        redirect: 'manual',
        signal: controller.signal
      });
      results.push({
        batch,
        urls: chunk.length,
        status: statusFromHttp(resp.status),
        httpStatus: resp.status,
        durationMs: Date.now() - start
      });
    } catch (err) {
      results.push({
        batch,
        urls: chunk.length,
        status: 'error',
        httpStatus: 0,
        durationMs: Date.now() - start,
        error: err.message
      });
    } finally {
      clearTimeout(timer);
    }
  }
  return results;
}

module.exports = { submitIndexNow, KNOWN_INDEXNOW_HOSTS };
