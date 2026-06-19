'use strict';

// ── dep.jl + DirectoryManager ─────────────────────────────────────────────
const _DEP_JL = process.env.HELIX_DEP  || 'F:/helix/.helix/dep.jl';
const _JULIA  = process.env.HELIX_JULIA || 'julia';
const { execFileSync } = require('child_process');

function _dep(key) {
    const v = execFileSync(_JULIA, [_DEP_JL, 'get', key], { encoding: 'utf8' }).trim();
    if (!v || v === 'not found') throw new Error(`[HelixRokuVM] dep.jl missing: ${key}`);
    return v;
}
let _DM_PATH;
function _dmResolve(name) {
    if (!_DM_PATH) _DM_PATH = _dep('HELIX_DM');
    const raw = execFileSync(_JULIA, [_DM_PATH, 'grep', name], { encoding: 'utf8' }).trim();
    const lines = raw.split('\n').map(l => l.trim())
        .filter(l => l && !l.startsWith('[DM]') && !l.startsWith('grep '));
    const match = lines.find(l => l.split(/[\\/]/).pop() === name) || lines[0];
    if (!match) throw new Error(`[HelixRokuVM] DM could not resolve: ${name}`);
    return match;
}

// ─────────────────────────────────────────────────────────────────────────
//  HelixRokuVM — BrightScript / Roku browser emulation
//  cv frame · b/b layer · free tier
//  Renamed from: helix_brightbrowser_session.js
//
//  Runs a Roku VM session inside Helix's session context.
//  BrightScript (Roku's language) is emulated for browser development/testing.
// ─────────────────────────────────────────────────────────────────────────
class HelixRokuVM {
    constructor() {
        this._workspace = _dep('HELIX_WORKSPACE');
        this._user      = _dep('HELIX_USER');
        this._SessionManager = null;
    }

    _sessionManager() {
        if (!this._SessionManager) {
            this._SessionManager = require(_dmResolve('SessionManager.js'));
        }
        return this._SessionManager;
    }

    // ── Start a BrightScript emulation session ────────────────────────
    async start(opts = {}) {
        console.log('[HelixRokuVM] starting BrightScript emulation session...');

        const SessionManager = this._sessionManager();
        const mgr = new SessionManager(this._workspace);

        const session = await mgr.startSession({
            user:         opts.user        || this._user,
            scope:        opts.scope       || 'roku-vm',
            networkScope: opts.networkScope || 'localhost',
            aiExtension:  opts.aiExtension || 'helix',
            helixMode:    opts.helixMode   || 'trivial',
            clientMode:   opts.clientMode  || 'sequential',
        });

        console.log('[HelixRokuVM] session started:', session?.id || '(no id)');
        return session;
    }

    // ── Navigate the Roku VM to a URL ─────────────────────────────────
    async navigate(url) {
        const ws = require(_dmResolve('ws'));
        const vmPort = parseInt(_dep('HELIX_ROKU_VM_PORT') || '8091', 10);

        return new Promise((resolve, reject) => {
            const socket = new ws(`ws://localhost:${vmPort}`);
            socket.on('open', () => {
                socket.send(JSON.stringify({ type: 'navigate', url }));
                setTimeout(() => { socket.close(); resolve(); }, 500);
            });
            socket.on('error', e => reject(e));
        });
    }

    // ── Stop session ──────────────────────────────────────────────────
    async stop() {
        const SessionManager = this._sessionManager();
        const mgr = new SessionManager(this._workspace);
        await mgr.stopSession({ user: this._user, scope: 'roku-vm' });
        console.log('[HelixRokuVM] session stopped.');
    }
}

module.exports = HelixRokuVM;
