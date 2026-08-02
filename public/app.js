const state = {
  context: null,
  view: 'dashboard',
  activeConversationId: null,
  conversations: [],
  theme: localStorage.getItem('reddad-theme') || 'light'
};

document.documentElement.dataset.theme = state.theme;

const pageContent = document.getElementById('pageContent');
const modalRoot = document.getElementById('modalRoot');
const toastContainer = document.getElementById('toastContainer');

const viewLabels = {
  dashboard: 'الرئيسية', connections: 'ربط واتساب', inbox: 'المحادثات', assistant: 'الموظف الذكي',
  knowledge: 'قاعدة المعرفة', products: 'المنتجات', orders: 'الطلبات', team: 'الفريق', reports: 'التقارير', settings: 'الإعدادات'
};

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
}

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('ar-SA', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function statusBadge(status) {
  const map = {
    connected: ['success', 'متصل'], disconnected: ['', 'غير متصل'], setup_required: ['warning', 'يحتاج إعداد'],
    error: ['danger', 'خطأ'], qr_required: ['warning', 'بانتظار المسح'], restricted: ['danger', 'مقيّد'],
    open: ['success', 'مفتوحة'], waiting_for_agent: ['warning', 'تنتظر موظفًا'], closed: ['', 'مغلقة'],
    sent: ['success', 'أُرسلت'], delivered: ['success', 'وصلت'], read: ['success', 'قُرئت'], failed: ['danger', 'فشلت'], queued: ['warning', 'بالانتظار']
  };
  const [kind, label] = map[status] || ['', status || 'غير معروف'];
  return `<span class="badge ${kind}"><span class="status-dot"></span>${escapeHtml(label)}</span>`;
}

async function api(url, options = {}) {
  const headers = { ...(options.body && !(options.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) };
  const response = await fetch(url, { ...options, headers });
  let data = null;
  try { data = await response.json(); } catch { data = {}; }
  if (response.status === 401) {
    window.location.href = '/login.html';
    throw new Error('انتهت الجلسة');
  }
  if (!response.ok) throw new Error(data.error || `فشل الطلب (${response.status})`);
  return data;
}

function toast(message, type = 'success') {
  const element = document.createElement('div');
  element.className = `toast ${type === 'error' ? 'error' : ''}`;
  element.textContent = message;
  toastContainer.appendChild(element);
  setTimeout(() => element.remove(), 4200);
}

function openModal({ title, body, footer = '' }) {
  modalRoot.innerHTML = `<div class="modal-backdrop" id="modalBackdrop"><div class="modal" role="dialog" aria-modal="true"><div class="modal-head"><strong>${escapeHtml(title)}</strong><button class="icon-btn" id="modalClose">×</button></div><div class="modal-body">${body}</div>${footer ? `<div class="modal-foot">${footer}</div>` : ''}</div></div>`;
  document.getElementById('modalClose').onclick = closeModal;
  document.getElementById('modalBackdrop').addEventListener('click', (event) => { if (event.target.id === 'modalBackdrop') closeModal(); });
}
function closeModal() { modalRoot.innerHTML = ''; }

function setLoading() {
  pageContent.innerHTML = `<div class="skeleton" style="height:42px;width:260px;margin-bottom:22px"></div><div class="stats"><div class="skeleton" style="height:110px"></div><div class="skeleton" style="height:110px"></div><div class="skeleton" style="height:110px"></div><div class="skeleton" style="height:110px"></div></div><div class="grid-2"><div class="skeleton" style="height:320px"></div><div class="skeleton" style="height:320px"></div></div>`;
}

function pageHead(title, description, action = '') {
  return `<div class="page-head"><div><h1>${escapeHtml(title)}</h1><p>${escapeHtml(description)}</p></div>${action}</div>`;
}

async function navigate(view) {
  state.view = view;
  state.activeConversationId = null;
  document.querySelectorAll('.nav-item').forEach((item) => item.classList.toggle('active', item.dataset.view === view));
  document.getElementById('breadcrumb').textContent = viewLabels[view] || view;
  setLoading();
  try {
    const render = views[view] || views.dashboard;
    await render();
  } catch (error) {
    pageContent.innerHTML = `${pageHead('تعذر تحميل الصفحة', error.message)}<div class="notice">حاول تحديث الصفحة أو راجع إعدادات التشغيل.</div>`;
    toast(error.message, 'error');
  }
}

const views = {
  async dashboard() {
    const data = await api('/api/dashboard');
    const metrics = data.metrics;
    pageContent.innerHTML = `${pageHead('نظرة عامة', `مرحبًا ${state.context.user.name}، هذه حالة خدمة العملاء اليوم.`, '<button class="btn btn-primary" data-action="go-connections">ربط واتساب</button>')}
      <div class="stats">
        <div class="stat"><div class="stat-number">${metrics.openConversations}</div><div class="stat-label">محادثات مفتوحة</div></div>
        <div class="stat"><div class="stat-number">${metrics.unread}</div><div class="stat-label">رسائل غير مقروءة</div></div>
        <div class="stat"><div class="stat-number">${metrics.contacts}</div><div class="stat-label">عميل</div></div>
        <div class="stat"><div class="stat-number">${metrics.aiReplies}</div><div class="stat-label">ردود ذكية</div></div>
      </div>
      <div class="grid-2">
        <section class="panel"><div class="panel-head"><strong>آخر المحادثات</strong><button class="btn btn-ghost btn-sm" data-action="go-inbox">عرض الكل</button></div><div class="list">${data.recent.length ? data.recent.map((item) => `<div class="list-row"><div><strong>${escapeHtml(item.contact_name || item.phone)}</strong><div class="small muted">${escapeHtml(item.last_text || 'لا توجد رسالة')}</div></div><div>${statusBadge(item.status)}<div class="small muted">${formatDate(item.last_message_at)}</div></div></div>`).join('') : '<div class="empty"><strong>لا توجد محادثات بعد</strong>ستظهر الرسائل الواردة هنا.</div>'}</div></section>
        <section class="panel"><div class="panel-head"><strong>اتصالات واتساب</strong><button class="btn btn-ghost btn-sm" data-action="go-connections">الإعداد</button></div><div class="list">${data.connections.length ? data.connections.map((connection) => `<div class="list-row"><div><strong>${escapeHtml(connection.name)}</strong><div class="small muted">${connection.type === 'official' ? 'رسمي عبر Meta' : 'تجريبي غير رسمي'}</div></div>${statusBadge(connection.status)}</div>`).join('') : '<div class="empty"><strong>لم تربط رقمًا</strong>اختر الربط الرسمي أو التجريبي.</div>'}</div></section>
      </div>`;
    pageContent.querySelector('[data-action="go-connections"]')?.addEventListener('click', () => navigate('connections'));
    pageContent.querySelector('[data-action="go-inbox"]')?.addEventListener('click', () => navigate('inbox'));
  },

  async connections() {
    const connections = await api('/api/connections');
    pageContent.innerHTML = `${pageHead('ربط واتساب', 'اختر الربط الرسمي للأعمال المهمة أو التجريبي للاختبار.', '<button class="btn btn-primary" id="addOfficial">إضافة ربط رسمي</button>')}
      <div class="connection-grid">
        <article class="card connection-card recommended"><span class="badge success">رسمي</span><h2>WhatsApp Cloud API</h2><p class="muted">ربط معتمد وأكثر استقرارًا. جميع رسوم Meta تكون على حساب العميل.</p><ul class="check-list"><li>Webhooks وتحديثات التسليم</li><li>قوالب رسائل معتمدة</li><li>مناسب للمتاجر والشركات</li></ul><button class="btn btn-primary" id="officialCardButton">إعداد الربط الرسمي</button></article>
        <article class="card connection-card"><span class="badge warning">تجريبي غير رسمي</span><h2>WhatsApp Web</h2><p class="muted">يستخدم Baileys اختياريًا، وقد ينقطع أو يتقيد الرقم.</p><ul class="check-list"><li>مسح QR أو Pairing Code</li><li>لا حملات جماعية</li><li>يحتاج خدمة Gateway دائمة</li></ul><button class="btn btn-secondary" id="unofficialCardButton">قراءة التحذير والربط</button></article>
      </div>
      <section class="panel"><div class="panel-head"><strong>الأرقام المرتبطة</strong><span class="small muted">${connections.length} اتصال</span></div><div class="list" id="connectionsList">${connections.length ? connections.map(connectionRow).join('') : '<div class="empty"><strong>لا يوجد اتصال حتى الآن</strong>أضف اتصالًا من الخيارات أعلاه.</div>'}</div></section>`;
    document.getElementById('addOfficial').onclick = openOfficialConnectionModal;
    document.getElementById('officialCardButton').onclick = openOfficialConnectionModal;
    document.getElementById('unofficialCardButton').onclick = openUnofficialConnectionModal;
    pageContent.querySelectorAll('[data-connection-test]').forEach((button) => button.addEventListener('click', async () => {
      button.disabled = true;
      try { const result = await api(`/api/connections/${button.dataset.connectionTest}/test`, { method: 'POST', body: '{}' }); toast(result.ok ? 'تم اختبار الاتصال بنجاح' : result.message); await views.connections(); }
      catch (error) { toast(error.message, 'error'); }
      finally { button.disabled = false; }
    }));
    pageContent.querySelectorAll('[data-connection-disconnect]').forEach((button) => button.addEventListener('click', async () => {
      if (!confirm('هل تريد فصل هذا الاتصال؟')) return;
      await api(`/api/connections/${button.dataset.connectionDisconnect}/disconnect`, { method: 'POST', body: '{}' });
      toast('تم فصل الاتصال'); await views.connections();
    }));
    pageContent.querySelectorAll('[data-connection-start]').forEach((button) => button.addEventListener('click', () => startUnofficialConnection(button.dataset.connectionStart)));
  },

  async inbox() {
    state.conversations = await api('/api/conversations');
    pageContent.innerHTML = `${pageHead('صندوق المحادثات', 'إدارة رسائل العملاء والتحويل بين الموظف والمساعد.')}
      <div class="inbox" id="inboxRoot">
        <aside class="inbox-list"><div class="inbox-search"><input id="conversationSearch" placeholder="ابحث بالاسم أو الرقم"></div><div id="conversationList">${renderConversationList(state.conversations)}</div></aside>
        <section class="chat" id="chatPanel"><div class="empty"><strong>اختر محادثة</strong>اضغط على أي محادثة لعرض الرسائل.</div></section>
        <aside class="contact-side" id="contactPanel"><div class="empty"><strong>بيانات العميل</strong>تظهر بعد اختيار المحادثة.</div></aside>
      </div>`;
    bindConversationList();
    document.getElementById('conversationSearch').addEventListener('input', (event) => {
      const query = event.target.value.toLowerCase();
      const filtered = state.conversations.filter((item) => `${item.contact_name || ''} ${item.phone || ''} ${item.last_text || ''}`.toLowerCase().includes(query));
      document.getElementById('conversationList').innerHTML = renderConversationList(filtered);
      bindConversationList();
    });
  },

  async assistant() {
    const settings = await api('/api/ai-settings');
    pageContent.innerHTML = `${pageHead('الموظف الذكي', 'اختر مزودك الخاص واضبط أسلوب المساعد وحدود عمله.')}
      <div class="grid-2">
        <section class="panel"><div class="panel-head"><strong>إعدادات المساعد</strong>${settings.enabled ? '<span class="badge success">مفعل</span>' : '<span class="badge">متوقف</span>'}</div><div class="panel-body"><form id="aiSettingsForm">
          <div class="form-group"><label>اسم المساعد</label><input name="assistantName" value="${escapeHtml(settings.assistant_name || 'مساعد المتجر')}"></div>
          <div class="grid-2"><div class="form-group"><label>المزود</label><select name="provider" id="aiProvider">${providerOptions(settings.provider)}</select></div><div class="form-group"><label>النموذج</label><input name="model" value="${escapeHtml(settings.model || '')}" placeholder="اسم النموذج"></div></div>
          <div class="form-group"><label>Base URL</label><input name="baseUrl" value="${escapeHtml(settings.base_url || '')}" placeholder="اختياري حسب المزود"></div>
          <div class="form-group"><label>API Key ${settings.hasApiKey ? `<span class="small muted">(${escapeHtml(settings.apiKeyHint)})</span>` : ''}</label><input name="apiKey" type="password" placeholder="اتركه فارغًا للإبقاء على المفتاح المحفوظ"></div>
          <div class="grid-2"><div class="form-group"><label>نبرة الرد</label><input name="tone" value="${escapeHtml(settings.tone || 'ودود ومختصر')}"></div><div class="form-group"><label>حد الثقة</label><input name="confidenceThreshold" type="number" step="0.01" min="0" max="1" value="${Number(settings.confidence_threshold || .72)}"></div></div>
          <div class="form-group"><label>تعليمات إضافية</label><textarea name="systemInstructions">${escapeHtml(settings.system_instructions || '')}</textarea></div>
          <label class="checkbox-row"><input name="enabled" type="checkbox" ${settings.enabled ? 'checked' : ''}><span>تشغيل الرد الذكي تلقائيًا</span></label>
          <div style="display:flex;gap:8px"><button class="btn btn-primary" type="submit">حفظ الإعدادات</button><button class="btn btn-secondary" type="button" id="testAIButton">اختبار الاتصال</button></div>
        </form></div></section>
        <section class="panel"><div class="panel-head"><strong>اختبار المساعد</strong><span class="badge">لا يرسل إلى واتساب</span></div><div class="panel-body"><div class="form-group"><label>اكتب كأنك عميل</label><textarea id="previewText" placeholder="مثال: كم مدة التوصيل؟"></textarea></div><button class="btn btn-primary" id="previewButton">تجربة الرد</button><div id="previewResult" style="margin-top:18px"></div></div></section>
      </div>`;
    document.getElementById('aiSettingsForm').addEventListener('submit', saveAIForm);
    document.getElementById('testAIButton').onclick = testAIForm;
    document.getElementById('previewButton').onclick = previewAssistant;
  },

  async knowledge() {
    const entries = await api('/api/knowledge');
    pageContent.innerHTML = `${pageHead('قاعدة المعرفة', 'المعلومات التي يستخدمها المساعد للرد دون اختلاق.', '<button class="btn btn-primary" id="addKnowledge">إضافة معلومة</button>')}
      <section class="panel"><div class="panel-head"><strong>المصادر</strong><span class="small muted">${entries.length} مصدر</span></div><div class="list">${entries.length ? entries.map((entry) => `<div class="list-row"><div><strong>${escapeHtml(entry.title)}</strong><div class="small muted">${escapeHtml(entry.question || entry.source_type)} — ${escapeHtml(entry.answer).slice(0, 90)}${entry.answer.length > 90 ? '…' : ''}</div></div><div style="display:flex;gap:7px;align-items:center"><span class="badge success">جاهز</span><button class="btn btn-ghost btn-sm text-danger" data-delete-knowledge="${entry.id}">حذف</button></div></div>`).join('') : '<div class="empty"><strong>قاعدة المعرفة فارغة</strong>أضف الأسئلة المتكررة والسياسات قبل تشغيل المساعد.</div>'}</div></section>`;
    document.getElementById('addKnowledge').onclick = openKnowledgeModal;
    pageContent.querySelectorAll('[data-delete-knowledge]').forEach((button) => button.addEventListener('click', async () => {
      if (!confirm('حذف هذه المعلومة؟')) return;
      await api(`/api/knowledge/${button.dataset.deleteKnowledge}`, { method: 'DELETE' }); toast('تم حذف المعلومة'); await views.knowledge();
    }));
  },

  async products() {
    const products = await api('/api/products');
    pageContent.innerHTML = `${pageHead('المنتجات', 'منتجات المتجر التي يمكن للمساعد البحث فيها.', '<button class="btn btn-primary" id="addProduct">إضافة منتج</button>')}
      <section class="panel"><div class="list">${products.length ? products.map((product) => `<div class="list-row"><div><strong>${escapeHtml(product.name)}</strong><div class="small muted">${escapeHtml(product.sku || 'بدون SKU')} · المخزون ${product.stock}</div></div><div><strong>${Number(product.sale_price ?? product.price).toLocaleString('ar-SA')} ر.س</strong><div>${product.active ? '<span class="badge success">نشط</span>' : '<span class="badge">متوقف</span>'}</div></div></div>`).join('') : '<div class="empty"><strong>لا توجد منتجات</strong>أضف منتجاتك يدويًا، ثم يمكن ربط سلة لاحقًا.</div>'}</div></section>`;
    document.getElementById('addProduct').onclick = openProductModal;
  },

  async orders() {
    const orders = await api('/api/orders');
    pageContent.innerHTML = `${pageHead('الطلبات', 'عرض حالات الطلبات المرتبطة بالعملاء.')}
      <section class="panel"><div class="list">${orders.length ? orders.map((order) => `<div class="list-row"><div><strong>طلب #${escapeHtml(order.order_number)}</strong><div class="small muted">${escapeHtml(order.customer_name || order.customer_phone || 'عميل غير مرتبط')} · ${formatDate(order.created_at)}</div></div><div><strong>${Number(order.total).toLocaleString('ar-SA')} ر.س</strong><div><span class="badge">${escapeHtml(order.status)}</span></div></div></div>`).join('') : '<div class="empty"><strong>لا توجد طلبات</strong>ستظهر الطلبات بعد إضافتها أو ربط منصة المتجر.</div>'}</div></section>`;
  },

  async team() {
    const members = await api('/api/team');
    pageContent.innerHTML = `${pageHead('فريق العمل', 'أضف موظفين وحدد الصلاحيات المناسبة.', '<button class="btn btn-primary" id="inviteMember">دعوة عضو</button>')}
      <section class="panel"><div class="list">${members.map((member) => `<div class="list-row"><div style="display:flex;align-items:center;gap:11px"><div class="avatar">${escapeHtml(member.name).charAt(0)}</div><div><strong>${escapeHtml(member.name)}</strong><div class="small muted">${escapeHtml(member.email)}</div></div></div><div><span class="badge success">${roleLabel(member.role)}</span></div></div>`).join('')}</div></section>`;
    document.getElementById('inviteMember').onclick = openInviteModal;
  },

  async reports() {
    const report = await api('/api/reports');
    pageContent.innerHTML = `${pageHead('التقارير', 'أداء المحادثات والاتصالات خلال آخر 30 يومًا.')}
      <div class="stats"><div class="stat"><div class="stat-number">${report.summary.conversations}</div><div class="stat-label">إجمالي المحادثات</div></div><div class="stat"><div class="stat-number">${report.summary.aiReplies}</div><div class="stat-label">ردود الذكاء الاصطناعي</div></div><div class="stat"><div class="stat-number">${report.summary.humanReplies}</div><div class="stat-label">ردود الموظفين</div></div><div class="stat"><div class="stat-number">${report.summary.knowledgeEntries}</div><div class="stat-label">مصادر المعرفة</div></div></div>
      <div class="grid-2"><section class="panel"><div class="panel-head"><strong>الرسائل اليومية</strong></div><div class="panel-body">${report.daily.length ? `<table class="compare"><thead><tr><th>اليوم</th><th>واردة</th><th>صادرة</th></tr></thead><tbody>${report.daily.map((day) => `<tr><td>${escapeHtml(day.day)}</td><td>${day.inbound}</td><td>${day.outbound}</td></tr>`).join('')}</tbody></table>` : '<div class="empty"><strong>لا توجد بيانات كافية</strong>ستظهر بعد استقبال الرسائل.</div>'}</div></section><section class="panel"><div class="panel-head"><strong>صحة الاتصالات</strong></div><div class="list">${report.connectionHealth.length ? report.connectionHealth.map((item) => `<div class="list-row"><span>${item.type === 'official' ? 'رسمي' : 'تجريبي'}</span><div>${statusBadge(item.status)} <span class="small muted">${item.count}</span></div></div>`).join('') : '<div class="empty">لا توجد اتصالات</div>'}</div></section></div>`;
  },

  async settings() {
    const organization = await api('/api/organization');
    pageContent.innerHTML = `${pageHead('إعدادات المنشأة', 'حدّث اسم النشاط والمنطقة الزمنية.')}
      <div class="grid-2"><section class="panel"><div class="panel-head"><strong>بيانات المنشأة</strong></div><div class="panel-body"><form id="organizationForm"><div class="form-group"><label>اسم المنشأة</label><input name="name" value="${escapeHtml(organization.name)}" required></div><div class="form-group"><label>النشاط</label><input name="activity" value="${escapeHtml(organization.activity)}"></div><div class="form-group"><label>المنطقة الزمنية</label><select name="timezone"><option value="Asia/Riyadh" ${organization.timezone === 'Asia/Riyadh' ? 'selected' : ''}>السعودية — الرياض</option><option value="Asia/Dubai" ${organization.timezone === 'Asia/Dubai' ? 'selected' : ''}>الإمارات — دبي</option><option value="UTC" ${organization.timezone === 'UTC' ? 'selected' : ''}>UTC</option></select></div><button class="btn btn-primary" type="submit">حفظ</button></form></div></section><section class="panel"><div class="panel-head"><strong>الأمان والخصوصية</strong></div><div class="panel-body"><p class="muted">مفاتيح واتساب والذكاء الاصطناعي مشفرة ولا تظهر كاملة بعد الحفظ.</p><div class="notice">لا تشارك مفتاح التشفير الرئيسي. فقدانه يعني تعذر قراءة بيانات الاعتماد المحفوظة.</div></div></section></div>`;
    document.getElementById('organizationForm').addEventListener('submit', async (event) => {
      event.preventDefault(); const payload = Object.fromEntries(new FormData(event.currentTarget).entries());
      const updated = await api('/api/organization', { method: 'PATCH', body: JSON.stringify(payload) });
      state.context.organization.name = updated.name; document.getElementById('organizationName').textContent = updated.name; toast('تم حفظ الإعدادات');
    });
  }
};

function connectionRow(connection) {
  const primaryAction = connection.type === 'unofficial'
    ? `<button class="btn btn-secondary btn-sm" data-connection-start="${connection.id}">ربط الجهاز</button>`
    : `<button class="btn btn-secondary btn-sm" data-connection-test="${connection.id}">اختبار</button>`;
  return `<div class="list-row"><div><div style="display:flex;align-items:center;gap:8px"><strong>${escapeHtml(connection.name)}</strong>${connection.type === 'official' ? '<span class="badge success">رسمي</span>' : '<span class="badge warning">تجريبي غير معتمد</span>'}</div><div class="small muted">${escapeHtml(connection.phone_number || connection.phone_number_id || 'لم يحدد الرقم')} · ${formatDate(connection.updated_at)}</div>${connection.last_error ? `<div class="small text-danger">${escapeHtml(connection.last_error)}</div>` : ''}</div><div style="display:flex;gap:7px;align-items:center;flex-wrap:wrap">${statusBadge(connection.status)}${primaryAction}<button class="btn btn-ghost btn-sm" data-connection-disconnect="${connection.id}">فصل</button></div></div>`;
}

function providerOptions(selected) {
  return [['rules','ردود جاهزة فقط'],['ollama','Ollama محلي'],['openai_compatible','OpenAI-compatible'],['anthropic','Anthropic'],['gemini','Google Gemini']].map(([value,label]) => `<option value="${value}" ${selected === value ? 'selected' : ''}>${label}</option>`).join('');
}
function roleLabel(role) { return ({ owner:'مالك', admin:'مدير', supervisor:'مشرف', agent:'موظف', viewer:'مشاهد' })[role] || role; }

function openOfficialConnectionModal() {
  openModal({ title: 'إضافة ربط رسمي', body: `<div class="notice" style="margin-bottom:16px">قد تطبق Meta رسومًا حسب سياساتها. الرسوم مرتبطة بحساب نشاطك وليست مشمولة في المنصة.</div><form id="officialConnectionForm"><div class="grid-2"><div class="form-group"><label>اسم الاتصال</label><input name="name" value="واتساب الرسمي"></div><div class="form-group"><label>رقم الهاتف</label><input name="phoneNumber" placeholder="9665xxxxxxxx"></div></div><div class="grid-2"><div class="form-group"><label>Phone Number ID</label><input name="phoneNumberId" required></div><div class="form-group"><label>WABA ID</label><input name="wabaId"></div></div><div class="form-group"><label>Graph API Version</label><input name="apiVersion" placeholder="أدخله حسب وثائق Meta الحالية" required></div><div class="form-group"><label>Access Token</label><input name="accessToken" type="password" required></div><div class="grid-2"><div class="form-group"><label>App Secret</label><input name="appSecret" type="password" required></div><div class="form-group"><label>Verify Token</label><input name="verifyToken" type="password" required></div></div><button class="btn btn-primary" type="submit">حفظ الاتصال</button></form>` });
  document.getElementById('officialConnectionForm').addEventListener('submit', async (event) => {
    event.preventDefault(); const button = event.currentTarget.querySelector('button'); button.disabled = true;
    try { await api('/api/connections/official', { method:'POST', body:JSON.stringify(Object.fromEntries(new FormData(event.currentTarget).entries())) }); closeModal(); toast('تم حفظ الربط الرسمي'); await views.connections(); }
    catch (error) { toast(error.message, 'error'); }
    finally { button.disabled = false; }
  });
}

function openUnofficialConnectionModal() {
  openModal({ title: 'تنبيه مهم قبل الربط التجريبي', body: `<div class="notice"><strong>هذا الربط غير رسمي وغير معتمد من Meta.</strong><br>قد يتوقف الاتصال أو يتم تسجيل خروج الرقم أو يتعرض الحساب للتقييد أو الإيقاف. لا نضمن استمرارية الخدمة أو سلامة الرقم. ننصح باستخدام الربط الرسمي للأنشطة التجارية المهمة.<br><br>يحظر استخدامه لإرسال الرسائل العشوائية أو الحملات الجماعية أو التواصل مع أشخاص لم يوافقوا على استقبال الرسائل.</div><form id="unofficialConnectionForm" style="margin-top:16px"><div class="grid-2"><div class="form-group"><label>اسم الاتصال</label><input name="name" value="ربط تجريبي"></div><div class="form-group"><label>رقم الهاتف</label><input name="phoneNumber" placeholder="9665xxxxxxxx"></div></div><label class="checkbox-row"><input type="checkbox" name="acceptedRisk"><span>قرأت وفهمت أن الربط غير رسمي وتجريبي.</span></label><label class="checkbox-row"><input type="checkbox" name="acceptedAcceptableUse"><span>أوافق على عدم استخدامه للرسائل المزعجة أو الحملات غير المصرح بها.</span></label><button class="btn btn-primary" type="submit" id="acceptUnofficial">أوافق وأنشئ الاتصال</button></form>` });
  const form = document.getElementById('unofficialConnectionForm');
  form.addEventListener('submit', async (event) => {
    event.preventDefault(); const data = new FormData(form);
    if (!data.get('acceptedRisk') || !data.get('acceptedAcceptableUse')) return toast('يجب الموافقة على التحذيرين', 'error');
    const payload = { name:data.get('name'), phoneNumber:data.get('phoneNumber'), acceptedRisk:true, acceptedAcceptableUse:true };
    try { await api('/api/connections/unofficial', { method:'POST', body:JSON.stringify(payload) }); closeModal(); toast('تم إنشاء الاتصال التجريبي. شغّل Gateway لإظهار QR.'); await views.connections(); }
    catch (error) { toast(error.message, 'error'); }
  });
}

async function startUnofficialConnection(connectionId) {
  openModal({ title:'ربط الجهاز التجريبي', body:`<div class="notice">هذا الربط غير رسمي. افتح واتساب في الجوال ← الإعدادات ← الأجهزة المرتبطة، ثم استخدم رمز الاقتران عندما يظهر.</div><div id="gatewayStatus" class="empty"><strong>جارٍ تشغيل Gateway...</strong>قد يستغرق عدة ثوانٍ.</div>` });
  try {
    const started = await api(`/api/connections/${connectionId}/start`, { method:'POST', body:'{}' });
    renderGatewayStatus(started);
    const timer = setInterval(async () => {
      if (!document.getElementById('gatewayStatus')) return clearInterval(timer);
      try {
        const status = await api(`/api/connections/${connectionId}/status`);
        renderGatewayStatus(status);
        if (status.status === 'connected') { clearInterval(timer); toast('تم ربط الجهاز بنجاح'); setTimeout(() => { closeModal(); views.connections(); }, 1200); }
      } catch (error) { renderGatewayStatus({ status:'error', error:error.message }); }
    }, 2500);
  } catch (error) {
    renderGatewayStatus({ status:'setup_required', error:error.message });
  }
}
function renderGatewayStatus(data) {
  const box = document.getElementById('gatewayStatus'); if (!box) return;
  if (data.pairingCode) {
    box.innerHTML = `<span class="badge warning">رمز اقتران</span><div style="font-size:2.2rem;font-weight:900;letter-spacing:.18em;margin:16px 0;direction:ltr">${escapeHtml(data.pairingCode)}</div><p class="muted">أدخل الرمز في واتساب ضمن ربط جهاز برقم الهاتف.</p>`;
  } else if (data.qr) {
    box.innerHTML = `<strong>تم إنشاء QR داخل Gateway</strong><p class="muted">نسخة MVP تعرض رمز الاقتران تلقائيًا عند تسجيل رقم الهاتف. أعد إنشاء الاتصال مع الرقم للحصول على Pairing Code.</p>`;
  } else {
    box.innerHTML = `<strong>${escapeHtml(data.status || 'جاري الاتصال')}</strong><p class="${data.error ? 'text-danger' : 'muted'}">${escapeHtml(data.error || 'بانتظار Gateway...')}</p>`;
  }
}

function renderConversationList(items) {
  if (!items.length) return '<div class="empty"><strong>لا توجد محادثات</strong>عند وصول أول رسالة ستظهر هنا.</div>';
  return items.map((item) => `<article class="conv-item ${state.activeConversationId === item.id ? 'active' : ''}" data-conversation-id="${item.id}"><div class="conv-top"><span class="conv-name">${escapeHtml(item.contact_name || item.phone)}</span><span class="small muted">${item.unread_count ? `<span class="badge success">${item.unread_count}</span>` : ''}</span></div><div class="conv-preview">${escapeHtml(item.last_text || 'لا توجد رسالة')}</div><div class="small muted">${item.connection_type === 'official' ? 'رسمي' : item.connection_type === 'unofficial' ? 'تجريبي' : 'محلي'} · ${formatDate(item.last_message_at)}</div></article>`).join('');
}
function bindConversationList() { document.querySelectorAll('[data-conversation-id]').forEach((item) => item.addEventListener('click', () => openConversation(item.dataset.conversationId))); }

async function openConversation(id) {
  state.activeConversationId = id;
  document.querySelectorAll('.conv-item').forEach((item) => item.classList.toggle('active', item.dataset.conversationId === id));
  const data = await api(`/api/conversations/${id}/messages`);
  const chatPanel = document.getElementById('chatPanel');
  chatPanel.innerHTML = `<header class="chat-head"><div><button class="btn btn-ghost btn-sm" id="mobileBack">←</button><strong>${escapeHtml(data.contact_name || data.phone)}</strong><div class="small muted">${escapeHtml(data.phone)} · ${data.connection_type === 'official' ? 'ربط رسمي' : data.connection_type === 'unofficial' ? 'ربط تجريبي' : 'بدون ربط'}</div></div><div style="display:flex;gap:7px"><select id="controlMode" style="width:auto"><option value="ai_active" ${data.control_mode === 'ai_active' ? 'selected':''}>المساعد يعمل</option><option value="human_active" ${data.control_mode === 'human_active' ? 'selected':''}>موظف بشري</option><option value="paused" ${data.control_mode === 'paused' ? 'selected':''}>متوقف</option></select><button class="btn btn-secondary btn-sm" id="closeConversation">إغلاق</button></div></header><div class="chat-messages" id="chatMessages">${data.messages.length ? data.messages.map(messageBubble).join('') : '<div class="empty">لا توجد رسائل</div>'}</div><form class="composer" id="messageComposer"><input name="text" autocomplete="off" placeholder="اكتب ردك..."><button class="btn btn-primary">إرسال</button></form>`;
  document.getElementById('contactPanel').innerHTML = `<div class="avatar" style="width:58px;height:58px;font-size:1.4rem">${escapeHtml(data.contact_name || data.phone).charAt(0)}</div><h3>${escapeHtml(data.contact_name || 'عميل')}</h3><p class="muted">${escapeHtml(data.phone)}</p><hr style="border:0;border-top:1px solid var(--line)"><p><strong>حالة المحادثة</strong><br>${statusBadge(data.status)}</p><p><strong>وضع التحكم</strong><br>${data.control_mode === 'ai_active' ? 'المساعد الذكي' : data.control_mode === 'human_active' ? 'موظف بشري' : 'متوقف'}</p><div class="notice small">بمجرد إرسال الموظف ردًا يتحول التحكم تلقائيًا إلى الوضع البشري.</div>`;
  document.getElementById('inboxRoot').classList.add('chat-open');
  document.getElementById('mobileBack').onclick = () => document.getElementById('inboxRoot').classList.remove('chat-open');
  document.getElementById('controlMode').onchange = async (event) => { await api(`/api/conversations/${id}`, { method:'PATCH', body:JSON.stringify({ controlMode:event.target.value }) }); toast('تم تغيير وضع التحكم'); };
  document.getElementById('closeConversation').onclick = async () => { await api(`/api/conversations/${id}`, { method:'PATCH', body:JSON.stringify({ status:'closed', controlMode:'paused' }) }); toast('تم إغلاق المحادثة'); await openConversation(id); };
  document.getElementById('messageComposer').addEventListener('submit', async (event) => {
    event.preventDefault(); const input = event.currentTarget.elements.text; const text = input.value.trim(); if (!text) return;
    const button = event.currentTarget.querySelector('button'); button.disabled = true;
    try { const message = await api(`/api/conversations/${id}/messages`, { method:'POST', body:JSON.stringify({ text }) }); input.value = ''; document.getElementById('chatMessages').insertAdjacentHTML('beforeend', messageBubble({ direction:'outbound', text:message.text, status:message.status, sender_type:'agent', created_at:message.created_at })); document.getElementById('chatMessages').scrollTop = document.getElementById('chatMessages').scrollHeight; if (message.providerError) toast(message.providerError, 'error'); }
    catch (error) { toast(error.message, 'error'); }
    finally { button.disabled = false; input.focus(); }
  });
  const messagesBox = document.getElementById('chatMessages'); messagesBox.scrollTop = messagesBox.scrollHeight;
}
function messageBubble(message) { return `<div class="message ${message.direction === 'outbound' ? 'outbound' : ''}"><div>${escapeHtml(message.text || `[${message.type || 'رسالة'}]`)}</div><div class="message-meta"><span>${message.sender_type === 'ai' ? 'الذكاء الاصطناعي' : message.sender_type === 'agent' ? 'الموظف' : 'العميل'}</span><span>${formatDate(message.created_at)}</span><span>${message.direction === 'outbound' ? escapeHtml(message.status || '') : ''}</span></div></div>`; }

async function saveAIForm(event) {
  event.preventDefault(); const form = event.currentTarget; const raw = Object.fromEntries(new FormData(form).entries());
  const payload = { ...raw, enabled: form.elements.enabled.checked, confidenceThreshold:Number(raw.confidenceThreshold || .72) };
  try { await api('/api/ai-settings', { method:'PUT', body:JSON.stringify(payload) }); toast('تم حفظ إعدادات المساعد'); await views.assistant(); }
  catch (error) { toast(error.message, 'error'); }
}
async function testAIForm() {
  const form = document.getElementById('aiSettingsForm'); const raw = Object.fromEntries(new FormData(form).entries());
  try { const result = await api('/api/ai-settings/test', { method:'POST', body:JSON.stringify(raw) }); toast(result.message || `نجح الاتصال${result.modelCount != null ? ` — ${result.modelCount} نموذج` : ''}`); }
  catch (error) { toast(error.message, 'error'); }
}
async function previewAssistant() {
  const text = document.getElementById('previewText').value.trim(); if (!text) return toast('اكتب رسالة للاختبار', 'error');
  const resultBox = document.getElementById('previewResult'); resultBox.innerHTML = '<div class="skeleton" style="height:130px"></div>';
  try { const result = await api('/api/assistant/preview', { method:'POST', body:JSON.stringify({ text }) }); resultBox.innerHTML = `<div class="card"><span class="badge ${result.needsHuman ? 'warning' : 'success'}">${result.needsHuman ? 'تحويل لموظف' : 'رد تلقائي'}</span><p><strong>${escapeHtml(result.replyText)}</strong></p><div class="small muted">النية: ${escapeHtml(result.intent)} · الثقة: ${Math.round(result.confidence * 100)}% · المصادر: ${(result.sources || []).map((source) => escapeHtml(source.title)).join('، ') || 'لا يوجد'}</div>${result.humanReason ? `<div class="notice small" style="margin-top:10px">${escapeHtml(result.humanReason)}</div>` : ''}</div>`; }
  catch (error) { resultBox.innerHTML = `<div class="form-error">${escapeHtml(error.message)}</div>`; }
}

function openKnowledgeModal() {
  openModal({ title:'إضافة معلومة', body:`<form id="knowledgeForm"><div class="form-group"><label>العنوان</label><input name="title" required placeholder="سياسة الشحن"></div><div class="form-group"><label>السؤال المحتمل</label><input name="question" placeholder="كم مدة التوصيل؟"></div><div class="form-group"><label>الإجابة المعتمدة</label><textarea name="answer" required></textarea></div><div class="form-group"><label>النوع</label><select name="sourceType"><option value="qa">سؤال وجواب</option><option value="policy">سياسة</option><option value="text">معلومة عامة</option><option value="product">منتج</option></select></div><button class="btn btn-primary">حفظ</button></form>` });
  document.getElementById('knowledgeForm').addEventListener('submit', async (event) => { event.preventDefault(); try { await api('/api/knowledge', { method:'POST', body:JSON.stringify(Object.fromEntries(new FormData(event.currentTarget).entries())) }); closeModal(); toast('تمت إضافة المعلومة'); await views.knowledge(); } catch (error) { toast(error.message,'error'); } });
}
function openProductModal() {
  openModal({ title:'إضافة منتج', body:`<form id="productForm"><div class="form-group"><label>اسم المنتج</label><input name="name" required></div><div class="grid-2"><div class="form-group"><label>SKU</label><input name="sku"></div><div class="form-group"><label>المخزون</label><input name="stock" type="number" value="0"></div></div><div class="grid-2"><div class="form-group"><label>السعر</label><input name="price" type="number" step="0.01" value="0"></div><div class="form-group"><label>سعر التخفيض</label><input name="salePrice" type="number" step="0.01"></div></div><div class="form-group"><label>الوصف</label><textarea name="description"></textarea></div><div class="form-group"><label>رابط المنتج</label><input name="productUrl" type="url"></div><button class="btn btn-primary">حفظ المنتج</button></form>` });
  document.getElementById('productForm').addEventListener('submit', async (event) => { event.preventDefault(); try { await api('/api/products', { method:'POST', body:JSON.stringify(Object.fromEntries(new FormData(event.currentTarget).entries())) }); closeModal(); toast('تمت إضافة المنتج'); await views.products(); } catch (error) { toast(error.message,'error'); } });
}
function openInviteModal() {
  openModal({ title:'دعوة عضو للفريق', body:`<form id="inviteForm"><div class="form-group"><label>البريد الإلكتروني</label><input name="email" type="email" required></div><div class="form-group"><label>الدور</label><select name="role"><option value="agent">موظف</option><option value="supervisor">مشرف</option><option value="admin">مدير</option><option value="viewer">مشاهد</option></select></div><button class="btn btn-primary">إنشاء الدعوة</button></form>` });
  document.getElementById('inviteForm').addEventListener('submit', async (event) => { event.preventDefault(); try { const result = await api('/api/team/invites', { method:'POST', body:JSON.stringify(Object.fromEntries(new FormData(event.currentTarget).entries())) }); closeModal(); toast(`تم إنشاء الدعوة. رمز التطوير: ${result.inviteTokenForDevelopment}`); } catch (error) { toast(error.message,'error'); } });
}

async function initialize() {
  try {
    state.context = await api('/api/me');
    document.getElementById('userName').textContent = state.context.user.name;
    document.getElementById('userRole').textContent = roleLabel(state.context.role);
    document.getElementById('userAvatar').textContent = state.context.user.name.charAt(0);
    document.getElementById('organizationName').textContent = state.context.organization.name;
    document.querySelectorAll('[data-view]').forEach((button) => button.addEventListener('click', () => navigate(button.dataset.view)));
    document.querySelectorAll('[data-view-direct]').forEach((button) => button.addEventListener('click', () => navigate(button.dataset.viewDirect)));
    document.getElementById('logoutButton').onclick = async () => { await api('/api/auth/logout', { method:'POST', body:'{}' }); window.location.href = '/login.html'; };
    document.getElementById('themeButton').onclick = () => { state.theme = state.theme === 'dark' ? 'light' : 'dark'; document.documentElement.dataset.theme = state.theme; localStorage.setItem('reddad-theme', state.theme); };
    await navigate('dashboard');
  } catch (error) {
    if (!window.location.pathname.includes('login')) window.location.href = '/login.html';
  }
}

initialize();
