import { DatabaseSync } from 'node:sqlite';
import { config } from './config.mjs';

const db = new DatabaseSync(config.databaseFile);
db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');

const migrationSql = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  is_platform_admin INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  activity TEXT NOT NULL DEFAULT 'متجر إلكتروني',
  timezone TEXT NOT NULL DEFAULT 'Asia/Riyadh',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memberships (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('owner','admin','supervisor','agent','viewer')),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','invited','suspended')),
  created_at TEXT NOT NULL,
  UNIQUE(user_id, organization_id)
);
CREATE INDEX IF NOT EXISTS idx_memberships_org ON memberships(organization_id);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  active_organization_id TEXT REFERENCES organizations(id) ON DELETE SET NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS team_invites (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email TEXT NOT NULL COLLATE NOCASE,
  role TEXT NOT NULL CHECK(role IN ('admin','supervisor','agent','viewer')),
  token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','expired','revoked')),
  invited_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(organization_id, email, status)
);

CREATE TABLE IF NOT EXISTS whatsapp_connections (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK(type IN ('official','unofficial')),
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'disconnected' CHECK(status IN ('disconnected','connecting','qr_required','connected','logged_out','restricted','error','paused','setup_required')),
  phone_number TEXT,
  phone_number_id TEXT,
  waba_id TEXT,
  graph_version TEXT,
  credential_blob TEXT,
  last_error TEXT,
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_connection_phone ON whatsapp_connections(organization_id, phone_number) WHERE phone_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_connections_org ON whatsapp_connections(organization_id);

CREATE TABLE IF NOT EXISTS whatsapp_connection_consents (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL REFERENCES whatsapp_connections(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  warning_version TEXT NOT NULL,
  accepted_risk INTEGER NOT NULL CHECK(accepted_risk IN (0,1)),
  accepted_acceptable_use INTEGER NOT NULL CHECK(accepted_acceptable_use IN (0,1)),
  user_agent TEXT,
  ip_hash TEXT,
  agreed_at TEXT NOT NULL,
  UNIQUE(connection_id, warning_version)
);

CREATE TABLE IF NOT EXISTS webhook_events (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL REFERENCES whatsapp_connections(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  external_event_id TEXT,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'received',
  error TEXT,
  created_at TEXT NOT NULL,
  processed_at TEXT,
  UNIQUE(connection_id, external_event_id)
);

CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  wa_id TEXT,
  phone TEXT NOT NULL,
  name TEXT,
  email TEXT,
  marketing_opt_in INTEGER NOT NULL DEFAULT 0,
  blocked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(organization_id, phone)
);
CREATE INDEX IF NOT EXISTS idx_contacts_org ON contacts(organization_id);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  connection_id TEXT REFERENCES whatsapp_connections(id) ON DELETE SET NULL,
  contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','pending','waiting_for_customer','waiting_for_agent','resolved','closed','spam')),
  control_mode TEXT NOT NULL DEFAULT 'ai_active' CHECK(control_mode IN ('ai_active','human_active','paused')),
  assigned_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  unread_count INTEGER NOT NULL DEFAULT 0,
  last_message_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(organization_id, connection_id, contact_id)
);
CREATE INDEX IF NOT EXISTS idx_conversations_org_last ON conversations(organization_id, last_message_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  provider_message_id TEXT,
  direction TEXT NOT NULL CHECK(direction IN ('inbound','outbound')),
  type TEXT NOT NULL DEFAULT 'text',
  text TEXT,
  status TEXT NOT NULL DEFAULT 'received' CHECK(status IN ('queued','sent','delivered','read','failed','received')),
  sender_type TEXT NOT NULL CHECK(sender_type IN ('customer','agent','ai','system')),
  sender_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(organization_id, provider_message_id)
);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at);

CREATE TABLE IF NOT EXISTS internal_notes (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS knowledge_entries (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  question TEXT,
  answer TEXT NOT NULL,
  source_type TEXT NOT NULL DEFAULT 'qa' CHECK(source_type IN ('qa','text','policy','product','file','website')),
  status TEXT NOT NULL DEFAULT 'ready' CHECK(status IN ('processing','ready','failed')),
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_knowledge_org ON knowledge_entries(organization_id);

CREATE TABLE IF NOT EXISTS ai_settings (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL UNIQUE REFERENCES organizations(id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'rules' CHECK(provider IN ('rules','ollama','openai_compatible','anthropic','gemini')),
  model TEXT,
  base_url TEXT,
  api_key_blob TEXT,
  enabled INTEGER NOT NULL DEFAULT 0,
  assistant_name TEXT NOT NULL DEFAULT 'مساعد المتجر',
  tone TEXT NOT NULL DEFAULT 'ودود ومختصر',
  language_mode TEXT NOT NULL DEFAULT 'same_as_customer',
  confidence_threshold REAL NOT NULL DEFAULT 0.72,
  system_instructions TEXT,
  daily_limit INTEGER NOT NULL DEFAULT 500,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ai_usage_events (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  model TEXT,
  input_units INTEGER NOT NULL DEFAULT 0,
  output_units INTEGER NOT NULL DEFAULT 0,
  success INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  sku TEXT,
  description TEXT,
  price REAL NOT NULL DEFAULT 0,
  sale_price REAL,
  stock INTEGER NOT NULL DEFAULT 0,
  image_url TEXT,
  product_url TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(organization_id, sku)
);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL,
  order_number TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new',
  total REAL NOT NULL DEFAULT 0,
  shipping_company TEXT,
  tracking_number TEXT,
  items_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(organization_id, order_number)
);

CREATE TABLE IF NOT EXISTS automation_rules (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  trigger_type TEXT NOT NULL,
  conditions_json TEXT NOT NULL DEFAULT '{}',
  actions_json TEXT NOT NULL DEFAULT '[]',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  organization_id TEXT REFERENCES organizations(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_org ON audit_logs(organization_id, created_at DESC);
`;

db.exec(migrationSql);

export function nowIso() {
  return new Date().toISOString();
}

export function run(sql, params = []) {
  return db.prepare(sql).run(...params);
}

export function get(sql, params = []) {
  return db.prepare(sql).get(...params) || null;
}

export function all(sql, params = []) {
  return db.prepare(sql).all(...params);
}

export function transaction(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function closeDatabase() {
  db.close();
}

export { db };
