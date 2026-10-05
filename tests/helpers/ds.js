// 測試用：手工組裝資料集
import { SignalEngine } from '../../public/js/core/signals.js';

export const H = 3600000;

/** bars: [[o,h,l,c], ...]  → 單一幣種資料集 */
export function mkDs(bars, opts = {}) {
  const n = bars.length;
  const f = (k) => Float64Array.from(bars.map((b) => b[k]));
  const baseMs = opts.baseMs || H;
  const S = {
    symbol: opts.symbol || 'TESTUSDT', first: 0, last: n - 1, gaps: 0,
    o: f(0), h: f(1), l: f(2), c: f(3), v: new Float64Array(n).fill(100),
    mh: opts.mark ? Float64Array.from(bars.map((b, i) => opts.mark[i][0])) : null,
    ml: opts.mark ? Float64Array.from(bars.map((b, i) => opts.mark[i][1])) : null,
    funding: opts.funding || null,
    tf: {},
  };
  const ds = {
    market: opts.market || 'perp', baseTf: opts.baseTf || '1h', baseMs, t0: opts.t0 || 0, n,
    windowStartIdx: opts.windowStartIdx || 0, symbols: [S], warnings: [],
  };
  return { ds, S, sig: new SignalEngine(ds) };
}

export const COSTS0 = { fee: 0, slippage: 0, mmr: 0.005, posPct: 1, capital: 10000 };
export const flat = (p, n) => Array.from({ length: n }, () => [p, p, p, p]);
