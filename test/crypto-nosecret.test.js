'use strict';
// ADDON_SECRET intentionally NOT set — tests graceful degradation.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { encryptBlob, decryptBlob, resolveAuth } = require('../addon');

test('encryptBlob throws when ADDON_SECRET is not set', () => {
  assert.throws(
    () => encryptBlob({ refreshToken: 'tok', uid: 'uid' }),
    /ADDON_SECRET/
  );
});

test('decryptBlob returns null when ADDON_SECRET is not set', () => {
  assert.equal(decryptBlob('someencodedblob'), null);
});

test('resolveAuth(null) resolves to null', async () => {
  assert.equal(await resolveAuth(null), null);
});

test('resolveAuth with blob resolves to null (no secret to decrypt)', async () => {
  assert.equal(await resolveAuth('someencodedblob'), null);
});
