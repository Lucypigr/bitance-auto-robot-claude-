// K 線型態：第 i 根的判斷只使用 0..i 根（含第 i 根已收盤的資料）。
// 回傳 Uint8Array，1 = 該根 K 線收盤時型態成立。

const TREND_LB = 5; // 判斷「前一段趨勢」回看根數

function isDown(c, i) {
  return i - 1 - TREND_LB >= 0 && c[i - 1] < c[i - 1 - TREND_LB];
}
function isUp(c, i) {
  return i - 1 - TREND_LB >= 0 && c[i - 1] > c[i - 1 - TREND_LB];
}

function parts(o, h, l, c, i) {
  const body = Math.abs(c[i] - o[i]);
  const range = h[i] - l[i];
  const upper = h[i] - Math.max(o[i], c[i]);
  const lower = Math.min(o[i], c[i]) - l[i];
  return { body, range, upper, lower };
}

function hammerShape(p) {
  return p.range > 0 && p.lower >= 2 * p.body && p.upper <= 0.1 * p.range;
}
function invertedShape(p) {
  return p.range > 0 && p.upper >= 2 * p.body && p.lower <= 0.1 * p.range;
}

function make(n, fn) {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = fn(i) ? 1 : 0;
  return out;
}

/** 槌頭：長下影線、幾乎無上影線，出現在下跌之後（可能止跌） */
export function hammer(o, h, l, c) {
  return make(c.length, (i) => hammerShape(parts(o, h, l, c, i)) && isDown(c, i));
}
/** 倒槌頭：長上影線、幾乎無下影線，出現在下跌之後 */
export function invertedHammer(o, h, l, c) {
  return make(c.length, (i) => invertedShape(parts(o, h, l, c, i)) && isDown(c, i));
}
/** 上吊線：與槌頭同形，但出現在上漲之後（可能見頂） */
export function hangingMan(o, h, l, c) {
  return make(c.length, (i) => hammerShape(parts(o, h, l, c, i)) && isUp(c, i));
}
/** 流星線：與倒槌頭同形，但出現在上漲之後 */
export function shootingStar(o, h, l, c) {
  return make(c.length, (i) => invertedShape(parts(o, h, l, c, i)) && isUp(c, i));
}
/** 看漲吞噬：前一根陰線，這根陽線實體完整包住前一根實體 */
export function bullishEngulfing(o, h, l, c) {
  return make(c.length, (i) => {
    if (i < 1) return false;
    const prevBear = c[i - 1] < o[i - 1];
    const curBull = c[i] > o[i];
    if (!prevBear || !curBull) return false;
    const pb = o[i - 1] - c[i - 1];
    const cb = c[i] - o[i];
    return o[i] <= c[i - 1] && c[i] >= o[i - 1] && cb > pb;
  });
}
/** 看跌吞噬：前一根陽線，這根陰線實體完整包住前一根實體 */
export function bearishEngulfing(o, h, l, c) {
  return make(c.length, (i) => {
    if (i < 1) return false;
    const prevBull = c[i - 1] > o[i - 1];
    const curBear = c[i] < o[i];
    if (!prevBull || !curBear) return false;
    const pb = c[i - 1] - o[i - 1];
    const cb = o[i] - c[i];
    return o[i] >= c[i - 1] && c[i] <= o[i - 1] && cb > pb;
  });
}
/** 十字星：開收盤幾乎相同（實體 ≤ 全距 10%） */
export function doji(o, h, l, c) {
  return make(c.length, (i) => {
    const p = parts(o, h, l, c, i);
    return p.range > 0 && p.body <= 0.1 * p.range;
  });
}
/** 晨星：長陰線 → 小實體 → 長陽線收復第一根實體一半以上 */
export function morningStar(o, h, l, c) {
  return make(c.length, (i) => {
    if (i < 2) return false;
    const b0 = o[i - 2] - c[i - 2];
    const r0 = h[i - 2] - l[i - 2];
    if (!(b0 > 0 && r0 > 0 && b0 >= 0.5 * r0)) return false;
    const b1 = Math.abs(c[i - 1] - o[i - 1]);
    if (!(b1 <= 0.3 * b0)) return false;
    const mid1 = (c[i - 1] + o[i - 1]) / 2;
    if (!(mid1 < c[i - 2])) return false;
    const mid0 = (o[i - 2] + c[i - 2]) / 2;
    return c[i] > o[i] && c[i] > mid0;
  });
}
/** 暮星：長陽線 → 小實體 → 長陰線跌破第一根實體一半以下 */
export function eveningStar(o, h, l, c) {
  return make(c.length, (i) => {
    if (i < 2) return false;
    const b0 = c[i - 2] - o[i - 2];
    const r0 = h[i - 2] - l[i - 2];
    if (!(b0 > 0 && r0 > 0 && b0 >= 0.5 * r0)) return false;
    const b1 = Math.abs(c[i - 1] - o[i - 1]);
    if (!(b1 <= 0.3 * b0)) return false;
    const mid1 = (c[i - 1] + o[i - 1]) / 2;
    if (!(mid1 > c[i - 2])) return false;
    const mid0 = (o[i - 2] + c[i - 2]) / 2;
    return c[i] < o[i] && c[i] < mid0;
  });
}

export const PATTERNS = {
  hammer,
  inverted_hammer: invertedHammer,
  hanging_man: hangingMan,
  shooting_star: shootingStar,
  bullish_engulfing: bullishEngulfing,
  bearish_engulfing: bearishEngulfing,
  doji,
  morning_star: morningStar,
  evening_star: eveningStar,
};
