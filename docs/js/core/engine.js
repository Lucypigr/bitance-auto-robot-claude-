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

export const DEFAULT_COSTS = {
  fee: 0.0005, // 單邊手續費（Binance 永續 Taker 約 0.05%；現貨 0.1%）
  slippage: 0.0005, // 單邊滑價
  mmr: 0.005, // 維持保證金率
};

/** 單一標的的模擬環境（每次回測建立一次） */
function makeCtx(ds, S, cfg) {
  const rateIn = cfg.feeIn ?? cfg.fee;
  return {
    ds, S, cfg,
    T: (i) => (ds.times ? ds.times[i] : ds.t0 + i * ds.baseMs),
    d: cfg.dir, L: cfg.lev, rateIn, rateOut: cfg.feeOut ?? cfg.fee,
    minFee: cfg.minFee || 0, lot: cfg.lot || 0, slip: cfg.slippage, mmr: cfg.mmr,
    posPct: Math.min(1, Math.max(0.0001, cfg.posPct ?? 1)),
    exitSig: cfg.exitSig || null, maxBars: cfg.maxBars || 0,
    fund: cfg.perp && S.funding && S.funding.t.length ? S.funding : null,
  };
}

/**
 * 模擬「從第 k 根開盤進場」的一筆交易，直到出場。
 * @param {number} Wb 這筆交易可動用的資金（資金袋或共用資金池的一個部位額度）
 * @param {number} acct 帳戶總淨值（風險比例定位用）
 * @param {number} hi 可用的最後一根 K 線 + 1
 * @param {(j:number, mtm:number)=>void} onBar 仍持倉時，每根收盤的未實現損益（已含進場手續費與資金費率）
 * @returns {null | {trade:object, exitIdx:number, net:number, liq:boolean}} null＝買不起／漲停鎖死，沒有成交
 */
function runTrade(ctx, k, s, Wb, acct, hi, onBar) {
  const { ds, S, cfg, T, d, L, rateIn, rateOut, minFee, lot, slip, mmr, posPct, exitSig, maxBars, fund } = ctx;
  const { o, h, l, c, mh, ml } = S;
  const baseMs = ds.baseMs;
  const t0 = ds.t0;

  // 台股：開盤即漲停且鎖死（一價到底）→ 實際上買不到
  if (cfg.limitLock && k > 0 && o[k] === h[k] && h[k] === l[k] && o[k] >= c[k - 1] * 1.095) return null;

  const entry = o[k] * (1 + d * slip); // 不利方向滑價（做多買得更貴、做空賣得更便宜）
  // 每筆投入的保證金：固定金額（最多不超過可動用資金）或資金比例；風險比例定位則再以「停損時虧損 = 帳戶淨值 × 風險%」為上限
  let base = cfg.posUsdt > 0 ? Math.min(cfg.posUsdt, Wb) : Wb * posPct;
  if (cfg.riskPct > 0 && cfg.sl > 0) base = Math.min(base, (acct * cfg.riskPct) / (cfg.sl * L));
  // 股數：永續／現貨可小數；台股以整股計。最低手續費不夠買時，扣掉後重算
  const sizeQ = (b) => {
    const raw = (b * L) / (1 + L * rateIn) / entry;
    return lot > 0 ? Math.floor(raw / lot) * lot : raw;
  };
  let q = sizeQ(base);
  if (q * entry / L + Math.max(minFee, q * entry * rateIn) > base + 1e-9) q = sizeQ(base - minFee);
  if (!(q > 0)) return null; // 買不起一股
  const notional = q * entry;
  const M = notional / L;
  const feeIn = Math.max(minFee, notional * rateIn);
  // 停損／停利可用價格 % 或 USDT 損益金額（金額 ÷ 名目價值 = 價格變動幅度，不含手續費）
  const slF = cfg.slUsdt > 0 ? cfg.slUsdt / notional : cfg.sl;
  const tpF = cfg.tpUsdt > 0 ? cfg.tpUsdt / notional : cfg.tp;
  const slP = slF > 0 ? entry * (1 - d * slF) : NaN;
  const tpP = tpF > 0 ? entry * (1 + d * tpF) : NaN;
  const trail = cfg.trail > 0;
  const liqPrice = (en, qq, margin) =>
    d > 0 ? (qq * en - margin) / (qq * (1 - mmr)) : (qq * en + margin) / (qq * (1 + mmr));
  let ref = entry;
  let funding = 0;
  let mae = 0;
  let mfe = 0;
  let pLiq = liqPrice(entry, q, M);
  const liqDist = d > 0 ? 1 - pLiq / entry : pLiq / entry - 1;
  let fi = fund ? lowerBound(fund.t, t0 + k * baseMs) : 0;

  let exitIdx = -1;
  let exitPrice = NaN;
  let reason = '';

  for (let j = k; j < hi; j++) {
    const tj = t0 + j * baseMs;
    if (j > k) {
      // 上一根收盤後決定的「開盤出場」：反向訊號 / 持倉時間到
      const gapLiq = pLiq > 0 && (d > 0 ? o[j] <= pLiq : o[j] >= pLiq);
      if (gapLiq) {
        reason = 'liq'; exitIdx = j; exitPrice = pLiq; break;
      }
      let r = '';
      if (exitSig && exitSig[j - 1]) r = 'signal';
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
          funding += -d * q * mk * fund.rate[fi];
        }
        fi++;
      }
      pLiq = liqPrice(entry, q, M + funding);
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
    let preStop = slP; // 這根 K 線開盤前就已經確定的停損價（用來判斷開盤跳空）
    if (trail) {
      const tsPre = ref * (1 - d * cfg.trail);
      if (Number.isNaN(preStop) || (d > 0 ? tsPre > preStop : tsPre < preStop)) preStop = tsPre;
      if (d > 0) { if (hj > ref) ref = hj; } else if (lj < ref) ref = lj;
      const ts = ref * (1 - d * cfg.trail);
      if (Number.isNaN(stop) || (d > 0 ? ts > stop : ts < stop)) { stop = ts; stopIsTrail = true; }
    }
    const worst = d > 0 ? (ml && !Number.isNaN(ml[j]) ? ml[j] : lj) : (mh && !Number.isNaN(mh[j]) ? mh[j] : hj);
    const liqHit = d > 0 ? pLiq > 0 && worst <= pLiq : worst >= pLiq;
    const stopHit = !Number.isNaN(stop) && (d > 0 ? lj <= stop : hj >= stop);
    const tpHit = !Number.isNaN(tpP) && (d > 0 ? hj >= tpP : lj <= tpP);
    const tpGap = tpHit && j > k && (d > 0 ? o[j] >= tpP : o[j] <= tpP);

    if (tpGap || (tpHit && !liqHit && !stopHit)) {
      reason = 'tp'; exitIdx = j; exitPrice = tpP; break;
    }
    if (liqHit || stopHit) {
      const liqFirst = liqHit && (!stopHit || (d > 0 ? stop < pLiq : stop > pLiq));
      if (liqFirst) {
        reason = 'liq'; exitIdx = j; exitPrice = pLiq; break;
      }
      const gapStop = j > k && !Number.isNaN(preStop) && (d > 0 ? o[j] <= preStop : o[j] >= preStop);
      const px = (gapStop ? o[j] : stop) * (1 - d * slip);
      reason = stopIsTrail && (Number.isNaN(slP) || (d > 0 ? stop > slP : stop < slP)) ? 'trail' : 'sl';
      exitIdx = j; exitPrice = px; break;
    }
    if (j === hi - 1) {
      const px = c[j] * (1 - d * slip);
      reason = 'end'; exitIdx = j; exitPrice = px; break;
    }
    // 仍持倉：回報收盤時的未實現損益
    onBar(j, -feeIn + funding + d * q * (c[j] - entry));
  }

  // 結算
  let net;
  let feeOut = 0;
  let gross;
  const liq = reason === 'liq';
  if (liq) {
    gross = -M;
    net = -M - feeIn; // 逐倉：最多賠掉這筆保證金
  } else {
    gross = d * q * (exitPrice - entry);
    feeOut = Math.max(minFee, q * exitPrice * rateIn) + q * exitPrice * (rateOut - rateIn);
    net = gross - feeIn - feeOut + funding;
  }
  const trade = {
    dir: d, entryIdx: k, exitIdx, signalIdx: s,
    entryTime: T(k), exitTime: T(exitIdx),
    entryPrice: entry, exitPrice, qty: q, notional, margin: M, lev: L,
    fee: feeIn + feeOut, funding, gross, pnl: net, ret: net / Wb, equityBefore: Wb,
    reason, mae, mfe, liqDist, bars: exitIdx - k + 1,
  };
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
