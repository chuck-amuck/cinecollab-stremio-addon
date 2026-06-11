'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseConfig } = require('../addon');

const UUID1 = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const UUID2 = '11111111-2222-3333-4444-555555555555';

test('bare UUID → correct ids, no authBlob, no discover', () => {
  const r = parseConfig(UUID1);
  assert.deepEqual(r, { authBlob: null, ids: [UUID1], discover: false });
});

test('comma-separated UUIDs → both ids', () => {
  const r = parseConfig(UUID1 + ',' + UUID2);
  assert.deepEqual(r, { authBlob: null, ids: [UUID1, UUID2], discover: false });
});

test('duplicate UUIDs are collapsed', () => {
  const r = parseConfig(UUID1 + ',' + UUID1);
  assert.deepEqual(r.ids, [UUID1]);
});

test('UUIDs are lowercased', () => {
  const r = parseConfig('AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE');
  assert.deepEqual(r.ids, [UUID1]);
});

test('a_<blob> only → authBlob set, no ids', () => {
  const r = parseConfig('a_someBase64blob');
  assert.deepEqual(r, { authBlob: 'someBase64blob', ids: [], discover: false });
});

test('a_<blob> with UUIDs → authBlob + ids', () => {
  const r = parseConfig('a_someblob,' + UUID1 + ',' + UUID2);
  assert.equal(r.authBlob, 'someblob');
  assert.deepEqual(r.ids, [UUID1, UUID2]);
  assert.equal(r.discover, false);
});

test('a_<blob> with base64url chars (hyphens/underscores)', () => {
  const r = parseConfig('a_aB3-xY_zQ');
  assert.equal(r.authBlob, 'aB3-xY_zQ');
});

test('empty string → no authBlob, no ids, no discover', () => {
  assert.deepEqual(parseConfig(''), { authBlob: null, ids: [], discover: false });
});

test('undefined → no authBlob, no ids, no discover', () => {
  assert.deepEqual(parseConfig(undefined), { authBlob: null, ids: [], discover: false });
});

test('URL-encoded comma-separated UUIDs decode correctly', () => {
  const r = parseConfig(UUID1 + '%2C' + UUID2);
  assert.equal(r.ids.length, 2);
  assert.deepEqual(r.ids, [UUID1, UUID2]);
});

test('d_on token → discover: true', () => {
  const r = parseConfig('d_on,' + UUID1);
  assert.equal(r.discover, true);
  assert.deepEqual(r.ids, [UUID1]);
  assert.equal(r.authBlob, null);
});

test('d_on with account blob → discover: true + authBlob set', () => {
  const r = parseConfig('d_on,a_someblob,' + UUID1);
  assert.equal(r.discover, true);
  assert.equal(r.authBlob, 'someblob');
  assert.deepEqual(r.ids, [UUID1]);
});

test('d_on alone → discover: true, no ids', () => {
  const r = parseConfig('d_on');
  assert.deepEqual(r, { authBlob: null, ids: [], discover: true });
});
