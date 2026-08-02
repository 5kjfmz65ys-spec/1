import { createHash, randomUUID } from 'node:crypto';
import { all, get, nowIso, run, transaction } from './db.mjs';
import { generateAgentReply } from './agent.mjs';
import { MetaCloudWhatsAppProvider } from './providers/whatsapp/official.mjs';
import { logger } from './logger.mjs';
import { config } from './config.mjs';

function phoneFromWaId(value) {
  return String(value || '').replace(/\D/g, '');
}

export function saveWebhookEvent({ organizationId, connectionId, provider, rawBody, payload }) {
  const externalEventId = createHash('sha256').update(rawBody).digest('hex');
  const existing = get('SELECT id FROM webhook_events WHERE connection_id = ? AND external_event_id = ?', [connectionId, externalEventId]);
  if (existing) return { duplicate: true, eventId: existing.id };
  const id = randomUUID();
  run(
    'INSERT INTO webhook_events (id, organization_id, connection_id, provider, external_event_id, payload_json, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [id, organizationId, connectionId, provider, externalEventId, JSON.stringify(payload), 'received', nowIso()]
  );
  return { duplicate: false, eventId: id };
}

function upsertContact(organizationId, message) {
  const phone = phoneFromWaId(message.from);
  let contact = get('SELECT * FROM contacts WHERE organization_id = ? AND phone = ?', [organizationId, phone]);
  if (!contact) {
    const id = randomUUID();
    const timestamp = nowIso();
    run(
      'INSERT INTO contacts (id, organization_id, wa_id, phone, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [id, organizationId, message.from || phone, phone, message.contactName || null, timestamp, timestamp]
    );
    contact = get('SELECT * FROM contacts WHERE id = ?', [id]);
  } else if (message.contactName && message.contactName !== contact.name) {
    run('UPDATE contacts SET name = ?, wa_id = ?, updated_at = ? WHERE id = ?', [message.contactName, message.from || contact.wa_id, nowIso(), contact.id]);
    contact.name = message.contactName;
  }
  return contact;
}

function upsertConversation(organizationId, connectionId, contactId) {
  let conversation = get(
    'SELECT * FROM conversations WHERE organization_id = ? AND connection_id = ? AND contact_id = ?',
    [organizationId, connectionId, contactId]
  );
  if (!conversation) {
    const id = randomUUID();
    const timestamp = nowIso();
    run(
      `INSERT INTO conversations
       (id, organization_id, connection_id, contact_id, status, control_mode, unread_count, last_message_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'open', 'ai_active', 0, ?, ?, ?)`,
      [id, organizationId, connectionId, contactId, timestamp, timestamp, timestamp]
    );
    conversation = get('SELECT * FROM conversations WHERE id = ?', [id]);
  }
  return conversation;
}

export function ingestIncomingMessage({ organizationId, connectionId, message }) {
  const existing = message.providerMessageId
    ? get('SELECT id FROM messages WHERE organization_id = ? AND provider_message_id = ?', [organizationId, message.providerMessageId])
    : null;
  if (existing) return { duplicate: true, messageId: existing.id };
  return transaction(() => {
    const contact = upsertContact(organizationId, message);
    const conversation = upsertConversation(organizationId, connectionId, contact.id);
    const id = randomUUID();
    const timestamp = message.timestamp || nowIso();
    run(
      `INSERT INTO messages
       (id, organization_id, conversation_id, provider_message_id, direction, type, text, status, sender_type, metadata_json, created_at)
       VALUES (?, ?, ?, ?, 'inbound', ?, ?, 'received', 'customer', ?, ?)`,
      [
        id, organizationId, conversation.id, message.providerMessageId || null, message.type || 'text', message.text || '',
        JSON.stringify({ mediaId: message.mediaId, mimeType: message.mimeType, filename: message.filename, location: message.location, quotedMessageId: message.quotedMessageId }),
        timestamp
      ]
    );
    run(
      `UPDATE conversations SET status = 'open', unread_count = unread_count + 1, last_message_at = ?, updated_at = ? WHERE id = ?`,
      [timestamp, nowIso(), conversation.id]
    );
    return { duplicate: false, messageId: id, conversationId: conversation.id, contact };
  });
}

export function applyDeliveryStatus(organizationId, status) {
  const allowed = ['sent', 'delivered', 'read', 'failed'];
  if (!allowed.includes(status.status)) return;
  run(
    'UPDATE messages SET status = ? WHERE organization_id = ? AND provider_message_id = ?',
    [status.status, organizationId, status.providerMessageId]
  );
}

export async function maybeAutoReply({ organizationId, connectionId, conversationId, customerText, cryptoBox }) {
  if (!customerText) return;
  const conversation = get('SELECT * FROM conversations WHERE id = ? AND organization_id = ?', [conversationId, organizationId]);
  if (!conversation || conversation.control_mode !== 'ai_active') return;
  const organization = get('SELECT * FROM organizations WHERE id = ?', [organizationId]);
  const owner = get(
    `SELECT u.id, u.name, u.email FROM memberships m JOIN users u ON u.id = m.user_id
      WHERE m.organization_id = ? AND m.role = 'owner' ORDER BY m.created_at LIMIT 1`,
    [organizationId]
  );
  const contact = get('SELECT * FROM contacts WHERE id = ?', [conversation.contact_id]);
  const history = all('SELECT direction, text FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 12', [conversationId]).reverse();
  const context = { user: owner || { id: null, name: 'النظام', email: '' }, organization };
  let result;
  try {
    result = await generateAgentReply({ context, cryptoBox, customerText, history });
  } catch (error) {
    logger.error('فشل توليد الرد الآلي', { organizationId, conversationId, error: error.message });
    run("UPDATE conversations SET control_mode = 'human_active', status = 'waiting_for_agent', updated_at = ? WHERE id = ?", [nowIso(), conversationId]);
    return;
  }
  if (result.needsHuman) {
    run("UPDATE conversations SET control_mode = 'human_active', status = 'waiting_for_agent', updated_at = ? WHERE id = ?", [nowIso(), conversationId]);
  }
  if (!result.shouldReply || !result.replyText) return;

  const connection = get('SELECT * FROM whatsapp_connections WHERE id = ? AND organization_id = ?', [connectionId, organizationId]);
  let providerMessageId = null;
  let status = 'queued';
  let providerError = null;
  if (connection?.type === 'official' && connection.status === 'connected') {
    try {
      const credentials = cryptoBox.decrypt(connection.credential_blob);
      const provider = new MetaCloudWhatsAppProvider(credentials);
      const sent = await provider.sendText({ to: contact.phone, text: result.replyText });
      providerMessageId = sent.providerMessageId;
      status = 'sent';
    } catch (error) {
      status = 'failed';
      providerError = error.message;
    }
  }
  else if (connection?.type === 'unofficial' && connection.status === 'connected' && config.waGatewayToken) {
    try {
      const response = await fetch(`${config.waGatewayUrl}/sessions/${connection.id}/send`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.waGatewayToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'text', to: contact.phone, text: result.replyText })
      });
      const sent = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(sent.error || `Gateway HTTP ${response.status}`);
      providerMessageId = sent.providerMessageId || null;
      status = 'sent';
    } catch (error) {
      status = 'failed';
      providerError = error.message;
    }
  }
  const timestamp = nowIso();
  run(
    `INSERT INTO messages
     (id, organization_id, conversation_id, provider_message_id, direction, type, text, status, sender_type, metadata_json, created_at)
     VALUES (?, ?, ?, ?, 'outbound', 'text', ?, ?, 'ai', ?, ?)`,
    [randomUUID(), organizationId, conversationId, providerMessageId, result.replyText, status, JSON.stringify({ providerError, agentResult: result }), timestamp]
  );
  run('UPDATE conversations SET last_message_at = ?, updated_at = ? WHERE id = ?', [timestamp, timestamp, conversationId]);
}

export function markWebhookProcessed(eventId, error = null) {
  run('UPDATE webhook_events SET status = ?, error = ?, processed_at = ? WHERE id = ?', [error ? 'failed' : 'processed', error, nowIso(), eventId]);
}
