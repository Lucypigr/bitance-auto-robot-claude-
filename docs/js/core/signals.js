// 訊號引擎：把條件算成「執行週期時間軸上的訊號索引」，並做快取。
import { IndicatorBundle, evalSpecOnSeries, alignToBase, indicesOf, specKey, normalizeSpec, entryGroups } from './conditions.js';
import { intersectSorted, unionSorted, TF_MS, timeAt } from './util.js';

export class SignalEngine {
  constructor(ds) {
    this.ds = ds;
    this.bundles = new Map();
    this.atoms = new Map();
    this.sets = new Map();
    this.baseSeries = new Map();
  }

  /** 執行週期的序列（去掉前後 NaN）。回傳 {t,o,h,l,c,v} 及 offset */
  baseSeriesOf(si) {
    let b = this.baseSeries.get(si);
    if (!b) {
      const S = this.ds.symbols[si];
      const len = S.last - S.first + 1;
      const t = new Float64Array(len);
      for (let i = 0; i < len; i++) t[i] = timeAt(this.ds, S.first + i);
      b = {
        t, o: S.o.subarray(S.first, S.last + 1), h: S.h.subarray(S.first, S.last + 1),
        l: S.l.subarray(S.first, S.last + 1), c: S.c.subarray(S.first, S.last + 1),
        v: S.v.subarray(S.first, S.last + 1),
      };
      this.baseSeries.set(si, b);
    }
    return b;
  }

  seriesOf(si, tf) {
    return tf === this.ds.baseTf ? this.baseSeriesOf(si) : this.ds.symbols[si].tf[tf];
  }

  bundle(si, tf) {
    const key = `${si}|${tf}`;
    let b = this.bundles.get(key);
    if (!b) {
      const s = this.seriesOf(si, tf);
      if (!s || !s.t || s.t.length === 0) return null;
      b = new IndicatorBundle(s, tf);
      this.bundles.set(key, b);
    }
    return b;
  }

  /** 單一條件在執行週期時間軸上成立的索引（遞增） */
  atomIdx(si, spec) {
    const key = `${si}#${specKey(spec)}`;
    let r = this.atoms.get(key);
    if (r) return r;
    const s = normalizeSpec(spec);
    if (s.neg) {
      // NOT：在這檔標的有資料的所有 K 線中，扣掉「條件成立」的那些
      const pos = this.atomIdx(si, { ...s, neg: false });
      const S = this.ds.symbols[si];
      const out = new Int32Array(S.last - S.first + 1 - pos.length);
      let n = 0;
      let p = 0;
      for (let i = S.first; i <= S.last; i++) {
        if (p < pos.length && pos[p] === i) p++;
        else out[n++] = i;
      }
      this.atoms.set(key, out);
      return out;
    }
    const bundle = this.bundle(si, s.tf);
    if (!bundle) {
      r = new Int32Array(0);
    } else {
      if (TF_MS[s.tf] < this.ds.baseMs) throw new Error(`條件週期 ${s.tf} 不可小於執行週期 ${this.ds.baseTf}`);
      const sig = evalSpecOnSeries(s, bundle);
      if (s.tf === this.ds.baseTf) {
        r = indicesOf(sig, this.ds.symbols[si].first);
      } else {
        const S = this.ds.symbols[si];
        const len = S.last - S.first + 1;
        const al = alignToBase(bundle.s.t, TF_MS[s.tf], sig, this.ds.t0 + S.first * this.ds.baseMs, this.ds.baseMs, len);
        r = indicesOf(al, S.first);
      }
    }
    this.atoms.set(key, r);
    return r;
  }

  /** 進場條件成立的索引：群組內 OR、群組之間 AND（沒有指定群組時就是純 AND） */
  andIdx(si, specs) {
    const groups = entryGroups(specs);
    const gkeys = groups.map((g) => g.map(specKey).sort().join('|')).sort();
    const key = `${si}#${gkeys.join('&')}`;
    let r = this.sets.get(key);
    if (r) return r;
    if (specs.length === 0) r = new Int32Array(0);
    else {
      const lists = groups.map((g) => g.map((sp) => this.atomIdx(si, sp)).reduce((a, b) => unionSorted(a, b))).sort((a, b) => a.length - b.length);
      r = lists[0];
      for (let i = 1; i < lists.length && r.length; i++) r = intersectSorted(r, lists[i]);
    }
    this.sets.set(key, r);
    return r;
  }

  /** 進場訊號：mode='edge' 只取「剛由不成立變成立」的那一根；'level' 取所有成立的根 */
  entryIdx(si, specs, mode = 'edge') {
    const all = this.andIdx(si, specs);
    if (mode === 'level') return all;
    return risingEdges(all);
  }

  /** 任一出場條件成立（OR）→ 0/1 陣列（網格座標） */
  exitSignal(si, specs) {
    if (!specs || specs.length === 0) return null;
    const out = new Uint8Array(this.ds.n);
    for (const sp of specs) {
      const idx = this.atomIdx(si, sp);
      for (let i = 0; i < idx.length; i++) out[idx[i]] = 1;
    }
    return out;
  }
}

export function risingEdges(idx) {
  const out = new Int32Array(idx.length);
  let n = 0;
  for (let i = 0; i < idx.length; i++) {
    if (i === 0 || idx[i - 1] !== idx[i] - 1) out[n++] = idx[i];
  }
  return out.slice(0, n);
}
