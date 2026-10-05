import test from 'node:test';
import assert from 'node:assert/strict';
import { runSearch, generateCandidates, selectChampions, SEARCH_DEFAULTS, BUDGETS, strategyKey } from '../../public/js/core/search.js';
import { splitRanges } from '../../public/js/core/dataset.js';
import { stabilityScore } from '../../public/js/core/metrics.js';
import { makeMarket } from '../helpers/market.js';
import { ANCHOR } from '../helpers/synth.js';

const COSTS = { fee: 0.0005, slippage: 0.0005, mmr: 0.005, posPct: 1, capital: 10000 };
const CFG = { tfs: ['1h', '4h'], budget: 60, minTrades: 5 };

test('候選數永遠不超過上限，且加入槓桿不會讓數量膨脹', () => {
  const { sig, ds } = makeMarket();
  const r = splitRanges(ds);
  for (const budget of BUDGETS) {
    for (const levList of [[1], [1, 2, 3, 5, 10]]) {
      const { candidates } = generateCandidates(sig, { ...CFG, budget, levList, minTrades: 3 }, r.train);
      assert.ok(candidates.length <= budget, `budget=${budget} 實際 ${candidates.length}`);
      assert.ok(candidates.length >= Math.min(budget, 20), `候選太少：${candidates.length}`);
      const keys = new Set(candidates.map(strategyKey));
      assert.equal(keys.size, candidates.length, '候選不可重複');
    }
  }
  // 槓桿只是被抽樣的維度：有槓桿選項時，各槓桿都應出現
  const { candidates } = generateCandidates(sig, { ...CFG, budget: 180, minTrades: 3 }, r.train);
  const levs = new Set(candidates.map((c) => c.lev));
  assert.ok(levs.size >= 4, `槓桿覆蓋 ${[...levs]}`);
});

test('候選條件數 ≤ 設定上限，且同一指標家族／週期不重複', () => {
  const { sig, ds } = makeMarket();
  const r = splitRanges(ds);
  for (const maxConditions of [2, 3, 4]) {
    const { candidates } = generateCandidates(sig, { ...CFG, budget: 120, maxConditions, minTrades: 3 }, r.train);
    for (const c of candidates) {
      assert.ok(c.entry.length >= 1 && c.entry.length <= maxConditions);
      const fam = c.entry.map((e) => `${e.id.startsWith('pat_') ? 'pattern' : e.id.split('_')[0]}|${e.tf}`);
      assert.equal(new Set(fam).size, fam.length);
    }
  }
});

test('現貨：只做多、1× 槓桿', () => {
  const { sig, ds } = makeMarket({ market: 'spot' });
  const r = splitRanges(ds);
  const { candidates } = generateCandidates(sig, { ...CFG, budget: 60, minTrades: 3 }, r.train);
  assert.ok(candidates.length > 0);
  for (const c of candidates) { assert.equal(c.dir, 'long'); assert.equal(c.lev, 1); }
});

test('相同種子 → 相同候選與結果（可重現）', async () => {
  const { sig } = makeMarket();
  const a = await runSearch(sig, CFG, COSTS);
  const b = await runSearch(sig, CFG, COSTS);
  assert.deepEqual(a.candidates.map((c) => c.id + c.desc), b.candidates.map((c) => c.id + c.desc));
  assert.deepEqual(a.champions, b.champions);
});

test('【防過度擬合】改變樣本外(後 30%)的資料，候選、訓練期績效與冠軍完全不變', async () => {
  const A = makeMarket({ seed: 7 });
  const r = splitRanges(A.ds);
  const splitTime = A.ds.t0 + r.splitIdx * A.ds.baseMs;
  const cutIdx5m = Math.round((splitTime - ANCHOR) / 300000);
  const B = makeMarket({
    seed: 7,
    mutate: (path, s) => {
      // 在切割點之後把價格走勢完全換掉（接續切割點前的價格）
      let p = path.c[cutIdx5m - 1];
      let x = 12345 + s;
      const rnd = () => { x = (x * 1103515245 + 12345) & 0x7fffffff; return x / 0x7fffffff; };
      for (let i = cutIdx5m; i < path.c.length; i++) {
        const o = p; const c = p * (1 + (rnd() - 0.5) * 0.004);
        path.o[i] = o; path.c[i] = c; path.h[i] = Math.max(o, c) * 1.001; path.l[i] = Math.min(o, c) * 0.999; path.v[i] = 500 + rnd() * 500;
        p = c;
      }
    },
  });
  assert.equal(A.ds.n, B.ds.n);
  assert.equal(splitRanges(B.ds).splitIdx, r.splitIdx);
  const ra = await runSearch(A.sig, CFG, COSTS);
  const rb = await runSearch(B.sig, CFG, COSTS);
  assert.deepEqual(ra.candidates.map((c) => c.desc), rb.candidates.map((c) => c.desc), '候選組合不應受樣本外影響');
  assert.deepEqual(ra.candidates.map((c) => c.train), rb.candidates.map((c) => c.train), '訓練期績效不應受樣本外影響');
  assert.deepEqual(ra.champions, rb.champions, '冠軍不應受樣本外影響');
  // 確認兩份資料的樣本外確實不同（測試本身有效）
  const idA = ra.champions.netReturn || ra.champions.winRate;
  if (idA) {
    assert.notEqual(ra.details[idA].holdout.metrics.finalEquity, rb.details[idA].holdout.metrics.finalEquity);
    assert.equal(ra.details[idA].train.metrics.finalEquity, rb.details[idA].train.metrics.finalEquity);
  }
});

test('樣本外只會對冠軍計算（排行榜候選不含樣本外績效）', async () => {
  const { sig } = makeMarket();
  const r = await runSearch(sig, CFG, COSTS);
  for (const c of r.candidates) assert.equal(c.holdout, undefined);
  const champIds = new Set(Object.values(r.champions).filter(Boolean));
  assert.deepEqual(new Set(Object.keys(r.details)), champIds);
});

test('取消：cancelled() 為真時立即停止', async () => {
  const { sig } = makeMarket();
  let n = 0;
  const r = await runSearch(sig, { ...CFG, budget: 120 }, COSTS, { cancelled: () => ++n > 5 });
  assert.equal(r.cancelled, true);
});

const mk = (id, index, t, stab = 0) => ({ id, index, train: { trades: 30, liquidations: 0, winRate: 0.5, netReturn: 0.1, profitFactor: 1.5, ...t }, stability: stab });

test('冠軍選擇：交易數不足、訓練期曾清算者不得當選', () => {
  const evals = [
    mk('a', 0, { winRate: 0.99, trades: 19 }), // 交易數不足
    mk('b', 1, { winRate: 0.95, liquidations: 1 }), // 清算
    mk('c', 2, { winRate: 0.7, netReturn: 0.05 }),
    mk('d', 3, { winRate: 0.6, netReturn: 0.5 }, 30),
    mk('e', 4, { winRate: 0.55, netReturn: 0.2, profitFactor: 1.2 }, 55),
  ];
  const ch = selectChampions(evals, { minTrades: 20 });
  assert.equal(ch.winRate.id, 'c');
  assert.equal(ch.netReturn.id, 'd');
  assert.equal(ch.stable.id, 'e');
});

test('最穩定冠軍必須在訓練期獲利且 PF>1；否則為 null', () => {
  const evals = [mk('x', 0, { netReturn: -0.1, profitFactor: 0.8 }, 90), mk('y', 1, { netReturn: 0.1, profitFactor: 0.99 }, 80)];
  assert.equal(selectChampions(evals, { minTrades: 20 }).stable, null);
});

test('穩定度評分：較佳的指標分數較高；接近清算的策略被扣分', () => {
  const base = { trades: 60, sharpe: 1.5, sortino: 2, profitFactor: 1.5, maxDrawdown: 0.15, positiveSymbolRatio: 0.8, positiveMonths: 5, totalMonths: 6, liqProximity: 0.2 };
  const s0 = stabilityScore(base).score;
  assert.ok(stabilityScore({ ...base, sharpe: 2.5 }).score > s0);
  assert.ok(stabilityScore({ ...base, maxDrawdown: 0.4 }).score < s0);
  assert.ok(stabilityScore({ ...base, liqProximity: 0.95 }).score < s0);
  assert.ok(stabilityScore({ ...base, trades: 10 }).score < s0);
  assert.ok(stabilityScore({ ...base, positiveSymbolRatio: 0.2 }).score < s0);
  assert.ok(stabilityScore({ ...base, positiveMonths: 1 }).score < s0);
  assert.ok(stabilityScore(base).score <= 100);
});

test('搜尋結果：冠軍與樣本外驗證資訊完整', async () => {
  const { sig } = makeMarket({ days: 240, windowDays: 200 });
  const r = await runSearch(sig, { ...CFG, budget: 120, minTrades: 3 }, COSTS);
  assert.ok(r.candidates.length <= 120 && r.candidates.length > 20);
  const id = r.champions.netReturn;
  assert.ok(id, '應該要有最高淨報酬冠軍');
  const d = r.details[id];
  assert.ok(d.train.metrics && d.holdout.metrics && d.full.metrics);
  assert.ok(d.train.equity.length > 0 && d.holdout.equity.length > 0);
  for (const e of r.candidates) assert.equal(e.train.liquidations >= 0, true);
  void SEARCH_DEFAULTS;
});

test('【無免費午餐】純隨機漫步（無趨勢）上，候選平均報酬 ≤ 0（扣掉成本後），勝率約 50%', async () => {
  let sum = 0; let n = 0; let wr = 0; let best = -1;
  for (const seed of [1, 2, 3]) {
    const { sig } = makeMarket({ symbols: 4, days: 200, windowDays: 180, seed, regimeScale: 0 });
    const r = await runSearch(sig, { tfs: ['1h', '4h'], budget: 120, minTrades: 10, levList: [1], slList: [2], tpList: [2] }, COSTS);
    for (const c of r.candidates) { sum += c.train.netReturn; wr += c.train.winRate; n++; best = Math.max(best, c.train.netReturn); }
  }
  assert.ok(n > 100);
  assert.ok(sum / n < 0, `平均報酬應為負（成本拖累），實際 ${(sum / n).toFixed(4)}`);
  assert.ok(Math.abs(wr / n - 0.5) < 0.06, `勝率應接近 50%，實際 ${(wr / n).toFixed(3)}`);
  assert.ok(best < 0.25, `隨機行情不應出現離譜的高報酬：${best}`);
});
