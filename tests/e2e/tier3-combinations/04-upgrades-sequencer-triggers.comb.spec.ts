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
        message: `Ожидание применения уровня прокачки Ур. ${level} через #sandbox-upgrade-level-select`,
      },
    )
    .toBe(level);

  return latest;
}

async function tryEditSequencerItemDelayInteractive(
  harness: ShatterpointHarness,
  itemIndex: number,
  targetDelaySec: number,
): Promise<boolean> {
  const listLoc = harness.page.locator(EXT_SELECTORS.c4SequencerList);
  const childRows = listLoc.locator(':scope > *');
  const rowCount = await childRows.count();
  if (rowCount <= itemIndex) {
    return false;
  }

  const row = childRows.nth(itemIndex);
  const nestedSelect = row.locator('select');
  if ((await nestedSelect.count()) > 0 && (await nestedSelect.first().isVisible())) {
    const chosenValue = await nestedSelect.first().evaluate(
      (el: Element, target: number): string | null => {
        if (!(el instanceof HTMLSelectElement) || el.options.length === 0) return null;
        let bestVal = el.options[0].value;
        let bestDiff = Infinity;
        for (const opt of Array.from(el.options)) {
          if (opt.disabled) continue;
          const match = `${opt.value} ${opt.textContent ?? ''}`.match(/(\d+(?:[.,]\d+)?)/);
          if (!match) continue;
          const num = Number(match[1].replace(',', '.'));
          if (!Number.isFinite(num)) continue;
          const diff = Math.abs(num - target);
          if (diff < bestDiff) {
            bestDiff = diff;
            bestVal = opt.value;
          }
        }
        return bestVal;
      },
      targetDelaySec,
    );
    if (chosenValue !== null) {
      await nestedSelect.first().selectOption({ value: chosenValue });
      await harness.waitForAnimationFrames(1);
      return true;
    }
  }

  const nestedInput = row.locator('input');
  if ((await nestedInput.count()) > 0 && (await nestedInput.first().isVisible())) {
    await nestedInput.first().fill(String(targetDelaySec));
    await nestedInput.first().press('Enter');
    await harness.waitForAnimationFrames(1);
    return true;
  }

  const nestedButtons = row.locator('button');
  const btnCount = await nestedButtons.count();
  for (let b = 0; b < btnCount; b++) {
    const btn = nestedButtons.nth(b);
    if (!(await btn.isVisible())) continue;
    const label = ((await btn.textContent()) ?? '').toLowerCase();
    if (label.includes('+') || label.includes('0.5') || label.includes('1.0') || label.includes('задерж')) {
      await btn.click();
      await harness.waitForAnimationFrames(1);
      return true;
    }
  }

  return false;
}

test.describe.configure({ timeout: 75_000 });

test.describe('Уровень 3 — Кросс-фичевые комбинации: прокачка Ур. 1 vs Ур. 5, разведка X-Ray, секвенсор C4 и объекты-триггеры', () => {
  test('[Tier3][R05][R11][F09][F18][F24] Сравнение боевой эффективности арсенала Ур. 1 vs Ур. 5 через #sandbox-upgrade-level-select на идентичной мишени', async ({
    harness,
  }) => {
    await harness.boot();
    await setAutoSlowmo(harness, false);

    // 1. Прогон на базовом уровне Ур. 1
    await harness.spawnSandboxStructure('fortress', { cleanResetFirst: true });
    const tLevel1 = await setSandboxUpgradeLevel(harness, 1);
    expect(tLevel1.toolLevels?.cannon).toBe(1);
    expect(tLevel1.toolLevels?.c4).toBe(1);

    const shot1 = await harness.aimAndStrikeStructure('cannon', {
      preferSide: 'center',
      heightFraction: 0.25,
      maxAttempts: 2,
      settleTicks: 35,
    });
    expect(shot1.usedPoint).not.toBeNull();
    const targetWorld = shot1.usedPoint!.world;
    const after1 = await readExtTelemetry(harness);

    // 2. Прогон на максимальном уровне Ур. 5 строго в ту же мировую точку
    await harness.spawnSandboxStructure('fortress', { cleanResetFirst: true });
    const tLevel5 = await setSandboxUpgradeLevel(harness, 5);
    expect(tLevel5.toolLevels?.cannon).toBe(5);
    expect(tLevel5.toolLevels?.c4).toBe(5);

    await harness.aimAndStrikeStructure('cannon', {
      worldPoint: targetWorld,
      maxAttempts: 1,
      settleTicks: 35,
    });
    const after5 = await readExtTelemetry(harness);

    const level5Superior =
      after5.destructionPct > after1.destructionPct + 0.05 ||
      after5.brokenJointCount > after1.brokenJointCount ||
      after5.activeShardCount + after5.bakedRubbleCount >
        after1.activeShardCount + after1.bakedRubbleCount ||
      (after5.collapsedMassTons ?? 0) > (after1.collapsedMassTons ?? 0) + 0.05;

    expect(level5Superior).toBe(true);

    // Проверяем безлимитный доступ к прокачанному C4 Ур. 5 в Песочнице без платных блокировок
    const planted5 = await harness.plantC4OnStructure({
      count: 1,
      delaySec: 0,
      preferSide: 'center',
      heightFraction: 0.18,
    });
    expect(planted5.totalPlanted).toBeGreaterThanOrEqual(1);

    const afterC4Lv5 = (await harness.detonateC4AndSettle(35)) as ExtTelemetry;
    expect(
      afterC4Lv5.brokenJointCount > after5.brokenJointCount ||
        afterC4Lv5.destructionPct > after5.destructionPct,
    ).toBe(true);
  });

  test('[Tier3][R08][R12][F05][F14][F18][F26] Разведка критических опор на рентгене (criticalNodesCount) и каскадный секвенсор C4 по долям секунды (#c4-sequencer-list: 0.00 с → +0.25 с → +0.50 с)', async ({
    harness,
  }) => {
    await harness.boot();
    await setAutoSlowmo(harness, false);

    await harness.spawnSandboxStructure('tower', { cleanResetFirst: true });
    await harness.setRenderViewMode('xray');

    const xrayTel = await readExtTelemetry(harness);
    expect(typeof xrayTel.criticalNodesCount).toBe('number');
    expect(xrayTel.criticalNodesCount!).toBeGreaterThan(0);

    const p1 = await harness.plantC4OnStructure({
      count: 1,
      delaySec: 0,
      preferSide: 'left',
      heightFraction: 0.16,
    });
    expect(p1.plantedNow).toBe(1);

    const p2 = await harness.plantC4OnStructure({
      count: 1,
      delaySec: 0.25,
      preferSide: 'center',
      heightFraction: 0.18,
    });
    expect(p2.plantedNow).toBe(1);

    const p3 = await harness.plantC4OnStructure({
      count: 1,
      delaySec: 0.5,
      preferSide: 'right',
      heightFraction: 0.16,
    });
    expect(p3.plantedNow).toBe(1);
    expect(p3.totalPlanted).toBe(3);

    const seqPanel = harness.page.locator(EXT_SELECTORS.c4SequencerPanel);
    const seqList = harness.page.locator(EXT_SELECTORS.c4SequencerList);
    await expect(seqPanel).toBeVisible();
    await expect(seqList).toHaveAttribute('data-queue-count', '3');

    const preBlast = await readExtTelemetry(harness);
    expect(Array.isArray(preBlast.c4SequenceQueue)).toBe(true);
    expect(preBlast.c4SequenceQueue!.length).toBe(3);

    const initialDelays = preBlast.c4SequenceQueue!.map((q) => q.delaySec);
    expect(Math.min(...initialDelays)).toBeCloseTo(0, 2);
    expect(Math.max(...initialDelays)).toBeGreaterThanOrEqual(0.2);

    // Если элемент очереди в #c4-sequencer-list имеет интерактивный контрол редактирования задержки — проверяем его
    const edited = await tryEditSequencerItemDelayInteractive(harness, 2, 0.5);
    if (edited) {
      const afterEdit = await readExtTelemetry(harness);
      expect(afterEdit.c4SequenceQueue?.length).toBe(3);
      const updatedMaxDelay = Math.max(...(afterEdit.c4SequenceQueue ?? []).map((q) => q.delaySec));
      expect(updatedMaxDelay).toBeGreaterThanOrEqual(0.25);
    }

    // Запуск секвенсора: замер №1 через 4 тика (~0.067 с, между 0.00 с и +0.25 с)
    await harness.page.locator(SELECTORS.detonateC4Btn).click();
    const early = (await harness.waitForSimTicks(4)) as ExtTelemetry;
    const earlyPlanted = await harness.getPlantedC4Count();

    const firstChargeDetonated =
      early.brokenJointCount > 0 || early.activeShardCount > 0 || early.kineticEnergyKJ > 0;
    const delayedChargesStillPending =
      earlyPlanted >= 1 || (early.c4SequenceQueue?.length ?? 0) >= 1;

    expect(firstChargeDetonated).toBe(true);
    expect(delayedChargesStillPending).toBe(true);

    // Замер №2 после полного завершения очереди секвенсора (~1.25 с модельного времени)
    const settled = (await harness.waitForSimTime(1.25)) as ExtTelemetry;
    expect(await harness.getPlantedC4Count()).toBe(0);
    await expect(seqList).toHaveAttribute('data-queue-count', '0');
    expect(settled.c4SequenceQueue?.length ?? 0).toBe(0);
    expect(typeof settled.collapsedMassTons).toBe('number');
    expect(settled.collapsedMassTons!).toBeGreaterThan(0);
    expect(
      settled.destructionPct > early.destructionPct ||
        settled.brokenJointCount > early.brokenJointCount,
    ).toBe(true);
  });

  test('[Tier3][R10][R12][F06][F08][F19][F26] Направленный завал сооружения в сторону от охраняемого объекта в Кампании с помощью разведки X-Ray и ступенчатой очереди секвенсора C4', async ({
    harness,
  }) => {
    await harness.boot({ clearStorage: true });
    await setAutoSlowmo(harness, false);

    let chosenContract: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 = 3;
    for (const candidate of [3, 2, 5, 6, 8, 1] as const) {
      await harness.selectContract(candidate);
      const tools = await harness.getAvailableTools();
      if (tools.includes('c4')) {
        chosenContract = candidate;
        break;
      }
    }

    await harness.selectContract(chosenContract);
    await harness.setRenderViewMode('xray');

    const startTel = await readExtTelemetry(harness);
    expect(typeof startTel.criticalNodesCount).toBe('number');
    expect(startTel.criticalNodesCount!).toBeGreaterThan(0);
    expect(startTel.collateralPct).toBe(0);
    expect(startTel.protectedDamagePct).toBe(0);

    const step1 = await harness.plantC4OnStructure({
      count: 1,
      delaySec: 0,
      preferSide: 'center',
      heightFraction: 0.14,
    });
    const step2 = await harness.plantC4OnStructure({
      count: 1,
      delaySec: 0.25,
      preferSide: 'center',
      heightFraction: 0.2,
    });
    expect(step1.plantedNow + step2.plantedNow).toBeGreaterThanOrEqual(2);

    const queueCount = await readFiniteDataAttr(
      harness,
      EXT_SELECTORS.c4SequencerList,
      'data-queue-count',
    );
    expect(queueCount).toBeGreaterThanOrEqual(2);

    await harness.page.locator(SELECTORS.detonateC4Btn).click();
    const after = (await harness.waitForSimTime(1.2)) as ExtTelemetry;
    const missionDom = await harness.readMissionDomState();

    expect(after.destructionPct).toBeGreaterThan(5);
    expect(typeof after.collapsedMassTons).toBe('number');
    expect(after.collapsedMassTons!).toBeGreaterThan(0);
    expect(missionDom.failReason).not.toBe('collateral');
    expect(missionDom.missionStatus).not.toBe('defeat');
  });

  test('[Tier3][R11][R12][F08][F24][F25][F26] Связка «Оружие Ур. 5 + триггер подвешенного многотонного противовеса + комбо тоннажа»', async ({
    harness,
  }) => {
    await harness.boot();
    await setAutoSlowmo(harness, false);

    await setSandboxUpgradeLevel(harness, 5);

    let initialTriggers = 0;
    const blueprints = ['tower', 'hangar', 'viaduct', 'fortress', 'warehouse', 'domino'] as const;

    for (const bp of blueprints) {
      const res = await harness.spawnSandboxStructure(bp, { cleanResetFirst: true });
      const t = res.after as ExtTelemetry;
      if ((t.activeTriggersCount ?? 0) > 0 && t.targetMaxHeightM > 4.5) {
        initialTriggers = t.activeTriggersCount!;
        break;
      }
    }

    if (initialTriggers === 0) {
      for (const idx of [5, 6, 8, 3, 2, 1, 4, 7] as const) {
        const t = (await harness.selectContract(idx)) as ExtTelemetry;
        if ((t.activeTriggersCount ?? 0) > 0 && t.targetMaxHeightM > 4.5) {
          initialTriggers = t.activeTriggersCount!;
          break;
        }
      }
    }

    expect(initialTriggers).toBeGreaterThan(0);

    const available = await harness.getAvailableTools();
    const strikeTool: 'cannon' | 'cutter' | 'bomb' = available.includes('cannon')
      ? 'cannon'
      : available.includes('cutter')
        ? 'cutter'
        : 'bomb';

    for (const hf of [0.78, 0.85, 0.68]) {
      await harness.aimAndStrikeStructure(strikeTool, {
        preferSide: 'center',
        heightFraction: hf,
        holdMs: strikeTool === 'cutter' ? 750 : 0,
        settleTicks: 18,
        maxAttempts: 2,
        searchFullPolygon: true,
      });
      const check = await readExtTelemetry(harness);
      if (
        check.secondaryImpactsCount > 0 ||
        (check.activeTriggersCount ?? initialTriggers) < initialTriggers
      ) {
        break;
      }
    }

    let finalTelemetry = await readExtTelemetry(harness);
    for (let i = 0; i < 8; i++) {
      finalTelemetry = (await harness.waitForSimTicks(8)) as ExtTelemetry;
    }

    const counterweightTriggered =
      finalTelemetry.secondaryImpactsCount > 0 ||
      (finalTelemetry.activeTriggersCount ?? initialTriggers) < initialTriggers;
    expect(counterweightTriggered).toBe(true);
    expect(finalTelemetry.brokenJointCount).toBeGreaterThan(0);
    expect(typeof finalTelemetry.collapsedMassTons).toBe('number');
    expect(finalTelemetry.collapsedMassTons!).toBeGreaterThan(0);

    const hudScore = await readFiniteDataAttr(
      harness,
      EXT_SELECTORS.hudDestructionScore,
      'data-value',
    );
    expect(hudScore).toBeGreaterThan(0);
  });

  test('[Tier3][R06][R10][R12][F09][F19][F25][F26] Активация интерактивных объектов-триггеров уровней (газовые резервуары/цистерны и секции домино) с фиксацией цепной детонации и #tactical-feed', async ({
    harness,
  }) => {
    await harness.boot({ clearStorage: true });
    await setAutoSlowmo(harness, false);

    const scenesWithTriggers: Array<
      | { kind: 'contract'; index: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 }
      | { kind: 'sandbox'; blueprint: 'warehouse' | 'domino' | 'hangar' | 'tower' }
    > = [];

    for (const idx of [1, 2, 3, 4, 5, 6, 7, 8] as const) {
      const t = (await harness.selectContract(idx)) as ExtTelemetry;
      if ((t.activeTriggersCount ?? 0) > 0) {
        scenesWithTriggers.push({ kind: 'contract', index: idx });
      }
    }

    for (const bp of ['warehouse', 'domino', 'hangar', 'tower'] as const) {
      const res = await harness.spawnSandboxStructure(bp, { cleanResetFirst: true });
      const t = res.after as ExtTelemetry;
      if ((t.activeTriggersCount ?? 0) > 0) {
        scenesWithTriggers.push({ kind: 'sandbox', blueprint: bp });
      }
    }

    expect(scenesWithTriggers.length).toBeGreaterThanOrEqual(2);

    const preferredSandbox = scenesWithTriggers.find((s) => s.kind === 'sandbox');
    const chosenScene = preferredSandbox ?? scenesWithTriggers[0];

    if (chosenScene.kind === 'sandbox') {
      await harness.spawnSandboxStructure(chosenScene.blueprint, { cleanResetFirst: true });
    } else {
      await harness.selectContract(chosenScene.index);
    }

    const before = await readExtTelemetry(harness);
    const beforeTriggers = before.activeTriggersCount ?? 0;
    expect(beforeTriggers).toBeGreaterThan(0);
    expect(before.detonatedExplosivesCount).toBe(0);

    const tools = await harness.getAvailableTools();
    if (tools.includes('bomb')) {
      await harness.aimAndStrikeStructure('bomb', {
        preferSide: 'any',
        heightFraction: 0.2,
        settleTicks: 30,
        maxAttempts: 2,
        searchFullPolygon: true,
      });
    } else if (tools.includes('cannon')) {
      await harness.aimAndStrikeStructure('cannon', {
        preferSide: 'any',
        heightFraction: 0.25,
        settleTicks: 30,
        maxAttempts: 3,
        searchFullPolygon: true,
      });
    } else if (tools.includes('incendiary')) {
      await harness.aimAndStrikeStructure('incendiary', {
        preferSide: 'any',
        heightFraction: 0.2,
        settleTicks: 35,
        maxAttempts: 3,
        searchFullPolygon: true,
      });
    } else if (tools.includes('c4')) {
      const planted = await harness.plantC4OnStructure({ count: 2, delaySec: 0 });
      if (planted.totalPlanted > 0) {
        await harness.detonateC4AndSettle(40);
      }
    }

    const after = (await harness.waitForSimTicks(45)) as ExtTelemetry;

    const triggerActivated =
      after.detonatedExplosivesCount > 0 ||
      (after.activeTriggersCount ?? beforeTriggers) < beforeTriggers ||
      after.secondaryImpactsCount > 0;

    expect(triggerActivated).toBe(true);
    expect(after.destructionPct).toBeGreaterThan(0);
    expect(typeof after.collapsedMassTons).toBe('number');
    expect(after.collapsedMassTons!).toBeGreaterThan(0);

    const feedEvent =
      (await harness.page.locator(EXT_SELECTORS.tacticalFeed).getAttribute('data-last-event')) ?? '';
    expect(feedEvent.trim().length).toBeGreaterThan(0);
    expect(/[А-Яа-яЁё]{3,}/.test(feedEvent)).toBe(true);
  });
});
