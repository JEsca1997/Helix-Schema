'use strict';
// cc/f/b/lite — inherits free API, adds lite-tier endpoints
const base = require('../free/api.cjs');

async function getProjects()          { return base.get('/api/projects'); }
async function createProject(data)    { return base.post('/api/projects', data); }
async function getTools()             { return base.get('/api/tools?tier=lite'); }

module.exports = { ...base, getProjects, createProject, getTools };
