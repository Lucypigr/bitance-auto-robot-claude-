import { test, expect } from './fixtures.js';

test('手動回測：結果比較表、圖表、逐筆交易、每月報酬', async ({ page }) => {
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto('/index.html');
  await page.locator('#tab-manual').click();
  await page.selectOption('#m-template', 'overbought');
  await page.selectOption('#days', '90');
  await page.locator('#btn-manual').click();
  const cmp = page.getByTestId('compare');
  await expect(cmp).toBeVisible({ timeout: 60000 });
  for (const label of ['淨報酬', '勝率', '最大回撤', 'Profit Factor', 'Sharpe', 'Sortino', '年化報酬 CAGR', '平均盈利', '每筆期望值', '最長連敗', '交易次數', '正報酬月份', '跨幣正報酬比例', 'Funding', '清算次數', '槓桿']) {
    await expect(cmp).toContainText(label);
  }
  await expect(cmp).toContainText('訓練期');
  await expect(cmp).toContainText('樣本外');
  await expect(page.getByTestId('verdict')).toContainText('回測不代表未來績效');
  // K 線圖有繪製（canvas 存在且有尺寸）
  const canvas = page.locator('#candle-chart canvas').first();
  await expect(canvas).toBeVisible();
  expect((await canvas.boundingBox()).width).toBeGreaterThan(200);
  await page.locator('[data-ctab="equity"]').click();
  await expect(page.locator('#equity-chart canvas').first()).toBeVisible();
  await page.locator('[data-ctab="drawdown"]').click();
  await expect(page.locator('#dd-chart canvas').first()).toBeVisible();
  await page.locator('[data-ctab="monthly"]').click();
  await expect(page.getByTestId('monthly')).toBeVisible();
  await page.locator('[data-ctab="trades"]').click();
  await expect(page.getByTestId('trades')).toBeVisible();
  await page.selectOption('#tr-seg', '樣本外');
  expect(errors).toEqual([]);
});

test('跨週期範例：4h RSI 超買 + 1h MACD 死叉 + 15m 流星線，執行週期自動切到 15m', async ({ page }) => {
  await page.goto('/index.html');
  await page.locator('#tab-manual').click();
  await page.selectOption('#m-template', 'mtf');
  await expect(page.locator('#base-tf')).toHaveValue('15m');
  await expect(page.locator('#m-entry .cond')).toHaveCount(3);
  await expect(page.locator('#m-summary')).toContainText('4h RSI');
  await expect(page.locator('#m-summary')).toContainText('1h MACD');
  await expect(page.locator('#m-summary')).toContainText('15m 出現「流星線」');
  await page.selectOption('#days', '90');
  await page.locator('#btn-manual').click();
  await expect(page.getByTestId('compare')).toBeVisible({ timeout: 90000 });
  await expect(page.getByTestId('strategy-desc')).toContainText('流星線');
});

test('現貨：不能做空、不能用槓桿，並可回測', async ({ page }) => {
  await page.goto('/index.html');
  await page.locator('[data-market="spot"]').click();
  await expect(page.locator('[data-dir="short"]')).toBeDisabled();
  await expect(page.locator('#m-lev')).toBeDisabled();
  await expect(page.locator('#feePct')).toHaveValue('0.1');
  await page.locator('#tab-manual').click();
  await page.selectOption('#m-template', 'oversold');
  await page.selectOption('#days', '90');
  await page.locator('#btn-manual').click();
  await expect(page.getByTestId('compare')).toBeVisible({ timeout: 60000 });
  await expect(page.getByTestId('strategy-desc')).toContainText('做多');
});

test('自動搜尋：三位冠軍、排行榜只顯示訓練期、可開啟候選完整回測', async ({ page }) => {
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto('/index.html');
  await page.selectOption('#days', '90');
  await page.selectOption('#s-budget', '30');
  await page.fill('#s-min', '5');
  await page.locator('#btn-search').click();
  for (const k of ['winRate', 'netReturn', 'stable']) await expect(page.getByTestId(`champ-${k}`)).toBeVisible({ timeout: 90000 });
  await expect(page.locator('#r-champions')).toContainText('最高勝率');
  await expect(page.locator('#r-champions')).toContainText('最高淨報酬');
  await expect(page.locator('#r-champions')).toContainText('最穩定');
  await expect(page.getByTestId('compare')).toBeVisible();
  await page.locator('#tab-board').click();
  const rows = page.getByTestId('board').locator('tbody tr');
  const n = await rows.count();
  expect(n).toBeGreaterThan(5);
  expect(n).toBeLessThanOrEqual(30);
  await expect(page.locator('#board')).toContainText('只顯示訓練期');
  await page.getByTestId('board').locator('th[data-sort="netReturn"]').click();
  await rows.nth(3).click();
  await expect(page.getByTestId('detail-head')).toBeVisible();
  await expect(page.getByTestId('compare')).toBeVisible();
  expect(errors).toEqual([]);
});

test('自動搜尋可在 Web Worker 中取消', async ({ page, fake }) => {
  fake.delay = 0;
  await page.goto('/index.html');
  await page.selectOption('#days', '365');
  await page.selectOption('#base-tf', '15m');
  await page.selectOption('#s-budget', '300');
  await page.fill('#s-min', '3');
  await page.selectOption('#s-maxc', '4');
  await page.locator('#btn-search').click();
  await expect(page.locator('#btn-cancel')).toBeVisible({ timeout: 60000 });
  await expect(page.locator('#search-progress .ptext')).toContainText('訓練期測試候選', { timeout: 90000 });
  expect(page.workers().length).toBeGreaterThan(0);
  await page.locator('#btn-cancel').click();
  await expect(page.locator('#run-error')).toContainText('已取消', { timeout: 15000 });
  await expect(page.locator('#btn-search')).toBeEnabled();
  await expect(page.locator('#btn-cancel')).toBeHidden();
});

test('網路／地區封鎖時顯示清楚的錯誤訊息', async ({ page }) => {
  await page.unroute(/(binance\.com|binance\.vision)/);
  await page.route(/(binance\.com|binance\.vision)/, (r) => r.fulfill({ status: 451, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{}' }));
  await page.goto('/index.html');
  await expect(page.locator('#sym-status')).toContainText('無法取得幣種清單');
  await page.locator('#btn-search').click();
  await expect(page.locator('#run-error')).toContainText('地區', { timeout: 60000 });
});

test('GitHub Pages 發佈資料夾 docs/ 可正常執行', async ({ page }) => {
  await page.goto('http://localhost:4174/index.html');
  await expect(page.locator('h1')).toHaveText('幣安回測平台');
  await page.locator('#tab-manual').click();
  await page.selectOption('#m-template', 'overbought');
  await page.selectOption('#days', '30');
  await page.locator('#btn-manual').click();
  await expect(page.getByTestId('compare')).toBeVisible({ timeout: 60000 });
});

test('合約漲幅榜：依 24h 漲幅排序、快速選取前 N 名，並有「事後挑贏家」提醒', async ({ page }) => {
  await page.goto('/index.html');
  await expect(page.locator('#sym-list .sym-item').first()).toBeVisible();
  await page.selectOption('#sym-sort', 'gain');
  const pcts = await page.locator('#sym-list .sym-item .vol b').allTextContents();
  const nums = pcts.map((t) => parseFloat(t));
  expect(nums.length).toBeGreaterThan(5);
  for (let i = 1; i < nums.length; i++) expect(nums[i - 1]).toBeGreaterThanOrEqual(nums[i]);
  const top3 = (await page.locator('#sym-list .sym-item').evaluateAll((els) => els.slice(0, 3).map((e) => e.dataset.sym)));
  await page.locator('[data-preset="3"]').click();
  await expect(page.locator('#sym-count')).toContainText('已選 3');
  const chosen = await page.locator('#sym-selected .chip').allTextContents();
  for (const s of top3) expect(chosen.join(' ')).toContain(s.replace('USDT', ''));
  // 跌幅榜相反
  await page.selectOption('#sym-sort', 'loss');
  const lnums = (await page.locator('#sym-list .sym-item .vol b').allTextContents()).map((t) => parseFloat(t));
  for (let i = 1; i < lnums.length; i++) expect(lnums[i - 1]).toBeLessThanOrEqual(lnums[i]);
  // ⓘ 說明
  await page.locator('#step1 button.ibtn[data-term="gainers"]').hover();
  await expect(page.locator('#info-pop')).toContainText('事後挑出贏家');
});

test('自訂指標池：預設含全部 9 種 K 線型態，可加選其他指標後搜尋', async ({ page }) => {
  await page.goto('/index.html');
  await page.locator('#pool-adv summary').click();
  for (const id of ['pat_hammer', 'pat_inverted_hammer', 'pat_hanging_man', 'pat_shooting_star', 'pat_bullish_engulfing', 'pat_bearish_engulfing', 'pat_doji', 'pat_morning_star', 'pat_evening_star']) {
    await expect(page.locator(`input[name="s-pool"][value="${id}"]`)).toBeChecked();
  }
  await expect(page.locator('input[name="s-pool"][value="kd_oversold"]')).not.toBeChecked();
  await page.locator('#pool-all').click();
  await expect(page.locator('input[name="s-pool"][value="kd_oversold"]')).toBeChecked();
  await page.locator('#pool-none').click();
  await page.locator('#btn-search').click();
  await expect(page.locator('#run-error')).toContainText('指標池');
  await page.locator('#pool-all').click();
  await page.selectOption('#days', '90');
  await page.selectOption('#s-budget', '30');
  await page.fill('#s-min', '5');
  await page.locator('#btn-search').click();
  await expect(page.getByTestId('champ-netReturn')).toBeVisible({ timeout: 90000 });
  await page.locator('#tab-board').click();
  await expect(page.getByTestId('board').locator('tbody tr').first()).toBeVisible();
});

test('USDT 金額停損停利：投入 6U、停利 2U、停損 3U（手動與自動搜尋）', async ({ page }) => {
  await page.goto('/index.html');
  await page.locator('#tab-manual').click();
  await page.selectOption('#m-template', 'overbought');
  await page.selectOption('#m-unit', 'usdt');
  await page.fill('#m-sl', '3'); await page.fill('#m-tp', '2');
  await page.fill('#m-usdt', '0');
  await page.selectOption('#days', '90');
  await page.locator('#btn-manual').click();
  await expect(page.locator('#run-error')).toContainText('每筆投入');
  await page.fill('#m-usdt', '6');
  await expect(page.locator('#m-summary')).toContainText('停損 3 USDT');
  await expect(page.locator('#m-summary')).toContainText('停利 2 USDT');
  await page.locator('#btn-manual').click();
  await expect(page.getByTestId('compare')).toBeVisible({ timeout: 60000 });
  await expect(page.getByTestId('strategy-desc')).toContainText('每筆 6 USDT');
  // 自動搜尋
  await page.locator('#tab-search').click();
  await page.locator('#step2 details.adv summary').first().click();
  await page.selectOption('#s-unit', 'usdt');
  await expect(page.locator('input[name="s-sl"]').first()).toBeDisabled();
  await page.fill('#s-usdt', '6'); await page.fill('#s-sl-custom', '3'); await page.fill('#s-tp-custom', '2, 4');
  await page.selectOption('#s-budget', '30'); await page.fill('#s-min', '5');
  await page.locator('#btn-search').click();
  await expect(page.getByTestId('champ-netReturn')).toBeVisible({ timeout: 90000 });
  await expect(page.locator('#r-champions')).toContainText('每筆 6 USDT');
});

test('訓練／樣本外比例可改成 50/50，結果標題同步更新', async ({ page }) => {
  await page.goto('/index.html');
  await page.selectOption('#train-pct', '50');
  await page.locator('#tab-manual').click();
  await page.selectOption('#m-template', 'overbought');
  await page.selectOption('#days', '90');
  await page.locator('#btn-manual').click();
  const cmp = page.getByTestId('compare');
  await expect(cmp).toBeVisible({ timeout: 60000 });
  await expect(cmp).toContainText('訓練期 50%');
  await expect(cmp).toContainText('樣本外 50%');
  await page.locator('#tab-search').click();
  await page.selectOption('#s-budget', '30'); await page.fill('#s-min', '5');
  await page.locator('#btn-search').click();
  await expect(page.getByTestId('champ-netReturn')).toBeVisible({ timeout: 90000 });
  await expect(page.getByTestId('compare')).toContainText('訓練期 50%');
  await page.locator('#tab-board').click();
  await expect(page.locator('#board')).toContainText('前 50%');
});

test('歷史漲幅榜：設定區間、計算、排序、前瞻提醒與快速選取', async ({ page }) => {
  await page.goto('/index.html');
  await expect(page.locator('#sym-list .sym-item').first()).toBeVisible();
  await page.selectOption('#sym-sort', 'hist');
  await expect(page.locator('#hist-box')).toBeVisible();
  await expect(page.locator('#sym-list')).toContainText('請先設定區間');
  await page.selectOption('#hist-end', '7'); await page.selectOption('#hist-win', '7'); await page.selectOption('#hist-top', '30');
  await page.locator('#hist-go').click();
  await expect(page.locator('#hist-status')).toContainText('榜單區間（UTC 日線）', { timeout: 30000 });
  await expect(page.locator('#hist-status')).toContainText('事後挑出贏家'); // 回測 180 天包含 7 天前的區間
  const nums = (await page.locator('#sym-list .sym-item .vol b').allTextContents()).map((t) => parseFloat(t));
  expect(nums.length).toBeGreaterThan(5);
  for (let i = 1; i < nums.length; i++) expect(nums[i - 1]).toBeGreaterThanOrEqual(nums[i]);
  await page.locator('[data-preset="3"]').click();
  await expect(page.locator('#sym-count')).toContainText('已選 3');
  await page.selectOption('#days', '30');
  await page.selectOption('#hist-end', '60');
  await page.locator('#hist-go').click();
  await expect(page.locator('#hist-status')).toContainText('前瞻', { timeout: 30000 });
});

test('設定檢查：交易數太少時自動展開並說明哪一關擋掉', async ({ page }) => {
  await page.goto('/index.html');
  await page.locator('#tab-manual').click();
  await page.selectOption('#m-template', 'mtf');
  await page.selectOption('#days', '30');
  await page.locator('#btn-manual').click();
  const diag = page.getByTestId('diag');
  await expect(diag).toBeVisible({ timeout: 90000 });
  await expect(diag).toHaveAttribute('open', '');
  await expect(diag).toContainText('全部條件「同時成立」');
  await expect(diag).toContainText('實際成交的交易數');
  await expect(diag.locator('.verdict-list li').first()).toBeVisible();
});

test('各幣種損益：每個幣種一列，合計等於總成績', async ({ page }) => {
  await page.goto('/index.html');
  await page.locator('#tab-manual').click();
  await page.selectOption('#m-template', 'overbought');
  await page.selectOption('#days', '90');
  await page.locator('#btn-manual').click();
  const t = page.getByTestId('symbols');
  await expect(t).toBeVisible({ timeout: 60000 });
  await expect(t.locator('tbody tr')).toHaveCount(3); // 2 個幣種 + 合計
  await expect(t).toContainText('BTCUSDT');
  await expect(t).toContainText('ETHUSDT');
  await expect(t).toContainText('合計（＝總成績）');
  await expect(page.locator('#r-symbols')).toContainText('加總');
});

test('台股（日線）：切換市場、選股、手動回測與自動搜尋', async ({ page }) => {
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto('/index.html');
  await page.locator('[data-market="tw"]').click();
  // 只有日線、只做多、新台幣
  await expect(page.locator('#base-tf')).toHaveValue('1d');
  await expect(page.locator('#base-tf option[value="1h"]')).toBeDisabled();
  await expect(page.locator('[data-dir="short"]')).toBeDisabled();
  await page.locator('#step1 details.adv summary').click();
  await expect(page.locator('#tw-fields')).toBeVisible();
  await expect(page.locator('#feePct')).toHaveValue('0.1425');
  await expect(page.locator('#capital')).toHaveValue('1000000');
  await expect(page.locator('label[for="capital"]')).toContainText('TWD');
  await expect(page.locator('#sym-list')).toContainText('2330 台積電');
  await expect(page.locator('#sym-selected')).toContainText('台積電');
  await page.fill('#sym-search', '聯發');
  await expect(page.locator('#sym-list .sym-item')).toHaveCount(1);
  await page.fill('#sym-search', '');
  // 手動回測
  await page.locator('#tab-manual').click();
  await page.selectOption('#m-template', 'oversold');
  await page.fill('#m-sl', '5'); await page.fill('#m-tp', '8');
  await page.locator('#btn-manual').click();
  await expect(page.getByTestId('compare')).toBeVisible({ timeout: 60000 });
  await expect(page.getByTestId('strategy-desc')).toContainText('做多');
  await expect(page.locator('#r-title')).toContainText('台股（日線）');
  await expect(page.locator('#r-title')).toContainText('證交稅');
  await expect(page.getByTestId('symbols')).toContainText('2330 台積電');
  await expect(page.locator('#r-symbols')).toContainText('TWD');
  await expect(page.locator('#data-info')).toContainText('交易日');
  await page.locator('[data-ctab="trades"]').click();
  await expect(page.getByTestId('trades')).toContainText('淨損益 TWD');
  const dates = await page.getByTestId('trades').locator('tbody tr td:nth-child(5)').allTextContents();
  for (const d of dates.slice(0, 20)) { expect(d).toMatch(/^\d{4}-\d{2}-\d{2}$/); const dow = new Date(`${d}T00:00:00Z`).getUTCDay(); expect([0, 6]).not.toContain(dow); }
  await page.locator('[data-ctab="candles"]').click();
  await expect(page.locator('#candle-chart canvas').first()).toBeVisible();
  // 自動搜尋
  await page.locator('#tab-search').click();
  await expect(page.locator('input[name="s-tf"]')).toHaveCount(1);
  await page.selectOption('#s-budget', '30'); await page.fill('#s-min', '3');
  await page.locator('#btn-search').click();
  await expect(page.getByTestId('champ-netReturn')).toBeVisible({ timeout: 90000 });
  // 切回加密貨幣：恢復預設
  await page.locator('[data-market="perp"]').click();
  await expect(page.locator('#base-tf option[value="1h"]')).toBeEnabled();
  await expect(page.locator('#capital')).toHaveValue('10000');
  expect(errors).toEqual([]);
});

test('台股：FinMind 額度用完時顯示清楚的錯誤', async ({ page, fakeTw }) => {
  fakeTw.quota = 1; // 只夠取得股票清單
  await page.goto('/index.html');
  await page.locator('[data-market="tw"]').click();
  await expect(page.locator('#sym-list')).toContainText('2330');
  await page.locator('#tab-manual').click();
  await page.selectOption('#m-template', 'oversold');
  await page.locator('#btn-manual').click();
  await expect(page.locator('#run-error')).toContainText('Token', { timeout: 60000 });
});

test('進階設定：偏離預設時會提醒、可一鍵恢復；台股每筆投入太小會明確說明原因', async ({ page }) => {
  await page.goto('/index.html');
  await expect(page.getByTestId('adv-note')).toBeHidden();
  await page.locator('[data-market="tw"]').click();
  await page.locator('#step2 details.adv summary').first().click();
  await page.selectOption('#s-unit', 'usdt');
  await page.fill('#s-usdt', '6'); await page.fill('#s-sl-custom', '3'); await page.fill('#s-tp-custom', '2');
  await expect(page.getByTestId('adv-note')).toBeVisible();
  await expect(page.getByTestId('adv-note')).toContainText('每筆固定投入 6 TWD');
  await page.selectOption('#days', '730'); await page.selectOption('#s-budget', '30'); await page.fill('#s-min', '3');
  await page.locator('#btn-search').click();
  await expect(page.getByTestId('search-tips')).toContainText('買不起 1 股', { timeout: 90000 });
  await page.locator('#adv-reset').click();
  await expect(page.getByTestId('adv-note')).toBeHidden();
  await expect(page.locator('#s-unit')).toHaveValue('pct');
  await expect(page.locator('#s-usdt')).toHaveValue('0');
  await expect(page.locator('#s-sl-custom')).toHaveValue('');
  await expect(page.locator('input[name="s-sl"]').first()).toBeEnabled();
  await page.locator('#btn-search').click();
  await expect(page.getByTestId('champ-netReturn')).toBeVisible({ timeout: 90000 });
});

test('條件邏輯：(A 或 B) 且 非 C；回測與說明文字一致', async ({ page }) => {
  await page.goto('/index.html');
  await page.locator('#tab-manual').click();
  await page.selectOption('#m-template', 'overbought'); // 1 個條件
  await page.locator('#m-add-entry').click();
  await page.locator('#m-add-entry').click();
  await expect(page.locator('#m-entry .cond')).toHaveCount(3);
  const rows = page.locator('#m-entry .cond');
  await rows.nth(1).locator('.c-id').selectOption('bb_above_upper');
  await rows.nth(2).locator('.c-id').selectOption('macd_golden');
  await rows.nth(0).locator('.c-grp').selectOption('A');
  await rows.nth(1).locator('.c-grp').selectOption('A');
  await rows.nth(2).locator('.c-neg').check();
  const sum = page.locator('#m-summary');
  await expect(sum).toContainText('或');
  await expect(sum).toContainText('非（');
  await expect(rows.nth(2)).toHaveClass(/neg/);
  await page.selectOption('#days', '90');
  await page.locator('#btn-manual').click();
  await expect(page.getByTestId('compare')).toBeVisible({ timeout: 60000 });
  const desc = page.getByTestId('strategy-desc');
  await expect(desc).toContainText('或');
  await expect(desc).toContainText('非（');
  await expect(page.getByTestId('diag')).toContainText('條件 3');
});

test('部位規則：共用資金池＋同時最多持倉、風險比例定位', async ({ page }) => {
  await page.goto('/index.html');
  await page.locator('[data-preset="5"]').click();
  await page.locator('#tab-manual').click();
  await page.selectOption('#m-template', 'overbought');
  await page.selectOption('#days', '90');
  await page.locator('#m-rules-adv summary').click();
  await expect(page.locator('#m-maxpos-field')).toBeHidden();
  await page.selectOption('#m-capmode', 'shared');
  await expect(page.locator('#m-maxpos-field')).toBeVisible();
  await page.fill('#m-maxpos', '2');
  await page.fill('#m-risk', '1');
  await expect(page.locator('#m-summary')).toContainText('共用資金池、同時最多持有 2 檔');
  await expect(page.locator('#m-summary')).toContainText('每筆停損最多虧帳戶淨值的 1%');
  await page.locator('#btn-manual').click();
  await expect(page.getByTestId('compare')).toBeVisible({ timeout: 60000 });
  await expect(page.getByTestId('strategy-desc')).toContainText('共用資金池·最多 2 檔');
  await expect(page.getByTestId('strategy-desc')).toContainText('每筆風險 1%');
  await expect(page.getByTestId('symbols')).toBeVisible();
  // 沒設停損卻要風險定位 → 清楚的錯誤
  await page.fill('#m-sl', '0');
  await page.locator('#btn-manual').click();
  await expect(page.locator('#run-error')).toContainText('停損');
});

test('自動搜尋也能用共用資金池與風險比例，並列入「進階設定已自訂」提醒', async ({ page }) => {
  await page.goto('/index.html');
  await page.locator('[data-preset="3"]').click();
  await page.locator('#s-rules-adv summary').click();
  await page.selectOption('#s-capmode', 'shared');
  await page.fill('#s-maxpos', '2'); await page.fill('#s-risk', '1');
  await expect(page.getByTestId('adv-note')).toContainText('共用資金池·最多 2 檔');
  await page.selectOption('#days', '90'); await page.selectOption('#s-budget', '30'); await page.fill('#s-min', '3');
  await page.locator('#btn-search').click();
  await expect(page.getByTestId('champ-netReturn')).toBeVisible({ timeout: 90000 });
  await expect(page.locator('#r-champions')).toContainText('共用資金池·最多 2 檔');
  await page.locator('#adv-reset').click();
  await expect(page.locator('#s-capmode')).toHaveValue('sleeve');
  await expect(page.getByTestId('adv-note')).toBeHidden();
});

test('參數敏感度：熱度圖、基準格標示、高原／孤島判斷與單一參數掃描', async ({ page }) => {
  await page.goto('/index.html');
  await page.locator('#tab-manual').click();
  await page.selectOption('#m-template', 'overbought');
  await page.selectOption('#days', '90');
  await page.locator('#btn-manual').click();
  await expect(page.getByTestId('compare')).toBeVisible({ timeout: 60000 });
  await page.locator('[data-ctab="sens"]').click();
  const sum = page.getByTestId('sens-summary');
  await expect(sum).toBeVisible({ timeout: 60000 });
  await expect(sum).toContainText('參數敏感度');
  await expect(page.locator('#sens table.sens td.base')).not.toHaveCount(0);
  await expect(page.locator('#sens')).toContainText('樣本外只能用來檢驗');
  await expect(page.getByTestId('sens-params')).toContainText('槓桿');
  await expect(page.getByTestId('sens-params')).toContainText('RSI');
  // 重新切換分頁不會再重算（直接顯示）
  await page.locator('[data-ctab="trades"]').click();
  await page.locator('[data-ctab="sens"]').click();
  await expect(page.getByTestId('sens-summary')).toBeVisible();
});

test('走動式驗證：多折、串接曲線、每折冠軍、可取消', async ({ page }) => {
  await page.goto('/index.html');
  await page.selectOption('#days', '365');
  await page.selectOption('#s-budget', '30'); await page.fill('#s-min', '3');
  await page.locator('#wf-adv summary').click();
  await page.selectOption('#wf-folds', '3');
  await page.locator('#btn-wf').click();
  const wf = page.getByTestId('wf');
  await expect(wf).toBeVisible({ timeout: 120000 });
  await expect(wf.locator('h2')).toContainText('結果');
  await expect(page.getByTestId('wf-folds').locator('tbody tr')).toHaveCount(3);
  await expect(page.getByTestId('wf-summary')).toContainText('串接後淨報酬');
  await expect(page.getByTestId('wf-summary')).toContainText('同期買入持有');
  await expect(page.getByTestId('wf-verdict')).toContainText('走動式驗證驗證的是整套流程');
  await expect(page.locator('#wf-chart canvas').first()).toBeVisible();
  await expect(page.locator('.card.charts')).toBeHidden();
  // 回到一般搜尋：走動式結果會被收起
  await page.locator('#btn-search').click();
  await expect(page.getByTestId('champ-netReturn')).toBeVisible({ timeout: 90000 });
  await expect(wf).toBeHidden();
});

test('走動式驗證可取消', async ({ page }) => {
  await page.goto('/index.html');
  await page.selectOption('#days', '365');
  await page.selectOption('#base-tf', '15m');
  await page.selectOption('#s-budget', '300'); await page.selectOption('#s-maxc', '4'); await page.fill('#s-min', '3');
  await page.locator('#wf-adv summary').click();
  await page.selectOption('#wf-folds', '6');
  await page.locator('#btn-wf').click();
  await expect(page.locator('#search-progress .ptext')).toContainText('折', { timeout: 120000 });
  await page.locator('#btn-cancel').click();
  await expect(page.locator('#run-error')).toContainText('已取消', { timeout: 20000 });
  await expect(page.locator('#btn-wf')).toBeEnabled();
});

test('手動：條件參數可輸入任意數字、不合理時提示並擋下回測、修正後可回測', async ({ page }) => {
  await page.goto('/index.html');
  await page.locator('#tab-manual').click();
  await page.selectOption('#m-template', 'golden'); // EMA 20/50 黃金交叉
  const row = page.locator('#m-entry .cond').first();
  const fast = row.locator('input.c-param[data-k="fast"]');
  const slow = row.locator('input.c-param[data-k="slow"]');
  await expect(fast).toHaveValue('20');
  await expect(slow).toHaveValue('50');
  // 快線大於慢線：即時提示，按回測會被擋下
  await fast.fill('80'); await fast.blur();
  await expect(row.locator('.cond-err')).toContainText('快線');
  await page.selectOption('#days', '90');
  await page.locator('#btn-manual').click();
  await expect(page.locator('#run-error')).toContainText('快線');
  // 改成合理值：說明文字更新，且輸入框沒有被重畫（仍可繼續輸入）
  await fast.fill('13'); await fast.blur();
  await expect(row.locator('.cond-err')).toHaveCount(0);
  await expect(row.locator('.cond-text')).toContainText('EMA13');
  await expect(fast).toHaveValue('13');
  await page.locator('#btn-manual').click();
  await expect(page.getByTestId('compare')).toBeVisible({ timeout: 60000 });
  await expect(page.getByTestId('strategy-desc')).toContainText('EMA13');
});

test('自動搜尋：開啟「同時搜尋指標參數」會顯示提醒、列入進階提醒；可一鍵恢復', async ({ page }) => {
  await page.goto('/index.html');
  await page.locator('[data-preset="3"]').click();
  await page.locator('#pane-search details.adv').first().locator('summary').click();
  await page.locator('#s-psearch').check();
  await expect(page.locator('#s-psearch-note')).toBeVisible();
  await expect(page.getByTestId('adv-note')).toContainText('同時搜尋指標參數');
  await page.selectOption('#days', '90'); await page.selectOption('#s-budget', '60'); await page.fill('#s-min', '3');
  await page.locator('#btn-search').click();
  await expect(page.getByTestId('champ-netReturn')).toBeVisible({ timeout: 90000 });
  await expect(page.locator('#r-title')).toBeVisible();
  await page.locator('#adv-reset').click();
  await expect(page.locator('#s-psearch')).not.toBeChecked();
  await expect(page.locator('#s-psearch-note')).toBeHidden();
});

test('儲存／匯出／我的回測：存 2 筆、並排比較（含設定不同警告）、載入設定、CSV／JSON 匯出匯入、刪除', async ({ page }) => {
  const fs = await import('node:fs');
  await page.goto('/index.html');
  await page.evaluate(() => localStorage.removeItem('bt.library.v1'));
  await page.reload();
  await page.locator('#tab-manual').click();
  await page.selectOption('#days', '90');
  await page.selectOption('#m-template', 'golden');
  await page.locator('#btn-manual').click();
  await expect(page.getByTestId('compare')).toBeVisible({ timeout: 60000 });
  await expect(page.getByTestId('actions')).toBeVisible();

  // 匯出 CSV：UTF-8 BOM、表頭、交易筆數與畫面一致
  const [dl] = await Promise.all([page.waitForEvent('download'), page.locator('[data-act="trades"]').click()]);
  expect(dl.suggestedFilename()).toMatch(/^trades-perp-\d{4}-\d{2}-\d{2}\.csv$/);
  const csv = fs.readFileSync(await dl.path(), 'utf8');
  expect(csv.charCodeAt(0)).toBe(0xfeff);
  expect(csv).toContain('#,期間,代號');
  const [dl2] = await Promise.all([page.waitForEvent('download'), page.locator('[data-act="equity"]').click()]);
  expect(fs.readFileSync(await dl2.path(), 'utf8')).toContain('策略淨值');

  // 第一筆
  await page.locator('[data-act="save"]').click();
  await expect(page.locator('#toast')).toContainText('已儲存');
  await expect(page.locator('#lib-count')).toHaveText('1');
  // 第二筆：換範本、手續費不同
  await page.selectOption('#m-template', 'oversold');
  await page.locator('#feePct').evaluate((el) => { el.closest('details').open = true; });
  await page.fill('#feePct', '0.1');
  await page.locator('#btn-manual').click();
  await expect(page.getByTestId('compare')).toBeVisible({ timeout: 60000 });
  await page.locator('[data-act="save"]').click();
  await expect(page.locator('#lib-count')).toHaveText('2');

  // 清單與並排比較
  await page.locator('#btn-library').click();
  const dlg = page.getByTestId('library');
  await expect(dlg.locator('.lib-item')).toHaveCount(2);
  await expect(dlg.locator('[data-lib="compare"]')).toBeDisabled();
  await dlg.locator('[data-lib-sel]').nth(0).check();
  await dlg.locator('[data-lib-sel]').nth(1).check();
  await dlg.locator('[data-lib="compare"]').click();
  await expect(dlg.getByTestId('cmp-table')).toBeVisible();
  await expect(dlg.getByTestId('cmp-warn')).toContainText('手續費');
  await expect(dlg.getByTestId('cmp-chart')).toBeVisible();
  await expect(dlg.getByTestId('cmp-table')).toContainText('淨報酬');
  await dlg.locator('input[name="lib-seg"][value="train"]').check();
  await expect(dlg.getByTestId('cmp-table')).toBeVisible();
  await dlg.locator('[data-lib="back"]').first().click();

  // 單筆匯出 → 刪除 → 匯入還原
  const [dl3] = await Promise.all([page.waitForEvent('download'), dlg.locator('[data-lib="export"]').first().click()]);
  const jsonPath = await dl3.path();
  const obj = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  expect(obj.v).toBe(1);
  expect(obj.market).toBe('perp');
  page.once('dialog', (d) => d.accept());
  await dlg.locator('[data-lib="delete"]').first().click();
  await expect(dlg.locator('.lib-item')).toHaveCount(1);
  await expect(page.locator('#lib-count')).toHaveText('1');
  await dlg.locator('#lib-file').setInputFiles(jsonPath);
  await expect(dlg.locator('.lib-item')).toHaveCount(2);
  // 壞檔：明確提示、不變動
  fs.writeFileSync(jsonPath + '.bad', '{"v":1,"market":"x"}');
  await dlg.locator('#lib-file').setInputFiles(jsonPath + '.bad');
  await expect(page.locator('#toast')).toContainText('匯入失敗');
  await expect(dlg.locator('.lib-item')).toHaveCount(2);

  // 載入設定：天數與策略回到儲存時的樣子
  await page.keyboard.press('Escape');
  await page.selectOption('#days', '30');
  await page.fill('#feePct', '0.3');
  await page.locator('#btn-library').click();
  await dlg.locator('[data-lib="load"]').first().click();
  await expect(dlg).toBeHidden();
  await expect(page.locator('#days')).toHaveValue('90');
  await expect(page.locator('#feePct')).not.toHaveValue('0.3');
  await expect(page.locator('#tab-manual')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#m-entry .cond')).toHaveCount(1);

  // 重新整理後仍在
  await page.reload();
  await expect(page.locator('#lib-count')).toHaveText('2');
});

test('注意事項：免責列連結直接開到注意事項頁；自動搜尋有排行榜 CSV；走動式有 CSV', async ({ page }) => {
  const fs = await import('node:fs');
  await page.goto('/index.html');
  await page.locator('.disclaimer .linkbtn').click();
  const dlg = page.getByTestId('tutorial');
  await expect(dlg).toContainText('注意事項（請務必看）');
  await expect(dlg).toContainText('倖存者偏差');
  await expect(dlg).toContainText('我的回測');
  await page.keyboard.press('Escape');

  await page.locator('[data-preset="3"]').click();
  await page.selectOption('#days', '90'); await page.selectOption('#s-budget', '30'); await page.fill('#s-min', '3');
  await page.locator('#btn-search').click();
  await expect(page.getByTestId('champ-netReturn')).toBeVisible({ timeout: 90000 });
  const [dl] = await Promise.all([page.waitForEvent('download'), page.locator('[data-act="board"]').click()]);
  const csv = fs.readFileSync(await dl.path(), 'utf8');
  expect(csv).toContain('訓練期淨報酬');
  expect(csv.split('\r\n').length).toBeGreaterThan(5);

  await page.locator('#wf-adv summary').click();
  await page.locator('#btn-wf').click();
  await page.getByTestId('wf').waitFor({ timeout: 120000 });
  const [dl2] = await Promise.all([page.waitForEvent('download'), page.locator('[data-act="wf-folds"]').click()]);
  expect(fs.readFileSync(await dl2.path(), 'utf8')).toContain('採用策略');
  const [dl3] = await Promise.all([page.waitForEvent('download'), page.locator('[data-act="wf-chain"]').click()]);
  expect(fs.readFileSync(await dl3.path(), 'utf8')).toContain('走動式驗證淨值');
});

test('策略能力：ATR 單位＋分批出場＋加碼（手動），說明文字、交易表、K 線標記與驗證訊息', async ({ page }) => {
  await page.goto('/index.html');
  await page.locator('#tab-manual').click();
  await page.selectOption('#m-template', 'atr');
  await expect(page.locator('#m-unit')).toHaveValue('atr');
  await expect(page.locator('#m-atr-field')).toBeVisible();
  await expect(page.locator('#m-unit-note')).toContainText('ATR');
  await expect(page.locator('#m-so-on')).toBeChecked();
  await expect(page.locator('#m-summary')).toContainText('×ATR');
  await expect(page.locator('#m-summary')).toContainText('分批出場');
  // 加碼：順勢，需要資金 → 每筆投入比例調低
  await page.locator('#feePct').evaluate((el) => { el.closest('details').open = true; });
  await page.fill('#posPct', '50');
  await page.selectOption('#m-si-mode', 'favor');
  await page.fill('#m-si-step', '1'); await page.fill('#m-si-count', '2'); await page.fill('#m-si-size', '50');
  await expect(page.locator('#m-summary')).toContainText('順勢加碼');
  // 不合理：第一目標比最終停利還遠
  await page.fill('#m-so-at', '9');
  await page.selectOption('#days', '90');
  await page.locator('#btn-manual').click();
  await expect(page.locator('#run-error')).toContainText('更近');
  await page.fill('#m-so-at', '1.5');
  await page.locator('#btn-manual').click();
  await expect(page.getByTestId('compare')).toBeVisible({ timeout: 60000 });
  await expect(page.getByTestId('strategy-desc')).toContainText('分批出場');
  await expect(page.getByTestId('strategy-desc')).toContainText('×ATR');
  await expect(page.getByTestId('diag')).toContainText('ATR');
});

test('策略能力：雙向反手（手動）— 可設定做空條件、回測出現多空兩邊的交易與反手', async ({ page }) => {
  await page.goto('/index.html');
  await page.locator('#tab-manual').click();
  await page.selectOption('#m-template', 'dual');
  await expect(page.locator('#m-entryB-box')).toBeVisible();
  await expect(page.locator('#m-entryB .cond')).toHaveCount(1);
  await expect(page.locator('#m-summary')).toContainText('反向開倉');
  // 把 RSI 門檻放寬，讓兩邊訊號都夠多
  await page.locator('#m-entry .c-param[data-k="level"]').fill('45');
  await page.locator('#m-entryB .c-param[data-k="level"]').fill('55');
  await page.selectOption('#days', '90');
  await page.locator('#btn-manual').click();
  await expect(page.getByTestId('compare')).toBeVisible({ timeout: 60000 });
  await expect(page.getByTestId('strategy-desc')).toContainText('雙向反手');
  await page.locator('[data-ctab="trades"]').click();
  await expect(page.getByTestId('trades')).toContainText('反手');
  await expect(page.getByTestId('trades')).toContainText('做空');
  await expect(page.getByTestId('trades')).toContainText('做多');
  // 現貨不支援雙向
  await page.locator('[data-market="spot"]').click();
  await expect(page.locator('[data-dir="both"]')).toBeDisabled();
});

test('策略能力：自動搜尋可用 ATR 倍數單位（預設倍數），冠軍描述含 ×ATR', async ({ page }) => {
  await page.goto('/index.html');
  await page.locator('[data-preset="3"]').click();
  await page.locator('#pane-search details.adv').first().locator('summary').click();
  await page.selectOption('#s-unit', 'atr');
  await expect(page.locator('#s-unit-note')).toContainText('ATR 模式');
  await expect(page.getByTestId('adv-note')).toContainText('ATR 倍數');
  await page.selectOption('#days', '90'); await page.selectOption('#s-budget', '30'); await page.fill('#s-min', '3');
  await page.locator('#btn-search').click();
  await expect(page.getByTestId('champ-netReturn')).toBeVisible({ timeout: 90000 });
  await expect(page.locator('#r-champions')).toContainText('×ATR');
});

test('可信度檢定：手動回測有 p 值表、分布圖、白話結論、MAE/MFE，可換亂數；自動搜尋冠軍顯示多重檢定校正', async ({ page }) => {
  await page.goto('/index.html');
  await page.locator('#tab-manual').click();
  await page.selectOption('#m-template', 'oversold');
  await page.locator('#m-entry .c-param[data-k="level"]').fill('45');
  await page.selectOption('#days', '90');
  await page.locator('#btn-manual').click();
  await expect(page.getByTestId('compare')).toBeVisible({ timeout: 60000 });
  await page.locator('[data-ctab="robust"]').click();
  const box = page.getByTestId('robust');
  await expect(box.getByTestId('robust-table')).toBeVisible({ timeout: 20000 });
  await expect(box.getByTestId('robust-verdict').locator('li').first()).toBeVisible();
  await expect(box.getByTestId('robust-multiple')).toContainText('K＝1');
  await expect(box.locator('svg.robust-svg').first()).toBeVisible();
  await expect(box).toContainText('最大浮虧');
  const before = await box.getByTestId('robust-table').innerText();
  await box.locator('[data-robust="reseed"]').click();
  await expect(box.getByTestId('robust-table')).toBeVisible({ timeout: 20000 });
  const after = await box.getByTestId('robust-table').innerText();
  expect(after.length).toBeGreaterThan(20);
  void before;
  // 搜尋 → 冠軍詳細頁：多重檢定要顯示「從 N 組候選挑出」
  await page.locator('#tab-search').click();
  await page.locator('[data-preset="3"]').click();
  await page.selectOption('#s-budget', '30'); await page.fill('#s-min', '3');
  await page.locator('#btn-search').click();
  await expect(page.getByTestId('champ-netReturn')).toBeVisible({ timeout: 90000 });
  await page.getByTestId('champ-netReturn').locator('[data-open]').first().click();
  await expect(page.getByTestId('compare')).toBeVisible({ timeout: 60000 });
  await page.locator('[data-ctab="robust"]').click();
  await expect(page.getByTestId('robust').getByTestId('robust-multiple')).toContainText('候選裡挑出來', { timeout: 20000 });
});

test('市場研究：行情分析（目前行情與占比）、價格行為掃描（誠實的摘要、表格、CSV）、把行為建立成手動策略', async ({ page }) => {
  const fs = await import('node:fs');
  await page.goto('/index.html');
  await page.locator('#tab-study').click();
  await expect(page.locator('#pane-study')).toBeVisible();
  await page.selectOption('#days', '90');
  await page.locator('#btn-regime').click();
  const box = page.getByTestId('study');
  await expect(box.getByTestId('regime-table')).toBeVisible({ timeout: 60000 });
  await expect(box.getByTestId('regime-now')).toContainText('目前');
  await expect(box.getByTestId('regime-table').locator('tbody tr')).toHaveCount(2);
  // 門檻不合理 → 明確錯誤
  await page.fill('#st-range', '0.5');
  await page.locator('#btn-regime').click();
  await expect(page.locator('#run-error')).toContainText('小於');
  await page.fill('#st-range', '0.12');
  await page.locator('#st-h input[value="48"]').uncheck();
  await page.fill('#st-min', '8');
  await page.locator('#btn-scan').click();
  await expect(box.getByTestId('scan-summary')).toBeVisible({ timeout: 90000 });
  await expect(box.getByTestId('scan-summary')).toContainText(/沒有找到|通過篩選|確認/);
  await expect(box).toContainText('扣掉手續費');
  await expect(box).toContainText('預期有約');
  await box.locator('input[name="scan-filter"][value="all"]').check();
  await expect(box.getByTestId('scan-table').locator('tbody tr').first()).toBeVisible();
  const [dl] = await Promise.all([page.waitForEvent('download'), box.locator('[data-scan-csv]').click()]);
  const csv = fs.readFileSync(await dl.path(), 'utf8');
  expect(csv).toContain('訓練平均淨報酬');
  // 建立策略 → 手動分頁，持有根數變成最長持倉
  await box.locator('[data-scan-build]').first().click();
  await expect(page.locator('#tab-manual')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#m-entry .cond').first()).toBeVisible();
  const mb = Number(await page.locator('#m-maxbars').inputValue());
  expect(mb).toBeGreaterThan(0);
  await expect(page.locator('#toast')).toContainText('已建立手動策略');
  await page.locator('#btn-manual').click();
  await expect(page.getByTestId('compare')).toBeVisible({ timeout: 60000 });
  // 行情分析分頁：這個策略的交易在哪種行情賺賠
  await page.locator('[data-ctab="regime"]').click();
  await expect(page.getByTestId('regime-tab').getByTestId('regime-trades')).toBeVisible();
  await expect(page.getByTestId('regime-tab')).toContainText('進場時的行情');
});

test('斐波那契：可在手動策略選「上升波段回檔到斐波那契位」、調整比例與轉折參數並回測', async ({ page }) => {
  await page.goto('/index.html');
  await page.locator('#tab-manual').click();
  await page.selectOption('#m-template', 'oversold');
  const row = page.locator('#m-entry .cond').first();
  await row.locator('.c-id').selectOption('fib_pullback');
  await expect(row.locator('input.c-param')).toHaveCount(4);
  await expect(row.locator('.cond-text')).toContainText('斐波那契');
  await expect(row.locator('.cond-text')).toContainText('61.8%');
  await row.locator('input.c-param[data-k="level"]').fill('0.5');
  await row.locator('input.c-param[data-k="level"]').blur();
  await expect(row.locator('.cond-text')).toContainText('50%');
  await page.selectOption('#days', '90');
  await page.locator('#btn-manual').click();
  await expect(page.getByTestId('compare')).toBeVisible({ timeout: 60000 });
  await expect(page.getByTestId('strategy-desc')).toContainText('斐波那契');
});

test('停損停利以「本金 %」與「ROE %」設定：即時換算成價格幅度、回測說明與診斷、自動搜尋預設值', async ({ page }) => {
  await page.goto('/index.html');
  await page.locator('#tab-manual').click();
  await page.selectOption('#m-template', 'oversold');
  await page.locator('#m-entry .c-param[data-k="level"]').fill('45');
  await page.selectOption('#m-unit', 'capital');
  await page.fill('#m-sl', '2'); await page.fill('#m-tp', '4');
  await page.locator('#feePct').evaluate((el) => { el.closest('details').open = true; });
  await page.fill('#posPct', '50');
  const note = page.locator('#m-unit-note');
  await expect(note).toBeVisible();
  await expect(note).toContainText('本金 % 單位');
  await expect(note).toContainText('停損 2% 本金 ≈ 價格 4.00%');
  await expect(note).toContainText('停利 4% 本金 ≈ 價格 8.00%');
  await page.selectOption('#days', '90');
  await page.locator('#btn-manual').click();
  await expect(page.getByTestId('compare')).toBeVisible({ timeout: 60000 });
  await expect(page.getByTestId('strategy-desc')).toContainText('停損 2%本金');
  await expect(page.getByTestId('diag')).toContainText('≈ 價格');
  // 不能和「每筆風險」一起用
  await page.locator('#m-rules-adv summary').click();
  await page.fill('#m-risk', '1');
  await page.locator('#btn-manual').click();
  await expect(page.locator('#run-error')).toContainText('每筆風險');
  await page.fill('#m-risk', '0');
  // ROE：槓桿 5 → 停損 ROE 20% ≈ 價格 4%
  await page.selectOption('#m-unit', 'roe');
  await page.locator('#m-lev').fill('5');
  await page.fill('#m-sl', '20'); await page.fill('#m-tp', '40');
  await expect(note).toContainText('停損 ROE 20% ≈ 價格 4.00%');
  await page.locator('#btn-manual').click();
  await expect(page.getByTestId('strategy-desc')).toContainText('保證金報酬', { timeout: 60000 });
  // 現貨沒有 ROE
  await page.locator('[data-market="spot"]').click();
  await expect(page.locator('#m-unit option[value="roe"]')).toBeDisabled();
  await expect(page.locator('#m-unit')).toHaveValue('pct');
});

test('自動搜尋：停損停利單位選「本金 %」，用預設比例搜尋，冠軍描述含 %本金', async ({ page }) => {
  await page.goto('/index.html');
  await page.locator('[data-preset="3"]').click();
  await page.locator('#pane-search details.adv').first().locator('summary').click();
  await page.selectOption('#s-unit', 'capital');
  await expect(page.locator('#s-unit-note')).toContainText('本金 % 模式');
  await expect(page.getByTestId('adv-note')).toContainText('本金 %');
  await page.selectOption('#days', '90'); await page.selectOption('#s-budget', '30'); await page.fill('#s-min', '3');
  await page.locator('#btn-search').click();
  await expect(page.getByTestId('champ-netReturn')).toBeVisible({ timeout: 90000 });
  await expect(page.locator('#r-champions')).toContainText('%本金');
});
