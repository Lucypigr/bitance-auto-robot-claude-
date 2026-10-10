import test from 'node:test';
import assert from 'node:assert/strict';
import { efficiencyRatio } from '../../public/js/core/indicators.js';
import { CONDITIONS, evalSpecOnSeries, IndicatorBundle, validateSpec } from '../../public/js/core/conditions.js';
import { regimeSeries, regimeOverview, tradesByRegime, REGIME, REGIME_DEFAULTS, validateRegimeParams } from '../../public/js/core/regime.js';
import { mkDs } from '../helpers/ds.js';

const near = (a, b, e = 1e-9) => assert.ok(Math.abs(a - b) <= e, `${a} !≈ ${b}`);
const arr = (a) => Float64Array.from(a);

test('效率比率：直線＝1、來回震盪＝接近 0、前 n 根為 NaN、只用過去資料', () => {
  const up = arr(Array.from({ length: 30 }, (_, i) => 100 + i));
  const er = efficiencyRatio(up, 10);
  assert.ok(Number.isNaN(er[9]) && er[10] === 1 && er[29] === 1);
  const chop = arr(Array.from({ length: 30 }, (_, i) => 100 + (i % 2 ? 1 : 0)));
  assert.ok(efficiencyRatio(chop, 10)[29] < 0.15);
  const flat = arr(new Array(30).fill(100));
  assert.equal(efficiencyRatio(flat, 10)[20], 0);
  // 無偷看：改動第 20 根之後的資料，第 20 根以前的值不變
  const a = arr(Array.from({ length: 40 }, (_, i) => 100 + Math.sin(i) * 3 + i * 0.2));
  const b = a.slice(); for (let i = 21; i < 40; i++) b[i] += 50;
  const ea = efficiencyRatio(a, 10); const eb = efficiencyRatio(b, 10);
  for (let i = 0; i <= 20; i++) assert.equal(Number.isNaN(ea[i]) ? -1 : ea[i], Number.isNaN(eb[i]) ? -1 : eb[i]);
  // 手算：0,3,0 → n=2：淨位移 0、路徑 6 → 0；0,3,6 → 6/6 = 1
  near(efficiencyRatio(arr([0, 3, 0]), 2)[2], 0); near(efficiencyRatio(arr([0, 3, 6]), 2)[2], 1);
});

function bundleOf(c) {
  const n = c.length;
  return new IndicatorBundle({ t: Float64Array.from({ length: n }, (_, i) => i * 3600000), o: c, h: c, l: c, c, v: new Float64Array(n).fill(1) }, '1h');
}

test('行情條件：單邊上漲／下跌／震盪各自成立在對的走勢上，且互斥', () => {
  const up = arr(Array.from({ length: 60 }, (_, i) => 100 + i));
  const down = arr(Array.from({ length: 60 }, (_, i) => 200 - i));
  const chop = arr(Array.from({ length: 60 }, (_, i) => 100 + (i % 2 ? 1 : -1)));
  const ev = (id, c) => Array.from(evalSpecOnSeries({ id, tf: '1h' }, bundleOf(c)));
  assert.equal(ev('regime_up', up)[59], 1); assert.equal(ev('regime_down', up)[59], 0); assert.equal(ev('regime_trend', up)[59], 1); assert.equal(ev('regime_range', up)[59], 0);
  assert.equal(ev('regime_down', down)[59], 1); assert.equal(ev('regime_up', down)[59], 0);
  assert.equal(ev('regime_range', chop)[59], 1); assert.equal(ev('regime_trend', chop)[59], 0);
  assert.equal(ev('regime_up', up)[10], 0, '暖機期間不成立');
  for (const id of ['regime_trend', 'regime_up', 'regime_down', 'regime_range']) assert.equal(validateSpec({ id, tf: '1h' }), '');
  assert.equal(CONDITIONS.regime_range.params.level, 0.12);
});

test('行情分類：四種狀態、暖機為 0、門檻驗證', () => {
  const closes = [...Array.from({ length: 40 }, (_, i) => 100 + i), ...Array.from({ length: 40 }, (_, i) => 140 + (i % 2 ? 0.5 : -0.5))];
  const bars = closes.map((c) => [c, c, c, c]);
  const { ds } = mkDs(bars);
  const { regime } = regimeSeries(ds, 0, REGIME_DEFAULTS);
  assert.equal(regime[10], REGIME.NONE);
  assert.equal(regime[35], REGIME.UP);
  assert.equal(regime[79], REGIME.RANGE);
  const down = mkDs(Array.from({ length: 50 }, (_, i) => [200 - i, 200 - i, 200 - i, 200 - i])).ds;
  assert.equal(regimeSeries(down, 0, REGIME_DEFAULTS).regime[45], REGIME.DOWN);
  assert.throws(() => validateRegimeParams({ period: 2 }), /週期/);
  assert.throws(() => validateRegimeParams({ trend: 0.1, range: 0.3 }), /小於/);
  assert.doesNotThrow(() => validateRegimeParams({}));
});

test('行情總覽：目前行情、各行情占比加總為 1', () => {
  const closes = [...Array.from({ length: 40 }, (_, i) => 100 + i), ...Array.from({ length: 40 }, (_, i) => 140 + (i % 2 ? 0.5 : -0.5))];
  const { ds } = mkDs(closes.map((c) => [c, c, c, c]));
  const [o] = regimeOverview(ds, REGIME_DEFAULTS);
  assert.equal(o.current, REGIME.RANGE);
  near(Object.values(o.share).reduce((a, b) => a + b, 0), 1);
  assert.ok(o.share[REGIME.UP] > 0.2 && o.share[REGIME.RANGE] > 0.2);
});

test('交易依「訊號當下」的行情分組；損益、勝率、PF 正確', () => {
  const closes = [...Array.from({ length: 40 }, (_, i) => 100 + i), ...Array.from({ length: 40 }, (_, i) => 140 + (i % 2 ? 0.5 : -0.5))];
  const { ds } = mkDs(closes.map((c) => [c, c, c, c]));
  const t = (signalIdx, pnl) => ({ symbol: 'TESTUSDT', si: 0, signalIdx, pnl, ret: pnl / 1000 });
  const g = tradesByRegime([t(35, 50), t(36, -20), t(70, -30), t(72, -10), t(5, 5)], ds, REGIME_DEFAULTS);
  const by = Object.fromEntries(g.map((x) => [x.regime, x]));
  assert.equal(by[REGIME.UP].n, 2); near(by[REGIME.UP].pnl, 30); near(by[REGIME.UP].winRate, 0.5); near(by[REGIME.UP].profitFactor, 50 / 20);
  assert.equal(by[REGIME.RANGE].n, 2); near(by[REGIME.RANGE].pnl, -40); assert.equal(by[REGIME.RANGE].profitFactor, 0);
  assert.equal(by[REGIME.NONE].n, 1);
});
