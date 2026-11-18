import {
  test,
  expect,
  SELECTORS,
  TOOL_BUTTON_MAP,
  STAR_THRESHOLD_SELECTORS,
  areByteArraysDifferent,
} from '../helpers/shatterpoint-harness';
import type { ToolId } from '../helpers/shatterpoint-harness';

test.describe('Уровень 1 — R11: Экономическая прогрессия, Магазин, Мастерская улучшений Ур. 1→5 и Game Feel', () => {
  test('[R11][F24] Начисление кредитов (#wallet-credits) и синхронизация с getTelemetry().walletCredits за победное выполнение контракта Кампании', async ({
    harness,
  }) => {
    await harness.boot({ clearStorage: true });
    await harness.switchMode('campaign');

    await expect(harness.page.locator(SELECTORS.walletCredits)).toBeVisible();
    const credits0 = await harness.readWalletCreditsDom();
    const t0 = await harness.getTelemetry();

    expect(Number.isInteger(credits0)).toBe(true);
    expect(credits0).toBeGreaterThanOrEqual(0);
    expect(credits0).toBe(t0.walletCredits);

    await harness.selectContract(1);
    await harness.completeContractTargetDemolition();

    await expect
      .poll(async () => (await harness.readMissionDomState()).missionStatus, {
        timeout: 12_000,
        message: 'Ожидание победного завершения #contract-01 для начисления кредитов',
      })
      .toBe('victory');

    await harness.waitForSimTicks(10);
    const creditsAfter = await harness.readWalletCreditsDom();
    const tAfter = await harness.getTelemetry();

    expect(creditsAfter).toBeGreaterThan(credits0);
    expect(creditsAfter).toBe(tAfter.walletCredits);
  });

  test('[R11][F24] Мастерская улучшений (#open-workshop-btn, #workshop-modal, #close-workshop-btn): прокачка инструмента Ур. 1→2 и сохранение в localStorage после перезагрузки', async ({
    harness,
  }) => {
    await harness.boot({ clearStorage: true });
    await harness.switchMode('campaign');

    const w0 = await harness.openWorkshop();
    expect(w0.isOpen).toBe(true);
    expect(w0.modalVisible).toBe(true);

    const uiAudit = await harness.auditRussianUiAndNoPurple();
    expect(uiAudit.hasCyrillicText).toBe(true);
    expect(uiAudit.hasMalformedTokens).toBe(false);
    expect(uiAudit.purpleViolations).toEqual([]);

    const allTools: ToolId[] = ['cannon', 'c4', 'bomb', 'cutter', 'incendiary', 'seismic'];
    let cheapestTool: ToolId = 'cannon';
    let minCost = Infinity;

    for (const tool of allTools) {
      const u = w0.upgrades[tool];
      expect(u.level).toBe(1);
      expect(Number.isFinite(u.cost) && u.cost > 0).toBe(true);
      if (u.cost < minCost) {
        minCost = u.cost;
        cheapestTool = tool;
      }
    }

    await harness.ensureWalletCreditsViaCampaign(minCost);

    const upg = await harness.tryUpgradeToolInWorkshop(cheapestTool);
    expect(upg.upgraded).toBe(true);
    expect(upg.levelBefore).toBe(1);
    expect(upg.levelAfter).toBe(2);
    expect(upg.creditsAfter).toBe(upg.creditsBefore - upg.costBefore);

    const telemetryAfterUpg = await harness.getTelemetry();
    expect(telemetryAfterUpg.toolLevels[cheapestTool]).toBe(2);
    expect(telemetryAfterUpg.walletCredits).toBe(upg.creditsAfter);

    await harness.closeWorkshop();
    await expect(harness.page.locator(SELECTORS.workshopModal)).toHaveAttribute(
      'data-open',
      'false',
    );

    // Проверяем сохранение прокачки и баланса в localStorage после перезагрузки страницы
    await harness.reloadAndWaitReady();
    const wReloaded = await harness.openWorkshop();
    const telemetryReloaded = await harness.getTelemetry();

    expect(wReloaded.upgrades[cheapestTool].level).toBe(2);
    expect(telemetryReloaded.toolLevels[cheapestTool]).toBe(2);
    expect(wReloaded.walletCredits).toBe(upg.creditsAfter);
    expect(telemetryReloaded.walletCredits).toBe(upg.creditsAfter);
    await harness.closeWorkshop();
  });

  test('[R11][F24] Покупка дополнительного боекомплекта (#buy-extra-ammo-btn) в Мастерской с ростом доступного бюджета или боезапаса контракта', async ({
    harness,
  }) => {
    await harness.boot({ clearStorage: true });
    await harness.ensureWalletCreditsViaCampaign(500);

    // Проверяем стоимость #buy-extra-ammo-btn (если задан data-cost) и при необходимости добираем кредиты
    const initialWorkshop = await harness.openWorkshop();
    const ammoBtnCostAttr = await harness.page
      .locator(SELECTORS.buyExtraAmmoBtn)
      .getAttribute('data-cost');
    const parsedAmmoCost =
      ammoBtnCostAttr !== null && Number.isFinite(Number(ammoBtnCostAttr))
        ? Number(ammoBtnCostAttr)
        : 250;
    await harness.closeWorkshop();

    if (initialWorkshop.walletCredits < parsedAmmoCost) {
      await harness.ensureWalletCreditsViaCampaign(parsedAmmoCost);
    }

    await harness.selectContract(3);
    const readTotalAmmoIndicators = async (): Promise<number> => {
      const tools: ToolId[] = ['cannon', 'c4', 'bomb', 'cutter', 'incendiary', 'seismic'];
      let sum = 0;
      for (const tool of tools) {
        const btn = harness.page.locator(TOOL_BUTTON_MAP[tool]);
        if ((await btn.count()) === 0) continue;
        const val = await btn.evaluate((el: Element) => {
          const attr = el.getAttribute('data-ammo') ?? el.getAttribute('data-count');
          if (attr !== null && attr.trim() !== '' && Number.isFinite(Number(attr))) {
            return Math.max(0, Number(attr));
          }
          const cleaned = (el.textContent ?? '').replace(/[cс]4/gi, ' ');
          const m = cleaned.match(/(\d+)/);
          return m ? Number(m[1]) : 0;
        });
        sum += val;
      }
      return sum;
    };

    const budgetBefore = await harness.readNumericIndicator(SELECTORS.missionBudgetRemaining);
    const ammoBefore = await readTotalAmmoIndicators();
    const availableBefore = (await harness.getAvailableTools()).length;

    const buyRes = await harness.tryBuyExtraAmmoInWorkshop();
    await harness.closeWorkshop();

    const budgetAfter = await harness.readNumericIndicator(SELECTORS.missionBudgetRemaining);
    const ammoAfter = await readTotalAmmoIndicators();
    const availableAfter = (await harness.getAvailableTools()).length;

    expect(buyRes.purchased).toBe(true);
    expect(buyRes.creditsAfter).toBeLessThan(buyRes.creditsBefore);
    expect(
      budgetAfter > budgetBefore || ammoAfter > ammoBefore || availableAfter > availableBefore,
    ).toBe(true);
  });

  test('[R11][F24] Свободное переключение уровня прокачки арсенала Ур. 1→5 в Песочнице (#sandbox-upgrade-level-select) и физический прирост мощности оружия', async ({
    harness,
  }) => {
    await harness.boot({ clearStorage: true });
    await harness.switchMode('sandbox');
    await harness.setAutoSlowmo(false);

    const availableInSandbox = await harness.getAvailableTools();
    expect(availableInSandbox.length).toBe(6);

    const levelOptions = await harness.listSelectOptions(SELECTORS.sandboxUpgradeLevelSelect);
    expect(levelOptions.length).toBeGreaterThanOrEqual(5);

    // Замер 1: Уровень 1 на Кирпичной крепости
    await harness.spawnSandboxStructure('fortress', { cleanResetFirst: true });
    await harness.setSandboxUpgradeLevel(1);
    await expect
      .poll(async () => (await harness.getTelemetry()).toolLevels.cannon, { timeout: 5_000 })
      .toBe(1);

    const shotLv1 = await harness.aimAndStrikeStructure('cannon', {
      preferSide: 'center',
      heightFraction: 0.25,
      maxAttempts: 1,
      settleTicks: 30,
    });
    const targetWorld: [number, number, number] = shotLv1.usedPoint?.world ?? [0, 1.8, 0];
    const destr1 = shotLv1.after.destructionPct;
    const broken1 = shotLv1.after.brokenJointCount;
    const tons1 = shotLv1.after.collapsedMassTons;
    const shards1 = shotLv1.after.activeShardCount + shotLv1.after.bakedRubbleCount;
    const score1 = shotLv1.after.destructionScore;

    // Замер 2: Уровень 5 на идентичной Кирпичной крепости и той же точке прицеливания
    await harness.spawnSandboxStructure('fortress', { cleanResetFirst: true });
    await harness.setSandboxUpgradeLevel(5);
    await expect
      .poll(async () => (await harness.getTelemetry()).toolLevels.cannon, { timeout: 5_000 })
      .toBe(5);
    expect((await harness.getTelemetry()).toolLevels.c4).toBe(5);

    const shotLv5 = await harness.aimAndStrikeStructure('cannon', {
      worldPoint: targetWorld,
      maxAttempts: 1,
      settleTicks: 30,
    });
    const destr5 = shotLv5.after.destructionPct;
    const broken5 = shotLv5.after.brokenJointCount;
    const tons5 = shotLv5.after.collapsedMassTons;
    const shards5 = shotLv5.after.activeShardCount + shotLv5.after.bakedRubbleCount;
    const score5 = shotLv5.after.destructionScore;

    expect(
      destr5 > destr1 ||
        broken5 > broken1 ||
        tons5 > tons1 ||
        shards5 > shards1 ||
        score5 > score1,
    ).toBe(true);
  });

  test('[R11][F25] Живой Game Feel HUD: обрушенный тоннаж (#hud-collapsed-tons), счёт (#hud-destruction-score), комбо (#hud-combo-badge) и инженерная лента (#tactical-feed)', async ({
    harness,
  }) => {
    await harness.boot();
    await harness.setAutoSlowmo(false);
    await harness.spawnSandboxStructure('tower', { cleanResetFirst: true });
    await harness.waitForSimTicks(10);

    const hud0 = await harness.readGameFeelDomState();
    const t0 = await harness.getTelemetry();
    expect(hud0.collapsedTons).toBe(0);
    expect(hud0.destructionScore).toBe(0);
    expect(hud0.comboMultiplier).toBeGreaterThanOrEqual(1);
    expect(t0.collapsedMassTons).toBe(0);
    expect(t0.destructionScore).toBe(0);

    await harness.setSandboxUpgradeLevel(5);
    await harness.plantC4OnStructure({
      count: 2,
      delaySec: 0,
      preferSide: 'left',
      heightFraction: 0.14,
    });
    await harness.plantC4OnStructure({
      count: 2,
      delaySec: 0.25,
      preferSide: 'right',
      heightFraction: 0.14,
    });

    await harness.setPaused(false);
    await harness.page.locator(SELECTORS.detonateC4Btn).click();
    await harness.aimAndStrikeStructure('bomb', {
      preferSide: 'center',
      heightFraction: 0.16,
      settleTicks: 6,
      maxAttempts: 1,
    });

    let peakCombo = 1;
    let capturedRussianEvent = '';

    for (let step = 0; step < 10; step++) {
      const tStep = await harness.waitForSimTicks(8);
      const hudStep = await harness.readGameFeelDomState();
      peakCombo = Math.max(peakCombo, hudStep.comboMultiplier, tStep.comboMultiplier);
      if (/[А-Яа-яЁё]{3,}/.test(hudStep.tacticalFeedLastEvent)) {
        capturedRussianEvent = hudStep.tacticalFeedLastEvent;
      }
    }

    const finalTelemetry = await harness.getTelemetry();
    const finalHud = await harness.readGameFeelDomState();

    expect(finalHud.collapsedTons).toBeGreaterThan(0);
    expect(finalTelemetry.collapsedMassTons).toBeGreaterThan(0);
    expect(Math.abs(finalHud.collapsedTons - finalTelemetry.collapsedMassTons)).toBeLessThanOrEqual(
      1.5,
    );

    expect(finalHud.destructionScore).toBeGreaterThan(0);
    expect(finalTelemetry.destructionScore).toBeGreaterThan(0);
    expect(
      Math.abs(finalHud.destructionScore - finalTelemetry.destructionScore),
    ).toBeLessThanOrEqual(5);

    expect(peakCombo).toBeGreaterThan(1.0);
    expect(capturedRussianEvent || finalHud.tacticalFeedLastEvent).toMatch(/[А-Яа-яЁё]{3,}/);
  });

  test('[R11][F25] Контролируемый тумблер авто-слоу-мо (#auto-slowmo-toggle) без перезаписи data-time-scale и шкала урона с отметками звёзд (#damage-progress-bar, #star-threshold-1..3)', async ({
    harness,
  }) => {
    await harness.boot({ clearStorage: true });
    await harness.selectContract(1);

    for (const sel of STAR_THRESHOLD_SELECTORS) {
      await expect(harness.page.locator(sel)).toBeAttached();
    }

    const bar0 = await harness.readDamageProgressBarState();
    expect(bar0.barAttached).toBe(true);
    expect(bar0.barVisible).toBe(true);
    expect(bar0.thresholdsAttached).toEqual([true, true, true]);
    expect(bar0.thresholdsVisible).toEqual([true, true, true]);
    expect(bar0.thresholdPositionsOrValues[0]).toBeLessThanOrEqual(
      bar0.thresholdPositionsOrValues[1],
    );
    expect(bar0.thresholdPositionsOrValues[1]).toBeLessThanOrEqual(
      bar0.thresholdPositionsOrValues[2],
    );
    expect(bar0.thresholdPositionsOrValues[2]).toBeGreaterThan(bar0.thresholdPositionsOrValues[0]);

    // Убеждаемся, что базовый пользовательский масштаб времени равен 1.0x
    await harness.setTimeScale(1.0);
    expect((await harness.getAppRootState()).timeScale).toBeCloseTo(1.0, 2);

    // Переключаем #auto-slowmo-toggle и проверяем независимость data-time-scale
    await harness.setAutoSlowmo(true);
    expect(await harness.getAutoSlowmoEnabled()).toBe(true);
    expect((await harness.getAppRootState()).timeScale).toBeCloseTo(1.0, 2);

    await harness.setAutoSlowmo(false);
    expect(await harness.getAutoSlowmoEnabled()).toBe(false);
    expect((await harness.getAppRootState()).timeScale).toBeCloseTo(1.0, 2);

    await harness.setAutoSlowmo(true);
    expect(await harness.getAutoSlowmoEnabled()).toBe(true);

    // Вызываем ключевой разлом при включённом авто-слоу-мо
    const tickBefore = (await harness.getTelemetry()).tick;
    const available = await harness.getAvailableTools();
    if (available.includes('c4')) {
      const planted = await harness.plantC4OnStructure({
        count: 3,
        delaySec: 0,
        heightFraction: 0.14,
        preferSide: 'center',
      });
      if (planted.totalPlanted > 0) {
        await harness.detonateC4AndSettle(45);
      }
    } else if (available.includes('bomb')) {
      await harness.aimAndStrikeStructure('bomb', { heightFraction: 0.14, settleTicks: 45 });
    } else if (available.includes('cannon')) {
      await harness.aimAndStrikeStructure('cannon', { heightFraction: 0.16, settleTicks: 45 });
    }

    const afterState = await harness.getAppRootState();
    const afterTelemetry = await harness.getTelemetry();
    const missionDom = await harness.readMissionDomState();

    expect(afterTelemetry.tick).toBeGreaterThanOrEqual(tickBefore + 30);
    expect(afterState.autoSlowmo).toBe(true);
    // Пользовательский атрибут data-time-scale НЕ должен перезаписываться кинематографичным импульсом
    expect(afterState.timeScale).toBeCloseTo(1.0, 2);
    expect(afterTelemetry.destructionPct > 0 || missionDom.targetProgress > 0).toBe(true);
  });
});

test.describe('Уровень 1 — R12: Секвенсор каскадного подрыва C4, разведка критических узлов и объекты-триггеры', () => {
  test('[R12][F26] Тактическая разведка критических несущих опор (criticalNodesCount > 0) и визуализация узлов в режимах Stress и X-Ray', async ({
    harness,
  }) => {
    await harness.boot();
    await harness.setAutoSlowmo(false);
    await harness.spawnSandboxStructure('tower', { cleanResetFirst: true });
    await harness.waitForSimTicks(15);

    const t0 = await harness.getTelemetry();
    expect(Number.isInteger(t0.criticalNodesCount)).toBe(true);
    expect(t0.criticalNodesCount).toBeGreaterThan(0);
    expect(t0.criticalNodesCount).toBeLessThanOrEqual(t0.intactBlockCount);

    await harness.setPaused(true);
    await harness.setRenderViewMode('pbr');
    const pbrPng = await harness.captureCanvasPngBytes();

    await harness.setRenderViewMode('stress');
    const stressPng = await harness.captureCanvasPngBytes();
    expect((await harness.getTelemetry()).drawCalls).toBeGreaterThan(0);

    await harness.setRenderViewMode('xray');
    const xrayPng = await harness.captureCanvasPngBytes();
    expect((await harness.getTelemetry()).drawCalls).toBeGreaterThan(0);

    expect(areByteArraysDifferent(pbrPng, stressPng)).toBe(true);
    expect(areByteArraysDifferent(pbrPng, xrayPng)).toBe(true);

    await harness.setPaused(false);
    const planted = await harness.plantC4OnStructure({
      count: 2,
      delaySec: 0,
      preferSide: 'left',
      heightFraction: 0.14,
    });
    expect(planted.totalPlanted).toBeGreaterThanOrEqual(1);
    const tAfter = await harness.detonateC4AndSettle(35);

    expect(Number.isInteger(tAfter.criticalNodesCount)).toBe(true);
    expect(tAfter.criticalNodesCount).toBeGreaterThanOrEqual(0);
    expect(tAfter.criticalNodesCount).toBeLessThanOrEqual(tAfter.intactBlockCount);
    const glHealth = await harness.verifyWebGL2Context();
    expect(glHealth.contextLost).toBe(false);
  });

  test('[R12][F26] Очередь программируемого секвенсора C4 (#c4-sequencer-panel, #c4-sequencer-list): синхронизация data-queue-count и c4SequenceQueue при закладке и снятии', async ({
    harness,
  }) => {
    await harness.boot();
    await harness.spawnSandboxStructure('tower', { cleanResetFirst: true });
    await harness.selectTool('c4');

    const seq0 = await harness.readC4SequencerDomState();
    expect(seq0.queueCountAttr).toBe(0);
    expect((await harness.getTelemetry()).c4SequenceQueue).toEqual([]);

    const c1 = await harness.plantC4OnStructure({
      count: 1,
      delaySec: 0,
      preferSide: 'left',
      heightFraction: 0.18,
    });
    expect(c1.totalPlanted).toBe(1);
    const seq1 = await harness.readC4SequencerDomState();
    const t1 = await harness.getTelemetry();
    expect(seq1.panelVisible).toBe(true);
    expect(seq1.queueCountAttr).toBe(1);
    expect(seq1.renderedItemCount).toBe(1);
    expect(t1.c4SequenceQueue.length).toBe(1);

    const c2 = await harness.plantC4OnStructure({
      count: 1,
      delaySec: 0.25,
      preferSide: 'center',
      heightFraction: 0.24,
    });
    expect(c2.totalPlanted).toBe(2);
    const seq2 = await harness.readC4SequencerDomState();
    const t2 = await harness.getTelemetry();
    expect(seq2.queueCountAttr).toBe(2);
    expect(seq2.renderedItemCount).toBe(2);
    expect(t2.c4SequenceQueue.length).toBe(2);

    const c3 = await harness.plantC4OnStructure({
      count: 1,
      delaySec: 0.5,
      preferSide: 'right',
      heightFraction: 0.18,
    });
    expect(c3.totalPlanted).toBe(3);
    const seq3 = await harness.readC4SequencerDomState();
    const t3 = await harness.getTelemetry();
    expect(seq3.queueCountAttr).toBe(3);
    expect(seq3.renderedItemCount).toBe(3);
    expect(t3.c4SequenceQueue.length).toBe(3);

    const uniqueChargeIds = new Set(t3.c4SequenceQueue.map((item) => item.chargeId));
    expect(uniqueChargeIds.size).toBe(3);

    // Снимаем третий заряд правой кнопкой мыши и проверяем синхронное обновление очереди
    expect(c3.hits.length).toBe(1);
    const removed = await harness.removeC4AtHit(c3.hits[0]);
    expect(removed).toBe(true);

    const seqAfterRemove = await harness.readC4SequencerDomState();
    const tAfterRemove = await harness.getTelemetry();
    expect(await harness.getPlantedC4Count()).toBe(2);
    expect(seqAfterRemove.queueCountAttr).toBe(2);
    expect(seqAfterRemove.renderedItemCount).toBe(2);
    expect(tAfterRemove.c4SequenceQueue.length).toBe(2);
  });

  test('[R12][F26] Редактирование задержки заряда напрямую в #c4-sequencer-list и поэтапный волновой подрыв по долям секунды', async ({
    harness,
  }) => {
    await harness.boot();
    await harness.setAutoSlowmo(false);
    await harness.spawnSandboxStructure('viaduct', { cleanResetFirst: true });

    const leftCharge = await harness.plantC4OnStructure({
      count: 1,
      delaySec: 0,
      preferSide: 'left',
      heightFraction: 0.2,
    });
    const rightCharge = await harness.plantC4OnStructure({
      count: 1,
      delaySec: 0,
      preferSide: 'right',
      heightFraction: 0.2,
    });
    expect(leftCharge.plantedNow).toBe(1);
    expect(rightCharge.plantedNow).toBe(1);

    const queueBeforeEdit = (await harness.getTelemetry()).c4SequenceQueue;
    expect(queueBeforeEdit.length).toBe(2);
    expect(queueBeforeEdit[0].delaySec).toBeCloseTo(0, 2);
    expect(queueBeforeEdit[1].delaySec).toBeCloseTo(0, 2);

    // Меняем задержку второго заряда напрямую через UI элемента в #c4-sequencer-list
    const editRes = await harness.updateC4SequencerItemDelay(1, 0.5);
    expect(editRes.updated).toBe(true);
    expect(editRes.afterQueue[0].delaySec).toBeCloseTo(0, 2);
    expect(editRes.afterQueue[1].delaySec).toBeGreaterThanOrEqual(0.2);

    const secondDelaySec = editRes.afterQueue[1].delaySec;

    await harness.setPaused(false);
    await harness.page.locator(SELECTORS.detonateC4Btn).click();

    // На раннем замере (~4 тика = 0.067 с < secondDelaySec) первый заряд уже сработал, а второй ещё ждёт
    const earlyTelemetry = await harness.waitForSimTicks(4);
    const earlyPlanted = await harness.getPlantedC4Count();
    expect(
      earlyTelemetry.brokenJointCount > 0 ||
        earlyTelemetry.activeShardCount > 0 ||
        earlyPlanted === 1,
    ).toBe(true);
    expect(earlyPlanted >= 1 || earlyTelemetry.c4SequenceQueue.length >= 1).toBe(true);

    // По истечении времени задержки второго заряда вся очередь детонирует полностью
    const finalTelemetry = await harness.waitForSimTime(secondDelaySec + 0.5);
    const finalSeq = await harness.readC4SequencerDomState();

    expect(await harness.getPlantedC4Count()).toBe(0);
    expect(finalSeq.queueCountAttr).toBe(0);
    expect(finalTelemetry.c4SequenceQueue.length).toBe(0);
    expect(finalTelemetry.brokenJointCount).toBeGreaterThan(0);
  });

  test('[R12][F26] Направленный завал высотной башни каскадной очередью секвенсора C4 (асимметричный опережающий подрыв одной стороны)', async ({
    harness,
  }) => {
    await harness.boot();
    await harness.setAutoSlowmo(false);
    await harness.spawnSandboxStructure('tower', { cleanResetFirst: true });
    await harness.setSandboxUpgradeLevel(4);

    const h0 = (await harness.getTelemetry()).targetMaxHeightM;
    expect(h0).toBeGreaterThan(4.5);

    const wave1 = await harness.plantC4OnStructure({
      count: 2,
      delaySec: 0,
      preferSide: 'left',
      heightFraction: 0.14,
    });
    const wave2 = await harness.plantC4OnStructure({
      count: 2,
      delaySec: 0.5,
      preferSide: 'right',
      heightFraction: 0.24,
    });
    expect(wave1.plantedNow).toBeGreaterThanOrEqual(1);
    expect(wave2.plantedNow).toBeGreaterThanOrEqual(1);

    const seqBeforeBlast = await harness.readC4SequencerDomState();
    const queueBeforeBlast = (await harness.getTelemetry()).c4SequenceQueue;
    expect(seqBeforeBlast.queueCountAttr).toBe(queueBeforeBlast.length);
    expect(queueBeforeBlast.some((c) => c.delaySec === 0)).toBe(true);
    expect(queueBeforeBlast.some((c) => c.delaySec >= 0.25)).toBe(true);
    expect(seqBeforeBlast.listText).toMatch(/\d/);

    await harness.setPaused(false);
    await harness.page.locator(SELECTORS.detonateC4Btn).click();
    const afterCollapse = await harness.waitForSimTime(1.6);

    const seqAfterBlast = await harness.readC4SequencerDomState();
    expect(seqAfterBlast.queueCountAttr).toBe(0);
    expect(afterCollapse.brokenJointCount).toBeGreaterThan(0);
    expect(afterCollapse.collapsedMassTons).toBeGreaterThan(0);
    expect(
      afterCollapse.targetMaxHeightM < h0 * 0.8 || afterCollapse.destructionPct > 15,
    ).toBe(true);
  });

  test('[R12][F26] Интерактивные объекты-триггеры на уровнях (activeTriggersCount > 0): срабатывание взрывоопасных резервуаров и подвешенных противовесов', async ({
    harness,
  }) => {
    await harness.boot({ clearStorage: true });
    await harness.setAutoSlowmo(false);

    let triggers0 = 0;

    // Ищем карту с интерактивными объектами-триггерами в Кампании или Песочнице
    for (const contractIdx of [4, 2, 5, 6, 8, 1, 3, 7] as const) {
      const t = await harness.selectContract(contractIdx);
      if (t.activeTriggersCount > 0) {
        triggers0 = t.activeTriggersCount;
        break;
      }
    }

    if (triggers0 === 0) {
      for (const bp of ['hangar', 'warehouse', 'tower', 'domino', 'viaduct', 'fortress'] as const) {
        const { after } = await harness.spawnSandboxStructure(bp, { cleanResetFirst: true });
        if (after.activeTriggersCount > 0) {
          triggers0 = after.activeTriggersCount;
          break;
        }
      }
    }

    expect(triggers0).toBeGreaterThan(0);

    const available = await harness.getAvailableTools();
    const primaryTool: Exclude<ToolId, 'c4' | 'seismic'> = available.includes('cannon')
      ? 'cannon'
      : available.includes('bomb')
        ? 'bomb'
        : available.includes('incendiary')
          ? 'incendiary'
          : 'cutter';

    // Бьём по верхнему ярусу (крепления подвешенных противовесов) и нижнему ярусу (газовые резервуары)
    await harness.aimAndStrikeStructure(primaryTool, {
      heightFraction: 0.74,
      settleTicks: 30,
      searchFullPolygon: true,
    });
    let mid = await harness.getTelemetry();

    if (
      mid.activeTriggersCount >= triggers0 &&
      mid.detonatedExplosivesCount === 0 &&
      mid.secondaryImpactsCount === 0
    ) {
      const secondaryTool: Exclude<ToolId, 'c4' | 'seismic'> = available.includes('bomb')
        ? 'bomb'
        : primaryTool;
      await harness.aimAndStrikeStructure(secondaryTool, {
        heightFraction: 0.18,
        settleTicks: 35,
        searchFullPolygon: true,
      });
      mid = await harness.getTelemetry();
    }

    const tAfter = await harness.waitForSimTicks(30);
    expect(
      tAfter.activeTriggersCount < triggers0 ||
        tAfter.detonatedExplosivesCount > 0 ||
        tAfter.secondaryImpactsCount > 0,
    ).toBe(true);
    expect(tAfter.collapsedMassTons > 0 || tAfter.destructionPct > 0).toBe(true);
    expect(tAfter.destructionScore).toBeGreaterThan(0);
  });

  test('[R12][F26] Цепная реакция опор-триггеров «Каскад домино» с накоплением вторичных ударов и очков разрушения', async ({
    harness,
  }) => {
    await harness.boot();
    await harness.setAutoSlowmo(false);
    await harness.spawnSandboxStructure('domino', { cleanResetFirst: true });

    const before = await harness.waitForSimTicks(15);
    expect(before.brokenJointCount).toBe(0);
    expect(before.destructionScore).toBe(0);

    const pushLeft = await harness.aimAndStrikeStructure('cannon', {
      preferSide: 'left',
      heightFraction: 0.65,
      maxAttempts: 2,
      settleTicks: 35,
      searchFullPolygon: true,
    });

    if (
      pushLeft.after.brokenJointCount < 2 &&
      pushLeft.after.secondaryImpactsCount === 0 &&
      pushLeft.after.destructionPct <= 8
    ) {
      await harness.aimAndStrikeStructure('cannon', {
        preferSide: 'right',
        heightFraction: 0.65,
        maxAttempts: 2,
        settleTicks: 35,
        searchFullPolygon: true,
      });
    }

    await expect
      .poll(
        async () => {
          const cur = await harness.waitForSimTicks(15);
          return (
            (cur.brokenJointCount >= 2 ||
              cur.secondaryImpactsCount > 0 ||
              cur.detonatedExplosivesCount > 0) &&
            cur.destructionScore > 0 &&
            (cur.collapsedMassTons > 0 || cur.destructionPct > 8)
          );
        },
        {
          timeout: 10_000,
          message: 'Ожидание каскадной реакции опор-триггеров домино с ростом очков разрушения',
        },
      )
      .toBe(true);
  });
});
