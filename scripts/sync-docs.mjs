// 讓 docs/（GitHub Pages 發佈資料夾）與 public/（原始碼）保持完全一致。
//   node scripts/sync-docs.mjs          → 同步 public → docs
//   node scripts/sync-docs.mjs --check  → 只檢查，不一致就以非 0 結束
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(root, 'public');
const DST = path.join(root, 'docs');

function walk(dir, base = dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir).sort()) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, base, out);
    else out.push(path.relative(base, p));
  }
  return out;
}
const hash = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

export function diff() {
  const a = new Set(walk(SRC));
  const b = new Set(walk(DST));
  const problems = [];
  for (const f of a) {
    if (!b.has(f)) problems.push(`docs 缺少：${f}`);
    else if (hash(path.join(SRC, f)) !== hash(path.join(DST, f))) problems.push(`內容不同：${f}`);
  }
  for (const f of b) if (!a.has(f)) problems.push(`docs 多出（public 沒有）：${f}`);
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--check')) {
    const problems = diff();
    if (problems.length) {
      console.error('public/ 與 docs/ 不同步：\n' + problems.map((p) => '  - ' + p).join('\n') + '\n請執行：npm run sync');
      process.exit(1);
    }
    console.log('public/ 與 docs/ 完全一致 ✓');
  } else {
    fs.rmSync(DST, { recursive: true, force: true });
    for (const f of walk(SRC)) {
      fs.mkdirSync(path.dirname(path.join(DST, f)), { recursive: true });
      fs.copyFileSync(path.join(SRC, f), path.join(DST, f));
    }
    console.log(`已同步 ${walk(DST).length} 個檔案：public → docs`);
  }
}
