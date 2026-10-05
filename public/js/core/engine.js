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

/**
 * @param {object} ds 資料集
 * @param {object} S 該幣種資料
 * @param {Int32Array} entries 進場訊號索引（第 s 根收盤後成立，遞增）
 * @param {object} cfg {dir, lev, sl, tp, slUsdt, tpUsdt, posUsdt, trail, maxBars, posPct, fee, slippage, mmr, perp, exitSig}
 * @param {{from:number,to:number}} range 回測區間 [from, to)
 * @param {number} capital 該幣種分到的資金
 * @param {Float64Array|null} eq 每根 K 線收盤時的淨值（長度 to-from）
 */
export function simulateSymbol(ds, S, entries, cfg, range, capital, eq) {
  const { o, h, l, c, mh, ml } = S;
  const baseMs = ds.baseMs;
  const t0 = ds.t0;
  const d = cfg.dir;
  const L = cfg.lev;
  const fee = cfg.fee;
  const slip = cfg.slippage;
  const mmr = cfg.mmr;
  const posPct = Math.min(1, Math.max(0.0001, cfg.posPct ?? 1));
  const exitSig = cfg.exitSig || null;
  const maxBars = cfg.maxBars || 0;
  const fund = cfg.perp && S.funding && S.funding.t.length ? S.funding : null;

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
  let fi = 0;
  const liqPrice = (entry, q, margin) =>
    d > 0 ? (q * entry - margin) / (q * (1 - mmr)) : (q * entry + margin) / (q * (1 + mmr));

  while (ei < entries.length) {
    const s = entries[ei];
    const k = s + 1; // 進場 K 線（開盤價成交）
    if (k >= hi) break;

    fillTo(k, W);

    const entry = o[k] * (1 + d * slip); // 不利方向滑價（做多買得更貴、做空賣得更便宜）
    const Wb = W;
    // 每筆投入的保證金：固定 USDT 金額（最多不超過資金袋）或資金比例
    const base = cfg.posUsdt > 0 ? Math.min(cfg.posUsdt, Wb) : Wb * posPct;
    const M = base / (1 + L * fee);
    const notional = M * L;
    const q = notional / entry;
    const feeIn = notional * fee;
    // 停損／停利可用價格 % 或 USDT 損益金額（金額 ÷ 名目價值 = 價格變動幅度，不含手續費）
    const slF = cfg.slUsdt > 0 ? cfg.slUsdt / notional : cfg.sl;
    const tpF = cfg.tpUsdt > 0 ? cfg.tpUsdt / notional : cfg.tp;
    const slP = slF > 0 ? entry * (1 - d * slF) : NaN;
    const tpP = tpF > 0 ? entry * (1 + d * tpF) : NaN;
    const trail = cfg.trail > 0;
    let ref = entry;
    let funding = 0;
    let mae = 0;
    let mfe = 0;
    let pLiq = liqPrice(entry, q, M);
    const liqDist = d > 0 ? 1 - pLiq / entry : pLiq / entry - 1;
    if (fund) fi = lowerBound(fund.t, t0 + k * baseMs, fi);

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
      // 仍持倉：記錄收盤淨值（含未實現損益）
      if (eq) eq[j - range.from] = Wb - feeIn + funding + d * q * (c[j] - entry);
      cursor = j + 1;
    }

    // 結算
    let net;
    let feeOut = 0;
    let gross;
    if (reason === 'liq') {
      liquidations++;
      gross = -M;
      net = -M - feeIn; // 逐倉：最多賠掉這筆保證金
    } else {
      gross = d * q * (exitPrice - entry);
      feeOut = q * exitPrice * fee;
      net = gross - feeIn - feeOut + funding;
    }
    W = Wb + net;
    if (eq) eq[exitIdx - range.from] = W;
    cursor = exitIdx + 1;

    trades.push({
      dir: d, entryIdx: k, exitIdx, signalIdx: s,
      entryTime: t0 + k * baseMs, exitTime: t0 + exitIdx * baseMs,
      entryPrice: entry, exitPrice, qty: q, notional, margin: M, lev: L,
      fee: feeIn + feeOut, funding, gross, pnl: net, ret: net / Wb, equityBefore: Wb,
      reason, mae, mfe, liqDist, bars: exitIdx - k + 1,
    });

    // 下一筆進場訊號必須在出場那根 K 線（含）之後才成立
    ei = lowerBound(entries, exitIdx, ei);
  }
  fillTo(range.to, W);
  return { trades, finalEquity: W, liquidations };
}
