import { createHmac, timingSafeEqual } from 'node:crypto';

export class WhatsAppProviderError extends Error {
  constructor(message, { status = 502, code = 'WHATSAPP_ERROR', details = null } = {}) {
    super(message);
    this.name = 'WhatsAppProviderError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

async function parseResponse(response) {
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!response.ok) {
    const providerMessage = data?.error?.message || data?.message || `HTTP ${response.status}`;
    throw new WhatsAppProviderError(`تعذر تنفيذ طلب واتساب: ${providerMessage}`, {
      status: response.status >= 400 && response.status < 500 ? 400 : 502,
      code: data?.error?.code ? `META_${data.error.code}` : 'META_HTTP_ERROR',
      details: { providerStatus: response.status, providerType: data?.error?.type }
    });
  }
  return data;
}

function ensureCredentials(credentials) {
  const required = ['accessToken', 'phoneNumberId', 'apiVersion'];
  const missing = required.filter((key) => !credentials?.[key]);
  if (missing.length) {
    throw new WhatsAppProviderError(`بيانات الربط الرسمي ناقصة: ${missing.join(', ')}`, {
      status: 400,
      code: 'META_MISSING_CREDENTIALS'
    });
  }
}

export class MetaCloudWhatsAppProvider {
  constructor(credentials) {
    this.credentials = credentials;
    ensureCredentials(credentials);
    this.baseUrl = `https://graph.facebook.com/${encodeURIComponent(credentials.apiVersion)}`;
  }

  async testConnection() {
    const { phoneNumberId, accessToken } = this.credentials;
    const url = `${this.baseUrl}/${encodeURIComponent(phoneNumberId)}?fields=display_phone_number,verified_name,quality_rating`;
    const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    const data = await parseResponse(response);
    return {
      ok: true,
      phoneNumberId,
      displayPhoneNumber: data.display_phone_number || null,
      verifiedName: data.verified_name || null,
      qualityRating: data.quality_rating || null
    };
  }

  async sendText({ to, text, previewUrl = false, replyToMessageId = null }) {
    if (!to || !text) throw new WhatsAppProviderError('رقم المستلم ونص الرسالة مطلوبان', { status: 400 });
    const body = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'text',
      text: { preview_url: Boolean(previewUrl), body: text }
    };
    if (replyToMessageId) body.context = { message_id: replyToMessageId };
    return this.#send(body);
  }

  async sendTemplate({ to, name, languageCode = 'ar', components = [] }) {
    if (!to || !name) throw new WhatsAppProviderError('رقم المستلم واسم القالب مطلوبان', { status: 400 });
    return this.#send({
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: { name, language: { code: languageCode }, components }
    });
  }

  async sendMedia({ to, type, link, caption = '', filename = undefined }) {
    const allowed = ['image', 'audio', 'video', 'document'];
    if (!allowed.includes(type)) throw new WhatsAppProviderError('نوع الوسائط غير مدعوم', { status: 400 });
    if (!to || !link) throw new WhatsAppProviderError('رقم المستلم ورابط الملف مطلوبان', { status: 400 });
    const media = { link };
    if (caption && type !== 'audio') media.caption = caption;
    if (filename && type === 'document') media.filename = filename;
    return this.#send({ messaging_product: 'whatsapp', to, type, [type]: media });
  }

  async sendLocation({ to, latitude, longitude, name = '', address = '' }) {
    return this.#send({
      messaging_product: 'whatsapp',
      to,
      type: 'location',
      location: { latitude: String(latitude), longitude: String(longitude), name, address }
    });
  }

  async markAsRead(messageId) {
    if (!messageId) return { ok: false };
    return this.#send({ messaging_product: 'whatsapp', status: 'read', message_id: messageId });
  }

  async #send(body) {
    const { phoneNumberId, accessToken } = this.credentials;
    const response = await fetch(`${this.baseUrl}/${encodeURIComponent(phoneNumberId)}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });
    const data = await parseResponse(response);
    return { ok: true, providerMessageId: data?.messages?.[0]?.id || null, raw: data };
  }
}

export function verifyMetaSignature(rawBody, signatureHeader, appSecret) {
  if (!rawBody || !signatureHeader || !appSecret) return false;
  const expected = `sha256=${createHmac('sha256', appSecret).update(rawBody).digest('hex')}`;
  const actualBuffer = Buffer.from(String(signatureHeader));
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

export function normalizeMetaWebhook(payload) {
  const normalized = { messages: [], statuses: [], phoneNumberId: null };
  for (const entry of payload?.entry || []) {
    for (const change of entry?.changes || []) {
      const value = change?.value || {};
      normalized.phoneNumberId ||= value?.metadata?.phone_number_id || null;
      const contactByWaId = new Map((value.contacts || []).map((contact) => [contact.wa_id, contact]));
      for (const message of value.messages || []) {
        const contact = contactByWaId.get(message.from);
        normalized.messages.push({
          providerMessageId: message.id,
          from: message.from,
          timestamp: message.timestamp ? new Date(Number(message.timestamp) * 1000).toISOString() : new Date().toISOString(),
          type: message.type || 'unknown',
          text: message.text?.body || message.button?.text || message.interactive?.button_reply?.title || message.interactive?.list_reply?.title || '',
          contactName: contact?.profile?.name || null,
          mediaId: message.image?.id || message.audio?.id || message.video?.id || message.document?.id || null,
          mimeType: message.image?.mime_type || message.audio?.mime_type || message.video?.mime_type || message.document?.mime_type || null,
          filename: message.document?.filename || null,
          location: message.location || null,
          quotedMessageId: message.context?.id || null,
          raw: message
        });
      }
      for (const status of value.statuses || []) {
        normalized.statuses.push({
          providerMessageId: status.id,
          status: status.status,
          recipientId: status.recipient_id,
          timestamp: status.timestamp ? new Date(Number(status.timestamp) * 1000).toISOString() : new Date().toISOString(),
          errors: status.errors || []
        });
      }
    }
  }
  return normalized;
}
