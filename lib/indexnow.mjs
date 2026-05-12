const DEFAULT_ENDPOINT = 'https://api.indexnow.org/IndexNow';
const BATCH = 10000;
const DEFAULT_TIMEOUT = 5000;

function statusFromHttp(code) {
  if (code === 200 || code === 202) return 'ok';
  if (code === 422) return 'invalid';
  if (code === 429) return 'rate-limited';
  if (code === 403) return 'forbidden';
  return 'error';
}

export async function submitIndexNow(config, urls) {
  if (!urls.length) return [];
  const endpoint = config.endpoint || DEFAULT_ENDPOINT;
  const timeout = config.timeoutMs ?? DEFAULT_TIMEOUT;
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
