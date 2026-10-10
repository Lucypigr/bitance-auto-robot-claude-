// 條件目錄：每個條件在「自己的週期」上對已收盤 K 線計算 0/1 訊號，
// 再由 alignToBase() 對齊到執行週期（高週期訊號只在該根 K 線收盤後才可見）。
import * as I from './indicators.js';
import { PATTERNS } from './patterns.js';
import { TF_MS } from './util.js';

/** 指標快取：同一個週期序列的指標只算一次 */
export class IndicatorBundle {
  constructor(series, tf) {
    this.s = series; // {t,o,h,l,c,v}
    this.tf = tf;
    this.tfMs = TF_MS[tf];
    this.cache = new Map();
  }
  memo(key, fn) {
    let v = this.cache.get(key);
    if (v === undefined) {
      v = fn();
      this.cache.set(key, v);
    }
    return v;
  }
  rsi(n) { return this.memo(`rsi${n}`, () => I.rsi(this.s.c, n)); }
  ema(n) { return this.memo(`ema${n}`, () => I.ema(this.s.c, n)); }
  macd(f, s, g) { return this.memo(`macd${f},${s},${g}`, () => I.macd(this.s.c, f, s, g)); }
  bb(n, m) { return this.memo(`bb${n},${m}`, () => I.bollinger(this.s.c, n, m)); }
  adx(n) { return this.memo(`adx${n}`, () => I.adx(this.s.h, this.s.l, this.s.c, n)); }
  atrPct(n) { return this.memo(`atrp${n}`, () => I.atrPercent(this.s.h, this.s.l, this.s.c, n)); }
  stoch(n) { return this.memo(`stoch${n}`, () => I.stochastic(this.s.h, this.s.l, this.s.c, n, 3, 3)); }
  st(n, m) { return this.memo(`st${n},${m}`, () => I.supertrend(this.s.h, this.s.l, this.s.c, n, m)); }
  kc(n, a, m) { return this.memo(`kc${n},${a},${m}`, () => I.keltner(this.s.h, this.s.l, this.s.c, n, a, m)); }
  vwap() { return this.memo('vwap', () => I.vwap(this.s.t, this.s.h, this.s.l, this.s.c, this.s.v, this.tfMs)); }
  obv() { return this.memo('obv', () => I.obv(this.s.c, this.s.v)); }
  obvMa(n) { return this.memo(`obvma${n}`, () => I.ema(this.obv(), n)); }
  cci(n) { return this.memo(`cci${n}`, () => I.cci(this.s.h, this.s.l, this.s.c, n)); }
  mfi(n) { return this.memo(`mfi${n}`, () => I.mfi(this.s.h, this.s.l, this.s.c, this.s.v, n)); }
  don(n) { return this.memo(`don${n}`, () => I.donchian(this.s.h, this.s.l, n)); }
  er(n) { return this.memo(`er${n}`, () => I.efficiencyRatio(this.s.c, n)); }
  volAvg(n) { return this.memo(`vavg${n}`, () => I.prevAvg(this.s.v, n)); }
  pattern(name) { return this.memo(`pat${name}`, () => PATTERNS[name](this.s.o, this.s.h, this.s.l, this.s.c)); }
}

// ---- 比較小工具（遇到 NaN 一律視為不成立）----
function stateGE(a, x) { const n = a.length, o = new Uint8Array(n); for (let i = 0; i < n; i++) o[i] = a[i] >= x ? 1 : 0; return o; }
function stateLE(a, x) { const n = a.length, o = new Uint8Array(n); for (let i = 0; i < n; i++) o[i] = a[i] <= x ? 1 : 0; return o; }
function stateGT2(a, b) { const n = a.length, o = new Uint8Array(n); for (let i = 0; i < n; i++) o[i] = a[i] > b[i] ? 1 : 0; return o; }
function stateLT2(a, b) { const n = a.length, o = new Uint8Array(n); for (let i = 0; i < n; i++) o[i] = a[i] < b[i] ? 1 : 0; return o; }
function stateGT0(a) { const n = a.length, o = new Uint8Array(n); for (let i = 0; i < n; i++) o[i] = a[i] > 0 ? 1 : 0; return o; }
function stateLT0(a) { const n = a.length, o = new Uint8Array(n); for (let i = 0; i < n; i++) o[i] = a[i] < 0 ? 1 : 0; return o; }
function crossUp(a, b) {
  const n = a.length, o = new Uint8Array(n);
  for (let i = 1; i < n; i++) o[i] = a[i - 1] <= b[i - 1] && a[i] > b[i] ? 1 : 0;
  return o;
}
function crossDown(a, b) {
  const n = a.length, o = new Uint8Array(n);
  for (let i = 1; i < n; i++) o[i] = a[i - 1] >= b[i - 1] && a[i] < b[i] ? 1 : 0;
  return o;
}

// ---- 可調整參數的欄位定義：options＝下拉建議值；min/max/int/step＝手動輸入時的限制 ----
const fld = (key, label, options, { min = 1, max = 1000, int = true, step } = {}) => ({ key, label, options, min, max, int, step: step || (int ? 1 : 0.1) });
const PERIOD = (opts = [7, 14, 21], label = '週期') => fld('period', label, opts, { min: 2, max: 500 });
const LEVEL = (opts, label = '門檻', max = 100) => fld('level', label, opts, { min: 0, max, int: false, step: 1 });
const MULT = (opts, label = '倍數') => fld('mult', label, opts, { min: 0.1, max: 20, int: false });
const MACD_FIELDS = [fld('fast', '快線', [5, 8, 12], { min: 2, max: 200 }), fld('slow', '慢線', [17, 21, 26, 35], { min: 3, max: 400 }), fld('signal', '訊號線', [5, 9], { min: 2, max: 100 })];

/**
 * 條件目錄。
 *  side: 'bull'(偏多訊號) | 'bear'(偏空訊號) | 'neutral'
 *  kind: 'state'(狀態，條件持續成立期間為 1) | 'event'(事件，只在發生那根為 1)
 *  fields: 介面可調整的參數
 */
export const CONDITIONS = {
  // ---- RSI ----
  rsi_overbought: {
    group: 'RSI', label: 'RSI 超買', term: 'rsi_overbought', side: 'bear', kind: 'state', family: 'rsi',
    params: { period: 14, level: 70 },
    fields: [LEVEL([65, 70, 75, 80, 85]), PERIOD([7, 9, 14, 21])],
    text: (p) => `RSI(${p.period}) ≥ ${p.level}（超買）`,
    eval: (b, p) => stateGE(b.rsi(p.period), p.level),
  },
  rsi_oversold: {
    group: 'RSI', label: 'RSI 超賣', term: 'rsi_oversold', side: 'bull', kind: 'state', family: 'rsi',
    params: { period: 14, level: 30 },
    fields: [LEVEL([15, 20, 25, 30, 35]), PERIOD([7, 9, 14, 21])],
    text: (p) => `RSI(${p.period}) ≤ ${p.level}（超賣）`,
    eval: (b, p) => stateLE(b.rsi(p.period), p.level),
  },
  // ---- EMA ----
  ema_golden: {
    group: '均線 EMA', label: 'EMA 黃金交叉', term: 'ema_golden', side: 'bull', kind: 'event', family: 'ema',
    params: { fast: 50, slow: 200 },
    fields: [fld('fast', '快線', [9, 12, 20, 50], { min: 2, max: 400 }), fld('slow', '慢線', [21, 26, 50, 100, 200], { min: 3, max: 500 })],
    text: (p) => `EMA${p.fast} 向上穿越 EMA${p.slow}（黃金交叉）`,
    eval: (b, p) => crossUp(b.ema(p.fast), b.ema(p.slow)),
  },
  ema_death: {
    group: '均線 EMA', label: 'EMA 死亡交叉', term: 'ema_death', side: 'bear', kind: 'event', family: 'ema',
    params: { fast: 50, slow: 200 },
    fields: [fld('fast', '快線', [9, 12, 20, 50], { min: 2, max: 400 }), fld('slow', '慢線', [21, 26, 50, 100, 200], { min: 3, max: 500 })],
    text: (p) => `EMA${p.fast} 向下穿越 EMA${p.slow}（死亡交叉）`,
    eval: (b, p) => crossDown(b.ema(p.fast), b.ema(p.slow)),
  },
  price_above_ema: {
    group: '均線 EMA', label: '收盤價在 EMA 之上', term: 'ema', side: 'bull', kind: 'state', family: 'emaside',
    params: { period: 200 },
    fields: [PERIOD([20, 50, 100, 200], '均線週期')],
    text: (p) => `收盤價 > EMA${p.period}`,
    eval: (b, p) => stateGT2(b.s.c, b.ema(p.period)),
  },
  price_below_ema: {
    group: '均線 EMA', label: '收盤價在 EMA 之下', term: 'ema', side: 'bear', kind: 'state', family: 'emaside',
    params: { period: 200 },
    fields: [PERIOD([20, 50, 100, 200], '均線週期')],
    text: (p) => `收盤價 < EMA${p.period}`,
    eval: (b, p) => stateLT2(b.s.c, b.ema(p.period)),
  },
  // ---- MACD ----
  macd_golden: {
    group: 'MACD', label: 'MACD 黃金交叉', term: 'macd_golden', side: 'bull', kind: 'event', family: 'macd',
    params: { fast: 12, slow: 26, signal: 9 }, fields: MACD_FIELDS,
    text: (p) => `MACD(${p.fast},${p.slow},${p.signal}) 線向上穿越訊號線（黃金交叉）`,
    eval: (b, p) => { const m = b.macd(p.fast, p.slow, p.signal); return crossUp(m.line, m.signal); },
  },
  macd_death: {
    group: 'MACD', label: 'MACD 死亡交叉', term: 'macd_death', side: 'bear', kind: 'event', family: 'macd',
    params: { fast: 12, slow: 26, signal: 9 }, fields: MACD_FIELDS,
    text: (p) => `MACD(${p.fast},${p.slow},${p.signal}) 線向下穿越訊號線（死亡交叉）`,
    eval: (b, p) => { const m = b.macd(p.fast, p.slow, p.signal); return crossDown(m.line, m.signal); },
  },
  macd_hist_pos: {
    group: 'MACD', label: 'MACD 柱狀體為正', term: 'macd', side: 'bull', kind: 'state', family: 'macdhist',
    params: { fast: 12, slow: 26, signal: 9 }, fields: MACD_FIELDS,
    text: (p) => `MACD(${p.fast},${p.slow},${p.signal}) 柱狀體 > 0（多方動能）`,
    eval: (b, p) => stateGT0(b.macd(p.fast, p.slow, p.signal).hist),
  },
  macd_hist_neg: {
    group: 'MACD', label: 'MACD 柱狀體為負', term: 'macd', side: 'bear', kind: 'state', family: 'macdhist',
    params: { fast: 12, slow: 26, signal: 9 }, fields: MACD_FIELDS,
    text: (p) => `MACD(${p.fast},${p.slow},${p.signal}) 柱狀體 < 0（空方動能）`,
    eval: (b, p) => stateLT0(b.macd(p.fast, p.slow, p.signal).hist),
  },
  // ---- 布林通道 ----
  bb_above_upper: {
    group: '布林通道', label: '收盤價突破布林上軌', term: 'bollinger_upper', side: 'bear', kind: 'state', family: 'bb',
    params: { period: 20, mult: 2 }, fields: [PERIOD([10, 20, 30]), MULT([1.5, 2, 2.5, 3], '標準差倍數')],
    text: (p) => `收盤價 > 布林上軌(${p.period}, ${p.mult})`,
    eval: (b, p) => stateGT2(b.s.c, b.bb(p.period, p.mult).upper),
  },
  bb_below_lower: {
    group: '布林通道', label: '收盤價跌破布林下軌', term: 'bollinger_lower', side: 'bull', kind: 'state', family: 'bb',
    params: { period: 20, mult: 2 }, fields: [PERIOD([10, 20, 30]), MULT([1.5, 2, 2.5, 3], '標準差倍數')],
    text: (p) => `收盤價 < 布林下軌(${p.period}, ${p.mult})`,
    eval: (b, p) => stateLT2(b.s.c, b.bb(p.period, p.mult).lower),
  },
  // ---- ADX ----
  adx_strong: {
    group: 'ADX 趨勢強度', label: 'ADX 趨勢明確', term: 'adx', side: 'neutral', kind: 'state', family: 'adx',
    params: { period: 14, level: 25 },
    fields: [LEVEL([20, 25, 30, 40]), PERIOD([7, 14, 21])],
    text: (p) => `ADX(${p.period}) ≥ ${p.level}（趨勢明確）`,
    eval: (b, p) => stateGE(b.adx(p.period).adx, p.level),
  },
  adx_weak: {
    group: 'ADX 趨勢強度', label: 'ADX 盤整', term: 'adx', side: 'neutral', kind: 'state', family: 'adx',
    params: { period: 14, level: 20 },
    fields: [LEVEL([15, 20, 25]), PERIOD([7, 14, 21])],
    text: (p) => `ADX(${p.period}) ≤ ${p.level}（盤整）`,
    eval: (b, p) => stateLE(b.adx(p.period).adx, p.level),
  },
  di_bull: {
    group: 'ADX 趨勢強度', label: '+DI 高於 −DI', term: 'adx', side: 'bull', kind: 'state', family: 'di',
    params: { period: 14 }, fields: [PERIOD([7, 14, 21])],
    text: (p) => `+DI(${p.period}) > −DI（上漲力道較強）`,
    eval: (b, p) => { const a = b.adx(p.period); return stateGT2(a.plusDI, a.minusDI); },
  },
  di_bear: {
    group: 'ADX 趨勢強度', label: '−DI 高於 +DI', term: 'adx', side: 'bear', kind: 'state', family: 'di',
    params: { period: 14 }, fields: [PERIOD([7, 14, 21])],
    text: (p) => `−DI(${p.period}) > +DI（下跌力道較強）`,
    eval: (b, p) => { const a = b.adx(p.period); return stateGT2(a.minusDI, a.plusDI); },
  },
  // ---- ATR ----
  atr_high: {
    group: 'ATR 波動', label: '波動偏大', term: 'atr', side: 'neutral', kind: 'state', family: 'atr',
    params: { period: 14, pct: 2 },
    fields: [fld('pct', 'ATR 佔股價 %', [0.5, 1, 2, 3, 5], { min: 0.01, max: 100, int: false }), PERIOD([7, 14, 21], 'ATR 週期')],
    text: (p) => `ATR(${p.period}) ≥ 收盤價 ${p.pct}%（波動偏大）`,
    eval: (b, p) => stateGE(b.atrPct(p.period), p.pct),
  },
  atr_low: {
    group: 'ATR 波動', label: '波動偏小', term: 'atr', side: 'neutral', kind: 'state', family: 'atr',
    params: { period: 14, pct: 1 },
    fields: [fld('pct', 'ATR 佔股價 %', [0.3, 0.5, 1, 2], { min: 0.01, max: 100, int: false }), PERIOD([7, 14, 21], 'ATR 週期')],
    text: (p) => `ATR(${p.period}) ≤ 收盤價 ${p.pct}%（波動偏小）`,
    eval: (b, p) => stateLE(b.atrPct(p.period), p.pct),
  },
  // ---- KD ----
  kd_overbought: {
    group: 'KD 隨機指標', label: 'KD 超買', term: 'kd', side: 'bear', kind: 'state', family: 'kd',
    params: { period: 14, level: 80 },
    fields: [LEVEL([70, 80, 90], 'K 值門檻'), PERIOD([9, 14, 21], 'KD 週期')],
    text: (p) => `K 值(${p.period}) ≥ ${p.level}（KD 超買）`,
    eval: (b, p) => stateGE(b.stoch(p.period).k, p.level),
  },
  kd_oversold: {
    group: 'KD 隨機指標', label: 'KD 超賣', term: 'kd', side: 'bull', kind: 'state', family: 'kd',
    params: { period: 14, level: 20 },
    fields: [LEVEL([10, 20, 30], 'K 值門檻'), PERIOD([9, 14, 21], 'KD 週期')],
    text: (p) => `K 值(${p.period}) ≤ ${p.level}（KD 超賣）`,
    eval: (b, p) => stateLE(b.stoch(p.period).k, p.level),
  },
  kd_golden: {
    group: 'KD 隨機指標', label: 'KD 黃金交叉', term: 'kd', side: 'bull', kind: 'event', family: 'kdx',
    params: { period: 14 }, fields: [PERIOD([9, 14, 21], 'KD 週期')],
    text: (p) => `K 線向上穿越 D 線（KD(${p.period}) 黃金交叉）`,
    eval: (b, p) => { const s = b.stoch(p.period); return crossUp(s.k, s.d); },
  },
  kd_death: {
    group: 'KD 隨機指標', label: 'KD 死亡交叉', term: 'kd', side: 'bear', kind: 'event', family: 'kdx',
    params: { period: 14 }, fields: [PERIOD([9, 14, 21], 'KD 週期')],
    text: (p) => `K 線向下穿越 D 線（KD(${p.period}) 死亡交叉）`,
    eval: (b, p) => { const s = b.stoch(p.period); return crossDown(s.k, s.d); },
  },
  // ---- Supertrend ----
  supertrend_up: {
    group: 'Supertrend', label: 'Supertrend 多頭', term: 'supertrend', side: 'bull', kind: 'state', family: 'st',
    params: { period: 10, mult: 3 }, fields: [PERIOD([7, 10, 14], 'ATR 週期'), MULT([2, 2.5, 3, 4], 'ATR 倍數')],
    text: (p) => `Supertrend(${p.period}, ${p.mult}) 處於多頭趨勢`,
    eval: (b, p) => { const d = b.st(p.period, p.mult).dir; const o = new Uint8Array(d.length); for (let i = 0; i < d.length; i++) o[i] = d[i] === 1 ? 1 : 0; return o; },
  },
  supertrend_down: {
    group: 'Supertrend', label: 'Supertrend 空頭', term: 'supertrend', side: 'bear', kind: 'state', family: 'st',
    params: { period: 10, mult: 3 }, fields: [PERIOD([7, 10, 14], 'ATR 週期'), MULT([2, 2.5, 3, 4], 'ATR 倍數')],
    text: (p) => `Supertrend(${p.period}, ${p.mult}) 處於空頭趨勢`,
    eval: (b, p) => { const d = b.st(p.period, p.mult).dir; const o = new Uint8Array(d.length); for (let i = 0; i < d.length; i++) o[i] = d[i] === -1 ? 1 : 0; return o; },
  },
  supertrend_flip_up: {
    group: 'Supertrend', label: 'Supertrend 轉多', term: 'supertrend', side: 'bull', kind: 'event', family: 'stflip',
    params: { period: 10, mult: 3 }, fields: [PERIOD([7, 10, 14], 'ATR 週期'), MULT([2, 2.5, 3, 4], 'ATR 倍數')],
    text: (p) => `Supertrend(${p.period}, ${p.mult}) 由空翻多`,
    eval: (b, p) => { const d = b.st(p.period, p.mult).dir; const o = new Uint8Array(d.length); for (let i = 1; i < d.length; i++) o[i] = d[i - 1] === -1 && d[i] === 1 ? 1 : 0; return o; },
  },
  supertrend_flip_down: {
    group: 'Supertrend', label: 'Supertrend 轉空', term: 'supertrend', side: 'bear', kind: 'event', family: 'stflip',
    params: { period: 10, mult: 3 }, fields: [PERIOD([7, 10, 14], 'ATR 週期'), MULT([2, 2.5, 3, 4], 'ATR 倍數')],
    text: (p) => `Supertrend(${p.period}, ${p.mult}) 由多翻空`,
    eval: (b, p) => { const d = b.st(p.period, p.mult).dir; const o = new Uint8Array(d.length); for (let i = 1; i < d.length; i++) o[i] = d[i - 1] === 1 && d[i] === -1 ? 1 : 0; return o; },
  },
  // ---- Keltner ----
  keltner_above: {
    group: 'Keltner 通道', label: '收盤價突破 Keltner 上軌', term: 'keltner', side: 'bear', kind: 'state', family: 'kc',
    params: { period: 20, atr: 10, mult: 2 }, fields: [PERIOD([10, 20, 30], '均線週期'), fld('atr', 'ATR 週期', [10, 14], { min: 2, max: 200 }), MULT([1.5, 2, 2.5, 3], 'ATR 倍數')],
    text: (p) => `收盤價 > Keltner 上軌(${p.period}, ${p.atr}, ${p.mult})`,
    eval: (b, p) => stateGT2(b.s.c, b.kc(p.period, p.atr, p.mult).upper),
  },
  keltner_below: {
    group: 'Keltner 通道', label: '收盤價跌破 Keltner 下軌', term: 'keltner', side: 'bull', kind: 'state', family: 'kc',
    params: { period: 20, atr: 10, mult: 2 }, fields: [PERIOD([10, 20, 30], '均線週期'), fld('atr', 'ATR 週期', [10, 14], { min: 2, max: 200 }), MULT([1.5, 2, 2.5, 3], 'ATR 倍數')],
    text: (p) => `收盤價 < Keltner 下軌(${p.period}, ${p.atr}, ${p.mult})`,
    eval: (b, p) => stateLT2(b.s.c, b.kc(p.period, p.atr, p.mult).lower),
  },
  // ---- VWAP ----
  vwap_above: {
    group: 'VWAP', label: '收盤價在 VWAP 之上', term: 'vwap', side: 'bull', kind: 'state', family: 'vwap',
    params: {}, fields: [],
    text: () => '收盤價 > VWAP',
    eval: (b) => stateGT2(b.s.c, b.vwap()),
  },
  vwap_below: {
    group: 'VWAP', label: '收盤價在 VWAP 之下', term: 'vwap', side: 'bear', kind: 'state', family: 'vwap',
    params: {}, fields: [],
    text: () => '收盤價 < VWAP',
    eval: (b) => stateLT2(b.s.c, b.vwap()),
  },
  // ---- OBV ----
  obv_above: {
    group: 'OBV 能量潮', label: 'OBV 在均線之上', term: 'obv', side: 'bull', kind: 'state', family: 'obv',
    params: { period: 20 }, fields: [PERIOD([10, 20, 50], '均線週期')],
    text: (p) => `OBV > OBV 的 EMA${p.period}（量能偏多）`,
    eval: (b, p) => stateGT2(b.obv(), b.obvMa(p.period)),
  },
  obv_below: {
    group: 'OBV 能量潮', label: 'OBV 在均線之下', term: 'obv', side: 'bear', kind: 'state', family: 'obv',
    params: { period: 20 }, fields: [PERIOD([10, 20, 50], '均線週期')],
    text: (p) => `OBV < OBV 的 EMA${p.period}（量能偏空）`,
    eval: (b, p) => stateLT2(b.obv(), b.obvMa(p.period)),
  },
  // ---- CCI ----
  cci_overbought: {
    group: 'CCI', label: 'CCI 超買', term: 'cci', side: 'bear', kind: 'state', family: 'cci',
    params: { period: 20, level: 100 },
    fields: [LEVEL([100, 150, 200], '門檻', 1000), PERIOD([14, 20, 30])],
    text: (p) => `CCI(${p.period}) ≥ ${p.level}`,
    eval: (b, p) => stateGE(b.cci(p.period), p.level),
  },
  cci_oversold: {
    group: 'CCI', label: 'CCI 超賣', term: 'cci', side: 'bull', kind: 'state', family: 'cci',
    params: { period: 20, level: 100 },
    fields: [LEVEL([100, 150, 200], '門檻（負值）', 1000), PERIOD([14, 20, 30])],
    text: (p) => `CCI(${p.period}) ≤ −${p.level}`,
    eval: (b, p) => stateLE(b.cci(p.period), -p.level),
  },
  // ---- MFI ----
  mfi_overbought: {
    group: 'MFI 資金流量', label: 'MFI 超買', term: 'mfi', side: 'bear', kind: 'state', family: 'mfi',
    params: { period: 14, level: 80 },
    fields: [LEVEL([70, 80, 90]), PERIOD([10, 14, 21])],
    text: (p) => `MFI(${p.period}) ≥ ${p.level}`,
    eval: (b, p) => stateGE(b.mfi(p.period), p.level),
  },
  mfi_oversold: {
    group: 'MFI 資金流量', label: 'MFI 超賣', term: 'mfi', side: 'bull', kind: 'state', family: 'mfi',
    params: { period: 14, level: 20 },
    fields: [LEVEL([10, 20, 30]), PERIOD([10, 14, 21])],
    text: (p) => `MFI(${p.period}) ≤ ${p.level}`,
    eval: (b, p) => stateLE(b.mfi(p.period), p.level),
  },
  // ---- Donchian ----
  donchian_break_up: {
    group: '唐奇安通道', label: '突破 N 根新高', term: 'donchian', side: 'bull', kind: 'event', family: 'don',
    params: { period: 20 },
    fields: [PERIOD([10, 20, 55], 'N 根')],
    text: (p) => `收盤價突破前 ${p.period} 根最高價`,
    eval: (b, p) => {
      const u = b.don(p.period).upper, c = b.s.c, o = new Uint8Array(c.length);
      for (let i = 1; i < c.length; i++) o[i] = c[i] > u[i - 1] ? 1 : 0; // 與「前一根為止」的通道比較
      return o;
    },
  },
  donchian_break_down: {
    group: '唐奇安通道', label: '跌破 N 根新低', term: 'donchian', side: 'bear', kind: 'event', family: 'don',
    params: { period: 20 },
    fields: [PERIOD([10, 20, 55], 'N 根')],
    text: (p) => `收盤價跌破前 ${p.period} 根最低價`,
    eval: (b, p) => {
      const lw = b.don(p.period).lower, c = b.s.c, o = new Uint8Array(c.length);
      for (let i = 1; i < c.length; i++) o[i] = c[i] < lw[i - 1] ? 1 : 0;
      return o;
    },
  },
  // ---- 成交量 ----
  volume_spike: {
    group: '成交量', label: '爆量', term: 'volume', side: 'neutral', kind: 'state', family: 'vol',
    params: { period: 20, mult: 2 },
    fields: [MULT([1.5, 2, 3, 5]), PERIOD([10, 20, 50], '平均根數')],
    text: (p) => `成交量 ≥ 前 ${p.period} 根平均的 ${p.mult} 倍（爆量）`,
    eval: (b, p) => {
      const v = b.s.v, a = b.volAvg(p.period), o = new Uint8Array(v.length);
      for (let i = 0; i < v.length; i++) o[i] = v[i] >= p.mult * a[i] ? 1 : 0;
      return o;
    },
  },
};

// ---- 行情狀態：單邊／震盪（效率比率 ER）----
// 預設門檻依幣安 BTC／ETH／SOL 的 1h／4h／1d 實際分布挑選：ER(20) 的中位數約 0.2、75 百分位約 0.35、25 百分位約 0.1。
const ER_FIELDS = [PERIOD([10, 20, 40], 'ER 週期'), fld('level', 'ER 門檻', [0.1, 0.15, 0.2, 0.3, 0.35, 0.4, 0.5], { min: 0.01, max: 0.99, int: false, step: 0.01 })];
CONDITIONS.regime_trend = {
  group: '行情狀態（單邊／震盪）', label: '單邊行情（不分漲跌）', term: 'regime', side: 'neutral', kind: 'state', family: 'regime',
  params: { period: 20, level: 0.35 }, fields: ER_FIELDS,
  text: (p) => `效率比率 ER(${p.period}) ≥ ${p.level}（單邊行情）`,
  eval: (b, p) => stateGE(b.er(p.period), p.level),
};
CONDITIONS.regime_up = {
  group: '行情狀態（單邊／震盪）', label: '單邊上漲', term: 'regime', side: 'bull', kind: 'state', family: 'regime',
  params: { period: 20, level: 0.35 }, fields: ER_FIELDS,
  text: (p) => `ER(${p.period}) ≥ ${p.level} 且 ${p.period} 根來收盤價上升（單邊上漲）`,
  eval: (b, p) => { const e = b.er(p.period), c = b.s.c, o = new Uint8Array(c.length); for (let i = p.period; i < c.length; i++) o[i] = e[i] >= p.level && c[i] > c[i - p.period] ? 1 : 0; return o; },
};
CONDITIONS.regime_down = {
  group: '行情狀態（單邊／震盪）', label: '單邊下跌', term: 'regime', side: 'bear', kind: 'state', family: 'regime',
  params: { period: 20, level: 0.35 }, fields: ER_FIELDS,
  text: (p) => `ER(${p.period}) ≥ ${p.level} 且 ${p.period} 根來收盤價下降（單邊下跌）`,
  eval: (b, p) => { const e = b.er(p.period), c = b.s.c, o = new Uint8Array(c.length); for (let i = p.period; i < c.length; i++) o[i] = e[i] >= p.level && c[i] < c[i - p.period] ? 1 : 0; return o; },
};
CONDITIONS.regime_range = {
  group: '行情狀態（單邊／震盪）', label: '震盪行情', term: 'regime', side: 'neutral', kind: 'state', family: 'regime',
  params: { period: 20, level: 0.12 }, fields: ER_FIELDS,
  text: (p) => `效率比率 ER(${p.period}) ≤ ${p.level}（來回震盪）`,
  eval: (b, p) => stateLE(b.er(p.period), p.level),
};

// ---- K 線型態 ----
const PATTERN_DEFS = [
  ['hammer', '槌頭', 'bull'],
  ['inverted_hammer', '倒槌頭', 'bull'],
  ['hanging_man', '上吊線', 'bear'],
  ['shooting_star', '流星線', 'bear'],
  ['bullish_engulfing', '看漲吞噬', 'bull'],
  ['bearish_engulfing', '看跌吞噬', 'bear'],
  ['doji', '十字星', 'neutral'],
  ['morning_star', '晨星', 'bull'],
  ['evening_star', '暮星', 'bear'],
];
for (const [id, label, side] of PATTERN_DEFS) {
  CONDITIONS[`pat_${id}`] = {
    group: 'K 線型態', label, term: `pat_${id}`, side, kind: 'event', family: 'pattern',
    params: {}, fields: [],
    text: () => `出現「${label}」`,
    eval: (b) => b.pattern(id),
    pattern: id,
  };
}

/**
 * 「同時搜尋指標參數」模式下，各指標家族要試的參數組合。
 * 同一家族（例如 RSI）在同一個週期只會挑其中一組，不會同時出現 RSI(7) 與 RSI(14)。
 * 每個家族只放少數幾組常用值：參數越多，「剛好貼合過去」的機會越大。
 */
export const PARAM_GRID = {
  rsi: [{ period: 7 }, { period: 14 }, { period: 21 }],
  ema: [{ fast: 9, slow: 21 }, { fast: 20, slow: 50 }, { fast: 50, slow: 200 }],
  emaside: [{ period: 20 }, { period: 50 }, { period: 200 }],
  macd: [{ fast: 12, slow: 26, signal: 9 }, { fast: 8, slow: 17, signal: 9 }, { fast: 5, slow: 35, signal: 5 }],
  macdhist: [{ fast: 12, slow: 26, signal: 9 }, { fast: 8, slow: 17, signal: 9 }, { fast: 5, slow: 35, signal: 5 }],
  bb: [{ period: 20, mult: 2 }, { period: 20, mult: 2.5 }, { period: 10, mult: 2 }, { period: 30, mult: 2 }],
  adx: [{ period: 7 }, { period: 14 }, { period: 21 }],
  di: [{ period: 7 }, { period: 14 }, { period: 21 }],
  atr: [{ period: 7 }, { period: 14 }, { period: 21 }],
  kd: [{ period: 9 }, { period: 14 }, { period: 21 }],
  kdx: [{ period: 9 }, { period: 14 }, { period: 21 }],
  st: [{ period: 7, mult: 3 }, { period: 10, mult: 3 }, { period: 14, mult: 2 }],
  stflip: [{ period: 7, mult: 3 }, { period: 10, mult: 3 }, { period: 14, mult: 2 }],
  kc: [{ period: 20, atr: 10, mult: 1.5 }, { period: 20, atr: 10, mult: 2 }, { period: 20, atr: 10, mult: 2.5 }],
  obv: [{ period: 10 }, { period: 20 }, { period: 50 }],
  cci: [{ period: 14 }, { period: 20 }, { period: 30 }],
  mfi: [{ period: 10 }, { period: 14 }, { period: 21 }],
  don: [{ period: 10 }, { period: 20 }, { period: 55 }],
  vol: [{ period: 20, mult: 1.5 }, { period: 20, mult: 2 }, { period: 20, mult: 3 }],
};

export function conditionIds() {
  return Object.keys(CONDITIONS);
}

/** 依群組整理（給介面下拉選單用） */
export function conditionGroups() {
  const groups = new Map();
  for (const [id, def] of Object.entries(CONDITIONS)) {
    if (!groups.has(def.group)) groups.set(def.group, []);
    groups.get(def.group).push({ id, label: def.label });
  }
  return [...groups.entries()].map(([group, items]) => ({ group, items }));
}

/** 參數整理：轉成數字、超出範圍者拉回範圍（週期類取整數）；缺少或不是數字就用預設值 */
function cleanParams(def, given) {
  const out = { ...def.params, ...(given || {}) };
  for (const f of def.fields) {
    let v = Number(out[f.key]);
    if (!Number.isFinite(v)) v = def.params[f.key];
    if (f.int) v = Math.round(v);
    out[f.key] = Math.min(f.max, Math.max(f.min, v));
  }
  return out;
}

/** 參數是否合理（回傳錯誤訊息；沒問題回傳空字串）。例如快線必須比慢線短。 */
export function validateSpec(spec) {
  const def = CONDITIONS[spec.id];
  if (!def) return `未知的條件：${spec.id}`;
  const raw = { ...def.params, ...(spec.params || {}) };
  for (const f of def.fields) {
    const v = Number(raw[f.key]);
    if (!Number.isFinite(v)) return `「${def.label}」的${f.label}必須是數字`;
    if (v < f.min || v > f.max) return `「${def.label}」的${f.label}必須介於 ${f.min} ～ ${f.max}`;
  }
  const p = cleanParams(def, spec.params);
  if (('fast' in p) && ('slow' in p) && !(p.fast < p.slow)) return `「${def.label}」的快線（${p.fast}）必須小於慢線（${p.slow}）`;
  return '';
}

export function normalizeSpec(spec) {
  const def = CONDITIONS[spec.id];
  if (!def) throw new Error(`未知的條件：${spec.id}`);
  return {
    id: spec.id,
    tf: spec.tf,
    params: cleanParams(def, spec.params),
    within: Math.max(1, Math.floor(spec.within || 1)),
    neg: !!spec.neg, // NOT：條件「不成立」時才算
    grp: spec.grp || '', // 相同群組代號的條件之間是 OR；不同群組之間是 AND；空字串＝自己獨立一組
  };
}

export function specKey(spec) {
  const s = normalizeSpec(spec);
  const p = Object.keys(s.params).sort().map((k) => `${k}=${s.params[k]}`).join(',');
  return `${s.neg ? '!' : ''}${s.tf}|${s.id}|${p}|w${s.within}`;
}

export function describeSpec(spec) {
  const s = normalizeSpec(spec);
  const def = CONDITIONS[s.id];
  const win = s.within > 1 ? `（${s.within} 根內曾出現）` : '';
  const base = `${s.tf} ${def.text(s.params)}${win}`;
  return s.neg ? `非（${base}）` : base;
}

/** 把進場條件分組：同群組 → OR；群組之間 → AND。未指定群組的條件各自獨立成一組（＝純 AND，與舊版相同） */
export function entryGroups(specs) {
  const groups = [];
  const byId = new Map();
  for (const raw of specs) {
    const s = normalizeSpec(raw);
    if (s.grp) {
      if (!byId.has(s.grp)) { byId.set(s.grp, []); groups.push(byId.get(s.grp)); }
      byId.get(s.grp).push(s);
    } else groups.push([s]);
  }
  return groups;
}

/** 「(A 或 B) 且 C 且 非（D）」 */
export function describeEntry(specs) {
  return entryGroups(specs).map((g) => (g.length > 1 ? `(${g.map(describeSpec).join(' 或 ')})` : describeSpec(g[0]))).join(' 且 ');
}

/** 「最近 within 根（含當根）內曾成立」—— 只回看過去，沒有偷看未來 */
export function applyWithin(sig, within) {
  if (within <= 1) return sig;
  const n = sig.length;
  const out = new Uint8Array(n);
  let last = -Infinity;
  for (let i = 0; i < n; i++) {
    if (sig[i]) last = i;
    out[i] = i - last < within ? 1 : 0;
  }
  return out;
}

/** 在條件自己的週期上計算 0/1 訊號（第 i 根收盤後才知道） */
export function evalSpecOnSeries(spec, bundle) {
  const s = normalizeSpec(spec);
  const raw = CONDITIONS[s.id].eval(bundle, s.params);
  return applyWithin(raw, s.within);
}

/**
 * 把某週期的訊號對齊到執行週期（base）。
 * 規則：第 j 根 tf K 線在 t_j + tfMs 收盤；base 第 i 根在 t0 + (i+1)*baseMs 收盤。
 * base 第 i 根「收盤後」可見的訊號 = 收盤時間 <= base 第 i 根收盤時間 的最後一根 tf K 線。
 * 因此高週期訊號一定要等該根 K 線真正收盤後才會出現，不會偷看未完成的 K 線。
 */
export function alignToBase(tfT, tfMs, sig, baseT0, baseMs, n) {
  const out = new Uint8Array(n);
  let j = -1;
  const m = tfT.length;
  for (let i = 0; i < n; i++) {
    const closeBase = baseT0 + (i + 1) * baseMs;
    while (j + 1 < m && tfT[j + 1] + tfMs <= closeBase) j++;
    out[i] = j >= 0 ? sig[j] : 0;
  }
  return out;
}

export function indicesOf(sig, offset = 0) {
  let cnt = 0;
  for (let i = 0; i < sig.length; i++) if (sig[i]) cnt++;
  const out = new Int32Array(cnt);
  let k = 0;
  for (let i = 0; i < sig.length; i++) if (sig[i]) out[k++] = i + offset;
  return out;
}

