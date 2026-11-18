import {
  test,
  expect,
  SELECTORS,
  TOOL_BUTTON_MAP,
} from '../helpers/shatterpoint-harness';
import type { ToolId } from '../helpers/shatterpoint-harness';

test.describe('Уровень 1 — R05: Тактический и взрывной арсенал — Кинетическая пушка, C4 с задержкой и Фугас', () => {
  test('[R05][F04][F09][F18] Кинетическая пушка (#tool-cannon): прицельный выстрел, пробой стены и импульс осколков', async ({
    harness,
  }) => {
    await harness.boot();
    await harness.spawnSandboxStructure('tower', { cleanResetFirst: true });

    await harness.selectTool('cannon');
    await expect(harness.page.locator(SELECTORS.appRoot)).toHaveAttribute(
      'data-active-tool',
      'cannon',
    );

    const strike = await harness.aimAndStrikeStructure('cannon', {
      heightFraction: 0.25,
      settleTicks: 24,
    });

    expect(strike.impactConfirmed).toBe(true);
    expect(
      strike.after.activeShardCount > 0 || strike.after.brokenJointCount > 0,
    ).toBe(true);
    expect(
      strike.after.kineticEnergyKJ > 0 || strike.after.destructionPct > 0,
    ).toBe(true);
  });

  test('[R05][F18] Направленные заряды C4 (#tool-c4): закладка 3 брикетов на опоры, счётчик data-planted-c4 и залп #detonate-c4-btn', async ({
    harness,
  }) => {
    await harness.boot();
    await harness.spawnSandboxStructure('tower', { cleanResetFirst: true });

    await harness.selectTool('c4');
    await expect(harness.page.locator(SELECTORS.appRoot)).toHaveAttribute('data-active-tool', 'c4');
    await harness.setC4DelaySec(0);

    const c1 = await harness.plantC4OnStructure({ count: 1, delaySec: 0, preferSide: 'left' });
    expect(c1.totalPlanted).toBe(1);
    await expect(harness.page.locator(SELECTORS.appRoot)).toHaveAttribute('data-planted-c4', '1');

    const c2 = await harness.plantC4OnStructure({ count: 1, delaySec: 0, preferSide: 'center' });
    expect(c2.totalPlanted).toBe(2);
    await expect(harness.page.locator(SELECTORS.appRoot)).toHaveAttribute('data-planted-c4', '2');

    const c3 = await harness.plantC4OnStructure({ count: 1, delaySec: 0, preferSide: 'right' });
    expect(c3.totalPlanted).toBe(3);
    await expect(harness.page.locator(SELECTORS.appRoot)).toHaveAttribute('data-planted-c4', '3');

    const beforeBlast = await harness.getTelemetry();
    expect(beforeBlast.brokenJointCount).toBe(0);
    expect(beforeBlast.destructionPct).toBe(0);

    const afterBlast = await harness.detonateC4AndSettle(50);
    await expect(harness.page.locator(SELECTORS.appRoot)).toHaveAttribute('data-planted-c4', '0');
    expect(afterBlast.brokenJointCount).toBeGreaterThan(0);
    expect(afterBlast.destructionPct).toBeGreaterThan(3);
  });

  test('[R05][F18] Снятие заложенного заряда C4 правой кнопкой мыши без подрыва конструкции', async ({
    harness,
  }) => {
    await harness.boot();
    await harness.spawnSandboxStructure('tower', { cleanResetFirst: true });

    const leftPlanted = await harness.plantC4OnStructure({
      count: 1,
      delaySec: 0,
      preferSide: 'left',
      heightFraction: 0.2,
    });
    expect(leftPlanted.totalPlanted).toBe(1);
    expect(leftPlanted.hits.length).toBe(1);

    const rightPlanted = await harness.plantC4OnStructure({
      count: 1,
      delaySec: 0,
      preferSide: 'right',
      heightFraction: 0.2,
    });
    expect(rightPlanted.totalPlanted).toBe(2);
    expect(rightPlanted.hits.length).toBe(1);

    const removed = await harness.removeC4AtHit(rightPlanted.hits[0]);
    expect(removed).toBe(true);

    const remaining = await harness.getPlantedC4Count();
    expect(remaining).toBe(1);
    await expect(harness.page.locator(SELECTORS.appRoot)).toHaveAttribute('data-planted-c4', '1');

    const telemetry = await harness.getTelemetry();
    expect(telemetry.brokenJointCount).toBe(0);
    expect(telemetry.destructionPct).toBe(0);
  });

  test('[R05][F18] Программируемая задержка детонации C4 (#c4-delay-select): ступенчатый подрыв зарядов по таймеру', async ({
    harness,
  }) => {
    await harness.boot();
    await harness.spawnSandboxStructure('viaduct', { cleanResetFirst: true });

    await harness.selectTool('c4');
    const delayOptions = await harness.listSelectOptions(SELECTORS.c4DelaySelect);
    expect(delayOptions.length).toBeGreaterThanOrEqual(2);

    const maxDelayOpt = delayOptions.reduce((best, cur) =>
      (cur.numericValue ?? 0) > (best.numericValue ?? 0) ? cur : best,
    );
    const maxDelaySec = maxDelayOpt.numericValue ?? 0;
    expect(maxDelaySec).toBeGreaterThanOrEqual(0.5);

    // Закладываем заряды ТОЛЬКО с максимальной ненулевой задержкой (>= 0.5 с)
    const delayedCharges = await harness.plantC4OnStructure({
      count: 2,
      delaySec: maxDelaySec,
      heightFraction: 0.2,
    });
    expect(delayedCharges.totalPlanted).toBeGreaterThanOrEqual(1);

    await harness.setPaused(false);
    await harness.page.locator(SELECTORS.detonateC4Btn).click();

    // На раннем замере (~5 тиков = 0.083 с < maxDelaySec * 0.35) детонация ещё НЕ должна сработать
    const earlyTicks = Math.max(3, Math.min(5, Math.floor(maxDelaySec * 0.3 * 60)));
    const earlyTelemetry = await harness.waitForSimTicks(earlyTicks);
    expect(earlyTelemetry.brokenJointCount).toBe(0);
    expect(earlyTelemetry.destructionPct).toBe(0);

    // После прохождения полного времени задержки заряды обязаны сдетонировать и обрушить опоры
    const finalTelemetry = await harness.waitForSimTime(maxDelaySec + 0.45);
    await expect(harness.page.locator(SELECTORS.appRoot)).toHaveAttribute('data-planted-c4', '0');
    expect(finalTelemetry.brokenJointCount).toBeGreaterThan(0);
    expect(finalTelemetry.destructionPct).toBeGreaterThan(0);
  });

  test('[R05][F09][F18] Фугасная авиабомба / Метеорит (#tool-bomb): эпицентр дробления и затухающая ударная волна Садовского', async ({
    harness,
  }) => {
    await harness.boot();
    await harness.spawnSandboxStructure('fortress', { cleanResetFirst: true });

    await harness.selectTool('bomb');
    await expect(harness.page.locator(SELECTORS.appRoot)).toHaveAttribute(
      'data-active-tool',
      'bomb',
    );

    const strike = await harness.aimAndStrikeStructure('bomb', {
      heightFraction: 0.14,
      settleTicks: 12,
    });
    expect(strike.impactConfirmed).toBe(true);

    let peakKineticKj = strike.after.kineticEnergyKJ;
    let peakShards = strike.after.activeShardCount;

    await expect
      .poll(
        async () => {
          const t = await harness.waitForSimTicks(8);
          if (t.kineticEnergyKJ > peakKineticKj) peakKineticKj = t.kineticEnergyKJ;
          if (t.activeShardCount > peakShards) peakShards = t.activeShardCount;
          return t.brokenJointCount >= 4 && t.destructionPct > 12 && peakShards > 0 && peakKineticKj > 2;
        },
        { timeout: 8_000, message: 'Ожидание масштабного разрушения от ударной волны #tool-bomb' },
      )
      .toBe(true);
  });

  test('[R05][F08][F09] Вторичный кинетический урон обломков (secondaryImpactsCount > 0) при обрушении верхних ярусов на нижние', async ({
    harness,
  }) => {
    await harness.boot();
    await harness.spawnSandboxStructure('tower', { cleanResetFirst: true });
    // Размещаем рядом второе сооружение для плотного поля падения массивных плит
    await harness.spawnSandboxStructure('warehouse', { cleanResetFirst: false });

    const planted = await harness.plantC4OnStructure({
      count: 3,
      delaySec: 0,
      heightFraction: 0.42,
    });
    if (planted.totalPlanted > 0) {
      await harness.detonateC4AndSettle(40);
    }

    await harness.aimAndStrikeStructure('bomb', {
      heightFraction: 0.35,
      settleTicks: 45,
    });

    await expect
      .poll(
        async () => {
          await harness.waitForSimTicks(12);
          return (await harness.getTelemetry()).secondaryImpactsCount;
        },
        {
          timeout: 10_000,
          message: 'Ожидание вторичного кинетического урона от падающих глыб (secondaryImpactsCount > 0)',
        },
      )
      .toBeGreaterThan(0);
  });
});

test.describe('Уровень 1 — R06: Термический и стихийный арсенал — Плазморезак, Термитная кассета и Сейсмогенератор', () => {
  test('[R06][F10][F18] Термический плазморезак (#tool-cutter): перерезание несущего узла и арматуры непрерывным лучом', async ({
    harness,
  }) => {
    await harness.boot();
    await harness.spawnSandboxStructure('tower', { cleanResetFirst: true });

    await harness.selectTool('cutter');
    await expect(harness.page.locator(SELECTORS.appRoot)).toHaveAttribute(
      'data-active-tool',
      'cutter',
    );

    const cutResult = await harness.aimAndStrikeStructure('cutter', {
      heightFraction: 0.18,
      holdMs: 750,
      settleTicks: 30,
    });

    expect(cutResult.after.maxTemperatureC).toBeGreaterThan(80);
    expect(
      cutResult.after.brokenJointCount > 0 ||
        cutResult.after.snappedRebarCount > 0 ||
        cutResult.after.activeShardCount > 0,
    ).toBe(true);
  });

  test('[R06][F10][F18] Термитно-зажигательная кассета (#tool-incendiary): высокотемпературный поджог и конвективный подъём огня', async ({
    harness,
  }) => {
    await harness.boot();
    await harness.spawnSandboxStructure('warehouse', { cleanResetFirst: true });

    await harness.selectTool('incendiary');
    await expect(harness.page.locator(SELECTORS.appRoot)).toHaveAttribute(
      'data-active-tool',
      'incendiary',
    );

    await harness.aimAndStrikeStructure('incendiary', {
      heightFraction: 0.15,
      settleTicks: 24,
      requireBurning: true,
      searchFullPolygon: true,
    });

    await expect
      .poll(
        async () => {
          const t = await harness.waitForSimTicks(20);
          return t.maxTemperatureC >= 350 && t.burningNodeCount > 0 && t.brokenJointCount > 0;
        },
        {
          timeout: 12_000,
          message: 'Ожидание развития высокотемпературного пожара и выгорания деревянных связей',
        },
      )
      .toBe(true);
  });

  test('[R06][F10] Термическое ослабление стальных опор при раскалении до 500–850 °C с проседанием под нагрузкой', async ({
    harness,
  }) => {
    await harness.boot();
    await harness.spawnSandboxStructure('hangar', { cleanResetFirst: true });
    const initial = await harness.waitForSimTicks(15);
    const stress0 = initial.maxStressUtilization;
    const h0 = initial.targetMaxHeightM;

    const firstThermal = await harness.aimAndStrikeStructure('incendiary', {
      heightFraction: 0.2,
      settleTicks: 35,
      searchFullPolygon: true,
    });

    const checkTemp = await harness.getTelemetry();
    if (checkTemp.maxTemperatureC < 520) {
      await harness.aimAndStrikeStructure('incendiary', {
        worldPoint: firstThermal.usedPoint?.world,
        heightFraction: 0.2,
        settleTicks: 35,
        searchFullPolygon: true,
      });
    }

    await expect
      .poll(
        async () => {
          const t = await harness.waitForSimTicks(18);
          return (
            t.maxTemperatureC >= 500 &&
            (t.maxStressUtilization > stress0 ||
              t.plasticHingeCount > 0 ||
              t.brokenJointCount > 0 ||
              t.targetMaxHeightM < h0 - 0.05)
          );
        },
        {
          timeout: 10_000,
          message: 'Ожидание нагрева стальных опор >= 500 °C и термического снижения несущей способности',
        },
      )
      .toBe(true);
  });

  test('[R06][F09][F10] Тепловая детонация взрывоопасных ёмкостей при нагреве от пожара без прямого попадания снаряда', async ({
    harness,
  }) => {
    await harness.boot();
    await harness.switchMode('sandbox');
    await harness.resetScene();

    // Укладываем деревянный очаг #mat-wood и рядом вплотную взрывоопасную ёмкость #mat-explosive
    const woodSpot = await harness.placeSandboxBuildBlock('wood', [
      [7.0, 0.6, 0],
      [-7.0, 0.6, 0],
    ]);
    expect(woodSpot.placed).toBe(true);
    expect(woodSpot.hit).not.toBeNull();

    const wPos = woodSpot.hit!.world;
    const barrelSpot = await harness.placeSandboxBuildBlock('explosive', [
      [wPos[0] + 1.1, wPos[1], wPos[2]],
      [wPos[0] - 1.1, wPos[1], wPos[2]],
      [wPos[0], wPos[1] + 1.0, wPos[2]],
    ]);
    expect(barrelSpot.placed).toBe(true);

    // Добавляем второй деревянный блок для устойчивого теплового потока к бочке
    await harness.placeSandboxBuildBlock('wood', [
      [wPos[0], wPos[1], wPos[2] + 1.0],
      [wPos[0], wPos[1], wPos[2] - 1.0],
    ]);
    await harness.exitSandboxBuildMode();

    // Поджигаем деревянный настил (без прямого баллистического выстрела по бочке)
    await harness.selectTool('incendiary');
    const woodScreen = await harness.projectWorldPointsToClickableScreen([wPos], 0);
    const pt = woodScreen[0]?.screen ?? woodSpot.hit!.screen;
    await harness.page.mouse.click(pt.x, pt.y, { button: 'left' });

    let sawFire = false;
    await expect
      .poll(
        async () => {
          const t = await harness.waitForSimTicks(15);
          if (t.burningNodeCount > 0) sawFire = true;
          return sawFire && t.detonatedExplosivesCount >= 1;
        },
        {
          timeout: 12_000,
          message: 'Ожидание тепловой детонации взрывоопасной бочки от распространившегося пожара',
        },
      )
      .toBe(true);
  });

  test('[R06][F11][F18] Сейсмический генератор (#tool-seismic): запуск землетрясения и сейсмическое повреждение сооружения', async ({
    harness,
  }) => {
    await harness.boot();
    await harness.spawnSandboxStructure('tower', { cleanResetFirst: true });
    const initial = await harness.waitForSimTicks(12);
    const stress0 = initial.maxStressUtilization;

    const afterActivate = await harness.activateSeismicTool({
      freqHz: 2.5,
      ampM: 1.5,
      settleTicks: 20,
    });
    await expect(harness.page.locator(SELECTORS.appRoot)).toHaveAttribute(
      'data-active-tool',
      'seismic',
    );

    let sawSeismicActive = afterActivate.seismicActive;
    let maxFreq = afterActivate.seismicFrequencyHz;
    let maxAmp = afterActivate.seismicAmplitudeM;

    await expect
      .poll(
        async () => {
          const t = await harness.waitForSimTicks(20);
          if (t.seismicActive) sawSeismicActive = true;
          if (t.seismicFrequencyHz > maxFreq) maxFreq = t.seismicFrequencyHz;
          if (t.seismicAmplitudeM > maxAmp) maxAmp = t.seismicAmplitudeM;
          return (
            sawSeismicActive &&
            maxFreq >= 0.5 &&
            maxAmp > 0 &&
            (t.brokenJointCount > 0 ||
              t.kineticEnergyKJ > 0.05 ||
              t.maxStressUtilization > stress0 + 0.05)
          );
        },
        {
          timeout: 10_000,
          message: 'Ожидание активного землетрясения #tool-seismic и сейсмической раскачки здания',
        },
      )
      .toBe(true);
  });

  test('[R06][F18] Перебор всех 6 кнопок арсенала с точной проверкой канонических идентификаторов data-active-tool', async ({
    harness,
  }) => {
    await harness.boot();
    await harness.switchMode('sandbox');

    const expectedTools: ToolId[] = ['cannon', 'c4', 'bomb', 'cutter', 'incendiary', 'seismic'];
    for (const tool of expectedTools) {
      const btn = harness.page.locator(TOOL_BUTTON_MAP[tool]);
      await expect(btn).toBeVisible();
      await expect(btn).toBeEnabled();
      await btn.click();
      await expect(harness.page.locator(SELECTORS.appRoot)).toHaveAttribute(
        'data-active-tool',
        tool,
      );
    }
  });
});
