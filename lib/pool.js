'use strict';

// Sequential-index worker pool. Spawns up to `concurrency` async workers that
// each pull the next index from a shared counter and apply `task(item, idx)`.
// Returns results indexed positionally (order matches `items`, NOT completion
// order). Empty `items` short-circuits to `[]` without spawning workers.
async function parallelMap(items, task, concurrency) {
  if (!items.length) return [];
  const results = Array.from({ length: items.length });
  let next = 0;
  async function worker() {
    for (;;) {
      const idx = next++;
      if (idx >= items.length) return;
      results[idx] = await task(items[idx], idx);
    }
  }
  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
}

module.exports = { parallelMap };
