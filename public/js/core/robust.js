// 結果可信度：用「重新抽樣」檢查績效有多少可能只是運氣。
//  - 有放回重抽樣（bootstrap）：把這些交易的損益重抽很多次，看總損益會落在哪個範圍、有多少比例仍為正。
//  - 符號翻轉檢定（sign-flip）：假設「這個策略其實沒有優勢」（每筆損益正負對稱），隨機翻轉每筆的正負號，
//    看隨機得到「不輸給實際成績」的機率（單尾 p 值）。
//  - 順序重排：交易順序是運氣的一部分，隨機重排很多次看最大回撤的分布。
//  - 多重檢定：搜尋測了 K 組，挑出來的冠軍好成績有一部分只是「挑出來的」，用 Šidák 校正 p 值。
//  - MAE／MFE：每筆交易途中最大浮虧／最大浮盈，檢視停損停利是不是設得合理。
// 全部用固定亂數種子，結果可重現。損益一律採「加總」（不複利），是近似值，目的是看運氣的範圍。
import { makeRng } from './util.js';

export const ROBUST_DEFAULTS = { sims: 5000, seed: 20240601, bins: 24 };

export function percentile(sorted, q) {
  if (!sorted.length) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

const sum = (a) => { let t = 0; for (let i = 0; i < a.length; i++) t += a[i]; return t; };

/** 有放回重抽 n 筆的總損益，重複 sims 次（回傳排序後的陣列） */
export function bootstrapTotals(pnls, sims, rng) {
  const n = pnls.length;
  const out = new Float64Array(sims);
  for (let s = 0; s < sims; s++) {
    let t = 0;
    for (let i = 0; i < n; i++) t += pnls[Math.floor(rng() * n)];
    out[s] = t;
  }
  return out.sort();
}

/** 符號翻轉檢定：H0＝沒有優勢（每筆損益正負對稱）。p ＝ 隨機翻轉後總損益 ≥ 實際總損益的比例（含自己，故不會是 0） */
export function signFlipP(pnls, sims, rng) {
  const n = pnls.length;
  if (!n) return 1;
  const obs = sum(pnls);
  let ge = 0;
  for (let s = 0; s < sims; s++) {
    let t = 0;
    for (let i = 0; i < n; i++) t += rng() < 0.5 ? pnls[i] : -pnls[i];
    if (t >= obs - 1e-9) ge++;
  }
  return (ge + 1) / (sims + 1);
}

/** 依序累加損益（本金 + 累計）的最大回撤（相對高點的比例）。只看已平倉結算，不含持倉中的浮動損益。 */
export function maxDrawdownOf(pnls, capital) {
  let eq = capital;
  let peak = capital;
  let dd = 0;
  for (let i = 0; i < pnls.length; i++) {
    eq += pnls[i];
    if (eq > peak) peak = eq;
    const d = peak > 0 ? (peak - eq) / peak : 0;
    if (d > dd) dd = d;
  }
  return dd;
}

/** 隨機重排交易順序，回傳排序後的最大回撤分布 */
export function shuffledDrawdowns(pnls, capital, sims, rng) {
  const a = Float64Array.from(pnls);
  const out = new Float64Array(sims);
  for (let s = 0; s < sims; s++) {
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const t = a[i]; a[i] = a[j]; a[j] = t;
    }
    out[s] = maxDrawdownOf(a, capital);
  }
  return out.sort();
}

/** Šidák：從 K 組裡挑最好的那一組，「至少有一組這麼好」的機率 */
export function sidak(p, K) {
  if (!(K > 1)) return p;
  return 1 - Math.pow(1 - Math.min(1, Math.max(0, p)), K);
}

function histogram(sortedTotals, bins, extra = []) {
  const lo = Math.min(sortedTotals[0], ...extra);
  const hi = Math.max(sortedTotals[sortedTotals.length - 1], ...extra);
  const w = (hi - lo) / bins || 1;
  const counts = new Array(bins).fill(0);
  for (const v of sortedTotals) counts[Math.min(bins - 1, Math.floor((v - lo) / w))]++;
  return { lo, hi, counts };
}

/** 單一區段（訓練或樣本外）的檢定 */
export function analyzeSegment(trades, capital, { sims = ROBUST_DEFAULTS.sims, seed = ROBUST_DEFAULTS.seed, bins = ROBUST_DEFAULTS.bins } = {}) {
  const ordered = trades.slice().sort((a, b) => a.exitIdx - b.exitIdx || a.entryIdx - b.entryIdx);
  const pnls = ordered.map((t) => t.pnl);
  const n = pnls.length;
  const total = sum(pnls);
  const wins = pnls.filter((x) => x > 0).length;
  const base = { n, total, totalPct: total / capital, mean: n ? total / n : 0, winRate: n ? wins / n : 0 };
  if (n < 5) return { ...base, insufficient: true };
  const eff = Math.max(500, Math.min(sims, Math.floor(4e6 / n)));
  const rng = makeRng(seed);
  const boot = bootstrapTotals(pnls, eff, rng);
  const pctTotals = Array.from(boot, (x) => x / capital);
  const ddObs = maxDrawdownOf(pnls, capital);
  const dd = shuffledDrawdowns(pnls, capital, eff, rng);
  return {
    ...base, insufficient: false, sims: eff,
    boot: {
      p05: percentile(pctTotals, 0.05), p50: percentile(pctTotals, 0.5), p95: percentile(pctTotals, 0.95),
      probPositive: pctTotals.filter((x) => x > 0).length / pctTotals.length,
      hist: histogram(pctTotals, bins, [base.totalPct, 0]),
    },
    signFlipP: signFlipP(pnls, eff, rng),
    dd: { observed: ddObs, p50: percentile(dd, 0.5), p95: percentile(dd, 0.95) },
  };
}

// ---------------- MAE／MFE ----------------
const med = (a) => { const s = a.slice().sort((x, y) => x - y); return percentile(s, 0.5); };
const p90 = (a) => { const s = a.slice().sort((x, y) => x - y); return percentile(s, 0.9); };

/** 價格報酬（不含槓桿與成本）＝這筆實際從進場價走了多少 */
export const priceRet = (t) => (t.dir * (t.exitPrice - t.entryPrice)) / t.entryPrice;

export function excursionStats(trades) {
  const ts = trades.filter((t) => Number.isFinite(t.mae) && Number.isFinite(t.mfe) && t.entryPrice > 0);
  const win = ts.filter((t) => t.pnl > 0);
  const lose = ts.filter((t) => t.pnl <= 0);
  const capture = win.filter((t) => t.mfe > 0).map((t) => Math.min(1, Math.max(0, priceRet(t) / t.mfe)));
  return {
    n: ts.length,
    win: { n: win.length, maeMed: med(win.map((t) => t.mae)), maeP90: p90(win.map((t) => t.mae)), mfeMed: med(win.map((t) => t.mfe)) },
    lose: { n: lose.length, maeMed: med(lose.map((t) => t.mae)), maeP90: p90(lose.map((t) => t.mae)), mfeMed: med(lose.map((t) => t.mfe)) },
    loseWithProfit: lose.length ? lose.filter((t) => t.mfe >= 0.005).length / lose.length : 0, // 輸家中曾經浮盈 ≥ 0.5% 的比例
    capture: capture.length ? med(capture) : null, // 贏家平均抓到最大浮盈的幾成
  };
}

/** 完整的可信度報告 */
export function runRobustness({ res, capital, nCandidates = 1, sims, seed }) {
  const opt = { sims, seed };
  const train = analyzeSegment(res.train.trades, capital, opt);
  const oos = analyzeSegment(res.holdout.trades, capital, { ...opt, seed: (seed ?? ROBUST_DEFAULTS.seed) + 1 });
  const K = Math.max(1, Math.floor(nCandidates));
  const multiple = {
    K,
    pTrain: train.insufficient ? null : train.signFlipP,
    pTrainAdj: train.insufficient ? null : sidak(train.signFlipP, K),
    pOos: oos.insufficient ? null : oos.signFlipP,
  };
  const all = [...res.train.trades, ...res.holdout.trades];
  return { train, oos, multiple, excursion: excursionStats(all), capital };
}

export function robustVerdict(r, { searched = false } = {}) {
  const out = [];
  const add = (level, text) => out.push({ level, text });
  const pc = (x) => `${(x * 100).toFixed(1)}%`;
  const o = r.oos;
  if (o.insufficient) add('warn', `樣本外只有 ${o.n} 筆交易，太少，無法做統計檢定。拉長資料或增加幣種後再看。`);
  else {
    const p = o.signFlipP;
    if (p < 0.05) add('good', `樣本外：假設「策略其實沒有優勢」，隨機得到這麼好（或更好）成績的機率只有約 ${pc(p)}（p 值）。這是比較強的證據，但仍只代表這一段歷史。`);
    else if (p < 0.2) add('warn', `樣本外：隨機得到這麼好成績的機率約 ${pc(p)}（p 值），證據偏弱，還不能排除是運氣。`);
    else add('bad', `樣本外：隨機得到這麼好（或更好）成績的機率高達約 ${pc(p)}（p 值），無法排除只是運氣（或者其實是虧損）。`);
    add(o.boot.probPositive >= 0.9 ? 'good' : o.boot.probPositive >= 0.6 ? 'warn' : 'bad', `把樣本外的 ${o.n} 筆交易重抽樣 ${o.sims.toLocaleString()} 次：總損益有 ${pc(o.boot.probPositive)} 的情況為正；90% 區間約 ${pc(o.boot.p05)} ～ ${pc(o.boot.p95)}（佔本金）。`);
    if (o.dd.p95 > o.dd.observed * 1.5 && o.dd.p95 - o.dd.observed > 0.02) add('warn', `回撤可能比歷史看到的更深：樣本外實際最大回撤約 ${pc(o.dd.observed)}，但把交易順序隨機重排，95% 的情況下最大回撤在 ${pc(o.dd.p95)} 以內。請用後者評估自己撐不撐得住。`);
  }
  const m = r.multiple;
  if (!r.train.insufficient) {
    if (searched && m.K > 1) {
      if (m.pTrainAdj > 0.05) add('warn', `訓練期：原始 p 值 ${pc(m.pTrain)}，但這是從 ${m.K} 組候選裡挑出來的；經過多重檢定校正後約 ${pc(m.pTrainAdj)}，無法排除訓練期的好成績只是「挑出來的運氣」。這就是為什麼要看樣本外。`);
      else add('good', `訓練期：從 ${m.K} 組候選中挑出，經多重檢定校正後 p 值仍約 ${pc(m.pTrainAdj)}，不太像純靠挑選的運氣。（候選彼此相關，校正偏保守。）`);
    } else if (!searched) add('info', '多重檢定：這是單一策略，沒有校正。但如果你在這之前手動試過很多組設定，實際的「挑選次數」比 1 大，請把這個 p 值看得更保守一點。');
  }
  if (r.excursion.n >= 10 && r.excursion.capture !== null && r.excursion.capture < 0.4) add('info', `贏的交易平均只抓到最大浮盈的 ${pc(r.excursion.capture)}：賺錢的單子常常先賺到更多、又回吐。可以試試移動停損或分批出場。`);
  if (r.excursion.n >= 10 && r.excursion.loseWithProfit > 0.5) add('info', `虧損的交易中有 ${pc(r.excursion.loseWithProfit)} 曾經浮盈超過 0.5%，最後才轉虧：可以考慮把停利設近一點、分批出場，或用保本停損。`);
  if (r.train.n + r.oos.n < 30) add('warn', '總交易數不到 30 筆，任何統計檢定的結論都很脆弱。');
  return out;
}
