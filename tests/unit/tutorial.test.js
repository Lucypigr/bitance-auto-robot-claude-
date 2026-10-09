import test from 'node:test';
import assert from 'node:assert/strict';
import { PAGES } from '../../public/js/ui/tutorial.js';
import { GLOSSARY } from '../../public/js/ui/glossary.js';

test('新手篇：每頁有標題與內容，名詞都存在於說明表', () => {
  assert.ok(PAGES.length >= 6);
  const ids = new Set();
  for (const p of PAGES) {
    assert.ok(p.id && p.title && p.html.length > 100, p.id);
    assert.ok(!ids.has(p.id)); ids.add(p.id);
    for (const m of p.html.matchAll(/data-term="([a-z_]+)"/g)) assert.ok(GLOSSARY[m[1]], `${p.id}: ${m[1]}`);
  }
});

test('新手篇：涵蓋必要主題（樣本外、過度擬合、槓桿、買入持有）', () => {
  const all = PAGES.map((p) => p.html).join('');
  for (const w of ['樣本外', '過度擬合', '槓桿', '買入持有', '手續費', '一鍵示範']) assert.ok(all.includes(w), w);
});
