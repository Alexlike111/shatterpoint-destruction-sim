import { defineConfig } from '@playwright/test';

/**
 * Конфигурация сквозного E2E-тестирования «ТОЧКА РАЗЛОМА» (shatterpoint-destruction-sim).
 *
 * Архитектурные инварианты среды:
 * - Реальный браузер: системный /usr/lib/chromium/chromium с честным WebGL2 поверх ANGLE + SwiftShader.
 * - Строго без длинного кастомного профиля userDataDir (защита от лимита UNIX_PATH_MAX = 108 байт).
 * - Нулевая зависимость от @types/node (без обращения к process, Buffer, __dirname, node:*).
 * - 1 воркер и deviceScaleFactor = 1 для предсказуемого времени кадра на 2-ядерной CPU VM.
 * - Единый проект 'chromium-webgl2' с общим testDir './tests/e2e' для бесшовного запуска
 *   как всего пакета (npm run test:e2e), так и отдельных папок уровней (tier1..tier5).
 */
const CHROMIUM_WEBGL2_LAUNCH_OPTIONS = {
  executablePath: '/usr/lib/chromium/chromium',
  args: [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
  ],
};

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.spec.ts',
  outputDir: './test-results',

  fullyParallel: false,
  workers: 1,
  retries: 0,

  timeout: 45_000,
  expect: {
    timeout: 10_000,
  },

  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
  ],

  use: {
    baseURL: 'http://localhost:5175',
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
    locale: 'ru-RU',
    headless: true,
    launchOptions: CHROMIUM_WEBGL2_LAUNCH_OPTIONS,
    actionTimeout: 10_000,
    navigationTimeout: 20_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },

  projects: [
    {
      name: 'chromium-webgl2',
      use: {
        browserName: 'chromium',
        launchOptions: CHROMIUM_WEBGL2_LAUNCH_OPTIONS,
      },
    },
  ],

  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:5175',
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
