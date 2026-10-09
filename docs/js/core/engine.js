// 回測引擎（單一幣種的「資金袋」）。
//
// 重要規則（避免偷看未來）：
//  1. 訊號在「第 s 根 K 線收盤後」才成立，最早只能在第 s+1 根的「開盤價」成交。
//  2. 進場、市價出場（停損／反向訊號／強制平倉）都套用「不利方向」滑價與手續費；停利視為限價單，不加滑價。
//  3. 同一根 K 線內若同時碰到停損與停利，一律假設「先停損」（保守）。
//  4. 開盤跳空越過停損價 → 以開盤價（更差）成交；跳空越過停利價 → 以停利價成交（保守）。
//  5. 移動停損使用「含當根最高價」更新後再檢查最低價（保守）。
//  6. 永續合約採「逐倉」：最大虧損 = 該筆保證金；清算以標記價格（無則以成交價）判斷。
//  7. 資金費率：持倉經過的每根 K 線，該根內所有結算時間點都會計入。
import { lowerBound } from './util.js';
import * as I from './indicators.js';

export const DEFAULT_COSTS = {
  fee: 0.0005, // 單邊手續費（Binance 永續 Taker 約 0.05%；現貨 0.1%）
  slippage: 0.0005, // 單邊滑價
  mmr: 0.005, // 維持保證金率
};

/** ATR（佔收盤價的比例）：每檔標的、每個週期只算一次。第 i 根的值只用到第 i 根（含）以前的資料。 */
function atrOf(S, n) {
  if (!S._atr) S._atr = new Map();
  let r = S._atr.get(n);
  if (!r) {
    const a = I.atrPercent(S.h.subarray(S.first, S.last + 1), S.l.subarray(S.first, S.last + 1), S.c.subarray(S.first, S.last + 1), n);
    r = { a, off: S.first };
    S._atr.set(n, r);
  }
  return r;
}

/** 單一標的的模擬環境（每次回測建立一次） */
function makeCtx(ds, S, cfg) {
  const rateIn = cfg.feeIn ?? cfg.fee;
  const needAtr = !!cfg.unitAtr;
  return {
    ds, S, cfg,
    T: (i) => (ds.times ? ds.times[i] : ds.t0 + i * ds.baseMs),
    d: cfg.dir, L: cfg.lev, rateIn, rateOut: cfg.feeOut ?? cfg.fee,
    minFee: cfg.minFee || 0, lot: cfg.lot || 0, slip: cfg.slippage, mmr: cfg.mmr,
    posPct: Math.min(1, Math.max(0.0001, cfg.posPct ?? 1)),
    exitSig: cfg.exitSig || null, revSig: cfg.revSig || null, maxBars: cfg.maxBars || 0,
    fund: cfg.perp && S.funding && S.funding.t.length ? S.funding : null,
    atr: needAtr ? atrOf(S, cfg.atrPeriod || 14) : null,
  };
}

/**
 * 模擬「從第 k 根開盤進場」的一筆交易（一個部位，可能含加碼與分批出場），直到全部出場。
 * @param {number} Wb 這筆交易可動用的資金（資金袋或共用資金池的一個部位額度）
 * @param {number} acct 帳戶總淨值（風險比例定位用）
 * @param {number} hi 可用的最後一根 K 線 + 1
 * @param {(j:number, mtm:number)=>void} onBar 仍持倉時，每根收盤的未實現損益（已含手續費與資金費率）
 * @returns {null | {trade:object, exitIdx:number, net:number, liq:boolean}} null＝買不起／漲停鎖死／ATR 尚未暖機，沒有成交
 */
function runTrade(ctx, k, s, Wb, acct, hi, onBar) {
  const { ds, S, cfg, T, d, L, rateIn, rateOut, minFee, lot, slip, mmr, posPct, exitSig, revSig, maxBars, fund } = ctx;
  const { o, h, l, c, mh, ml } = S;
  const baseMs = ds.baseMs;
  const t0 = ds.t0;

  // 台股：開盤即漲停且鎖死（一價到底）→ 實際上買不到
  if (cfg.limitLock && k > 0 && o[k] === h[k] && h[k] === l[k] && o[k] >= c[k - 1] * 1.095) return null;

  // ATR 單位：用「訊號那根（已收盤）」的 ATR 換算距離，沒有偷看進場之後的資料
  const atrFrac = ctx.atr ? ctx.atr.a[s - ctx.atr.off] / 100 : NaN;
  if (ctx.atr && !(atrFrac > 0)) return null;
  const dist = (x) => (cfg.unitAtr ? x * atrFrac : x);

  const entry = o[k] * (1 + d * slip); // 不利方向滑價（做多買得更貴、做空賣得更便宜）
  // 每筆投入的保證金：固定金額（最多不超過可動用資金）或資金比例；風險比例定位則再以「停損時虧損 = 帳戶淨值 × 風險%」為上限
  const slF0 = cfg.sl > 0 ? dist(cfg.sl) : 0;
  let base = cfg.posUsdt > 0 ? Math.min(cfg.posUsdt, Wb) : Wb * posPct;
  if (cfg.riskPct > 0 && slF0 > 0) base = Math.min(base, (acct * cfg.riskPct) / (slF0 * L));
  // 股數：永續／現貨可小數；台股以整股計。最低手續費不夠買時，扣掉後重算
  const sizeQ = (b, px) => {
    const raw = (b * L) / (1 + L * rateIn) / px;
    return lot > 0 ? Math.floor(raw / lot) * lot : raw;
  };
  let q = sizeQ(base, entry);
  if (q * entry / L + Math.max(minFee, q * entry * rateIn) > base + 1e-9) q = sizeQ(base - minFee, entry);
  if (!(q > 0)) return null; // 買不起一股
  const q0 = q;
  const notional = q * entry;
  let M = notional / L;
  const feeIn = Math.max(minFee, notional * rateIn);
  // 停損／停利可用價格 %、ATR 倍數或 USDT 損益金額（金額 ÷ 名目價值 = 價格變動幅度，不含手續費）
  const slF = cfg.slUsdt > 0 ? cfg.slUsdt / notional : slF0;
  const tpF = cfg.tpUsdt > 0 ? cfg.tpUsdt / notional : cfg.tp > 0 ? dist(cfg.tp) : 0;
  const slP = slF > 0 ? entry * (1 - d * slF) : NaN;
  const tpP = tpF > 0 ? entry * (1 + d * tpF) : NaN;
  const so = cfg.so && cfg.so.frac > 0 && cfg.so.at > 0 ? cfg.so : null; // 分批出場
  const tp1P = so ? entry * (1 + d * dist(so.at)) : NaN;
  const si = cfg.si && cfg.si.count > 0 && cfg.si.step > 0 ? cfg.si : null; // 加碼／分批進場
  const trail = cfg.trail > 0;
  const liqPrice = (en, qq, margin) =>
    d > 0 ? (qq * en - margin) / (qq * (1 - mmr)) : (qq * en + margin) / (qq * (1 + mmr));

  let avg = entry; // 平均持倉成本
  let ref = entry;
  let fundTotal = 0; // 整筆交易的資金費率現金流
  let fundOpen = 0; // 仍持有的那部分所累積的資金費率（算清算價用）
  let mae = 0;
  let mfe = 0;
  let feeEntries = feeIn; // 進場與加碼的手續費
  let feeExitDone = 0; // 分批出場已付的手續費
  let grossDone = 0; // 分批出場已實現的毛利
  let soDone = false;
  let be = false;
  let beNext = false;
  let adds = 0;
  const legs = [];
  let pLiq = liqPrice(avg, q, M);
  const liqDist = d > 0 ? 1 - pLiq / entry : pLiq / entry - 1;
  let fi = fund ? lowerBound(fund.t, t0 + k * baseMs) : 0;

  const exitFee = (qq, px) => Math.max(minFee, qq * px * rateIn) + qq * px * (rateOut - rateIn);
  const doPartial = (px, j) => {
    let pq = q * so.frac;
    if (lot > 0) pq = Math.floor(pq / lot) * lot;
    soDone = true;
    if (!(pq > 0) || pq >= q) return;
    const gross = d * pq * (px - avg);
    const fee = exitFee(pq, px);
    grossDone += gross; feeExitDone += fee;
    const share = pq / q;
    M *= 1 - share; fundOpen *= 1 - share; q -= pq;
    legs.push({ kind: 'partial', idx: j, price: px, qty: pq, pnl: gross - fee });
    pLiq = liqPrice(avg, q, M + fundOpen);
    if (so.be) beNext = true;
  };
  const doAdd = (px, j) => {
    adds++;
    const addBase = base * si.size;
    const aq = sizeQ(addBase, px);
    if (!(aq > 0)) return;
    const addM = (aq * px) / L;
    const fee = Math.max(minFee, aq * px * rateIn);
    if (M + addM + feeEntries + fee > Wb + 1e-9) return; // 資金不夠加碼 → 略過這一次
    avg = (q * avg + aq * px) / (q + aq);
    q += aq; M += addM; feeEntries += fee;
    legs.push({ kind: 'add', idx: j, price: px, qty: aq });
    pLiq = liqPrice(avg, q, M + fundOpen);
  };
  const addLevel = () => entry * (1 + d * (si.mode === 'favor' ? 1 : -1) * dist(si.step) * (adds + 1));

  let exitIdx = -1;
  let exitPrice = NaN;
  let reason = '';

  for (let j = k; j < hi; j++) {
    const tj = t0 + j * baseMs;
    if (beNext) { be = true; beNext = false; }
    if (j > k) {
      // 上一根收盤後決定的「開盤出場」：反手訊號 / 出場條件 / 持倉時間到
      const gapLiq = pLiq > 0 && (d > 0 ? o[j] <= pLiq : o[j] >= pLiq);
      if (gapLiq) {
        reason = 'liq'; exitIdx = j; exitPrice = pLiq; break;
      }
      let r = '';
      if (revSig && revSig[j - 1]) r = 'reverse';
      else if (exitSig && exitSig[j - 1]) r = 'signal';
      else if (maxBars > 0 && j - k >= maxBars) r = 'time';
      if (r) {
        const px = o[j] * (1 - d * slip);
        reason = r; exitIdx = j; exitPrice = px; break;
      }
    }

    // 資金費率：持倉經過這根 K 線，計入此根內所有結算
    if (fund) {
      const tEnd = tj + baseMs;
      while (fi < fund.t.length && fund.t[fi] < tEnd) {
        if (fund.t[fi] >= tj) {
          const mk = fund.mark && fund.mark[fi] > 0 ? fund.mark[fi] : o[j];
          const f = -d * q * mk * fund.rate[fi];
          fundTotal += f; fundOpen += f;
        }
        fi++;
      }
      pLiq = liqPrice(avg, q, M + fundOpen);
    }

    const hj = h[j];
    const lj = l[j];
    if (d > 0) {
      mae = Math.max(mae, (entry - lj) / entry);
      mfe = Math.max(mfe, (hj - entry) / entry);
    } else {
      mae = Math.max(mae, (hj - entry) / entry);
      mfe = Math.max(mfe, (entry - lj) / entry);
    }

    let stop = slP;
    let stopIsTrail = false;
    let stopIsBe = false;
    let preStop = slP; // 這根 K 線開盤前就已經確定的停損價（用來判斷開盤跳空）
    if (be) { // 分批出場後把停損移到成本價（從下一根起生效）
      if (Number.isNaN(stop) || (d > 0 ? avg > stop : avg < stop)) { stop = avg; preStop = avg; stopIsBe = true; }
    }
    if (trail) {
      const tsPre = ref * (1 - d * cfg.trail);
      if (Number.isNaN(preStop) || (d > 0 ? tsPre > preStop : tsPre < preStop)) preStop = tsPre;
      if (d > 0) { if (hj > ref) ref = hj; } else if (lj < ref) ref = lj;
      const ts = ref * (1 - d * cfg.trail);
      if (Number.isNaN(stop) || (d > 0 ? ts > stop : ts < stop)) { stop = ts; stopIsTrail = true; stopIsBe = false; }
    }

    // 逢低分批進場（限價單）：價格先走到加碼價、之後才碰到停損，才會成交（停損比加碼價更近就不加）
    if (si && si.mode === 'adverse') {
      const gapStop = j > k && !Number.isNaN(preStop) && (d > 0 ? o[j] <= preStop : o[j] >= preStop);
      while (adds < si.count && !gapStop) {
        const lv = addLevel();
        if (!(d > 0 ? lj <= lv : hj >= lv)) break;
        if (!Number.isNaN(stop) && !(d > 0 ? lv > stop : lv < stop)) break;
        doAdd(lv, j);
      }
    }

    const worst = d > 0 ? (ml && !Number.isNaN(ml[j]) ? ml[j] : lj) : (mh && !Number.isNaN(mh[j]) ? mh[j] : hj);
    const liqHit = d > 0 ? pLiq > 0 && worst <= pLiq : worst >= pLiq;
    const stopHit = !Number.isNaN(stop) && (d > 0 ? lj <= stop : hj >= stop);
    const tpHit = !Number.isNaN(tpP) && (d > 0 ? hj >= tpP : lj <= tpP);
    const tpGap = tpHit && j > k && (d > 0 ? o[j] >= tpP : o[j] <= tpP);
    const tp1Hit = so && !soDone && (d > 0 ? hj >= tp1P : lj <= tp1P);

    if (tpGap || (tpHit && !liqHit && !stopHit)) {
      if (tp1Hit) doPartial(tp1P, j); // 價格一定先經過第一目標
      reason = 'tp'; exitIdx = j; exitPrice = tpP; break;
    }
    if (liqHit || stopHit) {
      const liqFirst = liqHit && (!stopHit || (d > 0 ? stop < pLiq : stop > pLiq));
      if (liqFirst) {
        reason = 'liq'; exitIdx = j; exitPrice = pLiq; break;
      }
      const gapStop = j > k && !Number.isNaN(preStop) && (d > 0 ? o[j] <= preStop : o[j] >= preStop);
      const px = (gapStop ? o[j] : stop) * (1 - d * slip);
      reason = stopIsTrail && (Number.isNaN(slP) || (d > 0 ? stop > slP : stop < slP)) ? 'trail' : stopIsBe ? 'be' : 'sl';
      exitIdx = j; exitPrice = px; break;
    }
    if (tp1Hit) doPartial(tp1P, j); // 分批出場（限價單，不加滑價）
    // 順勢加碼（停損單）：同一根 K 線內若已先碰到停損／停利就不加碼（先後順序無法判斷，保守處理）
    if (si && si.mode === 'favor') {
      while (adds < si.count) {
        const lv = addLevel();
        if (!(d > 0 ? hj >= lv : lj <= lv)) break;
        const fill = (d > 0 ? Math.max(lv, o[j]) : Math.min(lv, o[j])) * (1 + d * slip);
        doAdd(fill, j);
      }
    }
    if (j === hi - 1) {
      const px = c[j] * (1 - d * slip);
      reason = 'end'; exitIdx = j; exitPrice = px; break;
    }
    // 仍持倉：回報收盤時的未實現損益
    onBar(j, grossDone - feeExitDone - feeEntries + fundTotal + d * q * (c[j] - avg));
  }

  // 結算（剩下的部位）
  let net;
  let feeOut = 0;
  let gross;
  const liq = reason === 'liq';
  if (liq) {
    gross = grossDone - M;
    net = gross - feeExitDone - feeEntries; // 逐倉：剩下的部位最多賠掉它的保證金
  } else {
    gross = grossDone + d * q * (exitPrice - avg);
    feeOut = exitFee(q, exitPrice);
    net = gross - feeEntries - feeExitDone - feeOut + fundTotal;
  }
  const trade = {
    dir: d, entryIdx: k, exitIdx, signalIdx: s,
    entryTime: T(k), exitTime: T(exitIdx),
    entryPrice: entry, exitPrice, qty: q0, notional, margin: notional / L, lev: L,
    fee: feeEntries + feeExitDone + feeOut, funding: fundTotal, gross, pnl: net, ret: net / Wb, equityBefore: Wb,
    reason, mae, mfe, liqDist, bars: exitIdx - k + 1,
  };
  if (legs.length) { trade.legs = legs; trade.avgEntry = avg; }
  return { trade, exitIdx, net, liq };
}

/**
 * 「各標的獨立資金袋」模式：一檔標的用自己的資金滾動交易。
 * @param {object} ds 資料集
 * @param {object} S 該標的資料
 * @param {Int32Array} entries 進場訊號索引（第 s 根收盤後成立，遞增）
 * @param {object} cfg {dir, lev, sl, tp, slUsdt, tpUsdt, posUsdt, riskPct, trail, maxBars, posPct, fee, slippage, mmr, perp, exitSig}
 * @param {{from:number,to:number}} range 回測區間 [from, to)
 * @param {number} capital 該標的分到的資金
 * @param {Float64Array|null} eq 每根 K 線收盤時的淨值（長度 to-from）
 */
export function simulateSymbol(ds, S, entries, cfg, range, capital, eq) {
  const ctx = makeCtx(ds, S, cfg);
  const lo = Math.max(range.from, S.first);
  const hi = Math.min(range.to, S.last + 1);
  const trades = [];
  let W = capital;
  let liquidations = 0;
  let cursor = range.from;
  const fillTo = (upTo, val) => {
    if (eq && upTo > cursor) eq.fill(val, cursor - range.from, upTo - range.from);
    if (upTo > cursor) cursor = upTo;
  };
  let ei = lowerBound(entries, lo);

  while (ei < entries.length) {
    const s = entries[ei];
    const k = s + 1; // 進場 K 線（開盤價成交）
    if (k >= hi) break;
    fillTo(k, W);
    const Wb = W;
    const r = runTrade(ctx, k, s, Wb, Wb, hi, (j, m) => {
      if (eq) eq[j - range.from] = Wb + m;
      cursor = j + 1;
    });
    if (!r) { ei++; continue; }
    if (r.liq) liquidations++;
    W = Wb + r.net;
    if (eq) eq[r.exitIdx - range.from] = W;
    cursor = r.exitIdx + 1;
    trades.push(r.trade);
    // 下一筆進場訊號必須在出場那根 K 線（含）之後才成立
    ei = lowerBound(entries, r.exitIdx, ei);
  }
  fillTo(range.to, W);
  return { trades, finalEquity: W, liquidations };
}

/**
 * 雙向策略（可選「反手」）：一檔標的只會同時持有一個部位。
 *  - 空手時，A（做多）或 B（做空）任一邊的進場訊號都可以開倉；同一根 K 線兩邊同時出現訊號 → 衝突，都不做。
 *  - 持倉時，對面的進場訊號：開啟反手 → 下一根開盤平倉並「同一個開盤價」反向開倉；沒開反手 → 忽略，等這筆出場後才看新訊號。
 * @param {{entries:Int32Array,cfg:object}} A 做多那一邊
 * @param {{entries:Int32Array,cfg:object}} B 做空那一邊
 */
export function simulateDual(ds, S, A, B, range, capital, eq) {
  const ctxs = [makeCtx(ds, S, A.cfg), makeCtx(ds, S, B.cfg)];
  const sigs = [A.entries, B.entries];
  const lo = Math.max(range.from, S.first);
  const hi = Math.min(range.to, S.last + 1);
  const trades = [];
  let W = capital;
  let liquidations = 0;
  let cursor = range.from;
  const fillTo = (upTo, val) => {
    if (eq && upTo > cursor) eq.fill(val, cursor - range.from, upTo - range.from);
    if (upTo > cursor) cursor = upTo;
  };
  const ptr = [lowerBound(sigs[0], lo), lowerBound(sigs[1], lo)];
  let minS = lo;
  let forced = null;
  for (;;) {
    let side;
    let s;
    let k;
    const isForced = !!forced;
    if (forced) {
      side = forced.side; k = forced.k; s = k - 1; forced = null;
    } else {
      for (let i = 0; i < 2; i++) ptr[i] = lowerBound(sigs[i], minS, ptr[i]);
      const sa = ptr[0] < sigs[0].length ? sigs[0][ptr[0]] : Infinity;
      const sb = ptr[1] < sigs[1].length ? sigs[1][ptr[1]] : Infinity;
      if (sa === Infinity && sb === Infinity) break;
      if (sa === sb) { ptr[0]++; ptr[1]++; continue; }
      side = sa < sb ? 0 : 1;
      s = Math.min(sa, sb);
      k = s + 1;
    }
    if (k >= hi) break;
    fillTo(k, W);
    const Wb = W;
    const r = runTrade(ctxs[side], k, s, Wb, Wb, hi, (j, m) => {
      if (eq) eq[j - range.from] = Wb + m;
      cursor = j + 1;
    });
    if (!r) { // 買不起／漲停鎖死：略過這個訊號（反手那一筆開不了就維持空手）
      if (isForced) minS = Math.max(minS, k); else ptr[side]++;
      continue;
    }
    if (r.liq) liquidations++;
    W = Wb + r.net;
    if (eq) eq[r.exitIdx - range.from] = W;
    cursor = r.exitIdx + 1;
    trades.push(r.trade);
    minS = r.exitIdx;
    if (r.trade.reason === 'reverse') forced = { side: 1 - side, k: r.exitIdx };
  }
  fillTo(range.to, W);
  return { trades, finalEquity: W, liquidations };
}

/**
 * 「共用資金池」模式：所有標的共用同一筆資金，同時最多持有 maxPos 個部位。
 *  - 每個部位額度 = 當下已實現淨值 ÷ maxPos（未實現損益不拿來加碼）
 *  - 依「進場時間」由早到晚處理各標的的訊號；同一根 K 線上多個訊號 → 依標的順序（先選的先進）
 *  - 部位已滿時出現的訊號直接略過（不排隊）；在開盤出場（反向訊號／持倉期滿）的部位，當根開盤就釋出名額
 * @param {Array<{S:object, entries:Int32Array, cfg:object}>} inputs
 * @returns {{trades:Array, liquidations:number, equity:Float64Array|null}}
 */
export function simulatePool(ds, inputs, range, capital, { maxPos, record = true } = {}) {
  const n = inputs.length;
  const M = Math.max(1, Math.min(maxPos || n, n));
  const ctxs = inputs.map((x) => makeCtx(ds, x.S, x.cfg));
  const his = inputs.map((x) => Math.min(range.to, x.S.last + 1));
  const ptr = new Int32Array(n);
  const minSig = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const lo = Math.max(range.from, inputs[i].S.first);
    minSig[i] = lo;
    ptr[i] = lowerBound(inputs[i].entries, lo);
  }
  const trades = [];
  let pending = []; // 已接受、尚未計入已實現淨值的交易
  let realized = 0;
  let liquidations = 0;
  const len = range.to - range.from;
  const realStep = record ? new Float64Array(len + 1) : null;
  const openSum = record ? new Float64Array(len + 1) : null;

  for (;;) {
    let best = -1;
    let bestK = Infinity;
    for (let i = 0; i < n; i++) {
      const e = inputs[i].entries;
      if (ptr[i] < e.length && e[ptr[i]] < minSig[i]) ptr[i] = lowerBound(e, minSig[i], ptr[i]);
      if (ptr[i] >= e.length) continue;
      const k = e[ptr[i]] + 1;
      if (k >= his[i]) continue;
      if (k < bestK) { best = i; bestK = k; }
    }
    if (best < 0) break;
    const i = best;
    const k = bestK;
    const s = inputs[i].entries[ptr[i]];

    // 計入已經出場的交易；數一數還佔著名額的部位
    const still = [];
    for (const t of pending) {
      if (t.exitIdx < k || (t.exitIdx === k && t.atOpen)) realized += t.pnl; else still.push(t);
    }
    pending = still;
    if (pending.length >= M) { ptr[i]++; continue; } // 名額已滿 → 略過這個訊號

    const acct = capital + realized;
    const slot = acct / M;
    const deltas = [];
    const r = runTrade(ctxs[i], k, s, slot, acct, his[i], (j, m) => { deltas.push(m); });
    if (!r) { ptr[i]++; continue; }
    const t = r.trade;
    t.si = i;
    t.atOpen = t.reason === 'signal' || t.reason === 'time';
    if (r.liq) liquidations++;
    trades.push(t);
    pending.push(t);
    minSig[i] = r.exitIdx;
    if (record) {
      for (let d = 0; d < deltas.length; d++) {
        const idx = k + d - range.from;
        if (idx >= 0 && idx < len) openSum[idx] += deltas[d];
      }
      const ei = r.exitIdx - range.from;
      if (ei >= 0 && ei < len) realStep[ei] += r.net;
    }
  }
  let equity = null;
  if (record) {
    equity = new Float64Array(len);
    let cum = 0;
    for (let b = 0; b < len; b++) { cum += realStep[b]; equity[b] = capital + cum + openSum[b]; }
  }
  return { trades, liquidations, equity };
}
