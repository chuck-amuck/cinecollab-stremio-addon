'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  traktHistoryToRows, dedupeAgainstExisting, newestWatchedAt, normalizeTraktToken,
  traktWatchedToWatchlistRows
} = require('../traktSync');

const UID = 'ee5cf772-5024-44ce-aa6e-245c72e28456';

const MOVIE_ROWS = [
  { watched_at: '2025-11-22T03:23:24.000Z', movie: { title: 'A', ids: { tmdb: 44214, imdb: 'tt1' } } },
  { watched_at: '2025-12-01T10:00:00.000Z', movie: { title: 'B', ids: { tmdb: 99999 } } },
  { watched_at: '2025-12-02T10:00:00.000Z', movie: { title: 'No TMDB', ids: { imdb: 'tt9' } } }, // skipped
];

const EPISODE_ROWS = [
  { watched_at: '2025-11-10T00:00:00.000Z', show: { title: 'Show X', ids: { tmdb: 1399 } } },
  { watched_at: '2025-12-05T00:00:00.000Z', show: { title: 'Show X', ids: { tmdb: 1399 } } }, // later
  { watched_at: '2025-11-15T00:00:00.000Z', show: { title: 'No id', ids: {} } }, // skipped
];

// ── traktHistoryToRows ──────────────────────────────────────────────────

test('movies map 1:1 with tmdb media_id and movie type', () => {
  const rows = traktHistoryToRows(MOVIE_ROWS, [], UID, false);
  assert.equal(rows.length, 2, 'two movies have a tmdb id');
  assert.deepEqual(rows[0], { user_id: UID, media_id: 44214, media_type: 'movie', watched_at: '2025-11-22T03:23:24.000Z' });
  assert.ok(rows.every(r => r.media_type === 'movie'));
});

test('movies without a tmdb id are skipped', () => {
  const rows = traktHistoryToRows(MOVIE_ROWS, [], UID, false);
  assert.ok(!rows.some(r => r.watched_at === '2025-12-02T10:00:00.000Z'));
});

test('duplicate movie plays (rewatches) collapse to one row with the latest watched_at', () => {
  const rows = traktHistoryToRows([
    { watched_at: '2025-01-01T00:00:00.000Z', movie: { ids: { tmdb: 500 } } },
    { watched_at: '2025-06-01T00:00:00.000Z', movie: { ids: { tmdb: 500 } } },
  ], [], UID, false);
  assert.equal(rows.length, 1, 'two plays of the same movie collapse to one row');
  assert.equal(rows[0].watched_at, '2025-06-01T00:00:00.000Z');
});

test('episodes are ignored when includeShows is false', () => {
  const rows = traktHistoryToRows(MOVIE_ROWS, EPISODE_ROWS, UID, false);
  assert.ok(rows.every(r => r.media_type === 'movie'));
});

test('episodes collapse to one tv row per show using latest watched_at', () => {
  const rows = traktHistoryToRows([], EPISODE_ROWS, UID, true);
  const tv = rows.filter(r => r.media_type === 'tv');
  assert.equal(tv.length, 1, 'two episodes of the same show collapse to one');
  assert.deepEqual(tv[0], { user_id: UID, media_id: 1399, media_type: 'tv', watched_at: '2025-12-05T00:00:00.000Z' });
});

test('shows without a tmdb id are skipped', () => {
  const rows = traktHistoryToRows([], EPISODE_ROWS, UID, true);
  assert.equal(rows.filter(r => r.media_type === 'tv').length, 1);
});

// ── dedupeAgainstExisting ────────────────────────────────────────────────

test('rows already in CineCollab are filtered out', () => {
  const rows = traktHistoryToRows(MOVIE_ROWS, [], UID, false);
  const existing = new Set(['44214:movie']); // first movie already recorded
  const fresh = dedupeAgainstExisting(rows, existing);
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0].media_id, 99999);
});

test('empty existing set keeps everything', () => {
  const rows = traktHistoryToRows(MOVIE_ROWS, [], UID, false);
  assert.equal(dedupeAgainstExisting(rows, new Set()).length, rows.length);
});

// ── newestWatchedAt ───────────────────────────────────────────────────────

test('newestWatchedAt returns the max ISO timestamp', () => {
  assert.equal(
    newestWatchedAt([{ watched_at: '2025-11-22T03:23:24.000Z' }, { watched_at: '2025-12-01T10:00:00.000Z' }]),
    '2025-12-01T10:00:00.000Z'
  );
});

test('newestWatchedAt returns null for no rows', () => {
  assert.equal(newestWatchedAt([]), null);
});

// ── normalizeTraktToken ───────────────────────────────────────────────────

test('normalizeTraktToken computes expires_at in ms from created_at + expires_in', () => {
  const tok = normalizeTraktToken({ access_token: 'a', refresh_token: 'r', created_at: 1000, expires_in: 200 });
  assert.equal(tok.expires_at, (1000 + 200) * 1000);
  assert.equal(tok.access_token, 'a');
  assert.equal(tok.refresh_token, 'r');
});

// ── traktWatchedToWatchlistRows ───────────────────────────────────────────

const WATCHED_MOVIES = [
  { plays: 2, last_watched_at: '2025-12-01T00:00:00.000Z', movie: { title: 'A', ids: { tmdb: 111, imdb: 'tt1' } } },
  { plays: 1, last_watched_at: '2025-11-01T00:00:00.000Z', movie: { title: 'No TMDB', ids: { imdb: 'tt9' } } },
];
const WATCHED_SHOWS = [
  { plays: 10, last_watched_at: '2025-12-05T00:00:00.000Z', show: { title: 'Show X', ids: { tmdb: 1399 } } },
  { plays: 3,  last_watched_at: '2025-11-10T00:00:00.000Z', show: { title: 'No id',  ids: {} } },
];

test('traktWatchedToWatchlistRows maps movies to { tmdbId, mediaType, watchedAt, traktTitle }', () => {
  const rows = traktWatchedToWatchlistRows(WATCHED_MOVIES, []);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], { tmdbId: 111, mediaType: 'movie', watchedAt: '2025-12-01T00:00:00.000Z', traktTitle: 'A' });
});

test('traktWatchedToWatchlistRows maps shows to { tmdbId, mediaType, watchedAt, traktTitle }', () => {
  const rows = traktWatchedToWatchlistRows([], WATCHED_SHOWS);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], { tmdbId: 1399, mediaType: 'tv', watchedAt: '2025-12-05T00:00:00.000Z', traktTitle: 'Show X' });
});

test('traktWatchedToWatchlistRows handles movies and shows together', () => {
  const rows = traktWatchedToWatchlistRows(WATCHED_MOVIES, WATCHED_SHOWS);
  assert.equal(rows.length, 2);
  assert.equal(rows.filter(r => r.mediaType === 'movie').length, 1);
  assert.equal(rows.filter(r => r.mediaType === 'tv').length, 1);
});

test('traktWatchedToWatchlistRows skips entries without a TMDB id', () => {
  const rows = traktWatchedToWatchlistRows(WATCHED_MOVIES, WATCHED_SHOWS);
  assert.ok(rows.every(r => r.tmdbId !== undefined && r.tmdbId !== null));
});

test('traktWatchedToWatchlistRows returns empty array for empty inputs', () => {
  assert.deepEqual(traktWatchedToWatchlistRows([], []), []);
  assert.deepEqual(traktWatchedToWatchlistRows(null, null), []);
});

test('traktWatchedToWatchlistRows preserves last_watched_at as watchedAt', () => {
  const rows = traktWatchedToWatchlistRows([
    { last_watched_at: '2025-01-10T00:00:00.000Z', movie: { ids: { tmdb: 1 } } },
    { last_watched_at: '2025-06-20T00:00:00.000Z', movie: { ids: { tmdb: 2 } } },
  ], []);
  assert.equal(rows[0].watchedAt, '2025-01-10T00:00:00.000Z');
  assert.equal(rows[1].watchedAt, '2025-06-20T00:00:00.000Z');
});
