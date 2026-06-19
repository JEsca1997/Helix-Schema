'use strict';
// cc/f/b/pro — inherits plus API, adds Julia/pipeline endpoints
const base = require('../plus/api.cjs');

async function runJulia(code)         { return base.post('/api/julia/run', { code }); }
async function runPipeline(src, opts) { return base.post('/api/pipeline/run', { src, ...opts }); }
async function runGhost(asm, input)   { return base.post('/api/ghost/run', { asm, input }); }
async function getTools()             { return base.get('/api/tools?tier=pro'); }

module.exports = { ...base, runJulia, runPipeline, runGhost, getTools };
