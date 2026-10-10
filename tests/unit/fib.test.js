import test from 'node:test';
import assert from 'node:assert/strict';
import { fibRatios } from '../../public/js/core/indicators.js';
import { CONDITIONS, evalSpecOnSeries, IndicatorBundle, validateSpec, describeSpec } from '../../public/js/core/conditions.js';
import { scanEdges } from '../../public/js/core/edgescan.js';
import { mkDs } from '../helpers/ds.js';
import { makeRng } from '../../public/js/core/util.js';

const near = (a, b, e = 1e-9) => assert.ok(Math.abs(a - b) <= e, `${a} !≈ ${b}`);

/** 分段直線的收盤：[(索引, 價格), ...]；高低價 = 收盤 ± 0.5 */
function path(points, len) {
  const c = new Float64Array(len);
  for (let s = 0; s < points.length - 1; s++) {
    const [i0, p0] = points[s]; const [i1, p1] = points[s + 1];
    for (let i = i0; i <= i1; i++) c[i] = p0 + ((p1 - p0) * (i - i0)) / (i1 - i0);
  }
  const h = c.map((x) => x + 0.5); const l = c.map((x) => x - 0.5);
  return { c, h, l };
}
// 下跌到低點 100（索引 20）→ 上升到高點 200（索引 40）→ 回檔到 138（索引 60）
const UP = path([[0, 120], [20, 100], [40, 200], [60, 138]], 61);

test('斐波那契回撤：上升波段回檔比例 = (高 − 收盤) ÷ (高 − 低)，且轉折要等右邊 n 根收盤才確認', () => {
  const n = 3;
  const { up, down } = fibRatios(UP.h, UP.l, UP.c, n, 3);
  const H = 200.5; const L = 99.5;
  // 高點在索引 40，要到 43 才確認
  assert.ok(Number.isNaN(up[42]), '轉折尚未確認');
  assert.ok(Number.isNaN(up[43]) === false);
  near(up[43], (H - UP.c[43]) / (H - L));
  near(up[60], (H - 138) / (H - L));
  assert.ok(up[60] > 0.6 && up[60] < 0.63, `回檔 ${up[60]}`);
  assert.ok(Number.isNaN(down[60]), '最近轉折是高點時，下降波段的欄位為 NaN');
});

test('斐波那契回撤：下降波段反彈（鏡像）', () => {
  const m = path([[0, 180], [20, 200], [40, 100], [60, 162]], 61);
  const { up, down } = fibRatios(m.h, m.l, m.c, 3, 3);
  const H = 200.5; const L = 99.5;
  near(down[60], (162 - L) / (H - L));
  assert.ok(Number.isNaN(up[60]));
});

test('斐波那契回撤：無偷看（改動確認之後的資料，之前的值不變）；小波段（< minPct）不計', () => {
  const a = fibRatios(UP.h, UP.l, UP.c, 3, 3);
  const h2 = UP.h.slice(); const l2 = UP.l.slice(); const c2 = UP.c.slice();
  for (let i = 51; i < 61; i++) { h2[i] += 40; l2[i] += 40; c2[i] += 40; }
  const b = fibRatios(h2, l2, c2, 3, 3);
  for (let i = 0; i <= 50; i++) { assert.equal(Number.isNaN(a.up[i]), Number.isNaN(b.up[i])); if (!Number.isNaN(a.up[i])) assert.equal(a.up[i], b.up[i]); }
  const small = path([[0, 100], [20, 100.5], [40, 101.5], [60, 101]], 61);
  const s = fibRatios(small.h, small.l, small.c, 3, 3);
  assert.ok(Array.from(s.up).every(Number.isNaN) && Array.from(s.down).every(Number.isNaN));
});

test('斐波那契條件：回檔到 61.8% 附近成立、離開就不成立；多空互斥；說明文字與驗證', () => {
  const n = UP.c.length;
  const b = new IndicatorBundle({ t: Float64Array.from({ length: n }, (_, i) => i * 3600000), o: UP.c, h: UP.h, l: UP.l, c: UP.c, v: new Float64Array(n).fill(1) }, '1h');
  const spec = { id: 'fib_pullback', tf: '1h', params: { period: 3, level: 0.618, tol: 0.03, minPct: 3 } };
  const sig = evalSpecOnSeries(spec, b);
  assert.equal(sig[60], 1);
  assert.equal(sig[44], 0, '剛回檔一點點');
  const bounce = evalSpecOnSeries({ id: 'fib_bounce', tf: '1h', params: spec.params }, b);
  assert.equal(bounce[60], 0);
  assert.match(describeSpec(spec), /回檔到 61\.8%（±3%）/);
  assert.equal(validateSpec({ id: 'fib_pullback', tf: '1h' }), '');
  assert.match(validateSpec({ id: 'fib_pullback', tf: '1h', params: { level: 1.5 } }), /介於/);
  assert.equal(CONDITIONS.fib_pullback.side, 'bull'); assert.equal(CONDITIONS.fib_bounce.side, 'bear');
});

test('隨機漫步上，斐波那契回撤位沒有優勢（掃描不會把它當成發現）', async () => {
  const rng = makeRng(7);
  const gauss = () => Math.sqrt(-2 * Math.log(Math.max(1e-12, rng()))) * Math.cos(2 * Math.PI * rng());
  const bars = []; let c = 100;
  for (let i = 0; i < 6000; i++) { const o = c; c = o * Math.exp(0.006 * gauss()); bars.push([o, Math.max(o, c) * 1.001, Math.min(o, c) * 0.999, c]); }
  const { sig } = mkDs(bars);
  const r = await scanEdges(sig, { fee: 0.0005, slippage: 0.0005 }, { train: { from: 300, to: 4200 }, holdout: { from: 4200, to: 5990 } }, { horizons: [4, 12], ids: ['fib_pullback', 'fib_bounce'], minEvents: 20, byRegime: false });
  assert.ok(r.rows.length >= 6, `列數 ${r.rows.length}`);
  assert.equal(r.summary.nConfirmed, 0);
  assert.ok(r.rows.every((x) => x.params && x.params.level > 0));
});
