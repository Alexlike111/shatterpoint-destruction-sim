import {
  test,
  expect,
  SELECTORS,
  UPGRADE_BUTTON_MAP,
  STAR_THRESHOLD_SELECTORS,
} from '../helpers/shatterpoint-harness';
import type { ToolId } from '../helpers/shatterpoint-harness';

const ALL_TOOLS: readonly ToolId[] = [
  'cannon',
  'c4',
  'bomb',
  'cutter',
  'incendiary',
  'seismic',
];

test.describe('Уровень 2 — R11: Граничные и негативные сценарии экономики Мастерской, прокачки Ур. 1→5 и Game Feel', () => {
  test('[R11][F24] Отказ покупки #upgrade-*-btn и #buy-extra-ammo-btn при нулевом/недостаточном балансе #wallet-credits без ухода в минус и без роста data-level', async ({
    harness,
  }) => {
    await harness.boot({ clearStorage: true });
    await harness.selectContract(1);

    let ws = await harness.openWorkshop();
    expect(ws.isOpen).toBe(true);
    expect(ws.modalVisible).toBe(true);

    const t0 = await harness.getTelemetry();
    expect(ws.walletCredits).toBeGreaterThanOrEqual(0);
    expect(ws.walletCredits).toBe(t0.walletCredits);

    // На чистом старте все 6 инструментов имеют Ур. 1 и положительную целую цену апгрейда
    for (const tool of ALL_TOOLS) {
      const upg = ws.upgrades[tool];
      expect(upg.level).toBe(1);
      expect(Number.isInteger(upg.cost) && upg.cost > 0).toBe(true);
    }

    // Если на старте предусмотрен начальный грант кредитов, честно тратим его через кнопки Мастерской до дефицита
    for (let spendStep = 0; spendStep < 20; spendStep++) {
      ws = await harness.readWorkshopDomState();
      const hasDeficitTarget = ALL_TOOLS.some(
        (t) => ws.upgrades[t].level < 5 && ws.upgrades[t].cost > ws.walletCredits,
      );
      if (hasDeficitTarget) break;

      const affordableTool = ALL_TOOLS.find(
        (t) => ws.upgrades[t].level < 5 && ws.upgrades[t].cost <= ws.walletCredits,
      );
      if (!affordableTool) break;
      const attempt = await harness.tryUpgradeToolInWorkshop(affordableTool);
      if (!attempt.upgraded) break;
    }

    ws = await harness.readWorkshopDomState();
    const deficitTool =
      ALL_TOOLS.find((t) => ws.upgrades[t].level < 5 && ws.upgrades[t].cost > ws.walletCredits) ??
      'cannon';

    const walletBeforeUpg = ws.walletCredits;
    const levelBeforeUpg = ws.upgrades[deficitTool].level;
    const costRequired = ws.upgrades[deficitTool].cost;
    expect(walletBeforeUpg).toBeLessThan(costRequired);

    // Три попытки купить улучшение при дефиците средств не должны менять уровень или уводить кошелёк в минус
    const failedUpg = await harness.tryUpgradeToolInWorkshop(deficitTool);
    await harness.clickOrVerifyDisabled(UPGRADE_BUTTON_MAP[deficitTool]);
    await harness.clickOrVerifyDisabled(UPGRADE_BUTTON_MAP[deficitTool]);

    const wsAfterUpg = await harness.readWorkshopDomState();
    const telAfterUpg = await harness.getTelemetry();

    expect(failedUpg.upgraded).toBe(false);
    expect(wsAfterUpg.walletCredits).toBe(walletBeforeUpg);
    expect(wsAfterUpg.walletCredits).toBeGreaterThanOrEqual(0);
    expect(telAfterUpg.walletCredits).toBe(walletBeforeUpg);
    expect(wsAfterUpg.upgrades[deficitTool].level).toBe(levelBeforeUpg);
    expect(telAfterUpg.toolLevels[deficitTool]).toBe(levelBeforeUpg);

    // Доводим остаток средств ниже цены доп. боекомплекта (если остаток > 0) и проверяем отказ #buy-extra-ammo-btn
    for (let ammoSpend = 0; ammoSpend < 50; ammoSpend++) {
      const curCredits = await harness.readWalletCreditsDom();
      if (curCredits === 0) break;
      const res = await harness.tryBuyExtraAmmoInWorkshop();
      if (!res.purchased) break;
    }

    const walletBeforeAmmo = await harness.readWalletCreditsDom();
    const failedAmmo = await harness.tryBuyExtraAmmoInWorkshop();
    await harness.clickOrVerifyDisabled(SELECTORS.buyExtraAmmoBtn);

    const walletAfterAmmo = await harness.readWalletCreditsDom();
    const telAfterAmmo = await harness.getTelemetry();

    expect(failedAmmo.purchased).toBe(false);
    expect(walletAfterAmmo).toBe(walletBeforeAmmo);
    expect(walletAfterAmmo).toBeGreaterThanOrEqual(0);
    expect(telAfterAmmo.walletCredits).toBe(walletBeforeAmmo);
    expect(failedAmmo.budgetAfter).toBe(failedAmmo.budgetBefore);

    await harness.closeWorkshop();
  });

  test('[R11][F24] Верхняя граница прокачки Ур. 5 в Песочнице (#sandbox-upgrade-level-select): отсутствие уровней > 5, усиление физики Ур. 5 vs Ур. 1 и изоляция кошелька Кампании', async ({
    harness,
  }) => {
    await harness.boot({ clearStorage: true });
    await harness.switchMode('campaign');

    const campBefore = await harness.openWorkshop();
    const initialCampaignCredits = campBefore.walletCredits;
    await harness.closeWorkshop();

    await harness.switchMode('sandbox');
    await harness.setAutoSlowmo(false);

    const options = await harness.listSelectOptions(SELECTORS.sandboxUpgradeLevelSelect);
    expect(options.length).toBeGreaterThanOrEqual(5);

    const numericLevels = options
      .map((o) => o.numericValue)
      .filter((n): n is number => n !== null && Number.isFinite(n));
    expect(numericLevels.length).toBeGreaterThanOrEqual(5);
    expect(Math.min(...numericLevels)).toBe(1);
    expect(Math.max(...numericLevels)).toBe(5);

    // 1. Базовый замер на Ур. 1 по центру кирпичной крепости
    await harness.spawnSandboxStructure('fortress', { cleanResetFirst: true });
    await harness.setSandboxUpgradeLevel(1);
    await expect
      .poll(async () => (await harness.getTelemetry()).toolLevels.cannon, { timeout: 5_000 })
      .toBe(1);

    const shotLv1 = await harness.aimAndStrikeStructure('cannon', {
      preferSide: 'center',
      heightFraction: 0.25,
      maxAttempts: 1,
      settleTicks: 25,
    });
    const targetWorld: [number, number, number] = shotLv1.usedPoint?.world ?? [0, 1.8, 0];

    // 2. Потолочный замер на Ур. 5 в ту же мировую координату
    await harness.spawnSandboxStructure('fortress', { cleanResetFirst: true });
    await harness.setSandboxUpgradeLevel(5);
    const telLv5 = await harness.getTelemetry();

    for (const tool of ALL_TOOLS) {
      expect(telLv5.toolLevels[tool]).toBe(5);
      expect(telLv5.toolLevels[tool]).toBeLessThanOrEqual(5);
    }

    const shotLv5 = await harness.aimAndStrikeStructure('cannon', {
      worldPoint: targetWorld,
      maxAttempts: 1,
      settleTicks: 25,
    });

    const shardsLv1 = shotLv1.after.activeShardCount + shotLv1.after.bakedRubbleCount;
    const shardsLv5 = shotLv5.after.activeShardCount + shotLv5.after.bakedRubbleCount;

    expect(
      shotLv5.after.brokenJointCount > shotLv1.after.brokenJointCount ||
        shotLv5.after.destructionPct > shotLv1.after.destructionPct ||
        shardsLv5 > shardsLv1 ||
        shotLv5.after.collapsedMassTons > shotLv1.after.collapsedMassTons ||
        shotLv5.after.destructionScore > shotLv1.after.destructionScore,
    ).toBe(true);

    // 3. Возврат в Кампанию: тестовый Ур. 5 из Песочницы НЕ должен просочиться в прогрессию Мастерской
    await harness.switchMode('campaign');
    const campAfter = await harness.openWorkshop();
    const telCampAfter = await harness.getTelemetry();

    expect(campAfter.walletCredits).toBe(initialCampaignCredits);
    for (const tool of ALL_TOOLS) {
      expect(campAfter.upgrades[tool].level).toBe(1);
      expect(telCampAfter.toolLevels[tool]).toBe(1);
    }
    await harness.closeWorkshop();
  });

  test('[R11][F24] Верхняя граница прокачки data-level="5" в Мастерской Кампании: блокировка покупки 6-го уровня и сохранность кредитов на потолке', async ({
    harness,
  }) => {
    test.slow();

    await harness.boot({ clearStorage: true });
    await harness.switchMode('campaign');

    let ws = await harness.openWorkshop();
    let targetTool: ToolId = 'cannon';
    let minInitialCost = Infinity;
    for (const tool of ALL_TOOLS) {
      if (ws.upgrades[tool].cost < minInitialCost) {
        minInitialCost = ws.upgrades[tool].cost;
        targetTool = tool;
      }
    }
    await harness.closeWorkshop();

    await harness.setTimeScale(2.0);

    type CampaignContractId = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
    const freshContracts: CampaignContractId[] = [1, 2, 3, 4, 5, 6, 7, 8];
    const victoriousFirstPass: CampaignContractId[] = [];
    const repeatableRewardContracts: CampaignContractId[] = [];
    let replayProbeCursor = 0;
    let repeatableCursor = 0;

    const pickNextContractForCredits = (): {
      contractIdx: CampaignContractId;
      isFirstPass: boolean;
    } => {
      if (freshContracts.length > 0) {
        return { contractIdx: freshContracts.shift()!, isFirstPass: true };
      }
      if (repeatableRewardContracts.length > 0) {
        const chosen =
          repeatableRewardContracts[repeatableCursor % repeatableRewardContracts.length];
        repeatableCursor += 1;
        return { contractIdx: chosen, isFirstPass: false };
      }
      const fallbackPool: readonly CampaignContractId[] =
        victoriousFirstPass.length > 0 ? victoriousFirstPass : [1, 2, 3, 4, 5, 6, 7, 8];
      const chosen = fallbackPool[replayProbeCursor % fallbackPool.length];
      replayProbeCursor += 1;
      return { contractIdx: chosen, isFirstPass: false };
    };

    // Честно зарабатываем кредиты в миссиях и пошагово прокачиваем выбранный инструмент до потолка Ур. 5
    for (let runIdx = 0; runIdx < 20; runIdx++) {
      ws = await harness.openWorkshop();
      while (
        ws.upgrades[targetTool].level < 5 &&
        ws.walletCredits >= ws.upgrades[targetTool].cost
      ) {
        const upg = await harness.tryUpgradeToolInWorkshop(targetTool);
        if (!upg.upgraded) break;
        ws = await harness.readWorkshopDomState();
      }

      if (ws.upgrades[targetTool].level >= 5) {
        break;
      }

      await harness.closeWorkshop();
      const { contractIdx, isFirstPass } = pickNextContractForCredits();
      const creditsBeforeRun = await harness.readWalletCreditsDom();
      await harness.selectContract(contractIdx);
      await harness.completeContractTargetDemolition();
      await harness.waitForSimTicks(15);
      const creditsAfterRun = await harness.readWalletCreditsDom();

      if (creditsAfterRun > creditsBeforeRun) {
        if (isFirstPass) {
          victoriousFirstPass.push(contractIdx);
        } else if (!repeatableRewardContracts.includes(contractIdx)) {
          repeatableRewardContracts.push(contractIdx);
        }
      }
    }

    ws = await harness.openWorkshop();
    expect(ws.upgrades[targetTool].level).toBe(5);

    // Если после покупки Ур. 5 на кошельке осталось 0 кредитов, проходим ещё один прибыльный контракт для ненулевого баланса
    if (ws.walletCredits === 0) {
      await harness.closeWorkshop();
      const { contractIdx } = pickNextContractForCredits();
      await harness.selectContract(contractIdx);
      await harness.completeContractTargetDemolition();
      await harness.waitForSimTicks(15);
      ws = await harness.openWorkshop();
    }

    await harness.setTimeScale(1.0);
    const walletOnMax = ws.walletCredits;
    await expect(harness.page.locator(UPGRADE_BUTTON_MAP[targetTool])).toHaveAttribute(
      'data-level',
      '5',
    );
    expect((await harness.getTelemetry()).toolLevels[targetTool]).toBe(5);

    // Попытка купить «6-й уровень» обязана быть заблокирована без списания кредитов
    const maxAttempt = await harness.tryUpgradeToolInWorkshop(targetTool);
    await harness.clickOrVerifyDisabled(UPGRADE_BUTTON_MAP[targetTool]);

    const wsAfterMaxClick = await harness.readWorkshopDomState();
    const telAfterMaxClick = await harness.getTelemetry();

    expect(maxAttempt.upgraded).toBe(false);
    expect(maxAttempt.levelAfter).toBe(5);
    expect(wsAfterMaxClick.upgrades[targetTool].level).toBe(5);
    expect(telAfterMaxClick.toolLevels[targetTool]).toBe(5);
    expect(wsAfterMaxClick.walletCredits).toBe(walletOnMax);
    expect(telAfterMaxClick.walletCredits).toBe(walletOnMax);

    await harness.closeWorkshop();

    // Проверяем сохранность потолка data-level="5" в localStorage после перезагрузки страницы
    await harness.reloadAndWaitReady();
    const wsReloaded = await harness.openWorkshop();
    const telReloaded = await harness.getTelemetry();

    expect(wsReloaded.upgrades[targetTool].level).toBe(5);
    expect(telReloaded.toolLevels[targetTool]).toBe(5);
    expect(wsReloaded.walletCredits).toBe(walletOnMax);
    await harness.closeWorkshop();
  });

  test('[R11][F12][F25] Отключение авто-слоу-мо (#auto-slowmo-toggle -> data-auto-slowmo="false"): строгая неизменность data-time-scale в разгар каскадного обрушения', async ({
    harness,
  }) => {
    await harness.boot();
    await harness.spawnSandboxStructure('tower', { cleanResetFirst: true });

    await expect(harness.page.locator(SELECTORS.autoSlowmoToggle)).toBeVisible();

    // Проверяем переключение тумблера туда-обратно и фиксируем строго выключенное состояние false
    await harness.setAutoSlowmo(true);
    expect(await harness.getAutoSlowmoEnabled()).toBe(true);
    await harness.setAutoSlowmo(false);
    expect(await harness.getAutoSlowmoEnabled()).toBe(false);

    await harness.setTimeScale(1.0);
    expect((await harness.getAppRootState()).timeScale).toBeCloseTo(1.0, 3);

    await harness.setSandboxUpgradeLevel(4);
    const planted = await harness.plantC4OnStructure({
      count: 3,
      delaySec: 0,
      heightFraction: 0.14,
    });

    await harness.setPaused(false);
    if (planted.totalPlanted > 0) {
      await harness.clickOrVerifyDisabled(SELECTORS.detonateC4Btn);
    }
    if (planted.totalPlanted < 2) {
      await harness.aimAndStrikeStructure('bomb', {
        heightFraction: 0.14,
        settleTicks: 2,
        maxAttempts: 1,
      });
    }

    // 10 последовательных замеров в разгар каскадного разлома опор при выключенном авто-слоу-мо
    for (let sample = 0; sample < 10; sample++) {
      await harness.waitForSimTicks(3);
      const rootState = await harness.getAppRootState();
      expect(rootState.autoSlowmo).toBe(false);
      expect(rootState.timeScale).toBeCloseTo(1.0, 3);
    }

    const afterCollapse = await harness.getTelemetry();
    expect(afterCollapse.brokenJointCount).toBeGreaterThan(0);
    expect(afterCollapse.destructionPct).toBeGreaterThan(5);

    // При включённом data-auto-slowmo="true" пользовательский атрибут data-time-scale также не перезаписывается
    await harness.setAutoSlowmo(true);
    await harness.spawnSandboxStructure('tower', { cleanResetFirst: true });
    const tickStart = (await harness.getTelemetry()).tick;

    await harness.aimAndStrikeStructure('bomb', {
      heightFraction: 0.14,
      settleTicks: 24,
      maxAttempts: 1,
    });

    const stateWithAuto = await harness.getAppRootState();
    const telWithAuto = await harness.getTelemetry();
    expect(stateWithAuto.autoSlowmo).toBe(true);
    expect(stateWithAuto.timeScale).toBeCloseTo(1.0, 3);
    expect(telWithAuto.tick).toBeGreaterThanOrEqual(tickStart + 18);
  });

  test('[R11][F25] Комбо цепных реакций (#hud-combo-badge), тоннаж (#hud-collapsed-tons) и счёт (#hud-destruction-score): мгновенный сброс при #scene-reset-btn и затухание в покое', async ({
    harness,
  }) => {
    await harness.boot();
    await harness.setAutoSlowmo(false);

    const triggerCascadeWithCombo = async (): Promise<number> => {
      await harness.spawnSandboxStructure('tower', { cleanResetFirst: true });
      await harness.setSandboxUpgradeLevel(5);
      await harness.placeSandboxBuildBlock('explosive', [
        [2.2, 0.7, 2.2],
        [-2.2, 0.7, 2.2],
        [6.5, 0.7, 0],
      ]);
      await harness.exitSandboxBuildMode();

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
      await harness.clickOrVerifyDisabled(SELECTORS.detonateC4Btn);
      await harness.aimAndStrikeStructure('bomb', {
        preferSide: 'center',
        heightFraction: 0.16,
        settleTicks: 6,
        maxAttempts: 1,
      });

      let peakCombo = 1;
      for (let i = 0; i < 6; i++) {
        const t = await harness.waitForSimTicks(6);
        const hud = await harness.readGameFeelDomState();
        peakCombo = Math.max(peakCombo, t.comboMultiplier, hud.comboMultiplier);
      }

      if (peakCombo <= 1.0) {
        await harness.aimAndStrikeStructure('bomb', {
          preferSide: 'left',
          heightFraction: 0.22,
          settleTicks: 8,
          maxAttempts: 1,
        });
        const tExtra = await harness.getTelemetry();
        const hudExtra = await harness.readGameFeelDomState();
        peakCombo = Math.max(peakCombo, tExtra.comboMultiplier, hudExtra.comboMultiplier);
      }

      return peakCombo;
    };

    // 1. Запускаем цепное обрушение и проверяем мгновенное обнуление всех индикаторов при #scene-reset-btn
    const peakCombo1 = await triggerCascadeWithCombo();
    const beforeResetTel = await harness.getTelemetry();
    const beforeResetHud = await harness.readGameFeelDomState();

    expect(peakCombo1).toBeGreaterThan(1.0);
    expect(beforeResetTel.collapsedMassTons).toBeGreaterThan(0);
    expect(beforeResetHud.collapsedTons).toBeGreaterThan(0);
    expect(beforeResetTel.destructionScore).toBeGreaterThan(0);
    expect(beforeResetHud.destructionScore).toBeGreaterThan(0);

    const afterResetTel = await harness.resetScene();
    await harness.waitForAnimationFrames(2);
    const afterResetHud = await harness.readGameFeelDomState();

    expect(afterResetHud.comboMultiplier).toBe(1);
    expect(afterResetTel.comboMultiplier).toBe(1);
    expect(afterResetHud.collapsedTons).toBe(0);
    expect(afterResetTel.collapsedMassTons).toBe(0);
    expect(afterResetHud.destructionScore).toBe(0);
    expect(afterResetTel.destructionScore).toBe(0);

    // 2. Повторно набираем комбо > 1 и проверяем естественное затухание комбо в покое при сохранении тоннажа и счёта
    const peakCombo2 = await triggerCascadeWithCombo();
    expect(peakCombo2).toBeGreaterThan(1.0);

    await harness.setTimeScale(2.0);
    await expect
      .poll(
        async () => {
          await harness.waitForSimTime(1.2);
          const curTel = await harness.getTelemetry();
          const curHud = await harness.readGameFeelDomState();
          return curTel.comboMultiplier <= 1.05 && curHud.comboMultiplier <= 1.05;
        },
        {
          timeout: 20_000,
          message: 'Ожидание естественного затухания комбо-множителя к 1x в покое',
        },
      )
      .toBe(true);

    const quietTel = await harness.getTelemetry();
    const quietHud = await harness.readGameFeelDomState();

    expect(quietTel.comboMultiplier).toBeGreaterThanOrEqual(1);
    expect(quietTel.comboMultiplier).toBeLessThanOrEqual(1.05);
    expect(quietTel.comboMultiplier).toBeCloseTo(1, 1);
    expect(quietHud.comboMultiplier).toBeGreaterThanOrEqual(1);
    expect(quietHud.comboMultiplier).toBeLessThanOrEqual(1.05);
    expect(quietHud.comboMultiplier).toBeCloseTo(1, 1);
    expect(quietTel.collapsedMassTons).toBeGreaterThan(0);
    expect(quietHud.collapsedTons).toBeGreaterThan(0);
    expect(quietTel.destructionScore).toBeGreaterThan(0);
    expect(quietHud.destructionScore).toBeGreaterThan(0);

    await harness.setTimeScale(1.0);
  });

  test('[R11][F24][F25] Границы UI Мастерской (#open-workshop-btn / #close-workshop-btn), нулевой отклик счётчиков при clickSkyMiss и валидность шкалы #damage-progress-bar (#star-threshold-1..3)', async ({
    harness,
  }) => {
    await harness.boot({ clearStorage: true });
    await harness.selectContract(1);

    // 1. Границы модального окна Мастерской: закрыто -> открыто -> закрыто
    expect(await harness.isWorkshopModalOpen()).toBe(false);
    await expect(harness.page.locator(SELECTORS.workshopModal)).toHaveAttribute(
      'data-open',
      'false',
    );

    const openedWs = await harness.openWorkshop();
    expect(openedWs.isOpen).toBe(true);
    await expect(harness.page.locator(SELECTORS.workshopModal)).toHaveAttribute(
      'data-open',
      'true',
    );

    await harness.closeWorkshop();
    expect(await harness.isWorkshopModalOpen()).toBe(false);
    await expect(harness.page.locator(SELECTORS.workshopModal)).toHaveAttribute(
      'data-open',
      'false',
    );

    // 2. Проверка шкалы урона и упорядоченности всех 3 порогов звёзд
    for (const thresholdSel of STAR_THRESHOLD_SELECTORS) {
      await expect(harness.page.locator(thresholdSel)).toBeAttached();
    }
    const barState = await harness.readDamageProgressBarState();
    expect(barState.barAttached).toBe(true);
    expect(barState.barVisible).toBe(true);
    expect(barState.thresholdsAttached).toEqual([true, true, true]);
    expect(barState.thresholdPositionsOrValues[0]).toBeLessThanOrEqual(
      barState.thresholdPositionsOrValues[1],
    );
    expect(barState.thresholdPositionsOrValues[1]).toBeLessThanOrEqual(
      barState.thresholdPositionsOrValues[2],
    );
    expect(barState.thresholdPositionsOrValues[2]).toBeGreaterThan(
      barState.thresholdPositionsOrValues[0],
    );
    if (barState.progressNumericValue !== null) {
      expect(barState.progressNumericValue).toBe(0);
    }

    // 3. Три промаха пушкой мимо здания в небо не должны начислять тоннаж, очки или комбо
    await harness.spawnSandboxStructure('tower', { cleanResetFirst: true });
    await harness.selectTool('cannon');
    for (let i = 0; i < 3; i++) {
      await harness.clickSkyMiss({ button: 'left' });
    }
    const afterMissTel = await harness.waitForSimTicks(15);
    const afterMissHud = await harness.readGameFeelDomState();

    expect(afterMissTel.collapsedMassTons).toBe(0);
    expect(afterMissHud.collapsedTons).toBe(0);
    expect(afterMissTel.destructionScore).toBe(0);
    expect(afterMissHud.destructionScore).toBe(0);
    expect(afterMissTel.comboMultiplier).toBe(1);
    expect(afterMissHud.comboMultiplier).toBe(1);
  });
});

test.describe('Уровень 2 — R12: Граничные и негативные сценарии секвенсора C4, критических узлов и интерактивных триггеров', () => {
  test('[R12][F26] Пустой секвенсор C4 (#c4-sequencer-list[data-queue-count="0"]) на старте, при холостом нажатии #detonate-c4-btn и после #scene-reset-btn', async ({
    harness,
  }) => {
    await harness.boot();
    await harness.spawnSandboxStructure('tower', { cleanResetFirst: true });
    await harness.selectTool('c4');

    const seqStart = await harness.readC4SequencerDomState();
    const telStart = await harness.getTelemetry();
    expect(seqStart.panelAttached).toBe(true);
    expect(seqStart.listAttached).toBe(true);
    expect(seqStart.queueCountAttr).toBe(0);
    expect(telStart.c4SequenceQueue).toEqual([]);
    await expect(harness.page.locator(SELECTORS.appRoot)).toHaveAttribute('data-planted-c4', '0');

    // Три холостых нажатия детонатора и промах ПКМ в небо при пустом секвенсоре
    for (let i = 0; i < 3; i++) {
      await harness.clickOrVerifyDisabled(SELECTORS.detonateC4Btn);
    }
    await harness.clickSkyMiss({ button: 'right' });

    const telAfterIdle = await harness.waitForSimTicks(10);
    const seqAfterIdle = await harness.readC4SequencerDomState();
    expect(seqAfterIdle.queueCountAttr).toBe(0);
    expect(telAfterIdle.c4SequenceQueue).toEqual([]);
    expect(telAfterIdle.brokenJointCount).toBe(0);

    // Заполняем очередь двумя зарядами и проверяем её полную очистку кнопкой #scene-reset-btn
    const planted = await harness.plantC4OnStructure({
      count: 2,
      delaySec: 0.25,
      heightFraction: 0.18,
    });
    expect(planted.totalPlanted).toBe(2);
    expect((await harness.readC4SequencerDomState()).queueCountAttr).toBe(2);

    const telAfterReset = await harness.resetScene();
    const seqAfterReset = await harness.readC4SequencerDomState();
    await expect(harness.page.locator(SELECTORS.appRoot)).toHaveAttribute('data-planted-c4', '0');
    expect(seqAfterReset.queueCountAttr).toBe(0);
    expect(telAfterReset.c4SequenceQueue).toEqual([]);
  });

  test('[R12][F18][F26] Снятие отдельных зарядов C4 правой кнопкой мыши: синхронное удаление записи из #c4-sequencer-list и c4SequenceQueue с сохранением задержек остальных зарядов', async ({
    harness,
  }) => {
    await harness.boot();
    await harness.spawnSandboxStructure('tower', { cleanResetFirst: true });
    await harness.setPaused(true);

    const c1 = await harness.plantC4OnStructure({
      count: 1,
      delaySec: 0,
      preferSide: 'left',
      heightFraction: 0.14,
    });
    const c2 = await harness.plantC4OnStructure({
      count: 1,
      delaySec: 0.25,
      preferSide: 'center',
      heightFraction: 0.3,
    });
    const c3 = await harness.plantC4OnStructure({
      count: 1,
      delaySec: 0.5,
      preferSide: 'right',
      heightFraction: 0.14,
    });

    expect(c1.plantedNow).toBe(1);
    expect(c2.plantedNow).toBe(1);
    expect(c3.plantedNow).toBe(1);

    await expect(harness.page.locator(SELECTORS.appRoot)).toHaveAttribute('data-planted-c4', '3');
    const seqBefore = await harness.readC4SequencerDomState();
    const queueBefore = (await harness.getTelemetry()).c4SequenceQueue;
    expect(seqBefore.queueCountAttr).toBe(3);
    expect(seqBefore.renderedItemCount).toBe(3);
    expect(queueBefore.length).toBe(3);

    const firstEntry = queueBefore[0];
    const middleEntry = queueBefore[1];
    const lastEntry = queueBefore[2];

    // Снимаем средний заряд правой кнопкой мыши
    const removedMiddle = await harness.removeC4AtHit(c2.hits[0]);
    expect(removedMiddle).toBe(true);

    await expect(harness.page.locator(SELECTORS.appRoot)).toHaveAttribute('data-planted-c4', '2');
    const seqAfterMiddle = await harness.readC4SequencerDomState();
    const queueAfterMiddle = (await harness.getTelemetry()).c4SequenceQueue;

    expect(seqAfterMiddle.queueCountAttr).toBe(2);
    expect(seqAfterMiddle.renderedItemCount).toBe(2);
    expect(queueAfterMiddle.length).toBe(2);
    expect(new Set(queueAfterMiddle.map((item) => item.chargeId)).size).toBe(2);
    expect(queueAfterMiddle.some((item) => item.chargeId === middleEntry.chargeId)).toBe(false);

    const keptFirst = queueAfterMiddle.find((item) => item.chargeId === firstEntry.chargeId);
    const keptLast = queueAfterMiddle.find((item) => item.chargeId === lastEntry.chargeId);
    expect(keptFirst).toBeDefined();
    expect(keptLast).toBeDefined();
    expect(keptFirst!.delaySec).toBeCloseTo(firstEntry.delaySec, 2);
    expect(keptLast!.delaySec).toBeCloseTo(lastEntry.delaySec, 2);

    // Снимаем оставшиеся два заряда до полного опустошения секвенсора
    expect(await harness.removeC4AtHit(c1.hits[0])).toBe(true);
    expect(await harness.removeC4AtHit(c3.hits[0])).toBe(true);

    await expect(harness.page.locator(SELECTORS.appRoot)).toHaveAttribute('data-planted-c4', '0');
    expect((await harness.readC4SequencerDomState()).queueCountAttr).toBe(0);
    expect((await harness.getTelemetry()).c4SequenceQueue.length).toBe(0);
  });

  test('[R12][F18][F26] Граничные тайминги секвенсора C4 (0.00 с мгновенный vs максимальная задержка >= 0.50..1.00 с) и редактирование задержки без дублирования очереди', async ({
    harness,
  }) => {
    await harness.boot();
    await harness.setAutoSlowmo(false);
    await harness.spawnSandboxStructure('viaduct', { cleanResetFirst: true });
    await harness.setPaused(true);

    await harness.selectTool('c4');
    const delayOpts = await harness.listSelectOptions(SELECTORS.c4DelaySelect);
    const numericDelays = delayOpts
      .map((o) => o.numericValue)
      .filter((v): v is number => v !== null && Number.isFinite(v));
    expect(numericDelays.length).toBeGreaterThanOrEqual(2);

    const minDelay = Math.min(...numericDelays);
    const maxDelay = Math.max(...numericDelays);
    expect(minDelay).toBeCloseTo(0, 3);
    expect(maxDelay).toBeGreaterThanOrEqual(0.5);

    // Заряд A на левой опоре (0.00 с) и Заряд B на дальней правой опоре (maxDelay)
    const chargeA = await harness.plantC4OnStructure({
      count: 1,
      delaySec: 0,
      preferSide: 'left',
      heightFraction: 0.18,
    });
    const chargeB = await harness.plantC4OnStructure({
      count: 1,
      delaySec: maxDelay,
      preferSide: 'right',
      heightFraction: 0.18,
    });
    expect(chargeA.plantedNow).toBe(1);
    expect(chargeB.plantedNow).toBe(1);

    const seqInitial = await harness.readC4SequencerDomState();
    const queueInitial = (await harness.getTelemetry()).c4SequenceQueue;
    expect(seqInitial.queueCountAttr).toBe(2);
    expect(queueInitial.length).toBe(2);
    expect(queueInitial.some((c) => c.delaySec === 0)).toBe(true);
    expect(queueInitial.some((c) => c.delaySec >= 0.5)).toBe(true);

    // Редактируем задержку второго заряда туда-обратно через UI секвенсора и проверяем отсутствие дубликатов
    await harness.updateC4SequencerItemDelay(1, 0.25);
    expect((await harness.readC4SequencerDomState()).queueCountAttr).toBe(2);
    expect((await harness.getTelemetry()).c4SequenceQueue.length).toBe(2);

    await harness.updateC4SequencerItemDelay(1, maxDelay);
    const queueAfterEdit = (await harness.getTelemetry()).c4SequenceQueue;
    expect((await harness.readC4SequencerDomState()).queueCountAttr).toBe(2);
    expect(queueAfterEdit.length).toBe(2);
    expect(new Set(queueAfterEdit.map((c) => c.chargeId)).size).toBe(2);

    const effectiveMaxDelay = Math.max(0.5, queueAfterEdit[1]?.delaySec ?? maxDelay);

    // Запускаем каскад: через 4 тика (~0.067 с) мгновенный заряд A уже сработал, а заряд B ещё ждёт
    await harness.setPaused(false);
    await harness.page.locator(SELECTORS.detonateC4Btn).click();

    const earlyTel = await harness.waitForSimTicks(4);
    const earlyPlanted = await harness.getPlantedC4Count();
    expect(
      earlyTel.brokenJointCount > 0 ||
        earlyTel.activeShardCount > 0 ||
        earlyTel.kineticEnergyKJ > 0 ||
        earlyPlanted === 1,
    ).toBe(true);
    expect(earlyPlanted >= 1 || earlyTel.c4SequenceQueue.length >= 1).toBe(true);

    // По истечении полной задержки срабатывает и второй заряд, очередь полностью очищается
    const finalTel = await harness.waitForSimTime(effectiveMaxDelay + 0.45);
    await expect(harness.page.locator(SELECTORS.appRoot)).toHaveAttribute('data-planted-c4', '0');
    expect((await harness.readC4SequencerDomState()).queueCountAttr).toBe(0);
    expect(finalTel.c4SequenceQueue.length).toBe(0);
    expect(finalTel.brokenJointCount).toBeGreaterThan(0);
  });

  test('[R12][F12][F26] Сброс сцены (#scene-reset-btn) во время активного обратного отсчёта задержанных зарядов секвенсора C4: отсутствие «фантомного взрыва» на новой сцене', async ({
    harness,
  }) => {
    await harness.boot();
    await harness.setAutoSlowmo(false);
    await harness.spawnSandboxStructure('tower', { cleanResetFirst: true });

    await harness.selectTool('c4');
    const delayOpts = await harness.listSelectOptions(SELECTORS.c4DelaySelect);
    const maxDelay = delayOpts.reduce(
      (acc, cur) => Math.max(acc, cur.numericValue ?? 0),
      0.5,
    );
    expect(maxDelay).toBeGreaterThanOrEqual(0.5);

    const planted = await harness.plantC4OnStructure({
      count: 2,
      delaySec: maxDelay,
      heightFraction: 0.18,
    });
    expect(planted.totalPlanted).toBe(2);
    expect((await harness.readC4SequencerDomState()).queueCountAttr).toBe(2);

    // Вооружаем заряды, ждём всего 2 тика обратного отсчёта и немедленно сбрасываем сцену
    await harness.setPaused(false);
    await harness.page.locator(SELECTORS.detonateC4Btn).click();
    await harness.waitForSimTicks(2);

    const afterReset = await harness.resetScene();
    await expect(harness.page.locator(SELECTORS.appRoot)).toHaveAttribute('data-planted-c4', '0');
    expect((await harness.readC4SequencerDomState()).queueCountAttr).toBe(0);
    expect(afterReset.c4SequenceQueue.length).toBe(0);

    // Ждём заведомо дольше старой задержки C4 на чистой сцене: никаких «фантомных» подрывов быть не должно
    const afterFullTimeout = await harness.waitForSimTime(maxDelay + 0.7);
    expect(afterFullTimeout.intactBlockCount).toBe(afterFullTimeout.initialBlockCount);
    expect(afterFullTimeout.destructionPct).toBe(0);
    expect(afterFullTimeout.brokenJointCount).toBe(0);
    expect(afterFullTimeout.activeShardCount).toBe(0);
    expect(afterFullTimeout.detonatedExplosivesCount).toBe(0);
  });

  test('[R12][F09][F26] Статическая устойчивость интерактивных объектов-триггеров (activeTriggersCount > 0) в полном покое до внешнего импульса', async ({
    harness,
  }) => {
    await harness.boot({ clearStorage: true });
    await harness.setAutoSlowmo(false);

    let triggersInitial = 0;

    for (const bp of ['hangar', 'warehouse', 'domino', 'tower', 'fortress', 'viaduct'] as const) {
      const { after } = await harness.spawnSandboxStructure(bp, { cleanResetFirst: true });
      if (after.activeTriggersCount > 0) {
        triggersInitial = after.activeTriggersCount;
        break;
      }
    }

    if (triggersInitial === 0) {
      for (const contractIdx of [4, 2, 5, 6, 8, 1, 3, 7] as const) {
        const t = await harness.selectContract(contractIdx);
        if (t.activeTriggersCount > 0) {
          triggersInitial = t.activeTriggersCount;
          break;
        }
      }
    }

    expect(Number.isInteger(triggersInitial)).toBe(true);
    expect(triggersInitial).toBeGreaterThan(0);

    // Прогоняем 60 тиков (1.0 с реальной физики) без единого воздействия игрока
    const afterRest = await harness.waitForSimTicks(60);

    expect(afterRest.intactBlockCount).toBe(afterRest.initialBlockCount);
    expect(afterRest.destructionPct).toBe(0);
    expect(afterRest.brokenJointCount).toBe(0);
    expect(afterRest.detonatedExplosivesCount).toBe(0);
    expect(afterRest.secondaryImpactsCount).toBe(0);
    expect(afterRest.activeTriggersCount).toBe(triggersInitial);
  });

  test('[R12][F05][F14][F26] Границы разведки критических несущих опор (criticalNodesCount) в режиме X-Ray: от целого каркаса до полного сноса без NaN и выхода за intactBlockCount', async ({
    harness,
  }) => {
    await harness.boot();
    await harness.setAutoSlowmo(false);
    await harness.spawnSandboxStructure('tower', { cleanResetFirst: true });

    await harness.setRenderViewMode('xray');
    const tIntact = await harness.waitForSimTicks(15);

    expect(Number.isInteger(tIntact.criticalNodesCount)).toBe(true);
    expect(tIntact.criticalNodesCount).toBeGreaterThan(0);
    expect(tIntact.criticalNodesCount).toBeLessThanOrEqual(tIntact.intactBlockCount);

    // Массированный снос основания при активном рентген-режиме X-Ray
    await harness.setSandboxUpgradeLevel(5);
    const planted = await harness.plantC4OnStructure({
      count: 3,
      delaySec: 0,
      heightFraction: 0.14,
    });
    if (planted.totalPlanted > 0) {
      await harness.detonateC4AndSettle(25);
    }

    for (let strikeIdx = 0; strikeIdx < 3; strikeIdx++) {
      await harness.aimAndStrikeStructure('bomb', {
        heightFraction: 0.14,
        settleTicks: 25,
        maxAttempts: 1,
      });
    }

    const tDemolished = await harness.waitForSimTicks(20);
    expect(tDemolished.destructionPct).toBeGreaterThan(20);
    expect(Number.isInteger(tDemolished.criticalNodesCount)).toBe(true);
    expect(tDemolished.criticalNodesCount).toBeGreaterThanOrEqual(0);
    expect(tDemolished.criticalNodesCount).toBeLessThanOrEqual(tDemolished.intactBlockCount);

    const glHealth = await harness.verifyWebGL2Context();
    expect(glHealth.contextLost).toBe(false);
  });
});
