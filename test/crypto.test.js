'use strict';
// ADDON_SECRET must be set before requiring addon so the key is derived on first use.
process.env.ADDON_SECRET = 'test-secret-for-unit-tests-min16';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { encryptBlob, decryptBlob } = require('../addon');

test('encrypt → decrypt round-trips the original object', () => {
  const obj = { refreshToken: 'rt-abc123', uid: 'user-uuid-456' };
  const blob = encryptBlob(obj);
  assert.equal(typeof blob, 'string');
  assert.deepEqual(decryptBlob(blob), obj);
});

test('each encrypt call produces different ciphertext (random IV)', () => {
  const obj = { refreshToken: 'same', uid: 'same' };
  assert.notEqual(encryptBlob(obj), encryptBlob(obj));
});

test('blob is base64url (no +, /, = chars)', () => {
  const blob = encryptBlob({ refreshToken: 'x', uid: 'y' });
  assert.ok(!/[+/=]/.test(blob), 'blob should be base64url-safe');
});

test('decryptBlob returns null on garbage input', () => {
  assert.equal(decryptBlob('not-valid-ciphertext!!!!'), null);
});

test('decryptBlob returns null on too-short input (< 29 bytes decoded)', () => {
  // "hello" in base64url is 6 chars, decodes to 5 bytes — too short
  assert.equal(decryptBlob('aGVsbG8'), null);
});

test('decryptBlob returns null on tampered ciphertext (GCM auth tag check)', () => {
  const blob = encryptBlob({ refreshToken: 'tok', uid: 'uid' });
  // Decode to raw bytes, corrupt byte 13 (inside the 16-byte auth tag at bytes 12–27),
  // then re-encode. Directly corrupting the auth tag guarantees GCM rejects it.
  const buf = Buffer.from(blob.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  buf[13] ^= 0xFF;
  const tampered = buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  assert.equal(decryptBlob(tampered), null);
});

test('decryptBlob returns null on empty string', () => {
  assert.equal(decryptBlob(''), null);
});
