// 條件組合自動搜尋 + 冠軍選擇。
// 防過度擬合：候選評分與冠軍選擇「只」使用訓練期(前 70%)結果；
// 樣本外(後 30%)只在冠軍確定後才計算，用來驗證，絕不回頭影響選擇。
import { makeRng, shuffleInPlace, lowerBound } from './util.js';
import { specKey, describeSpec } from './conditions.js';
import { runStrategy } from './portfolio.js';
import { stabilityScore } from './metrics.js';
import { splitRanges } from './dataset.js';

export const BUDGETS = [30, 60, 120, 180, 300];

export const SEARCH_DEFAULTS = {
  direction: 'both', // long | short | both
  maxConditions: 3,
  budget: 120,
  tfs: null, // 條件使用的週期；預設為執行週期
  rsiOverbought: [70, 75, 80],
  rsiOversold: [30, 25, 20],
  slList: [1, 2, 3, 5],
  tpList: [1, 2, 3, 5, 10],
  levList: [1, 2, 3, 5, 10],
  minTrades: 20,
  seed: 20240601,
  allowOpposite: false, // true = 多單也可使用偏空條件（順勢追價），空單亦同
  entryMode: 'edge',
  trainFrac: 0.7,
  variantsPerSet: 3,
};

const sp = (id, tf, params = {}, within = 1) => ({ id, tf, params, within });

/** 建立某方向可用的「條件原子」，依 (指標家族, 週期) 分成槽位，同槽位不會同時出現 */
export function buildAtomSlots(dir, tfs, cfg) {
  const slots = new Map();
  const add = (family, tf, spec) => {
    const k = `${family}|${tf}`;
    if (!slots.has(k)) slots.set(k, []);
    slots.get(k).push(spec);
  };
  for (const tf of tfs) {
    const bull = () => {
      for (const lv of cfg.rsiOversold) add('rsi', tf, sp('rsi_oversold', tf, { level: lv }));
      add('ema', tf, sp('ema_golden', tf, { fast: 50, slow: 200 }, 3));
      add('macd', tf, sp('macd_golden', tf, {}, 2));
      add('bb', tf, sp('bb_below_lower', tf));
      for (const p of ['hammer', 'inverted_hammer', 'bullish_engulfing', 'morning_star']) add('pattern', tf, sp(`pat_${p}`, tf));
    };
    const bear = () => {
      for (const lv of cfg.rsiOverbought) add('rsi', tf, sp('rsi_overbought', tf, { level: lv }));
      add('ema', tf, sp('ema_death', tf, { fast: 50, slow: 200 }, 3));
      add('macd', tf, sp('macd_death', tf, {}, 2));
      add('bb', tf, sp('bb_above_upper', tf));
      for (const p of ['hanging_man', 'shooting_star', 'bearish_engulfing', 'evening_star']) add('pattern', tf, sp(`pat_${p}`, tf));
    };
    if (cfg.allowOpposite) { bull(); bear(); } else if (dir === 'long') bull(); else bear();
  }
  return [...slots.entries()].map(([key, specs]) => ({ key, specs }));
}

export function strategyKey(st) {
  return `${st.dir}|${st.entry.map(specKey).sort().join('&')}|sl${st.sl}|tp${st.tp}|x${st.lev}`;
}

export function describeStrategy(st) {
  const dir = st.dir === 'long' ? '做多' : '做空';
  const cond = st.entry.map(describeSpec).join(' 且 ');
  const exits = [];
  if (st.sl) exits.push(`停損 ${st.sl}%`);
  if (st.tp) exits.push(`停利 ${st.tp}%`);
  if (st.trail) exits.push(`移動停損 ${st.trail}%`);
  return `${dir}｜${cond}｜${exits.join('、') || '無停損停利'}｜${st.lev}×`;
}

/** 訓練期內可能的進場訊號數（用來預先過濾「幾乎不會觸發」的組合；只看訊號頻率，不看報酬） */
function countTrainSignals(sig, specs, entryMode, train) {
  let total = 0;
  const ds = sig.ds;
  for (let si = 0; si < ds.symbols.length; si++) {
    const idx = sig.entryIdx(si, specs, entryMode);
    const a = lowerBound(idx, train.from);
    const b = lowerBound(idx, train.to - 1); // 訊號 s 需要 s+1 < to
    total += Math.max(0, b - a);
  }
  return total;
}

/**
 * 產生候選策略。總數永遠 <= budget；槓桿只是被均勻抽樣的一個維度，不會讓數量倍增。
 */
export function generateCandidates(sig, cfgIn, train) {
  const cfg = { ...SEARCH_DEFAULTS, ...cfgIn };
  const ds = sig.ds;
  const tfs = cfg.tfs && cfg.tfs.length ? cfg.tfs : [ds.baseTf];
  const spot = ds.market === 'spot';
  const dirs = spot ? ['long'] : cfg.direction === 'both' ? ['long', 'short'] : [cfg.direction];
  const levList = spot ? [1] : cfg.levList;
  const rng = makeRng(cfg.seed);
  const budget = Math.max(1, Math.floor(cfg.budget));

  // 風控參數組合 (停損, 停利, 槓桿)，洗牌後輪流分配 → 各參數均勻出現
  const combos = [];
  for (const sl of cfg.slList) for (const tp of cfg.tpList) for (const lev of levList) combos.push({ sl, tp, lev });
  shuffleInPlace(combos, rng);

  const warnings = [];
  const nSetsTarget = Math.max(1, Math.ceil(budget / cfg.variantsPerSet));
  const setsByDir = new Map();
  for (const dir of dirs) {
    const slots = buildAtomSlots(dir, tfs, cfg);
    const want = Math.ceil(nSetsTarget / dirs.length);
    const found = [];
    const seen = new Set();
    let tries = 0;
    const maxTries = want * 80 + 200;
    const maxC = Math.min(cfg.maxConditions, slots.length);
    while (found.length < want && tries++ < maxTries) {
      const size = 1 + Math.floor(rng() * maxC);
      const pick = shuffleInPlace(slots.slice(), rng).slice(0, size);
      const specs = pick.map((s) => s.specs[Math.floor(rng() * s.specs.length)]);
      const key = specs.map(specKey).sort().join('&');
      if (seen.has(key)) continue;
      seen.add(key);
      if (countTrainSignals(sig, specs, cfg.entryMode, train) < cfg.minTrades) continue;
      found.push(specs);
    }
    if (found.length < want) {
      warnings.push(`${dir === 'long' ? '做多' : '做空'}方向只找到 ${found.length} 組訊號足夠的條件組合（目標 ${want} 組）。建議增加幣種、拉長資料或降低最低交易數。`);
    }
    setsByDir.set(dir, found);
  }

  const candidates = [];
  const seenKeys = new Set();
  let round = 0;
  let progress = true;
  let ci = 0;
  // 輪流從各方向、各組合取一個，並配上下一組風控參數，直到湊滿 budget 或沒有新組合
  while (candidates.length < budget && progress) {
    progress = false;
    for (const dir of dirs) {
      const sets = setsByDir.get(dir);
      for (let i = 0; i < sets.length && candidates.length < budget; i++) {
        const specs = sets[i];
        const combo = combos[(i * cfg.variantsPerSet + round + ci) % combos.length];
        const st = { dir, entry: specs, exit: [], entryMode: cfg.entryMode, sl: combo.sl, tp: combo.tp, trail: 0, lev: combo.lev };
        const key = strategyKey(st);
        if (seenKeys.has(key)) continue;
        seenKeys.add(key);
        candidates.push(st);
        progress = true;
      }
    }
    round++;
    ci += 7; // 讓之後各輪錯開，避免重複同一組風控
    if (round > combos.length * 2) break;
  }
  return { candidates: candidates.slice(0, budget), warnings };
}

/** 從「訓練期」結果挑出三位冠軍。完全不接觸樣本外資料。 */
export function selectChampions(evals, { minTrades = 20 } = {}) {
  const eligible = evals.filter((e) => e.train.trades >= minTrades && e.train.liquidations === 0);
  const best = (list, cmp) => (list.length ? list.slice().sort(cmp)[0] : null);
  const winRate = best(eligible, (a, b) =>
    b.train.winRate - a.train.winRate || b.train.netReturn - a.train.netReturn || b.train.trades - a.train.trades || a.index - b.index);
  const netReturn = best(eligible, (a, b) =>
    b.train.netReturn - a.train.netReturn || b.train.winRate - a.train.winRate || a.index - b.index);
  const stableList = eligible.filter((e) => e.train.netReturn > 0 && (e.train.profitFactor > 1));
  const stable = best(stableList, (a, b) => b.stability - a.stability || b.train.netReturn - a.train.netReturn || a.index - b.index);
  return { winRate, netReturn, stable, eligibleCount: eligible.length };
}

/**
 * 執行整個搜尋流程。
 * hooks: { progress(info), cancelled():boolean, yield():Promise }
 */
export async function runSearch(sig, cfgIn, costs, hooks = {}) {
  const cfg = { ...SEARCH_DEFAULTS, ...cfgIn };
  const ds = sig.ds;
  const ranges = splitRanges(ds, cfg.trainFrac);
  const emit = (info) => hooks.progress && hooks.progress(info);
  const cancelled = () => (hooks.cancelled ? hooks.cancelled() : false);
  const tick = async () => { if (hooks.yield) await hooks.yield(); };

  emit({ phase: 'scan', done: 0, total: 1 });
  const { candidates, warnings } = generateCandidates(sig, cfg, ranges.train);
  if (cancelled()) return { cancelled: true };
  const evals = [];
  let lastEmit = 0;
  for (let i = 0; i < candidates.length; i++) {
    if (cancelled()) return { cancelled: true };
    const st = candidates[i];
    const r = runStrategy(sig, st, costs, ranges.train);
    const m = r.metrics;
    const stab = stabilityScore(m, { minTrades: cfg.minTrades });
    evals.push({
      index: i, id: `c${i + 1}`, strategy: st, desc: describeStrategy(st),
      train: compactMetrics(m), stability: stab.score, stabilityParts: stab.parts,
    });
    const now = Date.now();
    if (now - lastEmit > 80 || i === candidates.length - 1) {
      lastEmit = now;
      emit({ phase: 'eval', done: i + 1, total: candidates.length });
      await tick();
    }
  }

  // ---- 冠軍：只看訓練期 ----
  const champs = selectChampions(evals, { minTrades: cfg.minTrades });
  emit({ phase: 'validate', done: 0, total: 1 });

  // ---- 樣本外驗證：冠軍確定之後才計算 ----
  const details = {};
  const unique = new Set([champs.winRate, champs.netReturn, champs.stable].filter(Boolean).map((e) => e.id));
  for (const e of evals) {
    if (!unique.has(e.id)) continue;
    if (cancelled()) return { cancelled: true };
    details[e.id] = evaluateDetail(sig, e.strategy, costs, ranges);
  }
  emit({ phase: 'done', done: 1, total: 1 });
  return {
    cancelled: false,
    ranges,
    candidates: evals,
    champions: {
      winRate: champs.winRate ? champs.winRate.id : null,
      netReturn: champs.netReturn ? champs.netReturn.id : null,
      stable: champs.stable ? champs.stable.id : null,
    },
    eligibleCount: champs.eligibleCount,
    details,
    warnings,
    config: { ...cfg, tfs: cfg.tfs || [ds.baseTf] },
  };
}

/** 訓練 / 樣本外 / 全期間 完整回測（含逐筆交易與淨值曲線） */
export function evaluateDetail(sig, strategy, costs, ranges) {
  const train = runStrategy(sig, strategy, costs, ranges.train);
  const holdout = runStrategy(sig, strategy, costs, ranges.holdout);
  const full = runStrategy(sig, strategy, costs, ranges.full);
  return { train, holdout, full, strategy };
}

function compactMetrics(m) {
  const { monthly, ...rest } = m;
  return rest;
}
