import {
  test,
  expect,
  SELECTORS,
  areByteArraysDifferent,
} from '../helpers/shatterpoint-harness';

test.describe('Уровень 1 — R07: Управление временем симуляции — Пауза, Пошаговый тик и Bullet-Time', () => {
  test('[R07][F12][F20] Пауза (#time-pause-btn): мгновенная заморозка тиков симуляции при сохранении интерактивности 3D-камеры', async ({
    harness,
  }) => {
    await harness.boot();
    await harness.spawnSandboxStructure('tower', { cleanResetFirst: true });

    await harness.aimAndStrikeStructure('bomb', {
      heightFraction: 0.16,
      settleTicks: 8,
    });

    await harness.setPaused(true);
    await expect(harness.page.locator(SELECTORS.appRoot)).toHaveAttribute('data-paused', 'true');

    const paused1 = await harness.getTelemetry();
    // Выдерживаем ~20 кадров рендера в браузере и убеждаемся, что тик физики строго заморожен
    await harness.waitForAnimationFrames(20);
    const paused2 = await harness.getTelemetry();

    expect(paused2.tick).toBe(paused1.tick);
    expect(paused2.simTimeSec).toBe(paused1.simTimeSec);

    // Во время паузы орбитальная 3D-камера обязана оставаться полностью интерактивной
    const projBefore = await harness.projectWorldPoint(0, 3, 0);
    await harness.orbitCameraDrag(140, -30);
    const projAfter = await harness.projectWorldPoint(0, 3, 0);
    expect(Math.hypot(projAfter.x - projBefore.x, projAfter.y - projBefore.y)).toBeGreaterThan(10);

    // Снимаем паузу — тики физики возобновляют движение
    await harness.setPaused(false);
    await expect(harness.page.locator(SELECTORS.appRoot)).toHaveAttribute('data-paused', 'false');
    const resumed = await harness.waitForSimTicks(8);
    expect(resumed.tick).toBeGreaterThan(paused2.tick);
  });

  test('[R07][F02][F12] Пошаговый режим (#time-step-btn): строго дискретное продвижение ровно на 1 тик (1/60 с) за клик', async ({
    harness,
  }) => {
    await harness.boot();
    await harness.spawnSandboxStructure('tower', { cleanResetFirst: true });

    await harness.setPaused(true);
    const t0 = await harness.getTelemetry();
    const tick0 = t0.tick;
    const time0 = t0.simTimeSec;

    for (let stepIdx = 1; stepIdx <= 3; stepIdx++) {
      await harness.page.locator(SELECTORS.timeStepBtn).click();
      await expect
        .poll(async () => (await harness.getTelemetry()).tick, {
          timeout: 5_000,
          message: `Ожидание строгого шага #${stepIdx} по #time-step-btn`,
        })
        .toBe(tick0 + stepIdx);

      const rootState = await harness.getAppRootState();
      expect(rootState.paused).toBe(true);
      expect(rootState.simTick).toBe(tick0 + stepIdx);
    }

    const t3 = await harness.getTelemetry();
    expect(t3.tick).toBe(tick0 + 3);
    expect(t3.simTimeSec - time0).toBeCloseTo(3 / 60, 3);
  });

  test('[R07][F12][F16][F20] Замедление времени Bullet-Time (#time-bullet-btn): снижение data-time-scale и замедление темпа физики', async ({
    harness,
  }) => {
    await harness.boot();
    await harness.spawnSandboxStructure('tower', { cleanResetFirst: true });
    await harness.setPaused(false);
    await harness.waitForSimTicks(6);

    // Замеряем продвижение модельного времени и тиков за фиксированные 30 кадров rAF при 1.0x
    const n0 = await harness.getTelemetry();
    await harness.waitForAnimationFrames(30);
    const n1 = await harness.getTelemetry();
    const normalDeltaTicks = n1.tick - n0.tick;
    const normalDeltaSimSec = n1.simTimeSec - n0.simTimeSec;
    expect(normalDeltaTicks).toBeGreaterThanOrEqual(8);
    expect(normalDeltaSimSec).toBeGreaterThan(0.12);

    // Включаем Bullet-Time и измеряем темп на той же установившейся сцене (вне компиляции шейдеров взрыва)
    const bulletScale = await harness.toggleBulletTime();
    expect(bulletScale).toBeGreaterThan(0);
    expect(bulletScale).toBeLessThan(1.0);

    const b0 = await harness.getTelemetry();
    await harness.waitForAnimationFrames(30);
    let b1 = await harness.getTelemetry();
    let measuredFrames = 30;
    if (b1.tick === b0.tick) {
      await harness.waitForAnimationFrames(18);
      b1 = await harness.getTelemetry();
      measuredFrames = 48;
    }

    const bulletDeltaTicks = b1.tick - b0.tick;
    const bulletDeltaSimSec = b1.simTimeSec - b0.simTimeSec;
    const normalSimPerFrame = normalDeltaSimSec / 30;
    const bulletSimPerFrame = bulletDeltaSimSec / measuredFrames;

    expect(bulletDeltaTicks).toBeGreaterThan(0);
    expect(bulletSimPerFrame).toBeGreaterThan(0);
    expect(bulletSimPerFrame).toBeLessThan(normalSimPerFrame * 0.65);

    // Отдельно проверяем корректную работу реального взрыва и звукового фильтра в режиме Bullet-Time
    const blastInBullet = await harness.aimAndStrikeStructure('bomb', {
      heightFraction: 0.16,
      settleTicks: 6,
    });
    expect(blastInBullet.impactConfirmed).toBe(true);
    expect(
      blastInBullet.after.brokenJointCount > 0 || blastInBullet.after.activeShardCount > 0,
    ).toBe(true);
    harness.assertZeroRuntimeErrors('замедления Bullet-Time со звуковым фильтром');
  });

  test('[R07][F12] Селектор масштаба времени (#time-scale-select): работа сверхзамедления (0.05x) и ускорения (2x)', async ({
    harness,
  }) => {
    await harness.boot();
    await harness.spawnSandboxStructure('tower', { cleanResetFirst: true });
    await harness.setPaused(false);
    await harness.waitForSimTicks(6);

    const scaleOptions = await harness.listSelectOptions(SELECTORS.timeScaleSelect);
    expect(scaleOptions.length).toBeGreaterThanOrEqual(3);

    const slowScale = await harness.setTimeScale(0.05);
    expect(slowScale).toBeGreaterThan(0);
    expect(slowScale).toBeLessThanOrEqual(0.25);

    const s0 = await harness.getTelemetry();
    await harness.waitForAnimationFrames(30);
    const s1 = await harness.getTelemetry();
    const ticksSlow = s1.tick - s0.tick;
    const simSlow = s1.simTimeSec - s0.simTimeSec;

    const fastScale = await harness.setTimeScale(2.0);
    expect(fastScale).toBeGreaterThan(1.0);

    const f0 = await harness.getTelemetry();
    await harness.waitForAnimationFrames(30);
    const f1 = await harness.getTelemetry();
    const ticksFast = f1.tick - f0.tick;
    const simFast = f1.simTimeSec - f0.simTimeSec;

    expect(ticksFast).toBeGreaterThan(ticksSlow);
    expect(ticksFast).toBeGreaterThanOrEqual(Math.max(6, ticksSlow * 3));
    expect(simFast).toBeGreaterThan(Math.max(0.08, simSlow * 3));

    const restoredScale = await harness.setTimeScale(1.0);
    expect(restoredScale).toBeCloseTo(1.0, 1);
  });

  test('[R07][F12][F18] Тактическая расстановка C4 на паузе с последующей детонацией в режиме Bullet-Time', async ({
    harness,
  }) => {
    await harness.boot();
    await harness.spawnSandboxStructure('tower', { cleanResetFirst: true });

    await harness.setPaused(true);
    const pausedTick = (await harness.getTelemetry()).tick;

    const planted = await harness.plantC4OnStructure({
      count: 2,
      delaySec: 0,
      heightFraction: 0.18,
    });
    expect(planted.totalPlanted).toBe(2);
    await expect(harness.page.locator(SELECTORS.appRoot)).toHaveAttribute('data-planted-c4', '2');
    expect((await harness.getTelemetry()).tick).toBe(pausedTick);

    const scale = await harness.toggleBulletTime();
    expect(scale).toBeLessThan(1.0);

    await harness.setPaused(false);
    await harness.page.locator(SELECTORS.detonateC4Btn).click();

    await expect
      .poll(
        async () => {
          await harness.waitForSimTicks(4);
          const t = await harness.getTelemetry();
          const c4Left = await harness.getPlantedC4Count();
          return c4Left === 0 && t.brokenJointCount > 0;
        },
        { timeout: 10_000, message: 'Ожидание детонации C4 в режиме Bullet-Time после снятия паузы' },
      )
      .toBe(true);
  });
});

test.describe('Уровень 1 — R08: Инженерный визуализатор (PBR, Stress, X-Ray) и живая телеметрия', () => {
  test('[R08][F14] Переключение режимов рендера (#view-pbr-btn, #view-stress-btn, #view-xray-btn) с визуальным изменением кадра WebGL2', async ({
    harness,
  }) => {
    await harness.boot();
    await harness.spawnSandboxStructure('tower', { cleanResetFirst: true });
    await harness.waitForSimTicks(10);

    // Фиксируем физику и камеру на паузе, чтобы различия кадров определялись исключительно шейдером/слоями визуализатора
    await harness.setPaused(true);

    await harness.setRenderViewMode('pbr');
    await harness.waitForAnimationFrames(3);
    const imgPbr = await harness.captureCanvasPngBytes();

    await harness.setRenderViewMode('stress');
    await harness.waitForAnimationFrames(3);
    const imgStress = await harness.captureCanvasPngBytes();

    await harness.setRenderViewMode('xray');
    await harness.waitForAnimationFrames(3);
    const imgXray = await harness.captureCanvasPngBytes();

    expect(imgPbr.byteLength).toBeGreaterThan(2000);
    expect(imgStress.byteLength).toBeGreaterThan(2000);
    expect(imgXray.byteLength).toBeGreaterThan(2000);

    expect(areByteArraysDifferent(imgPbr, imgStress)).toBe(true);
    expect(areByteArraysDifferent(imgStress, imgXray)).toBe(true);
    expect(areByteArraysDifferent(imgPbr, imgXray)).toBe(true);
  });

  test('[R08][F06][F14] Тепловая карта напряжений (#view-stress-btn): рост maxStressUtilization при выбивании угловой опоры', async ({
    harness,
  }) => {
    await harness.boot();
    await harness.spawnSandboxStructure('tower', { cleanResetFirst: true });
    await harness.setRenderViewMode('stress');

    const baseline = await harness.waitForSimTicks(15);
    const s0 = baseline.maxStressUtilization;
    expect(s0).toBeGreaterThan(0);

    const planted = await harness.plantC4OnStructure({
      count: 1,
      delaySec: 0,
      preferSide: 'left',
      heightFraction: 0.14,
    });
    expect(planted.totalPlanted).toBe(1);

    await harness.page.locator(SELECTORS.detonateC4Btn).click();

    let sPeak = s0;
    await expect
      .poll(
        async () => {
          const t = await harness.waitForSimTicks(6);
          if (t.maxStressUtilization > sPeak) sPeak = t.maxStressUtilization;
          return t.brokenJointCount >= 1 && sPeak > s0;
        },
        {
          timeout: 8_000,
          message: 'Ожидание роста maxStressUtilization при перераспределении нагрузки после подрыва опоры',
        },
      )
      .toBe(true);
  });

  test('[R08][F07][F14] Скелетный рентген связей и арматуры (#view-xray-btn): работа при расколе ЖБ без ошибок рендерера', async ({
    harness,
  }) => {
    await harness.boot();
    await harness.spawnSandboxStructure('tower', { cleanResetFirst: true });
    await harness.setRenderViewMode('xray');
    await expect(harness.page.locator(SELECTORS.appRoot)).toHaveAttribute(
      'data-render-mode',
      'xray',
    );

    // Включаем Bullet-Time для точного перехвата упруго-пластичных тяжей арматуры ЖБ и сверки #telemetry-rebar-links
    await harness.toggleBulletTime();

    const planted = await harness.plantC4OnStructure({
      count: 2,
      delaySec: 0,
      heightFraction: 0.22,
    });
    if (planted.totalPlanted > 0) {
      await harness.page.locator(SELECTORS.detonateC4Btn).click();
    } else {
      await harness.aimAndStrikeStructure('cannon', { settleTicks: 6 });
    }

    let sawRebarActivity = false;
    await expect
      .poll(
        async () => {
          await harness.waitForSimTicks(3);
          await harness.setPaused(true);
          await harness.waitForAnimationFrames(1);

          const [domVals, telemetry] = await Promise.all([
            harness.readTelemetryDomValues(),
            harness.getTelemetry(),
          ]);

          const rebarSynced = Math.round(domVals.rebarLinks) === telemetry.activeRebarCount;
          if (telemetry.activeRebarCount > 0 || telemetry.snappedRebarCount > 0) {
            sawRebarActivity = true;
          }

          if (sawRebarActivity && rebarSynced && telemetry.drawCalls > 0) {
            return true;
          }

          await harness.setPaused(false);
          return false;
        },
        {
          timeout: 10_000,
          message:
            'Ожидание активации/разрыва арматуры ЖБ в режиме X-Ray и синхронного обновления #telemetry-rebar-links',
        },
      )
      .toBe(true);

    const [finalDom, finalTelemetry] = await Promise.all([
      harness.readTelemetryDomValues(),
      harness.getTelemetry(),
    ]);
    expect(finalTelemetry.drawCalls).toBeGreaterThan(0);
    expect(Math.round(finalDom.rebarLinks)).toBe(finalTelemetry.activeRebarCount);
    expect(Math.round(finalDom.intactJoints)).toBe(finalTelemetry.intactJointCount);

    await harness.setPaused(false);
    await harness.setTimeScale(1.0);
    harness.assertZeroRuntimeErrors('рендера скелетного рентгена X-Ray при расколе ЖБ');
  });

  test('[R08][F22] Наличие, валидность data-value и синхронизация всех 7 DOM-индикаторов живой телеметрии с getTelemetry()', async ({
    harness,
  }) => {
    await harness.boot();
    await harness.spawnSandboxStructure('tower', { cleanResetFirst: true });
    await harness.waitForSimTicks(15);

    const sensorSelectors = [
      SELECTORS.telemetryDestructionPct,
      SELECTORS.telemetryIntactJoints,
      SELECTORS.telemetryRebarLinks,
      SELECTORS.telemetryBurningNodes,
      SELECTORS.telemetryMaxTempC,
      SELECTORS.telemetryKineticKj,
      SELECTORS.telemetryFps,
    ];
    for (const sel of sensorSelectors) {
      await expect(harness.page.locator(sel)).toBeVisible();
    }

    // Фиксируем тик на паузе для строгой поштучной сверки всех 7 DOM data-value с getTelemetry()
    await harness.setPaused(true);
    await harness.waitForAnimationFrames(2);

    const [domVals, bridgeVals] = await Promise.all([
      harness.readTelemetryDomValues(),
      harness.getTelemetry(),
    ]);

    expect(domVals.destructionPct).toBeCloseTo(bridgeVals.destructionPct, 1);
    expect(domVals.destructionPct).toBeCloseTo(0, 1);

    expect(Math.round(domVals.intactJoints)).toBe(bridgeVals.intactJointCount);
    expect(domVals.intactJoints).toBeGreaterThan(0);

    expect(Math.round(domVals.rebarLinks)).toBe(bridgeVals.activeRebarCount);

    expect(Math.round(domVals.burningNodes)).toBe(bridgeVals.burningNodeCount);
    expect(domVals.burningNodes).toBe(0);

    expect(domVals.maxTempC).toBeCloseTo(bridgeVals.maxTemperatureC, 1);
    expect(domVals.maxTempC).toBeGreaterThanOrEqual(15);
    expect(domVals.maxTempC).toBeLessThanOrEqual(35);

    expect(domVals.kineticKj).toBeCloseTo(bridgeVals.kineticEnergyKJ, 1);

    expect(domVals.fps).toBeGreaterThan(0);
    expect(Math.abs(domVals.fps - bridgeVals.fps)).toBeLessThanOrEqual(15);

    await harness.setPaused(false);
  });

  test('[R08][F08][F09][F22] Реакция механических датчиков телеметрии (#telemetry-destruction-pct, #telemetry-intact-joints, #telemetry-kinetic-kj) на взрыв', async ({
    harness,
  }) => {
    await harness.boot();
    await harness.spawnSandboxStructure('tower', { cleanResetFirst: true });
    await harness.waitForSimTicks(10);

    const beforeDom = await harness.readTelemetryDomValues();
    expect(beforeDom.intactJoints).toBeGreaterThan(0);

    await harness.aimAndStrikeStructure('bomb', {
      heightFraction: 0.14,
      settleTicks: 6,
    });

    let sawKineticDom = false;
    await expect
      .poll(
        async () => {
          await harness.waitForSimTicks(6);
          const curDom = await harness.readTelemetryDomValues();
          if (curDom.kineticKj > 0) sawKineticDom = true;
          return (
            curDom.destructionPct > 5 &&
            curDom.intactJoints < beforeDom.intactJoints &&
            sawKineticDom
          );
        },
        {
          timeout: 8_000,
          message: 'Ожидание обновления DOM-датчиков разрушения, целых связей и кинетической энергии',
        },
      )
      .toBe(true);
  });

  test('[R08][F10][F22] Реакция термических датчиков телеметрии (#telemetry-burning-nodes, #telemetry-max-temp-c) на развитие пожара', async ({
    harness,
  }) => {
    await harness.boot();
    await harness.spawnSandboxStructure('warehouse', { cleanResetFirst: true });

    const initialDom = await harness.readTelemetryDomValues();
    expect(initialDom.burningNodes).toBe(0);

    await harness.aimAndStrikeStructure('incendiary', {
      heightFraction: 0.16,
      settleTicks: 20,
      requireBurning: true,
      searchFullPolygon: true,
    });

    await expect
      .poll(
        async () => {
          await harness.waitForSimTicks(12);
          const domVals = await harness.readTelemetryDomValues();
          return domVals.burningNodes >= 1 && domVals.maxTempC >= 260;
        },
        {
          timeout: 10_000,
          message: 'Ожидание роста #telemetry-burning-nodes >= 1 и #telemetry-max-temp-c >= 260',
        },
      )
      .toBe(true);
  });
});
