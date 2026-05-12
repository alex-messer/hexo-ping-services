import { hashOf } from './hash.mjs';

function sortKey(post) {
  const s = post.updated || post.date;
  if (!s) return 0;
  if (typeof s?.getTime === 'function') return s.getTime();
  return new Date(s).getTime() || 0;
}

export function collectUrls(hexo) {
  const posts = hexo.locals.get('posts').data || [];
  const eligible = posts.filter(p =>
    p.published !== false &&
    p.noindex !== true &&
    p.ping !== false
  );
  eligible.sort((a, b) => sortKey(b) - sortKey(a));
  return eligible.map(p => ({ url: p.permalink, contentHash: hashOf(p) }));
}
