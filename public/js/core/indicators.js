// 技術指標：全部「因果」(causal) 計算 —— 第 i 根的值只使用 0..i 根的資料，絕不偷看未來。
// 資料不足時回傳 NaN。輸入／輸出皆為 Float64Array。

const NaNArray = (n) => new Float64Array(n).fill(NaN);

function firstValid(src) {
  for (let i = 0; i < src.length; i++) if (!Number.isNaN(src[i])) return i;
  return -1;
}

export function sma(src, n) {
  const out = NaNArray(src.length);
  const s = firstValid(src);
  if (s < 0) return out;
  let sum = 0;
  for (let i = s; i < src.length; i++) {
    sum += src[i];
    if (i - s >= n) sum -= src[i - n];
    if (i - s >= n - 1) out[i] = sum / n;
  }
  return out;
}

export function ema(src, n) {
  const out = NaNArray(src.length);
  const s = firstValid(src);
  if (s < 0 || src.length - s < n) return out;
  const k = 2 / (n + 1);
  let sum = 0;
  for (let i = s; i < s + n; i++) sum += src[i];
  let prev = sum / n;
  out[s + n - 1] = prev;
  for (let i = s + n; i < src.length; i++) {
    prev = src[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** Wilder 平滑（RMA），alpha = 1/n */
export function rma(src, n) {
  const out = NaNArray(src.length);
  const s = firstValid(src);
  if (s < 0 || src.length - s < n) return out;
  let sum = 0;
  for (let i = s; i < s + n; i++) sum += src[i];
  let prev = sum / n;
  out[s + n - 1] = prev;
  for (let i = s + n; i < src.length; i++) {
    prev = (prev * (n - 1) + src[i]) / n;
    out[i] = prev;
  }
  return out;
}

export function rsi(close, n = 14) {
  const len = close.length;
  const out = NaNArray(len);
  if (len <= n) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= n; i++) {
    const d = close[i] - close[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  let avgG = gain / n;
  let avgL = loss / n;
  out[n] = rsiVal(avgG, avgL);
  for (let i = n + 1; i < len; i++) {
    const d = close[i] - close[i - 1];
    const g = d > 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    avgG = (avgG * (n - 1) + g) / n;
    avgL = (avgL * (n - 1) + l) / n;
    out[i] = rsiVal(avgG, avgL);
  }
  return out;
}
function rsiVal(g, l) {
  if (l === 0) return g === 0 ? 50 : 100;
  return 100 - 100 / (1 + g / l);
}

export function macd(close, fast = 12, slow = 26, signalN = 9) {
  const ef = ema(close, fast);
  const es = ema(close, slow);
  const line = NaNArray(close.length);
  for (let i = 0; i < close.length; i++) line[i] = ef[i] - es[i];
  const signal = ema(line, signalN);
  const hist = NaNArray(close.length);
  for (let i = 0; i < close.length; i++) hist[i] = line[i] - signal[i];
  return { line, signal, hist };
}

export function bollinger(close, n = 20, mult = 2) {
  const len = close.length;
  const mid = NaNArray(len);
  const upper = NaNArray(len);
  const lower = NaNArray(len);
  const s = firstValid(close);
  if (s < 0) return { mid, upper, lower };
  for (let i = s + n - 1; i < len; i++) {
    let sum = 0;
    for (let j = i - n + 1; j <= i; j++) sum += close[j];
    const m = sum / n;
    let v = 0;
    for (let j = i - n + 1; j <= i; j++) v += (close[j] - m) * (close[j] - m);
    const sd = Math.sqrt(v / n); // 母體標準差（與 TradingView 相同）
    mid[i] = m;
    upper[i] = m + mult * sd;
    lower[i] = m - mult * sd;
  }
  return { mid, upper, lower };
}

export function trueRange(high, low, close) {
  const len = close.length;
  const tr = NaNArray(len);
  for (let i = 0; i < len; i++) {
    if (i === 0) tr[i] = high[i] - low[i];
    else {
      const pc = close[i - 1];
      tr[i] = Math.max(high[i] - low[i], Math.abs(high[i] - pc), Math.abs(low[i] - pc));
    }
  }
  return tr;
}

export function atr(high, low, close, n = 14) {
  return rma(trueRange(high, low, close), n);
}

export function adx(high, low, close, n = 14) {
  const len = close.length;
  const adxOut = NaNArray(len);
  const plusDI = NaNArray(len);
  const minusDI = NaNArray(len);
  if (len < 2 * n) return { adx: adxOut, plusDI, minusDI };
  const tr = trueRange(high, low, close);
  let sTR = 0;
  let sP = 0;
  let sM = 0;
  const dx = NaNArray(len);
  for (let i = 1; i < len; i++) {
    const up = high[i] - high[i - 1];
    const dn = low[i - 1] - low[i];
    const pdm = up > dn && up > 0 ? up : 0;
    const mdm = dn > up && dn > 0 ? dn : 0;
    if (i <= n) {
      sTR += tr[i];
      sP += pdm;
      sM += mdm;
    } else {
      sTR = sTR - sTR / n + tr[i];
      sP = sP - sP / n + pdm;
      sM = sM - sM / n + mdm;
    }
    if (i >= n) {
      const pdi = sTR === 0 ? 0 : (100 * sP) / sTR;
      const mdi = sTR === 0 ? 0 : (100 * sM) / sTR;
      plusDI[i] = pdi;
      minusDI[i] = mdi;
      const d = pdi + mdi;
      dx[i] = d === 0 ? 0 : (100 * Math.abs(pdi - mdi)) / d;
    }
  }
  // ADX：前 n 個 DX 的平均，之後 Wilder 平滑
  let sum = 0;
  for (let i = n; i < 2 * n; i++) sum += dx[i];
  let prev = sum / n;
  adxOut[2 * n - 1] = prev;
  for (let i = 2 * n; i < len; i++) {
    prev = (prev * (n - 1) + dx[i]) / n;
    adxOut[i] = prev;
  }
  return { adx: adxOut, plusDI, minusDI };
}

export function stochastic(high, low, close, n = 14, smoothK = 3, smoothD = 3) {
  const len = close.length;
  const raw = NaNArray(len);
  for (let i = n - 1; i < len; i++) {
    let hh = -Infinity;
    let ll = Infinity;
    for (let j = i - n + 1; j <= i; j++) {
      if (high[j] > hh) hh = high[j];
      if (low[j] < ll) ll = low[j];
    }
    raw[i] = hh === ll ? 50 : (100 * (close[i] - ll)) / (hh - ll);
  }
  const k = sma(raw, smoothK);
  const d = sma(k, smoothD);
  return { k, d };
}

export function supertrend(high, low, close, n = 10, mult = 3) {
  const len = close.length;
  const line = NaNArray(len);
  const dir = new Int8Array(len); // 1=多頭趨勢, -1=空頭趨勢, 0=尚未形成
  const a = atr(high, low, close, n);
  let pUp = NaN;
  let pDn = NaN;
  let pDir = 0;
  for (let i = 0; i < len; i++) {
    if (Number.isNaN(a[i])) continue;
    const hl2 = (high[i] + low[i]) / 2;
    let up = hl2 - mult * a[i];
    let dn = hl2 + mult * a[i];
    if (!Number.isNaN(pUp)) {
      if (close[i - 1] > pUp) up = Math.max(up, pUp);
      if (close[i - 1] < pDn) dn = Math.min(dn, pDn);
    }
    let d = pDir;
    if (d === 0) d = 1;
    else if (d === -1 && close[i] > pDn) d = 1;
    else if (d === 1 && close[i] < pUp) d = -1;
    dir[i] = d;
    line[i] = d === 1 ? up : dn;
    pUp = up;
    pDn = dn;
    pDir = d;
  }
  return { line, dir };
}

export function keltner(high, low, close, n = 20, atrN = 10, mult = 2) {
  const mid = ema(close, n);
  const a = atr(high, low, close, atrN);
  const len = close.length;
  const upper = NaNArray(len);
  const lower = NaNArray(len);
  for (let i = 0; i < len; i++) {
    upper[i] = mid[i] + mult * a[i];
    lower[i] = mid[i] - mult * a[i];
  }
  return { mid, upper, lower };
}

/** VWAP：日內週期以 UTC 日為錨點重置；日線則用滾動 20 根 */
export function vwap(time, high, low, close, volume, tfMs) {
  const len = close.length;
  const out = NaNArray(len);
  if (tfMs >= 86400000) {
    const n = 20;
    for (let i = n - 1; i < len; i++) {
      let pv = 0;
      let vv = 0;
      for (let j = i - n + 1; j <= i; j++) {
        pv += ((high[j] + low[j] + close[j]) / 3) * volume[j];
        vv += volume[j];
      }
      out[i] = vv > 0 ? pv / vv : NaN;
    }
    return out;
  }
  let day = -1;
  let pv = 0;
  let vv = 0;
  for (let i = 0; i < len; i++) {
    const d = Math.floor(time[i] / 86400000);
    if (d !== day) {
      day = d;
      pv = 0;
      vv = 0;
    }
    pv += ((high[i] + low[i] + close[i]) / 3) * volume[i];
    vv += volume[i];
    out[i] = vv > 0 ? pv / vv : NaN;
  }
  return out;
}

export function obv(close, volume) {
  const len = close.length;
  const out = NaNArray(len);
  if (len === 0) return out;
  let acc = 0;
  out[0] = 0;
  for (let i = 1; i < len; i++) {
    if (close[i] > close[i - 1]) acc += volume[i];
    else if (close[i] < close[i - 1]) acc -= volume[i];
    out[i] = acc;
  }
  return out;
}

export function cci(high, low, close, n = 20) {
  const len = close.length;
  const out = NaNArray(len);
  const tp = new Float64Array(len);
  for (let i = 0; i < len; i++) tp[i] = (high[i] + low[i] + close[i]) / 3;
  for (let i = n - 1; i < len; i++) {
    let sum = 0;
    for (let j = i - n + 1; j <= i; j++) sum += tp[j];
    const m = sum / n;
    let dev = 0;
    for (let j = i - n + 1; j <= i; j++) dev += Math.abs(tp[j] - m);
    dev /= n;
    out[i] = dev === 0 ? 0 : (tp[i] - m) / (0.015 * dev);
  }
  return out;
}

export function mfi(high, low, close, volume, n = 14) {
  const len = close.length;
  const out = NaNArray(len);
  const tp = new Float64Array(len);
  for (let i = 0; i < len; i++) tp[i] = (high[i] + low[i] + close[i]) / 3;
  for (let i = n; i < len; i++) {
    let pos = 0;
    let neg = 0;
    for (let j = i - n + 1; j <= i; j++) {
      const flow = tp[j] * volume[j];
      if (tp[j] > tp[j - 1]) pos += flow;
      else if (tp[j] < tp[j - 1]) neg += flow;
    }
    out[i] = neg === 0 ? (pos === 0 ? 50 : 100) : 100 - 100 / (1 + pos / neg);
  }
  return out;
}

/** 唐奇安通道：含當根的 n 根最高／最低 */
export function donchian(high, low, n = 20) {
  const len = close_len(high);
  const upper = NaNArray(len);
  const lower = NaNArray(len);
  for (let i = n - 1; i < len; i++) {
    let hh = -Infinity;
    let ll = Infinity;
    for (let j = i - n + 1; j <= i; j++) {
      if (high[j] > hh) hh = high[j];
      if (low[j] < ll) ll = low[j];
    }
    upper[i] = hh;
    lower[i] = ll;
  }
  return { upper, lower, mid: upper.map((u, i) => (u + lower[i]) / 2) };
}
function close_len(a) {
  return a.length;
}

/** 前一根為止的 n 根平均成交量（不含當根），用來判斷爆量 */
export function prevAvg(src, n) {
  const m = sma(src, n);
  const out = NaNArray(src.length);
  for (let i = 1; i < src.length; i++) out[i] = m[i - 1];
  return out;
}

/**
 * 效率比率（Kaufman Efficiency Ratio）：n 根內「淨位移 ÷ 路徑總長」，0～1。
 * 1＝一路走直線（單邊行情）；接近 0＝來回震盪、原地打轉。第 i 根只用到 i 以前的資料。
 */
export function efficiencyRatio(close, n = 20) {
  const out = NaNArray(close.length);
  for (let i = n; i < close.length; i++) {
    let path = 0;
    let ok = true;
    for (let k = i - n + 1; k <= i; k++) {
      const d = Math.abs(close[k] - close[k - 1]);
      if (Number.isNaN(d)) { ok = false; break; }
      path += d;
    }
    if (!ok || Number.isNaN(close[i - n])) continue;
    out[i] = path > 0 ? Math.abs(close[i] - close[i - n]) / path : 0;
  }
  return out;
}

/**
 * 斐波那契回撤位（用「已確認」的轉折點，沒有偷看未來）。
 * 轉折高點／低點：某根的最高價（最低價）是左右各 n 根裡最極端的；要等「右邊 n 根都收盤」才確認，
 * 所以第 p 根的轉折最早在第 p+n 根才知道。第 i 根的值只用到第 i 根以前已確認的轉折與第 i 根收盤價。
 * 回傳：
 *  up[i]   最近確認的轉折是「高點」（低→高的上升波段已完成）時，收盤價回檔了該波段的幾成：(高 − 收盤) ÷ (高 − 低)
 *  down[i] 最近確認的轉折是「低點」（高→低的下降波段已完成）時，收盤價反彈了該波段的幾成：(收盤 − 低) ÷ (高 − 低)
 * 波段幅度小於 minPct（%）的視為雜訊，不計。0＝回到波段終點、1＝回到波段起點、超過 1＝波段已被完全破壞。
 */
export function fibRatios(high, low, close, n = 5, minPct = 3) {
  const len = close.length;
  const up = NaNArray(len);
  const down = NaNArray(len);
  let hP = NaN; let hI = -1; let lP = NaN; let lI = -1;
  for (let i = 0; i < len; i++) {
    const p = i - n;
    if (p >= n) {
      let isH = true;
      let isL = true;
      for (let k = p - n; k <= p + n && (isH || isL); k++) {
        if (k === p) continue;
        const hk = high[k]; const lk = low[k];
        if (Number.isNaN(hk) || Number.isNaN(lk)) { isH = false; isL = false; break; }
        if (k < p ? hk >= high[p] : hk > high[p]) isH = false;
        if (k < p ? lk <= low[p] : lk < low[p]) isL = false;
      }
      if (Number.isNaN(high[p]) || Number.isNaN(low[p])) { isH = false; isL = false; }
      if (isH && !isL) { hP = high[p]; hI = p; }
      else if (isL && !isH) { lP = low[p]; lI = p; }
    }
    if (hI >= 0 && lI >= 0 && !Number.isNaN(close[i])) {
      const range = hP - lP;
      if (range > 0 && (range / lP) * 100 >= minPct) {
        if (hI > lI) up[i] = (hP - close[i]) / range;
        else if (lI > hI) down[i] = (close[i] - lP) / range;
      }
    }
  }
  return { up, down };
}

export function atrPercent(high, low, close, n = 14) {
  const a = atr(high, low, close, n);
  const out = NaNArray(close.length);
  for (let i = 0; i < close.length; i++) out[i] = (a[i] / close[i]) * 100;
  return out;
}
