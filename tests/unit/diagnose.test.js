import test from 'node:test';
import assert from 'node:assert/strict';
import { diagnoseStrategy, diagnoseSearch } from '../../public/js/core/diagnose.js';
import { runStrategy } from '../../public/js/core/portfolio.js';
import { splitRanges } from '../../public/js/core/dataset.js';
import { runSearch } from '../../public/js/core/search.js';
import { makeMarket } from '../helpers/market.js';

const COSTS = { fee: 0.0005, slippage: 0.0005, mmr: 0.005, posPct: 1, capital: 10000 };
function run(sig, st) {
  const ranges = splitRanges(sig.ds);
  const res = { ranges, train: runStrategy(sig, st, COSTS, ranges.train), holdout: runStrategy(sig, st, COSTS, ranges.holdout) };
  return { ranges, res, d: diagnoseStrategy(sig, st, ranges, res, { minTrades: 20, costs: COSTS }) };
}

test('診斷：數字與引擎一致（同時成立 ≤ 每個條件；進場訊號 ≥ 實際交易）', () => {
  const { sig } = makeMarket({ days: 240, windowDays: 200 });
  const st = { dir: 'long', entry: [{ id: 'rsi_oversold', tf: '1h', params: { level: 35 } }, { id: 'macd_golden', tf: '1h', within: 3 }], exit: [], sl: 2, tp: 3, lev: 1, entryMode: 'edge' };
  const { d, res } = run(sig, st);
  assert.equal(d.tradesTrain, res.train.metrics.trades);
  assert.ok(d.andTrain <= Math.min(...d.conditions.map((c) => c.train)));
  assert.ok(d.entryTrain <= d.andTrain);
  assert.ok(d.tradesTrain <= d.entryTrain);
  assert.equal(d.perSymbol.reduce((s, p) => s + p.trades, 0), d.tradesTrain);
});

test('診斷：條件一次都不成立 → 指出是哪個條件；沒設停損停利 → 提醒只會有 1 筆', () => {
  const { sig } = makeMarket({ days: 240, windowDays: 200 });
  const never = run(sig, { dir: 'long', entry: [{ id: 'adx_weak', tf: '1h', params: { level: 0 } }, { id: 'bb_below_lower', tf: '1h' }], exit: [], sl: 2, tp: 3, lev: 1 });
  assert.equal(never.d.tradesTrain, 0);
  assert.ok(never.d.tips.some((t) => t.level === 'bad' && t.text.includes('一次都沒有成立') && t.text.includes('ADX')));
  const excl = run(sig, { dir: 'long', entry: [{ id: 'rsi_oversold', tf: '1h', params: { level: 30 } }, { id: 'rsi_overbought', tf: '1h', params: { level: 70 } }], exit: [], sl: 2, tp: 3, lev: 1 });
  assert.ok(excl.d.tips.some((t) => t.text.includes('從來沒有同時成立過')));
  const noexit = run(sig, { dir: 'long', entry: [{ id: 'rsi_oversold', tf: '1h', params: { level: 40 } }], exit: [], sl: 0, tp: 0, lev: 1 });
  assert.ok(noexit.d.tradesTrain <= noexit.d.perSymbol.length);
  assert.ok(noexit.d.tips.some((t) => t.text.includes('沒有設定任何停損')));
});

test('診斷：停利小於交易成本、USDT 單位換算', () => {
  const { sig } = makeMarket({ days: 240, windowDays: 200 });
  const tiny = run(sig, { dir: 'long', entry: [{ id: 'rsi_oversold', tf: '1h', params: { level: 40 } }], exit: [], sl: 1, tp: 0.1, lev: 1 });
  assert.ok(tiny.d.tips.some((t) => t.text.includes('小於等於來回手續費')));
  const u = run(sig, { dir: 'long', entry: [{ id: 'rsi_oversold', tf: '1h', params: { level: 40 } }], exit: [], unit: 'usdt', posUsdt: 6, sl: 3, tp: 2, lev: 1 });
  assert.ok(u.d.tips.some((t) => t.text.includes('33.33%')));
});

test('搜尋診斷：沒有符合資格的候選時給出具體建議', async () => {
  const { sig, ds } = makeMarket({ days: 120, windowDays: 60, symbols: 1 });
  const r = await runSearch(sig, { tfs: ['1h'], budget: 30, minTrades: 400 }, COSTS);
  const tips = diagnoseSearch(r, ds);
  assert.ok(tips.length > 0);
  assert.ok(tips.some((t) => /交易數不到|沒有產生任何候選|符合冠軍資格/.test(t.text)));
});
