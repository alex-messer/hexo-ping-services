'use strict';
const path = require('node:path');
const { resolveConfig } = require('./config.js');
const { collectUrls } = require('./collect-urls.js');
const { readState, diff, commit } = require('./state.js');
const { submitIndexNow } = require('./indexnow.js');
const { pingAll } = require('./xmlrpc.js');
const { publishToHubs } = require('./websub.js');

const HTTP_URL_RE = /^https?:\/\//i;

function resolveStateFilePath(stateFile, baseDir) {
  const stateAbs = path.isAbsolute(stateFile)
    ? path.resolve(stateFile)
    : path.resolve(baseDir, stateFile);
  const baseAbs = path.resolve(baseDir);
  if (stateAbs !== baseAbs && !stateAbs.startsWith(baseAbs + path.sep)) {
    throw new Error(
      `hexo-ping-services: state_file must be inside hexo.base_dir (${baseAbs}), got ${stateAbs}`
    );
  }
  return stateAbs;
}

async function runPing(hexo, options = {}) {
  const config = resolveConfig(hexo.config);
  if (!config.enabled) {
    return { plan: [], indexnowResults: null, xmlrpcResults: null, websubResults: null };
  }

  let items;
  if (options.urls && options.urls.length) {
    items = options.urls.map(url => ({ url, contentHash: 'sha256:manual' }));
  } else {
    items = collectUrls(hexo);
  }

  const stateFilePath = resolveStateFilePath(config.stateFile, hexo.base_dir);
  const state = readState(stateFilePath);
  const dirtyUrls = options.all
    ? items.map(i => i.url)
    : diff(state, items);

  if (options.dryRun) {
    return { plan: dirtyUrls, indexnowResults: null, xmlrpcResults: null, websubResults: null };
  }

  if (!dirtyUrls.length) {
    return { plan: [], indexnowResults: [], xmlrpcResults: [], websubResults: [] };
  }

  const siteUrl = hexo.config.url;
  const siteUrlNoSlash = siteUrl.replace(/\/+$/, '');
  const keyLocation = HTTP_URL_RE.test(config.indexnow.keyLocation)
    ? config.indexnow.keyLocation
    : siteUrlNoSlash + config.indexnow.keyLocation;
  const feedUrl = config.xmlrpc.feedUrl
    ? (HTTP_URL_RE.test(config.xmlrpc.feedUrl)
        ? config.xmlrpc.feedUrl
        : siteUrlNoSlash + config.xmlrpc.feedUrl)
    : null;
  const websubFeedUrl = config.websub.feedUrl
    ? (HTTP_URL_RE.test(config.websub.feedUrl)
        ? config.websub.feedUrl
        : siteUrlNoSlash + config.websub.feedUrl)
    : null;

  const [indexnowResults, xmlrpcResults, websubResults] = await Promise.all([
    config.indexnow.enabled
      ? submitIndexNow({
          endpoint: config.indexnow.endpoint,
          host: new URL(siteUrl).host,
          key: config.indexnow.key,
          keyLocation,
          timeoutMs: config.timeoutMs
        }, dirtyUrls)
      : [],
    (config.xmlrpc.enabled && config.xmlrpc.endpoints.length)
      ? pingAll(
          config.xmlrpc.endpoints,
          hexo.config.title,
          siteUrl,
          feedUrl,
          { timeoutMs: config.timeoutMs, concurrency: config.concurrency }
        )
      : [],
    (config.websub.enabled && config.websub.hubs.length && websubFeedUrl)
      ? publishToHubs(
          config.websub.hubs,
          websubFeedUrl,
          { timeoutMs: config.timeoutMs, concurrency: config.concurrency }
        )
      : []
  ]);

  // Only persist state when at least one engine acknowledged the ping. If every
  // call failed (error / forbidden / blocked / fault), leave state untouched so
  // the next run retries instead of marking URLs permanently pinged.
  const anySuccess =
    (indexnowResults || []).some(r => r.status === 'ok') ||
    (xmlrpcResults || []).some(r => r.status === 'ok') ||
    (websubResults || []).some(r => r.status === 'ok');
  if (anySuccess) {
    const pingedItems = items.filter(i => dirtyUrls.includes(i.url));
    commit(stateFilePath, state, pingedItems);
  }

  return { plan: dirtyUrls, indexnowResults, xmlrpcResults, websubResults };
}

module.exports = { runPing };
