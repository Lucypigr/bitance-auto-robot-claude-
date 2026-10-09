// 手動策略：條件列的渲染與範本
import { CONDITIONS, conditionGroups, describeSpec, describeEntry, normalizeSpec, validateSpec } from '../core/conditions.js';
import { TIMEFRAMES, TF_LABEL, tfIndex } from '../core/util.js';
import { term, esc } from './info.js';
import { illustration } from './illustrations.js';
import { directionText, conditionText, exitParts, exitConditionText } from '../core/describe.js';

export const TEMPLATES = [
  {
    id: 'atr', name: 'ATR 波動停損＋分批出場（做多）', baseTf: null,
    strategy: (tf) => ({ dir: 'long', entry: [{ id: 'rsi_oversold', tf, params: { level: 30 } }], exit: [], unit: 'atr', sl: 1.5, tp: 4, lev: 1, scaleOut: { at: 1.5, frac: 50, be: true } }),
    tip: '停損 1.5 倍 ATR、第一目標 1.5 倍 ATR 先平一半並把停損移到成本價，剩下的看 4 倍 ATR；波動大時距離自動放寬。',
  },
  {
    id: 'dual', name: 'RSI 雙向反手（多空輪流）', baseTf: null,
    strategy: (tf) => ({ dir: 'both', entry: [{ id: 'rsi_oversold', tf, params: { level: 30 } }], entryB: [{ id: 'rsi_overbought', tf, params: { level: 70 } }], reverse: true, exit: [], sl: 4, tp: 0, lev: 1 }),
    tip: 'RSI 超賣做多、超買做空；持有多單時遇到超買訊號，直接平多並反手做空（只支援永續合約）。'
  },
  {
    id: 'oversold', name: 'RSI 超賣反彈（做多）', baseTf: null,
    strategy: (tf) => ({ dir: 'long', entry: [{ id: 'rsi_oversold', tf, params: { level: 30 } }], exit: [], sl: 3, tp: 5, lev: 1 }),
    tip: '價格短線跌太多時嘗試抄底；停損 3%、停利 5%。',
  },
  {
    id: 'overbought', name: 'RSI 超買回落（做空）', baseTf: null,
    strategy: (tf) => ({ dir: 'short', entry: [{ id: 'rsi_overbought', tf, params: { level: 75 } }], exit: [], sl: 3, tp: 5, lev: 1 }),
    tip: '價格短線漲太多時嘗試放空；注意強勢行情會一路軋空。',
  },
  {
    id: 'golden', name: '均線黃金交叉（做多）', baseTf: null,
    strategy: (tf) => ({ dir: 'long', entry: [{ id: 'ema_golden', tf, params: { fast: 20, slow: 50 }, within: 1 }], exit: [{ id: 'ema_death', tf, params: { fast: 20, slow: 50 } }], sl: 5, tp: 0, lev: 1 }),
    tip: 'EMA20 向上穿越 EMA50 進場，死亡交叉時出場。',
  },
  {
    id: 'bb', name: '布林下軌＋RSI 超賣（做多）', baseTf: null,
    strategy: (tf) => ({ dir: 'long', entry: [{ id: 'bb_below_lower', tf }, { id: 'rsi_oversold', tf, params: { level: 30 } }], exit: [], sl: 2, tp: 4, lev: 1 }),
    tip: '兩個「跌過頭」條件同時成立才進場，次數較少但較嚴格。',
  },
  {
    id: 'trend', name: 'Supertrend 轉多＋ADX 趨勢明確（做多）', baseTf: null,
    strategy: (tf) => ({ dir: 'long', entry: [{ id: 'supertrend_flip_up', tf, within: 2 }, { id: 'adx_strong', tf, params: { level: 20 } }], exit: [{ id: 'supertrend_flip_down', tf }], sl: 4, tp: 0, trail: 3, lev: 1 }),
    tip: '趨勢轉多且趨勢夠明確才進場，用移動停損保護獲利。',
  },
  {
    id: 'mtf', name: '跨週期範例：4h RSI 超買＋1h MACD 死叉＋15m 流星線（做空）', baseTf: '15m',
    strategy: () => ({
      dir: 'short',
      entry: [
        { id: 'rsi_overbought', tf: '4h', params: { level: 70 } },
        { id: 'macd_death', tf: '1h', within: 1 },
        { id: 'pat_shooting_star', tf: '15m' },
      ],
      exit: [], sl: 2, tp: 4, lev: 1,
    }),
    tip: '大週期過熱、中週期轉弱、小週期出現反轉 K 線，三者同時成立才做空。',
  },
];

export function defaultCondition(tf) {
  return { id: 'rsi_oversold', tf, params: {}, within: 1 };
}

function tfOptions(selected, baseTf) {
  const min = tfIndex(baseTf);
  return TIMEFRAMES.filter((_, i) => i >= min)
    .map((tf) => `<option value="${tf}" ${tf === selected ? 'selected' : ''}>${TF_LABEL[tf]}</option>`).join('');
}

function idOptions(selected) {
  return conditionGroups().map((g) =>
    `<optgroup label="${esc(g.group)}">${g.items.map((it) => `<option value="${it.id}" ${it.id === selected ? 'selected' : ''}>${esc(it.label)}</option>`).join('')}</optgroup>`).join('');
}

/** 渲染條件列表。事件以 data-* 屬性 + 事件委派處理（見 bindConditionList） */
export function renderConditionList(container, list, baseTf, { groups = true } = {}) {
  if (list.length === 0) {
    container.innerHTML = '<div class="muted small">（尚未設定）</div>';
    return;
  }
  container.innerHTML = list.map((raw, i) => {
    const c = normalizeSpec(raw);
    const def = CONDITIONS[c.id];
    // 參數：可直接輸入任意數字（有範圍限制），也可以從建議值挑（datalist）
    const given = (raw.params || {});
    const fields = def.fields.map((f) => {
      const v = given[f.key] !== undefined && given[f.key] !== '' ? given[f.key] : c.params[f.key];
      const dl = `dl-${i}-${f.key}`;
      return `<label>${esc(f.label)} <input type="number" class="c-param" data-k="${f.key}" data-i="${i}" list="${dl}" value="${esc(v)}" min="${f.min}" max="${f.max}" step="${f.step}" inputmode="decimal" aria-label="${esc(def.label)} ${esc(f.label)}"><datalist id="${dl}">${f.options.map((o) => `<option value="${o}"></option>`).join('')}</datalist></label>`;
    }).join('');
    const err = validateSpec(raw);
    const withinSel = `<label>${term('within', '保留')} <select data-i="${i}" class="c-within">${[1, 2, 3, 5, 10].map((n) => `<option value="${n}" ${n === c.within ? 'selected' : ''}>${n}</option>`).join('')}</select> 根</label>`;
    const logic = `<div class="cond-logic"><label class="check"><input type="checkbox" class="c-neg" data-i="${i}" ${c.neg ? 'checked' : ''}> ${term('cond_logic', '非')}（條件「不成立」才算）</label>${
      groups ? `<label>邏輯 <select class="c-grp" data-i="${i}" aria-label="條件群組">${[['', '且（獨立）'], ['A', '群組 A（群組內「或」）'], ['B', '群組 B'], ['C', '群組 C'], ['D', '群組 D']].map(([v, t]) => `<option value="${v}" ${c.grp === v ? 'selected' : ''}>${t}</option>`).join('')}</select></label>` : ''}</div>`;
    return `<div class="cond ${c.neg ? 'neg' : ''}" data-i="${i}">
      <div class="cond-main">
        <select class="c-tf" data-i="${i}" aria-label="條件週期">${tfOptions(c.tf, baseTf)}</select>
        <select class="c-id" data-i="${i}" aria-label="條件">${idOptions(c.id)}</select>
        <button type="button" class="cond-del" data-i="${i}" aria-label="刪除此條件">✕</button>
      </div>
      <div class="cond-params">${fields}${withinSel}</div>
      ${err ? `<div class="cond-err" role="alert">⚠ ${esc(err)}</div>` : ''}
      ${logic}
      <div class="cond-text">${(() => { const il = illustration(c.id); return il ? `<span class="cond-thumb" title="${esc(il.cap)}">${il.svg}</span>` : ''; })()}${term(def.term, describeSpec(c), c.id)}</div>
    </div>`;
  }).join('');
}

/** 只更新每列的說明文字與錯誤提示（不重畫輸入框，避免打字／Tab 時失去焦點） */
export function softUpdateConditionList(container, list, baseTf, opts) {
  const tmp = document.createElement('div');
  renderConditionList(tmp, list, baseTf, opts);
  list.forEach((_, i) => {
    const live = container.querySelector(`.cond[data-i="${i}"]`);
    const fresh = tmp.querySelector(`.cond[data-i="${i}"]`);
    if (!live || !fresh) return;
    live.classList.toggle('neg', fresh.classList.contains('neg'));
    live.querySelector('.cond-text').innerHTML = fresh.querySelector('.cond-text').innerHTML;
    const le = live.querySelector('.cond-err');
    const fe = fresh.querySelector('.cond-err');
    if (fe && le) le.innerHTML = fe.innerHTML;
    else if (fe) live.querySelector('.cond-params').insertAdjacentHTML('afterend', fe.outerHTML);
    else if (le) le.remove();
  });
}

/** 綁定一次即可；onChange(newList) 會收到更新後的陣列 */
export function bindConditionList(container, getList, setList, getBaseTf) {
  container.addEventListener('change', (e) => {
    const t = e.target;
    const i = Number(t.dataset.i);
    if (Number.isNaN(i)) return;
    const list = getList().map((c) => ({ ...c, params: { ...(c.params || {}) } }));
    const c = list[i];
    if (!c) return;
    if (t.classList.contains('c-tf')) c.tf = t.value;
    else if (t.classList.contains('c-id')) { c.id = t.value; c.params = {}; c.within = CONDITIONS[c.id].kind === 'event' ? 1 : 1; }
    else if (t.classList.contains('c-param')) c.params[t.dataset.k] = t.value === '' ? undefined : Number(t.value);
    else if (t.classList.contains('c-within')) c.within = Number(t.value);
    else if (t.classList.contains('c-neg')) c.neg = t.checked;
    else if (t.classList.contains('c-grp')) c.grp = t.value;
    setList(list, { soft: t.classList.contains('c-param') || t.classList.contains('c-within') });
  });
  container.addEventListener('click', (e) => {
    const b = e.target.closest('.cond-del');
    if (!b) return;
    const list = getList().slice();
    list.splice(Number(b.dataset.i), 1);
    setList(list);
  });
  void getBaseTf;
}

export function describeManual(st) {
  const dir = directionText(st);
  if (!st.entry.length || (st.dir === 'both' && !(st.entryB && st.entryB.length))) return st.dir === 'both' ? '雙向策略需要同時設定「做多進場條件」與「做空進場條件」。' : '請至少新增一個進場條件。';
  const cond = conditionText(st);
  const exits = exitParts(st);
  const ex = exitConditionText(st);
  if (ex) exits.push(ex);
  if (st.maxBars) exits.push(`最長持倉 ${st.maxBars} 根`);
  const rules = [];
  if (st.capitalMode === 'shared') rules.push(`共用資金池、同時最多持有 ${st.maxPos} 檔`);
  if (st.riskPct) rules.push(`每筆停損最多虧帳戶淨值的 ${st.riskPct}%`);
  const mode = st.entryMode === 'level' ? '條件成立期間，空手就進場' : '條件由不成立變成立的那一根收盤後';
  const side = st.dir === 'both' ? (st.reverse ? '下一根 K 線開盤進場；持倉中出現對面訊號就在下一個開盤價平倉並反向開倉' : '下一根 K 線開盤進場；持倉中忽略對面訊號') : `下一根 K 線開盤${dir}`;
  return `${mode}：${cond} → ${side}（${st.lev}× 槓桿${st.posUsdt ? `，每筆投入 ${st.posUsdt} ${st.cur || 'USDT'}` : ''}）。${exits.length ? '出場：' + exits.join('、') + '。' : '未設定停損停利，只會在資料結束時平倉。'}${rules.length ? '部位規則：' + rules.join('；') + '。' : ''}`;
}
