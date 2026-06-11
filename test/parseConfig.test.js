'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseConfig } = require('../addon');

const UUID1 = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const UUID2 = '11111111-2222-3333-4444-555555555555';

test('bare UUID → correct ids, no authBlob', () => {
  const r = parseConfig(UUID1);
  assert.deepEqual(r, { authBlob: null, ids: [UUID1] });
});

test('comma-separated UUIDs → both ids', () => {
  const r = parseConfig(UUID1 + ',' + UUID2);
  assert.deepEqual(r, { authBlob: null, ids: [UUID1, UUID2] });
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
  assert.deepEqual(r, { authBlob: 'someBase64blob', ids: [] });
});

test('a_<blob> with UUIDs → authBlob + ids', () => {
  const r = parseConfig('a_someblob,' + UUID1 + ',' + UUID2);
  assert.equal(r.authBlob, 'someblob');
  assert.deepEqual(r.ids, [UUID1, UUID2]);
});

test('a_<blob> with base64url chars (hyphens/underscores)', () => {
  const r = parseConfig('a_aB3-xY_zQ');
  assert.equal(r.authBlob, 'aB3-xY_zQ');
});

test('empty string → no authBlob, no ids', () => {
  assert.deepEqual(parseConfig(''), { authBlob: null, ids: [] });
});

test('undefined → no authBlob, no ids', () => {
  assert.deepEqual(parseConfig(undefined), { authBlob: null, ids: [] });
});

test('URL-encoded comma-separated UUIDs decode correctly', () => {
  const r = parseConfig(UUID1 + '%2C' + UUID2);
  assert.equal(r.ids.length, 2);
  assert.deepEqual(r.ids, [UUID1, UUID2]);
});
