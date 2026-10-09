import test from 'node:test';
import assert from 'node:assert/strict';
import { foldRanges, runWalkForward } from '../../public/js/core/walkforward.js';
import { makeMarket } from '../helpers/market.js';
import { ANCHOR } from '../helpers/synth.js';

const COSTS = { fee: 0.0005, slippage: 0.0005, mmr: 0.005, posPct: 1, capital: 10000 };
const CFG = { tfs: ['1h', '4h'], budget: 30, minTrades: 3, folds: 4, ratio: 3 };

test('折的區間：訓練在前、測試緊接在後、測試期互不重疊且連續、訓練長度 = ratio × 測試長度', () => {
  const { ds } = makeMarket({ days: 300, windowDays: 240 });
  const fr = foldRanges(ds, 4, 3);
  assert.equal(fr.length, 4);
  const S = fr[0].test.to - fr[0].test.from;
  for (let i = 0; i < fr.length; i++) {
    assert.equal(fr[i].train.to, fr[i].test.from);
    assert.equal(fr[i].train.to - fr[i].train.from, 3 * S);
    if (i) { assert.equal(fr[i].test.from, fr[i - 1].test.to, '測試期連續'); assert.equal(fr[i].train.from, fr[i - 1].train.from + S, '每折往前移一個測試長度'); }
    assert.ok(fr[i].test.from >= fr[i].train.to);
  }
  assert.equal(fr[0].train.from, ds.windowStartIdx);
  assert.equal(fr[3].test.to, ds.n);
  assert.throws(() => foldRanges(ds, 4000, 3), /資料太短/);
});

test('走動式驗證：每折冠軍只由該折訓練期決定；串接後的淨值 = 各折報酬連乘', async () => {
  const { sig } = makeMarket({ days: 300, windowDays: 240, seed: 21 });
  const r = await runWalkForward(sig, CFG, COSTS);
  assert.equal(r.folds.length, 4);
  let prod = 1;
  for (const f of r.folds) prod *= 1 + f.testMetrics.netReturn;
  assert.ok(Math.abs(prod - 1 - r.summary.netReturn) < 1e-9);
  assert.ok(Math.abs(r.chain[r.chain.length - 1] - prod) < 1e-6, '串接曲線的終點 = 連乘');
  assert.equal(r.chain.length, r.range.to - r.range.from);
  assert.ok(Math.abs(r.summary.metrics.netReturn - r.summary.netReturn) < 1e-6);
  // 沒有冠軍的折 → 空手（淨值不變）
  for (const f of r.folds) if (!f.hasChampion) assert.equal(f.testMetrics.trades, 0);
  assert.ok(r.folds.some((f) => f.hasChampion), '應該至少有一折找到冠軍');
  for (const f of r.folds.filter((x) => x.hasChampion)) assert.ok(f.desc && f.strategy);
});

test('【防偷看】改變某折測試期之後的資料，之前各折的冠軍與測試成績完全不變', async () => {
  const A = makeMarket({ days: 300, windowDays: 240, seed: 31 });
  const fr = foldRanges(A.ds, 4, 3);
  const cutBar = fr[2].test.from; // 第 3 折的測試期起點
  const cut5 = Math.round((A.ds.t0 + cutBar * A.ds.baseMs - ANCHOR) / 300000);
  const B = makeMarket({
    days: 300, windowDays: 240, seed: 31,
    mutate: (p) => { for (let i = cut5; i < p.c.length; i++) { p.o[i] *= 0.6; p.h[i] *= 0.6; p.l[i] *= 0.6; p.c[i] *= 0.6; } },
  });
  const ra = await runWalkForward(A.sig, CFG, COSTS);
  const rb = await runWalkForward(B.sig, CFG, COSTS);
  for (let k = 0; k < 2; k++) {
    assert.equal(ra.folds[k].desc, rb.folds[k].desc, `第 ${k + 1} 折冠軍不應受未來資料影響`);
    assert.deepEqual(ra.folds[k].trainMetrics, rb.folds[k].trainMetrics);
    assert.deepEqual(ra.folds[k].testMetrics, rb.folds[k].testMetrics);
  }
  // 串接曲線在切點之前也相同
  const n = fr[2].test.from - fr[0].test.from;
  assert.deepEqual([...ra.chain.slice(0, n)], [...rb.chain.slice(0, n)]);
});

test('取消：cancelled() 為真時立刻停止', async () => {
  const { sig } = makeMarket({ days: 300, windowDays: 240 });
  let n = 0;
  const r = await runWalkForward(sig, CFG, COSTS, { cancelled: () => ++n > 20 });
  assert.equal(r.cancelled, true);
});
