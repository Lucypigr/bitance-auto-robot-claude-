// 共用工具：週期定義、亂數、二分搜尋
export const MIN = 60 * 1000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

export const TIMEFRAMES = ['5m', '15m', '1h', '4h', '1d'];
export const TF_MS = { '5m': 5 * MIN, '15m': 15 * MIN, '1h': HOUR, '4h': 4 * HOUR, '1d': DAY };
export const TF_LABEL = { '5m': '5 分鐘', '15m': '15 分鐘', '1h': '1 小時', '4h': '4 小時', '1d': '1 天' };

export function tfIndex(tf) {
  const i = TIMEFRAMES.indexOf(tf);
  if (i < 0) throw new Error(`不支援的週期：${tf}`);
  return i;
}

/** 以種子產生可重現的亂數（mulberry32） */
export function makeRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffleInPlace(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = arr[i];
    arr[i] = arr[j];
    arr[j] = t;
  }
  return arr;
}

/** 回傳第一個 >= x 的索引（arr 為遞增排序） */
export function lowerBound(arr, x, lo = 0, hi = arr.length) {
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** 兩個遞增排序的 Int32Array 求交集 */
export function intersectSorted(a, b) {
  if (a.length > b.length) [a, b] = [b, a];
  const out = new Int32Array(a.length);
  let n = 0;
  let j = 0;
  for (let i = 0; i < a.length; i++) {
    const v = a[i];
    j = lowerBound(b, v, j);
    if (j >= b.length) break;
    if (b[j] === v) out[n++] = v;
  }
  return out.slice(0, n);
}

export function alignDown(t, step) {
  return Math.floor(t / step) * step;
}

export function isFiniteNum(x) {
  return typeof x === 'number' && Number.isFinite(x);
}
