import test from 'node:test';
import assert from 'node:assert/strict';
import { alignToBase, applyWithin } from '../../public/js/core/conditions.js';
import { buildDataset, splitRanges } from '../../public/js/core/dataset.js';
import { SignalEngine, risingEdges } from '../../public/js/core/signals.js';
import { makePath5m, aggregate, FACTOR, ANCHOR } from '../helpers/synth.js';

const H = 3600000;

test('高週期訊號只有在該根 K 線「收盤後」才可見', () => {
  // 1h 基準，4h 訊號：第 0 根 4h(0~4h) 有訊號
  const tfT = Float64Array.from([0, 4 * H, 8 * H]);
  const sig = Uint8Array.from([1, 0, 1]);
  const out = alignToBase(tfT, 4 * H, sig, 0, H, 12);
  // base 第 3 根(3h~4h)收盤時 = 4h，此時第 0 根 4h K 線剛好收盤 → 可見
  assert.deepEqual([...out.slice(0, 4)], [0, 0, 0, 1]);
  assert.deepEqual([...out.slice(4, 8)], [1, 1, 1, 0], '4h 第 1 根(4h~8h)於 base 第 7 根收盤後才換成 0');
  assert.deepEqual([...out.slice(8, 12)], [0, 0, 0, 1], '第 2 根 4h 訊號要等到 12h 才可見');
});

test('相同週期對齊 = 原樣', () => {
  const t = Float64Array.from([0, H, 2 * H, 3 * H]);
  const sig = Uint8Array.from([0, 1, 0, 1]);
  assert.deepEqual([...alignToBase(t, H, sig, 0, H, 4)], [0, 1, 0, 1]);
});

test('15m 基準 + 1h 訊號：1h 收盤前的 15m K 線看不到該訊號', () => {
  const q = 15 * 60000;
  const tfT = Float64Array.from([0, H]);
  const sig = Uint8Array.from([1, 1]);
  const out = alignToBase(tfT, H, sig, 0, q, 8);
  assert.deepEqual([...out], [0, 0, 0, 1, 1, 1, 1, 1]);
});

test('within：只往回看，不往前看', () => {
  assert.deepEqual([...applyWithin(Uint8Array.from([0, 1, 0, 0, 0, 1]), 3)], [0, 1, 1, 1, 0, 1]);
});

test('rising edge：連續成立只取第一根', () => {
  assert.deepEqual([...risingEdges(Int32Array.from([1, 2, 3, 7, 8, 12]))], [1, 7, 12]);
});

// ---- 跨週期訊號整合測試：在完整資料上算出的訊號，不可受「之後」的資料影響 ----
function makeSymbol(symbol, seed, path, tfs, from, to) {
  const klines = {};
  for (const tf of tfs) klines[tf] = tf === '5m' ? aggregate(path, 1, from, to) : aggregate(path, FACTOR[tf], from, to);
  return { symbol, klines };
}

test('跨週期條件組合：改變未來資料不會改變過去的進場訊號', () => {
  const total = 288 * 40; // 40 天的 5m
  const pathA = makePath5m(5, total, 100, 0.003);
  // pathB 前面與 A 相同，只有最後 5 天不同
  const pathB = {};
  const cutBars = 288 * 35;
  const alt = makePath5m(99, total, 100, 0.003);
  for (const k of ['t', 'o', 'h', 'l', 'c', 'v']) {
    pathB[k] = Float64Array.from(pathA[k]);
    for (let i = cutBars; i < total; i++) pathB[k][i] = alt[k][i] * (k === 't' ? 1 : 1) + (k === 't' ? pathA.t[i] - alt.t[i] : 0);
  }
  // 讓價格連續：把 B 後段平移到 A 在 cutBars 的收盤價
  const shift = pathA.c[cutBars - 1] / alt.o[cutBars];
  for (const k of ['o', 'h', 'l', 'c']) for (let i = cutBars; i < total; i++) pathB[k][i] = alt[k][i] * shift;

  const specs = [
    { id: 'rsi_overbought', tf: '4h', params: { level: 60 } },
    { id: 'macd_death', tf: '1h', within: 1 },
    { id: 'pat_shooting_star', tf: '15m' },
  ];
  const tfs = ['15m', '1h', '4h'];
  const end = ANCHOR + total * 300000;
  const build = (path) => buildDataset({
    market: 'spot', baseTf: '15m', windowStart: ANCHOR + 288 * 300000 * 5, endTime: end,
    symbols: [makeSymbol('X', 1, path, tfs, 0, total)],
  });
  const sa = new SignalEngine(build(pathA));
  const sb = new SignalEngine(build(pathB));
  // 結果必須「在變動點之前」完全一致（訊號只能用到已收盤的資料）。
  const cutIdx = Math.floor((ANCHOR + cutBars * 300000 - sa.ds.t0) / sa.ds.baseMs) - 20; // 留一點緩衝給 4h 的對齊
  for (const sp of specs) {
    const a = [...sa.atomIdx(0, sp)].filter((i) => i < cutIdx);
    const b = [...sb.atomIdx(0, sp)].filter((i) => i < cutIdx);
    assert.deepEqual(a, b, `${sp.id}@${sp.tf} 的過去訊號被未來資料改變`);
  }
  const andA = [...sa.andIdx(0, specs.slice(0, 2))].filter((i) => i < cutIdx);
  const andB = [...sb.andIdx(0, specs.slice(0, 2))].filter((i) => i < cutIdx);
  assert.deepEqual(andA, andB);
});

test('資料集：補洞、暖機、切割 70/30', () => {
  const total = 288 * 10;
  const path = makePath5m(3, total);
  const klines = { '1h': aggregate(path, 12) };
  // 挖掉一些 1h K 線
  const keep = [];
  for (let i = 0; i < klines['1h'].t.length; i++) if (i < 50 || i > 55) keep.push(i);
  const pick = (a) => Float64Array.from(keep.map((i) => a[i]));
  const k = { t: pick(klines['1h'].t), o: pick(klines['1h'].o), h: pick(klines['1h'].h), l: pick(klines['1h'].l), c: pick(klines['1h'].c), v: pick(klines['1h'].v) };
  const ds = buildDataset({
    market: 'spot', baseTf: '1h', windowStart: ANCHOR + 24 * H, endTime: ANCHOR + 240 * H,
    symbols: [{ symbol: 'X', klines: { '1h': k } }], warmupBars: 0,
  });
  const S = ds.symbols[0];
  assert.equal(S.gaps, 6);
  assert.equal(S.v[50 - 24], 0); // 時間軸從第 24 根開始
  assert.equal(S.c[50 - 24], S.c[49 - 24]);
  const r = splitRanges(ds, 0.7);
  assert.equal(r.train.from, 0); // 無暖機時，時間軸從回測起點開始
  assert.equal(r.train.to, r.holdout.from);
  assert.equal(r.holdout.to, ds.n);
  const trainLen = r.train.to - r.train.from; const total2 = ds.n;
  assert.equal(trainLen, Math.floor(total2 * 0.7));
});
