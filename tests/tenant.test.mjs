import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reddad-test-'));
process.env.DATA_DIR = tempDir;
process.env.ENCRYPTION_KEY = 'b'.repeat(64);
process.env.NODE_ENV = 'test';

const { signup } = await import('../src/auth.mjs');
const { createKnowledge, listKnowledge } = await import('../src/services.mjs');
const { closeDatabase } = await import('../src/db.mjs');

test('organization data is isolated by server context', () => {
  const first = signup({ name: 'الأول', email: 'one@example.test', password: 'Password123!', organizationName: 'متجر الأول' });
  const second = signup({ name: 'الثاني', email: 'two@example.test', password: 'Password123!', organizationName: 'متجر الثاني' });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  const contextA = { user: { id: first.userId }, organization: { id: first.organizationId }, role: 'owner' };
  const contextB = { user: { id: second.userId }, organization: { id: second.organizationId }, role: 'owner' };
  createKnowledge(contextA, { title: 'معلومة خاصة', question: 'سؤال', answer: 'جواب المتجر الأول', sourceType: 'qa' });
  assert.equal(listKnowledge(contextA).length, 1);
  assert.equal(listKnowledge(contextB).length, 0);
});

test.after(() => {
  closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});
