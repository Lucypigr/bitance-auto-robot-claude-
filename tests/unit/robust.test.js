import test from 'node:test';
import assert from 'node:assert/strict';
import { percentile, bootstrapTotals, signFlipP, maxDrawdownOf, shuffledDrawdowns, sidak, analyzeSegment, excursionStats, priceRet, runRobustness, robustVerdict } from '../../public/js/core/robust.js';
import { makeRng } from '../../public/js/core/util.js';
import { runStrategy } from '../../public/js/core/portfolio.js';
import { splitRanges } from '../../public/js/core/dataset.js';
import { evaluateDetail } from '../../public/js/core/search.js';
import { makeMarket } from '../helpers/market.js';

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} !≈ ${b}`);
const mkTrades = (pnls) => pnls.map((pnl, i) => ({ pnl, exitIdx: i, entryIdx: i, dir: 1, entryPrice: 100, exitPrice: 100 + pnl, mae: 0.01, mfe: Math.max(0.01, pnl / 100) }));

test('percentile：線性內插', () => {
  const a = [1, 2, 3, 4, 5];
  near(percentile(a, 0), 1); near(percentile(a, 0.5), 3); near(percentile(a, 1), 5); near(percentile(a, 0.25), 2);
  assert.equal(percentile([], 0.5), 0);
});

test('最大回撤：+10 −10 交替，本金 100 → 回撤 10/110', () => {
  near(maxDrawdownOf([10, -10, 10, -10], 100), 10 / 110);
  near(maxDrawdownOf([5, 5, 5], 100), 0);
});

test('重抽樣：中位數接近平均損益 × 筆數；區間單調；同種子結果相同', () => {
  const pnls = Array.from({ length: 200 }, (_, i) => (i % 3 === 0 ? -50 : 40));
  const total = pnls.reduce((a, b) => a + b, 0);
  const t1 = bootstrapTotals(pnls, 4000, makeRng(7));
  const t2 = bootstrapTotals(pnls, 4000, makeRng(7));
  assert.deepEqual(Array.from(t1), Array.from(t2));
  const med = percentile(Array.from(t1), 0.5);
  assert.ok(Math.abs(med - total) < 0.05 * Math.abs(total) + 200, `${med} vs ${total}`);
  assert.ok(percentile(Array.from(t1), 0.05) < med && med < percentile(Array.from(t1), 0.95));
});

test('符號翻轉檢定：全賺的 → p 極小；正負對稱 → p 約 0.5；全虧 → p 接近 1', () => {
  const rng = () => makeRng(11);
  const allWin = Array.from({ length: 30 }, () => 10);
  assert.ok(signFlipP(allWin, 3000, rng()) < 0.01);
  const sym = Array.from({ length: 40 }, (_, i) => (i % 2 ? 10 : -10));
  const p = signFlipP(sym, 4000, rng());
  assert.ok(p > 0.3 && p < 0.9, `p=${p}`);
  const allLose = Array.from({ length: 30 }, () => -10);
  assert.ok(signFlipP(allLose, 2000, rng()) > 0.99);
  assert.equal(signFlipP([], 100, rng()), 1);
});

test('多重檢定 Šidák：K=1 不變；K 越大校正後越大；上限 1', () => {
  assert.equal(sidak(0.01, 1), 0.01);
  near(sidak(0.001, 100), 1 - Math.pow(0.999, 100));
  assert.ok(sidak(0.01, 300) > 0.9);
  assert.ok(sidak(0.5, 1000) <= 1);
  assert.ok(sidak(0.01, 10) > sidak(0.01, 2));
});

test('順序重排：總損益不變，回撤分布的中位數與 95 百分位 ≥ 0 且單調', () => {
  const pnls = [50, -30, 20, -40, 60, -10, 30, -20];
  const dd = Array.from(shuffledDrawdowns(pnls, 1000, 2000, makeRng(5)));
  assert.ok(dd.every((x) => x >= 0 && x < 1));
  assert.ok(percentile(dd, 0.5) <= percentile(dd, 0.95));
});

test('analyzeSegment：交易太少 → insufficient；足夠 → 各欄位合理', () => {
  assert.equal(analyzeSegment(mkTrades([1, 2, 3]), 1000).insufficient, true);
  const trades = mkTrades(Array.from({ length: 60 }, (_, i) => (i % 4 === 0 ? -30 : 25)));
  const a = analyzeSegment(trades, 10000, { sims: 2000 });
  assert.equal(a.insufficient, false);
  assert.equal(a.n, 60);
  near(a.total, 45 * 25 - 15 * 30, 1e-9);
  assert.ok(a.boot.p05 < a.boot.p50 && a.boot.p50 < a.boot.p95);
  assert.ok(a.boot.probPositive > 0.9);
  assert.ok(a.signFlipP < 0.2);
  assert.ok(a.dd.observed >= 0 && a.dd.p95 >= a.dd.p50);
  assert.equal(a.boot.hist.counts.reduce((x, y) => x + y, 0), a.sims);
  assert.deepEqual(analyzeSegment(trades, 10000, { sims: 2000 }), a, '同種子要完全一致');
  assert.notDeepEqual(analyzeSegment(trades, 10000, { sims: 2000, seed: 99 }).boot.p50, undefined);
});

test('MAE／MFE：贏家／輸家的中位數、輸家曾浮盈比例、贏家抓到最大浮盈的幾成', () => {
  const ts = [
    { pnl: 10, dir: 1, entryPrice: 100, exitPrice: 104, mae: 0.01, mfe: 0.08 }, // 抓到 4/8 = 0.5
    { pnl: 10, dir: 1, entryPrice: 100, exitPrice: 106, mae: 0.02, mfe: 0.06 }, // 1.0
    { pnl: -5, dir: 1, entryPrice: 100, exitPrice: 97, mae: 0.03, mfe: 0.02 }, // 曾浮盈 2%
    { pnl: -5, dir: -1, entryPrice: 100, exitPrice: 103, mae: 0.03, mfe: 0.001 },
  ];
  near(priceRet(ts[3]), -0.03);
  const e = excursionStats(ts);
  assert.equal(e.win.n, 2); assert.equal(e.lose.n, 2);
  near(e.win.maeMed, 0.015); near(e.lose.maeMed, 0.03);
  near(e.loseWithProfit, 0.5);
  near(e.capture, 0.75);
});

test('整合：對真實回測結果跑可信度報告（含搜尋 K 組的校正）與白話結論', () => {
  const { sig, ds } = makeMarket();
  const ranges = splitRanges(ds);
  const costs = { fee: 0.0005, slippage: 0.0005, mmr: 0.005, posPct: 1, capital: 10000 };
  const st = { dir: 'long', entry: [{ id: 'rsi_oversold', tf: '1h', params: { level: 45 } }], exit: [], sl: 3, tp: 5, trail: 0, lev: 1, entryMode: 'edge', unit: 'pct' };
  const d = evaluateDetail(sig, st, costs, ranges);
  const res = { train: d.train, holdout: d.holdout, full: d.full, ranges };
  const r = runRobustness({ res, capital: 10000, nCandidates: 120, sims: 1500 });
  assert.equal(r.multiple.K, 120);
  if (!r.train.insufficient) assert.ok(r.multiple.pTrainAdj >= r.multiple.pTrain);
  const v = robustVerdict(r, { searched: true });
  assert.ok(v.length >= 1 && v.every((x) => ['good', 'warn', 'bad', 'info'].includes(x.level) && x.text.length > 10));
  const r1 = runRobustness({ res, capital: 10000, nCandidates: 1, sims: 1500 });
  assert.equal(r1.multiple.K, 1);
  assert.deepEqual(runRobustness({ res, capital: 10000, nCandidates: 1, sims: 1500 }), r1, '可重現');
  void runStrategy;
});

test('白話結論：樣本外交易太少 → 警告；p 值很小 → good；高 p → bad', () => {
  const rb = (p, probPos = 0.95, n = 40) => ({ train: { insufficient: false, n: 40, signFlipP: 0.001 }, oos: { insufficient: false, n, sims: 2000, signFlipP: p, boot: { probPositive: probPos, p05: -0.01, p95: 0.1 }, dd: { observed: 0.05, p95: 0.06 } }, multiple: { K: 1, pTrain: 0.001, pTrainAdj: 0.001, pOos: p }, excursion: { n: 0 } });
  assert.equal(robustVerdict(rb(0.01))[0].level, 'good');
  assert.equal(robustVerdict(rb(0.5, 0.3))[0].level, 'bad');
  const few = robustVerdict({ train: { insufficient: true, n: 2 }, oos: { insufficient: true, n: 3 }, multiple: { K: 1 }, excursion: { n: 0 } });
  assert.equal(few[0].level, 'warn');
  assert.ok(few.some((x) => x.text.includes('30 筆')));
  const multi = robustVerdict({ ...rb(0.01), multiple: { K: 300, pTrain: 0.01, pTrainAdj: 0.95, pOos: 0.01 } }, { searched: true });
  assert.ok(multi.some((x) => x.level === 'warn' && x.text.includes('300')));
});
