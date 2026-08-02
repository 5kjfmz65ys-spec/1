import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const required = [
  'package.json', '.env.example', 'server.mjs', 'src/db.mjs', 'src/auth.mjs', 'src/crypto.mjs',
  'src/providers/whatsapp/official.mjs', 'src/providers/ai/index.mjs', 'public/index.html',
  'public/app.html', 'public/app.js', 'public/styles.css', 'gateway/server.mjs', 'README.md'
];
let failed = false;
for (const file of required) {
  if (!fs.existsSync(path.join(root, file))) {
    failed = true;
    console.error(`مفقود: ${file}`);
  }
}
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
for (const script of ['start', 'dev', 'seed', 'test', 'verify', 'gateway']) {
  if (!pkg.scripts?.[script]) { failed = true; console.error(`script مفقود: ${script}`); }
}
const files = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', 'data'].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full); else files.push(full);
  }
}
walk(root);
for (const file of files.filter((file) => /\.(mjs|js)$/.test(file))) {
  const content = fs.readFileSync(file, 'utf8');
  if (/\bTODO\b|\bFIXME\b/.test(content)) { failed = true; console.error(`علامة عمل غير مكتمل: ${path.relative(root, file)}`); }
}
if (failed) process.exit(1);
console.log(`فحص الهيكل ناجح — ${files.length} ملفًا`);
