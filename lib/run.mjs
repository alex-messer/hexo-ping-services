import { join, isAbsolute } from 'node:path';
import { resolveConfig } from './config.mjs';
import { collectUrls } from './collect-urls.mjs';
import { readState, diff, commit } from './state.mjs';
import { submitIndexNow } from './indexnow.mjs';
import { pingAll } from './xmlrpc.mjs';

export async function runPing(hexo, options = {}) {
  const config = resolveConfig(hexo.config);
  if (!config.enabled) {
    return { plan: [], indexnowResults: null, xmlrpcResults: null };
  }

  let items;
  if (options.urls && options.urls.length) {
    items = options.urls.map(url => ({ url, contentHash: 'sha256:manual' }));
  } else {
    items = collectUrls(hexo);
  }

  const stateFilePath = isAbsolute(config.stateFile)
    ? config.stateFile
    : join(hexo.base_dir, config.stateFile);
  const state = readState(stateFilePath);
  const dirtyUrls = options.all
    ? items.map(i => i.url)
    : diff(state, items);

  if (options.dryRun) {
    return { plan: dirtyUrls, indexnowResults: null, xmlrpcResults: null };
  }

  if (!dirtyUrls.length) {
    return { plan: [], indexnowResults: [], xmlrpcResults: [] };
  }

  const [indexnowResults, xmlrpcResults] = await Promise.all([
    config.indexnow.enabled
      ? submitIndexNow({
          endpoint: config.indexnow.endpoint,
          host: new URL(hexo.config.url).host,
          key: config.indexnow.key,
          keyLocation: config.indexnow.keyLocation.startsWith('http')
            ? config.indexnow.keyLocation
            : hexo.config.url.replace(/\/+$/, '') + config.indexnow.keyLocation,
          timeoutMs: config.timeoutMs
        }, dirtyUrls)
      : [],
    (config.xmlrpc.enabled && config.xmlrpc.endpoints.length)
      ? pingAll(
          config.xmlrpc.endpoints,
          hexo.config.title,
          hexo.config.url,
          config.xmlrpc.feedUrl
            ? (config.xmlrpc.feedUrl.startsWith('http') ? config.xmlrpc.feedUrl : hexo.config.url.replace(/\/+$/, '') + config.xmlrpc.feedUrl)
            : null,
          { timeoutMs: config.timeoutMs }
        )
      : []
  ]);

  const pingedItems = items.filter(i => dirtyUrls.includes(i.url));
  commit(stateFilePath, state, pingedItems);

  return { plan: dirtyUrls, indexnowResults, xmlrpcResults };
}
