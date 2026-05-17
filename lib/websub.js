'use strict';
const { assertPublicHttpUrl } = require('./url-guard.js');
const { request } = require('./http-client.js');
const { parallelMap } = require('./pool.js');

const DEFAULT_TIMEOUT = 5000;
const DEFAULT_CONCURRENCY = 5;

function statusFromHttp(code) {
  if (code >= 200 && code < 300) return 'ok';
  if (code === 429) return 'rate-limited';
  return 'error';
}

async function publishToHub(hubUrl, feedUrl, { timeoutMs = DEFAULT_TIMEOUT, validateDns = true } = {}) {
  let parsedUrl;
  try {
    parsedUrl = await assertPublicHttpUrl(hubUrl, { resolveDns: validateDns });
  } catch (err) {
    return { hub: hubUrl, status: 'blocked', httpStatus: 0, durationMs: 0, error: err.message };
  }

  const start = Date.now();
  try {
    const body = new URLSearchParams({ 'hub.mode': 'publish', 'hub.url': feedUrl }).toString();
    const resp = await request(hubUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      timeoutMs,
      lookup: parsedUrl.pinnedLookup || null
    });
    resp.stream.resume();
    return {
      hub: hubUrl,
      status: statusFromHttp(resp.status),
      httpStatus: resp.status,
      durationMs: Date.now() - start
    };
  } catch (err) {
    return {
      hub: hubUrl,
      status: 'error',
      httpStatus: 0,
      durationMs: Date.now() - start,
      error: err.message
    };
  }
}

async function publishToHubs(hubs, feedUrl, { timeoutMs = DEFAULT_TIMEOUT, concurrency = DEFAULT_CONCURRENCY, validateDns = true } = {}) {
  return parallelMap(
    hubs,
    (hub) => publishToHub(hub, feedUrl, { timeoutMs, validateDns }),
    concurrency
  );
}

module.exports = { publishToHub, publishToHubs };
