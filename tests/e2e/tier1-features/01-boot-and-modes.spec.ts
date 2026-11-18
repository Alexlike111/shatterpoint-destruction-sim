import { test, expect, SELECTORS } from '../helpers/shatterpoint-harness';
import type { QualityPreset } from '../helpers/shatterpoint-harness';

test.describe('Уровень 1 — R01: Инициализация приложения, реальный WebGL2, пресеты качества и русский UI', () => {
  test('[R01][F01][F02][F23] Холодный старт приложения, инициализация WASM-ядра Rapier3D и продвижение тиков без ошибок консоли', async ({
    harness,
  }) => {
    const t0 = await harness.boot({ preset: null });

    const root = harness.page.locator(SELECTORS.appRoot);
    await expect(root).toBeVisible();
    await harness.assertCanonicalAppRootAttributes();

    const rootState0 = await harness.getAppRootState();
    expect(rootState0.ready).toBe(true);
    expect(['campaign', 'sandbox', 'lab']).toContain(rootState0.activeMode);
    expect(rootState0.paused).toBe(false);
    expect(rootState0.timeScale).toBeGreaterThan(0);
    expect(rootState0.renderMode).toBe('pbr');

    const bridgeTypes = await harness.page.evaluate(() => ({
      hasGetTelemetry: typeof window.__SHATTERPOINT__?.getTelemetry === 'function',
      hasProjectWorldPoint: typeof window.__SHATTERPOINT__?.projectWorldPoint === 'function',
    }));
    expect(bridgeTypes.hasGetTelemetry).toBe(true);
    expect(bridgeTypes.hasProjectWorldPoint).toBe(true);

    const t1 = await harness.waitForSimTicks(12);
    const rootState1 = await harness.getAppRootState();

    expect(t1.tick).toBeGreaterThanOrEqual(t0.tick + 10);
    expect(t1.simTimeSec).toBeGreaterThan(t0.simTimeSec);
    expect(rootState1.simTick).toBeGreaterThan(rootState0.simTick);
    expect(rootState1.simTick).toBeGreaterThanOrEqual(t0.tick + 10);
    harness.assertZeroRuntimeErrors('холодного старта и тиков WASM-ядра');
  });

  test('[R01][F13] Активный контекст WebGL2 на #sim-canvas, бюджет Draw Calls и непустой рендер 3D-сцены', async ({
    harness,
  }) => {
    await harness.boot({ preset: null });
    await harness.switchMode('sandbox');
    await harness.waitForSimTicks(6);

    const canvas = harness.page.locator(SELECTORS.simCanvas);
    await expect(canvas).toBeVisible();
    const box = await canvas.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThanOrEqual(640);
    expect(box!.height).toBeGreaterThanOrEqual(400);

    const glReport = await harness.verifyWebGL2Context();
    expect(glReport.hasWebGL2).toBe(true);
    expect(glReport.contextLost).toBe(false);
    expect(glReport.version).toContain('WebGL 2.0');
    expect(glReport.drawCalls).toBeGreaterThan(0);
    expect(glReport.drawCalls).toBeLessThanOrEqual(120);

    const pngBytes = await harness.captureCanvasPngBytes();
    expect(pngBytes.byteLength).toBeGreaterThan(2500);

    // Проверяем в браузере через стандартный ImageBitmap, что кадр имеет реальную цветовую вариативность
    const uniqueColorBuckets = await harness.page.evaluate(async (rawBytes: number[]) => {
      const u8 = new Uint8Array(rawBytes);
      const blob = new Blob([u8], { type: 'image/png' });
      const bitmap = await window.createImageBitmap(blob);
      const probe = document.createElement('canvas');
      probe.width = 48;
      probe.height = 27;
      const ctx = probe.getContext('2d');
      if (!ctx) return 0;
      ctx.drawImage(bitmap, 0, 0, probe.width, probe.height);
      const data = ctx.getImageData(0, 0, probe.width, probe.height).data;
      const buckets = new Set<string>();
      for (let i = 0; i < data.length; i += 4) {
        const qr = data[i] >> 4;
        const qg = data[i + 1] >> 4;
        const qb = data[i + 2] >> 4;
        buckets.add(`${qr}-${qg}-${qb}`);
      }
      bitmap.close();
      return buckets.size;
    }, Array.from(pngBytes));

    expect(uniqueColorBuckets).toBeGreaterThan(3);
  });

  test('[R01][F13] Переключение графических пресетов #quality-select (performance, high, ultra) без потери WebGL2-контекста', async ({
    harness,
  }) => {
    await harness.boot({ preset: null });
    await harness.switchMode('sandbox');

    const qualitySelect = harness.page.locator(SELECTORS.qualitySelect);
    await expect(qualitySelect).toBeVisible();

    const options = await harness.listSelectOptions(SELECTORS.qualitySelect);
    expect(options.length).toBeGreaterThanOrEqual(3);

    const presets: QualityPreset[] = ['performance', 'high', 'ultra'];
    const selectedValues: string[] = [];

    for (const preset of presets) {
      const tBefore = await harness.getTelemetry();
      const chosenOpt = await harness.setQualityPreset(preset);
      const currentVal = await qualitySelect.inputValue();
      expect(currentVal).toBe(chosenOpt.value);
      selectedValues.push(currentVal);

      const tAfter = await harness.waitForSimTicks(6);
      await harness.waitForAnimationFrames(2);
      const glReport = await harness.verifyWebGL2Context();
      const frameBytes = await harness.captureCanvasPngBytes();

      expect(glReport.contextLost).toBe(false);
      expect(glReport.drawCalls).toBeGreaterThan(0);
      expect(glReport.drawingBufferWidth).toBeGreaterThan(100);
      expect(glReport.drawingBufferHeight).toBeGreaterThan(100);
      expect(frameBytes.byteLength).toBeGreaterThan(2500);
      expect(tAfter.tick).toBeGreaterThan(tBefore.tick);
      harness.assertZeroRuntimeErrors(`переключения пресета качества ${preset}`);
    }

    expect(new Set(selectedValues).size).toBe(3);
    await harness.setQualityPreset('performance');
  });

  test('[R01][F22] Полная русскоязычная локализация кнопок режимов, арсенала, стендов и панелей управления', async ({
    harness,
  }) => {
    await harness.boot();

    const docMeta = await harness.page.evaluate(() => ({
      lang: document.documentElement.lang || '',
      title: document.title || '',
    }));
    expect(docMeta.lang.toLowerCase()).toMatch(/^ru/);
    expect(docMeta.title).toMatch(/[А-Яа-яЁё]/);

    // Проверяем подписи в режиме Кампании
    await harness.switchMode('campaign');
    const campaignAudit = await harness.auditRussianUiAndNoPurple();
    expect(campaignAudit.hasCyrillicText).toBe(true);
    expect(campaignAudit.hasMalformedTokens).toBe(false);

    // Проверяем подписи в режиме Свободной Песочницы (предварительно выбрав C4 для подпанели детонатора)
    await harness.switchMode('sandbox');
    await harness.selectTool('c4');
    const sandboxTexts = await Promise.all([
      harness.page.locator(SELECTORS.modeCampaignBtn).innerText(),
      harness.page.locator(SELECTORS.modeSandboxBtn).innerText(),
      harness.page.locator(SELECTORS.modeLabBtn).innerText(),
      harness.page.locator(SELECTORS.detonateC4Btn).innerText(),
      harness.page.locator(SELECTORS.sceneResetBtn).innerText(),
      harness.page.locator(SELECTORS.sandboxSpawnBtn).innerText(),
    ]);
    for (const txt of sandboxTexts) {
      expect(txt).toMatch(/[А-Яа-яЁё]/);
      expect(txt).not.toContain('undefined');
      expect(txt).not.toContain('NaN');
    }

    // Проверяем подписи в режиме Физической Лаборатории
    await harness.switchMode('lab');
    const labTexts = await Promise.all([
      harness.page.locator(SELECTORS.labBenchMaterials).innerText(),
      harness.page.locator(SELECTORS.labBenchBallistics).innerText(),
      harness.page.locator(SELECTORS.labBenchBlast).innerText(),
      harness.page.locator(SELECTORS.labBenchSeismic).innerText(),
      harness.page.locator(SELECTORS.btnTriggerQuake).innerText(),
    ]);
    for (const txt of labTexts) {
      expect(txt).toMatch(/[А-Яа-яЁё]/);
      expect(txt).not.toContain('undefined');
      expect(txt).not.toContain('NaN');
    }
  });

  test('[R01][F22] Соблюдение инженерной цветовой палитры Vanilla CSS и полное отсутствие фиолетовых тонов', async ({
    harness,
  }) => {
    await harness.boot();

    for (const mode of ['sandbox', 'lab', 'campaign'] as const) {
      await harness.switchMode(mode);
      const report = await harness.auditRussianUiAndNoPurple();

      expect(report.purpleViolations).toEqual([]);
      expect(report.hasMalformedTokens).toBe(false);
      expect(report.rootBgLuminance).toBeLessThan(0.22);
    }
  });

  test('[R01][F02][F22] Корректная перспективная проекция мировых 3D-координат в экранные через window.__SHATTERPOINT__.projectWorldPoint', async ({
    harness,
  }) => {
    await harness.boot();
    await harness.switchMode('sandbox');

    const box = await harness.page.locator(SELECTORS.simCanvas).boundingBox();
    expect(box).not.toBeNull();

    const lower = await harness.projectWorldPoint(0, 1.5, 0);
    const upper = await harness.projectWorldPoint(0, 7.5, 0);

    expect(lower.visible).toBe(true);
    expect(upper.visible).toBe(true);
    expect(Number.isFinite(lower.x)).toBe(true);
    expect(Number.isFinite(lower.y)).toBe(true);
    expect(Number.isFinite(upper.x)).toBe(true);
    expect(Number.isFinite(upper.y)).toBe(true);

    expect(lower.x).toBeGreaterThanOrEqual(0);
    expect(lower.x).toBeLessThanOrEqual(1280);
    expect(lower.y).toBeGreaterThanOrEqual(0);
    expect(lower.y).toBeLessThanOrEqual(720);

    // В экранных координатах ось Y направлена вниз, поэтому точка выше по Y_world имеет меньший Y_screen
    expect(upper.y).toBeLessThan(lower.y - 10);
  });
});

test.describe('Уровень 1 — R02: Навигация по 3 режимам, 3D-камера, сброс сцены и процедурный Web Audio', () => {
  test('[R02][F22] Переключение между тремя режимами (#mode-campaign-btn, #mode-sandbox-btn, #mode-lab-btn) с синхронизацией UI и телеметрии', async ({
    harness,
  }) => {
    await harness.boot();

    await harness.switchMode('sandbox');
    expect((await harness.getTelemetry()).mode).toBe('sandbox');
    await expect(harness.page.locator(SELECTORS.sandboxSpawnSelect)).toBeVisible();
    await expect(harness.page.locator(SELECTORS.sandboxSpawnBtn)).toBeVisible();
    await expect(harness.page.locator(SELECTORS.sandboxBuildToggle)).toBeVisible();

    await harness.switchMode('lab');
    expect((await harness.getTelemetry()).mode).toBe('lab');
    await expect(harness.page.locator(SELECTORS.labBenchMaterials)).toBeVisible();
    await expect(harness.page.locator(SELECTORS.labBenchBallistics)).toBeVisible();
    await expect(harness.page.locator(SELECTORS.labBenchBlast)).toBeVisible();
    await expect(harness.page.locator(SELECTORS.labBenchSeismic)).toBeVisible();
    await expect(harness.page.locator(SELECTORS.sliderGravity)).toBeVisible();

    await harness.switchMode('campaign');
    expect((await harness.getTelemetry()).mode).toBe('campaign');
    await expect(harness.page.locator(SELECTORS.contract01)).toBeVisible();
    await expect(harness.page.locator(SELECTORS.missionBudgetRemaining)).toBeVisible();

    await harness.switchMode('sandbox');
    expect((await harness.getTelemetry()).mode).toBe('sandbox');
  });

  test('[R02][F15] Орбитальное вращение и масштабирование 3D-камеры мышью и колесом на #sim-canvas', async ({
    harness,
  }) => {
    await harness.boot();
    await harness.switchMode('sandbox');

    const a0 = await harness.projectWorldPoint(4, 2, 0);
    const b0 = await harness.projectWorldPoint(-4, 2, 0);
    expect(a0.visible).toBe(true);
    expect(b0.visible).toBe(true);

    await harness.orbitCameraDrag(150, -35);

    const a1 = await harness.projectWorldPoint(4, 2, 0);
    const b1 = await harness.projectWorldPoint(-4, 2, 0);
    const orbitShiftPx = Math.hypot(a1.x - a0.x, a1.y - a0.y);
    expect(orbitShiftPx).toBeGreaterThan(10);

    const spanBeforeZoom = Math.hypot(a1.x - b1.x, a1.y - b1.y);
    await harness.zoomCameraWheel(-360);

    const a2 = await harness.projectWorldPoint(4, 2, 0);
    const b2 = await harness.projectWorldPoint(-4, 2, 0);
    const spanAfterZoom = Math.hypot(a2.x - b2.x, a2.y - b2.y);

    expect(Math.abs(spanAfterZoom - spanBeforeZoom)).toBeGreaterThan(5);
  });

  test('[R02][F12][F20] Полный сброс разрушенной сцены кнопкой #scene-reset-btn с восстановлением исходного монолита', async ({
    harness,
  }) => {
    await harness.boot();
    await harness.switchMode('sandbox');

    const initial = await harness.getTelemetry();
    expect(initial.initialBlockCount).toBeGreaterThan(0);
    expect(initial.initialJointCount).toBeGreaterThan(0);

    const strike = await harness.aimAndStrikeStructure('bomb', {
      heightFraction: 0.14,
      settleTicks: 35,
    });
    expect(strike.impactConfirmed).toBe(true);

    await expect
      .poll(async () => (await harness.getTelemetry()).brokenJointCount, { timeout: 6_000 })
      .toBeGreaterThan(0);
    expect((await harness.getTelemetry()).destructionPct).toBeGreaterThan(0);

    const afterReset = await harness.resetScene();
    expect(afterReset.initialBlockCount).toBeGreaterThan(0);
    expect(afterReset.initialBlockCount).toBe(initial.initialBlockCount);
    expect(afterReset.intactBlockCount).toBe(afterReset.initialBlockCount);
    expect(afterReset.intactJointCount).toBe(afterReset.initialJointCount);
    expect(afterReset.brokenJointCount).toBe(0);
    expect(afterReset.activeShardCount).toBe(0);
    expect(afterReset.destructionPct).toBe(0);
    expect(afterReset.burningNodeCount).toBe(0);
    expect(await harness.getPlantedC4Count()).toBe(0);
  });

  test('[R02][F16] Переключение звука #audio-mute-btn при взрывах и расколе без ошибок Web Audio API', async ({
    harness,
  }) => {
    await harness.boot();
    await harness.switchMode('sandbox');

    const muteBtn = harness.page.locator(SELECTORS.audioMuteBtn);
    await expect(muteBtn).toBeVisible();
    await expect(muteBtn).toBeEnabled();

    const readBtnSignature = async () =>
      await muteBtn.evaluate((el: Element) =>
        JSON.stringify({
          text: (el.textContent ?? '').trim(),
          html: el.innerHTML,
          cls: el.className.trim(),
          ariaPressed: el.getAttribute('aria-pressed') ?? 'false',
          ariaLabel: el.getAttribute('aria-label'),
          dataMuted: el.getAttribute('data-muted') ?? 'false',
          title: el.getAttribute('title'),
        }),
      );

    const sigBefore = await readBtnSignature();
    await harness.toggleAudioMute();
    const sigMuted = await readBtnSignature();
    expect(sigMuted).not.toBe(sigBefore);

    await harness.aimAndStrikeStructure('cannon', { settleTicks: 20 });

    await harness.toggleAudioMute();
    const sigUnmuted = await readBtnSignature();
    expect(sigUnmuted).not.toBe(sigMuted);
    expect(sigUnmuted).toBe(sigBefore);

    const blast = await harness.aimAndStrikeStructure('bomb', { settleTicks: 25 });
    expect(blast.after.brokenJointCount).toBeGreaterThan(0);
    harness.assertZeroRuntimeErrors('синтеза процедурного звука при mute/unmute');
  });

  test('[R02][F15][F22] Изоляция состояния физического мира при переключении режимов после масштабного разрушения', async ({
    harness,
  }) => {
    await harness.boot();
    await harness.spawnSandboxStructure('warehouse');

    await harness.aimAndStrikeStructure('bomb', { settleTicks: 24 });
    await harness.aimAndStrikeStructure('incendiary', { settleTicks: 24 });

    const damaged = await harness.getTelemetry();
    expect(damaged.brokenJointCount + damaged.activeShardCount + damaged.burningNodeCount).toBeGreaterThan(0);

    await harness.switchMode('lab');
    const labTelemetry = await harness.getTelemetry();
    expect(labTelemetry.mode).toBe('lab');
    expect(labTelemetry.brokenJointCount).toBe(0);
    expect(labTelemetry.burningNodeCount).toBe(0);
    expect(labTelemetry.destructionPct).toBe(0);
    expect(labTelemetry.initialBlockCount).toBeGreaterThan(0);
    expect((await harness.projectWorldPoint(0, 2, 0)).visible).toBe(true);

    await harness.switchMode('campaign');
    const campaignTelemetry = await harness.getTelemetry();
    expect(campaignTelemetry.mode).toBe('campaign');
    expect(campaignTelemetry.brokenJointCount).toBe(0);
    expect(campaignTelemetry.burningNodeCount).toBe(0);
    expect(campaignTelemetry.destructionPct).toBe(0);
    expect(campaignTelemetry.initialBlockCount).toBeGreaterThan(0);
    expect((await harness.projectWorldPoint(0, 2, 0)).visible).toBe(true);
  });
});
