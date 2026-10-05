// 圖表：TradingView Lightweight Charts（已隨專案一起放在 vendor/，不需要連外部 CDN）
import { createChart, CandlestickSeries, LineSeries, AreaSeries, createSeriesMarkers, ColorType, CrosshairMode, LineStyle } from '../../vendor/lightweight-charts.mjs';

const live = new Set();

export const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

/** 以「本機時區」顯示：把 UTC 毫秒轉成圖表用的秒（加上時區位移） */
export function toChartTime(ms) {
  return Math.floor(ms / 1000) - new Date(ms).getTimezoneOffset() * 60;
}

function themeOptions() {
  return {
    layout: { background: { type: ColorType.Solid, color: cssVar('--panel') }, textColor: cssVar('--muted'), fontFamily: 'inherit' },
    grid: { vertLines: { color: cssVar('--border') }, horzLines: { color: cssVar('--border') } },
    rightPriceScale: { borderColor: cssVar('--border') },
    timeScale: { borderColor: cssVar('--border'), timeVisible: true, secondsVisible: false },
    crosshair: { mode: CrosshairMode.Normal },
  };
}

export function refreshChartTheme() {
  for (const h of live) {
    h.chart.applyOptions(themeOptions());
    if (h.restyle) h.restyle();
  }
}

function base(el) {
  el.innerHTML = '';
  const chart = createChart(el, { ...themeOptions(), autoSize: true, localization: { locale: 'zh-TW' } });
  const handle = { chart, el, destroy() { live.delete(handle); try { chart.remove(); } catch { /* ignore */ } } };
  live.add(handle);
  return handle;
}

/** K 線圖 */
export function candleChart(el, { candles, markers = [], lines = [], onReady }) {
  const h = base(el);
  const up = () => cssVar('--up');
  const down = () => cssVar('--down');
  const series = h.chart.addSeries(CandlestickSeries, {
    upColor: up(), downColor: down(), borderUpColor: up(), borderDownColor: down(), wickUpColor: up(), wickDownColor: down(),
  });
  series.setData(candles);
  const lineSeries = lines.map((ln) => {
    const s = h.chart.addSeries(LineSeries, { color: ln.color, lineWidth: ln.width || 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, lineStyle: ln.dashed ? LineStyle.Dashed : LineStyle.Solid, title: ln.title || '' });
    s.setData(ln.data);
    return s;
  });
  const mk = createSeriesMarkers(series, markers);
  h.series = series;
  h.setMarkers = (m) => mk.setMarkers(m);
  h.restyle = () => series.applyOptions({ upColor: up(), downColor: down(), borderUpColor: up(), borderDownColor: down(), wickUpColor: up(), wickDownColor: down() });
  h.chart.timeScale().fitContent();
  if (onReady) onReady(h);
  return h;
}

/** 折線／面積圖（淨值、回撤） */
export function lineChart(el, { series, markers = {} }) {
  const h = base(el);
  h.series = {};
  for (const s of series) {
    const opts = { priceLineVisible: false, lastValueVisible: true, title: s.title || '' };
    let ser;
    if (s.type === 'area') {
      ser = h.chart.addSeries(AreaSeries, { ...opts, lineColor: s.color, topColor: s.color + '55', bottomColor: s.color + '08', lineWidth: 2, invertFilledArea: !!s.invert });
    } else {
      ser = h.chart.addSeries(LineSeries, { ...opts, color: s.color, lineWidth: s.width || 2, lineStyle: s.dashed ? LineStyle.Dashed : LineStyle.Solid });
    }
    ser.setData(s.data);
    h.series[s.key] = ser;
    if (markers[s.key] && markers[s.key].length) createSeriesMarkers(ser, markers[s.key]);
  }
  h.chart.timeScale().fitContent();
  return h;
}

export function destroyAll() {
  for (const h of [...live]) h.destroy();
}
