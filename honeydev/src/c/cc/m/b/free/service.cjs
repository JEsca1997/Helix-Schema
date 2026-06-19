'use strict';
// cc/m/b/free — mb-free: service layer
// Business logic and use-case orchestration for the cc/free surface.

const api = require('../../f/b/free/api.cjs');

async function loadPage(route) {
    return { route, data: null };
}

module.exports = { loadPage, api };
