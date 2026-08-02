import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const port = Number(process.env.WA_GATEWAY_PORT || 3090);
const gatewayToken = process.env.WA_GATEWAY_TOKEN || '';
const coreWebhook = process.env.CORE_BAILEYS_WEBHOOK_URL || 'http://localhost:3080/internal/baileys/events';
const internalToken = process.env.INTERNAL_WEBHOOK_TOKEN || '';
const dataDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'data/sessions');
fs.mkdirSync(dataDir, { recursive: true });

const sessions = new Map();
let baileysModule = null;
let baileysLoadError = null;

async function loadBaileys() {
  if (baileysModule) return baileysModule;
  if (baileysLoadError) throw baileysLoadError;
  try {
    baileysModule = await import('@whiskeysockets/baileys');
    return baileysModule;
  } catch (error) {
    baileysLoadError = new Error('حزمة Baileys غير مثبتة. شغّل npm install في بيئة متصلة ثم أعد تشغيل Gateway.');
    baileysLoadError.cause = error;
    throw baileysLoadError;
  }
}

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
  res.end(body);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024) throw Object.assign(new Error('Payload too large'), { status: 413 });
    chunks.push(chunk);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

function authorized(req) {
  return Boolean(gatewayToken) && req.headers.authorization === `Bearer ${gatewayToken}`;
}

async function emitCore(payload) {
  if (!internalToken) return;
  try {
    await fetch(coreWebhook, {
      method: 'POST',
      headers: { Authorization: `Bearer ${internalToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  } catch (error) {
    console.error(JSON.stringify({ level: 'error', message: 'تعذر إرسال الحدث للتطبيق الأساسي', error: error.message }));
  }
}

function normalizeMessage(message) {
  const content = message.message || {};
  const text = content.conversation || content.extendedTextMessage?.text || content.imageMessage?.caption || content.videoMessage?.caption || '';
  const remoteJid = message.key?.remoteJid || '';
  return {
    providerMessageId: message.key?.id || null,
    from: remoteJid.split('@')[0],
    timestamp: message.messageTimestamp ? new Date(Number(message.messageTimestamp) * 1000).toISOString() : new Date().toISOString(),
    type: content.imageMessage ? 'image' : content.audioMessage ? 'audio' : content.videoMessage ? 'video' : content.documentMessage ? 'document' : content.locationMessage ? 'location' : 'text',
    text,
    contactName: message.pushName || null,
    mediaId: null,
    mimeType: content.imageMessage?.mimetype || content.audioMessage?.mimetype || content.videoMessage?.mimetype || content.documentMessage?.mimetype || null,
    filename: content.documentMessage?.fileName || null,
    location: content.locationMessage ? { latitude: content.locationMessage.degreesLatitude, longitude: content.locationMessage.degreesLongitude } : null,
    quotedMessageId: content.extendedTextMessage?.contextInfo?.stanzaId || null
  };
}

async function startSession(connectionId, phoneNumber = '') {
  if (sessions.get(connectionId)?.socket) return sessions.get(connectionId);
  const baileys = await loadBaileys();
  const sessionDir = path.join(dataDir, connectionId);
  fs.mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  const { state, saveCreds } = await baileys.useMultiFileAuthState(sessionDir);
  const versionResult = typeof baileys.fetchLatestBaileysVersion === 'function' ? await baileys.fetchLatestBaileysVersion() : { version: undefined };
  const socket = baileys.default({
    auth: state,
    version: versionResult.version,
    printQRInTerminal: false,
    syncFullHistory: false,
    markOnlineOnConnect: false,
    generateHighQualityLinkPreview: false
  });
  const session = { connectionId, socket, status: 'connecting', qr: null, pairingCode: null, error: null, startedAt: new Date().toISOString() };
  sessions.set(connectionId, session);
  if (!state.creds.registered && phoneNumber && typeof socket.requestPairingCode === 'function') {
    try {
      session.pairingCode = await socket.requestPairingCode(String(phoneNumber).replace(/\D/g, ''));
      session.status = 'qr_required';
    } catch (error) {
      session.error = `تعذر إنشاء رمز الاقتران: ${error.message}`;
    }
  }

  socket.ev.on('creds.update', saveCreds);
  socket.ev.on('connection.update', async (update) => {
    if (update.qr) {
      session.qr = update.qr;
      session.status = 'qr_required';
      await emitCore({ event: 'status', connectionId, status: 'qr_required' });
    }
    if (update.connection === 'open') {
      session.status = 'connected'; session.qr = null; session.error = null;
      await emitCore({ event: 'status', connectionId, status: 'connected' });
    }
    if (update.connection === 'close') {
      const statusCode = update.lastDisconnect?.error?.output?.statusCode || update.lastDisconnect?.error?.statusCode;
      const loggedOut = statusCode === baileys.DisconnectReason?.loggedOut;
      session.status = loggedOut ? 'logged_out' : 'disconnected';
      session.error = update.lastDisconnect?.error?.message || null;
      session.socket = null;
      await emitCore({ event: 'status', connectionId, status: session.status, error: session.error });
      if (!loggedOut) setTimeout(() => startSession(connectionId, phoneNumber).catch(() => {}), 7000).unref();
    }
  });
  socket.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const message of messages || []) {
      if (!message.message || message.key?.fromMe || message.key?.remoteJid === 'status@broadcast') continue;
      await emitCore({ event: 'message', connectionId, message: normalizeMessage(message) });
    }
  });
  return session;
}

async function stopSession(connectionId, removeAuth = false) {
  const session = sessions.get(connectionId);
  try { session?.socket?.end?.(new Error('manual disconnect')); } catch {}
  sessions.delete(connectionId);
  if (removeAuth) fs.rmSync(path.join(dataDir, connectionId), { recursive: true, force: true });
}

async function sendMessage(connectionId, input) {
  const session = sessions.get(connectionId);
  if (!session?.socket || session.status !== 'connected') throw Object.assign(new Error('الجلسة غير متصلة'), { status: 409 });
  const jid = String(input.to || '').includes('@') ? input.to : `${String(input.to || '').replace(/\D/g, '')}@s.whatsapp.net`;
  if (!jid || jid === '@s.whatsapp.net') throw Object.assign(new Error('رقم المستلم مطلوب'), { status: 400 });
  if (input.type === 'text') return session.socket.sendMessage(jid, { text: String(input.text || '') });
  if (input.type === 'location') return session.socket.sendMessage(jid, { location: { degreesLatitude: Number(input.latitude), degreesLongitude: Number(input.longitude) } });
  throw Object.assign(new Error('في نسخة MVP يدعم Gateway النص والموقع. أضف تنزيل الوسائط الآمن قبل تفعيل باقي الأنواع.'), { status: 400 });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://localhost:${port}`);
  try {
    if (url.pathname === '/health') return json(res, 200, { ok: true, service: 'wa-gateway', baileysLoaded: Boolean(baileysModule), sessions: sessions.size });
    if (url.pathname === '/ready') return json(res, 200, { ok: true, ready: true, warning: baileysLoadError?.message || null });
    if (!authorized(req)) return json(res, 401, { ok: false, error: 'Unauthorized' });

    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] !== 'sessions' || !parts[1]) return json(res, 404, { ok: false, error: 'Not found' });
    const connectionId = parts[1];

    if (req.method === 'POST' && parts.length === 2) {
      const input = await readJson(req);
      const session = await startSession(connectionId, input.phoneNumber || '');
      return json(res, 202, { ok: true, connectionId, status: session.status, pairingCode: session.pairingCode });
    }
    if (req.method === 'GET' && parts.length === 2) {
      const session = sessions.get(connectionId);
      return json(res, 200, { ok: true, connectionId, status: session?.status || 'disconnected', qr: session?.qr || null, pairingCode: session?.pairingCode || null, error: session?.error || null });
    }
    if (req.method === 'DELETE' && parts.length === 2) {
      await stopSession(connectionId, url.searchParams.get('removeAuth') === 'true');
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && parts[2] === 'send') {
      const result = await sendMessage(connectionId, await readJson(req));
      return json(res, 200, { ok: true, providerMessageId: result?.key?.id || null });
    }
    return json(res, 404, { ok: false, error: 'Not found' });
  } catch (error) {
    console.error(JSON.stringify({ level: 'error', message: error.message }));
    return json(res, error.status || 500, { ok: false, error: error.status && error.status < 500 ? error.message : 'حدث خطأ في Gateway' });
  }
});

server.listen(port, () => console.log(JSON.stringify({ level: 'info', message: 'WA Gateway started', port })));

async function shutdown() {
  await Promise.allSettled([...sessions.keys()].map((id) => stopSession(id, false)));
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 8000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
