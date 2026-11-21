// ============================================================================
// D1 SETTINGS + MAINTENANCE (cached 15s per isolate so media requests stay fast)
// ============================================================================
// Separate site and app maintenance keys fall back to the legacy global flag.

// D1 settings store. Self-heals: creates the table if the schema was never
// applied, adds missing columns from older deployments, removes duplicate keys
// and falls back to UPDATE/INSERT when an UPSERT is not possible. The last
// error is kept so the admin panel can show what actually went wrong.
let __dbReady = false;
let __dbError = '';
function dbErrText(e) { return String((e && (e.cause && e.cause.message || e.message)) || e || 'unknown error').replace(/\s+/g, ' ').slice(0, 220); }

async function ensureSettingsSchema(env, force = false) {
    if (!env || !env.DB) { __dbError = 'This Worker has no D1 binding named "DB". Add it under Settings > Bindings (or deploy with wrangler.toml).'; return false; }
    if (__dbReady && !force) return true;
    try {
        await env.DB.prepare('CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL UNIQUE, value TEXT, updated_at TEXT DEFAULT CURRENT_TIMESTAMP)').run();
        const info = await env.DB.prepare('PRAGMA table_info(settings)').all();
        const cols = ((info && info.results) || []).map(r => String(r.name || '').toLowerCase());
        if (!cols.includes('key')) throw new Error('settings table exists but has no "key" column');
        if (!cols.includes('value')) await env.DB.prepare('ALTER TABLE settings ADD COLUMN value TEXT').run();
        if (!cols.includes('updated_at')) await env.DB.prepare('ALTER TABLE settings ADD COLUMN updated_at TEXT').run();
        try {
            await env.DB.prepare('DELETE FROM settings WHERE rowid NOT IN (SELECT MAX(rowid) FROM settings GROUP BY key)').run();
            await env.DB.prepare('CREATE UNIQUE INDEX IF NOT EXISTS idx_settings_key_unique ON settings(key)').run();
        } catch (_) { /* UPDATE/INSERT path below still works without the index */ }
        __dbReady = true;
        __dbError = '';
        return true;
    } catch (e) {
        __dbError = 'Schema check failed: ' + dbErrText(e);
        return false;
    }
}

async function dbGetSetting(env, key, fallback) {
    try {
        if (!env || !env.DB) return fallback;
        await ensureSettingsSchema(env);
        const row = await env.DB.prepare('SELECT value FROM settings WHERE key = ? ORDER BY rowid DESC LIMIT 1').bind(key).first();
        return row && row.value !== null && row.value !== undefined ? row.value : fallback;
    } catch (_) {
        return fallback;
    }
}

async function dbSetSetting(env, key, value) {
    if (!(await ensureSettingsSchema(env))) return false;
    const v = String(value);
    try {
        await env.DB.prepare(
            'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ' +
            'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP'
        ).bind(key, v).run();
        __dbError = '';
        return true;
    } catch (e1) {
        try {
            const up = await env.DB.prepare('UPDATE settings SET value = ?, updated_at = CURRENT_TIMESTAMP WHERE key = ?').bind(v, key).run();
            const changed = up && up.meta ? Number(up.meta.changes || 0) : 0;
            if (!changed) await env.DB.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').bind(key, v).run();
            __dbError = '';
            return true;
        } catch (e2) {
            __dbError = 'Write failed: ' + dbErrText(e2) + ' (first try: ' + dbErrText(e1) + ')';
            __dbReady = false;
            return false;
        }
    }
}

async function dbHealth(env) {
    const out = { binding: !!(env && env.DB), table: false, write: false, error: '' };
    if (!out.binding) { out.error = 'No D1 binding named "DB".'; return out; }
    out.table = await ensureSettingsSchema(env, true);
    if (out.table) out.write = await dbSetSetting(env, 'last_healthcheck', new Date().toISOString());
    out.error = __dbError;
    return out;
}

async function maintenanceFlag(env, key) {
    // Read the current D1 value on each request: changes made in another
    // Worker isolate must not remain hidden behind a local cache. If the
    // setting cannot be read, fail closed instead of accidentally opening it.
    if (!(await ensureSettingsSchema(env))) return true;
    try {
        const query = 'SELECT value FROM settings WHERE key = ? ORDER BY rowid DESC LIMIT 1';
        const row = await env.DB.prepare(query).bind(key).first();
        if (row && row.value != null) return row.value !== 'off';
        const legacy = await env.DB.prepare(query).bind('maintenance_mode').first();
        return !!(legacy && legacy.value != null && legacy.value !== 'off');
    } catch (e) { __dbError = 'Maintenance read failed: ' + dbErrText(e); return true; }
}
async function isSiteMaintenanceOn(env) { return maintenanceFlag(env, 'site_maintenance_mode'); }
async function isAppMaintenanceOn(env) { return maintenanceFlag(env, 'app_maintenance_mode'); }
async function setSiteMaintenance(env, on) { return dbSetSetting(env, 'site_maintenance_mode', on ? 'on' : 'off'); }
async function setAppMaintenance(env, on) { return dbSetSetting(env, 'app_maintenance_mode', on ? 'on' : 'off'); }
// Backward-compatible global operation. Owner-only at the API boundary.
async function setMaintenance(env, on) {
    // Keep the legacy all-services operation atomic: a failed write must not
    // leave the two services in different states.
    if (!(await ensureSettingsSchema(env)) || typeof env.DB.batch !== 'function') return false;
    const sql = 'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ' +
        'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP';
    try {
        const value = on ? 'on' : 'off';
        await env.DB.batch(['site_maintenance_mode', 'app_maintenance_mode', 'maintenance_mode'].map(key => env.DB.prepare(sql).bind(key, value)));
        return true;
    } catch (e) { __dbError = 'Maintenance update failed: ' + dbErrText(e); return false; }
}

// Backend URL can be overridden from the authenticated admin panel. HTTP and
// HTTPS are both accepted, with optional ports and public IPv4/IPv6 addresses.
// A URL without a scheme (e.g. 203.0.113.10:8000) is treated as http://.
// Localhost, private networks, metadata hosts, and credentials stay blocked.
let __backend = { at: 0, url: '' };
function normalizeBackendUrl(raw) {
    let text = String(raw == null ? '' : raw).trim();
    if (!text) return '';
    if (text.length > 240) return null;
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = 'http://' + text;
    try {
        const u = new URL(text);
        if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.username || u.password) return null;
        const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
        const isIPv4 = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host);
        const validIPv4 = isIPv4 && host.split('.').every(n => Number(n) <= 255);
        const isIPv6 = host.includes(':');
        const labels = host.split('.');
        const validDns = !isIPv4 && !isIPv6 && labels.length >= 2 && labels.every(x => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(x));
        if (!(validDns || validIPv4 || isIPv6) || isPrivateHost(host)) return null;
        u.search = '';
        u.hash = '';
        u.pathname = u.pathname.replace(/\/+$/, '');
        return u.origin + (u.pathname === '/' ? '' : u.pathname);
    } catch (_) { return null; }
}

// Cloudflare Workers refuse fetch() to raw IP addresses (error 1003, HTTP 403).
// For an IPv4 backend, fetch through a wildcard-DNS name that resolves to the
// same IP (203.0.113.10 -> 203.0.113.10.sslip.io). The port and http/https are
// kept. Set BACKEND_IP_RESOLVER to nip.io, another wildcard domain, or "off".
let BACKEND_IP_RESOLVER = 'sslip.io';
function fetchableBackendUrl(url) {
    const text = String(url || '');
    const resolver = String(BACKEND_IP_RESOLVER || '').trim().replace(/^\.+|\.+$/g, '').toLowerCase();
    if (!text || !resolver || resolver === 'off') return text;
    try {
        const u = new URL(text);
        if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(u.hostname)) return text;
        u.hostname = u.hostname + '.' + resolver;
        return u.origin + (u.pathname === '/' ? '' : u.pathname.replace(/\/+$/, ''));
    } catch (_) { return text; }
}

async function getBackendUrl(env, fresh = false) {
    if (!fresh && __backend.url && Date.now() - __backend.at < 20000) return __backend.url;
    const base = BACKEND_URL_BASE || DEFAULTS.RAILWAY_URL;
    const saved = await dbGetSetting(env, 'backend_url', '');
    const selected = normalizeBackendUrl(saved) || normalizeBackendUrl(base) || DEFAULTS.RAILWAY_URL;
    __backend = { at: Date.now(), url: selected };
    RAILWAY_URL = fetchableBackendUrl(selected);
    return selected;
}

async function saveBackendUrl(env, raw) {
    const value = String(raw == null ? '' : raw).trim();
    const normalized = normalizeBackendUrl(value);
    if (value && !normalized) return { ok: false, error: 'Use a valid public HTTP or HTTPS backend URL, for example https://api.example.com or http://203.0.113.10:8000. Local and private network addresses are not allowed.' };
    const ok = await dbSetSetting(env, 'backend_url', normalized || '');
    if (!ok) return { ok: false, error: 'Could not save Backend URL. ' + (__dbError || 'D1 write error.') };
    const active = normalized || BACKEND_URL_BASE || DEFAULTS.RAILWAY_URL;
    RAILWAY_URL = fetchableBackendUrl(active);
    __backend = { at: Date.now(), url: active };
    return { ok: true, url: active, reset: !normalized };
}

// Telegram credentials are editable only by the owner. Panel-managed tokens
// are encrypted with a key derived from STREAM_SIGN_SECRET before going into D1.
let __telegramConfig = { at: 0, token: '', tokenSource: 'Not configured', encryptedOverride: false, webhookOrigin: '' };

async function telegramTokenCryptoKey() {
    const material = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('vexostream-telegram-token:' + STREAM_SIGN_SECRET));
    return crypto.subtle.importKey('raw', material, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

async function encryptTelegramToken(token) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await telegramTokenCryptoKey();
    const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(token));
    return 'v1:' + bytesToHex(iv) + ':' + bytesToHex(new Uint8Array(encrypted));
}

async function decryptTelegramToken(value) {
    const parts = String(value || '').split(':');
    if (parts.length !== 3 || parts[0] !== 'v1') return '';
    try {
        const key = await telegramTokenCryptoKey();
        const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: hexToBytes(parts[1]) }, key, hexToBytes(parts[2]));
        return new TextDecoder().decode(plain);
    } catch (_) { return ''; }
}

function normalizeTelegramWebhookOrigin(raw) {
    const text = String(raw == null ? '' : raw).trim();
    if (!text) return '';
    if (text.length > 240) return null;
    try {
        const url = new URL(text);
        if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
            (url.pathname !== '/' && url.pathname !== '/webhook') || isPrivateHost(url.hostname)) return null;
        return url.origin;
    } catch (_) { return null; }
}

async function resolveTelegramSettings(env, requestOrigin = '', fresh = false) {
    if (fresh || Date.now() - __telegramConfig.at >= 10000) {
        const encrypted = await dbGetSetting(env, 'telegram_bot_token_enc', '');
        const overrideToken = await decryptTelegramToken(encrypted);
        const webhookOrigin = await dbGetSetting(env, 'telegram_webhook_origin', '');
        const workerToken = TELEGRAM_WORKER_TOKEN || DEFAULTS.TELEGRAM_BOT_TOKEN;
        const token = overrideToken || workerToken;
        __telegramConfig = {
            at: Date.now(),
            token,
            tokenSource: overrideToken ? 'Owner panel' : (encrypted ? 'Stored token needs re-entry' : (workerToken ? 'Worker secret' : 'Not configured')),
            encryptedOverride: !!encrypted,
            webhookOrigin: normalizeTelegramWebhookOrigin(webhookOrigin) || ''
        };
    }
    TELEGRAM_BOT_TOKEN = __telegramConfig.token;
    TELEGRAM_API = 'https://api.telegram.org/bot' + TELEGRAM_BOT_TOKEN;
    const origin = __telegramConfig.webhookOrigin || normalizeTelegramWebhookOrigin(requestOrigin) || String(requestOrigin || '').replace(/\/+$/, '');
    return {
        token: __telegramConfig.token,
        tokenSource: __telegramConfig.tokenSource,
        tokenConfigured: !!__telegramConfig.token,
        encryptedOverride: __telegramConfig.encryptedOverride,
        configuredWebhookOrigin: __telegramConfig.webhookOrigin,
        webhookOrigin: origin,
        webhookUrl: origin ? origin.replace(/\/+$/, '') + '/webhook' : ''
    };
}

async function getTelegramAdminSettings(env, requestOrigin, fresh = false) {
    const settings = await resolveTelegramSettings(env, requestOrigin, fresh);
    return {
        tokenSource: settings.tokenSource,
        tokenConfigured: settings.tokenConfigured,
        encryptedOverride: settings.encryptedOverride,
        webhookOrigin: settings.configuredWebhookOrigin,
        webhookUrl: settings.webhookUrl
    };
}

async function saveTelegramSettings(env, tokenInput, webhookOriginInput) {
    const token = String(tokenInput == null ? '' : tokenInput).trim();
    const webhookOrigin = normalizeTelegramWebhookOrigin(webhookOriginInput);
    if (token && (token.length > 256 || !/^\d{5,20}:[A-Za-z0-9_-]{20,160}$/.test(token))) {
        return { ok: false, error: 'That does not look like a Telegram bot token. Paste the full token from BotFather.' };
    }
    if (webhookOrigin === null) {
        return { ok: false, error: 'Use a public HTTPS origin, such as https://example.com. The app adds /webhook automatically.' };
    }
    if (!(await ensureSettingsSchema(env))) {
        return { ok: false, error: 'Could not save Telegram settings. ' + (__dbError || 'D1 is unavailable.') };
    }
    const statements = [];
    if (token) {
        try {
            const encrypted = await encryptTelegramToken(token);
            statements.push(env.DB.prepare(
                'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ' +
                'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP'
            ).bind('telegram_bot_token_enc', encrypted));
        } catch (_) {
            return { ok: false, error: 'Could not encrypt the bot token. Check that STREAM_SIGN_SECRET is configured.' };
        }
    }
    statements.push(env.DB.prepare(
        'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ' +
        'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP'
    ).bind('telegram_webhook_origin', webhookOrigin));
    try {
        await env.DB.batch(statements);
        __dbError = '';
        __dbReady = true;
        __telegramConfig.at = 0;
        await resolveTelegramSettings(env, '', true);
        return { ok: true };
    } catch (e) {
        __dbError = 'Write failed: ' + dbErrText(e);
        __dbReady = false;
        return { ok: false, error: 'Could not save Telegram settings. ' + __dbError };
    }
}

async function resetTelegramTokenOverride(env) {
    const ok = await dbSetSetting(env, 'telegram_bot_token_enc', '');
    if (!ok) return { ok: false, error: 'Could not reset the token. ' + (__dbError || 'D1 write error.') };
    __telegramConfig.at = 0;
    await resolveTelegramSettings(env, '', true);
    return { ok: true };
}

// ============================================================================
// PROVIDER MANAGEMENT
// live   = listed, searchable, links play
// hidden = removed from public listings, search, playback, and bot
// locked = listed but unavailable, with locked pages for direct links
// Stored as JSON in settings.provider_config, cached 15 s per isolate.
// ============================================================================
const PROVIDER_CONFIG_DEFAULT = {
    modes: {},
    order: PROVIDERS.map(p => p.id),
    defaultProvider: 'pornhub',
    defaultQuery: 'Brazzers',
    lockMessage: 'This provider is currently unavailable. Try another one.'
};
let __prov = { at: 0, cfg: null };

function normalizeProviderConfig(raw) {
    const ids = PROVIDERS.map(p => p.id);
    const src = raw && typeof raw === 'object' ? raw : {};
    const modes = {};
    for (const id of ids) {
        const m = src.modes && src.modes[id];
        modes[id] = PROVIDER_MODES.includes(m) ? m : 'live';
    }
    const order = (Array.isArray(src.order) ? src.order : []).filter((id, i, a) => ids.includes(id) && a.indexOf(id) === i);
    for (const id of ids) if (!order.includes(id)) order.push(id);
    const clean = (v, max, fb) => { const t = String(v == null ? '' : v).replace(/[-\u001f]/g, ' ').trim().slice(0, max); return t || fb; };
    return {
        modes,
        order,
        defaultProvider: ids.includes(src.defaultProvider) ? src.defaultProvider : PROVIDER_CONFIG_DEFAULT.defaultProvider,
        defaultQuery: clean(src.defaultQuery, 100, PROVIDER_CONFIG_DEFAULT.defaultQuery),
        lockMessage: clean(src.lockMessage, 200, PROVIDER_CONFIG_DEFAULT.lockMessage)
    };
}

async function getProviderConfig(env, fresh = false) {
    if (!fresh && __prov.cfg && Date.now() - __prov.at < 15000) return __prov.cfg;
    let raw = null;
    try { raw = JSON.parse(await dbGetSetting(env, 'provider_config', 'null')); } catch (_) {}
    const cfg = normalizeProviderConfig(raw);
    __prov = { at: Date.now(), cfg };
    return cfg;
}

async function saveProviderConfig(env, cfg) {
    const clean = normalizeProviderConfig(cfg);
    const ok = await dbSetSetting(env, 'provider_config', JSON.stringify(clean));
    if (ok) __prov = { at: Date.now(), cfg: clean };
    return ok;
}


const DEFAULT_SEARCH_NAMES = [
    "Abella Danger",
    "Angela White",
    "Mia Malkova",
    "Riley Reid",
    "Lana Rhoades",
    "Eva Elfie",
    "Adriana Chechik",
    "Brandi Love",
    "Mia Khalifa",
    "Cory Chase",
    "Kendra Lust",
    "Sweetie Fox",
    "Alexis Texas",
    "Lisa Ann",
    "Dani Daniels",
    "Asa Akira",
    "Luna Star",
    "Alexis Fawx",
    "Lauren Phillips",
    "Sasha Grey",
    "Sunny Leone",
    "Rae Lil Black",
    "Gina Valentina",
    "Nicole Kitt",
    "Skylar Vox",
    "Autumn Falls",
    "Gabbie Carter",
    "Blake Blossom",
    "Gianna Michaels",
    "Cherie DeVille",
    "Eliza Ibarra",
    "Jia Lissa",
    "Emily Willis",
    "Lena Paul",
    "Madison Ivy",
    "Natasha Nice",
    "Nicole Aniston",
    "Veronica Rodriguez",
    "Sara Jay",
    "Ava Addams",
    "Valentina Nappi",
    "Kelsi Monroe",
    "Little Caprice",
    "Liya Silver",
    "Comatozze",
    "Hazel Moore",
    "Leah Gotti",
    "Elena Koshka",
    "Anissa Kate",
    "Eva Lovia",
    "Darcie Dolce",
    "Kenzie Reeves",
    "Elsa Jean",
    "Violet Myers",
    "Alina Lopez",
    "Sky Bri",
    "Jane Wilde",
    "Aidra Fox",
    "Karlee Grey",
    "Kendra Spade",
    "Rachael Cavalli",
    "Janice Griffith",
    "Tori Black",
    "Remy LaCroix",
    "Naomi Swann",
    "Kayley Gunner",
    "Melody Marks",
    "Stacy Cruz",
    "Sybil A",
    "Nancy Ace",
    "Agatha Vega",
    "Bonnie Rotten",
    "Skin Diamond",
    "Mia Melano",
    "Keisha Grey",
    "Peta Jensen",
    "Kendra Sunderland",
    "August Ames",
    "Haley Reed",
    "Savannah Bond",
    "Kiara Cole",
    "Kyler Quinn",
    "Luna Okko",
    "Christy Mack",
    "Hitomi Tanaka",
    "Anri Okita",
    "Eimi Fukada",
    "Yua Mikami",
    "Ai Uehara",
    "Julia Ann",
    "Phoenix Marie",
    "Bridgette B",
    "Nikki Benz",
    "Sophie Dee",
    "Kagney Linn Karter",
    "Esperanza Gomez",
    "Rebel Lynn",
    "Ariella Ferrera",
    "Romi Rain",
    "Stoya"
];
const DEFAULT_SEARCH_UNITS = ['minutes', 'hours', 'days'];
const DEFAULT_SEARCH_UNIT_MS = { minutes: 60000, hours: 3600000, days: 86400000 };
const DEFAULT_SEARCH_DEFAULT_ANCHOR = Date.UTC(2026, 0, 1, 0, 0, 0);
let __ds = { at: 0, cfg: null };

function parseDefaultSearchNames(input) {
    const rawList = Array.isArray(input)
        ? input
        : String(input || '').split(/\r?\n|,/);
    const out = [];
    const seen = new Set();
    for (const item of rawList) {
        const clean = String(item == null ? '' : item).replace(/[-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);
        if (!clean) continue;
        const key = clean.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(clean);
        if (out.length >= 500) break;
    }
    return out;
}

function normalizeDefaultSearchConfig(raw) {
    const src = raw && typeof raw === 'object' ? raw : {};
    const hasNames = Array.isArray(src.names) || typeof src.names === 'string';
    const parsedNames = hasNames ? parseDefaultSearchNames(src.names) : DEFAULT_SEARCH_NAMES.slice();
    const names = parsedNames.length ? parsedNames : DEFAULT_SEARCH_NAMES.slice();
    const enabled = src.enabled === undefined ? true : !!src.enabled;
    const rawVal = parseInt(String(src.intervalValue ?? 1), 10);
    const intervalValue = Number.isFinite(rawVal) ? Math.max(1, Math.min(10000, rawVal)) : 1;
    const rawUnit = String(src.intervalUnit || 'days').trim().toLowerCase();
    const intervalUnit = DEFAULT_SEARCH_UNITS.includes(rawUnit) ? rawUnit : 'days';
    const rawIdx = parseInt(String(src.currentIndex ?? 0), 10);
    const currentIndex = names.length ? (((Number.isFinite(rawIdx) ? rawIdx : 0) % names.length) + names.length) % names.length : 0;
    const rawStarted = Number(src.startedAt || 0);
    const startedAt = Number.isFinite(rawStarted) && rawStarted > 0 ? rawStarted : DEFAULT_SEARCH_DEFAULT_ANCHOR;
    return { enabled, names, intervalValue, intervalUnit, currentIndex, startedAt };
}

async function getDefaultSearchConfig(env, fresh = false) {
    if (!fresh && __ds.cfg && Date.now() - __ds.at < 15000) return __ds.cfg;
    let raw = null;
    try { raw = JSON.parse(await dbGetSetting(env, 'default_search_config', 'null')); } catch (_) {}
    const cfg = normalizeDefaultSearchConfig(raw);
    __ds = { at: Date.now(), cfg };
    return cfg;
}

async function saveDefaultSearchConfig(env, cfg) {
    const clean = normalizeDefaultSearchConfig(cfg);
    const ok = await dbSetSetting(env, 'default_search_config', JSON.stringify(clean));
    if (ok) __ds = { at: Date.now(), cfg: clean };
    return ok;
}

function resolveDefaultSearchStatus(dsCfg, now = Date.now()) {
    const cfg = normalizeDefaultSearchConfig(dsCfg);
    const total = cfg.names.length;
    const unitMs = DEFAULT_SEARCH_UNIT_MS[cfg.intervalUnit] || 86400000;
    const intervalMs = cfg.intervalValue * unitMs;
    if (!total) {
        return { enabled: cfg.enabled, activeQuery: 'trending', activeIndex: 0, total: 0, nextQuery: 'trending', nextIndex: 0, intervalMs, nextChangeAt: now + intervalMs, remainingMs: intervalMs };
    }
    const elapsed = Math.max(0, now - cfg.startedAt);
    const steps = cfg.enabled ? Math.floor(elapsed / intervalMs) : 0;
    const activeIndex = (cfg.currentIndex + steps) % total;
    const nextIndex = (activeIndex + 1) % total;
    const nextChangeAt = cfg.enabled ? (cfg.startedAt + (steps + 1) * intervalMs) : 0;
    const remainingMs = cfg.enabled ? Math.max(0, nextChangeAt - now) : 0;
    return {
        enabled: cfg.enabled,
        activeQuery: cfg.names[activeIndex],
        activeIndex,
        total,
        nextQuery: cfg.names[nextIndex],
        nextIndex,
        intervalMs,
        nextChangeAt,
        remainingMs
    };
}

async function resolveActiveDefaultQuery(env, providerCfg = null, fresh = false) {
    if (!fresh && __ds.cfg) {
        if (__ds.cfg.enabled && __ds.cfg.names.length) return resolveDefaultSearchStatus(__ds.cfg).activeQuery;
        return (providerCfg && providerCfg.defaultQuery) || 'trending';
    }
    const rawText = await dbGetSetting(env, 'default_search_config', '');
    if (!rawText) {
        return (providerCfg && providerCfg.defaultQuery) || 'trending';
    }
    const ds = await getDefaultSearchConfig(env, fresh);
    if (ds.enabled && ds.names.length) return resolveDefaultSearchStatus(ds).activeQuery;
    return (providerCfg && providerCfg.defaultQuery) || 'trending';
}

function formatDurationShort(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (d > 0) return d + 'd ' + h + 'h';
    if (h > 0) return h + 'h ' + m + 'm';
    return Math.max(1, m) + 'm';
}


const NOTICE_TONES = ['info', 'success', 'warning', 'urgent'];
const NOTICE_ICONS = ['campaign', 'info', 'sparkles', 'check', 'warning', 'shield'];
const NOTICE_AUDIENCES = ['all', 'in', 'out'];
const NOTICE_CONFIG_DEFAULT = { items: [] };
let __notice = { at: 0, cfg: null };

function cleanNoticeUrl(raw) {
    const u = String(raw == null ? '' : raw).replace(/[\u0000-\u001f]/g, '').trim().slice(0, 240);
    if (!u) return '';
    if (u.startsWith('/') && !u.startsWith('//')) return u;
    try {
        const parsed = new URL(u);
        if (parsed.protocol === 'https:' || parsed.protocol === 'http:') return parsed.toString();
    } catch (_) {}
    return '';
}

function normalizeNoticeItem(raw, fallbackId = '') {
    const src = raw && typeof raw === 'object' ? raw : {};
    const clean = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
    const id = clean(src.id || fallbackId || ('n_' + Math.random().toString(36).slice(2, 10)), 40);
    const toneRaw = String(src.tone || 'info').trim().toLowerCase();
    const tone = NOTICE_TONES.includes(toneRaw) ? toneRaw : 'info';
    const iconRaw = String(src.icon || 'campaign').trim().toLowerCase();
    const icon = NOTICE_ICONS.includes(iconRaw) ? iconRaw : 'campaign';
    const audRaw = String(src.audience || 'all').trim().toLowerCase();
    const audience = NOTICE_AUDIENCES.includes(audRaw) ? audRaw : 'all';
    const title = clean(src.title, 100);
    const message = clean(src.message, 400);
    const linkText = clean(src.linkText, 40);
    const linkUrl = cleanNoticeUrl(src.linkUrl);
    const enabled = !!src.enabled && (!!title || !!message);
    const dismissible = src.dismissible === undefined ? true : !!src.dismissible;
    const updatedAt = Number.isFinite(Number(src.updatedAt)) && Number(src.updatedAt) > 0 ? Number(src.updatedAt) : 1;
    return { id, enabled, title, message, tone, icon, audience, linkText, linkUrl, dismissible, updatedAt };
}

function normalizeNoticeConfig(raw) {
    const src = raw && typeof raw === 'object' ? raw : {};
    let rawItems = [];
    if (Array.isArray(src.items)) {
        rawItems = src.items;
    } else if (src.title || src.message) {
        rawItems = [src];
    }
    const items = [];
    const seen = new Set();
    for (const entry of rawItems) {
        const item = normalizeNoticeItem(entry);
        if (!item.title && !item.message) continue;
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        items.push(item);
        if (items.length >= 20) break;
    }
    return { items };
}

async function getNoticeConfig(env, fresh = false) {
    if (!fresh && __notice.cfg && Date.now() - __notice.at < 15000) return __notice.cfg;
    let raw = null;
    try { raw = JSON.parse(await dbGetSetting(env, 'notice_config', 'null')); } catch (_) {}
    const cfg = normalizeNoticeConfig(raw);
    __notice = { at: Date.now(), cfg };
    return cfg;
}

async function saveNoticeConfig(env, cfg) {
    const clean = normalizeNoticeConfig(cfg);
    const ok = await dbSetSetting(env, 'notice_config', JSON.stringify(clean));
    if (ok) __notice = { at: Date.now(), cfg: clean };
    return ok;
}

function publicNoticesOf(cfg) {
    return normalizeNoticeConfig(cfg).items.filter(n => n.enabled && (n.title || n.message));
}

function publicNoticeOf(cfg) {
    const list = publicNoticesOf(cfg);
    return list.length ? list[0] : null;
}


// ============================================================================
// SITE SUSPENSION NOTICE (Owner-only by default, grantable via site_suspend)
// ============================================================================
const SITE_SUSPEND_PRESETS = {
    platform: {
        label: 'Platform Administration',
        issuer: 'VexoStream Administration',
        title: 'This website has been suspended.',
        message: 'Public access to this domain is currently suspended by platform administration pending review.',
        statusCode: 503
    },
    hosting: {
        label: 'Hosting Provider',
        issuer: 'Hosting Infrastructure Provider',
        title: 'Service temporarily suspended.',
        message: 'This website has been suspended by its hosting provider due to an active service or account review.',
        statusCode: 503
    },
    legal: {
        label: 'Legal & Compliance',
        issuer: 'Legal & Compliance Department',
        title: 'Unavailable for legal or compliance reasons.',
        message: 'Access to this website has been restricted pursuant to an active compliance or regulatory review.',
        statusCode: 451
    },
    dmca: {
        label: 'Copyright / DMCA',
        issuer: 'Copyright & DMCA Compliance Desk',
        title: 'Access restricted due to a copyright notice.',
        message: 'Public access to this website is suspended while a copyright or DMCA takedown notice is being processed.',
        statusCode: 451
    },
    network: {
        label: 'Network Operator',
        issuer: 'Edge Network Operations',
        title: 'Domain routing suspended.',
        message: 'Traffic to this domain has been suspended at the edge network layer until further notice.',
        statusCode: 503
    },
    custom: {
        label: 'Custom Notice',
        issuer: 'Site Administrator',
        title: 'This website has been suspended.',
        message: 'Public access to this website is currently suspended. Please contact the administrator for more information.',
        statusCode: 503
    }
};

let __siteSuspend: { at: number; cfg: any } = { at: 0, cfg: null };

function normalizeSiteSuspensionConfig(raw) {
    const o = raw && typeof raw === 'object' ? raw : {};
    const category = Object.prototype.hasOwnProperty.call(SITE_SUSPEND_PRESETS, o.category) ? String(o.category) : 'platform';
    const preset = SITE_SUSPEND_PRESETS[category];
    const cleanStr = (v, max) => String(v == null ? '' : v).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').trim().slice(0, max);
    const contactUrlRaw = cleanStr(o.contactUrl, 240);
    const contactUrl = /^(https?:\/\/|mailto:|\/[a-zA-Z0-9_\-/?=&%#.]+$)/i.test(contactUrlRaw) ? contactUrlRaw : '';
    const statusCode = Number(o.statusCode) === 451 ? 451 : 503;
    return {
        enabled: !!o.enabled,
        applyToApp: !!o.applyToApp,
        category,
        issuer: cleanStr(o.issuer, 120) || preset.issuer,
        title: cleanStr(o.title, 160) || preset.title,
        message: cleanStr(o.message, 800) || preset.message,
        referenceId: cleanStr(o.referenceId, 64),
        contactUrl,
        contactLabel: cleanStr(o.contactLabel, 48) || 'Contact support',
        statusCode,
        updatedAt: Number(o.updatedAt) > 0 ? Number(o.updatedAt) : 0
    };
}

async function getSiteSuspensionConfig(env, fresh = false) {
    if (!fresh && __siteSuspend.cfg && Date.now() - __siteSuspend.at < 15000) return __siteSuspend.cfg;
    let raw = null;
    try { raw = JSON.parse(await dbGetSetting(env, 'site_suspension_config', 'null')); } catch (_) {}
    const cfg = normalizeSiteSuspensionConfig(raw);
    __siteSuspend = { at: Date.now(), cfg };
    return cfg;
}

async function saveSiteSuspensionConfig(env, cfg) {
    const clean = normalizeSiteSuspensionConfig({ ...cfg, updatedAt: Date.now() });
    const ok = await dbSetSetting(env, 'site_suspension_config', JSON.stringify(clean));
    if (ok) __siteSuspend = { at: Date.now(), cfg: clean };
    return ok;
}

function providerList(cfg) {
    return cfg.order.map(id => PROVIDERS.find(p => p.id === id)).filter(Boolean).map(p => ({ ...p, mode: cfg.modes[p.id] || 'live' }));
}
function browseProviders(cfg) { return providerList(cfg).filter(p => p.mode === 'live'); }
function listedProviders(cfg) { return providerList(cfg).filter(p => p.mode !== 'hidden'); }
function playableProviders(cfg) { return providerList(cfg).filter(p => p.mode === 'live'); }
function defaultProviderOf(cfg) {
    const live = browseProviders(cfg);
    if (live.some(p => p.id === cfg.defaultProvider)) return cfg.defaultProvider;
    return live.length ? live[0].id : '';
}
function providerForUrl(target) {
    let host = '';
    try { host = new URL(target).hostname.toLowerCase(); } catch (_) { return /^[a-z0-9]{8,24}$/i.test(String(target || '')) ? 'pornhub' : ''; }
    const hit = PROVIDERS.find(p => host === p.domain || host.endsWith('.' + p.domain));
    return hit ? hit.id : '';
}
// Construct VexoStream's own /embed route only for supported provider pages.
// Never use an embed URL or host supplied by catalog data.
function vexoEmbedUrlForVideo(target) {
    let u;
    try { u = new URL(String(target || '')); } catch (_) { return ''; }
    if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.username || u.password || u.port) return '';
    const provider = providerForUrl(u.toString());
    const validPage = provider === 'pornhub'
        ? u.pathname === '/view_video.php' && /^[A-Za-z0-9_-]{6,32}$/.test(u.searchParams.get('viewkey') || '')
        : provider === 'xvideos'
            ? /^\/video\.?[A-Za-z0-9]{6,32}(?:\/|$)/.test(u.pathname)
            : provider === 'xnxx'
                ? /^\/video-[A-Za-z0-9]{6,32}(?:\/|$)/.test(u.pathname)
                : provider === 'youporn'
                    ? /^\/watch\/\d{4,15}(?:\/[^/]*)?\/?$/.test(u.pathname)
                    : provider === 'redtube'
                        ? /^\/(?:video\/)?\d{4,12}(?:\/[^/]*)?\/?$/.test(u.pathname)
                        : false;
    return validPage ? 'https://vexostream.bond/embed/' + b64urlEncode(u.toString()) : '';
}
function providerName(id) { const p = PROVIDERS.find(x => x.id === id); return p ? p.name : id; }
function isProviderLocked(cfg, id) { return !!id && cfg.modes[id] === 'locked'; }
function isProviderHidden(cfg, id) { return !!id && cfg.modes[id] === 'hidden'; }
function hiddenJson(id) { return jsonResponse({ status: 'error', error: 'Not found' }, 404, { 'Cache-Control': 'no-store' }); }
function lockedJson(cfg, id) {
    return jsonResponse({ status: 'error', error: cfg.lockMessage, provider: id, locked: true }, 423, { 'Cache-Control': 'no-store' });
}

// ============================================================================
// LIVE VIEWERS (owner only)
// The header + home page show "N watching now". The owner picks the source:
//   real      = visitors with a heartbeat in the last 90 s (D1 live_presence)
//   simulated = a smooth, deterministic curve between Online min and max.
//               Every second some visitors join (Joins/s range) and some
//               leave (Leaves/s range); the curve follows a daily rhythm and
//               every edge instance computes the same number for each second.
// Stored as JSON in settings.live_config.
// ============================================================================
const LIVE_LIMITS = { online: 100000000, rate: 1000000 };
const LIVE_CONFIG_DEFAULT = { enabled: false, mode: 'simulated', min: 1000000, max: 9000000, joinMin: 7000, joinMax: 13000, leaveMin: 7000, leaveMax: 13000, seed: 1 };
const LIVE_PRESENCE_WINDOW = 90;
const LIVE_SERIES_SECONDS = 40;
let __liveCfg = { at: 0, cfg: null };
let __liveSim = null;
let __liveReal = { at: 0, n: 0 };
let __livePresenceReady = false;
const __liveSeen = new Map();

function liveInt(v, fb, lo, hi) {
    const n = Math.round(Number(String(v == null ? '' : v).replace(/[,\s_]/g, '')));
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fb;
}

function normalizeLiveConfig(raw) {
    const s = raw && typeof raw === 'object' ? raw : {};
    const d = LIVE_CONFIG_DEFAULT;
    const pair = (a, b, fa, fb, hi) => {
        let x = liveInt(a, fa, 0, hi), y = liveInt(b, fb, 0, hi);
        if (x > y) { const t = x; x = y; y = t; }
        return [x, y];
    };
    const [min, max] = pair(s.min, s.max, d.min, d.max, LIVE_LIMITS.online);
    const [joinMin, joinMax] = pair(s.joinMin, s.joinMax, d.joinMin, d.joinMax, LIVE_LIMITS.rate);
    const [leaveMin, leaveMax] = pair(s.leaveMin, s.leaveMax, d.leaveMin, d.leaveMax, LIVE_LIMITS.rate);
    return { enabled: s.enabled === true, mode: s.mode === 'real' ? 'real' : 'simulated', min, max, joinMin, joinMax, leaveMin, leaveMax, seed: liveInt(s.seed, 1, 1, 2147483646) };
}

async function getLiveConfig(env, fresh = false) {
    if (!fresh && __liveCfg.cfg && Date.now() - __liveCfg.at < 10000) return __liveCfg.cfg;
    let raw = null;
    try { raw = JSON.parse(await dbGetSetting(env, 'live_config', 'null')); } catch (_) {}
    const cfg = normalizeLiveConfig(raw);
    __liveCfg = { at: Date.now(), cfg };
    return cfg;
}

async function saveLiveConfig(env, next) {
    const cfg = normalizeLiveConfig(next);
    const ok = await dbSetSetting(env, 'live_config', JSON.stringify(cfg));
    if (ok) { __liveCfg = { at: Date.now(), cfg }; __liveSim = null; }
    return ok;
}

// Validates the owner form. Returns { ok, cfg } or { ok: false, error }.
function parseLiveForm(form, current) {
    const read = (k) => {
        const raw = String(form.get(k) == null ? '' : form.get(k)).replace(/[,\s_]/g, '');
        return /^\d{1,9}$/.test(raw) ? Number(raw) : NaN;
    };
    const v = {
        min: read('online_min'), max: read('online_max'),
        joinMin: read('join_min'), joinMax: read('join_max'),
        leaveMin: read('leave_min'), leaveMax: read('leave_max')
    };
    if (Object.values(v).some(n => !Number.isFinite(n))) return { ok: false, error: 'Enter a whole number in every live viewer field.' };
    if (v.max > LIVE_LIMITS.online) return { ok: false, error: 'Online max can be at most ' + LIVE_LIMITS.online.toLocaleString('en-US') + '.' };
    if (v.joinMax > LIVE_LIMITS.rate || v.leaveMax > LIVE_LIMITS.rate) return { ok: false, error: 'Joins and leaves per second can be at most ' + LIVE_LIMITS.rate.toLocaleString('en-US') + '.' };
    if (v.min > v.max) return { ok: false, error: 'Online min must be less than or equal to Online max.' };
    if (v.joinMin > v.joinMax) return { ok: false, error: 'Joins per second: min must be less than or equal to max.' };
    if (v.leaveMin > v.leaveMax) return { ok: false, error: 'Leaves per second: min must be less than or equal to max.' };
    const rangeChanged = v.min !== current.min || v.max !== current.max;
    const seed = rangeChanged ? 1 + Math.floor(Math.random() * 2147483000) : current.seed;
    return {
        ok: true,
        cfg: { ...v, enabled: String(form.get('enabled') || '') === 'on', mode: String(form.get('mode') || '') === 'real' ? 'real' : 'simulated', seed }
    };
}

// Deterministic 0..1 value for (seed, a, b), identical on every edge instance.
function liveRand(seed, a, b) {
    let h = Math.imul(seed ^ 0x2545f491, 0x9e3779b1) ^ Math.imul(a | 0, 0x85ebca77) ^ Math.imul((b | 0) + 0x632be5ab, 0xc2b2ae3d);
    h ^= h >>> 16; h = Math.imul(h, 0x7feb352d);
    h ^= h >>> 15; h = Math.imul(h, 0x846ca68b);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
}

// Smooth deterministic curve through random knots (Catmull-Rom), -1..1-ish.
function liveCurve(seed, x, salt) {
    const i = Math.floor(x), f = x - i;
    const k = (n) => liveRand(seed, n, salt) * 2 - 1;
    const p0 = k(i - 1), p1 = k(i), p2 = k(i + 1), p3 = k(i + 2);
    return 0.5 * ((2 * p1) + (-p0 + p2) * f + (2 * p0 - 5 * p1 + 4 * p2 - p3) * f * f + (-p0 + 3 * p1 - 3 * p2 + p3) * f * f * f);
}

// Hourly anchor (0..1): daily rhythm with the peak around 19:00 UTC
// (22:30 Tehran) plus a different random lift for every hour.
function liveAnchorP(cfg, hour) {
    const hod = ((hour % 24) + 24) % 24;
    const p = 0.5 + 0.3 * Math.sin((hod - 13) / 24 * Math.PI * 2) + (liveRand(cfg.seed, hour, 7) - 0.5) * 0.22;
    return Math.min(0.92, Math.max(0.08, p));
}

// Where the audience "wants" to be at second s: the smooth daily curve plus
// slow swells (about 15 min) and shorter waves (about 4 min).
function liveTarget(cfg, s) {
    const span = cfg.max - cfg.min;
    const h = s / 3600, h0 = Math.floor(h), f = h - h0;
    const a0 = liveAnchorP(cfg, h0 - 1), a1 = liveAnchorP(cfg, h0), a2 = liveAnchorP(cfg, h0 + 1), a3 = liveAnchorP(cfg, h0 + 2);
    const base = 0.5 * ((2 * a1) + (-a0 + a2) * f + (2 * a0 - 5 * a1 + 4 * a2 - a3) * f * f + (-a0 + 3 * a1 - 3 * a2 + a3) * f * f * f);
    const swell = 0.035 * liveCurve(cfg.seed, s / 900, 21) + 0.012 * liveCurve(cfg.seed, s / 240, 22);
    const v = cfg.min + span * (base + swell);
    return Math.min(cfg.max - span * 0.005, Math.max(cfg.min + span * 0.005, v));
}

// Starts two minutes before the hour so every edge instance lands on the same
// number for the same second.
function liveFreshState(cfg, t) {
    const sec = Math.floor(t / 3600) * 3600 - 120;
    return { sec, v: liveTarget(cfg, sec), joins: 0, leaves: 0 };
}

// One simulated second. Joins and leaves stay inside their own ranges; both
// rise and fall together in short bursts (busy moments), while their
// difference follows the target curve with a little random jitter.
function liveStep(cfg, st) {
    const s = st.sec;
    const now = liveTarget(cfg, s), next = liveTarget(cfg, s + 1);
    const want = (next - now) + (next - st.v) * 0.08;
    const jMid = (cfg.joinMin + cfg.joinMax) / 2, jHalf = (cfg.joinMax - cfg.joinMin) / 2;
    const lMid = (cfg.leaveMin + cfg.leaveMax) / 2, lHalf = (cfg.leaveMax - cfg.leaveMin) / 2;
    const burst = Math.max(-1, Math.min(1, liveCurve(cfg.seed, s / 40, 31)));
    let joins = jMid + jHalf * (0.55 * burst + 0.45 * (liveRand(cfg.seed, s, 1) * 2 - 1));
    let leaves = lMid + lHalf * (0.55 * burst + 0.45 * (liveRand(cfg.seed, s, 2) * 2 - 1));
    const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, Math.round(x)));
    joins = clamp(joins, cfg.joinMin, cfg.joinMax);
    leaves = clamp(leaves, cfg.leaveMin, cfg.leaveMax);
    const delta = want - (jMid - lMid);
    const j0 = joins, l0 = leaves;
    joins = clamp(joins + delta / 2, cfg.joinMin, cfg.joinMax);
    leaves = clamp(leaves + (joins - j0) - delta, cfg.leaveMin, cfg.leaveMax);
    const left = delta - ((joins - j0) - (leaves - l0));
    joins = clamp(joins + left, cfg.joinMin, cfg.joinMax);
    st.v = Math.min(cfg.max, Math.max(cfg.min, st.v + joins - leaves));
    st.joins = joins;
    st.leaves = leaves;
    st.sec++;
}

function liveCfgKey(cfg) { return [cfg.seed, cfg.min, cfg.max, cfg.joinMin, cfg.joinMax, cfg.leaveMin, cfg.leaveMax].join(':'); }

function liveSimulatedAt(cfg, t) {
    const key = liveCfgKey(cfg);
    let st = __liveSim && __liveSim.key === key ? __liveSim.st : null;
    if (!st || st.sec > t || t - st.sec > 7200) st = liveFreshState(cfg, t);
    while (st.sec < t) liveStep(cfg, st);
    __liveSim = { key, st };
    return st;
}

function liveSeries(cfg, t) {
    const st = liveSimulatedAt(cfg, t);
    const copy = { ...st };
    const values = [];
    for (let i = 0; i < LIVE_SERIES_SECONDS; i++) {
        values.push(Math.round(copy.v));
        liveStep(cfg, copy);
    }
    return { values, joins: st.joins, leaves: st.leaves };
}

// --------------------------------------------------------------------------- real visitors
async function ensureLivePresenceSchema(env) {
    if (!env || !env.DB) return false;
    if (__livePresenceReady) return true;
    try {
        await env.DB.prepare('CREATE TABLE IF NOT EXISTS live_presence (sid TEXT PRIMARY KEY, last_seen INTEGER NOT NULL)').run();
        await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_live_presence_last_seen ON live_presence(last_seen)').run();
        __livePresenceReady = true;
        return true;
    } catch (e) {
        __dbError = 'Live presence table: ' + dbErrText(e);
        return false;
    }
}

async function touchLivePresence(env, sid, ctx) {
    if (!/^[a-z0-9]{16,40}$/.test(sid)) return;
    const now = Math.floor(Date.now() / 1000);
    if (now - (__liveSeen.get(sid) || 0) < 20) return;
    __liveSeen.set(sid, now);
    if (__liveSeen.size > 50000) for (const [k, v] of __liveSeen) if (now - v > LIVE_PRESENCE_WINDOW) __liveSeen.delete(k);
    const job = (async () => {
        if (!(await ensureLivePresenceSchema(env))) return;
        await env.DB.prepare('INSERT INTO live_presence (sid, last_seen) VALUES (?, ?) ON CONFLICT(sid) DO UPDATE SET last_seen = excluded.last_seen').bind(sid, now).run();
        if (Math.random() < 0.02) await env.DB.prepare('DELETE FROM live_presence WHERE last_seen < ?').bind(now - 900).run();
    })().catch(() => {});
    if (ctx && ctx.waitUntil) ctx.waitUntil(job); else await job;
}

async function countRealViewers(env, fresh = false) {
    if (!fresh && Date.now() - __liveReal.at < 10000) return __liveReal.n;
    let n = 0;
    try {
        if (await ensureLivePresenceSchema(env)) {
            const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM live_presence WHERE last_seen >= ?').bind(Math.floor(Date.now() / 1000) - LIVE_PRESENCE_WINDOW).first();
            n = Number(row && row.n) || 0;
        }
    } catch (_) {}
    __liveReal = { at: Date.now(), n };
    return n;
}

// Public payload: a short per-second series so every browser ticks smoothly
// without exposing the owner's settings.
async function livePublicPayload(env) {
    const cfg = await getLiveConfig(env);
    if (!cfg.enabled) return { enabled: false };
    const t = Math.floor(Date.now() / 1000);
    if (cfg.mode === 'real') {
        const n = Math.max(1, await countRealViewers(env));
        return { enabled: true, start: t, values: new Array(LIVE_SERIES_SECONDS).fill(n) };
    }
    return { enabled: true, start: t, values: liveSeries(cfg, t).values };
}

async function liveAdminStats(env) {
    const cfg = await getLiveConfig(env, true);
    const t = Math.floor(Date.now() / 1000);
    const real = await countRealViewers(env, true);
    const sim = liveSeries(cfg, t);
    return {
        enabled: cfg.enabled, mode: cfg.mode, start: t, real,
        simulated: sim.values, joins: sim.joins, leaves: sim.leaves,
        shown: !cfg.enabled ? null : (cfg.mode === 'real' ? Math.max(1, real) : sim.values[0])
    };
}

function renderLiveCard(cfg, stats) {
    const fmt = (n) => Number(n || 0).toLocaleString('en-US');
    const num = (name, label, value, max) => '<label class="opt"><span>' + label + '</span><input type="text" inputmode="numeric" pattern="[0-9,]*" name="' + name + '" maxlength="' + (String(max).length + 4) + '" required value="' + value + '" autocomplete="off"></label>';
    const radio = (val, label) => '<label><input type="radio" name="mode" value="' + val + '"' + (cfg.mode === val ? ' checked' : '') + '><span>' + label + '</span></label>';
    const warn = cfg.joinMin > cfg.leaveMax
        ? 'Joins always beat leaves with these ranges, so the count will sit at Online max.'
        : (cfg.leaveMin > cfg.joinMax ? 'Leaves always beat joins with these ranges, so the count will sit at Online min.' : '');
    const shownLabel = !cfg.enabled ? 'Hidden' : (cfg.mode === 'real' ? 'Real count' : 'Simulated');
    return '<section class="card span" id="live-card" data-stats-url="' + ADMIN_PATH + '/live/stats">' +
        '<div class="card-head"><div><div class="card-kicker">OWNER ONLY</div><h2>Live viewers</h2><p>The &ldquo;watching now&rdquo; counter in the header and on the home page.</p></div>' +
        '<span class="hpill' + (cfg.enabled ? '' : ' bad') + '"><i' + (cfg.enabled ? ' style="--c:var(--green)"' : '') + '></i>' + (cfg.enabled ? 'Visible on site' : 'Hidden on site') + '</span></div>' +
        '<div class="live-stats">' +
        '<div class="live-stat"><span>Real visitors now</span><b id="liveReal">' + fmt(stats.real) + '</b><small>Open tabs seen in the last 90 s</small></div>' +
        '<div class="live-stat"><span>Visitors see</span><b id="liveShown">' + (stats.shown == null ? '&mdash;' : fmt(stats.shown)) + '</b><small id="liveShownMode">' + shownLabel + '</small></div>' +
        '<div class="live-stat"><span>Simulated last second</span><b><em class="up" id="liveJoins">+' + fmt(stats.joins) + '</em> <em class="down" id="liveLeaves">&minus;' + fmt(stats.leaves) + '</em></b><small>Joined / left</small></div>' +
        '</div>' +
        '<form method="POST" action="' + ADMIN_PATH + '/live" class="live-form">' +
        '<div class="live-top"><label class="live-toggle"><input type="checkbox" name="enabled" value="on"' + (cfg.enabled ? ' checked' : '') + '><span>Show counter on the site</span></label>' +
        '<div class="seg-radio" role="radiogroup" aria-label="Counter source">' + radio('simulated', 'Simulated') + radio('real', 'Real visitors') + '</div></div>' +
        '<fieldset class="live-group"><legend>Online now</legend><div class="live-pair">' + num('online_min', 'Min', cfg.min, LIVE_LIMITS.online) + num('online_max', 'Max', cfg.max, LIVE_LIMITS.online) + '</div></fieldset>' +
        '<fieldset class="live-group"><legend>Join per second</legend><div class="live-pair">' + num('join_min', 'Min', cfg.joinMin, LIVE_LIMITS.rate) + num('join_max', 'Max', cfg.joinMax, LIVE_LIMITS.rate) + '</div></fieldset>' +
        '<fieldset class="live-group"><legend>Leave per second</legend><div class="live-pair">' + num('leave_min', 'Min', cfg.leaveMin, LIVE_LIMITS.rate) + num('leave_max', 'Max', cfg.leaveMax, LIVE_LIMITS.rate) + '</div></fieldset>' +
        (warn ? '<p class="db-err live-warn">' + warn + '</p>' : '') +
        '<p class="backend-note">Simulated mode follows a daily rhythm inside Online min/max (busiest around 22:30 Tehran), with slow swells and short waves on top. Each second visitors join and leave inside your ranges. Recommended for 1M&ndash;9M: join and leave 7,000&ndash;13,000 per second. Changing min/max starts a new curve.</p>' +
        '<div class="actions-row"><button class="btn sm" type="submit">Save live viewers</button></div>' +
        '</form></section>';
}

const ADMIN_LIVE_JS = String.raw`
(function(){
  var card = document.getElementById('live-card'); if (!card) return;
  var url = card.getAttribute('data-stats-url'), fmt = new Intl.NumberFormat('en-US');
  var real = document.getElementById('liveReal'), shown = document.getElementById('liveShown');
  var joins = document.getElementById('liveJoins'), leaves = document.getElementById('liveLeaves');
  var data = null, skew = 0;
  function tick(){
    if (!data) return;
    var i = Math.floor(Date.now() / 1000 + skew) - data.start;
    i = Math.max(0, Math.min(data.simulated.length - 1, i));
    if (data.enabled && data.mode === 'simulated') shown.textContent = fmt.format(data.simulated[i]);
  }
  function load(){
    fetch(url, { credentials: 'same-origin', cache: 'no-store' }).then(function(r){ return r.ok ? r.json() : null; }).then(function(d){
      if (!d) return;
      data = d; skew = d.start + 0.5 - Date.now() / 1000;
      real.textContent = fmt.format(d.real);
      joins.textContent = '+' + fmt.format(d.joins);
      leaves.textContent = '\u2212' + fmt.format(d.leaves);
      shown.textContent = d.shown == null ? '\u2014' : fmt.format(d.shown);
      tick();
    }).catch(function(){});
  }
  load();
  setInterval(tick, 1000);
  setInterval(function(){ if (document.visibilityState === 'visible') load(); }, 5000);
})();
`;

// Admin sessions + accounts live in 05a-admin-users.ts

// Basic brute-force brake: 8 failed logins per IP per 10 minutes (per isolate)
const __loginFails = new Map();
function loginBlocked(ip) {
    const r = __loginFails.get(ip);
    if (!r) return false;
    if (Date.now() - r.at > 10 * 60 * 1000) { __loginFails.delete(ip); return false; }
    return r.n >= 8;
}
function loginFailed(ip) {
    const r = __loginFails.get(ip);
    if (!r || Date.now() - r.at > 10 * 60 * 1000) __loginFails.set(ip, { n: 1, at: Date.now() });
    else r.n++;
}

function adminHtmlHeaders(extra = {}) {
    return { ...SECURE_HTML_HEADERS, 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', ...extra };
}

function renderAdminLoginHtml(errorMsg) {
    return renderHead({ title: 'Sign in \u2014 VexoStream Admin' }) +
        '<body>' + renderNav('') +
        '<main class="auth"><div class="auth-box">' +
        '<div class="auth-logo">' + VX_GLYPH + '</div>' +
        '<h1>Sign in to Admin</h1><p>Manage VexoStream.</p>' +
        (errorMsg ? '<div class="alert" role="alert">' + escapeHtml(errorMsg) + '</div>' : '') +
        '<form method="POST" action="' + ADMIN_PATH + '/login">' +
        '<div class="fieldset">' +
        '<label class="fl"><input type="text" name="username" autocomplete="username" placeholder=" " required autofocus><span>Username</span></label>' +
        '<label class="fl"><input type="password" name="password" autocomplete="current-password" placeholder=" " required><span>Password</span></label>' +
        '</div>' +
        '<button class="btn" type="submit">Sign in</button>' +
        '</form></div></main>' +
        renderFooter() + '<script>' + COMMON_JS + '</script></body></html>';
}

function renderProvidersCard(cfg) {
    const list = providerList(cfg);
    const modeLabel = { live: 'Live', hidden: 'Hidden', locked: 'Locked' };
    const rows = list.map((p, i) =>
        '<li class="prov-row" data-id="' + p.id + '">' +
        '<div class="prov-move">' +
        '<button type="button" class="icon-btn" data-move="-1" aria-label="Move ' + escapeHtml(p.name) + ' up"' + (i === 0 ? ' disabled' : '') + '>' + ICONS.up + '</button>' +
        '<button type="button" class="icon-btn" data-move="1" aria-label="Move ' + escapeHtml(p.name) + ' down"' + (i === list.length - 1 ? ' disabled' : '') + '>' + ICONS.down + '</button>' +
        '</div>' +
        '<div class="prov-name"><span class="pdot" data-mode="' + p.mode + '"></span><div><b>' + escapeHtml(p.name) + '</b><small>' + escapeHtml(p.domain) + '</small></div></div>' +
        '<div class="seg-radio" role="radiogroup" aria-label="' + escapeHtml(p.name) + ' mode">' +
        PROVIDER_MODES.map(m => '<label><input type="radio" name="mode_' + p.id + '" value="' + m + '"' + (p.mode === m ? ' checked' : '') + '><span>' + modeLabel[m] + '</span></label>').join('') +
        '</div></li>').join('');
    const opts = list.map(p => '<option value="' + p.id + '"' + (p.id === cfg.defaultProvider ? ' selected' : '') + '>' + escapeHtml(p.name) + (p.mode !== 'live' ? ' (' + modeLabel[p.mode].toLowerCase() + ')' : '') + '</option>').join('');
    const counts = PROVIDER_MODES.map(m => list.filter(p => p.mode === m).length);
    const bulk = (action, label, cls) => '<form method="POST" action="' + ADMIN_PATH + '/providers/bulk"><input type="hidden" name="action" value="' + action + '"><button class="btn ' + cls + ' sm" type="submit">' + label + '</button></form>';
    return '<section class="card span" id="providers-card">' +
        '<div class="card-head"><div><h2>Providers</h2><p>Lock a provider to keep it listed but unavailable, or hide it completely.</p>' +
        '<div class="health"><span class="hpill"><i style="--c:var(--green)"></i>' + counts[0] + ' live</span><span class="hpill"><i style="--c:var(--amber)"></i>' + counts[1] + ' hidden</span><span class="hpill"><i style="--c:var(--red)"></i>' + counts[2] + ' locked</span></div></div>' +
        '<div class="links">' + bulk('unlock_all', 'Unlock all', 'quiet') + bulk('lock_all', 'Lock all', 'quiet') + bulk('reset', 'Reset', 'quiet') + '</div></div>' +
        '<form method="POST" action="' + ADMIN_PATH + '/providers" id="provForm">' +
        '<ul class="prov-list" id="provList">' + rows + '</ul>' +
        '<input type="hidden" name="order" id="provOrder" value="' + cfg.order.join(',') + '">' +
        '<div class="prov-opts">' +
        '<label class="opt"><span>Default provider</span><select name="default_provider">' + opts + '</select></label>' +
        '<label class="opt"><span>Default search</span><input name="default_query" maxlength="100" value="' + escapeHtml(cfg.defaultQuery) + '" autocomplete="off"></label>' +
        '<label class="opt span"><span>Message shown when a provider is locked</span><input name="lock_message" maxlength="200" value="' + escapeHtml(cfg.lockMessage) + '" autocomplete="off"></label>' +
        '</div>' +
        '<div class="prov-foot"><p class="prov-legend"><b>Live</b> browse + play &middot; <b>Hidden</b> removed everywhere &middot; <b>Locked</b> listed but unavailable, including direct links.</p>' +
        '<div class="actions"><span class="dirty" id="provDirty">Unsaved changes</span><button class="btn sm" type="submit">Save providers</button></div></div>' +
        '</form></section>';
}


function renderDefaultSearchCard(dsCfg, status) {
    const unitOpts = [['minutes', 'Minutes'], ['hours', 'Hours'], ['days', 'Days']]
        .map(([val, lbl]) => '<option value="' + val + '"' + (dsCfg.intervalUnit === val ? ' selected' : '') + '>' + lbl + '</option>')
        .join('');
    const act = (action, label, cls = 'quiet') => '<form method="POST" action="' + ADMIN_PATH + '/default-search" style="display:inline"><input type="hidden" name="action" value="' + action + '"><button class="btn ' + cls + ' sm" type="submit">' + label + '</button></form>';
    return '<section class="card span" id="default-search-card">' +
        '<div class="card-head"><div><h2>Default Search Explore</h2><p>Automatically rotates the default search term for both the website and app.</p>' +
        '<div class="health">' +
        '<span class="hpill"><i style="--c:' + (dsCfg.enabled ? 'var(--green)' : 'var(--amber)') + '"></i>' + (dsCfg.enabled ? 'Auto-rotation on' : 'Paused') + '</span>' +
        '<span class="hpill"><i></i>Now: <b>' + escapeHtml(status.activeQuery) + '</b> (#' + (status.activeIndex + 1) + '/' + status.total + ')</span>' +
        '<span class="hpill"><i></i>Next: ' + escapeHtml(status.nextQuery) + (dsCfg.enabled ? ' in ' + formatDurationShort(status.remainingMs) : '') + '</span>' +
        '</div></div>' +
        '<div class="links">' + act('prev', '&lsaquo; Prev') + act('next', 'Next name &rsaquo;') + act('restart', 'Restart #1') + act('reset_list', 'Reset 100 defaults') + '</div></div>' +
        '<form method="POST" action="' + ADMIN_PATH + '/default-search" class="backend-form">' +
        '<input type="hidden" name="action" value="save">' +
        '<div class="prov-opts">' +
        '<label class="opt"><span>Auto-rotation</span><select name="enabled"><option value="1"' + (dsCfg.enabled ? ' selected' : '') + '>Enabled</option><option value="0"' + (!dsCfg.enabled ? ' selected' : '') + '>Disabled (use static default)</option></select></label>' +
        '<label class="opt"><span>Change every</span><input type="number" name="interval_value" min="1" max="10000" required value="' + dsCfg.intervalValue + '"></label>' +
        '<label class="opt"><span>Interval unit</span><select name="interval_unit">' + unitOpts + '</select></label>' +
        '<label class="opt"><span>Current position (1&ndash;' + Math.max(1, status.total) + ')</span><input type="number" name="current_index_1" min="1" max="' + Math.max(1, status.total) + '" value="' + (status.activeIndex + 1) + '"></label>' +
        '<label class="opt span"><span>Rotation name list (one name per line, ' + status.total + ' names)</span><textarea name="names_text" rows="12" style="font-family:var(--font-mono);font-size:13px">' + escapeHtml(dsCfg.names.join('\n')) + '</textarea></label>' +
        '</div>' +
        '<div class="prov-foot"><p class="prov-legend">Default is <b>1 day</b> per name. Saving updates the active term immediately across the site and app.</p>' +
        '<div class="actions"><button class="btn sm" type="submit">Save Default Search</button></div></div>' +
        '</form></section>';
}


function renderNoticeCard(nCfg) {
    const cfg = normalizeNoticeConfig(nCfg);
    const toneOpts = [['info', 'Info (Blue)'], ['success', 'Success (Green)'], ['warning', 'Warning (Amber)'], ['urgent', 'Urgent (Red)']]
        .map(([val, lbl]) => '<option value="' + val + '">' + lbl + '</option>').join('');
    const iconOpts = [['campaign', 'Megaphone'], ['sparkles', 'Sparkles / New'], ['info', 'Info Circle'], ['check', 'Checkmark'], ['warning', 'Warning'], ['shield', 'Shield / Security']]
        .map(([val, lbl]) => '<option value="' + val + '">' + lbl + '</option>').join('');
    const audOpts = [['all', 'Everyone (In & Out)'], ['in', 'Signed-in only (In)'], ['out', 'Signed-out only (Out)']]
        .map(([val, lbl]) => '<option value="' + val + '">' + lbl + '</option>').join('');
    const audLabel = { all: 'Everyone', in: 'Signed in only', out: 'Signed out only' };
    const rows = cfg.items.length
        ? cfg.items.map((n, i) =>
            '<li class="prov-row" style="align-items:flex-start;gap:12px">' +
            '<div class="prov-name" style="flex:1;min-width:0"><span class="pdot" data-mode="' + (n.enabled ? 'live' : 'locked') + '"></span>' +
            '<div style="min-width:0"><b>' + escapeHtml(n.title || '(No title)') + '</b>' +
            '<small style="display:block;white-space:normal">' + escapeHtml(n.message) + '</small>' +
            '<small style="display:block;opacity:.8;margin-top:4px">' + escapeHtml(n.tone.toUpperCase()) + ' &middot; ' + escapeHtml(n.icon) + ' &middot; ' + escapeHtml(audLabel[n.audience] || 'Everyone') + (n.dismissible ? ' &middot; Dismissible' : ' &middot; Pinned') + '</small>' +
            '</div></div>' +
            '<div class="links" style="flex-wrap:wrap">' +
            '<form method="POST" action="' + ADMIN_PATH + '/notice" style="display:inline"><input type="hidden" name="action" value="toggle"><input type="hidden" name="id" value="' + escapeHtml(n.id) + '"><button class="btn quiet sm" type="submit">' + (n.enabled ? 'Hide' : 'Show') + '</button></form>' +
            (i > 0 ? '<form method="POST" action="' + ADMIN_PATH + '/notice" style="display:inline"><input type="hidden" name="action" value="move"><input type="hidden" name="id" value="' + escapeHtml(n.id) + '"><input type="hidden" name="dir" value="-1"><button class="btn quiet sm" type="submit">&uarr;</button></form>' : '') +
            (i < cfg.items.length - 1 ? '<form method="POST" action="' + ADMIN_PATH + '/notice" style="display:inline"><input type="hidden" name="action" value="move"><input type="hidden" name="id" value="' + escapeHtml(n.id) + '"><input type="hidden" name="dir" value="1"><button class="btn quiet sm" type="submit">&darr;</button></form>' : '') +
            '<form method="POST" action="' + ADMIN_PATH + '/notice" style="display:inline"><input type="hidden" name="action" value="delete"><input type="hidden" name="id" value="' + escapeHtml(n.id) + '"><button class="btn quiet sm" type="submit">Delete</button></form>' +
            '</div></li>'
        ).join('')
        : '<li class="prov-row"><small>No notices added yet. Use the form below to publish one.</small></li>';

    const activeCount = cfg.items.filter(x => x.enabled).length;
    return '<section class="card span" id="notice-card">' +
        '<div class="card-head"><div><h2>Owner Notices</h2><p>Show multiple announcements across the website and app, with signed-in / signed-out targeting.</p>' +
        '<div class="health"><span class="hpill"><i style="--c:' + (activeCount ? 'var(--green)' : 'var(--amber)') + '"></i>' + activeCount + ' active / ' + cfg.items.length + ' total</span></div></div>' +
        '<form method="POST" action="' + ADMIN_PATH + '/notice" style="display:inline"><input type="hidden" name="action" value="clear"><button class="btn quiet sm" type="submit">Clear all</button></form></div>' +
        '<ul class="prov-list" style="margin-bottom:18px">' + rows + '</ul>' +
        '<form method="POST" action="' + ADMIN_PATH + '/notice" class="backend-form">' +
        '<input type="hidden" name="action" value="add">' +
        '<div class="prov-opts">' +
        '<label class="opt"><span>Visibility</span><select name="enabled"><option value="1" selected>Published (Show)</option><option value="0">Hidden (Draft)</option></select></label>' +
        '<label class="opt"><span>Audience (In / Out)</span><select name="audience">' + audOpts + '</select></label>' +
        '<label class="opt"><span>Style / Tone</span><select name="tone">' + toneOpts + '</select></label>' +
        '<label class="opt"><span>Icon</span><select name="icon">' + iconOpts + '</select></label>' +
        '<label class="opt"><span>Allow dismiss</span><select name="dismissible"><option value="1" selected>Yes (users can close)</option><option value="0">No (always pinned)</option></select></label>' +
        '<label class="opt"><span>Title (optional)</span><input name="title" maxlength="100" placeholder="Announcement or update title"></label>' +
        '<label class="opt span"><span>Message</span><textarea name="message" rows="3" maxlength="400" required placeholder="Write a notice for visitors or signed-in members..."></textarea></label>' +
        '<label class="opt"><span>Button label (optional)</span><input name="link_text" maxlength="40" placeholder="Learn more"></label>' +
        '<label class="opt"><span>Button URL (optional)</span><input name="link_url" maxlength="240" placeholder="https://... or /models"></label>' +
        '</div>' +
        '<div class="prov-foot"><p class="prov-legend">Use <b>Audience</b> to show a notice only to signed-in users, signed-out guests, or everyone.</p>' +
        '<div class="actions"><button class="btn sm" type="submit">Add Notice</button></div></div>' +
        '</form></section>';
}

function renderBackendCard(backendUrl) {
    return '<section class="card span" id="backend-card"><div class="card-head"><div><h2>Backend URL</h2><p>Choose the API server used for search, video extraction, and stream proxying. Saved in D1 and applied immediately (other edge instances refresh within 20 seconds).</p></div><span class="hpill"><i></i>HTTP + HTTPS</span></div>' +
        '<form method="POST" action="' + ADMIN_PATH + '/backend" id="backendForm" class="backend-form">' +
        '<label class="opt"><span>Backend URL</span><input type="text" inputmode="url" name="backend_url" maxlength="240" required value="' + escapeHtml(backendUrl) + '" placeholder="https://api.example.com or http://203.0.113.10:8000" autocomplete="url" spellcheck="false"></label>' +
        '<div class="backend-actions"><button class="btn sm" type="submit">Save Backend URL</button></div>' +
        '<p class="backend-note">Use the public HTTP or HTTPS origin for your VexoStream Core API. Ports and public IPs are supported; no scheme means <code>http://</code>. Private and local hosts are blocked. Reset uses the Worker’s <code>RAILWAY_URL</code> variable.</p></form>' +
        '<form method="POST" action="' + ADMIN_PATH + '/backend" class="backend-reset"><input type="hidden" name="action" value="reset"><button class="btn quiet sm" type="submit">Reset to Worker variable</button></form></section>';
}


function renderSiteSuspensionCard(sCfg) {
    const cfg = normalizeSiteSuspensionConfig(sCfg);
    const catOpts = Object.keys(SITE_SUSPEND_PRESETS).map(k =>
        '<option value="' + k + '"' + (cfg.category === k ? ' selected' : '') + '>' + escapeHtml(SITE_SUSPEND_PRESETS[k].label) + '</option>'
    ).join('');
    const codeOpts = [
        [503, '503 Service Unavailable'],
        [451, '451 Unavailable For Legal Reasons']
    ].map(c => '<option value="' + c[0] + '"' + (cfg.statusCode === c[0] ? ' selected' : '') + '>' + c[1] + '</option>').join('');
    const pill = cfg.enabled
        ? '<span class="hpill bad"><i></i>Site suspended (HTTP ' + cfg.statusCode + ')</span>'
        : '<span class="hpill"><i style="--c:var(--green)"></i>Site active</span>';
    return '<section class="card span" id="suspension-card">' +
        '<div class="card-head"><div><div class="card-kicker">SITE SUSPENSION</div><h2>Website suspension notice</h2><p>Display the official suspension page across the public website and optionally the native app while keeping Owner and Admin access active.</p></div>' +
        '<div class="health">' + pill + '</div></div>' +
        '<form method="POST" action="' + ADMIN_PATH + '/suspension" class="live-form">' +
        '<div class="live-top">' +
        '<div style="display:flex;flex-wrap:wrap;gap:14px 22px;align-items:center">' +
        '<label class="live-toggle"><input type="checkbox" name="enabled" value="on"' + (cfg.enabled ? ' checked' : '') + '><span>Suspend public website</span></label>' +
        '<label class="live-toggle"><input type="checkbox" name="apply_to_app" value="on"' + (cfg.applyToApp ? ' checked' : '') + '><span>Also suspend native app</span></label>' +
        '</div>' +
        '<div class="links"><a class="btn quiet sm" href="' + ADMIN_PATH + '/suspension/preview" target="_blank" rel="noopener">Preview page</a></div>' +
        '</div>' +
        '<div class="prov-opts">' +
        '<label class="opt"><span>Notice category</span><select name="category">' + catOpts + '</select></label>' +
        '<label class="opt"><span>HTTP status code</span><select name="status_code">' + codeOpts + '</select></label>' +
        '<label class="opt"><span>Issued by / Provider</span><input name="issuer" maxlength="120" value="' + escapeHtml(cfg.issuer) + '" placeholder="e.g. Hosting Infrastructure Provider" autocomplete="off"></label>' +
        '<label class="opt"><span>Reference / Case ID (optional)</span><input name="reference_id" maxlength="64" value="' + escapeHtml(cfg.referenceId) + '" placeholder="e.g. REF-2026-0412" autocomplete="off"></label>' +
        '<label class="opt span"><span>Headline</span><input name="title" maxlength="160" value="' + escapeHtml(cfg.title) + '" placeholder="This website has been suspended." autocomplete="off"></label>' +
        '<label class="opt span"><span>Suspension message</span><textarea name="message" maxlength="800" rows="3" placeholder="Explain why public access is suspended...">' + escapeHtml(cfg.message) + '</textarea></label>' +
        '<label class="opt"><span>Contact / Appeal URL (optional)</span><input name="contact_url" maxlength="240" value="' + escapeHtml(cfg.contactUrl) + '" placeholder="https://... or mailto:abuse@example.com" autocomplete="off"></label>' +
        '<label class="opt"><span>Button label</span><input name="contact_label" maxlength="48" value="' + escapeHtml(cfg.contactLabel) + '" placeholder="Contact support" autocomplete="off"></label>' +
        '</div>' +
        '<p class="backend-note">Signed-in admins bypass this screen and can lift the suspension at any time. For legal/compliance integrity, use accurate organization details rather than impersonating third-party brands or law enforcement.</p>' +
        '<div class="actions-row" style="gap:8px">' +
        (cfg.enabled ? '<button class="btn quiet sm" type="submit" name="action" value="lift">Lift suspension</button>' : '') +
        '<button class="btn danger sm" type="submit" name="action" value="save">' + (cfg.enabled ? 'Update suspension' : 'Save suspension settings') + '</button>' +
        '</div></form></section>';
}

function renderSiteSuspendedHtml(sCfg, host = 'vexostream.bond') {
    const cfg = normalizeSiteSuspensionConfig(sCfg);
    const preset = SITE_SUSPEND_PRESETS[cfg.category] || SITE_SUSPEND_PRESETS.platform;
    const stamp = cfg.updatedAt ? new Date(cfg.updatedAt).toISOString().replace('T', ' ').slice(0, 19) + ' UTC' : new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
    const sealSvg = '<svg viewBox="0 0 80 80" width="68" height="68" fill="none" aria-hidden="true">' +
        '<circle cx="40" cy="40" r="36" stroke="#ef4444" stroke-opacity=".35" stroke-width="1.5" stroke-dasharray="4 4"/>' +
        '<circle cx="40" cy="40" r="29" fill="rgba(239,68,68,.12)" stroke="#ef4444" stroke-width="2"/>' +
        '<path d="M40 19l15 6v13c0 10.2-6.4 18.8-15 22-8.6-3.2-15-11.8-15-22V25l15-6z" fill="rgba(239,68,68,.16)" stroke="#f87171" stroke-width="2.2" stroke-linejoin="round"/>' +
        '<path d="M40 31v11" stroke="#ffffff" stroke-width="2.8" stroke-linecap="round"/>' +
        '<circle cx="40" cy="48.5" r="1.8" fill="#ffffff"/>' +
        '</svg>';
    const isExt = /^https?:\/\//i.test(cfg.contactUrl);
    const cta = cfg.contactUrl
        ? '<a class="susp-cta" href="' + escapeHtml(cfg.contactUrl) + '"' + (isExt ? ' target="_blank" rel="noopener"' : '') + '>' + escapeHtml(cfg.contactLabel || 'Contact support') + '</a>'
        : '';
    const refCell = cfg.referenceId
        ? '<div class="susp-cell"><span>Reference / Case ID</span><b class="mono">' + escapeHtml(cfg.referenceId) + '</b></div>'
        : '';
    const scopeText = cfg.applyToApp ? 'Website & Native App' : 'Public Website';
    return renderHead({ title: cfg.title + ' \u2014 ' + escapeHtml(host) }).replace('</head>', '<meta name="robots" content="noindex, nofollow"><style>' +
        'body.susp-body-root{margin:0;min-height:100vh;min-height:100dvh;background:#05070c;background-image:radial-gradient(ellipse 80% 50% at 50% -10%,rgba(239,68,68,.18),transparent 70%);color:#f4f5f8;display:flex;flex-direction:column;font-family:var(--font-sans)}' +
        '.susp-ribbon{width:100%;background:#b91c1c;background-image:linear-gradient(90deg,#991b1b 0%,#dc2626 50%,#991b1b 100%);border-bottom:1px solid rgba(255,255,255,.18);color:#ffffff;padding:11px 20px;font:700 12px/1.2 var(--font-mono);letter-spacing:.14em;text-transform:uppercase;display:flex;align-items:center;justify-content:center;gap:14px;text-align:center}' +
        '.susp-ribbon-dot{width:8px;height:8px;border-radius:50%;background:#ffffff;box-shadow:0 0 0 3px rgba(255,255,255,.28);display:inline-block;flex:none}' +
        '.susp-stage{flex:1;display:flex;align-items:center;justify-content:center;padding:36px 16px 48px}' +
        '.susp-shell{width:100%;max-width:740px;border-radius:20px;border:1px solid rgba(239,68,68,.38);background:#0b0e16;box-shadow:0 32px 90px rgba(0,0,0,.68),0 0 0 1px rgba(255,255,255,.04) inset;overflow:hidden}' +
        '.susp-head{padding:36px 32px 28px;text-align:center;border-bottom:1px solid rgba(255,255,255,.08);background:linear-gradient(180deg,rgba(239,68,68,.10) 0%,rgba(11,14,22,0) 100%)}' +
        '.susp-seal{display:inline-flex;align-items:center;justify-content:center;margin:0 auto 18px}' +
        '.susp-tag{display:inline-flex;align-items:center;gap:8px;padding:6px 14px;border-radius:999px;background:rgba(239,68,68,.14);border:1px solid rgba(239,68,68,.36);color:#fca5a5;font:700 11px/1 var(--font-mono);letter-spacing:.12em;text-transform:uppercase;margin-bottom:16px}' +
        '.susp-head h1{margin:0 auto 14px;max-width:22ch;font-size:clamp(26px,4.4vw,40px);font-weight:800;letter-spacing:-.035em;line-height:1.08;color:#ffffff;text-transform:uppercase}' +
        '.susp-msg{margin:0 auto;max-width:56ch;font-size:16px;line-height:1.65;color:#b8becb;white-space:pre-line;unicode-bidi:plaintext}' +
        '.susp-docket{padding:26px 32px 30px}' +
        '.susp-docket-title{margin:0 0 14px;font:700 11px/1 var(--font-mono);letter-spacing:.14em;text-transform:uppercase;color:#7c8496}' +
        '.susp-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}' +
        '.susp-cell{padding:14px 16px;border-radius:12px;border:1px solid rgba(255,255,255,.08);background:#111622;min-width:0}' +
        '.susp-cell span{display:block;font:600 11px/1.2 var(--font-mono);letter-spacing:.08em;text-transform:uppercase;color:#7c8496;margin-bottom:6px}' +
        '.susp-cell b{display:block;font-size:14.5px;font-weight:600;color:#f4f5f8;overflow-wrap:anywhere}' +
        '.susp-cell b.is-red{color:#f87171}' +
        '.susp-foot{margin-top:22px;padding-top:18px;border-top:1px solid rgba(255,255,255,.08);display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap}' +
        '.susp-brand-mini{display:inline-flex;align-items:center;gap:8px;color:#7c8496;font:600 12px/1 var(--font-mono);letter-spacing:.06em}' +
        '.susp-cta{display:inline-flex;align-items:center;justify-content:center;min-height:40px;padding:0 20px;border-radius:999px;background:#dc2626;color:#ffffff;font:600 14px/1 var(--font-sans);text-decoration:none;transition:background-color .2s ease}' +
        '.susp-cta:hover{background:#b91c1c;text-decoration:none}' +
        '@media(max-width:600px){.susp-head{padding:28px 20px 22px}.susp-docket{padding:20px}.susp-grid{grid-template-columns:minmax(0,1fr)}.susp-ribbon{font-size:11px;letter-spacing:.09em}}' +
        '</style></head>') +
        '<body class="susp-body-root">' +
        '<div class="susp-ribbon"><span class="susp-ribbon-dot"></span><span>Access Restricted &middot; Official Suspension Notice &middot; HTTP ' + cfg.statusCode + '</span></div>' +
        '<main class="susp-stage"><section class="susp-shell" role="alert" aria-labelledby="suspTitle">' +
        '<div class="susp-head">' +
        '<div class="susp-seal">' + sealSvg + '</div>' +
        '<div><span class="susp-tag">' + escapeHtml(preset.label) + '</span></div>' +
        '<h1 id="suspTitle" dir="auto">' + escapeHtml(cfg.title) + '</h1>' +
        '<p class="susp-msg" dir="auto">' + escapeHtml(cfg.message) + '</p>' +
        '</div>' +
        '<div class="susp-docket">' +
        '<p class="susp-docket-title">Notice Details</p>' +
        '<div class="susp-grid">' +
        '<div class="susp-cell"><span>Domain</span><b class="mono">' + escapeHtml(host) + '</b></div>' +
        '<div class="susp-cell"><span>Issued By</span><b dir="auto">' + escapeHtml(cfg.issuer) + '</b></div>' +
        '<div class="susp-cell"><span>Service Status</span><b class="is-red">SUSPENDED (HTTP ' + cfg.statusCode + ')</b></div>' +
        '<div class="susp-cell"><span>Scope</span><b>' + escapeHtml(scopeText) + '</b></div>' +
        refCell +
        '<div class="susp-cell"><span>Effective (UTC)</span><b class="mono">' + escapeHtml(stamp) + '</b></div>' +
        '</div>' +
        '<div class="susp-foot">' +
        '<span class="susp-brand-mini"><span class="brand-mark" style="width:22px;height:22px;border-radius:6px">' + VX_GLYPH + '</span><span>VEXOSTREAM EDGE GATEWAY</span></span>' +
        (cta ? cta : '') +
        '</div>' +
        '</div></section></main></body></html>';
}

function renderDatabaseCard(health) {
    const pill = (ok, label) => '<span class="hpill' + (ok ? '' : ' bad') + '"><i></i>' + label + '</span>';
    return '<section class="card"><h2>Database</h2><p>Settings live in D1 (binding <b>DB</b>). Repair creates or upgrades the settings table and tests a write.</p>' +
        '<div class="health">' + pill(health.binding, 'Binding') + pill(health.table, 'Settings table') + (health.write === null ? '' : pill(health.write, 'Write test')) + '</div>' +
        (health.error ? '<p class="db-err">' + escapeHtml(health.error) + '</p>' : '') +
        '<form method="POST" action="' + ADMIN_PATH + '/repair"><button class="btn sm" type="submit">Repair database</button></form></section>';
}

function renderTelegramCard(settings = { tokenConfigured: false, tokenSource: 'Not configured', webhookUrl: '', webhookOrigin: '' }) {
    const tokenPill = settings.tokenConfigured
        ? '<span class="hpill"><i style="--c:var(--green)"></i>Bot token configured</span>'
        : '<span class="hpill bad"><i></i>Bot token missing</span>';
    const source = settings.tokenSource || 'Not configured';
    const webhook = settings.webhookUrl || 'Set a public HTTPS URL below';
    return '<section class="card span"><div class="card-head"><div><div class="card-kicker">TELEGRAM BOT</div><h2>Telegram bot settings</h2><p>Manage the bot credential and webhook target. The token is never shown after saving.</p></div>' +
        '<div class="health">' + tokenPill + '<span class="hpill"><i></i>' + escapeHtml(source) + '</span></div></div>' +
        '<form method="POST" action="' + ADMIN_PATH + '/telegram" class="tg-settings-form">' +
        '<div class="prov-opts">' +
        '<label class="opt"><span>Bot token</span><input type="password" name="bot_token" maxlength="256" autocomplete="new-password" placeholder="Leave blank to keep the current token"></label>' +
        '<label class="opt"><span>Webhook URL</span><input type="url" inputmode="url" name="webhook_origin" maxlength="240" value="' + escapeHtml(settings.webhookOrigin || '') + '" placeholder="https://example.com" autocomplete="url" spellcheck="false"></label>' +
        '</div>' +
        '<p class="backend-note">Current endpoint: <code>' + escapeHtml(webhook) + '</code>. Leave the URL blank to use this site’s current host. Only public HTTPS URLs are accepted. The webhook secret is derived from <code>STREAM_SIGN_SECRET</code>; bot commands are managed by the app.</p>' +
        '<div class="actions-row"><button class="btn sm" type="submit">Save Telegram settings</button></div></form>' +
        '<div class="links">' +
        '<form method="POST" action="' + ADMIN_PATH + '/telegram"><input type="hidden" name="action" value="reset_token"><button class="btn quiet sm" type="submit">Reset token to Worker secret</button></form>' +
        '<form method="POST" action="' + ADMIN_PATH + '/setup"><button class="btn quiet sm" type="submit">Reconnect Telegram</button></form>' +
        '<form method="POST" action="' + ADMIN_PATH + '/social"><input type="hidden" name="action" value="check_bot"><button class="btn quiet sm" type="submit">Check bot</button></form>' +
        '</div></section>';
}

const ADMIN_JS = String.raw`
(function(){
  var form = document.getElementById('provForm'); if (!form) return;
  var list = document.getElementById('provList'), order = document.getElementById('provOrder'), dirty = document.getElementById('provDirty');
  var initial = new URLSearchParams(new FormData(form)).toString();
  function sync(){
    var rows = list.querySelectorAll('.prov-row');
    order.value = Array.prototype.map.call(rows, function(r){ return r.dataset.id; }).join(',');
    rows.forEach(function(r, i){
      var b = r.querySelectorAll('[data-move]');
      b[0].disabled = i === 0; b[1].disabled = i === rows.length - 1;
      var c = r.querySelector('input[type=radio]:checked'); if (c) r.querySelector('.pdot').setAttribute('data-mode', c.value);
    });
    dirty.classList.toggle('on', new URLSearchParams(new FormData(form)).toString() !== initial);
  }
  list.addEventListener('click', function(e){
    var b = e.target.closest('[data-move]'); if (!b) return;
    var row = b.closest('.prov-row'), dir = parseInt(b.dataset.move, 10);
    var other = dir < 0 ? row.previousElementSibling : row.nextElementSibling; if (!other) return;
    if (dir < 0) list.insertBefore(row, other); else list.insertBefore(other, row);
    row.classList.remove('moved'); void row.offsetWidth; row.classList.add('moved');
    sync();
    var again = row.querySelector('[data-move="' + dir + '"]'); (again && !again.disabled ? again : b).focus();
  });
  form.addEventListener('change', sync);
  form.addEventListener('input', sync);
  form.addEventListener('submit', function(){ initial = new URLSearchParams(new FormData(form)).toString(); });
  window.addEventListener('beforeunload', function(e){ if (dirty.classList.contains('on')) { e.preventDefault(); e.returnValue = ''; } });
})();
`;

function renderAdminPanelHtml(user, maintenanceOn, flashMsg, cfg = normalizeProviderConfig(null), health = { binding: true, table: true, write: null, error: '' }, flashErr = false, backendUrl = BACKEND_URL_BASE, team = null, telegram = null, live = null, social = null, members = null, appMaintenanceOn = false, defaultSearch = null, noticeCfg = null, suspendCfg = null) {
    const section = (id, title, detail, cards) => '<section class="admin-section" id="' + id + '"><div class="section-head"><div><h2>' + title + '</h2><p>' + detail + '</p></div></div><div class="cards">' + cards + '</div></section>';
    const can = (perm) => adminCan(user, perm);
    const siteMode = '<section class="card span"><div class="card-kicker">PUBLIC SITE</div><h2>Site mode</h2><p>Website maintenance is independent of the app. Signed-in admins retain access.</p>' +
        '<form method="POST" action="' + ADMIN_PATH + '/toggle" class="mode">' +
        '<span class="mode-state"><span class="pdot" style="--c:' + (maintenanceOn ? 'var(--amber)' : 'var(--green)') + '"></span>' +
        (maintenanceOn ? 'Maintenance is on' : 'Site is live') + '</span>' +
        '<button type="submit" class="switch" role="switch" aria-checked="' + maintenanceOn + '" aria-label="Maintenance mode"' + (health.binding && health.table ? '' : ' title="Database needs repair first"') + '></button>' +
        '</form></section>';
    const appMode = '<section class="card span"><div class="card-kicker">NATIVE APP</div><h2>App mode</h2><p>App maintenance is independent of the website. Admin sign-in remains available.</p>' +
        '<form method="POST" action="' + ADMIN_PATH + '/toggle-app" class="mode">' +
        '<span class="mode-state"><span class="pdot" style="--c:' + (appMaintenanceOn ? 'var(--amber)' : 'var(--green)') + '"></span>' +
        (appMaintenanceOn ? 'App maintenance is on' : 'App is live') + '</span>' +
        '<button type="submit" class="switch" role="switch" aria-checked="' + appMaintenanceOn + '" aria-label="App maintenance mode"></button></form></section>';
    const ops = renderDatabaseCard(health);
    const links = '<section class="card span"><div class="card-kicker">QUICK LINKS</div><h2>Public pages</h2><p>Jump straight to the live site and health endpoints.</p>' +
        '<div class="links"><a class="btn quiet sm" href="/">Explore</a><a class="btn quiet sm" href="/status">Status</a><a class="btn quiet sm" href="/social">Social</a><a class="btn quiet sm" href="/api/status" target="_blank" rel="noopener">Status JSON</a><a class="btn quiet sm" href="/api/providers" target="_blank" rel="noopener">Providers JSON</a></div></section>';
    const parts = [];
    const nav = [];
    const add = (id, label, title, detail, cards) => { nav.push('<a href="#' + id + '">' + label + '</a>'); parts.push(section(id, title, detail, cards)); };
    add('account', 'Account', 'Your account', 'Change your password and see what you can manage.', renderAccountCard(user) + '<section class="card"><div class="card-kicker">ACCESS</div><h2>What you can manage</h2><p>' + (user.owner ? 'You own this site, so you can manage everything.' : 'Ask the owner (' + escapeHtml(ownerName()) + ') if you need more.') + '</p>' + permChecks('perm_view', user.permissions, { lockAll: true }) + '</section>');
    if (can('users')) add('team', 'Team', 'Team &amp; permissions', user.owner ? 'Add admins, choose what each one can manage, reset or remove them.' : 'Add admins and set their permissions. Only the owner can grant Team.', renderTeamCards(user, team));
    if (can('site') || can('app')) add('overview', 'Maintenance', 'Maintenance', 'Control the website and app independently.', (can('site') ? siteMode : '') + (can('app') ? appMode : ''));
    if (can('site_suspend')) add('suspension', 'Suspension', 'Site suspension', 'Suspend public access to the website with a formal suspension notice page.', renderSiteSuspensionCard(suspendCfg));
    if (members) add('members', 'Members', 'Members', 'Visitor accounts and “log in to watch”.', renderMembersCard(members.cfg, members.list, user));
    if (can('backend')) add('backend', 'Backend', 'Backend', 'Set the API server this Worker forwards requests to.', renderBackendCard(backendUrl));
    if (can('providers')) add('providers', 'Providers', 'Providers', 'Choose what visitors can browse and set the default search experience.', renderProvidersCard(cfg));
    if (can('default_search')) { const dsCfg = (defaultSearch && defaultSearch.cfg) || normalizeDefaultSearchConfig(null); const dsStatus = (defaultSearch && defaultSearch.status) || resolveDefaultSearchStatus(dsCfg); add('default-search', 'Default Search', 'Default Search Explore', 'Manage the rotating default search names and change interval for the site and app.', renderDefaultSearchCard(dsCfg, dsStatus)); }
    if (can('notice')) add('notice', 'Notice', 'Owner Notice', 'Publish a global announcement banner to both the website and app.', renderNoticeCard(noticeCfg));
    if (user.owner && live) add('live', 'Live viewers', 'Live viewers', 'See real traffic and control the public watching-now counter.', renderLiveCard(live.cfg, live.stats));
    if (can('social')) add('social', 'Social media', 'Social media', 'Telegram bot, Telegram channel, your bots and social accounts.', renderTelegramCard(telegram) + renderSocialCards(social && social.cfg, social && social.posts));
    if (can('operations')) add('operations', 'Operations', 'Operations', 'Keep the database healthy.', ops);
    add('links', 'Links', 'Quick links', 'Useful public endpoints.', links);
    return renderHead({ title: 'Admin \u00b7 VexoStream' }) +
        '<body>' + renderNav('') + '<main class="dash"><div class="wrap">' +
        '<div class="dash-head"><div><p class="eyebrow">CONTROL ROOM</p><h1>Admin</h1><p>Signed in as <b>' + escapeHtml(user.username) + '</b> ' + rolePill(user) + '</p></div>' +
        '<a class="btn quiet sm" href="' + ADMIN_PATH + '/logout">Sign out</a></div>' +
        (flashMsg ? '<div class="alert' + (flashErr ? '' : ' ok') + '" role="' + (flashErr ? 'alert' : 'status') + '">' + escapeHtml(flashMsg) + '</div>' : '') +
        '<nav class="admin-nav" aria-label="Admin sections">' + nav.join('') + '</nav>' +
        parts.join('') +
        '</div></main>' + renderFooter() + '<script>' + COMMON_JS + ADMIN_JS + ADMIN_TEAM_JS + ADMIN_LIVE_JS + SOCIAL_ADMIN_JS + '</script></body></html>';
}

function renderProviderLockedHtml(cfg, id, embed) {
    const name = escapeHtml(providerName(id));
    if (embed) {
        return '<!DOCTYPE html><html lang="en" class="embed" data-theme="dark"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Unavailable</title>' + FONT_LINKS +
            '<style>' + APP_CSS + 'html.embed body{display:grid;place-items:center;color:#f5f5f7;text-align:center;padding:24px}b{display:block;font-size:21px;font-weight:600;margin-bottom:6px}p{margin:0;color:#a1a1a6;font-size:15px}</style></head>' +
            '<body><div><b>' + name + ' is currently unavailable.</b><p>' + escapeHtml(cfg.lockMessage) + '</p></div></body></html>';
    }
    return renderHead({ title: name + ' is currently unavailable \u2014 VexoStream' }).replace('</head>', '<meta name="robots" content="noindex"></head>') +
        '<body>' + renderNav('') +
        '<main class="center-page"><div class="center-box">' +
        '<div class="maint-icon lock-icon">' + ICONS.lock + '</div>' +
        '<h1>' + name + ' is currently unavailable.</h1>' +
        '<p>' + escapeHtml(cfg.lockMessage) + '</p>' +
        '<div class="center-actions"><a class="btn" href="/">Back to home</a><a class="btn ghost" href="/status">System status</a></div>' +
        '</div></main>' + renderFooter() + '<script>' + COMMON_JS + '</script></body></html>';
}

function renderMaintenanceHtml() {
    return renderHead({ title: 'Be right back \u2014 VexoStream' }).replace('</head>', '<meta name="robots" content="noindex, nofollow"></head>') +
        '<body>' +
        '<main class="center-page" style="min-height:100vh;min-height:100dvh"><div class="center-box">' +
        '<div class="brand" style="justify-content:center;margin:0 auto 24px"><span class="brand-mark">' + VX_GLYPH + '</span><span class="brand-word">Vexo<b>Stream</b></span></div>' +
        '<div class="maint-icon">' + ICONS.wrench + '</div>' +
        '<h1>We&rsquo;ll be right back.</h1>' +
        '<p>VexoStream is getting a quick tune-up. Check back in a few minutes.</p>' +
        '<div class="center-actions"><a class="btn quiet" href="/status">System status</a></div>' +
        '</div></main></body></html>';
}

function render404Html() {
    return renderHead({ title: 'Page not found \u2014 VexoStream' }).replace('</head>', '<meta name="robots" content="noindex, nofollow"></head>') +
        '<body>' + renderNav('') +
        '<main class="center-page"><div class="center-box">' +
        '<p class="big-num" aria-hidden="true">404</p>' +
        '<h1>This page can&rsquo;t be found.</h1>' +
        '<p>The link may be broken, or the page may have moved.</p>' +
        '<div><span class="path" id="pathValue">/</span></div>' +
        '<form class="search center-search" action="/" method="GET" role="search">' + ICONS.search +
        '<label for="q404" class="sr-only">Search videos</label><input id="q404" name="q" type="search" placeholder="Search videos" autocomplete="off">' +
        '<button class="btn" type="submit">Search</button></form>' +
        '<div class="center-actions"><a href="/" class="btn">Back to home</a><button type="button" class="btn ghost" onclick="history.length > 1 ? history.back() : (location.href = \'/\')">Go back</button></div>' +
        '</div></main>' + renderFooter() +
        '<script>' + COMMON_JS + '(function(){var el=document.getElementById("pathValue");if(el)el.textContent=(location.pathname||"/")+(location.search||"");})();</script>' +
        '</body></html>';
}

// ============================================================================
