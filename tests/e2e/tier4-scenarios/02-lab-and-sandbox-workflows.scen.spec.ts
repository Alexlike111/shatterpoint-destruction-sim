import {
  test,
  expect,
  SELECTORS,
  type ShatterpointHarness,
  type ToolId,
  type E2ETelemetry,
} from '../helpers/shatterpoint-harness';

/**
 * Полный канонический набор из 23 аддитивных DOM-селекторов расширений A1–A3 (PROJECT.md §5).
 */
const EXT_SELECTORS = {
  // Магазин и Мастерская улучшений (A1 — 12 селекторов)
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

  // Game Feel, тоннаж, комбо и авто-слоу-мо (A2 — 9 селекторов)
  hudCollapsedTons: '#hud-collapsed-tons',
  hudDestructionScore: '#hud-destruction-score',
  hudComboBadge: '#hud-combo-badge',
  tacticalFeed: '#tactical-feed',
  autoSlowmoToggle: '#auto-slowmo-toggle',
  damageProgressBar: '#damage-progress-bar',
  starThreshold1: '#star-threshold-1',
  starThreshold2: '#star-threshold-2',
  starThreshold3: '#star-threshold-3',

  // Секвенсор каскадного подрыва C4 (A3 — 2 селектора)
  c4SequencerPanel: '#c4-sequencer-panel',
  c4SequencerList: '#c4-sequencer-list',
} as const;

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

async function readExtTelemetry(harness: ShatterpointHarness): Promise<ExtTelemetry> {
  return (await harness.getTelemetry()) as ExtTelemetry;
}

async function setAutoSlowmo(harness: ShatterpointHarness, enabled: boolean): Promise<void> {
  await harness.setAutoSlowmo(enabled);
}

async function readFiniteDataAttr(
  harness: ShatterpointHarness,
  selector: string,
  attrName: string,
): Promise<number> {
  const loc = harness.page.locator(selector);
  await expect(loc).toBeAttached();
  const raw = await loc.getAttribute(attrName);
  expect(raw, `Элемент ${selector} обязан иметь атрибут ${attrName}`).not.toBeNull();
  const parsed = Number(raw);
  expect(
    Number.isFinite(parsed),
    `Атрибут ${attrName}="${raw}" элемента ${selector} обязан быть конечным числом`,
  ).toBe(true);
  return parsed;
}

async function setSandboxUpgradeLevel(
  harness: ShatterpointHarness,
  level: 1 | 2 | 3 | 4 | 5,
): Promise<ExtTelemetry> {
  await harness.switchMode('sandbox');
  await expect(harness.page.locator(EXT_SELECTORS.sandboxUpgradeLevelSelect)).toBeVisible();
  await harness.selectOptionAdaptive(EXT_SELECTORS.sandboxUpgradeLevelSelect, {
    exactValue: String(level),
    nearestNumber: level,
    fallbackIndex: level - 1,
  });

  let latest = await readExtTelemetry(harness);
  await expect
    .poll(
      async () => {
        latest = await readExtTelemetry(harness);
        return latest.toolLevels?.cannon;
      },
      {
        timeout: 6_000,
        message: `Ожидание переключения уровня прокачки Ур. ${level} в Песочнице`,
      },
    )
    .toBe(level);

  return latest;
}

test.describe.configure({ timeout: 90_000 });

test.describe('Уровень 4 — Пользовательские сессии: научно-инженерный цикл Лаборатории и Песочницы', () => {
  test('[Tier4][R01][R02][R03][R04][R08][R09][R11][F03][F11][F17][F20][F21][F24][F25] Сквозной научно-инженерный цикл по 3 режимам: калибровка в Лаборатории → мульти-спавн и достройка в Песочнице + Ур. 5 прокачки → цепной снос в Bullet-Time и Stress/X-Ray → звук, пресеты и стерильный #scene-reset-btn', async ({
    harness,
  }) => {
    await harness.boot();
    await setAutoSlowmo(harness, false);

    // 1. Калибровочный этап в Физической Лаборатории
    await harness.selectLabBench('materials');
    await harness.aimAndStrikeStructure('incendiary', {
      heightFraction: 0.22,
      settleTicks: 24,
      requireBurning: true,
      searchFullPolygon: true,
    });
    const labFireTel = await readExtTelemetry(harness);
    expect(labFireTel.burningNodeCount).toBeGreaterThan(0);

    await harness.selectLabBench('seismic');
    await harness.setRangeSlider('jointStrength', 0.5);
    const labQuakeTel = await harness.triggerLabEarthquake({
      freqHz: 2.6,
      ampM: 1.5,
      settleTicks: 16,
    });
    expect(labQuakeTel.seismicActive).toBe(true);

    // 2. Переход в Свободную Песочницу: мульти-спавн двух разных сооружений рядом
    const towerSpawn = await harness.spawnSandboxStructure('tower', { cleanResetFirst: true });
    const towerBlocks = towerSpawn.after.initialBlockCount;
    expect(towerBlocks).toBeGreaterThan(0);

    const hangarSpawn = await harness.spawnSandboxStructure('hangar', { cleanResetFirst: false });
    expect(hangarSpawn.after.initialBlockCount).toBeGreaterThan(towerBlocks);

    // 3. Достройка композитного узла конструктором из 4 материалов
    const rcBlock = await harness.placeSandboxBuildBlock('reinforced_concrete', [
      [5.5, 0.6, 0],
      [-5.5, 0.6, 0],
      [0, 0.6, 5.5],
    ]);
    expect(rcBlock.placed).toBe(true);

    const steelBlock = await harness.placeSandboxBuildBlock('steel', [
      [6.3, 0.6, 0.8],
      [-6.3, 0.6, 0.8],
      [0.8, 0.6, 6.3],
    ]);
    expect(steelBlock.placed).toBe(true);

    const woodBlock = await harness.placeSandboxBuildBlock('wood', [
      [5.5, 0.6, 1.2],
      [-5.5, 0.6, 1.2],
      [1.2, 0.6, 5.5],
    ]);
    expect(woodBlock.placed).toBe(true);

    const expBlock = await harness.placeSandboxBuildBlock('explosive', [
      [6.3, 0.6, -0.6],
      [-6.3, 0.6, -0.6],
      [-0.6, 0.6, 6.3],
    ]);
    expect(expBlock.placed).toBe(true);

    await harness.exitSandboxBuildMode();

    // 4. Максимальный Ур. 5 прокачки + комбинированный снос в Bullet-Time и Stress / X-Ray
    const lv5 = await setSandboxUpgradeLevel(harness, 5);
    expect(lv5.toolLevels?.cannon).toBe(5);
    expect(lv5.toolLevels?.c4).toBe(5);

    await harness.plantC4OnStructure({
      count: 2,
      delaySec: 0,
      preferSide: 'center',
      heightFraction: 0.14,
    });
    await harness.plantC4OnStructure({
      count: 1,
      delaySec: 0.25,
      preferSide: 'right',
      heightFraction: 0.18,
    });

    await harness.aimAndStrikeStructure('incendiary', {
      worldPoint: woodBlock.hit?.world,
      heightFraction: 0.2,
      settleTicks: 12,
      maxAttempts: 2,
      searchFullPolygon: true,
    });

    if ((await harness.getPlantedC4Count()) > 0) {
      const availTools = await harness.getAvailableTools();
      if (availTools.includes('c4')) {
        await harness.selectTool('c4');
      }
      await harness.clickOrVerifyDisabled(SELECTORS.detonateC4Btn);
    }
    await harness.waitForSimTicks(6);

    await harness.aimAndStrikeStructure('bomb', {
      preferSide: 'center',
      heightFraction: 0.2,
      settleTicks: 8,
      maxAttempts: 2,
      searchFullPolygon: true,
    });

    const btScale = await harness.toggleBulletTime();
    expect(btScale).toBeLessThan(1.0);
    await harness.waitForSimTicks(3, 12_000);

    await harness.setRenderViewMode('stress');
    await harness.setRenderViewMode('xray');
    await harness.setRenderViewMode('pbr');
    await harness.orbitCameraDrag(110, -25);

    await harness.setTimeScale(1.0);
    const activeCascade = (await harness.waitForSimTicks(35)) as ExtTelemetry;

    expect(activeCascade.collapsedMassTons!).toBeGreaterThan(0);
    const hudTons = await readFiniteDataAttr(harness, EXT_SELECTORS.hudCollapsedTons, 'data-value');
    const hudScore = await readFiniteDataAttr(
      harness,
      EXT_SELECTORS.hudDestructionScore,
      'data-value',
    );
    const hudCombo = await readFiniteDataAttr(
      harness,
      EXT_SELECTORS.hudComboBadge,
      'data-multiplier',
    );
    const feedText =
      (await harness.page.locator(EXT_SELECTORS.tacticalFeed).getAttribute('data-last-event')) ?? '';

    expect(hudTons).toBeGreaterThan(0);
    expect(hudScore).toBeGreaterThan(0);
    expect(hudCombo).toBeGreaterThanOrEqual(1);
    expect(feedText.trim().length).toBeGreaterThan(0);

    // 5. Звук, пресеты качества и стерильный сброс сцены #scene-reset-btn
    await harness.toggleAudioMute();
    await harness.toggleAudioMute();

    await harness.setQualityPreset('high');
    await harness.waitForAnimationFrames(2);
    await harness.setQualityPreset('performance');
    await harness.waitForAnimationFrames(2);

    const afterReset = (await harness.resetScene()) as ExtTelemetry;
    expect(afterReset.destructionPct).toBe(0);
    expect(afterReset.brokenJointCount).toBe(0);
    expect(afterReset.activeShardCount).toBe(0);
    expect(afterReset.burningNodeCount).toBe(0);
    expect(await harness.getPlantedC4Count()).toBe(0);

    await harness.verifyWebGL2Context();
  });

  test('[Tier4][R04][R05][R06][R07][R12][F04][F07][F09][F10][F18][F26] Полигон полного арсенала Ур. 5: последовательное испытание всех 6 инструментов, секвенсора C4 и покадровой паузы на составном комплексе сооружений', async ({
    harness,
  }) => {
    await harness.boot();
    await setAutoSlowmo(harness, false);

    const viaduct = await harness.spawnSandboxStructure('viaduct', { cleanResetFirst: true });
    const warehouse = await harness.spawnSandboxStructure('warehouse', { cleanResetFirst: false });
    expect(warehouse.after.initialBlockCount).toBeGreaterThan(viaduct.after.initialBlockCount);

    const exp1 = await harness.placeSandboxBuildBlock('explosive', [
      [4.5, 0.6, 0],
      [-4.5, 0.6, 0],
      [0, 0.6, 4.5],
    ]);
    const exp2 = await harness.placeSandboxBuildBlock('explosive', [
      [5.3, 0.6, 0.8],
      [-5.3, 0.6, 0.8],
      [0.8, 0.6, 5.3],
    ]);
    expect(exp1.placed || exp2.placed).toBe(true);
    await harness.exitSandboxBuildMode();

    await setSandboxUpgradeLevel(harness, 5);

    // 1. Плазморезак (#tool-cutter)
    await harness.aimAndStrikeStructure('cutter', {
      preferSide: 'left',
      heightFraction: 0.2,
      holdMs: 750,
      settleTicks: 18,
      maxAttempts: 3,
      searchFullPolygon: true,
    });

    // 2. Кинетическая пушка (#tool-cannon)
    await harness.aimAndStrikeStructure('cannon', {
      preferSide: 'center',
      heightFraction: 0.28,
      settleTicks: 18,
      maxAttempts: 3,
      searchFullPolygon: true,
    });

    // 3. Термитная кассета (#tool-incendiary)
    await harness.aimAndStrikeStructure('incendiary', {
      preferSide: 'right',
      heightFraction: 0.2,
      settleTicks: 18,
      maxAttempts: 3,
      searchFullPolygon: true,
    });

    // 4. Направленные заряды C4 и секвенсор очереди (#tool-c4)
    const seq1 = await harness.plantC4OnStructure({
      count: 1,
      delaySec: 0,
      preferSide: 'left',
      heightFraction: 0.16,
    });
    const seq2 = await harness.plantC4OnStructure({
      count: 1,
      delaySec: 0.25,
      preferSide: 'center',
      heightFraction: 0.18,
    });
    expect(seq1.plantedNow + seq2.plantedNow).toBeGreaterThanOrEqual(2);

    const queueCount = await readFiniteDataAttr(
      harness,
      EXT_SELECTORS.c4SequencerList,
      'data-queue-count',
    );
    expect(queueCount).toBeGreaterThanOrEqual(2);

    await harness.page.locator(SELECTORS.detonateC4Btn).click();
    await harness.waitForSimTicks(5);

    // 5. Покадровый разбор на паузе в режиме рентгена X-Ray
    await harness.setPaused(true);
    await harness.setRenderViewMode('xray');
    const stepA = await harness.stepOnceWhenPaused();
    expect(stepA.tickAfter).toBe(stepA.tickBefore + 1);
    const stepB = await harness.stepOnceWhenPaused();
    expect(stepB.tickAfter).toBe(stepB.tickBefore + 1);

    await harness.setPaused(false);
    await harness.waitForSimTime(0.6);

    // 6. Сейсмогенератор (#tool-seismic) + Фугасная бомба (#tool-bomb)
    await harness.activateSeismicTool({ freqHz: 2.8, ampM: 1.4, settleTicks: 24 });
    await harness.aimAndStrikeStructure('bomb', {
      preferSide: 'center',
      heightFraction: 0.16,
      settleTicks: 35,
      maxAttempts: 2,
      searchFullPolygon: true,
    });

    const summary = await readExtTelemetry(harness);
    expect(summary.destructionPct).toBeGreaterThan(15);
    expect(summary.brokenJointCount).toBeGreaterThan(0);
    expect(summary.activeShardCount + summary.bakedRubbleCount).toBeGreaterThan(0);
    expect(typeof summary.collapsedMassTons).toBe('number');
    expect(summary.collapsedMassTons!).toBeGreaterThan(0);

    const cleaned = await harness.resetScene();
    expect(cleaned.destructionPct).toBe(0);
    expect(cleaned.brokenJointCount).toBe(0);
    expect(await harness.getPlantedC4Count()).toBe(0);
  });

  test('[Tier4][R08][R09][F03][F08][F09][F11][F12][F21] Лабораторный цикл по всем 4 калибровочным стендам и всем 7 инженерным ползункам с контролем телеметрии', async ({
    harness,
  }) => {
    await harness.boot();
    await setAutoSlowmo(harness, false);

    // Стенд 1: Материаловедение и Термика (#lab-bench-materials) + #slider-fire-rate
    await harness.selectLabBench('materials');
    const fireApplied = await harness.setRangeSlider('fireRate', 3.5);
    expect(fireApplied.appliedValue).toBeGreaterThan(1.0);

    await harness.aimAndStrikeStructure('incendiary', {
      heightFraction: 0.2,
      settleTicks: 28,
      requireBurning: true,
      searchFullPolygon: true,
    });
    const domMat = await harness.readTelemetryDomValues();
    expect(domMat.burningNodes).toBeGreaterThan(0);
    expect(domMat.maxTempC).toBeGreaterThanOrEqual(260);

    // Стенд 2: Баллистика (#lab-bench-ballistics) + #slider-gravity + #slider-secondary-dmg
    await harness.selectLabBench('ballistics');
    const gravApplied = await harness.setRangeSlider('gravity', 18.0);
    const secApplied = await harness.setRangeSlider('secondaryDmg', 2.5);
    expect(gravApplied.appliedValue).toBeGreaterThan(10.0);
    expect(secApplied.appliedValue).toBeGreaterThan(1.0);

    const shotRes = await harness.aimAndStrikeStructure('cannon', {
      heightFraction: 0.3,
      settleTicks: 25,
      searchFullPolygon: true,
    });
    expect(shotRes.after.brokenJointCount + shotRes.after.activeShardCount).toBeGreaterThan(0);
    const domBal = await harness.readTelemetryDomValues();
    expect(domBal.kineticKj).toBeGreaterThanOrEqual(0);

    // Стенд 3: Ударные волны (#lab-bench-blast) + #slider-blast-falloff + #slider-joint-strength
    const blastStart = await harness.selectLabBench('blast');
    const falloffApplied = await harness.setRangeSlider('blastFalloff', 0.5);
    const jointApplied = await harness.setRangeSlider('jointStrength', 0.5);
    expect(falloffApplied.appliedValue).toBeLessThanOrEqual(1.0);
    expect(jointApplied.appliedValue).toBeLessThan(1.0);

    await harness.setRenderViewMode('stress');
    await harness.aimAndStrikeStructure('bomb', {
      heightFraction: 0.2,
      settleTicks: 35,
      searchFullPolygon: true,
    });
    const domBlast = await harness.readTelemetryDomValues();
    expect(domBlast.destructionPct).toBeGreaterThan(0);
    expect(domBlast.intactJoints).toBeLessThan(blastStart.initialJointCount);

    // Стенд 4: Сейсмоплатформа (#lab-bench-seismic) + #slider-quake-freq-hz + #slider-quake-amp
    await harness.selectLabBench('seismic');
    await harness.setRenderViewMode('xray');
    const quakeTel = await harness.triggerLabEarthquake({
      freqHz: 2.4,
      ampM: 1.6,
      settleTicks: 28,
    });
    expect(quakeTel.seismicActive).toBe(true);
    expect(quakeTel.seismicFrequencyHz).toBeCloseTo(2.4, 0);
    expect(quakeTel.seismicAmplitudeM).toBeCloseTo(1.6, 1);

    await harness.setPaused(true);
    await harness.waitForAnimationFrames(1);
    const syncedQuakeTel = await harness.getTelemetry();
    const domSeismic = await harness.readTelemetryDomValues();
    expect(domSeismic.fps).toBeGreaterThan(0);
    expect(Math.abs(domSeismic.intactJoints - syncedQuakeTel.intactJointCount)).toBeLessThanOrEqual(
      3,
    );
    await harness.setPaused(false);

    const resetLab = await harness.resetScene();
    expect(resetLab.destructionPct).toBe(0);
  });

  test('[Tier4][R01][R02][R10][R11][R12][F13][F16][F22][F24] Кросс-режимный аудит стабильности, локализации и палитры (No Purple) при открытых панелях Мастерской и Секвенсора C4', async ({
    harness,
  }) => {
    await harness.boot({ clearStorage: true });
    await setAutoSlowmo(harness, false);
    await harness.selectContract(1);

    const tools = await harness.getAvailableTools();
    if (tools.includes('c4')) {
      const p1 = await harness.plantC4OnStructure({
        count: 1,
        delaySec: 0,
        preferSide: 'left',
        heightFraction: 0.16,
      });
      const p2 = await harness.plantC4OnStructure({
        count: 1,
        delaySec: 0.25,
        preferSide: 'right',
        heightFraction: 0.18,
      });
      if (p1.plantedNow + p2.plantedNow > 0) {
        await expect(harness.page.locator(EXT_SELECTORS.c4SequencerPanel)).toBeVisible();
      }
    }

    const workshopModal = harness.page.locator(EXT_SELECTORS.workshopModal);
    await harness.page.locator(EXT_SELECTORS.openWorkshopBtn).click();
    await expect(workshopModal).toHaveAttribute('data-open', 'true');

    // Полный аудит кириллической локализации, отсутствия NaN/undefined и отсутствия фиолетовой палитры
    // прямо при открытых новых модальных/секвенсорных компонентах A1–A3
    const uiAudit = await harness.auditRussianUiAndNoPurple();
    expect(uiAudit.hasCyrillicText).toBe(true);
    expect(uiAudit.hasMalformedTokens).toBe(false);
    expect(uiAudit.malformedMatches).toEqual([]);
    expect(uiAudit.purpleViolations).toEqual([]);

    await harness.page.locator(EXT_SELECTORS.closeWorkshopBtn).click();
    await expect(workshopModal).toHaveAttribute('data-open', 'false');

    if ((await harness.getPlantedC4Count()) > 0) {
      await harness.page.locator(SELECTORS.detonateC4Btn).click();
      await harness.waitForSimTicks(12);
    }

    // Переключение между режимами под активной нагрузкой и прогон всех 3 графических пресетов
    await harness.selectLabBench('blast');
    await harness.spawnSandboxStructure('domino', { cleanResetFirst: true });

    await harness.setQualityPreset('performance');
    await harness.waitForAnimationFrames(2);
    await harness.setQualityPreset('high');
    await harness.waitForAnimationFrames(2);
    await harness.setQualityPreset('ultra');
    await harness.waitForAnimationFrames(2);
    await harness.setQualityPreset('performance');
    await harness.waitForAnimationFrames(2);

    // Возврат в Кампанию на #contract-02: проверка отсутствия утечек зарядов и осколков из Песочницы
    const freshContractTel = (await harness.selectContract(2)) as ExtTelemetry;
    expect(await harness.getPlantedC4Count()).toBe(0);
    expect(freshContractTel.destructionPct).toBe(0);
    expect(freshContractTel.brokenJointCount).toBe(0);
    expect(freshContractTel.c4SequenceQueue?.length ?? 0).toBe(0);

    await harness.verifyWebGL2Context();
  });
});
