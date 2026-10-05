import test from 'node:test';
import assert from 'node:assert/strict';
import { computeMetrics } from '../../public/js/core/metrics.js';

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} !≈ ${b}`);
const DAY = 86400000;
const ds = { t0: Date.UTC(2024, 0, 1), baseMs: DAY };
const T = (pnl, ret, extra = {}) => ({ pnl, ret, fee: 1, funding: 0, reason: 'tp', mae: 0, liqDist: 1, ...extra });

test('淨報酬、最大回撤、月報酬', () => {
  // 每日一根；淨值：100 → 110 → 99 → 120
  const equity = Float64Array.from([110, 99, 120]);
  const m = computeMetrics({ equity, range: { from: 0, to: 3 }, ds, trades: [], perSymbol: [{ ret: 0.2 }], capital: 100, lev: 1, liquidations: 0 });
  near(m.netReturn, 0.2);
  near(m.maxDrawdown, 0.1); // 110 → 99
  assert.equal(m.totalMonths, 1);
  assert.equal(m.positiveMonths, 1);
  near(m.monthly[0].ret, 0.2);
});

test('勝率、Profit Factor、期望值、平均盈虧、最長連敗', () => {
  const trades = [T(10, 0.1), T(-5, -0.05), T(-5, -0.05), T(-5, -0.05), T(20, 0.2), T(-10, -0.1)];
  const m = computeMetrics({ equity: null, range: { from: 0, to: 6 }, ds, trades, perSymbol: [{ ret: 0.05 }, { ret: -0.1 }], capital: 100, lev: 2, liquidations: 0, finalEquityFallback: 105 });
  near(m.winRate, 2 / 6);
  near(m.profitFactor, 30 / 25);
  near(m.expectancy, 5 / 6);
  near(m.avgWin, 15);
  near(m.avgLoss, -25 / 4);
  assert.equal(m.maxLosingStreak, 3);
  assert.equal(m.trades, 6);
  assert.equal(m.positiveSymbolRatio, 0.5);
  assert.equal(m.leverage, 2);
});

test('沒有虧損交易 → PF 為無限大；沒有交易 → 全 0', () => {
  const m = computeMetrics({ equity: null, range: { from: 0, to: 2 }, ds, trades: [T(5, 0.05)], perSymbol: [], capital: 100, lev: 1, liquidations: 0, finalEquityFallback: 105 });
  assert.equal(m.profitFactor, Infinity);
  const z = computeMetrics({ equity: null, range: { from: 0, to: 2 }, ds, trades: [], perSymbol: [], capital: 100, lev: 1, liquidations: 0, finalEquityFallback: 100 });
  assert.equal(z.winRate, 0); assert.equal(z.profitFactor, 0); assert.equal(z.trades, 0);
});

test('Sharpe / Sortino：以日報酬年化(√365)', () => {
  // 日報酬 +1%, -1%, +1%, -1% ...
  const eq = []; let e = 100;
  for (let i = 0; i < 100; i++) { e *= i % 2 === 0 ? 1.01 : 0.99; eq.push(e); }
  const m = computeMetrics({ equity: Float64Array.from(eq), range: { from: 0, to: 100 }, ds, trades: [], perSymbol: [], capital: 100, lev: 1, liquidations: 0 });
  const r = Array.from({ length: 100 }, (_, i) => (i % 2 === 0 ? 0.01 : -0.01));
  const mean = r.reduce((a, b) => a + b) / 100;
  const sd = Math.sqrt(r.reduce((a, x) => a + (x - mean) ** 2, 0) / 99);
  near(m.sharpe, (mean / sd) * Math.sqrt(365), 1e-6);
  const dsd = Math.sqrt(r.filter((x) => x < 0).reduce((a, x) => a + x * x, 0) / 100);
  near(m.sortino, (mean / dsd) * Math.sqrt(365), 1e-6);
});

test('CAGR：一年翻倍 = 100%', () => {
  const eq = new Float64Array(365).fill(200);
  const m = computeMetrics({ equity: eq, range: { from: 0, to: 365 }, ds, trades: [], perSymbol: [], capital: 100, lev: 1, liquidations: 0 });
  near(m.cagr, 1, 1e-9);
  assert.equal(m.shortPeriod, false);
});

test('清算近接度：被清算 = 1；MAE 為清算距離的一半 = 0.5', () => {
  const m1 = computeMetrics({ equity: null, range: { from: 0, to: 1 }, ds, trades: [T(-10, -1, { reason: 'liq' })], perSymbol: [], capital: 10, lev: 10, liquidations: 1, finalEquityFallback: 0 });
  assert.equal(m1.liqProximity, 1);
  const m2 = computeMetrics({ equity: null, range: { from: 0, to: 1 }, ds, trades: [T(-1, -0.1, { mae: 0.045, liqDist: 0.09 })], perSymbol: [], capital: 10, lev: 10, liquidations: 0, finalEquityFallback: 9 });
  near(m2.liqProximity, 0.5);
});
