'use strict';
// cc/f/m/plus — orchestrates plus ff + fb (inherits lite)
const base = require('../lite/index.cjs');
const api  = require('../b/plus/api.cjs');

async function boot(mountId = 'app') {
    await base.boot(mountId);
    // additional hydration for plus-specific panels would go here
}

if (typeof document !== 'undefined') {
    document.addEventListener('DOMContentLoaded', () => boot().catch(() => {}));
}

module.exports = { ...base, boot, api };
