// 測試用「假 Binance」：回傳與真實 API 相同格式、但內容是合成行情的資料。
// 只用在單元測試與 Playwright（不會被部署版使用）。
import { makePath5m, aggregate, FACTOR, ANCHOR } from './synth.js';

const MS5 = 300000;
export const FAKE_SYMBOLS = ['BTC', 'ETH', 'BNB', 'SOL', 'XRP', 'DOGE', 'ADA', 'AVAX', 'LINK', 'DOT', 'LTC', 'TRX', 'MATIC', 'ATOM', 'NEAR', 'UNI', 'APT', 'OP', 'ARB', 'SUI'];
const INTERVAL = { '5m': 1, '15m': 3, '1h': 12, '4h': 48, '1d': 288 };

export class FakeBinance {
  constructor({ nowMs = Date.now(), regimeScale = 0.4, failMark = false, delay = 0 } = {}) {
    this.now = nowMs;
    this.regimeScale = regimeScale;
    this.failMark = failMark;
    this.delay = delay;
    this.paths = new Map();
    this.requests = [];
  }
  path(sym) {
    if (!this.paths.has(sym)) {
      const idx = Math.max(0, FAKE_SYMBOLS.indexOf(sym.replace('USDT', '')));
      const count = Math.floor((this.now - ANCHOR) / MS5);
      const p = makePath5m(1000 + idx * 31, count, 50 + idx * 40, 0.0028, 0, 1000, this.regimeScale);
      this.paths.set(sym, p);
    }
    return this.paths.get(sym);
  }
  series(sym, interval, start, end, limit) {
    const full = this.path(sym);
    const f = INTERVAL[interval];
    const ms = MS5 * f;
    const first = Math.max(0, Math.ceil((start - ANCHOR) / ms));
    const rows = [];
    for (let b = first; rows.length < limit; b++) {
      const i0 = b * f;
      const open = ANCHOR + b * ms;
      if (open > end || i0 + f > full.t.length + f) break; // 含「尚未收盤」的最後一根
      const i1 = Math.min(i0 + f, full.t.length);
      if (i0 >= full.t.length) break;
      let hh = -Infinity, ll = Infinity, vv = 0;
      for (let j = i0; j < i1; j++) { hh = Math.max(hh, full.h[j]); ll = Math.min(ll, full.l[j]); vv += full.v[j]; }
      rows.push([open, String(full.o[i0]), String(hh), String(ll), String(full.c[i1 - 1]), String(vv), open + ms - 1, '0', 1, '0', '0', '0']);
    }
    return rows;
  }
  /** 回傳 {status, body} */
  handle(urlStr) {
    const u = new URL(urlStr);
    const p = u.pathname;
    const q = u.searchParams;
    this.requests.push(p + u.search);
    const perp = p.startsWith('/fapi');
    const syms = FAKE_SYMBOLS.map((b) => `${b}USDT`);
    if (p.endsWith('/exchangeInfo')) {
      return ok({ symbols: syms.map((s, i) => perp
        ? { symbol: s, status: 'TRADING', contractType: 'PERPETUAL', quoteAsset: 'USDT', baseAsset: s.replace('USDT', ''), onboardDate: ANCHOR }
        : { symbol: s, status: 'TRADING', isSpotTradingAllowed: true, quoteAsset: 'USDT', baseAsset: s.replace('USDT', '') }).concat([{ symbol: 'BTCEUR', status: 'TRADING', isSpotTradingAllowed: true, contractType: 'PERPETUAL', quoteAsset: 'EUR', baseAsset: 'BTC' }]) });
    }
    if (p.endsWith('/ticker/24hr')) return ok(syms.map((s, i) => ({ symbol: s, quoteVolume: String(1e9 / (i + 1)) })));
    if (p.endsWith('/klines') || p.endsWith('/markPriceKlines')) {
      const sym = q.get('symbol');
      if (!syms.includes(sym)) return { status: 400, body: { code: -1121, msg: 'Invalid symbol.' } };
      if (p.endsWith('/markPriceKlines') && this.failMark) return { status: 500, body: { code: -1000, msg: 'boom' } };
      const limit = Math.min(Number(q.get('limit') || 500), perp ? 1500 : 1000);
      return ok(this.series(sym, q.get('interval'), Number(q.get('startTime')), Number(q.get('endTime')), limit));
    }
    if (p.endsWith('/fundingRate')) {
      const sym = q.get('symbol');
      const full = this.path(sym);
      const st = Number(q.get('startTime')); const en = Number(q.get('endTime'));
      const rows = [];
      const step = 8 * 3600000;
      for (let t = Math.ceil(Math.max(st, ANCHOR) / step) * step; t <= en && t < this.now && rows.length < 1000; t += step) {
        const i = Math.min(full.c.length - 1, Math.floor((t - ANCHOR) / MS5));
        rows.push({ symbol: sym, fundingTime: t, fundingRate: '0.00010000', markPrice: String(full.c[i]) });
      }
      return ok(rows);
    }
    return { status: 404, body: { msg: 'not found' } };
  }
}
const ok = (body) => ({ status: 200, body });

/** 組成 fetch 介面（單元測試用） */
export function fakeFetch(fake) {
  return async (url) => {
    if (fake.delay) await new Promise((r) => setTimeout(r, fake.delay));
    const { status, body } = fake.handle(url);
    return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => body };
  };
}
void aggregate; void FACTOR;
