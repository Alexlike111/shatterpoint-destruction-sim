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

test.describe.configure({ timeout: 60_000 });

test.describe('Уровень 3 — Кросс-фичевые комбинации: композитный конструктор, термитный пожар, пластика стали и цепная детонация', () => {
  test('[Tier3][R04][R06][R08][F03][F07][F10][F17] Достройка композитного узла (дерево + сталь) на промышленном ангаре и поджог термитом (#tool-incendiary): конвективный нагрев стали и пластическое проседание', async ({
    harness,
  }) => {
    await harness.boot();
    await setAutoSlowmo(harness, false);

    await harness.spawnSandboxStructure('hangar', { cleanResetFirst: true });

    const woodPlaced = await harness.placeSandboxBuildBlock('wood', [
      [0, 0.8, 0],
      [1.4, 0.8, 0],
      [-1.4, 0.8, 0],
      [2.6, 0.8, 0],
      [0, 0.8, 1.8],
    ]);
    expect(woodPlaced.placed).toBe(true);

    const steelPlaced = await harness.placeSandboxBuildBlock('steel', [
      [0.8, 0.8, 0.8],
      [-0.8, 0.8, 0.8],
      [2.0, 0.8, 1.2],
      [-2.0, 0.8, 1.2],
      [0, 1.6, 0],
    ]);
    expect(steelPlaced.placed).toBe(true);

    await harness.exitSandboxBuildMode();

    const beforeFire = await readExtTelemetry(harness);
    expect(beforeFire.burningNodeCount).toBe(0);
    expect(beforeFire.plasticHingeCount).toBe(0);
    expect(beforeFire.brokenJointCount).toBe(0);

    await harness.setRenderViewMode('stress');

    await harness.aimAndStrikeStructure('incendiary', {
      worldPoint: woodPlaced.hit?.world,
      heightFraction: 0.2,
      settleTicks: 24,
      requireBurning: true,
      searchFullPolygon: true,
    });

    await harness.aimAndStrikeStructure('incendiary', {
      worldPoint: steelPlaced.hit?.world,
      preferSide: 'left',
      heightFraction: 0.22,
      settleTicks: 20,
      maxAttempts: 2,
      searchFullPolygon: true,
    });

    let peakBurningNodes = 0;
    let peakTempC = 0;
    let finalTelemetry = await readExtTelemetry(harness);

    for (let step = 0; step < 8; step++) {
      finalTelemetry = (await harness.waitForSimTicks(10)) as ExtTelemetry;
      if (finalTelemetry.burningNodeCount > peakBurningNodes) {
        peakBurningNodes = finalTelemetry.burningNodeCount;
      }
      if (finalTelemetry.maxTemperatureC > peakTempC) {
        peakTempC = finalTelemetry.maxTemperatureC;
      }
    }

    expect(peakBurningNodes).toBeGreaterThan(0);
    expect(peakTempC).toBeGreaterThanOrEqual(350);

    const thermalStructuralResponse =
      finalTelemetry.plasticHingeCount > 0 ||
      finalTelemetry.brokenJointCount > 0 ||
      finalTelemetry.maxStressUtilization > beforeFire.maxStressUtilization + 0.03;
    expect(thermalStructuralResponse).toBe(true);

    const domVals = await harness.readTelemetryDomValues();
    expect(domVals.maxTempC).toBeGreaterThan(100);
    expect(Math.abs(domVals.burningNodes - finalTelemetry.burningNodeCount)).toBeLessThanOrEqual(2);
  });

  test('[Tier3][R04][R06][R11][F03][F09][F10][F25] Композитный узел «дерево + сталь + взрывчатые бочки»: поджог термитом запускает тепловую цепную детонацию и уведомление в #tactical-feed', async ({
    harness,
  }) => {
    await harness.boot();
    await setAutoSlowmo(harness, false);

    await harness.spawnSandboxStructure('warehouse', { cleanResetFirst: true });

    const woodCluster = await harness.placeSandboxBuildBlock('wood', [
      [3.5, 0.6, 0],
      [2.6, 0.6, 0],
      [0, 0.8, 2.2],
      [-3.5, 0.6, 0],
    ]);
    expect(woodCluster.placed).toBe(true);

    const steelCluster = await harness.placeSandboxBuildBlock('steel', [
      [3.5, 0.6, 1.0],
      [2.6, 0.6, 1.0],
      [-3.5, 0.6, 1.0],
    ]);
    expect(steelCluster.placed).toBe(true);

    const exp1 = await harness.placeSandboxBuildBlock('explosive', [
      [4.3, 0.6, 0],
      [3.5, 0.6, -1.0],
      [-4.3, 0.6, 0],
      [1.8, 0.6, 0],
    ]);
    expect(exp1.placed).toBe(true);

    const exp2 = await harness.placeSandboxBuildBlock('explosive', [
      [5.0, 0.6, 0.6],
      [4.3, 0.6, 1.0],
      [-5.0, 0.6, 0.6],
      [1.8, 0.6, 1.0],
    ]);
    expect(exp2.placed).toBe(true);

    await harness.exitSandboxBuildMode();

    const beforeIgnite = await readExtTelemetry(harness);
    expect(beforeIgnite.detonatedExplosivesCount).toBe(0);

    await harness.aimAndStrikeStructure('incendiary', {
      worldPoint: exp1.hit?.world ?? woodCluster.hit?.world,
      heightFraction: 0.2,
      settleTicks: 18,
      maxAttempts: 3,
      searchFullPolygon: true,
    });

    await harness.aimAndStrikeStructure('incendiary', {
      preferSide: 'center',
      heightFraction: 0.2,
      settleTicks: 18,
      requireBurning: true,
      searchFullPolygon: true,
    });

    let afterChain = await readExtTelemetry(harness);
    await expect
      .poll(
        async () => {
          afterChain = (await harness.waitForSimTicks(12)) as ExtTelemetry;
          return afterChain.detonatedExplosivesCount;
        },
        {
          timeout: 14_000,
          message: 'Ожидание тепловой цепной детонации взрывчатого кластера без выстрелов и C4',
        },
      )
      .toBeGreaterThanOrEqual(1);

    expect(afterChain.brokenJointCount).toBeGreaterThan(0);
    expect(afterChain.destructionPct).toBeGreaterThan(0);
    expect(typeof afterChain.collapsedMassTons).toBe('number');
    expect(afterChain.collapsedMassTons!).toBeGreaterThan(0);

    const feedEvent =
      (await harness.page.locator(EXT_SELECTORS.tacticalFeed).getAttribute('data-last-event')) ?? '';
    expect(feedEvent.trim().length).toBeGreaterThan(0);
    expect(/[А-Яа-яЁё]{3,}/.test(feedEvent)).toBe(true);
    expect(feedEvent).not.toContain('undefined');
    expect(feedEvent).not.toContain('NaN');

    const hudScore = await readFiniteDataAttr(
      harness,
      EXT_SELECTORS.hudDestructionScore,
      'data-value',
    );
    const hudTons = await readFiniteDataAttr(harness, EXT_SELECTORS.hudCollapsedTons, 'data-value');
    expect(hudScore).toBeGreaterThan(0);
    expect(hudTons).toBeGreaterThan(0);
  });

  test('[Tier3][R06][R09][F03][F10][F12][F21] Синергия скорости распространения огня (#slider-fire-rate) и ослабленных связей (#slider-joint-strength) на стенде материаловедения', async ({
    harness,
  }) => {
    await harness.boot();
    await setAutoSlowmo(harness, false);

    await harness.selectLabBench('materials');
    const fireMeta = await harness.getSliderMeta('fireRate');
    const jointMeta = await harness.getSliderMeta('jointStrength');

    // Прогон А: подавленное распространение огня и усиленные связи
    await harness.setRangeSlider('fireRate', fireMeta.min);
    await harness.setRangeSlider('jointStrength', Math.min(jointMeta.max, 2.5));

    const slowIgnite = await harness.aimAndStrikeStructure('incendiary', {
      heightFraction: 0.2,
      settleTicks: 18,
      requireBurning: true,
      searchFullPolygon: true,
    });
    const fireOrigin = slowIgnite.usedPoint?.world;
    const slowTelemetry = (await harness.waitForSimTicks(45)) as ExtTelemetry;

    // Прогон Б: максимальная скорость огня и ослабленные связи на том же стенде и в той же точке
    await harness.selectLabBench('materials');
    await harness.setRangeSlider('fireRate', fireMeta.max);
    await harness.setRangeSlider('jointStrength', Math.max(jointMeta.min, 0.2));

    await harness.aimAndStrikeStructure('incendiary', {
      worldPoint: fireOrigin,
      heightFraction: 0.2,
      settleTicks: 18,
      requireBurning: true,
      searchFullPolygon: true,
    });
    const fastTelemetry = (await harness.waitForSimTicks(45)) as ExtTelemetry;

    const synergyConfirmed =
      fastTelemetry.burningNodeCount > slowTelemetry.burningNodeCount ||
      fastTelemetry.maxTemperatureC > slowTelemetry.maxTemperatureC + 10 ||
      fastTelemetry.brokenJointCount > slowTelemetry.brokenJointCount ||
      fastTelemetry.destructionPct > slowTelemetry.destructionPct + 0.1;

    expect(synergyConfirmed).toBe(true);
  });

  test('[Tier3][R06][R08][R11][F07][F10][F11] Термическое ослабление стального каркаса в связке с сейсмическим резонансом (#tool-incendiary + #tool-seismic)', async ({
    harness,
  }) => {
    await harness.boot();
    await setAutoSlowmo(harness, false);

    // 1. Холодный контрольный прогон стального ангара под умеренным землетрясением
    await harness.spawnSandboxStructure('hangar', { cleanResetFirst: true });
    const coldBefore = await readExtTelemetry(harness);

    const coldAfter = (await harness.activateSeismicTool({
      freqHz: 3.2,
      ampM: 0.55,
      settleTicks: 40,
    })) as ExtTelemetry;

    // 2. Горячий прогон: прогрев опорных стоек ангара термитом + то же землетрясение
    await harness.spawnSandboxStructure('hangar', { cleanResetFirst: true });

    await harness.aimAndStrikeStructure('incendiary', {
      preferSide: 'left',
      heightFraction: 0.2,
      settleTicks: 22,
      maxAttempts: 2,
      searchFullPolygon: true,
    });
    await harness.aimAndStrikeStructure('incendiary', {
      preferSide: 'right',
      heightFraction: 0.2,
      settleTicks: 22,
      maxAttempts: 2,
      searchFullPolygon: true,
    });
    await harness.aimAndStrikeStructure('incendiary', {
      preferSide: 'center',
      heightFraction: 0.2,
      settleTicks: 22,
      maxAttempts: 2,
      searchFullPolygon: true,
    });

    const hotBefore = (await harness.waitForSimTicks(35)) as ExtTelemetry;
    expect(hotBefore.maxTemperatureC).toBeGreaterThan(coldBefore.maxTemperatureC + 150);

    await harness.setRenderViewMode('pbr');
    const hotAfter = (await harness.activateSeismicTool({
      freqHz: 3.2,
      ampM: 0.55,
      settleTicks: 40,
    })) as ExtTelemetry;

    expect(hotAfter.maxTemperatureC).toBeGreaterThan(coldAfter.maxTemperatureC);

    const thermalWeakeningConfirmed =
      hotAfter.plasticHingeCount > coldAfter.plasticHingeCount ||
      hotAfter.brokenJointCount > coldAfter.brokenJointCount ||
      hotAfter.destructionPct > coldAfter.destructionPct + 0.05 ||
      hotAfter.maxStressUtilization > coldAfter.maxStressUtilization + 0.03;

    expect(thermalWeakeningConfirmed).toBe(true);
  });

  test('[Tier3][R04][R05][R06][F04][F09][F10] Термошок и ударная волна по достроенному остеклению (#mat-glass + #mat-explosive + #tool-incendiary)', async ({
    harness,
  }) => {
    await harness.boot();
    await setAutoSlowmo(harness, false);

    await harness.spawnSandboxStructure('warehouse', { cleanResetFirst: true });

    const glass1 = await harness.placeSandboxBuildBlock('glass', [
      [4.0, 0.6, 0],
      [-4.0, 0.6, 0],
      [0, 0.6, 4.5],
    ]);
    expect(glass1.placed).toBe(true);

    const glass2 = await harness.placeSandboxBuildBlock('glass', [
      [4.0, 0.6, 1.1],
      [-4.0, 0.6, 1.1],
      [1.1, 0.6, 4.5],
    ]);
    expect(glass2.placed).toBe(true);

    const explosiveAdj = await harness.placeSandboxBuildBlock('explosive', [
      [4.8, 0.6, 0.4],
      [3.2, 0.6, 0.4],
      [-4.8, 0.6, 0.4],
      [0.4, 0.6, 5.3],
    ]);
    expect(explosiveAdj.placed).toBe(true);

    await harness.exitSandboxBuildMode();

    const before = await readExtTelemetry(harness);
    expect(before.activeShardCount).toBe(0);
    expect(before.detonatedExplosivesCount).toBe(0);

    await harness.aimAndStrikeStructure('incendiary', {
      worldPoint: explosiveAdj.hit?.world ?? glass1.hit?.world,
      heightFraction: 0.2,
      settleTicks: 24,
      maxAttempts: 3,
      searchFullPolygon: true,
    });

    const after = (await harness.waitForSimTicks(65)) as ExtTelemetry;

    expect(after.activeShardCount + after.bakedRubbleCount + after.brokenJointCount).toBeGreaterThan(
      0,
    );

    const domVals = await harness.readTelemetryDomValues();
    expect(domVals.destructionPct).toBeGreaterThanOrEqual(0);
    expect(domVals.intactJoints).toBeGreaterThanOrEqual(0);
    expect(domVals.rebarLinks).toBeGreaterThanOrEqual(0);
    expect(domVals.burningNodes).toBeGreaterThanOrEqual(0);
    expect(domVals.maxTempC).toBeGreaterThanOrEqual(20);
    expect(domVals.kineticKj).toBeGreaterThanOrEqual(0);
    expect(domVals.fps).toBeGreaterThan(0);

    const hudTons = await readFiniteDataAttr(harness, EXT_SELECTORS.hudCollapsedTons, 'data-value');
    expect(hudTons).toBeGreaterThanOrEqual(0);
  });
});
