import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

function parseBool(value, fallback = false) {
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index < 1) continue;
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadDotEnv(path.resolve(process.cwd(), '.env'));

const dataDir = path.resolve(process.cwd(), process.env.DATA_DIR || './data');
fs.mkdirSync(dataDir, { recursive: true });

function resolveEncryptionKey() {
  const configured = process.env.ENCRYPTION_KEY?.trim();
  if (configured) return configured;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('ENCRYPTION_KEY مطلوب في بيئة الإنتاج');
  }
  const keyFile = path.join(dataDir, '.dev-encryption-key');
  if (!fs.existsSync(keyFile)) {
    fs.writeFileSync(keyFile, randomBytes(32).toString('hex'), { mode: 0o600 });
  }
  return fs.readFileSync(keyFile, 'utf8').trim();
}

export const config = Object.freeze({
  port: Number(process.env.PORT || 3080),
  appUrl: process.env.APP_URL || 'http://localhost:3080',
  dataDir,
  databaseFile: path.join(dataDir, 'reddad.sqlite'),
  encryptionKey: resolveEncryptionKey(),
  sessionTtlDays: Number(process.env.SESSION_TTL_DAYS || 30),
  cookieSecure: parseBool(process.env.COOKIE_SECURE, false),
  metaGraphApiVersion: process.env.META_GRAPH_API_VERSION || '',
  waGatewayUrl: process.env.WA_GATEWAY_URL || 'http://localhost:3090',
  waGatewayToken: process.env.WA_GATEWAY_TOKEN || '',
  internalWebhookToken: process.env.INTERNAL_WEBHOOK_TOKEN || '',
  isProduction: process.env.NODE_ENV === 'production'
});
