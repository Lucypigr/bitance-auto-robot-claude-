// 「交易數太少？」設定檢查：把訊號一層一層拆開來看，找出是哪一關把交易擋掉了。
import { lowerBound, TF_MS, tfIndex, spanMs } from './util.js';
import { describeSpec, normalizeSpec, CONDITIONS } from './conditions.js';

const countIn = (idx, range) => Math.max(0, lowerBound(idx, range.to - 1) - lowerBound(idx, range.from));

export function diagnoseStrategy(sig, strategy, ranges, res, { minTrades = 20, costs = null } = {}) {
  const ds = sig.ds;
  const nSym = ds.symbols.length;
  const specs = strategy.entry.map(normalizeSpec);
  const mode = strategy.entryMode || 'edge';
  const sum = (fn) => { let t = 0; for (let si = 0; si < nSym; si++) t += fn(si); return t; };

  const conditions = specs.map((sp) => ({
    text: describeSpec(sp), spec: sp,
    train: sum((si) => countIn(sig.atomIdx(si, sp), ranges.train)),
    holdout: sum((si) => countIn(sig.atomIdx(si, sp), ranges.holdout)),
  }));
  const andTrain = sum((si) => countIn(sig.andIdx(si, specs), ranges.train));
  const andHold = sum((si) => countIn(sig.andIdx(si, specs), ranges.holdout));
  const entryTrain = sum((si) => countIn(sig.entryIdx(si, specs, mode), ranges.train));
  const entryHold = sum((si) => countIn(sig.entryIdx(si, specs, mode), ranges.holdout));
  const levelTrain = mode === 'edge' ? andTrain : entryTrain;
  const tradesTrain = res.train.metrics.trades;
  const tradesHold = res.holdout.metrics.trades;

  const perSymbol = ds.symbols.map((S, si) => {
    const bars = Math.max(0, Math.min(ranges.train.to, S.last + 1) - Math.max(ranges.train.from, S.first));
    return {
      symbol: S.symbol, bars,
      and: countIn(sig.andIdx(si, specs), ranges.train),
      entries: countIn(sig.entryIdx(si, specs, mode), ranges.train),
      trades: res.train.trades.filter((t) => t.si === si).length,
      tradesHold: res.holdout.trades.filter((t) => t.si === si).length,
    };
  });

  const tips = [];
  const add = (level, text) => tips.push({ level, text });
  const trainDays = spanMs(ds, ranges.train) / 86400000;
  const low = tradesTrain < minTrades;

  // 1) 條件本身
  const zero = conditions.filter((c) => c.train === 0);
  for (const c of zero) add('bad', `「${c.text}」在訓練期一次都沒有成立，只要有它，整組條件就不可能進場。請放寬門檻、換條件，或確認週期選對。`);
  if (conditions.length > 1 && !zero.length && andTrain === 0) {
    add('bad', `每個條件單獨都有成立，但「從來沒有同時成立過」（${conditions.map((c) => `${c.train} 次`).join('／')}）。這些條件可能互相排斥（例如「剛超賣」與「剛突破」），請換掉其中一個，或把事件型條件的「保留」調大。`);
  } else if (conditions.length > 1 && !zero.length) {
    const bottleneck = conditions.reduce((a, b) => (b.train < a.train ? b : a));
    if (andTrain < Math.min(...conditions.map((c) => c.train)) * 0.5 || andTrain < minTrades) {
      add(low ? 'warn' : 'info', `最稀少的條件是「${bottleneck.text}」（訓練期只成立 ${bottleneck.train} 次）。${conditions.length} 個條件要「同時成立」，次數會比最稀少的條件還少，實際同時成立只有 ${andTrain} 次。可以減少條件數，或把事件型條件（交叉、K 線型態）的「保留根數」調大。`);
    }
  }
  // 2) AND 之後 → 進場訊號 → 實際交易
  if (!zero.length && andTrain > 0 && mode === 'edge' && entryTrain < andTrain * 0.5 && low) {
    add('info', `條件同時成立 ${andTrain} 根，但只在「剛由不成立變成立」時進場，剩 ${entryTrain} 次。若想在條件持續期間也能進場，可把「進場方式」改成「成立期間都可進場」（但交易會彼此高度相關）。`);
  }
  if (entryTrain > 0 && tradesTrain < entryTrain * 0.6 && low) {
    add('info', `進場訊號有 ${entryTrain} 次，實際只成交 ${tradesTrain} 筆：持倉期間出現的訊號會被略過（一個幣種同時只持一個部位）。可以縮短持倉（停損停利更近、設最長持倉根數），或增加幣種。`);
  }
  // 3) 資料量
  if (low) {
    if (trainDays < 60) add('warn', `訓練期只有約 ${trainDays.toFixed(0)} 天（${(ranges.train.to - ranges.train.from).toLocaleString()} 根 K 線）。拉長「回測資料長度」，或把訓練比例調高，是增加交易數最直接的方法。`);
    if (nSym < 3) add('info', `目前只選了 ${nSym} 個幣種。多選幾個幣種（資金會平均分配）可以明顯增加交易數。`);
    if (tfIndex(ds.baseTf) >= 3) add('info', `執行週期是 ${ds.baseTf}，K 線根數本來就少。換成較小的週期（例如 1h 或 15m）通常會有更多訊號。`);
  }
  const thin = perSymbol.filter((p) => p.bars < 50);
  if (thin.length) add('warn', `${thin.map((p) => p.symbol).join('、')} 在訓練期的資料很少（上市較晚或資料缺漏），幾乎沒有交易機會。`);
  // 4) 設定本身是否合理
  const L = strategy.lev || 1;
  const cost = costs ? 2 * (costs.fee + costs.slippage) : 0;
  if (strategy.unit === 'usdt' && strategy.posUsdt > 0) {
    const notional = strategy.posUsdt * L;
    const tpPct = strategy.tp ? (strategy.tp / notional) * 100 : 0;
    const slPct = strategy.sl ? (strategy.sl / notional) * 100 : 0;
    const C = strategy.cur || 'USDT';
    if (tpPct) add(tpPct > 20 || tpPct < 0.2 ? 'warn' : 'info', `以 ${C} 設定：投入 ${strategy.posUsdt}、槓桿 ${L}× → 名目價值 ${notional} ${C}；停利 ${strategy.tp} ${C} 相當於價格要走 ${tpPct.toFixed(2)}%，停損 ${strategy.sl || 0} ${C} 相當於 ${slPct.toFixed(2)}%。${tpPct > 20 ? '停利要價格走很遠才會碰到，多半只會等到區間結束才平倉。' : tpPct < 0.2 ? '停利幅度小於來回交易成本，賺到的都被手續費吃掉。' : ''}`);
  } else {
    if (strategy.tp && cost && strategy.tp / 100 <= cost) add('warn', `停利 ${strategy.tp}% 小於等於來回手續費＋滑價（約 ${(cost * 100).toFixed(2)}%），就算停利成功也是賠錢。`);
    if (!strategy.sl && !strategy.tp && !strategy.trail && !(strategy.exit && strategy.exit.length) && !strategy.maxBars) add('warn', '沒有設定任何停損、停利或出場條件：一旦進場就會持有到資料結束，之後的訊號都會被略過，所以只會有 1 筆交易。');
  }
  for (const sp of specs) {
    const def = CONDITIONS[sp.id];
    if (tfIndex(sp.tf) < tfIndex(ds.baseTf)) add('bad', `條件週期 ${sp.tf} 小於執行週期 ${ds.baseTf}，無法使用。`);
    if (def.kind === 'event' && sp.within === 1 && TF_MS[sp.tf] > ds.baseMs && specs.length > 1) {
      add('info', `「${describeSpec(sp)}」是「事件」型條件，只在發生那一根成立（大週期則在該根收盤後持續到下一根收盤）。和其他條件同時成立的機會不高，可以把「保留」調成 2～5 根。`);
      break;
    }
  }
  const wrongWay = specs.filter((sp) => { const s = CONDITIONS[sp.id].side; return s !== 'neutral' && s !== (strategy.dir === 'long' ? 'bull' : 'bear'); });
  if (wrongWay.length) add('info', `方向是${strategy.dir === 'long' ? '做多' : '做空'}，卻使用了${strategy.dir === 'long' ? '偏空' : '偏多'}條件（${wrongWay.map((s) => CONDITIONS[s.id].label).join('、')}）。這是「順勢追價」的邏輯，不是錯誤，但請確認是你要的。`);
  // 5) 樣本外
  if (tradesHold < 10) add('warn', `樣本外只有 ${tradesHold} 筆交易（需要夠多才能驗證）。`);
  if (!tips.length) add('good', low ? '沒有找到明顯的設定問題：這個條件組合在這段資料裡本來就不常出現。' : '交易數足夠，沒有發現明顯的設定問題。');
  return { conditions, andTrain, andHold, entryTrain, entryHold, levelTrain, tradesTrain, tradesHold, perSymbol, tips, low, minTrades, trainDays };
}

/** 自動搜尋：為什麼沒有（或很少）符合資格的候選 */
export function diagnoseSearch(result, ds) {
  const cands = result.candidates;
  const min = result.config.minTrades;
  const tips = [];
  const add = (level, text) => tips.push({ level, text });
  const under = cands.filter((c) => c.train.trades < min).length;
  const liq = cands.filter((c) => c.train.liquidations > 0).length;
  const maxTr = cands.reduce((m, c) => Math.max(m, c.train.trades), 0);
  const days = spanMs(ds, result.ranges.train) / 86400000;
  if (!cands.length) add('bad', '沒有產生任何候選：目前的指標池、條件週期與最低交易數組合下，找不到訊號足夠的條件。請放寬最低交易數、增加幣種／資料天數，或在指標池多勾幾個條件。');
  if (cands.length && under) add(under > cands.length / 2 ? 'warn' : 'info', `${cands.length} 組候選中，有 ${under} 組在訓練期的交易數不到 ${min} 筆（全部候選的最大交易數是 ${maxTr}），所以不能當冠軍。`);
  if (liq) add('info', `有 ${liq} 組在訓練期發生過清算，不能當冠軍；降低槓桿範圍可以減少。`);
  if (result.eligibleCount < 5) add('warn', `符合冠軍資格的只有 ${result.eligibleCount} 組。可以：① 拉長資料天數（現在訓練期約 ${days.toFixed(0)} 天）② 多選幾個幣種 ③ 減少「最多條件數」④ 降低最低交易數 ⑤ 換較小的執行週期。`);
  if (ds.symbols.length < 3) add('info', '只選了不到 3 個幣種，交易數會比較少，「跨幣正報酬比例」也沒有參考價值。');
  return tips;
}
