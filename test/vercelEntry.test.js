'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { originalUrl } = require('../handler');

// vercel.json rewrites every path to /api/index?__path=/<path>; originalUrl
// must give the handler back the URL the client asked for.
const cases = [
  ['catalog extras, path unencoded', '/api/index?__path=/cfg%2Cx/catalog/movie/cc_1/genre=Action&skip=20.json',
    '/cfg%2Cx/catalog/movie/cc_1/genre=Action&skip=20.json'],
  ['catalog extras, path encoded', '/api/index?__path=%2Fcfg%252Cx%2Fcatalog%2Fmovie%2Fcc_1%2Fgenre%3DAction%26skip%3D20.json',
    '/cfg%2Cx/catalog/movie/cc_1/genre=Action&skip=20.json'],
  ['catalog without extras', '/api/index?__path=/cfg/catalog/movie/cc_1.json', '/cfg/catalog/movie/cc_1.json'],
  ['search extra', '/api/index?__path=/cfg/catalog/movie/cc_1/search=star%20wars.json',
    '/cfg/catalog/movie/cc_1/search=star%20wars.json'],
  ['root', '/api/index?__path=/', '/'],
  ['root, empty capture', '/api/index?__path=', '/'],
  ['plain route', '/api/index?__path=/health', '/health'],
  ['query string kept', '/api/index?__path=/api/user-lists&username=foo', '/api/user-lists?username=foo'],
  ['query string first', '/api/index?username=foo&__path=/api/user-lists', '/api/user-lists?username=foo'],
  ['encoded path + query', '/api/index?__path=%2Fapi%2Fuser-lists&username=foo', '/api/user-lists?username=foo'],
  ['no rewrite (local server)', '/cfg/manifest.json', '/cfg/manifest.json'],
  ['no rewrite, with query', '/api/user-lists?username=foo', '/api/user-lists?username=foo'],
];
for (const [name, input, want] of cases) {
  test('originalUrl: ' + name, () => assert.equal(originalUrl(input), want));
}
