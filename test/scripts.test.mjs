// Tests for scripts/console.js and scripts/filter.js have moved to
// console.test.mjs and filter.test.mjs respectively. Splitting was required
// because node --test silently drops the first ~4 tests from this combined
// file under Node 22.x/24.x process-isolation mode (confirmed bug).
// This file intentionally registers no tests.
