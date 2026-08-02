import { randomUUID } from 'node:crypto';
import { get, nowIso, run, transaction } from '../src/db.mjs';
import { hashPassword } from '../src/crypto.mjs';

const email = 'demo@reddad.local';
const password = 'Demo12345!';
let user = get('SELECT * FROM users WHERE email = ?', [email]);
let organization;

if (!user) {
  const userId = randomUUID();
  const organizationId = randomUUID();
  const timestamp = nowIso();
  transaction(() => {
    run('INSERT INTO users (id, name, email, password_hash, created_at) VALUES (?, ?, ?, ?, ?)', [userId, 'مدير التجربة', email, hashPassword(password), timestamp]);
    run('INSERT INTO organizations (id, name, slug, activity, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', [organizationId, 'متجر ردّاد التجريبي', 'demo-store', 'متجر ذهب ومجوهرات', timestamp, timestamp]);
    run('INSERT INTO memberships (id, user_id, organization_id, role, status, created_at) VALUES (?, ?, ?, ?, ?, ?)', [randomUUID(), userId, organizationId, 'owner', 'active', timestamp]);
    run('INSERT INTO ai_settings (id, organization_id, assistant_name, tone, updated_at) VALUES (?, ?, ?, ?, ?)', [randomUUID(), organizationId, 'نورة', 'ودود ومختصر باللهجة السعودية', timestamp]);
  });
  user = get('SELECT * FROM users WHERE id = ?', [userId]);
  organization = get('SELECT * FROM organizations WHERE id = ?', [organizationId]);
} else {
  organization = get(`SELECT o.* FROM memberships m JOIN organizations o ON o.id = m.organization_id WHERE m.user_id = ? LIMIT 1`, [user.id]);
}

const orgId = organization.id;
const timestamp = nowIso();
const knowledge = [
  ['مدة التوصيل', 'كم مدة التوصيل؟', 'التوصيل داخل القصيم يستغرق عادة من يوم إلى 3 أيام عمل، وخارج القصيم من 3 إلى 6 أيام عمل.', 'policy'],
  ['سياسة الاستبدال', 'هل يمكن الاستبدال؟', 'يمكن طلب الاستبدال خلال 3 أيام من الاستلام بشرط بقاء القطعة بحالتها الأصلية وعدم استخدامها.', 'policy'],
  ['طرق الدفع', 'وش طرق الدفع؟', 'ندعم مدى وفيزا وماستركارد وApple Pay والتحويل البنكي حسب توفرها في المتجر.', 'qa']
];
for (const [title, question, answer, sourceType] of knowledge) {
  if (!get('SELECT id FROM knowledge_entries WHERE organization_id = ? AND title = ?', [orgId, title])) {
    run('INSERT INTO knowledge_entries (id, organization_id, title, question, answer, source_type, status, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [randomUUID(), orgId, title, question, answer, sourceType, 'ready', user.id, timestamp, timestamp]);
  }
}

const productRows = [
  ['خاتم ذهب عيار 21', 'RING-21-001', 'خاتم شرقي لامع', 1250, 4],
  ['سوار ذهب عيار 18', 'BRACELET-18-002', 'سوار ناعم للاستخدام اليومي', 980, 7]
];
for (const [name, sku, description, price, stock] of productRows) {
  if (!get('SELECT id FROM products WHERE organization_id = ? AND sku = ?', [orgId, sku])) {
    run('INSERT INTO products (id, organization_id, name, sku, description, price, stock, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)', [randomUUID(), orgId, name, sku, description, price, stock, timestamp, timestamp]);
  }
}

if (!get('SELECT id FROM contacts WHERE organization_id = ? LIMIT 1', [orgId])) {
  const contactId = randomUUID();
  const conversationId = randomUUID();
  run('INSERT INTO contacts (id, organization_id, phone, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', [contactId, orgId, '966500000001', 'سارة', timestamp, timestamp]);
  run("INSERT INTO conversations (id, organization_id, contact_id, status, control_mode, unread_count, last_message_at, created_at, updated_at) VALUES (?, ?, ?, 'open', 'ai_active', 1, ?, ?, ?)", [conversationId, orgId, contactId, timestamp, timestamp, timestamp]);
  run("INSERT INTO messages (id, organization_id, conversation_id, direction, type, text, status, sender_type, created_at) VALUES (?, ?, ?, 'inbound', 'text', ?, 'received', 'customer', ?)", [randomUUID(), orgId, conversationId, 'السلام عليكم، كم مدة التوصيل لبريدة؟', timestamp]);
}

console.log('تم إنشاء بيانات التجربة:');
console.log(`البريد: ${email}`);
console.log(`كلمة المرور: ${password}`);
