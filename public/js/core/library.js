// 「我的回測」：儲存在瀏覽器（localStorage），只放在這台裝置上。
import { MAX_SAVED, validateSnapshot } from './report.js';

const KEY = 'bt.library.v1';

export class MemoryKV {
  constructor() { this.m = new Map(); }
  getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }
  setItem(k, v) { this.m.set(k, v); }
  removeItem(k) { this.m.delete(k); }
}

export class RunLibrary {
  constructor(kv) { this.kv = kv; }

  list() {
    let raw;
    try { raw = JSON.parse(this.kv.getItem(KEY) || '[]'); } catch { return []; }
    if (!Array.isArray(raw)) return [];
    const out = [];
    for (const r of raw) { try { out.push(validateSnapshot(r)); } catch { /* 壞掉的項目略過 */ } }
    return out.sort((a, b) => b.savedAt - a.savedAt);
  }

  _write(list) {
    try { this.kv.setItem(KEY, JSON.stringify(list)); } catch (e) { throw new Error('瀏覽器儲存空間不足或被停用，無法儲存。可先「匯出 JSON」備份，再刪除不需要的項目。'); }
  }

  /** 新增；超過上限時回傳 { dropped } 代表丟掉了最舊的幾筆 */
  add(snap) {
    const s = validateSnapshot(snap);
    const list = this.list().filter((x) => x.id !== s.id);
    list.unshift(s);
    const dropped = list.splice(MAX_SAVED).length;
    this._write(list);
    return { id: s.id, dropped };
  }

  addMany(snaps) {
    let dropped = 0;
    for (const s of snaps) { const r = this.add({ ...s, id: this.list().some((x) => x.id === s.id) ? `${s.id}x${Math.random().toString(36).slice(2, 5)}` : s.id }); dropped += r.dropped; }
    return { count: snaps.length, dropped };
  }

  get(id) { return this.list().find((x) => x.id === id) || null; }
  remove(id) { this._write(this.list().filter((x) => x.id !== id)); }
  rename(id, name) { this._write(this.list().map((x) => (x.id === id ? { ...x, name: String(name).trim().slice(0, 80) || x.name } : x))); }
  clear() { this._write([]); }
}
