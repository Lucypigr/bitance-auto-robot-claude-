// 多幣種投組：資金平均分配給每個幣種（各自獨立的資金袋），再把淨值曲線相加。
import { validateSpec } from './conditions.js';
import { simulateSymbol, simulatePool, simulateDual } from './engine.js';
import { computeMetrics } from './metrics.js';

/**
 * 策略（strategy）格式：
 * { dir:'long'|'short', entry:[spec...], exit:[spec...], entryMode:'edge'|'level',
 *   lev, sl(%), tp(%), trail(%), maxBars }
 */
export function strategyToCfg(strategy, costs, market) {
  const perp = market === 'perp';
  const tw = market === 'tw';
  const atr = strategy.unit === 'atr'; // 停損／停利（及分批出場、加碼間距）以 ATR 倍數表示
  const cap = strategy.unit === 'capital'; // 以「進場前資金袋淨值」的 % 表示（引擎依投入金額換算成價格幅度）
  const roe = strategy.unit === 'roe'; // 以「保證金報酬率 ROE %」表示：價格幅度 = ROE ÷ 槓桿
  const lev = perp ? strategy.lev || 1 : 1;
  const scale = atr ? 1 : roe ? 0.01 / lev : 0.01;
  const so = strategy.scaleOut;
  const si = strategy.scaleIn;
  return {
    dir: strategy.dir === 'short' ? -1 : 1,
    lev: perp ? strategy.lev || 1 : 1,
    unitAtr: atr, atrPeriod: strategy.atrPeriod || 14,
    sl: strategy.unit === 'usdt' || cap ? 0 : (strategy.sl || 0) * scale,
    tp: strategy.unit === 'usdt' || cap ? 0 : (strategy.tp || 0) * scale,
    slCap: cap ? (strategy.sl || 0) / 100 : 0,
    tpCap: cap ? (strategy.tp || 0) / 100 : 0,
    so: so && so.frac > 0 ? { at: (so.at || 0) * scale, frac: so.frac / 100, be: !!so.be } : null,
    si: si && si.count > 0 ? { mode: si.mode === 'adverse' ? 'adverse' : 'favor', step: (si.step || 0) * scale, count: Math.floor(si.count), size: (si.size ?? 100) / 100 } : null,
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
  for (const sp of [...(strategy.entry || []), ...(strategy.entryB || []), ...(strategy.exit || [])]) {
    const e = validateSpec(sp);
    if (e) throw new Error(e);
  }
  if (strategy.unit && !['pct', 'usdt', 'atr', 'capital', 'roe'].includes(strategy.unit)) throw new Error('停損停利單位不正確');
  if (strategy.unit === 'capital') {
    if (strategy.riskPct > 0) throw new Error('「本金 %」單位已經直接以本金決定每筆虧損，不需要再設「每筆風險」，請把每筆風險改回 0');
    if (strategy.scaleOut && strategy.scaleOut.frac > 0) throw new Error('分批出場不能和「本金 %」單位一起用，請改用價格 %、ROE % 或 ATR 倍數');
    if (strategy.scaleIn && strategy.scaleIn.count > 0) throw new Error('加碼不能和「本金 %」單位一起用，請改用價格 %、ROE % 或 ATR 倍數');
    if (!(strategy.sl > 0) && !(strategy.tp > 0)) throw new Error('「本金 %」單位需要設定停損或停利');
    if (strategy.sl > 100 || strategy.tp > 1000) throw new Error('停損不能超過本金的 100%');
  }
  if (strategy.unit === 'roe' && ds.market !== 'perp') throw new Error('保證金報酬率（ROE）只適用於永續合約；現貨與台股沒有槓桿，請用價格 %');
  if (strategy.unit === 'atr') {
    const p = strategy.atrPeriod ?? 14;
    if (!(p >= 2 && p <= 200)) throw new Error('ATR 週期必須介於 2 ～ 200');
    if (!(strategy.sl > 0) && !(strategy.tp > 0) && !(strategy.scaleIn && strategy.scaleIn.count > 0)) throw new Error('ATR 單位需要設定停損或停利的 ATR 倍數');
  }
  const so = strategy.scaleOut;
  if (so && so.frac > 0) {
    if (strategy.unit === 'usdt') throw new Error('分批出場不能和「USDT 金額」單位一起用，請改用價格 % 或 ATR 倍數');
    if (!(so.frac >= 1 && so.frac <= 99)) throw new Error('分批出場的平倉比例必須介於 1% ～ 99%');
    if (!(so.at > 0)) throw new Error('分批出場需要設定第一目標（大於 0）');
    if (strategy.tp > 0 && !(so.at < strategy.tp)) throw new Error('分批出場的第一目標必須比最終停利更近（小於停利）');
  }
  const si = strategy.scaleIn;
  if (si && si.count > 0) {
    if (strategy.unit === 'usdt') throw new Error('加碼不能和「USDT 金額」單位一起用，請改用價格 % 或 ATR 倍數');
    if (!['favor', 'adverse'].includes(si.mode)) throw new Error('加碼方式不正確');
    if (!(si.count >= 1 && si.count <= 5 && Number.isInteger(si.count))) throw new Error('加碼次數必須是 1 ～ 5 的整數');
    if (!(si.step > 0)) throw new Error('加碼間距必須大於 0');
    if (!(si.size >= 1 && si.size <= 300)) throw new Error('每次加碼的大小必須介於初始部位的 1% ～ 300%');
    if (si.mode === 'adverse' && strategy.sl > 0 && !(si.step * si.count < strategy.sl)) throw new Error('逢低分批進場的最遠一檔必須比停損更近（間距 × 次數 < 停損），否則會先被停損');
    if (si.mode === 'favor' && strategy.tp > 0 && !(si.step < strategy.tp)) throw new Error('順勢加碼的間距必須小於停利，否則還沒加碼就已經停利出場');
  }
  if (strategy.dir === 'both' || (strategy.entryB && strategy.entryB.length)) {
    if (ds.market !== 'perp') throw new Error('雙向／反手只支援 USDT 永續合約（現貨與台股不能做空）');
    if (strategy.dir !== 'both') throw new Error('設定了做空進場條件，請把方向改成「雙向」');
    if (!strategy.entry.length || !(strategy.entryB && strategy.entryB.length)) throw new Error('雙向策略需要同時設定「做多進場條件」與「做空進場條件」');
    if (strategy.capitalMode === 'shared') throw new Error('雙向／反手目前不能和「共用資金池」一起用');
  } else if (strategy.reverse) throw new Error('反手需要方向設為「雙向」');
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

  const dual = strategy.dir === 'both';
  for (let si = 0; si < nSym; si++) {
    const S = ds.symbols[si];
    const entries = sig.entryIdx(si, strategy.entry, strategy.entryMode || 'edge');
    const exitSig = sig.exitSignal(si, strategy.exit);
    const cfg = { ...cfg0, feeOut: costs.fee + taxOf(S), ...(exitSig ? { exitSig } : {}) };
    let r;
    if (dual) {
      const entriesB = sig.entryIdx(si, strategy.entryB, strategy.entryMode || 'edge');
      const flags = (idx) => { const f = new Uint8Array(ds.n); for (let i = 0; i < idx.length; i++) f[idx[i]] = 1; return f; };
      const revA = strategy.reverse ? flags(entriesB) : null;
      const revB = strategy.reverse ? flags(entries) : null;
      r = simulateDual(ds, S, { entries, cfg: { ...cfg, dir: 1, ...(revA ? { revSig: revA } : {}) } }, { entries: entriesB, cfg: { ...cfg, dir: -1, ...(revB ? { revSig: revB } : {}) } }, range, per, scratch);
    } else r = simulateSymbol(ds, S, entries, cfg, range, per, scratch);
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
