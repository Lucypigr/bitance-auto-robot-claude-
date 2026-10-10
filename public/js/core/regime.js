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

/** 一串收盤價的行情分類（第 i 根只用 i 以前的資料；資料不足為 0） */
export function classifyCloses(c, params = {}) {
  const { period, trend, range } = { ...REGIME_DEFAULTS, ...params };
  const er = efficiencyRatio(c, period);
  const out = new Uint8Array(c.length);
  for (let i = 0; i < er.length; i++) {
    const e = er[i];
    if (Number.isNaN(e)) continue;
    if (e >= trend) out[i] = c[i] > c[i - period] ? REGIME.UP : c[i] < c[i - period] ? REGIME.DOWN : REGIME.MID;
    else if (e <= range) out[i] = REGIME.RANGE;
    else out[i] = REGIME.MID;
  }
  return { regime: out, er };
}

/** 一檔標的在執行週期上的行情分類（陣列長度＝ds.n，資料範圍外為 0） */
export function regimeSeries(ds, si, params = {}) {
  const S = ds.symbols[si];
  const { regime, er } = classifyCloses(S.c.subarray(S.first, S.last + 1), params);
  const out = new Uint8Array(ds.n);
  out.set(regime, S.first);
  return { regime: out, er, first: S.first };
}

/**
 * 多週期並排：每檔標的在各週期（執行週期與更大的週期）各自的目前行情。
 * 大週期單邊、小週期震盪是很常見的組合，只看單一週期會得到互相矛盾的印象。
 */
export function regimeMultiTf(ds, params = {}, tfs = [ds.baseTf]) {
  const { period } = { ...REGIME_DEFAULTS, ...params };
  return ds.symbols.map((S) => ({
    symbol: S.symbol, name: S.name || '',
    tfs: tfs.map((tf) => {
      const ser = tf === ds.baseTf ? { c: S.c.subarray(S.first, S.last + 1) } : S.tf && S.tf[tf];
      if (!ser || !ser.c || ser.c.length <= period) return { tf, current: 0, er: NaN, bars: 0, share: { 1: 0, 2: 0, 3: 0, 4: 0 } };
      const { regime, er } = classifyCloses(ser.c, params);
      const counts = { 1: 0, 2: 0, 3: 0, 4: 0 };
      let total = 0;
      for (const r of regime) if (r) { counts[r]++; total++; }
      const last = regime.length - 1;
      return { tf, current: regime[last], er: er[last], bars: total, share: Object.fromEntries(REGIME_KEYS.map((k) => [k, total ? counts[k] / total : 0])) };
    }),
  }));
}

/** 白話：各週期的行情組合代表什麼（描述現狀，不是預測） */
export function multiTfReading(row) {
  const known = row.tfs.filter((t) => t.current);
  if (known.length < 2) return '';
  const hi = known[known.length - 1];
  const lo = known[0];
  const L = (t) => `${t.tf} ${REGIME_LABEL[t.current]}`;
  const trend = (r) => r === REGIME.UP || r === REGIME.DOWN;
  if (trend(hi.current) && lo.current === REGIME.RANGE) return `大週期單邊（${L(hi)}）、小週期在整理（${L(lo)}）：常見於單邊走勢中的整理，可能續勢也可能轉折，這裡只描述現況。`;
  if (hi.current === REGIME.RANGE && trend(lo.current)) return `大週期在震盪（${L(hi)}）、小週期有短線單邊（${L(lo)}）：區間內的短線波動。`;
  if (known.every((t) => t.current === known[0].current)) return `各週期一致：${REGIME_LABEL[known[0].current]}。`;
  if (trend(hi.current) && trend(lo.current) && hi.current !== lo.current) return `大週期${REGIME_LABEL[hi.current]}、小週期${REGIME_LABEL[lo.current]}：小週期正在逆著大方向走（回檔或反彈）。`;
  return `各週期看法不一：${known.map(L).join('、')}。`;
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
