'use strict';
const { assertPublicHttpUrl } = require('./url-guard.js');

const DEFAULT_TIMEOUT = 5000;
const DEFAULT_CONCURRENCY = 5;

function statusFromHttp(code) {
  if (code >= 200 && code < 300) return 'ok';
  if (code === 429) return 'rate-limited';
  return 'error';
}

async function publishToHub(hubUrl, feedUrl, { timeoutMs = DEFAULT_TIMEOUT, validateDns = true } = {}) {
  try {
    await assertPublicHttpUrl(hubUrl, { resolveDns: validateDns });
  } catch (err) {
    return { hub: hubUrl, status: 'blocked', httpStatus: 0, durationMs: 0, error: err.message };
  }

  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const body = new URLSearchParams({ 'hub.mode': 'publish', 'hub.url': feedUrl }).toString();
    const resp = await fetch(hubUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal: controller.signal,
      redirect: 'manual'
    });
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
  } finally {
    clearTimeout(timer);
  }
}

async function publishToHubs(hubs, feedUrl, { timeoutMs = DEFAULT_TIMEOUT, concurrency = DEFAULT_CONCURRENCY, validateDns = true } = {}) {
  if (!hubs.length) return [];
  const results = new Array(hubs.length);
  let next = 0;
  async function worker() {
    while (true) {
      const idx = next++;
      if (idx >= hubs.length) return;
      results[idx] = await publishToHub(hubs[idx], feedUrl, { timeoutMs, validateDns });
    }
  }
  const workerCount = Math.max(1, Math.min(concurrency, hubs.length));
  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
}

module.exports = { publishToHub, publishToHubs };
