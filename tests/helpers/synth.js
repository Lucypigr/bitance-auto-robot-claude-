// 測試用：可重現的合成行情（不是真實行情！只用於單元測試與 Playwright 假伺服器）
import { makeRng } from '../../public/js/core/util.js';

const MS5 = 5 * 60 * 1000;
export const ANCHOR = Date.UTC(2023, 0, 1);

/** 以 5 分鐘為單位的隨機漫步路徑 */
export function makePath5m(seed, count, startPrice = 100, vol = 0.0025, drift = 0, volBase = 1000, regimeScale = 0.4) {
  const rng = makeRng(seed);
  const gauss = () => {
    let u = 0;
    let v = 0;
    while (u === 0) u = rng();
    while (v === 0) v = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  const t = new Float64Array(count);
  const o = new Float64Array(count);
  const h = new Float64Array(count);
  const l = new Float64Array(count);
  const c = new Float64Array(count);
  const v = new Float64Array(count);
  let p = startPrice;
  // 緩慢變動的波動度與趨勢，讓行情有「段落感」
  let regime = 0;
  const kappa = regimeScale === 0 ? 0 : 0.0004; // 輕微均值回歸，避免合成價格漂到 0 或爆衝
  const p0 = startPrice;
  for (let i = 0; i < count; i++) {
    if (i % 400 === 0) regime = gauss() * vol * regimeScale;
    const r = drift + regime + gauss() * vol - kappa * Math.log(p / p0);
    const op = p;
    const cl = Math.max(0.0001, p * (1 + r));
    const wick = Math.abs(gauss()) * vol * 0.6;
    const hi = Math.max(op, cl) * (1 + wick * rng());
    const lo = Math.min(op, cl) * (1 - wick * rng());
    t[i] = ANCHOR + i * MS5;
    o[i] = op; h[i] = hi; l[i] = lo; c[i] = cl;
    v[i] = volBase * (0.5 + rng()) * (1 + Math.abs(r) / vol);
    p = cl;
  }
  return { t, o, h, l, c, v };
}

/** 把 5 分鐘資料聚合成較大週期（factor 根合併一根） */
export function aggregate(src, factor, from = 0, to = src.t.length) {
  const start = Math.ceil(from / factor) * factor;
  const nBars = Math.floor((to - start) / factor);
  const out = {
    t: new Float64Array(nBars), o: new Float64Array(nBars), h: new Float64Array(nBars),
    l: new Float64Array(nBars), c: new Float64Array(nBars), v: new Float64Array(nBars),
  };
  for (let b = 0; b < nBars; b++) {
    const i0 = start + b * factor;
    out.t[b] = src.t[i0];
    out.o[b] = src.o[i0];
    out.c[b] = src.c[i0 + factor - 1];
    let hh = -Infinity; let ll = Infinity; let vv = 0;
    for (let j = i0; j < i0 + factor; j++) {
      if (src.h[j] > hh) hh = src.h[j];
      if (src.l[j] < ll) ll = src.l[j];
      vv += src.v[j];
    }
    out.h[b] = hh; out.l[b] = ll; out.v[b] = vv;
  }
  return out;
}

export const FACTOR = { '5m': 1, '15m': 3, '1h': 12, '4h': 48, '1d': 288 };
