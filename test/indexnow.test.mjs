import { test } from 'node:test';
import assert from 'node:assert/strict';
import { submitIndexNow } from '../lib/indexnow.js';
import { startMockServer } from './helpers/mock-http.mjs';

function captureStderr(fn) {
  const captured = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = (s) => { captured.push(String(s)); return true; };
  return Promise.resolve(fn()).finally(() => { process.stderr.write = orig; })
    .then((value) => ({ value, stderr: captured.join('') }));
}

test('submitIndexNow POSTs JSON with required fields', async () => {
  let captured = null;
  const server = await startMockServer(async ({ method, body, headers }) => {
    captured = { method, body: JSON.parse(body), contentType: headers['content-type'] };
    return { status: 200, body: '' };
  });
  try {
    const result = await submitIndexNow(
      { endpoint: server.url, host: 'einfach-aleks.com', key: 'abc123', keyLocation: 'https://einfach-aleks.com/abc123.txt' },
      ['https://einfach-aleks.com/foo/', 'https://einfach-aleks.com/bar/']
    );
    assert.equal(captured.method, 'POST');
    assert.equal(captured.contentType, 'application/json');
    assert.equal(captured.body.host, 'einfach-aleks.com');
    assert.equal(captured.body.key, 'abc123');
    assert.equal(captured.body.keyLocation, 'https://einfach-aleks.com/abc123.txt');
    assert.deepEqual(captured.body.urlList, ['https://einfach-aleks.com/foo/', 'https://einfach-aleks.com/bar/']);
    assert.equal(result.length, 1);
    assert.equal(result[0].status, 'ok');
    assert.equal(result[0].urls, 2);
  } finally { await server.close(); }
});

test('submitIndexNow batches URLs at 10000 per request', async () => {
  let calls = 0;
  let totalUrls = 0;
  const server = await startMockServer(async ({ body }) => {
    calls++;
    totalUrls += JSON.parse(body).urlList.length;
    return { status: 200, body: '' };
  });
  try {
    const urls = Array.from({ length: 23001 }, (_, i) => `https://x/p${i}/`);
    const result = await submitIndexNow(
      { endpoint: server.url, host: 'x', key: 'k', keyLocation: 'https://x/k.txt' },
      urls
    );
    assert.equal(calls, 3);
    assert.equal(totalUrls, 23001);
    assert.equal(result.length, 3);
  } finally { await server.close(); }
});

test('submitIndexNow maps 422 to invalid', async () => {
  const server = await startMockServer(async () => ({ status: 422, body: '' }));
  try {
    const result = await submitIndexNow(
      { endpoint: server.url, host: 'x', key: 'k', keyLocation: 'https://x/k.txt' },
      ['https://x/a/']
    );
    assert.equal(result[0].status, 'invalid');
    assert.equal(result[0].httpStatus, 422);
  } finally { await server.close(); }
});

test('submitIndexNow maps 429 to rate-limited', async () => {
  const server = await startMockServer(async () => ({ status: 429, body: '' }));
  try {
    const result = await submitIndexNow(
      { endpoint: server.url, host: 'x', key: 'k', keyLocation: 'https://x/k.txt' },
      ['https://x/a/']
    );
    assert.equal(result[0].status, 'rate-limited');
  } finally { await server.close(); }
});

test('submitIndexNow maps 403 to forbidden', async () => {
  const server = await startMockServer(async () => ({ status: 403, body: '' }));
  try {
    const result = await submitIndexNow(
      { endpoint: server.url, host: 'x', key: 'k', keyLocation: 'https://x/k.txt' },
      ['https://x/a/']
    );
    assert.equal(result[0].status, 'forbidden');
  } finally { await server.close(); }
});

test('submitIndexNow returns empty array for empty urls', async () => {
  const result = await submitIndexNow(
    { endpoint: 'http://nope.invalid', host: 'x', key: 'k', keyLocation: 'https://x/k.txt' },
    []
  );
  assert.deepEqual(result, []);
});

test('submitIndexNow blocks private/loopback endpoint without HTTP', async () => {
  // Run the assertion with the loopback exemption disabled so the SSRF guard
  // takes effect even though the mock helper has set it.
  const prev = process.env.HEXO_PING_ALLOW_PRIVATE_HOSTS;
  delete process.env.HEXO_PING_ALLOW_PRIVATE_HOSTS;
  try {
    const result = await submitIndexNow(
      { endpoint: 'http://127.0.0.1:65535/IndexNow', host: 'x', key: 'k', keyLocation: 'https://x/k.txt' },
      ['https://x/a/']
    );
    assert.equal(result.length, 1);
    assert.equal(result[0].status, 'blocked');
    assert.match(result[0].error, /private\/loopback host/);
  } finally {
    if (prev !== undefined) process.env.HEXO_PING_ALLOW_PRIVATE_HOSTS = prev;
  }
});

test('submitIndexNow blocks IMDS endpoint (169.254.169.254)', async () => {
  const prev = process.env.HEXO_PING_ALLOW_PRIVATE_HOSTS;
  delete process.env.HEXO_PING_ALLOW_PRIVATE_HOSTS;
  try {
    const result = await submitIndexNow(
      { endpoint: 'http://169.254.169.254/latest/meta-data/', host: 'x', key: 'k', keyLocation: 'https://x/k.txt' },
      ['https://x/a/']
    );
    assert.equal(result[0].status, 'blocked');
  } finally {
    if (prev !== undefined) process.env.HEXO_PING_ALLOW_PRIVATE_HOSTS = prev;
  }
});

test('submitIndexNow blocks non-http(s) scheme', async () => {
  const prev = process.env.HEXO_PING_ALLOW_PRIVATE_HOSTS;
  delete process.env.HEXO_PING_ALLOW_PRIVATE_HOSTS;
  try {
    const result = await submitIndexNow(
      { endpoint: 'file:///etc/passwd', host: 'x', key: 'k', keyLocation: 'https://x/k.txt' },
      ['https://x/a/']
    );
    assert.equal(result[0].status, 'blocked');
  } finally {
    if (prev !== undefined) process.env.HEXO_PING_ALLOW_PRIVATE_HOSTS = prev;
  }
});

test('submitIndexNow warns on non-allowlisted host but still pings', async () => {
  // 198.51.100.x is the TEST-NET-2 range; it's public per isPrivateHost so the
  // guard lets it through, but it's not on KNOWN_INDEXNOW_HOSTS so a stderr
  // warning must be emitted. We use the mock helper bound to 127.0.0.1 to
  // actually serve the request (loopback exemption is on by default here).
  const server = await startMockServer(async () => ({ status: 200, body: '' }));
  try {
    const { value: result, stderr } = await captureStderr(() =>
      submitIndexNow(
        { endpoint: server.url, host: 'x', key: 'k', keyLocation: 'https://x/k.txt' },
        ['https://x/a/']
      )
    );
    assert.equal(result[0].status, 'ok');
    assert.match(stderr, /not on the known-host allowlist/);
  } finally { await server.close(); }
});

test('submitIndexNow does not warn for known IndexNow host', async () => {
  // We can't actually hit api.indexnow.org in tests, but we can verify the
  // branch by triggering a network error path. The fix is: build a request
  // pointed at api.indexnow.org with a 1ms timeout and assert no warning.
  const { value: result, stderr } = await captureStderr(() =>
    submitIndexNow(
      { endpoint: 'https://api.indexnow.org/IndexNow', host: 'x', key: 'k', keyLocation: 'https://x/k.txt', timeoutMs: 1 },
      ['https://x/a/']
    )
  );
  assert.equal(result[0].status, 'error');
  assert.doesNotMatch(stderr, /not on the known-host allowlist/);
});

test('submitIndexNow respects timeoutMs', async () => {
  const server = await startMockServer(async () => {
    await new Promise(r => setTimeout(r, 200));
    return { status: 200, body: '' };
  });
  try {
    const result = await submitIndexNow(
      { endpoint: server.url, host: 'x', key: 'k', keyLocation: 'https://x/k.txt', timeoutMs: 50 },
      ['https://x/a/']
    );
    assert.equal(result[0].status, 'error');
  } finally { await server.close(); }
});

test('submitIndexNow retries on 429 up to 3 times then gives up', async () => {
  let calls = 0;
  const server = await startMockServer(async () => {
    calls++;
    return { status: 429, body: '' };
  });
  try {
    const result = await submitIndexNow(
      { endpoint: server.url, host: 'x', key: 'k', keyLocation: 'https://x/k.txt', timeoutMs: 200, retryBaseMs: 1 },
      ['https://x/a/']
    );
    assert.equal(calls, 4, 'should attempt initial + 3 retries');
    assert.equal(result[0].status, 'rate-limited');
    assert.equal(result[0].retries, 3);
  } finally { await server.close(); }
});

test('submitIndexNow retries on 429 then succeeds', async () => {
  let calls = 0;
  const server = await startMockServer(async () => {
    calls++;
    if (calls < 3) return { status: 429, body: '' };
    return { status: 200, body: '' };
  });
  try {
    const result = await submitIndexNow(
      { endpoint: server.url, host: 'x', key: 'k', keyLocation: 'https://x/k.txt', timeoutMs: 200, retryBaseMs: 1 },
      ['https://x/a/']
    );
    assert.equal(calls, 3);
    assert.equal(result[0].status, 'ok');
    assert.equal(result[0].retries, 2);
  } finally { await server.close(); }
});

test('submitIndexNow honors Retry-After delta-seconds on 429', async () => {
  let calls = 0;
  let firstCallAt, secondCallAt;
  const server = await startMockServer(async () => {
    calls++;
    const now = Date.now();
    if (calls === 1) {
      firstCallAt = now;
      return { status: 429, headers: { 'retry-after': '1', 'content-type': 'application/json' }, body: '' };
    }
    secondCallAt = now;
    return { status: 200, body: '' };
  });
  try {
    const result = await submitIndexNow(
      { endpoint: server.url, host: 'x', key: 'k', keyLocation: 'https://x/k.txt', timeoutMs: 2000, retryBaseMs: 1 },
      ['https://x/a/']
    );
    assert.equal(result[0].status, 'ok');
    const gap = secondCallAt - firstCallAt;
    assert.ok(gap >= 900, `retry gap ${gap}ms should be >=900ms when Retry-After=1s`);
  } finally { await server.close(); }
});

test('submitIndexNow does NOT retry on non-429 errors (e.g. 422)', async () => {
  let calls = 0;
  const server = await startMockServer(async () => {
    calls++;
    return { status: 422, body: '' };
  });
  try {
    const result = await submitIndexNow(
      { endpoint: server.url, host: 'x', key: 'k', keyLocation: 'https://x/k.txt', timeoutMs: 200, retryBaseMs: 1 },
      ['https://x/a/']
    );
    assert.equal(calls, 1, '422 must not trigger retries');
    assert.equal(result[0].status, 'invalid');
  } finally { await server.close(); }
});

test('submitIndexNow caps Retry-After to a max to prevent stalls', async () => {
  let calls = 0;
  const server = await startMockServer(async () => {
    calls++;
    return { status: 429, headers: { 'retry-after': '999', 'content-type': 'application/json' }, body: '' };
  });
  try {
    const start = Date.now();
    const result = await submitIndexNow(
      { endpoint: server.url, host: 'x', key: 'k', keyLocation: 'https://x/k.txt', timeoutMs: 200, retryBaseMs: 1, retryMaxBackoffMs: 50 },
      ['https://x/a/']
    );
    const elapsed = Date.now() - start;
    assert.equal(result[0].status, 'rate-limited');
    // 3 retries x 50ms cap = at most ~200ms (plus fetch round-trip overhead).
    assert.ok(elapsed < 1500, `elapsed ${elapsed}ms should be <<999s (cap kicked in)`);
  } finally { await server.close(); }
});

test('submitIndexNow honors Retry-After HTTP-date on 429', async () => {
  let calls = 0;
  let firstCallAt, secondCallAt;
  const server = await startMockServer(async () => {
    calls++;
    const now = Date.now();
    if (calls === 1) {
      firstCallAt = now;
      // Target ~2s in the future. HTTP-date has 1-second resolution and
      // toUTCString rounds down, so net wait is between ~1s and ~2s.
      const when = new Date(now + 2000).toUTCString();
      return { status: 429, headers: { 'retry-after': when, 'content-type': 'application/json' }, body: '' };
    }
    secondCallAt = now;
    return { status: 200, body: '' };
  });
  try {
    const result = await submitIndexNow(
      { endpoint: server.url, host: 'x', key: 'k', keyLocation: 'https://x/k.txt', timeoutMs: 3000, retryBaseMs: 1, retryMaxBackoffMs: 5000 },
      ['https://x/a/']
    );
    assert.equal(result[0].status, 'ok');
    const gap = secondCallAt - firstCallAt;
    assert.ok(gap >= 500, `retry gap ${gap}ms should reflect HTTP-date Retry-After`);
  } finally { await server.close(); }
});

test('submitIndexNow ignores malformed Retry-After header', async () => {
  let calls = 0;
  const server = await startMockServer(async () => {
    calls++;
    if (calls < 2) return { status: 429, headers: { 'retry-after': 'not-a-date', 'content-type': 'application/json' }, body: '' };
    return { status: 200, body: '' };
  });
  try {
    const result = await submitIndexNow(
      { endpoint: server.url, host: 'x', key: 'k', keyLocation: 'https://x/k.txt', timeoutMs: 200, retryBaseMs: 1 },
      ['https://x/a/']
    );
    assert.equal(result[0].status, 'ok');
    assert.equal(result[0].retries, 1);
  } finally { await server.close(); }
});
