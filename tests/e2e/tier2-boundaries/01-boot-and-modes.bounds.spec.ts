import {
  test,
  expect,
  SELECTORS,
  MATERIAL_BUTTON_MAP,
  type AppMode,
  type QualityPreset,
} from '../helpers/shatterpoint-harness';

interface DomStubScanReport {
  stubTokenMatches: string[];
  emptyVisibleButtons: string[];
  untranslatedButtons: string[];
  totalVisibleButtons: number;
  cyrillicButtonsCount: number;
}

test.describe('Уровень 2 — R01: Граничные и негативные сценарии инициализации, WebGL2, пресетов качества и локализации UI', () => {
  test('[R01-B01][F01][F13] Быстрая серия ресайзов окна (1600x900 -> 800x600 -> 1024x768 -> 1280x720) без потери WebGL2-контекста и с пересчётом буфера', async ({
    harness,
  }) => {
    await harness.boot();
    await harness.switchMode('sandbox');

    // Шаг 1: 1600x900
    await harness.page.setViewportSize({ width: 1600, height: 900 });
    await harness.waitForAnimationFrames(3);
    const gl1600 = await harness.verifyWebGL2Context();
    expect(gl1600.contextLost).toBe(false);

    // Шаг 2: 800x600 — проверяем сжатие буфера и пересчёт проекции в рамки малого вьюпорта
    await harness.page.setViewportSize({ width: 800, height: 600 });
    await harness.waitForAnimationFrames(3);
    await expect
      .poll(async () => (await harness.verifyWebGL2Context()).drawingBufferWidth, {
        timeout: 5_000,
        message: 'Ожидание пересчёта ширины WebGL2 буфера под вьюпорт 800x600',
      })
      .toBeLessThan(gl1600.drawingBufferWidth);

    const gl800 = await harness.verifyWebGL2Context();
    expect(gl800.contextLost).toBe(false);
    expect(gl800.drawingBufferWidth).toBeGreaterThan(100);
    expect(gl800.drawingBufferHeight).toBeGreaterThan(100);

    const pt800 = await harness.projectWorldPoint(0, 2, 0);
    expect(pt800.visible).toBe(true);
    expect(Number.isFinite(pt800.x)).toBe(true);
    expect(Number.isFinite(pt800.y)).toBe(true);
    expect(pt800.x).toBeGreaterThanOrEqual(0);
    expect(pt800.x).toBeLessThanOrEqual(800);
    expect(pt800.y).toBeGreaterThanOrEqual(0);
    expect(pt800.y).toBeLessThanOrEqual(600);

    // Шаг 3: 1024x768
    await harness.page.setViewportSize({ width: 1024, height: 768 });
    await harness.waitForAnimationFrames(3);
    const gl1024 = await harness.verifyWebGL2Context();
    expect(gl1024.contextLost).toBe(false);

    // Шаг 4: возврат в штатный вьюпорт 1280x720
    await harness.page.setViewportSize({ width: 1280, height: 720 });
    await harness.waitForAnimationFrames(3);
    await expect
      .poll(async () => (await harness.verifyWebGL2Context()).drawingBufferWidth, {
        timeout: 5_000,
        message: 'Ожидание восстановления ширины WebGL2 буфера под вьюпорт 1280x720',
      })
      .toBeGreaterThan(gl800.drawingBufferWidth);

    const gl1280 = await harness.verifyWebGL2Context();
    expect(gl1280.contextLost).toBe(false);
    expect(gl800.drawingBufferWidth).toBeLessThan(gl1280.drawingBufferWidth);
    expect(gl800.drawingBufferHeight).toBeLessThan(gl1280.drawingBufferHeight);

    const pt1280 = await harness.projectWorldPoint(0, 2, 0);
    expect(pt1280.visible).toBe(true);
    expect(Number.isFinite(pt1280.x)).toBe(true);
    expect(Number.isFinite(pt1280.y)).toBe(true);
    expect(pt1280.x).toBeGreaterThanOrEqual(0);
    expect(pt1280.x).toBeLessThanOrEqual(1280);
    expect(pt1280.y).toBeGreaterThanOrEqual(0);
    expect(pt1280.y).toBeLessThanOrEqual(720);

    await harness.waitForSimTicks(5);
    harness.assertZeroRuntimeErrors('быстрой серии ресайзов окна WebGL2');
  });

  test('[R01-B02][F13] Многократное переключение пресетов #quality-select в эпицентре взрыва и разлёта 3D-осколков Вороного', async ({
    harness,
  }) => {
    await harness.boot();
    await harness.spawnSandboxStructure('fortress', { cleanResetFirst: true });

    const strike = await harness.aimAndStrikeStructure('bomb', {
      heightFraction: 0.16,
      settleTicks: 4,
    });

    let peakShardsOrRubble = strike.after.activeShardCount + strike.after.bakedRubbleCount;
    const tickAtBlast = strike.after.tick;

    // 6 быстрых переключений пресетов качества прямо в фазе активного разлёта 3D-осколков
    const presetSequence: readonly QualityPreset[] = [
      'performance',
      'ultra',
      'high',
      'performance',
      'ultra',
      'performance',
    ];

    for (const preset of presetSequence) {
      await harness.setQualityPreset(preset);
      await harness.waitForAnimationFrames(1);
      const cur = await harness.getTelemetry();
      peakShardsOrRubble = Math.max(
        peakShardsOrRubble,
        cur.activeShardCount + cur.bakedRubbleCount,
      );
    }

    const afterSettle = await harness.waitForSimTicks(10);
    peakShardsOrRubble = Math.max(
      peakShardsOrRubble,
      afterSettle.activeShardCount + afterSettle.bakedRubbleCount,
    );

    const glReport = await harness.verifyWebGL2Context();
    expect(glReport.contextLost).toBe(false);
    expect(afterSettle.tick).toBeGreaterThan(tickAtBlast);
    expect(peakShardsOrRubble).toBeGreaterThan(0);
    harness.assertZeroRuntimeErrors(
      'многократного переключения #quality-select в эпицентре взрыва',
    );
  });

  test('[R01-B03][F12][F13] Соблюдение потолка Draw Calls (инстансинг и батчинг геометрии) при 3 зданиях и множестве осколков на сцене', async ({
    harness,
  }) => {
    await harness.boot();

    const { after: firstBuilding } = await harness.spawnSandboxStructure('tower', {
      cleanResetFirst: true,
    });
    await harness.spawnSandboxStructure('viaduct', { cleanResetFirst: false });
    const { after: thirdBuilding } = await harness.spawnSandboxStructure('fortress', {
      cleanResetFirst: false,
    });

    expect(thirdBuilding.initialBlockCount).toBeGreaterThan(firstBuilding.initialBlockCount);

    await harness.aimAndStrikeStructure('bomb', {
      heightFraction: 0.16,
      settleTicks: 20,
      searchFullPolygon: true,
    });

    const t = await harness.getTelemetry();
    const gl = await harness.verifyWebGL2Context();

    expect(gl.contextLost).toBe(false);
    expect(t.brokenJointCount + t.activeShardCount + t.bakedRubbleCount).toBeGreaterThan(0);
    expect(t.drawCalls).toBeGreaterThan(0);
    expect(t.drawCalls).toBeLessThanOrEqual(120);
  });

  test('[R01-B04][F02][F22] Экстремальные и запредельные мировые координаты в projectWorldPoint (зенит, подземелье, горизонт, точка позади камеры) без NaN и Infinity', async ({
    harness,
  }) => {
    await harness.boot();
    await harness.switchMode('sandbox');

    const extremeProbes: ReadonlyArray<[number, number, number]> = [
      [0, 0, 0],
      [0, 800, 0],
      [0, -800, 0],
      [5000, 10, 5000],
      [0, 25, 300],
      [-300, 25, -300],
    ];

    const results = [];
    for (const [wx, wy, wz] of extremeProbes) {
      const pt = await harness.projectWorldPoint(wx, wy, wz);
      expect(typeof pt.x).toBe('number');
      expect(typeof pt.y).toBe('number');
      expect(Number.isFinite(pt.x)).toBe(true);
      expect(Number.isFinite(pt.y)).toBe(true);
      expect(typeof pt.visible).toBe('boolean');
      results.push({ world: [wx, wy, wz], pt });
    }

    // Опорная точка центра полигона видима в пределах кадра
    expect(results[0].pt.visible).toBe(true);

    // Хотя бы одна экстремальная закадровая точка помечена невидимой или проецируется за пределы 1280x720
    const offscreenDetected = results.slice(1).some(({ pt }) => {
      return !pt.visible || pt.x < 0 || pt.x > 1280 || pt.y < 0 || pt.y > 720;
    });
    expect(offscreenDetected).toBe(true);
  });

  test('[R01-B05][F22] Полное отсутствие англоязычных заглушек (Lorem, TODO, Placeholder, undefined, NaN, null) во всех 3 режимах и модальном окне Мастерской', async ({
    harness,
  }) => {
    await harness.boot();

    const scanDomForStubsAndUntranslatedUi = async (): Promise<DomStubScanReport> => {
      return await harness.page.evaluate((): DomStubScanReport => {
        const root = (document.querySelector('#app-root') ?? document.body) as HTMLElement;
        const forbiddenWordRegex = /\b(lorem|ipsum|todo|fixme|placeholder|undefined|null)\b/i;
        const stubTokenMatches: string[] = [];

        const checkString = (raw: string, sourceHint: string): void => {
          if (!raw) return;
          const wordMatch = raw.match(forbiddenWordRegex);
          if (wordMatch) {
            stubTokenMatches.push(`${sourceHint}: "${wordMatch[0]}"`);
          }
          if (raw.includes('NaN')) {
            stubTokenMatches.push(`${sourceHint}: "NaN"`);
          }
          if (raw.includes('[object Object]')) {
            stubTokenMatches.push(`${sourceHint}: "[object Object]"`);
          }
        };

        checkString(root.innerText || '', 'visibleText');

        const isElementVisible = (el: Element): el is HTMLElement => {
          if (!(el instanceof HTMLElement)) return false;
          const st = window.getComputedStyle(el);
          if (
            st.display === 'none' ||
            st.visibility === 'hidden' ||
            Number(st.opacity ?? '1') <= 0.01
          ) {
            return false;
          }
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        };

        const allElements = Array.from(root.querySelectorAll('*'));
        for (const el of allElements) {
          if (!isElementVisible(el)) continue;
          const hint = el.id ? `#${el.id}` : el.tagName.toLowerCase();
          const titleAttr = el.getAttribute('title') ?? '';
          const ariaLabelAttr = el.getAttribute('aria-label') ?? '';
          const placeholderAttr = el.getAttribute('placeholder') ?? '';
          checkString(titleAttr, `${hint}[title]`);
          checkString(ariaLabelAttr, `${hint}[aria-label]`);
          checkString(placeholderAttr, `${hint}[placeholder]`);
        }

        const emptyVisibleButtons: string[] = [];
        const untranslatedButtons: string[] = [];
        let totalVisibleButtons = 0;
        let cyrillicButtonsCount = 0;

        const buttons = Array.from(root.querySelectorAll('button'));
        for (const btn of buttons) {
          if (!isElementVisible(btn)) continue;
          totalVisibleButtons += 1;
          const hint = btn.id ? `#${btn.id}` : 'button';
          const text = (btn.innerText || btn.textContent || '').replace(/\s+/g, ' ').trim();
          const ariaLabel = (btn.getAttribute('aria-label') ?? '').trim();
          const title = (btn.getAttribute('title') ?? '').trim();
          const combined = `${text} ${ariaLabel} ${title}`.trim();

          if (combined.length === 0) {
            emptyVisibleButtons.push(hint);
            continue;
          }

          if (/[А-Яа-яЁё]/.test(combined)) {
            cyrillicButtonsCount += 1;
          } else {
            // Допускаются только международные инженерные обозначения (C4, PBR, X-Ray, FPS, 3D, Bullet-Time, Esc, SFX, UI, HUD) или чистые символы без английских слов
            const strippedTech = combined.replace(
              /\b(?:c4|pbr|x-?ray|fps|3d|bullet-?time|esc|sfx|ui|hud)\b/gi,
              ' ',
            );
            if (/[A-Za-z]{2,}/.test(strippedTech)) {
              untranslatedButtons.push(`${hint}: "${combined}"`);
            }
          }
        }

        return {
          stubTokenMatches,
          emptyVisibleButtons,
          untranslatedButtons,
          totalVisibleButtons,
          cyrillicButtonsCount,
        };
      });
    };

    const verifyCurrentScreen = async (stateLabel: string): Promise<void> => {
      const uiReport = await harness.auditRussianUiAndNoPurple();
      expect(uiReport.hasCyrillicText, `Отсутствует кириллица в состоянии «${stateLabel}»`).toBe(
        true,
      );
      expect(
        uiReport.hasMalformedTokens,
        `Найдены битые токены в состоянии «${stateLabel}»: ${uiReport.malformedMatches.join(', ')}`,
      ).toBe(false);
      expect(
        uiReport.purpleViolations,
        `Нарушение запрета фиолетового цвета в состоянии «${stateLabel}»`,
      ).toEqual([]);

      const stubScan = await scanDomForStubsAndUntranslatedUi();
      expect(
        stubScan.stubTokenMatches,
        `Обнаружены англоязычные заглушки/NaN в состоянии «${stateLabel}»`,
      ).toEqual([]);
      expect(
        stubScan.emptyVisibleButtons,
        `Обнаружены пустые видимые кнопки в состоянии «${stateLabel}»`,
      ).toEqual([]);
      expect(
        stubScan.untranslatedButtons,
        `Обнаружены непереведённые англоязычные кнопки в состоянии «${stateLabel}»`,
      ).toEqual([]);
      expect(stubScan.totalVisibleButtons).toBeGreaterThan(0);
      expect(stubScan.cyrillicButtonsCount).toBeGreaterThan(0);
    };

    // 1. Песочница с открытым конструктором достройки и с панелью C4
    await harness.switchMode('sandbox');
    if (!(await harness.isSandboxBuildModeActive())) {
      await harness.page.locator(SELECTORS.sandboxBuildToggle).click();
      await harness.waitForAnimationFrames(1);
    }
    if (!(await harness.page.locator(MATERIAL_BUTTON_MAP.reinforced_concrete).isVisible())) {
      await harness.page.locator(SELECTORS.sandboxBuildToggle).click();
      await harness.waitForAnimationFrames(1);
    }
    await verifyCurrentScreen('Песочница (активный конструктор материалов)');

    await harness.selectTool('c4');
    await verifyCurrentScreen('Песочница (выбран инструмент C4 и секвенсор)');

    // 2. Физическая Лаборатория-полигон
    await harness.switchMode('lab');
    await verifyCurrentScreen('Физическая Лаборатория');

    // 3. Кампания миссий + открытое модальное окно Мастерской (#workshop-modal)
    await harness.switchMode('campaign');
    await verifyCurrentScreen('Кампания миссий');

    await harness.openWorkshop();
    await verifyCurrentScreen('Модальное окно Мастерской улучшений (#workshop-modal)');
    await harness.closeWorkshop();
  });

  test('[R01-B06][F01][F02] Двойная последовательная перезагрузка страницы (page.reload) без ошибок повторной инициализации WASM Rapier3D и утечек контекста', async ({
    harness,
  }) => {
    await harness.boot({ clearStorage: true });
    await harness.assertCanonicalAppRootAttributes();
    const glInitial = await harness.verifyWebGL2Context();
    expect(glInitial.contextLost).toBe(false);

    for (let reloadIdx = 1; reloadIdx <= 2; reloadIdx++) {
      const tReloaded = await harness.reloadAndWaitReady();
      await harness.assertCanonicalAppRootAttributes();

      const glReloaded = await harness.verifyWebGL2Context();
      expect(glReloaded.hasWebGL2).toBe(true);
      expect(glReloaded.contextLost).toBe(false);

      const tAdvanced = await harness.waitForSimTicks(8);
      expect(tAdvanced.tick).toBeGreaterThanOrEqual(tReloaded.tick + 8);
      expect(tAdvanced.simTimeSec).toBeGreaterThan(tReloaded.simTimeSec);
      harness.assertZeroRuntimeErrors(`последовательной перезагрузки страницы №${reloadIdx}`);
    }
  });
});

test.describe('Уровень 2 — R02: Граничные и стрессовые сценарии смены режимов, сброса сцены, 3D-камеры и Web Audio', () => {
  test('[R02-B01][F15][F22] Стрессовое переключение режимов (sandbox -> lab -> campaign -> sandbox x2) в момент активного взрыва, пожара и землетрясения', async ({
    harness,
  }) => {
    await harness.boot();
    await harness.spawnSandboxStructure('warehouse', { cleanResetFirst: true });

    await harness.aimAndStrikeStructure('incendiary', {
      heightFraction: 0.2,
      settleTicks: 4,
      maxAttempts: 3,
    });
    await harness.aimAndStrikeStructure('bomb', {
      heightFraction: 0.16,
      settleTicks: 4,
      maxAttempts: 2,
    });
    await harness.activateSeismicTool({ settleTicks: 4 });

    // 6 быстрых переключений режимов подряд без промежуточного ожидания затухания физики
    const rapidCycle: readonly AppMode[] = [
      'lab',
      'campaign',
      'sandbox',
      'lab',
      'campaign',
      'sandbox',
    ];
    for (const nextMode of rapidCycle) {
      await harness.switchMode(nextMode);
    }

    const rootState = await harness.getAppRootState();
    expect(rootState.activeMode).toBe('sandbox');

    const tSandbox = await harness.waitForSimTicks(6);
    expect(tSandbox.mode).toBe('sandbox');
    expect(tSandbox.initialBlockCount).toBeGreaterThan(0);
    expect(tSandbox.burningNodeCount).toBe(0);
    expect(tSandbox.seismicActive).toBe(false);
    expect(tSandbox.brokenJointCount).toBe(0);

    const gl = await harness.verifyWebGL2Context();
    expect(gl.contextLost).toBe(false);
    harness.assertZeroRuntimeErrors(
      'стрессового переключения режимов во время взрыва, пожара и землетрясения',
    );
  });

  test('[R02-B02][F12][F20] Идемпотентность тройного нажатия #scene-reset-btn подряд (отсутствие дублирования блоков и обнуления сцены)', async ({
    harness,
  }) => {
    await harness.boot();
    await harness.switchMode('sandbox');

    const initial = await harness.getTelemetry();
    const blocks0 = initial.initialBlockCount;
    const joints0 = initial.initialJointCount;
    expect(blocks0).toBeGreaterThan(0);
    expect(joints0).toBeGreaterThan(0);

    const strike = await harness.aimAndStrikeStructure('bomb', {
      heightFraction: 0.14,
      settleTicks: 20,
    });
    expect(strike.impactConfirmed).toBe(true);
    await harness.plantC4OnStructure({ count: 1, delaySec: 0, heightFraction: 0.2 });

    // Тройное нажатие #scene-reset-btn подряд без пауз между кликами
    const resetBtn = harness.page.locator(SELECTORS.sceneResetBtn);
    await resetBtn.click();
    await resetBtn.click();
    await resetBtn.click();

    const after = await harness.waitForSimTicks(10);
    expect(after.initialBlockCount).toBe(blocks0);
    expect(after.intactBlockCount).toBe(blocks0);
    expect(after.initialJointCount).toBe(joints0);
    expect(after.intactJointCount).toBe(joints0);
    expect(after.brokenJointCount).toBe(0);
    expect(after.activeShardCount).toBe(0);
    expect(after.bakedRubbleCount).toBe(0);
    expect(after.destructionPct).toBe(0);
    expect(await harness.getPlantedC4Count()).toBe(0);
  });

  test('[R02-B03][F15] Границы масштабирования 3D-камеры (экстремальный zoom-in и zoom-out колесом мыши без инверсии и провала сквозь землю)', async ({
    harness,
  }) => {
    await harness.boot();
    await harness.spawnSandboxStructure('tower', { cleanResetFirst: true });

    // 1. Экстремальное приближение: 8 мощных импульсов колеса вперёд
    for (let i = 0; i < 8; i++) {
      await harness.zoomCameraWheel(-900);
    }

    const lowerZoomIn = await harness.projectWorldPoint(0, 1.0, 0);
    const upperZoomIn = await harness.projectWorldPoint(0, 7.5, 0);
    expect(Number.isFinite(lowerZoomIn.x)).toBe(true);
    expect(Number.isFinite(lowerZoomIn.y)).toBe(true);
    expect(Number.isFinite(upperZoomIn.x)).toBe(true);
    expect(Number.isFinite(upperZoomIn.y)).toBe(true);

    if (lowerZoomIn.visible && upperZoomIn.visible) {
      expect(upperZoomIn.y).toBeLessThan(lowerZoomIn.y);
    }

    const midLowIn = await harness.projectWorldPoint(0, 1.8, 0);
    const midHighIn = await harness.projectWorldPoint(0, 3.8, 0);
    if (midLowIn.visible && midHighIn.visible) {
      expect(midHighIn.y).toBeLessThan(midLowIn.y);
    }

    // 2. Экстремальное отдаление: 10 мощных импульсов колеса назад (проверка ограничения maxDistance)
    for (let i = 0; i < 10; i++) {
      await harness.zoomCameraWheel(900);
    }

    const centerZoomOut = await harness.projectWorldPoint(0, 2.0, 0);
    const lowerZoomOut = await harness.projectWorldPoint(0, 1.0, 0);
    const upperZoomOut = await harness.projectWorldPoint(0, 7.5, 0);

    expect(centerZoomOut.visible).toBe(true);
    expect(lowerZoomOut.visible).toBe(true);
    expect(upperZoomOut.visible).toBe(true);
    expect(upperZoomOut.y).toBeLessThan(lowerZoomOut.y);
    expect(lowerZoomOut.y - upperZoomOut.y).toBeGreaterThan(2);

    const t = await harness.getTelemetry();
    expect(t.drawCalls).toBeGreaterThan(0);
    const gl = await harness.verifyWebGL2Context();
    expect(gl.contextLost).toBe(false);
  });

  test('[R02-B04][F15] Экстремальные углы орбитального вращения камеры (защита от переворота в зените Gimbal Lock и ухода под фундамент)', async ({
    harness,
  }) => {
    await harness.boot();
    await harness.spawnSandboxStructure('tower', { cleanResetFirst: true });

    const assertUprightProjection = async (stepLabel: string): Promise<void> => {
      const upper = await harness.projectWorldPoint(0, 8.0, 0);
      const lower = await harness.projectWorldPoint(0, 1.0, 0);

      expect(Number.isFinite(upper.x), `NaN/Infinity X верхней точки (${stepLabel})`).toBe(true);
      expect(Number.isFinite(upper.y), `NaN/Infinity Y верхней точки (${stepLabel})`).toBe(true);
      expect(Number.isFinite(lower.x), `NaN/Infinity X нижней точки (${stepLabel})`).toBe(true);
      expect(Number.isFinite(lower.y), `NaN/Infinity Y нижней точки (${stepLabel})`).toBe(true);
      expect(upper.visible, `Верхняя точка выпала из кадра (${stepLabel})`).toBe(true);
      expect(lower.visible, `Нижняя точка выпала из кадра (${stepLabel})`).toBe(true);
      expect(
        upper.y,
        `Инверсия вертикали / Gimbal Lock камеры на шаге «${stepLabel}»`,
      ).toBeLessThan(lower.y);
    };

    await harness.orbitCameraDrag(0, -650);
    await assertUprightProjection('экстремальный наклон к зениту (dy = -650)');

    await harness.orbitCameraDrag(0, 650);
    await assertUprightProjection('экстремальный наклон к горизонту/фундаменту (dy = +650)');

    await harness.orbitCameraDrag(950, 0);
    await assertUprightProjection('полный азимутальный разворот (dx = +950)');

    const gl = await harness.verifyWebGL2Context();
    expect(gl.contextLost).toBe(false);
  });

  test('[R02-B05][F16] Быстрая серия из 10 переключений #audio-mute-btn подряд во время грохота каскадного обрушения без ошибок AudioContext', async ({
    harness,
  }) => {
    await harness.boot();
    await harness.spawnSandboxStructure('tower', { cleanResetFirst: true });

    const muteBtn = harness.page.locator(SELECTORS.audioMuteBtn);
    await expect(muteBtn).toBeVisible();

    const readMuteBtnSignature = async (): Promise<string> => {
      return await muteBtn.evaluate((el: Element): string =>
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
    };

    const sigInitial = await readMuteBtnSignature();

    // Инициируем взрыв у основания башни и сразу в разгар обрушения выполняем 10 переключений mute/unmute
    await harness.aimAndStrikeStructure('bomb', {
      heightFraction: 0.14,
      settleTicks: 4,
    });

    await harness.toggleAudioMute();
    const sigAfterFirstToggle = await readMuteBtnSignature();
    expect(sigAfterFirstToggle).not.toBe(sigInitial);

    for (let i = 1; i < 10; i++) {
      await harness.toggleAudioMute();
    }

    const sigAfterTenToggles = await readMuteBtnSignature();
    expect(sigAfterTenToggles).toBe(sigInitial);

    const afterCollapse = await harness.waitForSimTicks(15);
    expect(afterCollapse.brokenJointCount + afterCollapse.activeShardCount).toBeGreaterThan(0);
    harness.assertZeroRuntimeErrors(
      'серии из 10 быстрых переключений #audio-mute-btn во время обрушения',
    );
  });
});
