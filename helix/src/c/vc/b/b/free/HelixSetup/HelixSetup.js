'use strict';

// ── dep.jl + DirectoryManager + Helix Maven ───────────────────────────────
const _DEP_JL = process.env.HELIX_DEP  || 'F:/helix/.helix/dep.jl';
const _JULIA  = process.env.HELIX_JULIA || 'julia';
const { execFileSync, execSync } = require('child_process');

function _dep(key) {
    const v = execFileSync(_JULIA, [_DEP_JL, 'get', key], { encoding: 'utf8' }).trim();
    if (!v || v === 'not found') throw new Error(`[HelixSetup] dep.jl missing: ${key}`);
    return v;
}
let _DM_PATH;
function _dmResolve(name) {
    if (!_DM_PATH) _DM_PATH = _dep('HELIX_DM');
    const raw = execFileSync(_JULIA, [_DM_PATH, 'grep', name], { encoding: 'utf8' }).trim();
    const lines = raw.split('\n').map(l => l.trim())
        .filter(l => l && !l.startsWith('[DM]') && !l.startsWith('grep '));
    const match = lines.find(l => l.split(/[\\/]/).pop() === name) || lines[0];
    if (!match) throw new Error(`[HelixSetup] DM could not resolve: ${name}`);
    return match;
}

// Resolve Maven artifact to local JAR path
function _mvnResolve(groupId, artifactId, version) {
    const repo    = _dep('HELIX_MAVEN_REPO');
    const mvnPath = _dep('HELIX_MVN_PATH');
    try {
        execFileSync(mvnPath, [
            'dependency:get',
            `-Dartifact=${groupId}:${artifactId}:${version}`,
            `-Dmaven.repo.local=${repo}`,
            '-q',
        ], { stdio: 'pipe' });
    } catch {}
    // Return expected JAR path
    const g = groupId.replace(/\./g, '/');
    return `${repo}/${g}/${artifactId}/${version}/${artifactId}-${version}.jar`;
}

// ─────────────────────────────────────────────────────────────────────────
//  HelixSetup — instance + service setup
//  vc frame · b/b layer · free tier  (internal, dep.jl level)
//  Renamed from: setup_brightbrowser.js
//
//  Creates and configures a Helix instance with its required services.
//  Services are resolved via DirectoryManager; JVM artifacts via Maven.
// ─────────────────────────────────────────────────────────────────────────
class HelixSetup {
    constructor() {
        this._instanceManager = null;
    }

    _instances() {
        if (!this._instanceManager) {
            this._instanceManager = require(_dmResolve('helix_instances.js'));
        }
        return this._instanceManager;
    }

    // ── Create a named Helix instance with services ───────────────────
    create(name, opts = {}) {
        const port     = opts.port     || parseInt(_dep('HELIX_DEFAULT_PORT') || '3001', 10);
        const services = opts.services || ['Database', 'Parser', 'Transpiler', 'WebEngine', 'Localizer'];

        // Resolve service paths via DirectoryManager
        const resolvedServices = services.map(svc => ({
            name: svc,
            path: _dmResolve(`${svc}.js`),
        }));

        // Resolve JVM dependencies via Maven if needed
        const jvmDeps = (opts.jvmDeps || []).map(({ groupId, artifactId, version }) => ({
            artifact: `${groupId}:${artifactId}:${version}`,
            jar:      _mvnResolve(groupId, artifactId, version),
        }));

        const instance = this._instances().createInstance(name, {
            port,
            services:    resolvedServices,
            jvmDeps,
            clientPath:  opts.clientPath || _dep('HELIX_CLIENT_PATH'),
            autoStart:   opts.autoStart !== false,
            dep:         _DEP_JL,
            julia:       _JULIA,
            dm:          _DM_PATH || _dep('HELIX_DM'),
        });

        console.log(`[HelixSetup] instance "${name}" created on port ${port}`);
        return instance;
    }

    // ── Standard Helix browser instance ──────────────────────────────
    createBrowserInstance() {
        return this.create('helix', {
            port:      parseInt(_dep('HELIX_PORT') || '3001', 10),
            services:  ['Database', 'Parser', 'Transpiler', 'WebEngine', 'Localizer'],
            autoStart: true,
        });
    }

    // ── Roku VM instance ──────────────────────────────────────────────
    createRokuVMInstance() {
        return this.create('helix-roku-vm', {
            port:      parseInt(_dep('HELIX_ROKU_VM_PORT') || '8091', 10),
            services:  ['Parser', 'Transpiler', 'WebEngine'],
            autoStart: true,
        });
    }
}

module.exports = HelixSetup;
