// Usage: set PLAYWRIGHT_MODULE if Playwright is not installed locally.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const path = require('node:path');
const fs = require('node:fs');
(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  const out = path.resolve(__dirname, '../docs/screenshots');
  fs.mkdirSync(out, { recursive: true });
  const base = process.env.SCREENSHOT_BASE_URL || 'http://127.0.0.1:5173';
  async function shot(name) {
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: path.join(out, name), type: 'jpeg', quality: 88, animations: 'disabled' });
    console.log(name);
  }
  await page.goto(base, { waitUntil: 'networkidle' });
  await shot('01-landing.jpg');
  await page.locator('#cta-start').click();
  await page.locator('#plan-city').fill('武汉');
  await page.locator('.hotel-picker input[type=search]').fill('中交五洲皇冠');
  await page.locator('.hotel-picker').getByRole('button', { name: '搜索酒店', exact: true }).click();
  await page.locator('.hotel-picker__results button').first().waitFor({ timeout: 20000 });
  await page.locator('.hotel-picker__results button').first().click();
  if (!await page.locator('#plan-sheet').isVisible()) throw new Error('Hotel selection closed the form');
  await page.locator('.hotel-picker').scrollIntoViewIfNeeded();
  await shot('10-hotel-picker.jpg');
  await page.goto(base + '/trip.html', { waitUntil: 'networkidle' });
  await shot('02-trip-overview.jpg');
  await page.locator('#daybar button').nth(1).click();
  await shot('11-day-collapsed.jpg');
  await page.locator('#day-intro > summary').click();
  await shot('12-day-expanded.jpg');
  await page.locator('#prep-open').click();
  await shot('07-prep-drawer.jpg');
  await page.locator('#drawer-close').click();
  await page.evaluate(() => window.TripExport.prepare());
  await page.emulateMedia({ media: 'print' });
  await page.locator('.sheet__cover').screenshot({ path: path.join(out, '08-export-cover.jpg'), type: 'jpeg', quality: 88 });
  await page.locator('.sheet__day').first().screenshot({ path: path.join(out, '09-export-day.jpg'), type: 'jpeg', quality: 88 });
  await browser.close();
})().catch(error => { console.error(error); process.exit(1); });
