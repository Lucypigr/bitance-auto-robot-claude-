import { initInfo, decorate, term, esc } from './info.js';
import { BinanceClient, IdbStore, MemoryStore, loadMarketData } from '../data/binance.js';
import { buildDataset } from '../core/dataset.js';
import { SignalEngine } from '../core/signals.js';
import { normalizeSpec, describeSpec } from '../core/conditions.js';
import { describeStrategy } from '../core/search.js';
import { TIMEFRAMES, TF_LABEL, TF_MS, DAY, tfIndex } from '../core/util.js';
import { ComputeClient } from './worker-client.js';
import { refreshChartTheme, destroyAll, candleChart, toChartTime } from './charts.js';
import { TEMPLATES, defaultCondition, renderConditionList, bindConditionList, describeManual } from './strategy-form.js';
import * as R from './results.js';
import { fmtMoney, fmtPct } from './format.js';

const $ = (id) => document.getElementById(id);
const MAX_SYMBOLS = 15;
const FALLBACK_SYMBOLS = ['BTC', 'ETH', 'BNB', 'SOL', 'XRP', 'DOGE', 'ADA', 'AVAX', 'LINK', 'DOT', 'LTC', 'TRX', 'ATOM', 'NEAR', 'UNI'].map((b, i) => ({ symbol: `${b}USDT`, base: b, quoteVolume: 1e9 / (i + 1) }));
const MAX_DAYS = { '5m': 365, '15m': 730, '1h': 1095, '4h': 1095, '1d': 1095 };

const state = {
  market: 'perp',
  symbols: ['BTCUSDT', 'ETHUSDT'],
  allSymbols: { spot: null, perp: null },
  baseTf: '1h',
  days: 180,
  useMark: true,
  tab: 'search',
  manual: { dir: 'short', entry: [], exit: [], sl: 3, tp: 5, trail: 0, lev: 1, maxBars: 0, entryMode: 'edge' },
  search: { direction: 'both', maxConditions: 3, budget: 120, tfs: [], minTrades: 20, sl: [1, 2, 3, 5], tp: [1, 2, 3, 5, 10], lev: [1, 2, 3, 5, 10], seed: 20240601, entryMode: 'edge', allowOpposite: false },
  data: null, // {key, tfs, ds, sig}
  view: null, // 目前顯示的完整回測 {res, strategy, title}
  searchResult: null,
  detailCache: new Map(),
  busy: false,
  abort: null,
  boardSort: { key: 'stability', dir: 'desc' },
  tradeView: { seg: '', symbol: '', page: 0 },
  builtCharts: {},
  ctab: 'candles',
};
window.__bt = { state };

const compute = new ComputeClient();
const client = new BinanceClient();
let store;
try { store = typeof indexedDB !== 'undefined' ? new IdbStore() : new MemoryStore(); } catch { store = new MemoryStore(); }

// ---------------- 設定存取 ----------------
const LS = 'bt.settings.v1';
function loadSettings() {
  try { return JSON.parse(localStorage.getItem(LS) || '{}'); } catch { return {}; }
}
function saveSettings() {
  try {
    localStorage.setItem(LS, JSON.stringify({
      market: state.market, symbols: state.symbols, baseTf: state.baseTf, days: state.days,
      theme: document.documentElement.dataset.theme, colors: document.documentElement.dataset.colors,
      costs: readCosts(true),
    }));
  } catch { /* 無痕模式等情況，忽略 */ }
}

// ---------------- 成本 ----------------
function readCosts(raw = false) {
  const n = (id, d) => { const v = Number($(id).value); return Number.isFinite(v) ? v : d; };
  const r = { capital: n('capital', 10000), posPct: n('posPct', 100), feePct: n('feePct', 0.05), slipPct: n('slipPct', 0.05), mmrPct: n('mmrPct', 0.5) };
  if (raw) return r;
  return {
    capital: Math.max(100, r.capital), posPct: Math.min(1, Math.max(0.01, r.posPct / 100)),
    fee: Math.max(0, r.feePct / 100), slippage: Math.max(0, r.slipPct / 100), mmr: Math.max(0.001, r.mmrPct / 100),
  };
}

// ---------------- 小工具 ----------------
function setProgress(el, done, total, text) {
  el.hidden = false;
  el.querySelector('.bar').style.width = total ? `${Math.min(100, (done / total) * 100).toFixed(1)}%` : '0%';
  el.querySelector('.ptext').textContent = text;
}
function showError(msg) {
  const e = $('run-error');
  e.hidden = !msg;
  e.textContent = msg || '';
}
function setBusy(b, cancellable = false) {
  state.busy = b;
  $('btn-search').disabled = b;
  $('btn-manual').disabled = b;
  $('btn-demo').disabled = b;
  $('btn-cancel').hidden = !(b && cancellable);
}
const symOf = (s) => s.replace(/USDT$/, '');

// ---------------- 主題 ----------------
function initTheme() {
  const s = loadSettings();
  const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.dataset.theme = s.theme || (prefersDark ? 'dark' : 'light');
  document.documentElement.dataset.colors = s.colors || 'intl';
  $('color-scheme').value = document.documentElement.dataset.colors;
  $('btn-theme').addEventListener('click', () => {
    document.documentElement.dataset.theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    saveSettings(); refreshChartTheme();
  });
  $('color-scheme').addEventListener('change', (e) => {
    document.documentElement.dataset.colors = e.target.value; saveSettings(); rebuildVisibleChart();
  });
}

// ---------------- 市場與幣種 ----------------
async function loadSymbolList(market) {
  if (state.allSymbols[market]) return state.allSymbols[market];
  const key = `bt.symbols.${market}`;
  try {
    const c = JSON.parse(sessionStorage.getItem(key) || 'null');
    if (c && Date.now() - c.t < 3600e3) { state.allSymbols[market] = c.list; return c.list; }
  } catch { /* ignore */ }
  $('sym-status').textContent = '正在從幣安取得幣種清單…';
  try {
    const list = await client.listSymbols(market);
    state.allSymbols[market] = list;
    try { sessionStorage.setItem(key, JSON.stringify({ t: Date.now(), list })); } catch { /* ignore */ }
    $('sym-status').textContent = `共 ${list.length} 個 USDT ${market === 'perp' ? '永續合約' : '現貨'}交易對（依 24 小時成交額排序）`;
    return list;
  } catch (e) {
    state.allSymbols[market] = FALLBACK_SYMBOLS;
    $('sym-status').innerHTML = `<span class="neg">無法取得幣種清單：${esc(e.message)}</span>（已改用內建常用幣種；實際下載資料時若仍被拒絕，請換個網路環境）`;
    return FALLBACK_SYMBOLS;
  }
}

function renderSymbols() {
  const list = state.allSymbols[state.market] || [];
  const q = $('sym-search').value.trim().toUpperCase();
  const sel = new Set(state.symbols);
  const filtered = (q ? list.filter((s) => s.symbol.includes(q)) : list).slice(0, 80);
  $('sym-list').innerHTML = filtered.map((s) => `<button type="button" class="sym-item" role="option" aria-selected="${sel.has(s.symbol)}" data-sym="${s.symbol}"><span>${sel.has(s.symbol) ? '✓ ' : ''}${esc(s.base || symOf(s.symbol))}<span class="muted">/USDT</span></span><span class="vol">${s.quoteVolume ? '24h 成交 ' + (s.quoteVolume / 1e6).toFixed(0) + 'M' : ''}</span></button>`).join('') || '<div class="muted small" style="padding:8px">找不到符合的幣種</div>';
  $('sym-selected').innerHTML = state.symbols.map((s) => `<span class="chip">${esc(symOf(s))}<button type="button" data-rm="${s}" aria-label="移除 ${esc(s)}">✕</button></span>`).join('');
  $('sym-count').textContent = `（已選 ${state.symbols.length}／${MAX_SYMBOLS}）`;
}

function toggleSymbol(sym) {
  const i = state.symbols.indexOf(sym);
  if (i >= 0) state.symbols.splice(i, 1);
  else if (state.symbols.length >= MAX_SYMBOLS) { $('sym-status').innerHTML = `<span class="neg">最多只能選 ${MAX_SYMBOLS} 個幣種</span>`; return; }
  else state.symbols.push(sym);
  renderSymbols(); updateDataWarn(); saveSettings();
}

function setMarket(m, silent) {
  state.market = m;
  document.querySelectorAll('[data-market]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.market === m)));
  const perp = m === 'perp';
  $('mmr-field').hidden = !perp; $('mark-field').hidden = !perp; $('s-lev-field').hidden = !perp;
  $('m-lev').disabled = !perp;
  if (!perp) { state.manual.lev = 1; $('m-lev').value = 1; $('m-lev-out').textContent = '1×'; if (state.manual.dir === 'short') setDir('long'); }
  document.querySelector('[data-dir="short"]').disabled = !perp;
  $('s-dir').querySelector('option[value="short"]').disabled = !perp;
  $('s-dir').querySelector('option[value="both"]').disabled = !perp;
  if (!perp && $('s-dir').value !== 'long') $('s-dir').value = 'long';
  if (!silent) { $('feePct').value = perp ? '0.05' : '0.1'; }
  loadSymbolList(m).then((list) => {
    const have = new Set(list.map((s) => s.symbol));
    state.symbols = state.symbols.filter((s) => have.has(s));
    if (!state.symbols.length) state.symbols = ['BTCUSDT', 'ETHUSDT'].filter((s) => have.has(s));
    renderSymbols(); updateDataWarn();
  });
  saveSettings();
}

function updateDataWarn() {
  const bars = (state.days * DAY) / TF_MS[state.baseTf];
  const total = bars * state.symbols.length;
  const w = $('data-warn');
  const msgs = [];
  if (total > 1.2e6) msgs.push(`預計載入約 ${(total / 1e4).toFixed(0)} 萬根 K 線（${state.symbols.length} 個幣種 × ${Math.round(bars).toLocaleString()} 根），下載與運算會比較久。`);
  if (!state.symbols.length) msgs.push('請至少選擇 1 個幣種。');
  w.hidden = msgs.length === 0;
  w.textContent = msgs.join(' ');
}

function applyDaysLimit() {
  const max = MAX_DAYS[state.baseTf];
  for (const o of $('days').options) o.disabled = Number(o.value) > max;
  if (state.days > max) { state.days = max; $('days').value = String(max); }
}

// ---------------- 搜尋面板 ----------------
function checkboxGroup(el, values, checked, name, disabledFn) {
  el.innerHTML = values.map((v) => {
    const dis = disabledFn ? disabledFn(v) : false;
    return `<label class="check"><input type="checkbox" name="${name}" value="${v}" ${checked.includes(v) ? 'checked' : ''} ${dis ? 'disabled' : ''}> ${name === 's-tf' ? esc(TF_LABEL[v]) : v}</label>`;
  }).join('');
}
function renderSearchPane() {
  const baseIdx = tfIndex(state.baseTf);
  const allowed = TIMEFRAMES.filter((_, i) => i >= baseIdx);
  let tfs = state.search.tfs.filter((t) => allowed.includes(t));
  if (!tfs.includes(state.baseTf)) tfs.unshift(state.baseTf);
  if (tfs.length === 1 && allowed[1]) tfs.push(allowed[1]);
  state.search.tfs = tfs;
  checkboxGroup($('s-tfs'), allowed, tfs, 's-tf', (v) => v === state.baseTf);
  checkboxGroup($('s-sl'), [1, 2, 3, 5], state.search.sl, 's-sl');
  checkboxGroup($('s-tp'), [1, 2, 3, 5, 10], state.search.tp, 's-tp');
  checkboxGroup($('s-lev'), [1, 2, 3, 5, 10], state.search.lev, 's-lev');
  decorate($('pane-search'));
}
function readChecks(name) {
  return [...document.querySelectorAll(`input[name="${name}"]:checked`)].map((i) => Number(i.value) || i.value);
}

function readSearchConfig() {
  const sl = readChecks('s-sl'); const tp = readChecks('s-tp'); const lev = readChecks('s-lev');
  const tfs = [...new Set([state.baseTf, ...readChecks('s-tf')])];
  if (!sl.length || !tp.length) throw new Error('停損與停利至少各選一個');
  const minTrades = Math.max(1, Number($('s-min').value) || 20);
  const cfg = {
    direction: state.market === 'spot' ? 'long' : $('s-dir').value,
    maxConditions: Number($('s-maxc').value), budget: Number($('s-budget').value),
    tfs, minTrades, slList: sl, tpList: tp, levList: state.market === 'spot' ? [1] : (lev.length ? lev : [1]),
    seed: Number($('s-seed').value) || 1, entryMode: $('s-entrymode').value, allowOpposite: $('s-opp').checked,
  };
  Object.assign(state.search, { sl, tp, lev, tfs });
  return cfg;
}

// ---------------- 手動策略 ----------------
function setDir(d) {
  state.manual.dir = d;
  document.querySelectorAll('[data-dir]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.dir === d)));
  renderManual();
}
function renderManual() {
  const m = state.manual;
  renderConditionList($('m-entry'), m.entry, state.baseTf);
  renderConditionList($('m-exit'), m.exit, state.baseTf);
  $('m-summary').innerHTML = esc(describeManual(readManualStrategy(true)));
  decorate($('pane-manual'));
}
function readManualStrategy(soft = false) {
  const m = state.manual;
  const num = (id) => Math.max(0, Number($(id).value) || 0);
  m.sl = num('m-sl'); m.tp = num('m-tp'); m.trail = num('m-trail'); m.maxBars = Math.floor(num('m-maxbars'));
  m.lev = state.market === 'spot' ? 1 : Number($('m-lev').value) || 1;
  m.entryMode = $('m-entrymode').value;
  const fix = (c) => { const n = normalizeSpec(c); if (tfIndex(n.tf) < tfIndex(state.baseTf)) n.tf = state.baseTf; return n; };
  const st = { dir: m.dir, entry: m.entry.map(fix), exit: m.exit.map(fix), entryMode: m.entryMode, lev: m.lev, sl: m.sl, tp: m.tp, trail: m.trail, maxBars: m.maxBars };
  if (!soft && !st.entry.length) throw new Error('請至少新增一個進場條件');
  return st;
}
function applyTemplate(id) {
  const t = TEMPLATES.find((x) => x.id === id);
  if (!t) return;
  if (t.baseTf && state.baseTf !== t.baseTf) setBaseTf(t.baseTf);
  const s = t.strategy(state.baseTf);
  Object.assign(state.manual, { dir: s.dir, entry: s.entry, exit: s.exit || [], sl: s.sl, tp: s.tp, trail: s.trail || 0, lev: state.market === 'spot' ? 1 : s.lev, maxBars: 0 });
  if (state.market === 'spot' && s.dir === 'short') state.manual.dir = 'long';
  $('m-sl').value = state.manual.sl; $('m-tp').value = state.manual.tp; $('m-trail').value = state.manual.trail;
  $('m-lev').value = state.manual.lev; $('m-lev-out').textContent = `${state.manual.lev}×`; $('m-maxbars').value = 0;
  setDir(state.manual.dir);
}

function setBaseTf(tf) {
  state.baseTf = tf;
  $('base-tf').value = tf;
  applyDaysLimit();
  for (const c of [...state.manual.entry, ...state.manual.exit]) if (tfIndex(c.tf) < tfIndex(tf)) c.tf = tf;
  renderManual(); renderSearchPane(); updateDataWarn(); saveSettings();
}

// ---------------- 資料載入 ----------------
function neededTfs(strategyList) {
  const set = new Set([state.baseTf]);
  for (const st of strategyList) for (const c of [...(st.entry || []), ...(st.exit || [])]) set.add(normalizeSpec(c).tf);
  return set;
}

async function ensureData(tfSet) {
  if (!state.symbols.length) throw new Error('請至少選擇 1 個幣種');
  const key = JSON.stringify([state.market, [...state.symbols].sort(), state.baseTf, state.days, state.market === 'perp' && $('useMark').checked]);
  if (state.data && state.data.key === key && [...tfSet].every((t) => state.data.tfs.has(t))) return state.data;
  const tfs = new Set([...(state.data && state.data.key === key ? state.data.tfs : []), ...tfSet]);
  const prog = $('load-progress');
  setProgress(prog, 0, 1, '正在下載 K 線…');
  const raw = await loadMarketData(client, store, {
    market: state.market, symbols: state.symbols, baseTf: state.baseTf, tfs: [...tfs], days: state.days,
    useMark: $('useMark').checked, signal: state.abort && state.abort.signal,
    onProgress: (p) => setProgress(prog, p.done, p.total, `下載中 ${p.done}／${p.total}　${p.label || ''}`),
  });
  setProgress(prog, 1, 1, '整理資料中…');
  const ds = buildDataset({ market: state.market, baseTf: state.baseTf, windowStart: raw.windowStart, endTime: raw.endTime, symbols: raw.symbols });
  ds.warnings.push(...raw.warnings);
  await compute.setDataset(ds);
  prog.hidden = true;
  state.data = { key, tfs, ds, sig: new SignalEngine(ds) };
  state.detailCache.clear();
  const bars = ds.n - ds.windowStartIdx;
  $('data-info').innerHTML = `已載入 <b>${ds.symbols.length}</b> 個幣種 × <b>${bars.toLocaleString()}</b> 根 ${TF_LABEL[state.baseTf]} K 線` +
    (ds.warnings.length ? `<br><span class="neg">${ds.warnings.map(esc).join('<br>')}</span>` : '');
  showPreview(ds);
  return state.data;
}

function showPreview(ds) {
  const S = ds.symbols[0];
  if (!S || $('result-body').hidden === false) return;
  const el = $('preview-chart');
  el.hidden = false;
  const candles = [];
  for (let i = Math.max(ds.windowStartIdx, S.first); i <= S.last; i++) candles.push({ time: toChartTime(ds.t0 + i * ds.baseMs), open: S.o[i], high: S.h[i], low: S.l[i], close: S.c[i] });
  destroyAll();
  candleChart(el, { candles });
}

// ---------------- 執行 ----------------
function costsNote(c) {
  return `手續費 ${(c.fee * 100).toFixed(3)}%／滑價 ${(c.slippage * 100).toFixed(3)}%（單邊）`;
}

async function runManual() {
  showError('');
  let st;
  try { st = readManualStrategy(); } catch (e) { showError(e.message); return; }
  state.abort = new AbortController();
  setBusy(true, true);
  try {
    const d = await ensureData(neededTfs([st]));
    const costs = readCosts();
    const strategy = { ...st };
    const res = await compute.backtest(strategy, costs);
    state.searchResult = null;
    showDetail({ res, strategy, title: '手動策略回測', costs });
  } catch (e) {
    if (e.kind !== 'abort') showError(e.message || String(e));
    $('load-progress').hidden = true;
  } finally { setBusy(false); }
}

async function runSearch() {
  showError('');
  let cfg;
  try { cfg = readSearchConfig(); } catch (e) { showError(e.message); return; }
  state.abort = new AbortController();
  setBusy(true, true);
  const prog = $('search-progress');
  try {
    await ensureData(new Set(cfg.tfs));
    const costs = readCosts();
    setProgress(prog, 0, 1, '產生候選組合…');
    const result = await compute.search(cfg, costs, (p) => {
      const label = p.phase === 'scan' ? '產生候選組合…' : p.phase === 'eval' ? `在訓練期測試候選 ${p.done}／${p.total}` : p.phase === 'validate' ? '樣本外驗證冠軍…' : '完成';
      setProgress(prog, p.phase === 'eval' ? p.done : p.phase === 'done' ? 1 : 0, p.phase === 'eval' ? p.total : 1, label);
    });
    prog.hidden = true;
    if (result.cancelled) { showError('已取消搜尋'); return; }
    state.searchResult = result;
    state.detailCache.clear();
    for (const [id, d] of Object.entries(result.details)) state.detailCache.set(id, { ranges: result.ranges, ...d });
    showSearchResult(result, costs);
  } catch (e) {
    if (e.kind !== 'abort') showError(e.message || String(e));
    prog.hidden = true; $('load-progress').hidden = true;
  } finally { setBusy(false); }
}

async function cancelRun() {
  if (state.abort) state.abort.abort();
  await compute.cancel();
}

// ---------------- 結果顯示 ----------------
function showResultShell() {
  $('result-empty').hidden = true;
  $('result-body').hidden = false;
}

function showSearchResult(result, costs) {
  showResultShell();
  const n = result.candidates.length;
  $('r-title').innerHTML = `<div><h2>自動搜尋結果</h2>
    <div class="muted small">共測試 <b>${n}</b> 組候選（上限 ${result.config.budget}）；符合冠軍資格 ${result.eligibleCount} 組。${costsNote(costs)}。冠軍只用<b>訓練期</b>挑選，<b>樣本外</b>只做驗收。</div>
    ${result.warnings.map((w) => `<div class="note warn">${esc(w)}</div>`).join('')}</div>`;
  $('r-champions').hidden = false;
  R.renderChampions($('r-champions'), result);
  $('tab-board').hidden = false;
  const first = result.champions.stable || result.champions.netReturn || result.champions.winRate;
  if (first) {
    const d = state.detailCache.get(first);
    showDetail({ res: d, strategy: d.strategy, title: null, costs, keepHead: true, candidateId: first });
  } else {
    $('r-verdict').hidden = true; $('r-compare').hidden = true;
    document.querySelector('.card.charts').hidden = false;
    state.view = null;
    selectChartTab('board');
  }
  $('r-champions').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function showDetail({ res, strategy, title, costs, keepHead, candidateId }) {
  showResultShell();
  state.view = { res, strategy, costs, candidateId };
  state.builtCharts = {};
  state.tradeView = { seg: '', symbol: '', page: 0 };
  const ds = state.data.ds;
  if (!keepHead) {
    $('r-champions').hidden = true; $('tab-board').hidden = true;
    $('r-title').innerHTML = `<div><h2>${esc(title)}</h2><div class="strategy" data-testid="strategy-desc">${esc(describeStrategy({ ...strategy, sl: strategy.sl, tp: strategy.tp }))}</div>
      <div class="muted small">${costsNote(costs)}　${state.market === 'perp' ? '永續合約' : '現貨'}　${ds.symbols.length} 個幣種　執行週期 ${TF_LABEL[ds.baseTf]}</div></div>`;
  } else {
    const e = state.searchResult.candidates.find((c) => c.id === candidateId);
    $('r-title').querySelector('div').insertAdjacentHTML('beforeend', `<div class="note info" data-testid="detail-head">目前顯示的完整回測：<b>${esc(e.desc)}</b></div>`);
    const old = $('r-title').querySelectorAll('[data-testid="detail-head"]');
    if (old.length > 1) old[0].remove();
  }
  $('r-verdict').hidden = false; $('r-compare').hidden = false;
  document.querySelector('.card.charts').hidden = false;
  R.renderVerdict($('r-verdict'), res);
  R.renderCompare($('r-compare'), res, ds);
  const sel = $('c-symbol');
  sel.innerHTML = ds.symbols.map((s, i) => `<option value="${i}">${esc(s.symbol)}</option>`).join('');
  decorate($('result-body'));
  selectChartTab(state.ctab === 'board' && !state.searchResult ? 'candles' : state.ctab);
}

async function openCandidate(id) {
  let d = state.detailCache.get(id);
  if (!d) {
    const e = state.searchResult.candidates.find((c) => c.id === id);
    state.abort = new AbortController();
    setBusy(true, false);
    try {
      const res = await compute.backtest(e.strategy, readCosts());
      d = { ...res, strategy: e.strategy };
      state.detailCache.set(id, d);
    } catch (err) { showError(err.message); return; } finally { setBusy(false); }
  }
  showDetail({ res: d, strategy: d.strategy, costs: readCosts(), keepHead: true, candidateId: id });
  $('r-verdict').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ---------------- 圖表分頁 ----------------
function selectChartTab(name) {
  state.ctab = name;
  document.querySelectorAll('#chart-tabs .tab').forEach((b) => {
    const on = b.dataset.ctab === name;
    b.classList.toggle('active', on); b.setAttribute('aria-selected', String(on));
  });
  document.querySelectorAll('.ctab').forEach((el) => { el.hidden = el.id !== `ctab-${name}`; });
  buildTab(name);
}

function buildTab(name) {
  if (name === 'board') {
    if (state.searchResult) {
      R.renderBoard($('board'), state.searchResult, state.boardSort, state.searchResult.config.minTrades);
      decorate($('board'));
    }
    return;
  }
  if (!state.view) return;
  const { res, strategy, costs } = state.view;
  const ds = state.data.ds;
  if (name === 'trades') { renderTrades(); return; }
  if (name === 'monthly') { R.renderMonthly($('monthly'), res); return; }
  if (state.builtCharts[name]) return;
  state.builtCharts[name] = true;
  if (name === 'candles') {
    destroyAll();
    buildCandle();
  } else if (name === 'equity') {
    R.buildEquityChart($('equity-chart'), res, ds, costs.capital);
    $('equity-legend').innerHTML = `<span class="legend-dot" style="background:#4c82ff"></span>訓練期　<span class="legend-dot" style="background:#f59e0b"></span>樣本外（接在訓練期期末之後，每段獨立回測）　<span class="legend-dot" style="background:var(--muted)"></span>${term('buyhold', '等權重買入持有')}（比較基準）`;
    decorate($('equity-legend'));
  } else if (name === 'drawdown') {
    R.buildDrawdownChart($('dd-chart'), res, ds, costs.capital);
  }
  void strategy;
}

function buildCandle() {
  if (!state.view) return;
  const { res, strategy } = state.view;
  const ds = state.data.ds;
  const si = Number($('c-symbol').value) || 0;
  R.buildCandleChart($('candle-chart'), {
    ds, sig: state.data.sig, res, strategy, si, legendEl: $('candle-legend'),
    show: { ema: $('ov-ema').checked, bb: $('ov-bb').checked, sig: $('ov-sig').checked, trade: $('ov-trade').checked },
  });
}

function rebuildVisibleChart() {
  if (!state.view) return;
  state.builtCharts = {};
  if (['candles', 'equity', 'drawdown'].includes(state.ctab)) buildTab(state.ctab);
}

function renderTrades() {
  R.renderTrades($('trades'), state.view.res, state.data.ds, state.tradeView);
}

// ---------------- 事件綁定 ----------------
function bind() {
  document.querySelectorAll('[data-market]').forEach((b) => b.addEventListener('click', () => setMarket(b.dataset.market)));
  $('sym-search').addEventListener('input', renderSymbols);
  $('sym-list').addEventListener('click', (e) => { const b = e.target.closest('[data-sym]'); if (b) toggleSymbol(b.dataset.sym); });
  $('sym-selected').addEventListener('click', (e) => { const b = e.target.closest('[data-rm]'); if (b) toggleSymbol(b.dataset.rm); });
  document.querySelectorAll('[data-preset]').forEach((b) => b.addEventListener('click', () => {
    const n = Number(b.dataset.preset);
    const list = state.allSymbols[state.market] || [];
    state.symbols = list.slice(0, n).map((s) => s.symbol);
    renderSymbols(); updateDataWarn(); saveSettings();
  }));
  $('base-tf').addEventListener('change', (e) => setBaseTf(e.target.value));
  $('days').addEventListener('change', (e) => { state.days = Number(e.target.value); updateDataWarn(); saveSettings(); });
  for (const id of ['capital', 'posPct', 'feePct', 'slipPct', 'mmrPct']) $(id).addEventListener('change', saveSettings);

  document.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => {
    state.tab = b.dataset.tab;
    document.querySelectorAll('#step2 > .tabs .tab').forEach((x) => { const on = x === b; x.classList.toggle('active', on); x.setAttribute('aria-selected', String(on)); });
    $('pane-search').hidden = state.tab !== 'search'; $('pane-manual').hidden = state.tab !== 'manual';
  }));

  $('btn-search').addEventListener('click', runSearch);
  $('btn-manual').addEventListener('click', runManual);
  $('btn-cancel').addEventListener('click', cancelRun);
  $('btn-demo').addEventListener('click', runDemo);

  // 手動策略
  $('m-template').innerHTML += TEMPLATES.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join('');
  $('m-template').addEventListener('change', (e) => { applyTemplate(e.target.value); const t = TEMPLATES.find((x) => x.id === e.target.value); if (t) $('m-template').title = t.tip; });
  document.querySelectorAll('[data-dir]').forEach((b) => b.addEventListener('click', () => { if (!b.disabled) setDir(b.dataset.dir); }));
  $('m-add-entry').addEventListener('click', () => { state.manual.entry = [...state.manual.entry, defaultCondition(state.baseTf)]; renderManual(); });
  $('m-add-exit').addEventListener('click', () => { state.manual.exit = [...state.manual.exit, { ...defaultCondition(state.baseTf), id: 'rsi_overbought' }]; renderManual(); });
  bindConditionList($('m-entry'), () => state.manual.entry, (l) => { state.manual.entry = l; renderManual(); });
  bindConditionList($('m-exit'), () => state.manual.exit, (l) => { state.manual.exit = l; renderManual(); });
  for (const id of ['m-sl', 'm-tp', 'm-trail', 'm-maxbars', 'm-entrymode']) $(id).addEventListener('input', renderManual);
  $('m-lev').addEventListener('input', (e) => { $('m-lev-out').textContent = `${e.target.value}×`; renderManual(); });

  // 結果區
  $('chart-tabs').addEventListener('click', (e) => { const b = e.target.closest('[data-ctab]'); if (b) selectChartTab(b.dataset.ctab); });
  $('c-symbol').addEventListener('change', () => { destroyAll(); buildCandle(); });
  for (const id of ['ov-ema', 'ov-bb', 'ov-sig', 'ov-trade']) $(id).addEventListener('change', () => { destroyAll(); buildCandle(); });
  $('r-champions').addEventListener('click', (e) => { const b = e.target.closest('[data-open]'); if (b) openCandidate(b.dataset.open); });
  $('board').addEventListener('click', (e) => {
    const th = e.target.closest('th[data-sort]');
    if (th) {
      const k = th.dataset.sort;
      state.boardSort = { key: k, dir: state.boardSort.key === k && state.boardSort.dir === 'desc' ? 'asc' : 'desc' };
      buildTab('board'); return;
    }
    const tr = e.target.closest('tr[data-id]');
    if (tr && !e.target.closest('.info')) openCandidate(tr.dataset.id);
  });
  $('trades').addEventListener('change', (e) => {
    if (e.target.id === 'tr-seg') { state.tradeView.seg = e.target.value; state.tradeView.page = 0; renderTrades(); }
    if (e.target.id === 'tr-sym') { state.tradeView.symbol = e.target.value; state.tradeView.page = 0; renderTrades(); }
  });
  $('trades').addEventListener('click', (e) => {
    if (e.target.id === 'tr-prev') { state.tradeView.page--; renderTrades(); }
    if (e.target.id === 'tr-next') { state.tradeView.page++; renderTrades(); }
  });
}

async function runDemo() {
  setMarket('perp', true);
  await loadSymbolList('perp');
  state.symbols = ['BTCUSDT', 'ETHUSDT'];
  renderSymbols();
  setBaseTf('1h');
  state.days = 180; $('days').value = '180';
  $('feePct').value = '0.05';
  $('s-budget').value = '60'; $('s-maxc').value = '3'; $('s-dir').value = 'both';
  document.querySelector('[data-tab="search"]').click();
  updateDataWarn();
  runSearch();
}

// ---------------- 啟動 ----------------
async function init() {
  initTheme();
  initInfo();
  decorate(document);
  const s = loadSettings();
  if (s.costs) {
    $('capital').value = s.costs.capital ?? 10000; $('posPct').value = s.costs.posPct ?? 100;
    $('feePct').value = s.costs.feePct ?? 0.05; $('slipPct').value = s.costs.slipPct ?? 0.05; $('mmrPct').value = s.costs.mmrPct ?? 0.5;
  }
  if (s.symbols && s.symbols.length) state.symbols = s.symbols.slice(0, MAX_SYMBOLS);
  if (s.baseTf && TIMEFRAMES.includes(s.baseTf)) state.baseTf = s.baseTf;
  if (s.days) state.days = s.days;
  $('base-tf').value = state.baseTf; $('days').value = String(state.days);
  applyDaysLimit();
  state.search.tfs = [state.baseTf];
  state.manual.entry = [{ id: 'rsi_overbought', tf: state.baseTf, params: { level: 75 }, within: 1 }];
  bind();
  renderSearchPane();
  renderManual();
  renderSymbols();
  setMarket(s.market === 'spot' ? 'spot' : 'perp', true);
  setDir(s.market === 'spot' ? 'long' : 'short');
  updateDataWarn();
}
init();
void fmtMoney; void fmtPct; void describeSpec; void TF_MS;
