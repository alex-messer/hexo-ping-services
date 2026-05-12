'use strict';

const MAX_XMLRPC_ENDPOINTS = 32;
const MAX_WEBSUB_HUBS = 16;
const MAX_FEED_URL_LEN = 2048;
const MAX_KEY_LEN = 256;

const DEFAULT = {
  enabled: true,
  run_after_generate: false,
  indexnow: {
    enabled: true,
    endpoint: 'https://api.indexnow.org/IndexNow',
    key: null,
    key_location: '/indexnow.txt'
  },
  xmlrpc: {
    enabled: true,
    endpoints: ['https://rpc.pingomatic.com/', 'https://rpc.twingly.com/'],
    feed_url: null
  },
  websub: {
    enabled: false,
    hubs: [],
    feed_url: '/atom.xml'
  },
  state_file: '.hexo-ping-state.json',
  concurrency: 5,
  timeout_ms: 5000
};

function merge(defaults, user) {
  const out = { ...defaults };
  for (const [k, v] of Object.entries(user || {})) {
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = merge(defaults[k] || {}, v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function resolveConfig(hexoConfig) {
  const userPing = hexoConfig.ping || null;
  const raw = merge(DEFAULT, userPing || {});
  if (userPing && raw.enabled && raw.indexnow.enabled && !raw.indexnow.key) {
    throw new Error('hexo-ping-services: indexnow.key is required when indexnow.enabled');
  }
  if (Array.isArray(raw.xmlrpc.endpoints) && raw.xmlrpc.endpoints.length > MAX_XMLRPC_ENDPOINTS) {
    throw new Error(`hexo-ping-services: too many endpoints (max ${MAX_XMLRPC_ENDPOINTS})`);
  }
  if (typeof raw.xmlrpc.feed_url === 'string' && raw.xmlrpc.feed_url.length > MAX_FEED_URL_LEN) {
    throw new Error(`hexo-ping-services: feed_url too long (max ${MAX_FEED_URL_LEN} chars)`);
  }
  if (typeof raw.indexnow.key === 'string' && raw.indexnow.key.length > MAX_KEY_LEN) {
    throw new Error(`hexo-ping-services: indexnow.key too long (max ${MAX_KEY_LEN} chars)`);
  }
  if (Array.isArray(raw.websub.hubs) && raw.websub.hubs.length > MAX_WEBSUB_HUBS) {
    throw new Error(`hexo-ping-services: too many websub hubs (max ${MAX_WEBSUB_HUBS})`);
  }
  if (typeof raw.websub.feed_url === 'string' && raw.websub.feed_url.length > MAX_FEED_URL_LEN) {
    throw new Error(`hexo-ping-services: websub.feed_url too long (max ${MAX_FEED_URL_LEN} chars)`);
  }
  return {
    enabled: raw.enabled,
    runAfterGenerate: raw.run_after_generate,
    indexnow: {
      enabled: raw.indexnow.enabled,
      endpoint: raw.indexnow.endpoint,
      key: raw.indexnow.key,
      keyLocation: raw.indexnow.key_location
    },
    xmlrpc: {
      enabled: raw.xmlrpc.enabled,
      endpoints: raw.xmlrpc.endpoints,
      feedUrl: raw.xmlrpc.feed_url
    },
    websub: {
      enabled: raw.websub.enabled,
      hubs: raw.websub.hubs,
      feedUrl: raw.websub.feed_url
    },
    stateFile: raw.state_file,
    concurrency: raw.concurrency,
    timeoutMs: raw.timeout_ms
  };
}

module.exports = { resolveConfig };
