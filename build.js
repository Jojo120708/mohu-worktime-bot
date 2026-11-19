import fs from 'node:fs';
import path from 'node:path';

const out = 'dist';
fs.mkdirSync(out, { recursive: true });

const statics = ['index.html'];
let n = 0;
for (const f of statics) {
  if (!fs.existsSync(f)) { console.error('build: 缺少 ' + f); process.exit(1); }
  fs.copyFileSync(f, path.join(out, f));
  n++;
}
const bytes = fs.statSync(path.join(out, 'index.html')).size;
if (bytes < 100000) { console.error('build: index.html 体积异常 ' + bytes); process.exit(1); }
console.log('build ok: ' + n + ' file(s), index.html = ' + bytes + ' bytes -> ' + out);
