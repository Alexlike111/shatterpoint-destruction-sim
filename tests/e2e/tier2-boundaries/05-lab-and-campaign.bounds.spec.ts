import {
  test,
  expect,
  SELECTORS,
  TOOL_BUTTON_MAP,
  type E2ETelemetry,
  type PhysicsSliderKey,
  type ShatterpointHarness,
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

const EXT_SELECTORS = {
  walletCredits: '#wallet-credits',
  openWorkshopBtn: '#open-workshop-btn',
  workshopModal: '#workshop-modal',
  closeWorkshopBtn: '#close-workshop-btn',
  buyExtraAmmoBtn: '#buy-extra-ammo-btn',
  upgradeCannonBtn: '#upgrade-cannon-btn',
  upgradeC4Btn: '#upgrade-c4-btn',
  upgradeBombBtn: '#upgrade-bomb-btn',
  upgradeCutterBtn: '#upgrade-cutter-btn',
  upgradeIncendiaryBtn: '#upgrade-incendiary-btn',
  upgradeSeismicBtn: '#upgrade-seismic-btn',
  sandboxUpgradeLevelSelect: '#sandbox-upgrade-level-select',
  hudCollapsedTons: '#hud-collapsed-tons',
  hudDestructionScore: '#hud-destruction-score',
  hudComboBadge: '#hud-combo-badge',
  tacticalFeed: '#tactical-feed',
  autoSlowmoToggle: '#auto-slowmo-toggle',
  damageProgressBar: '#damage-progress-bar',
  starThreshold1: '#star-threshold-1',
  starThreshold2: '#star-threshold-2',
  starThreshold3: '#star-threshold-3',
  c4SequencerPanel: '#c4-sequencer-panel',
  c4SequencerList: '#c4-sequencer-list',
} as const;

const CONTRACT_INDICES = [1, 2, 3, 4, 5, 6, 7, 8] as const;
type ContractIndex = (typeof CONTRACT_INDICES)[number];

const ALL_TOOLS: readonly ToolId[] = ['cannon', 'c4', 'bomb', 'cutter', 'incendiary', 'seismic'];

/**
 * Честное списание боекомплекта/бюджета текущего контракта в небо или дальний пустой угол полигона
 * без нанесения урона целевому и охраняемому сооружениям.
 */
async function spendSingleMissShot(harness: ShatterpointHarness, tool: ToolId): Promise<boolean> {
  await harness.selectTool(tool);
  const bBefore = await harness.readNumericIndicator(SELECTORS.missionBudgetRemaining);
  const availBefore = await harness.getAvailableTools();

  if (tool === 'cutter') {
    const skyPt = await harness.clickSkyMiss({ button: 'left' });
    await harness.page.mouse.move(skyPt.x, skyPt.y);
    await harness.page.mouse.down({ button: 'left' });
    await harness.waitForSimTicks(8);
    await harness.page.mouse.up({ button: 'left' });
    await harness.waitForSimTicks(4);
  } else if (tool === 'seismic') {
    await harness.activateSeismicTool({ settleTicks: 10 });
  } else {
    await harness.clickSkyMiss({ button: 'left' });
    await harness.waitForSimTicks(6);
  }

  const bAfterSky = await harness.readNumericIndicator(SELECTORS.missionBudgetRemaining);
  const availAfterSky = await harness.getAvailableTools();
  const statusAfterSky = (await harness.readMissionDomState()).missionStatus;
  if (
    bAfterSky < bBefore ||
    availAfterSky.length < availBefore.length ||
    statusAfterSky === 'defeat'
  ) {
    return true;
  }

  // Если инструмент требует пересечения луча с поверхностью полигона, стреляем в пустой дальний угол площадки
  const farGroundSpots: Array<[number, number, number]> = [
    [-26, 0.15, -26],
    [26, 0.15, -26],
    [-26, 0.15, 26],
    [26, 0.15, 26],
    [-23, 0.15, 0],
    [23, 0.15, 0],
  ];
  const projected = await harness.projectWorldPointsToClickableScreen(farGroundSpots, 12);
  for (const spot of projected) {
    if (tool === 'cutter') {
      await harness.page.mouse.move(spot.screen.x, spot.screen.y);
      await harness.page.mouse.down({ button: 'left' });
      await harness.waitForSimTicks(8);
      await harness.page.mouse.up({ button: 'left' });
      await harness.waitForSimTicks(4);
    } else {
      await harness.page.mouse.click(spot.screen.x, spot.screen.y, { button: 'left' });
      if (tool === 'c4') {
        await harness.waitForAnimationFrames(1);
        if ((await harness.getPlantedC4Count()) > 0) {
          await harness.detonateC4AndSettle(8);
        }
      } else {
        await harness.waitForSimTicks(6);
      }
    }

    const bAfterGround = await harness.readNumericIndicator(SELECTORS.missionBudgetRemaining);
    const availAfterGround = await harness.getAvailableTools();
    const statusAfterGround = (await harness.readMissionDomState()).missionStatus;
    if (
      bAfterGround < bBefore ||
      availAfterGround.length < availBefore.length ||
      statusAfterGround === 'defeat'
    ) {
      return true;
    }
  }

  return false;
}

test.describe('Уровень 2 — R09: Экстремумы физических констант и граничные режимы стендов Лаборатории', () => {
  test('[R09][F12][F21] Проверка контрактных границ min/max всех 7 ползунков Лаборатории (PROJECT.md §2) и защита от выхода за пределы диапазона (clamping)', async ({
    harness,
  }) => {
    await harness.boot();
    await harness.selectLabBench('seismic');

    const expectedBounds: Record<
      PhysicsSliderKey,
      { min: number; max: number; precision: number }
    > = {
      gravity: { min: 0, max: 30, precision: 2 },
      jointStrength: { min: 0.1, max: 5.0, precision: 2 },
      secondaryDmg: { min: 0, max: 3.0, precision: 2 },
      blastFalloff: { min: 0.25, max: 3.0, precision: 2 },
      fireRate: { min: 0, max: 4.0, precision: 2 },
      quakeFreqHz: { min: 0.5, max: 15.0, precision: 2 },
      quakeAmp: { min: 0.05, max: 2.5, precision: 2 },
    };

    for (const [key, spec] of Object.entries(expectedBounds) as Array<
      [PhysicsSliderKey, { min: number; max: number; precision: number }]
    >) {
      const meta = await harness.getSliderMeta(key);
      expect(meta.min, `Неверная нижняя граница min ползунка ${key}`).toBeCloseTo(
        spec.min,
        spec.precision,
      );
      expect(meta.max, `Неверная верхняя граница max ползунка ${key}`).toBeCloseTo(
        spec.max,
        spec.precision,
      );
    }

    // Подаём запредельные значения ниже min и выше max и проверяем строгое зажатие (clamping)
    const gUnder = await harness.setRangeSlider('gravity', -25);
    expect(gUnder.appliedValue).toBe(0);

    const gOver = await harness.setRangeSlider('gravity', 500);
    expect(gOver.appliedValue).toBe(30);

    const fUnder = await harness.setRangeSlider('quakeFreqHz', 0.001);
    expect(fUnder.appliedValue).toBeCloseTo(0.5, 2);

    const fOver = await harness.setRangeSlider('quakeFreqHz', 99);
    expect(fOver.appliedValue).toBeCloseTo(15.0, 1);

    const jUnder = await harness.setRangeSlider('jointStrength', -5);
    expect(jUnder.appliedValue).toBeCloseTo(0.1, 2);

    const jOver = await harness.setRangeSlider('jointStrength', 120);
    expect(jOver.appliedValue).toBeCloseTo(5.0, 1);

    await harness.setRangeSlider('gravity', 9.81);
    const tAfterClamp = await harness.triggerLabEarthquake({ settleTicks: 10 });
    expect(tAfterClamp.seismicFrequencyHz).toBeGreaterThanOrEqual(0.5);
    expect(tAfterClamp.seismicFrequencyHz).toBeLessThanOrEqual(15.0);
    expect(Number.isFinite(tAfterClamp.maxStressUtilization)).toBe(true);
  });

  test('[R09][F06][F12][F21] Экстремумы гравитации (#slider-gravity): невесомость 0 м/с² против гипергравитации 30 м/с²', async ({
    harness,
  }) => {
    await harness.boot();
    await harness.selectLabBench('ballistics');

    // 1. Невесомость (0 м/с²): отсутствие весового напряжения и отсутствие гравитационного обрушения
    const g0 = await harness.setRangeSlider('gravity', 0);
    expect(g0.appliedValue).toBe(0);

    const tZero = await harness.waitForSimTicks(20);
    const stressZero = tZero.maxStressUtilization;
    const h0 = tZero.targetMaxHeightM;
    expect(stressZero).toBeLessThan(0.2);

    const zeroShot = await harness.aimAndStrikeStructure('cannon', {
      preferSide: 'center',
      heightFraction: 0.2,
      settleTicks: 30,
      maxAttempts: 2,
      searchFullPolygon: true,
    });
    const usedPt = zeroShot.usedPoint?.world;
    expect(zeroShot.after.secondaryImpactsCount).toBe(0);
    expect(zeroShot.after.targetMaxHeightM).toBeGreaterThanOrEqual(h0 * 0.65);

    // 2. Гипергравитация (30 м/с²): трёхкратный собственный вес и усиленный гравитационный снос
    await harness.selectLabBench('ballistics');
    const g30 = await harness.setRangeSlider('gravity', 30);
    expect(g30.appliedValue).toBe(30);

    const tHigh = await harness.waitForSimTicks(25);
    expect(tHigh.maxStressUtilization > stressZero || tHigh.brokenJointCount > 0).toBe(true);

    const highShot = await harness.aimAndStrikeStructure('cannon', {
      worldPoint: usedPt,
      preferSide: 'center',
      heightFraction: 0.2,
      settleTicks: 35,
      maxAttempts: 1,
      searchFullPolygon: true,
    });

    expect(
      highShot.after.destructionPct > zeroShot.after.destructionPct ||
        highShot.after.brokenJointCount > zeroShot.after.brokenJointCount ||
        highShot.after.targetMaxHeightM < zeroShot.after.targetMaxHeightM,
    ).toBe(true);
  });

  test('[R09][F08][F12][F21] Полное отключение вторичного кинетического урона (#slider-secondary-dmg = 0) против максимума (3.0)', async ({
    harness,
  }) => {
    await harness.boot();
    await harness.selectLabBench('seismic');

    await harness.setRangeSlider('jointStrength', 1.0);
    const secOff = await harness.setRangeSlider('secondaryDmg', 0);
    expect(secOff.appliedValue).toBe(0);

    const strikeZero = await harness.aimAndStrikeStructure('bomb', {
      preferSide: 'center',
      heightFraction: 0.45,
      settleTicks: 50,
      maxAttempts: 3,
      searchFullPolygon: true,
    });

    // Контрольное подтверждение первичного разрушения и строгий ноль вторичных ударов при множителе 0
    expect(
      strikeZero.after.brokenJointCount > 0 || strikeZero.after.activeShardCount > 0,
    ).toBe(true);
    expect(strikeZero.after.secondaryImpactsCount).toBe(0);

    const usedWorld = strikeZero.usedPoint?.world ?? [0, 3.0, 0];

    await harness.selectLabBench('seismic');
    await harness.setRangeSlider('jointStrength', 1.0);
    const secMax = await harness.setRangeSlider('secondaryDmg', 3.0);
    expect(secMax.appliedValue).toBeCloseTo(3.0, 1);

    const strikeMax = await harness.aimAndStrikeStructure('bomb', {
      worldPoint: usedWorld,
      settleTicks: 50,
      maxAttempts: 1,
    });

    let maxExceededZero =
      strikeMax.after.secondaryImpactsCount > 0 ||
      strikeMax.after.brokenJointCount > strikeZero.after.brokenJointCount ||
      strikeMax.after.destructionPct > strikeZero.after.destructionPct + 0.05;

    if (!maxExceededZero) {
      await harness.selectLabBench('ballistics');
      await harness.setRangeSlider('jointStrength', 1.0);
      await harness.setRangeSlider('secondaryDmg', 0);
      const fbZero = await harness.aimAndStrikeStructure('bomb', {
        preferSide: 'center',
        heightFraction: 0.4,
        settleTicks: 50,
        maxAttempts: 2,
        searchFullPolygon: true,
      });
      expect(fbZero.after.secondaryImpactsCount).toBe(0);
      const fbPt = fbZero.usedPoint?.world ?? [0, 2.2, 0];

      await harness.selectLabBench('ballistics');
      await harness.setRangeSlider('jointStrength', 1.0);
      await harness.setRangeSlider('secondaryDmg', 3.0);
      const fbMax = await harness.aimAndStrikeStructure('bomb', {
        worldPoint: fbPt,
        settleTicks: 50,
        maxAttempts: 1,
      });
      maxExceededZero =
        fbMax.after.secondaryImpactsCount > 0 ||
        fbMax.after.brokenJointCount > fbZero.after.brokenJointCount ||
        fbMax.after.destructionPct > fbZero.after.destructionPct + 0.05;
    }

    expect(maxExceededZero).toBe(true);
  });

  test('[R09][F10][F12][F21] Блокировка распространения пожара при #slider-fire-rate = 0 против форсированного распространения 4.0', async ({
    harness,
  }) => {
    await harness.boot();
    await harness.selectLabBench('materials');

    const fireOff = await harness.setRangeSlider('fireRate', 0);
    expect(fireOff.appliedValue).toBe(0);

    const igniteRes = await harness.aimAndStrikeStructure('incendiary', {
      heightFraction: 0.2,
      settleTicks: 10,
      requireBurning: true,
      searchFullPolygon: true,
    });
    const burningInitial = igniteRes.after.burningNodeCount;
    expect(burningInitial).toBeGreaterThanOrEqual(1);
    const fireWorldPt = igniteRes.usedPoint?.world;

    // Прогоняем 1.5 с модельного времени (90 тиков): при fireRate = 0 пламя не должно перекинуться на соседей
    const tBlocked = await harness.waitForSimTicks(90);
    expect(tBlocked.burningNodeCount).toBeLessThanOrEqual(burningInitial);

    // Перезапускаем стенд с максимальной скоростью распространения огня 4.0
    await harness.selectLabBench('materials');
    const fireMax = await harness.setRangeSlider('fireRate', 4.0);
    expect(fireMax.appliedValue).toBeCloseTo(4.0, 1);

    await harness.aimAndStrikeStructure('incendiary', {
      worldPoint: fireWorldPt,
      heightFraction: 0.2,
      settleTicks: 10,
      requireBurning: true,
      searchFullPolygon: true,
    });
    const tMaxFire = await harness.waitForSimTicks(90);

    expect(
      tMaxFire.burningNodeCount > tBlocked.burningNodeCount ||
        tMaxFire.brokenJointCount > tBlocked.brokenJointCount ||
        tMaxFire.maxTemperatureC > tBlocked.maxTemperatureC,
    ).toBe(true);
  });

  test('[R09][F11][F21] Крайние границы сейсмоплатформы (#lab-bench-seismic): минимум (0.5 Гц, 0.05 м) против максимума (15.0 Гц, 2.50 м)', async ({
    harness,
  }) => {
    await harness.boot();
    await harness.selectLabBench('seismic');

    // Нижняя граница вибростенда: слабый длиннопериодный микротремор
    const tMin = await harness.triggerLabEarthquake({
      freqHz: 0.5,
      ampM: 0.05,
      settleTicks: 20,
    });
    expect(tMin.seismicActive).toBe(true);
    expect(tMin.seismicFrequencyHz).toBeCloseTo(0.5, 2);
    expect(tMin.seismicAmplitudeM).toBeCloseTo(0.05, 2);
    expect(tMin.destructionPct).toBeLessThan(25);

    // Верхняя граница вибростенда: экстремальный высокочастотный удар максимальной амплитуды
    let tMax = await harness.triggerLabEarthquake({
      freqHz: 15.0,
      ampM: 2.5,
      settleTicks: 35,
    });
    expect(tMax.seismicActive).toBe(true);
    expect(tMax.seismicFrequencyHz).toBeCloseTo(15.0, 1);
    expect(tMax.seismicAmplitudeM).toBeCloseTo(2.5, 2);

    if (tMax.brokenJointCount <= tMin.brokenJointCount) {
      tMax = await harness.waitForSimTicks(25);
    }

    expect(tMax.brokenJointCount).toBeGreaterThan(tMin.brokenJointCount);
    expect(tMax.destructionPct).toBeGreaterThan(tMin.destructionPct);
    expect(tMax.destructionPct).toBeLessThanOrEqual(100);
    expect(Number.isFinite(tMax.maxStressUtilization)).toBe(true);
  });

  test('[R09][F12][F19][F21] Границы прочности связей (#slider-joint-strength: 0.1 vs 5.0) и изоляция лабораторных оверрайдов при переходе в Кампанию', async ({
    harness,
  }) => {
    await harness.boot({ clearStorage: true });
    await harness.selectLabBench('ballistics');

    const jMax = await harness.setRangeSlider('jointStrength', 5.0);
    expect(jMax.appliedValue).toBeCloseTo(5.0, 1);

    // Оставляем в Лаборатории экстремальные оверрайды: невесомость 0 м/с² и минимальная прочность связей 0.1
    const gZero = await harness.setRangeSlider('gravity', 0);
    const jMin = await harness.setRangeSlider('jointStrength', 0.1);
    expect(gZero.appliedValue).toBe(0);
    expect(jMin.appliedValue).toBeCloseTo(0.1, 2);

    // Переключаемся в Кампанию: контракты обязаны использовать калиброванные константы мира, а не лабораторные оверрайды
    await harness.selectContract(1);
    const tCampRest = await harness.waitForSimTicks(25);

    expect(tCampRest.destructionPct).toBe(0);
    expect(tCampRest.brokenJointCount).toBe(0);
    expect(tCampRest.maxStressUtilization).toBeGreaterThan(0);

    await harness.completeContractTargetDemolition();
    await expect
      .poll(async () => (await harness.readMissionDomState()).missionStatus, {
        timeout: 12_000,
        message: 'Ожидание штатной гравитационной победы в #contract-01 после выхода из Лаборатории',
      })
      .toBe('victory');
  });
});

test.describe('Уровень 2 — R10: Негативные и граничные исходы миссий Кампании', () => {
  test('[R10][F08][F19] Гарантированный провал контракта (data-mission-status="defeat", data-fail-reason="collateral", data-stars="0") при разрушении охраняемого объекта', async ({
    harness,
  }) => {
    await harness.boot({ clearStorage: true });

    let defeatedByCollateral = false;
    for (const idx of [3, 2, 5, 6, 8, 4] as const) {
      await harness.selectContract(idx);
      await harness.strikeProtectedZone({ untilDefeat: true, maxStrikes: 12 });
      const domCheck = await harness.readMissionDomState();
      if (domCheck.missionStatus === 'defeat' && domCheck.failReason === 'collateral') {
        defeatedByCollateral = true;
        break;
      }
    }

    expect(defeatedByCollateral).toBe(true);
    await harness.assertCanonicalMissionPanelAttributes();

    const panel = harness.page.locator(SELECTORS.missionResultPanel);
    await expect(panel).toHaveAttribute('data-mission-status', 'defeat');
    await expect(panel).toHaveAttribute('data-fail-reason', 'collateral');
    await expect(panel).toHaveAttribute('data-stars', '0');

    const [missionDom, telemetry] = await Promise.all([
      harness.readMissionDomState(),
      harness.getTelemetry(),
    ]);

    expect(missionDom.collateralPct).toBeGreaterThan(0);
    expect(missionDom.starsAttr).toBe(0);
    expect(telemetry.missionStatus).toBe('defeat');
    expect(telemetry.stars).toBe(0);
    expect(Math.max(telemetry.protectedDamagePct, telemetry.collateralPct)).toBeGreaterThan(0);
  });

  test('[R10][F19] Расстрел всего боекомплекта/бюджета мимо цели в небо (clickSkyMiss): провал budget_exhausted и блокировка стрельбы при 0 бюджета', async ({
    harness,
  }) => {
    await harness.boot({ clearStorage: true });

    // Выбираем миссию по приоритетам:
    // 1) есть cannon и НЕТ seismic/c4; 2) есть cannon и НЕТ seismic; 3) любой контракт без seismic; 4) фолбэк
    const scannedContracts: Array<{ idx: ContractIndex; avail: ToolId[] }> = [];
    for (const idx of CONTRACT_INDICES) {
      await harness.selectContract(idx);
      const avail = await harness.getAvailableTools();
      scannedContracts.push({ idx, avail });
      if (avail.includes('cannon') && !avail.includes('seismic') && !avail.includes('c4')) {
        break;
      }
    }

    const tier1Match = scannedContracts.find(
      (c) => c.avail.includes('cannon') && !c.avail.includes('seismic') && !c.avail.includes('c4'),
    );
    const tier2Match = scannedContracts.find(
      (c) => c.avail.includes('cannon') && !c.avail.includes('seismic'),
    );
    const tier3Match = scannedContracts.find(
      (c) => c.avail.length > 0 && !c.avail.includes('seismic'),
    );
    const tier4Match = scannedContracts.find((c) => c.avail.includes('cannon'));
    const selectedIdx: ContractIndex =
      tier1Match?.idx ?? tier2Match?.idx ?? tier3Match?.idx ?? tier4Match?.idx ?? 1;

    await harness.selectContract(selectedIdx);

    const initialBudget = await harness.readNumericIndicator(SELECTORS.missionBudgetRemaining);
    expect(initialBudget).toBeGreaterThan(0);

    let usedGlobalSeismic = false;
    const nonSeismicOrder: readonly ToolId[] = ['cannon', 'bomb', 'incendiary', 'cutter', 'c4'];

    for (let shot = 0; shot < 60; shot++) {
      const domState = await harness.readMissionDomState();
      if (domState.missionStatus === 'defeat' || domState.budgetRemaining <= 0) {
        break;
      }

      const available = await harness.getAvailableTools();
      if (available.length === 0) {
        break;
      }

      let spent = false;
      const nonSeismicCandidates = nonSeismicOrder.filter((t) => available.includes(t));
      for (const candidateTool of nonSeismicCandidates) {
        spent = await spendSingleMissShot(harness, candidateTool);
        if (spent) {
          break;
        }
      }

      if (!spent && available.includes('seismic')) {
        spent = await spendSingleMissShot(harness, 'seismic');
        if (spent) {
          usedGlobalSeismic = true;
        }
      }

      if (!spent) {
        break;
      }

      if (!usedGlobalSeismic) {
        const midTel = await harness.getTelemetry();
        expect(midTel.destructionPct).toBe(0);
        expect(midTel.collateralPct).toBe(0);
      }
    }

    await expect
      .poll(
        async () => {
          await harness.waitForSimTicks(15);
          const m = await harness.readMissionDomState();
          return m.missionStatus;
        },
        {
          timeout: 12_000,
          message: 'Ожидание перехода контракта в defeat после полного расходования бюджета мимо цели',
        },
      )
      .toBe('defeat');

    const defeatDom = await harness.readMissionDomState();
    const defeatTel = await harness.getTelemetry();

    expect(defeatDom.missionStatus).toBe('defeat');
    expect(defeatDom.failReason).toBe('budget_exhausted');
    expect(defeatDom.starsAttr).toBe(0);
    expect(defeatDom.budgetRemaining).toBeGreaterThanOrEqual(0);
    if (!usedGlobalSeismic) {
      expect(defeatTel.destructionPct).toBe(0);
      expect(defeatTel.collateralPct).toBe(0);
    }

    // Попытка выстрела по целевому зданию после провала и исчерпания бюджета обязана быть заблокирована
    const destructionBeforeExtraClick = defeatTel.destructionPct;
    const targetHits = await harness.projectWorldPointsToClickableScreen(
      [
        [0, 2.0, 0],
        [0, 1.4, 0],
      ],
      0,
    );
    if (targetHits[0]) {
      await harness.page.mouse.click(targetHits[0].screen.x, targetHits[0].screen.y, {
        button: 'left',
      });
      await harness.waitForSimTicks(15);
    }

    const afterExtraClickTel = await harness.getTelemetry();
    const afterExtraClickDom = await harness.readMissionDomState();
    if (!usedGlobalSeismic) {
      expect(afterExtraClickTel.destructionPct).toBe(0);
    } else {
      expect(afterExtraClickTel.destructionPct).toBeCloseTo(destructionBeforeExtraClick, 1);
    }
    expect(afterExtraClickDom.budgetRemaining).toBeGreaterThanOrEqual(0);
  });

  test('[R10][F19][F22] Перезапуск проваленной миссии через #scene-reset-btn и через повторный клик по карточке контракта: чистый сброс в planning/running и failReason="none"', async ({
    harness,
  }) => {
    await harness.boot({ clearStorage: true });

    let chosenContract: ContractIndex = 3;
    let initialBudget = 0;
    let initialBlocks = 0;

    for (const idx of [3, 2, 5, 6, 8, 4] as const) {
      const tStart = await harness.selectContract(idx);
      const domStart = await harness.readMissionDomState();
      initialBudget = domStart.budgetRemaining;
      initialBlocks = tStart.initialBlockCount;
      chosenContract = idx;

      await harness.strikeProtectedZone({ untilDefeat: true, maxStrikes: 12 });
      const domAfter = await harness.readMissionDomState();
      if (domAfter.missionStatus === 'defeat') {
        break;
      }
    }

    const failedDom1 = await harness.readMissionDomState();
    expect(failedDom1.missionStatus).toBe('defeat');
    expect(failedDom1.failReason).toBe('collateral');

    // Способ 1: Сброс проваленной миссии через кнопку #scene-reset-btn
    await harness.resetScene();
    const [afterResetDom, afterResetTel] = await Promise.all([
      harness.readMissionDomState(),
      harness.getTelemetry(),
    ]);

    expect(['planning', 'running']).toContain(afterResetDom.missionStatus);
    expect(afterResetDom.failReason).toBe('none');
    expect(afterResetDom.starsAttr).toBe(0);
    expect(afterResetDom.budgetRemaining).toBe(initialBudget);
    expect(afterResetDom.collateralPct).toBe(0);
    expect(afterResetTel.destructionPct).toBe(0);
    expect(afterResetTel.intactBlockCount).toBe(initialBlocks);

    // Способ 2: Повторный провал и чистый перезапуск кликом по карточке #contract-0X
    await harness.strikeProtectedZone({ untilDefeat: true, maxStrikes: 12 });
    expect((await harness.readMissionDomState()).missionStatus).toBe('defeat');

    await harness.selectContract(chosenContract);
    const [afterCardDom, afterCardTel] = await Promise.all([
      harness.readMissionDomState(),
      harness.getTelemetry(),
    ]);

    expect(['planning', 'running']).toContain(afterCardDom.missionStatus);
    expect(afterCardDom.failReason).toBe('none');
    expect(afterCardDom.starsAttr).toBe(0);
    expect(afterCardDom.budgetRemaining).toBe(initialBudget);
    expect(afterCardDom.collateralPct).toBe(0);
    expect(afterCardTel.destructionPct).toBe(0);
  });

  test('[R10][F18][F19] Недоступность заблокированных спецсредств в смете контракта Кампании и невозможность нанести ими урон', async ({
    harness,
  }) => {
    await harness.boot({ clearStorage: true });

    let lockedTool: ToolId | null = null;
    for (const idx of CONTRACT_INDICES) {
      await harness.selectContract(idx);
      const available = await harness.getAvailableTools();
      if (available.length >= 1 && available.length < ALL_TOOLS.length) {
        lockedTool = ALL_TOOLS.find((t) => !available.includes(t)) ?? null;
        if (lockedTool) break;
      }
    }

    expect(
      lockedTool,
      'В Кампании обязан существовать хотя бы один контракт с ограниченным арсеналом (< 6 средств)',
    ).not.toBeNull();

    const forbiddenTool = lockedTool!;
    const budget0 = await harness.readNumericIndicator(SELECTORS.missionBudgetRemaining);
    const rootBefore = await harness.getAppRootState();
    expect(rootBefore.activeTool).not.toBe(forbiddenTool);

    const clickRes = await harness.clickOrVerifyDisabled(TOOL_BUTTON_MAP[forbiddenTool]);

    if (!clickRes.clicked) {
      expect((await harness.getAppRootState()).activeTool).not.toBe(forbiddenTool);
    } else {
      await harness.waitForAnimationFrames(1);
      const activeAfterClick = (await harness.getAppRootState()).activeTool;

      if (activeAfterClick === forbiddenTool) {
        const hits = await harness.projectWorldPointsToClickableScreen([[0, 1.8, 0]], 0);
        if (hits[0]) {
          await harness.page.mouse.click(hits[0].screen.x, hits[0].screen.y, { button: 'left' });
          await harness.waitForSimTicks(15);
        }
        const tAfter = await harness.getTelemetry();
        const budgetAfter = await harness.readNumericIndicator(SELECTORS.missionBudgetRemaining);
        expect(budgetAfter).toBe(budget0);
        expect(tAfter.destructionPct).toBe(0);
        expect(tAfter.brokenJointCount).toBe(0);
      } else {
        expect(activeAfterClick).not.toBe(forbiddenTool);
      }
    }
  });

  test('[R10][F18][F19] Холостой подрыв #detonate-c4-btn при 0 зарядов и возврат сметного бюджета при снятии C4 правой кнопкой мыши', async ({
    harness,
  }) => {
    await harness.boot({ clearStorage: true });

    let c4ContractFound = false;
    for (const idx of CONTRACT_INDICES) {
      await harness.selectContract(idx);
      const available = await harness.getAvailableTools();
      if (available.includes('c4')) {
        c4ContractFound = true;
        break;
      }
    }
    expect(c4ContractFound).toBe(true);

    const budget0 = await harness.readNumericIndicator(SELECTORS.missionBudgetRemaining);
    expect(await harness.getPlantedC4Count()).toBe(0);

    // 1. Холостое нажатие #detonate-c4-btn и холостой ПКМ при 0 установленных зарядов
    for (let i = 0; i < 3; i++) {
      await harness.clickOrVerifyDisabled(SELECTORS.detonateC4Btn);
    }
    await harness.selectTool('c4');
    const buildingHits = await harness.projectWorldPointsToClickableScreen([[0, 1.8, 0]], 0);
    if (buildingHits[0]) {
      await harness.page.mouse.click(buildingHits[0].screen.x, buildingHits[0].screen.y, {
        button: 'right',
      });
    }
    await harness.waitForSimTicks(10);

    expect(await harness.getPlantedC4Count()).toBe(0);
    expect(await harness.readNumericIndicator(SELECTORS.missionBudgetRemaining)).toBe(budget0);
    const idleDom = await harness.readMissionDomState();
    expect(['planning', 'running']).toContain(idleDom.missionStatus);
    expect(idleDom.failReason).toBe('none');

    // 2. Установка 1 заряда C4 и его снятие ПКМ: возврат заряда в бюджет и отсутствие взрыва при детонации
    const planted = await harness.plantC4OnStructure({
      count: 1,
      delaySec: 0,
      heightFraction: 0.16,
    });
    expect(planted.totalPlanted).toBe(1);
    expect(planted.hits.length).toBeGreaterThanOrEqual(1);

    const removed = await harness.removeC4AtHit(planted.hits[0]);
    expect(removed).toBe(true);
    expect(await harness.getPlantedC4Count()).toBe(0);

    const budgetRestored = await harness.readNumericIndicator(SELECTORS.missionBudgetRemaining);
    expect(budgetRestored).toBeCloseTo(budget0, 1);

    await harness.clickOrVerifyDisabled(SELECTORS.detonateC4Btn);
    const afterEmptyDetonate = await harness.waitForSimTicks(15);
    expect(afterEmptyDetonate.brokenJointCount).toBe(0);
    expect(afterEmptyDetonate.destructionPct).toBe(0);
  });

  test('[R10][F19][F24] Защита сохранённого рекорда звёзд и кредитов в localStorage: повторный провал пройденного контракта не обнуляет прогресс', async ({
    harness,
  }) => {
    test.slow();
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
    const cleanCardSnapshot = await readContract01Snapshot();

    // 1. Победное прохождение #contract-01 с начислением звёзд и кредитов
    await harness.selectContract(1);
    await harness.completeContractTargetDemolition();
    await expect
      .poll(async () => (await harness.readMissionDomState()).missionStatus, {
        timeout: 12_000,
        message: 'Ожидание победы в #contract-01 перед тестом повторного провала',
      })
      .toBe('victory');

    const winDom = await harness.readMissionDomState();
    expect(winDom.starsAttr).toBeGreaterThanOrEqual(1);

    const telAfterWin = (await harness.getTelemetry()) as ExtTelemetry;
    const creditsAfterWin = telAfterWin.walletCredits ?? 0;
    expect(creditsAfterWin).toBeGreaterThan(0);

    const walletDomVal = await harness.readNumericIndicator(EXT_SELECTORS.walletCredits);
    expect(walletDomVal).toBe(creditsAfterWin);

    // 2. Повторный запуск #contract-01 и намеренный провал миссии
    await harness.selectContract(1);
    for (let attempt = 0; attempt < 40; attempt++) {
      const m = await harness.readMissionDomState();
      if (m.missionStatus === 'defeat' || m.budgetRemaining <= 0) break;
      const avail = await harness.getAvailableTools();
      if (avail.length === 0) break;
      const tool = avail.includes('cannon') ? 'cannon' : avail[0];
      const spent = await spendSingleMissShot(harness, tool);
      if (!spent) break;
    }

    if ((await harness.readMissionDomState()).missionStatus !== 'defeat') {
      await harness.strikeProtectedZone({ untilDefeat: true, maxStrikes: 8 });
    }

    if ((await harness.readMissionDomState()).missionStatus !== 'defeat') {
      // Если в #contract-01 нет protected и только контактный C4, тратим весь лимит зарядов в одну точку верхушки
      for (let w = 0; w < 10; w++) {
        const m = await harness.readMissionDomState();
        if (m.missionStatus === 'defeat' || m.missionStatus === 'victory' || m.budgetRemaining <= 0) {
          break;
        }
        const avail = await harness.getAvailableTools();
        if (avail.includes('c4')) {
          const p = await harness.plantC4OnStructure({
            count: 6,
            delaySec: 0,
            heightFraction: 0.92,
            preferSide: 'left',
          });
          if (p.totalPlanted > 0) {
            await harness.detonateC4AndSettle(40);
          } else {
            break;
          }
        } else {
          break;
        }
      }
      await harness.waitForSimTicks(60);
    }

    // Если даже верхний подрыв снёс лёгкую цель на победу, вызываем гарантированный defeat на соседнем контракте
    if ((await harness.readMissionDomState()).missionStatus !== 'defeat') {
      for (const idx of [3, 2, 5, 6] as const) {
        await harness.selectContract(idx);
        await harness.strikeProtectedZone({ untilDefeat: true, maxStrikes: 10 });
        if ((await harness.readMissionDomState()).missionStatus === 'defeat') break;
      }
    }

    const defeatDom = await harness.readMissionDomState();
    expect(defeatDom.missionStatus).toBe('defeat');
    expect(defeatDom.starsAttr).toBe(0);

    // 3. Перезагружаем страницу и проверяем сохранность рекорда #contract-01 и кредитов в localStorage
    await harness.reloadAndWaitReady();
    await harness.switchMode('campaign');

    const telAfterReload = (await harness.getTelemetry()) as ExtTelemetry;
    expect(telAfterReload.walletCredits ?? 0).toBeGreaterThanOrEqual(creditsAfterWin);

    const hasLocalStorageData = await harness.page.evaluate(() => window.localStorage.length > 0);
    expect(hasLocalStorageData).toBe(true);

    const cardAfterReload = await readContract01Snapshot();
    expect(JSON.stringify(cardAfterReload)).not.toBe(JSON.stringify(cleanCardSnapshot));
  });
});
