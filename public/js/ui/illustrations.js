// 指標／K 線型態的「長什麼樣子」示意圖（手繪式示意，不是真實行情）。
// 每張圖都是內嵌 SVG，顏色用 CSS 變數，深淺色主題與漲跌顏色設定都會跟著變。
const W = 140;
const H = 84;
const f = (v) => v.toFixed(1);
const svg = (inner) => `<svg class="ill" viewBox="0 0 ${W} ${H}" role="img" aria-hidden="true" focusable="false">${inner}</svg>`;

const R1 = { x0: 6, x1: 134, y0: 5, y1: 78 }; // 只有價格
const RP = { x0: 6, x1: 134, y0: 4, y1: 44 }; // 上方價格
const RI = { x0: 6, x1: 134, y0: 52, y1: 80 }; // 下方指標
const Y = (r, v) => r.y0 + (1 - v) * (r.y1 - r.y0);
const X = (r, i, n) => r.x0 + ((r.x1 - r.x0) / n) * (i + 0.5);

/** 蠟燭：list = [[o,h,l,c], ...]，數值 0~1（1 在最上方）；hl = [起, 迄] 圈出重點 K 線 */
function candles(list, r = R1, hl = null) {
  const n = list.length;
  const step = (r.x1 - r.x0) / n;
  const w = Math.min(10, step * 0.62);
  const body = list.map(([o, h, l, c], i) => {
    const x = X(r, i, n);
    const top = Y(r, Math.max(o, c));
    const bot = Y(r, Math.min(o, c));
    return `<g class="${c >= o ? 'k-up' : 'k-dn'}"><line x1="${f(x)}" x2="${f(x)}" y1="${f(Y(r, h))}" y2="${f(Y(r, l))}"/><rect x="${f(x - w / 2)}" y="${f(top)}" width="${f(w)}" height="${f(Math.max(1.4, bot - top))}"/></g>`;
  }).join('');
  let box = '';
  if (hl) {
    const x0 = X(r, hl[0], n) - w * 0.95;
    const x1 = X(r, hl[1], n) + w * 0.95;
    box = `<rect class="k-hl" x="${f(x0)}" y="${r.y0 - 2}" width="${f(x1 - x0)}" height="${r.y1 - r.y0 + 4}" rx="4"/>`;
  }
  return body + box;
}

/** 由價格序列產生蠟燭（有一點固定的起伏，讓圖看起來像 K 線） */
function fromSeries(vals, wob = 0.05) {
  return vals.map((v, i) => {
    const nxt = i + 1 < vals.length ? vals[i + 1] : v + (v - (vals[i - 1] ?? v)) * 0.5;
    const o = v + Math.sin(i * 2.3) * wob * 0.4;
    const c = nxt + Math.cos(i * 1.7) * wob * 0.4;
    return [o, Math.max(o, c) + wob * (0.6 + 0.4 * Math.abs(Math.sin(i))), Math.min(o, c) - wob * (0.6 + 0.4 * Math.abs(Math.cos(i))), c];
  });
}
const clamp01 = (v) => Math.min(0.97, Math.max(0.03, v));
const seq = (n, fn) => Array.from({ length: n }, (_, i) => clamp01(fn(i / (n - 1), i)));

function line(vals, r, cls) {
  const n = vals.length;
  return `<polyline class="ln ${cls}" points="${vals.map((v, i) => `${f(X(r, i, n))},${f(Y(r, v))}`).join(' ')}"/>`;
}
const hline = (r, v, cls = 'dash') => `<line class="${cls}" x1="${r.x0}" x2="${r.x1}" y1="${f(Y(r, v))}" y2="${f(Y(r, v))}"/>`;
const zone = (r, v0, v1, cls) => `<rect class="${cls}" x="${r.x0}" y="${f(Y(r, v1))}" width="${r.x1 - r.x0}" height="${f(Y(r, v0) - Y(r, v1))}"/>`;
const mark = (r, i, n, v) => `<circle class="mk" cx="${f(X(r, i, n))}" cy="${f(Y(r, v))}" r="3.6"/>`;
const sep = () => `<line class="sep" x1="${RP.x0}" x2="${RP.x1}" y1="48" y2="48"/>`;
const firstCross = (a, b, dir) => { for (let i = 1; i < a.length; i++) if (dir > 0 ? a[i - 1] <= b[i - 1] && a[i] > b[i] : a[i - 1] >= b[i - 1] && a[i] < b[i]) return i; return a.length - 2; };
const firstAbove = (a, th) => { const i = a.findIndex((v) => v >= th); return i < 0 ? a.length - 1 : i; };
const firstBelow = (a, th) => { const i = a.findIndex((v) => v <= th); return i < 0 ? a.length - 1 : i; };
const N = 18;

// ---------- 振盪指標（上：價格；下：指標 + 門檻線）----------
function oscillator({ up, hi, lo, label, valsFn, priceFn }) {
  const vals = seq(N, valsFn);
  const price = seq(N, priceFn);
  const idx = up ? firstAbove(vals, hi) : firstBelow(vals, lo);
  return svg(`${candles(fromSeries(price, 0.035), RP)}${sep()}${up ? zone(RI, hi, 1, 'zone-hot') : zone(RI, 0, lo, 'zone-cold')}${hline(RI, hi)}${hline(RI, lo)}${line(vals, RI, 'l-a')}${mark(RI, idx, N, vals[idx])}<text class="tx" x="${RI.x0 + 1}" y="50">${label}</text>`);
}
const rsiUp = () => oscillator({ up: true, hi: 0.7, lo: 0.3, label: '70', valsFn: (t) => 0.3 + 0.62 * Math.min(1, t * 1.25), priceFn: (t) => 0.25 + 0.6 * t });
const rsiDn = () => oscillator({ up: false, hi: 0.7, lo: 0.3, label: '30', valsFn: (t) => 0.7 - 0.62 * Math.min(1, t * 1.25), priceFn: (t) => 0.85 - 0.6 * t });
const kdUp = () => oscillator({ up: true, hi: 0.8, lo: 0.2, label: '80', valsFn: (t) => 0.3 + 0.62 * Math.min(1, t * 1.3), priceFn: (t) => 0.25 + 0.6 * t });
const kdDn = () => oscillator({ up: false, hi: 0.8, lo: 0.2, label: '20', valsFn: (t) => 0.7 - 0.62 * Math.min(1, t * 1.3), priceFn: (t) => 0.85 - 0.6 * t });
const cciUp = () => oscillator({ up: true, hi: 0.75, lo: 0.25, label: '+100', valsFn: (t) => 0.35 + 0.6 * Math.min(1, t * 1.2), priceFn: (t) => 0.25 + 0.6 * t });
const cciDn = () => oscillator({ up: false, hi: 0.75, lo: 0.25, label: '−100', valsFn: (t) => 0.65 - 0.6 * Math.min(1, t * 1.2), priceFn: (t) => 0.85 - 0.6 * t });

// ---------- 兩線交叉 ----------
function crossOver(up, labelFast = '快線', labelSlow = '慢線') {
  const slow = seq(N, (t) => (up ? 0.5 + 0.2 * t : 0.7 - 0.2 * t));
  const fast = seq(N, (t) => (up ? 0.28 + 0.62 * t : 0.82 - 0.62 * t));
  const price = seq(N, (t) => (up ? 0.28 + 0.62 * t : 0.82 - 0.62 * t));
  const i = firstCross(fast, slow, up ? 1 : -1);
  return svg(`${candles(fromSeries(price, 0.04), R1)}${line(slow, R1, 'l-b')}${line(fast, R1, 'l-a')}${mark(R1, i, N, fast[i])}<text class="tx a" x="8" y="12">${labelFast}</text><text class="tx b" x="8" y="22">${labelSlow}</text>`);
}
function macdIll(up) {
  const m = seq(N, (t) => 0.5 + 0.3 * Math.sin(2 * Math.PI * (t - 0.05)));
  const s = seq(N, (t) => 0.5 + 0.3 * Math.sin(2 * Math.PI * (t - 0.05) - 0.8));
  const price = seq(N, (t) => 0.5 + 0.3 * Math.sin(2 * Math.PI * (t - 0.12)));
  const i = firstCross(m, s, up ? 1 : -1);
  const bars = m.map((v, k) => { const h = (v - s[k]) * 1.1; const x = X(RI, k, N); const y0 = Y(RI, 0.5); const y1 = Y(RI, 0.5 + h); return `<rect class="${h >= 0 ? 'k-up' : 'k-dn'} bar" x="${f(x - 2.2)}" y="${f(Math.min(y0, y1))}" width="4.4" height="${f(Math.max(0.8, Math.abs(y1 - y0)))}"/>`; }).join('');
  return svg(`${candles(fromSeries(price, 0.035), RP)}${sep()}${hline(RI, 0.5)}${bars}${line(m, RI, 'l-a')}${line(s, RI, 'l-b')}${mark(RI, i, N, m[i])}`);
}
function kdCross(up) {
  const k = seq(N, (t) => 0.5 + 0.38 * Math.sin(2 * Math.PI * (t - 0.05)));
  const d = seq(N, (t) => 0.5 + 0.38 * Math.sin(2 * Math.PI * (t - 0.05) - 0.7));
  const price = seq(N, (t) => 0.5 + 0.3 * Math.sin(2 * Math.PI * (t - 0.1)));
  const i = firstCross(k, d, up ? 1 : -1);
  return svg(`${candles(fromSeries(price, 0.035), RP)}${sep()}${hline(RI, 0.8)}${hline(RI, 0.2)}${line(k, RI, 'l-a')}${line(d, RI, 'l-b')}${mark(RI, i, N, k[i])}`);
}

// ---------- 通道（布林／Keltner）----------
function bands(up, wide) {
  const mid = seq(N, (t) => 0.5 + 0.06 * t);
  const w = wide;
  const upper = mid.map((v) => v + w);
  const lower = mid.map((v) => v - w);
  const price = seq(N, (t, i) => mid[i] + (up ? 1 : -1) * (0.1 * Math.sin(i * 1.3) + (t > 0.85 ? 0.26 * (t - 0.8) / 0.2 : 0)));
  const idx = N - 2;
  return svg(`${candles(fromSeries(price, 0.03), R1)}${line(upper, R1, 'l-c')}${line(mid, R1, 'l-b dashed')}${line(lower, R1, 'l-c')}${mark(R1, idx, N, price[idx])}`);
}

// ---------- 其他 ----------
function adxIll(strong, di) {
  const price = seq(N, (t, i) => (strong ? 0.25 + 0.6 * t : 0.5 + 0.08 * Math.sin(i * 1.7)));
  const adx = seq(N, (t) => (strong ? 0.15 + 0.6 * t : 0.18 + 0.06 * Math.sin(t * 9)));
  const p = seq(N, (t) => 0.55 + 0.25 * Math.sin(2 * Math.PI * t));
  const q = seq(N, (t) => 0.45 - 0.25 * Math.sin(2 * Math.PI * t));
  if (di) return svg(`${candles(fromSeries(price, 0.035), RP)}${sep()}${line(p, RI, 'l-a')}${line(q, RI, 'l-b')}<text class="tx" x="${RI.x0 + 1}" y="50">+DI ／ −DI</text>`);
  const i = strong ? firstAbove(adx, 0.45) : 0;
  return svg(`${candles(fromSeries(price, 0.035), RP)}${sep()}${hline(RI, 0.45)}${line(adx, RI, 'l-a')}${strong ? mark(RI, i, N, adx[i]) : ''}<text class="tx" x="${RI.x0 + 1}" y="50">${strong ? 'ADX ≥ 25' : 'ADX 很低'}</text>`);
}
function regimeIll(mode) {
  const price = seq(N, (t, i) => (mode === 'up' ? 0.2 + 0.65 * t + 0.02 * Math.sin(i * 2) : mode === 'down' ? 0.85 - 0.65 * t + 0.02 * Math.sin(i * 2) : mode === 'trend' ? 0.2 + 0.65 * t + 0.02 * Math.sin(i * 2) : 0.5 + 0.17 * Math.sin(i * 1.9)));
  const label = mode === 'range' ? '震盪：來回、原地打轉' : mode === 'down' ? '單邊下跌' : mode === 'up' ? '單邊上漲' : '單邊行情';
  return svg(`${candles(fromSeries(price, 0.035), R1)}<text class="tx" x="14" y="12">${label}</text>`);
}
function fibIll(up) {
  // 上升波段：低→高，再回檔到 61.8%；下降波段上下相反
  const leg = seq(10, (t) => 0.12 + 0.76 * t);
  const back = seq(8, (t) => 0.88 - 0.47 * t);
  let price = [...leg, ...back];
  if (!up) price = price.map((v) => 1 - v);
  const y = (lvl) => (up ? 0.88 - 0.76 * lvl : 0.12 + 0.76 * lvl);
  const lines = [0.382, 0.5, 0.618].map((lv) => `${hline(R1, y(lv))}<text class="tx" x="${R1.x1 - 26}" y="${f(Y(R1, y(lv)) - 2)}">${(lv * 100).toFixed(lv === 0.5 ? 0 : 1)}%</text>`).join('');
  return svg(`${candles(fromSeries(price, 0.03), R1)}${lines}${mark(R1, price.length - 1, price.length, price[price.length - 1])}`);
}
function atrIll(low = false) {
  if (low) return svg(`${candles(Array.from({ length: 16 }, (_, i) => { const b = 0.5 + 0.02 * Math.sin(i * 2); return [b, b + 0.04, b - 0.04, b + 0.012 * (i % 2 ? 1 : -1)]; }), R1)}<text class="tx" x="14" y="12">波動小：K 線都很短</text>`);
  const list = [...Array.from({ length: 8 }, (_, i) => { const b = 0.5 + 0.02 * Math.sin(i * 2); return [b, b + 0.04, b - 0.04, b + 0.012]; }),
    ...Array.from({ length: 8 }, (_, i) => { const b = 0.5 + 0.1 * Math.sin(i * 2.2); const d = i % 2 ? -0.2 : 0.22; return [b, b + Math.abs(d) + 0.08, b - Math.abs(d) - 0.08, b + d]; })];
  return svg(`${candles(list, R1)}<line class="sep" x1="${(R1.x0 + R1.x1) / 2}" x2="${(R1.x0 + R1.x1) / 2}" y1="6" y2="78"/><text class="tx" x="14" y="12">波動小</text><text class="tx" x="88" y="12">波動大</text>`);
}
function supertrendIll(mode) {
  // mode: up（一路多頭）、down（一路空頭）、flipUp（由空翻多）、flipDown（由多翻空）
  const cut = Math.round(N * 0.5);
  const rise = (t0, t1, a, b2) => (t) => a + ((b2 - a) * (t - t0)) / (t1 - t0);
  const price = seq(N, (t, i) => {
    if (mode === 'up') return rise(0, 1, 0.22, 0.85)(t);
    if (mode === 'down') return rise(0, 1, 0.85, 0.22)(t);
    if (mode === 'flipUp') return (i < cut ? rise(0, 0.5, 0.78, 0.3)(t) : rise(0.5, 1, 0.3, 0.85)(t));
    return i < cut ? rise(0, 0.5, 0.25, 0.75)(t) : rise(0.5, 1, 0.75, 0.2)(t);
  }).map((v, i) => clamp01(v + 0.03 * Math.sin(i * 2.1)));
  const upSide = (i) => (mode === 'up' ? true : mode === 'down' ? false : mode === 'flipUp' ? i >= cut : i < cut);
  const pts = (from, to) => price.slice(from, to).map((v, k) => { const i = from + k; return `${f(X(R1, i, N))},${f(Y(R1, clamp01(v + (upSide(i) ? -0.13 : 0.13))))}`; }).join(' ');
  const flips = mode === 'flipUp' || mode === 'flipDown';
  const segs = flips
    ? `<polyline class="ln ${upSide(0) ? 'l-up' : 'l-dn'}" points="${pts(0, cut)}"/><polyline class="ln ${upSide(cut) ? 'l-up' : 'l-dn'}" points="${pts(cut, N)}"/>`
    : `<polyline class="ln ${upSide(0) ? 'l-up' : 'l-dn'}" points="${pts(0, N)}"/>`;
  return svg(`${candles(fromSeries(price, 0.03), R1)}${segs}${flips ? mark(R1, cut, N, clamp01(price[cut] + (upSide(cut) ? -0.13 : 0.13))) : ''}`);
}
function vwapIll(above) {
  const price = seq(N, (t, i) => 0.5 + (above ? 0.1 : -0.1) * Math.min(1, t * 2.4) + 0.07 * Math.sin(i * 1.6));
  const vw = seq(N, () => 0.5);
  return svg(`${candles(fromSeries(price, 0.03), R1)}${line(vw, R1, 'l-b')}<text class="tx b" x="8" y="12">VWAP</text>${mark(R1, N - 3, N, price[N - 3])}`);
}
function obvIll(above) {
  const price = seq(N, (t, i) => 0.5 + 0.1 * Math.sin(i * 1.3));
  const obv = seq(N, (t) => (above ? 0.3 + 0.55 * t : 0.85 - 0.55 * t));
  const ma = seq(N, (t) => (above ? 0.4 + 0.3 * t : 0.75 - 0.3 * t));
  return svg(`${candles(fromSeries(price, 0.035), RP)}${sep()}${line(obv, RI, 'l-a')}${line(ma, RI, 'l-b')}<text class="tx" x="${RI.x0 + 1}" y="50">OBV</text>`);
}
function donchianIll(up) {
  const base = seq(N, (t, i) => 0.5 + 0.16 * Math.sin(i * 1.5));
  const price = base.map((v, i) => (i >= N - 2 ? (up ? 0.92 : 0.08) : v));
  const lvl = up ? Math.max(...base.slice(0, N - 2)) + 0.08 : Math.min(...base.slice(0, N - 2)) - 0.08;
  return svg(`${candles(fromSeries(price, 0.03), R1)}${hline(R1, clamp01(lvl), 'dash l-c')}${mark(R1, N - 2, N, price[N - 2])}<text class="tx" x="8" y="12">${up ? '前 N 根最高' : '前 N 根最低'}</text>`);
}
function volumeIll() {
  const price = seq(N, (t, i) => 0.55 + 0.05 * Math.sin(i * 1.2) + (i >= N - 2 ? 0.2 : 0));
  const vol = Array.from({ length: N }, (_, i) => (i === N - 2 ? 0.95 : 0.2 + 0.12 * Math.abs(Math.sin(i * 2.1))));
  const bars = vol.map((v, i) => { const x = X(RI, i, N); const h = v * (RI.y1 - RI.y0); return `<rect class="vbar ${i === N - 2 ? 'hot' : ''}" x="${f(x - 3)}" y="${f(RI.y1 - h)}" width="6" height="${f(h)}"/>`; }).join('');
  return svg(`${candles(fromSeries(price, 0.03), RP)}${sep()}${bars}<text class="tx" x="${RI.x0 + 1}" y="50">成交量</text>`);
}
function emaSide(above) {
  const price = seq(N, (t, i) => (above ? 0.45 + 0.4 * t : 0.75 - 0.4 * t) + 0.03 * Math.sin(i * 2));
  const ema = seq(N, (t) => (above ? 0.4 + 0.3 * t : 0.7 - 0.3 * t));
  return svg(`${candles(fromSeries(price, 0.035), R1)}${line(ema, R1, 'l-b')}<text class="tx b" x="8" y="12">EMA</text>`);
}

// ---------- K 線型態 ----------
const DOWN = [[0.92, 0.94, 0.8, 0.82], [0.82, 0.84, 0.7, 0.72], [0.72, 0.74, 0.6, 0.62], [0.62, 0.64, 0.5, 0.52]];
const UP = [[0.18, 0.3, 0.16, 0.28], [0.28, 0.4, 0.26, 0.38], [0.38, 0.5, 0.36, 0.48], [0.48, 0.6, 0.46, 0.58]];
const pat = (list, hl) => svg(candles(list, { x0: 18, x1: 122, y0: 6, y1: 78 }, hl));
const PATTERNS = {
  pat_hammer: () => pat([...DOWN, [0.5, 0.52, 0.18, 0.51]], [4, 4]),
  pat_inverted_hammer: () => pat([...DOWN, [0.5, 0.82, 0.48, 0.51]], [4, 4]),
  pat_hanging_man: () => pat([...UP, [0.7, 0.72, 0.38, 0.71]], [4, 4]),
  pat_shooting_star: () => pat([...UP, [0.68, 0.98, 0.66, 0.69]], [4, 4]),
  pat_bullish_engulfing: () => pat([...DOWN, [0.52, 0.54, 0.4, 0.42], [0.37, 0.7, 0.35, 0.68]], [4, 5]),
  pat_bearish_engulfing: () => pat([...UP, [0.6, 0.75, 0.58, 0.72], [0.77, 0.79, 0.4, 0.42]], [4, 5]),
  pat_doji: () => pat([[0.4, 0.5, 0.36, 0.48], [0.48, 0.6, 0.46, 0.58], [0.58, 0.8, 0.3, 0.585], [0.58, 0.66, 0.5, 0.52]], [2, 2]),
  pat_morning_star: () => pat([...DOWN.slice(1), [0.62, 0.64, 0.3, 0.34], [0.3, 0.33, 0.22, 0.26], [0.3, 0.58, 0.28, 0.56]], [3, 5]),
  pat_evening_star: () => pat([...UP.slice(1), [0.58, 0.8, 0.56, 0.78], [0.82, 0.88, 0.8, 0.84], [0.78, 0.8, 0.5, 0.52]], [3, 5]),
};

// 圖說（一句話：圖上要看什麼）
const CAP = {
  rsi_overbought: 'RSI（下方曲線）衝進 70 以上的紅色區，代表短線漲很多、偏熱',
  rsi_oversold: 'RSI 跌進 30 以下的藍色區，代表短線跌很多、偏冷',
  ema_golden: '快線（藍）由下往上穿過慢線（橘）＝黃金交叉',
  ema_death: '快線（藍）由上往下穿過慢線（橘）＝死亡交叉',
  price_above_ema: '收盤價維持在均線（橘）上方',
  price_below_ema: '收盤價掉到均線（橘）下方',
  macd_golden: 'MACD 線（藍）由下往上穿過訊號線（橘），柱狀體由綠轉紅或由負轉正',
  macd_death: 'MACD 線（藍）由上往下穿過訊號線（橘）',
  macd_hist_pos: '柱狀體（長條）在 0 軸上方＝多方動能',
  macd_hist_neg: '柱狀體（長條）在 0 軸下方＝空方動能',
  bb_above_upper: '收盤價衝出布林通道上軌（上方紫線）',
  bb_below_lower: '收盤價跌破布林通道下軌（下方紫線）',
  keltner_above: '收盤價衝出 Keltner 上軌',
  keltner_below: '收盤價跌破 Keltner 下軌',
  adx_strong: 'ADX（下方曲線）升到 25 以上＝趨勢明確（不分漲跌）',
  adx_weak: 'ADX 很低＝來回盤整、沒有明確方向',
  di_bull: '+DI（藍）在 −DI（橘）上方＝上漲力道較強',
  di_bear: '−DI（橘）在 +DI（藍）上方＝下跌力道較強',
  atr_high: '右半邊 K 線的高低範圍明顯變大＝波動變大',
  atr_low: '波動小：K 線都很短',
  kd_overbought: 'K 值升到 80 以上的紅色區＝偏超買',
  kd_oversold: 'K 值跌到 20 以下的藍色區＝偏超賣',
  kd_golden: 'K 線（藍）由下往上穿過 D 線（橘）',
  kd_death: 'K 線（藍）由上往下穿過 D 線（橘）',
  supertrend_up: '趨勢線在價格下方（綠）＝多頭趨勢',
  supertrend_down: '趨勢線在價格上方（紅）＝空頭趨勢',
  supertrend_flip_up: '趨勢線由價格上方（紅）翻到下方（綠）＝轉多',
  supertrend_flip_down: '趨勢線由價格下方（綠）翻到上方（紅）＝轉空',
  vwap_above: '收盤價在 VWAP（橘線，平均成本）上方',
  vwap_below: '收盤價在 VWAP（橘線）下方',
  obv_above: 'OBV（藍）在它的均線（橘）上方＝量能偏多',
  obv_below: 'OBV（藍）在它的均線（橘）下方＝量能偏空',
  cci_overbought: 'CCI 升到 +100 以上＝偏強（超買）',
  cci_oversold: 'CCI 跌到 −100 以下＝偏弱（超賣）',
  mfi_overbought: 'MFI 升到 80 以上＝資金大量流入、偏超買',
  mfi_oversold: 'MFI 跌到 20 以下＝偏超賣',
  donchian_break_up: '收盤價突破前 N 根的最高價（虛線）',
  donchian_break_down: '收盤價跌破前 N 根的最低價（虛線）',
  volume_spike: '某一根的成交量（下方長條）遠高於平常＝爆量',
  fib_pullback: '價格由低點漲到高點（上升波段）後回檔，落在斐波那契回撤位（虛線，如 38.2%、50%、61.8%）附近＝可能的支撐',
  fib_bounce: '價格由高點跌到低點（下降波段）後反彈，落在斐波那契回撤位（虛線）附近＝可能的壓力',
  regime_trend: '價格沿著一個方向走了一大段、很少回頭＝單邊行情（效率比率高）',
  regime_up: '價格一路墊高、很少回檔＝單邊上漲',
  regime_down: '價格一路走低、很少反彈＝單邊下跌',
  regime_range: '價格在一個區間內來回、走了很多路卻回到原點＝震盪（效率比率低）',
  pat_hammer: '下跌之後：實體小、下影線很長、幾乎沒有上影線（像槌子）',
  pat_inverted_hammer: '下跌之後：實體小、上影線很長、幾乎沒有下影線',
  pat_hanging_man: '上漲之後：形狀與槌頭相同（長下影線小實體），可能見頂',
  pat_shooting_star: '上漲之後：實體小、上影線很長（像流星），可能見頂',
  pat_bullish_engulfing: '小陰線後出現大陽線，實體把前一根完全包住',
  pat_bearish_engulfing: '小陽線後出現大陰線，實體把前一根完全包住',
  pat_doji: '開盤價≈收盤價：實體幾乎只剩一條線，上下影線拉長＝多空拉鋸',
  pat_morning_star: '長陰線 → 小實體（猶豫）→ 長陽線收復一半以上＝止跌回升',
  pat_evening_star: '長陽線 → 小實體（猶豫）→ 長陰線跌破一半以下＝見頂回落',
};

const BUILDERS = {
  rsi_overbought: rsiUp, rsi_oversold: rsiDn,
  ema_golden: () => crossOver(true), ema_death: () => crossOver(false),
  price_above_ema: () => emaSide(true), price_below_ema: () => emaSide(false),
  macd_golden: () => macdIll(true), macd_death: () => macdIll(false), macd_hist_pos: () => macdIll(true), macd_hist_neg: () => macdIll(false),
  bb_above_upper: () => bands(true, 0.17), bb_below_lower: () => bands(false, 0.17),
  keltner_above: () => bands(true, 0.2), keltner_below: () => bands(false, 0.2),
  adx_strong: () => adxIll(true, false), adx_weak: () => adxIll(false, false), di_bull: () => adxIll(true, true), di_bear: () => adxIll(false, true),
  atr_high: () => atrIll(false), atr_low: () => atrIll(true),
  kd_overbought: kdUp, kd_oversold: kdDn, kd_golden: () => kdCross(true), kd_death: () => kdCross(false),
  supertrend_up: () => supertrendIll('up'), supertrend_down: () => supertrendIll('down'),
  supertrend_flip_up: () => supertrendIll('flipUp'), supertrend_flip_down: () => supertrendIll('flipDown'),
  vwap_above: () => vwapIll(true), vwap_below: () => vwapIll(false),
  obv_above: () => obvIll(true), obv_below: () => obvIll(false),
  cci_overbought: cciUp, cci_oversold: cciDn,
  mfi_overbought: () => oscillator({ up: true, hi: 0.8, lo: 0.2, label: '80', valsFn: (t) => 0.3 + 0.62 * Math.min(1, t * 1.3), priceFn: (t) => 0.25 + 0.6 * t }),
  mfi_oversold: () => oscillator({ up: false, hi: 0.8, lo: 0.2, label: '20', valsFn: (t) => 0.7 - 0.62 * Math.min(1, t * 1.3), priceFn: (t) => 0.85 - 0.6 * t }),
  donchian_break_up: () => donchianIll(true), donchian_break_down: () => donchianIll(false),
  volume_spike: volumeIll,
  fib_pullback: () => fibIll(true), fib_bounce: () => fibIll(false),
  regime_trend: () => regimeIll('trend'), regime_up: () => regimeIll('up'), regime_down: () => regimeIll('down'), regime_range: () => regimeIll('range'),
  ...PATTERNS,
};
// 沒有專屬圖的說明名詞，借用相近的圖
const ALIAS = { rsi: 'rsi_overbought', ema: 'ema_golden', macd: 'macd_golden', bollinger_upper: 'bb_above_upper', bollinger_lower: 'bb_below_lower',
  adx: 'adx_strong', atr: 'atr_high', kd: 'kd_golden', supertrend: 'supertrend_flip_up', keltner: 'keltner_above', vwap: 'vwap_above', obv: 'obv_above',
  cci: 'cci_overbought', mfi: 'mfi_overbought', donchian: 'donchian_break_up', volume: 'volume_spike', regime: 'regime_trend', efficiency_ratio: 'regime_range', fibonacci: 'fib_pullback' };

const cache = new Map();
/** key 可以是條件 id（如 pat_hammer）或說明名詞（如 rsi） */
export function illustration(key) {
  const id = BUILDERS[key] ? key : ALIAS[key];
  if (!id || !BUILDERS[id]) return null;
  if (!cache.has(id)) cache.set(id, { svg: BUILDERS[id](), cap: CAP[id] || '' });
  return cache.get(id);
}
export function illustrationIds() { return Object.keys(BUILDERS); }
export function illustrationHtml(key, cls = 'pop-illus') {
  const ill = illustration(key);
  return ill ? `<figure class="${cls}">${ill.svg}<figcaption>示意圖：${ill.cap}</figcaption></figure>` : '';
}
