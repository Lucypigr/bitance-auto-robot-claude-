import test from 'node:test';
import assert from 'node:assert/strict';
import * as I from '../../public/js/core/indicators.js';
import { PATTERNS } from '../../public/js/core/patterns.js';
import { CONDITIONS, IndicatorBundle, evalSpecOnSeries } from '../../public/js/core/conditions.js';
import { makePath5m } from '../helpers/synth.js';

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} !≈ ${b}`);
const F = (a) => Float64Array.from(a);

test('SMA / EMA 基本數值', () => {
  const s = I.sma(F([1, 2, 3, 4, 5]), 3);
  assert.ok(Number.isNaN(s[0]) && Number.isNaN(s[1]));
  assert.deepEqual([...s.slice(2)], [2, 3, 4]);
  const e = I.ema(F([1, 2, 3, 4, 5, 6]), 3); // 以 SMA(1,2,3)=2 為種子, k=0.5
  assert.deepEqual([...e.slice(2)], [2, 3, 4, 5]);
});

test('RSI 與 StockCharts 教學資料一致 (Wilder 14)', () => {
  const close = F([44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28, 46.00, 46.03, 46.41, 46.22, 45.64, 46.21, 46.25, 45.71, 46.45, 45.78, 45.35, 44.03, 44.18, 44.22, 44.57, 43.42, 42.66, 43.13]);
  const r = I.rsi(close, 14);
  const expected = { 14: 70.53, 15: 66.32, 16: 66.55, 17: 69.41, 18: 66.36, 19: 57.97, 20: 62.93, 26: 39.99, 31: 33.08, 32: 37.77 };
  for (const [i, v] of Object.entries(expected)) assert.ok(Math.abs(r[i] - v) < 0.1, `RSI[${i}]=${r[i]} 應約為 ${v}`);
  assert.ok(Number.isNaN(r[13]));
});

test('布林通道：中軌=SMA、寬度=2 個母體標準差', () => {
  const c = F([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  const b = I.bollinger(c, 5, 2);
  near(b.mid[4], 3);
  near(b.upper[4], 3 + 2 * Math.sqrt(2));
  near(b.lower[4], 3 - 2 * Math.sqrt(2));
});

test('ATR / True Range', () => {
  const h = F([10, 12, 11]); const l = F([8, 9, 9]); const c = F([9, 11, 10]);
  const tr = I.trueRange(h, l, c);
  assert.deepEqual([...tr], [2, 3, 2]);
  near(I.atr(h, l, c, 3)[2], 7 / 3);
});

test('MACD：柱狀體 = MACD 線 − 訊號線', () => {
  const p = makePath5m(1, 400);
  const m = I.macd(p.c);
  for (let i = 0; i < 400; i++) if (!Number.isNaN(m.hist[i])) near(m.hist[i], m.line[i] - m.signal[i]);
});

test('KD、ADX、CCI、MFI 值域合理', () => {
  const p = makePath5m(2, 600);
  const k = I.stochastic(p.h, p.l, p.c);
  const a = I.adx(p.h, p.l, p.c);
  const m = I.mfi(p.h, p.l, p.c, p.v);
  for (let i = 0; i < 600; i++) {
    if (!Number.isNaN(k.k[i])) assert.ok(k.k[i] >= 0 && k.k[i] <= 100);
    if (!Number.isNaN(a.adx[i])) assert.ok(a.adx[i] >= 0 && a.adx[i] <= 100);
    if (!Number.isNaN(m[i])) assert.ok(m[i] >= 0 && m[i] <= 100);
  }
  assert.ok(!Number.isNaN(a.adx[599]) && !Number.isNaN(k.d[599]));
});

test('Supertrend：上升趨勢為 +1，下降趨勢為 -1', () => {
  const up = F(Array.from({ length: 80 }, (_, i) => 100 + i));
  const st = I.supertrend(up.map((x) => x + 1), up.map((x) => x - 1), up, 10, 3);
  assert.equal(st.dir[79], 1);
  const dn = F(Array.from({ length: 80 }, (_, i) => 200 - i));
  const st2 = I.supertrend(dn.map((x) => x + 1), dn.map((x) => x - 1), dn, 10, 3);
  assert.equal(st2.dir[79], -1);
});

test('OBV / VWAP', () => {
  const o = I.obv(F([1, 2, 1, 1]), F([10, 20, 30, 40]));
  assert.deepEqual([...o], [0, 20, -10, -10]);
  // 同一個 UTC 日內 VWAP = 累計(典型價*量)/累計量
  const t = F([0, 3600000, 7200000]);
  const v = I.vwap(t, F([10, 10, 10]), F([10, 10, 10]), F([10, 20, 30]), F([1, 1, 2]), 3600000);
  near(v[0], (10 + 10 + 10) / 3);
  near(v[1], (10 + 40 / 3) / 2);
  near(v[2], (10 + 40 / 3 + (50 / 3) * 2) / 4);
});

// ---------- 最重要：沒有偷看未來 ----------
test('所有指標：用前綴資料算出的值 = 用完整資料算出的值（無 Lookahead）', () => {
  const p = makePath5m(7, 700);
  const cut = 450;
  const pre = (a) => a.slice(0, cut);
  const eq = (name, full, part) => {
    for (let i = 0; i < cut; i++) {
      const a = full[i]; const b = part[i];
      if (Number.isNaN(a) && Number.isNaN(b)) continue;
      assert.ok(Math.abs(a - b) < 1e-9, `${name}[${i}] 有偷看未來：${a} vs ${b}`);
    }
  };
  eq('rsi', I.rsi(p.c, 14), I.rsi(pre(p.c), 14));
  eq('ema', I.ema(p.c, 50), I.ema(pre(p.c), 50));
  const m1 = I.macd(p.c); const m2 = I.macd(pre(p.c));
  eq('macd', m1.line, m2.line); eq('macds', m1.signal, m2.signal);
  const b1 = I.bollinger(p.c); const b2 = I.bollinger(pre(p.c));
  eq('bbu', b1.upper, b2.upper);
  const a1 = I.adx(p.h, p.l, p.c); const a2 = I.adx(pre(p.h), pre(p.l), pre(p.c));
  eq('adx', a1.adx, a2.adx);
  eq('atr', I.atr(p.h, p.l, p.c), I.atr(pre(p.h), pre(p.l), pre(p.c)));
  const k1 = I.stochastic(p.h, p.l, p.c); const k2 = I.stochastic(pre(p.h), pre(p.l), pre(p.c));
  eq('k', k1.k, k2.k); eq('d', k1.d, k2.d);
  const s1 = I.supertrend(p.h, p.l, p.c); const s2 = I.supertrend(pre(p.h), pre(p.l), pre(p.c));
  eq('st', s1.line, s2.line);
  const kc1 = I.keltner(p.h, p.l, p.c); const kc2 = I.keltner(pre(p.h), pre(p.l), pre(p.c));
  eq('kc', kc1.upper, kc2.upper);
  eq('vwap', I.vwap(p.t, p.h, p.l, p.c, p.v, 300000), I.vwap(pre(p.t), pre(p.h), pre(p.l), pre(p.c), pre(p.v), 300000));
  eq('obv', I.obv(p.c, p.v), I.obv(pre(p.c), pre(p.v)));
  eq('cci', I.cci(p.h, p.l, p.c), I.cci(pre(p.h), pre(p.l), pre(p.c)));
  eq('mfi', I.mfi(p.h, p.l, p.c, p.v), I.mfi(pre(p.h), pre(p.l), pre(p.c), pre(p.v)));
  const d1 = I.donchian(p.h, p.l); const d2 = I.donchian(pre(p.h), pre(p.l));
  eq('don', d1.upper, d2.upper);
});

test('所有條件與 K 線型態：訊號在第 i 根只取決於 0..i 根', () => {
  const p = makePath5m(11, 900, 100, 0.004);
  const cut = 600;
  const mk = (n) => {
    const s = (a) => a.slice(0, n);
    return new IndicatorBundle({ t: s(p.t), o: s(p.o), h: s(p.h), l: s(p.l), c: s(p.c), v: s(p.v) }, '5m');
  };
  const full = mk(900); const part = mk(cut);
  let nonEmpty = 0;
  for (const id of Object.keys(CONDITIONS)) {
    for (const within of [1, 3]) {
      const a = evalSpecOnSeries({ id, tf: '5m', within }, full);
      const b = evalSpecOnSeries({ id, tf: '5m', within }, part);
      for (let i = 0; i < cut; i++) assert.equal(a[i], b[i], `${id} within=${within} 在 ${i} 有偷看未來`);
      if (a.some((x) => x)) nonEmpty++;
    }
  }
  assert.ok(nonEmpty > 20, '多數條件在隨機資料上應該會觸發');
  void PATTERNS;
});
