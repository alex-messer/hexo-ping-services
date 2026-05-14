'use strict';
const { runPing } = require('../lib/run.js');

// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_RE = /[\x00-\x1f\x7f-\x9f‪-‮⁦-⁩]/g;
function sanitize(s) {
  return String(s == null ? '' : s).replace(CONTROL_CHAR_RE, '?');
}

function parseArgs(argv) {
  return {
    all: Boolean(argv.all),
    dryRun: Boolean(argv['dry-run']),
    verbose: Boolean(argv.verbose),
    noState: Boolean(argv['no-state']),
    since: argv.since || null,
    urls: argv.urls
      ? String(argv.urls).split(',').map(s => s.trim()).filter(Boolean)
      : []
  };
}

function logHuman(result) {
  const lines = [];
  if (result.plan.length === 0) {
    lines.push('hexo-ping-services: no URLs to ping (state up-to-date).');
  } else {
    lines.push(`hexo-ping-services: ${result.plan.length} URL(s) to ping.`);
  }
  if (result.indexnowResults) {
    for (const r of result.indexnowResults) {
      lines.push(`  indexnow batch ${r.batch}: ${r.urls} urls → ${r.status} (HTTP ${r.httpStatus}, ${r.durationMs}ms)`);
    }
  }
  if (result.xmlrpcResults) {
    for (const r of result.xmlrpcResults) {
      const fault = r.fault ? ` fault="${sanitize(r.fault)}"` : '';
      lines.push(`  xmlrpc ${r.endpoint}: ${r.status}${fault} (HTTP ${r.httpStatus}, ${r.durationMs}ms)`);
    }
  }
  if (result.websubResults) {
    for (const r of result.websubResults) {
      lines.push(`  websub ${r.hub}: ${r.status} (HTTP ${r.httpStatus}, ${r.durationMs}ms)`);
    }
  }
  return lines.join('\n');
}

function sanitizeStringFields(r) {
  const copy = {};
  for (const k of Object.keys(r)) {
    const v = r[k];
    copy[k] = typeof v === 'string' ? sanitize(v) : v;
  }
  return copy;
}

function logJson(result) {
  const out = [];
  if (result.indexnowResults) {
    for (const r of result.indexnowResults) {
      out.push(JSON.stringify({ level: r.status === 'ok' ? 'info' : 'warn', engine: 'indexnow', ...sanitizeStringFields(r) }));
    }
  }
  if (result.xmlrpcResults) {
    for (const r of result.xmlrpcResults) {
      out.push(JSON.stringify({ level: r.status === 'ok' ? 'info' : 'warn', engine: 'xmlrpc', ...sanitizeStringFields(r) }));
    }
  }
  if (result.websubResults) {
    for (const r of result.websubResults) {
      out.push(JSON.stringify({ level: r.status === 'ok' ? 'info' : 'warn', engine: 'websub', ...sanitizeStringFields(r) }));
    }
  }
  return out.join('\n');
}

function registerConsole(hexo) {
  hexo.extend.console.register('ping', 'Notify IndexNow + XML-RPC update services.', {
    options: [
      { name: '--all', desc: 'Ping every indexable URL, ignoring state.' },
      { name: '--dry-run', desc: 'Show what would be pinged, no network.' },
      { name: '--verbose', desc: 'Per-endpoint JSON logs to stdout.' },
      { name: '--no-state', desc: 'Skip state-file update.' },
      { name: '--since=<value>', desc: 'Ping URLs whose date >= <value> (ISO or NN[hd]).' },
      { name: '--urls=<csv>', desc: 'Explicit URL list (comma-separated).' }
    ]
  }, async function (argv) {
    const options = parseArgs(argv);
    try {
      // Custom console commands don't auto-trigger Hexo's source loader;
      // call it explicitly so we have access to posts in locals.
      // Idempotent on subsequent calls.
      await this.load();
      const result = await runPing(this, options);
      if (options.verbose) process.stdout.write(logJson(result) + '\n');
      process.stderr.write(logHuman(result) + '\n');

      const indexnowForbidden = (result.indexnowResults || []).some(r => r.status === 'forbidden');
      if (indexnowForbidden) {
        process.exit(1);
      }
    } catch (err) {
      process.stderr.write(`hexo-ping-services: ${err.message}\n`);
      process.exit(1);
    }
  });
}

module.exports = {
  parseArgs,
  registerConsole,
  // Exposed for unit testing; not part of the public API.
  _internal: { logHuman, logJson, sanitize }
};
