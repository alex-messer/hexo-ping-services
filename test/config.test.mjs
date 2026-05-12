import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveConfig } from '../lib/config.js';

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

test('resolveConfig caps xmlrpc.endpoints at 32', () => {
  const endpoints = Array.from({ length: 33 }, (_, i) => `https://rpc${i}.example.com/`);
  assert.throws(
    () => resolveConfig({ ping: { indexnow: { enabled: false }, xmlrpc: { endpoints } } }),
    /too many endpoints \(max 32\)/
  );
});

test('resolveConfig accepts exactly 32 xmlrpc endpoints', () => {
  const endpoints = Array.from({ length: 32 }, (_, i) => `https://rpc${i}.example.com/`);
  const c = resolveConfig({ ping: { indexnow: { enabled: false }, xmlrpc: { endpoints } } });
  assert.equal(c.xmlrpc.endpoints.length, 32);
});

test('resolveConfig caps feed_url length at 2048 chars', () => {
  const longFeed = 'https://example.com/' + 'a'.repeat(2048);
  assert.throws(
    () => resolveConfig({ ping: { indexnow: { enabled: false }, xmlrpc: { feed_url: longFeed } } }),
    /feed_url too long \(max 2048 chars\)/
  );
});

test('resolveConfig caps indexnow.key length at 256 chars', () => {
  const longKey = 'a'.repeat(257);
  assert.throws(
    () => resolveConfig({ ping: { indexnow: { key: longKey } } }),
    /indexnow\.key too long \(max 256 chars\)/
  );
});

test('resolveConfig defaults websub to disabled with empty hubs and /atom.xml', () => {
  const c = resolveConfig({});
  assert.equal(c.websub.enabled, false);
  assert.deepEqual(c.websub.hubs, []);
  assert.equal(c.websub.feedUrl, '/atom.xml');
});

test('resolveConfig accepts user-provided websub block', () => {
  const c = resolveConfig({
    ping: {
      indexnow: { enabled: false },
      websub: {
        enabled: true,
        hubs: ['https://pubsubhubbub.appspot.com/'],
        feed_url: '/feed.xml'
      }
    }
  });
  assert.equal(c.websub.enabled, true);
  assert.deepEqual(c.websub.hubs, ['https://pubsubhubbub.appspot.com/']);
  assert.equal(c.websub.feedUrl, '/feed.xml');
});

test('resolveConfig caps websub.hubs at 16', () => {
  const hubs = Array.from({ length: 17 }, (_, i) => `https://hub${i}.example.com/`);
  assert.throws(
    () => resolveConfig({ ping: { indexnow: { enabled: false }, websub: { hubs } } }),
    /too many websub hubs \(max 16\)/
  );
});

test('resolveConfig accepts exactly 16 websub hubs', () => {
  const hubs = Array.from({ length: 16 }, (_, i) => `https://hub${i}.example.com/`);
  const c = resolveConfig({ ping: { indexnow: { enabled: false }, websub: { hubs } } });
  assert.equal(c.websub.hubs.length, 16);
});

test('resolveConfig caps websub.feed_url length at 2048 chars', () => {
  const longFeed = 'https://example.com/' + 'a'.repeat(2048);
  assert.throws(
    () => resolveConfig({ ping: { indexnow: { enabled: false }, websub: { feed_url: longFeed } } }),
    /websub\.feed_url too long \(max 2048 chars\)/
  );
});
