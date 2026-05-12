'use strict';
/* global hexo */
const { registerConsole } = require('./scripts/console.js');
const { registerFilter } = require('./scripts/filter.js');
registerConsole(hexo);
registerFilter(hexo);
