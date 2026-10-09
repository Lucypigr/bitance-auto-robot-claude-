import test from 'node:test';
import assert from 'node:assert/strict';
import { csvCell, toCsv, stamp, tradesRows, equityRows, boardRows, foldsRows, wfChainRows, chainedEquity, makeSnapshot, validateSnapshot, exportJson, parseImport, compareRows, compareWarnings, normalizedCurves, MAX_SAVED, SNAP_VERSION } from '../../public/js/core/report.js';
import { RunLibrary, MemoryKV } from '../../public/js/core/library.js';
import { runStrategy } from '../../public/js/core/portfolio.js';
import { evaluateDetail } from '../../public/js/core/search.js';
import { splitRanges } from '../../public/js/core/dataset.js';
import { makeMarket } from '../helpers/market.js';
import { NOTES, notesHtml } from '../../public/js/ui/notes.js';
import { PAGES } from '../../public/js/ui/tutorial.js';

const COSTS = { fee: 0.0005, slippage: 0.0005, mmr: 0.005, posPct: 1, capital: 10000 };
const ST = { dir: 'long', entry: [{ id: 'rsi_oversold', tf: '1h', params: { level: 40 } }], exit: [], sl: 3, tp: 5, trail: 0, lev: 1, entryMode: 'edge', unit: 'pct', posUsdt: 0, capitalMode: 'sleeve', maxPos: 0, riskPct: 0 };

function fixture(strategy = ST) {
  const { sig, ds } = makeMarket();
  const ranges = splitRanges(ds);
  const d = evaluateDetail(sig, strategy, COSTS, ranges);
  const res = { train: d.train, holdout: d.holdout, full: d.full, ranges };
  return { ds, sig, res, ranges };
}
const snapOf = (f, over = {}) => makeSnapshot({ res: f.res, ds: f.ds, strategy: ST, costsRaw: { capital: 10000, posPct: 100, feePct: 0.05, slipPct: 0.05, mmrPct: 0.5 }, useMark: true, trainFrac: 0.7, days: 90, market: 'perp', baseTf: '1h', desc: 'RSI 超賣', name: 'A', ...over });

test('CSV：逗號、引號、換行會跳脫；以 = + - @ 開頭的文字會防公式注入；數字不受影響', () => {
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell('=SUM(A1)'), "'=SUM(A1)");
  assert.equal(csvCell('@x'), "'@x");
  assert.equal(csvCell(-1.5), '-1.5');
  assert.equal(csvCell(NaN), '');
  assert.equal(csvCell(null), '');
  assert.equal(toCsv([[1, 'a'], [2, 'b,c']]), '1,a\r\n2,"b,c"\r\n');
});

test('交易明細 CSV：筆數、欄位、期間標記與損益總和與回測一致', () => {
  const f = fixture();
  const rows = tradesRows(f.res, f.ds);
  const n = f.res.train.trades.length + f.res.holdout.trades.length;
  assert.equal(rows.length, n + 1);
  assert.ok(n > 3, '測試資料要有交易');
  const head = rows[0];
  const pnlCol = head.findIndex((h) => h.startsWith('淨損益'));
  const sum = rows.slice(1).reduce((a, r) => a + r[pnlCol], 0);
  const expect = [...f.res.train.trades, ...f.res.holdout.trades].reduce((a, t) => a + t.pnl, 0);
  assert.ok(Math.abs(sum - expect) < 1e-6);
  assert.deepEqual([...new Set(rows.slice(1).map((r) => r[1]))].sort(), ['樣本外', '訓練'].filter((s) => rows.slice(1).some((r) => r[1] === s)).sort());
  for (const r of rows) assert.equal(r.length, head.length);
  assert.match(rows[1][5], /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
});

test('淨值曲線 CSV：長度＝訓練＋樣本外，樣本外接在訓練期期末淨值後', () => {
  const f = fixture();
  const eq = chainedEquity(f.res, 10000);
  assert.equal(eq.length, f.res.train.equity.length + f.res.holdout.equity.length);
  const nT = f.res.train.equity.length;
  const trEnd = f.res.train.equity[nT - 1];
  assert.ok(Math.abs(eq[nT] - f.res.holdout.equity[0] * (trEnd / 10000)) < 1e-9);
  const rows = equityRows(f.res, f.ds, 10000, new Float64Array(eq.length).fill(10000));
  assert.equal(rows.length, eq.length + 1);
  assert.equal(rows[1][1], '訓練');
  assert.equal(rows[nT + 1][1], '樣本外');
});

test('快照：只含可序列化數字、曲線點數受限、Infinity 不會變成 null', () => {
  const f = fixture();
  const s = snapOf(f);
  assert.equal(s.v, SNAP_VERSION);
  assert.ok(s.curve.t.length <= 260 && s.curve.t.length === s.curve.eq.length);
  for (let i = 1; i < s.curve.t.length; i++) assert.ok(s.curve.t[i] > s.curve.t[i - 1]);
  const m = { ...f.res.train.metrics, profitFactor: Infinity };
  const s2 = makeSnapshot({ res: { ...f.res, train: { ...f.res.train, metrics: m } }, ds: f.ds, strategy: ST, costsRaw: {}, trainFrac: 0.7, days: 90, market: 'perp', baseTf: '1h', desc: 'x', name: 'x' });
  assert.equal(s2.metrics.train.profitFactor, 1e9);
  const back = JSON.parse(JSON.stringify(s2));
  assert.equal(back.metrics.train.profitFactor, 1e9);
  assert.equal(s.metrics.oos.netReturn, f.res.holdout.metrics.netReturn);
});

test('匯出再匯入（往返）內容相同；單筆與多筆格式都可讀', () => {
  const f = fixture();
  const a = snapOf(f, { name: 'A', id: 'idA' });
  const b = snapOf(f, { name: 'B', id: 'idB' });
  const one = parseImport(exportJson([a]));
  assert.equal(one.length, 1);
  assert.deepEqual(one[0], validateSnapshot(a));
  const two = parseImport(exportJson([a, b]));
  assert.deepEqual(two.map((x) => x.id), ['idA', 'idB']);
});

test('匯入檢查：壞檔、版本不符、缺欄位、過大都會被擋；惡意字串被截斷、id 被淨化', () => {
  const f = fixture();
  const good = snapOf(f);
  assert.throws(() => parseImport('not json'), /JSON/);
  assert.throws(() => parseImport(JSON.stringify({ hello: 1 })), /版本/);
  assert.throws(() => parseImport(JSON.stringify({ ...good, market: 'forex' })), /市場/);
  assert.throws(() => parseImport(JSON.stringify({ ...good, strategy: null })), /策略/);
  assert.throws(() => parseImport(JSON.stringify({ ...good, metrics: {} })), /績效/);
  assert.throws(() => parseImport('x'.repeat(9e6)), /太大/);
  const evil = parseImport(JSON.stringify({ ...good, id: '../<script>alert(1)</script>', name: 'N'.repeat(500), desc: 'D'.repeat(5000), symbols: Array.from({ length: 50 }, (_, i) => ({ symbol: `S${i}`, name: 'x' })), unknown: { a: 1 } }))[0];
  assert.match(evil.id, /^[\w-]+$/);
  assert.ok(evil.name.length <= 80 && evil.desc.length <= 600 && evil.symbols.length <= 15);
  assert.equal(evil.unknown, undefined);
  assert.throws(() => parseImport(JSON.stringify({ kind: 'bt-library', runs: Array.from({ length: MAX_SAVED + 1 }, () => good) })), /最多/);
});

test('我的回測：新增、排序、改名、刪除、清空、上限、壞資料略過、重複 id 匯入不覆蓋', () => {
  const f = fixture();
  const lib = new RunLibrary(new MemoryKV());
  assert.deepEqual(lib.list(), []);
  lib.add(snapOf(f, { id: 'a', name: 'A', now: 1000 }));
  lib.add(snapOf(f, { id: 'b', name: 'B', now: 2000 }));
  assert.deepEqual(lib.list().map((x) => x.id), ['b', 'a']); // 新的在前
  lib.rename('a', '  新名字  ');
  assert.equal(lib.get('a').name, '新名字');
  lib.remove('b');
  assert.deepEqual(lib.list().map((x) => x.id), ['a']);
  const r = lib.addMany([snapOf(f, { id: 'a', name: 'dup' })]);
  assert.equal(r.count, 1);
  assert.equal(lib.list().length, 2, '同 id 匯入不覆蓋原本的');
  lib.clear();
  assert.equal(lib.list().length, 0);
  for (let i = 0; i < MAX_SAVED + 5; i++) lib.add(snapOf(f, { id: `x${i}`, now: 1e6 + i }));
  assert.equal(lib.list().length, MAX_SAVED);
  assert.equal(lib.list()[0].id, `x${MAX_SAVED + 4}`);
  const kv = new MemoryKV();
  kv.setItem('bt.library.v1', JSON.stringify([{ junk: true }, snapOf(f, { id: 'ok' })]));
  assert.deepEqual(new RunLibrary(kv).list().map((x) => x.id), ['ok']);
  const bad = new MemoryKV(); bad.setItem('bt.library.v1', '{{{');
  assert.deepEqual(new RunLibrary(bad).list(), []);
});

test('儲存空間寫入失敗時給出明確訊息，不會默默丟資料', () => {
  const f = fixture();
  const kv = { getItem: () => null, setItem: () => { throw new Error('quota'); } };
  assert.throws(() => new RunLibrary(kv).add(snapOf(f)), /儲存空間/);
});

test('並排比較：最佳值標示、平手與 0 筆交易不標示、回撤越小越好', () => {
  const f = fixture();
  const mk = (id, over, mover = {}) => { const s = snapOf(f, { id, name: id, ...over }); Object.assign(s.metrics.oos, mover); return s; };
  const a = mk('a', {}, { netReturn: 0.1, maxDrawdown: 0.3, trades: 30 });
  const b = mk('b', {}, { netReturn: 0.2, maxDrawdown: 0.1, trades: 25 });
  const c = mk('c', {}, { netReturn: 0.9, maxDrawdown: 0.0, trades: 0 }); // 0 筆交易不得當最佳
  const rows = compareRows([a, b, c], 'oos');
  const get = (k) => rows.find((r) => r.key === k);
  assert.equal(get('netReturn').best, 1);
  assert.equal(get('maxDrawdown').best, 1);
  assert.equal(get('trades').best, -1);
  const tie = compareRows([mk('t1', {}, { netReturn: 0.1, trades: 5 }), mk('t2', {}, { netReturn: 0.1, trades: 5 })], 'oos');
  assert.equal(tie.find((r) => r.key === 'netReturn').best, -1);
});

test('並排比較：設定不同時給出警告；相同則不警告', () => {
  const f = fixture();
  const a = snapOf(f, { id: 'a' });
  const b = snapOf(f, { id: 'b' });
  assert.deepEqual(compareWarnings([a, b]), []);
  const c = { ...b, market: 'spot', baseTf: '4h', trainFrac: 0.5, costsRaw: { ...b.costsRaw, feePct: 0.1 }, symbols: [{ symbol: 'ZZZ' }] };
  const w = compareWarnings([a, c]).join('|');
  for (const k of ['市場不同', '執行週期不同', '標的不同', '比例不同', '手續費']) assert.ok(w.includes(k), k);
  const d = { ...b, window: { ...b.window, from: b.window.from + 40 * 864e5 } };
  assert.ok(compareWarnings([a, d]).join('').includes('資料期間不同'));
});

test('比較曲線：各自換算成起點 100', () => {
  const f = fixture();
  const cs = normalizedCurves([snapOf(f, { id: 'a' }), snapOf(f, { id: 'b' })]);
  for (const c of cs) assert.ok(Math.abs(c.points[0].v - 100) < 1e-9);
});

test('候選排行榜與走動式 CSV 欄位數一致', () => {
  const f = fixture();
  const cand = { id: 'c1', desc: '=危險,文字', train: f.res.train.metrics, stability: 12.3 };
  const rows = boardRows({ candidates: [cand], champions: { winRate: 'c1', netReturn: null, stable: 'c1' } });
  assert.equal(rows[1].length, rows[0].length);
  assert.equal(rows[1][rows[0].length - 1], '最高勝率／最穩定');
  assert.match(toCsv(rows), /'=危險/);
  const t = f.ranges.full;
  const wf = { folds: [{ k: 1, train: { from: t.from, to: t.from + 100 }, test: { from: t.from + 100, to: t.from + 150 }, hasChampion: false, desc: '', trainMetrics: null, testMetrics: { netReturn: 0.01, trades: 0 }, buyHold: 0.02 }], chain: new Float64Array([1, 1.1]), bhChain: new Float64Array([1, 1.2]), range: { from: t.from + 100, to: t.from + 102 } };
  const fr = foldsRows(wf, f.ds);
  assert.equal(fr[1].length, fr[0].length);
  assert.match(fr[1][5], /沒有合格冠軍/);
  const cr = wfChainRows(wf, f.ds, 1000);
  assert.equal(cr.length, 3);
  assert.equal(cr[2][1], 1100);
  assert.equal(stamp({ times: [1] }, Date.UTC(2025, 0, 2, 3, 4)), '2025-01-02');
});

test('注意事項：單一來源，教學頁與說明都包含關鍵警語', () => {
  const html = notesHtml();
  for (const k of ['不代表未來', '過度擬合', '倖存者偏差', '同時搜尋指標參數', 'localStorage', '匯出 JSON', 'UTC', '並排比較', '共用資金池', '走動式驗證']) assert.ok(html.includes(k) || NOTES.some((n) => n.items.some((t) => t.includes(k))), k);
  const page = PAGES.find((p) => p.id === 'notes');
  assert.ok(page && page.html.includes('倖存者偏差') && page.html.includes('localStorage'));
  assert.equal(PAGES[PAGES.length - 1].id, 'notes');
  assert.ok(!html.includes('<script'));
});

test('回測結果不受匯出影響（純函式不會修改輸入）', () => {
  const f = fixture();
  const before = JSON.stringify(f.res.train.metrics);
  tradesRows(f.res, f.ds); equityRows(f.res, f.ds, 10000, null); snapOf(f);
  assert.equal(JSON.stringify(f.res.train.metrics), before);
  void runStrategy;
});
