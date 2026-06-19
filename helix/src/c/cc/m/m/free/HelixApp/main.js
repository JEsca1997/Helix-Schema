'use strict';

// ─────────────────────────────────────────────────────────────────────────────
//  HelixApp/main.js — Electron main process for helix.exe
//  cc frame · m/m layer · free tier  (top-level assembly / app entry)
//
//  This is the Electron main process. It:
//    1. Resolves all paths via dep.jl + DirectoryManager (never hardcoded)
//    2. Creates the BrowserWindow loading HelixIDE.html
//    3. Exposes IPC handlers for pipeline + GhostVM operations
//    4. Spawns helix.js control server when starting pro/plus tiers
//
//  Only helix.ico and dep.jl paths are __dirname-relative or hardcoded.
// ─────────────────────────────────────────────────────────────────────────────

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path       = require('path');
const { execFileSync, spawn } = require('child_process');


// Only stable hardcode — everything else via dep.jl
const _DEP_JL = process.env.HELIX_DEP  || 'F:/helix/.helix/dep.jl';
// Probe for Julia on Windows if not set
const _JULIA  = process.env.HELIX_JULIA || (() => {
    const candidates = [
        'C:/Julia/bin/julia.exe',
        'C:/Program Files/Julia/bin/julia.exe',
        'julia',
    ];
    const fs = require('fs');
    return candidates.find(p => { try { fs.accessSync(p); return true; } catch { return false; } })
        || 'julia';
})();

function _dep(key) {
    const v = execFileSync(_JULIA, [_DEP_JL, 'get', key], { encoding: 'utf8' }).trim();
    if (!v || v === 'not found') throw new Error(`[HelixApp] dep.jl missing: ${key}`);
    return v;
}

let _DM_PATH;
function _dmResolve(name) {
    if (!_DM_PATH) _DM_PATH = _dep('HELIX_DM');
    const raw = execFileSync(_JULIA, [_DM_PATH, 'grep', name], { encoding: 'utf8' }).trim();
    const lines = raw.split('\n').map(l => l.trim())
        .filter(l => l && !l.startsWith('[DM]') && !l.startsWith('grep '));
    const match = lines.find(l => l.split(/[\\/]/).pop() === name) || lines[0];
    if (!match) throw new Error(`[HelixApp] DM could not resolve: ${name}`);
    return match;
}

// ── Lazy pipeline singleton ───────────────────────────────────────────────────
let _pipeline = null;
function getPipeline() {
    if (_pipeline) return _pipeline;
    const HelixPipeline = require(_dmResolve('HelixPipeline.js'));
    _pipeline = new HelixPipeline({
        tier: process.env.HELIX_TIER || 'free',
        k4:   process.env.HELIX_K4   || 'cc',
    });
    return _pipeline;
}

// ── Lazy GhostVM singleton ────────────────────────────────────────────────────
let _ghostVM = null;
function getGhostVM() {
    if (_ghostVM) return _ghostVM;
    const GhostVM = require(_dmResolve('GhostVM.js'));
    _ghostVM = new GhostVM();
    return _ghostVM;
}

// ── Lazy Ghost (K2 access control) singleton ──────────────────────────────────
// Ghost.js is the access-control layer (K2 gating, xpol, phantomFile, routing).
// Separate from GhostVM.js (the ZWC bytecode VM).
let _ghost = null;
function getGhost() {
    if (_ghost) return _ghost;
    _ghost = require(_dmResolve('Ghost.js'));
    return _ghost;
}

// ── IPC: dep.jl key reads ─────────────────────────────────────────────────────
ipcMain.handle('helix:dep', (_evt, key) => {
    try { return { ok: true, val: _dep(key) }; }
    catch (e) { return { ok: false, err: e.message }; }
});

// ── IPC: full pipeline run ────────────────────────────────────────────────────
ipcMain.handle('helix:pipeline', async (_evt, req) => {
    const { source, stopAt, input, maxSteps } = req || {};
    try {
        const result = await getPipeline().run(source || '', { stopAt, input, maxSteps });
        return { ok: true, result };
    } catch (e) {
        return { ok: false, err: e.message };
    }
});

// ── IPC: Ghost Assembly → ZWC IR ─────────────────────────────────────────────
ipcMain.handle('helix:ghost:assemble', (_evt, asm) => {
    try { return { ok: true, zwc: getGhostVM().assemble(asm) }; }
    catch (e) { return { ok: false, err: e.message }; }
});

// ── IPC: ZWC IR → Ghost Assembly disassembly ─────────────────────────────────
ipcMain.handle('helix:ghost:disassemble', (_evt, zwc) => {
    try { return { ok: true, asm: getGhostVM().disassemble(zwc) }; }
    catch (e) { return { ok: false, err: e.message }; }
});

// ── IPC: run Ghost Assembly directly ─────────────────────────────────────────
ipcMain.handle('helix:ghost:run', (_evt, { asm, input }) => {
    try { return { ok: true, result: getGhostVM().runAssembly(asm, input || '') }; }
    catch (e) { return { ok: false, err: e.message }; }
});

// ── IPC: Ghost K2 access control ─────────────────────────────────────────────
// Ghost.js (not GhostVM.js) — the io_calculus Klein-4 routing + K2 gating layer.
// Used to validate whether a given path/frame is accessible at the caller's k4 level.
ipcMain.handle('helix:ghost:k2', (_evt, { path, k4 }) => {
    try {
        const Ghost = getGhost();
        const node  = Ghost.ghostValidate(path, false);
        // needsZwc/needsAes/needsBsd tell the renderer which encoding tier applies
        return {
            ok: true,
            node,
            needsZwc: Ghost.needsZwc(node),
            needsAes: Ghost.needsAes(node),
            needsBsd: Ghost.needsBsd(node),
        };
    } catch (e) { return { ok: false, err: e.message }; }
});

// ── IPC: download helix.exe (self-distribution) ───────────────────────────────
// helix.exe serves itself — the landing page can offer a download of the
// currently-running binary. In packaged form: process.execPath = helix.exe.
// In dev (npm start): serves the exe from Build/bin/helix.exe via DM.
ipcMain.handle('helix:download-self', async (_evt) => {
    const fs = require('fs');
    let exePath = process.execPath;

    // In dev mode, process.execPath is the Electron binary itself, not helix.exe.
    // Fall back to the built binary resolved via DM.
    if (!exePath.toLowerCase().endsWith('helix.exe')) {
        try {
            exePath = _dmResolve('helix.exe');
        } catch {
            return { ok: false, err: 'helix.exe not found — run electron-builder first.' };
        }
    }

    try {
        const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
            defaultPath: 'helix.exe',
            filters: [{ name: 'Executable', extensions: ['exe'] }],
        });
        if (canceled || !filePath) return { ok: false, err: 'cancelled' };
        fs.copyFileSync(exePath, filePath);
        return { ok: true, path: filePath };
    } catch (e) { return { ok: false, err: e.message }; }
});

// ── IPC: named drives with schema metadata ────────────────────────────────────
ipcMain.handle('helix:drives', () => {
    try {
        // Get volume names + types via WMIC
        const wmicOut = execFileSync('wmic', [
            'logicaldisk', 'get', 'DeviceID,VolumeName,DriveType,ProviderName',
        ], { encoding: 'utf8' });

        // Parse subst mappings:  "K:\: => F:\some\path"
        const substOut = execFileSync('subst', [], { encoding: 'utf8', shell: true });
        const substMap = {};
        for (const line of substOut.split('\n')) {
            const m = line.match(/^([A-Z]):\\:\s*=>\s*(.+)/i);
            if (m) substMap[m[1].toUpperCase()] = m[2].trim();
        }

        const DRIVE_TYPES = { '1':'NoRoot','2':'Removable','3':'Fixed','4':'Network','5':'Disc','6':'RAM' };

        const drives = [];
        for (const line of wmicOut.split('\n').slice(1)) {
            const parts = line.trim().split(/\s{2,}/);
            if (!parts[0]?.match(/^[A-Z]:$/i)) continue;
            const letter      = parts[0].replace(':','').toUpperCase();
            const driveType   = DRIVE_TYPES[parts[1]?.trim()] || 'Fixed';
            const providerName= parts[2]?.trim() || '';
            const volumeName  = parts[3]?.trim() || parts[2]?.trim() || '';
            const substTarget = substMap[letter] || null;

            // Naming logic:
            //   subst drives → descriptive from target path
            //   physical drives → volume label if available, else letter
            let displayName;
            if (substTarget) {
                const segs = substTarget.replace(/[/\\]+$/, '').split(/[/\\]/);
                displayName = segs[segs.length - 1] || letter;
            } else {
                displayName = volumeName || letter;
            }

            drives.push({
                letter,
                path:        letter + ':\\',
                displayName,
                driveType,
                volumeName:  volumeName || letter,
                substTarget,
                isSubst:     !!substTarget,
                isPhysical:  !substTarget && driveType === 'Fixed',
                provider:    providerName,
            });
        }
        return drives;
    } catch {
        // Fallback
        const fs = require('fs');
        const drives = [];
        for (let c = 65; c <= 90; c++) {
            const letter = String.fromCharCode(c);
            const p = letter + ':\\';
            try { fs.accessSync(p); drives.push({ letter, path: p, displayName: letter, driveType: 'Fixed', isPhysical: true, isSubst: false }); } catch {}
        }
        return drives;
    }
});

// ── IPC: list directory children via DM ──────────────────────────────────────
ipcMain.handle('helix:dm:children', (_evt, absPath) => {
    try {
        if (!_DM_PATH) _DM_PATH = _dep('HELIX_DM');
        const out = execFileSync(_JULIA, [_DM_PATH, 'children', absPath, '--json'],
            { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }).trim();
        const lines = out.split('\n').filter(l => !l.startsWith('[DM]')).join('\n');
        const nodes = JSON.parse(lines || '[]');
        return { ok: true, nodes };
    } catch (e) {
        // Fallback: read dir directly via fs
        try {
            const fs = require('fs');
            const entries = require('fs').readdirSync(absPath, { withFileTypes: true });
            return { ok: true, nodes: entries.map(e => ({ label: require('path').join(absPath, e.name), isDir: e.isDirectory() })) };
        } catch (e2) { return { ok: false, err: e2.message }; }
    }
});

// ── Lazy AccountManager singleton ─────────────────────────────────────────────
let _accountManager = null;
function getAccountManager() {
    if (_accountManager) return _accountManager;
    // Load via dep.jl key (avoids DM ambiguity — multiple AccountManager.js exist)
    const AccountManager = require(_dep('HELIX_ACCOUNT_MANAGER'));
    // Inject deps from HelixApp/node_modules so AccountManager (in cv/ tree) can find them
    _accountManager = new AccountManager({
        deps: {
            'better-sqlite3': require('better-sqlite3'),
            'bcryptjs':       require('bcryptjs'),
        },
    });
    return _accountManager;
}

// ── Oracle HTTP client — POST JSON, return parsed body ─────────────────────
function _oraclePost(route, body) {
    return new Promise((resolve, reject) => {
        const baseUrl = (() => {
            try { return _dep('HELIX_ORACLE_URL'); }
            catch { return 'http://144.24.42.219:3001'; }
        })();
        const url  = new URL(route, baseUrl);
        const data = JSON.stringify(body);
        const opts = {
            hostname: url.hostname,
            port:     parseInt(url.port || '80', 10),
            path:     url.pathname + (url.search || ''),
            method:   'POST',
            headers:  {
                'Content-Type':   'application/json',
                'Content-Length': Buffer.byteLength(data),
            },
            timeout: 8000,
        };
        const httpMod = require('http');
        const req = httpMod.request(opts, (res) => {
            let raw = '';
            res.on('data', c => raw += c);
            res.on('end', () => {
                try { resolve(JSON.parse(raw)); }
                catch (e) { reject(new Error(`Oracle response parse error: ${e.message}`)); }
            });
        });
        req.on('timeout', () => { req.destroy(); reject(new Error('Oracle request timed out after 8s')); });
        req.on('error', reject);
        req.write(data);
        req.end();
    });
}

// ── IPC: create account — Oracle-first, local vault as backup ────────────────
// Registration is always cloud-primary: Oracle stores the authoritative record,
// local SQLite is a backup vault so the app works offline after first login.
ipcMain.handle('helix:auth:create-account', async (_evt, { accountName, email, password, adPerLoad, adInterval }) => {
    // 1. Register on Oracle
    let cloudResult;
    try {
        cloudResult = await _oraclePost('/api/signup', {
            accountName, localPassword: password,
        });
    } catch (e) {
        return { ok: false, err: `Registration requires a cloud connection: ${e.message}` };
    }
    if (!cloudResult.ok) return { ok: false, err: cloudResult.err || 'Oracle signup failed' };

    // 2. Mirror into local vault backup
    try {
        const am = getAccountManager();
        if (!am._db) am.initialize();
        await am.storeVaultCopy({
            accountId:   cloudResult.accountId,
            accountName: cloudResult.accountName,
            accountType: 'user',
            localPassword: password,
            tier:        cloudResult.tier || 'Free',
            adPerLoad,
            adInterval,
        });
    } catch (e) {
        // Vault write failing is non-fatal — Oracle is authoritative
        console.warn('[HelixApp] local vault backup failed (non-fatal):', e.message);
    }

    // 3. Mirror cc/cv/vc schema to Oracle (vv stays local — separate entity vault)
    //    vc→vc bridge per io schema: local vc shr/o/v/vc/ → Oracle vc shr/i/v/vc/
    try {
        await _oraclePost('/api/account/schema', {
            accountId:   cloudResult.accountId,
            accountName: cloudResult.accountName,
        });
    } catch (e) {
        console.warn('[HelixApp] Oracle schema mirror failed (non-fatal):', e.message);
    }

    // 4. Set process env so rest of app session is immediately authenticated
    if (cloudResult.sessionId) {
        process.env.HELIX_SESSION = cloudResult.sessionId;
        process.env.HELIX_TIER    = cloudResult.tier || 'Free';
        process.env.HELIX_K4      = cloudResult.k4   || 'cv';
    }

    return { ok: true, ...cloudResult };
});

// ── IPC: login — Oracle-first, local vault fallback (offline mode) ────────────
ipcMain.handle('helix:auth:login', async (_evt, { accountName, password }) => {
    // 1. Try Oracle
    try {
        const result = await _oraclePost('/api/login', { account: accountName, password });
        if (!result.ok) throw new Error(result.err || 'Invalid account or password.');

        // Write local session file so helix:auth:session works across app restarts
        try {
            const am = getAccountManager();
            am._writeSessionFile({
                account:  accountName,
                token:    result.sessionId,
                tier:     result.tier || 'Free',
                k4:       result.k4   || '01',
                expires:  Date.now() + 86_400_000,
                loginAt:  new Date().toISOString(),
            });
        } catch {}

        process.env.HELIX_SESSION = result.sessionId || '';
        process.env.HELIX_TIER    = result.tier       || 'Free';
        process.env.HELIX_K4      = result.k4         || 'cv';
        return { ok: true, ...result };
    } catch (oracleErr) {
        // 2. Oracle unreachable — fall back to local vault
        console.warn('[HelixApp] Oracle unreachable, trying local vault:', oracleErr.message);
        try {
            const am = getAccountManager();
            if (!am._db) am.initialize();
            const result = await am.authenticate(accountName, password);
            process.env.HELIX_SESSION = result.sessionId;
            process.env.HELIX_TIER    = result.tier;
            process.env.HELIX_K4      = result.k4;
            return { ok: true, ...result, offline: true };
        } catch (localErr) {
            return { ok: false, err: localErr.message };
        }
    }
});

// ── IPC: logout ───────────────────────────────────────────────────────────────
ipcMain.handle('helix:auth:logout', (_evt) => {
    try {
        const result = getAccountManager().logout();
        process.env.HELIX_SESSION = 'none';
        process.env.HELIX_TIER    = 'free';
        process.env.HELIX_K4      = 'cc';
        return { ok: true, ...result };
    } catch (e) { return { ok: false, err: e.message }; }
});

// ── IPC: auth session check ───────────────────────────────────────────────────
ipcMain.handle('helix:auth:session', () => {
    try {
        // Check env session token first (set by AuthManager on login)
        if (process.env.HELIX_SESSION && process.env.HELIX_SESSION !== 'none') {
            return { authenticated: true, tier: process.env.HELIX_TIER || 'free', k4: process.env.HELIX_K4 || 'cc' };
        }
        // Check session file (~/.helix/session.json — OS-relative, no dep.jl needed)
        const sessionPath = require('path').join(require('os').homedir(), '.helix', 'session.json');
        const fs = require('fs');
        if (fs.existsSync(sessionPath)) {
            const raw = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
            if (raw?.token && raw?.expires > Date.now()) {
                // Re-derive k4 from tier — pair names only, never bit strings
                const tier = raw.tier || 'Free';
                const level = { Free:0,Lite:1,Regular:2,Pro:3,Suite:4,Enterprise:5,Owner:6 }[tier] ?? 0;
                const k4 = level >= 5 ? 'vv' : level >= 4 ? 'vc' : 'cv';
                return { authenticated: true, tier, k4, user: raw.user };
            }
        }
    } catch {}
    return { authenticated: false, tier: 'free', k4: 'cc' };
});

// ── IPC: DM grep (filename search) ───────────────────────────────────────────
ipcMain.handle('helix:dm:grep', (_evt, pattern) => {
    try {
        if (!_DM_PATH) _DM_PATH = _dep('HELIX_DM');
        const out = execFileSync(_JULIA, [_DM_PATH, 'grep', pattern],
            { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }).trim();
        const lines = out.split('\n').map(l => l.trim())
            .filter(l => l && !l.startsWith('[DM]') && !l.startsWith('grep '));
        return { ok: true, paths: lines };
    } catch (e) { return { ok: false, err: e.message }; }
});

// ── IPC: open file dialog ─────────────────────────────────────────────────────
ipcMain.handle('helix:open-file', async (_evt) => {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
        filters: [{ name: 'Helix Source', extensions: ['helix', 'hx', 'ghost', 'js', 'txt'] }],
        properties: ['openFile'],
    });
    if (canceled || !filePaths.length) return { ok: false };
    const fs = require('fs');
    return { ok: true, path: filePaths[0], content: fs.readFileSync(filePaths[0], 'utf8') };
});

// ── IPC: save file ────────────────────────────────────────────────────────────
ipcMain.handle('helix:save-file', async (_evt, { filePath, content }) => {
    try {
        const fs    = require('fs');
        const saveTo = filePath || (await dialog.showSaveDialog(mainWindow, {
            filters: [{ name: 'Helix Source', extensions: ['helix', 'hx'] }],
        })).filePath;
        if (!saveTo) return { ok: false };
        fs.writeFileSync(saveTo, content, 'utf8');
        return { ok: true, path: saveTo };
    } catch (e) { return { ok: false, err: e.message }; }
});

// ─────────────────────────────────────────────────────────────────────────────
let mainWindow;

function createWindow() {
    let ideHtml;
    try {
        ideHtml = _dmResolve('HelixIDE.html');
    } catch (e) {
        // DM unavailable — walk up from __dirname to find HelixIDE.html
        const fs = require('fs');
        const candidates = [
            path.join(__dirname, '..', '..', '..', 'f', 'f', 'free', 'HelixIDE', 'HelixIDE.html'),
            path.resolve('F:/helix/accounts/Enterprise/Owners/Personal/escamillajoseph44/Organizations/Company/helix/src/c/cc/f/f/free/HelixIDE/HelixIDE.html'),
        ];
        ideHtml = candidates.find(p => { try { fs.accessSync(p); return true; } catch { return false; } });
        if (!ideHtml) { console.error('[HelixApp] cannot find HelixIDE.html:', e.message); app.quit(); return; }
    }

    mainWindow = new BrowserWindow({
        width:  1440,
        height: 900,
        minWidth:  900,
        minHeight: 600,
        title: 'helix',
        backgroundColor: '#0d0d0d',
        webPreferences: {
            preload:          path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration:  false,
            sandbox:          false,
            webviewTag:       true,
        },
    });

    mainWindow.loadFile(ideHtml);
    mainWindow.setMenuBarVisibility(false);

    if (process.env.HELIX_DEV) {
        mainWindow.webContents.openDevTools({ mode: 'detach' });
    }

    mainWindow.on('closed', () => { mainWindow = null; });
}

// ── App lifecycle ─────────────────────────────────────────────────────────────
app.whenReady().then(() => {
    process.env.HELIX_DEP   = _DEP_JL;
    process.env.HELIX_JULIA = _JULIA;
    try { process.env.HELIX_DM = _DM_PATH || _dep('HELIX_DM'); } catch {}

    try {
        createWindow();
    } catch (e) {
        console.error('[HelixApp] createWindow failed:', e.message);
        // Show error in a minimal window rather than silently dying
        const win = new BrowserWindow({ width: 700, height: 300, title: 'helix — startup error' });
        win.loadURL(`data:text/html,<pre style="font:14px monospace;background:#0d0d0d;color:#ef5350;padding:20px">[HelixApp] startup error:\n${e.message}</pre>`);
    }
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
    if (!mainWindow) createWindow();
});
