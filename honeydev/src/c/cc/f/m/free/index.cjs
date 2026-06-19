'use strict';
// cc/f/m/free — fm-free: front module entry
// Assembles ff (GUI) + fb (API) and boots the website.

const api = require('../b/free/api.cjs');

function boot(mountId = 'app') {
    const mount = document.getElementById(mountId);
    if (!mount) return;
    mount.innerHTML = `<h1>HoneyDev</h1><p>Loading…</p>`;
    // hydrate from API when backend is wired
}

if (typeof document !== 'undefined') {
    document.addEventListener('DOMContentLoaded', () => boot());
}

module.exports = { boot, api };
