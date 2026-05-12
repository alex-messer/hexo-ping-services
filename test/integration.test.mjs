import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { runInThisContext } from 'node:vm';
import Module from 'node:module';
import Hexo from 'hexo';

function setupFakeBlog() {
  const dir = mkdtempSync(join(tmpdir(), 'hps-integration-'));
  mkdirSync(join(dir, 'source/_posts'), { recursive: true });
  writeFileSync(join(dir, '_config.yml'), `
title: Test Blog
url: https://example.com
root: /
permalink: :title/
language: en
ping:
  indexnow:
    key: abc123
    key_location: /abc.txt
  xmlrpc:
    endpoints: []
`);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'hps-integration-test',
    version: '0.0.0'
  }));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// Mimic Hexo's plugin loader: vm.runInThisContext with no dynamic-import
// callback. This is what Hexo's loadPlugin() actually does at runtime in
// node_modules/hexo/dist/hexo/index.js — and what makes `await import(...)`
// inside index.js throw ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING.
async function loadPluginLikeHexo(hexo, pluginPath) {
  const script = readFileSync(pluginPath, 'utf8');
  const req = createRequire(pluginPath);
  const module = new Module(pluginPath);
  module.filename = pluginPath;
  const wrapped =
    `(async function(exports, require, module, __filename, __dirname, hexo){${script}\n});`;
  const fn = runInThisContext(wrapped, pluginPath);
  await fn(module.exports, req, module, pluginPath, dirname(pluginPath), hexo);
  return module.exports;
}

test('plugin loads in a real Hexo instance without ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING', async () => {
  const { dir, cleanup } = setupFakeBlog();
  try {
    const hexo = new Hexo(dir, { safe: false });
    await hexo.init();

    const pluginPath = resolve('./index.js');
    // The real bug surfaces here: Hexo's vm.runInThisContext has no
    // dynamic-import callback, so any `await import(...)` inside index.js
    // throws. We assert no throw.
    await loadPluginLikeHexo(hexo, pluginPath);
    // Give any async work a tick to settle so errors surface deterministically.
    await new Promise(r => setTimeout(r, 100));

    const cmds = hexo.extend.console.list();
    assert.ok(cmds.ping, 'ping console command must be registered');
    const filters = hexo.extend.filter.list('after_generate');
    assert.ok(filters && filters.length > 0, 'after_generate filter must be registered');

    await hexo.exit();
  } finally {
    cleanup();
  }
});

test('hexo ping CLI calls hexo.load() so posts are visible', async () => {
  const { dir, cleanup } = setupFakeBlog();
  try {
    // Create a fake post file so hexo.load() has something to process.
    writeFileSync(
      join(dir, 'source/_posts/hello.md'),
      '---\ntitle: Hello\ndate: 2026-01-01\n---\nbody\n'
    );

    const hexo = new Hexo(dir, { safe: false });
    await hexo.init();

    // Track whether hexo.load was called by the ping console command.
    let loadCalled = false;
    const originalLoad = hexo.load.bind(hexo);
    hexo.load = async function (...args) {
      loadCalled = true;
      return originalLoad(...args);
    };

    // Load and register the plugin against this Hexo instance.
    const pluginPath = resolve('./index.js');
    await loadPluginLikeHexo(hexo, pluginPath);

    // Invoke the ping console command with --dry-run --all.
    const pingCmd = hexo.extend.console.list().ping;
    await pingCmd.call(hexo, { 'dry-run': true, all: true });

    assert.ok(loadCalled, 'hexo.load() must be called by the ping console command');
    await hexo.exit();
  } finally {
    cleanup();
  }
});
