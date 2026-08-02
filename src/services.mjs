import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { all, get, nowIso, run, transaction } from './db.mjs';
import { maskSecret } from './crypto.mjs';
import { MetaCloudWhatsAppProvider } from './providers/whatsapp/official.mjs';
import { createAIProvider } from './providers/ai/index.mjs';
import { config } from './config.mjs';

export function audit(context, action, entityType = null, entityId = null, metadata = null) {
  run(
    'INSERT INTO audit_logs (id, organization_id, user_id, action, entity_type, entity_id, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [
      randomUUID(), context?.organization?.id || null, context?.user?.id || null, action,
      entityType, entityId, metadata ? JSON.stringify(metadata) : null, nowIso()
    ]
  );
}

export function getDashboard(context) {
  const orgId = context.organization.id;
  const metrics = {
    conversations: get('SELECT COUNT(*) AS count FROM conversations WHERE organization_id = ?', [orgId])?.count || 0,
    openConversations: get("SELECT COUNT(*) AS count FROM conversations WHERE organization_id = ? AND status IN ('open','pending','waiting_for_agent')", [orgId])?.count || 0,
    unread: get('SELECT COALESCE(SUM(unread_count), 0) AS count FROM conversations WHERE organization_id = ?', [orgId])?.count || 0,
    contacts: get('SELECT COUNT(*) AS count FROM contacts WHERE organization_id = ?', [orgId])?.count || 0,
    aiReplies: get("SELECT COUNT(*) AS count FROM messages WHERE organization_id = ? AND sender_type = 'ai'", [orgId])?.count || 0,
    humanReplies: get("SELECT COUNT(*) AS count FROM messages WHERE organization_id = ? AND sender_type = 'agent'", [orgId])?.count || 0,
    knowledgeEntries: get('SELECT COUNT(*) AS count FROM knowledge_entries WHERE organization_id = ?', [orgId])?.count || 0
  };
  const connections = all(
    'SELECT id, type, name, status, phone_number, last_error, updated_at FROM whatsapp_connections WHERE organization_id = ? ORDER BY created_at DESC',
    [orgId]
  );
  const recent = all(
    `SELECT c.id, c.status, c.control_mode, c.unread_count, c.last_message_at,
            ct.name AS contact_name, ct.phone,
            (SELECT text FROM messages m WHERE m.conversation_id = c.id ORDER BY created_at DESC LIMIT 1) AS last_text
       FROM conversations c JOIN contacts ct ON ct.id = c.contact_id
      WHERE c.organization_id = ? ORDER BY c.last_message_at DESC LIMIT 6`,
    [orgId]
  );
  return { metrics, connections, recent };
}

export function updateOrganization(context, input) {
  const name = String(input.name || '').trim();
  const activity = String(input.activity || '').trim();
  const timezone = String(input.timezone || 'Asia/Riyadh').trim();
  if (name.length < 2) throw Object.assign(new Error('اسم المنشأة مطلوب'), { status: 400 });
  run('UPDATE organizations SET name = ?, activity = ?, timezone = ?, updated_at = ? WHERE id = ?', [
    name, activity || 'متجر إلكتروني', timezone, nowIso(), context.organization.id
  ]);
  audit(context, 'organization.updated', 'organization', context.organization.id, { name, activity, timezone });
  return get('SELECT id, name, activity, timezone, updated_at FROM organizations WHERE id = ?', [context.organization.id]);
}

export function listTeam(context) {
  return all(
    `SELECT u.id, u.name, u.email, m.role, m.status, m.created_at
       FROM memberships m JOIN users u ON u.id = m.user_id
      WHERE m.organization_id = ? ORDER BY m.created_at`,
    [context.organization.id]
  );
}

export function createInvite(context, input) {
  const email = String(input.email || '').trim().toLowerCase();
  const role = String(input.role || 'agent');
  if (!/^\S+@\S+\.\S+$/.test(email)) throw Object.assign(new Error('البريد غير صحيح'), { status: 400 });
  if (!['admin', 'supervisor', 'agent', 'viewer'].includes(role)) throw Object.assign(new Error('الدور غير صحيح'), { status: 400 });
  const existing = get('SELECT id FROM team_invites WHERE organization_id = ? AND email = ? AND status = ?', [context.organization.id, email, 'pending']);
  if (existing) throw Object.assign(new Error('توجد دعوة معلقة لهذا البريد'), { status: 409 });
  const rawToken = randomBytes(24).toString('base64url');
  const id = randomUUID();
  const expiresAt = new Date(Date.now() + 7 * 86400000).toISOString();
  run(
    'INSERT INTO team_invites (id, organization_id, email, role, token_hash, status, invited_by, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [id, context.organization.id, email, role, createHash('sha256').update(rawToken).digest('hex'), 'pending', context.user.id, expiresAt, nowIso()]
  );
  audit(context, 'team.invited', 'team_invite', id, { email, role });
  return { id, email, role, expiresAt, inviteTokenForDevelopment: rawToken };
}

export function listConnections(context) {
  return all(
    `SELECT id, type, name, status, phone_number, phone_number_id, waba_id, graph_version,
            last_error, created_at, updated_at
       FROM whatsapp_connections WHERE organization_id = ? ORDER BY created_at DESC`,
    [context.organization.id]
  );
}

export function saveOfficialConnection(context, cryptoBox, input) {
  const name = String(input.name || 'واتساب الرسمي').trim();
  const phoneNumber = String(input.phoneNumber || '').trim();
  const phoneNumberId = String(input.phoneNumberId || '').trim();
  const wabaId = String(input.wabaId || '').trim();
  const apiVersion = String(input.apiVersion || '').trim();
  const accessToken = String(input.accessToken || '').trim();
  const appSecret = String(input.appSecret || '').trim();
  const verifyToken = String(input.verifyToken || '').trim();
  if (!phoneNumberId || !apiVersion || !accessToken || !appSecret || !verifyToken) {
    throw Object.assign(new Error('أكمل بيانات Meta المطلوبة'), { status: 400 });
  }
  const id = randomUUID();
  const timestamp = nowIso();
  const credentialBlob = cryptoBox.encrypt({ accessToken, appSecret, verifyToken, phoneNumberId, wabaId, apiVersion });
  run(
    `INSERT INTO whatsapp_connections
      (id, organization_id, type, name, status, phone_number, phone_number_id, waba_id, graph_version, credential_blob, created_by, created_at, updated_at)
     VALUES (?, ?, 'official', ?, 'disconnected', ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, context.organization.id, name, phoneNumber || null, phoneNumberId, wabaId || null, apiVersion, credentialBlob, context.user.id, timestamp, timestamp]
  );
  audit(context, 'whatsapp.official.created', 'whatsapp_connection', id, { phoneNumberId, wabaId, apiVersion, accessToken: maskSecret(accessToken) });
  return { id, name, type: 'official', status: 'disconnected', phoneNumber, phoneNumberId, wabaId, apiVersion };
}

export function createUnofficialConnection(context, input, requestMeta = {}) {
  if (input.acceptedRisk !== true || input.acceptedAcceptableUse !== true) {
    throw Object.assign(new Error('يجب الموافقة على التحذيرين قبل إنشاء الربط التجريبي'), { status: 400 });
  }
  const id = randomUUID();
  const timestamp = nowIso();
  const warningVersion = '2026-08-02-v1';
  transaction(() => {
    run(
      `INSERT INTO whatsapp_connections
        (id, organization_id, type, name, status, phone_number, created_by, created_at, updated_at)
       VALUES (?, ?, 'unofficial', ?, 'setup_required', ?, ?, ?, ?)`,
      [id, context.organization.id, String(input.name || 'ربط تجريبي').trim(), String(input.phoneNumber || '').trim() || null, context.user.id, timestamp, timestamp]
    );
    run(
      `INSERT INTO whatsapp_connection_consents
        (id, organization_id, connection_id, user_id, warning_version, accepted_risk, accepted_acceptable_use, user_agent, ip_hash, agreed_at)
       VALUES (?, ?, ?, ?, ?, 1, 1, ?, ?, ?)`,
      [randomUUID(), context.organization.id, id, context.user.id, warningVersion, requestMeta.userAgent || '', requestMeta.ipHash || '', timestamp]
    );
  });
  audit(context, 'whatsapp.unofficial.consent_accepted', 'whatsapp_connection', id, { warningVersion });
  return { id, type: 'unofficial', status: 'setup_required', warningVersion };
}

export function getConnectionForOrganization(context, connectionId) {
  const connection = get('SELECT * FROM whatsapp_connections WHERE id = ? AND organization_id = ?', [connectionId, context.organization.id]);
  if (!connection) throw Object.assign(new Error('الاتصال غير موجود'), { status: 404 });
  return connection;
}

export function getConnectionCredentials(connection, cryptoBox) {
  return connection.credential_blob ? cryptoBox.decrypt(connection.credential_blob) : null;
}

export async function testConnection(context, cryptoBox, connectionId) {
  const connection = getConnectionForOrganization(context, connectionId);
  if (connection.type === 'unofficial') {
    return { ok: false, status: connection.status, message: 'اختبار الربط التجريبي يتم من خدمة البوابة الاختيارية' };
  }
  const credentials = getConnectionCredentials(connection, cryptoBox);
  const provider = new MetaCloudWhatsAppProvider(credentials);
  try {
    const result = await provider.testConnection();
    run('UPDATE whatsapp_connections SET status = ?, last_error = NULL, updated_at = ? WHERE id = ?', ['connected', nowIso(), connection.id]);
    audit(context, 'whatsapp.connection_tested', 'whatsapp_connection', connection.id, { ok: true });
    return result;
  } catch (error) {
    run('UPDATE whatsapp_connections SET status = ?, last_error = ?, updated_at = ? WHERE id = ?', ['error', error.message, nowIso(), connection.id]);
    audit(context, 'whatsapp.connection_tested', 'whatsapp_connection', connection.id, { ok: false, code: error.code });
    throw error;
  }
}

export function disconnectConnection(context, connectionId) {
  const connection = getConnectionForOrganization(context, connectionId);
  run('UPDATE whatsapp_connections SET status = ?, updated_at = ? WHERE id = ?', ['disconnected', nowIso(), connectionId]);
  audit(context, 'whatsapp.disconnected', 'whatsapp_connection', connectionId, { type: connection.type });
  return { ok: true };
}

export function listConversations(context) {
  return all(
    `SELECT c.id, c.status, c.control_mode, c.unread_count, c.last_message_at, c.assigned_user_id,
            ct.name AS contact_name, ct.phone, wc.type AS connection_type, wc.name AS connection_name,
            (SELECT text FROM messages m WHERE m.conversation_id = c.id ORDER BY created_at DESC LIMIT 1) AS last_text
       FROM conversations c
       JOIN contacts ct ON ct.id = c.contact_id
       LEFT JOIN whatsapp_connections wc ON wc.id = c.connection_id
      WHERE c.organization_id = ? ORDER BY COALESCE(c.last_message_at, c.created_at) DESC`,
    [context.organization.id]
  );
}

export function getConversation(context, conversationId) {
  const conversation = get(
    `SELECT c.*, ct.name AS contact_name, ct.phone, ct.email, ct.marketing_opt_in, wc.type AS connection_type, wc.name AS connection_name
       FROM conversations c JOIN contacts ct ON ct.id = c.contact_id
       LEFT JOIN whatsapp_connections wc ON wc.id = c.connection_id
      WHERE c.id = ? AND c.organization_id = ?`,
    [conversationId, context.organization.id]
  );
  if (!conversation) throw Object.assign(new Error('المحادثة غير موجودة'), { status: 404 });
  const messages = all(
    `SELECT id, direction, type, text, status, sender_type, sender_user_id, metadata_json, created_at
       FROM messages WHERE conversation_id = ? AND organization_id = ? ORDER BY created_at`,
    [conversationId, context.organization.id]
  );
  run('UPDATE conversations SET unread_count = 0, updated_at = ? WHERE id = ?', [nowIso(), conversationId]);
  return { ...conversation, messages: messages.map((message) => ({ ...message, metadata: message.metadata_json ? JSON.parse(message.metadata_json) : null })) };
}

export async function sendConversationMessage(context, cryptoBox, conversationId, input) {
  const conversation = getConversation(context, conversationId);
  const text = String(input.text || '').trim();
  if (!text) throw Object.assign(new Error('اكتب نص الرسالة'), { status: 400 });
  const messageId = randomUUID();
  let status = 'sent';
  let providerMessageId = null;
  let providerError = null;
  if (conversation.connection_id) {
    const connection = getConnectionForOrganization(context, conversation.connection_id);
    if (connection.type === 'official' && connection.status === 'connected') {
      try {
        const provider = new MetaCloudWhatsAppProvider(getConnectionCredentials(connection, cryptoBox));
        const result = await provider.sendText({ to: conversation.phone, text });
        providerMessageId = result.providerMessageId;
      } catch (error) {
        status = 'failed';
        providerError = error.message;
      }
    } else if (connection.type === 'unofficial') {
      if (!config.waGatewayToken) {
        status = 'queued';
        providerError = 'أضف WA_GATEWAY_TOKEN وشغّل خدمة Baileys Gateway لتسليم الرسالة';
      } else {
        try {
          const response = await fetch(`${config.waGatewayUrl}/sessions/${connection.id}/send`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${config.waGatewayToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'text', to: conversation.phone, text })
          });
          const result = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(result.error || `Gateway HTTP ${response.status}`);
          providerMessageId = result.providerMessageId || null;
          status = 'sent';
        } catch (error) {
          status = 'failed';
          providerError = `تعذر الإرسال عبر Gateway: ${error.message}`;
        }
      }
    }
  }
  const timestamp = nowIso();
  run(
    `INSERT INTO messages
      (id, organization_id, conversation_id, provider_message_id, direction, type, text, status, sender_type, sender_user_id, metadata_json, created_at)
     VALUES (?, ?, ?, ?, 'outbound', 'text', ?, ?, 'agent', ?, ?, ?)`,
    [messageId, context.organization.id, conversationId, providerMessageId, text, status, context.user.id, JSON.stringify({ providerError }), timestamp]
  );
  run(
    "UPDATE conversations SET control_mode = 'human_active', status = 'open', last_message_at = ?, updated_at = ? WHERE id = ?",
    [timestamp, timestamp, conversationId]
  );
  audit(context, 'conversation.agent_replied', 'conversation', conversationId, { messageId, status });
  return { id: messageId, text, status, providerMessageId, providerError, created_at: timestamp };
}

export function updateConversation(context, conversationId, input) {
  const conversation = get('SELECT id FROM conversations WHERE id = ? AND organization_id = ?', [conversationId, context.organization.id]);
  if (!conversation) throw Object.assign(new Error('المحادثة غير موجودة'), { status: 404 });
  const allowedStatus = ['open', 'pending', 'waiting_for_customer', 'waiting_for_agent', 'resolved', 'closed', 'spam'];
  const allowedMode = ['ai_active', 'human_active', 'paused'];
  if (input.status && !allowedStatus.includes(input.status)) throw Object.assign(new Error('حالة المحادثة غير صحيحة'), { status: 400 });
  if (input.controlMode && !allowedMode.includes(input.controlMode)) throw Object.assign(new Error('وضع التحكم غير صحيح'), { status: 400 });
  const current = get('SELECT status, control_mode FROM conversations WHERE id = ?', [conversationId]);
  run('UPDATE conversations SET status = ?, control_mode = ?, updated_at = ? WHERE id = ?', [
    input.status || current.status, input.controlMode || current.control_mode, nowIso(), conversationId
  ]);
  audit(context, 'conversation.updated', 'conversation', conversationId, { status: input.status, controlMode: input.controlMode });
  return { ok: true };
}

export function listKnowledge(context) {
  return all(
    'SELECT id, title, question, answer, source_type, status, created_at, updated_at FROM knowledge_entries WHERE organization_id = ? ORDER BY updated_at DESC',
    [context.organization.id]
  );
}

export function createKnowledge(context, input) {
  const title = String(input.title || '').trim();
  const question = String(input.question || '').trim();
  const answer = String(input.answer || '').trim();
  const sourceType = ['qa', 'text', 'policy', 'product', 'file', 'website'].includes(input.sourceType) ? input.sourceType : 'qa';
  if (title.length < 2 || answer.length < 2) throw Object.assign(new Error('العنوان والإجابة مطلوبان'), { status: 400 });
  const id = randomUUID();
  const timestamp = nowIso();
  run(
    'INSERT INTO knowledge_entries (id, organization_id, title, question, answer, source_type, status, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [id, context.organization.id, title, question || null, answer, sourceType, 'ready', context.user.id, timestamp, timestamp]
  );
  audit(context, 'knowledge.created', 'knowledge_entry', id, { title, sourceType });
  return get('SELECT * FROM knowledge_entries WHERE id = ?', [id]);
}

export function deleteKnowledge(context, id) {
  const result = run('DELETE FROM knowledge_entries WHERE id = ? AND organization_id = ?', [id, context.organization.id]);
  if (!result.changes) throw Object.assign(new Error('المصدر غير موجود'), { status: 404 });
  audit(context, 'knowledge.deleted', 'knowledge_entry', id);
  return { ok: true };
}

export function getAISettings(context, cryptoBox) {
  const settings = get('SELECT * FROM ai_settings WHERE organization_id = ?', [context.organization.id]);
  let apiKeyHint = '';
  if (settings?.api_key_blob) {
    try { apiKeyHint = maskSecret(cryptoBox.decrypt(settings.api_key_blob)?.apiKey || ''); } catch { apiKeyHint = 'مفتاح محفوظ'; }
  }
  const { api_key_blob, ...safe } = settings || {};
  return { ...safe, apiKeyHint, hasApiKey: Boolean(api_key_blob) };
}

export function saveAISettings(context, cryptoBox, input) {
  const provider = ['rules', 'ollama', 'openai_compatible', 'anthropic', 'gemini'].includes(input.provider) ? input.provider : 'rules';
  const existing = get('SELECT * FROM ai_settings WHERE organization_id = ?', [context.organization.id]);
  const apiKey = String(input.apiKey || '').trim();
  const apiKeyBlob = apiKey ? cryptoBox.encrypt({ apiKey }) : existing?.api_key_blob || null;
  run(
    `UPDATE ai_settings SET provider = ?, model = ?, base_url = ?, api_key_blob = ?, enabled = ?, assistant_name = ?, tone = ?,
      language_mode = ?, confidence_threshold = ?, system_instructions = ?, daily_limit = ?, updated_at = ? WHERE organization_id = ?`,
    [
      provider, String(input.model || '').trim() || null, String(input.baseUrl || '').trim() || null, apiKeyBlob,
      input.enabled ? 1 : 0, String(input.assistantName || 'مساعد المتجر').trim(), String(input.tone || 'ودود ومختصر').trim(),
      String(input.languageMode || 'same_as_customer'), Number(input.confidenceThreshold || 0.72),
      String(input.systemInstructions || '').trim() || null, Number(input.dailyLimit || 500), nowIso(), context.organization.id
    ]
  );
  audit(context, 'ai.settings_updated', 'ai_settings', existing?.id, { provider, model: input.model, enabled: Boolean(input.enabled), apiKey: apiKey ? maskSecret(apiKey) : 'unchanged' });
  return getAISettings(context, cryptoBox);
}

export async function testAISettings(context, cryptoBox, input = {}) {
  const settings = get('SELECT * FROM ai_settings WHERE organization_id = ?', [context.organization.id]);
  if (!settings) throw Object.assign(new Error('إعدادات الذكاء الاصطناعي غير موجودة'), { status: 404 });
  const apiKey = input.apiKey || (settings.api_key_blob ? cryptoBox.decrypt(settings.api_key_blob)?.apiKey : '');
  const provider = createAIProvider({ ...settings, ...input, base_url: input.baseUrl || settings.base_url }, apiKey);
  return provider.testConnection();
}

export function listProducts(context) {
  return all('SELECT * FROM products WHERE organization_id = ? ORDER BY updated_at DESC', [context.organization.id]);
}

export function createProduct(context, input) {
  const name = String(input.name || '').trim();
  if (name.length < 2) throw Object.assign(new Error('اسم المنتج مطلوب'), { status: 400 });
  const id = randomUUID();
  const timestamp = nowIso();
  run(
    `INSERT INTO products (id, organization_id, name, sku, description, price, sale_price, stock, image_url, product_url, active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    [id, context.organization.id, name, String(input.sku || '').trim() || null, String(input.description || '').trim() || null, Number(input.price || 0), input.salePrice === '' ? null : Number(input.salePrice || 0), Number(input.stock || 0), String(input.imageUrl || '').trim() || null, String(input.productUrl || '').trim() || null, timestamp, timestamp]
  );
  audit(context, 'product.created', 'product', id, { name });
  return get('SELECT * FROM products WHERE id = ?', [id]);
}

export function listOrders(context) {
  return all(
    `SELECT o.*, c.name AS customer_name, c.phone AS customer_phone
       FROM orders o LEFT JOIN contacts c ON c.id = o.contact_id
      WHERE o.organization_id = ? ORDER BY o.created_at DESC`,
    [context.organization.id]
  ).map((order) => ({ ...order, items: JSON.parse(order.items_json || '[]') }));
}

export function getReports(context) {
  const orgId = context.organization.id;
  const daily = all(
    `SELECT substr(created_at, 1, 10) AS day,
            SUM(CASE WHEN direction = 'inbound' THEN 1 ELSE 0 END) AS inbound,
            SUM(CASE WHEN direction = 'outbound' THEN 1 ELSE 0 END) AS outbound
       FROM messages WHERE organization_id = ? AND created_at >= datetime('now', '-30 days')
      GROUP BY substr(created_at, 1, 10) ORDER BY day`,
    [orgId]
  );
  return {
    summary: getDashboard(context).metrics,
    daily,
    connectionHealth: all('SELECT type, status, COUNT(*) AS count FROM whatsapp_connections WHERE organization_id = ? GROUP BY type, status', [orgId]),
    aiUsage: all('SELECT provider, COUNT(*) AS requests, SUM(output_units) AS units FROM ai_usage_events WHERE organization_id = ? GROUP BY provider', [orgId])
  };
}
