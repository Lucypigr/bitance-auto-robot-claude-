import { test as base, expect } from '@playwright/test';
import { FakeBinance } from '../helpers/fake-binance.js';

/** 攔截所有 Binance 請求，回傳合成行情（沙盒與 CI 不需要真的連網） */
export const test = base.extend({
  fake: async ({}, use) => { await use(new FakeBinance({ nowMs: Date.now() })); },
  page: async ({ page, fake }, use) => {
    await page.route(/(binance\.com|binance\.vision)/, async (route) => {
      const { status, body } = fake.handle(route.request().url());
      await route.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
    });
    page.on('pageerror', (e) => { throw e; });
    await use(page);
  },
});
export { expect };
