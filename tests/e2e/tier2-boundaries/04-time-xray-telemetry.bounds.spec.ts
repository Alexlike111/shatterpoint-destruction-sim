import {
  test,
  expect,
  SELECTORS,
  VIEW_BUTTON_MAP,
  areByteArraysDifferent,
  type E2ETelemetry,
  type RenderViewMode,
  type ToolId,
} from '../helpers/shatterpoint-harness';

type ExtTelemetry = E2ETelemetry & {
  walletCredits?: number;
  toolLevels?: Record<ToolId, number>;
  collapsedMassTons?: number;
  destructionScore?: number;
  comboMultiplier?: number;
  criticalNodesCount?: number;
  c4SequenceQueue?: Array<{ chargeId: number; delaySec: number }>;
  activeTriggersCount?: number;
};

const ALL_TOOL_IDS: readonly ToolId[] = [
  'cannon',
  'c4',
  'bomb',
  'cutter',
  'incendiary',
  'seismic',
];

const SIMULATION_NUMERIC_FIELDS: ReadonlyArray<keyof E2ETelemetry> = [
  'tick',
  'simTimeSec',
  'intactBlockCount',
  'initialBlockCount',
  'intactJointCount',
  'initialJointCount',
  'brokenJointCount',
  'activeRebarCount',
  'snappedRebarCount',
  'plasticHingeCount',
  'activeShardCount',
  'bakedRubbleCount',
  'burningNodeCount',
  'maxTemperatureC',
  'maxStressUtilization',
  'kineticEnergyKJ',
  'secondaryImpactsCount',
  'detonatedExplosivesCount',
  'destructionPct',
  'targetMaxHeightM',
  'protectedDamagePct',
  'seismicFrequencyHz',
  'seismicAmplitudeM',
  'lastStepCpuMs',
];

const SIMULATION_INTEGER_COUNTERS: ReadonlyArray<keyof E2ETelemetry> = [
  'tick',
  'intactBlockCount',
  'initialBlockCount',
  'intactJointCount',
  'initialJointCount',
  'brokenJointCount',
  'activeRebarCount',
  'snappedRebarCount',
  'plasticHingeCount',
  'activeShardCount',
  'bakedRubbleCount',
  'burningNodeCount',
  'secondaryImpactsCount',
  'detonatedExplosivesCount',
];

test.describe('Уровень 2 — R07: Граничные и негативные режимы управления временем', () => {
  test('[R07][F02][F12] Пакетная серия из 5 быстрых нажатий #time-step-btn на паузе: строго +5 тиков и +5/60 с без потери кликов и без срыва паузы', async ({
    harness,
  }) => {
    await harness.boot();
    await harness.spawnSandboxStructure('tower', { cleanResetFirst: true });

    await harness.setPaused(true);
    await harness.waitForAnimationFrames(2);

    const t0 = await harness.getTelemetry();
    const stepBtn = harness.page.locator(SELECTORS.timeStepBtn);

    // Пакетная серия из 5 кликов без промежуточного опроса тиков между кликами
    for (let i = 0; i < 5; i++) {
      await stepBtn.click();
    }

    await expect
      .poll(async () => (await harness.getTelemetry()).tick, {
        timeout: 5_000,
        message: 'Ожидание точного прихода к tick0 + 5 после серии из 5 нажатий #time-step-btn',
      })
      .toBe(t0.tick + 5);

    // Выдерживаем ещё 15 кадров rAF, доказывая отсутствие инерционного проскальзывания в tick0 + 6
    await harness.waitForAnimationFrames(15);

    const tAfter = await harness.getTelemetry();
    expect(tAfter.tick).toBe(t0.tick + 5);
    expect(tAfter.simTimeSec - t0.simTimeSec).toBeCloseTo(5 / 60, 3);

    const rootState = await harness.getAppRootState();
    expect(rootState.paused).toBe(true);
    expect(rootState.simTick).toBe(t0.tick + 5);
  });

  test('[R07][F02][F12] Экстремальные границы #time-scale-select (0.05x и 2.0x): сохранение инварианта FIXED_DT = 1/60 и устойчивости физики под нагрузкой', async ({
    harness,
  }) => {
    await harness.boot();
    await harness.spawnSandboxStructure('tower', { cleanResetFirst: true });

    const options = await harness.listSelectOptions(SELECTORS.timeScaleSelect);
    const numericScales = options
      .map((o) => o.numericValue)
      .filter((v): v is number => v !== null && Number.isFinite(v));
    expect(numericScales.length).toBeGreaterThanOrEqual(3);

    const minOptionScale = Math.min(...numericScales);
    const maxOptionScale = Math.max(...numericScales);
    expect(minOptionScale).toBeCloseTo(0.05, 3);
    expect(maxOptionScale).toBeCloseTo(2.0, 2);

    // 1. Нижний экстремум сверхзамедления 0.05x под взрывной нагрузкой
    const appliedSlow = await harness.setTimeScale(0.05);
    expect(appliedSlow).toBeCloseTo(0.05, 3);
    await expect(harness.page.locator(SELECTORS.appRoot)).toHaveAttribute('data-paused', 'false');

    await harness.aimAndStrikeStructure('bomb', {
      heightFraction: 0.16,
      settleTicks: 4,
    });

    const s0 = await harness.getTelemetry();
    let slowFrames = 36;
    await harness.waitForAnimationFrames(36);
    let s1 = await harness.getTelemetry();
    if (s1.tick === s0.tick) {
      await harness.waitForAnimationFrames(24);
      slowFrames += 24;
      s1 = await harness.getTelemetry();
    }

    const ticksSlow = s1.tick - s0.tick;
    const dtSlow = s1.simTimeSec - s0.simTimeSec;
    expect(ticksSlow).toBeGreaterThanOrEqual(1);
    expect(dtSlow).toBeCloseTo(ticksSlow / 60, 3);

    // 2. Переключение на лету в верхний экстремум ускорения 2.0x
    const appliedFast = await harness.setTimeScale(2.0);
    expect(appliedFast).toBeCloseTo(2.0, 2);

    const f0 = await harness.getTelemetry();
    const fastFrames = 36;
    await harness.waitForAnimationFrames(fastFrames);
    const f1 = await harness.getTelemetry();

    const ticksFast = f1.tick - f0.tick;
    const dtFast = f1.simTimeSec - f0.simTimeSec;
    const slowRatePerFrame = ticksSlow / slowFrames;
    const fastRatePerFrame = ticksFast / fastFrames;

    expect(ticksFast).toBeGreaterThanOrEqual(8);
    expect(fastRatePerFrame).toBeGreaterThan(slowRatePerFrame * 4);
    expect(dtFast).toBeCloseTo(ticksFast / 60, 3);
    expect(Number.isFinite(f1.kineticEnergyKJ)).toBe(true);
    expect(f1.destructionPct).toBeGreaterThanOrEqual(0);
    expect(f1.destructionPct).toBeLessThanOrEqual(100);

    await harness.setTimeScale(1.0);
  });

  test('[R07][F12][F16] Переключение Bullet-Time (#time-bullet-btn) и #time-scale-select во время паузы НЕ вызывает самопроизвольного снятия паузы', async ({
    harness,
  }) => {
    await harness.boot();
    await harness.spawnSandboxStructure('tower', { cleanResetFirst: true });

    await harness.aimAndStrikeStructure('cannon', { settleTicks: 6 });
    await harness.setPaused(true);

    const pausedInitial = await harness.getTelemetry();
    const pausedTick = pausedInitial.tick;
    const pausedSimTime = pausedInitial.simTimeSec;

    // Включаем Bullet-Time на активной паузе
    const bulletScale = await harness.toggleBulletTime();
    expect(bulletScale).toBeGreaterThan(0);
    expect(bulletScale).toBeLessThan(1.0);
    await expect(harness.page.locator(SELECTORS.appRoot)).toHaveAttribute('data-paused', 'true');

    await harness.waitForAnimationFrames(20);
    const afterBulletOnPause = await harness.getTelemetry();
    expect(afterBulletOnPause.tick).toBe(pausedTick);
    expect(afterBulletOnPause.simTimeSec).toBe(pausedSimTime);

    // Меняем масштаб времени туда-обратно и снова переключаем Bullet-Time на паузе
    await harness.setTimeScale(2.0);
    await harness.setTimeScale(0.05);
    await harness.toggleBulletTime();

    await harness.waitForAnimationFrames(15);
    await expect(harness.page.locator(SELECTORS.appRoot)).toHaveAttribute('data-paused', 'true');

    const afterScaleChanges = await harness.getTelemetry();
    expect(afterScaleChanges.tick).toBe(pausedTick);
    expect(afterScaleChanges.simTimeSec).toBe(pausedSimTime);

    // Снимаем паузу и убеждаемся в штатном возобновлении хода симуляции
    await harness.setTimeScale(1.0);
    await harness.setPaused(false);
    const resumed = await harness.waitForSimTicks(5);
    expect(resumed.tick).toBeGreaterThanOrEqual(pausedTick + 5);
  });

  test('[R07][F12] Нажатие #time-step-btn при активной симуляции и быстрая серия переключений #time-pause-btn без утечки цикла rAF', async ({
    harness,
  }) => {
    await harness.boot();
    await harness.spawnSandboxStructure('tower', { cleanResetFirst: true });
    await harness.setPaused(false);

    const t0 = await harness.waitForSimTicks(6);

    // Нажимаем кнопку одиночного шага прямо во время бегущей симуляции (без предварительной паузы)
    await harness.page.locator(SELECTORS.timeStepBtn).click();
    await harness.waitForAnimationFrames(3);
    const t1 = await harness.getTelemetry();

    expect(t1.tick).toBeGreaterThanOrEqual(t0.tick);
    expect(Math.abs((t1.tick - t0.tick) / 60 - (t1.simTimeSec - t0.simTimeSec))).toBeLessThan(
      0.005,
    );

    // Быстрая серия из 6 переключений #time-pause-btn подряд не должна порождать дублирующий цикл rAF
    const pauseBtn = harness.page.locator(SELECTORS.timePauseBtn);
    for (let i = 0; i < 6; i++) {
      await pauseBtn.click();
    }

    await harness.setPaused(true);
    await harness.waitForAnimationFrames(2);
    const frozenTick = (await harness.getTelemetry()).tick;

    await harness.waitForAnimationFrames(20);
    const afterWait = await harness.getTelemetry();
    expect(afterWait.tick).toBe(frozenTick);
    expect((await harness.getAppRootState()).paused).toBe(true);
  });

  test('[R07][F12][F20] Согласованность атрибутов data-paused и data-time-scale с реальным ходом тиков после #scene-reset-btn и смены режима', async ({
    harness,
  }) => {
    await harness.boot();
    await harness.spawnSandboxStructure('tower', { cleanResetFirst: true });

    await harness.setTimeScale(0.05);
    await harness.setPaused(true);
    await harness.stepOnceWhenPaused();
    await harness.stepOnceWhenPaused();

    await harness.resetScene();
    await harness.assertCanonicalAppRootAttributes();

    const stateAfterReset = await harness.getAppRootState();
    expect(stateAfterReset.timeScale).toBeGreaterThanOrEqual(0.05);
    expect(stateAfterReset.timeScale).toBeLessThanOrEqual(2.0);

    const tickA = (await harness.getTelemetry()).tick;
    await harness.waitForAnimationFrames(24);
    const tickB = (await harness.getTelemetry()).tick;

    if (stateAfterReset.paused) {
      expect(tickB).toBe(tickA);
      await harness.setPaused(false);
    }
    await harness.setTimeScale(1.0);
    const tickBeforeRun = (await harness.getTelemetry()).tick;
    await harness.waitForAnimationFrames(20);
    const tickAfterRun = (await harness.getTelemetry()).tick;
    expect(tickAfterRun).toBeGreaterThan(tickBeforeRun);

    // Проверяем сохранение синхронности data-paused и реального счёта тиков при смене режимов
    await harness.switchMode('lab');
    await harness.switchMode('sandbox');
    await harness.assertCanonicalAppRootAttributes();

    const stateAfterSwitch = await harness.getAppRootState();
    const tickSwitchA = (await harness.getTelemetry()).tick;
    await harness.waitForAnimationFrames(18);
    const tickSwitchB = (await harness.getTelemetry()).tick;

    if (stateAfterSwitch.paused) {
      expect(tickSwitchB).toBe(tickSwitchA);
    } else {
      expect(tickSwitchB).toBeGreaterThan(tickSwitchA);
    }
  });
});

test.describe('Уровень 2 — R08: Граничные режимы визуализатора (PBR, Stress, X-Ray) и инварианты 25+ полей телеметрии', () => {
  test('[R08][F13][F14] Стресс-переключение PBR ↔ Stress ↔ X-Ray на паузе (12 смен подряд): неизменность тика, отсутствие утечки drawCalls и живой WebGL2', async ({
    harness,
  }) => {
    await harness.boot();
    await harness.spawnSandboxStructure('tower', { cleanResetFirst: true });

    const planted = await harness.plantC4OnStructure({
      count: 1,
      delaySec: 0,
      heightFraction: 0.16,
    });
    if (planted.totalPlanted > 0) {
      await harness.detonateC4AndSettle(15);
    } else {
      await harness.aimAndStrikeStructure('bomb', { settleTicks: 15 });
    }

    await harness.setPaused(true);
    await harness.setRenderViewMode('pbr');
    await harness.waitForAnimationFrames(3);

    const baselineTel = await harness.getTelemetry();
    const pausedTick = baselineTel.tick;
    const drawCallsBaseline = baselineTel.drawCalls;
    const pngPbrBefore = await harness.captureCanvasPngBytes();

    const rotationOrder: RenderViewMode[] = ['stress', 'xray', 'pbr'];
    for (let round = 0; round < 4; round++) {
      for (const mode of rotationOrder) {
        await harness.page.locator(VIEW_BUTTON_MAP[mode]).click();
      }
    }

    await harness.waitForAnimationFrames(3);
    await expect(harness.page.locator(SELECTORS.appRoot)).toHaveAttribute(
      'data-render-mode',
      'pbr',
    );

    const afterTel = await harness.getTelemetry();
    expect(afterTel.tick).toBe(pausedTick);
    expect(afterTel.drawCalls).toBeGreaterThan(0);
    expect(afterTel.drawCalls).toBeLessThanOrEqual(drawCallsBaseline + 4);

    await harness.setRenderViewMode('xray');
    await harness.waitForAnimationFrames(3);
    const pngXray = await harness.captureCanvasPngBytes();
    expect(areByteArraysDifferent(pngPbrBefore, pngXray)).toBe(true);

    const glHealth = await harness.verifyWebGL2Context();
    expect(glHealth.contextLost).toBe(false);
  });

  test('[R08][F13][F14] Быстрое переключение PBR ↔ Stress ↔ X-Ray под пиковой нагрузкой осколков Вороного, арматуры и огня', async ({
    harness,
  }) => {
    await harness.boot();
    await harness.spawnSandboxStructure('tower', { cleanResetFirst: true });
    await harness.spawnSandboxStructure('warehouse', { cleanResetFirst: false });

    const planted = await harness.plantC4OnStructure({
      count: 3,
      delaySec: 0,
      heightFraction: 0.16,
    });
    await harness.aimAndStrikeStructure('incendiary', {
      settleTicks: 6,
      searchFullPolygon: true,
    });

    if (planted.totalPlanted > 0) {
      await harness.page.locator(SELECTORS.detonateC4Btn).click();
    } else {
      await harness.aimAndStrikeStructure('bomb', { settleTicks: 4 });
    }
    await harness.waitForSimTicks(4);

    const sequence: RenderViewMode[] = ['stress', 'xray', 'pbr', 'xray', 'stress', 'pbr'];
    let peakShards = 0;
    let peakBroken = 0;

    for (const viewMode of sequence) {
      await harness.setRenderViewMode(viewMode);
      const t = await harness.waitForSimTicks(4);
      peakShards = Math.max(peakShards, t.activeShardCount);
      peakBroken = Math.max(peakBroken, t.brokenJointCount);
    }

    expect(peakShards > 0 || peakBroken > 0).toBe(true);
    const glHealth = await harness.verifyWebGL2Context();
    expect(glHealth.contextLost).toBe(false);
    harness.assertZeroRuntimeErrors('стресс-переключения визуализатора под нагрузкой разрушения');
  });

  test('[R08][F22] Строгая конечность (без NaN/Infinity) и неотрицательность всех 25+ полей getTelemetry() и DOM data-value в 4 фазах жизни сцены', async ({
    harness,
  }) => {
    const domSensorSelectors = [
      SELECTORS.telemetryDestructionPct,
      SELECTORS.telemetryIntactJoints,
      SELECTORS.telemetryRebarLinks,
      SELECTORS.telemetryBurningNodes,
      SELECTORS.telemetryMaxTempC,
      SELECTORS.telemetryKineticKj,
      SELECTORS.telemetryFps,
    ] as const;

    const assertAllTelemetryFieldsValid = async (phaseLabel: string): Promise<void> => {
      const tel = (await harness.getTelemetry()) as ExtTelemetry;
      const rawRecord = tel as unknown as Record<string, unknown>;

      for (const field of SIMULATION_NUMERIC_FIELDS) {
        const val = rawRecord[field as string];
        expect(
          typeof val === 'number' && Number.isFinite(val) && val >= 0,
          `Поле SimulationTelemetry.${String(field)} в фазе «${phaseLabel}» должно быть конечным числом >= 0 (получено: ${String(val)})`,
        ).toBe(true);
      }

      for (const intField of SIMULATION_INTEGER_COUNTERS) {
        const val = rawRecord[intField as string];
        expect(
          typeof val === 'number' && Number.isInteger(val),
          `Счётчик SimulationTelemetry.${String(intField)} в фазе «${phaseLabel}» должен быть целым числом (получено: ${String(val)})`,
        ).toBe(true);
      }

      expect(typeof tel.seismicActive).toBe('boolean');
      expect(tel.destructionPct).toBeLessThanOrEqual(100);
      expect(tel.protectedDamagePct).toBeLessThanOrEqual(100);

      // Поля базового моста и расширений A1–A3 (PROJECT.md §5)
      const bridgeNumericFields = [
        'collateralPct',
        'stars',
        'fps',
        'drawCalls',
        'walletCredits',
        'collapsedMassTons',
        'destructionScore',
        'comboMultiplier',
        'criticalNodesCount',
        'activeTriggersCount',
      ] as const;

      for (const bKey of bridgeNumericFields) {
        const val = rawRecord[bKey];
        expect(
          typeof val === 'number' && Number.isFinite(val) && val >= 0,
          `Поле моста getTelemetry().${bKey} в фазе «${phaseLabel}» должно быть конечным числом >= 0 (получено: ${String(val)})`,
        ).toBe(true);
      }

      expect(tel.collateralPct).toBeLessThanOrEqual(100);
      expect(tel.stars).toBeGreaterThanOrEqual(0);
      expect(tel.stars).toBeLessThanOrEqual(3);

      expect(tel.toolLevels).toBeDefined();
      if (tel.toolLevels) {
        for (const toolId of ALL_TOOL_IDS) {
          const lv = tel.toolLevels[toolId];
          expect(typeof lv === 'number' && Number.isInteger(lv) && lv >= 1 && lv <= 5).toBe(true);
        }
      }

      expect(Array.isArray(tel.c4SequenceQueue)).toBe(true);

      // Проверка всех 7 DOM-датчиков живой телеметрии
      for (const sel of domSensorSelectors) {
        const snap = await harness.page.locator(sel).evaluate((el: Element) => ({
          dataVal: el.getAttribute('data-value'),
          text: el.textContent ?? '',
        }));
        expect(snap.dataVal, `Отсутствует data-value на ${sel} в фазе «${phaseLabel}»`).not.toBeNull();
        const parsed = Number(snap.dataVal);
        expect(Number.isFinite(parsed) && parsed >= 0).toBe(true);
        for (const forbidden of ['NaN', 'Infinity', 'undefined']) {
          expect(snap.dataVal ?? '').not.toContain(forbidden);
          expect(snap.text).not.toContain(forbidden);
        }
      }
    };

    await harness.boot();

    // Фаза 1: Статический покой после спавна
    await harness.spawnSandboxStructure('tower', { cleanResetFirst: true });
    await harness.waitForSimTicks(10);
    await assertAllTelemetryFieldsValid('1: покой после спавна');

    // Фаза 2: Пик комбинированного взрыва #tool-bomb + землетрясения #tool-seismic
    await harness.aimAndStrikeStructure('bomb', { heightFraction: 0.16, settleTicks: 6 });
    await harness.activateSeismicTool({ settleTicks: 10 });
    await assertAllTelemetryFieldsValid('2: комбинированный взрыв и сейсмика');

    // Фаза 3: Заморозка на паузе в режиме рентгена X-Ray
    await harness.setPaused(true);
    await harness.setRenderViewMode('xray');
    await assertAllTelemetryFieldsValid('3: пауза в режиме X-Ray');

    // Фаза 4: Сразу после полного сброса сцены #scene-reset-btn
    await harness.setPaused(false);
    await harness.resetScene();
    await assertAllTelemetryFieldsValid('4: сразу после #scene-reset-btn');
  });

  test('[R08][F04][F05][F22] Защита границ destructionPct в [0, 100]: отсутствие ухода в минус при достройке блоков и потолок <= 100% при массированном оверкилл-сносе', async ({
    harness,
  }) => {
    await harness.boot();

    // 1. Нижняя граница [>= 0]: достройка новых блоков конструктором не уводит destructionPct в минус
    await harness.spawnSandboxStructure('domino', { cleanResetFirst: true });
    const tInit = await harness.waitForSimTicks(8);
    expect(tInit.destructionPct).toBe(0);

    const built1 = await harness.placeSandboxBuildBlock('brick');
    const built2 = await harness.placeSandboxBuildBlock('reinforced_concrete', [
      [-7.5, 0.6, 0],
      [0, 0.6, -7.5],
      [-6.0, 0.6, -6.0],
    ]);
    expect(built1.placed || built2.placed).toBe(true);
    await harness.exitSandboxBuildMode();

    const tAfterBuild = await harness.waitForSimTicks(10);
    const domAfterBuild = await harness.readTelemetryDomValues();
    expect(tAfterBuild.destructionPct).toBeGreaterThanOrEqual(0);
    expect(domAfterBuild.destructionPct).toBeGreaterThanOrEqual(0);

    // 2. Верхняя граница [<= 100]: массированный оверкилл-снос компактного деревянного склада
    await harness.spawnSandboxStructure('warehouse', { cleanResetFirst: true });
    const planted = await harness.plantC4OnStructure({
      count: 3,
      delaySec: 0,
      heightFraction: 0.16,
    });
    if (planted.totalPlanted > 0) {
      await harness.detonateC4AndSettle(20);
    }

    for (let i = 0; i < 5; i++) {
      await harness.aimAndStrikeStructure('bomb', {
        heightFraction: 0.14,
        settleTicks: 20,
        maxAttempts: 2,
        searchFullPolygon: true,
      });
    }

    const tOverkill = await harness.getTelemetry();
    const domOverkill = await harness.readTelemetryDomValues();

    expect(tOverkill.destructionPct).toBeGreaterThan(25);
    expect(tOverkill.destructionPct).toBeLessThanOrEqual(100);
    expect(domOverkill.destructionPct).toBeLessThanOrEqual(100);
    expect(tOverkill.intactBlockCount).toBeGreaterThanOrEqual(0);
    expect(tOverkill.intactBlockCount).toBeLessThanOrEqual(tOverkill.initialBlockCount);
  });

  test('[R08][F05][F07] Инварианты баланса узлов, связей и арматуры (intactJointCount, brokenJointCount, activeRebarCount, snappedRebarCount) при каскадном разломе ЖБ', async ({
    harness,
  }) => {
    await harness.boot();
    await harness.spawnSandboxStructure('tower', { cleanResetFirst: true });

    const rest = await harness.waitForSimTicks(10);
    expect(rest.initialBlockCount).toBeGreaterThan(0);
    expect(rest.initialJointCount).toBeGreaterThan(0);
    expect(rest.intactBlockCount).toBe(rest.initialBlockCount);
    expect(rest.intactJointCount).toBe(rest.initialJointCount);
    expect(rest.brokenJointCount).toBe(0);
    expect(rest.snappedRebarCount).toBe(0);

    const planted = await harness.plantC4OnStructure({
      count: 2,
      delaySec: 0,
      heightFraction: 0.16,
    });
    if (planted.totalPlanted > 0) {
      await harness.detonateC4AndSettle(40);
    } else {
      await harness.aimAndStrikeStructure('bomb', { heightFraction: 0.14, settleTicks: 40 });
    }

    await harness.setPaused(true);
    await harness.waitForAnimationFrames(2);

    const [t, domVals] = await Promise.all([
      harness.getTelemetry(),
      harness.readTelemetryDomValues(),
    ]);

    expect(t.brokenJointCount).toBeGreaterThan(0);
    expect(t.intactJointCount).toBeGreaterThanOrEqual(0);
    expect(t.intactJointCount).toBeLessThan(t.initialJointCount);
    expect(t.intactJointCount + t.brokenJointCount).toBeGreaterThanOrEqual(t.initialJointCount);
    expect(t.activeRebarCount).toBeGreaterThanOrEqual(0);
    expect(t.snappedRebarCount).toBeGreaterThanOrEqual(0);

    expect(Math.round(domVals.intactJoints)).toBe(t.intactJointCount);
    expect(Math.round(domVals.rebarLinks)).toBe(t.activeRebarCount);

    await harness.setPaused(false);
  });

  test('[R08][F14][F15][F22] Устойчивость рендера X-Ray и projectWorldPoint при экстремальном зуме/вращении камеры и полное обнуление датчиков при #scene-reset-btn', async ({
    harness,
  }) => {
    await harness.boot();
    await harness.spawnSandboxStructure('tower', { cleanResetFirst: true });
    await harness.setRenderViewMode('xray');

    const strike = await harness.aimAndStrikeStructure('bomb', {
      heightFraction: 0.16,
      settleTicks: 15,
    });
    expect(strike.after.brokenJointCount > 0 || strike.after.activeShardCount > 0).toBe(true);

    // Экстремальное приближение, отдаление и разворот орбитальной камеры
    await harness.zoomCameraWheel(-750);
    await harness.zoomCameraWheel(850);
    await harness.orbitCameraDrag(340, -190);

    const pNear = await harness.projectWorldPoint(0, 2, 0);
    const pFarBelow = await harness.projectWorldPoint(0, -10_000, 0);
    expect(typeof pNear.visible).toBe('boolean');
    expect(typeof pFarBelow.visible).toBe('boolean');
    if (pNear.visible) {
      expect(Number.isFinite(pNear.x)).toBe(true);
      expect(Number.isFinite(pNear.y)).toBe(true);
    }
    if (pFarBelow.visible) {
      expect(Number.isFinite(pFarBelow.x)).toBe(true);
      expect(Number.isFinite(pFarBelow.y)).toBe(true);
    }

    // Полный сброс сцены #scene-reset-btn обязан обнулить все показатели разрушения и горения
    await harness.resetScene();
    await harness.setPaused(true);
    await harness.waitForAnimationFrames(2);

    const [resetTel, resetDom] = await Promise.all([
      harness.getTelemetry(),
      harness.readTelemetryDomValues(),
    ]);

    expect(resetTel.destructionPct).toBe(0);
    expect(resetTel.brokenJointCount).toBe(0);
    expect(resetTel.activeShardCount).toBe(0);
    expect(resetTel.burningNodeCount).toBe(0);
    expect(resetDom.destructionPct).toBeCloseTo(0, 2);

    await harness.setPaused(false);
  });
});
