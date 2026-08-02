import test from 'node:test';
import assert from 'node:assert/strict';
import { createCryptoBox, hashPassword, maskSecret, verifyPassword } from '../src/crypto.mjs';

test('AES-256-GCM encrypts and decrypts structured data', () => {
  const box = createCryptoBox('a'.repeat(64));
  const encrypted = box.encrypt({ token: 'secret-value', nested: { ok: true } });
  assert.equal(encrypted.includes('secret-value'), false);
  assert.deepEqual(box.decrypt(encrypted), { token: 'secret-value', nested: { ok: true } });
});

test('password hashing validates correct password only', () => {
  const stored = hashPassword('StrongPassword123!');
  assert.equal(verifyPassword('StrongPassword123!', stored), true);
  assert.equal(verifyPassword('wrong', stored), false);
});

test('secret masking shows only the ending', () => {
  assert.equal(maskSecret('abcdef123456'), '••••••••3456');
});
