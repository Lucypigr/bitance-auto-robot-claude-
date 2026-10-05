import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { GLOSSARY } from '../../public/js/ui/glossary.js';
import { CONDITIONS } from '../../public/js/core/conditions.js';

const root = path.resolve(import.meta.dirname, '../../public');
function files(dir, out = []) {
  for (const n of fs.readdirSync(dir)) {
    const p = path.join(dir, n);
    if (fs.statSync(p).isDirectory()) { if (n !== 'vendor') files(p, out); } else if (/\.(js|html)$/.test(n)) out.push(p);
  }
  return out;
}

test('每個名詞說明都有白話解釋與「常見誤解」', () => {
  for (const [k, g] of Object.entries(GLOSSARY)) {
    assert.ok(g.title && g.plain && g.caution, `${k} 缺欄位`);
    assert.ok(g.plain.length >= 12 && g.caution.length >= 8, `${k} 說明太短`);
  }
});

test('程式與頁面引用的名詞都存在於說明表', () => {
  const used = new Set();
  for (const f of files(root)) {
    const s = fs.readFileSync(f, 'utf8');
    for (const m of s.matchAll(/term\('([a-z_]+)'/g)) used.add(m[1]);
    for (const m of s.matchAll(/data-term="([a-z_]+)"/g)) used.add(m[1]);
    for (const m of s.matchAll(/term: '([a-z_]+)'/g)) used.add(m[1]);
  }
  for (const c of Object.values(CONDITIONS)) used.add(c.term);
  for (const k of used) assert.ok(GLOSSARY[k], `缺少名詞說明：${k}`);
  assert.ok(used.size > 40);
});

test('使用者指定的核心名詞與常見誤解提醒', () => {
  for (const k of ['rsi', 'rsi_overbought', 'rsi_oversold', 'pf', 'sharpe', 'drawdown', 'oos', 'leverage', 'funding', 'liquidation', 'backtest', 'winrate']) assert.ok(GLOSSARY[k], k);
  assert.match(GLOSSARY.rsi_overbought.caution, /不代表一定下跌/);
  assert.match(GLOSSARY.winrate.caution, /高勝率不代表/);
  assert.match(GLOSSARY.backtest.caution, /不代表未來績效/);
});
