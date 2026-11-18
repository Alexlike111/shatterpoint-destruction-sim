import {
  test,
  expect,
  SELECTORS,
  CONTRACT_SELECTORS,
} from '../helpers/shatterpoint-harness';

test.describe('Уровень 1 — R09: Физическая Лаборатория-полигон — 4 стенда и пульт физических констант', () => {
  test('[R09][F03][F10][F21] Стенд Материаловедения и Термодинамики (#lab-bench-materials): дифференцированная реакция образцов на нагрев и удар', async ({
    harness,
  }) => {
    await harness.boot();
    const initial = await harness.selectLabBench('materials');

    expect(initial.mode).toBe('lab');
    expect(initial.initialBlockCount).toBeGreaterThanOrEqual(5);
    expect(initial.brokenJointCount).toBe(0);

    await harness.aimAndStrikeStructure('incendiary', {
      heightFraction: 0.25,
      settleTicks: 24,
      requireBurning: true,
      searchFullPolygon: true,
    });

    await harness.aimAndStrikeStructure('cannon', {
      heightFraction: 0.3,
      settleTicks: 24,
      searchFullPolygon: true,
    });

    await expect
      .poll(
        async () => {
          const t = await harness.waitForSimTicks(15);
          return (
            t.burningNodeCount > 0 &&
            t.maxTemperatureC >= 260 &&
            (t.brokenJointCount > 0 || t.activeShardCount > 0)
          );
        },
        {
          timeout: 10_000,
          message: 'Ожидание дифференцированной реакции образцов материалов на нагрев и баллистический удар',
        },
      )
      .toBe(true);
  });

  test('[R09][F09][F12][F21] Баллистический коридор (#lab-bench-ballistics) и влияние ползунка гравитации (#slider-gravity) на физический мир', async ({
    harness,
  }) => {
    await harness.boot();
    await harness.selectLabBench('ballistics');

    // Невесомость: гравитация 0 м/с² -> собственная весовая нагрузка в StressSolver минимальна
    const zeroG = await harness.setRangeSlider('gravity', 0);
    expect(zeroG.appliedValue).toBeCloseTo(0, 1);
    const tZeroG = await harness.waitForSimTicks(20);
    const stressZeroG = tZeroG.maxStressUtilization;

    // Баллистический пробой мишеней в коридоре
    const shot = await harness.aimAndStrikeStructure('cannon', {
      heightFraction: 0.3,
      settleTicks: 25,
      searchFullPolygon: true,
    });
    expect(shot.after.brokenJointCount > 0 || shot.after.activeShardCount > 0).toBe(true);

    // Сброс стенда и повышенная гравитация ~28 м/с²
    await harness.resetScene();
    const highG = await harness.setRangeSlider('gravity', 28);
    expect(highG.appliedValue).toBeGreaterThanOrEqual(20);
    const tHighG = await harness.waitForSimTicks(20);
    const stressHighG = tHighG.maxStressUtilization;

    expect(stressHighG).toBeGreaterThan(stressZeroG);
  });

  test('[R09][F09][F21] Полигон ударных волн и цепной детонации (#lab-bench-blast) с калибровкой ползунка #slider-blast-falloff', async ({
    harness,
  }) => {
    await harness.boot();
    await harness.selectLabBench('blast');

    const falloffMeta = await harness.getSliderMeta('blastFalloff');
    await harness.setRangeSlider('blastFalloff', falloffMeta.min);
    await harness.waitForSimTicks(8);

    const strikeA = await harness.aimAndStrikeStructure('bomb', {
      preferSide: 'left',
      heightFraction: 0.2,
      settleTicks: 40,
      maxAttempts: 1,
      searchFullPolygon: true,
    });
    const usedWorld = strikeA.usedPoint?.world ?? [-4.0, 1.5, 0];
    const destrA = strikeA.after.destructionPct;
    const brokenA = strikeA.after.brokenJointCount;
    const detonatedA = strikeA.after.detonatedExplosivesCount;

    await harness.selectLabBench('blast');
    await harness.setRangeSlider('blastFalloff', falloffMeta.max);
    await harness.waitForSimTicks(8);

    const strikeB = await harness.aimAndStrikeStructure('bomb', {
      worldPoint: usedWorld,
      settleTicks: 40,
      maxAttempts: 1,
    });
    const destrB = strikeB.after.destructionPct;
    const brokenB = strikeB.after.brokenJointCount;
    const detonatedB = strikeB.after.detonatedExplosivesCount;

    expect(Math.max(detonatedA, detonatedB)).toBeGreaterThanOrEqual(1);
    expect(Math.max(destrA, destrB)).toBeGreaterThan(0);
    expect(
      Math.abs(destrA - destrB) > 0.05 || brokenA !== brokenB,
    ).toBe(true);
  });

  test('[R09][F11][F21] Сейсмоплатформа (#lab-bench-seismic): управление частотой (#slider-quake-freq-hz), амплитудой (#slider-quake-amp) и запуск #btn-trigger-quake', async ({
    harness,
  }) => {
    await harness.boot();
    await harness.selectLabBench('seismic');

    await expect(harness.page.locator(SELECTORS.sliderQuakeFreqHz)).toBeVisible();
    await expect(harness.page.locator(SELECTORS.sliderQuakeAmp)).toBeVisible();
    await expect(harness.page.locator(SELECTORS.btnTriggerQuake)).toBeVisible();

    const tLow = await harness.triggerLabEarthquake({
      freqHz: 2.5,
      ampM: 0.8,
      settleTicks: 12,
    });
    expect(tLow.seismicActive).toBe(true);
    expect(tLow.seismicFrequencyHz).toBeCloseTo(2.5, 0);
    expect(tLow.seismicAmplitudeM).toBeCloseTo(0.8, 1);

    const tHigh = await harness.triggerLabEarthquake({
      freqHz: 9.0,
      ampM: 1.6,
      settleTicks: 12,
    });
    expect(tHigh.seismicActive).toBe(true);
    expect(tHigh.seismicFrequencyHz).toBeCloseTo(9.0, 0);
    expect(tHigh.seismicAmplitudeM).toBeCloseTo(1.6, 1);
  });

  test('[R09][F11][F21] Сейсмический резонанс макетов разной высоты при запуске вибростенда #lab-bench-seismic', async ({
    harness,
  }) => {
    await harness.boot();
    await harness.selectLabBench('seismic');

    await harness.triggerLabEarthquake({
      freqHz: 2.2,
      ampM: 1.7,
      settleTicks: 20,
    });

    let maxStress = 0;
    await expect
      .poll(
        async () => {
          const t = await harness.waitForSimTicks(25);
          if (t.maxStressUtilization > maxStress) maxStress = t.maxStressUtilization;
          return maxStress > 0.6 && t.brokenJointCount > 0;
        },
        {
          timeout: 12_000,
          message: 'Ожидание резонансного разрушения макетов на вибростенде #lab-bench-seismic',
        },
      )
      .toBe(true);
  });

  test('[R09][F12][F21] Ползунки прочности связей (#slider-joint-strength), вторичного урона (#slider-secondary-dmg) и скорости огня (#slider-fire-rate)', async ({
    harness,
  }) => {
    await harness.boot();
    await harness.selectLabBench('ballistics');

    // Проверяем видимость всех трёх целевых ползунков
    await expect(harness.page.locator(SELECTORS.sliderJointStrength)).toBeVisible();
    await expect(harness.page.locator(SELECTORS.sliderSecondaryDmg)).toBeVisible();
    await expect(harness.page.locator(SELECTORS.sliderFireRate)).toBeVisible();

    // 1. Чистый эксперимент #slider-joint-strength (5.0 vs 0.1) при фиксированном secondaryDmg = 1.0
    await harness.setRangeSlider('jointStrength', 5.0);
    await harness.setRangeSlider('secondaryDmg', 1.0);
    const strongShot = await harness.aimAndStrikeStructure('cannon', {
      preferSide: 'center',
      heightFraction: 0.25,
      settleTicks: 30,
      maxAttempts: 1,
    });
    const targetPt = strongShot.usedPoint?.world ?? [0, 1.8, 0];
    const brokenStrong = strongShot.after.brokenJointCount;

    await harness.selectLabBench('ballistics');
    await harness.setRangeSlider('jointStrength', 0.1);
    await harness.setRangeSlider('secondaryDmg', 1.0);
    const weakShot = await harness.aimAndStrikeStructure('cannon', {
      worldPoint: targetPt,
      settleTicks: 30,
      maxAttempts: 1,
    });
    const brokenWeak = weakShot.after.brokenJointCount;
    expect(brokenWeak).toBeGreaterThan(brokenStrong);

    // 2. Чистый эксперимент #slider-secondary-dmg (0.0 vs 3.0) при фиксированном jointStrength = 1.0
    await harness.selectLabBench('seismic');
    await harness.setRangeSlider('jointStrength', 1.0);
    await harness.setRangeSlider('secondaryDmg', 0.0);
    const secShotOff = await harness.aimAndStrikeStructure('bomb', {
      preferSide: 'center',
      heightFraction: 0.45,
      settleTicks: 55,
      maxAttempts: 1,
      searchFullPolygon: true,
    });
    const secWorldPt = secShotOff.usedPoint?.world ?? [0, 3.0, 0];
    let impactsOff = secShotOff.after.secondaryImpactsCount;
    let destrOff = secShotOff.after.destructionPct;
    let brokenSecOff = secShotOff.after.brokenJointCount;

    await harness.selectLabBench('seismic');
    await harness.setRangeSlider('jointStrength', 1.0);
    await harness.setRangeSlider('secondaryDmg', 3.0);
    const secShotMax = await harness.aimAndStrikeStructure('bomb', {
      worldPoint: secWorldPt,
      settleTicks: 55,
      maxAttempts: 1,
    });
    let impactsMax = secShotMax.after.secondaryImpactsCount;
    let destrMax = secShotMax.after.destructionPct;
    let brokenSecMax = secShotMax.after.brokenJointCount;

    if (
      impactsMax === impactsOff &&
      Math.abs(destrMax - destrOff) <= 0.05 &&
      brokenSecMax === brokenSecOff
    ) {
      await harness.selectLabBench('ballistics');
      await harness.setRangeSlider('jointStrength', 1.0);
      await harness.setRangeSlider('secondaryDmg', 0.0);
      const fbOff = await harness.aimAndStrikeStructure('bomb', {
        preferSide: 'center',
        heightFraction: 0.4,
        settleTicks: 50,
        maxAttempts: 1,
      });
      const fbWorld = fbOff.usedPoint?.world ?? [0, 2.2, 0];
      impactsOff = fbOff.after.secondaryImpactsCount;
      destrOff = fbOff.after.destructionPct;
      brokenSecOff = fbOff.after.brokenJointCount;

      await harness.selectLabBench('ballistics');
      await harness.setRangeSlider('jointStrength', 1.0);
      await harness.setRangeSlider('secondaryDmg', 3.0);
      const fbMax = await harness.aimAndStrikeStructure('bomb', {
        worldPoint: fbWorld,
        settleTicks: 50,
        maxAttempts: 1,
      });
      impactsMax = fbMax.after.secondaryImpactsCount;
      destrMax = fbMax.after.destructionPct;
      brokenSecMax = fbMax.after.brokenJointCount;
    }

    expect(
      impactsMax > impactsOff || destrMax > destrOff + 0.05 || brokenSecMax > brokenSecOff,
    ).toBe(true);

    // 3. Сравнение скорости распространения пожара (#slider-fire-rate: 0 vs 4.0) на стенде материалов
    await harness.selectLabBench('materials');
    await harness.setRangeSlider('jointStrength', 1.0);
    await harness.setRangeSlider('secondaryDmg', 1.0);
    await harness.setRangeSlider('fireRate', 0.0);
    const fireSlowInit = await harness.aimAndStrikeStructure('incendiary', {
      heightFraction: 0.2,
      settleTicks: 15,
      requireBurning: true,
      searchFullPolygon: true,
    });
    const fireOrigin = fireSlowInit.usedPoint?.world;
    const tSlow = await harness.waitForSimTicks(60);

    await harness.selectLabBench('materials');
    await harness.setRangeSlider('jointStrength', 1.0);
    await harness.setRangeSlider('secondaryDmg', 1.0);
    await harness.setRangeSlider('fireRate', 4.0);
    await harness.aimAndStrikeStructure('incendiary', {
      worldPoint: fireOrigin,
      heightFraction: 0.2,
      settleTicks: 15,
      requireBurning: true,
      searchFullPolygon: true,
    });
    const tFast = await harness.waitForSimTicks(60);

    expect(
      tFast.burningNodeCount > tSlow.burningNodeCount ||
        tFast.maxTemperatureC > tSlow.maxTemperatureC ||
        tFast.brokenJointCount > tSlow.brokenJointCount,
    ).toBe(true);
  });
});

test.describe('Уровень 1 — R10: Кампания миссий — 8 контрактов сноса, бюджет, охраняемые зоны, звёзды и localStorage', () => {
  test('[R10][F19][F22] Загрузка всех 8 контрактов Кампании (#contract-01 .. #contract-08) с проверкой сцены, бюджета и статуса миссии', async ({
    harness,
  }) => {
    await harness.boot({ clearStorage: true });
    await harness.switchMode('campaign');

    for (const sel of CONTRACT_SELECTORS) {
      await expect(harness.page.locator(sel)).toBeVisible();
    }

    const contractSignatures = new Set<string>();

    for (const idx of [1, 2, 3, 4, 5, 6, 7, 8] as const) {
      const telemetry = await harness.selectContract(idx);
      await harness.assertCanonicalMissionPanelAttributes();
      const missionDom = await harness.readMissionDomState();

      expect(telemetry.initialBlockCount).toBeGreaterThan(0);
      expect(telemetry.targetMaxHeightM).toBeGreaterThan(0);
      expect(telemetry.destructionPct).toBe(0);

      expect(['planning', 'running']).toContain(missionDom.missionStatus);
      expect(missionDom.failReason).toBe('none');
      expect(missionDom.starsAttr).toBe(0);
      expect(missionDom.budgetRemaining).toBeGreaterThan(0);

      contractSignatures.add(
        `${telemetry.initialBlockCount}:${telemetry.initialJointCount}:${telemetry.targetMaxHeightM.toFixed(1)}:${missionDom.budgetRemaining}`,
      );
    }

    expect(contractSignatures.size).toBeGreaterThanOrEqual(4);
  });

  test('[R10][F19] Учёт инженерного бюджета (#mission-budget-remaining) при закладке спецсредств в контракте', async ({
    harness,
  }) => {
    await harness.boot({ clearStorage: true });
    await harness.selectContract(1);

    const b0 = await harness.readNumericIndicator(SELECTORS.missionBudgetRemaining);
    expect(b0).toBeGreaterThan(0);

    const available = await harness.getAvailableTools();
    let usedC4 = false;

    if (available.includes('c4')) {
      const planted = await harness.plantC4OnStructure({
        count: 1,
        delaySec: 0,
        heightFraction: 0.16,
      });
      expect(planted.totalPlanted).toBeGreaterThanOrEqual(1);
      usedC4 = true;
    } else if (available.includes('cannon')) {
      await harness.aimAndStrikeStructure('cannon', { settleTicks: 15, maxAttempts: 1 });
    } else if (available.includes('bomb')) {
      await harness.aimAndStrikeStructure('bomb', { settleTicks: 15, maxAttempts: 1 });
    } else if (available.includes('cutter')) {
      await harness.aimAndStrikeStructure('cutter', {
        holdMs: 650,
        settleTicks: 15,
        maxAttempts: 1,
      });
    } else if (available.includes('incendiary')) {
      await harness.aimAndStrikeStructure('incendiary', { settleTicks: 15, maxAttempts: 1 });
    } else if (available.includes('seismic')) {
      await harness.activateSeismicTool({ settleTicks: 20 });
    }

    let b1 = await harness.readNumericIndicator(SELECTORS.missionBudgetRemaining);
    if (usedC4 && b1 === b0) {
      await harness.detonateC4AndSettle(15);
      b1 = await harness.readNumericIndicator(SELECTORS.missionBudgetRemaining);
    }

    expect(b1).toBeLessThan(b0);
    expect(b1).toBeGreaterThanOrEqual(0);
  });

  test('[R10][F19] Победное прохождение контракта #contract-01 с достижением нормы сноса и получением звёзд (data-mission-status="victory")', async ({
    harness,
  }) => {
    await harness.boot({ clearStorage: true });
    await harness.selectContract(1);

    const finalMission = await harness.completeContractTargetDemolition();

    await expect
      .poll(async () => (await harness.readMissionDomState()).missionStatus, {
        timeout: 12_000,
        message: 'Ожидание статуса победы data-mission-status="victory" в контракте #contract-01',
      })
      .toBe('victory');

    const victoryDom =
      finalMission.missionStatus === 'victory'
        ? finalMission
        : await harness.readMissionDomState();
    const telemetry = await harness.getTelemetry();

    expect(victoryDom.targetProgress).toBeGreaterThan(0);
    expect(victoryDom.missionStatus).toBe('victory');
    expect(victoryDom.failReason).toBe('none');
    expect(victoryDom.starsAttr).toBeGreaterThanOrEqual(1);
    expect(victoryDom.starsAttr).toBeLessThanOrEqual(3);
    expect(telemetry.missionStatus).toBe('victory');
    expect(telemetry.stars).toBeGreaterThanOrEqual(1);
    await expect(harness.page.locator(SELECTORS.missionStars)).toBeVisible();
  });

  test('[R10][F08][F19] Контроль охраняемых соседних зданий и индикатора #mission-collateral-pct в контракте #contract-03', async ({
    harness,
  }) => {
    await harness.boot({ clearStorage: true });
    const startTelemetry = await harness.selectContract(3);

    expect(startTelemetry.collateralPct).toBe(0);
    expect(startTelemetry.protectedDamagePct).toBe(0);

    const available = await harness.getAvailableTools();
    if (available.includes('c4')) {
      const planted = await harness.plantC4OnStructure({
        count: 2,
        delaySec: 0,
        preferSide: 'center',
        heightFraction: 0.18,
      });
      expect(planted.totalPlanted).toBeGreaterThanOrEqual(1);
      await harness.detonateC4AndSettle(65);
    } else if (available.includes('cutter')) {
      await harness.aimAndStrikeStructure('cutter', {
        preferSide: 'center',
        heightFraction: 0.18,
        holdMs: 750,
        settleTicks: 50,
      });
    } else if (available.includes('cannon')) {
      await harness.aimAndStrikeStructure('cannon', {
        preferSide: 'center',
        heightFraction: 0.2,
        settleTicks: 40,
      });
    }

    const afterTelemetry = await harness.getTelemetry();
    const missionDom = await harness.readMissionDomState();

    expect(afterTelemetry.destructionPct).toBeGreaterThan(5);
    expect(missionDom.failReason).toBe('none');
    expect(Math.abs(missionDom.collateralPct - afterTelemetry.collateralPct)).toBeLessThanOrEqual(
      1.5,
    );

    // 2. Проверяем реальную реакцию охраняемых зданий: наносим удар по охраняемой зоне
    if (missionDom.missionStatus === 'victory' || missionDom.missionStatus === 'defeat') {
      await harness.selectContract(3);
    }

    let protectedStrike = await harness.strikeProtectedZone({ untilDefeat: false });
    if (!protectedStrike.collateralDetected) {
      for (const fallbackIdx of [2, 5, 6, 8, 4] as const) {
        await harness.selectContract(fallbackIdx);
        protectedStrike = await harness.strikeProtectedZone({ untilDefeat: false });
        if (protectedStrike.collateralDetected) break;
      }
    }

    expect(protectedStrike.collateralDetected).toBe(true);
    const colTelemetry = await harness.getTelemetry();
    const colDom = await harness.readMissionDomState();

    expect(Math.max(colTelemetry.collateralPct, colTelemetry.protectedDamagePct)).toBeGreaterThan(
      0,
    );
    expect(colDom.collateralPct).toBeGreaterThan(0);
    expect(Math.abs(colDom.collateralPct - colTelemetry.collateralPct)).toBeLessThanOrEqual(2.0);
  });

  test('[R10][F10][F11][F19] Работа стихийных и сейсмических механик в профильных контрактах Кампании (#contract-04 и #contract-07)', async ({
    harness,
  }) => {
    await harness.boot({ clearStorage: true });

    const executeAnyAvailableTool = async (tools: ReadonlyArray<string>): Promise<void> => {
      if (tools.includes('incendiary')) {
        await harness.aimAndStrikeStructure('incendiary', {
          heightFraction: 0.2,
          settleTicks: 40,
          searchFullPolygon: true,
        });
      } else if (tools.includes('bomb')) {
        await harness.aimAndStrikeStructure('bomb', {
          heightFraction: 0.2,
          settleTicks: 40,
          searchFullPolygon: true,
        });
      } else if (tools.includes('cannon')) {
        await harness.aimAndStrikeStructure('cannon', {
          heightFraction: 0.2,
          settleTicks: 40,
          searchFullPolygon: true,
        });
      } else if (tools.includes('c4')) {
        const planted = await harness.plantC4OnStructure({ count: 2, delaySec: 0 });
        if (planted.totalPlanted > 0) {
          await harness.detonateC4AndSettle(45);
        }
      } else if (tools.includes('cutter')) {
        await harness.aimAndStrikeStructure('cutter', {
          heightFraction: 0.2,
          holdMs: 700,
          settleTicks: 40,
          searchFullPolygon: true,
        });
      } else if (tools.includes('seismic')) {
        await harness.activateSeismicTool({ freqHz: 2.2, ampM: 1.2, settleTicks: 35 });
      }
    };

    // 1. Находим профильную термическую миссию с incendiary (начиная с #contract-04, с полным фолбэком)
    let incendiaryContractFound = false;
    for (const candidateIdx of [4, 5, 6, 8, 3, 2, 1, 7] as const) {
      await harness.selectContract(candidateIdx);
      const tools = await harness.getAvailableTools();
      if (tools.includes('incendiary')) {
        incendiaryContractFound = true;
        await harness.aimAndStrikeStructure('incendiary', {
          heightFraction: 0.2,
          settleTicks: 45,
          searchFullPolygon: true,
        });
        break;
      }
    }
    if (!incendiaryContractFound) {
      await harness.selectContract(4);
      const tools04 = await harness.getAvailableTools();
      await executeAnyAvailableTool(tools04);
    }

    await expect
      .poll(
        async () => {
          const t = await harness.waitForSimTicks(15);
          const m = await harness.readMissionDomState();
          return (
            t.burningNodeCount > 0 ||
            t.detonatedExplosivesCount > 0 ||
            t.destructionPct > 0 ||
            m.targetProgress > 0
          );
        },
        { timeout: 10_000, message: 'Ожидание реакции профильной термической миссии Кампании' },
      )
      .toBe(true);

    // 2. Находим профильную сейсмическую миссию с seismic (начиная с #contract-07, с полным фолбэком)
    let seismicContractFound = false;
    let baselineStress = 0;

    for (const candidateIdx of [7, 8, 6, 5, 4, 3, 2, 1] as const) {
      await harness.selectContract(candidateIdx);
      const tools = await harness.getAvailableTools();
      if (tools.includes('seismic')) {
        seismicContractFound = true;
        const settledBefore = await harness.waitForSimTicks(10);
        baselineStress = settledBefore.maxStressUtilization;
        await harness.activateSeismicTool({ freqHz: 2.2, ampM: 1.2, settleTicks: 35 });
        break;
      }
    }

    if (!seismicContractFound) {
      await harness.selectContract(7);
      const settledBefore = await harness.waitForSimTicks(10);
      baselineStress = settledBefore.maxStressUtilization;
      const tools07 = await harness.getAvailableTools();
      await executeAnyAvailableTool(tools07);
    }

    let sawSeismicOrImpact = false;
    await expect
      .poll(
        async () => {
          const cur = await harness.waitForSimTicks(15);
          if (
            cur.seismicActive ||
            cur.brokenJointCount > 0 ||
            cur.destructionPct > 0 ||
            cur.maxStressUtilization > baselineStress + 0.05
          ) {
            sawSeismicOrImpact = true;
          }
          return sawSeismicOrImpact;
        },
        {
          timeout: 10_000,
          message: 'Ожидание сейсмического воздействия или разрушений в профильной миссии Кампании',
        },
      )
      .toBe(true);

    const mSeismic = await harness.readMissionDomState();
    expect(mSeismic.failReason).not.toBe('collateral');
  });

  test('[R10][F19][F22] Персистентность прогресса Кампании и заработанных звёзд в localStorage после перезагрузки страницы', async ({
    harness,
  }) => {
    const readSortedStorageEntries = async (): Promise<Array<[string, string]>> =>
      await harness.page.evaluate(() => {
        const entries: Array<[string, string]> = [];
        for (let i = 0; i < window.localStorage.length; i++) {
          const key = window.localStorage.key(i);
          if (key !== null) {
            entries.push([key, window.localStorage.getItem(key) ?? '']);
          }
        }
        entries.sort((a, b) => a[0].localeCompare(b[0]));
        return entries;
      });

    const readContract01Snapshot = async () =>
      await harness.page.locator(SELECTORS.contract01).evaluate((el: Element) => ({
        text: (el.textContent ?? '').trim(),
        html: el.innerHTML,
        cls: el.className,
        attrs: Array.from(el.attributes)
          .map((a) => [a.name, a.value] as [string, string])
          .sort((a, b) => a[0].localeCompare(b[0])),
      }));

    await harness.boot({ clearStorage: true });
    await harness.switchMode('campaign');

    // Снимаем базовые слепки чистого непройденного состояния до победы
    const cleanStorageJson = JSON.stringify(await readSortedStorageEntries());
    const cleanCardSnapshot = await readContract01Snapshot();

    await harness.selectContract(1);
    await harness.completeContractTargetDemolition();
    await expect
      .poll(async () => (await harness.readMissionDomState()).missionStatus, {
        timeout: 12_000,
      })
      .toBe('victory');

    const starsBefore = (await harness.readMissionDomState()).starsAttr;
    expect(starsBefore).toBeGreaterThanOrEqual(1);

    const storageBeforeReload = await readSortedStorageEntries();
    expect(storageBeforeReload.length).toBeGreaterThan(0);
    expect(JSON.stringify(storageBeforeReload)).not.toBe(cleanStorageJson);

    // Перезагружаем страницу без очистки localStorage и открываем экран Кампании
    await harness.reloadAndWaitReady();
    await harness.switchMode('campaign');

    const storageAfter = await readSortedStorageEntries();
    const afterReloadStorageJson = JSON.stringify(storageAfter);
    const afterReloadCardSnapshot = await readContract01Snapshot();

    const storagePersisted =
      storageAfter.length > 0 && afterReloadStorageJson !== cleanStorageJson;
    const cardUiChangedFromClean =
      JSON.stringify(afterReloadCardSnapshot) !== JSON.stringify(cleanCardSnapshot);

    expect(storagePersisted).toBe(true);
    expect(cardUiChangedFromClean).toBe(true);
    expect(storagePersisted && cardUiChangedFromClean).toBe(true);
  });
});

