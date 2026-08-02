import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { normalizeMetaWebhook, verifyMetaSignature } from '../src/providers/whatsapp/official.mjs';

test('Meta webhook signature is verified', () => {
  const secret = 'app-secret';
  const body = Buffer.from('{"hello":"world"}');
  const signature = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
  assert.equal(verifyMetaSignature(body, signature, secret), true);
  assert.equal(verifyMetaSignature(body, 'sha256=bad', secret), false);
});

test('Meta payload normalizes messages and statuses', () => {
  const normalized = normalizeMetaWebhook({ entry: [{ changes: [{ value: {
    metadata: { phone_number_id: '123' },
    contacts: [{ wa_id: '9665', profile: { name: 'سارة' } }],
    messages: [{ id: 'm1', from: '9665', type: 'text', text: { body: 'مرحبا' }, timestamp: '1700000000' }],
    statuses: [{ id: 'm2', status: 'delivered', recipient_id: '9665', timestamp: '1700000001' }]
  } }] }] });
  assert.equal(normalized.phoneNumberId, '123');
  assert.equal(normalized.messages[0].text, 'مرحبا');
  assert.equal(normalized.messages[0].contactName, 'سارة');
  assert.equal(normalized.statuses[0].status, 'delivered');
});
