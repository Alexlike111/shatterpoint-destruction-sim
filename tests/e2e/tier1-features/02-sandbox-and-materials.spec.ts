import {
  test,
  expect,
  SELECTORS,
  MATERIAL_BUTTON_MAP,
} from '../helpers/shatterpoint-harness';
import type { StructuralMaterialId } from '../helpers/shatterpoint-harness';

test.describe('Уровень 1 — R03: Свободная Песочница — каталог 6 сооружений и структурное равновесие', () => {
  test('[R03][F05][F06] Покоящийся монолит на фундаменте GroundAnchor: статическое равновесие ЖБ-башни без саморазрушения', async ({
    harness,
  }) => {
    await harness.boot();
    const { after: spawned } = await harness.spawnSandboxStructure('tower', {
      cleanResetFirst: true,
    });

    const h0 = spawned.targetMaxHeightM;
    expect(spawned.initialBlockCount).toBeGreaterThanOrEqual(8);
    expect(spawned.initialJointCount).toBeGreaterThanOrEqual(8);
    expect(h0).toBeGreaterThan(4.5);

    const afterRest = await harness.waitForSimTicks(90);

    expect(afterRest.intactBlockCount).toBe(afterRest.initialBlockCount);
    expect(afterRest.brokenJointCount).toBe(0);
    expect(afterRest.activeShardCount).toBe(0);
    expect(afterRest.destructionPct).toBe(0);
    expect(Math.abs(afterRest.targetMaxHeightM - h0)).toBeLessThan(0.08);
    expect(afterRest.maxStressUtilization).toBeGreaterThan(0);
    expect(afterRest.maxStressUtilization).toBeLessThan(1.0);
  });

  test('[R03][F17][F20] Спавн сооружений «Арочный виадук» и «Кирпичная крепость» из каталога Песочницы', async ({
    harness,
  }) => {
    await harness.boot();
    const blueprints = await harness.listSandboxBlueprints();
    expect(blueprints.length).toBeGreaterThanOrEqual(6);

    await harness.spawnSandboxStructure('viaduct', { cleanResetFirst: true });
    const viaductRest = await harness.waitForSimTicks(30);
    expect(viaductRest.initialBlockCount).toBeGreaterThanOrEqual(6);
    expect(viaductRest.intactJointCount).toBeGreaterThanOrEqual(5);
    expect(viaductRest.targetMaxHeightM).toBeGreaterThan(2.5);
    expect(viaductRest.brokenJointCount).toBe(0);
    expect(viaductRest.destructionPct).toBe(0);

    await harness.spawnSandboxStructure('fortress', { cleanResetFirst: true });
    const fortressRest = await harness.waitForSimTicks(30);
    expect(fortressRest.initialBlockCount).toBeGreaterThanOrEqual(6);
    expect(fortressRest.intactJointCount).toBeGreaterThanOrEqual(5);
    expect(fortressRest.targetMaxHeightM).toBeGreaterThan(2.5);
    expect(fortressRest.brokenJointCount).toBe(0);
    expect(fortressRest.destructionPct).toBe(0);
  });

  test('[R03][F17][F20] Спавн сооружений «Промышленный ангар», «Деревянный склад» и «Каскад домино» (покрытие всех 6 чертежей и цепного падения домино)', async ({
    harness,
  }) => {
    await harness.boot();
    const blueprints = await harness.listSandboxBlueprints();
    expect(blueprints.length).toBeGreaterThanOrEqual(6);

    // Проверяем спавн ангара и деревянного склада
    for (const key of ['hangar', 'warehouse'] as const) {
      await harness.spawnSandboxStructure(key, { cleanResetFirst: true });
      const t = await harness.waitForSimTicks(25);
      expect(t.initialBlockCount).toBeGreaterThan(0);
      expect(t.brokenJointCount).toBe(0);
      expect(t.destructionPct).toBe(0);
    }

    // Обходим все 6 индексов каталога 0..5 и проверяем геометрическое разнообразие чертежей
    const uniqueBlueprintSignatures = new Set<string>();
    for (let idx = 0; idx < 6; idx++) {
      await harness.spawnSandboxStructure(idx, { cleanResetFirst: true });
      const t = await harness.waitForSimTicks(15);
      expect(t.initialBlockCount).toBeGreaterThan(0);
      expect(t.brokenJointCount).toBe(0);
      uniqueBlueprintSignatures.add(
        `${t.initialBlockCount}:${t.initialJointCount}:${t.targetMaxHeightM.toFixed(1)}`,
      );
    }
    expect(uniqueBlueprintSignatures.size).toBeGreaterThanOrEqual(4);

    // Финально спавним «Каскад домино» и запускаем цепную реакцию выстрелом пушки по крайней плите
    await harness.spawnSandboxStructure('domino', { cleanResetFirst: true });
    const dominoBefore = await harness.waitForSimTicks(20);
    expect(dominoBefore.brokenJointCount).toBe(0);

    const firstPush = await harness.aimAndStrikeStructure('cannon', {
      preferSide: 'left',
      heightFraction: 0.65,
      settleTicks: 35,
      searchFullPolygon: true,
    });

    if (
      firstPush.after.brokenJointCount < 2 &&
      firstPush.after.destructionPct <= 8 &&
      firstPush.after.targetMaxHeightM >= dominoBefore.targetMaxHeightM - 0.25
    ) {
      await harness.aimAndStrikeStructure('cannon', {
        preferSide: 'right',
        heightFraction: 0.65,
        settleTicks: 35,
        searchFullPolygon: true,
      });
    }

    await expect
      .poll(
        async () => {
          const cur = await harness.waitForSimTicks(12);
          const heightDropped = cur.targetMaxHeightM < dominoBefore.targetMaxHeightM - 0.25;
          return cur.brokenJointCount >= 2 || cur.destructionPct > 8 || heightDropped;
        },
        { timeout: 10_000, message: 'Ожидание реального цепного опрокидывания плит домино' },
      )
      .toBe(true);
  });

  test('[R03][F20] Свободный мульти-спавн нескольких зданий рядом на полигоне Песочницы через #sandbox-spawn-btn', async ({
    harness,
  }) => {
    await harness.boot();

    const { after: t1 } = await harness.spawnSandboxStructure('tower', { cleanResetFirst: true });
    const b1 = t1.initialBlockCount;
    expect(b1).toBeGreaterThan(0);

    // Размещаем второе здание рядом без сброса сцены
    await harness.spawnSandboxStructure('viaduct', { cleanResetFirst: false });
    const t2 = await harness.getTelemetry();
    const b2 = t2.initialBlockCount;
    expect(b2).toBeGreaterThan(b1);

    // Выбираем третий чертёж и размещаем третье здание на том же полигоне
    await harness.spawnSandboxStructure('fortress', { cleanResetFirst: false });
    const t3 = await harness.waitForSimTicks(30);
    const b3 = t3.initialBlockCount;
    expect(b3).toBeGreaterThan(b2);
    expect(t3.brokenJointCount).toBe(0);
  });

  test('[R03][F05][F06] Выбивание несущих колонн первого этажа: отрыв островов BFS и гравитационное каскадное обрушение этажей', async ({
    harness,
  }) => {
    await harness.boot();
    await harness.spawnSandboxStructure('tower', { cleanResetFirst: true });

    const before = await harness.getTelemetry();
    const h0 = before.targetMaxHeightM;
    const joints0 = before.initialJointCount;
    expect(h0).toBeGreaterThan(4.5);

    const planted = await harness.plantC4OnStructure({
      count: 4,
      delaySec: 0,
      heightFraction: 0.12,
    });
    expect(planted.totalPlanted).toBeGreaterThanOrEqual(1);

    await harness.detonateC4AndSettle(60);

    // Если часть колонн первого этажа устояла после первой серии C4, подрезаем основание фугасом
    const midCheck = await harness.getTelemetry();
    if (midCheck.targetMaxHeightM >= h0 * 0.65) {
      await harness.aimAndStrikeStructure('bomb', {
        heightFraction: 0.1,
        settleTicks: 75,
      });
    }

    await expect
      .poll(
        async () => {
          const cur = await harness.getTelemetry();
          return (
            cur.targetMaxHeightM < h0 * 0.65 &&
            cur.brokenJointCount >= Math.min(8, Math.floor(joints0 * 0.25)) &&
            cur.destructionPct > 25
          );
        },
        { timeout: 10_000, message: 'Ожидание гравитационного каскадного обрушения верхних этажей' },
      )
      .toBe(true);
  });

  test('[R03][F04][F12] 3D Voronoi-дробление блоков при взрыве и стабилизация осколков губернатором бюджета', async ({
    harness,
  }) => {
    await harness.boot();
    await harness.spawnSandboxStructure('fortress', { cleanResetFirst: true });

    let sawActiveShards = false;
    let sawKineticEnergy = false;

    const strike = await harness.aimAndStrikeStructure('bomb', {
      heightFraction: 0.18,
      settleTicks: 6,
    });
    if (strike.after.activeShardCount > 0) sawActiveShards = true;
    if (strike.after.kineticEnergyKJ > 0) sawKineticEnergy = true;

    await expect
      .poll(
        async () => {
          const t = await harness.getTelemetry();
          if (t.activeShardCount > 0) sawActiveShards = true;
          if (t.kineticEnergyKJ > 0) sawKineticEnergy = true;
          return sawActiveShards && sawKineticEnergy;
        },
        { timeout: 6_000, message: 'Ожидание образования 3D-осколков Вороного при взрыве' },
      )
      .toBe(true);

    const settled = await harness.waitForSimTicks(150);
    expect(settled.activeShardCount + settled.bakedRubbleCount).toBeGreaterThan(0);
    expect(settled.lastStepCpuMs).toBeLessThan(150);
  });
});

test.describe('Уровень 1 — R04: Конструктор достройки и глубоко различная физика 5 материалов + взрывчатки', () => {
  test('[R04][F17][F20] Конструктор достройки (#sandbox-build-toggle): поочерёдная постановка блоков всех 6 материалов на сцену', async ({
    harness,
  }) => {
    await harness.boot();
    await harness.switchMode('sandbox');
    await harness.resetScene();

    const buildToggle = harness.page.locator(SELECTORS.sandboxBuildToggle);
    await expect(buildToggle).toBeVisible();

    const materials: StructuralMaterialId[] = [
      'reinforced_concrete',
      'glass',
      'wood',
      'steel',
      'brick',
      'explosive',
    ];

    const spotSets: Array<Array<[number, number, number]>> = [
      [[6.5, 0.6, 0], [7.5, 0.6, 2.0], [0, 0.8, 6.5]],
      [[-6.5, 0.6, 0], [-7.5, 0.6, 2.0], [0, 0.8, -6.5]],
      [[6.5, 0.6, 4.5], [8.5, 0.6, 0], [4.5, 0.6, 6.5]],
      [[-6.5, 0.6, 4.5], [-8.5, 0.6, 0], [-4.5, 0.6, 6.5]],
      [[6.5, 0.6, -4.5], [8.5, 0.6, -3.0], [4.5, 0.6, -6.5]],
      [[-6.5, 0.6, -4.5], [-8.5, 0.6, -3.0], [-4.5, 0.6, -6.5]],
    ];

    const startBlocks = (await harness.getTelemetry()).initialBlockCount;

    // Укладываем первый блок через драйвер (он штатно активирует #sandbox-build-toggle)
    const firstRes = await harness.placeSandboxBuildBlock(materials[0], spotSets[0]);
    expect(firstRes.placed).toBe(true);
    expect(firstRes.afterBlocks).toBeGreaterThan(firstRes.beforeBlocks);
    expect(await harness.isSandboxBuildModeActive()).toBe(true);

    // В активном режиме конструктора все 6 кнопок материалов обязаны быть видимы
    for (const mat of materials) {
      await expect(harness.page.locator(MATERIAL_BUTTON_MAP[mat])).toBeVisible();
    }

    // Поочерёдно укладываем оставшиеся 5 материалов без самовыключения конструктора
    for (let i = 1; i < materials.length; i++) {
      const res = await harness.placeSandboxBuildBlock(materials[i], spotSets[i]);
      expect(res.placed).toBe(true);
      expect(res.afterBlocks).toBeGreaterThan(res.beforeBlocks);
    }

    const endBlocks = (await harness.getTelemetry()).initialBlockCount;
    expect(endBlocks).toBeGreaterThanOrEqual(startBlocks + 6);

    await harness.exitSandboxBuildMode();
    expect(await harness.isSandboxBuildModeActive()).toBe(false);
  });

  test('[R04][F03][F07] Физика железобетона (#mat-reinforced_concrete): удержание глыб стальными тяжами арматуры (activeRebarCount / snappedRebarCount)', async ({
    harness,
  }) => {
    await harness.boot();
    await harness.spawnSandboxStructure('tower', { cleanResetFirst: true });

    // Дополнительно проверяем укладку блока железобетона через конструктор #mat-reinforced_concrete
    await harness.placeSandboxBuildBlock('reinforced_concrete', [
      [2.0, 0.8, 2.0],
      [-2.0, 0.8, 2.0],
      [6.5, 0.6, 0],
    ]);
    await harness.exitSandboxBuildMode();

    // Включаем замедление Bullet-Time для надёжного перехвата фазы упруго-пластического натяжения арматуры
    await harness.toggleBulletTime();

    const planted = await harness.plantC4OnStructure({
      count: 2,
      delaySec: 0,
      heightFraction: 0.22,
    });
    expect(planted.totalPlanted).toBeGreaterThanOrEqual(1);

    await harness.page.locator(SELECTORS.detonateC4Btn).click();

    let maxActiveRebar = 0;
    let maxSnappedRebar = 0;

    await expect
      .poll(
        async () => {
          await harness.waitForSimTicks(4);
          const t = await harness.getTelemetry();
          if (t.activeRebarCount > maxActiveRebar) maxActiveRebar = t.activeRebarCount;
          if (t.snappedRebarCount > maxSnappedRebar) maxSnappedRebar = t.snappedRebarCount;
          return maxActiveRebar > 0 || maxSnappedRebar > 0;
        },
        {
          timeout: 10_000,
          message: 'Ожидание активации или разрыва стальных тяжей арматуры ЖБ (RebarTether)',
        },
      )
      .toBe(true);
  });

  test('[R04][F03][F04] Контраст хрупкого стекла (#mat-glass) и кирпичной кладки (#mat-brick) при ударно-волновом воздействии', async ({
    harness,
  }) => {
    await harness.boot();
    await harness.switchMode('sandbox');

    const spotA: Array<[number, number, number]> = [
      [7.0, 0.7, 0],
      [-7.0, 0.7, 0],
      [0, 0.7, 7.0],
    ];
    const spotB: Array<[number, number, number]> = [
      [7.0, 0.7, 3.0],
      [-7.0, 0.7, 3.0],
      [3.0, 0.7, 7.0],
    ];

    // 1. Испытание пары образцов хрупкого калёного стекла (#mat-glass): удар пушки + термошок
    await harness.resetScene();
    const glass1 = await harness.placeSandboxBuildBlock('glass', spotA);
    expect(glass1.placed).toBe(true);
    expect(glass1.hit).not.toBeNull();
    const glass2 = await harness.placeSandboxBuildBlock('glass', spotB);
    expect(glass2.placed).toBe(true);
    expect(glass2.hit).not.toBeNull();
    await harness.exitSandboxBuildMode();

    const beforeGlass = await harness.getTelemetry();
    const glassShards0 = beforeGlass.activeShardCount + beforeGlass.bakedRubbleCount;

    await harness.selectTool('cannon');
    expect(await harness.clickWorldPoint(...glass1.hit!.world)).not.toBeNull();

    await expect
      .poll(
        async () => {
          const t = await harness.getTelemetry();
          return (
            t.activeShardCount > beforeGlass.activeShardCount ||
            t.intactBlockCount < beforeGlass.intactBlockCount
          );
        },
        { timeout: 6_000, message: 'Ожидание мгновенного раскола стеклянного блока #mat-glass' },
      )
      .toBe(true);

    await harness.selectTool('incendiary');
    expect(await harness.clickWorldPoint(...glass2.hit!.world)).not.toBeNull();
    const afterGlass = await harness.waitForSimTicks(30);

    const glassBlocksLost = Math.max(0, beforeGlass.intactBlockCount - afterGlass.intactBlockCount);
    const glassShardsDelta = Math.max(
      0,
      afterGlass.activeShardCount + afterGlass.bakedRubbleCount - glassShards0,
    );
    const glassFragilityScore = glassBlocksLost * 100 + glassShardsDelta;

    // 2. Идентичное испытание пары образцов кирпичной кладки (#mat-brick) в тех же координатах
    await harness.resetScene();
    const brick1 = await harness.placeSandboxBuildBlock('brick', [glass1.hit!.world, ...spotA]);
    expect(brick1.placed).toBe(true);
    expect(brick1.hit).not.toBeNull();
    const brick2 = await harness.placeSandboxBuildBlock('brick', [glass2.hit!.world, ...spotB]);
    expect(brick2.placed).toBe(true);
    expect(brick2.hit).not.toBeNull();
    await harness.exitSandboxBuildMode();

    const beforeBrick = await harness.getTelemetry();
    const brickShards0 = beforeBrick.activeShardCount + beforeBrick.bakedRubbleCount;

    // Огнеупорный кирпич выдерживает термический импульс без термошокового разрушения
    await harness.selectTool('incendiary');
    expect(await harness.clickWorldPoint(...brick2.hit!.world)).not.toBeNull();
    const brickAfterThermal = await harness.waitForSimTicks(20);
    const brickLostByThermal = Math.max(
      0,
      beforeBrick.intactBlockCount - brickAfterThermal.intactBlockCount,
    );
    expect(brickLostByThermal).toBe(0);

    await harness.selectTool('cannon');
    expect(await harness.clickWorldPoint(...brick1.hit!.world)).not.toBeNull();
    const afterBrick = await harness.waitForSimTicks(30);

    const brickBlocksLost = Math.max(0, beforeBrick.intactBlockCount - afterBrick.intactBlockCount);
    const brickShardsDelta = Math.max(
      0,
      afterBrick.activeShardCount + afterBrick.bakedRubbleCount - brickShards0,
    );
    const brickFragilityScore = brickBlocksLost * 100 + brickShardsDelta;

    // Сравнительный физический инвариант: стекло разрушается сильнее / лучистее кирпича при равных воздействиях
    expect(glassFragilityScore).toBeGreaterThan(brickFragilityScore);

    // 3. Проверка раскола швов массивной кирпичной крепости (fortress)
    await harness.spawnSandboxStructure('fortress', { cleanResetFirst: true });
    const brickStrike = await harness.aimAndStrikeStructure('cannon', {
      heightFraction: 0.25,
      settleTicks: 25,
      searchFullPolygon: true,
    });
    expect(
      brickStrike.after.brokenJointCount > 0 || brickStrike.after.activeShardCount > 0,
    ).toBe(true);
  });

  test('[R04][F03][F07] Физика конструкционной стали (#mat-steel): формирование пластических шарниров изгиба (plasticHingeCount > 0)', async ({
    harness,
  }) => {
    await harness.boot();
    await harness.spawnSandboxStructure('hangar', { cleanResetFirst: true });

    await harness.placeSandboxBuildBlock('steel', [
      [6.5, 0.7, 0],
      [-6.5, 0.7, 0],
    ]);
    await harness.exitSandboxBuildMode();

    // Нагружаем стальные фермы/колонны термомеханическим и ударным воздействием до пластической текучести
    await harness.aimAndStrikeStructure('incendiary', {
      heightFraction: 0.35,
      settleTicks: 30,
      searchFullPolygon: true,
    });

    const hingeAttempt = await harness.aimAndStrikeStructure('cannon', {
      heightFraction: 0.35,
      settleTicks: 25,
      requirePlasticHinge: true,
      searchFullPolygon: true,
    });

    if (hingeAttempt.after.plasticHingeCount === 0) {
      const c4 = await harness.plantC4OnStructure({
        count: 2,
        delaySec: 0,
        heightFraction: 0.3,
      });
      if (c4.totalPlanted > 0) {
        await harness.detonateC4AndSettle(45);
      }
    }

    await expect
      .poll(async () => (await harness.getTelemetry()).plasticHingeCount, {
        timeout: 8_000,
        message: 'Ожидание формирования пластических шарниров стали (plasticHingeCount > 0)',
      })
      .toBeGreaterThan(0);
  });

  test('[R04][F03][F10] Физика дубового массива (#mat-wood): воспламенение при T >= 260 °C, передача огня и выгорание', async ({
    harness,
  }) => {
    await harness.boot();
    await harness.spawnSandboxStructure('warehouse', { cleanResetFirst: true });

    // Достраиваем смежные деревянные блоки #mat-wood
    await harness.placeSandboxBuildBlock('wood', [
      [6.0, 0.6, 0],
      [-6.0, 0.6, 0],
    ]);
    await harness.placeSandboxBuildBlock('wood', [
      [6.0, 1.6, 0],
      [6.8, 0.6, 0],
    ]);
    await harness.exitSandboxBuildMode();

    await harness.aimAndStrikeStructure('incendiary', {
      heightFraction: 0.16,
      settleTicks: 25,
      requireBurning: true,
      searchFullPolygon: true,
    });

    let maxBurningNodes = 0;
    await expect
      .poll(
        async () => {
          await harness.waitForSimTicks(15);
          const t = await harness.getTelemetry();
          if (t.burningNodeCount > maxBurningNodes) {
            maxBurningNodes = t.burningNodeCount;
          }
          return (
            t.maxTemperatureC >= 260 &&
            t.burningNodeCount >= 1 &&
            (maxBurningNodes >= 2 || t.brokenJointCount > 0)
          );
        },
        {
          timeout: 10_000,
          message: 'Ожидание воспламенения дерева (T >= 260 °C) и распространения пожара',
        },
      )
      .toBe(true);
  });

  test('[R04][F03][F09] Цепная детонация кластера взрывоопасных бочек (#mat-explosive) от одиночного попадания пушки', async ({
    harness,
  }) => {
    await harness.boot();
    await harness.switchMode('sandbox');
    await harness.resetScene();

    // Размещаем кластер из 3 взрывоопасных бочек рядом друг с другом (на расстоянии ~1.3 м)
    const barrel1 = await harness.placeSandboxBuildBlock('explosive', [
      [7.0, 0.6, 0],
      [-7.0, 0.6, 0],
    ]);
    expect(barrel1.placed).toBe(true);
    expect(barrel1.hit).not.toBeNull();

    const base = barrel1.hit!.world;
    const barrel2 = await harness.placeSandboxBuildBlock('explosive', [
      [base[0] + 1.3, base[1], base[2]],
      [base[0] - 1.3, base[1], base[2]],
      [base[0], base[1], base[2] + 1.3],
    ]);
    expect(barrel2.placed).toBe(true);

    const barrel3 = await harness.placeSandboxBuildBlock('explosive', [
      [base[0], base[1], base[2] - 1.3],
      [base[0] + 1.3, base[1], base[2] + 1.3],
      [base[0] - 1.3, base[1], base[2] - 1.3],
    ]);
    expect(barrel3.placed).toBe(true);

    await harness.exitSandboxBuildMode();

    // Делаем ровно ОДИН прицельный выстрел из кинетической пушки в первую бочку кластера
    await harness.selectTool('cannon');
    const freshScreen = await harness.projectWorldPointsToClickableScreen([barrel1.hit!.world], 0);
    const targetScreen = freshScreen[0]?.screen ?? barrel1.hit!.screen;
    await harness.page.mouse.click(targetScreen.x, targetScreen.y, { button: 'left' });

    await expect
      .poll(
        async () => {
          await harness.waitForSimTicks(10);
          return (await harness.getTelemetry()).detonatedExplosivesCount;
        },
        {
          timeout: 8_000,
          message: 'Ожидание каскадной цепной детонации >= 2 взрывоопасных бочек от 1 выстрела',
        },
      )
      .toBeGreaterThanOrEqual(2);
  });
});
