'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { applyExtras } = require('../addon');
const handler = require('../handler');
const { parseExtras } = handler;

// Predictable sample set
const METAS = [
  { name: 'The Matrix',      genres: ['Action', 'Science Fiction'], releaseInfo: '1999' },
  { name: 'Matrix Reloaded', genres: ['Action', 'Science Fiction'], releaseInfo: '2003' },
  { name: 'The Dark Knight', genres: ['Action', 'Crime', 'Drama'],  releaseInfo: '2008' },
  { name: 'Toy Story',       genres: ['Animation', 'Family'],       releaseInfo: '1995' },
];

// ── applyExtras ────────────────────────────────────────────────────────────

test('applyExtras: no extras returns all items unchanged', () => {
  assert.equal(applyExtras(METAS, {}).length, 4);
});

test('applyExtras: search filters by title substring (case-insensitive)', () => {
  const r = applyExtras(METAS, { search: 'matrix' });
  assert.equal(r.length, 2);
  assert.ok(r.every(m => m.name.toLowerCase().includes('matrix')));
});

test('applyExtras: search with no matches returns empty array', () => {
  assert.equal(applyExtras(METAS, { search: 'zzznothere' }).length, 0);
});

test('applyExtras: genre filter keeps only matching genre', () => {
  const r = applyExtras(METAS, { genre: 'Action' });
  assert.equal(r.length, 3); // Matrix, Matrix Reloaded, Dark Knight
  assert.ok(r.every(m => m.genres.includes('Action')));
});

test('applyExtras: genre filter with no matches returns empty array', () => {
  assert.equal(applyExtras(METAS, { genre: 'Horror' }).length, 0);
});

test('applyExtras: search and genre can be combined', () => {
  const r = applyExtras(METAS, { search: 'matrix', genre: 'Action' });
  assert.equal(r.length, 2);
});

test('applyExtras: sort "Title A–Z" orders alphabetically ascending', () => {
  const r = applyExtras(METAS, { sort: 'Title A–Z' });
  // M < T so Matrix Reloaded first; then The Dark Knight < The Matrix < Toy Story
  assert.equal(r[0].name, 'Matrix Reloaded');
  assert.equal(r[1].name, 'The Dark Knight');
  assert.equal(r[2].name, 'The Matrix');
  assert.equal(r[3].name, 'Toy Story');
});

test('applyExtras: sort "Title Z–A" orders alphabetically descending', () => {
  const r = applyExtras(METAS, { sort: 'Title Z–A' });
  assert.equal(r[0].name, 'Toy Story');
  assert.equal(r[3].name, 'Matrix Reloaded');
});

test('applyExtras: sort "Year" orders by releaseInfo descending', () => {
  const r = applyExtras(METAS, { sort: 'Year' });
  assert.equal(r[0].releaseInfo, '2008');
  assert.equal(r[1].releaseInfo, '2003');
  assert.equal(r[2].releaseInfo, '1999');
  assert.equal(r[3].releaseInfo, '1995');
});

test('applyExtras: sort "Added (oldest)" reverses input order', () => {
  const r = applyExtras(METAS, { sort: 'Added (oldest)' });
  assert.equal(r[0].name, METAS[METAS.length - 1].name);
  assert.equal(r[r.length - 1].name, METAS[0].name);
});

test('applyExtras: does not mutate input array', () => {
  const copy = METAS.slice();
  applyExtras(METAS, { sort: 'Title A–Z' });
  assert.deepEqual(METAS, copy);
});

// ── parseExtras ────────────────────────────────────────────────────────────

test('parseExtras: parses search and genre', () => {
  const r = parseExtras('search=matrix&genre=Action');
  assert.equal(r.search, 'matrix');
  assert.equal(r.genre, 'Action');
});

test('parseExtras: decodes encoded sort option with em dash', () => {
  const r = parseExtras('sort=Title%20A%E2%80%93Z');
  assert.equal(r.sort, 'Title A–Z');
});

test('parseExtras: empty string returns empty object', () => {
  assert.deepEqual(parseExtras(''), {});
});

test('parseExtras: undefined returns empty object', () => {
  assert.deepEqual(parseExtras(undefined), {});
});

test('parseExtras: single key=value pair', () => {
  assert.equal(parseExtras('search=inception').search, 'inception');
});
