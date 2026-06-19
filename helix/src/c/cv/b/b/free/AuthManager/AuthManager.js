'use strict';

// ── dep.jl + DirectoryManager ─────────────────────────────────────────────
const _DEP_JL = process.env.HELIX_DEP  || 'F:/helix/.helix/dep.jl';
const _JULIA  = process.env.HELIX_JULIA || 'julia';
const { execFileSync } = require('child_process');

function _dep(key) {
    const v = execFileSync(_JULIA, [_DEP_JL, 'get', key], { encoding: 'utf8' }).trim();
    if (!v || v === 'not found') throw new Error(`[AuthManager] dep.jl missing: ${key}`);
    return v;
}
let _DM_PATH;
function _dmResolve(name) {
    if (!_DM_PATH) _DM_PATH = _dep('HELIX_DM');
    const raw = execFileSync(_JULIA, [_DM_PATH, 'grep', name], { encoding: 'utf8' }).trim();
    const lines = raw.split('\n').map(l => l.trim())
        .filter(l => l && !l.startsWith('[DM]') && !l.startsWith('grep '));
    const match = lines.find(l => l.split(/[\\/]/).pop() === name) || lines[0];
    if (!match) throw new Error(`[AuthManager] DM could not resolve: ${name}`);
    return match;
}

// ── SDK deps via DirectoryManager ─────────────────────────────────────────
const fs     = require('fs');
const crypto = require('crypto');
const https  = require('https');
const net    = require('net');

const HelixE2EEncryption     = require(_dmResolve('HelixE2EEncryption.js'));
const EmailDirectoryResolver = require(_dmResolve('EmailDirectoryResolver.js'));
const { getTierFromEmail, getCompanyFromEmail, getAccountType, getSessionScope }
                             = require(_dmResolve('TestUserAccounts.js'));

// ── Klein-4 frame constants ────────────────────────────────────────────────
const K4 = Object.freeze({ GUEST: '00', CONSUMER: '01', PRODUCER: '10', ADMIN: '11' });

// ── Network level detection (IPC / LAN / Cloud) ───────────────────────────
const NET_LEVEL = Object.freeze({ IPC: 1, LAN: 2, CLOUD: 3 });

function _detectNetLevel(ip) {
    if (!ip || ip === '127.0.0.1' || ip === '::1') return NET_LEVEL.IPC;
    if (/^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(ip)) return NET_LEVEL.LAN;
    return NET_LEVEL.CLOUD;
}

// ── Entity types (user vs organisation) ───────────────────────────────────
const ENTITY = Object.freeze({ USER: 'user', COMPANY: 'company', OWNER: 'owner' });

// ── Tier ordering for access checks ───────────────────────────────────────
const TIER_ORDER = { free: 0, lite: 1, plus: 2, pro: 3, suite: 4 };

// ─────────────────────────────────────────────────────────────────────────
//  AuthManager — canonical
//  cv frame · b/b layer · free tier
//  Merges: AuthenticationManager + AuthorizationManager +
//          ThreeLevelAuthManager + AuthManagerAdapter (v1+v2)
// ─────────────────────────────────────────────────────────────────────────
class AuthManager {
    constructor(context = null) {
        this._context     = context;   // VSCode ExtensionContext (optional)
        this._enc         = new HelixE2EEncryption();
        this._resolver    = new EmailDirectoryResolver();
        this._schema      = null;
        this._session     = null;
        this._sessionPath = _dep('HELIX_SESSION_PATH');

        // Oracle Cloud — all from dep.jl
        this._oci = {
            endpoint: process.env.ORACLE_CLOUD_ENDPOINT || _dep('HELIX_OCI_ENDPOINT'),
            region:   _dep('HELIX_OCI_REGION'),
            sshKey:   _dep('HELIX_SSH_KEY_A1'),
            enabled:  process.env.ORACLE_CLOUD_ENABLED === 'true',
        };

        // Per-network-level sessions (IPC / LAN / Cloud)
        this._sessions = { 1: new Map(), 2: new Map(), 3: new Map() };

        this._loadPersistedSession();
    }

    // ── Schema ────────────────────────────────────────────────────────
    loadEmailSchema() {
        this._schema = JSON.parse(fs.readFileSync(_dmResolve('EMAIL_SCHEMA.json'), 'utf8'));
        return this._schema;
    }

    // ── Klein-4 tier ──────────────────────────────────────────────────
    getK4(emailOrUsername) {
        return getTierFromEmail(emailOrUsername) || K4.GUEST;
    }

    getTierFromUsername(u) { return this.getK4(u); }

    getAuthMethodsForTier(tier) {
        const methods = ['local'];
        if (TIER_ORDER[tier] >= TIER_ORDER.lite)  methods.push('native');
        if (TIER_ORDER[tier] >= TIER_ORDER.plus)  methods.push('cloud');
        if (TIER_ORDER[tier] >= TIER_ORDER.pro)   methods.push('oracle');
        return methods;
    }

    // ── Primary authenticate entry (detects entity type + network level) ─
    async authenticate(credentials, clientIP) {
        const { username, email, password, rememberMe = false, isEncrypted = false } = credentials;
        const identity  = email || username;
        const netLevel  = _detectNetLevel(clientIP);
        const entityType = getAccountType ? getAccountType(identity) : ENTITY.USER;

        let result;
        switch (entityType) {
            case ENTITY.OWNER:   result = await this.authenticateOwner({ identity }, password);   break;
            case ENTITY.COMPANY: result = await this.authenticateCompany({ identity }, password); break;
            default:             result = await this.authenticateUser({}, identity, password);    break;
        }

        if (result.success) {
            result.session.netLevel  = netLevel;
            result.session.entityType = entityType;
            this._sessions[netLevel].set(result.session.id, result.session);
        }
        return result;
    }

    // ── Entity-type auth ──────────────────────────────────────────────
    async authenticateOwner(companyData, password) {
        return this._authEntity(ENTITY.OWNER, companyData, password);
    }

    async authenticateCompany(companyData, password) {
        return this._authEntity(ENTITY.COMPANY, companyData, password);
    }

    async authenticateUser(companyData, username, password) {
        return this._authEntity(ENTITY.USER, { identity: username, ...companyData }, password);
    }

    async _authEntity(entityType, data, password) {
        const identity = data.identity;
        const entry    = this._resolver.resolve(identity);
        if (!entry) return { success: false, reason: 'unknown_identity' };

        const hash  = crypto.createHash('sha256').update(password + entry.salt).digest('hex');
        const valid = crypto.timingSafeEqual(
            Buffer.from(hash, 'hex'),
            Buffer.from(entry.passwordHash, 'hex')
        );
        if (!valid) return { success: false, reason: 'invalid_password' };

        const k4      = this.getK4(identity);
        const token   = await this._enc.generateToken({ identity, k4, entityType });
        const session = this._createSession({ identity, k4, entityType, token, via: 'local' });
        return { success: true, session };
    }

    // ── Network-level sub-paths ───────────────────────────────────────
    async authenticateLocal(username, password)    { return this.authenticateUser({}, username, password); }
    async authenticateNative(username, password)   { return this.authenticateUser({}, username, password); }
    async authenticateCloud(username, password)    { return this.authenticateUser({}, username, password); }

    // ── Oracle Cloud auth ─────────────────────────────────────────────
    async authenticateOracle(ociToken) {
        if (!this._oci.enabled) return { success: false, reason: 'oracle_disabled' };
        if (!ociToken)          return { success: false, reason: 'missing_oci_token' };

        return new Promise((resolve) => {
            const payload = JSON.stringify({ token: ociToken, region: this._oci.region });
            const url     = new URL(`${this._oci.endpoint}/auth/verify`);
            const req     = https.request({
                hostname: url.hostname, port: 443, path: url.pathname, method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
            }, (res) => {
                let body = '';
                res.on('data', c => body += c);
                res.on('end', () => {
                    try {
                        const d = JSON.parse(body);
                        if (res.statusCode === 200 && d.email) {
                            const k4      = this.getK4(d.email);
                            const session = this._createSession({ identity: d.email, k4, entityType: ENTITY.USER, token: d.token, via: 'oracle' });
                            resolve({ success: true, session });
                        } else {
                            resolve({ success: false, reason: d.reason || 'oci_rejected' });
                        }
                    } catch { resolve({ success: false, reason: 'oci_parse_error' }); }
                });
            });
            req.on('error', e => resolve({ success: false, reason: e.message }));
            req.write(payload); req.end();
        });
    }

    // Kali — deprecated
    authenticateKali() { return { success: false, reason: 'deprecated' }; }

    // ── Layer / xpol access (Condition 4 — frame crossing) ───────────
    async authenticateLayerAccess(entity, requestedLayers, layerPassword) {
        const entry = this._resolver.resolve(entity.identity);
        if (!entry) return { success: false, reason: 'unknown_entity' };

        const hash  = crypto.createHash('sha256').update(layerPassword + entry.salt).digest('hex');
        const valid = crypto.timingSafeEqual(
            Buffer.from(hash, 'hex'),
            Buffer.from(entry.passwordHash, 'hex')
        );
        if (!valid) return { success: false, reason: 'invalid_layer_password' };

        const permitted = requestedLayers.filter(l => this._layerPermitted(entry.k4, l));
        return { success: true, authorizedLayers: permitted };
    }

    _layerPermitted(k4, layer) {
        const layerK4 = { cc: '00', cv: '01', vc: '10', vv: '11' };
        const required = parseInt(layerK4[layer] || '11', 2);
        const user     = parseInt(k4, 2);
        return user >= required;
    }

    getEntityPermissions(entity, authorizedLayers) {
        return {
            identity: entity.identity,
            k4:       entity.k4,
            layers:   authorizedLayers,
            canRead:  authorizedLayers,
            canWrite: authorizedLayers.filter(l => ['cc','cv'].includes(l)),
            canExec:  entity.k4 >= K4.PRODUCER ? authorizedLayers : [],
        };
    }

    // ── Authorization (tier-based feature access) ─────────────────────
    canAccessFeature(featureName) {
        const session = this.getCurrentSession();
        if (!session) return false;
        const required = this.getFeatureTier(featureName);
        return this.tierHasAccess(session.tier || 'free', required);
    }

    tierHasAccess(userTier, requiredTier) {
        return (TIER_ORDER[userTier] ?? -1) >= (TIER_ORDER[requiredTier] ?? 99);
    }

    getFeatureTier(featureName) {
        const map = {
            ghost_encoding: 'lite',
            aes_gcm:        'pro',
            bsd_ecc:        'suite',
            oracle_auth:    'plus',
            circuit_schema: 'free',
        };
        return map[featureName] || 'pro';
    }

    getTopologyAccess()          { return this._topologyAccess('full'); }
    getDataTopologyAccess()      { return this._topologyAccess('data'); }
    getExtensionTopologyAccess() { return this._topologyAccess('extension'); }
    getAvailableFeatures() {
        return Object.keys({ ghost_encoding: 1, aes_gcm: 1, bsd_ecc: 1, oracle_auth: 1, circuit_schema: 1 })
            .filter(f => this.canAccessFeature(f));
    }

    _topologyAccess(type) {
        const session = this.getCurrentSession();
        const k4      = session?.k4 || K4.GUEST;
        return { type, k4, frames: this._framesForK4(k4) };
    }

    _framesForK4(k4) {
        const all = ['cc', 'cv', 'vc', 'vv'];
        const idx = parseInt(k4, 2);
        return all.slice(0, idx + 1);
    }

    // ── E2E handshake ─────────────────────────────────────────────────
    async initiateE2EHandshake(clientId) {
        return this._enc.initiateHandshake(clientId);
    }

    async registerE2ESession(clientId, encryptedSessionKey) {
        return this._enc.registerSession(clientId, encryptedSessionKey);
    }

    // ── Session ───────────────────────────────────────────────────────
    _createSession(data) {
        this._session = {
            id:         crypto.randomUUID(),
            ...data,
            tier:       this._k4ToTier(data.k4),
            scope:      getSessionScope ? getSessionScope(data.identity) : 'free',
            created:    Date.now(),
            expires:    Date.now() + 8 * 60 * 60 * 1000,
        };
        this._persist();
        return this._session;
    }

    _k4ToTier(k4) {
        return { '00': 'free', '01': 'lite', '10': 'pro', '11': 'suite' }[k4] || 'free';
    }

    async createSession(sessionData)   { return this._createSession(sessionData); }
    getCurrentSession()                { return this._validSession(); }
    getSession()                       { return this._validSession(); }
    getCurrentUser()                   { return this._validSession()?.identity || null; }
    setCurrentUser(u)                  { if (this._session) this._session.identity = u; }

    async getStoredCredentials() {
        try { return JSON.parse(fs.readFileSync(this._sessionPath, 'utf8')); } catch { return null; }
    }

    logout() {
        this._session = null;
        Object.values(this._sessions).forEach(m => m.clear());
        try { fs.writeFileSync(this._sessionPath, JSON.stringify(null), 'utf8'); } catch {}
    }

    _validSession() {
        if (!this._session)                    return null;
        if (this._session.expires < Date.now()) { this.logout(); return null; }
        return this._session;
    }

    _persist() {
        try { fs.writeFileSync(this._sessionPath, JSON.stringify(this._session), 'utf8'); } catch {}
    }

    _loadPersistedSession() {
        try {
            const s = JSON.parse(fs.readFileSync(this._sessionPath, 'utf8'));
            if (s?.expires > Date.now()) this._session = s;
        } catch {}
    }

    // ── Local registration ────────────────────────────────────────────
    async registerLocal(username, password) {
        const salt = crypto.randomBytes(16).toString('hex');
        const hash = crypto.createHash('sha256').update(password + salt).digest('hex');
        return { username, salt, passwordHash: hash, createdAt: new Date().toISOString() };
    }

    hashPassword(password) {
        const salt = crypto.randomBytes(16).toString('hex');
        return { hash: crypto.createHash('sha256').update(password + salt).digest('hex'), salt };
    }

    getUser(identity) {
        const entry = this._resolver.resolve(identity);
        if (!entry) return null;
        return { identity: entry.identity || identity, tier: entry.tier, createdAt: entry.createdAt };
    }

    getDefaultPermissions(tier) {
        const base = { read: ['cc'], write: [], exec: [] };
        if (TIER_ORDER[tier] >= TIER_ORDER.lite)  { base.read.push('cv');  base.write.push('cc'); }
        if (TIER_ORDER[tier] >= TIER_ORDER.pro)   { base.read.push('vc');  base.write.push('cv'); base.exec.push('cc','cv'); }
        if (TIER_ORDER[tier] >= TIER_ORDER.suite) { base.read.push('vv');  base.write.push('vc'); base.exec.push('vc'); }
        return base;
    }

    // ── Stats ─────────────────────────────────────────────────────────
    getStats() {
        return {
            activeSession:    !!this._validSession(),
            level1Sessions:   this._sessions[1].size,
            level2Sessions:   this._sessions[2].size,
            level3Sessions:   this._sessions[3].size,
        };
    }

    // ── E2E passthrough ───────────────────────────────────────────────
    async encrypt(data) { return this._enc.encrypt(data); }
    async decrypt(data) { return this._enc.decrypt(data); }

    // ── Webview (VSCode sidepanel + web host) ─────────────────────────
    getWebviewContent() {
        return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <title>Helix — Sign in</title>
  <style>
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
    :root{--bg:#0a0a0a;--sf:#111;--bd:#222;--fg:#f0f0f0;--mu:#666;--ac:#f5c518;--er:#e05252;--r:6px}
    body{background:var(--bg);color:var(--fg);font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:1rem}
    .card{background:var(--sf);border:1px solid var(--bd);border-radius:var(--r);padding:2rem;width:100%;max-width:360px}
    .logo{font-size:1.2rem;font-weight:800;color:var(--ac);letter-spacing:-.03em;margin-bottom:1.5rem}
    .field{margin-bottom:1rem}
    .field label{display:block;font-size:.8rem;color:var(--mu);margin-bottom:.35rem}
    .field input{width:100%;background:var(--bg);border:1px solid var(--bd);border-radius:var(--r);color:var(--fg);padding:.55rem .75rem;font-size:.9rem;outline:none;transition:border-color .15s}
    .field input:focus{border-color:var(--ac)}
    .btn{width:100%;margin-top:.5rem;padding:.65rem;background:var(--ac);color:#000;border:none;border-radius:var(--r);font-size:.95rem;font-weight:700;cursor:pointer;transition:opacity .15s}
    .btn:hover{opacity:.85}
    .divider{display:flex;align-items:center;gap:.75rem;margin:1rem 0;color:var(--mu);font-size:.75rem}
    .divider::before,.divider::after{content:'';flex:1;height:1px;background:var(--bd)}
    .ghost-btn{width:100%;padding:.6rem;background:transparent;color:var(--fg);border:1px solid var(--bd);border-radius:var(--r);font-size:.9rem;cursor:pointer;transition:border-color .15s,color .15s}
    .ghost-btn:hover{border-color:var(--ac);color:var(--ac)}
    .err{display:none;margin-top:.75rem;padding:.5rem .75rem;background:rgba(224,82,82,.1);border:1px solid var(--er);border-radius:var(--r);font-size:.8rem;color:var(--er)}
    .foot{margin-top:1.25rem;font-size:.78rem;color:var(--mu);text-align:center}
    .foot a{color:var(--ac);text-decoration:none}
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">Helix</div>
    <form id="form" autocomplete="on">
      <div class="field"><label>Email</label><input id="email" type="email" placeholder="you@example.com" required autocomplete="username"/></div>
      <div class="field"><label>Password</label><input id="pw" type="password" placeholder="••••••••" required autocomplete="current-password"/></div>
      <button class="btn" type="submit">Sign in</button>
    </form>
    <div class="divider">or</div>
    <button class="ghost-btn" id="oci-btn" type="button">Sign in with Oracle Cloud</button>
    <div class="err" id="err"></div>
    <p class="foot">No account? <a href="/account/signup">Sign up</a></p>
  </div>
  <script>
    const vsc = (typeof acquireVsCodeApi!=='undefined') ? acquireVsCodeApi() : null;
    const ERRORS = {missing_credentials:'Email and password are required.',unknown_identity:'No account found.',unknown_email:'No account found.',invalid_password:'Incorrect password.',oracle_disabled:'Oracle Cloud auth not enabled.',oci_rejected:'Oracle Cloud rejected the request.'};
    function post(msg){
      if(vsc){ vsc.postMessage(msg); }
      else fetch('/api/auth/'+msg.type,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(msg)}).then(r=>r.json()).then(handle).catch(e=>err(e.message));
    }
    function err(m){const el=document.getElementById('err');el.textContent=m;el.style.display='block';}
    function handle(d){if(d.success){document.getElementById('err').style.display='none';if(!vsc)window.location.href='/account';}else{err(ERRORS[d.reason]||d.reason||'Authentication failed.');}}
    document.getElementById('form').addEventListener('submit',e=>{e.preventDefault();post({type:'local',email:document.getElementById('email').value.trim(),password:document.getElementById('pw').value});});
    document.getElementById('oci-btn').addEventListener('click',()=>post({type:'oracle'}));
    if(vsc)window.addEventListener('message',ev=>handle(ev.data));
  </script>
</body>
</html>`;
    }

    resolveWebviewView(webviewView) {
        webviewView.webview.options = { enableScripts: true };
        webviewView.webview.html    = this.getWebviewContent();
        webviewView.webview.onDidReceiveMessage(async (msg) => {
            let result;
            if (msg.type === 'local') result = await this.authenticate({ email: msg.email, password: msg.password }, '127.0.0.1');
            else                      result = { success: false, reason: 'oci_flow_pending' };
            webviewView.webview.postMessage(result);
        });
    }

    // ── VSCode registration ───────────────────────────────────────────
    static register(context) {
        const vscode = require('vscode');
        const mgr    = new AuthManager(context);
        return vscode.window.registerWebviewViewProvider('helix.authPanel', mgr);
    }
}

module.exports = AuthManager;
