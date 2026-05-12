import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { dirname, basename, join } from 'node:path';

const EMPTY = () => ({ version: 1, lastRun: null, urls: {} });

export function readState(filePath) {
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

export function diff(state, items) {
  const out = [];
  for (const item of items) {
    const prev = state.urls[item.url];
    if (!prev || prev.contentHash !== item.contentHash) out.push(item.url);
  }
  return out;
}

export function commit(filePath, state, pingedItems) {
  const now = new Date().toISOString();
  const next = { version: 1, lastRun: now, urls: { ...state.urls } };
  for (const item of pingedItems) {
    next.urls[item.url] = { lastPinged: now, contentHash: item.contentHash };
  }
  const tmp = join(dirname(filePath), '.' + basename(filePath) + '.tmp');
  writeFileSync(tmp, JSON.stringify(next, null, 2));
  renameSync(tmp, filePath);
}
