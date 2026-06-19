'use strict';
// cc/m/f/free — mf-free: view routing / controller
// Maps URL paths to view components at the free tier.

const routes = {
    '/':       'home',
    '/about':  'about',
    '/contact':'contact',
};

function resolve(pathname) {
    return routes[pathname] || 'home';
}

module.exports = { routes, resolve };
