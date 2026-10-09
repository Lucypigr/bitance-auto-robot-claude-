import test from 'node:test';
import assert from 'node:assert/strict';
import { CONDITIONS, PARAM_GRID, normalizeSpec, validateSpec, specKey, describeSpec } from '../../public/js/core/conditions.js';
import { generateCandidates, buildAtomSlots, strategyKey, DEFAULT_POOL, SEARCH_DEFAULTS } from '../../public/js/core/search.js';
import { validateStrategy } from '../../public/js/core/portfolio.js';
import { splitRanges } from '../../public/js/core/dataset.js';
import { makeMarket } from '../helpers/market.js';

const ALL = Object.keys(CONDITIONS);

test('每個條件的預設值與建議值都在允許範圍內，且通過驗證', () => {
  for (const id of ALL) {
    const def = CONDITIONS[id];
    assert.equal(validateSpec({ id, tf: '1h' }), '', `${id} 預設值`);
    for (const f of def.fields) {
      assert.ok(f.min < f.max && f.options.length >= 2, `${id}.${f.key} 欄位定義`);
      assert.ok(f.key in def.params, `${id}.${f.key} 沒有預設值`);
      for (const o of f.options) assert.ok(o >= f.min && o <= f.max, `${id}.${f.key} 建議值 ${o} 超出範圍`);
    }
  }
});

test('所有帶參數的條件（VWAP、K 線型態除外）都能在介面上調整每一個參數', () => {
  for (const id of ALL) {
    const def = CONDITIONS[id];
    const keys = Object.keys(def.params);
    assert.deepEqual(def.fields.map((f) => f.key).sort(), keys.slice().sort(), `${id} 有參數沒有欄位`);
  }
});

test('參數整理：字串轉數字、週期取整數、超出範圍拉回、缺少用預設', () => {
  const p = normalizeSpec({ id: 'rsi_oversold', tf: '1h', params: { period: '9.4', level: 'abc' } }).params;
  assert.equal(p.period, 9);
  assert.equal(p.level, 30);
  assert.equal(normalizeSpec({ id: 'rsi_oversold', tf: '1h', params: { period: 1 } }).params.period, 2);
  assert.equal(normalizeSpec({ id: 'bb_below_lower', tf: '1h', params: { mult: 2.5 } }).params.mult, 2.5);
});

test('參數驗證：快線必須小於慢線、超出範圍與非數字會給出明確訊息', () => {
  assert.match(validateSpec({ id: 'ema_golden', tf: '1h', params: { fast: 60, slow: 50 } }), /快線.*小於慢線/);
  assert.match(validateSpec({ id: 'macd_golden', tf: '1h', params: { fast: 26, slow: 12 } }), /快線.*小於慢線/);
  assert.match(validateSpec({ id: 'rsi_oversold', tf: '1h', params: { period: 1 } }), /週期.*介於/);
  assert.match(validateSpec({ id: 'rsi_oversold', tf: '1h', params: { level: 'x' } }), /必須是數字/);
  assert.equal(validateSpec({ id: 'macd_golden', tf: '1h', params: { fast: 8, slow: 17, signal: 9 } }), '');
});

test('回測前的策略驗證會擋下不合理的參數', () => {
  const { ds } = makeMarket();
  const bad = { dir: 'long', entry: [{ id: 'ema_golden', tf: '1h', params: { fast: 100, slow: 20 } }], lev: 1 };
  assert.throws(() => validateStrategy(ds, bad), /快線/);
  assert.doesNotThrow(() => validateStrategy(ds, { ...bad, entry: [{ id: 'ema_golden', tf: '1h', params: { fast: 20, slow: 100 } }] }));
});

test('改參數真的會改訊號與說明文字；specKey 不同', () => {
  const a = { id: 'macd_golden', tf: '1h', params: { fast: 12, slow: 26, signal: 9 } };
  const b = { id: 'macd_golden', tf: '1h', params: { fast: 8, slow: 17, signal: 9 } };
  assert.notEqual(specKey(a), specKey(b));
  assert.match(describeSpec(b), /MACD\(8,17,9\)/);
  const { sig } = makeMarket();
  const ia = sig.entryIdx(0, [a], 'edge');
  const ib = sig.entryIdx(0, [b], 'edge');
  assert.ok(ia.length > 0 && ib.length > 0);
  assert.notDeepEqual(Array.from(ia), Array.from(ib));
});

test('預設（參數固定）模式的搜尋原子與舊版相同：只有 RSI 門檻與 EMA50/200', () => {
  const slots = buildAtomSlots('long', ['1h'], { ...SEARCH_DEFAULTS, pool: DEFAULT_POOL });
  const rsi = slots.find((s) => s.key.startsWith('rsi|')).specs;
  assert.deepEqual(rsi.map((s) => Object.keys(s.params)), rsi.map(() => ['level']));
  const ema = slots.find((s) => s.key.startsWith('ema|')).specs;
  assert.deepEqual(ema.map((s) => s.params), [{ fast: 50, slow: 200 }]);
  const macd = slots.find((s) => s.key.startsWith('macd|')).specs;
  assert.deepEqual(macd.map((s) => s.params), [{}]);
});

test('「同時搜尋指標參數」模式：每個家族多組參數，全都是合法參數', () => {
  const cfg = { ...SEARCH_DEFAULTS, pool: DEFAULT_POOL, paramSearch: 'grid' };
  const slots = buildAtomSlots('long', ['1h'], cfg);
  const rsi = slots.find((s) => s.key.startsWith('rsi|')).specs;
  assert.deepEqual([...new Set(rsi.map((s) => s.params.period))].sort((a, b) => a - b), [7, 14, 21]);
  assert.equal(rsi.length, 3 * SEARCH_DEFAULTS.rsiOversold.length);
  const ema = slots.find((s) => s.key.startsWith('ema|')).specs;
  assert.equal(new Set(ema.map((s) => `${s.params.fast}/${s.params.slow}`)).size, 3);
  for (const s of slots.flatMap((x) => x.specs)) assert.equal(validateSpec(s), '', `${s.id} ${JSON.stringify(s.params)}`);
  // 全部指標一起開，網格也都合法
  const all = buildAtomSlots('long', ['1h'], { ...cfg, pool: ALL, allowOpposite: true });
  for (const s of all.flatMap((x) => x.specs)) assert.equal(validateSpec(s), '', `${s.id} ${JSON.stringify(s.params)}`);
  for (const [fam, sets] of Object.entries(PARAM_GRID)) {
    const ids = ALL.filter((id) => CONDITIONS[id].family === fam);
    assert.ok(ids.length, `網格家族 ${fam} 沒有對應條件`);
    for (const set of sets) for (const id of ids) for (const k of Object.keys(set)) assert.ok(k in CONDITIONS[id].params, `${fam}.${k}`);
  }
});

test('參數搜尋：候選數仍不超過上限、不重複、可重現，且同家族不會同時出現兩組參數', () => {
  const { sig, ds } = makeMarket();
  const r = splitRanges(ds);
  const cfg = { tfs: ['1h', '4h'], budget: 120, minTrades: 3, paramSearch: 'grid', maxConditions: 4 };
  const a = generateCandidates(sig, cfg, r.train);
  const b = generateCandidates(sig, cfg, r.train);
  assert.ok(a.candidates.length <= 120 && a.candidates.length >= 20);
  assert.deepEqual(a.candidates.map(strategyKey), b.candidates.map(strategyKey));
  assert.equal(new Set(a.candidates.map(strategyKey)).size, a.candidates.length);
  const periods = new Set();
  for (const c of a.candidates) {
    const fam = c.entry.map((e) => `${CONDITIONS[e.id].pattern ? 'pattern' : CONDITIONS[e.id].family}|${e.tf}`);
    assert.equal(new Set(fam).size, fam.length);
    for (const e of c.entry) if (e.id.startsWith('rsi_')) periods.add(e.params.period);
  }
  assert.ok(periods.size >= 2, `RSI 週期應多樣：${[...periods]}`);
  // 固定模式下 RSI 週期一律是預設 14（沒有帶 period）
  const f = generateCandidates(sig, { ...cfg, paramSearch: 'fixed' }, r.train);
  for (const c of f.candidates) for (const e of c.entry) assert.equal(e.params.period, undefined);
});
