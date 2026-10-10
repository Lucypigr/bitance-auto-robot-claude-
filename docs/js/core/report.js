// 匯出（CSV／JSON 快照）與並排比較 —— 全部是純函式，方便測試。
import { timeAt } from './util.js';

export const SNAP_VERSION = 1;
export const MAX_SAVED = 30;

// ---------------- CSV ----------------
/** CSV 欄位：文字開頭若是 = + - @ 會被試算表當成公式執行，前面補單引號；數字不處理 */
export function csvCell(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows) {
  return rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

const pad = (n) => String(n).padStart(2, '0');
/** 匯出一律用 UTC，並明寫，避免換電腦或時區後對不上 */
export function stamp(ds, ms) {
  const d = new Date(ms);
  const day = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  return ds.times ? day : `${day} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

const REASON = { tp: '停利', sl: '停損', trail: '移動停損', be: '保本出場', reverse: '反手', liq: '清算', signal: '出場訊號', time: '持倉期滿', end: '區間結束' };

export function tradesRows(res, ds) {
  const tag = (list, seg) => list.map((t) => ({ ...t, seg }));
  const trades = [...tag(res.train.trades, '訓練'), ...tag(res.holdout.trades, '樣本外')].sort((a, b) => a.exitIdx - b.exitIdx || a.entryIdx - b.entryIdx);
  const cur = ds.times ? 'TWD' : 'USDT';
  const rows = [['#', '期間', '代號', '名稱', '方向', `進場時間(UTC${ds.times ? '，日期' : ''})`, '進場價', '出場時間(UTC)', '出場價', '出場原因', '加碼次數', '分批出場次數', 'K數', '槓桿', `手續費(${cur})`, `Funding(${cur})`, `淨損益(${cur})`, '報酬率']];
  trades.forEach((t, i) => {
    const S = ds.symbols.find((s) => s.symbol === t.symbol);
    rows.push([i + 1, t.seg, t.symbol, (S && S.name) || '', t.dir > 0 ? '做多' : '做空', stamp(ds, t.entryTime), t.entryPrice, stamp(ds, t.exitTime), t.exitPrice, REASON[t.reason] || t.reason, t.legs ? t.legs.filter((x) => x.kind === 'add').length : 0, t.legs ? t.legs.filter((x) => x.kind === 'partial').length : 0, t.bars, t.lev, t.fee, t.funding, t.pnl, t.ret]);
  });
  return rows;
}

/** 淨值曲線：訓練期、樣本外各自獨立重跑，這裡與圖表相同，把樣本外接在訓練期期末淨值後 */
export function chainedEquity(res, capital) {
  const tr = res.train.equity;
  const oo = res.holdout.equity;
  const trEnd = tr.length ? tr[tr.length - 1] : capital;
  const out = new Float64Array(tr.length + oo.length);
  out.set(tr, 0);
  for (let i = 0; i < oo.length; i++) out[tr.length + i] = oo[i] * (trEnd / capital);
  return out;
}

export function equityRows(res, ds, capital, bh) {
  const eq = chainedEquity(res, capital);
  const nTrain = res.train.equity.length;
  const from = res.ranges.train.from;
  const rows = [['時間(UTC，K線收盤)', '期間', '策略淨值', '買入持有淨值']];
  for (let i = 0; i < eq.length; i++) {
    const idx = from + i;
    const t = ds.times ? timeAt(ds, idx) : timeAt(ds, idx + 1);
    rows.push([stamp(ds, t), i < nTrain ? '訓練' : '樣本外', eq[i], bh && i < bh.length ? bh[i] : null]);
  }
  return rows;
}

/** 走動式驗證：各折測試期串接後的淨值（與買入持有） */
export function wfChainRows(wf, ds, capital) {
  const rows = [['時間(UTC，K線收盤)', '走動式驗證淨值', '買入持有淨值']];
  for (let i = 0; i < wf.chain.length; i++) {
    const idx = wf.range.from + i;
    const t = ds.times ? timeAt(ds, idx) : timeAt(ds, idx + 1);
    rows.push([stamp(ds, t), wf.chain[i] * capital, wf.bhChain[i] * capital]);
  }
  return rows;
}

export function boardRows(result) {
  const rows = [['編號', '策略', '訓練期交易數', '訓練期勝率', '訓練期淨報酬', '訓練期最大回撤', '訓練期PF', '訓練期Sharpe', '訓練期清算次數', '穩定度分數', '冠軍']];
  const champ = new Map();
  const names = { winRate: '最高勝率', netReturn: '最高淨報酬', stable: '最穩定' };
  for (const [k, id] of Object.entries(result.champions || {})) if (id) champ.set(id, [...(champ.get(id) || []), names[k]]);
  for (const e of result.candidates) {
    const m = e.train;
    rows.push([e.id, e.desc, m.trades, m.winRate, m.netReturn, m.maxDrawdown, Number.isFinite(m.profitFactor) ? m.profitFactor : null, m.sharpe, m.liquidations, e.stability, (champ.get(e.id) || []).join('／')]);
  }
  return rows;
}

export function foldsRows(wf, ds) {
  const rows = [['折', '訓練開始(UTC)', '訓練結束', '測試開始', '測試結束', '採用策略', '訓練報酬', '測試報酬', '測試交易數', '同期買入持有']];
  for (const f of wf.folds) {
    rows.push([f.k, stamp(ds, timeAt(ds, f.train.from)), stamp(ds, timeAt(ds, f.train.to - 1)), stamp(ds, timeAt(ds, f.test.from)), stamp(ds, timeAt(ds, f.test.to - 1)),
      f.hasChampion ? f.desc : '（沒有合格冠軍，空手）', f.trainMetrics ? f.trainMetrics.netReturn : null, f.testMetrics.netReturn, f.testMetrics.trades, f.buyHold]);
  }
  return rows;
}

// ---------------- 快照（儲存 / 匯出 JSON / 比較）----------------
export const METRIC_KEYS = ['netReturn', 'cagr', 'winRate', 'maxDrawdown', 'profitFactor', 'sharpe', 'sortino', 'expectancyPct', 'trades', 'wins', 'losses', 'maxLosingStreak', 'positiveMonths', 'totalMonths', 'positiveSymbols', 'symbolCount', 'funding', 'fees', 'liquidations', 'liqProximity', 'leverage', 'finalEquity', 'initial', 'shortPeriod'];
const INF = 1e9; // JSON 不能存 Infinity

export function compactMetrics(m) {
  const o = {};
  for (const k of METRIC_KEYS) {
    let v = m[k];
    if (typeof v === 'boolean') { o[k] = v; continue; }
    if (typeof v !== 'number' || Number.isNaN(v)) v = 0;
    if (!Number.isFinite(v)) v = v > 0 ? INF : -INF;
    o[k] = v;
  }
  return o;
}

function thin(arr, max) {
  if (arr.length <= max) return Array.from(arr);
  const k = (arr.length - 1) / (max - 1);
  const out = [];
  for (let i = 0; i < max; i++) out.push(arr[Math.round(i * k)]);
  return out;
}
const r4 = (x) => (Number.isFinite(x) ? Math.round(x * 1e4) / 1e4 : 0);

export function makeSnapshot({ res, ds, strategy, costsRaw, useMark, trainFrac, days, market, baseTf, desc, name, bh, now = Date.now(), id }) {
  const capital = res.train.metrics.initial;
  const eq = chainedEquity(res, capital);
  const from = res.ranges.train.from;
  const times = [];
  for (let i = 0; i < eq.length; i++) times.push(ds.times ? timeAt(ds, from + i) : timeAt(ds, from + i + 1));
  const N = 260;
  const idx = thin(Array.from({ length: eq.length }, (_, i) => i), N);
  return {
    v: SNAP_VERSION,
    id: id || `r${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    name: String(name || desc || '未命名').slice(0, 80),
    savedAt: now,
    market, baseTf, days, trainFrac,
    symbols: ds.symbols.map((s) => ({ symbol: s.symbol, name: s.name || '' })),
    costsRaw: { ...costsRaw }, useMark: !!useMark,
    strategy: JSON.parse(JSON.stringify(strategy)),
    desc: String(desc || ''),
    window: { from: times[0] || 0, to: times[times.length - 1] || 0, splitT: res.train.equity.length ? times[res.train.equity.length - 1] : 0 },
    metrics: { train: compactMetrics(res.train.metrics), oos: compactMetrics(res.holdout.metrics), full: compactMetrics(res.full.metrics) },
    curve: { t: idx.map((i) => times[i]), eq: idx.map((i) => r4(eq[i])), bh: bh ? idx.map((i) => (i < bh.length ? r4(bh[i]) : null)) : null },
  };
}

const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');

/** 匯入的 JSON 不可信：重新逐欄檢查、截斷長度，丟掉未知欄位 */
export function validateSnapshot(o) {
  if (!o || typeof o !== 'object' || o.v !== SNAP_VERSION) throw new Error('不是這個平台匯出的回測檔（版本不符）');
  if (!['perp', 'spot', 'tw'].includes(o.market)) throw new Error('回測檔的市場欄位不正確');
  if (!o.strategy || typeof o.strategy !== 'object' || !Array.isArray(o.strategy.entry)) throw new Error('回測檔缺少策略內容');
  if (!o.metrics || !o.metrics.train || !o.metrics.oos) throw new Error('回測檔缺少績效資料');
  const cleanM = (m) => { const out = {}; for (const k of METRIC_KEYS) out[k] = typeof m[k] === 'boolean' ? m[k] : num(m[k]); return out; };
  const cl = o.curve || {};
  const len = Array.isArray(cl.t) ? Math.min(cl.t.length, 400) : 0;
  const t = [];
  const eq = [];
  const bh = [];
  for (let i = 0; i < len; i++) {
    if (!Number.isFinite(cl.t[i]) || !Number.isFinite(cl.eq && cl.eq[i])) continue;
    t.push(cl.t[i]); eq.push(cl.eq[i]);
    bh.push(cl.bh && Number.isFinite(cl.bh[i]) ? cl.bh[i] : null);
  }
  const strategy = JSON.parse(JSON.stringify(o.strategy));
  if (strategy.entry.length > 12 || (strategy.exit || []).length > 12) throw new Error('回測檔的條件數量不合理');
  return {
    v: SNAP_VERSION,
    id: str(o.id, 40).replace(/[^\w-]/g, '') || `r${Date.now().toString(36)}`,
    name: str(o.name, 80) || '匯入的回測',
    savedAt: num(o.savedAt, Date.now()),
    market: o.market, baseTf: str(o.baseTf, 4), days: num(o.days), trainFrac: Math.min(0.9, Math.max(0.2, num(o.trainFrac, 0.7))),
    symbols: (Array.isArray(o.symbols) ? o.symbols : []).slice(0, 15).map((s) => ({ symbol: str(s && s.symbol, 24), name: str(s && s.name, 40) })).filter((s) => s.symbol),
    costsRaw: Object.fromEntries(Object.entries(o.costsRaw || {}).filter(([, v]) => typeof v === 'number' && Number.isFinite(v)).slice(0, 20)),
    useMark: !!o.useMark,
    strategy,
    desc: str(o.desc, 600),
    window: { from: num(o.window && o.window.from), to: num(o.window && o.window.to), splitT: num(o.window && o.window.splitT) },
    metrics: { train: cleanM(o.metrics.train), oos: cleanM(o.metrics.oos), full: cleanM(o.metrics.full || o.metrics.oos) },
    curve: { t, eq, bh: bh.some((x) => x !== null) ? bh : null },
  };
}

/** 匯出 / 匯入的檔案格式：單一快照，或 { kind:'bt-library', runs:[…] } */
export function exportJson(snaps) {
  return JSON.stringify(snaps.length === 1 ? snaps[0] : { kind: 'bt-library', v: SNAP_VERSION, runs: snaps }, null, 1);
}

export function parseImport(text) {
  if (typeof text !== 'string' || text.length > 8e6) throw new Error('檔案太大或格式不正確');
  let o;
  try { o = JSON.parse(text); } catch { throw new Error('不是有效的 JSON 檔案'); }
  const list = o && o.kind === 'bt-library' && Array.isArray(o.runs) ? o.runs : [o];
  if (list.length > MAX_SAVED) throw new Error(`一次最多匯入 ${MAX_SAVED} 筆`);
  return list.map(validateSnapshot);
}

// ---------------- 並排比較 ----------------
const ROWS = [
  ['netReturn', '淨報酬', 'pct', 'high'],
  ['cagr', '年化報酬', 'pct', 'high'],
  ['winRate', '勝率', 'pct', 'high'],
  ['maxDrawdown', '最大回撤', 'pct', 'low'],
  ['profitFactor', 'Profit Factor', 'num', 'high'],
  ['sharpe', 'Sharpe', 'num', 'high'],
  ['sortino', 'Sortino', 'num', 'high'],
  ['expectancyPct', '每筆期望報酬', 'pct', 'high'],
  ['trades', '交易次數', 'int', null],
  ['maxLosingStreak', '最長連敗', 'int', 'low'],
  ['liquidations', '清算次數', 'int', 'low'],
  ['leverage', '槓桿', 'x', null],
];

/** seg: 'oos' | 'train' | 'full'；沒有交易的欄位不參與「最佳」判斷（避免 0 筆交易的 0% 被當成最好） */
export function compareRows(snaps, seg = 'oos') {
  return ROWS.map(([key, label, fmt, better]) => {
    const values = snaps.map((s) => s.metrics[seg][key]);
    let best = -1;
    if (better) {
      values.forEach((v, i) => {
        if (!snaps[i].metrics[seg].trades) return;
        if (best < 0 || (better === 'high' ? v > values[best] : v < values[best])) best = i;
      });
      if (best >= 0 && values.filter((v, i) => snaps[i].metrics[seg].trades && v === values[best]).length > 1) best = -1; // 平手不標示
    }
    return { key, label, fmt, better, values, best };
  });
}

/** 設定不同的回測，數字不能直接比；回傳要提醒的原因 */
export function compareWarnings(snaps) {
  const out = [];
  const uniq = (f) => new Set(snaps.map(f)).size > 1;
  if (uniq((s) => s.market)) out.push('市場不同（現貨／永續／台股），成本與交易規則不同，數字不能直接比較。');
  if (uniq((s) => s.baseTf)) out.push('執行週期不同。');
  if (uniq((s) => JSON.stringify(s.symbols.map((x) => x.symbol).sort()))) out.push('回測的標的不同。');
  const days = (a) => Math.round((a.to - a.from) / 864e5);
  if (uniq((s) => Math.round(days(s.window) / 5)) || uniq((s) => new Date(s.window.from).toISOString().slice(0, 10))) out.push('資料期間不同：行情不同，績效差異可能只是因為遇到不同的行情。');
  if (uniq((s) => Math.round(s.trainFrac * 100))) out.push('訓練／樣本外比例不同，「樣本外」的長度與時間不一樣。');
  if (uniq((s) => `${s.costsRaw.feePct}|${s.costsRaw.slipPct}|${s.costsRaw.capital}`)) out.push('手續費、滑價或本金不同。');
  return out;
}

/** 淨值曲線：各自換算成起點 = 100，方便疊在一起看 */
export function normalizedCurves(snaps) {
  return snaps.map((s) => {
    const base = s.curve.eq[0] || 1;
    return { id: s.id, name: s.name, points: s.curve.t.map((t, i) => ({ t, v: (s.curve.eq[i] / base) * 100 })), splitT: s.window.splitT };
  });
}

/** 價格行為掃描結果的 CSV 列 */
export function scanRows(scan, regimeLabel) {
  const rows = [['行為', '方向', '持有根數', '行情', '訓練筆數', '訓練平均淨報酬', '訓練超額報酬', '訓練勝率', '訓練p值', '訓練q值(FDR)', '樣本外筆數', '樣本外平均淨報酬', '樣本外超額報酬', '樣本外p值', '樣本外q值', '訓練期通過', '樣本外確認']];
  for (const r of scan.rows) {
    rows.push([r.label, r.dir > 0 ? '做多' : '做空', r.h, r.regime === 'all' ? '全部' : regimeLabel[r.regime], r.train.n, r.train.mean, r.train.excess, r.train.hit, r.train.pUse, r.train.q, r.oos.n, r.oos.mean, r.oos.excess, r.oos.pUse, r.oos.q ?? null, r.selected ? '是' : '否', r.confirmed ? '是' : r.selected ? '否' : '']);
  }
  return rows;
}
