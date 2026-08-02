import { randomBytes, randomUUID } from 'node:crypto';
import { config } from './config.mjs';
import { all, get, nowIso, run, transaction } from './db.mjs';
import { hashPassword, hashToken, verifyPassword } from './crypto.mjs';

const COOKIE_NAME = 'reddad_session';

export function parseCookies(header = '') {
  const out = {};
  for (const part of String(header).split(';')) {
    const index = part.indexOf('=');
    if (index < 1) continue;
    out[decodeURIComponent(part.slice(0, index).trim())] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return out;
}

export function setSessionCookie(res, token, expiresAt) {
  const secure = config.cookieSecure ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Expires=${new Date(expiresAt).toUTCString()}${secure}`);
}

export function clearSessionCookie(res) {
  const secure = config.cookieSecure ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`);
}

function createSession(userId, activeOrganizationId) {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + config.sessionTtlDays * 86400000).toISOString();
  run(
    'INSERT INTO sessions (id, token_hash, user_id, active_organization_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [randomUUID(), hashToken(token), userId, activeOrganizationId, expiresAt, nowIso()]
  );
  return { token, expiresAt };
}

export function validateSignup(input) {
  const name = String(input.name || '').trim();
  const email = String(input.email || '').trim().toLowerCase();
  const password = String(input.password || '');
  const organizationName = String(input.organizationName || '').trim();
  const errors = [];
  if (name.length < 2) errors.push('الاسم قصير');
  if (!/^\S+@\S+\.\S+$/.test(email)) errors.push('البريد الإلكتروني غير صحيح');
  if (password.length < 8) errors.push('كلمة المرور يجب أن تكون 8 أحرف على الأقل');
  if (organizationName.length < 2) errors.push('اسم المنشأة مطلوب');
  return { ok: errors.length === 0, errors, value: { name, email, password, organizationName } };
}

function makeSlug(name) {
  const base = String(name)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 42) || 'store';
  let slug = base;
  let counter = 1;
  while (get('SELECT id FROM organizations WHERE slug = ?', [slug])) slug = `${base}-${counter++}`;
  return slug;
}

export function signup(input) {
  const parsed = validateSignup(input);
  if (!parsed.ok) return { ok: false, status: 400, error: parsed.errors.join('، ') };
  const { name, email, password, organizationName } = parsed.value;
  if (get('SELECT id FROM users WHERE email = ? COLLATE NOCASE', [email])) {
    return { ok: false, status: 409, error: 'البريد مسجل مسبقًا' };
  }
  const userId = randomUUID();
  const organizationId = randomUUID();
  const createdAt = nowIso();
  try {
    transaction(() => {
      run('INSERT INTO users (id, name, email, password_hash, created_at) VALUES (?, ?, ?, ?, ?)', [
        userId,
        name,
        email,
        hashPassword(password),
        createdAt
      ]);
      run('INSERT INTO organizations (id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', [
        organizationId,
        organizationName,
        makeSlug(organizationName),
        createdAt,
        createdAt
      ]);
      run('INSERT INTO memberships (id, user_id, organization_id, role, status, created_at) VALUES (?, ?, ?, ?, ?, ?)', [
        randomUUID(),
        userId,
        organizationId,
        'owner',
        'active',
        createdAt
      ]);
      run('INSERT INTO ai_settings (id, organization_id, updated_at) VALUES (?, ?, ?)', [randomUUID(), organizationId, createdAt]);
    });
  } catch (error) {
    return { ok: false, status: 500, error: 'تعذر إنشاء الحساب', details: error.message };
  }
  const session = createSession(userId, organizationId);
  return { ok: true, userId, organizationId, session };
}

export function login(input) {
  const email = String(input.email || '').trim().toLowerCase();
  const password = String(input.password || '');
  const user = get('SELECT id, name, email, password_hash FROM users WHERE email = ? COLLATE NOCASE', [email]);
  if (!user || !verifyPassword(password, user.password_hash)) {
    return { ok: false, status: 401, error: 'البريد أو كلمة المرور غير صحيحة' };
  }
  const membership = get(
    "SELECT organization_id FROM memberships WHERE user_id = ? AND status = 'active' ORDER BY created_at LIMIT 1",
    [user.id]
  );
  if (!membership) return { ok: false, status: 403, error: 'لا توجد منشأة مفعلة لهذا الحساب' };
  const session = createSession(user.id, membership.organization_id);
  return { ok: true, user: { id: user.id, name: user.name, email: user.email }, session };
}

export function logout(req) {
  const token = parseCookies(req.headers.cookie || '')[COOKIE_NAME];
  if (token) run('DELETE FROM sessions WHERE token_hash = ?', [hashToken(token)]);
}

export function getRequestContext(req) {
  const token = parseCookies(req.headers.cookie || '')[COOKIE_NAME];
  if (!token) return null;
  const session = get(
    `SELECT s.id AS session_id, s.user_id, s.active_organization_id, s.expires_at,
            u.name AS user_name, u.email AS user_email
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?`,
    [hashToken(token)]
  );
  if (!session || new Date(session.expires_at).getTime() <= Date.now()) {
    if (session) run('DELETE FROM sessions WHERE id = ?', [session.session_id]);
    return null;
  }
  const membership = get(
    `SELECT m.role, m.status, o.id AS organization_id, o.name AS organization_name, o.activity, o.timezone
       FROM memberships m JOIN organizations o ON o.id = m.organization_id
      WHERE m.user_id = ? AND m.organization_id = ? AND m.status = 'active'`,
    [session.user_id, session.active_organization_id]
  );
  if (!membership) return null;
  return {
    sessionId: session.session_id,
    user: { id: session.user_id, name: session.user_name, email: session.user_email },
    organization: {
      id: membership.organization_id,
      name: membership.organization_name,
      activity: membership.activity,
      timezone: membership.timezone
    },
    role: membership.role
  };
}

export function requireContext(req) {
  const context = getRequestContext(req);
  if (!context) {
    const error = new Error('يجب تسجيل الدخول');
    error.status = 401;
    throw error;
  }
  return context;
}

export function requireRole(context, allowed) {
  if (!allowed.includes(context.role)) {
    const error = new Error('ليس لديك صلاحية لتنفيذ هذه العملية');
    error.status = 403;
    throw error;
  }
}

export function listMemberships(userId) {
  return all(
    `SELECT o.id, o.name, o.activity, m.role
       FROM memberships m JOIN organizations o ON o.id = m.organization_id
      WHERE m.user_id = ? AND m.status = 'active' ORDER BY o.name`,
    [userId]
  );
}

export function switchOrganization(context, organizationId) {
  const membership = get(
    "SELECT id FROM memberships WHERE user_id = ? AND organization_id = ? AND status = 'active'",
    [context.user.id, organizationId]
  );
  if (!membership) {
    const error = new Error('لا يمكنك الوصول لهذه المنشأة');
    error.status = 403;
    throw error;
  }
  run('UPDATE sessions SET active_organization_id = ? WHERE id = ?', [organizationId, context.sessionId]);
}
