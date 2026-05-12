'use strict';
/* global hexo */

// Hexo loads plugins as CJS. We dynamic-import the ESM scripts.
(async () => {
  const { registerConsole } = await import('./scripts/console.mjs');
  const { registerFilter } = await import('./scripts/filter.mjs');
  registerConsole(hexo);
  registerFilter(hexo);
})();
