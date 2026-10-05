// 手動策略：條件列的渲染與範本
import { CONDITIONS, conditionGroups, describeSpec, normalizeSpec } from '../core/conditions.js';
import { TIMEFRAMES, TF_LABEL, tfIndex } from '../core/util.js';
import { term, esc } from './info.js';

export const TEMPLATES = [
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
export function renderConditionList(container, list, baseTf) {
  if (list.length === 0) {
    container.innerHTML = '<div class="muted small">（尚未設定）</div>';
    return;
  }
  container.innerHTML = list.map((raw, i) => {
    const c = normalizeSpec(raw);
    const def = CONDITIONS[c.id];
    const fields = def.fields.map((f) => `<label>${esc(f.label)} <select data-k="${f.key}" data-i="${i}" class="c-param">${
      f.options.map((o) => `<option value="${o}" ${String(o) === String(c.params[f.key]) ? 'selected' : ''}>${o}</option>`).join('')}</select></label>`).join('');
    const withinSel = `<label>${term('within', '保留')} <select data-i="${i}" class="c-within">${[1, 2, 3, 5, 10].map((n) => `<option value="${n}" ${n === c.within ? 'selected' : ''}>${n}</option>`).join('')}</select> 根</label>`;
    return `<div class="cond" data-i="${i}">
      <div class="cond-main">
        <select class="c-tf" data-i="${i}" aria-label="條件週期">${tfOptions(c.tf, baseTf)}</select>
        <select class="c-id" data-i="${i}" aria-label="條件">${idOptions(c.id)}</select>
        <button type="button" class="cond-del" data-i="${i}" aria-label="刪除此條件">✕</button>
      </div>
      <div class="cond-params">${fields}${withinSel}</div>
      <div class="cond-text">${term(def.term, describeSpec(c))}</div>
    </div>`;
  }).join('');
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
    else if (t.classList.contains('c-param')) c.params[t.dataset.k] = Number(t.value);
    else if (t.classList.contains('c-within')) c.within = Number(t.value);
    setList(list);
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
  const dir = st.dir === 'long' ? '做多' : '做空';
  if (!st.entry.length) return '請至少新增一個進場條件。';
  const cond = st.entry.map(describeSpec).join('　且　');
  const exits = [];
  if (st.sl) exits.push(`停損 ${st.sl}%`);
  if (st.tp) exits.push(`停利 ${st.tp}%`);
  if (st.trail) exits.push(`移動停損 ${st.trail}%`);
  if (st.exit && st.exit.length) exits.push(`或 ${st.exit.map(describeSpec).join('、')} 時出場`);
  if (st.maxBars) exits.push(`最長持倉 ${st.maxBars} 根`);
  const mode = st.entryMode === 'level' ? '條件成立期間，空手就進場' : '條件由不成立變成立的那一根收盤後';
  return `${mode}：${cond} → 下一根 K 線開盤${dir}（${st.lev}× 槓桿）。${exits.length ? '出場：' + exits.join('、') + '。' : '未設定停損停利，只會在資料結束時平倉。'}`;
}
