import test from 'node:test';
import assert from 'node:assert/strict';
import { simulateSymbol } from '../../public/js/core/engine.js';
import { runStrategy, validateStrategy } from '../../public/js/core/portfolio.js';
import { mkDs, flat, H, COSTS0 } from '../helpers/ds.js';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} !≈ ${b}`);
const CFG = { dir: 1, lev: 1, sl: 0, tp: 0, trail: 0, maxBars: 0, posPct: 1, fee: 0, slippage: 0, mmr: 0.005, perp: true };
function sim(bars, entries, cfgOver = {}, opts = {}) {
  const { ds, S } = mkDs(bars, opts);
  const range = opts.range || { from: 0, to: bars.length };
  const eq = new Float64Array(range.to - range.from);
  const r = simulateSymbol(ds, S, Int32Array.from(entries), { ...CFG, ...cfgOver }, range, 10000, eq);
  return { ...r, eq };
}

test('訊號在第 s 根收盤後成立 → 第 s+1 根「開盤價」才進場（不是訊號 K 線的收盤價）', () => {
  const bars = [[100, 101, 99, 100], [105, 106, 104, 105], [105, 106, 104, 105]];
  const r = sim(bars, [0]);
  assert.equal(r.trades.length, 1);
  assert.equal(r.trades[0].entryIdx, 1);
  assert.equal(r.trades[0].entryPrice, 105);
});

test('停利：以停利價成交', () => {
  const bars = [...flat(100, 2), [100, 106, 99, 104], ...flat(104, 2)];
  const r = sim(bars, [0], { tp: 0.05 });
  const t = r.trades[0];
  assert.equal(t.reason, 'tp');
  near(t.exitPrice, 105);
  near(t.pnl, 100 * 5); // q = 10000/100 = 100
  near(r.finalEquity, 10500);
});

test('停損：以停損價成交', () => {
  const bars = [...flat(100, 2), [100, 101, 97, 98], ...flat(98, 2)];
  const r = sim(bars, [0], { sl: 0.02 });
  assert.equal(r.trades[0].reason, 'sl');
  near(r.trades[0].exitPrice, 98);
  near(r.trades[0].pnl, -200);
});

test('同一根 K 線同時碰到停損與停利 → 保守假設先停損', () => {
  const bars = [...flat(100, 2), [100, 110, 90, 100], ...flat(100, 2)];
  const r = sim(bars, [0], { sl: 0.02, tp: 0.05 });
  assert.equal(r.trades[0].reason, 'sl');
  assert.ok(r.trades[0].pnl < 0);
});

test('開盤跳空越過停損價 → 以更差的開盤價成交', () => {
  const bars = [...flat(100, 2), [95, 96, 94, 95], ...flat(95, 2)];
  const r = sim(bars, [0], { sl: 0.02 });
  assert.equal(r.trades[0].reason, 'sl');
  near(r.trades[0].exitPrice, 95);
  near(r.trades[0].pnl, -500);
});

test('手續費與不利滑價（做多）', () => {
  const fee = 0.001; const slip = 0.001;
  const bars = [...flat(100, 2), [100, 106, 99.9, 104], ...flat(104, 2)];
  const r = sim(bars, [0], { fee, slippage: slip, tp: 0.05 });
  const t = r.trades[0];
  const entry = 100 * (1 + slip);
  const M = 10000 / (1 + fee);
  const q = M / entry;
  near(t.entryPrice, entry);
  const tpPrice = entry * 1.05;
  near(t.exitPrice, tpPrice);
  const net = q * (tpPrice - entry) - M * fee - q * tpPrice * fee;
  near(t.pnl, net, 1e-6);
  near(r.finalEquity, 10000 + net, 1e-6);
});

test('做空：滑價往不利（較低價賣出）', () => {
  const bars = [...flat(100, 2), [100, 101, 94, 95], ...flat(95, 2)];
  const r = sim(bars, [0], { dir: -1, slippage: 0.001, tp: 0.05 });
  const t = r.trades[0];
  near(t.entryPrice, 99.9);
  near(t.exitPrice, 99.9 * 0.95);
  assert.equal(t.reason, 'tp');
  assert.ok(t.pnl > 0);
});

test('做空停損', () => {
  const bars = [...flat(100, 2), [100, 104, 99, 103], ...flat(103, 2)];
  const r = sim(bars, [0], { dir: -1, sl: 0.03 });
  assert.equal(r.trades[0].reason, 'sl');
  near(r.trades[0].exitPrice, 103);
  near(r.trades[0].pnl, -300);
});

test('槓桿 10× 逐倉：清算價與損失 = 全部保證金', () => {
  const lev = 10; const mmr = 0.005;
  const pLiq = (100 * (1 - 1 / lev)) / (1 - mmr);
  const bars = [...flat(100, 2), [100, 100, 89, 90], ...flat(90, 2)];
  const r = sim(bars, [0], { lev });
  const t = r.trades[0];
  assert.equal(t.reason, 'liq');
  near(t.exitPrice, pLiq, 1e-9);
  near(t.liqDist, 1 - pLiq / 100, 1e-12);
  near(t.pnl, -10000);
  assert.equal(r.liquidations, 1);
  near(r.finalEquity, 0);
});

test('槓桿 10× 有 5% 停損 → 先停損、不會被清算；損失 = 50% 保證金', () => {
  const bars = [...flat(100, 2), [100, 100, 89, 90], ...flat(90, 2)];
  const r = sim(bars, [0], { lev: 10, sl: 0.05 });
  assert.equal(r.trades[0].reason, 'sl');
  near(r.trades[0].pnl, -5000);
});

test('做空 10× 清算價在進場價上方', () => {
  const lev = 10; const mmr = 0.005;
  const pLiq = (100 * (1 + 1 / lev)) / (1 + mmr);
  const bars = [...flat(100, 2), [100, 111, 100, 110], ...flat(110, 2)];
  const r = sim(bars, [0], { dir: -1, lev });
  assert.equal(r.trades[0].reason, 'liq');
  near(r.trades[0].exitPrice, pLiq, 1e-9);
});

test('清算以標記價格判斷：成交價插針但標記價沒到 → 不清算', () => {
  const bars = [...flat(100, 2), [100, 100, 89, 99], ...flat(99, 2)];
  const mark = bars.map(() => [100, 95]); // 標記價最低只到 95 (> 清算價 90.45)
  const r = sim(bars, [0], { lev: 10 }, { mark });
  assert.equal(r.liquidations, 0);
  assert.equal(r.trades[0].reason, 'end');
  const mark2 = bars.map(() => [100, 90]);
  const r2 = sim(bars, [0], { lev: 10 }, { mark: mark2 });
  assert.equal(r2.liquidations, 1);
});

test('槓桿 1× 做多永遠不會被清算', () => {
  const bars = [...flat(100, 2), [100, 100, 1, 1], ...flat(1, 2)];
  const r = sim(bars, [0], { lev: 1 });
  assert.equal(r.liquidations, 0);
  near(r.finalEquity, 100); // 剩下 1%
});

test('資金費率：多單在正費率時付費、空單收費', () => {
  const bars = flat(100, 10);
  const funding = { t: Float64Array.from([3 * H, 6 * H]), rate: Float64Array.from([0.001, 0.001]), mark: Float64Array.from([100, 100]) };
  const long = sim(bars, [0], { dir: 1 }, { funding });
  // 進場於 bar1 (t=1h)，持倉到 bar9 結束 → 兩次結算都經過；q=100，每次 100*100*0.001 = 10
  near(long.trades[0].funding, -20);
  near(long.trades[0].pnl, -20);
  const short = sim(bars, [0], { dir: -1 }, { funding });
  near(short.trades[0].funding, 20);
  near(short.finalEquity, 10020);
});

test('資金費率只計入持倉期間（進場前、出場後不計）', () => {
  const bars = flat(100, 10);
  bars[4] = [100, 106, 100, 105];
  const funding = { t: Float64Array.from([0 * H, 3 * H, 8 * H]), rate: Float64Array.from([0.01, 0.001, 0.01]), mark: Float64Array.from([100, 100, 100]) };
  const r = sim(bars, [0], { dir: 1, tp: 0.05 }, { funding });
  // 進場 bar1、停利 bar4：只有 t=3h 的結算在持倉期間
  near(r.trades[0].funding, -10);
});

test('現貨沒有資金費率', () => {
  const bars = flat(100, 10);
  const funding = { t: Float64Array.from([3 * H]), rate: Float64Array.from([0.01]), mark: Float64Array.from([100]) };
  const r = sim(bars, [0], { perp: false }, { funding, market: 'spot' });
  assert.equal(r.trades[0].funding, 0);
});

test('移動停損：從最高價回落 5% 出場', () => {
  const bars = [...flat(100, 2), [100, 110, 106, 110], [110, 120, 112, 118], [118, 119, 112, 113], ...flat(113, 2)];
  const r = sim(bars, [0], { trail: 0.05 });
  const t = r.trades[0];
  assert.equal(t.reason, 'trail');
  near(t.exitPrice, 120 * 0.95); // 114
  assert.ok(t.pnl > 0);
});

test('區間結束仍有持倉 → 以最後一根收盤價強制平倉', () => {
  const bars = [...flat(100, 3), [100, 103, 99, 102]];
  const r = sim(bars, [0], {});
  assert.equal(r.trades[0].reason, 'end');
  assert.equal(r.trades[0].exitIdx, 3);
  near(r.trades[0].exitPrice, 102);
});

test('最後一根的訊號無法進場（沒有下一根可成交）', () => {
  const bars = flat(100, 5);
  assert.equal(sim(bars, [4]).trades.length, 0);
});

test('同一時間只持一個部位；出場後的新訊號才能再進場', () => {
  const bars = [...flat(100, 2), [100, 106, 100, 105], ...flat(105, 3), [105, 111, 105, 110], flat(110, 1)[0]];
  const r = sim(bars, [0, 1, 2, 3, 4], { tp: 0.05 });
  // 第一筆: 進場 bar1, 停利 bar2。訊號 3、4 之後可再進場 (訊號3→bar4 進場, 105 → 停利 110.25 在 bar5 h=111)
  assert.equal(r.trades.length, 2);
  assert.equal(r.trades[0].exitIdx, 2);
  assert.ok(r.trades[1].entryIdx >= 3);
});

test('區間起點之前的訊號不會被使用（樣本外不受訓練期影響）', () => {
  const bars = flat(100, 20);
  const r = sim(bars, [9], {}, { range: { from: 10, to: 20 } });
  assert.equal(r.trades.length, 0);
  const r2 = sim(bars, [10], {}, { range: { from: 10, to: 20 } });
  assert.equal(r2.trades[0].entryIdx, 11);
});

test('淨值曲線：持倉中以收盤價計入未實現損益，結束時等於最終資金', () => {
  const bars = [...flat(100, 2), [100, 103, 99, 102], [102, 106, 101, 105], ...flat(105, 2)];
  const r = sim(bars, [0], {});
  assert.equal(r.eq.length, bars.length);
  near(r.eq[0], 10000); near(r.eq[1], 10000);
  near(r.eq[2], 10000 + 100 * 2);
  near(r.eq[3], 10000 + 100 * 5);
  near(r.eq[r.eq.length - 1], r.finalEquity);
  near(r.finalEquity, 10500);
});

test('反向訊號 / 持倉時間 → 下一根開盤出場', () => {
  const bars = [...flat(100, 2), [100, 101, 99, 100], [103, 104, 102, 103], ...flat(103, 3)];
  const exitSig = new Uint8Array(bars.length); exitSig[2] = 1; // 第 2 根收盤後出現出場訊號
  const r = sim(bars, [0], { exitSig });
  assert.equal(r.trades[0].reason, 'signal');
  assert.equal(r.trades[0].exitIdx, 3);
  near(r.trades[0].exitPrice, 103);
  const r2 = sim(bars, [0], { maxBars: 2 });
  assert.equal(r2.trades[0].reason, 'time');
  assert.equal(r2.trades[0].exitIdx, 3);
});

test('逐倉：任何一筆的虧損都不會超過該筆保證金', () => {
  // 隨機劇烈行情，高槓桿
  let seed = 1; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const bars = []; let p = 100;
  for (let i = 0; i < 400; i++) { const o = p; const c = p * (1 + (rnd() - 0.5) * 0.2); bars.push([o, Math.max(o, c) * 1.05, Math.min(o, c) * 0.95, c]); p = c; }
  for (const lev of [1, 3, 10]) {
    for (const dir of [1, -1]) {
      const entries = Array.from({ length: 100 }, (_, i) => i * 4);
      const r = sim(bars, entries, { lev, dir, sl: 0.03, tp: 0.05, fee: 0.0005, slippage: 0.0005 });
      for (const t of r.trades) assert.ok(t.pnl >= -t.margin - t.fee - 1e-6, `虧損 ${t.pnl} 超過保證金 ${t.margin}`);
      assert.ok(r.finalEquity >= 0);
    }
  }
});

test('現貨不可做空、不可用槓桿', () => {
  const { ds } = mkDs(flat(100, 5), { market: 'spot' });
  assert.throws(() => validateStrategy(ds, { dir: 'short', lev: 1 }), /現貨/);
  assert.throws(() => validateStrategy(ds, { dir: 'long', lev: 3 }), /槓桿/);
  validateStrategy(ds, { dir: 'long', lev: 1 });
});

test('runStrategy：多幣種資金平均分配，淨值為各資金袋加總', () => {
  const a = mkDs([...flat(100, 2), [100, 106, 100, 105], ...flat(105, 3)], { symbol: 'AAA' });
  const b = mkDs([...flat(100, 2), [100, 101, 94, 95], ...flat(95, 3)], { symbol: 'BBB' });
  const ds = { ...a.ds, symbols: [a.S, b.S] };
  // 手動組 SignalEngine 所需的訊號：直接以 rsi 之外的方式不方便，改用 stub
  const sig = {
    ds,
    entryIdx: () => Int32Array.from([0]),
    exitSignal: () => null,
  };
  const r = runStrategy(sig, { dir: 'long', entry: [], exit: [], lev: 1, sl: 0, tp: 5 }, { ...COSTS0, capital: 10000 }, { from: 0, to: 6 });
  // 每個幣種 5000：A +5% → +250；B 到最後平倉收盤 95 → -250
  near(r.perSymbol[0].finalEquity, 5250);
  near(r.perSymbol[1].finalEquity, 4750);
  near(r.equity[5], 10000);
  assert.equal(r.metrics.trades, 2);
  assert.equal(r.metrics.positiveSymbolRatio, 0.5);
});
