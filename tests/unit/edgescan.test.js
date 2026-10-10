import test from 'node:test';
import assert from 'node:assert/strict';
import { normSf, bhQ, tripReturn, scanEdges, scanConditionIds } from '../../public/js/core/edgescan.js';
import { makeRng } from '../../public/js/core/util.js';
import { mkDs } from '../helpers/ds.js';

const near = (a, b, e = 1e-9) => assert.ok(Math.abs(a - b) <= e, `${a} !≈ ${b}`);
const COSTS = { fee: 0.0005, slippage: 0.0005 };

/** 隨機漫步（可加入「大跌之後隔天反彈」的設計好的優勢，或穩定漂移） */
function walk({ n = 6000, seed = 1, sd = 0.004, drift = 0, plant = false, symbols = 1 }) {
  const rng = makeRng(seed);
  const gauss = () => { const u = Math.max(1e-12, rng()); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng()); };
  const bars = [];
  let c = 100;
  for (let i = 0; i < n; i++) {
    let r = drift + sd * gauss();
    if (plant && i % 40 === 20) r = -0.03;
    if (plant && i % 40 === 21) r = 0.02;
    const o = c;
    c = o * Math.exp(r);
    const hi = Math.max(o, c) * (1 + Math.abs(gauss()) * 0.0008);
    const lo = Math.min(o, c) * (1 - Math.abs(gauss()) * 0.0008);
    bars.push([o, hi, lo, c]);
  }
  void symbols;
  return mkDs(bars);
}
const RANGES = { train: { from: 300, to: 4200 }, holdout: { from: 4200, to: 5990 } };

test('標準常態上尾機率與 BH 校正（與已知值一致）', () => {
  near(normSf(0), 0.5, 1e-7); near(normSf(1.645), 0.05, 1e-4); near(normSf(3), 0.00135, 1e-5); near(normSf(-1), 1 - normSf(1), 1e-9);
  const q = bhQ([0.01, 0.04, 0.03, 0.005]);
  [0.02, 0.04, 0.04, 0.02].forEach((v, i) => near(q[i], v));
  assert.deepEqual(bhQ([]), []);
});

test('單筆報酬：零成本＝價差；做空相反；成本讓報酬變小；台股賣出稅', () => {
  near(tripReturn(1, 100, 110, { fee: 0, slippage: 0 }), 0.1);
  near(tripReturn(-1, 100, 90, { fee: 0, slippage: 0 }), 0.1);
  near(tripReturn(-1, 100, 110, { fee: 0, slippage: 0 }), -0.1);
  const c = tripReturn(1, 100, 110, { fee: 0.001, slippage: 0.001 });
  near(c, (110 * 0.999 * (1 - 0.001)) / (100 * 1.001 * 1.001) - 1);
  assert.ok(c < 0.1);
  assert.ok(tripReturn(1, 100, 110, { fee: 0, slippage: 0, tax: 0.003 }) < 0.1 - 0.0029);
  assert.ok(tripReturn(-1, 100, 100, { fee: 0.0005, slippage: 0.0005 }) < 0);
});

test('純隨機漫步：沒有任何行為通過檢驗（偽發現率受控），而且一定是「成本拖累」', async () => {
  const { ds, sig } = walk({ seed: 11 });
  void ds;
  const r = await scanEdges(sig, COSTS, RANGES, { horizons: [1, 4, 12], minEvents: 30 });
  assert.ok(r.summary.nTested > 100, `測試組數 ${r.summary.nTested}`);
  assert.equal(r.summary.nConfirmed, 0, '隨機漫步不該有樣本外確認的優勢');
  assert.ok(r.summary.nSelected <= 3, `訓練期偽發現 ${r.summary.nSelected}`);
  // 基準（任何時間進場）平均淨報酬應為負，大約等於來回成本
  for (const b of r.baselines) assert.ok(b.train.mean < 0 && b.train.mean > -0.01, `基準 ${b.train.mean}`);
  // p 值不應大量偏小：p<0.05 的比例不超過 20%（事件有重疊的相關性，所以給寬鬆上限）
  assert.ok(r.summary.nP05 / r.summary.nTested < 0.2, `p<0.05 占 ${r.summary.nP05}/${r.summary.nTested}`);
});

test('設計好的優勢（大跌後隔天反彈 2%）：能在訓練期找到並在樣本外確認', async () => {
  const { sig } = walk({ seed: 5, plant: true });
  const r = await scanEdges(sig, COSTS, RANGES, { horizons: [1, 4], minEvents: 20, byRegime: false });
  const hit = r.rows.filter((x) => x.confirmed && x.dir === 1 && x.h === 1);
  assert.ok(hit.length >= 1, '應確認至少一個「做多、持有 1 根」的行為');
  const best = hit[0];
  assert.ok(best.train.mean > 0.003 && best.oos.mean > 0.003, `平均淨報酬 ${best.train.mean} / ${best.oos.mean}`);
  assert.ok(best.train.excess > 0.003);
  assert.ok(r.summary.nConfirmed >= 1);
  assert.equal(r.rows[0].train.pUse <= r.rows[r.rows.length - 1].train.pUse, true, '依 p 值排序');
});

test('穩定上漲漂移：事件的絕對報酬為正，但「超額報酬」不顯著，不算發現（避免把大盤上漲當成優勢）', async () => {
  const { sig } = walk({ seed: 9, drift: 0.0015 });
  const r = await scanEdges(sig, COSTS, RANGES, { horizons: [4, 12], minEvents: 30, byRegime: false });
  const longBase = r.baselines.filter((b) => b.dir === 1);
  assert.ok(longBase.every((b) => b.train.mean > 0), '漂移讓任何時間進場的做多都賺');
  assert.equal(r.summary.nConfirmed, 0);
  assert.ok(r.summary.nSelected <= 3);
});

test('分行情：每個行為多出 4 種行情的列；基準也依行情分層；事件互不重疊（筆數不超過期間/持有根數）', async () => {
  const { sig } = walk({ seed: 3 });
  const all = await scanEdges(sig, COSTS, RANGES, { horizons: [12], minEvents: 20, byRegime: true });
  const tags = new Set(all.rows.map((x) => x.regime));
  assert.ok(tags.has('all') && tags.size >= 3, `行情標籤 ${[...tags]}`);
  const maxN = Math.floor((RANGES.train.to - RANGES.train.from) / 12) + 1;
  for (const row of all.rows.filter((x) => x.regime === 'all')) assert.ok(row.train.n <= maxN, `${row.label} n=${row.train.n} > ${maxN}`);
  for (const row of all.rows) assert.ok(Number.isFinite(row.train.mean) && row.train.p >= 0 && row.train.p <= 1);
});

test('現貨市場只測做多；可取消；進度會回報；結果可重現', async () => {
  const { ds, sig } = walk({ seed: 21, n: 3000 });
  ds.market = 'spot';
  const r = await scanEdges(sig, COSTS, { train: { from: 300, to: 2000 }, holdout: { from: 2000, to: 2990 } }, { horizons: [4], minEvents: 20, byRegime: false });
  assert.ok(r.rows.length > 0 && r.rows.every((x) => x.dir === 1));
  let n = 0;
  const c = await scanEdges(sig, COSTS, RANGES, { horizons: [4] }, { cancelled: () => ++n > 3 });
  assert.equal(c.cancelled, true);
  const seen = [];
  await scanEdges(sig, COSTS, { train: { from: 300, to: 2000 }, holdout: { from: 2000, to: 2990 } }, { horizons: [4], ids: scanConditionIds().slice(0, 5), byRegime: false, minEvents: 5 }, { progress: (p) => seen.push(p.done) });
  assert.deepEqual(seen, [1, 2, 3, 4, 5]);
  const a = await scanEdges(sig, COSTS, { train: { from: 300, to: 2000 }, holdout: { from: 2000, to: 2990 } }, { horizons: [4], byRegime: false });
  const b = await scanEdges(sig, COSTS, { train: { from: 300, to: 2000 }, holdout: { from: 2000, to: 2990 } }, { horizons: [4], byRegime: false });
  assert.deepEqual(a.rows.map((x) => x.key + x.train.mean), b.rows.map((x) => x.key + x.train.mean));
});

test('不會偷看未來：只動「掃描區間之後」的資料，訓練期結果完全不變', async () => {
  const w1 = walk({ seed: 31, n: 3000 });
  const w2 = walk({ seed: 31, n: 3000 });
  const S = w2.ds.symbols[0];
  for (let i = 2100; i < 3000; i++) { S.o[i] *= 1.3; S.h[i] *= 1.3; S.l[i] *= 1.3; S.c[i] *= 1.3; }
  const rg = { train: { from: 300, to: 1500 }, holdout: { from: 1500, to: 2000 } };
  const a = await scanEdges(w1.sig, COSTS, rg, { horizons: [4], byRegime: false });
  const b = await scanEdges(w2.sig, COSTS, rg, { horizons: [4], byRegime: false });
  assert.deepEqual(a.rows.map((x) => [x.key, x.train.n, x.train.mean, x.oos.n, x.oos.mean]), b.rows.map((x) => [x.key, x.train.n, x.train.mean, x.oos.n, x.oos.mean]));
});

import { clusterRows } from '../../public/js/core/edgescan.js';
test('合併「完全相同的一批事件」：事件筆數與平均報酬都相同的列只列一次', () => {
  const mk = (label, n, mean) => ({ label, dir: 1, h: 4, regime: 'all', train: { n, mean }, oos: { n: 10, mean: 0.01 } });
  const cl = clusterRows([mk('A', 50, 0.01), mk('B', 50, 0.01), mk('C', 50, 0.02), mk('D', 49, 0.01)]);
  assert.equal(cl.length, 3);
  assert.deepEqual(cl[0].same, ['B']);
  assert.equal(clusterRows([]).length, 0);
});

import { scanRows, toCsv } from '../../public/js/core/report.js';
import { REGIME_LABEL } from '../../public/js/core/regime.js';
test('掃描結果 CSV：欄位數一致、行情顯示中文、通過／確認欄位正確', async () => {
  const { sig } = walk({ seed: 5, plant: true });
  const r = await scanEdges(sig, COSTS, RANGES, { horizons: [1], minEvents: 20 });
  const rows = scanRows(r, REGIME_LABEL);
  assert.equal(rows.length, r.rows.length + 1);
  for (const x of rows) assert.equal(x.length, rows[0].length);
  assert.ok(rows.some((x) => x[3] === '單邊上漲' || x[3] === '震盪' || x[3] === '全部'));
  assert.ok(rows.slice(1).some((x) => x[16] === '是'));
  assert.match(toCsv(rows), /訓練平均淨報酬/);
});

import { scanItems } from '../../public/js/core/edgescan.js';
test('掃描項目：斐波那契回撤分 38.2%／50%／61.8% 三個比例各測一次，其他條件只測預設參數', () => {
  const items = scanItems();
  const fib = items.filter((x) => x.id === 'fib_pullback');
  assert.equal(fib.length, 3);
  assert.deepEqual(fib.map((x) => x.params.level), [0.382, 0.5, 0.618]);
  assert.match(fib[2].label, /61\.8%/);
  assert.equal(new Set(items.map((x) => x.key)).size, items.length);
  assert.ok(items.some((x) => x.id === 'rsi_oversold' && Object.keys(x.params).length === 0));
  assert.ok(!items.some((x) => x.id.startsWith('regime_')));
});
