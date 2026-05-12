import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import consoleModule from '../scripts/console.js';
import { registerConsole } from '../scripts/console.js';
import { startMockServer } from './helpers/mock-http.mjs';

const { logHuman, logJson } = consoleModule._internal;

function tmpDir(prefix) {
  const d = mkdtempSync(join(tmpdir(), prefix));
  return { dir: d, cleanup: () => rmSync(d, { recursive: true, force: true }) };
}

function makeFakeHexo({ posts = [], pingConfig, baseDir }) {
  const consoleHandlers = new Map();
  return {
    base_dir: baseDir,
    config: {
      title: 'EinfachAleks',
      url: 'https://einfach-aleks.com',
      ping: pingConfig
    },
    locals: { get: (n) => n === 'posts' ? { data: posts } : null },
    log: { info: () => {}, warn: () => {} },
    // Mirror the real Hexo API: ping console handler calls this.load()
    // to populate locals before running. No-op in unit tests since
    // locals.posts is already injected via the constructor argument.
    load: async () => {},
    extend: {
      console: {
        register: (name, _desc, _opts, handler) => { consoleHandlers.set(name, handler); }
      },
      filter: { register: () => {} }
    },
    _invokeConsole(name, argv) { return consoleHandlers.get(name).call(this, argv); }
  };
}

// Direct unit tests for the internal log formatters --------------------------

test('logHuman: empty plan renders "no URLs to ping"', async () => {
  await new Promise(r => setImmediate(r));
  const out = logHuman({ plan: [], indexnowResults: [], xmlrpcResults: [] });
  assert.match(out, /no URLs to ping/);
});

test('logHuman: non-empty plan renders count line', async () => {
  await new Promise(r => setImmediate(r));
  const out = logHuman({
    plan: ['https://x/a/', 'https://x/b/'],
    indexnowResults: [{ batch: 0, urls: 2, status: 'ok', httpStatus: 200, durationMs: 12 }],
    xmlrpcResults: [{ endpoint: 'https://rpc/', status: 'ok', httpStatus: 200, durationMs: 7 }]
  });
  assert.match(out, /2 URL\(s\) to ping/);
  assert.match(out, /indexnow batch 0: 2 urls → ok \(HTTP 200, 12ms\)/);
  assert.match(out, /xmlrpc https:\/\/rpc\/: ok \(HTTP 200, 7ms\)/);
});

test('logHuman: includes fault attribute when xmlrpc fault present', () => {
  const out = logHuman({
    plan: ['https://x/a/'],
    indexnowResults: null,
    xmlrpcResults: [{ endpoint: 'https://rpc/', status: 'fault', httpStatus: 200, durationMs: 8, fault: 'spam' }]
  });
  assert.match(out, /xmlrpc https:\/\/rpc\/: fault fault="spam"/);
});

test('logJson: emits one JSON line per engine result with level', () => {
  const out = logJson({
    plan: ['https://x/a/'],
    indexnowResults: [{ batch: 0, urls: 1, status: 'ok' }, { batch: 1, urls: 0, status: 'error' }],
    xmlrpcResults: [{ endpoint: 'https://rpc/', status: 'fault' }]
  });
  const lines = out.split('\n');
  assert.equal(lines.length, 3);
  const j0 = JSON.parse(lines[0]);
  assert.equal(j0.level, 'info');
  assert.equal(j0.engine, 'indexnow');
  const j1 = JSON.parse(lines[1]);
  assert.equal(j1.level, 'warn');
  const j2 = JSON.parse(lines[2]);
  assert.equal(j2.engine, 'xmlrpc');
  assert.equal(j2.level, 'warn');
});

// End-to-end tests against the registered handler ---------------------------

test('ping console handler reports no URLs when state is current', async () => {
  const { dir, cleanup } = tmpDir('hps-console-noop-');
  const indexnow = await startMockServer(async () => ({ status: 200, body: '' }));
  try {
    const hexo = makeFakeHexo({
      baseDir: dir,
      posts: [{ permalink: 'https://x/a/', date: '2026-01-01' }],
      pingConfig: {
        indexnow: { key: 'abc', key_location: '/abc.txt', endpoint: indexnow.url },
        xmlrpc: { endpoints: [] }
      }
    });
    registerConsole(hexo);
    await hexo._invokeConsole('ping', {});
    const stderrCap = [];
    const origErr = process.stderr.write.bind(process.stderr);
    process.stderr.write = (s) => { stderrCap.push(String(s)); return true; };
    try {
      await hexo._invokeConsole('ping', {});
    } finally {
      process.stderr.write = origErr;
    }
    assert.match(stderrCap.join(''), /no URLs to ping/);
  } finally {
    await indexnow.close();
    cleanup();
  }
});

test('ping console handler exits 1 on config error', async () => {
  const { dir, cleanup } = tmpDir('hps-console-err-');
  try {
    const hexo = makeFakeHexo({
      baseDir: dir,
      pingConfig: {
        indexnow: { key_location: '/abc.txt' },
        xmlrpc: { endpoints: [] }
      }
    });
    registerConsole(hexo);
    const stderrCap = [];
    const origErr = process.stderr.write.bind(process.stderr);
    const origExit = process.exit;
    let exitCode = null;
    process.stderr.write = (s) => { stderrCap.push(String(s)); return true; };
    process.exit = (c) => { exitCode = c; throw new Error('exit:' + c); };
    try {
      await hexo._invokeConsole('ping', {});
    } catch (e) {
      assert.match(e.message, /^exit:1$/);
    } finally {
      process.stderr.write = origErr;
      process.exit = origExit;
    }
    assert.equal(exitCode, 1);
    assert.match(stderrCap.join(''), /indexnow\.key is required/);
  } finally { cleanup(); }
});

test('ping console handler exits 1 when indexnow returns forbidden', async () => {
  const { dir, cleanup } = tmpDir('hps-console-403-');
  const indexnow = await startMockServer(async () => ({ status: 403, body: '' }));
  try {
    const hexo = makeFakeHexo({
      baseDir: dir,
      posts: [{ permalink: 'https://x/a/', date: '2026-01-01' }],
      pingConfig: {
        indexnow: { key: 'abc', key_location: '/abc.txt', endpoint: indexnow.url },
        xmlrpc: { endpoints: [] }
      }
    });
    registerConsole(hexo);
    const origExit = process.exit;
    let exitCode = null;
    process.exit = (c) => { exitCode = c; throw new Error('exit:' + c); };
    const origErr = process.stderr.write.bind(process.stderr);
    process.stderr.write = () => true;
    try {
      await hexo._invokeConsole('ping', {});
    } catch (e) {
      assert.match(e.message, /^exit:1$/);
    } finally {
      process.exit = origExit;
      process.stderr.write = origErr;
    }
    assert.equal(exitCode, 1);
  } finally {
    await indexnow.close();
    cleanup();
  }
});

test('registerConsole registers a `ping` command with expected metadata', async () => {
  await new Promise(r => setImmediate(r));
  const calls = [];
  const hexo = {
    extend: {
      console: {
        register: (name, desc, opts, handler) => calls.push({ name, desc, opts, handler })
      }
    }
  };
  registerConsole(hexo);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'ping');
  assert.match(calls[0].desc, /IndexNow/);
  assert.ok(Array.isArray(calls[0].opts.options));
  assert.equal(typeof calls[0].handler, 'function');
});
