import {
  test,
  expect,
  SELECTORS,
  areByteArraysDifferent,
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

test.describe.configure({ timeout: 60_000 });

test.describe('Уровень 3 — Кросс-фичевые комбинации: сейсмический резонанс Гц, прочность связей, покадровый разбор Bullet-Time и контроль авто-слоу-мо', () => {
  test('[Tier3][R07][R08][R09][F02][F11][F12][F14][F21] Сейсмический резонанс при ослабленной прочности связей (#slider-joint-strength) с перехватом разлома в Bullet-Time и пошаговым разбором (#time-step-btn)', async ({
    harness,
  }) => {
    await harness.boot();
    await setAutoSlowmo(harness, false);

    await harness.selectLabBench('seismic');
    await harness.setRangeSlider('jointStrength', 0.3);
    await harness.setRangeSlider('quakeFreqHz', 2.5);
    await harness.setRangeSlider('quakeAmp', 1.6);

    await harness.setRenderViewMode('stress');
    await harness.page.locator(SELECTORS.btnTriggerQuake).click();

    const tQuake = (await harness.waitForSimTicks(14)) as ExtTelemetry;
    expect(tQuake.seismicActive).toBe(true);
    expect(tQuake.seismicFrequencyHz).toBeCloseTo(2.5, 0);
    expect(tQuake.maxStressUtilization).toBeGreaterThan(0);

    const btScale = await harness.toggleBulletTime();
    expect(btScale).toBeGreaterThan(0);
    expect(btScale).toBeLessThan(1.0);

    await harness.setPaused(true);

    for (let i = 0; i < 3; i++) {
      const stepRes = await harness.stepOnceWhenPaused();
      expect(stepRes.tickAfter).toBe(stepRes.tickBefore + 1);
      await expect(harness.page.locator(SELECTORS.appRoot)).toHaveAttribute('data-paused', 'true');
    }

    const frozenTick = (await readExtTelemetry(harness)).tick;

    await harness.setRenderViewMode('stress');
    const pngStress = await harness.captureCanvasPngBytes();

    await harness.setRenderViewMode('xray');
    const pngXray = await harness.captureCanvasPngBytes();

    await harness.setRenderViewMode('pbr');
    const pngPbr = await harness.captureCanvasPngBytes();

    expect(areByteArraysDifferent(pngStress, pngXray)).toBe(true);
    expect(areByteArraysDifferent(pngXray, pngPbr)).toBe(true);

    const afterViewsTick = (await readExtTelemetry(harness)).tick;
    expect(afterViewsTick).toBe(frozenTick);

    await harness.setPaused(false);
    await harness.setTimeScale(1.0);
  });

  test('[Tier3][R08][R09][F11][F14][F21] Частотная настройка вибростенда (низкочастотный vs высокочастотный режим Гц) под рентгеном связей X-Ray', async ({
    harness,
  }) => {
    await harness.boot();
    await setAutoSlowmo(harness, false);

    // 1. Низкочастотный прогон (1.8 Гц)
    await harness.selectLabBench('seismic');
    await harness.setRenderViewMode('xray');
    await harness.setRangeSlider('jointStrength', 0.55);
    const lowT = (await harness.triggerLabEarthquake({
      freqHz: 1.8,
      ampM: 1.4,
      settleTicks: 45,
    })) as ExtTelemetry;

    // 2. Высокочастотный прогон (12.0 Гц) с чистым перезапуском стенда
    await harness.selectLabBench('seismic');
    await harness.setRenderViewMode('xray');
    await harness.setRangeSlider('jointStrength', 0.55);
    const highT = (await harness.triggerLabEarthquake({
      freqHz: 12.0,
      ampM: 1.4,
      settleTicks: 45,
    })) as ExtTelemetry;

    expect(lowT.seismicFrequencyHz).toBeLessThan(3.0);
    expect(highT.seismicFrequencyHz).toBeGreaterThan(10.0);

    expect(Math.max(lowT.brokenJointCount, highT.brokenJointCount)).toBeGreaterThan(0);
    expect(Math.max(lowT.maxStressUtilization, highT.maxStressUtilization)).toBeGreaterThan(0.2);

    const distinctFrequencyResponse =
      lowT.brokenJointCount !== highT.brokenJointCount ||
      Math.abs(lowT.destructionPct - highT.destructionPct) > 0.05 ||
      Math.abs(lowT.maxStressUtilization - highT.maxStressUtilization) > 0.02;

    expect(distinctFrequencyResponse).toBe(true);
  });

  test('[Tier3][R07][R11][F12][F25] Контроль тумблера авто-слоу-мо (#auto-slowmo-toggle): сохранение пользовательского data-time-scale и монотонности тиков при обрушении главной опоры', async ({
    harness,
  }) => {
    await harness.boot();
    const appRoot = harness.page.locator(SELECTORS.appRoot);

    // Фаза 1: авто-слоу-мо отключено
    await harness.spawnSandboxStructure('tower', { cleanResetFirst: true });
    const userScalePhase1 = await harness.setTimeScale(1.0);
    expect(userScalePhase1).toBeCloseTo(1.0, 2);

    await setAutoSlowmo(harness, false);

    const plantedOff = await harness.plantC4OnStructure({
      count: 3,
      delaySec: 0,
      preferSide: 'center',
      heightFraction: 0.14,
    });
    expect(plantedOff.totalPlanted).toBeGreaterThanOrEqual(2);

    await harness.detonateC4AndSettle(35);
    await expect(appRoot).toHaveAttribute('data-auto-slowmo', 'false');
    expect(Number(await appRoot.getAttribute('data-time-scale'))).toBeCloseTo(userScalePhase1, 4);

    // Фаза 2: авто-слоу-мо включено — базовый пользовательский data-time-scale НЕ должен перезаписываться
    await harness.spawnSandboxStructure('tower', { cleanResetFirst: true });
    const userScalePhase2 = await harness.setTimeScale(1.0);
    expect(userScalePhase2).toBeCloseTo(1.0, 2);

    await setAutoSlowmo(harness, true);

    const plantedOn = await harness.plantC4OnStructure({
      count: 4,
      delaySec: 0,
      preferSide: 'center',
      heightFraction: 0.14,
    });
    expect(plantedOn.totalPlanted).toBeGreaterThanOrEqual(2);

    let prevTick = (await readExtTelemetry(harness)).tick;
    await harness.page.locator(SELECTORS.detonateC4Btn).click();

    let finalTelemetry = await readExtTelemetry(harness);
    for (let step = 0; step < 6; step++) {
      finalTelemetry = (await harness.waitForSimTicks(8)) as ExtTelemetry;
      expect(finalTelemetry.tick).toBeGreaterThan(prevTick);
      prevTick = finalTelemetry.tick;

      await expect(appRoot).toHaveAttribute('data-auto-slowmo', 'true');
      const currentScaleAttr = Number(await appRoot.getAttribute('data-time-scale'));
      expect(currentScaleAttr).toBeCloseTo(userScalePhase2, 4);
    }

    expect(typeof finalTelemetry.collapsedMassTons).toBe('number');
    expect(finalTelemetry.collapsedMassTons!).toBeGreaterThan(0);

    const hudTons = await readFiniteDataAttr(harness, EXT_SELECTORS.hudCollapsedTons, 'data-value');
    expect(hudTons).toBeGreaterThan(0);

    await setAutoSlowmo(harness, false);
  });

  test('[Tier3][R02][R07][R08][F11][F14][F15][F16] Сверхзамедление 0.05x во время активного землетрясения с орбитальным облётом камеры, переключением #audio-mute-btn и режимов PBR / Stress / X-Ray', async ({
    harness,
  }) => {
    await harness.boot();
    await setAutoSlowmo(harness, false);

    await harness.spawnSandboxStructure('viaduct', { cleanResetFirst: true });
    await harness.activateSeismicTool({
      freqHz: 2.6,
      ampM: 1.5,
      settleTicks: 10,
    });

    const slowScale = await harness.setTimeScale(0.05);
    expect(slowScale).toBeGreaterThan(0);
    expect(slowScale).toBeLessThanOrEqual(0.25);

    // Короткое окно 3 тиков при сверхзамедлении 0.05x
    await harness.waitForSimTicks(3, 15_000);

    await harness.toggleAudioMute();
    await harness.toggleAudioMute();

    const projBefore = await harness.projectWorldPoint(3.5, 2.5, 0);
    await harness.orbitCameraDrag(130, -25);
    await harness.zoomCameraWheel(-260);
    const projAfter = await harness.projectWorldPoint(3.5, 2.5, 0);

    expect(Math.hypot(projAfter.x - projBefore.x, projAfter.y - projBefore.y)).toBeGreaterThan(5);

    await harness.setRenderViewMode('pbr');
    await harness.setRenderViewMode('stress');
    await harness.setRenderViewMode('xray');

    const restoredScale = await harness.setTimeScale(1.0);
    expect(restoredScale).toBeCloseTo(1.0, 2);

    await harness.waitForSimTicks(10);
    await harness.setPaused(true);
    await harness.waitForAnimationFrames(1);

    const telemetry = await harness.getTelemetry();
    const domVals = await harness.readTelemetryDomValues();

    expect(Math.abs(domVals.destructionPct - telemetry.destructionPct)).toBeLessThanOrEqual(2.0);
    expect(Math.abs(domVals.intactJoints - telemetry.intactJointCount)).toBeLessThanOrEqual(3);
    expect(domVals.fps).toBeGreaterThan(0);

    await harness.setPaused(false);
  });
});
