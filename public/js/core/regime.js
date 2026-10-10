// 行情狀態（單邊上漲／單邊下跌／震盪／過渡）：用效率比率 ER 分類。
// 第 i 根的分類只用到第 i 根（含）以前已收盤的資料；訊號在第 i 根收盤後成立、下一根開盤才成交，和條件的時間對齊方式一致。
import { efficiencyRatio } from './indicators.js';

export const REGIME = { NONE: 0, UP: 1, DOWN: 2, RANGE: 3, MID: 4 };
export const REGIME_LABEL = { 0: '資料不足', 1: '單邊上漲', 2: '單邊下跌', 3: '震盪', 4: '過渡' };
export const REGIME_KEYS = [1, 2, 3, 4];
// 依幣安 BTC／ETH／SOL 的 1h／4h／1d 實際分布：ER(20) 的 25／50／75 百分位約 0.10／0.20／0.35
export const REGIME_DEFAULTS = { period: 20, trend: 0.35, range: 0.12 };

export function validateRegimeParams(p) {
  const { period, trend, range } = { ...REGIME_DEFAULTS, ...p };
  if (!(Number.isInteger(period) && period >= 5 && period <= 200)) throw new Error('行情判斷的 ER 週期必須是 5 ～ 200 的整數');
  if (!(trend > 0 && trend < 1) || !(range > 0 && range < 1)) throw new Error('行情門檻必須介於 0 ～ 1');
  if (!(range < trend)) throw new Error('「震盪」的 ER 門檻必須小於「單邊」的 ER 門檻');
}

/** 一檔標的在執行週期上的行情分類（陣列長度＝ds.n，資料範圍外為 0） */
export function regimeSeries(ds, si, params = {}) {
  const { period, trend, range } = { ...REGIME_DEFAULTS, ...params };
  const S = ds.symbols[si];
  const c = S.c.subarray(S.first, S.last + 1);
  const er = efficiencyRatio(c, period);
  const out = new Uint8Array(ds.n);
  for (let i = 0; i < er.length; i++) {
    const e = er[i];
    if (Number.isNaN(e)) continue;
    let r;
    if (e >= trend) r = c[i] > c[i - period] ? REGIME.UP : c[i] < c[i - period] ? REGIME.DOWN : REGIME.MID;
    else if (e <= range) r = REGIME.RANGE;
    else r = REGIME.MID;
    out[S.first + i] = r;
  }
  return { regime: out, er, first: S.first };
}

/** 每檔標的：最新一根已收盤 K 線的行情、ER，以及在區間內各行情所佔比例 */
export function regimeOverview(ds, params = {}, range = null) {
  return ds.symbols.map((S, si) => {
    const { regime, er } = regimeSeries(ds, si, params);
    const from = Math.max(range ? range.from : 0, S.first);
    const to = Math.min(range ? range.to : ds.n, S.last + 1);
    const counts = { 1: 0, 2: 0, 3: 0, 4: 0 };
    let total = 0;
    for (let i = from; i < to; i++) { const r = regime[i]; if (r) { counts[r]++; total++; } }
    const last = S.last;
    return {
      symbol: S.symbol, name: S.name || '', current: regime[last], er: er[last - S.first],
      share: Object.fromEntries(REGIME_KEYS.map((k) => [k, total ? counts[k] / total : 0])), bars: total,
    };
  });
}

/** 每一筆交易在「訊號那根收盤」時的行情，分組統計（誰在哪種行情賺、哪種行情賠） */
export function tradesByRegime(trades, ds, params = {}) {
  const cache = new Map();
  const reg = (si) => { if (!cache.has(si)) cache.set(si, regimeSeries(ds, si, params).regime); return cache.get(si); };
  const symIdx = new Map(ds.symbols.map((S, i) => [S.symbol, i]));
  const groups = Object.fromEntries(REGIME_KEYS.concat([0]).map((k) => [k, { regime: k, n: 0, wins: 0, pnl: 0, grossWin: 0, grossLoss: 0, retSum: 0 }]));
  for (const t of trades) {
    const si = t.si ?? symIdx.get(t.symbol);
    const r = si === undefined ? 0 : reg(si)[t.signalIdx] || 0;
    const g = groups[r];
    g.n++; g.pnl += t.pnl; g.retSum += t.ret;
    if (t.pnl > 0) { g.wins++; g.grossWin += t.pnl; } else g.grossLoss += -t.pnl;
  }
  return Object.values(groups).filter((g) => g.n > 0).map((g) => ({
    ...g, winRate: g.wins / g.n, avgRet: g.retSum / g.n, profitFactor: g.grossLoss > 0 ? g.grossWin / g.grossLoss : g.grossWin > 0 ? Infinity : 0,
  }));
}
