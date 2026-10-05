// 多幣種投組：資金平均分配給每個幣種（各自獨立的資金袋），再把淨值曲線相加。
import { simulateSymbol } from './engine.js';
import { computeMetrics } from './metrics.js';

/**
 * 策略（strategy）格式：
 * { dir:'long'|'short', entry:[spec...], exit:[spec...], entryMode:'edge'|'level',
 *   lev, sl(%), tp(%), trail(%), maxBars }
 */
export function strategyToCfg(strategy, costs, market) {
  const perp = market === 'perp';
  return {
    dir: strategy.dir === 'short' ? -1 : 1,
    lev: perp ? strategy.lev || 1 : 1,
    sl: (strategy.sl || 0) / 100,
    tp: (strategy.tp || 0) / 100,
    trail: (strategy.trail || 0) / 100,
    maxBars: strategy.maxBars || 0,
    posPct: costs.posPct ?? 1,
    fee: costs.fee,
    slippage: costs.slippage,
    mmr: costs.mmr,
    perp,
  };
}

export function validateStrategy(ds, strategy) {
  if (ds.market === 'spot') {
    if (strategy.dir === 'short') throw new Error('現貨市場無法做空');
    if ((strategy.lev || 1) !== 1) throw new Error('現貨市場不支援槓桿');
  }
  if (strategy.lev < 1 || strategy.lev > 10) throw new Error('槓桿必須介於 1× ~ 10×');
}

/**
 * 在指定區間執行策略。
 * @param {SignalEngine} sig
 * @returns {{equity:Float64Array, trades:Array, perSymbol:Array, metrics:object}}
 */
export function runStrategy(sig, strategy, costs, range, opts = {}) {
  const ds = sig.ds;
  validateStrategy(ds, strategy);
  const cfg0 = strategyToCfg(strategy, costs, ds.market);
  const nSym = ds.symbols.length;
  const capital = costs.capital ?? 10000;
  const per = capital / nSym;
  const len = range.to - range.from;
  const record = opts.recordEquity !== false;
  const total = record ? new Float64Array(len) : null;
  const scratch = record ? new Float64Array(len) : null;
  const trades = [];
  const perSymbol = [];
  let liquidations = 0;

  for (let si = 0; si < nSym; si++) {
    const S = ds.symbols[si];
    const entries = sig.entryIdx(si, strategy.entry, strategy.entryMode || 'edge');
    const exitSig = sig.exitSignal(si, strategy.exit);
    const cfg = exitSig ? { ...cfg0, exitSig } : cfg0;
    const r = simulateSymbol(ds, S, entries, cfg, range, per, scratch);
    if (record) for (let i = 0; i < len; i++) total[i] += scratch[i];
    for (const t of r.trades) { t.symbol = S.symbol; t.si = si; trades.push(t); }
    liquidations += r.liquidations;
    perSymbol.push({ symbol: S.symbol, trades: r.trades.length, finalEquity: r.finalEquity, ret: r.finalEquity / per - 1 });
  }
  trades.sort((a, b) => a.exitIdx - b.exitIdx || a.entryIdx - b.entryIdx);
  const metrics = computeMetrics({
    equity: total, range, ds, trades, perSymbol, capital, lev: strategy.lev || 1, liquidations,
    finalEquityFallback: perSymbol.reduce((s, x) => s + x.finalEquity, 0),
  });
  return { equity: total, trades, perSymbol, metrics, range };
}
