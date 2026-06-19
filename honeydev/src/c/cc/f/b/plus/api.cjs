'use strict';
// cc/f/b/plus — inherits lite API, adds WASM/binary endpoints
const base = require('../lite/api.cjs');

async function compileWasm(src, opts) { return base.post('/api/compile/wasm', { src, ...opts }); }
async function runBinary(buf)         { return base.post('/api/run/binary', { buf }); }
async function getTools()             { return base.get('/api/tools?tier=plus'); }

module.exports = { ...base, compileWasm, runBinary, getTools };
