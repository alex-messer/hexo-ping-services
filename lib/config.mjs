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

export function resolveConfig(hexoConfig) {
  const userPing = hexoConfig.ping || null;
  const raw = merge(DEFAULT, userPing || {});
  if (userPing && raw.enabled && raw.indexnow.enabled && !raw.indexnow.key) {
    throw new Error('hexo-ping-services: indexnow.key is required when indexnow.enabled');
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
    stateFile: raw.state_file,
    concurrency: raw.concurrency,
    timeoutMs: raw.timeout_ms
  };
}
