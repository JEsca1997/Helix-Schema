'use strict';

// ── dep.jl + DirectoryManager + Helix Maven ───────────────────────────────
// Only stable hardcode: dep.jl root. Everything else resolved at runtime.
const _DEP_JL = process.env.HELIX_DEP  || 'F:/helix/.helix/dep.jl';
const _JULIA  = process.env.HELIX_JULIA || 'julia';

const { execSync, execFileSync, spawn } = require('child_process');

function _dep(key) {
    const v = execFileSync(_JULIA, [_DEP_JL, 'get', key], { encoding: 'utf8' }).trim();
    if (!v || v === 'not found') throw new Error(`[helix] dep.jl missing: ${key}`);
    return v;
}

let _DM_PATH;
function _dmResolve(name) {
    if (!_DM_PATH) _DM_PATH = _dep('HELIX_DM');
    const raw = execFileSync(_JULIA, [_DM_PATH, 'grep', name], { encoding: 'utf8' }).trim();
    const lines = raw.split('\n').map(l => l.trim())
        .filter(l => l && !l.startsWith('[DM]') && !l.startsWith('grep '));
    const match = lines.find(l => l.split(/[\\/]/).pop() === name) || lines[0];
    if (!match) throw new Error(`[helix] DM could not resolve: ${name}`);
    return match;
}

// Maven artifact resolution via DependencyManager
function _mvn(groupId, artifactId, version) {
    const mvnRepo  = _dep('HELIX_MAVEN_REPO');
    const mvnPath  = _dep('HELIX_MVN_PATH');
    const artifact = `${groupId}:${artifactId}:${version}`;
    const v = execFileSync(mvnPath, [
        'dependency:get',
        `-Dartifact=${artifact}`,
        `-Dmaven.repo.local=${mvnRepo}`,
        '-q',
    ], { encoding: 'utf8' }).trim();
    return v;
}

// ── Runtime paths via DirectoryManager ────────────────────────────────────
const _CONTROL_SERVER = () => _dmResolve('control_server.js');
const _KILL_ALL       = () => _dmResolve('kill_all.js');
const _SESSION_MGR    = () => _dmResolve('SessionManager.js');
const _INSTANCES      = () => _dmResolve('helix_instances.js');

// ── Klein-4 / tier config via dep.jl ──────────────────────────────────────
const _CONTROL_PORT   = () => parseInt(_dep('HELIX_CONTROL_PORT') || '4000', 10);
const _HELIX_URL      = () => process.env.HELIX_URL || _dep('HELIX_URL');

// ─────────────────────────────────────────────────────────────────────────
//  helix — browser entry point
//  cc frame · m/m layer · free tier
//  Renamed from: BrightBrowser / boss-browser
//  Packages as: helix.exe (Electron) or node helix.js (CLI)
//
//  Two axes:
//    --helix=trivial   Single DM connection (free/lite, default)
//    --helix=discrete  Multiple service connections (plus/pro)
//    --clients=sequential  All clients share one worker (free tier)
//    --clients=parallel    Each client gets isolated workers (paid tier)
//
//  Tier map:
//    trivial  + sequential → free   (k4=00, cc only, D^0)
//    trivial  + parallel   → lite   (k4=01, cv basic, D^½)
//    discrete + sequential → plus   (k4=01+, cv extended, D^½+)
//    discrete + parallel   → pro    (k4=10, vc, D^1, AES-GCM)
// ─────────────────────────────────────────────────────────────────────────
class Helix {
    constructor() {
        this.controlPort = _CONTROL_PORT();
        this.helixUrl    = _HELIX_URL();
    }

    // ── Arg parsing ───────────────────────────────────────────────────
    parseArgs(args) {
        const cfg = { helixMode: 'trivial', clientMode: 'sequential' };
        args.forEach(a => {
            if (a.startsWith('--helix='))   cfg.helixMode  = a.split('=')[1];
            if (a.startsWith('--clients=')) cfg.clientMode = a.split('=')[1];
        });
        if (!['trivial','discrete'].includes(cfg.helixMode)) {
            console.error('[helix] --helix must be "trivial" or "discrete"');
            process.exit(1);
        }
        if (!['sequential','parallel'].includes(cfg.clientMode)) {
            console.error('[helix] --clients must be "sequential" or "parallel"');
            process.exit(1);
        }
        return cfg;
    }

    // ── Tier from mode pair ───────────────────────────────────────────
    tierFromConfig(cfg) {
        if (cfg.helixMode === 'trivial'  && cfg.clientMode === 'sequential') return { tier: 'free',  k4: '00' };
        if (cfg.helixMode === 'trivial'  && cfg.clientMode === 'parallel')   return { tier: 'lite',  k4: '01' };
        if (cfg.helixMode === 'discrete' && cfg.clientMode === 'sequential') return { tier: 'plus',  k4: '01' };
        if (cfg.helixMode === 'discrete' && cfg.clientMode === 'parallel')   return { tier: 'pro',   k4: '10' };
    }

    // ── Kill all helix processes ──────────────────────────────────────
    killAll() {
        console.log('[helix] stopping all processes...');
        try {
            execFileSync(process.execPath, [_KILL_ALL()], { stdio: 'inherit' });
        } catch {}
    }

    // ── Start control server ──────────────────────────────────────────
    startControl(cfg) {
        const { tier, k4 } = this.tierFromConfig(cfg);

        console.log('─'.repeat(56));
        console.log('  HELIX STARTUP');
        console.log('─'.repeat(56));
        console.log(`  Port        : ${this.controlPort}`);
        console.log(`  Helix URL   : ${this.helixUrl}`);
        console.log(`  Helix mode  : ${cfg.helixMode}`);
        console.log(`  Client mode : ${cfg.clientMode}`);
        console.log(`  Tier        : ${tier} (k4=${k4})`);
        console.log('─'.repeat(56));

        this.killAll();

        setTimeout(() => {
            const env = {
                ...process.env,
                HELIX_MODE:        cfg.helixMode,
                HELIX_CLIENT_MODE: cfg.clientMode,
                HELIX_TIER:        tier,
                HELIX_K4:          k4,
                HELIX_URL:         this.helixUrl,
                HELIX_DEP:         _DEP_JL,
                HELIX_JULIA:       _JULIA,
                HELIX_DM:          _DM_PATH || _dep('HELIX_DM'),
            };

            const proc = spawn(process.execPath, [_CONTROL_SERVER()], {
                stdio: 'inherit',
                env,
            });

            proc.on('error', e => {
                console.error('[helix] failed to start control server:', e.message);
                process.exit(1);
            });
        }, 500);
    }

    // ── Roku VM mode ──────────────────────────────────────────────────
    startRokuVM(cfg) {
        console.log('[helix] starting Roku VM (BrightScript emulation)...');
        const SessionManager = require(_SESSION_MGR());
        const session = new SessionManager(_dep('HELIX_WORKSPACE'));
        session.startSession({
            user:         _dep('HELIX_USER'),
            scope:        'roku-vm',
            networkScope: 'localhost',
            helixMode:    cfg.helixMode,
            clientMode:   cfg.clientMode,
        });
    }

    // ── Help ──────────────────────────────────────────────────────────
    help() {
        console.log([
            '',
            'helix — browser entry point',
            '',
            'Usage:',
            '  node helix.js control [--helix=<mode>] [--clients=<mode>]',
            '  node helix.js roku-vm [--helix=<mode>] [--clients=<mode>]',
            '  node helix.js kill',
            '',
            '--helix modes:',
            '  trivial   Single DM connection (free/lite)  [default]',
            '  discrete  Multiple service connections (plus/pro)',
            '',
            '--clients modes:',
            '  sequential  All clients share one worker (free)  [default]',
            '  parallel    Each client gets isolated workers (paid)',
            '',
            'Tier map:',
            '  trivial  + sequential → free  (k4=00)',
            '  trivial  + parallel   → lite  (k4=01)',
            '  discrete + sequential → plus  (k4=01+)',
            '  discrete + parallel   → pro   (k4=10)',
            '',
        ].join('\n'));
    }

    // ── Run ───────────────────────────────────────────────────────────
    run(args) {
        const cmd = args[0] || 'help';
        const cfg = this.parseArgs(args.slice(1));
        switch (cmd) {
            case 'control':  this.startControl(cfg); break;
            case 'roku-vm':  this.startRokuVM(cfg);  break;
            case 'kill':     this.killAll();          break;
            default:         this.help();             break;
        }
    }
}

if (require.main === module) {
    new Helix().run(process.argv.slice(2));
}

module.exports = Helix;
