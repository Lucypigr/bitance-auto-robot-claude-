import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { diff } from '../../scripts/sync-docs.mjs';

const root = path.resolve(import.meta.dirname, '../..');

test('public/ 與 docs/ 完全同步（修改後請執行 npm run sync）', () => {
  assert.deepEqual(diff(), []);
});

test('部署版使用相對路徑，可放在 GitHub Pages 子路徑', () => {
  const html = fs.readFileSync(path.join(root, 'docs/index.html'), 'utf8');
  assert.ok(!/(src|href)="\//.test(html), '不可使用以 / 開頭的絕對路徑');
  assert.ok(fs.existsSync(path.join(root, 'docs/.nojekyll')));
  assert.ok(fs.existsSync(path.join(root, 'docs/vendor/lightweight-charts.mjs')), '圖表函式庫必須隨附，不依賴外部 CDN');
  for (const f of ['js/ui/app.js', 'js/ui/charts.js']) {
    const s = fs.readFileSync(path.join(root, 'docs', f), 'utf8');
    assert.ok(!/https?:\/\/(cdn|unpkg)/.test(s));
  }
});
