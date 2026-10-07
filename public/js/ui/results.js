// 結果頁面的各個區塊
import { term, esc } from './info.js';
import { fmtPct, fmtNum, fmtMoney, fmtPrice, fmtTime, fmtDate, signClass } from './format.js';
import { candleChart, lineChart, toChartTime, cssVar } from './charts.js';
import * as I from '../core/indicators.js';
import { CONDITIONS, describeSpec, specKey } from '../core/conditions.js';
import { risingEdges } from '../core/signals.js';
import { symbolBreakdown } from '../core/breakdown.js';

const REASON = { tp: '停利', sl: '停損', trail: '移動停損', liq: '清算', signal: '出場訊號', time: '持倉期滿', end: '區間結束' };
const pfText = (pf) => (Number.isFinite(pf) ? fmtNum(pf) : pf > 0 ? '∞' : '—');

// ---------------- 績效比較表 ----------------
const ROWS = [
  ['net_return', '淨報酬', (m) => fmtPct(m.netReturn, 1, true), (m) => signClass(m.netReturn)],
  ['cagr', '年化報酬 CAGR', (m) => fmtPct(m.cagr, 1, true) + (m.shortPeriod ? ' *' : ''), (m) => signClass(m.cagr)],
  ['winrate', '勝率', (m) => (m.trades ? fmtPct(m.winRate) : '—')],
  ['drawdown', '最大回撤', (m) => fmtPct(-m.maxDrawdown), (m) => (m.maxDrawdown > 0.3 ? 'neg' : '')],
  ['pf', 'Profit Factor', (m) => pfText(m.profitFactor), (m) => (m.trades ? (m.profitFactor > 1 ? 'pos' : 'neg') : '')],
  ['sharpe', 'Sharpe', (m) => fmtNum(m.sharpe)],
  ['sortino', 'Sortino', (m) => fmtNum(m.sortino)],
  ['avg_win_loss', '平均盈利／平均虧損', (m) => (m.trades ? `${fmtMoney(m.avgWin)} ／ ${fmtMoney(m.avgLoss)}` : '—')],
  ['expectancy', '每筆期望值', (m) => (m.trades ? `${fmtMoney(m.expectancy, 2, true)}（${fmtPct(m.expectancyPct, 2, true)}）` : '—'), (m) => signClass(m.expectancy)],
  ['losing_streak', '最長連敗', (m) => `${m.maxLosingStreak} 筆`],
  ['trades', '交易次數', (m) => `${m.trades}`, (m) => (m.trades < 20 ? 'neg' : '')],
  ['positive_months', '正報酬月份', (m) => `${m.positiveMonths} ／ ${m.totalMonths}`],
  ['cross_symbol', '跨幣正報酬比例', (m) => `${m.positiveSymbols} ／ ${m.symbolCount}（${fmtPct(m.positiveSymbolRatio, 0)}）`],
  ['funding', 'Funding 合計', (m) => fmtMoney(m.funding, 2, true), (m) => signClass(m.funding)],
  ['fee', '手續費合計', (m) => fmtMoney(-m.fees)],
  ['liquidation', '清算次數', (m) => `${m.liquidations}`, (m) => (m.liquidations ? 'neg' : '')],
  ['liq_risk', '清算風險（最近距離）', (m) => fmtPct(m.liqProximity, 0), (m) => (m.liqProximity >= 0.7 ? 'neg' : '')],
  ['leverage', '槓桿', (m) => `${m.leverage}×`],
];

export function renderCompare(el, res, ds) {
  const r = res.ranges;
  const cap = (rg) => `${fmtDate(ds.t0 + rg.from * ds.baseMs)} ～ ${fmtDate(ds.t0 + rg.to * ds.baseMs - 1)}`;
  const trainPct = Math.round((100 * (r.train.to - r.train.from)) / (r.full.to - r.full.from));
  const cols = [
    ['col-train', term('training', `訓練期 ${trainPct}%`), cap(r.train), res.train.metrics],
    ['col-oos', term('oos', `樣本外 ${100 - trainPct}%`), cap(r.holdout), res.holdout.metrics],
    ['', '全期間（參考）', cap(r.full), res.full.metrics],
  ];
  const head = cols.map(([c, t, d]) => `<th class="${c}">${t}<div class="muted small">${d}</div></th>`).join('');
  const body = ROWS.map(([key, label, fn, cls]) => `<tr><td>${term(key, label)}</td>${cols.map(([, , , m]) => `<td class="${cls ? cls(m) : ''}">${fn(m)}</td>`).join('')}</tr>`).join('');
  const anyShort = cols.some(([, , , m]) => m.shortPeriod);
  el.innerHTML = `<h2>訓練期 vs 樣本外</h2>
    <div class="tbl-wrap"><table class="tbl compare" data-testid="compare"><thead><tr><th></th>${head}</tr></thead><tbody>${body}</tbody></table></div>
    <div class="muted small">「全期間」是另外整段重跑的參考，包含樣本外，<b>不可</b>用來挑選策略。${anyShort ? ' ＊期間不足 3 個月，年化數字僅供參考。' : ''}</div>`;
}

// ---------------- 白話解讀 ----------------
export function verdict(res) {
  const tr = res.train.metrics;
  const oo = res.holdout.metrics;
  const list = [];
  const add = (level, text) => list.push({ level, text });
  if (oo.trades < 10) add('warn', `樣本外只有 ${oo.trades} 筆交易，樣本太少，結果參考價值有限（可以拉長資料或增加幣種）。`);
  if (tr.netReturn > 0 && oo.netReturn > 0) add('good', `訓練期 ${fmtPct(tr.netReturn, 1, true)}、樣本外 ${fmtPct(oo.netReturn, 1, true)}：兩段都獲利，這是比較好的跡象。但回測不代表未來績效。`);
  else if (tr.netReturn > 0 && oo.netReturn <= 0) add('bad', `訓練期賺 ${fmtPct(tr.netReturn)}，樣本外卻是 ${fmtPct(oo.netReturn, 1, true)}：這是典型的「過度擬合」警訊——策略可能只是貼合了過去那段行情。`);
  else if (tr.netReturn <= 0 && oo.netReturn > 0) add('warn', `訓練期虧損（${fmtPct(tr.netReturn, 1, true)}）、樣本外獲利（${fmtPct(oo.netReturn, 1, true)}）：可能只是樣本外那段行情剛好適合，不代表策略有效。`);
  else add('bad', `訓練期與樣本外都沒有獲利（${fmtPct(tr.netReturn, 1, true)}／${fmtPct(oo.netReturn, 1, true)}），這組策略目前看不到優勢。`);
  for (const [label, m] of [['訓練期', tr], ['樣本外', oo]]) {
    if (m.trades >= 10 && m.winRate >= 0.6 && m.profitFactor < 1.1) add('warn', `${label}勝率 ${fmtPct(m.winRate, 0)} 看起來高，但 Profit Factor 只有 ${pfText(m.profitFactor)}：賺的少、賠的多，高勝率不代表賺錢。`);
  }
  const liq = tr.liquidations + oo.liquidations;
  if (liq > 0) add('bad', `回測期間共發生 ${liq} 次清算（保證金被強制平倉）。降低槓桿或加上更近的停損。`);
  else if (Math.max(tr.liqProximity, oo.liqProximity) >= 0.7) add('warn', `雖然沒有被清算，但最危險的一筆曾走到離清算價 ${fmtPct(Math.max(tr.liqProximity, oo.liqProximity), 0)} 的距離，風險偏高。`);
  const dd = Math.max(tr.maxDrawdown, oo.maxDrawdown);
  if (dd >= 0.3) add('warn', `最大回撤達 ${fmtPct(dd, 0)}：過程中資金曾從高點損失三成以上，請想想自己能不能承受。`);
  if (tr.symbolCount >= 3 && tr.positiveSymbolRatio < 0.5) add('warn', `訓練期只有 ${tr.positiveSymbols}／${tr.symbolCount} 個幣種賺錢，可能只適合少數幣種。`);
  if (tr.trades < 20) add('warn', `訓練期只有 ${tr.trades} 筆交易，不到 20 筆，統計結果容易是運氣。`);
  add('info', '回測不代表未來績效；成本（手續費、滑價、資金費率）已計入，但真實交易還有更多不確定性。');
  return list;
}

export function renderVerdict(el, res) {
  el.innerHTML = `<h2>白話解讀</h2><ul class="verdict-list" data-testid="verdict">${verdict(res).map((v) => `<li class="${v.level}">${esc(v.text)}</li>`).join('')}</ul>`;
}

// ---------------- 冠軍卡片 ----------------
export function oosBadge(train, oos) {
  if (!oos) return '<span class="badge neutral">—</span>';
  if (oos.trades < 10) return `<span class="badge warn">樣本外交易太少（${oos.trades} 筆）</span>`;
  if (oos.netReturn > 0 && oos.profitFactor > 1) return '<span class="badge good">✓ 樣本外仍獲利</span>';
  if (oos.netReturn > 0) return '<span class="badge warn">樣本外微幅獲利</span>';
  return '<span class="badge bad">✗ 樣本外虧損，疑似過度擬合</span>';
}

export function renderChampions(el, result) {
  const defs = [
    ['winRate', 'champion_winrate', '最高勝率'],
    ['netReturn', 'champion_return', '最高淨報酬'],
    ['stable', 'champion_stable', '最穩定'],
  ];
  el.innerHTML = defs.map(([k, termKey, title]) => {
    const id = result.champions[k];
    if (!id) {
      const why = k === 'stable' ? '沒有任何候選同時符合：交易數足夠、無清算、訓練期獲利且 PF>1。這本身是重要的結果：目前的搜尋範圍找不到穩健的組合。' : '沒有任何候選達到最低交易數且訓練期無清算。可以降低最低交易數、增加幣種或拉長資料。';
      return `<div class="champ empty-champ" data-testid="champ-${k}"><h3>${term(termKey, title)}</h3><div class="desc">無</div><div class="muted small">${why}</div></div>`;
    }
    const e = result.candidates.find((c) => c.id === id);
    const d = result.details[id];
    const t = d.train.metrics;
    const o = d.holdout.metrics;
    return `<div class="champ" data-testid="champ-${k}" data-id="${id}">
      <h3>${term(termKey, title)} ${oosBadge(t, o)}</h3>
      <div class="desc">${esc(e.desc)}</div>
      <table class="tbl"><thead><tr><th></th><th>訓練期</th><th>樣本外</th></tr></thead><tbody>
        <tr><td>淨報酬</td><td class="${signClass(t.netReturn)}">${fmtPct(t.netReturn, 1, true)}</td><td class="${signClass(o.netReturn)}">${fmtPct(o.netReturn, 1, true)}</td></tr>
        <tr><td>勝率</td><td>${fmtPct(t.winRate, 0)}</td><td>${o.trades ? fmtPct(o.winRate, 0) : '—'}</td></tr>
        <tr><td>PF</td><td>${pfText(t.profitFactor)}</td><td>${pfText(o.profitFactor)}</td></tr>
        <tr><td>最大回撤</td><td>${fmtPct(-t.maxDrawdown, 0)}</td><td>${fmtPct(-o.maxDrawdown, 0)}</td></tr>
        <tr><td>交易數</td><td>${t.trades}</td><td>${o.trades}</td></tr>
      </tbody></table>
      <button type="button" class="btn small" data-open="${id}">查看完整回測</button>
    </div>`;
  }).join('');
}

// ---------------- 候選排行榜 ----------------
const BOARD_COLS = [
  ['rank', '#', null],
  ['desc', '策略', null],
  ['winRate', '勝率', (e) => fmtPct(e.train.winRate, 0)],
  ['netReturn', '淨報酬', (e) => fmtPct(e.train.netReturn, 1, true)],
  ['maxDrawdown', '最大回撤', (e) => fmtPct(-e.train.maxDrawdown, 0)],
  ['profitFactor', 'PF', (e) => pfText(e.train.profitFactor)],
  ['sharpe', 'Sharpe', (e) => fmtNum(e.train.sharpe)],
  ['trades', '交易數', (e) => `${e.train.trades}`],
  ['stability', '穩定度', (e) => fmtNum(e.stability, 0)],
  ['liquidations', '清算', (e) => `${e.train.liquidations}`],
];
const COL_TERM = { winRate: 'winrate', netReturn: 'net_return', maxDrawdown: 'drawdown', profitFactor: 'pf', sharpe: 'sharpe', trades: 'trades', stability: 'stability_score', liquidations: 'liquidation' };

export function sortValue(e, key) {
  if (key === 'stability') return e.stability;
  if (key === 'desc') return e.desc;
  return e.train[key];
}

export function renderBoard(el, result, sort, minTrades) {
  const trainPct = Math.round(result.config.trainFrac * 100);
  const rows = result.candidates.slice();
  const dirMul = sort.dir === 'asc' ? 1 : -1;
  rows.sort((a, b) => {
    const va = sortValue(a, sort.key); const vb = sortValue(b, sort.key);
    const x = typeof va === 'string' ? va.localeCompare(vb) : (Number.isFinite(va) ? va : 1e9) - (Number.isFinite(vb) ? vb : 1e9);
    return x * dirMul || a.index - b.index;
  });
  const champIds = new Set(Object.values(result.champions).filter(Boolean));
  const head = BOARD_COLS.map(([k, label]) => {
    const arrow = sort.key === k ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : '';
    const lab = COL_TERM[k] ? term(COL_TERM[k], label) : esc(label);
    return k === 'rank' ? `<th>${label}</th>` : `<th data-sort="${k}" class="${k === 'desc' ? 'txt' : ''}">${lab}${arrow}</th>`;
  }).join('');
  const body = rows.map((e, i) => {
    const bad = e.train.trades < minTrades ? `交易數不足 ${minTrades}` : e.train.liquidations > 0 ? '訓練期曾清算' : '';
    const star = champIds.has(e.id) ? '🏆 ' : '';
    return `<tr class="clickable ${bad ? 'dim' : ''}" data-id="${e.id}" ${bad ? `title="不得成為冠軍：${bad}"` : ''}>
      <td>${i + 1}</td><td class="txt">${star}${esc(e.desc)}${bad ? ` <span class="badge neutral">${bad}</span>` : ''}</td>
      ${BOARD_COLS.slice(2).map(([, , fn]) => `<td>${fn(e)}</td>`).join('')}</tr>`;
  }).join('');
  el.innerHTML = `<div class="note info">排行榜<b>只顯示訓練期（前 ${trainPct}%）</b>的成績。點選任一列可查看完整回測（含樣本外）。請<b>不要</b>因為看到某組的樣本外特別好就改選它——那樣樣本外就不再是公平的驗證了。（共 ${rows.length} 組候選，${term('overfitting', '測越多組越容易碰巧挑到運氣好的')}。）</div>
    <div class="tbl-wrap" style="max-height:520px;overflow:auto"><table class="tbl sortable" data-testid="board"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

// ---------------- 逐筆交易 ----------------
export function allTrades(res) {
  return [
    ...res.train.trades.map((t) => ({ ...t, seg: '訓練' })),
    ...res.holdout.trades.map((t) => ({ ...t, seg: '樣本外' })),
  ].sort((a, b) => a.exitIdx - b.exitIdx || a.entryIdx - b.entryIdx);
}

export function renderTrades(el, res, ds, view) {
  let trades = allTrades(res);
  if (view.seg) trades = trades.filter((t) => t.seg === view.seg);
  if (view.symbol) trades = trades.filter((t) => t.symbol === view.symbol);
  const per = 30;
  const pages = Math.max(1, Math.ceil(trades.length / per));
  view.page = Math.min(Math.max(0, view.page), pages - 1);
  const slice = trades.slice(view.page * per, view.page * per + per);
  const syms = ds.symbols.map((s) => s.symbol);
  const rows = slice.map((t, i) => `<tr>
    <td>${view.page * per + i + 1}</td><td>${t.seg}</td><td>${esc(t.symbol)}</td><td class="${t.dir > 0 ? 'pos' : 'neg'}">${t.dir > 0 ? '做多' : '做空'}</td>
    <td>${fmtTime(t.entryTime)}</td><td>${fmtPrice(t.entryPrice)}</td><td>${fmtTime(t.exitTime)}</td><td>${fmtPrice(t.exitPrice)}</td>
    <td>${REASON[t.reason] || t.reason}</td><td>${t.bars}</td><td>${t.lev}×</td><td>${fmtMoney(t.fee)}</td><td class="${signClass(t.funding)}">${fmtMoney(t.funding, 2, true)}</td>
    <td class="${signClass(t.pnl)}">${fmtMoney(t.pnl, 2, true)}</td><td class="${signClass(t.ret)}">${fmtPct(t.ret, 2, true)}</td></tr>`).join('');
  el.innerHTML = `<div class="chart-tools">
      <label>期間 <select id="tr-seg"><option value="">全部</option><option ${view.seg === '訓練' ? 'selected' : ''}>訓練</option><option ${view.seg === '樣本外' ? 'selected' : ''}>樣本外</option></select></label>
      <label>幣種 <select id="tr-sym"><option value="">全部</option>${syms.map((s) => `<option ${view.symbol === s ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select></label>
      <span class="muted small">共 ${trades.length} 筆；報酬% = 該筆淨損益 ÷ 進場前資金袋淨值</span></div>
    <div class="tbl-wrap"><table class="tbl" data-testid="trades"><thead><tr><th>#</th><th>期間</th><th>幣種</th><th>方向</th><th>進場時間</th><th>進場價</th><th>出場時間</th><th>出場價</th><th>原因</th><th>K 數</th><th>槓桿</th><th>手續費</th><th>Funding</th><th>淨損益 USDT</th><th>報酬</th></tr></thead><tbody>${rows || '<tr><td colspan="15" class="muted">沒有交易</td></tr>'}</tbody></table></div>
    <div class="pager"><button class="btn small" id="tr-prev" ${view.page === 0 ? 'disabled' : ''}>上一頁</button> ${view.page + 1} ／ ${pages} <button class="btn small" id="tr-next" ${view.page >= pages - 1 ? 'disabled' : ''}>下一頁</button></div>`;
}

// ---------------- 每月報酬 ----------------
export function renderMonthly(el, res) {
  const cells = new Map();
  for (const m of res.train.metrics.monthly) cells.set(m.month, { train: m.ret });
  for (const m of res.holdout.metrics.monthly) { const c = cells.get(m.month) || {}; c.oos = m.ret; cells.set(m.month, c); }
  const months = [...cells.keys()].sort();
  if (!months.length) { el.innerHTML = '<div class="muted">沒有資料</div>'; return; }
  const years = [...new Set(months.map((m) => m.slice(0, 4)))];
  const color = (r) => {
    const a = Math.min(80, Math.round((Math.abs(r) / 0.15) * 80));
    return `color-mix(in srgb, var(${r >= 0 ? '--up' : '--down'}) ${a}%, var(--panel-2))`;
  };
  const cell = (c) => {
    if (!c) return '<td></td>';
    const parts = [];
    if (c.train !== undefined) parts.push(`<div style="background:${color(c.train)};border-radius:4px;padding:2px">${c.oos !== undefined ? '訓 ' : ''}${fmtPct(c.train, 1, true)}</div>`);
    if (c.oos !== undefined) parts.push(`<div style="background:${color(c.oos)};border-radius:4px;padding:2px;margin-top:2px">${c.train !== undefined ? '外 ' : ''}${fmtPct(c.oos, 1, true)}</div>`);
    return `<td class="${c.train === undefined ? 'oos' : ''}">${parts.join('')}</td>`;
  };
  const rows = years.map((y) => `<tr><th>${y}</th>${Array.from({ length: 12 }, (_, i) => cell(cells.get(`${y}-${String(i + 1).padStart(2, '0')}`))).join('')}</tr>`).join('');
  el.innerHTML = `<div class="tbl-wrap"><table class="heat" data-testid="monthly"><thead><tr><th></th>${Array.from({ length: 12 }, (_, i) => `<th>${i + 1} 月</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>
    <div class="muted small">虛線框＝樣本外的月份；跨越切割日的月份會分成「訓」「外」兩個數字。每月報酬 = 該月底淨值 ÷ 上月底淨值 − 1。</div>`;
}

// ---------------- 圖表 ----------------
function downsample(arr, max = 20000) {
  if (arr.length <= max) return arr;
  const k = Math.ceil(arr.length / max);
  const out = [];
  for (let i = 0; i < arr.length; i += k) out.push(arr[i]);
  if (out[out.length - 1] !== arr[arr.length - 1]) out.push(arr[arr.length - 1]);
  return out;
}

function seriesPoints(ds, range, values, scale = 1) {
  const pts = [];
  for (let i = 0; i < values.length; i++) {
    pts.push({ time: toChartTime(ds.t0 + (range.from + i + 1) * ds.baseMs), value: values[i] * scale });
  }
  return pts;
}

/** 等權重買入持有（比較基準）：資金平均分配、期初買進、不動 */
export function buyHoldCurve(ds, range, capital) {
  const len = range.to - range.from;
  const out = new Float64Array(len);
  const per = capital / ds.symbols.length;
  for (const S of ds.symbols) {
    const st = Math.max(S.first, range.from);
    const ref = S.o[st];
    for (let i = 0; i < len; i++) {
      const idx = range.from + i;
      if (idx < st) out[i] += per;
      else {
        const c = S.c[Math.min(idx, S.last)];
        out[i] += per * (c / ref);
      }
    }
  }
  return out;
}

export function buildEquityChart(el, res, ds, capital) {
  const tr = res.train;
  const oo = res.holdout;
  const trEnd = tr.equity.length ? tr.equity[tr.equity.length - 1] : capital;
  const bh = buyHoldCurve(ds, res.ranges.full, capital);
  const trPts = downsample(seriesPoints(ds, res.ranges.train, tr.equity));
  // 樣本外是獨立重跑的；為了畫成連續曲線，接在訓練期期末淨值之後（等比例換算）
  const ooPts = downsample(seriesPoints(ds, res.ranges.holdout, oo.equity, trEnd / capital));
  const bhPts = downsample(seriesPoints(ds, res.ranges.full, bh));
  const startMark = ooPts.length ? [{ time: ooPts[0].time, position: 'aboveBar', color: '#f59e0b', shape: 'arrowDown', text: '樣本外開始' }] : [];
  lineChart(el, {
    series: [
      { key: 'bh', title: '買入持有', color: cssVar('--muted'), data: bhPts, dashed: true, width: 1 },
      { key: 'train', title: '訓練期', color: '#4c82ff', data: trPts },
      { key: 'oos', title: '樣本外', color: '#f59e0b', data: ooPts },
    ],
    markers: { oos: startMark },
  });
}

function ddCurve(equity, capital) {
  const out = new Float64Array(equity.length);
  let peak = capital;
  for (let i = 0; i < equity.length; i++) {
    if (equity[i] > peak) peak = equity[i];
    out[i] = peak > 0 ? (equity[i] / peak - 1) * 100 : 0;
  }
  return out;
}

export function buildDrawdownChart(el, res, ds, capital) {
  const a = downsample(seriesPoints(ds, res.ranges.train, ddCurve(res.train.equity, capital)));
  const b = downsample(seriesPoints(ds, res.ranges.holdout, ddCurve(res.holdout.equity, capital)));
  lineChart(el, {
    series: [
      { key: 'train', title: '訓練期回撤 %', color: '#4c82ff', type: 'area', invert: true, data: a },
      { key: 'oos', title: '樣本外回撤 %', color: '#f59e0b', type: 'area', invert: true, data: b },
    ],
  });
}

/** K 線圖 + 技術訊號 + 進出場標記 */
export function buildCandleChart(el, { ds, sig, res, strategy, si, show, legendEl }) {
  const S = ds.symbols[si];
  const from = Math.max(ds.windowStartIdx, S.first);
  const candles = [];
  for (let i = from; i <= S.last; i++) {
    candles.push({ time: toChartTime(ds.t0 + i * ds.baseMs), open: S.o[i], high: S.h[i], low: S.l[i], close: S.c[i] });
  }
  const timeAt = (idx) => toChartTime(ds.t0 + idx * ds.baseMs);
  const lines = [];
  const bundle = sig.bundle(si, ds.baseTf);
  const lineFrom = (arr, color, title) => {
    const data = [];
    for (let k = 0; k < arr.length; k++) {
      const idx = S.first + k;
      if (idx >= from && Number.isFinite(arr[k])) data.push({ time: timeAt(idx), value: arr[k] });
    }
    lines.push({ data, color, title });
  };
  if (show.ema && bundle) { lineFrom(bundle.ema(50), '#f59e0b', 'EMA50'); lineFrom(bundle.ema(200), '#a855f7', 'EMA200'); }
  if (show.bb && bundle) { const b = I.bollinger(bundle.s.c, 20, 2); lineFrom(b.upper, '#64748b', '布林上'); lineFrom(b.lower, '#64748b', '布林下'); }

  const markers = [];
  const legend = [];
  if (show.sig && strategy) {
    const specs = [...strategy.entry];
    const conds = specs.length > 1 ? specs : [];
    conds.forEach((sp, n) => {
      const idx = risingEdges(sig.atomIdx(si, sp));
      const label = ['①', '②', '③', '④'][n];
      const def = CONDITIONS[sp.id];
      const above = def.side === 'bear' || (def.side === 'neutral' && strategy.dir === 'short');
      for (const i of idx) if (i >= from) markers.push({ time: timeAt(i), position: above ? 'aboveBar' : 'belowBar', color: '#8b93a7', shape: 'circle', text: label, size: 0.6 });
      legend.push(`${label} ${describeSpec(sp)}`);
    });
    const all = sig.entryIdx(si, strategy.entry, strategy.entryMode || 'edge');
    for (const i of all) if (i >= from) markers.push({ time: timeAt(i), position: strategy.dir === 'short' ? 'aboveBar' : 'belowBar', color: cssVar('--accent'), shape: 'square', text: '訊號', size: 0.8 });
  }
  if (show.trade) {
    const upC = cssVar('--up'); const dnC = cssVar('--down');
    for (const seg of [res.train, res.holdout]) {
      for (const t of seg.trades) {
        if (t.symbol !== S.symbol) continue;
        markers.push({ time: timeAt(t.entryIdx), position: t.dir > 0 ? 'belowBar' : 'aboveBar', color: t.dir > 0 ? upC : dnC, shape: t.dir > 0 ? 'arrowUp' : 'arrowDown', text: `${t.dir > 0 ? '多' : '空'}${t.lev > 1 ? t.lev + '×' : ''}` });
        markers.push({ time: timeAt(t.exitIdx), position: t.dir > 0 ? 'aboveBar' : 'belowBar', color: t.pnl >= 0 ? upC : dnC, shape: 'circle', text: REASON[t.reason] || '' });
      }
    }
    const splitIdx = res.ranges.splitIdx;
    if (splitIdx >= from && splitIdx <= S.last) markers.push({ time: timeAt(splitIdx), position: 'aboveBar', color: '#f59e0b', shape: 'square', text: '樣本外開始' });
  }
  markers.sort((a, b) => a.time - b.time);
  const MAX = 1500;
  const shown = markers.length > MAX ? markers.slice(markers.length - MAX) : markers;
  if (legendEl) {
    legendEl.innerHTML = (legend.length ? legend.map(esc).join('　') + '<br>' : '') +
      (markers.length > MAX ? `標記過多，只顯示最近 ${MAX} 個。` : '') +
      '　時間為本機時區；▲▼ 為進場（多／空）、● 為出場（顏色＝該筆賺／賠）、「訊號」＝所有條件同時成立（下一根開盤才成交）。';
  }
  return candleChart(el, { candles, markers: shown, lines });
}
void fmtTime;
void specKey;

// ---------------- 設定檢查（交易數太少時）----------------
export function renderDiagnosis(el, d) {
  const rows = [
    ...d.conditions.map((c, i) => `<tr><td class="txt">條件 ${i + 1}：${esc(c.text)}</td><td class="${c.train === 0 ? 'neg' : ''}">${c.train.toLocaleString()}</td><td>${c.holdout.toLocaleString()}</td></tr>`),
    `<tr class="hl"><td class="txt">${d.conditions.length > 1 ? '全部條件「同時成立」的 K 線數' : '條件成立的 K 線數'}</td><td>${d.andTrain.toLocaleString()}</td><td>${d.andHold.toLocaleString()}</td></tr>`,
    `<tr><td class="txt">進場訊號（${term('entry_mode', '進場方式')}過濾後）</td><td>${d.entryTrain.toLocaleString()}</td><td>${d.entryHold.toLocaleString()}</td></tr>`,
    `<tr class="hl"><td class="txt"><b>實際成交的交易數</b>（一個幣種同時只持一個部位）</td><td class="${d.low ? 'neg' : ''}"><b>${d.tradesTrain}</b></td><td><b>${d.tradesHold}</b></td></tr>`,
  ].join('');
  const sym = d.perSymbol.map((p) => `<tr><td>${esc(p.symbol)}</td><td>${p.bars.toLocaleString()}</td><td>${p.and}</td><td>${p.entries}</td><td>${p.trades}</td><td>${p.tradesHold}</td></tr>`).join('');
  const open = d.low || d.tradesHold < 10;
  el.innerHTML = `<details ${open ? 'open' : ''} data-testid="diag">
    <summary><b>設定檢查：${d.low ? '交易數偏少，是哪一關擋掉的？' : '訊號是怎麼變成交易的'}</b>
      <span class="muted small">　訓練期 ${d.tradesTrain} 筆（門檻 ${d.minTrades}）／樣本外 ${d.tradesHold} 筆</span></summary>
    <div class="tbl-wrap" style="margin-top:10px"><table class="tbl"><thead><tr><th class="txt">步驟（越往下越少）</th><th>訓練期</th><th>樣本外</th></tr></thead><tbody>${rows}</tbody></table></div>
    <ul class="verdict-list" style="margin-top:10px">${d.tips.map((t) => `<li class="${t.level}">${esc(t.text)}</li>`).join('')}</ul>
    <details style="margin-top:8px"><summary class="muted small">各幣種明細</summary>
      <div class="tbl-wrap"><table class="tbl"><thead><tr><th>幣種</th><th>訓練期 K 線數</th><th>同時成立</th><th>進場訊號</th><th>訓練期交易</th><th>樣本外交易</th></tr></thead><tbody>${sym}</tbody></table></div></details>
  </details>`;
}

export function renderSearchTips(tips) {
  if (!tips.length) return '';
  return `<div data-testid="search-tips" style="margin-top:8px"><b class="small">結果檢查</b><ul class="verdict-list" style="margin-top:6px">${tips.map((t) => `<li class="${t.level}">${esc(t.text)}</li>`).join('')}</ul></div>`;
}

// ---------------- 各幣種損益 ----------------
export function renderSymbolBreakdown(el, res, capital) {
  const tr = symbolBreakdown(res.train, capital);
  const oo = symbolBreakdown(res.holdout, capital);
  const rows = tr.rows.map((r, i) => ({ tr: r, oo: oo.rows[i] })).sort((a, b) => b.tr.pnl - a.tr.pnl);
  const cell = (r) => `<td class="${signClass(r.pnl)}">${fmtMoney(r.pnl, 2, true)}</td><td class="${signClass(r.ret)}">${fmtPct(r.ret, 1, true)}</td><td>${r.trades}</td><td>${r.winRate === null ? '—' : fmtPct(r.winRate, 0)}</td>`;
  const body = rows.map(({ tr: a, oo: b }) => `<tr><td><b>${esc(a.symbol)}</b>${a.liquidations + b.liquidations ? ' <span class="badge bad">清算</span>' : ''}</td>${cell(a)}${cell(b)}</tr>`).join('');
  const tot = (s, t) => `<td class="${signClass(s.totalPnl)}"><b>${fmtMoney(s.totalPnl, 2, true)}</b></td><td class="${signClass(s.totalPnl)}"><b>${fmtPct(s.totalPnl / capital, 1, true)}</b></td><td><b>${t.trades}</b></td><td>${t.trades ? fmtPct(t.winRate, 0) : '—'}</td>`;
  el.innerHTML = `<h2>各幣種損益</h2>
    <div class="muted small" style="margin-bottom:8px">上面「淨報酬」是所有幣種<b>加總</b>的結果。下表拆開來看每個幣種賺賠多少（USDT）。每個幣種的報酬率是以它自己分到的資金（${term('capital_split', '總資金 ÷ 幣種數')} ＝ ${fmtMoney(tr.sleeve, 2)} USDT）計算。</div>
    <div class="tbl-wrap"><table class="tbl" data-testid="symbols"><thead>
      <tr><th rowspan="2">幣種</th><th colspan="4" class="col-train" style="text-align:center">訓練期</th><th colspan="4" class="col-oos" style="text-align:center">樣本外</th></tr>
      <tr><th>淨損益</th><th>報酬率</th><th>交易</th><th>勝率</th><th>淨損益</th><th>報酬率</th><th>交易</th><th>勝率</th></tr></thead>
      <tbody>${body}<tr class="hl"><td><b>合計（＝總成績）</b></td>${tot(tr, res.train.metrics)}${tot(oo, res.holdout.metrics)}</tr></tbody></table></div>
    <div class="muted small">按「逐筆交易」分頁可以看到每一筆；也能用幣種篩選。</div>`;
}
