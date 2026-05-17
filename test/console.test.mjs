import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import consoleModule from '../scripts/console.js';
import { registerConsole } from '../scripts/console.js';
import { startMockServer } from './helpers/mock-http.mjs';

const { logHuman, logJson, sanitize } = consoleModule._internal;

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

test('sanitize replaces ANSI escapes and control bytes with ?', () => {
  // Bytes: ESC 0x1b, BEL 0x07, CR 0x0d, DEL 0x7f, NUL 0x00.
  const raw = '\x1b[31mRED\x07\x0d\x7f\x00';
  const out = sanitize(raw);
  assert.equal(out, '?[31mRED????');
});

test('logHuman strips raw escape bytes from xmlrpc fault', () => {
  const fault = '\x1b[31mInjected\x1b[0m';
  const out = logHuman({
    plan: ['https://x/'],
    indexnowResults: null,
    xmlrpcResults: [{
      endpoint: 'https://rpc/',
      status: 'fault',
      httpStatus: 200,
      durationMs: 5,
      fault
    }]
  });
  assert.equal(out.includes('\x1b'), false, 'output must not contain ESC bytes');
  assert.match(out, /fault="\?\[31mInjected\?\[0m"/);
});

test('sanitize handles null/undefined safely', () => {
  assert.equal(sanitize(null), '');
  assert.equal(sanitize(undefined), '');
});

test('sanitize strips 8-bit CSI (C1 control 0x9b) — MED-03 extended', () => {
  const raw = 'before\x9b31mAFTER';
  const out = sanitize(raw);
  assert.equal(out.includes('\x9b'), false, '8-bit CSI byte must be stripped');
  assert.equal(out, 'before?31mAFTER');
});

test('sanitize strips full C1 control range (0x80-0x9f) — MED-03 extended', () => {
  for (let code = 0x80; code <= 0x9f; code++) {
    const ch = String.fromCharCode(code);
    const out = sanitize('a' + ch + 'b');
    assert.equal(out, 'a?b', `code point 0x${code.toString(16)} must be stripped`);
  }
});

test('sanitize strips RTL override U+202E (bidi spoofing) — MED-03 extended', () => {
  const raw = 'hello‮dlrow';
  const out = sanitize(raw);
  assert.equal(out.includes('‮'), false, 'RTL override must be stripped');
  assert.equal(out, 'hello?dlrow');
});

test('sanitize strips bidi formatting U+202A through U+202E — MED-03 extended', () => {
  for (let code = 0x202A; code <= 0x202E; code++) {
    const ch = String.fromCharCode(code);
    const out = sanitize('x' + ch + 'y');
    assert.equal(out, 'x?y', `code point U+${code.toString(16).toUpperCase()} must be stripped`);
  }
});

test('sanitize strips isolate format U+2066 (LRI) — MED-03 extended', () => {
  const raw = 'a⁦b';
  assert.equal(sanitize(raw), 'a?b');
});

test('sanitize strips bidi isolates U+2066 through U+2069 — MED-03 extended', () => {
  for (let code = 0x2066; code <= 0x2069; code++) {
    const ch = String.fromCharCode(code);
    const out = sanitize('x' + ch + 'y');
    assert.equal(out, 'x?y', `code point U+${code.toString(16).toUpperCase()} must be stripped`);
  }
});

test('sanitize preserves chars adjacent to bidi range boundaries — MED-03 extended', () => {
  assert.equal(sanitize('a‧b'), 'a‧b', 'U+2027 just below 2028 must not be stripped');
  assert.equal(sanitize('a b'), 'a b', 'U+202F just above 202E must not be stripped');
  assert.equal(sanitize('a⁥b'), 'a⁥b', 'U+2065 just below 2066 must not be stripped');
  assert.equal(sanitize('a⁪b'), 'a⁪b', 'U+206A just above 2069 must not be stripped');
});

test('logHuman strips 8-bit CSI and RTL override from xmlrpc fault — MED-03 extended', () => {
  const fault = 'a\x9b31mb‮c⁦d';
  const out = logHuman({
    plan: ['https://x/'],
    indexnowResults: null,
    xmlrpcResults: [{
      endpoint: 'https://rpc/',
      status: 'fault',
      httpStatus: 200,
      durationMs: 5,
      fault
    }]
  });
  assert.equal(out.includes('\x9b'), false, 'output must not contain CSI 0x9b');
  assert.equal(out.includes('‮'), false, 'output must not contain RTL override');
  assert.equal(out.includes('⁦'), false, 'output must not contain LRI');
  assert.match(out, /fault="a\?31mb\?c\?d"/);
});

// R1-F3: logHuman must sanitize r.endpoint / r.hub — they originate from
// _config.yml and can carry attacker-supplied ANSI / control bytes.

test('R1-F3: logHuman strips ANSI escapes from xmlrpc endpoint string', () => {
  const out = logHuman({
    plan: ['https://x/'],
    indexnowResults: null,
    xmlrpcResults: [{
      endpoint: 'https://rpc.example.com/\x1b[1;31mINJECTED\x1b[0m',
      status: 'error',
      httpStatus: 0,
      durationMs: 5
    }]
  });
  assert.equal(out.includes('\x1b'), false, 'ESC bytes must not appear in logHuman output');
  assert.match(out, /xmlrpc https:\/\/rpc\.example\.com\/\?\[1;31mINJECTED\?\[0m: error/);
});

test('R1-F3: logHuman strips bidi override (U+202E) from xmlrpc endpoint', () => {
  const out = logHuman({
    plan: ['https://x/'],
    xmlrpcResults: [{
      endpoint: 'https://safe‮evil/path',
      status: 'ok',
      httpStatus: 200,
      durationMs: 1
    }]
  });
  assert.equal(out.includes('‮'), false, 'RTL override must not survive in endpoint');
});

test('R1-F3: logHuman strips ANSI escapes and 8-bit CSI from websub hub string', () => {
  const out = logHuman({
    plan: ['https://x/'],
    indexnowResults: null,
    xmlrpcResults: null,
    websubResults: [{
      hub: 'https://hub.example.com/\x9b31mBAD\x9b0m',
      status: 'error',
      httpStatus: 0,
      durationMs: 5
    }]
  });
  assert.equal(out.includes('\x9b'), false, 'C1 CSI byte must not appear in logHuman websub line');
  assert.match(out, /websub https:\/\/hub\.example\.com\/\?31mBAD\?0m: error/);
});

// R1-F4: U+2028 (LINE SEPARATOR) and U+2029 (PARAGRAPH SEPARATOR) are
// treated as line terminators by some terminals / log aggregators. Adding
// them to CONTROL_CHAR_RE closes a low-severity log-splitting vector.

test('R1-F4: sanitize strips U+2028 LINE SEPARATOR', () => {
  const raw = 'safe INJECTED';
  const out = sanitize(raw);
  assert.equal(out.includes(' '), false, 'U+2028 must be stripped');
  assert.equal(out, 'safe?INJECTED');
});

test('R1-F4: sanitize strips U+2029 PARAGRAPH SEPARATOR', () => {
  const raw = 'safe INJECTED';
  const out = sanitize(raw);
  assert.equal(out.includes(' '), false, 'U+2029 must be stripped');
  assert.equal(out, 'safe?INJECTED');
});

test('R1-F4: logHuman strips U+2028/U+2029 from xmlrpc fault', () => {
  const out = logHuman({
    plan: ['https://x/'],
    xmlrpcResults: [{
      endpoint: 'https://rpc/',
      status: 'fault',
      httpStatus: 200,
      durationMs: 5,
      fault: 'Ping OK hexo-ping-services: SPOOFED '
    }]
  });
  assert.equal(out.includes(' '), false);
  assert.equal(out.includes(' '), false);
});

test('R1-F4: sanitize preserves U+2027 and U+202A boundary chars', () => {
  // Just below U+2028 and just above U+2029 — must remain untouched.
  assert.equal(sanitize('a‧b'), 'a‧b');
  // U+202A is the start of the existing bidi range; verify it is still stripped.
  assert.equal(sanitize('a‪b'), 'a?b');
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

test('logHuman: renders websub hub lines', () => {
  const out = logHuman({
    plan: ['https://x/a/'],
    indexnowResults: null,
    xmlrpcResults: null,
    websubResults: [
      { hub: 'https://pubsubhubbub.appspot.com/', status: 'ok', httpStatus: 204, durationMs: 42 },
      { hub: 'https://push.superfeedr.com/', status: 'error', httpStatus: 500, durationMs: 11 }
    ]
  });
  assert.match(out, /websub https:\/\/pubsubhubbub\.appspot\.com\/: ok \(HTTP 204, 42ms\)/);
  assert.match(out, /websub https:\/\/push\.superfeedr\.com\/: error \(HTTP 500, 11ms\)/);
});

test('logJson: emits websub engine lines with level', () => {
  const out = logJson({
    plan: ['https://x/a/'],
    indexnowResults: null,
    xmlrpcResults: null,
    websubResults: [
      { hub: 'https://hub.example.com/', status: 'ok', httpStatus: 204, durationMs: 21 },
      { hub: 'https://hub2.example.com/', status: 'rate-limited', httpStatus: 429, durationMs: 12 }
    ]
  });
  const lines = out.split('\n');
  assert.equal(lines.length, 2);
  const j0 = JSON.parse(lines[0]);
  assert.equal(j0.engine, 'websub');
  assert.equal(j0.level, 'info');
  const j1 = JSON.parse(lines[1]);
  assert.equal(j1.engine, 'websub');
  assert.equal(j1.level, 'warn');
});

test('logJson strips 8-bit CSI from xmlrpc fault — MED-03 round 3', () => {
  const out = logJson({
    plan: ['https://x/a/'],
    xmlrpcResults: [{ endpoint: 'https://rpc/', status: 'fault', httpStatus: 200, durationMs: 5, fault: 'a\x9b31mb' }]
  });
  assert.equal(out.includes('\x9b'), false, 'serialized output must not contain raw 8-bit CSI byte');
  const j = JSON.parse(out);
  assert.equal(j.fault, 'a?31mb');
});

test('logJson strips RTL override from xmlrpc fault — MED-03 round 3', () => {
  const out = logJson({
    plan: ['https://x/a/'],
    xmlrpcResults: [{ endpoint: 'https://rpc/', status: 'fault', httpStatus: 200, durationMs: 5, fault: 'safe‮flip' }]
  });
  assert.equal(out.includes('‮'), false, 'serialized output must not contain RTL override');
  assert.equal(JSON.parse(out).fault, 'safe?flip');
});

test('logJson strips LRI from indexnow error — MED-03 round 3', () => {
  const out = logJson({
    plan: ['https://x/a/'],
    indexnowResults: [{ batch: 0, urls: 1, status: 'error', httpStatus: 0, durationMs: 3, error: 'net⁦fail' }]
  });
  assert.equal(out.includes('⁦'), false, 'serialized output must not contain LRI');
  assert.equal(JSON.parse(out).error, 'net?fail');
});

test('logJson leaves a safe fault string intact — MED-03 round 3', () => {
  const out = logJson({
    plan: ['https://x/a/'],
    xmlrpcResults: [{ endpoint: 'https://rpc/', status: 'fault', httpStatus: 200, durationMs: 5, fault: 'rejected: spam detected (code 42)' }]
  });
  assert.equal(JSON.parse(out).fault, 'rejected: spam detected (code 42)');
});

test('logJson keeps numeric fields as numbers — MED-03 round 3', () => {
  const out = logJson({
    plan: ['https://x/a/'],
    xmlrpcResults: [{ endpoint: 'https://rpc/', status: 'fault', httpStatus: 200, durationMs: 5, fault: 'spam' }]
  });
  const j = JSON.parse(out);
  assert.equal(typeof j.httpStatus, 'number');
  assert.equal(typeof j.durationMs, 'number');
  assert.equal(j.httpStatus, 200);
  assert.equal(j.durationMs, 5);
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
