'use strict';
const { readFileSync, writeFileSync, renameSync, existsSync, lstatSync } = require('node:fs');
const { dirname, basename, join } = require('node:path');

const EMPTY = () => ({ version: 1, lastRun: null, urls: {} });

// Refuse symlinks for the state file to defeat link-replacement attacks where
// an attacker pre-creates the file as a symlink to /etc/passwd (or any other
// path) and tricks `commit` into clobbering it via the atomic rename.
function refuseSymlink(filePath) {
  try {
    const st = lstatSync(filePath);
    if (st.isSymbolicLink()) {
      throw new Error('hexo-ping-services: state file is a symlink, refusing for security');
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

function readState(filePath) {
  refuseSymlink(filePath);
  if (!existsSync(filePath)) return EMPTY();
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    if (parsed.version !== 1) return EMPTY();
    return {
      version: 1,
      lastRun: parsed.lastRun ?? null,
      urls: parsed.urls ?? {}
    };
  } catch {
    return EMPTY();
  }
}

function diff(state, items) {
  const out = [];
  for (const item of items) {
    const prev = state.urls[item.url];
    if (!prev || prev.contentHash !== item.contentHash) out.push(item.url);
  }
  return out;
}

// NOTE: this function is not safe under concurrent invocation against the same
// state file. Two parallel runs can interleave read → write and lose updates,
// or race on the temp filename. Build pipelines run `hexo ping` once per build
// so the assumption holds today; tracked as a v0.2 follow-up.
function commit(filePath, state, pingedItems) {
  refuseSymlink(filePath);
  const now = new Date().toISOString();
  const next = { version: 1, lastRun: now, urls: { ...state.urls } };
  for (const item of pingedItems) {
    next.urls[item.url] = { lastPinged: now, contentHash: item.contentHash };
  }
  const tmp = join(dirname(filePath), '.' + basename(filePath) + '.tmp');
  writeFileSync(tmp, JSON.stringify(next, null, 2));
  renameSync(tmp, filePath);
}

module.exports = { readState, diff, commit };
