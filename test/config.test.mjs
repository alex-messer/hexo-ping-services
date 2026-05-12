import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveConfig } from '../lib/config.mjs';

test('resolveConfig fills defaults when block is missing', () => {
  const c = resolveConfig({});
  assert.equal(c.enabled, true);
  assert.equal(c.runAfterGenerate, false);
  assert.equal(c.indexnow.enabled, true);
  assert.equal(c.xmlrpc.enabled, true);
  assert.deepEqual(c.xmlrpc.endpoints, ['https://rpc.pingomatic.com/', 'https://rpc.twingly.com/']);
  assert.equal(c.stateFile, '.hexo-ping-state.json');
  assert.equal(c.timeoutMs, 5000);
});

test('resolveConfig merges user-provided values', () => {
  const c = resolveConfig({
    ping: {
      indexnow: { key: 'abc', key_location: '/n.txt' },
      xmlrpc: { endpoints: ['https://rpc.x/'] },
      timeout_ms: 2000
    }
  });
  assert.equal(c.indexnow.key, 'abc');
  assert.equal(c.indexnow.keyLocation, '/n.txt');
  assert.deepEqual(c.xmlrpc.endpoints, ['https://rpc.x/']);
  assert.equal(c.timeoutMs, 2000);
});

test('resolveConfig throws when indexnow.enabled but no key', () => {
  assert.throws(
    () => resolveConfig({ ping: { indexnow: { enabled: true } } }),
    /hexo-ping-services: indexnow\.key is required/
  );
});

test('resolveConfig allows indexnow disabled without key', () => {
  const c = resolveConfig({ ping: { indexnow: { enabled: false } } });
  assert.equal(c.indexnow.enabled, false);
});

test('resolveConfig respects ping.enabled=false short-circuit', () => {
  const c = resolveConfig({ ping: { enabled: false } });
  assert.equal(c.enabled, false);
});
