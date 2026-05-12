import { test } from 'node:test';
import assert from 'node:assert/strict';
import { submitIndexNow } from '../lib/indexnow.mjs';
import { startMockServer } from './helpers/mock-http.mjs';

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
