import {
  test,
  expect,
  SELECTORS,
} from '../helpers/shatterpoint-harness';
import type { E2ETelemetry, ToolUpgradeLevel } from '../helpers/shatterpoint-harness';

const TELEMETRY_NUMERIC_KEYS: ReadonlyArray<keyof E2ETelemetry> = [
  'tick',
  'simTimeSec',
  'intactBlockCount',
  'initialBlockCount',
  'intactJointCount',
  'initialJointCount',
  'brokenJointCount',
  'activeRebarCount',
  'snappedRebarCount',
  'plasticHingeCount',
  'activeShardCount',
  'bakedRubbleCount',
  'burningNodeCount',
  'maxTemperatureC',
  'maxStressUtilization',
  'kineticEnergyKJ',
  'secondaryImpactsCount',
  'detonatedExplosivesCount',
  'destructionPct',
  'targetMaxHeightM',
  'protectedDamagePct',
  'seismicFrequencyHz',
  'seismicAmplitudeM',
  'lastStepCpuMs',
  'collateralPct',
  'stars',
  'fps',
  'drawCalls',
  'walletCredits',
  'collapsedMassTons',
  'destructionScore',
  'comboMultiplier',
  'criticalNodesCount',
  'activeTriggersCount',
];

function assertFiniteNonNegativeTelemetry(telemetry: E2ETelemetry, label: string): void {
  for (const key of TELEMETRY_NUMERIC_KEYS) {
    const val = telemetry[key];
    expect(
      typeof val === 'number' && Number.isFinite(val) && val >= 0,
      `Поле телеметрии "${String(key)}" (${String(val)}) должно быть конечным неотрицательным числом (${label})`,
    ).toBe(true);
  }
}

test.describe('Уровень 2 — R05: Граничные и негативные сценарии взрывного и баллистического арсенала', () => {
  test('[R05-B01][F18] Нажатие #detonate-c4-btn при 0 заложенных зарядов (data-planted-c4="0"): безопасный холостой ход без взрыва и ошибок', async ({
    harness,
  }) => {
    await harness.boot();
    const { after: initial } = await harness.spawnSandboxStructure('tower', {
      cleanResetFirst: true,
    });

    await harness.selectTool('c4');
    await expect(harness.page.locator(SELECTORS.appRoot)).toHaveAttribute('data-planted-c4', '0');
    expect(await harness.getPlantedC4Count()).toBe(0);

    // Холостое нажатие детонатора при пустой очереди не должно вызывать взрывов или ошибок
    await harness.clickOrVerifyDisabled(SELECTORS.detonateC4Btn);
    await harness.clickOrVerifyDisabled(SELECTORS.detonateC4Btn);

    const afterIdle = await harness.waitForSimTicks(20);
    await expect(harness.page.locator(SELECTORS.appRoot)).toHaveAttribute('data-planted-c4', '0');
    expect(await harness.getPlantedC4Count()).toBe(0);
    expect(afterIdle.intactBlockCount).toBe(initial.initialBlockCount);
    expect(afterIdle.brokenJointCount).toBe(0);
    expect(afterIdle.destructionPct).toBe(0);
    expect(afterIdle.activeShardCount).toBe(0);
    expect(afterIdle.detonatedExplosivesCount).toBe(0);
  });

  test('[R05-B02][F18] Клик ЛКМ и ПКМ в открытое небо (clickSkyMiss) с активным #tool-c4: заряд не ставится в воздух и не снимается со здания при промахе', async ({
    harness,
  }) => {
    await harness.boot();
    await harness.spawnSandboxStructure('tower', { cleanResetFirst: true });

    await harness.selectTool('c4');

    // Промах ЛКМ в пустое небо не должен подвешивать заряд в воздухе
    await harness.clickSkyMiss({ button: 'left' });
    await harness.clickSkyMiss({ button: 'left' });
    await harness.waitForAnimationFrames(2);

    expect(await harness.getPlantedC4Count()).toBe(0);
    await expect(harness.page.locator(SELECTORS.appRoot)).toHaveAttribute('data-planted-c4', '0');
    expect((await harness.getTelemetry()).c4SequenceQueue.length).toBe(0);

    // Закладываем 1 брикет C4 на конструкцию башни
    const planted = await harness.plantC4OnStructure({
      count: 1,
      delaySec: 0,
      preferSide: 'center',
      heightFraction: 0.2,
    });
    expect(planted.totalPlanted).toBe(1);
    expect(await harness.getPlantedC4Count()).toBe(1);

    // Промах ПКМ в далёкое небо не должен снимать установленный на здании брикет
    await harness.clickSkyMiss({ button: 'right' });
    await harness.clickSkyMiss({ button: 'right' });
    await harness.waitForAnimationFrames(2);

    expect(await harness.getPlantedC4Count()).toBe(1);
    await expect(harness.page.locator(SELECTORS.appRoot)).toHaveAttribute('data-planted-c4', '1');
    expect((await harness.getTelemetry()).c4SequenceQueue.length).toBe(1);
    expect((await harness.getTelemetry()).brokenJointCount).toBe(0);
  });

  test('[R05-B03][F09][F18] Стрельба кинетической пушкой (#tool-cannon) и сброс фугаса (#tool-bomb) в пустое небо без разрушения цели и без NaN в телеметрии', async ({
    harness,
  }) => {
    await harness.boot();
    const { after: initial } = await harness.spawnSandboxStructure('tower', {
      cleanResetFirst: true,
    });
    const blocks0 = initial.initialBlockCount;

    // 1. Выстрел кинетической пушки мимо здания в небо
    await harness.selectTool('cannon');
    await harness.clickSkyMiss({ button: 'left' });
    const afterCannon = await harness.waitForSimTicks(20);

    expect(afterCannon.intactBlockCount).toBe(blocks0);
    expect(afterCannon.brokenJointCount).toBe(0);
    expect(afterCannon.destructionPct).toBe(0);
    assertFiniteNonNegativeTelemetry(afterCannon, 'после выстрела #tool-cannon в небо');

    // 2. Клик фугасной авиабомбой мимо здания в небо
    await harness.selectTool('bomb');
    await harness.clickSkyMiss({ button: 'left' });
    const afterBomb = await harness.waitForSimTicks(20);

    expect(afterBomb.intactBlockCount).toBe(blocks0);
    expect(afterBomb.brokenJointCount).toBe(0);
    expect(afterBomb.destructionPct).toBe(0);
    assertFiniteNonNegativeTelemetry(afterBomb, 'после клика #tool-bomb в небо');
  });

  test('[R05-B04][F09] Затухание ударной волны с расстоянием по закону Садовского (сравнение урона мишени вблизи и вдали от эпицентра)', async ({
    harness,
  }) => {
    await harness.boot();
    await harness.switchMode('sandbox');
    await harness.setAutoSlowmo(false);

    const runBlastDistanceTrial = async (
      isNear: boolean,
      level: ToolUpgradeLevel,
    ): Promise<{ blocksLost: number; shardsTotal: number; destructionScore: number }> => {
      await harness.resetScene();
      await harness.zoomCameraWheel(240);
      await harness.setSandboxUpgradeLevel(level);

      // Хрупкая стеклянная мишень справа на радиусе ~7.9 м от центра сцены
      const glass1 = await harness.placeSandboxBuildBlock('glass', [
        [7.5, 0.7, 2.4],
        [7.5, 0.7, 0],
        [7.0, 0.7, 2.0],
      ]);
      expect(glass1.placed).toBe(true);
      const glassWorld = glass1.hit?.world ?? [7.5, 0.7, 2.4];

      await harness.placeSandboxBuildBlock('glass', [
        [glassWorld[0] + 0.75, glassWorld[1], glassWorld[2]],
        [glassWorld[0], glassWorld[1] + 0.85, glassWorld[2]],
      ]);

      // Опорный стальной блок для заряда C4:
      // - Вдали: диаметрально противоположная сторона (~15.7 м от стекла, тот же радиус от центра)
      // - Вблизи: в ~1.35 м от стеклянной мишени (почти тот же радиус от центра)
      const chargeMountCandidates: Array<[number, number, number]> = isNear
        ? [
            [glassWorld[0] - 1.35, glassWorld[1], glassWorld[2]],
            [glassWorld[0], glassWorld[1], glassWorld[2] - 1.35],
            [glassWorld[0] - 1.5, 0.7, 0],
          ]
        : [
            [-7.5, 0.7, -2.4],
            [-8.5, 0.7, 0],
            [-7.5, 0.7, 2.4],
          ];

      const mount = await harness.placeSandboxBuildBlock('steel', chargeMountCandidates);
      expect(mount.placed).toBe(true);
      await harness.exitSandboxBuildMode();

      const mw = mount.hit?.world ?? chargeMountCandidates[0];
      const beforeBlast = await harness.waitForSimTicks(8);

      const c4Candidates: Array<[number, number, number]> = [
        mw,
        [mw[0], mw[1] + 0.35, mw[2]],
        [mw[0], mw[1] + 0.7, mw[2]],
        [mw[0] + 0.25, mw[1] + 0.35, mw[2]],
        [mw[0] - 0.25, mw[1] + 0.35, mw[2]],
      ];

      const planted = await harness.plantC4OnStructure({
        count: 1,
        delaySec: 0,
        customWorldCandidates: c4Candidates,
      });

      let afterBlast: E2ETelemetry;
      if (planted.totalPlanted > 0) {
        afterBlast = await harness.detonateC4AndSettle(35);
      } else {
        const bombStrike = await harness.aimAndStrikeStructure('bomb', {
          worldPoint: mw,
          maxAttempts: 1,
          settleTicks: 35,
        });
        afterBlast = bombStrike.after;
      }

      return {
        blocksLost: Math.max(0, beforeBlast.intactBlockCount - afterBlast.intactBlockCount),
        shardsTotal: afterBlast.activeShardCount + afterBlast.bakedRubbleCount,
        destructionScore: afterBlast.destructionScore,
      };
    };

    let farRes = await runBlastDistanceTrial(false, 1);
    let nearRes = await runBlastDistanceTrial(true, 1);

    // Если на Ур. 1 импульс слишком мал даже на 1.35 м, проверяем на Ур. 2 при абсолютно равных условиях
    if (nearRes.blocksLost === 0 && nearRes.shardsTotal === 0) {
      farRes = await runBlastDistanceTrial(false, 2);
      nearRes = await runBlastDistanceTrial(true, 2);
    }

    expect(
      nearRes.blocksLost > farRes.blocksLost ||
        nearRes.shardsTotal > farRes.shardsTotal ||
        nearRes.destructionScore > farRes.destructionScore,
      `По закону Садовского урон мишени вблизи эпицентра (lost=${nearRes.blocksLost}, shards=${nearRes.shardsTotal}) обязан превышать урон вдали (lost=${farRes.blocksLost}, shards=${farRes.shardsTotal})`,
    ).toBe(true);
  });

  test('[R05-B05][F09] Экранирование ударной волны взрыва (raycast-окклюзия) массивной стальной/ЖБ преградой перед хрупкой стеклянной мишенью', async ({
    harness,
  }) => {
    await harness.boot();
    await harness.switchMode('sandbox');
    await harness.setAutoSlowmo(false);

    const runOcclusionTrial = async (
      withSteelShield: boolean,
    ): Promise<{
      blocksLost: number;
      shardsTotal: number;
      destructionPct: number;
      destructionScore: number;
    }> => {
      await harness.resetScene();
      await harness.zoomCameraWheel(240);
      await harness.setSandboxUpgradeLevel(2);

      // 1. Размещаем кластер хрупких стеклянных мишеней на внешней линии x ≈ 7.8..8.5
      const gMain = await harness.placeSandboxBuildBlock('glass', [
        [7.8, 0.7, 0],
        [8.0, 0.7, 0.6],
      ]);
      expect(gMain.placed).toBe(true);
      await harness.placeSandboxBuildBlock('glass', [
        [7.8, 0.7, 0.85],
        [8.4, 0.7, 0],
      ]);
      await harness.placeSandboxBuildBlock('glass', [
        [7.8, 0.7, -0.85],
        [7.8, 1.55, 0],
      ]);

      // 2. В экранированном замере возводим плотную стальную преграду между зарядом (x=5.0) и стеклом (x=7.8)
      if (withSteelShield) {
        const wallSpots: Array<Array<[number, number, number]>> = [
          [[6.4, 0.7, 0], [6.3, 0.7, 0]],
          [[6.4, 1.65, 0], [6.3, 1.65, 0]],
          [[6.4, 0.7, 0.95], [6.3, 0.7, 0.95]],
          [[6.4, 0.7, -0.95], [6.3, 0.7, -0.95]],
          [[6.4, 1.65, 0.95], [6.3, 1.65, 0.95]],
          [[6.4, 1.65, -0.95], [6.3, 1.65, -0.95]],
        ];
        for (const candidateSet of wallSpots) {
          await harness.placeSandboxBuildBlock('steel', candidateSet);
        }
      }

      // 3. Опорный стальной блок под заряд C4 с внешней стороны в точке x = 5.0
      const mount = await harness.placeSandboxBuildBlock('steel', [
        [5.0, 0.7, 0],
        [4.8, 0.7, 0],
      ]);
      expect(mount.placed).toBe(true);
      await harness.exitSandboxBuildMode();

      const mw = mount.hit?.world ?? [5.0, 0.7, 0];
      const beforeBlast = await harness.waitForSimTicks(8);

      const planted = await harness.plantC4OnStructure({
        count: 1,
        delaySec: 0,
        customWorldCandidates: [
          mw,
          [mw[0], mw[1] + 0.35, mw[2]],
          [mw[0], mw[1] + 0.7, mw[2]],
          [mw[0] - 0.25, mw[1] + 0.35, mw[2]],
        ],
      });

      let afterBlast: E2ETelemetry;
      if (planted.totalPlanted > 0) {
        afterBlast = await harness.detonateC4AndSettle(35);
      } else {
        const bombStrike = await harness.aimAndStrikeStructure('bomb', {
          worldPoint: mw,
          maxAttempts: 1,
          settleTicks: 35,
        });
        afterBlast = bombStrike.after;
      }

      return {
        blocksLost: Math.max(0, beforeBlast.intactBlockCount - afterBlast.intactBlockCount),
        shardsTotal: afterBlast.activeShardCount + afterBlast.bakedRubbleCount,
        destructionPct: afterBlast.destructionPct,
        destructionScore: afterBlast.destructionScore,
      };
    };

    const unshielded = await runOcclusionTrial(false);
    const shielded = await runOcclusionTrial(true);

    // Без экрана хрупкое стекло на открытой линии 2.8 м должно получить ощутимый урон
    expect(unshielded.blocksLost > 0 || unshielded.shardsTotal > 0).toBe(true);

    // За массивной стальной стеной урон защищённой мишени обязан снизиться за счёт raycast-окклюзии
    expect(
      shielded.blocksLost < unshielded.blocksLost ||
        shielded.destructionPct < unshielded.destructionPct ||
        shielded.shardsTotal < unshielded.shardsTotal ||
        shielded.destructionScore < unshielded.destructionScore,
      `Стальной экран обязан снижать урон за преградой (без щита: lost=${unshielded.blocksLost}, shards=${unshielded.shardsTotal}, pct=${unshielded.destructionPct.toFixed(1)}%; со щитом: lost=${shielded.blocksLost}, shards=${shielded.shardsTotal}, pct=${shielded.destructionPct.toFixed(1)}%)`,
    ).toBe(true);
  });

  test('[R05-B06][F18] Полное разминирование всех заложенных зарядов C4 правой кнопкой мыши до 0 с последующей проверкой детонатора', async ({
    harness,
  }) => {
    await harness.boot();
    const { after: initial } = await harness.spawnSandboxStructure('tower', {
      cleanResetFirst: true,
    });

    const leftCharge = await harness.plantC4OnStructure({
      count: 1,
      delaySec: 0,
      preferSide: 'left',
      heightFraction: 0.18,
    });
    expect(leftCharge.plantedNow).toBe(1);

    const rightCharge = await harness.plantC4OnStructure({
      count: 1,
      delaySec: 0.25,
      preferSide: 'right',
      heightFraction: 0.18,
    });
    expect(rightCharge.totalPlanted).toBe(2);
    expect((await harness.getTelemetry()).c4SequenceQueue.length).toBe(2);

    // Поочерёдно снимаем оба заряда правой кнопкой мыши
    const removedRight = await harness.removeC4AtHit(rightCharge.hits[0]);
    expect(removedRight).toBe(true);
    expect(await harness.getPlantedC4Count()).toBe(1);

    const removedLeft = await harness.removeC4AtHit(leftCharge.hits[0]);
    expect(removedLeft).toBe(true);
    expect(await harness.getPlantedC4Count()).toBe(0);
    await expect(harness.page.locator(SELECTORS.appRoot)).toHaveAttribute('data-planted-c4', '0');
    expect((await harness.getTelemetry()).c4SequenceQueue.length).toBe(0);

    // Нажатие детонатора после полного разминирования не должно вызывать фантомного подрыва
    await harness.clickOrVerifyDisabled(SELECTORS.detonateC4Btn);
    const afterDetonate = await harness.waitForSimTicks(25);

    expect(afterDetonate.intactBlockCount).toBe(initial.initialBlockCount);
    expect(afterDetonate.brokenJointCount).toBe(0);
    expect(afterDetonate.destructionPct).toBe(0);
    expect(afterDetonate.activeShardCount).toBe(0);
  });
});

test.describe('Уровень 2 — R06: Граничные и негативные сценарии термического и сейсмического арсенала', () => {
  test('[R06-B01][F18] Непрерывный луч плазморезака (#tool-cutter) по пустому небу: 0 повреждённых связей и стабильная работа рекаста', async ({
    harness,
  }) => {
    await harness.boot();
    const { after: initial } = await harness.spawnSandboxStructure('tower', {
      cleanResetFirst: true,
    });

    await harness.selectTool('cutter');
    const skyPt = await harness.clickSkyMiss({ button: 'left' });

    // Удерживаем активный луч плазморезака в пустом небе 20 тиков с горизонтальным покачиванием ±4 px
    await harness.page.mouse.move(skyPt.x, skyPt.y);
    await harness.page.mouse.down({ button: 'left' });
    for (const dx of [-4, 0, 4, 0, -4]) {
      await harness.page.mouse.move(skyPt.x + dx, skyPt.y);
      await harness.waitForSimTicks(4);
    }
    await harness.page.mouse.up({ button: 'left' });

    const afterCutSky = await harness.waitForSimTicks(10);
    expect(afterCutSky.intactBlockCount).toBe(initial.initialBlockCount);
    expect(afterCutSky.brokenJointCount).toBe(0);
    expect(afterCutSky.snappedRebarCount).toBe(0);
    expect(afterCutSky.destructionPct).toBe(0);
    assertFiniteNonNegativeTelemetry(afterCutSky, 'после луча плазморезака в пустое небо');
  });

  test('[R06-B02][F03][F10] Негорючесть железобетона и кирпича под термитной кассетой (#tool-incendiary) в отличие от горючего дерева', async ({
    harness,
  }) => {
    await harness.boot();
    await harness.setAutoSlowmo(false);

    // 1. Железобетонная башня: локальный нагрев без возгорания блоков
    await harness.spawnSandboxStructure('tower', { cleanResetFirst: true });
    const concreteHit = await harness.aimAndStrikeStructure('incendiary', {
      preferSide: 'center',
      heightFraction: 0.22,
      maxAttempts: 2,
      settleTicks: 30,
    });
    expect(concreteHit.after.burningNodeCount).toBe(0);

    // 2. Кирпичная крепость: негорючая каменная кладка не переходит в режим пожара
    await harness.spawnSandboxStructure('fortress', { cleanResetFirst: true });
    const brickHit = await harness.aimAndStrikeStructure('incendiary', {
      preferSide: 'center',
      heightFraction: 0.22,
      maxAttempts: 2,
      settleTicks: 30,
    });
    expect(brickHit.after.burningNodeCount).toBe(0);

    // 3. Деревянный склад: идентичный удар термитной кассетой вызывает устойчивое горение при T >= 260 °C
    await harness.spawnSandboxStructure('warehouse', { cleanResetFirst: true });
    const woodHit = await harness.aimAndStrikeStructure('incendiary', {
      requireBurning: true,
      settleTicks: 25,
    });
    expect(woodHit.after.burningNodeCount).toBeGreaterThanOrEqual(1);
    expect(woodHit.after.maxTemperatureC).toBeGreaterThanOrEqual(260);
  });

  test('[R06-B03][F10][F18] Промах термитной кассетой (#tool-incendiary) в открытое небо над деревянным складом: отсутствие ложного поджога', async ({
    harness,
  }) => {
    await harness.boot();
    const { after: initial } = await harness.spawnSandboxStructure('warehouse', {
      cleanResetFirst: true,
    });

    await harness.selectTool('incendiary');
    await harness.clickSkyMiss({ button: 'left' });
    await harness.clickSkyMiss({ button: 'left' });

    const afterSkyMiss = await harness.waitForSimTicks(25);
    expect(afterSkyMiss.burningNodeCount).toBe(0);
    expect(afterSkyMiss.destructionPct).toBe(0);
    expect(afterSkyMiss.intactBlockCount).toBe(initial.initialBlockCount);
  });

  test('[R06-B04][F11][F18] Остановка активного землетрясения кнопкой #scene-reset-btn и автоматическое завершение сейсмоимпульса по истечении длительности', async ({
    harness,
  }) => {
    await harness.boot();
    await harness.spawnSandboxStructure('fortress', { cleanResetFirst: true });

    // 1. Запускаем землетрясение и мгновенно прерываем его сбросом сцены #scene-reset-btn
    const activeQuake = await harness.activateSeismicTool({
      freqHz: 2.5,
      ampM: 0.6,
      settleTicks: 8,
    });
    expect(activeQuake.seismicActive).toBe(true);

    const afterReset = await harness.resetScene();
    expect(afterReset.seismicActive).toBe(false);
    expect(afterReset.brokenJointCount).toBe(0);

    const confirmStopped = await harness.waitForSimTicks(10);
    expect(confirmStopped.seismicActive).toBe(false);

    // 2. Запускаем новый сейсмоимпульс и проверяем его штатное авто-завершение по истечении длительности
    const secondQuake = await harness.activateSeismicTool({
      freqHz: 2.5,
      ampM: 0.4,
      settleTicks: 6,
    });
    expect(secondQuake.seismicActive).toBe(true);

    await harness.setTimeScale(2.0);
    await expect
      .poll(
        async () => {
          const cur = await harness.waitForSimTicks(30);
          return cur.seismicActive;
        },
        {
          timeout: 25_000,
          message: 'Ожидание автоматического завершения сейсмоимпульса по истечении длительности',
        },
      )
      .toBe(false);

    await harness.setTimeScale(1.0);
  });

  test('[R06-B05][F11][F21] Сейсмостойкость конструкции при минимальной амплитуде колебаний (#slider-quake-amp = min) на сейсмоплатформе', async ({
    harness,
  }) => {
    await harness.boot();
    await harness.selectLabBench('seismic');

    const ampMeta = await harness.getSliderMeta('quakeAmp');
    expect(ampMeta.min).toBeGreaterThan(0);
    expect(ampMeta.min).toBeLessThanOrEqual(0.1);

    const afterMicroTremor = await harness.triggerLabEarthquake({
      freqHz: 1.0,
      ampM: ampMeta.min,
      settleTicks: 45,
    });

    expect(afterMicroTremor.seismicAmplitudeM).toBeCloseTo(ampMeta.min, 2);
    expect(afterMicroTremor.seismicFrequencyHz).toBeCloseTo(1.0, 1);
    expect(afterMicroTremor.destructionPct).toBeLessThan(15);
    expect(afterMicroTremor.intactBlockCount).toBeGreaterThan(0);
  });

  test('[R06-B06][F10][F12] Полное тушение активного пожара и возврат температуры к ~20 °C при нажатии #scene-reset-btn', async ({
    harness,
  }) => {
    await harness.boot();
    await harness.spawnSandboxStructure('warehouse', { cleanResetFirst: true });

    const ignited = await harness.aimAndStrikeStructure('incendiary', {
      requireBurning: true,
      settleTicks: 25,
    });
    expect(ignited.after.burningNodeCount).toBeGreaterThanOrEqual(1);
    expect(ignited.after.maxTemperatureC).toBeGreaterThanOrEqual(260);

    const afterReset = await harness.resetScene();
    await harness.waitForSimTicks(4);
    const settledAfterReset = await harness.getTelemetry();
    const domVals = await harness.readTelemetryDomValues();

    expect(afterReset.burningNodeCount).toBe(0);
    expect(settledAfterReset.burningNodeCount).toBe(0);
    expect(settledAfterReset.maxTemperatureC).toBeGreaterThanOrEqual(0);
    expect(settledAfterReset.maxTemperatureC).toBeLessThanOrEqual(35);
    expect(domVals.burningNodes).toBe(0);
    expect(domVals.maxTempC).toBeLessThanOrEqual(35);
  });
});
