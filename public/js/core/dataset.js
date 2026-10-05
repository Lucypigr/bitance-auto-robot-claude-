// 把原始 K 線整理成「對齊到執行週期時間軸」的資料集（純函式，可在 Node 測試）。
import { TF_MS, alignDown } from './util.js';

export const WARMUP_BARS = 300; // 每個週期額外往前抓的暖機根數（EMA200 等指標需要）

/**
 * @param {object} o
 * @param {'spot'|'perp'} o.market
 * @param {string} o.baseTf 執行週期
 * @param {number} o.windowStart 回測起點（ms）
 * @param {number} o.endTime 回測終點（ms，不含）。必須是已收盤時間
 * @param {Array} o.symbols [{symbol, klines:{tf:{t,o,h,l,c,v}}, mark?:{t,h,l}, funding?:{t,rate,mark}}]
 */
export function buildDataset({ market, baseTf, windowStart, endTime, symbols, warmupBars = WARMUP_BARS }) {
  const baseMs = TF_MS[baseTf];
  const end = alignDown(endTime, baseMs);
  const t0 = alignDown(windowStart - warmupBars * baseMs, baseMs);
  const n = Math.round((end - t0) / baseMs);
  if (n <= 0) throw new Error('時間範圍無效');
  const windowStartIdx = Math.max(0, Math.round((alignDown(windowStart, baseMs) - t0) / baseMs));
  const warnings = [];
  const out = [];

  for (const sd of symbols) {
    const raw = sd.klines[baseTf];
    const o = new Float64Array(n).fill(NaN);
    const h = new Float64Array(n).fill(NaN);
    const l = new Float64Array(n).fill(NaN);
    const c = new Float64Array(n).fill(NaN);
    const v = new Float64Array(n).fill(NaN);
    let first = -1;
    let last = -1;
    let real = 0;
    if (raw) {
      for (let k = 0; k < raw.t.length; k++) {
        const x = (raw.t[k] - t0) / baseMs;
        if (!Number.isInteger(x) || x < 0 || x >= n) continue;
        o[x] = raw.o[k]; h[x] = raw.h[k]; l[x] = raw.l[k]; c[x] = raw.c[k]; v[x] = raw.v[k];
        if (first < 0 || x < first) first = x;
        if (x > last) last = x;
        real++;
      }
    }
    if (first < 0) {
      warnings.push(`${sd.symbol}：沒有可用的 K 線資料，已略過`);
      continue;
    }
    // 補洞：沒成交的 K 線以前一根收盤價補成「平盤 K 線」，成交量 0
    let gaps = 0;
    for (let i = first + 1; i <= last; i++) {
      if (Number.isNaN(c[i])) {
        const pc = c[i - 1];
        o[i] = h[i] = l[i] = c[i] = pc;
        v[i] = 0;
        gaps++;
      }
    }
    const coverage = (last - Math.max(first, windowStartIdx) + 1) / Math.max(1, n - windowStartIdx);
    if (coverage < 0.8) warnings.push(`${sd.symbol}：在回測期間內只有約 ${(coverage * 100).toFixed(0)}% 的資料（上市較晚或已下架）`);
    if (gaps / Math.max(1, last - first + 1) > 0.01) warnings.push(`${sd.symbol}：有 ${gaps} 根 K 線缺資料（已補平盤）`);

    // 標記價格（只用於永續合約的清算判斷）
    let mh = null;
    let ml = null;
    if (market === 'perp' && sd.mark && sd.mark.t.length) {
      mh = new Float64Array(n).fill(NaN);
      ml = new Float64Array(n).fill(NaN);
      for (let k = 0; k < sd.mark.t.length; k++) {
        const x = (sd.mark.t[k] - t0) / baseMs;
        if (!Number.isInteger(x) || x < 0 || x >= n) continue;
        mh[x] = sd.mark.h[k];
        ml[x] = sd.mark.l[k];
      }
    }

    // 其他週期：只保留「收盤時間 <= 時間軸終點」的 K 線
    const tf = {};
    for (const [name, s] of Object.entries(sd.klines)) {
      if (name === baseTf) continue;
      const ms = TF_MS[name];
      let m = 0;
      while (m < s.t.length && s.t[m] + ms <= end) m++;
      tf[name] = {
        t: s.t.slice(0, m), o: s.o.slice(0, m), h: s.h.slice(0, m),
        l: s.l.slice(0, m), c: s.c.slice(0, m), v: s.v.slice(0, m),
      };
    }

    out.push({
      symbol: sd.symbol, first, last, gaps, realBars: real,
      o, h, l, c, v, mh, ml,
      funding: market === 'perp' && sd.funding ? sd.funding : null,
      tf,
    });
  }
  return { market, baseTf, baseMs, t0, n, windowStartIdx, symbols: out, warnings };
}

/** 訓練／驗證切割：以時間軸索引切成前 trainFrac / 後 (1-trainFrac) */
export function splitRanges(ds, trainFrac = 0.7) {
  const total = ds.n - ds.windowStartIdx;
  const splitIdx = ds.windowStartIdx + Math.floor(total * trainFrac);
  return {
    train: { from: ds.windowStartIdx, to: splitIdx },
    holdout: { from: splitIdx, to: ds.n },
    full: { from: ds.windowStartIdx, to: ds.n },
    splitIdx,
  };
}
