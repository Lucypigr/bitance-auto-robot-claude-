import { initInfo, decorate, term, esc } from './info.js';
import { BinanceClient, IdbStore, MemoryStore, loadMarketData, sortSymbols } from '../data/binance.js';
import { FinMindClient, loadTwData, twseQuotes } from '../data/finmind.js';
import { buildDataset, buildTwDataset } from '../core/dataset.js';
import { SignalEngine } from '../core/signals.js';
import { normalizeSpec, describeSpec, conditionGroups, CONDITIONS, validateSpec } from '../core/conditions.js';
import { describeStrategy, DEFAULT_POOL } from '../core/search.js';
import { TIMEFRAMES, TF_LABEL, TF_MS, DAY, tfIndex, timeAt } from '../core/util.js';
import { ComputeClient } from './worker-client.js';
import { refreshChartTheme, destroyAll, candleChart, chartTime } from './charts.js';
import { TEMPLATES, defaultCondition, renderConditionList, bindConditionList, softUpdateConditionList, describeManual } from './strategy-form.js';
import * as R from './results.js';
import { diagnoseStrategy, diagnoseSearch } from '../core/diagnose.js';
import { fmtMoney, fmtPct } from './format.js';
import { initTutorial } from './tutorial.js';
import { createLibrary, downloadText, toast } from './library-ui.js';
import { makeSnapshot, tradesRows, equityRows, boardRows, foldsRows, wfChainRows, toCsv, exportJson } from '../core/report.js';

const $ = (id) => document.getElementById(id);
const MAX_SYMBOLS = 15;
const FALLBACK_SYMBOLS = ['BTC', 'ETH', 'BNB', 'SOL', 'XRP', 'DOGE', 'ADA', 'AVAX', 'LINK', 'DOT', 'LTC', 'TRX', 'ATOM', 'NEAR', 'UNI'].map((b, i) => ({ symbol: `${b}USDT`, base: b, quoteVolume: 1e9 / (i + 1), change24h: 0 }));
const TW_FALLBACK = [['2330', '台積電'], ['2317', '鴻海'], ['2454', '聯發科'], ['2881', '富邦金'], ['2412', '中華電'], ['0050', '元大台灣50'], ['00878', '國泰永續高股息']].map(([symbol, base]) => ({ symbol, base, quoteVolume: 0, change24h: 0, isEtf: /^00/.test(symbol) }));
const MAX_DAYS = { '5m': 365, '15m': 730, '1h': 1095, '4h': 1095, '1d': 1095 };

let library;
const state = {
  market: 'perp',
  symbols: ['BTCUSDT', 'ETHUSDT'],
  allSymbols: { spot: null, perp: null, tw: null },
  baseTf: '1h',
  days: 180,
  useMark: true,
  tab: 'search',
  manual: { unit: 'pct', posUsdt: 0, dir: 'short', entry: [], exit: [], sl: 3, tp: 5, trail: 0, lev: 1, maxBars: 0, entryMode: 'edge' },
  search: { direction: 'both', maxConditions: 3, budget: 120, tfs: [], minTrades: 20, sl: [1, 2, 3, 5], tp: [1, 2, 3, 5, 10], lev: [1, 2, 3, 5, 10], seed: 20240601, entryMode: 'edge', allowOpposite: false, pool: DEFAULT_POOL.slice() },
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
let fmToken = '';
try { fmToken = localStorage.getItem('bt.fmtoken') || ''; } catch { /* ignore */ }
const fmClient = new FinMindClient({ token: fmToken });
const isTw = () => state.market === 'tw';
const CUR = () => (isTw() ? 'TWD' : 'USDT');
const TW_DEFAULTS = ['2330', '2317', '2454', '0050'];
const marketName = () => (isTw() ? '台股（日線）' : state.market === 'perp' ? '永續合約' : '現貨');
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
      costs: readCosts(true), trainPct: $('train-pct').value,
    }));
  } catch { /* 無痕模式等情況，忽略 */ }
}

// ---------------- 成本 ----------------
function readCosts(raw = false) {
  const n = (id, d) => { const v = Number($(id).value); return Number.isFinite(v) ? v : d; };
  const r = { capital: n('capital', 10000), posPct: n('posPct', 100), feePct: n('feePct', 0.05), slipPct: n('slipPct', 0.05), mmrPct: n('mmrPct', 0.5), taxPct: n('taxPct', 0.3), taxEtfPct: n('taxEtfPct', 0.1), minFee: n('minFee', 20) };
  if (raw) return r;
  return {
    tax: Math.max(0, r.taxPct / 100), taxEtf: Math.max(0, r.taxEtfPct / 100), minFee: Math.max(0, r.minFee),
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
  $('btn-wf').disabled = b;
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
    if (c && Date.now() - c.t < 600e3) { state.allSymbols[market] = c.list; return c.list; }
  } catch { /* ignore */ }
  $('sym-status').textContent = market === 'tw' ? '正在取得台股清單…' : '正在從幣安取得幣種清單…';
  try {
    let list;
    if (market === 'tw') {
      list = await fmClient.listStocks();
      const q = await twseQuotes();
      for (const s of list) { const x = q.get(s.symbol); if (x) { s.quoteVolume = x.turnover; s.change24h = x.change * 100; } }
      list.sort((a, b) => b.quoteVolume - a.quoteVolume || (a.symbol < b.symbol ? -1 : 1));
    } else list = await client.listSymbols(market);
    state.allSymbols[market] = list;
    try { sessionStorage.setItem(key, JSON.stringify({ t: Date.now(), list })); } catch { /* ignore */ }
    $('sym-status').textContent = market === 'tw' ? `共 ${list.length} 檔上市櫃股票與 ETF（排序與漲跌幅為最近一個交易日，只有上市股票有行情）` : `共 ${list.length} 個 USDT ${market === 'perp' ? '永續合約' : '現貨'}交易對（依 24 小時成交額排序）`;
    return list;
  } catch (e) {
    if (market === 'tw') {
      state.allSymbols[market] = TW_FALLBACK;
      $('sym-status').innerHTML = `<span class="neg">無法取得台股清單：${esc(e.message)}</span>（已改用內建常用股票）`;
      return TW_FALLBACK;
    }
    state.allSymbols[market] = FALLBACK_SYMBOLS;
    $('sym-status').innerHTML = `<span class="neg">無法取得幣種清單：${esc(e.message)}</span>（已改用內建常用幣種；實際下載資料時若仍被拒絕，請換個網路環境）`;
    return FALLBACK_SYMBOLS;
  }
}

const histCache = new Map();
function sortedSymbols() {
  const mode = $('sym-sort').value;
  let list = state.allSymbols[state.market] || [];
  if (mode === 'hist' || mode === 'histloss') {
    const h = histCache.get(histKey());
    list = h ? list.filter((s) => h.returns.has(s.symbol)).map((s) => ({ ...s, histRet: h.returns.get(s.symbol) })) : [];
  }
  return sortSymbols(list, mode);
}
const histKey = () => `${state.market}|${$('hist-end').value}|${$('hist-win').value}|${$('hist-top').value}`;
function histNote() {
  const h = histCache.get(histKey());
  if (!h) return '';
  const f = (ms) => new Date(ms).toISOString().slice(0, 10);
  const endDays = Number($('hist-end').value);
  const overlap = state.days > endDays;
  return `榜單區間（UTC 日線）：${f(h.start)} ～ ${f(h.end - 1)}，共 ${h.returns.size} 個合約有完整資料。` +
    (overlap ? ` <b class="neg">⚠ 回測期間（近 ${state.days} 天）包含這段榜單區間，等於事後挑出贏家，結果會偏樂觀。</b>` : ' ✓ 回測期間在榜單區間之後，可當作「前瞻」檢驗。');
}
async function computeHist() {
  const st = $('hist-status');
  const list = (state.allSymbols[state.market] || []).slice(0, Number($('hist-top').value));
  st.textContent = '正在下載日線並計算…';
  $('hist-go').disabled = true;
  try {
    const r = await client.historicalGainers(state.market, list.map((s) => s.symbol), {
      endDaysAgo: Number($('hist-end').value), windowDays: Number($('hist-win').value),
      onProgress: (p) => { st.textContent = `計算中 ${p.done}／${p.total}`; },
    });
    histCache.set(histKey(), r);
    st.innerHTML = histNote();
  } catch (e) { st.innerHTML = `<span class="neg">計算失敗：${esc(e.message)}</span>`; }
  $('hist-go').disabled = false;
  renderSymbols();
}

function renderSymbols() {
  const list = sortedSymbols();
  const q = $('sym-search').value.trim().toUpperCase();
  const sel = new Set(state.symbols);
  const filtered = (q ? list.filter((s) => s.symbol.includes(q) || (s.base || '').toUpperCase().includes(q)) : list).slice(0, 80);
  const tw = isTw();
  const nameOf = (code) => { const f = (state.allSymbols[state.market] || []).find((x) => x.symbol === code); return tw && f ? `${code} ${f.base}` : symOf(code); };
  $('sym-list').innerHTML = filtered.map((s) => `<button type="button" class="sym-item" role="option" aria-selected="${sel.has(s.symbol)}" data-sym="${s.symbol}"><span>${sel.has(s.symbol) ? '✓ ' : ''}${tw ? esc(s.symbol) + ' ' + esc(s.base) : esc(s.base || symOf(s.symbol)) + '<span class="muted">/USDT</span>'}</span><span class="vol">${(() => { const v = s.histRet !== undefined ? s.histRet * 100 : s.change24h; return v !== undefined ? `<b class="${v >= 0 ? 'pos' : 'neg'}">${v >= 0 ? '+' : ''}${v.toFixed(1)}%</b> ` : ''; })()}${s.quoteVolume ? (tw ? '成交 ' + (s.quoteVolume / 1e8).toFixed(1) + '億' : '成交 ' + (s.quoteVolume / 1e6).toFixed(0) + 'M') : ''}</span></button>`).join('') || `<div class="muted small" style="padding:8px">${['hist', 'histloss'].includes($('sym-sort').value) && !list.length ? '請先設定區間並按「計算榜單」' : '找不到符合的標的'}</div>`;
  $('sym-selected').innerHTML = state.symbols.map((s) => `<span class="chip">${esc(nameOf(s))}<button type="button" data-rm="${s}" aria-label="移除 ${esc(s)}">✕</button></span>`).join('');
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
  const was = state.market;
  state.market = m;
  document.querySelectorAll('[data-market]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.market === m)));
  const perp = m === 'perp';
  const tw = m === 'tw';
  $('mmr-field').hidden = !perp; $('mark-field').hidden = !perp; $('s-lev-field').hidden = !perp;
  $('tw-fields').hidden = !tw;
  $('m-lev').disabled = !perp;
  if (!perp) { state.manual.lev = 1; $('m-lev').value = 1; $('m-lev-out').textContent = '1×'; if (state.manual.dir === 'short') setDir('long'); }
  document.querySelector('[data-dir="short"]').disabled = !perp;
  $('s-dir').querySelector('option[value="short"]').disabled = !perp;
  $('s-dir').querySelector('option[value="both"]').disabled = !perp;
  if (!perp && $('s-dir').value !== 'long') $('s-dir').value = 'long';
  // 台股：只有日線；歷史漲幅榜（用加密貨幣日線）不適用
  for (const o of $('base-tf').options) o.disabled = tw && o.value !== '1d';
  for (const o of $('sym-sort').querySelectorAll('option[value="hist"], option[value="histloss"]')) o.disabled = tw;
  $('sym-label').textContent = tw ? '股票／ETF' : '幣種';
  $('sym-search').placeholder = tw ? '搜尋代號或名稱，例如 2330、台積電…' : '搜尋，例如 BTC、SOL…';
  $('sym-sort').querySelector('option[value="volume"]').textContent = tw ? '最近交易日成交值' : '24h 成交額';
  $('sym-sort').querySelector('option[value="gain"]').textContent = tw ? '最近交易日漲幅榜（高→低）' : '24h 漲幅榜（高→低）';
  $('sym-sort').querySelector('option[value="loss"]').textContent = tw ? '最近交易日跌幅榜（大→小）' : '24h 跌幅榜（大→小）';
  if (tw && ['hist', 'histloss'].includes($('sym-sort').value)) { $('sym-sort').value = 'volume'; $('hist-box').hidden = true; }
  if (tw) {
    setBaseTf('1d');
    if (was !== 'tw') { state.days = 730; $('days').value = '730'; }
    if (!silent) { $('feePct').value = '0.1425'; if (Number($('capital').value) === 10000) $('capital').value = '1000000'; }
  } else {
    if (was === 'tw') { if (state.baseTf === '1d') setBaseTf('1h'); if (Number($('capital').value) === 1000000) $('capital').value = '10000'; }
    if (!silent) { $('feePct').value = perp ? '0.05' : '0.1'; }
  }
  document.querySelectorAll('[data-cur]').forEach((el) => { el.textContent = el.dataset.cur.replace('{C}', CUR()); });
  loadSymbolList(m).then((list) => {
    const have = new Set(list.map((s) => s.symbol));
    state.symbols = state.symbols.filter((s) => have.has(s));
    if (!state.symbols.length) state.symbols = (tw ? TW_DEFAULTS : ['BTCUSDT', 'ETHUSDT']).filter((s) => have.has(s));
    renderSymbols(); updateDataWarn();
  });
  renderSymbols();
  saveSettings();
}

function updateDataWarn() {
  for (const id of ['m-maxpos', 's-maxpos']) $(id).max = String(Math.max(1, state.symbols.length));
  const bars = isTw() ? state.days * 0.69 : (state.days * DAY) / TF_MS[state.baseTf];
  const total = bars * state.symbols.length;
  const w = $('data-warn');
  const msgs = [];
  if (total > 1.2e6) msgs.push(`預計載入約 ${(total / 1e4).toFixed(0)} 萬根 K 線（${state.symbols.length} 個幣種 × ${Math.round(bars).toLocaleString()} 根），下載與運算會比較久。`);
  if (!state.symbols.length) msgs.push(isTw() ? '請至少選擇 1 檔股票。' : '請至少選擇 1 個幣種。');
  if (isTw() && state.days < 365) msgs.push('台股只有日線，資料天數太短時交易筆數會很少；建議至少近 1 年（最好 2～3 年）。');
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
  if ($('s-unit').value === 'usdt') document.querySelectorAll('input[name="s-sl"], input[name="s-tp"]').forEach((i) => { i.disabled = true; });
  decorate($('pane-search'));
}
function renderPool() {
  const sel = new Set(state.search.pool);
  $('s-pool').innerHTML = conditionGroups().map((g) => `<div class="field"><div class="label">${term(CONDITIONS[g.items[0].id].term.startsWith('pat_') ? 'pat_hammer' : CONDITIONS[g.items[0].id].term, g.group)}</div>
    <div class="checks">${g.items.map((it) => `<span class="pool-item"><label class="check"><input type="checkbox" name="s-pool" value="${it.id}" ${sel.has(it.id) ? 'checked' : ''}> ${esc(it.label)}</label><button type="button" class="ibtn" data-term="${esc(CONDITIONS[it.id].term)}" data-ill="${it.id}" aria-label="說明與示意圖：${esc(it.label)}">ⓘ</button></span>`).join('')}</div></div>`).join('');
  $('pool-count').textContent = `已選 ${sel.size} 個條件`;
  decorate($('pool-adv'));
}
function setPool(ids) { state.search.pool = ids; renderPool(); refreshAdvNote(); }
const DEF_SL = [1, 2, 3, 5];
const DEF_TP = [1, 2, 3, 5, 10];
const DEF_LEV = [1, 2, 3, 5, 10];
const DEF_SEED = 20240601;
const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));

/** 自動搜尋的「進階」設定中，哪些和預設不同（用來提醒使用者，避免忘了自己改過） */
function advancedChanges() {
  const out = [];
  const cur = CUR();
  if ($('s-unit').value !== 'pct') out.push(`停損停利單位＝${cur} 金額`);
  const pu = Number($('s-usdt').value) || 0;
  if (pu > 0) out.push(`每筆固定投入 ${pu} ${cur}`);
  if ($('s-sl-custom').value.trim()) out.push(`自訂停損「${$('s-sl-custom').value.trim()}」`);
  if ($('s-tp-custom').value.trim()) out.push(`自訂停利「${$('s-tp-custom').value.trim()}」`);
  if ($('s-unit').value === 'pct') {
    if (!sameSet(readChecks('s-sl'), DEF_SL)) out.push(`停損範圍＝${readChecks('s-sl').join('/') || '無'}`);
    if (!sameSet(readChecks('s-tp'), DEF_TP)) out.push(`停利範圍＝${readChecks('s-tp').join('/') || '無'}`);
  }
  if (state.market === 'perp' && !sameSet(readChecks('s-lev'), DEF_LEV)) out.push(`槓桿範圍＝${readChecks('s-lev').join('/') || '無'}`);
  if (Number($('s-seed').value) !== DEF_SEED) out.push(`亂數種子＝${$('s-seed').value}`);
  if ($('s-entrymode').value !== 'edge') out.push('進場方式＝成立期間都可進場');
  if ($('s-opp').checked) out.push('允許逆向條件');
  if ($('s-psearch').checked) out.push('同時搜尋指標參數');
  if ($('s-capmode').value === 'shared') out.push(`共用資金池·最多 ${$('s-maxpos').value} 檔`);
  if ((Number($('s-risk').value) || 0) > 0) out.push(`每筆風險 ${$('s-risk').value}%`);
  const pool = readChecks('s-pool');
  if (!sameSet(pool, DEFAULT_POOL)) out.push(`指標池 ${pool.length} 個（預設 ${DEFAULT_POOL.length} 個）`);
  return out;
}
function refreshAdvNote() {
  const c = advancedChanges();
  $('adv-note').hidden = c.length === 0;
  $('adv-list').textContent = c.join('；');
}
function resetAdvanced() {
  $('s-unit').value = 'pct'; $('s-usdt').value = 0;
  $('s-sl-custom').value = ''; $('s-tp-custom').value = '';
  $('s-seed').value = DEF_SEED; $('s-entrymode').value = 'edge'; $('s-opp').checked = false; $('s-psearch').checked = false; $('s-psearch-note').hidden = true;
  $('s-capmode').value = 'sleeve'; $('s-maxpos').value = 1; $('s-risk').value = 0; $('s-maxpos-field').hidden = true;
  $('s-unit-note').hidden = true;
  Object.assign(state.search, { sl: DEF_SL.slice(), tp: DEF_TP.slice(), lev: DEF_LEV.slice(), pool: DEFAULT_POOL.slice() });
  renderSearchPane();
  renderPool();
  refreshAdvNote();
}

function readChecks(name) {
  return [...document.querySelectorAll(`input[name="${name}"]:checked`)].map((i) => Number(i.value) || i.value);
}

function readTrainFrac() {
  const v = Number($('train-pct').value);
  return v >= 50 && v <= 80 ? v / 100 : 0.7;
}

function readSearchConfig() {
  const unit = $('s-unit').value;
  const parse = (id) => [...new Set($(id).value.split(/[,，\s]+/).map(Number).filter((x) => Number.isFinite(x) && x > 0))];
  const posUsdt = Math.max(0, Number($('s-usdt').value) || 0);
  const sl = [...(unit === 'pct' ? readChecks('s-sl') : []), ...parse('s-sl-custom')];
  const tp = [...(unit === 'pct' ? readChecks('s-tp') : []), ...parse('s-tp-custom')];
  const lev = readChecks('s-lev');
  if (unit === 'usdt' && !(posUsdt > 0)) throw new Error('USDT 模式需要填寫「每筆投入」金額');
  if ((Number($('s-risk').value) || 0) > 0 && unit === 'usdt') throw new Error('每筆風險只能搭配「價格 %」的停損，請把停損停利單位改回價格 %');
  const tfs = [...new Set([state.baseTf, ...readChecks('s-tf')])];
  if (!sl.length || !tp.length) throw new Error('停損與停利至少各選一個');
  const minTrades = Math.max(1, Number($('s-min').value) || 20);
  const pool = readChecks('s-pool');
  if (!pool.length) throw new Error('指標池至少要勾選一個條件');
  const cfg = {
    pool, unit, posUsdt, trainFrac: readTrainFrac(), cur: CUR(),
    capitalMode: $('s-capmode').value, riskPct: Math.max(0, Number($('s-risk').value) || 0),
    maxPos: $('s-capmode').value === 'shared' ? Math.max(1, Math.min(state.symbols.length || 1, Math.floor(Number($('s-maxpos').value)) || 1)) : 0,
    direction: state.market === 'spot' ? 'long' : $('s-dir').value,
    maxConditions: Number($('s-maxc').value), budget: Number($('s-budget').value),
    tfs, minTrades, slList: sl, tpList: tp, levList: state.market === 'spot' ? [1] : (lev.length ? lev : [1]),
    seed: Number($('s-seed').value) || 1, entryMode: $('s-entrymode').value, allowOpposite: $('s-opp').checked,
    paramSearch: $('s-psearch').checked ? 'grid' : 'fixed',
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
function renderManual(soft = false) {
  const m = state.manual;
  if (soft === true) {
    softUpdateConditionList($('m-entry'), m.entry, state.baseTf);
    softUpdateConditionList($('m-exit'), m.exit, state.baseTf, { groups: false });
  } else {
    renderConditionList($('m-entry'), m.entry, state.baseTf);
    renderConditionList($('m-exit'), m.exit, state.baseTf, { groups: false });
  }
  $('m-summary').innerHTML = esc(describeManual(readManualStrategy(true)));
  decorate($('pane-manual'));
}
function readManualStrategy(soft = false) {
  const m = state.manual;
  const num = (id) => Math.max(0, Number($(id).value) || 0);
  m.sl = num('m-sl'); m.tp = num('m-tp'); m.trail = num('m-trail'); m.maxBars = Math.floor(num('m-maxbars'));
  m.unit = $('m-unit').value; m.posUsdt = num('m-usdt');
  m.capitalMode = $('m-capmode').value; m.riskPct = num('m-risk');
  m.maxPos = Math.max(1, Math.min(state.symbols.length || 1, Math.floor(num('m-maxpos')) || 1));
  $('m-maxpos-field').hidden = m.capitalMode !== 'shared';
  m.lev = state.market === 'spot' ? 1 : Number($('m-lev').value) || 1;
  m.entryMode = $('m-entrymode').value;
  const fix = (c) => { const n = normalizeSpec(c); if (tfIndex(n.tf) < tfIndex(state.baseTf)) n.tf = state.baseTf; return n; };
  const st = { dir: m.dir, entry: m.entry.map(fix), exit: m.exit.map(fix), entryMode: m.entryMode, lev: m.lev, cur: CUR(), capitalMode: m.capitalMode, maxPos: m.capitalMode === 'shared' ? m.maxPos : 0, riskPct: m.riskPct, unit: m.unit, posUsdt: m.posUsdt, sl: m.sl, tp: m.tp, trail: m.trail, maxBars: m.maxBars };
  if (!soft) for (const sp of [...m.entry, ...m.exit]) { const e = validateSpec(sp); if (e) throw new Error(e); }
  if (!soft && !st.entry.length) throw new Error('請至少新增一個進場條件');
  if (!soft && st.riskPct > 0 && (!(st.sl > 0) || st.unit === 'usdt')) throw new Error('每筆風險需要設定「價格 %」的停損');
  if (!soft && st.unit === 'usdt' && !(st.posUsdt > 0)) throw new Error('USDT 模式需要填寫「每筆投入」金額（例如 6）');
  return st;
}
function applyTemplate(id) {
  const t = TEMPLATES.find((x) => x.id === id);
  if (!t) return;
  if (t.baseTf && state.baseTf !== t.baseTf) setBaseTf(t.baseTf);
  const s = t.strategy(state.baseTf);
  Object.assign(state.manual, { dir: s.dir, entry: s.entry, exit: s.exit || [], sl: s.sl, tp: s.tp, trail: s.trail || 0, lev: state.market === 'spot' ? 1 : s.lev, maxBars: 0 });
  if (state.market === 'spot' && s.dir === 'short') state.manual.dir = 'long';
  $('m-unit').value = 'pct'; $('m-usdt').value = 0;
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
  if (!state.symbols.length) throw new Error(isTw() ? '請至少選擇 1 檔股票' : '請至少選擇 1 個幣種');
  const key = JSON.stringify([state.market, [...state.symbols].sort(), state.baseTf, state.days, state.market === 'perp' && $('useMark').checked]);
  if (state.data && state.data.key === key && [...tfSet].every((t) => state.data.tfs.has(t))) return state.data;
  const tfs = new Set([...(state.data && state.data.key === key ? state.data.tfs : []), ...tfSet]);
  const prog = $('load-progress');
  setProgress(prog, 0, 1, '正在下載 K 線…');
  let ds;
  if (isTw()) {
    const list = state.allSymbols.tw || [];
    const raw = await loadTwData(fmClient, store, {
      symbols: state.symbols.map((code) => { const f = list.find((x) => x.symbol === code); return { symbol: code, name: f ? f.base : '', isEtf: f ? f.isEtf : /^00/.test(code) }; }),
      days: state.days, signal: state.abort && state.abort.signal,
      onProgress: (p) => setProgress(prog, p.done, p.total, `下載中 ${p.done}／${p.total}　${p.label || ''}`),
    });
    setProgress(prog, 1, 1, '整理資料中…');
    ds = buildTwDataset({ windowStart: raw.windowStart, symbols: raw.symbols });
    ds.warnings.push(...raw.warnings);
  } else {
    const raw = await loadMarketData(client, store, {
      market: state.market, symbols: state.symbols, baseTf: state.baseTf, tfs: [...tfs], days: state.days,
      useMark: $('useMark').checked, signal: state.abort && state.abort.signal,
      onProgress: (p) => setProgress(prog, p.done, p.total, `下載中 ${p.done}／${p.total}　${p.label || ''}`),
    });
    setProgress(prog, 1, 1, '整理資料中…');
    ds = buildDataset({ market: state.market, baseTf: state.baseTf, windowStart: raw.windowStart, endTime: raw.endTime, symbols: raw.symbols });
    ds.warnings.push(...raw.warnings);
  }
  await compute.setDataset(ds);
  prog.hidden = true;
  state.data = { key, tfs, ds, sig: new SignalEngine(ds) };
  state.detailCache.clear();
  const bars = ds.n - ds.windowStartIdx;
  $('data-info').innerHTML = (isTw()
    ? `已載入 <b>${ds.symbols.length}</b> 檔 × <b>${bars.toLocaleString()}</b> 個交易日（還原股價，另含約 300 個交易日暖機）`
    : `已載入 <b>${ds.symbols.length}</b> 個幣種 × <b>${bars.toLocaleString()}</b> 根 ${TF_LABEL[state.baseTf]} K 線`) +
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
  for (let i = Math.max(ds.windowStartIdx, S.first); i <= S.last; i++) candles.push({ time: chartTime(ds, timeAt(ds, i)), open: S.o[i], high: S.h[i], low: S.l[i], close: S.c[i] });
  destroyAll();
  candleChart(el, { candles });
}

// ---------------- 執行 ----------------
function costsNote(c) {
  if (isTw()) return `買進手續費 ${(c.fee * 100).toFixed(4)}%、賣出手續費＋證交稅 ${((c.fee + c.tax) * 100).toFixed(4)}%（ETF ${((c.fee + c.taxEtf) * 100).toFixed(4)}%）、最低手續費 ${c.minFee}、滑價 ${(c.slippage * 100).toFixed(3)}%`;
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
    const res = await compute.backtest(strategy, costs, readTrainFrac());
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

async function runWalk() {
  showError('');
  let cfg;
  try { cfg = readSearchConfig(); } catch (e) { showError(e.message); return; }
  cfg.folds = Number($('wf-folds').value); cfg.ratio = Number($('wf-ratio').value); cfg.follow = $('wf-follow').value;
  state.abort = new AbortController();
  setBusy(true, true);
  const prog = $('search-progress');
  try {
    await ensureData(new Set(cfg.tfs));
    const costs = readCosts();
    setProgress(prog, 0, 1, '走動式驗證準備中…');
    const wf = await compute.walkForward(cfg, costs, (p) => {
      const frac = p.phase === 'eval' ? p.done / Math.max(1, p.total) : p.phase === 'done' ? 1 : 0;
      const label = p.phase === 'eval' ? `第 ${p.fold}／${p.folds} 折：在訓練期測試候選 ${p.done}／${p.total}` : p.phase === 'validate' ? `第 ${p.fold}／${p.folds} 折：驗證冠軍` : `第 ${p.fold}／${p.folds} 折：產生候選組合…`;
      setProgress(prog, (p.fold - 1) + frac, p.folds, label);
    });
    prog.hidden = true;
    if (wf.cancelled) { showError('已取消走動式驗證'); return; }
    state.searchResult = null;
    showWalkForward(wf, costs);
  } catch (e) {
    if (e.kind !== 'abort') showError(e.message || String(e));
    prog.hidden = true; $('load-progress').hidden = true;
  } finally { setBusy(false); }
}

// ---------------- 儲存／匯出／我的回測 ----------------
const todayStr = () => new Date().toISOString().slice(0, 10);
function costsRawOf(c) {
  return { capital: c.capital, posPct: c.posPct * 100, feePct: c.fee * 100, slipPct: c.slippage * 100, mmrPct: c.mmr * 100, taxPct: (c.tax || 0) * 100, taxEtfPct: (c.taxEtf || 0) * 100, minFee: c.minFee || 0 };
}
function currentSnapshot(name) {
  const v = state.view;
  const ds = state.data.ds;
  const [market, , baseTf, days, useMark] = JSON.parse(state.data.key);
  const bh = R.buyHoldCurve(ds, v.res.ranges.full, v.costs.capital);
  const desc = describeStrategy(v.strategy);
  return makeSnapshot({ res: v.res, ds, strategy: v.strategy, costsRaw: costsRawOf(v.costs), useMark, trainFrac: v.trainFrac, days, market, baseTf, desc, name: name || desc, bh });
}
function renderActions(mode) {
  const el = $('r-actions');
  const btn = (act, label, title) => `<button type="button" class="btn small" data-act="${act}" ${title ? `title="${esc(title)}"` : ''}>${label}</button>`;
  const parts = [];
  if (mode === 'detail') parts.push(btn('save', '💾 儲存這次回測', '存在這台裝置的瀏覽器，之後可載入設定、並排比較'), btn('trades', '⬇ 交易明細 CSV'), btn('equity', '⬇ 淨值曲線 CSV'), btn('json', '⬇ 完整報告 JSON', '含策略、設定與績效，可備份或在另一台裝置匯入'));
  if ((mode === 'detail' || mode === 'search') && state.searchResult) parts.push(btn('board', '⬇ 候選排行榜 CSV', '全部候選的訓練期成績'));
  if (mode === 'wf') parts.push(btn('wf-folds', '⬇ 各折明細 CSV'), btn('wf-chain', '⬇ 串接淨值 CSV'));
  parts.push('<span class="grow"></span>', btn('library', '📁 我的回測'));
  el.innerHTML = `${parts.join('')}<div class="muted small" style="flex-basis:100%">匯出的時間一律是 UTC；CSV 用 UTF-8（含 BOM），可直接用 Excel 開啟。</div>`;
  el.hidden = false;
}
async function onAction(act) {
  try {
    if (act === 'library') { library.open(); return; }
    const ds = state.data.ds;
    const tag = `${state.market}-${todayStr()}`;
    if (act === 'save') {
      const r = library.save(currentSnapshot());
      toast(`已儲存到「我的回測」${r.dropped ? `（超過上限，已丟掉最舊的 ${r.dropped} 筆）` : ''}。可在右上角「📁 我的回測」載入設定或並排比較。`);
    } else if (act === 'trades') downloadText(`trades-${tag}.csv`, toCsv(tradesRows(state.view.res, ds)), 'text/csv');
    else if (act === 'equity') downloadText(`equity-${tag}.csv`, toCsv(equityRows(state.view.res, ds, state.view.costs.capital, R.buyHoldCurve(ds, state.view.res.ranges.full, state.view.costs.capital))), 'text/csv');
    else if (act === 'json') downloadText(`backtest-${tag}.json`, exportJson([currentSnapshot()]), 'application/json');
    else if (act === 'board') downloadText(`candidates-${tag}.csv`, toCsv(boardRows(state.searchResult)), 'text/csv');
    else if (act === 'wf-folds') downloadText(`walkforward-folds-${tag}.csv`, toCsv(foldsRows(state.wf.wf, ds)), 'text/csv');
    else if (act === 'wf-chain') downloadText(`walkforward-equity-${tag}.csv`, toCsv(wfChainRows(state.wf.wf, ds, state.wf.costs.capital)), 'text/csv');
  } catch (e) { toast(e.message || String(e)); }
}

/** 把已儲存的設定（市場、標的、週期、天數、成本、策略）整組載回左側表單 */
async function restoreSnapshot(s) {
  showError('');
  setMarket(s.market, true);
  await loadSymbolList(s.market);
  state.symbols = s.symbols.map((x) => x.symbol).slice(0, MAX_SYMBOLS);
  renderSymbols();
  setBaseTf(s.baseTf);
  const dayOpt = [...$('days').options].find((o) => Number(o.value) === s.days && !o.disabled);
  if (dayOpt) { state.days = s.days; $('days').value = String(s.days); }
  const c = s.costsRaw || {};
  const put = (id, v) => { if (Number.isFinite(v)) $(id).value = String(v); };
  put('capital', c.capital); put('posPct', c.posPct); put('feePct', c.feePct); put('slipPct', c.slipPct); put('mmrPct', c.mmrPct);
  if (s.market === 'tw') { put('taxPct', c.taxPct); put('taxEtfPct', c.taxEtfPct); put('minFee', c.minFee); }
  $('useMark').checked = s.useMark;
  const tp = String(Math.round(s.trainFrac * 100));
  if ([...$('train-pct').options].some((o) => o.value === tp)) $('train-pct').value = tp;
  applyManualStrategy(s.strategy);
  document.querySelector('[data-tab="manual"]').click();
  updateDataWarn(); saveSettings();
  toast(`已載入「${s.name}」的設定到「手動設定策略」，按「執行回測」即可重跑。`);
  $('step2').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function applyManualStrategy(st) {
  const m = state.manual;
  Object.assign(m, {
    dir: st.dir === 'short' && state.market !== 'perp' ? 'long' : st.dir, entry: JSON.parse(JSON.stringify(st.entry || [])), exit: JSON.parse(JSON.stringify(st.exit || [])),
    sl: st.sl || 0, tp: st.tp || 0, trail: st.trail || 0, lev: state.market === 'perp' ? st.lev || 1 : 1, maxBars: st.maxBars || 0,
    unit: st.unit || 'pct', posUsdt: st.posUsdt || 0, entryMode: st.entryMode || 'edge', capitalMode: st.capitalMode || 'sleeve', maxPos: st.maxPos || 1, riskPct: st.riskPct || 0,
  });
  for (const c of [...m.entry, ...m.exit]) if (tfIndex(c.tf) < tfIndex(state.baseTf)) c.tf = state.baseTf;
  $('m-unit').value = m.unit; $('m-usdt').value = m.posUsdt; $('m-sl').value = m.sl; $('m-tp').value = m.tp; $('m-trail').value = m.trail;
  $('m-lev').value = m.lev; $('m-lev-out').textContent = `${m.lev}×`; $('m-maxbars').value = m.maxBars; $('m-entrymode').value = m.entryMode;
  $('m-capmode').value = m.capitalMode; $('m-maxpos').value = m.maxPos; $('m-risk').value = m.riskPct;
  if (m.capitalMode === 'shared' || m.riskPct > 0) $('m-rules-adv').open = true;
  setDir(m.dir);
}

function showWalkForward(wf, costs) {
  showResultShell();
  state.view = null; state.searchResult = null;
  destroyAll();
  for (const id of ['r-champions', 'r-verdict', 'r-compare', 'r-symbols', 'r-diag']) $(id).hidden = true;
  document.querySelector('.card.charts').hidden = true;
  const ds = state.data.ds;
  $('r-title').innerHTML = `<div><h2>走動式驗證</h2><div class="muted small">${costsNote(costs)}　${marketName()}　${ds.symbols.length} ${isTw() ? '檔' : '個幣種'}　候選數上限 ${wf.config.budget}、最低交易數 ${wf.config.minTrades}。</div></div>`;
  state.wf = { wf, costs };
  renderActions('wf');
  $('r-wf').hidden = false;
  R.renderWalkForward($('r-wf'), wf, ds, costs.capital);
  decorate($('r-wf'));
  $('r-wf').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function cancelRun() {
  if (state.abort) state.abort.abort();
  await compute.cancel();
}

// ---------------- 結果顯示 ----------------
function showResultShell() {
  $('r-wf').hidden = true;
  $('result-empty').hidden = true;
  $('result-body').hidden = false;
}

function showSearchResult(result, costs) {
  showResultShell();
  const n = result.candidates.length;
  $('r-title').innerHTML = `<div><h2>自動搜尋結果</h2>
    <div class="muted small">共測試 <b>${n}</b> 組候選（上限 ${result.config.budget}）；符合冠軍資格 ${result.eligibleCount} 組。${costsNote(costs)}。冠軍只用<b>訓練期</b>挑選，<b>樣本外</b>只做驗收。</div>
    ${result.warnings.map((w) => `<div class="note warn">${esc(w)}</div>`).join('')}${R.renderSearchTips(diagnoseSearch(result, state.data.ds))}</div>`;
  $('r-champions').hidden = false;
  renderActions('search');
  R.renderChampions($('r-champions'), result);
  $('tab-board').hidden = false;
  const first = result.champions.stable || result.champions.netReturn || result.champions.winRate;
  if (first) {
    const d = state.detailCache.get(first);
    showDetail({ res: d, strategy: d.strategy, title: null, costs, keepHead: true, candidateId: first });
  } else {
    $('r-verdict').hidden = true; $('r-compare').hidden = true; $('r-diag').hidden = true; $('r-symbols').hidden = true;
    document.querySelector('.card.charts').hidden = false;
    state.view = null;
    selectChartTab('board');
  }
  $('r-champions').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function showDetail({ res, strategy, title, costs, keepHead, candidateId }) {
  showResultShell();
  const tf = Math.round(((res.ranges.train.to - res.ranges.train.from) / (res.ranges.full.to - res.ranges.full.from)) * 100) / 100;
  state.view = { res, strategy, costs, candidateId, trainFrac: tf };
  state.sens = null;
  state.builtCharts = {};
  state.tradeView = { seg: '', symbol: '', page: 0 };
  const ds = state.data.ds;
  if (!keepHead) {
    $('r-champions').hidden = true; $('tab-board').hidden = true;
    $('r-title').innerHTML = `<div><h2>${esc(title)}</h2><div class="strategy" data-testid="strategy-desc">${esc(describeStrategy({ ...strategy, sl: strategy.sl, tp: strategy.tp }))}</div>
      <div class="muted small">${costsNote(costs)}　${marketName()}　${ds.symbols.length} ${isTw() ? '檔' : '個幣種'}　執行週期 ${TF_LABEL[ds.baseTf]}</div></div>`;
  } else {
    const e = state.searchResult.candidates.find((c) => c.id === candidateId);
    $('r-title').querySelector('div').insertAdjacentHTML('beforeend', `<div class="note info" data-testid="detail-head">目前顯示的完整回測：<b>${esc(e.desc)}</b></div>`);
    const old = $('r-title').querySelectorAll('[data-testid="detail-head"]');
    if (old.length > 1) old[0].remove();
  }
  $('r-verdict').hidden = false; $('r-compare').hidden = false; $('r-diag').hidden = false; $('r-wf').hidden = true;
  document.querySelector('.card.charts').hidden = false;
  renderActions('detail');
  R.renderVerdict($('r-verdict'), res);
  R.renderCompare($('r-compare'), res, ds);
  $('r-symbols').hidden = false;
  R.renderSymbolBreakdown($('r-symbols'), res, costs.capital, state.data.ds);
  const minT = state.searchResult ? state.searchResult.config.minTrades : 20;
  R.renderDiagnosis($('r-diag'), diagnoseStrategy(state.data.sig, strategy, res.ranges, res, { minTrades: minT, costs }), state.data.ds);
  const sel = $('c-symbol');
  sel.innerHTML = ds.symbols.map((s, i) => `<option value="${i}">${esc(s.name ? s.symbol + ' ' + s.name : s.symbol)}</option>`).join('');
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
      const res = await compute.backtest(e.strategy, readCosts(), state.searchResult.config.trainFrac);
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
  if (name === 'sens') { renderSens(); return; }
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

async function renderSens() {
  const v = state.view;
  const el = $('sens');
  if (!v) return;
  if (state.sens && state.sens.view === v) { R.renderSensitivity(el, state.sens.data, v.strategy, state.data.ds); decorate(el); return; }
  el.innerHTML = '<div class="muted" data-testid="sens-loading">計算中…（會在基準參數附近重跑幾十次回測）</div>';
  try {
    const data = await compute.sensitivity(v.strategy, v.costs, v.trainFrac);
    if (state.view !== v) return;
    state.sens = { view: v, data };
    R.renderSensitivity(el, data, v.strategy, state.data.ds);
    decorate(el);
  } catch (e) { el.innerHTML = `<div class="note bad">計算失敗：${esc(e.message)}</div>`; }
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
  $('sym-sort').addEventListener('change', () => {
    const hist = ['hist', 'histloss'].includes($('sym-sort').value);
    $('hist-box').hidden = !hist;
    if (hist) $('hist-status').innerHTML = histNote() || '設定區間後按「計算榜單」。';
    renderSymbols();
  });
  $('hist-go').addEventListener('click', computeHist);
  for (const id of ['hist-end', 'hist-win', 'hist-top']) $(id).addEventListener('change', () => { $('hist-status').innerHTML = histNote() || '設定區間後按「計算榜單」。'; renderSymbols(); });
  $('sym-list').addEventListener('click', (e) => { const b = e.target.closest('[data-sym]'); if (b) toggleSymbol(b.dataset.sym); });
  $('sym-selected').addEventListener('click', (e) => { const b = e.target.closest('[data-rm]'); if (b) toggleSymbol(b.dataset.rm); });
  document.querySelectorAll('[data-preset]').forEach((b) => b.addEventListener('click', () => {
    const n = Number(b.dataset.preset);
    const ranked = sortedSymbols();
    if (n > 0 && !ranked.length) { $('sym-status').innerHTML = '<span class="neg">榜單還沒有資料，請先按「計算榜單」</span>'; return; }
    state.symbols = ranked.slice(0, n).map((s) => s.symbol);
    renderSymbols(); updateDataWarn(); saveSettings();
  }));
  $('base-tf').addEventListener('change', (e) => setBaseTf(e.target.value));
  $('train-pct').addEventListener('change', saveSettings);
  $('fmToken').value = fmToken;
  $('fmToken').addEventListener('change', () => {
    fmToken = $('fmToken').value.trim(); fmClient.token = fmToken;
    try { localStorage.setItem('bt.fmtoken', fmToken); } catch { /* ignore */ }
  });
  $('days').addEventListener('change', (e) => { state.days = Number(e.target.value); if (!$('hist-box').hidden) $('hist-status').innerHTML = histNote(); updateDataWarn(); saveSettings(); });
  for (const id of ['capital', 'posPct', 'feePct', 'slipPct', 'mmrPct']) $(id).addEventListener('change', saveSettings);

  document.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => {
    state.tab = b.dataset.tab;
    document.querySelectorAll('#step2 > .tabs .tab').forEach((x) => { const on = x === b; x.classList.toggle('active', on); x.setAttribute('aria-selected', String(on)); });
    $('pane-search').hidden = state.tab !== 'search'; $('pane-manual').hidden = state.tab !== 'manual';
  }));

  $('s-unit').addEventListener('change', () => {
    const usdt = $('s-unit').value === 'usdt';
    document.querySelectorAll('input[name="s-sl"], input[name="s-tp"]').forEach((i) => { i.disabled = usdt; });
    $('s-unit-note').hidden = !usdt;
  });
  $('s-capmode').addEventListener('change', () => { $('s-maxpos-field').hidden = $('s-capmode').value !== 'shared'; });
  $('adv-reset').addEventListener('click', resetAdvanced);
  $('pane-search').addEventListener('change', refreshAdvNote);
  $('pane-search').addEventListener('input', refreshAdvNote);
  $('pool-default').addEventListener('click', () => setPool(DEFAULT_POOL.slice()));
  $('pool-all').addEventListener('click', () => setPool(Object.keys(CONDITIONS)));
  $('pool-none').addEventListener('click', () => setPool([]));
  $('s-psearch').addEventListener('change', () => { $('s-psearch-note').hidden = !$('s-psearch').checked; });
  $('s-pool').addEventListener('change', () => { state.search.pool = readChecks('s-pool'); $('pool-count').textContent = `已選 ${state.search.pool.length} 個條件`; });
  $('btn-search').addEventListener('click', runSearch);
  $('btn-wf').addEventListener('click', runWalk);
  $('btn-manual').addEventListener('click', runManual);
  $('btn-cancel').addEventListener('click', cancelRun);
  $('btn-demo').addEventListener('click', runDemo);

  // 手動策略
  $('m-template').innerHTML += TEMPLATES.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join('');
  $('m-template').addEventListener('change', (e) => { applyTemplate(e.target.value); const t = TEMPLATES.find((x) => x.id === e.target.value); if (t) $('m-template').title = t.tip; });
  document.querySelectorAll('[data-dir]').forEach((b) => b.addEventListener('click', () => { if (!b.disabled) setDir(b.dataset.dir); }));
  $('m-add-entry').addEventListener('click', () => { state.manual.entry = [...state.manual.entry, defaultCondition(state.baseTf)]; renderManual(); });
  $('m-add-exit').addEventListener('click', () => { state.manual.exit = [...state.manual.exit, { ...defaultCondition(state.baseTf), id: 'rsi_overbought' }]; renderManual(); });
  bindConditionList($('m-entry'), () => state.manual.entry, (l, o) => { state.manual.entry = l; renderManual(!!(o && o.soft)); });
  bindConditionList($('m-exit'), () => state.manual.exit, (l, o) => { state.manual.exit = l; renderManual(!!(o && o.soft)); });
  for (const id of ['m-sl', 'm-tp', 'm-trail', 'm-maxbars', 'm-entrymode', 'm-unit', 'm-usdt', 'm-capmode', 'm-maxpos', 'm-risk']) $(id).addEventListener('input', renderManual);
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
  initTutorial({ demo: () => runDemo() });
  library = createLibrary({ restore: restoreSnapshot, onChange: (n) => { $('lib-count').textContent = n; } });
  $('lib-count').textContent = library.count();
  $('btn-library').addEventListener('click', () => library.open());
  $('r-actions').addEventListener('click', (e) => { const b = e.target.closest('[data-act]'); if (b) onAction(b.dataset.act); });
  const s = loadSettings();
  if (s.costs) {
    $('capital').value = s.costs.capital ?? 10000; $('posPct').value = s.costs.posPct ?? 100;
    $('feePct').value = s.costs.feePct ?? 0.05; $('slipPct').value = s.costs.slipPct ?? 0.05; $('mmrPct').value = s.costs.mmrPct ?? 0.5;
  }
  if (s.trainPct && [...$('train-pct').options].some((o) => o.value === String(s.trainPct))) $('train-pct').value = String(s.trainPct);
  if (s.symbols && s.symbols.length) state.symbols = s.symbols.slice(0, MAX_SYMBOLS);
  if (s.baseTf && TIMEFRAMES.includes(s.baseTf)) state.baseTf = s.baseTf;
  if (s.days) state.days = s.days;
  $('base-tf').value = state.baseTf; $('days').value = String(state.days);
  applyDaysLimit();
  state.search.tfs = [state.baseTf];
  state.manual.entry = [{ id: 'rsi_overbought', tf: state.baseTf, params: { level: 75 }, within: 1 }];
  // 瀏覽器重新整理時可能「記住」上次的表單內容（例如舊的每筆投入 6），進階設定一律回到預設
  document.querySelectorAll('input, select').forEach((el) => el.setAttribute('autocomplete', 'off'));
  bind();
  renderSearchPane();
  renderPool();
  resetAdvanced();
  window.addEventListener('pageshow', (e) => { if (e.persisted) resetAdvanced(); });
  renderManual();
  renderSymbols();
  const mkt = ['spot', 'tw'].includes(s.market) ? s.market : 'perp';
  setMarket(mkt, true);
  setDir(mkt === 'perp' ? 'short' : 'long');
  updateDataWarn();
}
init();
void fmtMoney; void fmtPct; void describeSpec; void TF_MS;
