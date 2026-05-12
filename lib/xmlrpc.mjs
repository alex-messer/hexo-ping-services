const DEFAULT_TIMEOUT = 5000;

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function param(s) {
  return `<param><value><string>${escapeXml(s)}</string></value></param>`;
}

export function buildPingPayload(siteName, siteUrl, feedUrl) {
  const method = feedUrl ? 'weblogUpdates.extendedPing' : 'weblogUpdates.ping';
  const params = feedUrl
    ? [siteName, siteUrl, siteUrl, feedUrl]
    : [siteName, siteUrl];
  return `<?xml version="1.0"?><methodCall><methodName>${method}</methodName><params>${params.map(param).join('')}</params></methodCall>`;
}

export async function pingEndpoint(endpoint, payload, { timeoutMs = DEFAULT_TIMEOUT } = {}) {
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'text/xml; charset=utf-8' },
      body: payload,
      signal: controller.signal
    });
    const body = await resp.text();
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
  } finally {
    clearTimeout(timer);
  }
}

export async function pingAll(endpoints, siteName, siteUrl, feedUrl, { timeoutMs = DEFAULT_TIMEOUT } = {}) {
  const payload = buildPingPayload(siteName, siteUrl, feedUrl);
  return Promise.all(endpoints.map(e => pingEndpoint(e, payload, { timeoutMs })));
}
