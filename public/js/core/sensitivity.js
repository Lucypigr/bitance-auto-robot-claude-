// 參數敏感度：把策略的停損、停利、槓桿與條件門檻在「基準值附近」掃一遍，
// 看績效是平穩的高原（穩健），還是只有基準值那一格特別好的孤島（可能過度擬合）。
import { runStrategy } from './portfolio.js';
import { CONDITIONS, normalizeSpec, describeSpec } from './conditions.js';

const MULTS = [0.5, 0.75, 1, 1.25, 1.5, 2];
const r2 = (x) => Math.round(x * 100) / 100;

export function axisValues(base) {
  if (!(base > 0)) return [];
  return [...new Set(MULTS.map((m) => r2(base * m)).filter((v) => v > 0))].sort((a, b) => a - b);
}

function cell(sig, strategy, costs, ranges) {
  const run = (rg) => {
    const m = runStrategy(sig, strategy, costs, rg, { recordEquity: false }).metrics;
    return { netReturn: m.netReturn, trades: m.trades, winRate: m.winRate, profitFactor: m.profitFactor, liquidations: m.liquidations };
  };
  return { train: run(ranges.train), oos: run(ranges.holdout) };
}

/**
 * @returns {{base:{sl:number,tp:number}, slAxis:number[], tpAxis:number[], grid:Array<Array<object>>,
 *            params:Array<object>, summary:object}}
 */
export function runSensitivity(sig, strategy, costs, ranges, hooks = {}) {
  const ds = sig.ds;
  const slAxis = axisValues(strategy.sl);
  const tpAxis = axisValues(strategy.tp);
  const grid = [];
  const total = Math.max(1, slAxis.length || 1) * Math.max(1, tpAxis.length || 1);
  let done = 0;
  const sl = slAxis.length ? slAxis : [strategy.sl || 0];
  const tp = tpAxis.length ? tpAxis : [strategy.tp || 0];
  for (const t of tp) {
    const row = [];
    for (const s of sl) {
      const st = { ...strategy, sl: s, tp: t };
      // 風險比例定位需要停損；沒有停損的格子就不用風險定位
      if (!(s > 0)) st.riskPct = 0;
      row.push({ sl: s, tp: t, ...cell(sig, st, costs, ranges) });
      done++;
      if (hooks.progress) hooks.progress({ done, total });
    }
    grid.push(row);
  }

  // 單一參數掃描：槓桿、各條件的門檻／週期
  const params = [];
  if (ds.market === 'perp') {
    const vals = [1, 2, 3, 5, 10];
    params.push({ label: '槓桿', key: 'lev', base: strategy.lev, unit: '×', points: vals.map((v) => ({ v, ...cell(sig, { ...strategy, lev: v }, costs, ranges) })) });
  }
  strategy.entry.forEach((raw, i) => {
    const sp = normalizeSpec(raw);
    const def = CONDITIONS[sp.id];
    for (const f of def.fields) {
      const options = f.options.map(Number).filter((x) => Number.isFinite(x));
      if (options.length < 2) continue;
      const cur = Number(sp.params[f.key]);
      const points = options.map((v) => {
        const entry = strategy.entry.map((e, k) => (k === i ? { ...e, params: { ...(e.params || {}), [f.key]: v } } : e));
        return { v, ...cell(sig, { ...strategy, entry }, costs, ranges) };
      });
      params.push({ label: `條件 ${i + 1}「${describeSpec({ ...sp, neg: false })}」的${f.label}`, key: `c${i}.${f.key}`, base: cur, unit: '', points });
    }
  });

  return { base: { sl: strategy.sl || 0, tp: strategy.tp || 0 }, slAxis, tpAxis, grid, params, summary: summarize(grid, sl, tp, strategy) };
}

/** 基準格與「周圍 8 格」的比較 */
export function summarize(grid, slAxis, tpAxis, strategy) {
  const bi = slAxis.findIndex((v) => Math.abs(v - (strategy.sl || 0)) < 1e-9);
  const bj = tpAxis.findIndex((v) => Math.abs(v - (strategy.tp || 0)) < 1e-9);
  if (bi < 0 || bj < 0 || grid.length * (grid[0] || []).length < 4) return { level: 'none', text: '停損與停利都沒有設定（或只有一個可變動），無法做二維敏感度比較。請看下方的單一參數掃描。' };
  const base = grid[bj][bi];
  const nb = [];
  for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
    if (!di && !dj) continue;
    const c = (grid[bj + dj] || [])[bi + di];
    if (c) nb.push(c);
  }
  const share = (sel) => (nb.length ? nb.filter((c) => c[sel].netReturn > 0).length / nb.length : 0);
  const trainShare = share('train');
  const oosShare = share('oos');
  const all = grid.flat();
  const best = all.reduce((a, c) => (c.train.netReturn > a.train.netReturn ? c : a), all[0]);
  let level;
  let text;
  if (base.train.netReturn <= 0) {
    level = 'bad';
    text = `基準參數在訓練期本身就是虧損（${(base.train.netReturn * 100).toFixed(1)}%），周圍 ${nb.length} 格中只有 ${(trainShare * 100).toFixed(0)}% 在訓練期獲利。`;
  } else if (trainShare >= 0.7 && oosShare >= 0.5) {
    level = 'good';
    text = `基準參數周圍 ${nb.length} 格中，訓練期有 ${(trainShare * 100).toFixed(0)}%、樣本外有 ${(oosShare * 100).toFixed(0)}% 仍獲利：績效沒有因為參數稍微改動就崩掉，是比較穩健的「高原」。`;
  } else if (trainShare < 0.4) {
    level = 'bad';
    text = `基準參數訓練期獲利，但周圍 ${nb.length} 格只有 ${(trainShare * 100).toFixed(0)}% 獲利：像一座孤島，參數稍微改動就轉虧，很可能是過度擬合。`;
  } else {
    level = 'warn';
    text = `基準參數周圍 ${nb.length} 格中，訓練期 ${(trainShare * 100).toFixed(0)}%、樣本外 ${(oosShare * 100).toFixed(0)}% 獲利：穩健度普通，請搭配其他驗證。`;
  }
  return { level, text, trainShare, oosShare, neighbors: nb.length, base: base.train.netReturn, bestSl: best.sl, bestTp: best.tp };
}
