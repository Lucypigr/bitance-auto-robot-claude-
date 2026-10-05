import { test, expect } from './fixtures.js';

test('手機：版面不橫向捲動，ⓘ 點擊顯示說明並可關閉', async ({ page }) => {
  await page.goto('/index.html');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  const btn = page.locator('#step1 button.ibtn[data-term="execution_tf"]').first();
  await btn.tap();
  const pop = page.locator('#info-pop');
  await expect(pop).toBeVisible();
  await expect(pop).toContainText('常見誤解');
  const box = await pop.boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize().width + 1);
  await pop.locator('.pop-close').tap();
  await expect(pop).toBeHidden();
});

test('手機：可完成一次手動回測', async ({ page }) => {
  await page.goto('/index.html');
  await page.locator('#tab-manual').tap();
  await page.selectOption('#m-template', 'overbought');
  await page.selectOption('#days', '90');
  await page.locator('#btn-manual').tap();
  await expect(page.getByTestId('compare')).toBeVisible({ timeout: 60000 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});
