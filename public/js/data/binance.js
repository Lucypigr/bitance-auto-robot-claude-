// Binance 公開行情 API（不需要金鑰；瀏覽器直接呼叫）
import { TF_MS, DAY, alignDown } from '../core/util.js';
import { WARMUP_BARS } from '../core/dataset.js';

export const ENDPOINTS = {
  spot: ['https://data-api.binance.vision', 'https://api.binance.com', 'https://api1.binance.com', 'https://api2.binance.com'],
  perp: ['https://fapi.binance.com'],
};
const PATHS = {
  spot: { info: '/api/v3/exchangeInfo?symbolStatus=TRADING', ticker: '/api/v3/ticker/24hr', klines: '/api/v3/klines', limit: 1000 },
  perp: { info: '/fapi/v1/exchangeInfo', ticker: '/fapi/v1/ticker/24hr', klines: '/fapi/v1/klines', mark: '/fapi/v1/markPriceKlines', funding: '/fapi/v1/fundingRate', limit: 1500 },
};

export class BinanceError extends Error {
  constructor(message, kind = 'error', status = 0) {
    super(message);
    this.kind = kind; // 'region' | 'rate' | 'network' | 'api' | 'abort'
    this.status = status;
  }
}

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const id = setTimeout(resolve, ms);
    if (signal) signal.addEventListener('abort', () => { clearTimeout(id); reject(new BinanceError('已取消', 'abort')); }, { once: true });
  });

/** 簡單的並行限制 */
export class Limiter {
  constructor(n) { this.n = n; this.active = 0; this.q = []; }
  run(fn) {
    return new Promise((resolve, reject) => {
      const go = () => {
        this.active++;
        fn().then(resolve, reject).finally(() => { this.active--; if (this.q.length) this.q.shift()(); });
      };
      if (this.active < this.n) go(); else this.q.push(go);
    });
  }
}

export class BinanceClient {
  constructor({ fetchImpl, concurrency = 4, retries = 4, backoffMs = 800, endpoints = ENDPOINTS } = {}) {
    this.fetch = fetchImpl || ((...a) => globalThis.fetch(...a));
    this.limiter = new Limiter(concurrency);
    this.retries = retries;
    this.backoffMs = backoffMs;
    this.endpoints = endpoints;
    this.good = { spot: 0, perp: 0 }; // 目前可用的端點索引
  }

  async getJson(market, path, signal) {
    const bases = this.endpoints[market];
    let lastErr;
    for (let bi = 0; bi < bases.length; bi++) {
      const base = bases[(this.good[market] + bi) % bases.length];
      for (let attempt = 0; attempt <= this.retries; attempt++) {
        if (signal && signal.aborted) throw new BinanceError('已取消', 'abort');
        let res;
        try {
          res = await this.limiter.run(() => this.fetch(base + path, { signal }));
        } catch (e) {
          if (signal && signal.aborted) throw new BinanceError('已取消', 'abort');
          lastErr = new BinanceError('無法連線到 Binance（網路問題或被瀏覽器阻擋）', 'network');
          if (attempt < this.retries) { await sleep(this.backoffMs * 2 ** attempt, signal); continue; }
          break;
        }
        if (res.ok) {
          this.good[market] = (this.good[market] + bi) % bases.length;
          return res.json();
        }
        if (res.status === 451 || res.status === 403) {
          lastErr = new BinanceError('Binance 拒絕了此地區的連線（HTTP ' + res.status + '）。請改用其他網路環境，或稍後再試。', 'region', res.status);
          break; // 換下一個端點
        }
        if (res.status === 429 || res.status === 418) {
          const ra = Number(res.headers && res.headers.get && res.headers.get('Retry-After'));
          lastErr = new BinanceError('Binance 請求過於頻繁，正在等待後重試', 'rate', res.status);
          await sleep(Math.min(30000, (ra > 0 ? ra * 1000 : this.backoffMs * 2 ** attempt)), signal);
          continue;
        }
        if (res.status >= 500) {
          lastErr = new BinanceError('Binance 伺服器暫時異常（HTTP ' + res.status + '）', 'network', res.status);
          if (attempt < this.retries) { await sleep(this.backoffMs * 2 ** attempt, signal); continue; }
          break;
        }
        let msg = '';
        try { const j = await res.json(); msg = j.msg || ''; } catch { /* ignore */ }
        throw new BinanceError(`Binance 回應錯誤（HTTP ${res.status}）${msg}`, 'api', res.status);
      }
    }
    throw lastErr || new BinanceError('無法取得資料', 'network');
  }

  /** 可交易的 USDT 交易對，依 24h 成交額排序 */
  async listSymbols(market, signal) {
    const P = PATHS[market];
    const [info, tick] = await Promise.all([this.getJson(market, P.info, signal), this.getJson(market, P.ticker, signal)]);
    const vol = new Map();
    for (const t of tick) vol.set(t.symbol, Number(t.quoteVolume) || 0);
    const out = [];
    for (const s of info.symbols) {
      if (s.quoteAsset !== 'USDT' || s.status !== 'TRADING') continue;
      if (market === 'spot' && s.isSpotTradingAllowed === false) continue;
      if (market === 'perp' && s.contractType !== 'PERPETUAL') continue;
      out.push({ symbol: s.symbol, base: s.baseAsset, quoteVolume: vol.get(s.symbol) || 0, onboardDate: s.onboardDate || 0 });
    }
    out.sort((a, b) => b.quoteVolume - a.quoteVolume);
    return out;
  }

  /** 抓 K 線（自動分頁）。只保留「已收盤」的 K 線。 */
  async klines(market, symbol, interval, startTime, endTime, { signal, kind = 'klines', now = Date.now() } = {}) {
    const P = PATHS[market];
    const ms = TF_MS[interval];
    const rows = [];
    let cursor = startTime;
    for (let guard = 0; guard < 2000; guard++) {
      const path = `${kind === 'mark' ? P.mark : P.klines}?symbol=${symbol}&interval=${interval}&startTime=${cursor}&endTime=${endTime}&limit=${P.limit}`;
      const page = await this.getJson(market, path, signal);
      if (!Array.isArray(page) || page.length === 0) break;
      for (const r of page) rows.push(r);
      const lastOpen = page[page.length - 1][0];
      cursor = lastOpen + ms;
      if (page.length < P.limit || cursor > endTime) break;
    }
    return parseKlines(rows, now, kind);
  }

  async funding(symbol, startTime, endTime, { signal } = {}) {
    const P = PATHS.perp;
    const rows = [];
    let cursor = startTime;
    for (let guard = 0; guard < 500; guard++) {
      const page = await this.getJson('perp', `${P.funding}?symbol=${symbol}&startTime=${cursor}&endTime=${endTime}&limit=1000`, signal);
      if (!Array.isArray(page) || page.length === 0) break;
      for (const r of page) rows.push(r);
      cursor = page[page.length - 1].fundingTime + 1;
      if (page.length < 1000) break;
    }
    const t = new Float64Array(rows.length);
    const rate = new Float64Array(rows.length);
    const mark = new Float64Array(rows.length);
    rows.forEach((r, i) => { t[i] = r.fundingTime; rate[i] = Number(r.fundingRate); mark[i] = Number(r.markPrice) || 0; });
    return { t, rate, mark };
  }
}

export function parseKlines(rows, now = Date.now(), kind = 'klines') {
  // 只保留已收盤的 K 線（收盤時間 < 現在），去除重複、確保遞增
  const keep = [];
  let prev = -Infinity;
  for (const r of rows) {
    if (r[6] >= now) continue;
    if (r[0] <= prev) continue;
    prev = r[0];
    keep.push(r);
  }
  const n = keep.length;
  const out = { t: new Float64Array(n), o: new Float64Array(n), h: new Float64Array(n), l: new Float64Array(n), c: new Float64Array(n), v: new Float64Array(n) };
  for (let i = 0; i < n; i++) {
    const r = keep[i];
    out.t[i] = r[0]; out.o[i] = +r[1]; out.h[i] = +r[2]; out.l[i] = +r[3]; out.c[i] = +r[4];
    out.v[i] = kind === 'mark' ? 0 : +r[5];
  }
  return out;
}

// ---------------- 快取（IndexedDB；測試時可換成記憶體版） ----------------
export class MemoryStore {
  constructor() { this.m = new Map(); }
  async get(k) { return this.m.get(k); }
  async set(k, v) { this.m.set(k, v); }
  async clear() { this.m.clear(); }
}

export class IdbStore {
  constructor(name = 'bt-cache', store = 'kv') { this.name = name; this.store = store; this.dbp = null; }
  db() {
    if (!this.dbp) {
      this.dbp = new Promise((resolve, reject) => {
        const req = indexedDB.open(this.name, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(this.store);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return this.dbp;
  }
  async get(k) {
    try {
      const db = await this.db();
      return await new Promise((res, rej) => { const r = db.transaction(this.store).objectStore(this.store).get(k); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    } catch { return undefined; }
  }
  async set(k, v) {
    try {
      const db = await this.db();
      await new Promise((res, rej) => { const tx = db.transaction(this.store, 'readwrite'); tx.objectStore(this.store).put(v, k); tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
    } catch { /* 快取失敗不影響功能 */ }
  }
  async clear() {
    try {
      const db = await this.db();
      await new Promise((res, rej) => { const tx = db.transaction(this.store, 'readwrite'); tx.objectStore(this.store).clear(); tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
    } catch { /* ignore */ }
  }
}

function concat(a, b, keys) {
  const out = {};
  for (const k of keys) {
    const x = new Float64Array(a[k].length + b[k].length);
    x.set(a[k], 0); x.set(b[k], a[k].length);
    out[k] = x;
  }
  return out;
}
function slice(d, keys, from, to) {
  const out = {};
  for (const k of keys) out[k] = d[k].slice(from, to);
  return out;
}
const lowerIdx = (t, x) => { let lo = 0, hi = t.length; while (lo < hi) { const m = (lo + hi) >>> 1; if (t[m] < x) lo = m + 1; else hi = m; } return lo; };

/**
 * 區間快取：只補抓「還沒有的頭尾」。
 * entry = { coveredFrom, coveredTo, data } ；coveredFrom/To 是「曾經請求過」的範圍（幣種上市前的空白也算已請求過）
 */
export async function cachedSeries(store, key, start, end, ms, keys, fetchRange) {
  let e = await store.get(key);
  let changed = false;
  if (!e || !e.data) {
    e = { coveredFrom: start, coveredTo: end, data: await fetchRange(start, end) };
    changed = true;
  } else {
    if (start < e.coveredFrom) {
      const d = await fetchRange(start, e.coveredFrom - 1);
      e.data = concat(d, e.data, keys);
      e.coveredFrom = start;
      changed = true;
    }
    if (end > e.coveredTo) {
      const have = e.data.t.length;
      const lastHave = have ? e.data.t[have - 1] : -Infinity;
      const d = await fetchRange(Math.max(have ? lastHave + 1 : e.coveredTo, e.coveredFrom), end);
      const from = lowerIdx(d.t, lastHave + 1); // 去重：只接上比現有最後一根更新的
      e.data = concat(e.data, slice(d, keys, from, d.t.length), keys);
      e.coveredTo = end;
      changed = true;
    }
  }
  if (changed) await store.set(key, e);
  const a = lowerIdx(e.data.t, start);
  const b = lowerIdx(e.data.t, end + 1);
  return slice(e.data, keys, a, b);
}

const KL = ['t', 'o', 'h', 'l', 'c', 'v'];
const MK = ['t', 'o', 'h', 'l', 'c', 'v'];
const FK = ['t', 'rate', 'mark'];

/**
 * 載入回測所需的全部資料。
 * @returns {{market, baseTf, windowStart, endTime, symbols:[{symbol, klines, mark, funding}], warnings:string[]}}
 */
export async function loadMarketData(client, store, { market, symbols, baseTf, tfs, days, useMark = true, onProgress, signal, now = Date.now() }) {
  const baseMs = TF_MS[baseTf];
  const endTime = alignDown(now, baseMs);
  const windowStart = alignDown(endTime - days * DAY, baseMs);
  const allTfs = [...new Set([baseTf, ...tfs])];
  const warnings = [];
  const jobs = [];
  for (const symbol of symbols) {
    for (const tf of allTfs) jobs.push({ symbol, kind: 'klines', tf });
    if (market === 'perp') {
      if (useMark) jobs.push({ symbol, kind: 'mark', tf: baseTf });
      jobs.push({ symbol, kind: 'funding' });
    }
  }
  let done = 0;
  const results = new Map();
  const report = (label) => onProgress && onProgress({ done, total: jobs.length, label });
  report('準備下載');

  await Promise.all(jobs.map(async (job) => {
    const id = `${job.symbol}|${job.kind}|${job.tf || ''}`;
    try {
      let data;
      if (job.kind === 'funding') {
        const s = windowStart - 2 * 86400000;
        data = await cachedSeries(store, `${market}|${job.symbol}|funding`, s, endTime, 3600000, FK, (a, b) => client.funding(job.symbol, a, b, { signal }));
      } else {
        const ms = TF_MS[job.tf];
        const s = windowStart - WARMUP_BARS * ms;
        const keys = job.kind === 'mark' ? MK : KL;
        data = await cachedSeries(store, `${market}|${job.symbol}|${job.tf}|${job.kind}`, s, endTime - 1, ms, keys,
          (a, b) => client.klines(market, job.symbol, job.tf, a, b, { signal, kind: job.kind, now }));
      }
      results.set(id, data);
    } catch (e) {
      if (e.kind === 'abort') throw e;
      if (job.kind === 'mark' || job.kind === 'funding') {
        warnings.push(`${job.symbol}：${job.kind === 'mark' ? '標記價格' : '資金費率'}下載失敗（${e.message}），${job.kind === 'mark' ? '清算改用成交價判斷' : '本次回測不計資金費率'}`);
        results.set(id, null);
      } else {
        throw new BinanceError(`${job.symbol} ${job.tf} K 線下載失敗：${e.message}`, e.kind || 'error');
      }
    }
    done++;
    report(`${job.symbol}`);
  }));

  const out = symbols.map((symbol) => {
    const klines = {};
    for (const tf of allTfs) klines[tf] = results.get(`${symbol}|klines|${tf}`);
    return {
      symbol, klines,
      mark: results.get(`${symbol}|mark|${baseTf}`) || null,
      funding: results.get(`${symbol}|funding|`) || null,
    };
  });
  return { market, baseTf, windowStart, endTime, symbols: out, warnings };
}
