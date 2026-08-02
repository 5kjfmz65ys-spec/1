import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

function normalizeKey(raw) {
  const text = String(raw || '').trim();
  if (/^[a-f0-9]{64}$/i.test(text)) return Buffer.from(text, 'hex');
  try {
    const decoded = Buffer.from(text, 'base64');
    if (decoded.length === 32) return decoded;
  } catch {
    // ignore and derive below
  }
  return createHash('sha256').update(text).digest();
}

export function createCryptoBox(rawKey) {
  const key = normalizeKey(rawKey);
  return {
    encrypt(value) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const plaintext = Buffer.from(JSON.stringify(value), 'utf8');
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const tag = cipher.getAuthTag();
      return JSON.stringify({
        v: 1,
        iv: iv.toString('base64'),
        tag: tag.toString('base64'),
        data: ciphertext.toString('base64')
      });
    },
    decrypt(payload) {
      if (!payload) return null;
      const parsed = typeof payload === 'string' ? JSON.parse(payload) : payload;
      if (parsed.v !== 1) throw new Error('إصدار تشفير غير مدعوم');
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(parsed.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(parsed.tag, 'base64'));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(parsed.data, 'base64')),
        decipher.final()
      ]);
      return JSON.parse(plaintext.toString('utf8'));
    }
  };
}

export function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  const [algorithm, saltB64, hashB64] = String(stored || '').split('$');
  if (algorithm !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function hashToken(token) {
  return createHash('sha256').update(String(token)).digest('hex');
}

export function maskSecret(secret) {
  const value = String(secret || '');
  if (!value) return '';
  if (value.length <= 4) return '••••';
  return `••••••••${value.slice(-4)}`;
}
