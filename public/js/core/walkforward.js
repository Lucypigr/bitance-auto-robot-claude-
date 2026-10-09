// 走動式驗證（Walk-forward）：
// 把資料切成多折，每一折都「只用該折訓練期」重新跑一次自動搜尋、挑出冠軍，
// 再拿它去交易「緊接在後、完全沒看過」的測試期。把所有測試期串起來，就是一條
// 從頭到尾都沒有偷看過未來的績效曲線，比單次 70/30 更可信。
import { runSearch } from './search.js';
import { computeMetrics } from './metrics.js';
import { spanMs, timeAt } from './util.js';

/** 折的區間：訓練長度 = ratio × 測試長度；每折往前移動一個測試長度；最後一折的測試期延伸到資料結尾 */
export function foldRanges(ds, folds, ratio) {
  const total = ds.n - ds.windowStartIdx;
  const S = Math.floor(total / (ratio + folds));
  if (S < 20) throw new Error('資料太短，無法切成這麼多折（每折測試期至少需要 20 根 K 線）。請拉長資料、減少折數或降低訓練／測試比例。');
  const T = ratio * S;
  const out = [];
  for (let k = 0; k < folds; k++) {
    const trainFrom = ds.windowStartIdx + k * S;
    const trainTo = trainFrom + T;
    const testTo = k === folds - 1 ? ds.n : trainTo + S;
    out.push({ k, train: { from: trainFrom, to: trainTo }, test: { from: trainTo, to: testTo } });
  }
  return out;
}

function buyHoldReturn(ds, range) {
  let sum = 0;
  for (const S of ds.symbols) {
    const st = Math.max(S.first, range.from);
    const en = Math.min(S.last, range.to - 1);
    if (en <= st) continue;
    sum += S.c[en] / S.o[st] - 1;
  }
  return sum / ds.symbols.length;
}

const compact = (m) => ({ netReturn: m.netReturn, trades: m.trades, winRate: m.winRate, profitFactor: m.profitFactor, maxDrawdown: m.maxDrawdown, liquidations: m.liquidations });

/**
 * @param {object} cfg 自動搜尋設定 + { folds, ratio, follow:'stable'|'netReturn'|'winRate' }
 * @param {object} hooks { progress, cancelled, yield }
 */
export async function runWalkForward(sig, cfgIn, costs, hooks = {}) {
  const ds = sig.ds;
  const folds = cfgIn.folds || 4;
  const ratio = cfgIn.ratio || 3;
  const follow = cfgIn.follow || 'stable';
  const ranges = foldRanges(ds, folds, ratio);
  const capital = costs.capital;
  const out = [];
  let level = 1;
  const chainParts = [];
  const bhParts = [];
  let bhLevel = 1;
  const allTrades = [];
  let liquidations = 0;

  for (const fr of ranges) {
    if (hooks.cancelled && hooks.cancelled()) return { cancelled: true };
    const rng = { train: fr.train, holdout: fr.test, full: { from: fr.train.from, to: fr.test.to }, splitIdx: fr.test.from };
    const res = await runSearch(sig, cfgIn, costs, {
      ranges: rng,
      cancelled: hooks.cancelled,
      yield: hooks.yield,
      progress: (p) => hooks.progress && hooks.progress({ fold: fr.k + 1, folds, phase: p.phase, done: p.done, total: p.total }),
    });
    if (res.cancelled) return { cancelled: true };
    const id = res.champions[follow];
    const len = fr.test.to - fr.test.from;
    let testM;
    let trainM = null;
    let desc = null;
    let strategy = null;
    let eq;
    if (id) {
      const e = res.candidates.find((c) => c.id === id);
      const d = res.details[id];
      desc = e.desc; strategy = e.strategy;
      trainM = compact(d.train.metrics);
      testM = compact(d.holdout.metrics);
      eq = d.holdout.equity;
      for (const t of d.holdout.trades) allTrades.push(t);
      liquidations += d.holdout.metrics.liquidations;
    } else {
      testM = { netReturn: 0, trades: 0, winRate: 0, profitFactor: 0, maxDrawdown: 0, liquidations: 0 };
      eq = new Float64Array(len).fill(capital); // 沒有合格的冠軍 → 這段時間空手
    }
    const seg = new Float64Array(len);
    for (let i = 0; i < len; i++) seg[i] = (level * eq[i]) / capital;
    chainParts.push(seg);
    level *= eq[len - 1] / capital;
    const bh = buyHoldReturn(ds, fr.test);
    const bseg = new Float64Array(len);
    // 買入持有的逐根曲線（等權重）：每檔 c/起點，空手檔位以 1 計
    for (let i = 0; i < len; i++) {
      let s = 0;
      for (const S of ds.symbols) {
        const st = Math.max(S.first, fr.test.from);
        const idx = Math.min(S.last, fr.test.from + i);
        s += idx < st ? 1 : S.c[idx] / S.o[st];
      }
      bseg[i] = (bhLevel * s) / ds.symbols.length;
    }
    bhParts.push(bseg);
    bhLevel *= 1 + bh;
    out.push({
      k: fr.k + 1, train: fr.train, test: fr.test, hasChampion: !!id, desc, strategy,
      trainMetrics: trainM, testMetrics: testM, buyHold: bh, eligible: res.eligibleCount,
      candidates: res.candidates.length,
    });
  }

  const first = ranges[0].test.from;
  const last = ranges[ranges.length - 1].test.to;
  const total = last - first;
  const chain = new Float64Array(total);
  const bhChain = new Float64Array(total);
  let p = 0;
  for (let i = 0; i < chainParts.length; i++) { chain.set(chainParts[i], p); bhChain.set(bhParts[i], p); p += chainParts[i].length; }
  const eqUsd = chain.map((x) => x * capital);
  allTrades.sort((a, b) => a.exitIdx - b.exitIdx || a.entryIdx - b.entryIdx);
  const range = { from: first, to: last };
  const m = computeMetrics({ equity: eqUsd, range, ds, trades: allTrades, perSymbol: [], capital, lev: 1, liquidations });
  const withCh = out.filter((f) => f.hasChampion);
  const posFolds = out.filter((f) => f.testMetrics.netReturn > 0).length;
  const sumTrain = withCh.reduce((a, f) => a + f.trainMetrics.netReturn, 0);
  const sumTest = withCh.reduce((a, f) => a + f.testMetrics.netReturn, 0);
  const T = ranges[0].train.to - ranges[0].train.from;
  const S = ranges[0].test.to - ranges[0].test.from;
  const efficiency = withCh.length && sumTrain > 0 ? (sumTest / withCh.length / S) / (sumTrain / withCh.length / T) : null;
  return {
    cancelled: false,
    folds: out, chain, bhChain, range, ratio, follow,
    summary: {
      netReturn: level - 1, buyHold: bhLevel - 1, metrics: m,
      foldsWithChampion: withCh.length, foldsTotal: out.length, positiveFolds: posFolds,
      trades: allTrades.length, efficiency,
      spanDays: spanMs(ds, range) / 86400000,
      start: timeAt(ds, first), end: timeAt(ds, last - 1),
    },
    config: { folds, ratio, follow, minTrades: cfgIn.minTrades ?? 20, budget: cfgIn.budget },
  };
}
