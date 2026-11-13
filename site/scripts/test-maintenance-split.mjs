import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.caches ??= { default: { async match() {}, async put() {} } };
const worker = (await import('../dist/worker.js')).default;
const settings = new Map([
  ['members_config', JSON.stringify({ requireLogin: false, embedsToo: false, modelsLogin: false })],
]);
const appKey = 'split-maintenance-test-key';
const db = {
  prepare(sql) {
    return {
      sql, values: [],
      bind(...values) { this.values = values; return this; },
      async run() { return { success: true, meta: { changes: 1 } }; },
      async all() { return { results: [{ name: 'id' }, { name: 'key' }, { name: 'value' }, { name: 'updated_at' }] }; },
      async first() {
        if (/SELECT value FROM settings/i.test(this.sql)) {
          const value = settings.get(String(this.values[0]));
          return value === undefined ? null : { value };
        }
        return null;
      },
    };
  },
};
const env = { STREAM_SIGN_SECRET: 'split-test-secret', EDGE_TOKEN: 'split-test-edge', APP_KEY: appKey, DB: db };
const ctx = { waitUntil() {} };
const headers = { 'User-Agent': 'Mozilla/5.0 SplitMaintenanceTest/1.0', 'Accept-Language': 'en-US,en;q=0.9' };
const video = 'https://www.xvideos.com/video123456/example';
const token = Buffer.from(video).toString('base64url');
const appPath = `/embed/for/app/${token}`;
const normalPath = `/embed/${token}`;
async function get(path, options = {}) {
  const host = options.api ? 'https://api.vexostream.bond' : 'https://vexostream.bond';
  return worker.fetch(new Request(host + path, { headers: { ...headers, ...(options.api ? { 'X-App-Key': appKey } : {}), ...(options.headers || {}) } }), env, ctx);
}
function setModes(site, app) {
  settings.set('site_maintenance_mode', site ? 'on' : 'off');
  settings.set('app_maintenance_mode', app ? 'on' : 'off');
}

test('site-only maintenance leaves app API and app embed reachable', async () => {
  setModes(true, false);
  assert.equal((await get('/')).status, 503);
  assert.equal((await get(normalPath)).status, 503);
  assert.equal((await get('/api/v1/health', { api: true })).status, 200);
  assert.equal((await get(appPath)).status, 200);
  assert.equal((await get(normalPath + '?app_player=1')).status, 200);
});

test('app-only maintenance leaves website reachable and blocks app entry points', async () => {
  setModes(false, true);
  assert.equal((await get('/')).status, 200);
  assert.equal((await get(normalPath)).status, 200);
  assert.equal((await get('/api/v1/health', { api: true })).status, 503);
  assert.equal((await get(appPath)).status, 503);
  assert.equal((await get(normalPath + '?app_player=1')).status, 503);
  const extraction = await get('/api/extract?url=' + encodeURIComponent(video), { headers: { Referer: 'https://vexostream.bond' + appPath } });
  assert.equal(extraction.status, 503);
  assert.equal((await extraction.json()).code, 'maintenance');
  const memberLogin = await worker.fetch(new Request('https://api.vexostream.bond/api/v1/auth/login', {
    method: 'POST', headers: { ...headers, 'X-App-Key': appKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'ordinary', password: 'password123' }),
  }), env, ctx);
  assert.equal(memberLogin.status, 503);
});

test('both modes and legacy fallback behave consistently', async () => {
  setModes(true, true);
  assert.equal((await get('/')).status, 503);
  assert.equal((await get('/api/v1/health', { api: true })).status, 503);
  setModes(false, false);
  assert.equal((await get('/')).status, 200);
  assert.equal((await get('/api/v1/health', { api: true })).status, 200);
  settings.delete('site_maintenance_mode'); settings.delete('app_maintenance_mode');
  settings.set('maintenance_mode', 'on');
  assert.equal((await get('/')).status, 503);
  assert.equal((await get('/api/v1/health', { api: true })).status, 503);
  settings.set('site_maintenance_mode', 'off');
  assert.equal((await get('/')).status, 200);
  assert.equal((await get('/api/v1/health', { api: true })).status, 503);
});


test('a settings read failure does not silently bypass maintenance', async () => {
  const brokenDb = { prepare() { return { bind() { return this; }, async first() { throw new Error('D1 failure'); }, async all() { throw new Error('D1 failure'); }, async run() { throw new Error('D1 failure'); } }; } };
  const response = await worker.fetch(new Request('https://vexostream.bond/ordinary-page', { headers }), { ...env, DB: brokenDb }, ctx);
  assert.equal(response.status, 503);
});

test('site maintenance still permits the app embed to extract through its first-party referer', async () => {
  setModes(true, false);
  const page = await get(appPath);
  const html = await page.text();
  const config = html.match(/window\.VX=(\{.*?\});window\.API_TOKEN/s);
  assert.ok(config);
  const browserToken = JSON.parse(config[1]).token;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ status: 'success', streams: { qualities: [], fallback: [] } }), { headers: { 'Content-Type': 'application/json' } });
  try {
    const path = '/api/extract?url=' + encodeURIComponent(video) + '&token=' + encodeURIComponent(browserToken);
    const result = await get(path, { headers: { Referer: 'https://vexostream.bond' + appPath, 'X-Edge-Token': browserToken } });
    assert.equal(result.status, 200, await result.clone().text());
    const website = await get(path, { headers: { Referer: 'https://vexostream.bond' + normalPath, 'X-Edge-Token': browserToken } });
    assert.equal(website.status, 503);
  } finally { globalThis.fetch = originalFetch; }
});
