import test from 'node:test';
import assert from 'node:assert/strict';
import { PATTERNS } from '../../public/js/core/patterns.js';

// bars: [o,h,l,c]
function run(name, bars) {
  const f = (k) => Float64Array.from(bars.map((b) => b[k]));
  return [...PATTERNS[name](f(0), f(1), f(2), f(3))];
}
// 前 6 根：先製造下跌 / 上漲趨勢
const downTrend = Array.from({ length: 7 }, (_, i) => { const c = 100 - i * 2; return [c + 1, c + 1.5, c - 1.5, c]; });
const upTrend = Array.from({ length: 7 }, (_, i) => { const c = 100 + i * 2; return [c - 1, c + 1.5, c - 1.5, c]; });

test('槌頭：下跌後、長下影線小實體', () => {
  const bar = [86, 86.4, 80, 86.3]; // 實體 0.3、下影 6、上影 0.1
  assert.equal(run('hammer', [...downTrend, bar])[7], 1);
  assert.equal(run('hanging_man', [...downTrend, bar])[7], 0, '下跌後的同形狀是槌頭，不是上吊線');
});
test('上吊線：上漲後、長下影線小實體', () => {
  const bar = [112, 112.3, 106, 112.2];
  assert.equal(run('hanging_man', [...upTrend, bar])[7], 1);
  assert.equal(run('hammer', [...upTrend, bar])[7], 0);
});
test('倒槌頭 / 流星線：長上影線', () => {
  const bar1 = [86, 92, 85.9, 86.3];
  assert.equal(run('inverted_hammer', [...downTrend, bar1])[7], 1);
  assert.equal(run('shooting_star', [...downTrend, bar1])[7], 0);
  const bar2 = [112, 118, 111.9, 112.3];
  assert.equal(run('shooting_star', [...upTrend, bar2])[7], 1);
  assert.equal(run('inverted_hammer', [...upTrend, bar2])[7], 0);
});
test('吞噬', () => {
  assert.equal(run('bullish_engulfing', [[10, 10.2, 8.8, 9], [8.8, 11, 8.7, 10.5]])[1], 1);
  assert.equal(run('bearish_engulfing', [[9, 10.2, 8.8, 10], [10.2, 10.3, 8.5, 8.7]])[1], 1);
  // 實體沒有完全包住 → 不成立
  assert.equal(run('bullish_engulfing', [[10, 10.2, 8.8, 9], [9.2, 10, 9.1, 9.8]])[1], 0);
});
test('十字星', () => {
  assert.equal(run('doji', [[10, 11, 9, 10.05]])[0], 1);
  assert.equal(run('doji', [[10, 11, 9, 10.9]])[0], 0);
});
test('晨星 / 暮星', () => {
  const ms = [[20, 20.2, 14.8, 15], [14.5, 14.8, 14, 14.6], [14.8, 18.5, 14.7, 18.2]];
  assert.equal(run('morning_star', ms)[2], 1);
  assert.equal(run('evening_star', ms)[2], 0);
  const es = [[15, 20.2, 14.8, 20], [20.5, 21, 20.2, 20.4], [20.2, 20.3, 16, 16.5]];
  assert.equal(run('evening_star', es)[2], 1);
  assert.equal(run('morning_star', es)[2], 0);
});
test('資料不足時不會成立', () => {
  assert.equal(run('morning_star', [[1, 2, 0, 1]])[0], 0);
  assert.equal(run('hammer', [[1, 1.1, 0, 1.05]])[0], 0);
});
