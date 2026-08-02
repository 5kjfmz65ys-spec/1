import http from 'node:http';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { config } from './src/config.mjs';
import { createCryptoBox } from './src/crypto.mjs';
import { clearSessionCookie, getRequestContext, listMemberships, login, logout, requireContext, requireRole, setSessionCookie, signup, switchOrganization } from './src/auth.mjs';
import { all, closeDatabase, get, nowIso, run } from './src/db.mjs';
import { getClientIp, json, readBody, readJson, redirect, securityHeaders, serveStatic, text } from './src/http.mjs';
import { logger } from './src/logger.mjs';
import {
  audit, createInvite, createKnowledge, createProduct, createUnofficialConnection, deleteKnowledge,
  disconnectConnection, getAISettings, getConnectionCredentials, getConnectionForOrganization, getConversation,
  getDashboard, getReports, listConnections, listConversations, listKnowledge, listOrders, listProducts, listTeam,
  saveAISettings, saveOfficialConnection, sendConversationMessage, testAISettings, testConnection, updateConversation,
  updateOrganization
} from './src/services.mjs';
import { generateAgentReply } from './src/agent.mjs';
import { applyDeliveryStatus, ingestIncomingMessage, markWebhookProcessed, maybeAutoReply, saveWebhookEvent } from './src/inbound.mjs';
import { normalizeMetaWebhook, verifyMetaSignature } from './src/providers/whatsapp/official.mjs';

const publicDir = path.resolve(process.cwd(), 'public');
const cryptoBox = createCryptoBox(config.encryptionKey);
const rateBuckets = new Map();

function clientFingerprint(req) {
  return createHash('sha256').update(getClientIp(req)).digest('hex');
}

function rateLimit(req, key, limit = 60, windowMs = 60000) {
  const bucketKey = `${key}:${getClientIp(req)}`;
  const now = Date.now();
  const bucket = rateBuckets.get(bucketKey) || { count: 0, resetAt: now + windowMs };
  if (bucket.resetAt <= now) {
    bucket.count = 0;
    bucket.resetAt = now + windowMs;
  }
  bucket.count += 1;
  rateBuckets.set(bucketKey, bucket);
  if (bucket.count > limit) {
    const error = new Error('عدد الطلبات مرتفع، حاول بعد قليل');
    error.status = 429;
    throw error;
  }
}

function assertSameOrigin(req) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return;
  const origin = req.headers.origin;
  if (!origin) return;
  const expected = new URL(config.appUrl).origin;
  if (origin !== expected) {
    const error = new Error('مصدر الطلب غير مسموح');
    error.status = 403;
    throw error;
  }
}

function pathMatch(pathname, pattern) {
  const pathParts = pathname.split('/').filter(Boolean);
  const patternParts = pattern.split('/').filter(Boolean);
  if (pathParts.length !== patternParts.length) return null;
  const params = {};
  for (let index = 0; index < patternParts.length; index += 1) {
    const expected = patternParts[index];
    const actual = pathParts[index];
    if (expected.startsWith(':')) params[expected.slice(1)] = decodeURIComponent(actual);
    else if (expected !== actual) return null;
  }
  return params;
}

function safeContext(req) {
  const context = getRequestContext(req);
  if (!context) return null;
  return context;
}

async function handleApi(req, res, url) {
  const { pathname, searchParams } = url;

  if (pathname === '/api/health' && req.method === 'GET') {
    return json(res, 200, { ok: true, service: 'reddad-ai', time: nowIso() });
  }

  if (pathname === '/api/auth/signup' && req.method === 'POST') {
    rateLimit(req, 'signup', 8, 10 * 60000);
    assertSameOrigin(req);
    const result = signup(await readJson(req));
    if (!result.ok) return json(res, result.status, { ok: false, error: result.error });
    setSessionCookie(res, result.session.token, result.session.expiresAt);
    return json(res, 201, { ok: true, redirect: '/app' });
  }

  if (pathname === '/api/auth/login' && req.method === 'POST') {
    rateLimit(req, 'login', 15, 10 * 60000);
    assertSameOrigin(req);
    const result = login(await readJson(req));
    if (!result.ok) return json(res, result.status, { ok: false, error: result.error });
    setSessionCookie(res, result.session.token, result.session.expiresAt);
    return json(res, 200, { ok: true, user: result.user, redirect: '/app' });
  }

  if (pathname === '/api/auth/logout' && req.method === 'POST') {
    assertSameOrigin(req);
    logout(req);
    clearSessionCookie(res);
    return json(res, 200, { ok: true });
  }

  if (pathname === '/api/me' && req.method === 'GET') {
    const context = requireContext(req);
    return json(res, 200, { ...context, memberships: listMemberships(context.user.id) });
  }

  const switchParams = pathMatch(pathname, '/api/organizations/:id/switch');
  if (switchParams && req.method === 'POST') {
    assertSameOrigin(req);
    const context = requireContext(req);
    switchOrganization(context, switchParams.id);
    return json(res, 200, { ok: true });
  }

  if (pathname === '/api/dashboard' && req.method === 'GET') {
    return json(res, 200, getDashboard(requireContext(req)));
  }

  if (pathname === '/api/organization' && req.method === 'GET') {
    const context = requireContext(req);
    return json(res, 200, get('SELECT id, name, activity, timezone, created_at, updated_at FROM organizations WHERE id = ?', [context.organization.id]));
  }

  if (pathname === '/api/organization' && req.method === 'PATCH') {
    assertSameOrigin(req);
    const context = requireContext(req);
    requireRole(context, ['owner', 'admin']);
    return json(res, 200, updateOrganization(context, await readJson(req)));
  }

  if (pathname === '/api/team' && req.method === 'GET') {
    return json(res, 200, listTeam(requireContext(req)));
  }

  if (pathname === '/api/team/invites' && req.method === 'POST') {
    assertSameOrigin(req);
    const context = requireContext(req);
    requireRole(context, ['owner', 'admin']);
    return json(res, 201, createInvite(context, await readJson(req)));
  }

  if (pathname === '/api/connections' && req.method === 'GET') {
    return json(res, 200, listConnections(requireContext(req)));
  }

  if (pathname === '/api/connections/official' && req.method === 'POST') {
    assertSameOrigin(req);
    const context = requireContext(req);
    requireRole(context, ['owner', 'admin']);
    return json(res, 201, saveOfficialConnection(context, cryptoBox, await readJson(req)));
  }

  if (pathname === '/api/connections/unofficial' && req.method === 'POST') {
    assertSameOrigin(req);
    const context = requireContext(req);
    requireRole(context, ['owner', 'admin']);
    const input = await readJson(req);
    const connection = createUnofficialConnection(context, input, {
      userAgent: req.headers['user-agent'] || '',
      ipHash: clientFingerprint(req)
    });
    return json(res, 201, connection);
  }

  const connectionTest = pathMatch(pathname, '/api/connections/:id/test');
  if (connectionTest && req.method === 'POST') {
    assertSameOrigin(req);
    const context = requireContext(req);
    requireRole(context, ['owner', 'admin']);
    return json(res, 200, await testConnection(context, cryptoBox, connectionTest.id));
  }

  const connectionStart = pathMatch(pathname, '/api/connections/:id/start');
  if (connectionStart && req.method === 'POST') {
    assertSameOrigin(req);
    const context = requireContext(req);
    requireRole(context, ['owner', 'admin']);
    const connection = getConnectionForOrganization(context, connectionStart.id);
    if (connection.type !== 'unofficial') throw Object.assign(new Error('هذا المسار للربط التجريبي فقط'), { status: 400 });
    const consent = get('SELECT id FROM whatsapp_connection_consents WHERE connection_id = ? AND organization_id = ?', [connection.id, context.organization.id]);
    if (!consent) throw Object.assign(new Error('لا يمكن إنشاء QR قبل قبول التحذير'), { status: 400 });
    if (!config.waGatewayToken) throw Object.assign(new Error('WA_GATEWAY_TOKEN غير مضبوط. شغّل Gateway وأضف الرمز في .env'), { status: 503 });
    const response = await fetch(`${config.waGatewayUrl}/sessions/${connection.id}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.waGatewayToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ phoneNumber: connection.phone_number || '' })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(data.error || 'تعذر تشغيل Gateway'), { status: 502 });
    run('UPDATE whatsapp_connections SET status = ?, last_error = NULL, updated_at = ? WHERE id = ?', [data.status || 'connecting', nowIso(), connection.id]);
    audit(context, 'whatsapp.unofficial.started', 'whatsapp_connection', connection.id);
    return json(res, 202, data);
  }

  const connectionStatus = pathMatch(pathname, '/api/connections/:id/status');
  if (connectionStatus && req.method === 'GET') {
    const context = requireContext(req);
    const connection = getConnectionForOrganization(context, connectionStatus.id);
    if (connection.type !== 'unofficial') return json(res, 200, { ok: true, status: connection.status, qr: null });
    if (!config.waGatewayToken) return json(res, 200, { ok: false, status: 'setup_required', qr: null, error: 'Gateway غير مهيأ' });
    try {
      const response = await fetch(`${config.waGatewayUrl}/sessions/${connection.id}`, { headers: { Authorization: `Bearer ${config.waGatewayToken}` } });
      const data = await response.json();
      return json(res, response.ok ? 200 : 502, data);
    } catch (error) {
      return json(res, 200, { ok: false, status: 'setup_required', qr: null, error: `تعذر الوصول إلى Gateway: ${error.message}` });
    }
  }

  const connectionDisconnect = pathMatch(pathname, '/api/connections/:id/disconnect');
  if (connectionDisconnect && req.method === 'POST') {
    assertSameOrigin(req);
    const context = requireContext(req);
    requireRole(context, ['owner', 'admin']);
    return json(res, 200, disconnectConnection(context, connectionDisconnect.id));
  }

  if (pathname === '/api/conversations' && req.method === 'GET') {
    return json(res, 200, listConversations(requireContext(req)));
  }

  const conversationMessages = pathMatch(pathname, '/api/conversations/:id/messages');
  if (conversationMessages && req.method === 'GET') {
    return json(res, 200, getConversation(requireContext(req), conversationMessages.id));
  }
  if (conversationMessages && req.method === 'POST') {
    assertSameOrigin(req);
    const context = requireContext(req);
    requireRole(context, ['owner', 'admin', 'supervisor', 'agent']);
    return json(res, 201, await sendConversationMessage(context, cryptoBox, conversationMessages.id, await readJson(req)));
  }

  const conversationUpdate = pathMatch(pathname, '/api/conversations/:id');
  if (conversationUpdate && req.method === 'PATCH') {
    assertSameOrigin(req);
    const context = requireContext(req);
    requireRole(context, ['owner', 'admin', 'supervisor', 'agent']);
    return json(res, 200, updateConversation(context, conversationUpdate.id, await readJson(req)));
  }

  if (pathname === '/api/knowledge' && req.method === 'GET') {
    return json(res, 200, listKnowledge(requireContext(req)));
  }
  if (pathname === '/api/knowledge' && req.method === 'POST') {
    assertSameOrigin(req);
    const context = requireContext(req);
    requireRole(context, ['owner', 'admin', 'supervisor']);
    return json(res, 201, createKnowledge(context, await readJson(req)));
  }
  const knowledgeDelete = pathMatch(pathname, '/api/knowledge/:id');
  if (knowledgeDelete && req.method === 'DELETE') {
    assertSameOrigin(req);
    const context = requireContext(req);
    requireRole(context, ['owner', 'admin', 'supervisor']);
    return json(res, 200, deleteKnowledge(context, knowledgeDelete.id));
  }

  if (pathname === '/api/ai-settings' && req.method === 'GET') {
    return json(res, 200, getAISettings(requireContext(req), cryptoBox));
  }
  if (pathname === '/api/ai-settings' && req.method === 'PUT') {
    assertSameOrigin(req);
    const context = requireContext(req);
    requireRole(context, ['owner', 'admin']);
    return json(res, 200, saveAISettings(context, cryptoBox, await readJson(req)));
  }
  if (pathname === '/api/ai-settings/test' && req.method === 'POST') {
    assertSameOrigin(req);
    const context = requireContext(req);
    requireRole(context, ['owner', 'admin']);
    return json(res, 200, await testAISettings(context, cryptoBox, await readJson(req)));
  }
  if (pathname === '/api/assistant/preview' && req.method === 'POST') {
    assertSameOrigin(req);
    const context = requireContext(req);
    const input = await readJson(req);
    const result = await generateAgentReply({ context, cryptoBox, customerText: String(input.text || ''), history: [] });
    return json(res, 200, result);
  }

  if (pathname === '/api/products' && req.method === 'GET') {
    return json(res, 200, listProducts(requireContext(req)));
  }
  if (pathname === '/api/products' && req.method === 'POST') {
    assertSameOrigin(req);
    const context = requireContext(req);
    requireRole(context, ['owner', 'admin', 'supervisor']);
    return json(res, 201, createProduct(context, await readJson(req)));
  }
  if (pathname === '/api/orders' && req.method === 'GET') {
    return json(res, 200, listOrders(requireContext(req)));
  }
  if (pathname === '/api/reports' && req.method === 'GET') {
    return json(res, 200, getReports(requireContext(req)));
  }
  if (pathname === '/api/audit-logs' && req.method === 'GET') {
    const context = requireContext(req);
    requireRole(context, ['owner', 'admin']);
    return json(res, 200, all('SELECT * FROM audit_logs WHERE organization_id = ? ORDER BY created_at DESC LIMIT 200', [context.organization.id]));
  }

  return json(res, 404, { ok: false, error: 'المسار غير موجود' });
}

async function handleMetaWebhook(req, res, url, connectionId) {
  const connection = get('SELECT * FROM whatsapp_connections WHERE id = ? AND type = ?', [connectionId, 'official']);
  if (!connection) return json(res, 404, { ok: false, error: 'الاتصال غير موجود' });
  const credentials = cryptoBox.decrypt(connection.credential_blob);

  if (req.method === 'GET') {
    const mode = url.searchParams.get('hub.mode');
    const token = url.searchParams.get('hub.verify_token');
    const challenge = url.searchParams.get('hub.challenge');
    if (mode === 'subscribe' && token === credentials.verifyToken) return text(res, 200, challenge || '');
    return text(res, 403, 'Verification failed');
  }

  if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'Method not allowed' });
  const rawBody = await readBody(req, 2 * 1024 * 1024);
  if (!verifyMetaSignature(rawBody, req.headers['x-hub-signature-256'], credentials.appSecret)) {
    return json(res, 401, { ok: false, error: 'توقيع Webhook غير صحيح' });
  }
  let payload;
  try { payload = JSON.parse(rawBody.toString('utf8')); }
  catch { return json(res, 400, { ok: false, error: 'Payload غير صحيح' }); }
  const saved = saveWebhookEvent({
    organizationId: connection.organization_id,
    connectionId: connection.id,
    provider: 'meta',
    rawBody,
    payload
  });
  json(res, 200, { ok: true, duplicate: saved.duplicate });
  if (saved.duplicate) return;
  setImmediate(async () => {
    try {
      const normalized = normalizeMetaWebhook(payload);
      for (const status of normalized.statuses) applyDeliveryStatus(connection.organization_id, status);
      for (const message of normalized.messages) {
        const result = ingestIncomingMessage({ organizationId: connection.organization_id, connectionId: connection.id, message });
        if (!result.duplicate) {
          await maybeAutoReply({
            organizationId: connection.organization_id,
            connectionId: connection.id,
            conversationId: result.conversationId,
            customerText: message.text,
            cryptoBox
          });
        }
      }
      markWebhookProcessed(saved.eventId);
    } catch (error) {
      logger.error('فشل معالجة Meta Webhook', { connectionId, error: error.message });
      markWebhookProcessed(saved.eventId, error.message);
    }
  });
}

async function handleInternalBaileys(req, res) {
  if (req.method !== 'POST') return json(res, 405, { ok: false });
  if (!config.internalWebhookToken || req.headers.authorization !== `Bearer ${config.internalWebhookToken}`) {
    return json(res, 401, { ok: false, error: 'Unauthorized' });
  }
  const input = await readJson(req, 2 * 1024 * 1024);
  const connection = get('SELECT * FROM whatsapp_connections WHERE id = ? AND type = ?', [input.connectionId, 'unofficial']);
  if (!connection) return json(res, 404, { ok: false, error: 'Connection not found' });
  if (input.event === 'status') {
    run('UPDATE whatsapp_connections SET status = ?, last_error = ?, updated_at = ? WHERE id = ?', [input.status, input.error || null, nowIso(), connection.id]);
    return json(res, 200, { ok: true });
  }
  if (input.event === 'message') {
    const result = ingestIncomingMessage({ organizationId: connection.organization_id, connectionId: connection.id, message: input.message });
    json(res, 200, { ok: true, duplicate: result.duplicate });
    if (!result.duplicate) {
      setImmediate(() => maybeAutoReply({
        organizationId: connection.organization_id,
        connectionId: connection.id,
        conversationId: result.conversationId,
        customerText: input.message.text,
        cryptoBox
      }).catch((error) => logger.error('فشل الرد على رسالة Baileys', { error: error.message })));
    }
    return;
  }
  return json(res, 400, { ok: false, error: 'Unknown event' });
}

const server = http.createServer(async (req, res) => {
  securityHeaders(res);
  const url = new URL(req.url || '/', config.appUrl);
  try {
    const webhookParams = pathMatch(url.pathname, '/webhooks/meta/:connectionId');
    if (webhookParams) return await handleMetaWebhook(req, res, url, webhookParams.connectionId);
    if (url.pathname === '/internal/baileys/events') return await handleInternalBaileys(req, res);
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);

    if (url.pathname === '/app') {
      if (!safeContext(req)) return redirect(res, '/login.html');
      return serveStatic(req, res, publicDir, '/app.html') || json(res, 404, { error: 'App not found' });
    }
    if ((url.pathname === '/login.html' || url.pathname === '/signup.html') && safeContext(req)) return redirect(res, '/app');
    if (serveStatic(req, res, publicDir, url.pathname)) return;
    return text(res, 404, 'الصفحة غير موجودة');
  } catch (error) {
    logger.error('فشل الطلب', { method: req.method, path: url.pathname, error: error.message, code: error.code });
    if (!res.headersSent) json(res, Number(error.status || 500), { ok: false, error: error.status && error.status < 500 ? error.message : 'حدث خطأ داخلي', code: error.code || null });
    else res.end();
  }
});

server.listen(config.port, () => {
  logger.info('تم تشغيل ردّاد AI', { url: config.appUrl, port: config.port });
});

function shutdown(signal) {
  logger.info('إيقاف الخدمة', { signal });
  server.close(() => {
    closeDatabase();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
