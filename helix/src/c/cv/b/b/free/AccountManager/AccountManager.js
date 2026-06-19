'use strict';

// ─────────────────────────────────────────────────────────────────────────────
//  AccountManager.js — unified account, session, and auth manager
//  cv frame · b/b layer · free tier
//
//  Merged from:
//    _incoming/AccountManager/AccountManager.js  (session/credential helpers)
//    _incoming/AccountManager/AccountsManager.js (SQLite + cloud two-tier auth)
//
//  Rules:
//    - All paths resolved via dep.jl + DirectoryManager — no hardcodes
//    - All tier routing delegated to TierManager — never hardcode tier names
//    - Session written to ~/.helix/session.json (OS-relative)
//    - Cloud auth is scaffolded; pending PostgreSQL provisioning on OCI
//    - Uses better-sqlite3 (sync) + bcryptjs (pure JS) — no native rebuild needed
// ─────────────────────────────────────────────────────────────────────────────

const fs_sync = require('fs');
const fs      = require('fs').promises;
const path    = require('path');
const os      = require('os');
const { execFileSync } = require('child_process');

// ── dep.jl resolver ──────────────────────────────────────────────────────────
const _DEP_JL = process.env.HELIX_DEP || 'F:/helix/.helix/dep.jl';
const _JULIA  = process.env.HELIX_JULIA || (() => {
    const candidates = ['C:/Julia/bin/julia.exe', 'C:/Program Files/Julia/bin/julia.exe', 'julia'];
    return candidates.find(p => { try { fs_sync.accessSync(p); return true; } catch { return false; } }) || 'julia';
})();

const _depCache = {};
function _dep(key) {
    if (_depCache[key]) return _depCache[key];
    const v = execFileSync(_JULIA, [_DEP_JL, 'get', key], { encoding: 'utf8' }).trim();
    if (!v || v === 'not found') throw new Error(`[AccountManager] dep.jl missing key: ${key}`);
    _depCache[key] = v;
    return v;
}

let _DM_PATH;
function _dmResolve(name) {
    if (!_DM_PATH) _DM_PATH = _dep('HELIX_DM');
    const raw = execFileSync(_JULIA, [_DM_PATH, 'grep', name], { encoding: 'utf8' }).trim();
    const lines = raw.split('\n').map(l => l.trim())
        .filter(l => l && !l.startsWith('[DM]') && !l.startsWith('grep '));
    const match = lines.find(l => l.split(/[\\/]/).pop() === name) || lines[0];
    if (!match) throw new Error(`[AccountManager] DM could not resolve: ${name}`);
    return match;
}

// ── TierManager singleton (owner-only — loaded internally) ───────────────────
let _tierManager = null;
function _tm() {
    if (_tierManager) return _tierManager;
    const TierManager = require(_dmResolve('TierManager.js'));
    _tierManager = new TierManager();
    return _tierManager;
}

// ── Session + credential file paths (OS-relative) ────────────────────────────
const _HELIX_DIR    = path.join(os.homedir(), '.helix');
const _SESSION_FILE = path.join(_HELIX_DIR, 'session.json');
const _CREDS_FILE   = path.join(_HELIX_DIR, 'credentials.json');

function _ensureHelixDir() {
    if (!fs_sync.existsSync(_HELIX_DIR)) fs_sync.mkdirSync(_HELIX_DIR, { recursive: true });
}

// ── Klein-4 frame from tier level ────────────────────────────────────────────
// io_calculus.md canonical src schema: cc = guest (no account), cv = any
// authenticated account, vc = Pro+, vv = Suite/Enterprise.
// ALWAYS return pair names — never bit strings.
function _tierToK4(tier) {
    const level = _tm().getTierLevel(tier) ?? 0;
    if (level >= 5) return 'vv';
    if (level >= 4) return 'vc';
    return 'cv';   // all authenticated accounts ≥ cv; cc is guest only
}

// ─────────────────────────────────────────────────────────────────────────────
class AccountManager {
    constructor(options = {}) {
        this._options      = options;
        this._accountsRoot = null;
        this._accountsBase = null;
        this._db           = null;  // better-sqlite3 (synchronous)
    }

    // ── Lazy dep-resolved paths ──────────────────────────────────────────
    get accountsRoot() {
        if (!this._accountsRoot)
            this._accountsRoot = this._options.accountsRoot || _dep('HELIX_ACCOUNTS_ROOT');
        return this._accountsRoot;
    }

    get accountsBase() {
        if (!this._accountsBase)
            this._accountsBase = this._options.accountsBase || _dep('HELIX_ACCOUNTS_BASE');
        return this._accountsBase;
    }

    get localDbPath() {
        return path.join(this.accountsRoot, '.registry', 'accounts.db');
    }

    // Cloud config fully resolved at call time — host registered when OCI is up
    get cloudConfig() {
        return {
            host:     _dep('HELIX_OCI_PG_HOST'),
            port:     parseInt(_dep('HELIX_OCI_PG_PORT') || '5432', 10),
            database: _dep('HELIX_OCI_PG_DB'),
            ssl:      true,
        };
    }

    // ── Module resolution helpers ────────────────────────────────────────
    // Callers (e.g. Electron main.js) can inject deps via options to avoid
    // cross-tree require() failures. Falls back to local require for standalone use.
    _require(name) {
        if (this._options.deps && this._options.deps[name]) return this._options.deps[name];
        return require(name);
    }

    // ── Initialization ───────────────────────────────────────────────────
    initialize() {
        const registryPath = path.join(this.accountsRoot, '.registry');
        fs_sync.mkdirSync(registryPath, { recursive: true });
        const Database = this._require('better-sqlite3');
        this._db = new Database(this.localDbPath);
        this._db.pragma('journal_mode = WAL');
        this._createTables();
    }

    _createTables() {
        this._db.exec(`
            CREATE TABLE IF NOT EXISTS accounts (
                account_id    TEXT PRIMARY KEY,
                account_name  TEXT NOT NULL UNIQUE,
                account_type  TEXT CHECK(account_type IN ('user','organization','company')),
                password_hash TEXT NOT NULL,
                cloud_account_id TEXT,
                tier          TEXT DEFAULT 'Free',
                sync_enabled  INTEGER DEFAULT 0,
                sync_status   TEXT DEFAULT 'not_synced',
                ad_per_load   INTEGER DEFAULT 2,
                ad_interval   INTEGER DEFAULT 30,
                ad_earnings   REAL    DEFAULT 0.0,
                created_at    TEXT DEFAULT CURRENT_TIMESTAMP,
                updated_at    TEXT DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS sessions (
                session_id    TEXT PRIMARY KEY,
                account_id    TEXT NOT NULL,
                tier          TEXT DEFAULT 'Free',
                k4            TEXT DEFAULT 'cc',
                created_at    TEXT DEFAULT CURRENT_TIMESTAMP,
                expires_at    TEXT,
                last_activity TEXT DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (account_id) REFERENCES accounts(account_id)
            );
            CREATE TABLE IF NOT EXISTS permissions_cache (
                cache_id         INTEGER PRIMARY KEY AUTOINCREMENT,
                account_id       TEXT NOT NULL,
                permission_key   TEXT NOT NULL,
                permission_value TEXT,
                cached_at        TEXT DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (account_id) REFERENCES accounts(account_id)
            );
        `);
        this._migrateTables();
    }

    // CREATE TABLE IF NOT EXISTS does not retroactively add columns to a
    // table that already existed before this schema added them — an
    // existing accounts.db from before ad_per_load/ad_interval/ad_earnings
    // were added would otherwise break every signup. Real migration, not a
    // one-off delete-and-recreate.
    _migrateTables() {
        const existing = new Set(
            this._db.prepare(`PRAGMA table_info(accounts)`).all().map(c => c.name)
        );
        const wanted = {
            ad_per_load: 'INTEGER DEFAULT 2',
            ad_interval: 'INTEGER DEFAULT 30',
            ad_earnings: 'REAL DEFAULT 0.0',
        };
        for (const [col, def] of Object.entries(wanted)) {
            if (!existing.has(col)) {
                this._db.exec(`ALTER TABLE accounts ADD COLUMN ${col} ${def}`);
            }
        }
    }

    _ensureDb() {
        if (!this._db) this.initialize();
    }

    // ── Account creation ─────────────────────────────────────────────────
    async createAccount({ accountName, accountType, localPassword, cloudPassword, sync = false, tier, adPerLoad, adInterval }) {
        if (!accountName || !accountType || !localPassword)
            throw new Error('[AccountManager] createAccount: missing accountName, accountType, or localPassword');
        if (!['user', 'organization', 'company'].includes(accountType))
            throw new Error('[AccountManager] accountType must be "user", "organization", or "company" (company IS-A organization)');

        const resolvedTier = tier || 'Free';
        if (!_tm().isValidTier(resolvedTier))
            throw new Error(`[AccountManager] invalid tier: ${resolvedTier}`);

        const adFloor    = parseInt(_dep('HELIX_AD_FLOOR') || '2', 10);
        const intFloor   = parseInt(_dep('HELIX_AD_INTERVAL_FLOOR') || '15', 10);
        const resolvedAdPerLoad  = Math.max(adFloor,   parseInt(adPerLoad  || adFloor,   10));
        const resolvedAdInterval = Math.max(intFloor,  parseInt(adInterval || 30,         10));

        const bcrypt = this._require('bcryptjs');
        this._ensureDb();

        const accountId    = `${accountName.toLowerCase()}_${Date.now()}`;
        const passwordHash = await bcrypt.hash(localPassword, 12);

        await this._createAccountDirs(accountName);
        await this._writeProfile(accountName, {
            accountId, accountType, accountName,
            tier: resolvedTier, sync,
            adPerLoad: resolvedAdPerLoad, adInterval: resolvedAdInterval,
            createdAt: new Date().toISOString(),
        });

        this._db.prepare(`
            INSERT INTO accounts (account_id, account_name, account_type, password_hash, tier, sync_enabled, ad_per_load, ad_interval)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(accountId, accountName, accountType, passwordHash, resolvedTier, sync ? 1 : 0, resolvedAdPerLoad, resolvedAdInterval);

        if (sync && cloudPassword) {
            try { await this.registerCloudAccount(accountId, cloudPassword); }
            catch (e) { console.warn(`[AccountManager] cloud registration deferred: ${e.message}`); }
        }

        return { accountId, accountName, accountType, tier: resolvedTier, sync, created: true };
    }

    // ── Canonical src schema (io_calculus.md Part XVII) ─────────────────────
    // Each account gets all four Klein-4 frames. vv is local-only (vault) —
    // Oracle mirrors only cc/cv/vc via the vc→vc bridge per the io schema.
    // Ghost K2 phase per frame (K2=vc excluded — vc frame uses K2=vv):
    //   cc → K2=cc (phase 0, no encoding)
    //   cv → K2=cv (phase 1, ZWC)
    //   vc → K2=vv (phase 3, AES-GCM; K2=vc is a honeypot hot path)
    //   vv → K2=vv (phase 3, AES+BSD)
    // Canonical src schema compounds (io_calculus.md Part XVII)
    // b/ = backend tools: bb (error schema/AST), bf (error pages), bm (back packaging)
    // f/ = GUI side:      ff (components/layouts), fb (API/state layer), fm (front packaging)
    // m/ = orchestration: mm (assembly/entry), mf (controller/routing), mb (service layer)
    static get _SRC_COMPOUNDS() {
        return {
            b: ['b/b', 'b/f', 'b/m'],
            f: ['f/f', 'f/b', 'f/m'],
            m: ['m/m', 'm/f', 'm/b'],
        };
    }

    static get _SRC_COMPOUNDS_FLAT() {
        const c = AccountManager._SRC_COMPOUNDS;
        return [...c.b, ...c.f, ...c.m];
    }

    // shr i/o ports per frame — canonical io schema (io_calculus.md Part XVII)
    static get _SHR_PORTS() {
        return {
            cc: { i: [['c','cc'],['c','cv']],               o: [['c','cc'],['c','cv']]                        },
            cv: { i: [['c','cc'],['c','cv']],               o: [['c','cc'],['c','cv'],['v','vc']]             },
            vc: { i: [['c','cv'],['v','vc']],               o: [['v','vc'],['v','vv']]                        },
            vv: { i: [['v','vc'],['v','vv']],               o: [['v','vv']]                                   },
        };
    }

    // Ghost K2 phase descriptor written into each frame root as .schema.json
    static get _GHOST_K2() {
        return {
            cc: { k1: 'cc', k2: 'cc', phase: 0, encoding: 'none'   },
            cv: { k1: 'cv', k2: 'cv', phase: 1, encoding: 'zwc'    },
            vc: { k1: 'vc', k2: 'vv', phase: 3, encoding: 'aes'    },
            vv: { k1: 'vv', k2: 'vv', phase: 3, encoding: 'aes+bsd'},
        };
    }

    async _createFrameDirs(base, frame, parentLetter) {
        const frameRoot = path.join(base, parentLetter, frame, 'src');
        const ports     = AccountManager._SHR_PORTS[frame];

        const dirs = [
            ...AccountManager._SRC_COMPOUNDS_FLAT.map(c => path.join(frameRoot, c)),
            ...ports.i.map(([p, leaf]) => path.join(frameRoot, 'shr', 'i', p, leaf)),
            ...ports.o.map(([p, leaf]) => path.join(frameRoot, 'shr', 'o', p, leaf)),
        ];

        for (const d of dirs) {
            await fs.mkdir(d, { recursive: true });
            await fs.writeFile(path.join(d, '.gitkeep'), '');
        }

        // Ghost K2 phase marker in frame root (not inside src — frame-level metadata)
        const frameDir = path.join(base, parentLetter, frame);
        await fs.writeFile(
            path.join(frameDir, '.schema.json'),
            JSON.stringify(AccountManager._GHOST_K2[frame], null, 2)
        );
    }

    async _createAccountDirs(accountName, { skipVv = false } = {}) {
        const base = path.join(this.accountsRoot, accountName);
        await this._createFrameDirs(base, 'cc', 'c');
        await this._createFrameDirs(base, 'cv', 'c');
        await this._createFrameDirs(base, 'vc', 'v');
        if (!skipVv) await this._createFrameDirs(base, 'vv', 'v');
    }

    async _writeProfile(accountName, data) {
        const p = path.join(this.accountsRoot, accountName, 'profile.json');
        await fs.writeFile(p, JSON.stringify(data, null, 2));
    }

    // ── Authentication (local SQLite, bcryptjs) ──────────────────────────
    async authenticate(accountName, password) {
        this._ensureDb();
        const account = this._db.prepare('SELECT * FROM accounts WHERE account_name = ?').get(accountName);
        if (!account) throw new Error(`[AccountManager] account not found: ${accountName}`);

        const bcrypt = this._require('bcryptjs');
        if (!await bcrypt.compare(password, account.password_hash))
            throw new Error('[AccountManager] invalid password');

        const tier = account.tier || 'Free';
        if (!_tm().isValidTier(tier))
            throw new Error(`[AccountManager] account has unrecognized tier: ${tier}`);

        const sessionId = `sess_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
        const k4        = _tierToK4(tier);

        this._db.prepare(`
            INSERT INTO sessions (session_id, account_id, tier, k4, expires_at) VALUES (?, ?, ?, ?, ?)
        `).run(sessionId, account.account_id, tier, k4, expiresAt);

        this._writeSessionFile({
            account:  accountName,
            token:    sessionId,
            tier,
            k4,
            expires:  new Date(expiresAt).getTime(),
            loginAt:  new Date().toISOString(),
        });

        return {
            accountId:   account.account_id,
            accountName: account.account_name,
            accountType: account.account_type,
            tier,
            k4,
            sessionId,
            expiresAt,
            sync:        account.sync_enabled === 1,
            adPerLoad:   account.ad_per_load  ?? 2,
            adInterval:  account.ad_interval  ?? 30,
            adEarnings:  account.ad_earnings  ?? 0,
            adUserShare: parseInt(_dep('HELIX_AD_USER_SHARE') || '30', 10),
        };
    }

    // ── Session validation by ID (multi-user — for web servers) ──────────
    // authenticate() above is correct for single-user CLI (writes the one
    // shared ~/.helix/session.json), but a real web server has many
    // concurrent visitors and must validate sessions by the sessionId each
    // client holds (cookie/header), not a shared file. Reads the `sessions`
    // SQL table that authenticate() already populates — no schema change.
    validateSession(sessionId) {
        this._ensureDb();
        if (!sessionId) return null;

        const session = this._db.prepare(`
            SELECT s.session_id, s.account_id, s.tier, s.k4, s.expires_at,
                   a.account_name, a.account_type
            FROM sessions s JOIN accounts a ON a.account_id = s.account_id
            WHERE s.session_id = ?
        `).get(sessionId);

        if (!session) return null;
        if (new Date(session.expires_at).getTime() < Date.now()) return null;

        this._db.prepare(`UPDATE sessions SET last_activity = CURRENT_TIMESTAMP WHERE session_id = ?`)
            .run(sessionId);

        return {
            sessionId:   session.session_id,
            accountId:   session.account_id,
            accountName: session.account_name,
            accountType: session.account_type,
            tier:        session.tier,
            k4:          session.k4,
            expiresAt:   session.expires_at,
        };
    }

    // Actually revoke a session server-side — required for real logout.
    // Clearing the client's cookie alone does nothing if the sessionId
    // leaked (XSS, stolen token): it would still validate() successfully
    // until this is called.
    invalidateSession(sessionId) {
        this._ensureDb();
        if (!sessionId) return { ok: false, reason: 'no sessionId' };
        const result = this._db.prepare(`DELETE FROM sessions WHERE session_id = ?`).run(sessionId);
        return { ok: result.changes > 0 };
    }

    // ── Local vault backup — written AFTER Oracle registers the account ──────
    // Oracle is authoritative. This stores the cloud-registered account in the
    // local SQLite so the app can authenticate offline if Oracle is unreachable.
    // accountId must be the Oracle-assigned ID so both sides reference the same user.
    async storeVaultCopy({ accountId, accountName, accountType, tier, localPassword, adPerLoad, adInterval }) {
        if (!accountId || !accountName || !localPassword)
            throw new Error('[AccountManager] storeVaultCopy: missing accountId, accountName, or localPassword');

        const resolvedTier      = tier || 'Free';
        const resolvedAdPerLoad  = Math.max(2,  parseInt(adPerLoad  || 2,  10));
        const resolvedAdInterval = Math.max(15, parseInt(adInterval || 30, 10));

        const bcrypt = this._require('bcryptjs');
        this._ensureDb();

        const passwordHash = await bcrypt.hash(localPassword, 12);

        await this._createAccountDirs(accountName);
        await this._writeProfile(accountName, {
            accountId, accountType: accountType || 'user', accountName,
            tier: resolvedTier, sync: true, cloudAccountId: accountId,
            adPerLoad: resolvedAdPerLoad, adInterval: resolvedAdInterval,
            createdAt: new Date().toISOString(),
        });

        const existing = this._db.prepare('SELECT account_id FROM accounts WHERE account_name = ?').get(accountName);
        if (!existing) {
            this._db.prepare(`
                INSERT INTO accounts
                    (account_id, account_name, account_type, password_hash, cloud_account_id, tier, sync_enabled, ad_per_load, ad_interval)
                VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
            `).run(accountId, accountName, accountType || 'user', passwordHash, accountId,
                   resolvedTier, resolvedAdPerLoad, resolvedAdInterval);
        }
        return { ok: true };
    }

    // ── Cloud auth stubs (pending OCI PostgreSQL) ─────────────────────────
    async authenticateCloud(accountName) {
        throw new Error('[AccountManager] cloud auth pending — PostgreSQL provisioning required on OCI');
    }

    async registerCloudAccount(accountId) {
        throw new Error('[AccountManager] cloud registration pending — PostgreSQL provisioning required on OCI');
    }

    async syncToCloud(accountName) {
        this._ensureDb();
        const account = this._db.prepare('SELECT * FROM accounts WHERE account_name = ?').get(accountName);
        if (!account) throw new Error(`[AccountManager] account not found: ${accountName}`);
        if (account.sync_enabled !== 1) return { synced: false, reason: 'sync disabled' };
        throw new Error('[AccountManager] cloud sync pending — PostgreSQL provisioning required on OCI');
    }

    // ── Profile ──────────────────────────────────────────────────────────
    async getProfile(accountName) {
        const p = path.join(this.accountsRoot, accountName, 'profile.json');
        try { return JSON.parse(await fs.readFile(p, 'utf8')); }
        catch (e) { throw new Error(`[AccountManager] getProfile failed for ${accountName}: ${e.message}`); }
    }

    async updateProfile(accountName, updates) {
        const profile = await this.getProfile(accountName);
        const merged  = { ...profile, ...updates };
        await this._writeProfile(accountName, merged);
        if (merged.sync) console.log(`[AccountManager] queuing cloud sync for ${accountName}`);
    }

    // ── Account type helpers (IS-A: company → organization) ──────────────
    static isOrganization(accountType) {
        return accountType === 'organization' || accountType === 'company';
    }
    static isCompany(accountType) {
        return accountType === 'company';
    }
    static isUser(accountType) {
        return accountType === 'user';
    }

    // ── Tier gate helper ─────────────────────────────────────────────────
    meetsMinimumTier(userTier, requiredTier) {
        return _tm().meetsMinimumTier(userTier, requiredTier);
    }

    // ── Shell login helper (sets active working account, no password) ──────
    login(account) {
        if (!account) return { error: 'Usage: helix account login <account>' };
        const root = path.join(this.accountsBase, account);
        if (!fs_sync.existsSync(root)) return { error: `Account root not found: ${root}` };
        this._writeSessionFile({
            account, root,
            loginAt: new Date().toISOString(),
            tier: 'Free', k4: 'cc',
            expires: Date.now() + 24 * 60 * 60 * 1000,
            token: null,
        });
        return { ok: true, account, root };
    }

    whoami() {
        const s = this._readSessionFile();
        if (!s) return { error: 'Not logged in. Run: helix account login <account>' };
        return { account: s.account, root: s.root, tier: s.tier, k4: s.k4, loginAt: s.loginAt };
    }

    logout() {
        try { fs_sync.unlinkSync(_SESSION_FILE); } catch {}
        return { ok: true, message: 'Logged out' };
    }

    storeCredential(key, value) {
        if (!key || !value) return { error: 'Usage: helix account storeCredential <key> <value>' };
        const creds = this._readCreds();
        creds[key] = value;
        _ensureHelixDir();
        fs_sync.writeFileSync(_CREDS_FILE, JSON.stringify(creds, null, 2));
        return { ok: true, stored: key };
    }

    getCredential(key) {
        if (!key) return { error: 'Usage: helix account getCredential <key>' };
        const creds = this._readCreds();
        if (!(key in creds)) return { error: `Credential not found: ${key}` };
        return { key, value: creds[key] };
    }

    listCredentials() {
        return { keys: Object.keys(this._readCreds()) };
    }

    close() {
        if (this._db) { this._db.close(); this._db = null; }
    }

    // ── Private I/O ──────────────────────────────────────────────────────
    _writeSessionFile(data) {
        _ensureHelixDir();
        fs_sync.writeFileSync(_SESSION_FILE, JSON.stringify(data, null, 2));
    }

    _readSessionFile() {
        try { return JSON.parse(fs_sync.readFileSync(_SESSION_FILE, 'utf8')); }
        catch { return null; }
    }

    _readCreds() {
        try { return JSON.parse(fs_sync.readFileSync(_CREDS_FILE, 'utf8')); }
        catch { return {}; }
    }
}

// ── Singleton + functional exports (auto-cli.js compat) ─────────────────────
const _singleton = new AccountManager();

module.exports          = AccountManager;
module.exports.default  = AccountManager;
module.exports.instance = _singleton;

const _fn = (fn, schema) => { fn.schema = schema; return fn; };

module.exports.login = _fn(
    (account) => _singleton.login(account),
    { params: [{ name: 'account', positional: true, required: true, description: 'Account folder name' }],
      description: 'Set active account (shell navigation helper)' }
);
module.exports.whoami = _fn(
    () => _singleton.whoami(),
    { params: [], description: 'Show currently active account and tier' }
);
module.exports.logout = _fn(
    () => _singleton.logout(),
    { params: [], description: 'Clear the active Helix session' }
);
module.exports.storeCredential = _fn(
    (key, value) => _singleton.storeCredential(key, value),
    { params: [
        { name: 'key',   positional: true, required: true, description: 'Credential name' },
        { name: 'value', positional: true, required: true, description: 'Credential value' },
      ], description: 'Store a named credential in ~/.helix/credentials.json' }
);
module.exports.getCredential = _fn(
    (key) => _singleton.getCredential(key),
    { params: [{ name: 'key', positional: true, required: true, description: 'Credential name' }],
      description: 'Retrieve a stored credential' }
);
module.exports.listCredentials = _fn(
    () => _singleton.listCredentials(),
    { params: [], description: 'List all stored credential keys' }
);
