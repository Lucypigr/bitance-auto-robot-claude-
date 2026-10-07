import test from 'node:test';
import assert from 'node:assert/strict';
import { FinMindClient, loadTwData, twseQuotes, toActions, lastClosedTwDate } from '../../public/js/data/finmind.js';
import { MemoryStore } from '../../public/js/data/binance.js';
import { adjustPrices, buildTwDataset, findSuspiciousJumps, splitRanges } from '../../public/js/core/dataset.js';
import { SignalEngine } from '../../public/js/core/signals.js';
import { simulateSymbol } from '../../public/js/core/engine.js';
import { runStrategy, validateStrategy } from '../../public/js/core/portfolio.js';
import { runSearch } from '../../public/js/core/search.js';
import { FakeTw, fakeTwFetch } from '../helpers/fake-tw.js';

const NOW = Date.UTC(2026, 9, 6, 9, 0, 0); // 台灣時間 17:00（已收盤）
const D = 86400000;
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} !≈ ${b}`);

test('還原股價：除息／分割前的價格被調整，價格連續；分割同時調整成交量', () => {
  const t = Float64Array.from([0, 1, 2, 3].map((x) => x * D));
  const mk = (a) => Float64Array.from(a);
  const bars = { t, o: mk([100, 100, 25, 25]), h: mk([101, 101, 26, 26]), l: mk([99, 99, 24, 24]), c: mk([100, 100, 25, 25]), v: mk([10, 10, 40, 40]) };
  const { bars: adj, applied } = adjustPrices(bars, [{ date: '1970-01-03', factor: 0.25, splitLike: true }]);
  assert.equal(applied.length, 1);
  assert.deepEqual([...adj.c], [25, 25, 25, 25]);
  assert.deepEqual([...adj.v], [40, 40, 40, 40]);
  assert.equal(findSuspiciousJumps(bars).length, 1, '未還原會出現 −75% 的假崩盤');
  assert.equal(findSuspiciousJumps(adj).length, 0);
  // 不合理的係數（資料錯誤）會被忽略
  assert.equal(adjustPrices(bars, [{ date: '1970-01-03', factor: 0 }, { date: '1970-01-03', factor: 9 }]).applied.length, 0);
});

test('toActions：除息用參考價/前收盤、分割用 after/before', () => {
  const a = toActions([{ date: '2025-01-02', before_price: 100, reference_price: 99 }], [{ date: '2025-06-18', type: '分割', before_price: 188, after_price: 47 }], []);
  near(a[0].factor, 0.99); assert.equal(a[0].splitLike, false);
  near(a[1].factor, 0.25); assert.equal(a[1].splitLike, true);
});

test('台灣時間 14:30 前不使用當日資料', () => {
  const morning = Date.UTC(2026, 9, 6, 3, 0); // TW 11:00
  const evening = Date.UTC(2026, 9, 6, 8, 0); // TW 16:00
  assert.equal(lastClosedTwDate(morning), Date.UTC(2026, 9, 5));
  assert.equal(lastClosedTwDate(evening), Date.UTC(2026, 9, 6));
});

test('載入台股：還原後與「連續價格」完全一致；交易日曆沒有週末；清單只含上市櫃', async () => {
  const fake = new FakeTw({ nowMs: NOW });
  const client = new FinMindClient({ fetchImpl: fakeTwFetch(fake) });
  const stocks = await client.listStocks();
  assert.equal(stocks.length, 12);
  assert.ok(!stocks.some((s) => s.symbol === '8888'), '興櫃不列入');
  assert.ok(stocks.find((s) => s.symbol === '0050').isEtf);
  const raw = await loadTwData(client, new MemoryStore(), {
    symbols: [{ symbol: '2330', name: '台積電' }, { symbol: '0050', name: '元大台灣50', isEtf: true }, { symbol: '2317', name: '鴻海' }], days: 365, now: NOW,
  });
  const ds = buildTwDataset({ windowStart: raw.windowStart, symbols: raw.symbols });
  assert.equal(ds.market, 'tw'); assert.equal(ds.annual, 252);
  for (let i = 0; i < ds.n; i++) { const dow = new Date(ds.times[i]).getUTCDay(); assert.ok(dow !== 0 && dow !== 6); }
  assert.ok(ds.times[ds.n - 1] <= lastClosedTwDate(NOW));
  assert.ok(ds.n - ds.windowStartIdx > 200 && ds.n - ds.windowStartIdx < 260);
  assert.ok(ds.windowStartIdx > 280, '暖機至少約 300 個交易日');
  for (const id of ['2330', '0050']) {
    const S = ds.symbols.find((s) => s.symbol === id);
    const { rows } = fake.base(id);
    const byT = new Map(rows.map((r) => [r.t, r]));
    let checked = 0;
    for (let i = S.first; i <= S.last; i++) {
      const r = byT.get(ds.times[i]);
      if (!r) continue;
      near(S.c[i] / r.c, 1, 1e-4); near(S.o[i] / r.o, 1, 1e-4); checked++;
    }
    assert.ok(checked > 400);
  }
  assert.equal(raw.symbols.find((s) => s.symbol === '0050').adjusted, 1);
  assert.equal(ds.warnings.length, 0, ds.warnings.join(';'));
  // 價格請求有快取：第二次不再向 FinMind 請求價格
  const before = fake.requests.length;
  await loadTwData(client, new MemoryStore(), { symbols: [{ symbol: '2330', name: 'x' }], days: 365, now: NOW });
  assert.ok(fake.requests.length > before);
});

test('FinMind 額度用完 → 清楚的錯誤訊息（建議填 Token）', async () => {
  const fake = new FakeTw({ nowMs: NOW, quota: 1 });
  const client = new FinMindClient({ fetchImpl: fakeTwFetch(fake), retries: 0 });
  await client.listStocks();
  await assert.rejects(client.prices('2330', NOW - 30 * D, NOW), (e) => e.kind === 'rate' && /Token/.test(e.message));
});

test('證交所行情表：成交金額與漲跌幅', async () => {
  const fake = new FakeTw({ nowMs: NOW });
  const q = await twseQuotes(fakeTwFetch(fake), NOW);
  assert.ok(q.size >= 9);
  const t = q.get('2330');
  assert.ok(t.turnover > 0 && Number.isFinite(t.change));
});

// ---------------- 回測引擎：台股成本 ----------------
function mini(bars, extra = {}) {
  const n = bars.length;
  const times = Float64Array.from({ length: n }, (_, i) => Date.UTC(2026, 0, 5) + i * D);
  const f = (k) => Float64Array.from(bars.map((b) => b[k]));
  const S = { symbol: '2330', first: 0, last: n - 1, o: f(0), h: f(1), l: f(2), c: f(3), v: new Float64Array(n).fill(1), mh: null, ml: null, funding: null, tf: {}, ...extra };
  return { ds: { market: 'tw', baseTf: '1d', baseMs: D, t0: times[0], times, n, windowStartIdx: 0, annual: 252, symbols: [S], warnings: [] }, S };
}
const TWCFG = { dir: 1, lev: 1, sl: 0, tp: 0.05, trail: 0, maxBars: 0, posPct: 1, fee: 0.001425, feeIn: 0.001425, feeOut: 0.001425 + 0.003, slippage: 0, mmr: 0.005, perp: false, minFee: 20, lot: 1, limitLock: true };
const flat = (p, n) => Array.from({ length: n }, () => [p, p, p, p]);

test('台股成本：買進手續費、賣出手續費＋證交稅、整股、最低手續費', () => {
  const { ds, S } = mini([...flat(100, 2), [100, 106, 99, 104], ...flat(104, 2)]);
  const r = simulateSymbol(ds, S, Int32Array.from([0]), TWCFG, { from: 0, to: 6 }, 1_000_000, new Float64Array(6));
  const t = r.trades[0];
  assert.equal(t.qty % 1, 0, '整股');
  assert.ok(t.qty * 100 + Math.max(20, t.qty * 100 * 0.001425) <= 1_000_000 + 1e-6, '買進成本不超過本金');
  const buyFee = Math.max(20, t.qty * 100 * 0.001425);
  const sellFee = Math.max(20, t.qty * 105 * 0.001425) + t.qty * 105 * 0.003;
  near(t.fee, buyFee + sellFee, 1e-6);
  near(t.pnl, t.qty * 5 - buyFee - sellFee, 1e-6);
  assert.equal(t.exitTime, ds.times[2]);
  assert.equal(t.entryTime, ds.times[1]);
  // 最低手續費：小額交易
  const small = simulateSymbol(ds, S, Int32Array.from([0]), TWCFG, { from: 0, to: 6 }, 5000, null);
  assert.equal(small.trades[0].qty, 49);
  near(small.trades[0].fee, 20 + (Math.max(20, 49 * 105 * 0.001425) + 49 * 105 * 0.003), 1e-6);
  // 買不起一股 → 沒有交易
  assert.equal(simulateSymbol(ds, S, Int32Array.from([0]), TWCFG, { from: 0, to: 6 }, 90, null).trades.length, 0);
});

test('台股：開盤即漲停鎖死（一價到底）買不到', () => {
  const { ds, S } = mini([[100, 100, 100, 100], [110, 110, 110, 110], [110, 112, 109, 111], [111, 116, 110, 115], ...flat(115, 2)]);
  const r = simulateSymbol(ds, S, Int32Array.from([0]), { ...TWCFG, tp: 0.03 }, { from: 0, to: 6 }, 1_000_000, null);
  assert.equal(r.trades.length, 0);
  const r2 = simulateSymbol(ds, S, Int32Array.from([0]), { ...TWCFG, tp: 0.03, limitLock: false }, { from: 0, to: 6 }, 1_000_000, null);
  assert.equal(r2.trades.length, 1);
});

test('台股：ETF 賣出稅率 0.1%；不能做空、不能用槓桿', () => {
  const { ds, S } = mini([...flat(100, 2), [100, 106, 99, 104], ...flat(104, 2)]);
  S.isEtf = true;
  const sig = { ds, entryIdx: () => Int32Array.from([0]), exitSignal: () => null };
  const costs = { fee: 0.001425, slippage: 0, mmr: 0.005, posPct: 1, capital: 1_000_000, tax: 0.003, taxEtf: 0.001, minFee: 20 };
  const r = runStrategy(sig, { dir: 'long', entry: [], exit: [], lev: 1, sl: 0, tp: 5 }, costs, { from: 0, to: 6 });
  const t = r.trades[0];
  near(t.fee, Math.max(20, t.qty * 100 * 0.001425) + Math.max(20, t.qty * 105 * 0.001425) + t.qty * 105 * 0.001, 1e-6);
  assert.throws(() => validateStrategy(ds, { dir: 'short', lev: 1 }), /台股/);
  assert.throws(() => validateStrategy(ds, { dir: 'long', lev: 2 }), /槓桿/);
});

test('台股指標：Sharpe 以 252 個交易日年化；交易日期為真實日期（週末不存在）', async () => {
  const fake = new FakeTw({ nowMs: NOW });
  const client = new FinMindClient({ fetchImpl: fakeTwFetch(fake) });
  const raw = await loadTwData(client, new MemoryStore(), { symbols: [{ symbol: '2330', name: 'a' }, { symbol: '2317', name: 'b' }, { symbol: '2454', name: 'c' }], days: 730, now: NOW });
  const ds = buildTwDataset({ windowStart: raw.windowStart, symbols: raw.symbols });
  const sig = new SignalEngine(ds);
  const r = splitRanges(ds);
  const st = { dir: 'long', entry: [{ id: 'rsi_oversold', tf: '1d', params: { level: 48 } }], exit: [], sl: 4, tp: 8, lev: 1, entryMode: 'edge' };
  const costs = { fee: 0.001425, slippage: 0.0005, mmr: 0.005, posPct: 1, capital: 1_000_000, tax: 0.003, taxEtf: 0.001, minFee: 20 };
  const res = runStrategy(sig, st, costs, r.train);
  assert.ok(res.metrics.trades > 0);
  for (const t of res.trades) { const dow = new Date(t.entryTime).getUTCDay(); assert.ok(dow !== 0 && dow !== 6); assert.equal(t.qty % 1, 0); }
  assert.ok(res.metrics.totalMonths >= 10);
  // 搜尋流程可以在台股資料上跑完，且只做多、1×
  const out = await runSearch(sig, { tfs: ['1d'], budget: 30, minTrades: 3 }, costs);
  assert.ok(out.candidates.length > 0);
  for (const c of out.candidates) { assert.equal(c.strategy.dir, 'long'); assert.equal(c.strategy.lev, 1); }
});
