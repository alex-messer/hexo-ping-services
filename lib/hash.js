'use strict';
const { createHash } = require('node:crypto');

function dateString(d) {
  if (!d) return '';
  if (typeof d?.toISOString === 'function') return d.toISOString();
  return String(d);
}

function hashOf(post) {
  const stamp = dateString(post.updated || post.date);
  const digest = createHash('sha256').update(post.permalink + '|' + stamp).digest('hex');
  return 'sha256:' + digest;
}

module.exports = { hashOf };
