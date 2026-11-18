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
  const root = harness.page.locator(SELECTORS.appRoot);
  const toggle = harness.page.locator(EXT_SELECTORS.autoSlowmoToggle);
  await expect(toggle).toBeAttached();
  const current = (await root.getAttribute('data-auto-slowmo')) === 'true';
  if (current !== enabled) {
    await toggle.click();
    await harness.waitForAnimationFrames(1);
  }
  await expect(root).toHaveAttribute('data-auto-slowmo', String(enabled));
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

interface CascadeObservation {
  finalTelemetry: ExtTelemetry;
  peakCombo: number;
  peakActiveRebar: number;
  events: string[];
}

async function observeCascadeWindow(
  harness: ShatterpointHarness,
  steps = 8,
  ticksPerStep = 8,
): Promise<CascadeObservation> {
  let peakCombo = 1;
  let peakActiveRebar = 0;
  const seenEvents = new Set<string>();
  let latest = await readExtTelemetry(harness);

  for (let i = 0; i < steps; i++) {
    latest = (await harness.waitForSimTicks(ticksPerStep)) as ExtTelemetry;
    if (latest.activeRebarCount > peakActiveRebar) {
      peakActiveRebar = latest.activeRebarCount;
    }
    const bridgeCombo = latest.comboMultiplier ?? 1;
    if (bridgeCombo > peakCombo) {
      peakCombo = bridgeCombo;
    }

    const domCombo = await readFiniteDataAttr(
      harness,
      EXT_SELECTORS.hudComboBadge,
      'data-multiplier',
    );
    if (domCombo > peakCombo) {
      peakCombo = domCombo;
    }

    const rawEvent = await harness.page
      .locator(EXT_SELECTORS.tacticalFeed)
      .getAttribute('data-last-event');
    const trimmed = (rawEvent ?? '').trim();
    if (trimmed.length > 0) {
      seenEvents.add(trimmed);
    }
  }

  return {
    finalTelemetry: latest,
    peakCombo,
    peakActiveRebar,
    events: Array.from(seenEvents),
  };
}

test.describe.configure({ timeout: 60_000 });

test.describe('Уровень 3 — Кросс-фичевые комбинации: несущий каркас, арматура ЖБ в X-Ray, вторичный кинетический каскад и тоннаж', () => {
  test('[Tier3][R03][R08][R11][F05][F06][F07][F14][F25] Подрыв части нижних колонн ЖБ-башни в режиме X-Ray: натяжение и обрыв арматуры с ростом тоннажа #hud-collapsed-tons', async ({
    harness,
  }) => {
    await harness.boot();
    await setAutoSlowmo(harness, false);

    const spawned = await harness.spawnSandboxStructure('tower', { cleanResetFirst: true });
    const initial = spawned.after as ExtTelemetry;
    expect(initial.activeRebarCount).toBe(0);
    expect(initial.snappedRebarCount).toBe(0);
    expect(initial.brokenJointCount).toBe(0);

    await harness.setRenderViewMode('xray');
    const xrayBefore = await harness.captureCanvasPngBytes();

    const planted = await harness.plantC4OnStructure({
      count: 3,
      delaySec: 0,
      preferSide: 'left',
      heightFraction: 0.14,
    });
    expect(planted.totalPlanted).toBeGreaterThanOrEqual(2);

    await harness.page.locator(SELECTORS.detonateC4Btn).click();
    const cascade = await observeCascadeWindow(harness, 10, 6);
    const xrayAfter = await harness.captureCanvasPngBytes();

    expect(cascade.finalTelemetry.brokenJointCount).toBeGreaterThan(0);
    expect(cascade.peakActiveRebar + cascade.finalTelemetry.snappedRebarCount).toBeGreaterThan(0);

    const domTelemetry = await harness.readTelemetryDomValues();
    expect(
      Math.abs(domTelemetry.rebarLinks - cascade.finalTelemetry.activeRebarCount),
    ).toBeLessThanOrEqual(2);

    expect(areByteArraysDifferent(xrayBefore, xrayAfter)).toBe(true);

    expect(typeof cascade.finalTelemetry.collapsedMassTons).toBe('number');
    expect(cascade.finalTelemetry.collapsedMassTons!).toBeGreaterThan(0);

    const hudTons = await readFiniteDataAttr(harness, EXT_SELECTORS.hudCollapsedTons, 'data-value');
    expect(hudTons).toBeGreaterThan(0);
    expect(Math.abs(hudTons - cascade.finalTelemetry.collapsedMassTons!)).toBeLessThanOrEqual(0.5);
  });

  test('[Tier3][R03][R05][R11][F06][F08][F17][F25] Мульти-спавн двух сооружений рядом: каскадный обвал ЖБ-башни с вторичным кинетическим уроном соседнему строению и ростом #hud-combo-badge', async ({
    harness,
  }) => {
    await harness.boot();
    await setAutoSlowmo(harness, false);

    const first = await harness.spawnSandboxStructure('tower', { cleanResetFirst: true });
    const blocksTower = first.after.initialBlockCount;
    expect(blocksTower).toBeGreaterThan(0);

    const second = await harness.spawnSandboxStructure('warehouse', { cleanResetFirst: false });
    expect(second.after.initialBlockCount).toBeGreaterThan(blocksTower);
    expect(second.after.secondaryImpactsCount).toBe(0);

    const c4Wave1 = await harness.plantC4OnStructure({
      count: 2,
      delaySec: 0,
      preferSide: 'center',
      heightFraction: 0.14,
    });
    const c4Wave2 = await harness.plantC4OnStructure({
      count: 2,
      delaySec: 0.25,
      preferSide: 'right',
      heightFraction: 0.16,
    });
    expect(c4Wave1.plantedNow + c4Wave2.plantedNow).toBeGreaterThanOrEqual(2);

    await harness.page.locator(SELECTORS.detonateC4Btn).click();
    await harness.waitForSimTicks(6);

    await harness.aimAndStrikeStructure('bomb', {
      preferSide: 'center',
      heightFraction: 0.22,
      settleTicks: 6,
      maxAttempts: 2,
      searchFullPolygon: true,
    });

    const cascade = await observeCascadeWindow(harness, 12, 6);

    expect(cascade.finalTelemetry.secondaryImpactsCount).toBeGreaterThan(0);
    expect(cascade.finalTelemetry.destructionPct).toBeGreaterThan(10);
    expect(typeof cascade.finalTelemetry.collapsedMassTons).toBe('number');
    expect(cascade.finalTelemetry.collapsedMassTons!).toBeGreaterThan(0);

    const hudScore = await readFiniteDataAttr(
      harness,
      EXT_SELECTORS.hudDestructionScore,
      'data-value',
    );
    expect(hudScore).toBeGreaterThan(0);
    expect(typeof cascade.finalTelemetry.destructionScore).toBe('number');
    expect(cascade.finalTelemetry.destructionScore!).toBeGreaterThan(0);

    expect(cascade.peakCombo).toBeGreaterThanOrEqual(1.5);
    expect(cascade.events.length).toBeGreaterThan(0);
  });

  test('[Tier3][R04][R06][R08][F05][F07][F14][F18][F25] Комбинированный надлом колонны и хирургический дорез арматурных связей плазморезаком (#tool-cutter) под рентгеном X-Ray и контролем #tactical-feed', async ({
    harness,
  }) => {
    await harness.boot();
    await setAutoSlowmo(harness, false);

    const spawned = await harness.spawnSandboxStructure('tower', { cleanResetFirst: true });
    const initialJoints = spawned.after.initialJointCount;
    expect(initialJoints).toBeGreaterThan(0);

    await harness.setRenderViewMode('xray');

    const cannonRes = await harness.aimAndStrikeStructure('cannon', {
      preferSide: 'center',
      heightFraction: 0.16,
      settleTicks: 18,
      maxAttempts: 3,
    });
    expect(cannonRes.impactConfirmed).toBe(true);

    const beforeCutter = await readExtTelemetry(harness);

    const cutterRes = await harness.aimAndStrikeStructure('cutter', {
      worldPoint: cannonRes.usedPoint?.world,
      preferSide: 'center',
      heightFraction: 0.16,
      holdMs: 950,
      settleTicks: 30,
      maxAttempts: 4,
    });
    expect(cutterRes.impactConfirmed).toBe(true);

    const afterCutter = await readExtTelemetry(harness);
    const cutterProgressedDamage =
      afterCutter.brokenJointCount > beforeCutter.brokenJointCount ||
      afterCutter.snappedRebarCount > beforeCutter.snappedRebarCount ||
      afterCutter.intactBlockCount < beforeCutter.intactBlockCount ||
      afterCutter.destructionPct > beforeCutter.destructionPct + 0.05;
    expect(cutterProgressedDamage).toBe(true);

    const feedLoc = harness.page.locator(EXT_SELECTORS.tacticalFeed);
    await expect(feedLoc).toBeAttached();
    const lastEvent = (await feedLoc.getAttribute('data-last-event')) ?? '';
    expect(lastEvent.trim().length).toBeGreaterThan(0);
    expect(/[А-Яа-яЁё]{3,}/.test(lastEvent)).toBe(true);
    expect(lastEvent).not.toContain('undefined');
    expect(lastEvent).not.toContain('NaN');

    const domVals = await harness.readTelemetryDomValues();
    expect(domVals.intactJoints).toBeLessThan(initialJoints);
  });

  test('[Tier3][R08][R09][R11][F06][F08][F12][F21] Влияние ползунка вторичного кинетического урона (#slider-secondary-dmg: минимум vs максимум) на каскадное дробление в режиме Stress', async ({
    harness,
  }) => {
    await harness.boot();
    await setAutoSlowmo(harness, false);

    await harness.selectLabBench('seismic');
    await harness.setRenderViewMode('stress');

    const secMeta = await harness.getSliderMeta('secondaryDmg');
    expect(secMeta.max).toBeGreaterThan(secMeta.min);

    await harness.setRangeSlider('jointStrength', 1.0);
    await harness.setRangeSlider('secondaryDmg', secMeta.min);

    const strikeMin = await harness.aimAndStrikeStructure('bomb', {
      preferSide: 'center',
      heightFraction: 0.42,
      settleTicks: 50,
      maxAttempts: 1,
      searchFullPolygon: true,
    });
    const usedWorld = strikeMin.usedPoint?.world ?? [0, 2.8, 0];
    let afterMin = (await readExtTelemetry(harness));

    await harness.selectLabBench('seismic');
    await harness.setRenderViewMode('stress');
    await harness.setRangeSlider('jointStrength', 1.0);
    await harness.setRangeSlider('secondaryDmg', secMeta.max);

    await harness.aimAndStrikeStructure('bomb', {
      worldPoint: usedWorld,
      settleTicks: 50,
      maxAttempts: 1,
    });
    let afterMax = await readExtTelemetry(harness);

    if (
      afterMax.secondaryImpactsCount === afterMin.secondaryImpactsCount &&
      afterMax.brokenJointCount === afterMin.brokenJointCount &&
      Math.abs(afterMax.destructionPct - afterMin.destructionPct) <= 0.05
    ) {
      await harness.selectLabBench('ballistics');
      await harness.setRenderViewMode('stress');
      await harness.setRangeSlider('jointStrength', 1.0);
      await harness.setRangeSlider('secondaryDmg', secMeta.min);

      const fbMin = await harness.aimAndStrikeStructure('bomb', {
        preferSide: 'center',
        heightFraction: 0.38,
        settleTicks: 50,
        maxAttempts: 1,
        searchFullPolygon: true,
      });
      const fbWorld = fbMin.usedPoint?.world ?? [0, 2.2, 0];
      afterMin = await readExtTelemetry(harness);

      await harness.selectLabBench('ballistics');
      await harness.setRenderViewMode('stress');
      await harness.setRangeSlider('jointStrength', 1.0);
      await harness.setRangeSlider('secondaryDmg', secMeta.max);

      await harness.aimAndStrikeStructure('bomb', {
        worldPoint: fbWorld,
        settleTicks: 50,
        maxAttempts: 1,
      });
      afterMax = await readExtTelemetry(harness);
    }

    const strongerCascadeWithMaxSecondary =
      afterMax.secondaryImpactsCount > afterMin.secondaryImpactsCount ||
      afterMax.brokenJointCount > afterMin.brokenJointCount ||
      afterMax.destructionPct > afterMin.destructionPct + 0.05 ||
      (afterMax.collapsedMassTons ?? 0) > (afterMin.collapsedMassTons ?? 0) + 0.05;

    expect(strongerCascadeWithMaxSecondary).toBe(true);
    await expect(harness.page.locator(SELECTORS.appRoot)).toHaveAttribute(
      'data-render-mode',
      'stress',
    );
  });

  test('[Tier3][R03][R04][R05][R11][F05][F08][F17][F25] Цепная реакция «Каскад домино» с достроенным павильоном на финише: передача кинетического импульса, тоннаж и комбо-множитель', async ({
    harness,
  }) => {
    await harness.boot();
    await setAutoSlowmo(harness, false);

    const spawned = await harness.spawnSandboxStructure('domino', { cleanResetFirst: true });
    expect(spawned.after.brokenJointCount).toBe(0);
    expect(spawned.after.secondaryImpactsCount).toBe(0);

    const glassBlock = await harness.placeSandboxBuildBlock('glass', [
      [8.0, 0.6, 0],
      [-8.0, 0.6, 0],
      [6.5, 0.6, 0],
      [-6.5, 0.6, 0],
      [0, 0.6, 6.5],
    ]);
    expect(glassBlock.placed).toBe(true);

    const brickBlock = await harness.placeSandboxBuildBlock('brick', [
      [8.8, 0.6, 0.8],
      [-8.8, 0.6, 0.8],
      [7.2, 0.6, 1.0],
      [-7.2, 0.6, 1.0],
      [1.2, 0.6, 6.5],
    ]);
    expect(brickBlock.placed).toBe(true);

    await harness.exitSandboxBuildMode();

    const pushLeft = await harness.aimAndStrikeStructure('cannon', {
      preferSide: 'left',
      heightFraction: 0.65,
      settleTicks: 18,
      searchFullPolygon: true,
    });

    if (pushLeft.after.secondaryImpactsCount === 0 && pushLeft.after.brokenJointCount < 2) {
      await harness.aimAndStrikeStructure('cannon', {
        preferSide: 'right',
        heightFraction: 0.65,
        settleTicks: 18,
        searchFullPolygon: true,
      });
    }

    const cascade = await observeCascadeWindow(harness, 12, 8);

    expect(cascade.finalTelemetry.brokenJointCount).toBeGreaterThanOrEqual(2);
    expect(cascade.finalTelemetry.secondaryImpactsCount).toBeGreaterThanOrEqual(1);
    expect(typeof cascade.finalTelemetry.collapsedMassTons).toBe('number');
    expect(cascade.finalTelemetry.collapsedMassTons!).toBeGreaterThan(0);

    expect(cascade.peakCombo).toBeGreaterThanOrEqual(1.5);

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

    expect(hudTons).toBeGreaterThan(0);
    expect(Math.abs(hudTons - cascade.finalTelemetry.collapsedMassTons!)).toBeLessThanOrEqual(0.5);
    expect(hudScore).toBeGreaterThan(0);
    expect(hudCombo).toBeGreaterThanOrEqual(1);
  });
});
