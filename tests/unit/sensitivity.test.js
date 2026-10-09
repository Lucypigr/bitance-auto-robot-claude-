import test from 'node:test';
import assert from 'node:assert/strict';
import { runSensitivity, axisValues, summarize } from '../../public/js/core/sensitivity.js';
import { runStrategy } from '../../public/js/core/portfolio.js';
import { splitRanges } from '../../public/js/core/dataset.js';
import { makeMarket } from '../helpers/market.js';

const COSTS = { fee: 0.0005, slippage: 0.0005, mmr: 0.005, posPct: 1, capital: 10000 };

test('軸：以基準值為中心的倍數（0.5～2 倍），不含 0、已排序', () => {
  assert.deepEqual(axisValues(4), [2, 3, 4, 5, 6, 8]);
  assert.deepEqual(axisValues(0), []);
  assert.deepEqual(axisValues(1), [0.5, 0.75, 1, 1.25, 1.5, 2]);
});

test('敏感度格子：基準格與直接回測完全相同；樣本外用的是切割後的後段', () => {
  const { sig, ds } = makeMarket({ days: 240, windowDays: 200 });
  const r = splitRanges(ds);
  const st = { dir: 'short', entry: [{ id: 'rsi_overbought', tf: '1h', params: { level: 65 } }], exit: [], sl: 2, tp: 3, lev: 2, entryMode: 'edge' };
  const s = runSensitivity(sig, st, COSTS, r);
  assert.deepEqual(s.slAxis, [1, 1.5, 2, 2.5, 3, 4]);
  assert.deepEqual(s.tpAxis, [1.5, 2.25, 3, 3.75, 4.5, 6]);
  const bi = s.slAxis.indexOf(2); const bj = s.tpAxis.indexOf(3);
  const base = s.grid[bj][bi];
  const t = runStrategy(sig, st, COSTS, r.train).metrics;
  const o = runStrategy(sig, st, COSTS, r.holdout).metrics;
  assert.equal(base.train.netReturn, t.netReturn); assert.equal(base.train.trades, t.trades);
  assert.equal(base.oos.netReturn, o.netReturn);
  // 單一參數：槓桿與 RSI 門檻
  const lev = s.params.find((p) => p.key === 'lev');
  assert.equal(lev.points.length, 5);
  const lv2 = lev.points.find((p) => p.v === 2);
  assert.equal(lv2.train.netReturn, t.netReturn);
  const rsi = s.params.find((p) => p.key === 'c0.level');
  assert.ok(rsi && rsi.points.length >= 4);
  assert.equal(rsi.points.find((p) => p.v === 65).train.netReturn, t.netReturn, '門檻掃描中等於基準值的那一點，與基準回測相同');
});

test('摘要：高原／孤島判斷', () => {
  const mk = (tr, oo) => ({ train: { netReturn: tr }, oos: { netReturn: oo } });
  const ax = [1, 2, 3];
  const plateau = [[mk(0.1, 0.05), mk(0.1, 0.05), mk(0.1, 0.05)], [mk(0.1, 0.05), mk(0.2, 0.1), mk(0.1, 0.05)], [mk(0.1, -0.1), mk(0.1, 0.05), mk(0.1, 0.05)]];
  assert.equal(summarize(plateau, ax, ax, { sl: 2, tp: 2 }).level, 'good');
  const island = [[mk(-0.1, -0.1), mk(-0.1, -0.1), mk(-0.1, -0.1)], [mk(-0.1, -0.1), mk(0.3, 0.1), mk(-0.1, -0.1)], [mk(-0.1, 0), mk(-0.1, -0.1), mk(-0.1, 0)]];
  assert.equal(summarize(island, ax, ax, { sl: 2, tp: 2 }).level, 'bad');
  const lose = [[mk(-0.1, 0), mk(-0.1, 0), mk(-0.1, 0)], [mk(-0.1, 0), mk(-0.2, 0), mk(0.1, 0)], [mk(-0.1, 0), mk(-0.1, 0), mk(-0.1, 0)]];
  assert.equal(summarize(lose, ax, ax, { sl: 2, tp: 2 }).level, 'bad');
  assert.equal(summarize([[mk(0, 0)]], [1], [1], { sl: 1, tp: 1 }).level, 'none');
});

test('沒有停損停利時只做單一參數掃描，不會當機', () => {
  const { sig, ds } = makeMarket({ days: 240, windowDays: 200 });
  const r = splitRanges(ds);
  const st = { dir: 'long', entry: [{ id: 'rsi_oversold', tf: '1h', params: { level: 35 } }], exit: [], sl: 0, tp: 0, lev: 1, entryMode: 'edge', maxBars: 24 };
  const s = runSensitivity(sig, st, COSTS, r);
  assert.equal(s.grid.length, 1); assert.equal(s.summary.level, 'none');
  assert.ok(s.params.length >= 2);
});
