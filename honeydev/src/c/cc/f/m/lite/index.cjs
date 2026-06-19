'use strict';
// cc/f/m/lite — orchestrates lite ff + fb
const base = require('../free/index.cjs');
const api  = require('../b/lite/api.cjs');

async function boot(mountId = 'app') {
    const projects = await api.getProjects().catch(() => []);
    const mount = document.getElementById('hd-projects');
    if (mount && projects.length) {
        mount.innerHTML = projects.map(p =>
            `<div style="padding:4px 0;font-size:.85rem"><a href="/projects/${p.id}" style="color:#f5c518">${p.name}</a></div>`
        ).join('');
    }
}

if (typeof document !== 'undefined') {
    document.addEventListener('DOMContentLoaded', () => boot().catch(() => {}));
}

module.exports = { ...base, boot, api };
