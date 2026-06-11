'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildManifest, buildCatalog, buildMeta, parseConfig, DISCOVER_ID } = require('../addon');

const TEST_UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const MOVIE_TMDB  = 12345;
const TV_TMDB     = 67890;
const NO_IMDB_TMDB = 99999;

function mockJson(data) {
  return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(data)) };
}

global.fetch = async (url) => {
  const s = String(url);
  if (s.includes('/rest/v1/watchlists') && s.includes('is_featured')) return mockJson([]);
  if (s.includes('/rest/v1/watchlists'))      return mockJson([{ name: 'Test List', description: 'desc', visibility: 'public' }]);
  if (s.includes('/rest/v1/watchlist_movies')) return mockJson([
    { media_id: MOVIE_TMDB,   media_type: 'movie', title: 'Test Movie',      poster_path: '/p.jpg', backdrop_path: null, release_date: '2020-01-01', genre_ids: [28, 878], runtime: 120 },
    { media_id: TV_TMDB,      media_type: 'tv',    title: 'Test Show',       poster_path: null,      backdrop_path: null, release_date: '2021-01-01', genre_ids: [18],      runtime: null },
    { media_id: NO_IMDB_TMDB, media_type: 'movie', title: 'No IMDB Movie',   poster_path: null,      backdrop_path: null, release_date: '2022-01-01', genre_ids: [],        runtime: 90 },
  ]);
  if (s.includes('api.themoviedb.org')) {
    if (s.includes('/movie/' + MOVIE_TMDB))  return mockJson({ imdb_id: 'tt1234567' });
    if (s.includes('/tv/'    + TV_TMDB))     return mockJson({ imdb_id: 'tt9876543' });
    return mockJson({ imdb_id: null });
  }
  return { ok: false, status: 404, json: async () => ({}) };
};

// ── buildManifest ──────────────────────────────────────────────────────────

test('buildManifest: version is 1.2.0 and required fields present', async () => {
  const manifest = await buildManifest(parseConfig(TEST_UUID), null);
  assert.equal(manifest.version, '1.2.0');
  assert.ok(Array.isArray(manifest.catalogs));
  assert.ok(manifest.types.includes('movie'));
  assert.ok(manifest.types.includes('series'));
  assert.ok(manifest.idPrefixes.includes('tt'));
  assert.ok(manifest.idPrefixes.includes('cc:'));
  assert.ok(manifest.resources.some(r => r === 'catalog' || (r && r.name === 'catalog')));
});

test('buildManifest: Discover catalogs present when d_on token set', async () => {
  const manifest = await buildManifest(parseConfig('d_on,' + TEST_UUID), null);
  const discover = manifest.catalogs.filter(c => c.id === DISCOVER_ID);
  assert.equal(discover.length, 2, 'one movie + one series Discover catalog');
  assert.ok(discover.some(c => c.type === 'movie'));
  assert.ok(discover.some(c => c.type === 'series'));
});

test('buildManifest: Discover catalogs absent without d_on token', async () => {
  const manifest = await buildManifest(parseConfig(TEST_UUID), null);
  assert.equal(manifest.catalogs.filter(c => c.id === DISCOVER_ID).length, 0);
});

test('buildManifest: watchlist catalogs have search and sort extras', async () => {
  const manifest = await buildManifest(parseConfig(TEST_UUID), null);
  const watchlistCats = manifest.catalogs.filter(c => c.id !== DISCOVER_ID);
  assert.ok(watchlistCats.length > 0);
  for (const cat of watchlistCats) {
    assert.ok(cat.extra.some(e => e.name === 'search'), 'missing search extra');
    assert.ok(cat.extra.some(e => e.name === 'sort'),   'missing sort extra');
  }
});

// ── buildCatalog ───────────────────────────────────────────────────────────

test('buildCatalog: movie type returns only movie-type items', async () => {
  const { metas } = await buildCatalog('cc_' + TEST_UUID, 'movie', {}, null);
  assert.equal(metas.length, 2, '2 movies in the fixture (Test Movie + No IMDB Movie)');
  assert.ok(metas.every(m => m.type === 'movie'));
});

test('buildCatalog: series type returns only TV items', async () => {
  const { metas } = await buildCatalog('cc_' + TEST_UUID, 'series', {}, null);
  assert.equal(metas.length, 1);
  assert.equal(metas[0].type, 'series');
  assert.equal(metas[0].name, 'Test Show');
});

test('buildCatalog: uses tt-prefixed id when TMDB resolves imdb_id', async () => {
  const { metas } = await buildCatalog('cc_' + TEST_UUID, 'movie', {}, null);
  const m = metas.find(x => x.name === 'Test Movie');
  assert.ok(m, 'Test Movie should appear');
  assert.equal(m.id, 'tt1234567');
});

test('buildCatalog: falls back to cc: id when no imdb_id from TMDB', async () => {
  const { metas } = await buildCatalog('cc_' + TEST_UUID, 'movie', {}, null);
  const m = metas.find(x => x.name === 'No IMDB Movie');
  assert.ok(m, 'No IMDB Movie should appear');
  assert.ok(m.id.startsWith('cc:movie:'), 'fallback id must start with cc:movie:');
});

test('buildCatalog: metas have no _tmdb or _mediaType internal fields', async () => {
  const { metas } = await buildCatalog('cc_' + TEST_UUID, 'movie', {}, null);
  for (const m of metas) {
    assert.ok(!('_tmdb'      in m), '_tmdb should be stripped');
    assert.ok(!('_mediaType' in m), '_mediaType should be stripped');
  }
});

// ── buildMeta ─────────────────────────────────────────────────────────────

test('buildMeta: finds item by cc: fallback id', async () => {
  const { meta } = await buildMeta([TEST_UUID], 'movie', 'cc:movie:' + NO_IMDB_TMDB, null);
  assert.ok(meta, 'should find the item');
  assert.equal(meta.name, 'No IMDB Movie');
  assert.ok(!('_tmdb' in meta));
});

test('buildMeta: returns null for an id not in any list', async () => {
  const { meta } = await buildMeta([TEST_UUID], 'movie', 'cc:movie:000000', null);
  assert.equal(meta, null);
});
