import test from 'node:test';
import assert from 'node:assert/strict';
import { simulateSymbol, simulateDual } from '../../public/js/core/engine.js';
import { runStrategy, validateStrategy, strategyToCfg } from '../../public/js/core/portfolio.js';
import { mkDs, flat, COSTS0 } from '../helpers/ds.js';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} !≈ ${b}`);
const CFG = { dir: 1, lev: 1, sl: 0, tp: 0, trail: 0, maxBars: 0, posPct: 1, fee: 0, slippage: 0, mmr: 0.005, perp: true };
function sim(bars, entries, cfgOver = {}, opts = {}) {
  const { ds, S } = mkDs(bars, opts);
  const range = opts.range || { from: 0, to: bars.length };
  const eq = new Float64Array(range.to - range.from);
  const r = simulateSymbol(ds, S, Int32Array.from(entries), { ...CFG, ...cfgOver }, range, 10000, eq);
  return { ...r, eq, ds, S };
}

// ---------------- ATR 單位 ----------------
// 前 20 根每根振幅固定 2（ATR≈2、佔價格 2%），訊號在第 19 根，第 20 根開盤 100 進場
const atrBars = (tail) => [...Array.from({ length: 20 }, () => [100, 101, 99, 100]), ...tail];

test('ATR 單位：停損距離 = 倍數 × 訊號那根的 ATR%（不是進場之後才知道的資料）', () => {
  const bars = atrBars([[100, 100.5, 95, 96], ...flat(96, 3)]);
  const r = sim(bars, [19], { unitAtr: true, atrPeriod: 14, sl: 1.5 }); // 1.5 × 2% = 3%
  const t = r.trades[0];
  assert.equal(t.reason, 'sl');
  near(t.exitPrice, 97, 1e-9); // 100 × (1 − 3%)
  near(t.pnl, -300, 1e-6);
});

test('ATR 單位：停利與停損一起、風險比例定位用 ATR 停損距離換算', () => {
  const bars = atrBars([[100, 105, 99.5, 104], ...flat(104, 3)]);
  const r = sim(bars, [19], { unitAtr: true, sl: 1, tp: 2 }); // 停損 2%、停利 4%
  assert.equal(r.trades[0].reason, 'tp');
  near(r.trades[0].exitPrice, 104);
  // 每筆風險 1% 本金、停損 2%（ATR 1×）→ 保證金上限 = 10000×1%/2% = 5000
  const r2 = sim(atrBars([[100, 100.5, 97, 98], ...flat(98, 3)]), [19], { unitAtr: true, sl: 1, riskPct: 0.01 });
  near(r2.trades[0].margin, 5000, 1e-6);
  near(r2.trades[0].pnl, -100, 1e-6); // 剛好虧掉本金的 1%
});

test('ATR 單位：ATR 還沒暖機（資料太少）就不進場', () => {
  const bars = [...Array.from({ length: 5 }, () => [100, 101, 99, 100]), ...flat(100, 4)];
  const r = sim(bars, [3], { unitAtr: true, sl: 1 });
  assert.equal(r.trades.length, 0);
});

test('ATR 單位：訊號之後的暴漲暴跌不會改變當筆的停損距離（無偷看）', () => {
  const calm = atrBars([[100, 100.5, 99.8, 100], [100, 100.4, 99.9, 100], ...flat(100, 3)]);
  const wild = atrBars([[100, 100.5, 99.8, 100], [100, 130, 70, 100], ...flat(100, 3)]);
  const a = sim(calm, [19], { unitAtr: true, sl: 1.5, tp: 1.5 });
  const b = sim(wild, [19], { unitAtr: true, sl: 1.5, tp: 1.5 });
  const fa = a.S._atr.get(14); const fb = b.S._atr.get(14);
  near(fa.a[19], fb.a[19], 1e-12); // 訊號那根的 ATR 兩邊相同
  near(b.trades[0].exitPrice, 97, 1e-9); // 停損距離仍是 3%
});

// ---------------- 分批出場 ----------------
test('分批出場：到第一目標先平 50%（限價、不加滑價），剩下的繼續到最終停利；損益與手續費加總正確', () => {
  const bars = [...flat(100, 2), [100, 103, 99.5, 102.5], [102.5, 111, 102, 110], ...flat(110, 2)];
  const r = sim(bars, [0], { tp: 0.1, so: { at: 0.02, frac: 0.5, be: false }, fee: 0.001 });
  const t = r.trades[0];
  assert.equal(t.reason, 'tp');
  assert.equal(t.legs.length, 1);
  near(t.legs[0].price, 102);
  near(t.legs[0].qty, t.qty * 0.5, 1e-9);
  // q = 10000/(100×1.001) = 99.9001；半倉 2% 賺、半倉 10% 賺
  const q = 10000 / (100 * 1.001);
  const gross = q * 0.5 * 2 + q * 0.5 * 10;
  const fees = q * 100 * 0.001 + q * 0.5 * 102 * 0.001 + q * 0.5 * 110 * 0.001;
  near(t.pnl, gross - fees, 1e-6);
  near(t.fee, fees, 1e-6);
});

test('分批出場 + 保本：第一目標成交後，停損移到成本價（從下一根起生效）', () => {
  // 第 2 根碰第一目標（同根不生效保本）；第 3 根回到成本價以下 → 保本出場
  const bars = [...flat(100, 2), [100, 103, 99.5, 102.5], [102.5, 102.8, 99, 99.5], ...flat(99.5, 2)];
  const r = sim(bars, [0], { sl: 0.05, so: { at: 0.02, frac: 0.5, be: true } });
  const t = r.trades[0];
  assert.equal(t.reason, 'be');
  near(t.exitPrice, 100);
  near(t.pnl, (10000 / 100) * 0.5 * 2 + 0, 1e-6); // 半倉賺 2%，剩下的保本 → 合計 +100
  // 不保本：同一份資料會被打到 5% 的停損之前，一直持有到最後
  const r2 = sim(bars, [0], { sl: 0.05, so: { at: 0.02, frac: 0.5, be: false } });
  assert.equal(r2.trades[0].reason, 'end');
});

test('分批出場：同一根 K 線同時碰到停損與第一目標 → 保守先停損、不做分批', () => {
  const bars = [...flat(100, 2), [100, 103, 94, 100], ...flat(100, 2)];
  const r = sim(bars, [0], { sl: 0.05, so: { at: 0.02, frac: 0.5, be: false } });
  assert.equal(r.trades[0].reason, 'sl');
  assert.equal(r.trades[0].legs, undefined);
});

test('分批出場：做空也對稱', () => {
  const bars = [...flat(100, 2), [100, 100.5, 97, 97.5], [97.5, 98, 89, 90], ...flat(90, 2)];
  const r = sim(bars, [0], { dir: -1, tp: 0.1, so: { at: 0.02, frac: 0.5, be: false } });
  const t = r.trades[0];
  assert.equal(t.reason, 'tp');
  near(t.legs[0].price, 98);
  near(t.pnl, 100 * 0.5 * 2 + 100 * 0.5 * 10, 1e-6);
});

test('分批出場：台股整股，平倉股數取整數', () => {
  const bars = [...flat(100, 2), [100, 103, 99.5, 102.5], ...flat(102.5, 3)];
  const r = sim(bars, [0], { lot: 1, perp: false, so: { at: 0.02, frac: 0.5, be: false } }, {});
  const t = r.trades[0];
  assert.equal(t.legs[0].qty, Math.floor(t.qty * 0.5));
  assert.ok(Number.isInteger(t.legs[0].qty));
});

// ---------------- 加碼／分批進場 ----------------
test('順勢加碼：價格每走 2% 加一次，成本價用加權平均；資金不足不會超額加碼', () => {
  const bars = [...flat(100, 2), [100, 104.5, 99.8, 104], [104, 105, 103.5, 104], ...flat(104, 2)];
  const r = sim(bars, [0], { posPct: 0.3, si: { mode: 'favor', step: 0.02, count: 2, size: 1 } });
  const t = r.trades[0];
  assert.equal(t.legs.filter((x) => x.kind === 'add').length, 2);
  near(t.legs[0].price, 102); near(t.legs[1].price, 104);
  // 初始 3000/100 = 30 股；加碼各 3000/價 → 29.4118 與 28.8462 股
  const q0 = 30; const a1 = 3000 / 102; const a2 = 3000 / 104;
  const avg = (q0 * 100 + a1 * 102 + a2 * 104) / (q0 + a1 + a2);
  near(t.avgEntry, avg, 1e-9);
  near(t.pnl, (q0 + a1 + a2) * (104 - avg), 1e-6); // 結束時以收盤 104 平倉
  // 每次保證金 4000：第一次 8000 ≤ 10000 可以，第二次 12000 > 10000 → 資金不足，只加一次
  const r2 = sim(bars, [0], { posPct: 0.4, si: { mode: 'favor', step: 0.02, count: 2, size: 1 } });
  assert.equal(r2.trades[0].legs.filter((x) => x.kind === 'add').length, 1);
});

test('順勢加碼：同一根 K 線先碰到停損就不加碼', () => {
  const bars = [...flat(100, 2), [100, 104, 94, 95], ...flat(95, 2)];
  const r = sim(bars, [0], { sl: 0.04, posPct: 0.4, si: { mode: 'favor', step: 0.02, count: 1, size: 1 } });
  assert.equal(r.trades[0].reason, 'sl');
  assert.equal(r.trades[0].legs, undefined);
});

test('逢低分批進場：先碰到加碼價再碰到停損 → 加碼後以更大部位被停損（比不加碼虧更多）', () => {
  const bars = [...flat(100, 2), [100, 100, 94, 95], ...flat(95, 2)];
  const plain = sim(bars, [0], { sl: 0.05, posPct: 0.4 });
  const dca = sim(bars, [0], { sl: 0.05, posPct: 0.4, si: { mode: 'adverse', step: 0.02, count: 1, size: 1 } });
  assert.equal(dca.trades[0].legs.length, 1);
  near(dca.trades[0].legs[0].price, 98);
  assert.ok(dca.trades[0].pnl < plain.trades[0].pnl);
  near(plain.trades[0].pnl, -200, 1e-6);
  const qAdd = 4000 / 98;
  near(dca.trades[0].pnl, 40 * (95 - 100) + qAdd * (95 - 98), 1e-6);
});

test('逢低分批進場：停損比加碼價更近 → 不會加碼', () => {
  const bars = [...flat(100, 2), [100, 100, 94, 95], ...flat(95, 2)];
  const r = sim(bars, [0], { sl: 0.01, posPct: 0.4, si: { mode: 'adverse', step: 0.03, count: 1, size: 1 } });
  assert.equal(r.trades[0].reason, 'sl');
  assert.equal(r.trades[0].legs, undefined);
});

test('加碼後的清算價依平均成本重算：順勢加碼把清算價拉近，同樣的崩跌會被清算（沒加碼則存活）', () => {
  const bars = [...flat(100, 2), [100, 103, 99.9, 103], [103, 103, 80.5, 81], ...flat(81, 2)];
  const plain = sim(bars, [0], { lev: 5, posPct: 0.4 });
  assert.notEqual(plain.trades[0].reason, 'liq'); // 原本清算價 ≈ 80.4，低點 80.5 沒碰到
  const added = sim(bars, [0], { lev: 5, posPct: 0.4, si: { mode: 'favor', step: 0.02, count: 1, size: 1 } });
  const t = added.trades[0];
  assert.equal(t.legs.length, 1);
  assert.equal(t.reason, 'liq');
  const aq = (4000 * 5) / 102;
  const q = 200 + aq; const avg = (200 * 100 + aq * 102) / q; const M = 8000;
  near(t.exitPrice, (q * avg - M) / (q * 0.995), 1e-6);
  near(t.pnl, -M, 1e-6); // 逐倉：賠掉全部保證金（無手續費時）
});

// ---------------- 雙向／反手 ----------------
function dual(bars, a, b, opts = {}) {
  const { ds, S } = mkDs(bars);
  const range = { from: 0, to: bars.length };
  const eq = new Float64Array(bars.length);
  const mk = (dir, rev) => ({ ...CFG, dir, ...(rev ? { revSig: rev } : {}) });
  const flags = (idx) => { const f = new Uint8Array(ds.n); for (const i of idx) f[i] = 1; return f; };
  const reverse = opts.reverse !== false;
  const r = simulateDual(ds, S, { entries: Int32Array.from(a), cfg: mk(1, reverse ? flags(b) : null) }, { entries: Int32Array.from(b), cfg: mk(-1, reverse ? flags(a) : null) }, range, 10000, eq);
  return { ...r, eq };
}

test('反手：持多單遇到做空訊號 → 下一根開盤平多並「同一個開盤價」反向做空；資金接續滾動', () => {
  // 訊號 0 → 第 1 根開盤 100 做多；訊號 2（做空）→ 第 3 根開盤 110 平多、反手做空；結束時平空
  const bars = [[100, 101, 99, 100], [100, 105, 99, 104], [104, 111, 103, 110], [110, 111, 105, 106], [106, 107, 100, 101], [101, 102, 99, 100]];
  const r = dual(bars, [0], [2]);
  assert.equal(r.trades.length, 2);
  const [t1, t2] = r.trades;
  assert.equal(t1.dir, 1); assert.equal(t1.reason, 'reverse'); assert.equal(t1.exitIdx, 3);
  near(t1.exitPrice, 110);
  near(t1.pnl, 100 * 10, 1e-6);
  assert.equal(t2.dir, -1); assert.equal(t2.entryIdx, 3); near(t2.entryPrice, 110);
  near(t2.equityBefore, 11000, 1e-6); // 用平倉後的資金開空
  assert.equal(t2.reason, 'end');
  near(r.finalEquity, 11000 + (11000 / 110) * (110 - 100), 1e-6);
});

test('不反手：持倉中忽略對面訊號，出場後才看新訊號', () => {
  const bars = [[100, 101, 99, 100], [100, 105, 99, 104], [104, 111, 103, 110], [110, 111, 105, 106], [106, 107, 100, 101], [101, 102, 99, 100]];
  const r = dual(bars, [0], [2, 4], { reverse: false });
  assert.equal(r.trades.length, 1); // 多單一路持有到結束；訊號 2、4 都被忽略
  assert.equal(r.trades[0].dir, 1);
});

test('雙向：同一根 K 線兩邊同時出現訊號 → 衝突，都不做；空手時任一邊都能開倉', () => {
  const bars = [...flat(100, 8)];
  assert.equal(dual(bars, [1], [1]).trades.length, 0);
  const r = dual([...flat(100, 3), [100, 100, 94, 95], ...flat(95, 4)], [], [1]);
  assert.equal(r.trades[0].dir, -1);
});

test('反手後的淨值曲線連續（反手那一根的淨值是新部位的盯市值）', () => {
  const bars = [[100, 101, 99, 100], [100, 105, 99, 104], [104, 111, 103, 110], [110, 111, 105, 106], [106, 107, 100, 101], [101, 102, 99, 100]];
  const r = dual(bars, [0], [2]);
  for (let i = 0; i < r.eq.length; i++) assert.ok(Number.isFinite(r.eq[i]) && r.eq[i] > 0, `eq[${i}]`);
  near(r.eq[3], 11000 + (11000 / 110) * (110 - 106), 1e-6);
});

// ---------------- 策略驗證 ----------------
test('驗證：單位、分批出場、加碼、雙向的錯誤設定會被擋下並說明', () => {
  const { ds } = mkDs(flat(100, 5));
  const base = { dir: 'long', entry: [{ id: 'rsi_oversold', tf: '1h' }], lev: 1 };
  assert.throws(() => validateStrategy(ds, { ...base, unit: 'atr', sl: 0, tp: 0 }), /ATR/);
  assert.throws(() => validateStrategy(ds, { ...base, unit: 'usdt', posUsdt: 5, sl: 1, scaleOut: { at: 1, frac: 50 } }), /USDT/);
  assert.throws(() => validateStrategy(ds, { ...base, tp: 5, scaleOut: { at: 6, frac: 50 } }), /更近/);
  assert.throws(() => validateStrategy(ds, { ...base, scaleOut: { at: 2, frac: 100 } }), /1% ～ 99%/);
  assert.throws(() => validateStrategy(ds, { ...base, sl: 3, scaleIn: { mode: 'adverse', step: 2, count: 2, size: 100 } }), /停損更近/);
  assert.throws(() => validateStrategy(ds, { ...base, tp: 3, scaleIn: { mode: 'favor', step: 4, count: 1, size: 100 } }), /小於停利/);
  assert.throws(() => validateStrategy(ds, { ...base, scaleIn: { mode: 'favor', step: 2, count: 9, size: 100 } }), /1 ～ 5/);
  assert.throws(() => validateStrategy(ds, { ...base, dir: 'both', entry: base.entry }), /同時設定/);
  assert.throws(() => validateStrategy(ds, { ...base, reverse: true }), /雙向/);
  const spot = { ...ds, market: 'spot' };
  assert.throws(() => validateStrategy(spot, { ...base, dir: 'both', entryB: base.entry }), /永續/);
  assert.throws(() => validateStrategy(ds, { ...base, dir: 'both', entryB: base.entry, capitalMode: 'shared', maxPos: 1 }), /共用資金池/);
  assert.doesNotThrow(() => validateStrategy(ds, { ...base, dir: 'both', entryB: base.entry, reverse: true, unit: 'atr', sl: 1.5, tp: 3, scaleOut: { at: 1, frac: 50, be: true }, scaleIn: { mode: 'favor', step: 0.5, count: 2, size: 50 } }));
});

test('strategyToCfg：ATR 單位不除以 100，百分比單位除以 100', () => {
  const a = strategyToCfg({ dir: 'long', unit: 'atr', sl: 1.5, tp: 3, scaleOut: { at: 1, frac: 50, be: true }, scaleIn: { mode: 'favor', step: 0.5, count: 2, size: 50 } }, { fee: 0, slippage: 0, mmr: 0.005 }, 'perp');
  assert.equal(a.unitAtr, true); assert.equal(a.sl, 1.5); assert.equal(a.so.at, 1); assert.equal(a.so.frac, 0.5); assert.equal(a.si.step, 0.5); assert.equal(a.si.size, 0.5);
  const p = strategyToCfg({ dir: 'long', sl: 3, tp: 6, scaleOut: { at: 2, frac: 40 }, scaleIn: { mode: 'adverse', step: 1, count: 1 } }, { fee: 0, slippage: 0, mmr: 0.005 }, 'perp');
  assert.equal(p.unitAtr, false); near(p.sl, 0.03); near(p.so.at, 0.02); near(p.si.step, 0.01); assert.equal(p.si.size, 1);
});

const COSTS = { fee: 0.0005, slippage: 0.0005, mmr: 0.005, posPct: 0.5, capital: 10000 };
const BASE = { dir: 'long', entry: [{ id: 'rsi_oversold', tf: '1h', params: { level: 45 } }], exit: [], entryMode: 'edge', lev: 1, sl: 2, tp: 4, unit: 'pct' };

function checkAccounting(res, capital, label) {
  const sum = res.trades.reduce((a, t) => a + t.pnl, 0);
  const last = res.equity[res.equity.length - 1];
  assert.ok(Math.abs(last - (capital + sum)) < 1e-6 * capital, `${label}：期末淨值 ${last} ≠ 本金＋交易損益 ${capital + sum}`);
  for (let i = 0; i < res.equity.length; i++) assert.ok(Number.isFinite(res.equity[i]) && res.equity[i] > -1e-6, `${label} eq[${i}]`);
  for (const t of res.trades) {
    assert.ok(Number.isFinite(t.pnl) && Number.isFinite(t.fee) && t.exitIdx >= t.entryIdx, label);
    if (t.legs) {
      const legPnl = t.legs.filter((x) => x.kind === 'partial').reduce((a, x) => a + x.pnl, 0);
      assert.ok(Number.isFinite(legPnl));
    }
  }
}

test('整合：各種新功能經 runStrategy 跑完，淨值曲線期末 = 本金 + 全部交易損益（會計一致）', async () => {
  const { makeMarket } = await import('../helpers/market.js');
  const { splitRanges } = await import('../../public/js/core/dataset.js');
  const { sig, ds } = makeMarket();
  const r = splitRanges(ds).full;
  const variants = {
    原本: BASE,
    ATR: { ...BASE, unit: 'atr', sl: 1.5, tp: 3 },
    ATR風險定位: { ...BASE, unit: 'atr', sl: 1.5, tp: 3, riskPct: 1 },
    分批出場: { ...BASE, sl: 3, tp: 8, scaleOut: { at: 2, frac: 50, be: true } },
    順勢加碼: { ...BASE, sl: 3, tp: 8, scaleIn: { mode: 'favor', step: 1, count: 2, size: 50 } },
    逢低分批: { ...BASE, sl: 6, tp: 6, scaleIn: { mode: 'adverse', step: 1.5, count: 2, size: 50 } },
    全部組合: { ...BASE, unit: 'atr', sl: 3, tp: 5, riskPct: 1, scaleOut: { at: 1, frac: 40, be: true }, scaleIn: { mode: 'favor', step: 0.6, count: 2, size: 50 } },
    雙向反手: { ...BASE, dir: 'both', entry: [{ id: 'rsi_oversold', tf: '1h', params: { level: 45 } }], entryB: [{ id: 'rsi_overbought', tf: '1h', params: { level: 55 } }], reverse: true, sl: 4, tp: 8 },
    雙向不反手: { ...BASE, dir: 'both', entryB: [{ id: 'rsi_overbought', tf: '1h', params: { level: 55 } }], reverse: false, sl: 4, tp: 8 },
    雙向加槓桿: { ...BASE, dir: 'both', entryB: [{ id: 'rsi_overbought', tf: '1h', params: { level: 55 } }], reverse: true, lev: 3, sl: 4, tp: 8 },
  };
  const out = {};
  for (const [name, st] of Object.entries(variants)) {
    const res = runStrategy(sig, st, COSTS, r);
    checkAccounting(res, COSTS.capital, name);
    out[name] = res;
  }
  assert.ok(out.原本.trades.length > 5, '要有足夠交易');
  assert.ok(out.順勢加碼.trades.some((t) => t.legs && t.legs.some((x) => x.kind === 'add')), '應有加碼成交');
  assert.ok(out.分批出場.trades.some((t) => t.legs && t.legs.some((x) => x.kind === 'partial')), '應有分批出場');
  assert.ok(out.逢低分批.trades.some((t) => t.legs && t.legs.some((x) => x.kind === 'add')), '應有逢低進場');
  const both = out.雙向反手.trades;
  assert.ok(both.some((t) => t.dir > 0) && both.some((t) => t.dir < 0), '雙向要有多空兩邊的交易');
  assert.ok(both.some((t) => t.reason === 'reverse'), '應有反手');
  assert.ok(!out.雙向不反手.trades.some((t) => t.reason === 'reverse'));
  // 雙向：同一檔標的的交易不會重疊
  for (const t of both) for (const u of both) if (t !== u && t.symbol === u.symbol) assert.ok(t.exitIdx <= u.entryIdx || u.exitIdx <= t.entryIdx, '同一檔不可同時持有兩個部位');
});

test('整合：新功能關閉時，結果與沿用舊欄位完全一致（回歸）', async () => {
  const { makeMarket } = await import('../helpers/market.js');
  const { splitRanges } = await import('../../public/js/core/dataset.js');
  const { sig, ds } = makeMarket();
  const r = splitRanges(ds).full;
  const a = runStrategy(sig, BASE, COSTS, r);
  const b = runStrategy(sig, { ...BASE, scaleOut: null, scaleIn: { count: 0 }, entryB: [], reverse: false, atrPeriod: 20 }, COSTS, r);
  assert.deepEqual(Array.from(a.equity), Array.from(b.equity));
  assert.equal(a.trades.length, b.trades.length);
});

// ---------------- 本金 % 與 ROE % 單位 ----------------
test('本金 % 單位：停損時毛損剛好 = 進場前資金袋淨值 × 比例（價格距離由投入金額決定）', () => {
  const bars = [...flat(100, 2), [100, 101, 90, 92], ...flat(92, 2)];
  // 投入 50%（5000）、1 倍槓桿：名目 5000；停損 2% 本金 = 200 → 價格 4% → 96
  const r = sim(bars, [0], { posPct: 0.5, slCap: 0.02 });
  near(r.trades[0].exitPrice, 96, 1e-9);
  assert.equal(r.trades[0].reason, 'sl');
  near(r.trades[0].pnl, -200, 1e-6);
  // 2 倍槓桿、全倉：名目 20000 → 價格 1% → 99；虧 200
  const r2 = sim(bars, [0], { lev: 2, posPct: 1, slCap: 0.02 });
  near(r2.trades[0].exitPrice, 99, 1e-9);
  near(r2.trades[0].pnl, -200, 1e-6);
  // 停利 3% 本金
  const up = [...flat(100, 2), [100, 106, 99.5, 105], ...flat(105, 2)];
  const r3 = sim(up, [0], { posPct: 0.5, tpCap: 0.03 }); // 賺 300 / 名目 5000 = 6% → 106
  assert.equal(r3.trades[0].reason, 'tp');
  near(r3.trades[0].exitPrice, 106, 1e-9);
  near(r3.trades[0].pnl, 300, 1e-6);
});

test('本金 %：資金袋滾動後，比例是相對「進場前淨值」（賺了之後虧損金額跟著變大）', () => {
  // 第一筆停利賺 10%（資金 11000）；第二筆停損 2% 本金 = 220
  const bars = [...flat(100, 2), [100, 111, 99.9, 110], ...flat(110, 3), [110, 110, 90, 95], ...flat(95, 2)];
  const r = sim(bars, [0, 5], { posPct: 1, tpCap: 0.1, slCap: 0.02 });
  assert.equal(r.trades.length, 2);
  near(r.trades[0].pnl, 1000, 1e-6);
  near(r.trades[1].equityBefore, 11000, 1e-6);
  near(r.trades[1].pnl, -220, 1e-6);
});

test('ROE %：價格距離 = ROE ÷ 槓桿（和幣安介面一致），與投入金額無關', () => {
  const cfg = strategyToCfg({ dir: 'long', unit: 'roe', sl: 20, tp: 40, lev: 5 }, { fee: 0, slippage: 0, mmr: 0.005 }, 'perp');
  near(cfg.sl, 0.04); near(cfg.tp, 0.08);
  const bars = [...flat(100, 2), [100, 101, 95, 96], ...flat(96, 2)];
  const r = sim(bars, [0], { lev: 5, posPct: 0.4, sl: cfg.sl });
  near(r.trades[0].exitPrice, 96, 1e-9);
  near(r.trades[0].pnl, -(r.trades[0].margin * 0.2), 1e-6); // 虧保證金的 20%
  const cap = strategyToCfg({ dir: 'long', unit: 'capital', sl: 2, tp: 4 }, { fee: 0, slippage: 0, mmr: 0.005 }, 'perp');
  assert.equal(cap.sl, 0); near(cap.slCap, 0.02); near(cap.tpCap, 0.04);
});

test('驗證：本金 % 不能搭配分批出場／加碼／每筆風險；ROE 只限永續；單位要有停損或停利', () => {
  const { ds } = mkDs(flat(100, 5));
  const base = { dir: 'long', entry: [{ id: 'rsi_oversold', tf: '1h' }], lev: 1, unit: 'capital', sl: 2, tp: 4 };
  assert.doesNotThrow(() => validateStrategy(ds, base));
  assert.throws(() => validateStrategy(ds, { ...base, riskPct: 1 }), /每筆風險/);
  assert.throws(() => validateStrategy(ds, { ...base, scaleOut: { at: 1, frac: 50 } }), /分批出場/);
  assert.throws(() => validateStrategy(ds, { ...base, scaleIn: { mode: 'favor', step: 1, count: 1, size: 100 } }), /加碼/);
  assert.throws(() => validateStrategy(ds, { ...base, sl: 0, tp: 0 }), /需要設定/);
  assert.throws(() => validateStrategy(ds, { ...base, sl: 150 }), /100%/);
  assert.throws(() => validateStrategy({ ...ds, market: 'spot' }, { ...base, unit: 'roe' }), /永續/);
  assert.doesNotThrow(() => validateStrategy(ds, { ...base, unit: 'roe', sl: 20, tp: 40, lev: 5, riskPct: 1, scaleOut: { at: 10, frac: 50 } }));
});

test('整合：本金 % 與 ROE % 經 runStrategy 跑完，期末淨值 = 本金 + 全部交易損益；停損時的毛損符合設定', async () => {
  const { makeMarket } = await import('../helpers/market.js');
  const { splitRanges } = await import('../../public/js/core/dataset.js');
  const { sig, ds } = makeMarket();
  const r = splitRanges(ds).full;
  const base = { dir: 'long', entry: [{ id: 'rsi_oversold', tf: '1h', params: { level: 45 } }], exit: [], entryMode: 'edge', lev: 1, sl: 2, tp: 4 };
  for (const unit of ['capital', 'roe']) {
    const res = runStrategy(sig, { ...base, unit, lev: unit === 'roe' ? 3 : 1 }, COSTS, r);
    checkAccounting(res, COSTS.capital, unit);
    assert.ok(res.trades.length > 5, unit);
  }
  // 手續費為 0、無滑價時：每一筆停損的損益 = −2% × 該筆進場前淨值
  const nofee = { fee: 0, slippage: 0, mmr: 0.005, posPct: 0.5, capital: 10000 };
  const res = runStrategy(sig, { ...base, unit: 'capital', tp: 0 }, nofee, r);
  const stops = res.trades.filter((t) => t.reason === 'sl');
  assert.ok(stops.length > 3);
  // 開盤跳空越過停損價會以更差的開盤價成交（虧得比設定多），其餘毛損剛好等於設定；資金費率另外計入損益
  let exact = 0;
  for (const t of stops) {
    const target = -0.02 * t.equityBefore;
    // 毛損（不含資金費率與手續費）才是「本金 %」所指的金額
    assert.ok(t.gross <= target + 1e-6 && t.gross >= target * 3, `${t.gross} vs ${target}`);
    if (Math.abs(t.gross - target) < 1e-6 * t.equityBefore + 1e-6) exact++;
  }
  assert.ok(exact / stops.length >= 0.5, `精確等於設定的比例 ${exact}/${stops.length}`);
});
