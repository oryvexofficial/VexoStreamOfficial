// ============================================================================
// MEMBERS (visitor accounts) + "log in to watch"
//
// - Visitors create an account (username + password) at /signup and sign in
//   at /login. Passwords are PBKDF2-SHA256 (100k, per-user salt), same as admins.
// - Admin > Members (needs the "Site mode" permission):
//     requireLogin   videos only play for signed-in members (default ON)
//     allowSignup    new visitors can create accounts (default ON)
//     embedsToo      /embed/ players also ask for an account (default OFF)
//   plus a member list with disable / enable / remove.
// - Not signed in + requireLogin: clicking any video shows "Please log in
//   first." (client), /video/... shows the same gate (server), and the stream
//   resolver API refuses (server), so the gate can't be skipped.
// - Session cookie "vx_member" = id.exp.sig, signed with the member's stamp,
//   so a password change or disable signs that member out everywhere.
//
// Storage (D1, binding DB):
//   settings.members_config  JSON flags
//   members                  accounts (created by the Worker too)
// ============================================================================
const MEMBER_COOKIE = 'vx_member';
const MEMBER_SESSION_TTL = 60 * 60 * 24 * 30;
const MEMBER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{2,23}$/;
const MEMBER_PW_MIN = 8;
const MEMBER_PLACEHOLDER = '__VX_MEMBER_STATE__';

let __membersReady = false;
let __membersCfg = { at: 0, cfg: null };
const __memberCache = new Map(); // id -> { at, m }
const __memberFails = new Map(); // ip -> { n, at }

function membersDefaults() { return { requireLogin: true, allowSignup: true, embedsToo: false, modelsLogin: true }; }
function normalizeMembersConfig(raw) {
    const s = raw && typeof raw === 'object' ? raw : {};
    return { requireLogin: s.requireLogin !== false, allowSignup: s.allowSignup !== false, embedsToo: s.embedsToo === true, modelsLogin: s.modelsLogin !== false };
}
async function getMembersConfig(env, fresh = false) {
    if (!fresh && __membersCfg.cfg && Date.now() - __membersCfg.at < 15000) return __membersCfg.cfg;
    let raw = null;
    try { raw = JSON.parse(await dbGetSetting(env, 'members_config', 'null')); } catch (_) {}
    const cfg = normalizeMembersConfig(raw);
    __membersCfg = { at: Date.now(), cfg };
    return cfg;
}
function membersCached() { return __membersCfg.cfg || membersDefaults(); }
async function saveMembersConfig(env, next) {
    const cfg = normalizeMembersConfig(next);
    const ok = await dbSetSetting(env, 'members_config', JSON.stringify(cfg));
    if (ok) __membersCfg = { at: Date.now(), cfg };
    return ok;
}

async function ensureMembersSchema(env) {
    if (__membersReady) return true;
    if (!env || !env.DB) return false;
    try {
        await env.DB.prepare(
            'CREATE TABLE IF NOT EXISTS members (' +
            'id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE COLLATE NOCASE, ' +
            'password_hash TEXT NOT NULL, salt TEXT NOT NULL, iterations INTEGER NOT NULL DEFAULT 100000, ' +
            'stamp TEXT NOT NULL, disabled INTEGER NOT NULL DEFAULT 0, ' +
            'ban_reason TEXT, banned_at TEXT, ' +
            'created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, last_login_at TEXT)'
        ).run();
        await env.DB.prepare('ALTER TABLE members ADD COLUMN ban_reason TEXT').run().catch(() => null);
        await env.DB.prepare('ALTER TABLE members ADD COLUMN banned_at TEXT').run().catch(() => null);
        __membersReady = true;
        return true;
    } catch (e) {
        __dbError = String((e && e.message) || e);
        return false;
    }
}

function memberThrottled(ip) {
    const r = __memberFails.get(ip);
    if (!r) return false;
    if (Date.now() - r.at > 10 * 60 * 1000) { __memberFails.delete(ip); return false; }
    return r.n >= 10;
}
function memberFailed(ip) {
    const r = __memberFails.get(ip);
    if (!r || Date.now() - r.at > 10 * 60 * 1000) __memberFails.set(ip, { n: 1, at: Date.now() });
    else r.n++;
}

function memberSecret() { return 'vx_member_' + STREAM_SIGN_SECRET; }

async function getMemberById(env, id, fresh = false) {
    const c = __memberCache.get(id);
    if (!fresh && c && Date.now() - c.at < 30000) return c.m;
    if (!(await ensureMembersSchema(env))) return null;
    const m = await env.DB.prepare('SELECT id, username, stamp, disabled, ban_reason, banned_at, created_at, last_login_at FROM members WHERE id = ?').bind(id).first().catch(() => null);
    __memberCache.set(id, { at: Date.now(), m: m || null });
    if (__memberCache.size > 2000) __memberCache.delete(__memberCache.keys().next().value);
    return m || null;
}

async function createMemberSession(m) {
    const exp = Math.floor(Date.now() / 1000) + MEMBER_SESSION_TTL;
    const sig = await generateHmacSha256('member:' + m.id + ':' + exp + ':' + m.stamp, memberSecret());
    return m.id + '.' + exp + '.' + sig.slice(0, 48);
}
function memberCookie(token) {
    return MEMBER_COOKIE + '=' + token + '; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=' + MEMBER_SESSION_TTL;
}
function memberCookieClear() {
    return MEMBER_COOKIE + '=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0';
}

async function parseMemberCookieRecord(request, env) {
    const cookie = request.headers.get('Cookie') || '';
    const mm = cookie.match(/(?:^|;\s*)vx_member=([0-9]+)\.([0-9]{9,11})\.([a-f0-9]{48})(?:;|$)/);
    if (!mm) return null;
    const id = parseInt(mm[1], 10), exp = parseInt(mm[2], 10);
    if (!id || Math.floor(Date.now() / 1000) > exp) return null;
    // Authorization state must be read fresh so a ban or stamp rotation in
    // another Worker isolate takes effect on the next authenticated request.
    const m = await getMemberById(env, id, true);
    if (!m) return null;
    const sig = await generateHmacSha256('member:' + m.id + ':' + exp + ':' + m.stamp, memberSecret());
    if (!timingSafeEqual(sig.slice(0, 48), mm[3])) return null;
    return m;
}

async function verifyMemberSession(request, env) {
    const m = await parseMemberCookieRecord(request, env);
    if (!m || Number(m.disabled)) return null;
    return { id: m.id, username: m.username };
}

function memberNameProblem(name) {
    if (!MEMBER_NAME_RE.test(name)) return 'Usernames are 3–24 letters, numbers, dots, dashes or underscores, starting with a letter or number.';
    if (/^(admin|owner|vexo|vexostream|support|root|system)/i.test(name)) return 'That username is reserved. Pick another one.';
    if (isOwnerName(name)) return 'That username belongs to the site owner. Log in with the owner account instead.';
    return '';
}

async function signupMember(env, name, pw, pw2) {
    const cfg = await getMembersConfig(env);
    if (!cfg.allowSignup) return { ok: false, error: 'New accounts are closed right now.' };
    name = String(name || '').trim();
    const nameErr = memberNameProblem(name);
    if (nameErr) return { ok: false, error: nameErr };
    pw = String(pw || '');
    if (pw.length < MEMBER_PW_MIN) return { ok: false, error: 'Use at least ' + MEMBER_PW_MIN + ' characters for your password.' };
    if (pw.length > 128) return { ok: false, error: 'Use at most 128 characters for your password.' };
    if (/^(.)\1+$/.test(pw) || pw.toLowerCase() === name.toLowerCase()) return { ok: false, error: 'That password is too easy to guess.' };
    if (pw2 !== undefined && pw !== String(pw2 || '')) return { ok: false, error: 'The two passwords don’t match.' };
    if (!(await ensureMembersSchema(env))) return { ok: false, error: 'Accounts are unavailable right now. Try again soon.' };
    if (!(await ensureAdminUsersSchema(env))) return { ok: false, error: 'Could not verify admin accounts right now. Try again soon.' };
    const adminRow = await getAdminRow(env, name);
    const legacyAdminName = Object.keys(ADMIN_USERS || {}).some(k => k.toLowerCase() === name.toLowerCase());
    if (adminRow || legacyAdminName) return { ok: false, error: 'That username belongs to an admin account. Log in with the existing admin account instead.' };
    const exists = await env.DB.prepare('SELECT id FROM members WHERE username = ?').bind(name).first().catch(() => null);
    if (exists) return { ok: false, error: 'That username is taken.' };
    const salt = randomHex(16), stamp = randomHex(8);
    const hash = await hashAdminPassword(pw, salt);
    try {
        const r = await env.DB.prepare('INSERT INTO members (username, password_hash, salt, iterations, stamp, last_login_at) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)').bind(name, hash, salt, ADMIN_PBKDF2_ITER, stamp).run();
        const id = Number((r && r.meta && r.meta.last_row_id) || 0) || Number(((await env.DB.prepare('SELECT id FROM members WHERE username = ?').bind(name).first()) || {}).id || 0);
        return { ok: true, member: { id, username: name, stamp } };
    } catch (_) {
        return { ok: false, error: 'That username is taken.' };
    }
}

async function loginMember(env, name, pw) {
    name = String(name || '').trim();
    if (!name || !pw) return { ok: false, error: 'Enter your username and password.' };
    if (!(await ensureMembersSchema(env))) return { ok: false, error: 'Accounts are unavailable right now. Try again soon.' };
    const row = await env.DB.prepare('SELECT id, username, password_hash, salt, iterations, stamp, disabled, ban_reason, banned_at FROM members WHERE username = ?').bind(name).first().catch(() => null);
    const hash = await hashAdminPassword(String(pw), row ? row.salt : '00', row ? Number(row.iterations) || ADMIN_PBKDF2_ITER : ADMIN_PBKDF2_ITER);
    if (!row || !timingSafeEqual(hash, row.password_hash)) return { ok: false, error: 'Wrong username or password.' };
    if (Number(row.disabled)) return { ok: false, banned: true, username: row.username, reason: row.ban_reason || '', bannedAt: row.banned_at || '', error: 'This account has been banned.' };
    await env.DB.prepare('UPDATE members SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?').bind(row.id).run().catch(() => null);
    return { ok: true, member: { id: row.id, username: row.username, stamp: row.stamp } };
}

async function listMembers(env, limit = 25) {
    if (!(await ensureMembersSchema(env))) return { total: 0, rows: [] };
    const t = await env.DB.prepare('SELECT COUNT(*) AS n FROM members').first().catch(() => null);
    const r = await env.DB.prepare('SELECT id, username, disabled, ban_reason, banned_at, created_at, last_login_at FROM members ORDER BY id DESC LIMIT ?').bind(limit).all().catch(() => null);
    return { total: Number((t && t.n) || 0), rows: (r && r.results) || [] };
}

async function handleMembersAdmin(env, form) {
    const action = String(form.get('action') || '');
    if (action === 'settings') {
        const ok = await saveMembersConfig(env, { requireLogin: form.get('require_login') === '1', allowSignup: form.get('allow_signup') === '1', embedsToo: form.get('embeds_too') === '1', modelsLogin: form.get('models_login') === '1' });
        return ok ? { ok: true, message: 'Member settings saved.' } : { ok: false, error: 'Could not save. ' + (__dbError || 'D1 write error.') };
    }
    if (!(await ensureMembersSchema(env))) return { ok: false, error: 'Accounts are unavailable right now.' };
    const rawId = parseInt(String(form.get('member_id') || ''), 10);
    const rawUsername = String(form.get('username') || '').trim();
    let m = rawId ? await getMemberById(env, rawId, true) : null;
    if (!m && rawUsername) {
        m = await env.DB.prepare('SELECT id, username, stamp, disabled, ban_reason, banned_at, created_at, last_login_at FROM members WHERE username = ? COLLATE NOCASE LIMIT 1').bind(rawUsername).first().catch(() => null);
    }
    if (!m) return { ok: false, error: rawUsername ? 'No member found with username "' + rawUsername + '".' : 'Member not found.' };
    const id = Number(m.id);
    if (action === 'disable' || action === 'ban' || action === 'enable' || action === 'unban') {
        const isBan = action === 'disable' || action === 'ban';
        const reason = String(form.get('reason') || '').trim().slice(0, 240);
        if (isBan) {
            await env.DB.prepare('UPDATE members SET disabled = 1, ban_reason = ?, banned_at = CURRENT_TIMESTAMP, stamp = ? WHERE id = ?').bind(reason || null, randomHex(8), id).run();
        } else {
            await env.DB.prepare('UPDATE members SET disabled = 0, ban_reason = NULL, banned_at = NULL, stamp = ? WHERE id = ?').bind(randomHex(8), id).run();
        }
        __memberCache.delete(id);
        return { ok: true, message: m.username + (isBan ? ' was banned and signed out.' : ' was unbanned.') };
    }
    if (action === 'remove') {
        await env.DB.prepare('DELETE FROM members WHERE id = ?').bind(id).run();
        __memberCache.delete(id);
        return { ok: true, message: m.username + ' was removed.' };
    }
    return { ok: false, error: 'Unknown action.' };
}

// Only same-site paths are allowed as "next".
function safeNext(raw) {
    const s = String(raw || '');
    return /^\/(?![\/\\])[^\s]*$/.test(s) && s.length < 600 ? s : '/';
}

// Per-request member state for the page (replaces MEMBER_PLACEHOLDER).
async function injectMemberState(response, request, env) {
    const type = response.headers.get('Content-Type') || '';
    if (!/text\/html/i.test(type) || !response.body) return response;
    const html = await response.text();
    if (!html.includes(MEMBER_PLACEHOLDER)) return new Response(html, response);
    let m = null;
    let admin = null;
    try {
        admin = await verifyAdminSession(request, env);
        if (!admin) m = await verifyMemberSession(request, env);
    } catch (_) {}
    const cfg = membersCached();
    const account = admin || m;
    const state = jsonForScript({
        in: !!account,
        name: account ? account.username : '',
        role: admin ? (admin.owner ? 'Owner' : 'Admin') : 'Member',
        required: !!cfg.requireLogin,
        models: !!cfg.modelsLogin,
        admin: admin ? ADMIN_PATH : '',
        signup: !!cfg.allowSignup
    });
    const headers = new Headers(response.headers);
    headers.set('Cache-Control', 'private, no-store');
    headers.delete('Content-Length');
    return new Response(html.split(MEMBER_PLACEHOLDER).join(state), { status: response.status, statusText: response.statusText, headers });
}

// ---------------------------------------------------------------- admin card
function renderMembersCard(cfg, list, user) {
    cfg = cfg || membersDefaults();
    list = list || { total: 0, rows: [] };
    const canSettings = adminCan(user, 'member_settings');
    const canModerate = adminCan(user, 'member_moderation');
    const canRemove = adminCan(user, 'member_remove');
    const rows = list.rows.map(r => '<li class="social-log-row"><div><b>' + escapeHtml(r.username) + (Number(r.disabled) ? ' <span class="hpill bad"><i></i>Banned</span>' : '') + '</b>' +
        '<small>Joined ' + escapeHtml(String(r.created_at || '')) + ' UTC' + (r.last_login_at ? ' · last sign-in ' + escapeHtml(String(r.last_login_at)) + ' UTC' : '') + (Number(r.disabled) && r.ban_reason ? ' · Reason: ' + escapeHtml(String(r.ban_reason)) : '') + '</small></div>' +
        '<div class="links" style="margin:0">' +
        (canModerate ? '<form method="POST" action="' + ADMIN_PATH + '/members"><input type="hidden" name="member_id" value="' + Number(r.id) + '"><input type="hidden" name="action" value="' + (Number(r.disabled) ? 'enable' : 'disable') + '"><button class="btn ' + (Number(r.disabled) ? 'quiet' : 'danger') + ' sm" type="submit">' + (Number(r.disabled) ? 'Unban' : 'Ban') + '</button></form>' : '') +
        (canRemove ? '<form method="POST" action="' + ADMIN_PATH + '/members" data-confirm="Remove ' + escapeHtml(r.username) + ' for good?"><input type="hidden" name="member_id" value="' + Number(r.id) + '"><input type="hidden" name="action" value="remove"><button class="btn danger sm" type="submit">Remove</button></form>' : '') +
        '</div></li>').join('');
    const settingsCard = '<section class="card span" id="members-settings"><div class="card-head"><div><div class="card-kicker">MEMBERS</div><h2>Accounts &amp; access</h2><p>When “Log in to watch” is on, visitors must create an account before any video plays. Clicking a video shows “Please log in first.”</p></div>' +
        '<div class="health"><span class="hpill' + (cfg.requireLogin ? '' : ' bad') + '"><i></i>' + (cfg.requireLogin ? 'Login required' : 'Open to everyone') + '</span></div></div>' +
        '<form method="POST" action="' + ADMIN_PATH + '/members"><input type="hidden" name="action" value="settings"><div class="social-flags">' +
        '<label><input type="checkbox" name="require_login" value="1"' + (cfg.requireLogin ? ' checked' : '') + '> Log in to watch (members only)</label>' +
        '<label><input type="checkbox" name="allow_signup" value="1"' + (cfg.allowSignup ? ' checked' : '') + '> Let new visitors create accounts</label>' +
        '<label><input type="checkbox" name="embeds_too" value="1"' + (cfg.embedsToo ? ' checked' : '') + '> Embedded players need an account too</label>' +
        '<label><input type="checkbox" name="models_login" value="1"' + (cfg.modelsLogin ? ' checked' : '') + '> Models pages need an account (list + profiles)</label>' +
        '</div><div class="actions-row"><button class="btn sm" type="submit">Save member settings</button><a class="btn quiet sm" href="/signup" target="_blank" rel="noopener">Open sign-up page</a></div></form></section>';
    const banByUsernameForm = canModerate
        ? '<form method="POST" action="' + ADMIN_PATH + '/members" class="add-form" style="margin-bottom:18px;padding-bottom:18px;border-bottom:1px solid var(--line)">' +
          '<div class="add-fields">' +
          '<label class="opt"><span>Ban / Unban by username</span><input name="username" required maxlength="32" autocomplete="off" spellcheck="false" placeholder="Exact member username"></label>' +
          '<label class="opt"><span>Ban reason (optional)</span><input name="reason" maxlength="240" autocomplete="off" placeholder="e.g. Spam or policy violation"></label>' +
          '</div><div class="actions-row">' +
          '<button class="btn danger sm" type="submit" name="action" value="ban">Ban user</button>' +
          '<button class="btn quiet sm" type="submit" name="action" value="unban">Unban user</button>' +
          '<a class="btn quiet sm" href="/banned" target="_blank" rel="noopener">Preview ban page</a>' +
          '</div></form>'
        : '';
    const membersCard = '<section class="card span" id="members-moderation"><div class="card-head"><div><div class="card-kicker">MEMBERS</div><h2>Members &amp; Bans</h2><p>Newest first. Banning immediately signs the user out and shows the official ban page.</p></div><div class="health"><span class="hpill"><i></i>' + list.total + (list.total === 1 ? ' member' : ' members') + '</span></div></div>' +
        banByUsernameForm +
        (rows ? '<ul class="social-log">' + rows + '</ul>' : '<p>No members yet.</p>') + '</section>';
    return (canSettings ? settingsCard : '') + (canModerate || canRemove ? membersCard : '');
}

// ---------------------------------------------------------------- public pages
function renderAuthHtml(mode, opts: any = {}) {
    const cfg = membersCached();
    const next = safeNext(opts.next);
    const isSignup = mode === 'signup' && cfg.allowSignup;
    const q = next !== '/' ? '?next=' + encodeURIComponent(next) : '';
    const err = opts.error ? '<p class="auth-err" role="alert">' + escapeHtml(opts.error) + '</p>' : '';
    const note = opts.gate ? '<p class="auth-gate"><i aria-hidden="true">' + ICONS.lock + '</i>' + (opts.gateText || 'Please log in first. Videos are for members only.') + '</p>' : '';
    const adminNote = '<p class="auth-switch auth-admin-note">Admins and owners: log in with your existing admin account. You don’t need to create a separate member account.</p>';
    const form = isSignup
        ? '<form class="auth-form" method="POST" action="/account/signup" novalidate>' +
          '<input type="hidden" name="next" value="' + escapeHtml(next) + '">' +
          '<label class="auth-field"><span>Username</span><input name="username" required minlength="3" maxlength="24" autocomplete="username" autocapitalize="none" spellcheck="false" value="' + escapeHtml(opts.username || '') + '" placeholder="pick a name" dir="ltr"></label>' +
          '<label class="auth-field"><span>Password</span><input type="password" name="password" required minlength="' + MEMBER_PW_MIN + '" maxlength="128" autocomplete="new-password" placeholder="' + MEMBER_PW_MIN + '+ characters" dir="ltr"></label>' +
          '<label class="auth-field"><span>Confirm password</span><input type="password" name="password2" required minlength="' + MEMBER_PW_MIN + '" maxlength="128" autocomplete="new-password" placeholder="type it again" dir="ltr"></label>' +
          '<label class="auth-check"><input type="checkbox" name="adult" value="1" required> I’m 18 or older</label>' +
          '<button class="btn auth-btn" type="submit">Create account</button></form>' +
          '<p class="auth-switch">Already a member? <a href="/login' + q + '">Log in</a></p>'
        : '<form class="auth-form" method="POST" action="/account/login" novalidate>' +
          '<input type="hidden" name="next" value="' + escapeHtml(next) + '">' +
          '<label class="auth-field"><span>Username</span><input name="username" required maxlength="24" autocomplete="username" autocapitalize="none" spellcheck="false" value="' + escapeHtml(opts.username || '') + '" placeholder="your username" dir="ltr"></label>' +
          '<label class="auth-field"><span>Password</span><input type="password" name="password" required maxlength="128" autocomplete="current-password" placeholder="your password" dir="ltr"></label>' +
          '<button class="btn auth-btn" type="submit">Log in</button></form>' +
          (cfg.allowSignup ? '<p class="auth-switch">New here? <a href="/signup' + q + '">Create a free account</a></p>' : '');
    const title = isSignup ? 'Create your account' : 'Welcome back';
    return renderHead({ meta: opts.meta || '', title: (isSignup ? 'Create account' : 'Log in') + ' \u2014 VexoStream' }).replace('</head>', /name="robots"/.test(opts.meta || '') ? '</head>' : '<meta name="robots" content="noindex, follow"></head>') +
        '<body>' + renderNav('') +
        '<main class="auth-page"><div class="auth-card">' +
        '<span class="vf vf-tl"></span><span class="vf vf-tr"></span><span class="vf vf-bl"></span><span class="vf vf-br"></span>' +
        '<a class="brand auth-brand" href="/" aria-label="VexoStream home"><span class="brand-mark">' + VX_GLYPH + '</span><span class="brand-word">Vexo<b>Stream</b></span></a>' +
        (cfg.allowSignup ? '<nav class="auth-tabs" aria-label="Account"><a href="/login' + q + '"' + (isSignup ? '' : ' aria-current="page"') + '>Log in</a><a href="/signup' + q + '"' + (isSignup ? ' aria-current="page"' : '') + '>Sign up</a></nav>' : '') +
        '<h1>' + title + '</h1>' + note + err + adminNote + form +
        '</div></main>' + renderFooter() + '<script>' + COMMON_JS + '</script></body></html>';
}

function renderEmbedGateHtml(origin, next) {
    return '<!DOCTYPE html><html lang="en" class="embed" data-theme="dark"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Please log in first</title>' + FONT_LINKS +
        '<style>' + APP_CSS + 'html.embed body{display:grid;place-items:center;min-height:100vh;color:#f5f5f7;text-align:center;padding:24px;background:#05070c}b{display:block;font:800 24px/1.1 var(--font-display);letter-spacing:-.03em;margin-bottom:8px}p{margin:0 0 18px;color:#a1a1a6;font-size:15px}a.btn{display:inline-flex}</style></head>' +
        '<body><div><b>Please log in first.</b><p>Videos are for VexoStream members.</p><a class="btn" href="' + escapeHtml(origin + '/login?next=' + encodeURIComponent(next)) + '" target="_top">Log in to watch</a></div></body></html>';
}

function renderBannedHtml(opts: any = {}) {
    const username = String(opts.username || '').trim();
    const reason = String(opts.reason || '').trim();
    const bannedAt = String(opts.bannedAt || '').trim();
    const safeReason = reason || 'Your account was suspended by an administrator for violating VexoStream’s terms or community guidelines.';
    return renderHead({ title: 'Account Suspended \u2014 VexoStream' }).replace('</head>', '<meta name="robots" content="noindex, nofollow"></head>') +
        '<body>' + renderNav('') +
        '<main class="center-page"><div class="center-box" style="max-width:540px">' +
        '<div class="maint-icon" style="color:var(--red,#f85452);background:rgba(248,84,82,.12);border-color:rgba(248,84,82,.32)">' + ICONS.lock + '</div>' +
        '<p class="hpill bad" style="display:inline-flex;margin:0 auto 14px"><i></i>Account Suspended</p>' +
        '<h1>This account has been banned.</h1>' +
        (username ? '<p style="margin-bottom:8px">Account: <b>' + escapeHtml(username) + '</b></p>' : '') +
        '<p style="color:var(--fg-2)">' + escapeHtml(safeReason) + '</p>' +
        (bannedAt ? '<p style="font-size:12px;color:var(--fg-3);margin-top:8px">Suspended at ' + escapeHtml(bannedAt) + ' UTC</p>' : '') +
        '<div class="center-actions" style="margin-top:22px">' +
        '<a class="btn" href="/">Back to home</a>' +
        '<a class="btn ghost" href="/login">Log in with another account</a>' +
        '<a class="btn quiet" href="/social">Contact support</a>' +
        '</div>' +
        '</div></main>' + renderFooter() + '<script>' + COMMON_JS + '</script></body></html>';
}
