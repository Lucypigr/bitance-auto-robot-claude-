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
  if (!(trainFrac >= 0.2 && trainFrac <= 0.9)) throw new Error('訓練比例必須介於 20% ~ 90%');
  const total = ds.n - ds.windowStartIdx;
  const splitIdx = ds.windowStartIdx + Math.floor(total * trainFrac);
  return {
    train: { from: ds.windowStartIdx, to: splitIdx },
    holdout: { from: splitIdx, to: ds.n },
    full: { from: ds.windowStartIdx, to: ds.n },
    splitIdx,
  };
}

// ---------------------------------------------------------------------------
// 台股（日線）
// ---------------------------------------------------------------------------

/**
 * 還原股價：依「除權息／分割／減資」事件，把事件日「之前」的價格乘上調整係數，
 * 讓價格在事件前後連續（否則除息或分割當天會被誤判成暴跌）。
 * actions: [{ date:'YYYY-MM-DD', factor }]，factor = 事件後參考價 ÷ 事件前收盤價（0~1.5 之間才採用）。
 * splitLike=true 的事件（分割、面額變更、減資）同時調整成交量。
 */
export function adjustPrices(bars, actions) {
  const out = { t: bars.t.slice(), o: bars.o.slice(), h: bars.h.slice(), l: bars.l.slice(), c: bars.c.slice(), v: bars.v.slice() };
  const applied = [];
  for (const a of actions) {
    const D = Date.parse(`${a.date}T00:00:00Z`);
    if (!(a.factor > 0.05 && a.factor < 1.5) || Number.isNaN(D)) continue;
    let touched = false;
    for (let i = 0; i < out.t.length && out.t[i] < D; i++) {
      out.o[i] *= a.factor; out.h[i] *= a.factor; out.l[i] *= a.factor; out.c[i] *= a.factor;
      if (a.splitLike) out.v[i] /= a.factor;
      touched = true;
    }
    if (touched) applied.push(a);
  }
  return { bars: out, applied };
}

/** 找出還原後仍然超出漲跌幅限制(±10%)太多的單日跳動（可能是沒被資料涵蓋的公司行動） */
export function findSuspiciousJumps(bars, limit = 0.13) {
  const res = [];
  for (let i = 1; i < bars.t.length; i++) {
    const r = bars.c[i] / bars.c[i - 1] - 1;
    if (Math.abs(r) > limit) res.push({ t: bars.t[i], ret: r });
  }
  return res;
}

/**
 * 台股資料集：時間軸是「交易日曆」（所有選到的股票出現過的交易日的聯集），不是連續的日曆日。
 * 某檔股票在某個交易日沒有資料（停牌）→ 以前一日收盤補平盤、成交量 0。
 * @param {object} o
 * @param {number} o.windowStart 回測起點（ms，UTC 日期）
 * @param {Array} o.symbols [{symbol, name, isEtf, bars:{t,o,h,l,c,v}(已還原), jumps?}]
 */
export function buildTwDataset({ windowStart, symbols }) {
  const warnings = [];
  const set = new Set();
  for (const sd of symbols) for (let i = 0; i < sd.bars.t.length; i++) set.add(sd.bars.t[i]);
  const times = Float64Array.from([...set].sort((a, b) => a - b));
  const n = times.length;
  if (n === 0) throw new Error('沒有任何交易日資料');
  const idxOf = new Map();
  for (let i = 0; i < n; i++) idxOf.set(times[i], i);
  let windowStartIdx = 0;
  while (windowStartIdx < n && times[windowStartIdx] < windowStart) windowStartIdx++;
  if (windowStartIdx >= n - 5) throw new Error('回測期間內的交易日太少');

  const out = [];
  for (const sd of symbols) {
    const o = new Float64Array(n).fill(NaN);
    const h = new Float64Array(n).fill(NaN);
    const l = new Float64Array(n).fill(NaN);
    const c = new Float64Array(n).fill(NaN);
    const v = new Float64Array(n).fill(NaN);
    let first = -1;
    let last = -1;
    for (let k = 0; k < sd.bars.t.length; k++) {
      const i = idxOf.get(sd.bars.t[k]);
      o[i] = sd.bars.o[k]; h[i] = sd.bars.h[k]; l[i] = sd.bars.l[k]; c[i] = sd.bars.c[k]; v[i] = sd.bars.v[k];
      if (first < 0 || i < first) first = i;
      if (i > last) last = i;
    }
    if (first < 0) { warnings.push(`${sd.symbol} ${sd.name || ''}：沒有可用的價格資料，已略過`); continue; }
    let gaps = 0;
    for (let i = first + 1; i <= last; i++) {
      if (Number.isNaN(c[i])) { o[i] = h[i] = l[i] = c[i] = c[i - 1]; v[i] = 0; gaps++; }
    }
    const coverage = (last - Math.max(first, windowStartIdx) + 1) / Math.max(1, n - windowStartIdx);
    if (coverage < 0.8) warnings.push(`${sd.symbol} ${sd.name || ''}：在回測期間內只有約 ${(coverage * 100).toFixed(0)}% 的交易日有資料（上市較晚或已下市）`);
    if (gaps > 3) warnings.push(`${sd.symbol} ${sd.name || ''}：有 ${gaps} 個交易日沒有成交（停牌？），已補平盤`);
    if (sd.jumps && sd.jumps.length) {
      warnings.push(`${sd.symbol} ${sd.name || ''}：還原後仍有單日跳動超過 13%（${sd.jumps.slice(0, 3).map((j) => new Date(j.t).toISOString().slice(0, 10)).join('、')}），可能是未涵蓋的公司行動，結果請小心解讀`);
    }
    out.push({ symbol: sd.symbol, name: sd.name || '', isEtf: !!sd.isEtf, first, last, gaps, realBars: sd.bars.t.length, o, h, l, c, v, mh: null, ml: null, funding: null, tf: {} });
  }
  return {
    market: 'tw', baseTf: '1d', baseMs: 86400000, t0: times[0], times, n, windowStartIdx,
    annual: 252, symbols: out, warnings,
  };
}
