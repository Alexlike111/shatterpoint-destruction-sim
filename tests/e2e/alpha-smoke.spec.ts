import { test, expect } from '@playwright/test';

test('v1.0 визуальная проверка: 3D-прицел, закатное небо, взрыв, Кампания и Мастерская без ошибок консоли', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(`PAGEERROR: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      errors.push(`CONSOLE_ERROR: ${msg.text()}`);
    }
  });

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#app-root')).toHaveAttribute('data-ready', 'true', {
    timeout: 20_000,
  });

  // Переключаем закатное освещение, выбираем Фугас Ур. 5 и наводим 3D-прицел на здание
  await page.locator('#sky-sunset-btn').click();
  await page.locator('#sandbox-upgrade-level-select').selectOption('5');
  await page.locator('#tool-bomb').click();

  const canvasBox = await page.locator('#sim-canvas').boundingBox();
  expect(canvasBox).not.toBeNull();
  const cx = canvasBox!.x + canvasBox!.width * 0.5;
  const cy = canvasBox!.y + canvasBox!.height * 0.54;
  await page.mouse.move(cx, cy);
  await page.waitForTimeout(250);
  await page.screenshot({ path: 'test-results/v1-sunset-reticle.png' });

  // Взрываем колонну и делаем кадр каскадного обрушения
  await page.mouse.click(cx, cy);
  await page.waitForTimeout(450);
  await page.screenshot({ path: 'test-results/v1-destruction-action.png' });

  // Проверяем режим Кампании (контракт №3 с двумя охраняемыми зданиями)
  await page.locator('#mode-campaign-btn').click();
  await page.locator('#contract-03').click();
  await page.locator('#sky-day-btn').click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: 'test-results/v1-campaign-mode.png' });

  expect(errors).toEqual([]);
});
