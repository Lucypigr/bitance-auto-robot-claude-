// 策略的白話描述（手動與自動搜尋共用）
import { describeEntry, describeSpec } from './conditions.js';

const num = (x) => (Number.isInteger(x) ? String(x) : String(+x.toFixed(2)));

/** 停損停利等距離的單位：價格 %、USDT 損益金額、ATR 倍數 */
export function unitSuffix(st) {
  if (st.unit === 'usdt') return ` ${st.cur || 'USDT'}`;
  if (st.unit === 'atr') return '×ATR';
  if (st.unit === 'capital') return '%本金';
  if (st.unit === 'roe') return '%保證金報酬';
  return '%';
}

export function directionText(st) {
  if (st.dir === 'both') return st.reverse ? '雙向反手' : '雙向（不反手）';
  return st.dir === 'long' ? '做多' : '做空';
}

export function conditionText(st) {
  if (st.dir === 'both') return `做多：${describeEntry(st.entry)}／做空：${describeEntry(st.entryB || [])}`;
  return describeEntry(st.entry);
}

/** 停損、停利、移動停損、分批出場、加碼 */
export function exitParts(st) {
  const u = unitSuffix(st);
  const out = [];
  if (st.unit === 'atr' && (st.sl || st.tp)) out.push(`ATR 週期 ${st.atrPeriod || 14}`);
  if (st.sl) out.push(`停損 ${num(st.sl)}${u}`);
  if (st.tp) out.push(`停利 ${num(st.tp)}${u}`);
  if (st.trail) out.push(`移動停損 ${st.trail}%`);
  const so = st.scaleOut;
  if (so && so.frac > 0) out.push(`分批出場：到 ${num(so.at)}${u} 先平 ${num(so.frac)}%${so.be ? '、之後停損移到成本價' : ''}`);
  const si = st.scaleIn;
  if (si && si.count > 0) out.push(`${si.mode === 'adverse' ? '逢低分批進場' : '順勢加碼'}：每${si.mode === 'adverse' ? '逆行' : '順行'} ${num(si.step)}${u} 加碼初始部位 ${num(si.size ?? 100)}%、最多 ${si.count} 次`);
  return out;
}

export function exitConditionText(st) {
  return st.exit && st.exit.length ? `或 ${st.exit.map(describeSpec).join('、')} 時出場` : '';
}
