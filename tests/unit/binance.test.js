import test from 'node:test';
import assert from 'node:assert/strict';
import { BinanceClient, MemoryStore, cachedSeries, loadMarketData, parseKlines } from '../../public/js/data/binance.js';
import { buildDataset } from '../../public/js/core/dataset.js';
import { FakeBinance, fakeFetch } from '../helpers/fake-binance.js';

const HOUR = 3600000;
const NOW = Date.UTC(2025, 5, 1, 10, 20, 0);

test('parseKlines：只保留已收盤的 K 線、去重、數值化', () => {
  const rows = [
    [0, '1', '2', '0.5', '1.5', '10', 3599999],
    [0, '1', '2', '0.5', '1.5', '10', 3599999], // 重複
    [3600000, '1.5', '3', '1', '2', '20', 7199999],
    [7200000, '2', '4', '2', '3', '30', 10799999], // 尚未收盤
  ];
  const k = parseKlines(rows, 8000000);
  assert.deepEqual([...k.t], [0, 3600000]);
  assert.equal(k.c[1], 2);
  assert.equal(k.v[1], 20);
});

test('klines：自動分頁、不含未收盤 K 線', async () => {
  const fake = new FakeBinance({ nowMs: NOW });
  const c = new BinanceClient({ fetchImpl: fakeFetch(fake), concurrency: 2 });
  const start = NOW - 1500 * 5 * 60000 * 2; // 3000 根 5m → 需要 3 頁(1000)
  const k = await c.klines('spot', 'BTCUSDT', '5m', start, NOW, { now: NOW });
  assert.ok(k.t.length >= 2990 && k.t.length <= 3001, `${k.t.length}`);
  for (let i = 1; i < k.t.length; i++) assert.equal(k.t[i] - k.t[i - 1], 300000, '時間必須連續');
  assert.ok(k.t[k.t.length - 1] + 300000 <= NOW, '最後一根必須已收盤');
  const pages = fake.requests.filter((r) => r.includes('/klines')).length;
  assert.ok(pages >= 3);
});

test('listSymbols：只列 USDT 交易中的交易對、依成交額排序', async () => {
  const c = new BinanceClient({ fetchImpl: fakeFetch(new FakeBinance({ nowMs: NOW })) });
  for (const m of ['spot', 'perp']) {
    const list = await c.listSymbols(m);
    assert.ok(list.length >= 20);
    assert.equal(list[0].symbol, 'BTCUSDT');
    assert.ok(list.every((s) => s.symbol.endsWith('USDT')));
    assert.ok(!list.some((s) => s.symbol === 'BTCEUR'));
  }
});

test('錯誤處理：451 地區限制 → 明確訊息；429 → 重試', async () => {
  let calls = 0;
  const f451 = async () => ({ ok: false, status: 451, headers: { get: () => null }, json: async () => ({}) });
  const c1 = new BinanceClient({ fetchImpl: f451, retries: 0, endpoints: { spot: ['https://a'], perp: ['https://b'] } });
  await assert.rejects(c1.getJson('perp', '/x'), (e) => e.kind === 'region' && /地區/.test(e.message));
  const flaky = async () => {
    calls++;
    if (calls < 3) return { ok: false, status: 429, headers: { get: () => '0' }, json: async () => ({}) };
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ ok: 1 }) };
  };
  const c2 = new BinanceClient({ fetchImpl: flaky, retries: 4, backoffMs: 1, endpoints: { spot: ['https://a'], perp: [] } });
  assert.deepEqual(await c2.getJson('spot', '/y'), { ok: 1 });
  assert.equal(calls, 3);
});

test('現貨端點失敗時自動換下一個端點', async () => {
  const f = async (url) => {
    if (url.startsWith('https://a')) return { ok: false, status: 451, headers: { get: () => null }, json: async () => ({}) };
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ from: 'b' }) };
  };
  const c = new BinanceClient({ fetchImpl: f, retries: 0, endpoints: { spot: ['https://a', 'https://b'], perp: [] } });
  assert.deepEqual(await c.getJson('spot', '/z'), { from: 'b' });
});

test('區間快取：第二次只補抓缺的尾巴；往前延伸只補抓頭部', async () => {
  const store = new MemoryStore();
  const calls = [];
  const mk = (a, b) => {
    calls.push([a, b]);
    const t = []; for (let x = Math.ceil(a / HOUR) * HOUR; x <= b; x += HOUR) t.push(x);
    return { t: Float64Array.from(t), o: Float64Array.from(t), h: Float64Array.from(t), l: Float64Array.from(t), c: Float64Array.from(t), v: Float64Array.from(t) };
  };
  const keys = ['t', 'o', 'h', 'l', 'c', 'v'];
  const r1 = await cachedSeries(store, 'k', 10 * HOUR, 20 * HOUR, HOUR, keys, mk);
  assert.equal(r1.t.length, 11);
  const r2 = await cachedSeries(store, 'k', 10 * HOUR, 25 * HOUR, HOUR, keys, mk);
  assert.equal(r2.t.length, 16);
  assert.deepEqual(calls[1], [20 * HOUR + 1, 25 * HOUR]);
  const r3 = await cachedSeries(store, 'k', 5 * HOUR, 25 * HOUR, HOUR, keys, mk);
  assert.equal(r3.t.length, 21);
  assert.deepEqual(calls[2], [5 * HOUR, 10 * HOUR - 1]);
  await cachedSeries(store, 'k', 8 * HOUR, 22 * HOUR, HOUR, keys, mk);
  assert.equal(calls.length, 3, '範圍已涵蓋 → 不再下載');
  for (let i = 1; i < r3.t.length; i++) assert.equal(r3.t[i] - r3.t[i - 1], HOUR);
});

test('loadMarketData + buildDataset：永續合約含標記價格與資金費率', async () => {
  const fake = new FakeBinance({ nowMs: NOW });
  const client = new BinanceClient({ fetchImpl: fakeFetch(fake) });
  const prog = [];
  const d = await loadMarketData(client, new MemoryStore(), {
    market: 'perp', symbols: ['BTCUSDT', 'ETHUSDT'], baseTf: '1h', tfs: ['4h'], days: 20, now: NOW, onProgress: (p) => prog.push(p),
  });
  assert.equal(d.symbols.length, 2);
  assert.ok(d.symbols[0].mark && d.symbols[0].funding && d.symbols[0].funding.t.length > 40);
  assert.ok(prog.length > 5 && prog[prog.length - 1].done === prog[prog.length - 1].total);
  const ds = buildDataset({ market: 'perp', baseTf: '1h', windowStart: d.windowStart, endTime: d.endTime, symbols: d.symbols });
  assert.equal(ds.symbols.length, 2);
  assert.ok(ds.symbols[0].mh && !Number.isNaN(ds.symbols[0].ml[ds.n - 1]));
  assert.equal(ds.windowStartIdx, 300);
  assert.equal(ds.symbols[0].gaps, 0);
  // 最後一根 K 線必須在 now 之前收盤
  assert.ok(ds.t0 + ds.n * ds.baseMs <= NOW);
  // 標記價格載入失敗 → 退而求其次並提出警告
  const bad = new FakeBinance({ nowMs: NOW, failMark: true });
  const d2 = await loadMarketData(new BinanceClient({ fetchImpl: fakeFetch(bad), retries: 0, backoffMs: 1 }), new MemoryStore(), {
    market: 'perp', symbols: ['BTCUSDT'], baseTf: '1h', tfs: [], days: 10, now: NOW,
  });
  assert.equal(d2.symbols[0].mark, null);
  assert.ok(d2.warnings.some((w) => w.includes('標記價格')));
});

test('現貨不下載資金費率與標記價格', async () => {
  const fake = new FakeBinance({ nowMs: NOW });
  const client = new BinanceClient({ fetchImpl: fakeFetch(fake) });
  const d = await loadMarketData(client, new MemoryStore(), { market: 'spot', symbols: ['BTCUSDT'], baseTf: '1h', tfs: [], days: 5, now: NOW });
  assert.equal(d.symbols[0].funding, null);
  assert.ok(!fake.requests.some((r) => r.includes('fundingRate') || r.includes('markPrice')));
});

test('漲幅榜：listSymbols 帶出 24h 漲跌幅，sortSymbols 可依成交額／漲幅／跌幅排序', async () => {
  const { sortSymbols } = await import('../../public/js/data/binance.js');
  const c = new BinanceClient({ fetchImpl: fakeFetch(new FakeBinance({ nowMs: NOW })) });
  const list = await c.listSymbols('perp');
  assert.ok(list.every((s) => typeof s.change24h === 'number'));
  assert.ok(list.some((s) => s.change24h > 0) && list.some((s) => s.change24h < 0));
  const gain = sortSymbols(list, 'gain');
  for (let i = 1; i < gain.length; i++) assert.ok(gain[i - 1].change24h >= gain[i].change24h);
  const loss = sortSymbols(list, 'loss');
  for (let i = 1; i < loss.length; i++) assert.ok(loss[i - 1].change24h <= loss[i].change24h);
  const vol = sortSymbols(list, 'volume');
  assert.equal(vol[0].symbol, 'BTCUSDT');
  assert.equal(list.length, gain.length, '排序不可增減項目');
  // 舊快取沒有 change24h 欄位時不應壞掉
  assert.equal(sortSymbols([{ symbol: 'A', quoteVolume: 1 }, { symbol: 'B', quoteVolume: 2 }], 'gain')[0].symbol, 'B');
});

test('歷史漲幅榜：windowReturn 只使用區間內已收盤的完整日線', async () => {
  const { windowReturn, historyWindow } = await import('../../public/js/data/binance.js');
  const D = 86400000;
  const rows = { t: Float64Array.from([0, D, 2 * D, 3 * D]), o: Float64Array.from([10, 11, 12, 13]), c: Float64Array.from([11, 12, 13, 99]) };
  assert.equal(windowReturn(rows, 3 * D, 3), 13 / 10 - 1); // 區間 [0, 3D)：不含第 4 根（99）
  assert.equal(windowReturn(rows, 3 * D, 4), null, '區間開始前沒有資料（上市太晚）→ 排除');
  assert.equal(windowReturn(rows, 3 * D, 2), 13 / 11 - 1);
  const w = historyWindow(Date.UTC(2026, 9, 6, 15), 7, 7);
  assert.equal(w.end, Date.UTC(2026, 9, 6) - 7 * D);
  assert.equal(w.start, w.end - 7 * D);
});

test('歷史漲幅榜：掃描多個合約，與直接用日線計算的結果一致，且不受區間之後的資料影響', async () => {
  const { sortSymbols } = await import('../../public/js/data/binance.js');
  const fake = new FakeBinance({ nowMs: NOW });
  const c = new BinanceClient({ fetchImpl: fakeFetch(fake) });
  const syms = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT'];
  const opts = { endDaysAgo: 7, windowDays: 7, now: NOW };
  const r = await c.historicalGainers('perp', syms, opts);
  assert.equal(r.returns.size, 5);
  for (const sym of syms) {
    const k = await c.klines('perp', sym, '1d', r.start, r.end - 1, { now: NOW });
    assert.equal(k.t.length, 7);
    assert.ok(Math.abs(r.returns.get(sym) - (k.c[6] / k.o[0] - 1)) < 1e-12);
    assert.ok(k.t[6] + 86400000 <= r.end, '最後一根必須在區間結束前收盤');
  }
  // 兩天後再算同一個「絕對區間」，結果不變（區間之後的新資料不會混進來）
  const later = await c.historicalGainers('perp', syms, { endDaysAgo: 9, windowDays: 7, now: NOW + 2 * 86400000 });
  assert.equal(later.start, r.start);
  for (const sym of syms) assert.equal(later.returns.get(sym), r.returns.get(sym));
  const list = syms.map((s) => ({ symbol: s, quoteVolume: 1, histRet: r.returns.get(s) }));
  const sorted = sortSymbols(list, 'hist');
  for (let i = 1; i < sorted.length; i++) assert.ok(sorted[i - 1].histRet >= sorted[i].histRet);
  assert.equal(sortSymbols([{ symbol: 'X', quoteVolume: 1 }, ...list], 'hist').at(-1).symbol, 'X', '沒有榜單資料的排最後');
});
