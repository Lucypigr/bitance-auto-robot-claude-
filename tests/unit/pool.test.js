import test from 'node:test';
import assert from 'node:assert/strict';
import { simulateSymbol, simulatePool } from '../../public/js/core/engine.js';
import { runStrategy, validateStrategy } from '../../public/js/core/portfolio.js';
import { runSearch } from '../../public/js/core/search.js';
import { mkDs, flat, COSTS0 } from '../helpers/ds.js';
import { makeMarket } from '../helpers/market.js';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} !≈ ${b}`);
const CFG = { dir: 1, lev: 1, sl: 0, tp: 0, trail: 0, maxBars: 0, posPct: 1, fee: 0, slippage: 0, mmr: 0.005, perp: true };

function multi(barsList) {
  const ms = barsList.map((b, i) => mkDs(b, { symbol: `S${i}` }));
  const ds = { ...ms[0].ds, symbols: ms.map((m) => m.S) };
  return { ds, Ss: ms.map((m) => m.S) };
}
const win = [...flat(100, 2), [100, 106, 99, 104], ...flat(104, 4)]; // 進場 100，停利 5% 當根達成
const lose = [...flat(100, 2), [100, 101, 97, 98], ...flat(98, 4)];

test('風險比例定位：停損時剛好虧帳戶淨值的 X%（槓桿越高，部位越小）', () => {
  const { ds, S } = mkDs([...flat(100, 2), [100, 101, 97, 98], ...flat(98, 4)]);
  const run = (over) => simulateSymbol(ds, S, Int32Array.from([0]), { ...CFG, sl: 0.02, ...over }, { from: 0, to: 9 }, 10000, null).trades[0];
  const a = run({ riskPct: 0.01 });
  near(a.margin, 5000); near(a.pnl, -100);
  const b = run({ riskPct: 0.01, lev: 5 });
  near(b.margin, 1000); near(b.notional, 5000); near(b.pnl, -100);
  // 風險比例算出的部位若比「資金比例上限」大，仍受上限約束
  const c = run({ riskPct: 0.05, posPct: 0.3 });
  near(c.margin, 3000);
  // 沒有風險設定 → 全額
  near(run({}).margin, 10000);
});

test('共用資金池：同時最多持倉數限制，名額已滿的訊號被略過（依標的順序先到先得）', () => {
  const { ds, Ss } = multi([win, win, win]);
  const inputs = Ss.map((S) => ({ S, entries: Int32Array.from([0]), cfg: { ...CFG, tp: 0.05 } }));
  const r1 = simulatePool(ds, inputs, { from: 0, to: 9 }, 9000, { maxPos: 1 });
  assert.equal(r1.trades.length, 1);
  assert.equal(r1.trades[0].si, 0);
  near(r1.trades[0].margin, 9000); // 只有 1 個名額 → 全部資金
  const r2 = simulatePool(ds, inputs, { from: 0, to: 9 }, 9000, { maxPos: 2 });
  assert.deepEqual(r2.trades.map((t) => t.si), [0, 1]);
  near(r2.trades[0].margin, 4500);
  const r3 = simulatePool(ds, inputs, { from: 0, to: 9 }, 9000, { maxPos: 3 });
  assert.equal(r3.trades.length, 3);
  near(r3.trades[2].margin, 3000);
});

test('共用資金池：出場後名額釋出、已實現損益滾入下一筆的部位額度；未實現損益不拿來加碼', () => {
  // S0 在第 2 根停利出場（+5%），S1 的訊號在出場後（第 3 根收盤 → 第 4 根進場）
  const s1 = [...flat(100, 4), [100, 106, 99, 104], ...flat(104, 4)];
  const { ds, Ss } = multi([win, s1]);
  const inputs = [
    { S: Ss[0], entries: Int32Array.from([0]), cfg: { ...CFG, tp: 0.05 } },
    { S: Ss[1], entries: Int32Array.from([1, 3]), cfg: { ...CFG, tp: 0.05 } }, // 訊號 1 → 第 2 根進場（此時 S0 仍持倉，名額 1 已滿 → 略過）；訊號 3 → 第 4 根進場
  ];
  const r = simulatePool(ds, inputs, { from: 0, to: 9 }, 10000, { maxPos: 1 });
  assert.equal(r.trades.length, 2);
  assert.equal(r.trades[0].si, 0); near(r.trades[0].pnl, 500);
  assert.equal(r.trades[1].si, 1); assert.equal(r.trades[1].entryIdx, 4);
  near(r.trades[1].margin, 10500, 1e-6); // 滾入已實現的 +500
  near(r.equity[r.equity.length - 1], 10000 + 500 + 10500 * 0.05, 1e-6);
});

test('共用資金池：在「開盤」出場的部位當根就釋出名額；盤中出場的不會', () => {
  // S0：訊號 0 → 第 1 根進場；第 2 根收盤後出場訊號 → 第 3 根開盤出場（signal）
  const a = [...flat(100, 2), [100, 101, 99, 100], [100, 101, 99, 100], ...flat(100, 4)];
  // S1：訊號在第 2 根（→ 第 3 根進場）
  const b = flat(100, 9);
  const exitSig = new Uint8Array(9); exitSig[2] = 1;
  const { ds, Ss } = multi([a, b]);
  const inputs = [
    { S: Ss[0], entries: Int32Array.from([0]), cfg: { ...CFG, exitSig } },
    { S: Ss[1], entries: Int32Array.from([2]), cfg: { ...CFG } },
  ];
  const r = simulatePool(ds, inputs, { from: 0, to: 9 }, 10000, { maxPos: 1 });
  assert.equal(r.trades.length, 2, '第 3 根開盤出場的名額，當根開盤就能給 S1');
  assert.equal(r.trades[0].exitIdx, 3); assert.equal(r.trades[1].entryIdx, 3);
  // 若 S0 是盤中（第 3 根）停損才出場，S1 在第 3 根開盤進場時 S0 還在 → 名額已滿
  const a2 = [...flat(100, 2), [100, 101, 99, 100], [100, 101, 95, 96], ...flat(96, 4)];
  const r2 = simulatePool(ds, [
    { S: mkDs(a2).S, entries: Int32Array.from([0]), cfg: { ...CFG, sl: 0.03 } },
    { S: Ss[1], entries: Int32Array.from([2]), cfg: { ...CFG } },
  ], { from: 0, to: 9 }, 10000, { maxPos: 1 });
  assert.equal(r2.trades.length, 1);
});

test('共用資金池：淨值曲線 = 本金 + 已實現 + 持倉中的未實現；最後等於本金 + 全部損益', () => {
  const { ds, Ss } = multi([win, lose]);
  const inputs = [
    { S: Ss[0], entries: Int32Array.from([0]), cfg: { ...CFG, tp: 0.05 } },
    { S: Ss[1], entries: Int32Array.from([0]), cfg: { ...CFG, sl: 0.02 } },
  ];
  const r = simulatePool(ds, inputs, { from: 0, to: 9 }, 10000, { maxPos: 2 });
  near(r.equity[0], 10000); near(r.equity[1], 10000);
  const total = r.trades.reduce((a, t) => a + t.pnl, 0);
  near(r.equity[8], 10000 + total);
  near(total, 5000 * 0.05 - 5000 * 0.02);
  // 持倉期間（第 2 根收盤時兩筆都已出場）；用更長持倉驗證 MTM
  const hold = [...flat(100, 2), [100, 103, 99, 102], [102, 104, 101, 103], ...flat(103, 3)];
  const h = multi([hold]);
  const r2 = simulatePool(h.ds, [{ S: h.Ss[0], entries: Int32Array.from([0]), cfg: { ...CFG } }], { from: 0, to: 7 }, 10000, { maxPos: 1 });
  near(r2.equity[2], 10000 + 100 * 2); near(r2.equity[3], 10000 + 100 * 3);
});

test('共用資金池：名額 = 標的數時，第一筆交易與獨立資金袋模式完全相同', () => {
  const { ds, Ss } = multi([win, lose]);
  const cfgs = [{ ...CFG, tp: 0.05 }, { ...CFG, sl: 0.02 }];
  const sleeve = Ss.map((S, i) => simulateSymbol(ds, S, Int32Array.from([0]), cfgs[i], { from: 0, to: 9 }, 5000, null));
  const pool = simulatePool(ds, Ss.map((S, i) => ({ S, entries: Int32Array.from([0]), cfg: cfgs[i] })), { from: 0, to: 9 }, 10000, { maxPos: 2 });
  for (let i = 0; i < 2; i++) {
    const a = sleeve[i].trades[0]; const b = pool.trades.find((t) => t.si === i);
    near(a.pnl, b.pnl); near(a.qty, b.qty); assert.equal(a.exitIdx, b.exitIdx); assert.equal(a.reason, b.reason);
  }
});

test('runStrategy：共用資金池的各標的損益加總 = 總損益；驗證參數', () => {
  const { sig, ds } = makeMarket({ symbols: 4, days: 240, windowDays: 200 });
  const st = { dir: 'short', entry: [{ id: 'rsi_overbought', tf: '1h', params: { level: 65 } }], exit: [], sl: 2, tp: 3, lev: 2, entryMode: 'edge', capitalMode: 'shared', maxPos: 2 };
  const costs = { fee: 0.0005, slippage: 0.0005, mmr: 0.005, posPct: 1, capital: 10000 };
  const r = runStrategy(sig, st, costs, { from: ds.windowStartIdx, to: ds.n });
  assert.ok(r.trades.length > 10);
  near(r.perSymbol.reduce((a, p) => a + (p.finalEquity - 2500), 0), r.metrics.finalEquity - 10000, 1e-6);
  near(r.equity[r.equity.length - 1], r.metrics.finalEquity, 1e-6);
  // 任一時刻同時持倉不超過 2 檔
  const ev = [];
  for (const t of r.trades) { ev.push([t.entryIdx, 1]); ev.push([t.exitIdx + (t.atOpen ? 0 : 0.5), -1]); }
  ev.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let open = 0; let max = 0;
  for (const [, d] of ev) { open += d; max = Math.max(max, open); }
  assert.ok(max <= 2, `同時持倉最多 ${max}`);
  assert.throws(() => runStrategy(sig, { ...st, maxPos: 9 }, costs, { from: 0, to: 100 }), /同時最多持倉數/);
  assert.throws(() => runStrategy(sig, { ...st, capitalMode: 'sleeve', sl: 0, riskPct: 1 }, costs, { from: 0, to: 100 }), /需要先設定停損/);
  assert.throws(() => runStrategy(sig, { ...st, capitalMode: 'sleeve', unit: 'usdt', posUsdt: 5, riskPct: 1 }, costs, { from: 0, to: 100 }), /風險比例/);
});

test('共用資金池／風險定位可用在自動搜尋，且參數會帶進每個候選', async () => {
  const { sig } = makeMarket({ symbols: 3 });
  const costs = { fee: 0.0005, slippage: 0.0005, mmr: 0.005, posPct: 1, capital: 10000 };
  const r = await runSearch(sig, { tfs: ['1h', '4h'], budget: 30, minTrades: 3, capitalMode: 'shared', maxPos: 2, riskPct: 1 }, costs);
  assert.ok(r.candidates.length > 0);
  for (const c of r.candidates) { assert.equal(c.strategy.capitalMode, 'shared'); assert.equal(c.strategy.maxPos, 2); assert.match(c.desc, /共用資金池·最多 2 檔/); assert.match(c.desc, /每筆風險 1%/); }
  const any = r.candidates.find((c) => c.train.trades > 0);
  assert.ok(any);
  void validateStrategy; void COSTS0;
});
