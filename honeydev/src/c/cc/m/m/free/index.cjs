'use strict';
// cc/m/m/free — mm-free: top-level module assembly
// Entry point for the honeydev cc frame at free tier.
// Composes the full front surface (f) + back service (b) into one export.

const front   = require('../../f/m/free/index.cjs');
const service = require('../b/free/service.cjs');
const router  = require('../f/free/router.cjs');

module.exports = { front, service, router };
