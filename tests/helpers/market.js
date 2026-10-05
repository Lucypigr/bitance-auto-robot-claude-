import { buildDataset } from '../../public/js/core/dataset.js';
import { SignalEngine } from '../../public/js/core/signals.js';
import { makePath5m, aggregate, FACTOR, ANCHOR } from './synth.js';

const MS5 = 300000;

export function klinesFromPath(path, tfs) {
  const out = {};
  for (const tf of tfs) out[tf] = aggregate(path, FACTOR[tf]);
  return out;
}

/** 建立多幣種合成資料集。mutate(path, symIndex) 可在建立後修改路徑（用來製造「未來不同」的資料） */
export function makeMarket({ symbols = 3, days = 180, baseTf = '1h', tfs = ['1h', '4h'], market = 'perp', seed = 100, vol = 0.0030, mutate = null, windowDays = 150, regimeScale = 0.4 } = {}) {
  const total = 288 * days;
  const list = [];
  for (let s = 0; s < symbols; s++) {
    const path = makePath5m(seed + s * 17, total, 100 + s * 50, vol, 0, 1000, regimeScale);
    if (mutate) mutate(path, s);
    const sd = { symbol: `S${s}USDT`, klines: klinesFromPath(path, tfs) };
    if (market === 'perp') {
      // 每 8 小時結算一次的資金費率
      const n = Math.floor(total / 96);
      const t = new Float64Array(n); const rate = new Float64Array(n); const mark = new Float64Array(n);
      for (let i = 0; i < n; i++) { t[i] = ANCHOR + i * 8 * 3600000; rate[i] = 0.0001; mark[i] = path.c[Math.min(total - 1, i * 96)]; }
      sd.funding = { t, rate, mark };
    }
    list.push(sd);
  }
  const endTime = ANCHOR + total * MS5;
  const windowStart = endTime - windowDays * 86400000;
  const ds = buildDataset({ market, baseTf, windowStart, endTime, symbols: list });
  return { ds, sig: new SignalEngine(ds), endTime };
}
