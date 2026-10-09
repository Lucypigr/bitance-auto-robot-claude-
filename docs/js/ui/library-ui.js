// 「我的回測」視窗：清單、載入、改名、刪除、匯入／匯出 JSON、並排比較
import { esc, decorate } from './info.js';
import { fmtPct, fmtNum, fmtDate, signClass } from './format.js';
import { lineChart, chartTime, cssVar } from './charts.js';
import { RunLibrary } from '../core/library.js';
import { compareRows, compareWarnings, normalizedCurves, exportJson, parseImport, MAX_SAVED } from '../core/report.js';
import { TF_LABEL } from '../core/util.js';

const MARKET = { perp: 'USDT 永續', spot: '現貨', tw: '台股' };
const COLORS = ['#4c82ff', '#f59e0b', '#14b8a6', '#a855f7'];
const MAX_COMPARE = 4;

export function downloadText(filename, text, mime = 'text/plain') {
  const bom = mime.startsWith('text/csv') ? '﻿' : ''; // 讓 Excel 正確辨識 UTF-8 中文
  const blob = new Blob([bom + text], { type: `${mime};charset=utf-8` });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

let toastTimer = 0;
export function toast(msg) {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 4200);
}

const fmtVal = (fmt, v) => {
  if (fmt === 'pct') return fmtPct(v, 1, true);
  if (fmt === 'num') return v >= 1e6 ? '∞' : fmtNum(v);
  if (fmt === 'x') return `${v}×`;
  return String(Math.round(v));
};

export function createLibrary({ restore, onChange }) {
  let kv;
  try { kv = window.localStorage; kv.getItem('x'); } catch { kv = null; }
  const mem = new Map();
  const lib = new RunLibrary(kv || { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, v), removeItem: (k) => mem.delete(k) });

  let root = null;
  let view = 'list'; // list | compare
  let selected = new Set();
  let seg = 'oos';
  let lastFocus = null;

  const count = () => lib.list().length;

  function build() {
    root = document.createElement('div');
    root.id = 'library';
    root.className = 'tut-overlay';
    root.hidden = true;
    root.innerHTML = `<div class="tut-panel lib-panel" role="dialog" aria-modal="true" aria-labelledby="lib-title" data-testid="library">
      <div class="tut-head"><h2 id="lib-title">📁 我的回測</h2><button type="button" class="btn ghost small" data-lib="close" aria-label="關閉">✕</button></div>
      <div class="tut-body lib-body" tabindex="0"></div>
      <div class="tut-foot lib-foot"></div>
      <input type="file" id="lib-file" accept="application/json,.json" hidden>
    </div>`;
    document.body.appendChild(root);
    root.addEventListener('click', onClick);
    root.addEventListener('change', onChange_);
    document.addEventListener('keydown', (e) => { if (root && !root.hidden && e.key === 'Escape') close(); });
  }

  function open() {
    if (!root) build();
    lastFocus = document.activeElement;
    view = 'list';
    selected = new Set([...selected].filter((id) => lib.get(id)));
    root.hidden = false;
    document.body.classList.add('tut-open');
    render();
    root.querySelector('[data-lib="close"]').focus();
  }
  function close() {
    if (!root || root.hidden) return;
    root.hidden = true;
    document.body.classList.remove('tut-open');
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  function render() {
    const body = root.querySelector('.lib-body');
    const foot = root.querySelector('.lib-foot');
    const list = lib.list();
    if (view === 'compare') { renderCompare(body, foot, list); return; }
    if (!list.length) {
      body.innerHTML = `<div class="empty-lib" data-testid="lib-empty"><p><b>還沒有儲存的回測。</b></p><p class="muted">跑完一次回測後，按結果上方的「💾 儲存這次回測」就會出現在這裡，可以重新載入設定、匯出、並排比較。</p><p class="muted small">資料只存在這台裝置的這個瀏覽器（清除網站資料就會消失）；想換裝置或備份，請用「匯出」。最多保留 ${MAX_SAVED} 筆。</p></div>`;
    } else {
      body.innerHTML = `<p class="muted small">勾選 2～${MAX_COMPARE} 筆可並排比較。資料只存在這台裝置的瀏覽器裡，最多 ${MAX_SAVED} 筆。</p>
      <ul class="lib-list" data-testid="lib-list">${list.map((s) => {
        const o = s.metrics.oos;
        const t = s.metrics.train;
        return `<li class="lib-item" data-id="${esc(s.id)}">
          <label class="lib-check"><input type="checkbox" data-lib-sel="${esc(s.id)}" ${selected.has(s.id) ? 'checked' : ''} aria-label="選取 ${esc(s.name)} 做比較"></label>
          <div class="lib-main"><div class="lib-name">${esc(s.name)}</div>
            <div class="muted small">${esc(fmtDate(s.savedAt))}　${MARKET[s.market] || ''}　${s.symbols.length} 個標的　${esc(TF_LABEL[s.baseTf] || s.baseTf)}　${s.days} 天　訓練/樣本外 ${Math.round(s.trainFrac * 100)}/${100 - Math.round(s.trainFrac * 100)}</div>
            <div class="small lib-desc">${esc(s.desc)}</div>
            <div class="small">訓練期 <b class="${signClass(t.netReturn)}">${fmtPct(t.netReturn, 1, true)}</b>（${t.trades} 筆）　樣本外 <b class="${signClass(o.netReturn)}">${fmtPct(o.netReturn, 1, true)}</b>（${o.trades} 筆）　最大回撤 ${fmtPct(-o.maxDrawdown, 1)}</div></div>
          <div class="lib-actions"><button type="button" class="btn small" data-lib="load" data-id="${esc(s.id)}">載入設定</button><button type="button" class="btn small" data-lib="rename" data-id="${esc(s.id)}">改名</button><button type="button" class="btn small" data-lib="export" data-id="${esc(s.id)}">匯出</button><button type="button" class="btn small danger" data-lib="delete" data-id="${esc(s.id)}">刪除</button></div></li>`;
      }).join('')}</ul>`;
    }
    foot.innerHTML = `<div class="lib-foot-row"><button type="button" class="btn small" data-lib="import">⬆ 匯入 JSON</button><button type="button" class="btn small" data-lib="export-all" ${list.length ? '' : 'disabled'}>⬇ 全部匯出</button><button type="button" class="btn small danger" data-lib="clear" ${list.length ? '' : 'disabled'}>清空</button></div>
      <button type="button" class="btn primary" data-lib="compare" ${selected.size >= 2 && selected.size <= MAX_COMPARE ? '' : 'disabled'}>並排比較（${selected.size}）</button>`;
    decorate(root);
  }

  function renderCompare(body, foot, list) {
    const snaps = list.filter((s) => selected.has(s.id)).slice(0, MAX_COMPARE);
    const rows = compareRows(snaps, seg);
    const warns = compareWarnings(snaps);
    const head = snaps.map((s, i) => `<th><span class="lib-dot" style="background:${COLORS[i]}"></span>${esc(s.name)}</th>`).join('');
    const setting = (label, fn) => `<tr class="set"><td>${label}</td>${snaps.map((s) => `<td class="txt">${fn(s)}</td>`).join('')}</tr>`;
    const trs = rows.map((r) => `<tr><td>${esc(r.label)}</td>${r.values.map((v, i) => `<td class="${r.best === i ? 'best' : ''} ${r.fmt === 'pct' && r.key !== 'maxDrawdown' ? signClass(v) : ''}">${snaps[i].metrics[seg].trades || r.key === 'trades' || r.key === 'leverage' ? fmtVal(r.fmt, r.key === 'maxDrawdown' ? -v : v) : '—'}</td>`).join('')}</tr>`).join('');
    body.innerHTML = `<div class="chart-tools"><button type="button" class="btn small" data-lib="back">← 返回清單</button>
      <label class="check"><input type="radio" name="lib-seg" value="oos" ${seg === 'oos' ? 'checked' : ''}> 樣本外</label>
      <label class="check"><input type="radio" name="lib-seg" value="train" ${seg === 'train' ? 'checked' : ''}> 訓練期</label>
      <label class="check"><input type="radio" name="lib-seg" value="full" ${seg === 'full' ? 'checked' : ''}> 全期間（參考）</label></div>
      ${warns.length ? `<div class="note warn" data-testid="cmp-warn"><b>這幾筆的設定不完全相同，比較時要小心：</b><ul>${warns.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></div>` : ''}
      <div class="tbl-wrap"><table class="tbl cmp" data-testid="cmp-table"><thead><tr><th></th>${head}</tr></thead><tbody>
        ${setting('策略', (s) => esc(s.desc))}${setting('市場／週期', (s) => `${MARKET[s.market] || ''}／${esc(TF_LABEL[s.baseTf] || s.baseTf)}`)}${setting('標的', (s) => esc(s.symbols.map((x) => x.symbol).join('、')))}${setting('資料期間', (s) => `${esc(fmtDate(s.window.from))} ～ ${esc(fmtDate(s.window.to))}`)}
        ${trs}</tbody></table></div>
      <div class="muted small">綠框＝這一列表現最好的（交易次數 0 的不參與）。「最好」只代表這段歷史，不代表未來；請同時看交易次數與樣本外。</div>
      <h3 style="margin:14px 0 6px">淨值曲線（起點＝100）</h3><div id="lib-chart" class="chart-box" data-testid="cmp-chart"></div>
      <div class="muted small">${snaps.map((s, i) => `<span class="lib-dot" style="background:${COLORS[i]}"></span>${esc(s.name)}`).join('　')}　（訓練期＋樣本外接續；各自換算成起點 100）</div>`;
    foot.innerHTML = `<button type="button" class="btn" data-lib="back">← 返回清單</button><span></span>`;
    const series = normalizedCurves(snaps).map((c, i) => {
      const ds = { times: snaps[i].market === 'tw' };
      const data = [];
      let last = -Infinity;
      for (const p of c.points) { const t = chartTime(ds, p.t); if (t > last) { data.push({ time: t, value: p.v }); last = t; } }
      return { key: `r${i}`, title: String(i + 1), color: COLORS[i], data };
    });
    lineChart(body.querySelector('#lib-chart'), { series });
    void cssVar;
  }

  async function onClick(e) {
    const t = e.target;
    if (t === root) { close(); return; }
    const b = t.closest('[data-lib]');
    if (!b) return;
    const act = b.dataset.lib;
    const id = b.dataset.id;
    if (act === 'close') close();
    else if (act === 'back') { view = 'list'; render(); }
    else if (act === 'compare') { view = 'compare'; render(); }
    else if (act === 'load') { const s = lib.get(id); if (s) { close(); await restore(s); } }
    else if (act === 'rename') {
      const s = lib.get(id); if (!s) return;
      const n = window.prompt('新的名稱', s.name);
      if (n !== null && n.trim()) { lib.rename(id, n); render(); }
    } else if (act === 'delete') {
      const s = lib.get(id); if (!s) return;
      if (window.confirm(`刪除「${s.name}」？此動作無法復原。`)) { lib.remove(id); selected.delete(id); render(); onChange(count()); }
    } else if (act === 'export') { const s = lib.get(id); if (s) downloadText(`backtest-${safeName(s.name)}.json`, exportJson([s]), 'application/json'); }
    else if (act === 'export-all') downloadText('backtest-library.json', exportJson(lib.list()), 'application/json');
    else if (act === 'clear') { if (window.confirm('清空全部已儲存的回測？此動作無法復原（建議先「全部匯出」備份）。')) { lib.clear(); selected.clear(); render(); onChange(0); } }
    else if (act === 'import') root.querySelector('#lib-file').click();
  }

  async function onChange_(e) {
    const t = e.target;
    if (t.matches('[data-lib-sel]')) {
      if (t.checked) {
        if (selected.size >= MAX_COMPARE) { t.checked = false; toast(`最多同時比較 ${MAX_COMPARE} 筆`); return; }
        selected.add(t.dataset.libSel);
      } else selected.delete(t.dataset.libSel);
      render();
    } else if (t.name === 'lib-seg') { seg = t.value; render(); }
    else if (t.id === 'lib-file' && t.files && t.files[0]) {
      try {
        const f = t.files[0];
        if (f.size > 8e6) throw new Error('檔案太大（上限 8 MB）');
        const snaps = parseImport(await f.text());
        const r = lib.addMany(snaps);
        toast(`已匯入 ${r.count} 筆${r.dropped ? `（超過 ${MAX_SAVED} 筆，已丟掉最舊的 ${r.dropped} 筆）` : ''}`);
        onChange(count());
        render();
      } catch (err) { toast(`匯入失敗：${err.message}`); }
      t.value = '';
    }
  }

  return {
    open, close, count,
    save(snap) { const r = lib.add(snap); onChange(count()); return r; },
    list: () => lib.list(),
  };
}

function safeName(s) { return String(s).replace(/[^\w一-鿿-]+/g, '_').slice(0, 40) || 'run'; }
