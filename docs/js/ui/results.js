// 結果頁面的各個區塊
import { term, esc } from './info.js';
import { fmtPct, fmtNum, fmtMoney, fmtPrice, fmtDate, fmtDateUTC, fmtStamp, signClass } from './format.js';
import { candleChart, lineChart, chartTime, cssVar } from './charts.js';
import { timeAt, currencyOf, symLabel } from '../core/util.js';
import * as I from '../core/indicators.js';
import { CONDITIONS, describeSpec, specKey } from '../core/conditions.js';
import { risingEdges } from '../core/signals.js';
import { symbolBreakdown } from '../core/breakdown.js';
import { robustVerdict, priceRet } from '../core/robust.js';

const REASON = { tp: '停利', sl: '停損', trail: '移動停損', be: '保本出場', reverse: '反手', liq: '清算', signal: '出場訊號', time: '持倉期滿', end: '區間結束' };
const legsText = (t) => {
  if (!t.legs) return '';
  const a = t.legs.filter((x) => x.kind === 'add').length;
  const p = t.legs.filter((x) => x.kind === 'partial').length;
  return `（${[a ? `加碼 ${a}` : '', p ? `分批出場 ${p}` : ''].filter(Boolean).join('、')}）`;
};
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
  const fd = ds.times ? fmtDateUTC : fmtDate;
  const cap = (rg) => `${fd(timeAt(ds, rg.from))} ～ ${fd(ds.times ? timeAt(ds, rg.to - 1) : timeAt(ds, rg.to) - 1)}`;
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
    <td>${view.page * per + i + 1}</td><td>${t.seg}</td><td>${esc(symLabel(ds, t.symbol))}</td><td class="${t.dir > 0 ? 'pos' : 'neg'}">${t.dir > 0 ? '做多' : '做空'}</td>
    <td>${fmtStamp(ds, t.entryTime)}</td><td>${fmtPrice(t.entryPrice)}</td><td>${fmtStamp(ds, t.exitTime)}</td><td>${fmtPrice(t.exitPrice)}</td>
    <td>${REASON[t.reason] || t.reason}${legsText(t)}</td><td>${t.bars}</td><td>${t.lev}×</td><td>${fmtMoney(t.fee)}</td><td class="${signClass(t.funding)}">${fmtMoney(t.funding, 2, true)}</td>
    <td class="${signClass(t.pnl)}">${fmtMoney(t.pnl, 2, true)}</td><td class="${signClass(t.ret)}">${fmtPct(t.ret, 2, true)}</td></tr>`).join('');
  el.innerHTML = `<div class="chart-tools">
      <label>期間 <select id="tr-seg"><option value="">全部</option><option ${view.seg === '訓練' ? 'selected' : ''}>訓練</option><option ${view.seg === '樣本外' ? 'selected' : ''}>樣本外</option></select></label>
      <label>幣種 <select id="tr-sym"><option value="">全部</option>${syms.map((s) => `<option value="${esc(s)}" ${view.symbol === s ? 'selected' : ''}>${esc(symLabel(ds, s))}</option>`).join('')}</select></label>
      <span class="muted small">共 ${trades.length} 筆；報酬% = 該筆淨損益 ÷ 進場前資金袋淨值</span></div>
    <div class="tbl-wrap"><table class="tbl" data-testid="trades"><thead><tr><th>#</th><th>期間</th><th>幣種</th><th>方向</th><th>進場時間</th><th>進場價</th><th>出場時間</th><th>出場價</th><th>原因</th><th>K 數</th><th>槓桿</th><th>手續費</th><th>Funding</th><th>淨損益 ${currencyOf(ds)}</th><th>報酬</th></tr></thead><tbody>${rows || '<tr><td colspan="15" class="muted">沒有交易</td></tr>'}</tbody></table></div>
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
    pts.push({ time: chartTime(ds, ds.times ? timeAt(ds, range.from + i) : timeAt(ds, range.from + i + 1)), value: values[i] * scale });
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
    candles.push({ time: chartTime(ds, timeAt(ds, i)), open: S.o[i], high: S.h[i], low: S.l[i], close: S.c[i] });
  }
  const tAt = (idx) => chartTime(ds, timeAt(ds, idx));
  const lines = [];
  const bundle = sig.bundle(si, ds.baseTf);
  const lineFrom = (arr, color, title) => {
    const data = [];
    for (let k = 0; k < arr.length; k++) {
      const idx = S.first + k;
      if (idx >= from && Number.isFinite(arr[k])) data.push({ time: tAt(idx), value: arr[k] });
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
      for (const i of idx) if (i >= from) markers.push({ time: tAt(i), position: above ? 'aboveBar' : 'belowBar', color: '#8b93a7', shape: 'circle', text: label, size: 0.6 });
      legend.push(`${label} ${describeSpec(sp)}`);
    });
    const all = sig.entryIdx(si, strategy.entry, strategy.entryMode || 'edge');
    for (const i of all) if (i >= from) markers.push({ time: tAt(i), position: strategy.dir === 'short' ? 'aboveBar' : 'belowBar', color: cssVar('--accent'), shape: 'square', text: strategy.dir === 'both' ? '多訊號' : '訊號', size: 0.8 });
    if (strategy.dir === 'both') for (const i of sig.entryIdx(si, strategy.entryB || [], strategy.entryMode || 'edge')) if (i >= from) markers.push({ time: tAt(i), position: 'aboveBar', color: cssVar('--accent'), shape: 'square', text: '空訊號', size: 0.8 });
  }
  if (show.trade) {
    const upC = cssVar('--up'); const dnC = cssVar('--down');
    for (const seg of [res.train, res.holdout]) {
      for (const t of seg.trades) {
        if (t.symbol !== S.symbol) continue;
        markers.push({ time: tAt(t.entryIdx), position: t.dir > 0 ? 'belowBar' : 'aboveBar', color: t.dir > 0 ? upC : dnC, shape: t.dir > 0 ? 'arrowUp' : 'arrowDown', text: `${t.dir > 0 ? '多' : '空'}${t.lev > 1 ? t.lev + '×' : ''}` });
        markers.push({ time: tAt(t.exitIdx), position: t.dir > 0 ? 'aboveBar' : 'belowBar', color: t.pnl >= 0 ? upC : dnC, shape: 'circle', text: REASON[t.reason] || '' });
        for (const lg of t.legs || []) markers.push({ time: tAt(lg.idx), position: t.dir > 0 ? 'aboveBar' : 'belowBar', color: '#a855f7', shape: 'circle', text: lg.kind === 'add' ? '加碼' : '分批出場', size: 0.7 });
      }
    }
    const splitIdx = res.ranges.splitIdx;
    if (splitIdx >= from && splitIdx <= S.last) markers.push({ time: tAt(splitIdx), position: 'aboveBar', color: '#f59e0b', shape: 'square', text: '樣本外開始' });
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
void specKey;

// ---------------- 設定檢查（交易數太少時）----------------
export function renderDiagnosis(el, d, ds) {
  const rows = [
    ...d.conditions.map((c, i) => `<tr><td class="txt">條件 ${i + 1}：${esc(c.text)}</td><td class="${c.train === 0 ? 'neg' : ''}">${c.train.toLocaleString()}</td><td>${c.holdout.toLocaleString()}</td></tr>`),
    `<tr class="hl"><td class="txt">${d.conditions.length > 1 ? '全部條件「同時成立」的 K 線數' : '條件成立的 K 線數'}</td><td>${d.andTrain.toLocaleString()}</td><td>${d.andHold.toLocaleString()}</td></tr>`,
    `<tr><td class="txt">進場訊號（${term('entry_mode', '進場方式')}過濾後）</td><td>${d.entryTrain.toLocaleString()}</td><td>${d.entryHold.toLocaleString()}</td></tr>`,
    `<tr class="hl"><td class="txt"><b>實際成交的交易數</b>（一個幣種同時只持一個部位）</td><td class="${d.low ? 'neg' : ''}"><b>${d.tradesTrain}</b></td><td><b>${d.tradesHold}</b></td></tr>`,
  ].join('');
  const sym = d.perSymbol.map((p) => `<tr><td>${esc(ds ? symLabel(ds, p.symbol) : p.symbol)}</td><td>${p.bars.toLocaleString()}</td><td>${p.and}</td><td>${p.entries}</td><td>${p.trades}</td><td>${p.tradesHold}</td></tr>`).join('');
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
export function renderSymbolBreakdown(el, res, capital, ds) {
  const cur = currencyOf(ds);
  const tr = symbolBreakdown(res.train, capital);
  const oo = symbolBreakdown(res.holdout, capital);
  const rows = tr.rows.map((r, i) => ({ tr: r, oo: oo.rows[i] })).sort((a, b) => b.tr.pnl - a.tr.pnl);
  const cell = (r) => `<td class="${signClass(r.pnl)}">${fmtMoney(r.pnl, 2, true)}</td><td class="${signClass(r.ret)}">${fmtPct(r.ret, 1, true)}</td><td>${r.trades}</td><td>${r.winRate === null ? '—' : fmtPct(r.winRate, 0)}</td>`;
  const body = rows.map(({ tr: a, oo: b }) => `<tr><td><b>${esc(symLabel(ds, a.symbol))}</b>${a.liquidations + b.liquidations ? ' <span class="badge bad">清算</span>' : ''}</td>${cell(a)}${cell(b)}</tr>`).join('');
  const tot = (s, t) => `<td class="${signClass(s.totalPnl)}"><b>${fmtMoney(s.totalPnl, 2, true)}</b></td><td class="${signClass(s.totalPnl)}"><b>${fmtPct(s.totalPnl / capital, 1, true)}</b></td><td><b>${t.trades}</b></td><td>${t.trades ? fmtPct(t.winRate, 0) : '—'}</td>`;
  el.innerHTML = `<h2>各幣種損益</h2>
    <div class="muted small" style="margin-bottom:8px">上面「淨報酬」是所有幣種<b>加總</b>的結果。下表拆開來看每個標的賺賠多少（${cur}）。每個標的的報酬率是以它自己分到的資金（${term('capital_split', '總資金 ÷ 標的數')} ＝ ${fmtMoney(tr.sleeve, 2)} ${cur}）計算。</div>
    <div class="tbl-wrap"><table class="tbl" data-testid="symbols"><thead>
      <tr><th rowspan="2">標的</th><th colspan="4" class="col-train" style="text-align:center">訓練期</th><th colspan="4" class="col-oos" style="text-align:center">樣本外</th></tr>
      <tr><th>淨損益</th><th>報酬率</th><th>交易</th><th>勝率</th><th>淨損益</th><th>報酬率</th><th>交易</th><th>勝率</th></tr></thead>
      <tbody>${body}<tr class="hl"><td><b>合計（＝總成績）</b></td>${tot(tr, res.train.metrics)}${tot(oo, res.holdout.metrics)}</tr></tbody></table></div>
    <div class="muted small">按「逐筆交易」分頁可以看到每一筆；也能用幣種篩選。</div>`;
}

// ---------------- 參數敏感度 ----------------
const heatColor = (r) => `color-mix(in srgb, var(${r >= 0 ? '--up' : '--down'}) ${Math.min(80, Math.round((Math.abs(r) / 0.3) * 80))}%, var(--panel-2))`;

export function renderSensitivity(el, d, strategy, ds) {
  const unit = strategy.unit === 'usdt' ? ` ${strategy.cur || 'USDT'}` : strategy.unit === 'atr' ? '×ATR' : '%';
  const cls = { good: 'good', warn: 'warn', bad: 'bad', none: 'info' }[d.summary.level];
  const heat = (sel, title) => {
    const head = d.slAxis.length ? d.slAxis : [d.base.sl];
    const rows = d.grid.map((row, j) => `<tr><th>${d.tpAxis.length ? d.tpAxis[j] + unit : '—'}</th>${row.map((c, i) => {
      const isBase = Math.abs(c.sl - d.base.sl) < 1e-9 && Math.abs(c.tp - d.base.tp) < 1e-9;
      return `<td class="${isBase ? 'base' : ''}" style="background:${heatColor(c[sel].netReturn)}" title="${c[sel].trades} 筆交易、勝率 ${c[sel].trades ? fmtPct(c[sel].winRate, 0) : '—'}">${fmtPct(c[sel].netReturn, 0, true)}</td>`;
    }).join('')}</tr>`).join('');
    return `<div><div class="label">${title}</div><div class="tbl-wrap"><table class="heat sens"><thead><tr><th>停利↓　停損→</th>${head.map((v) => `<th>${v ? v + unit : '—'}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div></div>`;
  };
  const params = d.params.map((p) => {
    const cells = (sel) => p.points.map((pt) => `<td class="${Math.abs(pt.v - p.base) < 1e-9 ? 'base' : ''}" style="background:${heatColor(pt[sel].netReturn)}" title="${pt[sel].trades} 筆交易">${fmtPct(pt[sel].netReturn, 0, true)}</td>`).join('');
    return `<tr><th class="txt">${esc(p.label)}</th>${p.points.map((pt) => `<th>${pt.v}${p.unit}</th>`).join('')}</tr>
      <tr><th class="txt col-train">訓練期</th>${cells('train')}</tr><tr><th class="txt col-oos">樣本外</th>${cells('oos')}</tr>`;
  }).join('<tr><td colspan="9" style="padding:4px"></td></tr>');
  el.innerHTML = `<div class="note ${d.summary.level === 'none' ? 'info' : cls}" data-testid="sens-summary"><b>${term('param_sens', '參數敏感度')}：</b>${esc(d.summary.text)}</div>
    <div class="note info">格子裡是「淨報酬」。有外框的是你目前的設定。<b>訓練期</b>可以用來判斷穩健度；<b>樣本外</b>只能用來檢驗，請不要拿它挑參數——挑了，它就不再是乾淨的驗證。</div>
    ${d.grid.length > 1 || d.slAxis.length ? `<div class="sens-grid">${heat('train', '訓練期（停損 × 停利）')}${heat('oos', '樣本外（停損 × 停利）')}</div>` : ''}
    ${d.params.length ? `<h3 style="margin:14px 0 6px;font-size:14px">單一參數掃描（其他參數不變）</h3><div class="tbl-wrap"><table class="heat sens" data-testid="sens-params"><tbody>${params}</tbody></table></div>` : ''}`;
  void ds;
}

// ---------------- 走動式驗證 ----------------
export function wfVerdict(wf) {
  const s = wf.summary;
  const list = [];
  const add = (level, text) => list.push({ level, text });
  if (s.foldsWithChampion < s.foldsTotal) add('warn', `${s.foldsTotal} 折中有 ${s.foldsTotal - s.foldsWithChampion} 折找不到合格的冠軍（交易數不足、清算或沒有獲利），那段時間是空手。`);
  if (s.netReturn > 0 && s.positiveFolds >= Math.ceil(s.foldsTotal * 0.6)) add('good', `把所有測試期串起來，淨報酬 ${fmtPct(s.netReturn, 1, true)}，${s.positiveFolds}／${s.foldsTotal} 折獲利：這套「搜尋＋挑冠軍」的流程在過去每一段「事前不知道答案」的時間裡大致都有效。`);
  else if (s.netReturn > 0) add('warn', `串接後的淨報酬 ${fmtPct(s.netReturn, 1, true)}，但只有 ${s.positiveFolds}／${s.foldsTotal} 折獲利：賺的錢集中在少數幾折，不夠穩定。`);
  else add('bad', `串接後的淨報酬 ${fmtPct(s.netReturn, 1, true)}：如果過去每隔一段時間就用這個流程重新挑一次策略，結果是虧錢的。目前的搜尋範圍看不到可靠的優勢。`);
  if (s.netReturn > 0 && s.netReturn < s.buyHold) add('info', `同一期間等權重買入持有是 ${fmtPct(s.buyHold, 1, true)}，高於策略；策略賺的錢沒有贏過「什麼都不做」。`);
  if (s.netReturn <= 0 && s.buyHold < 0 && s.netReturn > s.buyHold) add('info', `同一期間買入持有是 ${fmtPct(s.buyHold, 1, true)}，策略虧得比較少（可能因為空手或停損保護）。`);
  if (s.efficiency !== null && s.efficiency < 0.5) add('warn', `走動效率 ${fmtNum(s.efficiency, 2)}（理想接近 1）：訓練期的好表現大部分沒有延續到新資料，是過度擬合的典型現象。`);
  if (s.trades < 20) add('warn', `全部測試期只有 ${s.trades} 筆交易，樣本太少，結果參考價值有限。`);
  add('info', '走動式驗證驗證的是整套流程，不保證未來；折數與切法不同，結果也會不同。');
  return list;
}

export function renderWalkForward(el, wf, ds, capital) {
  const s = wf.summary;
  const m = s.metrics;
  const fd = (idx) => (ds.times ? fmtDateUTC(timeAt(ds, idx)) : fmtDate(timeAt(ds, idx)));
  const rows = wf.folds.map((f) => `<tr>
    <td>${f.k}</td><td>${fd(f.train.from)} ～ ${fd(f.train.to - 1)}</td><td>${fd(f.test.from)} ～ ${fd(f.test.to - 1)}</td>
    <td class="txt">${f.hasChampion ? esc(f.desc) : '<span class="muted">（沒有合格冠軍 → 空手）</span>'}</td>
    <td class="${signClass(f.trainMetrics ? f.trainMetrics.netReturn : 0)}">${f.trainMetrics ? fmtPct(f.trainMetrics.netReturn, 1, true) : '—'}</td>
    <td class="${signClass(f.testMetrics.netReturn)}"><b>${fmtPct(f.testMetrics.netReturn, 1, true)}</b></td>
    <td>${f.testMetrics.trades}</td><td class="${signClass(f.buyHold)}">${fmtPct(f.buyHold, 1, true)}</td></tr>`).join('');
  el.innerHTML = `<h2>${term('walk_forward', '走動式驗證')}結果</h2>
    <div class="muted small">${wf.folds.length} 折，訓練：測試 ＝ ${wf.ratio}：1，每折採用「${{ stable: '最穩定', netReturn: '最高淨報酬', winRate: '最高勝率' }[wf.follow]}」冠軍。測試期合計 ${s.spanDays.toFixed(0)} 天（${fd(wf.range.from)} ～ ${fd(wf.range.to - 1)}），每一段測試期都是「選策略時完全沒看過」的資料。</div>
    <div class="tbl-wrap" style="margin:10px 0"><table class="tbl" data-testid="wf-summary"><tbody>
      <tr><td>串接後淨報酬</td><td class="${signClass(s.netReturn)}"><b>${fmtPct(s.netReturn, 1, true)}</b></td><td>同期買入持有</td><td class="${signClass(s.buyHold)}">${fmtPct(s.buyHold, 1, true)}</td></tr>
      <tr><td>最大回撤</td><td>${fmtPct(-m.maxDrawdown, 1)}</td><td>Sharpe</td><td>${fmtNum(m.sharpe)}</td></tr>
      <tr><td>獲利的折數</td><td>${s.positiveFolds} ／ ${s.foldsTotal}</td><td>${term('wf_efficiency', '走動效率')}</td><td>${s.efficiency === null ? '—' : fmtNum(s.efficiency, 2)}</td></tr>
      <tr><td>交易次數</td><td>${s.trades}</td><td>勝率／PF</td><td>${s.trades ? fmtPct(m.winRate, 0) : '—'}／${pfText(m.profitFactor)}</td></tr>
    </tbody></table></div>
    <ul class="verdict-list" data-testid="wf-verdict">${wfVerdict(wf).map((v) => `<li class="${v.level}">${esc(v.text)}</li>`).join('')}</ul>
    <div id="wf-chart" class="chart-box" style="margin-top:12px"></div>
    <div class="muted small"><span class="legend-dot" style="background:#4c82ff"></span>走動式驗證串接淨值（起點 ${fmtMoney(capital, 0)}，每折結束的淨值接到下一折）　<span class="legend-dot" style="background:var(--muted)"></span>等權重買入持有；垂直標記＝新的一折開始</div>
    <div class="tbl-wrap" style="margin-top:10px"><table class="tbl" data-testid="wf-folds"><thead><tr><th>折</th><th>訓練期</th><th>測試期</th><th class="txt">當折採用的策略（只由訓練期挑出）</th><th>訓練報酬</th><th>測試報酬</th><th>測試交易</th><th>買入持有</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  const pts = (arr, scale) => Array.from(arr, (v, i) => ({ time: chartTime(ds, ds.times ? timeAt(ds, wf.range.from + i) : timeAt(ds, wf.range.from + i + 1)), value: v * scale }));
  const markers = wf.folds.map((f) => ({ time: chartTime(ds, ds.times ? timeAt(ds, f.test.from) : timeAt(ds, f.test.from + 1)), position: 'aboveBar', color: '#f59e0b', shape: 'arrowDown', text: `第 ${f.k} 折` })).sort((a, b) => a.time - b.time);
  lineChart(el.querySelector('#wf-chart'), {
    series: [
      { key: 'bh', title: '買入持有', color: cssVar('--muted'), data: downsample(pts(wf.bhChain, capital)), dashed: true, width: 1 },
      { key: 'wf', title: '走動式驗證', color: '#4c82ff', data: downsample(pts(wf.chain, capital)) },
    ],
    markers: { wf: markers },
  });
}

// ---------------- 可信度檢定 ----------------
function histSvg(seg, title) {
  const h = seg.boot.hist;
  const W = 520; const H = 130; const pad = 22;
  const max = Math.max(...h.counts, 1);
  const bw = (W - pad * 2) / h.counts.length;
  const xOf = (v) => pad + ((v - h.lo) / ((h.hi - h.lo) || 1)) * (W - pad * 2);
  const bars = h.counts.map((c, i) => {
    const x0 = h.lo + ((h.hi - h.lo) / h.counts.length) * i;
    const neg = x0 + (h.hi - h.lo) / h.counts.length / 2 < 0;
    const bh = (c / max) * (H - 38);
    return `<rect x="${(pad + i * bw + 1).toFixed(1)}" y="${(H - 18 - bh).toFixed(1)}" width="${(bw - 2).toFixed(1)}" height="${bh.toFixed(1)}" fill="var(${neg ? '--down' : '--up'})" opacity=".55"/>`;
  }).join('');
  const zero = h.lo < 0 && h.hi > 0 ? `<line x1="${xOf(0).toFixed(1)}" x2="${xOf(0).toFixed(1)}" y1="6" y2="${H - 18}" stroke="var(--muted)" stroke-dasharray="3 3"/><text x="${xOf(0).toFixed(1)}" y="${H - 5}" font-size="10" text-anchor="middle" fill="var(--muted)">0</text>` : '';
  const ox = xOf(seg.totalPct);
  return `<div><div class="label">${esc(title)}</div><svg viewBox="0 0 ${W} ${H}" class="robust-svg" role="img" aria-label="${esc(title)}：重抽樣總損益分布，橘線為實際成績">
    ${bars}${zero}<line x1="${ox.toFixed(1)}" x2="${ox.toFixed(1)}" y1="4" y2="${H - 18}" stroke="#f59e0b" stroke-width="2.5"/>
    <text x="${Math.min(W - pad, Math.max(pad, ox)).toFixed(1)}" y="${H - 5}" font-size="10" text-anchor="middle" fill="#f59e0b">實際 ${fmtPct(seg.totalPct, 1, true)}</text>
    <text x="${pad}" y="${H - 5}" font-size="10" fill="var(--muted)">${fmtPct(h.lo, 0, true)}</text><text x="${W - pad}" y="${H - 5}" font-size="10" text-anchor="end" fill="var(--muted)">${fmtPct(h.hi, 0, true)}</text></svg></div>`;
}

function scatterSvg(trades) {
  const pts = trades.filter((t) => Number.isFinite(t.mae) && t.entryPrice > 0).map((t) => ({ x: t.mae * 100, y: priceRet(t) * 100, win: t.pnl > 0 }));
  if (pts.length < 5) return '';
  const W = 520; const H = 220; const L = 40; const B = 26; const T = 8; const R = 10;
  const xmax = Math.max(1, ...pts.map((p) => p.x));
  const ymin = Math.min(0, ...pts.map((p) => p.y)); const ymax = Math.max(0.5, ...pts.map((p) => p.y));
  const X = (v) => L + (v / xmax) * (W - L - R);
  const Y = (v) => T + (1 - (v - ymin) / ((ymax - ymin) || 1)) * (H - T - B);
  const dots = pts.map((p) => `<circle cx="${X(p.x).toFixed(1)}" cy="${Y(p.y).toFixed(1)}" r="3" fill="var(${p.win ? '--up' : '--down'})" opacity=".6"/>`).join('');
  return `<svg viewBox="0 0 ${W} ${H}" class="robust-svg" role="img" aria-label="每筆交易的最大浮虧與最終報酬散佈圖">
    <line x1="${L}" x2="${W - R}" y1="${Y(0).toFixed(1)}" y2="${Y(0).toFixed(1)}" stroke="var(--muted)" stroke-dasharray="3 3"/>
    <line x1="${L}" x2="${L}" y1="${T}" y2="${H - B}" stroke="var(--border)"/><line x1="${L}" x2="${W - R}" y1="${H - B}" y2="${H - B}" stroke="var(--border)"/>
    ${dots}
    <text x="${W / 2}" y="${H - 6}" font-size="10.5" text-anchor="middle" fill="var(--muted)">途中最大浮虧（價格 %）→</text>
    <text x="4" y="${T + 10}" font-size="10" fill="var(--muted)">${ymax.toFixed(1)}%</text><text x="4" y="${H - B}" font-size="10" fill="var(--muted)">${ymin.toFixed(1)}%</text><text x="4" y="${Y(0).toFixed(1)}" font-size="10" fill="var(--muted)">0</text></svg>`;
}

export function renderRobust(el, r, { searched = false, seed = 0, trades = [] } = {}) {
  const lvl = { good: 'good', warn: 'warn', bad: 'bad', info: 'info' };
  const list = robustVerdict(r, { searched });
  const seg = (name, s) => (s.insufficient
    ? `<tr><th class="txt">${name}</th><td colspan="6" class="muted">交易只有 ${s.n} 筆，太少，無法檢定</td></tr>`
    : `<tr><th class="txt">${name}</th><td>${s.n}</td><td class="${signClass(s.totalPct)}">${fmtPct(s.totalPct, 1, true)}</td><td>${fmtPct(s.boot.p05, 1, true)} ～ ${fmtPct(s.boot.p95, 1, true)}</td><td>${fmtPct(s.boot.probPositive, 0)}</td><td class="${s.signFlipP < 0.05 ? 'pos' : s.signFlipP < 0.2 ? '' : 'neg'}">${fmtNum(s.signFlipP, 3)}</td><td>${fmtPct(-s.dd.observed, 1)} ／ ${fmtPct(-s.dd.p95, 1)}</td></tr>`);
  const m = r.multiple;
  const ex = r.excursion;
  const exRow = (name, x) => `<tr><th class="txt">${name}（${x.n} 筆）</th><td>${x.n ? fmtPct(x.maeMed, 2) : '—'}</td><td>${x.n ? fmtPct(x.maeP90, 2) : '—'}</td><td>${x.n ? fmtPct(x.mfeMed, 2) : '—'}</td></tr>`;
  el.innerHTML = `<div class="note info"><b>這一頁回答：「這段績效有多少可能只是運氣？」</b>把交易重新抽樣、隨機翻轉、隨機重排很多次，看運氣能造成多大的差距。固定亂數種子（${seed}），結果可重現；損益用「加總」近似、不含持倉中的浮動損益。<button type="button" class="btn small" data-robust="reseed" style="margin-left:8px">🔄 換一組亂數</button></div>
    <ul class="verdict-list" data-testid="robust-verdict">${list.map((v) => `<li class="${lvl[v.level]}">${esc(v.text)}</li>`).join('')}</ul>
    <div class="tbl-wrap"><table class="tbl" data-testid="robust-table"><thead><tr><th class="txt"></th><th>交易數</th><th>實際總損益<div class="muted small">佔本金</div></th><th>${term('monte_carlo', '重抽樣 90% 區間')}</th><th>總損益為正的機率</th><th>${term('sign_flip', 'p 值')}<div class="muted small">越小越不像運氣</div></th><th>最大回撤<div class="muted small">實際 ／ 重排 95%</div></th></tr></thead>
      <tbody>${seg('訓練期', r.train)}${seg('樣本外', r.oos)}</tbody></table></div>
    <div class="robust-hists">${r.oos.insufficient ? '' : histSvg(r.oos, '樣本外：重抽樣的總損益分布（橘線＝實際）')}${r.train.insufficient ? '' : histSvg(r.train, '訓練期：重抽樣的總損益分布（橘線＝實際）')}</div>
    <div class="note ${searched && m.K > 1 ? 'warn' : 'info'}" data-testid="robust-multiple"><b>${term('multiple_testing', '多重檢定')}：</b>${searched && m.K > 1
      ? `這個策略是從 <b>${m.K}</b> 組候選裡挑出來的。訓練期原始 p 值 ${m.pTrain === null ? '—' : fmtNum(m.pTrain, 3)}，校正後約 <b>${m.pTrainAdj === null ? '—' : fmtNum(m.pTrainAdj, 3)}</b>（Šidák）；校正後如果仍然偏大，代表訓練期的好成績可能只是「挑出來的」。<b>樣本外 p 值 ${m.pOos === null ? '—' : fmtNum(m.pOos, 3)}</b> 是乾淨的（只驗收一次）；若你在三位冠軍之間比較、挑最好的，請把它乘以 3 再看。`
      : `目前是單一策略（K＝1），沒有校正。若你之前手動試過很多組設定才挑到這一組，實際的挑選次數比 1 大，請把 p 值看得更保守。`}</div>
    <h3 style="margin:14px 0 6px">${term('mae_mfe', '交易途中的最大浮虧／浮盈')}</h3>
    <div class="tbl-wrap"><table class="tbl"><thead><tr><th class="txt"></th><th>最大浮虧（中位數）</th><th>最大浮虧（90 百分位）</th><th>最大浮盈（中位數）</th></tr></thead><tbody>${exRow('賺錢的交易', ex.win)}${exRow('虧錢的交易', ex.lose)}</tbody></table></div>
    <div class="muted small" style="margin:6px 0">${ex.n >= 10 ? `輸家中有 ${fmtPct(ex.loseWithProfit, 0)} 曾經浮盈超過 0.5%；${ex.capture === null ? '' : `贏家平均只抓到最大浮盈的 ${fmtPct(ex.capture, 0)}。`}` : '交易太少，無法歸納。'}數字是價格變動（不含槓桿與成本）。</div>
    ${scatterSvg(trades)}<div class="muted small">每個點是一筆交易：橫軸＝途中最大浮虧、縱軸＝最終價格報酬。點若集中在左下（小浮虧就認賠）代表停損夠緊；右上角很多點（浮虧很深最後還是賺）代表停損可能太緊，把賺錢的單子洗掉了。</div>`;
}
