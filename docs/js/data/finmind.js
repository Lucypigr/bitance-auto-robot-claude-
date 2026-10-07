// 台股日線資料（FinMind 公開 API + 證交所 TWSE 行情表）。皆可由瀏覽器直接呼叫。
//  - TaiwanStockPrice                          日 K（未還原）
//  - TaiwanStockDividendResult                 除權息結果（參考價）
//  - TaiwanStockSplitPrice                     分割／面額變更
//  - TaiwanStockCapitalReductionReferencePrice 減資
// 還原股價：用上述事件把事件日前的價格往下／往上調整，避免除息、分割被誤判成暴跌。
import { Limiter, cachedSeries } from './binance.js';
import { adjustPrices, findSuspiciousJumps } from '../core/dataset.js';
import { DAY } from '../core/util.js';

export const FM_URL = 'https://api.finmindtrade.com/api/v4/data';
export const TWSE_QUOTES = 'https://www.twse.com.tw/exchangeReport/MI_INDEX';
export const TW_WARMUP_DAYS = 460; // 約 300 個交易日的暖機（EMA200 需要）

export class FinMindError extends Error {
  constructor(message, kind = 'error', status = 0) { super(message); this.kind = kind; this.status = status; }
}
const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const id = setTimeout(resolve, ms);
  if (signal) signal.addEventListener('abort', () => { clearTimeout(id); reject(new FinMindError('已取消', 'abort')); }, { once: true });
});

const dateStr = (ms) => new Date(ms).toISOString().slice(0, 10);
const dateMs = (s) => Date.parse(`${s}T00:00:00Z`);

/** 台灣時間 (UTC+8) 的「最後一個已收盤交易日」候選日期：13:30 收盤，資料約 14:30 後可用 */
export function lastClosedTwDate(now = Date.now()) {
  const tw = new Date(now + 8 * 3600000);
  const today = Date.UTC(tw.getUTCFullYear(), tw.getUTCMonth(), tw.getUTCDate());
  const minutes = tw.getUTCHours() * 60 + tw.getUTCMinutes();
  return minutes >= 14 * 60 + 30 ? today : today - DAY;
}

export class FinMindClient {
  constructor({ fetchImpl, token = '', concurrency = 3, retries = 3, backoffMs = 800 } = {}) {
    this.fetch = fetchImpl || ((...a) => globalThis.fetch(...a));
    this.token = token;
    this.limiter = new Limiter(concurrency);
    this.retries = retries;
    this.backoffMs = backoffMs;
  }

  async get(dataset, params = {}, signal) {
    const q = new URLSearchParams({ dataset, ...params });
    if (this.token) q.set('token', this.token);
    const url = `${FM_URL}?${q}`;
    let lastErr;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      if (signal && signal.aborted) throw new FinMindError('已取消', 'abort');
      let res;
      try {
        res = await this.limiter.run(() => this.fetch(url, { signal }));
      } catch (e) {
        if (signal && signal.aborted) throw new FinMindError('已取消', 'abort');
        lastErr = new FinMindError('無法連線到 FinMind（網路問題或被瀏覽器阻擋）', 'network');
        if (attempt < this.retries) { await sleep(this.backoffMs * 2 ** attempt, signal); continue; }
        break;
      }
      let body = null;
      try { body = await res.json(); } catch { /* ignore */ }
      const status = (body && body.status) || res.status;
      if (res.ok && status === 200) return body.data || [];
      if (status === 402 || status === 429 || (body && /upper limit|too many/i.test(body.msg || ''))) {
        throw new FinMindError('FinMind 免費額度（每小時請求數）用完了。請到進階設定填入你的免費 FinMind Token，或一小時後再試。', 'rate', status);
      }
      if (status === 400 && body && /level|sponsor/i.test(body.msg || '')) throw new FinMindError('此資料集需要 FinMind 付費會員', 'api', 400);
      if (res.status >= 500) {
        lastErr = new FinMindError(`FinMind 伺服器暫時異常（HTTP ${res.status}）`, 'network', res.status);
        if (attempt < this.retries) { await sleep(this.backoffMs * 2 ** attempt, signal); continue; }
        break;
      }
      throw new FinMindError(`FinMind 回應錯誤（${status}）${body && body.msg ? ' ' + body.msg : ''}`, 'api', status);
    }
    throw lastErr || new FinMindError('無法取得資料', 'network');
  }

  /** 股票／ETF 清單（上市、上櫃） */
  async listStocks(signal) {
    const rows = await this.get('TaiwanStockInfo', {}, signal);
    const seen = new Map();
    for (const r of rows) {
      if (!['twse', 'tpex'].includes(r.type) || !/^\d{4,6}[A-Z]?$/.test(r.stock_id)) continue;
      if (seen.has(r.stock_id)) continue;
      seen.set(r.stock_id, {
        symbol: r.stock_id, base: r.stock_name, industry: r.industry_category, board: r.type,
        isEtf: r.industry_category === 'ETF' || /^00/.test(r.stock_id), quoteVolume: 0, change24h: 0,
      });
    }
    return [...seen.values()];
  }

  /** 日 K（未還原）。FinMind 在停牌日回傳 0 價，這裡略過 */
  async prices(id, startMs, endMs, signal) {
    const rows = await this.get('TaiwanStockPrice', { data_id: id, start_date: dateStr(startMs), end_date: dateStr(endMs) }, signal);
    const out = { t: [], o: [], h: [], l: [], c: [], v: [] };
    let prev = -Infinity;
    for (const r of rows) {
      const t = dateMs(r.date);
      if (!(r.close > 0) || t <= prev || t > endMs) continue;
      prev = t;
      const c = r.close;
      const o = r.open > 0 ? r.open : c;
      out.t.push(t); out.o.push(o); out.c.push(c);
      out.h.push(r.max > 0 ? Math.max(r.max, o, c) : Math.max(o, c));
      out.l.push(r.min > 0 ? Math.min(r.min, o, c) : Math.min(o, c));
      out.v.push(r.Trading_Volume || 0);
    }
    const F = (a) => Float64Array.from(a);
    return { t: F(out.t), o: F(out.o), h: F(out.h), l: F(out.l), c: F(out.c), v: F(out.v) };
  }

  /** 除權息、分割、減資事件 → 調整係數 */
  async actions(id, startMs, endMs, signal) {
    const p = { data_id: id, start_date: dateStr(startMs), end_date: dateStr(endMs) };
    const [div, split, red] = await Promise.all([
      this.get('TaiwanStockDividendResult', p, signal),
      this.get('TaiwanStockSplitPrice', p, signal),
      this.get('TaiwanStockCapitalReductionReferencePrice', p, signal).catch((e) => { if (e.kind === 'abort') throw e; return []; }),
    ]);
    return toActions(div, split, red);
  }
}

export function toActions(div = [], split = [], red = []) {
  const list = [];
  for (const r of div) {
    if (r.before_price > 0 && r.reference_price > 0) list.push({ date: r.date, factor: r.reference_price / r.before_price, kind: 'dividend', splitLike: false });
  }
  for (const r of split) {
    if (r.before_price > 0 && r.after_price > 0) list.push({ date: r.date, factor: r.after_price / r.before_price, kind: r.type || 'split', splitLike: true });
  }
  for (const r of red) {
    const after = r.reference_price ?? r.after_price ?? r.post_price;
    const before = r.before_price ?? r.closing_price_on_the_last_trading_date;
    if (before > 0 && after > 0) list.push({ date: r.date, factor: after / before, kind: 'reduction', splitLike: true });
  }
  return list.sort((a, b) => (a.date < b.date ? -1 : 1));
}

/** 證交所最近一個交易日行情表：成交金額與漲跌幅（只有上市股票），用來排序選股 */
export async function twseQuotes(fetchImpl, now = Date.now()) {
  const f = fetchImpl || ((...a) => globalThis.fetch(...a));
  const out = new Map();
  let day = lastClosedTwDate(now);
  for (let tries = 0; tries < 9; tries++, day -= DAY) {
    const dow = new Date(day).getUTCDay();
    if (dow === 0 || dow === 6) continue;
    const ds = dateStr(day).replace(/-/g, '');
    try {
      const res = await f(`${TWSE_QUOTES}?response=json&date=${ds}&type=ALLBUT0999`);
      if (!res.ok) continue;
      const j = await res.json();
      if (j.stat !== 'OK' || !j.tables) continue;
      const t = j.tables.find((x) => x.fields && x.fields.includes('證券代號') && x.fields.includes('收盤價') && x.data && x.data.length > 20);
      if (!t) continue;
      const ix = (name) => t.fields.indexOf(name);
      const num = (s) => Number(String(s).replace(/,/g, ''));
      for (const r of t.data) {
        const close = num(r[ix('收盤價')]);
        if (!(close > 0)) continue;
        const diff = num(r[ix('漲跌價差')]) || 0;
        const sign = /color:\s*green/.test(r[ix('漲跌(+/-)')]) || /-/.test(String(r[ix('漲跌(+/-)')]).replace(/<[^>]*>/g, '')) ? -1 : 1;
        const prev = close - sign * diff;
        out.set(r[ix('證券代號')], { turnover: num(r[ix('成交金額')]) || 0, change: prev > 0 ? (sign * diff) / prev : 0, date: ds });
      }
      if (out.size) return out;
    } catch { /* 試前一天 */ }
  }
  return out;
}

const KEYS = ['t', 'o', 'h', 'l', 'c', 'v'];

/**
 * 載入台股日線（已還原）。
 * @returns {{windowStart:number, symbols:Array, warnings:string[], endDate:number}}
 */
export async function loadTwData(client, store, { symbols, days, onProgress, signal, now = Date.now() }) {
  const end = lastClosedTwDate(now);
  const windowStart = end - days * DAY;
  const start = windowStart - TW_WARMUP_DAYS * DAY;
  const warnings = [];
  let done = 0;
  const total = symbols.length * 2;
  const tick = (label) => { done++; if (onProgress) onProgress({ done, total, label }); };
  if (onProgress) onProgress({ done: 0, total, label: '準備下載' });

  const results = await Promise.all(symbols.map(async (s) => {
    const priceP = cachedSeries(store, `tw|${s.symbol}|price`, start, end, DAY, KEYS, (a, b) => client.prices(s.symbol, a, b, signal)).then((x) => { tick(`${s.symbol} 價格`); return x; });
    const actP = (async () => {
      const key = `tw|${s.symbol}|actions`;
      const c = await store.get(key);
      if (c && c.from <= start && c.to >= end - 7 * DAY && Date.now() - c.fetchedAt < 12 * 3600000) { tick(`${s.symbol} 除權息`); return c.list; }
      const list = await client.actions(s.symbol, start, end, signal);
      await store.set(key, { from: start, to: end, fetchedAt: Date.now(), list });
      tick(`${s.symbol} 除權息`);
      return list;
    })();
    const [bars, actions] = await Promise.all([priceP, actP]);
    return { s, bars, actions };
  }));

  const out = results.map(({ s, bars, actions }) => {
    const adj = adjustPrices(bars, actions);
    const jumps = findSuspiciousJumps({ t: adj.bars.t, c: adj.bars.c }).filter((j) => j.t >= windowStart);
    return { symbol: s.symbol, name: s.name || s.base || '', isEtf: !!s.isEtf, bars: adj.bars, jumps, adjusted: adj.applied.length };
  });
  return { windowStart, endDate: end, symbols: out, warnings };
}
