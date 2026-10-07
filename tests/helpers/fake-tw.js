// 測試用「假的 FinMind／證交所」：回傳相同格式、內容為合成資料。
import { makePath5m, aggregate, FACTOR, ANCHOR } from './synth.js';

export const FAKE_TW = [
  ['2330', '台積電', 'twse', '半導體業'], ['2317', '鴻海', 'twse', '其他電子業'], ['2454', '聯發科', 'twse', '半導體業'],
  ['2881', '富邦金', 'twse', '金融保險業'], ['2603', '長榮', 'twse', '航運業'], ['1301', '台塑', 'twse', '塑膠工業'],
  ['3008', '大立光', 'twse', '光電業'], ['2412', '中華電', 'twse', '通信網路業'], ['0050', '元大台灣50', 'twse', 'ETF'],
  ['00878', '國泰永續高股息', 'twse', 'ETF'], ['6488', '環球晶', 'tpex', '半導體業'], ['3105', '穩懋', 'tpex', '半導體業'],
];
const DAYMS = 86400000;

export class FakeTw {
  constructor({ nowMs = Date.now(), quota = Infinity } = {}) {
    this.now = nowMs;
    this.quota = quota;
    this.requests = [];
    this.cache = new Map();
    // 事件（日期以「第 k 個交易日」表示）：2330 現金股利 f=0.985；0050 一拆四 f=0.25
    this.events = { '2330': [{ fromEnd: 250, f: 0.985, type: 'dividend' }], '0050': [{ fromEnd: 120, f: 0.25, type: 'split' }] };
  }
  /** 連續（已還原）價格 P 與交易日曆 */
  base(id) {
    if (this.cache.has(id)) return this.cache.get(id);
    const idx = Math.max(0, FAKE_TW.findIndex((s) => s[0] === id));
    const total = Math.floor((this.now - ANCHOR) / 300000);
    const path = makePath5m(500 + idx * 13, total, 100 + idx * 30, 0.0006, 0, 1000, 0.1);
    const d = aggregate(path, FACTOR['1d']);
    const rows = [];
    let wk = 0;
    for (let i = 0; i < d.t.length; i++) {
      const dow = new Date(d.t[i]).getUTCDay();
      if (dow === 0 || dow === 6) continue;
      wk++;
      if (wk % 47 === 0) continue; // 假日
      rows.push({ t: d.t[i], o: d.o[i], h: d.h[i], l: d.l[i], c: d.c[i], v: Math.round(d.v[i] * 1000) });
    }
    const evs = (this.events[id] || []).map((e) => ({ ...e, k: rows.length - e.fromEnd }));
    // raw(t) = P(t) / Π f（事件日之前）
    const rawRows = rows.map((r, k) => {
      let prod = 1;
      for (const e of evs) if (k < e.k) prod *= e.f;
      return { ...r, o: r.o / prod, h: r.h / prod, l: r.l / prod, c: r.c / prod, adj: { o: r.o, h: r.h, l: r.l, c: r.c } };
    });
    const out = { rows, rawRows, evs };
    this.cache.set(id, out);
    return out;
  }
  handle(urlStr) {
    const u = new URL(urlStr);
    this.requests.push(u.host + u.pathname + u.search);
    if (u.host.includes('twse.com.tw')) return this.twse(u);
    if (--this.quota < 0) return { status: 402, body: { msg: 'Requests reach the upper limit', status: 402 } };
    const ds = u.searchParams.get('dataset');
    const id = u.searchParams.get('data_id');
    const a = u.searchParams.get('start_date');
    const b = u.searchParams.get('end_date');
    const inRange = (ms) => (!a || ms >= Date.parse(`${a}T00:00:00Z`)) && (!b || ms <= Date.parse(`${b}T00:00:00Z`));
    const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
    if (ds === 'TaiwanStockInfo') {
      return ok(FAKE_TW.map(([sid, name, type, ind]) => ({ industry_category: ind, stock_id: sid, stock_name: name, type, date: '2020-01-01' }))
        .concat([{ industry_category: '其他', stock_id: '8888', stock_name: '興櫃股', type: 'emerging', date: '2020-01-01' }]));
    }
    if (!FAKE_TW.some((s) => s[0] === id)) return ok([]);
    const { rawRows, evs } = this.base(id);
    const limit = this.lastClosed();
    if (ds === 'TaiwanStockPrice') {
      return ok(rawRows.filter((r) => inRange(r.t) && r.t <= limit).map((r) => ({
        date: iso(r.t), stock_id: id, Trading_Volume: r.v, Trading_money: r.v * r.c, open: +r.o.toFixed(4), max: +r.h.toFixed(4), min: +r.l.toFixed(4), close: +r.c.toFixed(4), spread: 0, Trading_turnover: 1,
      })));
    }
    const ev = (kind) => evs.filter((e) => (kind === 'dividend' ? e.type === 'dividend' : e.type === 'split')).map((e) => {
      const before = rawRows[e.k - 1].c;
      return { date: iso(rawRows[e.k].t), stock_id: id, before_price: before, after_price: before * e.f, reference_price: before * e.f, type: '分割' };
    }).filter((r) => inRange(Date.parse(`${r.date}T00:00:00Z`)));
    if (ds === 'TaiwanStockDividendResult') return ok(ev('dividend'));
    if (ds === 'TaiwanStockSplitPrice') return ok(ev('split'));
    if (ds === 'TaiwanStockCapitalReductionReferencePrice') return ok([]);
    return { status: 400, body: { msg: 'unknown dataset', status: 400 } };
  }
  lastClosed() {
    const tw = new Date(this.now + 8 * 3600000);
    const today = Date.UTC(tw.getUTCFullYear(), tw.getUTCMonth(), tw.getUTCDate());
    return tw.getUTCHours() * 60 + tw.getUTCMinutes() >= 14 * 60 + 30 ? today : today - DAYMS;
  }
  twse() {
    const rows = FAKE_TW.filter((s) => s[2] === 'twse').map(([id], i) => {
      const { rawRows } = this.base(id);
      const last = rawRows[rawRows.length - 1]; const prev = rawRows[rawRows.length - 2];
      const diff = Math.abs(last.c - prev.c);
      return [id, id, '1,000', '10', (1e9 / (i + 1)).toLocaleString('en-US'), String(last.o), String(last.h), String(last.l), String(last.c), last.c >= prev.c ? '<p style= color:red>+</p>' : '<p style= color:green>-</p>', diff.toFixed(2), '0', '0', '0', '0', '0'];
    });
    const pad = Array.from({ length: 30 }, (_, i) => [`9${900 + i}`, 'x', '1', '1', '1', '10', '10', '10', '10', ' ', '0', '0', '0', '0', '0', '0']);
    return ok({ stat: 'OK', tables: [{ title: '每日收盤行情', fields: ['證券代號', '證券名稱', '成交股數', '成交筆數', '成交金額', '開盤價', '最高價', '最低價', '收盤價', '漲跌(+/-)', '漲跌價差', '最後揭示買價', '最後揭示買量', '最後揭示賣價', '最後揭示賣量', '本益比'], data: [...rows, ...pad] }] });
  }
}
const ok = (data) => ({ status: 200, body: Array.isArray(data) ? { msg: 'success', status: 200, data } : data });
export function fakeTwFetch(fake) {
  return async (url) => {
    const { status, body } = fake.handle(url);
    return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => body };
  };
}
