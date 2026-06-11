'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http   = require('http');
const handler = require('../handler');

const TEST_UUID = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';

function mockJson(data) {
  return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(data)) };
}

global.fetch = async (url) => {
  const s = String(url);
  if (s.includes('/rest/v1/watchlists') && s.includes('is_featured')) return mockJson([]);
  if (s.includes('/rest/v1/watchlists'))       return mockJson([{ name: 'My List', description: '', visibility: 'public' }]);
  if (s.includes('/rest/v1/watchlist_movies'))  return mockJson([
    { media_id: 1, media_type: 'movie', title: 'Handler Movie', poster_path: null,
      backdrop_path: null, release_date: '2020-01-01', genre_ids: [], runtime: 90 }
  ]);
  if (s.includes('/rest/v1/user_profiles'))     return mockJson([]); // unknown user
  if (s.includes('api.themoviedb.org'))         return mockJson({ imdb_id: 'tt0000001' });
  return { ok: false, status: 404, json: async () => ({}) };
};

// ── HTTP helper ─────────────────────────────────────────────────────────────

function request(server, method, path, body) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    const opts = { hostname: '127.0.0.1', port, path, method,
                   headers: body ? { 'Content-Type': 'application/json' } : {} };
    const req = http.request(opts, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (_) {}
        resolve({ status: res.statusCode, text, json, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function get(server, path) { return request(server, 'GET', path, null); }

let server;

before(async () => {
  server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
});

after(async () => {
  await new Promise((resolve, reject) =>
    server.close(err => err ? reject(err) : resolve())
  );
});

// ── Route tests ─────────────────────────────────────────────────────────────

test('GET /health → 200 {ok:true}', async () => {
  const r = await get(server, '/health');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { ok: true });
});

test('GET / → 200 HTML configure page', async () => {
  const r = await get(server, '/');
  assert.equal(r.status, 200);
  assert.ok(r.headers['content-type'].includes('text/html'));
  assert.ok(r.text.includes('CineCollab'));
});

test('GET /configure → 200 HTML', async () => {
  const r = await get(server, '/configure');
  assert.equal(r.status, 200);
  assert.ok(r.headers['content-type'].includes('text/html'));
});

test('OPTIONS → 204 with CORS headers', async () => {
  const r = await request(server, 'OPTIONS', '/health', null);
  assert.equal(r.status, 204);
  assert.equal(r.headers['access-control-allow-origin'], '*');
});

test('GET /<uuid>/manifest.json → valid manifest at version 1.2.0', async () => {
  const r = await get(server, '/' + TEST_UUID + '/manifest.json');
  assert.equal(r.status, 200);
  assert.ok(r.json, 'should return JSON');
  assert.equal(r.json.version, '1.2.0');
  assert.ok(Array.isArray(r.json.catalogs));
  assert.ok(r.json.types.includes('movie'));
});

test('GET /api/user-lists (no username) → 400', async () => {
  const r = await get(server, '/api/user-lists');
  assert.equal(r.status, 400);
});

test('GET /api/user-lists?username=unknown → 404', async () => {
  const r = await get(server, '/api/user-lists?username=nonexistentuser_xyz');
  assert.equal(r.status, 404);
});

test('GET /api/unknown-endpoint → 404', async () => {
  const r = await get(server, '/api/totally-unknown');
  assert.equal(r.status, 404);
});

test('manifest response has CORS header', async () => {
  const r = await get(server, '/' + TEST_UUID + '/manifest.json');
  assert.equal(r.headers['access-control-allow-origin'], '*');
});
