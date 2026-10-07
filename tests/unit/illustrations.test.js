import test from 'node:test';
import assert from 'node:assert/strict';
import { illustration, illustrationHtml } from '../../public/js/ui/illustrations.js';
import { CONDITIONS } from '../../public/js/core/conditions.js';
import { GLOSSARY } from '../../public/js/ui/glossary.js';

test('每個條件（含 9 種 K 線型態）都有示意圖與圖說', () => {
  for (const id of Object.keys(CONDITIONS)) {
    const ill = illustration(id);
    assert.ok(ill, `${id} 缺少示意圖`);
    assert.ok(ill.cap.length > 8, `${id} 缺少圖說`);
    assert.match(ill.svg, /^<svg[\s\S]*<\/svg>$/);
    assert.ok(!/NaN|undefined|Infinity/.test(ill.svg), `${id} 的 SVG 含無效數值`);
    assert.equal((ill.svg.match(/<svg/g) || []).length, 1);
  }
});

test('指標名詞（RSI、MACD、KD…）說明也有圖；沒有圖的名詞（如勝率）不會壞掉', () => {
  for (const k of ['rsi', 'ema', 'macd', 'bollinger_upper', 'adx', 'atr', 'kd', 'supertrend', 'keltner', 'vwap', 'obv', 'cci', 'mfi', 'donchian', 'volume']) assert.ok(illustration(k), k);
  assert.equal(illustration('winrate'), null);
  assert.equal(illustrationHtml('winrate'), '');
  assert.match(illustrationHtml('pat_hammer'), /<figure class="pop-illus">[\s\S]*示意圖：/);
  assert.ok(Object.keys(GLOSSARY).length > 40);
});
