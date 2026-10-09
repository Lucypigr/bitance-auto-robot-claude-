// 多幣種投組：資金平均分配給每個幣種（各自獨立的資金袋），再把淨值曲線相加。
import { validateSpec } from './conditions.js';
import { simulateSymbol, simulatePool } from './engine.js';
import { computeMetrics } from './metrics.js';

/**
 * 策略（strategy）格式：
 * { dir:'long'|'short', entry:[spec...], exit:[spec...], entryMode:'edge'|'level',
 *   lev, sl(%), tp(%), trail(%), maxBars }
 */
export function strategyToCfg(strategy, costs, market) {
  const perp = market === 'perp';
  const tw = market === 'tw';
  return {
    dir: strategy.dir === 'short' ? -1 : 1,
    lev: perp ? strategy.lev || 1 : 1,
    sl: strategy.unit === 'usdt' ? 0 : (strategy.sl || 0) / 100,
    tp: strategy.unit === 'usdt' ? 0 : (strategy.tp || 0) / 100,
    slUsdt: strategy.unit === 'usdt' ? strategy.sl || 0 : 0,
    tpUsdt: strategy.unit === 'usdt' ? strategy.tp || 0 : 0,
    posUsdt: strategy.posUsdt || 0,
    riskPct: (strategy.riskPct || 0) / 100,
    trail: (strategy.trail || 0) / 100,
    maxBars: strategy.maxBars || 0,
    posPct: costs.posPct ?? 1,
    fee: costs.fee,
    slippage: costs.slippage,
    mmr: costs.mmr,
    perp,
    // 台股：買進只收手續費；賣出另外加證交稅（依標的另計）、有最低手續費、以整股計
    feeIn: costs.fee,
    minFee: tw ? costs.minFee || 0 : 0,
    lot: tw ? 1 : 0,
    limitLock: tw,
  };
}

export function validateStrategy(ds, strategy) {
  for (const sp of [...(strategy.entry || []), ...(strategy.exit || [])]) {
    const e = validateSpec(sp);
    if (e) throw new Error(e);
  }
  if (ds.market !== 'perp') {
    if (strategy.dir === 'short') throw new Error(ds.market === 'tw' ? '台股不支援做空' : '現貨市場無法做空');
    if ((strategy.lev || 1) !== 1) throw new Error('現貨市場不支援槓桿');
  }
  if (strategy.unit === 'usdt' && !(strategy.posUsdt > 0)) throw new Error('以 USDT 金額設定停損／停利時，必須同時指定「每筆投入金額」');
  if (strategy.riskPct > 0) {
    if (strategy.unit === 'usdt') throw new Error('風險比例定位只能搭配「價格 %」的停損，不能和 USDT 金額停損一起用');
    if (!(strategy.sl > 0)) throw new Error('風險比例定位需要先設定停損（%）');
    if (strategy.riskPct > 100) throw new Error('每筆風險不能超過 100%');
  }
  if (strategy.capitalMode === 'shared') {
    const n = ds.symbols.length;
    if (!(strategy.maxPos >= 1 && strategy.maxPos <= n)) throw new Error(`同時最多持倉數必須介於 1 ～ ${n}（目前選了 ${n} 個標的）`);
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
  const shared = strategy.capitalMode === 'shared';
  const taxOf = (S) => (ds.market === 'tw' ? (S.isEtf ? costs.taxEtf ?? 0.001 : costs.tax ?? 0.003) : 0);

  if (shared) {
    // 共用資金池：所有標的共用同一筆資金，同時最多持有 maxPos 個部位
    const inputs = ds.symbols.map((S, si) => {
      const exitSig = sig.exitSignal(si, strategy.exit);
      return { S, entries: sig.entryIdx(si, strategy.entry, strategy.entryMode || 'edge'), cfg: { ...cfg0, feeOut: costs.fee + taxOf(S), ...(exitSig ? { exitSig } : {}) } };
    });
    const r = simulatePool(ds, inputs, range, capital, { maxPos: strategy.maxPos, record });
    for (const t of r.trades) { t.symbol = ds.symbols[t.si].symbol; trades.push(t); }
    liquidations = r.liquidations;
    for (let si = 0; si < nSym; si++) {
      const ts = trades.filter((t) => t.si === si);
      const pnl = ts.reduce((a, t) => a + t.pnl, 0);
      perSymbol.push({ symbol: ds.symbols[si].symbol, trades: ts.length, finalEquity: per + pnl, ret: pnl / per });
    }
    trades.sort((a, b) => a.exitIdx - b.exitIdx || a.entryIdx - b.entryIdx);
    const metrics = computeMetrics({
      equity: r.equity, range, ds, trades, perSymbol, capital, lev: strategy.lev || 1, liquidations,
      finalEquityFallback: capital + trades.reduce((a, t) => a + t.pnl, 0),
    });
    return { equity: r.equity, trades, perSymbol, metrics, range };
  }

  for (let si = 0; si < nSym; si++) {
    const S = ds.symbols[si];
    const entries = sig.entryIdx(si, strategy.entry, strategy.entryMode || 'edge');
    const exitSig = sig.exitSignal(si, strategy.exit);
    const cfg = { ...cfg0, feeOut: costs.fee + taxOf(S), ...(exitSig ? { exitSig } : {}) };
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
