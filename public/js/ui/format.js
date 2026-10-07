// 數字顯示
export function fmtPct(x, digits = 1, signed = false) {
  if (x === null || x === undefined || Number.isNaN(x)) return '—';
  if (!Number.isFinite(x)) return x > 0 ? '∞' : '−∞';
  const p = x * 100;
  const a = Math.abs(p);
  if (a >= 1e6) return (p < 0 ? '−' : signed ? '+' : '') + '>1,000,000%';
  const s = a.toLocaleString('en-US', { minimumFractionDigits: a >= 1000 ? 0 : digits, maximumFractionDigits: a >= 1000 ? 0 : digits });
  const sign = p < 0 ? '−' : signed && p > 0 ? '+' : '';
  return `${sign}${s}%`;
}
export function fmtNum(x, digits = 2) {
  if (x === null || x === undefined || Number.isNaN(x)) return '—';
  if (!Number.isFinite(x)) return x > 0 ? '∞' : '−∞';
  return x.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}
export function fmtMoney(x, digits = 2, signed = false) {
  if (x === null || x === undefined || Number.isNaN(x)) return '—';
  if (!Number.isFinite(x)) return x > 0 ? '∞' : '−∞';
  const a = Math.abs(x);
  if (a >= 1e12) return (x < 0 ? '−' : signed ? '+' : '') + a.toExponential(2);
  const s = a.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return (x < 0 ? '−' : signed && x > 0 ? '+' : '') + s;
}
export function fmtPrice(x) {
  if (!Number.isFinite(x)) return '—';
  const a = Math.abs(x);
  const d = a >= 1000 ? 2 : a >= 10 ? 3 : a >= 1 ? 4 : 6;
  return x.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: d });
}
export function fmtTime(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
export function fmtDate(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
export function fmtDateUTC(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}
/** 加密貨幣用本機時間（含時分），台股日線用日期（UTC 日期＝交易日） */
export function fmtStamp(ds, ms) {
  return ds.times ? fmtDateUTC(ms) : fmtTime(ms);
}
export const signClass = (x) => (x > 0 ? 'pos' : x < 0 ? 'neg' : '');
