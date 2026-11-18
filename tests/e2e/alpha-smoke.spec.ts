import { test, expect } from '@playwright/test';

test('v0.1 Alpha загружается, рендерит 3D-сцену и стреляет без ошибок консоли', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(`PAGEERROR: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      errors.push(`CONSOLE_ERROR: ${msg.text()}`);
    }
  });

  await page.goto('http://localhost:5180', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#app-root')).toHaveAttribute('data-ready', 'true', { timeout: 20_000 });

  // Убедимся, что тики физики идут
  await page.waitForTimeout(600);
  const tick1 = Number(await page.locator('#app-root').getAttribute('data-sim-tick'));
  expect(tick1).toBeGreaterThan(5);

  // Выстрелим из пушки в центр экрана
  const box = await page.locator('#sim-canvas').boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.click(box!.x + box!.width * 0.5, box!.y + box!.height * 0.52);
  await page.waitForTimeout(700);

  expect(errors).toEqual([]);
});
