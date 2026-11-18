import {
  test,
  expect,
  SELECTORS,
  MATERIAL_BUTTON_MAP,
  type StructuralMaterialId,
} from '../helpers/shatterpoint-harness';

test.describe('Уровень 2 — R03: Граничные и негативные сценарии Песочницы, губернатора осколков и устойчивости сооружений', () => {
  test('[R03-B01][F05][F20] Выстрелы мимо здания в открытое небо (clickSkyMiss): полное сохранение целостности монолита на GroundAnchor', async ({
    harness,
  }) => {
    await harness.boot();
    await harness.spawnSandboxStructure('tower', { cleanResetFirst: true });

    const before = await harness.waitForSimTicks(10);
    expect(before.brokenJointCount).toBe(0);
    expect(before.intactBlockCount).toBe(before.initialBlockCount);

    await harness.selectTool('cannon');
    for (let shot = 0; shot < 3; shot++) {
      await harness.clickSkyMiss({ button: 'left' });
    }

    const after = await harness.waitForSimTicks(25);
    expect(after.intactBlockCount).toBe(after.initialBlockCount);
    expect(after.brokenJointCount).toBe(0);
    expect(after.activeShardCount).toBe(0);
    expect(after.bakedRubbleCount).toBe(0);
    expect(after.destructionPct).toBe(0);
    expect(after.collapsedMassTons).toBe(0);
  });

  test('[R03-B02][F12][F20] Губернатор бюджета кадров при интенсивном мульти-спавне и ковровой бомбардировке: квота активных осколков и запекание руин', async ({
    harness,
  }) => {
    await harness.boot();

    const { after: firstSpawn } = await harness.spawnSandboxStructure('tower', {
      cleanResetFirst: true,
    });
    await harness.spawnSandboxStructure('fortress', { cleanResetFirst: false });
    const { after: multiSpawn } = await harness.spawnSandboxStructure('warehouse', {
      cleanResetFirst: false,
    });
    expect(multiSpawn.initialBlockCount).toBeGreaterThan(firstSpawn.initialBlockCount);

    let peakKineticEnergyKJ = 0;
    let peakActiveShards = 0;

    const strikeSides: ReadonlyArray<'left' | 'center' | 'right'> = ['left', 'center', 'right'];
    for (const side of strikeSides) {
      const strike = await harness.aimAndStrikeStructure('bomb', {
        preferSide: side,
        heightFraction: 0.16,
        settleTicks: 8,
        maxAttempts: 2,
        searchFullPolygon: true,
      });
      peakKineticEnergyKJ = Math.max(peakKineticEnergyKJ, strike.after.kineticEnergyKJ);
      peakActiveShards = Math.max(peakActiveShards, strike.after.activeShardCount);
    }

    // Продвигаем симуляцию на 160 тиков (4 фазы по 40 тиков), контролируя квоту осколков на всём протяжении
    let settled = await harness.getTelemetry();
    for (let phase = 0; phase < 4; phase++) {
      settled = await harness.waitForSimTicks(40, 20_000);
      peakKineticEnergyKJ = Math.max(peakKineticEnergyKJ, settled.kineticEnergyKJ);
      peakActiveShards = Math.max(peakActiveShards, settled.activeShardCount);
    }

    expect(settled.activeShardCount + settled.bakedRubbleCount).toBeGreaterThan(0);
    expect(peakActiveShards).toBeLessThanOrEqual(600);
    expect(settled.activeShardCount).toBeLessThanOrEqual(600);
    expect(
      settled.bakedRubbleCount > 0 || settled.kineticEnergyKJ < peakKineticEnergyKJ,
    ).toBe(true);
    expect(settled.lastStepCpuMs).toBeLessThan(150);
  });

  test('[R03-B03][F05][F06][F17] Длительная статическая устойчивость пролётной арки «Виадук» и «Кирпичной крепости» без самопроизвольного распада (120 тиков)', async ({
    harness,
  }) => {
    await harness.boot();

    // 1. Пролётная арка «Виадук» на дистанции 120 тиков (2.0 модельные секунды)
    const { after: viaductStart } = await harness.spawnSandboxStructure('viaduct', {
      cleanResetFirst: true,
    });
    const viaductHeight0 = viaductStart.targetMaxHeightM;
    expect(viaductStart.initialBlockCount).toBeGreaterThan(0);

    const viaductAfter = await harness.waitForSimTicks(120, 20_000);
    expect(viaductAfter.intactBlockCount).toBe(viaductAfter.initialBlockCount);
    expect(viaductAfter.brokenJointCount).toBe(0);
    expect(viaductAfter.activeShardCount).toBe(0);
    expect(viaductAfter.destructionPct).toBe(0);
    expect(Math.abs(viaductAfter.targetMaxHeightM - viaductHeight0)).toBeLessThan(0.08);

    // 2. «Кирпичная крепость» на дистанции 120 тиков
    const { after: fortressStart } = await harness.spawnSandboxStructure('fortress', {
      cleanResetFirst: true,
    });
    const fortressHeight0 = fortressStart.targetMaxHeightM;
    expect(fortressStart.initialBlockCount).toBeGreaterThan(0);

    const fortressAfter = await harness.waitForSimTicks(120, 20_000);
    expect(fortressAfter.intactBlockCount).toBe(fortressAfter.initialBlockCount);
    expect(fortressAfter.brokenJointCount).toBe(0);
    expect(fortressAfter.activeShardCount).toBe(0);
    expect(fortressAfter.destructionPct).toBe(0);
    expect(Math.abs(fortressAfter.targetMaxHeightM - fortressHeight0)).toBeLessThan(0.08);
  });

  test('[R03-B04][F05][F06] Точечный удар слабым снарядом по верхнему парапету башни без ложного обрушения нижних несущих этажей', async ({
    harness,
  }) => {
    await harness.boot();
    const { after: tower0 } = await harness.spawnSandboxStructure('tower', {
      cleanResetFirst: true,
    });
    const h0 = tower0.targetMaxHeightM;
    expect(h0).toBeGreaterThan(4.5);

    await harness.setSandboxUpgradeLevel(1);

    const parapetY = Number((h0 * 0.88).toFixed(2));
    const strike = await harness.aimAndStrikeStructure('cannon', {
      worldPoint: [0, parapetY, 0],
      preferSide: 'center',
      heightFraction: 0.92,
      maxAttempts: 2,
      settleTicks: 20,
    });
    expect(strike.attempts).toBeGreaterThanOrEqual(1);

    const after = await harness.waitForSimTicks(50);

    // Нижние несущие этажи сохраняют устойчивость и не складываются от локального удара по верхушке
    expect(after.destructionPct).toBeLessThan(45);
    expect(after.intactBlockCount).toBeGreaterThanOrEqual(
      Math.floor(after.initialBlockCount * 0.55),
    );
    expect(after.targetMaxHeightM).toBeGreaterThan(h0 * 0.5);
  });

  test('[R03-B05][F17][F20] Полная очистка дополнительных построек при #scene-reset-btn после мульти-спавна 3 зданий подряд', async ({
    harness,
  }) => {
    await harness.boot();

    const { selectedOption: towerOpt, after: towerOnly } = await harness.spawnSandboxStructure(
      'tower',
      { cleanResetFirst: true },
    );
    const bTower = towerOnly.initialBlockCount;
    expect(bTower).toBeGreaterThan(0);

    await harness.spawnSandboxStructure('viaduct', { cleanResetFirst: false });
    const { after: multi } = await harness.spawnSandboxStructure('hangar', {
      cleanResetFirst: false,
    });
    expect(multi.initialBlockCount).toBeGreaterThan(Math.floor(bTower * 1.5));

    await harness.page
      .locator(SELECTORS.sandboxSpawnSelect)
      .selectOption({ value: towerOpt.value });
    const afterReset = await harness.resetScene();

    expect(afterReset.initialBlockCount).toBe(bTower);
    expect(afterReset.intactBlockCount).toBe(bTower);
    expect(afterReset.brokenJointCount).toBe(0);
    expect(afterReset.activeShardCount).toBe(0);
    expect(afterReset.bakedRubbleCount).toBe(0);
    expect(afterReset.destructionPct).toBe(0);
  });

  test('[R03-B06][F02][F04] Математическая валидность всех числовых полей телеметрии (отсутствие NaN, Infinity и отрицательных значений) после тотального сноса', async ({
    harness,
  }) => {
    await harness.boot();
    await harness.spawnSandboxStructure('tower', { cleanResetFirst: true });
    await harness.setSandboxUpgradeLevel(5);

    const planted = await harness.plantC4OnStructure({
      count: 4,
      delaySec: 0,
      heightFraction: 0.14,
    });
    if (planted.totalPlanted > 0) {
      await harness.detonateC4AndSettle(25);
    }

    for (let i = 0; i < 2; i++) {
      await harness.aimAndStrikeStructure('bomb', {
        heightFraction: 0.14,
        settleTicks: 20,
        maxAttempts: 2,
        searchFullPolygon: true,
      });
    }

    let telemetry = await harness.waitForSimTicks(60);
    if (telemetry.destructionPct <= 30) {
      await harness.aimAndStrikeStructure('bomb', {
        heightFraction: 0.12,
        settleTicks: 35,
        maxAttempts: 3,
        searchFullPolygon: true,
      });
      telemetry = await harness.getTelemetry();
    }

    expect(telemetry.destructionPct).toBeGreaterThan(30);

    const entries = Object.entries(telemetry as unknown as Record<string, unknown>);
    let checkedNumericCount = 0;

    for (const [key, value] of entries) {
      if (typeof value === 'number') {
        checkedNumericCount += 1;
        expect(
          Number.isFinite(value),
          `Поле getTelemetry().${key} равно невалидному числу: ${String(value)}`,
        ).toBe(true);
        expect(
          value,
          `Числовое поле getTelemetry().${key} не должно быть отрицательным: ${String(value)}`,
        ).toBeGreaterThanOrEqual(0);
      }
    }

    expect(checkedNumericCount).toBeGreaterThanOrEqual(25);
    expect(telemetry.destructionPct).toBeGreaterThanOrEqual(0);
    expect(telemetry.destructionPct).toBeLessThanOrEqual(100);
    expect(telemetry.protectedDamagePct).toBeGreaterThanOrEqual(0);
    expect(telemetry.protectedDamagePct).toBeLessThanOrEqual(100);
    expect(telemetry.collateralPct).toBeGreaterThanOrEqual(0);
    expect(telemetry.collateralPct).toBeLessThanOrEqual(100);

    await harness.setSandboxUpgradeLevel(1);
  });
});

test.describe('Уровень 2 — R04: Граничные и негативные сценарии конструктора достройки и физики материалов', () => {
  test('[R04-B01][F17][F20] Включение и выключение конструктора (#sandbox-build-toggle) с перебором всех 6 материалов без клика по сцене (0 лишних блоков)', async ({
    harness,
  }) => {
    await harness.boot();
    await harness.switchMode('sandbox');
    const t0 = await harness.resetScene();
    const blocks0 = t0.initialBlockCount;
    expect(blocks0).toBeGreaterThan(0);

    const toggleBtn = harness.page.locator(SELECTORS.sandboxBuildToggle);
    await expect(toggleBtn).toBeVisible();

    if (!(await harness.isSandboxBuildModeActive())) {
      await toggleBtn.click();
      await harness.waitForAnimationFrames(1);
      if (!(await harness.page.locator(MATERIAL_BUTTON_MAP.reinforced_concrete).isVisible())) {
        await toggleBtn.click();
        await harness.waitForAnimationFrames(1);
      }
    }

    const allMaterials: readonly StructuralMaterialId[] = [
      'reinforced_concrete',
      'glass',
      'wood',
      'steel',
      'brick',
      'explosive',
    ];

    for (const mat of allMaterials) {
      const matBtn = harness.page.locator(MATERIAL_BUTTON_MAP[mat]);
      await expect(matBtn).toBeVisible();
      await matBtn.click();
      await harness.waitForAnimationFrames(1);
    }

    await harness.exitSandboxBuildMode();
    if (await harness.isSandboxBuildModeActive()) {
      await toggleBtn.click();
      await harness.waitForAnimationFrames(1);
    }

    const after = await harness.waitForSimTicks(8);
    expect(after.initialBlockCount).toBe(blocks0);
    expect(after.intactBlockCount).toBe(blocks0);
    expect(after.brokenJointCount).toBe(0);
    expect(await harness.isSandboxBuildModeActive()).toBe(false);
  });

  test('[R04-B02][F17][F20] Попытка поставить строительный блок кликом в открытое небо (clickSkyMiss): отказ размещения блока в пустоте', async ({
    harness,
  }) => {
    await harness.boot();
    await harness.switchMode('sandbox');
    await harness.resetScene();

    // Укладываем 1 проверочный блок на землю, гарантируя активное состояние конструктора достройки
    const probePlacement = await harness.placeSandboxBuildBlock('brick');
    expect(probePlacement.placed).toBe(true);
    expect(await harness.isSandboxBuildModeActive()).toBe(true);

    await harness.page.locator(SELECTORS.matBrick).click();
    await harness.waitForAnimationFrames(1);
    const blocksBeforeSky = (await harness.getTelemetry()).initialBlockCount;

    for (let i = 0; i < 3; i++) {
      await harness.clickSkyMiss({ button: 'left' });
    }

    const after = await harness.waitForSimTicks(10);
    expect(after.initialBlockCount).toBe(blocksBeforeSky);
    expect(after.intactBlockCount).toBe(blocksBeforeSky);

    await harness.exitSandboxBuildMode();
    expect(await harness.isSandboxBuildModeActive()).toBe(false);
  });

  test('[R04-B03][F17][F18] Переключение из активного конструктора достройки на боевой инструмент (#tool-cannon) прекращает укладку строительных блоков', async ({
    harness,
  }) => {
    await harness.boot();
    await harness.switchMode('sandbox');
    await harness.resetScene();

    const placedWood = await harness.placeSandboxBuildBlock('wood', [
      [6.5, 0.6, 0],
      [-6.5, 0.6, 0],
      [0, 0.6, 6.5],
    ]);
    expect(placedWood.placed).toBe(true);
    expect(await harness.isSandboxBuildModeActive()).toBe(true);
    const blocksAfterPlace = placedWood.afterBlocks;

    // Напрямую выбираем боевое орудие без ручного нажатия #sandbox-build-toggle
    await harness.selectTool('cannon');
    await expect(harness.page.locator(SELECTORS.appRoot)).toHaveAttribute(
      'data-active-tool',
      'cannon',
    );
    expect(await harness.isSandboxBuildModeActive()).toBe(false);

    const freeGroundSpots = await harness.projectWorldPointsToClickableScreen(
      [
        [7.5, 0.6, 3.5],
        [-7.5, 0.6, 3.5],
        [0, 0.6, -7.5],
      ],
      12,
    );
    expect(freeGroundSpots.length).toBeGreaterThan(0);

    await harness.page.mouse.click(freeGroundSpots[0].screen.x, freeGroundSpots[0].screen.y, {
      button: 'left',
    });
    const afterShot = await harness.waitForSimTicks(15);

    expect(afterShot.initialBlockCount).toBe(blocksAfterPlace);
  });

  test('[R04-B04][F03][F04][F07] Порог прочности конструкционной стали (#mat-steel) против хрупкого стекла (#mat-glass) при слабом ударе Ур. 1', async ({
    harness,
  }) => {
    await harness.boot();
    await harness.switchMode('sandbox');
    await harness.setSandboxUpgradeLevel(1);

    const candidateSpots: Array<[number, number, number]> = [
      [7.0, 0.7, 0],
      [-7.0, 0.7, 0],
      [0, 0.7, 7.0],
    ];

    // 1. Испытание образца хрупкого стекла (#mat-glass) одиночным выстрелом пушки Ур. 1
    await harness.resetScene();
    await harness.setSandboxUpgradeLevel(1);
    const glassPlacement = await harness.placeSandboxBuildBlock('glass', candidateSpots);
    expect(glassPlacement.placed).toBe(true);
    expect(glassPlacement.hit).not.toBeNull();
    const spotWorld = glassPlacement.hit!.world;
    await harness.exitSandboxBuildMode();

    const beforeGlass = await harness.getTelemetry();
    const glassShards0 = beforeGlass.activeShardCount + beforeGlass.bakedRubbleCount;

    await harness.selectTool('cannon');
    let aimWorld: [number, number, number] = [...spotWorld];
    expect(await harness.clickWorldPoint(...aimWorld)).not.toBeNull();
    let afterGlass = await harness.waitForSimTicks(25);

    let glassBlocksLost = Math.max(0, beforeGlass.intactBlockCount - afterGlass.intactBlockCount);
    let glassShardsDelta = Math.max(
      0,
      afterGlass.activeShardCount + afterGlass.bakedRubbleCount - glassShards0,
    );

    // Если первый луч прошёл по касательной над гранью блока, корректируем прицельную высоту и перепроверяем оба образца строго по ней
    if (glassBlocksLost === 0 && glassShardsDelta === 0) {
      await harness.resetScene();
      await harness.setSandboxUpgradeLevel(1);
      const retryGlass = await harness.placeSandboxBuildBlock('glass', [spotWorld]);
      expect(retryGlass.placed).toBe(true);
      await harness.exitSandboxBuildMode();

      const retryBefore = await harness.getTelemetry();
      const retryShards0 = retryBefore.activeShardCount + retryBefore.bakedRubbleCount;
      aimWorld = [spotWorld[0], Math.max(0.45, spotWorld[1] - 0.15), spotWorld[2]];

      await harness.selectTool('cannon');
      expect(await harness.clickWorldPoint(...aimWorld)).not.toBeNull();
      afterGlass = await harness.waitForSimTicks(25);

      glassBlocksLost = Math.max(0, retryBefore.intactBlockCount - afterGlass.intactBlockCount);
      glassShardsDelta = Math.max(
        0,
        afterGlass.activeShardCount + afterGlass.bakedRubbleCount - retryShards0,
      );
    }

    expect(glassBlocksLost > 0 || glassShardsDelta > 0).toBe(true);

    // 2. Идентичное испытание образца конструкционной стали (#mat-steel) ровно в той же координате и тем же 1 выстрелом Ур. 1
    await harness.resetScene();
    await harness.setSandboxUpgradeLevel(1);
    const steelPlacement = await harness.placeSandboxBuildBlock('steel', [
      spotWorld,
      ...candidateSpots,
    ]);
    expect(steelPlacement.placed).toBe(true);
    expect(steelPlacement.hit).not.toBeNull();
    await harness.exitSandboxBuildMode();

    const beforeSteel = await harness.getTelemetry();
    const steelShards0 = beforeSteel.activeShardCount + beforeSteel.bakedRubbleCount;

    await harness.selectTool('cannon');
    const steelTargetWorld: [number, number, number] =
      Math.hypot(
        steelPlacement.hit!.world[0] - spotWorld[0],
        steelPlacement.hit!.world[2] - spotWorld[2],
      ) < 0.2
        ? aimWorld
        : steelPlacement.hit!.world;
    expect(await harness.clickWorldPoint(...steelTargetWorld)).not.toBeNull();
    const afterSteel = await harness.waitForSimTicks(25);

    const steelBlocksLost = Math.max(0, beforeSteel.intactBlockCount - afterSteel.intactBlockCount);
    const steelShardsDelta = Math.max(
      0,
      afterSteel.activeShardCount + afterSteel.bakedRubbleCount - steelShards0,
    );

    expect(
      steelBlocksLost < glassBlocksLost || steelShardsDelta < glassShardsDelta,
    ).toBe(true);
  });

  test('[R04-B05][F03][F09] Отсутствие ложной цепной детонации двух взрывоопасных бочек (#mat-explosive), разнесённых на противоположные края полигона (> 16 м)', async ({
    harness,
  }) => {
    await harness.boot();
    await harness.switchMode('sandbox');
    await harness.resetScene();
    await harness.setSandboxUpgradeLevel(1);

    const leftBarrel = await harness.placeSandboxBuildBlock('explosive', [
      [-8.5, 0.6, 5.5],
      [-8.5, 0.6, 3.5],
      [-9.0, 0.6, 0],
    ]);
    expect(leftBarrel.placed).toBe(true);
    expect(leftBarrel.hit).not.toBeNull();

    const rightBarrel = await harness.placeSandboxBuildBlock('explosive', [
      [8.5, 0.6, -5.5],
      [8.5, 0.6, -3.5],
      [9.0, 0.6, 0],
      [8.5, 0.6, 4.5],
    ]);
    expect(rightBarrel.placed).toBe(true);
    expect(rightBarrel.hit).not.toBeNull();

    const wL = leftBarrel.hit!.world;
    const wR = rightBarrel.hit!.world;
    const separationDistM = Math.hypot(wR[0] - wL[0], wR[1] - wL[1], wR[2] - wL[2]);
    expect(separationDistM).toBeGreaterThan(16);

    await harness.exitSandboxBuildMode();
    const beforeShot = await harness.getTelemetry();
    expect(beforeShot.detonatedExplosivesCount).toBe(0);

    await harness.selectTool('cannon');
    const freshLeft = await harness.projectWorldPointsToClickableScreen([wL], 0);
    const targetScreen = freshLeft[0]?.screen ?? leftBarrel.hit!.screen;
    await harness.page.mouse.click(targetScreen.x, targetScreen.y, { button: 'left' });

    let afterFirstShot = await harness.waitForSimTicks(15);
    if (afterFirstShot.detonatedExplosivesCount === 0) {
      const correctionTargets: Array<[number, number, number]> = [
        [wL[0], wL[1] + 0.2, wL[2]],
        [wL[0], Math.max(0.25, wL[1] - 0.12), wL[2]],
      ];
      for (const corrWorld of correctionTargets) {
        await harness.clickWorldPoint(corrWorld[0], corrWorld[1], corrWorld[2], {
          button: 'left',
        });
        afterFirstShot = await harness.waitForSimTicks(15);
        if (afterFirstShot.detonatedExplosivesCount >= 1) {
          break;
        }
      }
    }

    if (afterFirstShot.detonatedExplosivesCount === 0) {
      await expect
        .poll(
          async () => {
            await harness.waitForSimTicks(5);
            return (await harness.getTelemetry()).detonatedExplosivesCount;
          },
          {
            timeout: 6_000,
            message: 'Ожидание детонации первой (левой) взрывоопасной бочки от попадания пушки',
          },
        )
        .toBeGreaterThanOrEqual(1);
    }

    expect((await harness.getTelemetry()).detonatedExplosivesCount).toBeGreaterThanOrEqual(1);

    // Ждём ещё 35 тиков: ударная волна обязана затухнуть на дистанции > 16 м, оставив вторую бочку целой
    const afterSettle = await harness.waitForSimTicks(35);
    expect(afterSettle.detonatedExplosivesCount).toBe(1);
  });
});
