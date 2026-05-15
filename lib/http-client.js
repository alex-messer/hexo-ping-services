'use strict';

const https = require('node:https');
const http = require('node:http');

const TRUNCATED_SENTINEL = '<response truncated>';

// Reads the response body but stops once `maxBytes` is exceeded, destroying the
// socket so a malicious or runaway server can't pump an unbounded body into
// memory. Returns the decoded text, or the truncation sentinel on overflow.
function readBodyCapped(res, maxBytes) {
  return new Promise((resolve, reject) => {
    let received = 0;
    let truncated = false;
    const chunks = [];
    res.on('data', (chunk) => {
      if (truncated) return;
      received += chunk.length;
      if (received > maxBytes) {
        truncated = true;
        res.destroy();
        resolve(TRUNCATED_SENTINEL);
        return;
      }
      chunks.push(chunk);
    });
    res.on('end', () => {
      if (truncated) return;
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    res.on('close', () => {
      if (truncated) return;
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    res.on('error', (err) => {
      if (truncated) return;
      reject(err);
    });
  });
}

// Single request primitive shared by all three engines. Deliberately does NOT
// follow redirects: node:http(s) keeps a 3xx as a terminal response, which the
// SSRF guard depends on. `lookup` is the pre-validated pin from url-guard; when
// omitted the platform resolver is used (e.g. loopback test servers).
function request(rawUrl, { method = 'GET', headers = {}, body = null, timeoutMs = 5000, lookup = null } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(rawUrl);
    } catch (err) {
      reject(err);
      return;
    }
    const transport = u.protocol === 'https:' ? https : http;
    const controller = new AbortController();
    const options = {
      method,
      headers,
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      signal: controller.signal
    };
    if (lookup) options.lookup = lookup;

    let settled = false;
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const req = transport.request(options, (res) => {
      if (settled) {
        res.destroy();
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({
        status: res.statusCode,
        headers: res.headers,
        stream: res,
        readBodyCapped: (maxBytes) => readBodyCapped(res, maxBytes),
        text: () => readBodyCapped(res, Infinity)
      });
    });

    req.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    if (body != null) req.write(body);
    req.end();
  });
}

module.exports = { request, readBodyCapped, TRUNCATED_SENTINEL };
