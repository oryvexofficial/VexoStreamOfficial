import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const api = await readFile(new URL('../src/05e-api-v1.ts', import.meta.url), 'utf8');
const router = await readFile(new URL('../src/07-router.ts', import.meta.url), 'utf8');
const wrangler = await readFile(new URL('../wrangler.toml', import.meta.url), 'utf8');
const migration = await readFile(new URL('../migrations/2026-11-11-api-sessions.sql', import.meta.url), 'utf8');

test('Worker exposes the app pages through the versioned API', () => {
  for (const route of [
    "path === '/health'", "path === '/config'", "path === '/catalog'", "path === '/search'",
    "path === '/auth/signup'", "path === '/auth/login'", "path === '/auth/logout'", "path === '/account'",
    "path === '/videos/extract'", "path === '/models'", "path === '/status'", "path === '/social'",
    "path === '/developers'", "path === '/check-host/start'", "path === '/check-host/result'"
  ]) assert.ok(api.includes(route), `missing API contract: ${route}`);
  assert.ok(router.includes('handleAppApiV1(request, url, env, ctx)'));
  assert.ok(router.includes("'Access-Control-Allow-Headers': 'Authorization, Content-Type"));
});

test('API is routed on the requested subdomain and sessions persist hashes only', () => {
  assert.ok(wrangler.includes('api.vexostream.bond/*'));
  assert.ok(migration.includes('token_hash TEXT PRIMARY KEY'));
  assert.ok(migration.includes('revoked_at TEXT'));
  assert.ok(!migration.toLowerCase().includes('token TEXT'));
});

const worker = (await import('../dist/worker.js')).default;

test('API health endpoint answers on api.vexostream.bond with no private key in the client', async () => {
  const request = new Request('https://api.vexostream.bond/api/v1/health', {
    headers: { 'User-Agent': 'VexoStream-Test/1.0', Accept: 'application/json' }
  });
  const response = await worker.fetch(request, { STREAM_SIGN_SECRET: 'test-secret-for-ci-only', EDGE_TOKEN: 'edge-test-token' }, { waitUntil() {} });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), '*');
  const payload = await response.json();
  assert.equal(payload.ok, true);
  assert.equal(payload.version, 1);
});

test('API preflight accepts the bearer Authorization header', async () => {
  const request = new Request('https://api.vexostream.bond/api/v1/account', {
    method: 'OPTIONS',
    headers: { Origin: 'null', 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization' }
  });
  const response = await worker.fetch(request, { STREAM_SIGN_SECRET: 'test-secret-for-ci-only', EDGE_TOKEN: 'edge-test-token' }, { waitUntil() {} });
  assert.equal(response.status, 204);
  assert.match(response.headers.get('Access-Control-Allow-Headers') || '', /Authorization/i);
});
