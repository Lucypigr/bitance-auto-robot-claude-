// 價格行為掃描（事件研究）：
//   「市場有沒有反覆出現、扣掉交易成本後仍有正期望值的價格行為？」
// 做法：把條件目錄裡每一種價格行為（RSI 超賣、突破布林下軌、K 線型態…）當成一個「事件」，
// 事件在第 s 根收盤後成立 → 第 s+1 根開盤進場 → 持有 h 根後在開盤出場（和回測引擎的成交規則一致），
// 逐筆計算「扣掉手續費與滑價（台股另加證交稅）」後的報酬，再檢定它是不是顯著大於 0。
//
// 防止自己騙自己：
//  1. 訓練期／樣本外分開：用訓練期篩出候選，樣本外只拿來確認（不回頭挑）。
//  2. 事件互不重疊（持有期間內的新訊號不算），避免同一段走勢被重複計算。
//  3. 「超額報酬」：減掉同一檔、同一段期間、同一種行情下「任意時間點進場」的平均報酬，扣掉大盤漲跌的影響。
//     只有「平均淨報酬 > 0」且「超額報酬 > 0」同時顯著才算（取兩個 p 值較大者）。
//  4. 多重檢定：同時測幾百組，用 Benjamini–Hochberg 控制偽發現率（FDR）；樣本外確認再做一次。
//  5. 限制：不同標的同時間的走勢高度相關，事件之間並非完全獨立，p 值偏樂觀；資金費率未計入。
import { CONDITIONS } from './conditions.js';
import { regimeSeries, REGIME_DEFAULTS, REGIME_KEYS, validateRegimeParams } from './regime.js';

export const SCAN_DEFAULTS = { horizons: [1, 4, 12, 24, 48], minEvents: 30, byRegime: true, fdr: 0.1, regime: REGIME_DEFAULTS };

// ---------------- 統計小工具 ----------------
/** 標準常態的上尾機率 P(Z > t)（Numerical Recipes erfcc，相對誤差 < 1.2e-7） */
export function normSf(t) {
  const z = Math.abs(t) / Math.SQRT2;
  const k = 1 / (1 + 0.5 * z);
  const r = k * Math.exp(-z * z - 1.26551223 + k * (1.00002368 + k * (0.37409196 + k * (0.09678418 + k * (-0.18628806 + k * (0.27886807 + k * (-1.13520398 + k * (1.48851587 + k * (-0.82215223 + k * 0.17087277)))))))));
  const erfc = r;
  const sf = 0.5 * erfc;
  return t >= 0 ? sf : 1 - sf;
}

/** Benjamini–Hochberg 調整後的 q 值（與輸入同順序） */
export function bhQ(ps) {
  const m = ps.length;
  const order = ps.map((p, i) => [p, i]).sort((a, b) => a[0] - b[0]);
  const q = new Array(m);
  let prev = 1;
  for (let r = m - 1; r >= 0; r--) {
    prev = Math.min(prev, (order[r][0] * m) / (r + 1));
    q[order[r][1]] = Math.min(1, prev);
  }
  return q;
}

/** 單筆報酬（相對於進場名目金額）：進場開盤價含不利滑價、出場開盤價含不利滑價，手續費雙邊，台股另加賣出證交稅 */
export function tripReturn(dir, entryOpen, exitOpen, { fee, slippage, tax = 0 }) {
  if (dir > 0) {
    const en = entryOpen * (1 + slippage);
    const ex = exitOpen * (1 - slippage);
    return (ex * (1 - fee - tax)) / (en * (1 + fee)) - 1;
  }
  const en = entryOpen * (1 - slippage);
  const ex = exitOpen * (1 + slippage);
  return (en * (1 - fee) - ex * (1 + fee)) / en;
}

const newAcc = () => ({ n: 0, sum: 0, sumsq: 0, hit: 0 });
const push = (a, r) => { a.n++; a.sum += r; a.sumsq += r * r; if (r > 0) a.hit++; };
function summarize(a, base) {
  if (!a || a.n < 2) return { n: a ? a.n : 0, mean: 0, sd: 0, hit: 0, t: 0, p: 1, excess: 0, tEx: 0, pEx: 1, pUse: 1 };
  const mean = a.sum / a.n;
  const sd = Math.sqrt(Math.max(0, (a.sumsq - a.n * mean * mean) / (a.n - 1)));
  const se = sd / Math.sqrt(a.n) || 1e-12;
  const t = mean / se;
  const bm = base && base.n ? base.sum / base.n : 0;
  const excess = mean - bm;
  const tEx = excess / se;
  const p = normSf(t);
  const pEx = normSf(tEx);
  return { n: a.n, mean, sd, hit: a.hit / a.n, t, p, excess, tEx, pEx, pUse: Math.max(p, pEx), base: bm };
}

/**
 * 把「其實是同一批事件」的列合併：不同指標（布林下軌、Keltner 下軌、某些 K 線型態…）常常在同一根大跌 K 線上同時觸發，
 * 事件筆數與平均報酬完全一樣，只列一次，並記下還有哪些條件也一樣。
 */
export function clusterRows(rows) {
  const groups = new Map();
  for (const r of rows) {
    const k = `${r.dir}|${r.h}|${r.regime}|${r.train.n}|${r.train.mean.toFixed(8)}|${r.oos.n}|${r.oos.mean.toFixed(8)}`;
    const g = groups.get(k);
    if (g) g.same.push(r.label); else groups.set(k, { ...r, same: [] });
  }
  return [...groups.values()];
}

/** 掃描時要測的行為：條件目錄去掉「行情狀態」本身（它是分層用的） */
export function scanConditionIds() {
  return Object.keys(CONDITIONS).filter((id) => CONDITIONS[id].family !== 'regime');
}

/** 掃描項目：多數條件只測預設參數；斐波那契回撤另外分 38.2%／50%／61.8% 三個比例各測一次 */
export const SCAN_FIB_LEVELS = [0.382, 0.5, 0.618];
export function scanItems(ids = scanConditionIds()) {
  const items = [];
  for (const id of ids) {
    const def = CONDITIONS[id];
    if (def.family === 'fib') {
      for (const level of SCAN_FIB_LEVELS) items.push({ id, params: { level }, key: `${id}@${level}`, label: `${def.label} ${+(level * 100).toFixed(1)}%` });
    } else items.push({ id, params: {}, key: id, label: def.label });
  }
  return items;
}

/**
 * @param {SignalEngine} sig
 * @param {{fee:number, slippage:number, tax?:number, taxEtf?:number}} costs
 * @param {{train:{from:number,to:number}, holdout:{from:number,to:number}}} ranges
 */
export async function scanEdges(sig, costs, ranges, opts = {}, hooks = {}) {
  const o = { ...SCAN_DEFAULTS, ...opts };
  const ds = sig.ds;
  validateRegimeParams(o.regime);
  const items = o.items || scanItems(o.ids || scanConditionIds());
  const dirs = ds.market === 'perp' ? [1, -1] : [1];
  const segs = { train: ranges.train, oos: ranges.holdout };
  const tags = o.byRegime ? ['all', ...REGIME_KEYS] : ['all'];
  const regs = ds.symbols.map((_, si) => regimeSeries(ds, si, o.regime).regime);
  const taxOf = (S) => (ds.market === 'tw' ? (S.isEtf ? costs.taxEtf ?? 0.001 : costs.tax ?? 0.003) : 0);
  const tick = async () => { if (hooks.yield) await hooks.yield(); };
  const k4 = (dir, h, seg, tag) => `${dir}|${h}|${seg}|${tag}`;

  // 基準：同一檔、同一段期間、同一種行情下「任何一根都進場」的平均報酬
  const base = new Map();
  const getA = (map, key) => { let a = map.get(key); if (!a) { a = newAcc(); map.set(key, a); } return a; };
  for (let si = 0; si < ds.symbols.length; si++) {
    const S = ds.symbols[si];
    const c = { fee: costs.fee, slippage: costs.slippage, tax: taxOf(S) };
    for (const [seg, rg] of Object.entries(segs)) {
      const lo = Math.max(rg.from, S.first + 1);
      const hiBar = Math.min(rg.to - 1, S.last);
      for (const h of o.horizons) {
        for (let k = lo; k + h <= hiBar; k++) {
          const tag = regs[si][k - 1];
          for (const dir of dirs) {
            const r = tripReturn(dir, S.o[k], S.o[k + h], c);
            push(getA(base, k4(dir, h, seg, 'all')), r);
            if (o.byRegime && tag) push(getA(base, k4(dir, h, seg, tag)), r);
          }
        }
      }
    }
  }

  const accs = new Map(); // `${id}|${dir}|${h}|${seg}|${tag}` → acc
  const total = items.length;
  for (let ci = 0; ci < total; ci++) {
    if (hooks.cancelled && hooks.cancelled()) return { cancelled: true };
    const item = items[ci];
    const id = item.key;
    const spec = { id: item.id, tf: ds.baseTf, params: item.params, within: 1 };
    for (let si = 0; si < ds.symbols.length; si++) {
      const S = ds.symbols[si];
      const c = { fee: costs.fee, slippage: costs.slippage, tax: taxOf(S) };
      const idx = sig.entryIdx(si, [spec], 'edge');
      for (const [seg, rg] of Object.entries(segs)) {
        const hiBar = Math.min(rg.to - 1, S.last);
        for (const h of o.horizons) {
          let nextOk = -Infinity;
          for (let e = 0; e < idx.length; e++) {
            const k = idx[e] + 1;
            if (k < rg.from || k < S.first + 1) continue;
            if (k + h > hiBar) break;
            if (k < nextOk) continue; // 事件互不重疊
            nextOk = k + h;
            const tag = regs[si][idx[e]];
            for (const dir of dirs) {
              const r = tripReturn(dir, S.o[k], S.o[k + h], c);
              push(getA(accs, `${id}|${k4(dir, h, seg, 'all')}`), r);
              if (o.byRegime && tag) push(getA(accs, `${id}|${k4(dir, h, seg, tag)}`), r);
            }
          }
        }
      }
    }
    if (hooks.progress) hooks.progress({ done: ci + 1, total });
    await tick();
  }

  // 彙整成列
  const rows = [];
  for (const item of items) {
    const id = item.key;
    for (const dir of dirs) for (const h of o.horizons) for (const tag of tags) {
      const tr = summarize(accs.get(`${id}|${k4(dir, h, 'train', tag)}`), base.get(k4(dir, h, 'train', tag)));
      if (tr.n < o.minEvents) continue;
      const oo = summarize(accs.get(`${id}|${k4(dir, h, 'oos', tag)}`), base.get(k4(dir, h, 'oos', tag)));
      rows.push({ id: item.id, params: item.params, label: item.label, key: `${id}|${dir}|${h}|${tag}`, dir, h, regime: tag, train: tr, oos: oo });
    }
  }
  // 訓練期：BH 控制偽發現率
  const qs = bhQ(rows.map((r) => r.train.pUse));
  rows.forEach((r, i) => { r.train.q = qs[i]; r.selected = qs[i] <= o.fdr && r.train.mean > 0 && r.train.excess > 0; });
  // 樣本外：只確認被選出的；再做一次 BH
  const sel = rows.filter((r) => r.selected);
  const qo = bhQ(sel.map((r) => r.oos.pUse));
  sel.forEach((r, i) => {
    r.oos.q = qo[i];
    r.confirmed = r.oos.n >= Math.max(10, Math.floor(o.minEvents / 3)) && qo[i] <= o.fdr && r.oos.mean > 0 && r.oos.excess > 0;
  });
  rows.sort((a, b) => a.train.pUse - b.train.pUse);

  const baselines = [];
  for (const dir of dirs) for (const h of o.horizons) baselines.push({ dir, h, train: summarize(base.get(k4(dir, h, 'train', 'all')), null), oos: summarize(base.get(k4(dir, h, 'oos', 'all')), null) });
  const nTested = rows.length;
  return {
    cancelled: false, rows, baselines,
    summary: {
      nTested, nSelected: sel.length, nConfirmed: sel.filter((r) => r.confirmed).length,
      expectedFalse05: nTested * 0.05, nP05: rows.filter((r) => r.train.pUse < 0.05).length, fdr: o.fdr,
      nConditions: items.length, horizons: o.horizons, byRegime: o.byRegime,
    },
    config: { ...o },
  };
}
