// 各幣種損益拆解：總成績 = 各幣種資金袋的加總
export function symbolBreakdown(seg, capital) {
  const n = seg.perSymbol.length || 1;
  const sleeve = capital / n;
  const rows = seg.perSymbol.map((p, si) => {
    const ts = seg.trades.filter((t) => t.si === si);
    const wins = ts.filter((t) => t.pnl > 0).length;
    return {
      symbol: p.symbol, trades: ts.length, wins,
      winRate: ts.length ? wins / ts.length : null,
      pnl: p.finalEquity - sleeve, ret: p.finalEquity / sleeve - 1,
      funding: ts.reduce((s, t) => s + t.funding, 0), liquidations: ts.filter((t) => t.reason === 'liq').length,
    };
  });
  return { rows, sleeve, totalPnl: rows.reduce((s, r) => s + r.pnl, 0) };
}
