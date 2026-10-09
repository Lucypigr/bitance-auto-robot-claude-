// 在 Web Worker 中執行大量運算，避免卡住介面
import { SignalEngine } from '../core/signals.js';
import { runStrategy } from '../core/portfolio.js';
import { runSearch, evaluateDetail } from '../core/search.js';
import { splitRanges } from '../core/dataset.js';
import { runSensitivity } from '../core/sensitivity.js';
import { runWalkForward } from '../core/walkforward.js';

let sig = null;
let cancelFlag = false;
const yieldNow = () => new Promise((r) => setTimeout(r, 0));

function transferables(obj, acc = []) {
  if (!obj || typeof obj !== 'object') return acc;
  if (ArrayBuffer.isView(obj)) { acc.push(obj.buffer); return acc; }
  if (Array.isArray(obj)) { for (const x of obj) transferables(x, acc); return acc; }
  for (const k of Object.keys(obj)) transferables(obj[k], acc);
  return acc;
}

self.onmessage = async (ev) => {
  const m = ev.data;
  try {
    if (m.type === 'init') {
      sig = new SignalEngine(m.dataset);
      self.postMessage({ type: 'ready', reqId: m.reqId });
    } else if (m.type === 'cancel') {
      cancelFlag = true;
    } else if (m.type === 'backtest') {
      cancelFlag = false;
      const ranges = splitRanges(sig.ds, m.trainFrac ?? 0.7);
      const res = evaluateDetail(sig, m.strategy, m.costs, ranges);
      const out = { ranges, train: pack(res.train), holdout: pack(res.holdout), full: pack(res.full) };
      self.postMessage({ type: 'result', reqId: m.reqId, result: out }, transferables(out));
    } else if (m.type === 'sensitivity') {
      cancelFlag = false;
      const ranges = splitRanges(sig.ds, m.trainFrac ?? 0.7);
      const out = runSensitivity(sig, m.strategy, m.costs, ranges, { progress: (p) => self.postMessage({ type: 'progress', reqId: m.reqId, progress: p }) });
      self.postMessage({ type: 'result', reqId: m.reqId, result: out });
    } else if (m.type === 'walkforward') {
      cancelFlag = false;
      const result = await runWalkForward(sig, m.config, m.costs, {
        progress: (p) => self.postMessage({ type: 'progress', reqId: m.reqId, progress: p }),
        cancelled: () => cancelFlag,
        yield: yieldNow,
      });
      if (result.cancelled) { self.postMessage({ type: 'cancelled', reqId: m.reqId }); return; }
      self.postMessage({ type: 'result', reqId: m.reqId, result }, [result.chain.buffer, result.bhChain.buffer]);
    } else if (m.type === 'search') {
      cancelFlag = false;
      const result = await runSearch(sig, m.config, m.costs, {
        progress: (p) => self.postMessage({ type: 'progress', reqId: m.reqId, progress: p }),
        cancelled: () => cancelFlag,
        yield: yieldNow,
      });
      if (result.cancelled) { self.postMessage({ type: 'cancelled', reqId: m.reqId }); return; }
      for (const id of Object.keys(result.details)) {
        const d = result.details[id];
        result.details[id] = { train: pack(d.train), holdout: pack(d.holdout), full: pack(d.full), strategy: d.strategy };
      }
      self.postMessage({ type: 'result', reqId: m.reqId, result }, transferables(result.details));
    }
  } catch (e) {
    self.postMessage({ type: 'error', reqId: m.reqId, message: String((e && e.message) || e) });
  }
};

function pack(r) {
  return { equity: r.equity, trades: r.trades, perSymbol: r.perSymbol, metrics: r.metrics, range: r.range };
}
void runStrategy;
