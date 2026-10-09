import { test, expect } from './fixtures.js';

test('首頁載入、繁體中文、ⓘ 說明存在、無錯誤', async ({ page }) => {
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto('/index.html');
  await expect(page.locator('h1')).toHaveText('幣安回測平台');
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-Hant');
  expect(await page.locator('button.ibtn').count()).toBeGreaterThan(10);
  await expect(page.locator('#sym-list .sym-item').first()).toBeVisible();
  expect(errors).toEqual([]);
});

test('ⓘ：滑鼠移上去顯示白話說明與常見誤解；點擊可釘住；Esc 關閉', async ({ page }) => {
  await page.goto('/index.html');
  const btn = page.locator('#guide ~ #step1 button.ibtn[data-term="execution_tf"]').first();
  await btn.hover();
  const pop = page.locator('#info-pop');
  await expect(pop).toBeVisible();
  await expect(pop).toContainText('執行週期');
  await expect(pop).toContainText('常見誤解');
  await page.mouse.move(5, 500);
  await expect(pop).toBeHidden();
  await btn.click();
  await expect(pop).toBeVisible();
  await page.mouse.move(5, 500);
  await page.waitForTimeout(400);
  await expect(pop).toBeVisible(); // 點擊後釘住
  await page.keyboard.press('Escape');
  await expect(pop).toBeHidden();
});

test('主要專有名詞都有 ⓘ（RSI、超買、超賣、PF、Sharpe、回撤、樣本外、槓桿、Funding、清算）', async ({ page }) => {
  await page.goto('/index.html');
  await page.locator('#tab-manual').click();
  await page.selectOption('#m-template', 'overbought');
  await page.selectOption('#days', '90');
  await page.locator('#btn-manual').click();
  await expect(page.getByTestId('compare')).toBeVisible({ timeout: 60000 });
  const terms = await page.locator('button.ibtn').evaluateAll((els) => [...new Set(els.map((e) => e.dataset.term))]);
  for (const t of ['rsi_overbought', 'rsi_oversold', 'pf', 'sharpe', 'sortino', 'drawdown', 'oos', 'leverage', 'funding', 'liquidation', 'winrate', 'cagr', 'training']) {
    expect(terms, `缺少 ${t}`).toContain(t);
  }
});

test('ⓘ 說明含指標／K 線型態的示意圖；手動條件列與指標池也看得到', async ({ page }) => {
  await page.goto('/index.html');
  await page.locator('#tab-manual').click();
  await page.selectOption('#m-template', 'mtf');
  // 條件列右側有縮圖
  await expect(page.locator('#m-entry .cond-thumb svg')).toHaveCount(3);
  // 流星線的 ⓘ：示意圖 + 說明
  const star = page.locator('#m-entry button.ibtn[data-ill="pat_shooting_star"]');
  await star.hover();
  const pop = page.locator('#info-pop');
  await expect(pop.locator('figure.pop-illus svg')).toBeVisible();
  await expect(pop).toContainText('示意圖');
  await expect(pop).toContainText('流星');
  await page.mouse.move(5, 600);
  // 指標池中的每個條件都有 ⓘ 與圖
  await page.locator('#tab-search').click();
  await page.locator('#pool-adv summary').click();
  const hammer = page.locator('#s-pool button.ibtn[data-ill="pat_hammer"]');
  await hammer.click();
  await expect(pop.locator('figure.pop-illus svg')).toBeVisible();
  await expect(page.locator('input[name="s-pool"][value="pat_hammer"]')).toBeChecked(); // 點 ⓘ 不會誤勾選
  await page.keyboard.press('Escape');
  const kd = page.locator('#s-pool button.ibtn[data-ill="kd_golden"]');
  await kd.click();
  await expect(pop.locator('figure.pop-illus svg')).toBeVisible();
});

test('新手篇：可開啟、翻頁、鍵盤關閉；一鍵示範會開始搜尋', async ({ page }) => {
  await page.goto('/index.html');
  await page.locator('#btn-tutorial').click();
  const dlg = page.getByTestId('tutorial');
  await expect(dlg).toBeVisible();
  await expect(dlg).toContainText('回測是什麼');
  await expect(dlg.locator('.ibtn').first()).toBeAttached();
  await dlg.locator('.tut-next').click();
  await expect(dlg).toContainText('第一次操作');
  await page.keyboard.press('Escape');
  await expect(dlg).toBeHidden();
  await page.locator('#btn-tutorial2').click();
  await dlg.locator('.tut-dot').nth(1).click();
  await dlg.locator('[data-tut-demo]').click();
  await expect(dlg).toBeHidden();
  await expect(page.locator('#r-title')).toBeVisible({ timeout: 120000 });
});
