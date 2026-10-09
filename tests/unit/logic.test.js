import test from 'node:test';
import assert from 'node:assert/strict';
import { describeEntry, entryGroups, specKey, describeSpec } from '../../public/js/core/conditions.js';
import { unionSorted, intersectSorted } from '../../public/js/core/util.js';
import { makeMarket } from '../helpers/market.js';

const I = (a) => Int32Array.from(a);

test('unionSorted：聯集、去重、保持遞增', () => {
  assert.deepEqual([...unionSorted(I([1, 3, 5]), I([2, 3, 6]))], [1, 2, 3, 5, 6]);
  assert.deepEqual([...unionSorted(I([]), I([4]))], [4]);
  assert.deepEqual([...unionSorted(I([1, 2]), I([1, 2]))], [1, 2]);
});

test('條件分組：同群組 OR、不同群組 AND、未分組＝獨立（純 AND 與舊版相同）', () => {
  const a = { id: 'rsi_oversold', tf: '1h' }; const b = { id: 'bb_below_lower', tf: '1h' }; const c = { id: 'macd_golden', tf: '1h' };
  assert.equal(entryGroups([a, b, c]).length, 3);
  assert.equal(entryGroups([{ ...a, grp: 'A' }, { ...b, grp: 'A' }, c]).length, 2);
  assert.match(describeEntry([{ ...a, grp: 'A' }, { ...b, grp: 'A' }, c]), /^\(.*或.*\) 且 /);
  assert.match(describeEntry([a, b]), / 且 /);
  assert.match(describeSpec({ ...a, neg: true }), /^非（/);
  assert.notEqual(specKey({ ...a, neg: true }), specKey(a));
  assert.equal(specKey({ ...a, grp: 'A' }), specKey(a), '群組不影響條件本身的快取');
});

test('NOT：與原條件互補（兩者聯集＝所有有資料的 K 線，交集為空）', () => {
  const { sig, ds } = makeMarket({ days: 200, windowDays: 150 });
  const sp = { id: 'rsi_overbought', tf: '1h', params: { level: 60 } };
  for (let si = 0; si < ds.symbols.length; si++) {
    const S = ds.symbols[si];
    const pos = sig.atomIdx(si, sp);
    const neg = sig.atomIdx(si, { ...sp, neg: true });
    assert.equal(pos.length + neg.length, S.last - S.first + 1);
    assert.equal(intersectSorted(pos, neg).length, 0);
    assert.equal(unionSorted(pos, neg).length, S.last - S.first + 1);
  }
});

test('OR / AND / NOT 的訊號與手算結果一致', () => {
  const { sig, ds } = makeMarket({ days: 200, windowDays: 150, symbols: 2 });
  const A = { id: 'rsi_overbought', tf: '1h', params: { level: 60 } };
  const B = { id: 'bb_above_upper', tf: '1h' };
  const C = { id: 'macd_death', tf: '1h' };
  for (let si = 0; si < 2; si++) {
    const a = new Set(sig.atomIdx(si, A)); const b = new Set(sig.atomIdx(si, B)); const c = new Set(sig.atomIdx(si, C));
    // (A 或 B) 且 非 C
    const expr = [{ ...A, grp: 'g' }, { ...B, grp: 'g' }, { ...C, neg: true }];
    const got = new Set(sig.andIdx(si, expr));
    const S = ds.symbols[si];
    for (let i = S.first; i <= S.last; i++) assert.equal(got.has(i), (a.has(i) || b.has(i)) && !c.has(i), `bar ${i}`);
    // 純 AND（沒有群組）與舊行為相同
    const and = new Set(sig.andIdx(si, [A, B]));
    for (let i = S.first; i <= S.last; i++) assert.equal(and.has(i), a.has(i) && b.has(i));
    // 順序不影響結果與快取
    assert.deepEqual([...sig.andIdx(si, [{ ...C, neg: true }, { ...B, grp: 'g' }, { ...A, grp: 'g' }])], [...sig.andIdx(si, expr)]);
  }
});

test('OR／NOT 不會偷看未來：改變後段資料，前段訊號不變', async () => {
  const { ANCHOR } = await import('../helpers/synth.js');
  const A = makeMarket({ seed: 3, days: 200, windowDays: 150 });
  const cut5 = Math.round((A.ds.t0 + Math.floor(A.ds.n * 0.7) * A.ds.baseMs - ANCHOR) / 300000);
  const B = makeMarket({ seed: 3, days: 200, windowDays: 150, mutate: (p) => { for (let i = cut5; i < p.c.length; i++) { p.o[i] *= 1.3; p.h[i] *= 1.3; p.l[i] *= 1.3; p.c[i] *= 1.3; } } });
  const expr = [{ id: 'rsi_overbought', tf: '4h', params: { level: 60 }, grp: 'g' }, { id: 'macd_death', tf: '1h', grp: 'g' }, { id: 'bb_above_upper', tf: '1h', neg: true }];
  const lim = Math.floor(A.ds.n * 0.7) - 60;
  for (let si = 0; si < A.ds.symbols.length; si++) {
    const a = [...A.sig.andIdx(si, expr)].filter((i) => i < lim);
    const b = [...B.sig.andIdx(si, expr)].filter((i) => i < lim);
    assert.deepEqual(a, b);
  }
});
