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

const UPGRADE_BUTTON_MAP: Record<ToolId, string> = {
  cannon: EXT_SELECTORS.upgradeCannonBtn,
  c4: EXT_SELECTORS.upgradeC4Btn,
  bomb: EXT_SELECTORS.upgradeBombBtn,
  cutter: EXT_SELECTORS.upgradeCutterBtn,
  incendiary: EXT_SELECTORS.upgradeIncendiaryBtn,
  seismic: EXT_SELECTORS.upgradeSeismicBtn,
};

const ALL_TOOLS: ReadonlyArray<ToolId> = [
  'c4',
  'cannon',
  'bomb',
  'cutter',
  'incendiary',
  'seismic',
];

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

async function readSortedStorageEntries(
  harness: ShatterpointHarness,
): Promise<Array<[string, string]>> {
  return await harness.page.evaluate(() => {
    const entries: Array<[string, string]> = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (key !== null) {
        entries.push([key, window.localStorage.getItem(key) ?? '']);
      }
    }
    entries.sort((a, b) => a[0].localeCompare(b[0]));
    return entries;
  });
}

interface ElementDomSnapshot {
  text: string;
  html: string;
  cls: string;
  attrs: Array<[string, string]>;
}

async function readElementSnapshot(
  harness: ShatterpointHarness,
  selector: string,
): Promise<ElementDomSnapshot> {
  const loc = harness.page.locator(selector);
  await expect(loc).toBeAttached();
  return await loc.evaluate((el: Element): ElementDomSnapshot => ({
    text: (el.textContent ?? '').trim(),
    html: el.innerHTML,
    cls: el.className,
    attrs: Array.from(el.attributes)
      .map((a) => [a.name, a.value] as [string, string])
      .sort((a, b) => a[0].localeCompare(b[0])),
  }));
}

interface UpgradeButtonState {
  tool: ToolId;
  selector: string;
  level: number;
  cost: number;
  disabled: boolean;
}

async function readAllWorkshopUpgrades(
  harness: ShatterpointHarness,
): Promise<UpgradeButtonState[]> {
  const result: UpgradeButtonState[] = [];
  for (const tool of ALL_TOOLS) {
    const selector = UPGRADE_BUTTON_MAP[tool];
    const btn = harness.page.locator(selector);
    await expect(btn).toBeVisible();
    const level = await readFiniteDataAttr(harness, selector, 'data-level');
    const cost = await readFiniteDataAttr(harness, selector, 'data-cost');
    const disabled = await btn.evaluate((el: Element) => {
      if ((el as HTMLButtonElement).disabled) return true;
      if (el.getAttribute('aria-disabled') === 'true') return true;
      if (el.getAttribute('data-disabled') === 'true') return true;
      return false;
    });
    result.push({ tool, selector, level, cost, disabled });
  }
  return result;
}

async function winContractCleanly(
  harness: ShatterpointHarness,
  contractIdx: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8,
): Promise<void> {
  await harness.selectContract(contractIdx);
  await harness.completeContractTargetDemolition();
  await expect
    .poll(async () => (await harness.readMissionDomState()).missionStatus, {
      timeout: 14_000,
      message: `Ожидание победного завершения контракта №${contractIdx}`,
    })
    .toBe('victory');
}

test.describe.configure({ timeout: 90_000 });

test.describe('Уровень 4 — Пользовательские сессии: карьера инженера-подрывника, экономика Мастерской и сохранение прогресса', () => {
  test('[Tier4][R08][R10][R11][R12][F19][F24][F25][F26] Сквозная карьера инженера: разведка X-Ray критических опор → каскадный секвенсор C4 → чистая победа без collateral → заработок кредитов → прокачка в Мастерской → сохранение звёзд, кредитов и уровней в localStorage после page.reload()', async ({
    harness,
  }) => {
    await harness.boot({ clearStorage: true });
    await setAutoSlowmo(harness, false);
    await harness.switchMode('campaign');

    const cleanStorageJson = JSON.stringify(await readSortedStorageEntries(harness));
    const cleanCard01Json = JSON.stringify(await readElementSnapshot(harness, SELECTORS.contract01));

    const credits0 = await readFiniteDataAttr(harness, EXT_SELECTORS.walletCredits, 'data-value');
    const t0 = await readExtTelemetry(harness);
    expect(t0.walletCredits).toBe(credits0);
    for (const tool of ALL_TOOLS) {
      expect(t0.toolLevels?.[tool]).toBe(1);
    }

    // Шаг 1: выбираем #contract-01, проверяем шкалу порогов 1–3 звёзд и разведку критических узлов в X-Ray
    await harness.selectContract(1);
    await expect(harness.page.locator(EXT_SELECTORS.damageProgressBar)).toBeVisible();
    await expect(harness.page.locator(EXT_SELECTORS.starThreshold1)).toBeAttached();
    await expect(harness.page.locator(EXT_SELECTORS.starThreshold2)).toBeAttached();
    await expect(harness.page.locator(EXT_SELECTORS.starThreshold3)).toBeAttached();

    await harness.setRenderViewMode('xray');
    const xrayStart = await readExtTelemetry(harness);
    expect(typeof xrayStart.criticalNodesCount).toBe('number');
    expect(xrayStart.criticalNodesCount!).toBeGreaterThan(0);
    expect(xrayStart.collateralPct).toBe(0);

    // Шаг 2: каскадный секвенсор C4 по долям секунды + полное победное завершение контракта
    const tools01 = await harness.getAvailableTools();
    if (tools01.includes('c4')) {
      const c1 = await harness.plantC4OnStructure({
        count: 1,
        delaySec: 0,
        preferSide: 'center',
        heightFraction: 0.14,
      });
      const c2 = await harness.plantC4OnStructure({
        count: 1,
        delaySec: 0.25,
        preferSide: 'center',
        heightFraction: 0.2,
      });
      expect(c1.plantedNow + c2.plantedNow).toBeGreaterThanOrEqual(2);

      const qCount = await readFiniteDataAttr(
        harness,
        EXT_SELECTORS.c4SequencerList,
        'data-queue-count',
      );
      expect(qCount).toBeGreaterThanOrEqual(2);

      await harness.page.locator(SELECTORS.detonateC4Btn).click();
      await harness.waitForSimTime(0.85);
    }

    await harness.completeContractTargetDemolition();
    await expect
      .poll(async () => (await harness.readMissionDomState()).missionStatus, {
        timeout: 14_000,
      })
      .toBe('victory');

    const winDom = await harness.readMissionDomState();
    const winTel = await readExtTelemetry(harness);
    expect(winDom.failReason).toBe('none');
    expect(winDom.collateralPct).toBe(0);
    expect(winDom.starsAttr).toBeGreaterThanOrEqual(1);
    expect(winTel.collapsedMassTons!).toBeGreaterThan(0);

    // Шаг 3: проверяем начисление кредитов и открываем Мастерскую улучшений
    let creditsBeforeUpgrade = await readFiniteDataAttr(
      harness,
      EXT_SELECTORS.walletCredits,
      'data-value',
    );
    expect(creditsBeforeUpgrade).toBeGreaterThan(credits0);
    expect(winTel.walletCredits).toBe(creditsBeforeUpgrade);

    const workshopModal = harness.page.locator(EXT_SELECTORS.workshopModal);
    await harness.page.locator(EXT_SELECTORS.openWorkshopBtn).click();
    await expect(workshopModal).toHaveAttribute('data-open', 'true');

    let upgrades = await readAllWorkshopUpgrades(harness);
    const minCost = Math.min(...upgrades.map((u) => u.cost));

    if (creditsBeforeUpgrade < minCost) {
      await harness.page.locator(EXT_SELECTORS.closeWorkshopBtn).click();
      await expect(workshopModal).toHaveAttribute('data-open', 'false');

      await winContractCleanly(harness, 2);
      creditsBeforeUpgrade = await readFiniteDataAttr(
        harness,
        EXT_SELECTORS.walletCredits,
        'data-value',
      );
      if (creditsBeforeUpgrade < minCost) {
        await winContractCleanly(harness, 3);
        creditsBeforeUpgrade = await readFiniteDataAttr(
          harness,
          EXT_SELECTORS.walletCredits,
          'data-value',
        );
      }

      await harness.page.locator(EXT_SELECTORS.openWorkshopBtn).click();
      await expect(workshopModal).toHaveAttribute('data-open', 'true');
      upgrades = await readAllWorkshopUpgrades(harness);
    }

    const affordable = upgrades.find((u) => u.level === 1 && u.cost <= creditsBeforeUpgrade && !u.disabled);
    expect(affordable).toBeDefined();
    const chosenUpgrade = affordable!;

    await harness.page.locator(chosenUpgrade.selector).click();
    await expect(harness.page.locator(chosenUpgrade.selector)).toHaveAttribute('data-level', '2');

    const savedCredits = await readFiniteDataAttr(
      harness,
      EXT_SELECTORS.walletCredits,
      'data-value',
    );
    const afterUpgradeTel = await readExtTelemetry(harness);
    expect(savedCredits).toBe(creditsBeforeUpgrade - chosenUpgrade.cost);
    expect(afterUpgradeTel.walletCredits).toBe(savedCredits);
    expect(afterUpgradeTel.toolLevels?.[chosenUpgrade.tool]).toBe(2);

    await harness.page.locator(EXT_SELECTORS.closeWorkshopBtn).click();
    await expect(workshopModal).toHaveAttribute('data-open', 'false');

    const storageBeforeReload = await readSortedStorageEntries(harness);
    expect(storageBeforeReload.length).toBeGreaterThan(0);
    expect(JSON.stringify(storageBeforeReload)).not.toBe(cleanStorageJson);

    // Шаг 4: перезагрузка страницы и строгая && проверка сохранения всех слоёв прогресса
    await harness.reloadAndWaitReady();
    await harness.switchMode('campaign');

    await harness.page.locator(EXT_SELECTORS.openWorkshopBtn).click();
    await expect(workshopModal).toHaveAttribute('data-open', 'true');

    const afterStorage = await readSortedStorageEntries(harness);
    const afterStorageJson = JSON.stringify(afterStorage);
    const afterCard01Json = JSON.stringify(
      await readElementSnapshot(harness, SELECTORS.contract01),
    );
    const creditsAfterReloadDom = await readFiniteDataAttr(
      harness,
      EXT_SELECTORS.walletCredits,
      'data-value',
    );
    const telAfterReload = await readExtTelemetry(harness);
    const levelAttrAfterReload = await harness.page
      .locator(chosenUpgrade.selector)
      .getAttribute('data-level');

    const storagePersisted = afterStorage.length > 0 && afterStorageJson !== cleanStorageJson;
    const cardDomPersisted = afterCard01Json !== cleanCard01Json;
    const creditsPersisted =
      creditsAfterReloadDom === savedCredits && telAfterReload.walletCredits === savedCredits;
    const upgradePersisted =
      levelAttrAfterReload === '2' && telAfterReload.toolLevels?.[chosenUpgrade.tool] === 2;

    expect(storagePersisted).toBe(true);
    expect(cardDomPersisted).toBe(true);
    expect(creditsPersisted).toBe(true);
    expect(upgradePersisted).toBe(true);
    expect(storagePersisted && cardDomPersisted && creditsPersisted && upgradePersisted).toBe(true);

    await harness.page.locator(EXT_SELECTORS.closeWorkshopBtn).click();
    await expect(workshopModal).toHaveAttribute('data-open', 'false');
  });

  test('[Tier4][R10][R11][R12][F08][F19][F25][F26] Сценарий провала и реабилитации: поражение из-за сопутствующего ущерба (collateral) → перезапуск контракта → чистый тактический снос через рентген и секвенсор на 2–3 звезды', async ({
    harness,
  }) => {
    await harness.boot({ clearStorage: true });
    await setAutoSlowmo(harness, false);

    // Шаг 1: находим контракт с охраняемой зоной и намеренно вызываем провал по collateral
    let targetContract: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 = 3;
    let defeatTriggered = false;

    for (const candidate of [3, 2, 5, 6, 8, 4] as const) {
      await harness.selectContract(candidate);
      const strike = await harness.strikeProtectedZone({ untilDefeat: true, maxStrikes: 10 });
      const dom = await harness.readMissionDomState();
      if (dom.missionStatus === 'defeat' && dom.failReason === 'collateral') {
        targetContract = candidate;
        defeatTriggered = true;
        break;
      }
      if (strike.collateralDetected && dom.missionStatus === 'defeat') {
        targetContract = candidate;
        defeatTriggered = true;
        break;
      }
    }

    expect(defeatTriggered).toBe(true);

    const defeatDom = await harness.readMissionDomState();
    expect(defeatDom.missionStatus).toBe('defeat');
    expect(defeatDom.failReason).toBe('collateral');
    expect(defeatDom.starsAttr).toBe(0);
    expect(defeatDom.collateralPct).toBeGreaterThan(0);

    // Шаг 2: перезапускаем тот же контракт и проверяем стерильную очистку сцены
    await harness.selectContract(targetContract);
    let restartedDom = await harness.readMissionDomState();
    if (restartedDom.missionStatus === 'defeat' || restartedDom.collateralPct > 0) {
      await harness.resetScene();
      restartedDom = await harness.readMissionDomState();
    }
    const restartedTel = await readExtTelemetry(harness);

    expect(['planning', 'running']).toContain(restartedDom.missionStatus);
    expect(restartedDom.failReason).toBe('none');
    expect(restartedDom.collateralPct).toBe(0);
    expect(restartedTel.destructionPct).toBe(0);
    expect(restartedTel.intactBlockCount).toBe(restartedTel.initialBlockCount);

    // Шаг 3: тактическая разведка Stress -> X-Ray и аккуратный снос строго по центру без задевания соседей
    await harness.setRenderViewMode('stress');
    await harness.setRenderViewMode('xray');
    const xrayTel = await readExtTelemetry(harness);
    expect(xrayTel.criticalNodesCount!).toBeGreaterThan(0);

    const tools = await harness.getAvailableTools();
    if (tools.includes('c4')) {
      await harness.plantC4OnStructure({
        count: 1,
        delaySec: 0,
        preferSide: 'center',
        heightFraction: 0.14,
      });
      await harness.plantC4OnStructure({
        count: 1,
        delaySec: 0.25,
        preferSide: 'center',
        heightFraction: 0.2,
      });
      await harness.page.locator(SELECTORS.detonateC4Btn).click();
      await harness.waitForSimTime(0.9);
    }

    await harness.completeContractTargetDemolition();
    await expect
      .poll(async () => (await harness.readMissionDomState()).missionStatus, {
        timeout: 14_000,
      })
      .toBe('victory');

    const rehabWinDom = await harness.readMissionDomState();
    const rehabCredits = await readFiniteDataAttr(
      harness,
      EXT_SELECTORS.walletCredits,
      'data-value',
    );

    expect(rehabWinDom.missionStatus).toBe('victory');
    expect(rehabWinDom.failReason).toBe('none');
    expect(rehabWinDom.starsAttr).toBeGreaterThanOrEqual(1);
    expect(rehabCredits).toBeGreaterThan(0);
  });

  test('[Tier4][R05][R06][R10][R11][R12][F18][F19][F24][F26] Серия контрактов с закупкой доп. боекомплекта (#buy-extra-ammo-btn), прокачкой спецсредств и использованием триггеров карты', async ({
    harness,
  }) => {
    await harness.boot({ clearStorage: true });
    await setAutoSlowmo(harness, false);
    await harness.switchMode('campaign');

    const cleanStorageJson = JSON.stringify(await readSortedStorageEntries(harness));
    const cleanCard01Json = JSON.stringify(await readElementSnapshot(harness, SELECTORS.contract01));
    const cleanCard02Json = JSON.stringify(await readElementSnapshot(harness, SELECTORS.contract02));

    const creditsStart = await readFiniteDataAttr(
      harness,
      EXT_SELECTORS.walletCredits,
      'data-value',
    );

    // Победное прохождение двух стартовых контрактов серии
    await winContractCleanly(harness, 1);
    const creditsAfter1 = await readFiniteDataAttr(
      harness,
      EXT_SELECTORS.walletCredits,
      'data-value',
    );
    expect(creditsAfter1).toBeGreaterThan(creditsStart);

    await winContractCleanly(harness, 2);
    let creditsPool = await readFiniteDataAttr(harness, EXT_SELECTORS.walletCredits, 'data-value');
    expect(creditsPool).toBeGreaterThan(creditsAfter1);

    // Выбираем следующий контракт с объектами-триггерами перед открытием Мастерской
    let triggerContractIdx: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 = 4;
    for (const candidate of [4, 5, 6, 7, 8, 3] as const) {
      const t = (await harness.selectContract(candidate)) as ExtTelemetry;
      if ((t.activeTriggersCount ?? 0) > 0) {
        triggerContractIdx = candidate;
        break;
      }
    }
    await harness.selectContract(triggerContractIdx);

    // Открываем Мастерскую: прокачиваем инструмент и покупаем доп. боекомплект (#buy-extra-ammo-btn)
    const workshopModal = harness.page.locator(EXT_SELECTORS.workshopModal);
    await harness.page.locator(EXT_SELECTORS.openWorkshopBtn).click();
    await expect(workshopModal).toHaveAttribute('data-open', 'true');

    let upgrades = await readAllWorkshopUpgrades(harness);
    const level1Candidates = upgrades
      .filter((u) => u.level === 1 && Number.isFinite(u.cost) && u.cost >= 0)
      .sort((a, b) => a.cost - b.cost);
    expect(level1Candidates.length).toBeGreaterThan(0);
    const minUpgradeCost = level1Candidates[0].cost;

    if (creditsPool < minUpgradeCost) {
      await harness.closeWorkshop();
      await harness.ensureWalletCreditsViaCampaign(minUpgradeCost);
      await harness.selectContract(triggerContractIdx);
      await harness.openWorkshop();
      creditsPool = await readFiniteDataAttr(
        harness,
        EXT_SELECTORS.walletCredits,
        'data-value',
      );
      upgrades = await readAllWorkshopUpgrades(harness);
    }

    const sortedAffordable = upgrades
      .filter((u) => u.level === 1 && u.cost <= creditsPool && !u.disabled)
      .sort((a, b) => a.cost - b.cost);

    expect(sortedAffordable.length).toBeGreaterThan(0);
    const upgradedItem = sortedAffordable[0];

    await harness.page.locator(upgradedItem.selector).click();
    await expect(harness.page.locator(upgradedItem.selector)).toHaveAttribute('data-level', '2');

    const creditsAfterUpgrade = await readFiniteDataAttr(
      harness,
      EXT_SELECTORS.walletCredits,
      'data-value',
    );
    expect(creditsAfterUpgrade).toBe(creditsPool - upgradedItem.cost);

    await expect(harness.page.locator(SELECTORS.buyExtraAmmoBtn)).toBeVisible();
    let ammoRes = await harness.tryBuyExtraAmmoInWorkshop();
    if (!ammoRes.purchased) {
      await harness.closeWorkshop();
      await winContractCleanly(harness, 3);
      await harness.selectContract(triggerContractIdx);
      await harness.openWorkshop();
      ammoRes = await harness.tryBuyExtraAmmoInWorkshop();
    }
    if (!ammoRes.purchased) {
      const currentCreditsAfterRetry = await harness.readWalletCreditsDom();
      await harness.ensureWalletCreditsViaCampaign(currentCreditsAfterRetry + 500);
      await harness.selectContract(triggerContractIdx);
      await harness.openWorkshop();
      ammoRes = await harness.tryBuyExtraAmmoInWorkshop();
    }
    expect(ammoRes.purchased).toBe(true);

    await harness.page.locator(EXT_SELECTORS.closeWorkshopBtn).click();
    await expect(workshopModal).toHaveAttribute('data-open', 'false');

    // Снос на карте с триггерами и проверка индикаторов Game Feel
    await expect(harness.page.locator(EXT_SELECTORS.damageProgressBar)).toBeVisible();
    await harness.completeContractTargetDemolition();
    await harness.waitForSimTicks(25);

    const hudTons = await readFiniteDataAttr(harness, EXT_SELECTORS.hudCollapsedTons, 'data-value');
    const hudCombo = await readFiniteDataAttr(
      harness,
      EXT_SELECTORS.hudComboBadge,
      'data-multiplier',
    );
    const feedLast =
      (await harness.page.locator(EXT_SELECTORS.tacticalFeed).getAttribute('data-last-event')) ?? '';

    expect(hudTons).toBeGreaterThan(0);
    expect(hudCombo).toBeGreaterThanOrEqual(1);
    expect(feedLast.trim().length).toBeGreaterThan(0);

    const savedFinalCredits = await readFiniteDataAttr(
      harness,
      EXT_SELECTORS.walletCredits,
      'data-value',
    );

    // Финальная проверка персистентности серии контрактов и Мастерской после page.reload()
    await harness.reloadAndWaitReady();
    await harness.switchMode('campaign');
    await harness.page.locator(EXT_SELECTORS.openWorkshopBtn).click();
    await expect(workshopModal).toHaveAttribute('data-open', 'true');

    const reloadedStorage = await readSortedStorageEntries(harness);
    const reloadedCard01Json = JSON.stringify(
      await readElementSnapshot(harness, SELECTORS.contract01),
    );
    const reloadedCard02Json = JSON.stringify(
      await readElementSnapshot(harness, SELECTORS.contract02),
    );
    const reloadedCredits = await readFiniteDataAttr(
      harness,
      EXT_SELECTORS.walletCredits,
      'data-value',
    );
    const reloadedUpgradeLevel = await harness.page
      .locator(upgradedItem.selector)
      .getAttribute('data-level');

    const storageOk =
      reloadedStorage.length > 0 && JSON.stringify(reloadedStorage) !== cleanStorageJson;
    const bothCardsUpdated =
      reloadedCard01Json !== cleanCard01Json && reloadedCard02Json !== cleanCard02Json;
    const creditsAndUpgradeOk =
      reloadedCredits === savedFinalCredits && reloadedUpgradeLevel === '2';

    expect(storageOk).toBe(true);
    expect(bothCardsUpdated).toBe(true);
    expect(creditsAndUpgradeOk).toBe(true);
    expect(storageOk && bothCardsUpdated && creditsAndUpgradeOk).toBe(true);

    await harness.page.locator(EXT_SELECTORS.closeWorkshopBtn).click();
  });

  test('[Tier4][R07][R08][R10][R11][F12][F14][F19][F25] Тактическое планирование на паузе: ревизия опор с вращением камеры, перестановка зарядов ПКМ, авто-слоу-мо разлома и сохранность прогресса при смене режимов', async ({
    harness,
  }) => {
    await harness.boot({ clearStorage: true });
    await harness.switchMode('campaign');

    const cleanCard01Json = JSON.stringify(await readElementSnapshot(harness, SELECTORS.contract01));

    await harness.selectContract(1);
    await harness.setPaused(true);
    await harness.setRenderViewMode('xray');

    const pausedTick = (await readExtTelemetry(harness)).tick;
    const projBefore = await harness.projectWorldPoint(3.0, 2.0, 0);
    await harness.orbitCameraDrag(120, -30);
    const projAfter = await harness.projectWorldPoint(3.0, 2.0, 0);

    expect(Math.hypot(projAfter.x - projBefore.x, projAfter.y - projBefore.y)).toBeGreaterThan(5);
    expect((await readExtTelemetry(harness)).tick).toBe(pausedTick);

    const tools = await harness.getAvailableTools();
    if (tools.includes('c4')) {
      const firstBatch = await harness.plantC4OnStructure({
        count: 2,
        delaySec: 0,
        preferSide: 'center',
        heightFraction: 0.15,
      });
      expect(firstBatch.plantedNow).toBe(2);
      expect(firstBatch.totalPlanted).toBe(2);
      expect((await readExtTelemetry(harness)).tick).toBe(pausedTick);

      const removed = await harness.removeC4AtHit(firstBatch.hits[0]);
      expect(removed).toBe(true);
      expect(await harness.getPlantedC4Count()).toBe(1);

      const secondBatch = await harness.plantC4OnStructure({
        count: 2,
        delaySec: 0.25,
        preferSide: 'center',
        heightFraction: 0.22,
      });
      expect(secondBatch.totalPlanted).toBe(3);
      expect((await readExtTelemetry(harness)).tick).toBe(pausedTick);
    }

    await setAutoSlowmo(harness, true);
    await harness.setPaused(false);

    if ((await harness.getPlantedC4Count()) > 0) {
      await harness.page.locator(SELECTORS.detonateC4Btn).click();
      await harness.waitForSimTime(0.8);
    }

    await harness.completeContractTargetDemolition();
    await expect
      .poll(async () => (await harness.readMissionDomState()).missionStatus, {
        timeout: 14_000,
      })
      .toBe('victory');

    const earnedCredits = await readFiniteDataAttr(
      harness,
      EXT_SELECTORS.walletCredits,
      'data-value',
    );
    expect(earnedCredits).toBeGreaterThan(0);

    // Переключаемся по всем трём режимам и возвращаемся в Кампанию
    await harness.switchMode('sandbox');
    await harness.spawnSandboxStructure('domino', { cleanResetFirst: true });
    await harness.switchMode('lab');
    await harness.selectLabBench('ballistics');
    await harness.switchMode('campaign');

    const creditsAfterNavigation = await readFiniteDataAttr(
      harness,
      EXT_SELECTORS.walletCredits,
      'data-value',
    );
    const telAfterNavigation = await readExtTelemetry(harness);
    const card01AfterNavigationJson = JSON.stringify(
      await readElementSnapshot(harness, SELECTORS.contract01),
    );

    expect(creditsAfterNavigation).toBe(earnedCredits);
    expect(telAfterNavigation.walletCredits).toBe(earnedCredits);
    expect(card01AfterNavigationJson).not.toBe(cleanCard01Json);
  });
});
