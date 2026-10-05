// 績效指標與「最穩定」評分
import { DAY } from './util.js';

const MONTH_NAMES = (idx) => {
  const y = Math.floor(idx / 12);
  const m = (idx % 12) + 1;
  return `${y}-${String(m).padStart(2, '0')}`;
};

export function computeMetrics({ equity, range, ds, trades, perSymbol, capital, lev, liquidations, finalEquityFallback }) {
  const len = range.to - range.from;
  const hasEq = equity && equity.length === len && len > 0;
  const final = hasEq ? equity[len - 1] : finalEquityFallback ?? capital;
  const netReturn = final / capital - 1;

  // ---- 最大回撤（以每根收盤淨值計）、日報酬、月報酬 ----
  let peak = capital;
  let maxDD = 0;
  const dailyRet = [];
  const monthly = new Map();
  if (hasEq) {
    let prevDay = capital;
    let prevMonth = capital;
    for (let i = 0; i < len; i++) {
      const e = equity[i];
      if (e > peak) peak = e;
      const dd = peak > 0 ? (peak - e) / peak : 0;
      if (dd > maxDD) maxDD = dd;
      const tOpen = ds.t0 + (range.from + i) * ds.baseMs;
      const nextOpen = tOpen + ds.baseMs;
      const day = Math.floor(tOpen / DAY);
      const nextDay = Math.floor(nextOpen / DAY);
      const mk = monthKey(tOpen);
      const nextMk = monthKey(nextOpen);
      if (i === len - 1 || nextDay !== day) {
        dailyRet.push(prevDay > 0 ? e / prevDay - 1 : 0);
        prevDay = e;
      }
      if (i === len - 1 || nextMk !== mk) {
        monthly.set(mk, prevMonth > 0 ? e / prevMonth - 1 : 0);
        prevMonth = e;
      }
    }
  }

  let sharpe = 0;
  let sortino = 0;
  if (dailyRet.length >= 2) {
    const mean = dailyRet.reduce((a, b) => a + b, 0) / dailyRet.length;
    let v = 0;
    let dv = 0;
    for (const r of dailyRet) {
      v += (r - mean) * (r - mean);
      if (r < 0) dv += r * r;
    }
    const sd = Math.sqrt(v / (dailyRet.length - 1));
    const dsd = Math.sqrt(dv / dailyRet.length);
    sharpe = sd > 1e-12 ? (mean / sd) * Math.sqrt(365) : 0;
    sortino = dsd > 1e-12 ? (mean / dsd) * Math.sqrt(365) : mean > 0 ? 99 : 0;
    sharpe = clamp(sharpe, -99, 99);
    sortino = clamp(sortino, -99, 99);
  }

  const years = Math.max(len * ds.baseMs, DAY) / (365 * DAY);
  const cagr = final <= 0 ? -1 : Math.pow(final / capital, 1 / years) - 1;

  // ---- 逐筆交易統計 ----
  let wins = 0;
  let gp = 0;
  let gl = 0;
  let sumPnl = 0;
  let sumRet = 0;
  let fees = 0;
  let funding = 0;
  let liqProx = 0;
  let streak = 0;
  let maxStreak = 0;
  for (const t of trades) {
    sumPnl += t.pnl;
    sumRet += t.ret;
    fees += t.fee;
    funding += t.funding;
    if (t.pnl > 0) { wins++; gp += t.pnl; streak = 0; } else {
      gl += -t.pnl;
      streak++;
      if (streak > maxStreak) maxStreak = streak;
    }
    const prox = t.reason === 'liq' ? 1 : t.liqDist > 0 ? Math.min(1, t.mae / t.liqDist) : 0;
    if (prox > liqProx) liqProx = prox;
  }
  const nT = trades.length;
  const losses = nT - wins;
  const profitFactor = gl === 0 ? (gp > 0 ? Infinity : 0) : gp / gl;
  const monthsArr = [...monthly.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const posMonths = monthsArr.filter(([, r]) => r > 0).length;
  const posSyms = perSymbol.filter((s) => s.ret > 0).length;

  return {
    initial: capital,
    finalEquity: final,
    netReturn,
    cagr,
    shortPeriod: years < 0.25,
    winRate: nT ? wins / nT : 0,
    maxDrawdown: maxDD,
    profitFactor,
    sharpe,
    sortino,
    avgWin: wins ? gp / wins : 0,
    avgLoss: losses ? -gl / losses : 0,
    expectancy: nT ? sumPnl / nT : 0,
    expectancyPct: nT ? sumRet / nT : 0,
    maxLosingStreak: maxStreak,
    trades: nT,
    wins,
    losses,
    positiveMonths: posMonths,
    totalMonths: monthsArr.length,
    monthly: monthsArr.map(([k, r]) => ({ month: k, ret: r })),
    positiveSymbolRatio: perSymbol.length ? posSyms / perSymbol.length : 0,
    positiveSymbols: posSyms,
    symbolCount: perSymbol.length,
    funding,
    fees,
    liquidations,
    liqProximity: liqProx,
    leverage: lev,
  };
}

function monthKey(ms) {
  const d = new Date(ms);
  return MONTH_NAMES(d.getUTCFullYear() * 12 + d.getUTCMonth());
}

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

/**
 * 「最穩定」評分（0~100）。只使用訓練期的指標。
 * 權重：Sharpe 18、Sortino 8、PF 14、最大回撤 18、交易數 8、跨幣正報酬 8、正報酬月份 10、清算風險 16
 */
export function stabilityScore(m, { minTrades = 20 } = {}) {
  if (m.trades === 0) return { score: 0, parts: {} };
  const pf = Number.isFinite(m.profitFactor) ? m.profitFactor : 4;
  const parts = {
    sharpe: 18 * clamp(m.sharpe, 0, 3) / 3,
    sortino: 8 * clamp(m.sortino, 0, 5) / 5,
    pf: 14 * clamp(pf - 1, 0, 2) / 2,
    drawdown: 18 * (1 - clamp(m.maxDrawdown / 0.5, 0, 1)),
    trades: 8 * clamp(m.trades / (minTrades * 3), 0, 1),
    symbols: 8 * m.positiveSymbolRatio,
    months: 10 * (m.totalMonths ? m.positiveMonths / m.totalMonths : 0),
    liquidation: 16 * (1 - clamp(m.liqProximity, 0, 1)),
  };
  let score = 0;
  for (const v of Object.values(parts)) score += v;
  return { score, parts };
}
