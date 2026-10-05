// 與 Web Worker 溝通；若瀏覽器不支援模組 Worker，則退回主執行緒（分段讓出，不會卡死）
import { SignalEngine } from '../core/signals.js';
import { runSearch, evaluateDetail } from '../core/search.js';
import { splitRanges } from '../core/dataset.js';

export class ComputeClient {
  constructor() {
    this.worker = null;
    this.inline = null;
    this.reqId = 0;
    this.pending = new Map();
    this.dataset = null;
    this.mode = 'worker';
  }

  _spawn() {
    if (this.worker || this.inline) return;
    try {
      this.worker = new Worker(new URL('../worker/backtest-worker.js', import.meta.url), { type: 'module' });
      this.worker.onmessage = (ev) => this._onMessage(ev.data);
      this.worker.onerror = (ev) => {
        const err = new Error(ev.message || 'Worker 發生錯誤');
        for (const p of this.pending.values()) p.reject(err);
        this.pending.clear();
      };
    } catch (e) {
      this.worker = null;
      this.mode = 'inline';
      this.inline = { sig: null, cancel: false };
    }
  }

  _onMessage(m) {
    const p = this.pending.get(m.reqId);
    if (!p) return;
    if (m.type === 'progress') { if (p.onProgress) p.onProgress(m.progress); return; }
    this.pending.delete(m.reqId);
    if (m.type === 'error') p.reject(new Error(m.message));
    else if (m.type === 'cancelled') p.resolve({ cancelled: true });
    else p.resolve(m.result === undefined ? { ok: true } : m.result);
  }

  _call(msg, onProgress) {
    const reqId = ++this.reqId;
    return new Promise((resolve, reject) => {
      this.pending.set(reqId, { resolve, reject, onProgress });
      this.worker.postMessage({ ...msg, reqId });
    });
  }

  async setDataset(ds) {
    this.dataset = ds;
    this._spawn();
    if (this.inline) { this.inline.sig = new SignalEngine(ds); return; }
    await this._call({ type: 'init', dataset: ds });
  }

  async backtest(strategy, costs, trainFrac = 0.7) {
    if (this.inline) {
      const ranges = splitRanges(this.inline.sig.ds, trainFrac);
      const r = evaluateDetail(this.inline.sig, strategy, costs, ranges);
      return { ranges, train: strip(r.train), holdout: strip(r.holdout), full: strip(r.full) };
    }
    return this._call({ type: 'backtest', strategy, costs, trainFrac });
  }

  async search(config, costs, onProgress) {
    if (this.inline) {
      this.inline.cancel = false;
      const result = await runSearch(this.inline.sig, config, costs, {
        progress: onProgress, cancelled: () => this.inline.cancel, yield: () => new Promise((r) => setTimeout(r, 0)),
      });
      if (result.cancelled) return { cancelled: true };
      for (const id of Object.keys(result.details)) {
        const d = result.details[id];
        result.details[id] = { train: strip(d.train), holdout: strip(d.holdout), full: strip(d.full), strategy: d.strategy };
      }
      return result;
    }
    return this._call({ type: 'search', config, costs }, onProgress);
  }

  /** 取消搜尋：先請 Worker 自行停止；1 秒內沒停就強制終止並重建 */
  async cancel() {
    if (this.inline) { this.inline.cancel = true; return; }
    if (!this.worker) return;
    this.worker.postMessage({ type: 'cancel' });
    const pendingIds = [...this.pending.keys()];
    for (let i = 0; i < 20 && pendingIds.some((id) => this.pending.has(id)); i++) await new Promise((r) => setTimeout(r, 50));
    if (pendingIds.some((id) => this.pending.has(id))) {
      this.worker.terminate();
      this.worker = null;
      for (const id of pendingIds) { const p = this.pending.get(id); if (p) { this.pending.delete(id); p.resolve({ cancelled: true }); } }
      this._spawn();
      if (this.dataset) await this._call({ type: 'init', dataset: this.dataset });
    }
  }
}

function strip(r) {
  return { equity: r.equity, trades: r.trades, perSymbol: r.perSymbol, metrics: r.metrics, range: r.range };
}
