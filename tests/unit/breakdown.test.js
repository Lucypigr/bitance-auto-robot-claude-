import test from 'node:test';
import assert from 'node:assert/strict';
import { symbolBreakdown } from '../../public/js/core/breakdown.js';
import { runStrategy } from '../../public/js/core/portfolio.js';
import { splitRanges } from '../../public/js/core/dataset.js';
import { makeMarket } from '../helpers/market.js';

const COSTS = { fee: 0.0005, slippage: 0.0005, mmr: 0.005, posPct: 1, capital: 10000 };

test('各幣種損益加總 = 投組總損益；交易數與勝率與總計一致', () => {
  const { sig, ds } = makeMarket({ symbols: 4, days: 240, windowDays: 200 });
  const r = splitRanges(ds);
  const st = { dir: 'short', entry: [{ id: 'rsi_overbought', tf: '1h', params: { level: 65 } }], exit: [], sl: 2, tp: 3, lev: 3, entryMode: 'edge' };
  for (const range of [r.train, r.holdout]) {
    const res = runStrategy(sig, st, COSTS, range);
    const b = symbolBreakdown(res, COSTS.capital);
    assert.equal(b.rows.length, 4);
    assert.ok(Math.abs(b.totalPnl - (res.metrics.finalEquity - COSTS.capital)) < 1e-6, '加總應等於總損益');
    assert.equal(b.rows.reduce((s, x) => s + x.trades, 0), res.metrics.trades);
    assert.equal(b.rows.reduce((s, x) => s + x.wins, 0), res.metrics.wins);
    assert.ok(Math.abs(b.rows.reduce((s, x) => s + x.funding, 0) - res.metrics.funding) < 1e-6);
    assert.equal(b.sleeve, 2500);
    assert.equal(b.rows.filter((x) => x.pnl > 0).length, res.metrics.positiveSymbols);
  }
});
