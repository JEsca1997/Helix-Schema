'use strict';
// cc/f/b/free — fb-free: frontend API layer
// Handles all outbound fetch calls from the website surface (cc/f/f).
// Routes through cv shr port for public transit.

const API_BASE = typeof window !== 'undefined'
    ? window.__HD_API__ || ''
    : '';

async function get(endpoint) {
    const res = await fetch(`${API_BASE}${endpoint}`);
    if (!res.ok) throw new Error(`GET ${endpoint} → ${res.status}`);
    return res.json();
}

async function post(endpoint, body) {
    const res = await fetch(`${API_BASE}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`POST ${endpoint} → ${res.status}`);
    return res.json();
}

module.exports = { get, post };
