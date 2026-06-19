'use strict';
// cc/f/m/pro — orchestrates pro ff + fb (inherits plus)
const base = require('../plus/index.cjs');
const api  = require('../b/pro/api.cjs');

async function boot(mountId = 'app') {
    await base.boot(mountId);
    // wire Julia console input if present
    const consoleEl = document.getElementById('hd-console');
    if (consoleEl) {
        consoleEl.addEventListener('keydown', async (e) => {
            if (e.key !== 'Enter' || !e.ctrlKey) return;
            const code = consoleEl.querySelector('input')?.value?.trim();
            if (!code) return;
            try {
                const res = await api.runJulia(code);
                consoleEl.insertAdjacentHTML('beforeend',
                    `<div><span class="hd-console-out">${res.output || ''}</span></div>`);
            } catch (err) {
                consoleEl.insertAdjacentHTML('beforeend',
                    `<div><span class="hd-console-err">${err.message}</span></div>`);
            }
        });
    }
}

if (typeof document !== 'undefined') {
    document.addEventListener('DOMContentLoaded', () => boot().catch(() => {}));
}

module.exports = { ...base, boot, api };
