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
