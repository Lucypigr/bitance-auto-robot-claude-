import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '../../public/js');
function files(dir, out = []) {
  for (const n of fs.readdirSync(dir)) {
    const p = path.join(dir, n);
    if (fs.statSync(p).isDirectory()) files(p, out); else if (n.endsWith('.js')) out.push(p);
  }
  return out;
}

test('所有前端模組語法正確（含只在瀏覽器執行、單元測試不會載入的 app.js 等）', () => {
  for (const f of files(root)) {
    const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
    assert.equal(r.status, 0, `${path.relative(root, f)}\n${r.stderr}`);
  }
});
