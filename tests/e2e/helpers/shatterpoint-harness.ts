import { test as base, expect } from '@playwright/test';
import type { ConsoleMessage, Locator, Page, Request, Response } from '@playwright/test';

// ============================================================================
// 1. АВТОНОМНЫЕ ТИПЫ OPAQUE-BOX КОНТРАКТА (PROJECT.md § Interface Contracts 2, 5)
//    СТРОГО 0 ИМПОРТОВ ИЗ src/** И 0 ЗАВИСИМОСТЕЙ ОТ @types/node
// ============================================================================

export type StructuralMaterialId =
  | 'reinforced_concrete'
  | 'brick'
  | 'glass'
  | 'wood'
  | 'steel'
  | 'explosive';

export type AppMode = 'campaign' | 'sandbox' | 'lab';
export type RenderViewMode = 'pbr' | 'stress' | 'xray';
export type QualityPreset = 'performance' | 'high' | 'ultra';
export type ToolId = 'cannon' | 'c4' | 'bomb' | 'cutter' | 'incendiary' | 'seismic';
export type LabBenchId = 'materials' | 'ballistics' | 'blast' | 'seismic';

export type MissionStatus = 'planning' | 'running' | 'victory' | 'defeat';
export type MissionFailReason = 'none' | 'collateral' | 'budget_exhausted';

export type SandboxBlueprintKey =
  | 'tower'
  | 'viaduct'
  | 'fortress'
  | 'hangar'
  | 'warehouse'
  | 'domino';

export type PhysicsSliderKey =
  | 'gravity'
  | 'jointStrength'
  | 'secondaryDmg'
  | 'blastFalloff'
  | 'fireRate'
  | 'quakeFreqHz'
  | 'quakeAmp';

export interface SimulationTelemetry {
  tick: number;
  simTimeSec: number;
  intactBlockCount: number;
  initialBlockCount: number;
  intactJointCount: number;
  initialJointCount: number;
  brokenJointCount: number;
  activeRebarCount: number;
  snappedRebarCount: number;
  plasticHingeCount: number;
  activeShardCount: number;
  bakedRubbleCount: number;
  burningNodeCount: number;
  maxTemperatureC: number;
  maxStressUtilization: number;
  kineticEnergyKJ: number;
  secondaryImpactsCount: number;
  detonatedExplosivesCount: number;
  destructionPct: number;
  targetMaxHeightM: number;
  protectedDamagePct: number;
  seismicActive: boolean;
  seismicFrequencyHz: number;
  seismicAmplitudeM: number;
  lastStepCpuMs: number;
}

export type ToolUpgradeLevel = 1 | 2 | 3 | 4 | 5;

export interface C4SequenceQueueEntry {
  chargeId: number;
  delaySec: number;
}

export interface E2ETelemetry extends SimulationTelemetry {
  mode: AppMode;
  missionStatus: string;
  collateralPct: number;
  stars: number;
  fps: number;
  drawCalls: number;
  // Поля расширений F24–F26 (PROJECT.md § Interface Contracts 5, строка 389)
  walletCredits: number;
  toolLevels: Record<ToolId, number>;
  collapsedMassTons: number;
  destructionScore: number;
  comboMultiplier: number;
  criticalNodesCount: number;
  c4SequenceQueue: C4SequenceQueueEntry[];
  activeTriggersCount: number;
  // Опциональные диагностические поля
  activeBench?: LabBenchId | null;
  activeContractId?: string | null;
  audioMuted?: boolean;
  audioEventsPlayedCount?: number;
  activeMaterialId?: StructuralMaterialId;
  buildModeActive?: boolean;
  qualityPreset?: QualityPreset;
}

export interface ProjectedWorldPoint {
  x: number;
  y: number;
  visible: boolean;
}

export interface WindowShatterpointBridge {
  getTelemetry(): E2ETelemetry;
  projectWorldPoint(x: number, y: number, z: number): ProjectedWorldPoint;
}

declare global {
  interface Window {
    __SHATTERPOINT__?: WindowShatterpointBridge;
  }
}

/**
 * Чистое побайтовое сравнение буферов (например, PNG-скриншотов #sim-canvas)
 * без использования Node.js Buffer.equals() и без зависимости от @types/node.
 */
export function areByteArraysDifferent(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) {
    return true;
  }
  for (let i = 0; i < a.byteLength; i++) {
    if (a[i] !== b[i]) {
      return true;
    }
  }
  return false;
}

// ============================================================================
// 2. КАНОНИЧЕСКИЕ DOM-СЕЛЕКТОРЫ (PROJECT.md:354-365, все 64 обязательных ID)
// ============================================================================

export const SELECTORS = {
  // Оболочка и режимы (5)
  appRoot: '#app-root',
  simCanvas: '#sim-canvas',
  modeCampaignBtn: '#mode-campaign-btn',
  modeSandboxBtn: '#mode-sandbox-btn',
  modeLabBtn: '#mode-lab-btn',

  // Арсенал: 6 средств + управление C4 (8)
  toolCannon: '#tool-cannon',
  toolC4: '#tool-c4',
  toolBomb: '#tool-bomb',
  toolCutter: '#tool-cutter',
  toolIncendiary: '#tool-incendiary',
  toolSeismic: '#tool-seismic',
  detonateC4Btn: '#detonate-c4-btn',
  c4DelaySelect: '#c4-delay-select',

  // Время, камера, визуализатор, сцена, качество, звук (10)
  timePauseBtn: '#time-pause-btn',
  timeStepBtn: '#time-step-btn',
  timeBulletBtn: '#time-bullet-btn',
  timeScaleSelect: '#time-scale-select',
  viewPbrBtn: '#view-pbr-btn',
  viewStressBtn: '#view-stress-btn',
  viewXrayBtn: '#view-xray-btn',
  sceneResetBtn: '#scene-reset-btn',
  qualitySelect: '#quality-select',
  audioMuteBtn: '#audio-mute-btn',

  // Свободная Песочница и Конструктор достройки (9)
  sandboxSpawnSelect: '#sandbox-spawn-select',
  sandboxSpawnBtn: '#sandbox-spawn-btn',
  sandboxBuildToggle: '#sandbox-build-toggle',
  matReinforcedConcrete: '#mat-reinforced_concrete',
  matGlass: '#mat-glass',
  matWood: '#mat-wood',
  matSteel: '#mat-steel',
  matBrick: '#mat-brick',
  matExplosive: '#mat-explosive',

  // Физическая Лаборатория-полигон: 4 стенда + 7 ползунков + запуск сейсмики (12)
  labBenchMaterials: '#lab-bench-materials',
  labBenchBallistics: '#lab-bench-ballistics',
  labBenchBlast: '#lab-bench-blast',
  labBenchSeismic: '#lab-bench-seismic',
  sliderGravity: '#slider-gravity',
  sliderJointStrength: '#slider-joint-strength',
  sliderSecondaryDmg: '#slider-secondary-dmg',
  sliderBlastFalloff: '#slider-blast-falloff',
  sliderFireRate: '#slider-fire-rate',
  sliderQuakeFreqHz: '#slider-quake-freq-hz',
  sliderQuakeAmp: '#slider-quake-amp',
  btnTriggerQuake: '#btn-trigger-quake',

  // Живая Телеметрия: 7 индикаторов с data-value="<float>" (7)
  telemetryDestructionPct: '#telemetry-destruction-pct',
  telemetryIntactJoints: '#telemetry-intact-joints',
  telemetryRebarLinks: '#telemetry-rebar-links',
  telemetryBurningNodes: '#telemetry-burning-nodes',
  telemetryMaxTempC: '#telemetry-max-temp-c',
  telemetryKineticKj: '#telemetry-kinetic-kj',
  telemetryFps: '#telemetry-fps',

  // Кампания миссий: 8 контрактов + индикаторы + панель результата (13)
  contract01: '#contract-01',
  contract02: '#contract-02',
  contract03: '#contract-03',
  contract04: '#contract-04',
  contract05: '#contract-05',
  contract06: '#contract-06',
  contract07: '#contract-07',
  contract08: '#contract-08',
  missionBudgetRemaining: '#mission-budget-remaining',
  missionTargetProgress: '#mission-target-progress',
  missionCollateralPct: '#mission-collateral-pct',
  missionResultPanel: '#mission-result-panel',
  missionStars: '#mission-stars',

  // Магазин и Мастерская улучшений F24 / R11 (12)
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

  // Game Feel HUD, комбо, лента уведомлений, авто-слоу-мо и пороги звёзд F25 / R11 (9)
  hudCollapsedTons: '#hud-collapsed-tons',
  hudDestructionScore: '#hud-destruction-score',
  hudComboBadge: '#hud-combo-badge',
  tacticalFeed: '#tactical-feed',
  autoSlowmoToggle: '#auto-slowmo-toggle',
  damageProgressBar: '#damage-progress-bar',
  starThreshold1: '#star-threshold-1',
  starThreshold2: '#star-threshold-2',
  starThreshold3: '#star-threshold-3',

  // Программируемый секвенсор каскадного подрыва C4 F26 / R12 (2)
  c4SequencerPanel: '#c4-sequencer-panel',
  c4SequencerList: '#c4-sequencer-list',
} as const;

export const MODE_BUTTON_MAP: Record<AppMode, string> = {
  campaign: SELECTORS.modeCampaignBtn,
  sandbox: SELECTORS.modeSandboxBtn,
  lab: SELECTORS.modeLabBtn,
};

export const TOOL_BUTTON_MAP: Record<ToolId, string> = {
  cannon: SELECTORS.toolCannon,
  c4: SELECTORS.toolC4,
  bomb: SELECTORS.toolBomb,
  cutter: SELECTORS.toolCutter,
  incendiary: SELECTORS.toolIncendiary,
  seismic: SELECTORS.toolSeismic,
};

export const VIEW_BUTTON_MAP: Record<RenderViewMode, string> = {
  pbr: SELECTORS.viewPbrBtn,
  stress: SELECTORS.viewStressBtn,
  xray: SELECTORS.viewXrayBtn,
};

export const MATERIAL_BUTTON_MAP: Record<StructuralMaterialId, string> = {
  reinforced_concrete: SELECTORS.matReinforcedConcrete,
  glass: SELECTORS.matGlass,
  wood: SELECTORS.matWood,
  steel: SELECTORS.matSteel,
  brick: SELECTORS.matBrick,
  explosive: SELECTORS.matExplosive,
};

export const LAB_BENCH_BUTTON_MAP: Record<LabBenchId, string> = {
  materials: SELECTORS.labBenchMaterials,
  ballistics: SELECTORS.labBenchBallistics,
  blast: SELECTORS.labBenchBlast,
  seismic: SELECTORS.labBenchSeismic,
};

export const SLIDER_SELECTOR_MAP: Record<PhysicsSliderKey, string> = {
  gravity: SELECTORS.sliderGravity,
  jointStrength: SELECTORS.sliderJointStrength,
  secondaryDmg: SELECTORS.sliderSecondaryDmg,
  blastFalloff: SELECTORS.sliderBlastFalloff,
  fireRate: SELECTORS.sliderFireRate,
  quakeFreqHz: SELECTORS.sliderQuakeFreqHz,
  quakeAmp: SELECTORS.sliderQuakeAmp,
};

export const CONTRACT_SELECTORS = [
  SELECTORS.contract01,
  SELECTORS.contract02,
  SELECTORS.contract03,
  SELECTORS.contract04,
  SELECTORS.contract05,
  SELECTORS.contract06,
  SELECTORS.contract07,
  SELECTORS.contract08,
] as const;

export const UPGRADE_BUTTON_MAP: Record<ToolId, string> = {
  cannon: SELECTORS.upgradeCannonBtn,
  c4: SELECTORS.upgradeC4Btn,
  bomb: SELECTORS.upgradeBombBtn,
  cutter: SELECTORS.upgradeCutterBtn,
  incendiary: SELECTORS.upgradeIncendiaryBtn,
  seismic: SELECTORS.upgradeSeismicBtn,
};

export const STAR_THRESHOLD_SELECTORS = [
  SELECTORS.starThreshold1,
  SELECTORS.starThreshold2,
  SELECTORS.starThreshold3,
] as const;

const SANDBOX_BLUEPRINT_KEYWORDS: Record<
  SandboxBlueprintKey,
  { fallbackIndex: number; patterns: string[] }
> = {
  tower: {
    fallbackIndex: 0,
    patterns: ['башн', 'высот', 'небоскр', 'монолит', 'жб', 'tower', 'highrise', 'concrete'],
  },
  viaduct: {
    fallbackIndex: 1,
    patterns: ['виадук', 'мост', 'ароч', 'арк', 'viaduct', 'bridge', 'arch'],
  },
  fortress: {
    fallbackIndex: 2,
    patterns: ['крепост', 'кирпич', 'цитадел', 'замок', 'fortress', 'brick', 'castle'],
  },
  hangar: {
    fallbackIndex: 3,
    patterns: ['ангар', 'промышл', 'ферм', 'стальн', 'цех', 'hangar', 'industrial', 'steel'],
  },
  warehouse: {
    fallbackIndex: 4,
    patterns: ['склад', 'дерев', 'терем', 'пакгауз', 'брус', 'warehouse', 'wood', 'timber'],
  },
  domino: {
    fallbackIndex: 5,
    patterns: ['домино', 'каскад', 'плит', 'domino', 'cascade'],
  },
};

const QUALITY_PRESET_KEYWORDS: Record<
  QualityPreset,
  { fallbackIndex: number; patterns: string[] }
> = {
  performance: {
    fallbackIndex: 0,
    patterns: ['performance', 'производит', 'быстр', 'низк', 'low', 'fast'],
  },
  high: {
    fallbackIndex: 1,
    patterns: ['high', 'высок', 'стандарт', 'средн', 'medium'],
  },
  ultra: {
    fallbackIndex: 2,
    patterns: ['ultra', 'ультра', 'макс', 'кинематограф', 'max'],
  },
};

// ============================================================================
// 3. ВСПОМОГАТЕЛЬНЫЕ ИНТЕРФЕЙСЫ СОСТОЯНИЯ ДРАЙВЕРА
// ============================================================================

export interface CapturedRuntimeError {
  kind: 'pageerror' | 'console.error' | 'network';
  message: string;
  location?: string;
  timestampMs: number;
}

export interface BootOptions {
  url?: string;
  /** По умолчанию 'performance' для стабильной скорости на SwiftShader; передайте null для сохранения дефолтного пресета */
  preset?: QualityPreset | null;
  /** Если true, очищает localStorage перед инициализацией приложения */
  clearStorage?: boolean;
  timeoutMs?: number;
}

export interface SpawnSandboxOptions {
  /**
   * Если true (по умолчанию), очищает/сбрасывает сцену перед спавном одиночного сооружения.
   * Если false, добавляет сооружение рядом на полигон поверх существующих (мульти-спавн).
   */
  cleanResetFirst?: boolean;
}

export interface WebGL2HealthReport {
  hasCanvas: boolean;
  hasWebGL2: boolean;
  contextLost: boolean;
  version: string;
  shadingLanguageVersion: string;
  renderer: string;
  drawingBufferWidth: number;
  drawingBufferHeight: number;
  drawCalls: number;
}

export interface DomSelectOption {
  index: number;
  value: string;
  label: string;
  numericValue: number | null;
}

export interface SliderApplyResult {
  appliedValue: number;
  min: number;
  max: number;
  step: number;
}

export interface AppRootDomState {
  ready: boolean;
  activeMode: AppMode;
  paused: boolean;
  timeScale: number;
  renderMode: RenderViewMode;
  simTick: number;
  activeTool: string;
  plantedC4: number;
  autoSlowmo: boolean;
}

export interface TelemetryDomSnapshot {
  destructionPct: number;
  intactJoints: number;
  rebarLinks: number;
  burningNodes: number;
  maxTempC: number;
  kineticKj: number;
  fps: number;
}

export interface MissionDomSnapshot {
  budgetRemaining: number;
  targetProgress: number;
  collateralPct: number;
  missionStatus: MissionStatus;
  failReason: MissionFailReason;
  starsAttr: number;
  starsText: string;
  resultPanelVisible: boolean;
}

export interface ConfirmedCanvasHit {
  world: [number, number, number];
  screen: { x: number; y: number };
}

export interface PlantC4Options {
  count?: number;
  delaySec?: number;
  heightFraction?: number;
  preferSide?: 'left' | 'right' | 'center' | 'any';
  customWorldCandidates?: Array<[number, number, number]>;
}

export interface PlantC4Result {
  plantedNow: number;
  totalPlanted: number;
  appliedDelaySec: number | null;
  hits: ConfirmedCanvasHit[];
}

export interface StrikeStructureOptions {
  worldPoint?: [number, number, number];
  preferSide?: 'left' | 'right' | 'center' | 'any';
  heightFraction?: number;
  holdMs?: number;
  settleTicks?: number;
  maxAttempts?: number;
  keepPaused?: boolean;
  requireBurning?: boolean;
  requirePlasticHinge?: boolean;
  searchFullPolygon?: boolean;
}

export interface StrikeStructureResult {
  impactConfirmed: boolean;
  attempts: number;
  usedPoint: ConfirmedCanvasHit | null;
  before: E2ETelemetry;
  after: E2ETelemetry;
}

export interface UiAuditReport {
  hasCyrillicText: boolean;
  cyrillicSample: string;
  hasMalformedTokens: boolean;
  malformedMatches: string[];
  rootBgLuminance: number;
  purpleViolations: Array<{
    selectorHint: string;
    property: string;
    color: string;
    hueDeg: number;
  }>;
}

export interface WorkshopToolUpgradeState {
  tool: ToolId;
  level: number;
  cost: number;
  disabled: boolean;
  label: string;
}

export interface WorkshopDomSnapshot {
  isOpen: boolean;
  modalVisible: boolean;
  walletCredits: number;
  buyExtraAmmoDisabled: boolean;
  upgrades: Record<ToolId, WorkshopToolUpgradeState>;
}

export interface UpgradeToolAttemptResult {
  tool: ToolId;
  wasDisabled: boolean;
  upgraded: boolean;
  levelBefore: number;
  levelAfter: number;
  costBefore: number;
  creditsBefore: number;
  creditsAfter: number;
}

export interface BuyExtraAmmoResult {
  wasDisabled: boolean;
  purchased: boolean;
  creditsBefore: number;
  creditsAfter: number;
  budgetBefore: number;
  budgetAfter: number;
}

export interface GameFeelDomSnapshot {
  collapsedTons: number;
  destructionScore: number;
  comboMultiplier: number;
  tacticalFeedLastEvent: string;
  tacticalFeedText: string;
  autoSlowmoEnabled: boolean;
}

export interface DamageProgressBarSnapshot {
  barAttached: boolean;
  barVisible: boolean;
  progressNumericValue: number | null;
  thresholdsAttached: [boolean, boolean, boolean];
  thresholdsVisible: [boolean, boolean, boolean];
  thresholdPositionsOrValues: [number, number, number];
}

export interface C4SequencerDomSnapshot {
  panelAttached: boolean;
  panelVisible: boolean;
  listAttached: boolean;
  queueCountAttr: number;
  renderedItemCount: number;
  listText: string;
}

export interface UpdateC4SequencerDelayResult {
  updated: boolean;
  beforeQueue: C4SequenceQueueEntry[];
  afterQueue: C4SequenceQueueEntry[];
}

// ============================================================================
// 4. ОСНОВНОЙ КЛАСС ДРАЙВЕРА ЧЁРНОГО ЯЩИКА SHATTERPOINT HARNESS
// ============================================================================

export class ShatterpointHarness {
  public readonly page: Page;
  private readonly runtimeErrors: CapturedRuntimeError[] = [];
  private autoAssertZeroErrors = true;
  private lastConfirmedHit: ConfirmedCanvasHit | null = null;
  private buildModeToggledByHarness = false;
  private sandboxPaletteDynamic: boolean | null = null;
  private defaultSandboxIndex0Sig: {
    blocks: number;
    joints: number;
    heightM: number;
  } | null = null;

  constructor(page: Page) {
    this.page = page;

    this.page.on('pageerror', (err: Error) => {
      this.runtimeErrors.push({
        kind: 'pageerror',
        message: err.stack || err.message || String(err),
        timestampMs: Date.now(),
      });
    });

    this.page.on('console', (msg: ConsoleMessage) => {
      if (msg.type() === 'error') {
        const text = msg.text();
        if (text.includes('favicon.ico')) {
          return;
        }
        const loc = msg.location();
        const locationStr = loc?.url
          ? `${loc.url}:${loc.lineNumber ?? 0}:${loc.columnNumber ?? 0}`
          : undefined;
        this.runtimeErrors.push({
          kind: 'console.error',
          message: text,
          location: locationStr,
          timestampMs: Date.now(),
        });
      }
    });

    this.page.on('requestfailed', (req: Request) => {
      const url = req.url();
      const failure = req.failure()?.errorText ?? 'unknown';
      if (url.includes('favicon.ico') || failure.includes('ERR_ABORTED')) {
        return;
      }
      this.runtimeErrors.push({
        kind: 'network',
        message: `Сбой загрузки ресурса ${url}: ${failure}`,
        timestampMs: Date.now(),
      });
    });

    this.page.on('response', (res: Response) => {
      const url = res.url();
      const status = res.status();
      if (status >= 400 && !url.includes('favicon.ico')) {
        this.runtimeErrors.push({
          kind: 'network',
          message: `HTTP ${status} при загрузке ${url}`,
          timestampMs: Date.now(),
        });
      }
    });
  }

  // --------------------------------------------------------------------------
  // 4.1. Контроль ошибок runtime / консоли и проверка живого WebGL2
  // --------------------------------------------------------------------------

  public setAutoAssertZeroErrors(enabled: boolean): void {
    this.autoAssertZeroErrors = enabled;
  }

  public isAutoAssertZeroErrorsEnabled(): boolean {
    return this.autoAssertZeroErrors;
  }

  public getRuntimeErrors(): ReadonlyArray<CapturedRuntimeError> {
    return this.runtimeErrors;
  }

  public clearRuntimeErrors(): void {
    this.runtimeErrors.length = 0;
  }

  public assertZeroRuntimeErrors(contextLabel = 'сессии теста'): void {
    expect(
      this.runtimeErrors,
      `Обнаружены ошибки console.error / pageerror / network в ходе ${contextLabel}:\n` +
        this.runtimeErrors
          .map(
            (e, idx) =>
              `  [${idx + 1}] (${e.kind}) ${e.message}${e.location ? ` @ ${e.location}` : ''}`,
          )
          .join('\n'),
    ).toEqual([]);
  }

  public async boot(options: BootOptions = {}): Promise<E2ETelemetry> {
    const {
      url = '/',
      preset = 'performance',
      clearStorage = false,
      timeoutMs = 25_000,
    } = options;

    this.buildModeToggledByHarness = false;
    this.sandboxPaletteDynamic = null;
    this.lastConfirmedHit = null;

    await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    let telemetry = await this.waitForAppReady({ preset, timeoutMs });

    if (clearStorage) {
      const hasStoredEntries = await this.page.evaluate(() => {
        try {
          return window.localStorage.length > 0;
        } catch {
          return false;
        }
      });
      if (hasStoredEntries) {
        await this.page.evaluate(() => {
          try {
            window.localStorage.clear();
          } catch {
            // Хранилище недоступно для очистки
          }
        });
        telemetry = await this.reloadAndWaitReady({ preset, timeoutMs });
      }
    }

    return telemetry;
  }

  public async reloadAndWaitReady(
    options: Omit<BootOptions, 'url' | 'clearStorage'> = {},
  ): Promise<E2ETelemetry> {
    const { preset = 'performance', timeoutMs = 25_000 } = options;
    this.buildModeToggledByHarness = false;
    this.sandboxPaletteDynamic = null;
    this.lastConfirmedHit = null;
    await this.page.reload({ waitUntil: 'domcontentloaded', timeout: timeoutMs });
    return await this.waitForAppReady({ preset, timeoutMs });
  }

  public async waitForAppReady(
    options: { preset?: QualityPreset | null; timeoutMs?: number } = {},
  ): Promise<E2ETelemetry> {
    const { preset = 'performance', timeoutMs = 25_000 } = options;

    await expect(this.page.locator(SELECTORS.appRoot)).toHaveAttribute('data-ready', 'true', {
      timeout: timeoutMs,
    });

    const canvas = this.page.locator(SELECTORS.simCanvas);
    await expect(canvas).toBeVisible({ timeout: timeoutMs });

    await expect
      .poll(
        async () => {
          return await this.page.evaluate(() => {
            const bridge = window.__SHATTERPOINT__;
            if (
              !bridge ||
              typeof bridge.getTelemetry !== 'function' ||
              typeof bridge.projectWorldPoint !== 'function'
            ) {
              return false;
            }
            const t = bridge.getTelemetry();
            return Boolean(t && Number.isFinite(t.tick) && typeof t.mode === 'string');
          });
        },
        {
          timeout: timeoutMs,
          message: 'Ожидание инициализации диагностического моста window.__SHATTERPOINT__',
        },
      )
      .toBe(true);

    if (preset !== null) {
      await this.setQualityPreset(preset);
    }

    this.assertZeroRuntimeErrors('инициализации приложения');
    return await this.getTelemetry();
  }

  public async waitForAnimationFrames(frameCount = 2): Promise<void> {
    await this.page.evaluate(async (count: number) => {
      const total = Math.max(1, Math.round(count));
      for (let i = 0; i < total; i++) {
        await new Promise<void>((resolve) => {
          window.requestAnimationFrame(() => resolve());
        });
      }
    }, frameCount);
  }

  public async captureCanvasPngBytes(): Promise<Uint8Array> {
    const rawPng = await this.page.locator(SELECTORS.simCanvas).screenshot({ type: 'png' });
    return new Uint8Array(rawPng as unknown as ArrayLike<number>);
  }

  public async verifyWebGL2Context(): Promise<WebGL2HealthReport> {
    await expect
      .poll(
        async () => {
          const t = await this.getTelemetry();
          return t.drawCalls;
        },
        { timeout: 10_000, message: 'Ожидание ненулевого числа Draw Calls WebGL2 рендерера' },
      )
      .toBeGreaterThan(0);

    const report = await this.page.evaluate((canvasSelector: string): WebGL2HealthReport => {
      const el = document.querySelector(canvasSelector);
      const drawCalls = window.__SHATTERPOINT__?.getTelemetry().drawCalls ?? 0;
      if (!(el instanceof HTMLCanvasElement)) {
        return {
          hasCanvas: false,
          hasWebGL2: false,
          contextLost: true,
          version: '',
          shadingLanguageVersion: '',
          renderer: '',
          drawingBufferWidth: 0,
          drawingBufferHeight: 0,
          drawCalls,
        };
      }

      const gl = el.getContext('webgl2');
      if (!gl) {
        return {
          hasCanvas: true,
          hasWebGL2: false,
          contextLost: true,
          version: '',
          shadingLanguageVersion: '',
          renderer: '',
          drawingBufferWidth: el.width,
          drawingBufferHeight: el.height,
          drawCalls,
        };
      }

      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      const renderer = dbg
        ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) ?? '')
        : String(gl.getParameter(gl.RENDERER) ?? '');

      return {
        hasCanvas: true,
        hasWebGL2: true,
        contextLost: gl.isContextLost(),
        version: String(gl.getParameter(gl.VERSION) ?? ''),
        shadingLanguageVersion: String(gl.getParameter(gl.SHADING_LANGUAGE_VERSION) ?? ''),
        renderer,
        drawingBufferWidth: gl.drawingBufferWidth,
        drawingBufferHeight: gl.drawingBufferHeight,
        drawCalls,
      };
    }, SELECTORS.simCanvas);

    expect(report.hasCanvas).toBe(true);
    expect(report.hasWebGL2).toBe(true);
    expect(report.contextLost).toBe(false);
    expect(report.version).toContain('WebGL 2.0');
    expect(report.drawingBufferWidth).toBeGreaterThan(100);
    expect(report.drawingBufferHeight).toBeGreaterThan(100);
    expect(report.drawCalls).toBeGreaterThan(0);

    return report;
  }

  public async auditRussianUiAndNoPurple(): Promise<UiAuditReport> {
    return await this.page.evaluate((): UiAuditReport => {
      const root = (document.querySelector('#app-root') ?? document.body) as HTMLElement;
      const visibleText = root.innerText || '';
      const hasCyrillicText = /[А-Яа-яЁё]{3,}/.test(visibleText);
      const cyrillicSample = visibleText.slice(0, 160).replace(/\s+/g, ' ').trim();

      const badTokens = ['undefined', 'NaN', '[object Object]'];
      const malformedMatches = badTokens.filter((tok) => visibleText.includes(tok));

      const colorProbeCanvas = document.createElement('canvas');
      colorProbeCanvas.width = 1;
      colorProbeCanvas.height = 1;
      const colorCtx = colorProbeCanvas.getContext('2d', { willReadFrequently: true });

      const toHsl = (
        r: number,
        g: number,
        b: number,
        a: number,
      ): { r: number; g: number; b: number; h: number; s: number; l: number; a: number } => {
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        const l = (max + min) / 2;
        const d = max - min;
        if (d === 0) return { r, g, b, h: 0, s: 0, l, a };
        const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        let h = 0;
        if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
        else if (max === g) h = (b - r) / d + 2;
        else h = (r - g) / d + 4;
        return { r, g, b, h: h * 60, s, l, a };
      };

      const parseRgba = (
        raw: string,
      ): { r: number; g: number; b: number; h: number; s: number; l: number; a: number } | null => {
        const trimmed = raw.trim();
        if (!trimmed || trimmed === 'transparent' || trimmed === 'none') return null;

        const match = trimmed.match(
          /^rgba?\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)(?:\s*[,/]\s*(\d+(?:\.\d+)?))?\s*\)$/i,
        );
        if (match) {
          const r = Number(match[1]) / 255;
          const g = Number(match[2]) / 255;
          const b = Number(match[3]) / 255;
          const a = match[4] !== undefined ? Number(match[4]) : 1;
          return toHsl(r, g, b, a);
        }

        if (colorCtx) {
          colorCtx.clearRect(0, 0, 1, 1);
          colorCtx.fillStyle = 'rgba(0, 0, 0, 0)';
          colorCtx.fillStyle = trimmed;
          colorCtx.fillRect(0, 0, 1, 1);
          const px = colorCtx.getImageData(0, 0, 1, 1).data;
          if (px[3] === 0) return null;
          return toHsl(px[0] / 255, px[1] / 255, px[2] / 255, px[3] / 255);
        }

        return null;
      };

      const rootBgRaw = window.getComputedStyle(root).backgroundColor;
      const bodyBgRaw = window.getComputedStyle(document.body).backgroundColor;
      const parsedRootBg = parseRgba(rootBgRaw);
      const parsedBodyBg = parseRgba(bodyBgRaw);
      const activeBg =
        parsedRootBg && parsedRootBg.a > 0.1 ? parsedRootBg : (parsedBodyBg ?? parsedRootBg);
      const rootBgLuminance = activeBg
        ? 0.2126 * activeBg.r + 0.7152 * activeBg.g + 0.0722 * activeBg.b
        : 0.05;

      const purpleViolations: UiAuditReport['purpleViolations'] = [];
      const elements = Array.from(root.querySelectorAll('*'));
      for (const el of elements) {
        if (!(el instanceof HTMLElement)) continue;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') continue;

        const props: Array<'backgroundColor' | 'borderTopColor' | 'color'> = [
          'backgroundColor',
          'borderTopColor',
          'color',
        ];
        for (const prop of props) {
          const val = style[prop];
          const hsl = parseRgba(val);
          if (!hsl || hsl.a < 0.08) continue;
          // Фиолетово-пурпурный спектр: Hue 262°..318° при выраженной насыщенности
          if (hsl.h >= 262 && hsl.h <= 318 && hsl.s > 0.25 && hsl.l > 0.1 && hsl.l < 0.92) {
            const hint = el.id ? `#${el.id}` : el.tagName.toLowerCase();
            purpleViolations.push({
              selectorHint: hint,
              property: prop,
              color: val,
              hueDeg: Math.round(hsl.h),
            });
          }
        }
      }

      return {
        hasCyrillicText,
        cyrillicSample,
        hasMalformedTokens: malformedMatches.length > 0,
        malformedMatches,
        rootBgLuminance,
        purpleViolations,
      };
    });
  }

  // --------------------------------------------------------------------------
  // 4.2. Чтение моста window.__SHATTERPOINT__, DOM-атрибутов и телеметрии
  // --------------------------------------------------------------------------

  public async getTelemetry(): Promise<E2ETelemetry> {
    return await this.page.evaluate((): E2ETelemetry => {
      const bridge = window.__SHATTERPOINT__;
      if (!bridge) {
        throw new Error('Диагностический мост window.__SHATTERPOINT__ не инициализирован');
      }
      return bridge.getTelemetry();
    });
  }

  public async projectWorldPoint(x: number, y: number, z: number): Promise<ProjectedWorldPoint> {
    return await this.page.evaluate(
      ([wx, wy, wz]: [number, number, number]): ProjectedWorldPoint => {
        const bridge = window.__SHATTERPOINT__;
        if (!bridge) {
          throw new Error('Диагностический мост window.__SHATTERPOINT__ не инициализирован');
        }
        return bridge.projectWorldPoint(wx, wy, wz);
      },
      [x, y, z] as [number, number, number],
    );
  }

  public async getAppRootState(): Promise<AppRootDomState> {
    const root = this.page.locator(SELECTORS.appRoot);
    return await root.evaluate((el: Element): AppRootDomState => {
      const attr = (name: string, fallback = '') => el.getAttribute(name) ?? fallback;
      return {
        ready: attr('data-ready') === 'true',
        activeMode: attr('data-active-mode', 'sandbox') as AppMode,
        paused: attr('data-paused') === 'true',
        timeScale: Number(attr('data-time-scale', '1')),
        renderMode: attr('data-render-mode', 'pbr') as RenderViewMode,
        simTick: Number(attr('data-sim-tick', '0')),
        activeTool: attr('data-active-tool', ''),
        plantedC4: Number(attr('data-planted-c4', '0')),
        autoSlowmo: attr('data-auto-slowmo', 'false') === 'true',
      };
    });
  }

  public async assertCanonicalAppRootAttributes(): Promise<void> {
    const root = this.page.locator(SELECTORS.appRoot);
    await expect(root).toBeAttached();

    const rawAttrs = await root.evaluate((el: Element) => ({
      ready: el.getAttribute('data-ready'),
      activeMode: el.getAttribute('data-active-mode'),
      paused: el.getAttribute('data-paused'),
      timeScale: el.getAttribute('data-time-scale'),
      renderMode: el.getAttribute('data-render-mode'),
      simTick: el.getAttribute('data-sim-tick'),
      activeTool: el.getAttribute('data-active-tool'),
      plantedC4: el.getAttribute('data-planted-c4'),
    }));

    expect(rawAttrs.ready, 'На #app-root обязан присутствовать атрибут data-ready').toBe('true');
    expect(
      rawAttrs.activeMode,
      'На #app-root обязан присутствовать атрибут data-active-mode',
    ).not.toBeNull();
    expect(['campaign', 'sandbox', 'lab']).toContain(rawAttrs.activeMode);

    expect(
      rawAttrs.paused,
      'На #app-root обязан присутствовать атрибут data-paused',
    ).not.toBeNull();
    expect(['true', 'false']).toContain(rawAttrs.paused);

    expect(
      rawAttrs.timeScale,
      'На #app-root обязан присутствовать атрибут data-time-scale',
    ).not.toBeNull();
    expect(Number.isFinite(Number(rawAttrs.timeScale)) && Number(rawAttrs.timeScale) > 0).toBe(
      true,
    );

    expect(
      rawAttrs.renderMode,
      'На #app-root обязан присутствовать атрибут data-render-mode',
    ).not.toBeNull();
    expect(['pbr', 'stress', 'xray']).toContain(rawAttrs.renderMode);

    expect(
      rawAttrs.simTick,
      'На #app-root обязан присутствовать атрибут data-sim-tick',
    ).not.toBeNull();
    expect(
      rawAttrs.simTick !== '' &&
        Number.isInteger(Number(rawAttrs.simTick)) &&
        Number(rawAttrs.simTick) >= 0,
    ).toBe(true);

    expect(
      rawAttrs.activeTool,
      'На #app-root обязан присутствовать атрибут data-active-tool',
    ).not.toBeNull();
    expect((rawAttrs.activeTool ?? '').trim().length).toBeGreaterThan(0);

    expect(
      rawAttrs.plantedC4,
      'На #app-root обязан присутствовать атрибут data-planted-c4',
    ).not.toBeNull();
    expect(
      rawAttrs.plantedC4 !== '' &&
        Number.isInteger(Number(rawAttrs.plantedC4)) &&
        Number(rawAttrs.plantedC4) >= 0,
    ).toBe(true);
  }

  public async assertCanonicalMissionPanelAttributes(): Promise<void> {
    const panel = this.page.locator(SELECTORS.missionResultPanel);
    await expect(panel).toBeAttached();

    const rawAttrs = await panel.evaluate((el: Element) => ({
      missionStatus: el.getAttribute('data-mission-status'),
      failReason: el.getAttribute('data-fail-reason'),
      stars: el.getAttribute('data-stars'),
    }));

    expect(
      rawAttrs.missionStatus,
      'На #mission-result-panel обязан присутствовать атрибут data-mission-status',
    ).not.toBeNull();
    expect(['planning', 'running', 'victory', 'defeat']).toContain(rawAttrs.missionStatus);

    expect(
      rawAttrs.failReason,
      'На #mission-result-panel обязан присутствовать атрибут data-fail-reason',
    ).not.toBeNull();
    expect(['none', 'collateral', 'budget_exhausted']).toContain(rawAttrs.failReason);

    expect(
      rawAttrs.stars,
      'На #mission-result-panel обязан присутствовать атрибут data-stars',
    ).not.toBeNull();
    expect(['0', '1', '2', '3']).toContain(rawAttrs.stars);
  }

  public async getPlantedC4Count(): Promise<number> {
    const raw = await this.page.locator(SELECTORS.appRoot).getAttribute('data-planted-c4');
    const parsed = Number(raw ?? '0');
    return Number.isFinite(parsed) ? parsed : 0;
  }

  public async readTelemetryDomValues(): Promise<TelemetryDomSnapshot> {
    const readDataVal = async (selector: string): Promise<number> => {
      const loc = this.page.locator(selector);
      await expect(loc).toBeAttached();
      const raw = await loc.getAttribute('data-value');
      expect(
        raw,
        `Индикатор ${selector} обязан иметь атрибут data-value="<float>"`,
      ).not.toBeNull();
      const num = Number(raw);
      expect(
        Number.isFinite(num),
        `Атрибут data-value="${raw}" на ${selector} должен быть конечным числом`,
      ).toBe(true);
      return num;
    };

    return {
      destructionPct: await readDataVal(SELECTORS.telemetryDestructionPct),
      intactJoints: await readDataVal(SELECTORS.telemetryIntactJoints),
      rebarLinks: await readDataVal(SELECTORS.telemetryRebarLinks),
      burningNodes: await readDataVal(SELECTORS.telemetryBurningNodes),
      maxTempC: await readDataVal(SELECTORS.telemetryMaxTempC),
      kineticKj: await readDataVal(SELECTORS.telemetryKineticKj),
      fps: await readDataVal(SELECTORS.telemetryFps),
    };
  }

  public async readLocatorNumericValue(loc: Locator): Promise<number> {
    await expect(loc).toBeAttached();
    return await loc.evaluate((el: Element): number => {
      const selfDataVal = el.getAttribute('data-value');
      if (selfDataVal !== null && selfDataVal.trim() !== '') {
        const parsedSelf = Number(selfDataVal.trim());
        if (Number.isFinite(parsedSelf)) return parsedSelf;
      }

      const childWithDataVal = el.querySelector('[data-value]');
      if (childWithDataVal) {
        const childVal = childWithDataVal.getAttribute('data-value');
        if (childVal !== null && childVal.trim() !== '') {
          const parsedChild = Number(childVal.trim());
          if (Number.isFinite(parsedChild)) return parsedChild;
        }
      }

      let text = (el.textContent ?? '')
        .replace(/(?<![A-Za-zА-Яа-яЁё\d])[cс]4(?![A-Za-zА-Яа-яЁё\d])/gi, ' ')
        .replace(/\b[23]d\b/gi, ' ')
        .replace(/№\s*\d+/g, ' ');

      const lastColon = text.lastIndexOf(':');
      const lastEq = text.lastIndexOf('=');
      const sepIdx = Math.max(lastColon, lastEq);
      if (sepIdx >= 0) {
        const rhs = text.slice(sepIdx + 1);
        if (/\d/.test(rhs)) {
          text = rhs;
        }
      }

      // Удаляем пробелы только внутри разрядов цифр, не склеивая тире вокруг слов ("Бюджет - 5000")
      const normalized = text.replace(/(\d)[\s\u00A0\u202F]+(?=\d)/g, '$1');
      const match = normalized.match(/(?<![\dA-Za-zА-Яа-яЁё])-?\d+(?:[.,]\d+)?|\d+(?:[.,]\d+)?/);
      if (!match) return Number.NaN;
      return Number(match[0].replace(',', '.'));
    });
  }

  public async readNumericIndicator(selector: string): Promise<number> {
    return await this.readLocatorNumericValue(this.page.locator(selector));
  }

  public async readMissionDomState(): Promise<MissionDomSnapshot> {
    const panel = this.page.locator(SELECTORS.missionResultPanel);
    await expect(panel).toBeAttached();

    const [budgetRemaining, targetProgress, collateralPct, panelMeta, starsText] =
      await Promise.all([
        this.readNumericIndicator(SELECTORS.missionBudgetRemaining),
        this.readNumericIndicator(SELECTORS.missionTargetProgress),
        this.readNumericIndicator(SELECTORS.missionCollateralPct),
        panel.evaluate((el: Element) => {
          const htmlEl = el as HTMLElement;
          const style = window.getComputedStyle(htmlEl);
          const rect = htmlEl.getBoundingClientRect();
          const visible =
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            Number(style.opacity ?? '1') > 0.01 &&
            rect.width > 0 &&
            rect.height > 0;
          return {
            missionStatus: (el.getAttribute('data-mission-status') ?? 'planning') as MissionStatus,
            failReason: (el.getAttribute('data-fail-reason') ?? 'none') as MissionFailReason,
            starsAttr: Number(el.getAttribute('data-stars') ?? '0'),
            visible,
          };
        }),
        this.page
          .locator(SELECTORS.missionStars)
          .evaluate((el: Element) => (el.textContent ?? '').trim()),
      ]);

    return {
      budgetRemaining,
      targetProgress,
      collateralPct,
      missionStatus: panelMeta.missionStatus,
      failReason: panelMeta.failReason,
      starsAttr: panelMeta.starsAttr,
      starsText,
      resultPanelVisible: panelMeta.visible,
    };
  }

  // --------------------------------------------------------------------------
  // 4.3. Адаптивные выпадающие списки <select> и ползунки <input type="range">
  // --------------------------------------------------------------------------

  public async listSelectOptions(selectSelector: string): Promise<DomSelectOption[]> {
    const selectLoc = this.page.locator(selectSelector);
    await expect(selectLoc).toBeAttached();
    return await selectLoc.evaluate((el: Element, sel: string): DomSelectOption[] => {
      if (!(el instanceof HTMLSelectElement)) {
        throw new Error(`Элемент ${sel} не является HTMLSelectElement`);
      }

      const extractFromValue = (rawVal: string): number | null => {
        const trimmed = rawVal.trim();
        if (!trimmed) return null;
        const valMatch = trimmed.match(/^([+-]?\d+(?:[.,]\d+)?)\s*(ms|мс|s|сек|с|x|х|×)?$/i);
        if (!valMatch) return null;
        const num = Number(valMatch[1].replace(',', '.'));
        if (!Number.isFinite(num)) return null;
        const unit = (valMatch[2] ?? '').toLowerCase();
        return unit === 'ms' || unit === 'мс' ? num / 1000 : num;
      };

      const extractFromLabel = (rawLabel: string): number | null => {
        const cleaned = rawLabel
          .replace(/(?<![A-Za-zА-Яа-яЁё\d])[cс]4(?![A-Za-zА-Яа-яЁё\d])/gi, ' ')
          .replace(/\b[23]d\b/gi, ' ')
          .replace(/\bwebgl2?\b/gi, ' ')
          .replace(/(\d)[\s\u00A0\u202F]+(?=\d)/g, '$1');

        const unitMatch = cleaned.match(
          /((?<![\dA-Za-zА-Яа-яЁё])[+-]?\d+(?:[.,]\d+)?|\d+(?:[.,]\d+)?)\s*(мс|ms|сек|с|s|x|х|×)(?![а-яёa-z])/i,
        );
        if (unitMatch) {
          const num = Number(unitMatch[1].replace(',', '.'));
          if (Number.isFinite(num)) {
            const unit = unitMatch[2].toLowerCase();
            return unit === 'ms' || unit === 'мс' ? num / 1000 : num;
          }
        }

        if (/мгновенно|сразу|instant|без\s+задержк/i.test(cleaned)) {
          return 0;
        }

        const plainMatch = cleaned.match(
          /(?<![\dA-Za-zА-Яа-яЁё])-?\d+(?:[.,]\d+)?|\d+(?:[.,]\d+)?/,
        );
        if (plainMatch) {
          const num = Number(plainMatch[0].replace(',', '.'));
          if (Number.isFinite(num)) return num;
        }

        return null;
      };

      return Array.from(el.options)
        .map((opt, index) => ({
          index,
          value: opt.value,
          label: (opt.textContent ?? '').trim(),
          disabled: opt.disabled,
        }))
        .filter((o) => !o.disabled)
        .map(({ index, value, label }) => ({
          index,
          value,
          label,
          numericValue: extractFromValue(value) ?? extractFromLabel(label),
        }));
    }, selectSelector);
  }

  public async selectOptionAdaptive(
    selectSelector: string,
    criteria: {
      exactValue?: string;
      keywords?: string[];
      nearestNumber?: number;
      fallbackIndex?: number;
    },
  ): Promise<DomSelectOption> {
    const options = await this.listSelectOptions(selectSelector);
    expect(
      options.length,
      `Список ${selectSelector} должен содержать хотя бы одну активную опцию <option>`,
    ).toBeGreaterThan(0);

    let chosen: DomSelectOption | undefined;

    if (criteria.exactValue !== undefined) {
      const targetLower = criteria.exactValue.toLowerCase();
      chosen = options.find((o) => o.value.toLowerCase() === targetLower);
    }

    if (!chosen && criteria.keywords && criteria.keywords.length > 0) {
      const lowered = criteria.keywords.map((k) => k.toLowerCase());
      chosen = options.find((o) => {
        const haystack = `${o.value} ${o.label}`.toLowerCase();
        return lowered.some((kw) => haystack.includes(kw));
      });
    }

    if (!chosen && criteria.nearestNumber !== undefined) {
      const target = criteria.nearestNumber;
      const numericOpts = options.filter((o) => o.numericValue !== null);
      if (numericOpts.length > 0) {
        const pool =
          target > 0 && numericOpts.some((o) => (o.numericValue ?? 0) > 0)
            ? numericOpts.filter((o) => (o.numericValue ?? 0) > 0)
            : numericOpts;
        chosen = pool.reduce((best, cur) =>
          Math.abs((cur.numericValue ?? 0) - target) <
          Math.abs((best.numericValue ?? 0) - target)
            ? cur
            : best,
        );
      }
    }

    if (!chosen && criteria.fallbackIndex !== undefined) {
      const clampedIdx = Math.min(options.length - 1, Math.max(0, criteria.fallbackIndex));
      chosen = options[clampedIdx];
    }

    const finalOption = chosen ?? options[0];
    const selectLoc = this.page.locator(selectSelector);
    await selectLoc.selectOption({ value: finalOption.value });
    return finalOption;
  }

  public async setQualityPreset(preset: QualityPreset): Promise<DomSelectOption> {
    const meta = QUALITY_PRESET_KEYWORDS[preset];
    return await this.selectOptionAdaptive(SELECTORS.qualitySelect, {
      exactValue: preset,
      keywords: meta.patterns,
      fallbackIndex: meta.fallbackIndex,
    });
  }

  public async setC4DelaySec(targetSec: number): Promise<number> {
    const chosen = await this.selectOptionAdaptive(SELECTORS.c4DelaySelect, {
      nearestNumber: targetSec,
      fallbackIndex: targetSec <= 0 ? 0 : 1,
    });
    return chosen.numericValue ?? targetSec;
  }

  public async setRangeSlider(
    sliderOrKey: PhysicsSliderKey | string,
    desiredValue: number,
  ): Promise<SliderApplyResult> {
    const selector =
      sliderOrKey in SLIDER_SELECTOR_MAP
        ? SLIDER_SELECTOR_MAP[sliderOrKey as PhysicsSliderKey]
        : sliderOrKey;

    const slider = this.page.locator(selector);
    await expect(slider).toBeVisible();

    return await slider.evaluate(
      (el: Element, rawTarget: number): SliderApplyResult => {
        if (!(el instanceof HTMLInputElement)) {
          throw new Error('Элемент ползунка не является HTMLInputElement');
        }
        const min = el.min !== '' ? Number(el.min) : -Infinity;
        const max = el.max !== '' ? Number(el.max) : Infinity;
        const step = el.step !== '' && el.step !== 'any' ? Number(el.step) : 0;

        let clamped = Math.min(max, Math.max(min, rawTarget));
        if (step > 0 && Number.isFinite(step) && clamped !== min && clamped !== max) {
          const base = Number.isFinite(min) ? min : 0;
          const snapped = base + Math.round((clamped - base) / step) * step;
          clamped = Math.min(max, Math.max(min, Number(snapped.toFixed(6))));
        } else {
          clamped = Number(clamped.toFixed(6));
        }

        const protoSetter = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          'value',
        )?.set;
        if (protoSetter) {
          protoSetter.call(el, String(clamped));
        } else {
          el.value = String(clamped);
        }

        el.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
        el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));

        return {
          appliedValue: Number(el.value),
          min: Number.isFinite(min) ? min : 0,
          max: Number.isFinite(max) ? max : 100,
          step,
        };
      },
      desiredValue,
    );
  }

  public async getSliderMeta(sliderOrKey: PhysicsSliderKey | string): Promise<SliderApplyResult> {
    const selector =
      sliderOrKey in SLIDER_SELECTOR_MAP
        ? SLIDER_SELECTOR_MAP[sliderOrKey as PhysicsSliderKey]
        : sliderOrKey;
    const slider = this.page.locator(selector);
    await expect(slider).toBeAttached();
    return await slider.evaluate((el: Element): SliderApplyResult => {
      const inp = el as HTMLInputElement;
      return {
        appliedValue: Number(inp.value),
        min: inp.min !== '' ? Number(inp.min) : 0,
        max: inp.max !== '' ? Number(inp.max) : 100,
        step: inp.step !== '' && inp.step !== 'any' ? Number(inp.step) : 0,
      };
    });
  }

  // --------------------------------------------------------------------------
  // 4.4. Навигация по режимам, время симуляции, визуализатор и Песочница
  // --------------------------------------------------------------------------

  public async switchMode(mode: AppMode): Promise<void> {
    const current = await this.page.locator(SELECTORS.appRoot).getAttribute('data-active-mode');
    if (current !== mode) {
      this.buildModeToggledByHarness = false;
      this.lastConfirmedHit = null;
      await this.page.locator(MODE_BUTTON_MAP[mode]).click();
    }
    await expect(this.page.locator(SELECTORS.appRoot)).toHaveAttribute('data-active-mode', mode);
  }

  public async selectTool(tool: ToolId): Promise<void> {
    const btn = this.page.locator(TOOL_BUTTON_MAP[tool]);
    await expect(btn).toBeVisible();
    await btn.click();
    this.buildModeToggledByHarness = false;
    await expect(this.page.locator(SELECTORS.appRoot)).toHaveAttribute('data-active-tool', tool);
  }

  public async getAvailableTools(): Promise<ToolId[]> {
    const allTools: ToolId[] = ['cannon', 'c4', 'bomb', 'cutter', 'incendiary', 'seismic'];
    const available: ToolId[] = [];
    for (const tool of allTools) {
      const btn = this.page.locator(TOOL_BUTTON_MAP[tool]);
      if ((await btn.count()) === 0) continue;
      const isOk = await btn.evaluate((el: Element) => {
        if (!(el instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(el);
        if (
          style.display === 'none' ||
          style.visibility === 'hidden' ||
          style.pointerEvents === 'none'
        ) {
          return false;
        }
        if ((el as HTMLButtonElement).disabled) return false;
        if (el.getAttribute('aria-disabled') === 'true') return false;
        if (el.getAttribute('data-disabled') === 'true') return false;
        if (el.classList.contains('disabled') || el.classList.contains('is-disabled')) {
          return false;
        }
        const dataAmmo = el.getAttribute('data-ammo');
        if (dataAmmo !== null && dataAmmo.trim() !== '' && Number(dataAmmo) <= 0) {
          return false;
        }
        return true;
      });
      if (isOk) available.push(tool);
    }
    return available;
  }

  public async setRenderViewMode(mode: RenderViewMode): Promise<void> {
    await this.page.locator(VIEW_BUTTON_MAP[mode]).click();
    await expect(this.page.locator(SELECTORS.appRoot)).toHaveAttribute('data-render-mode', mode);
    await this.waitForAnimationFrames(2);
  }

  public async resetScene(): Promise<E2ETelemetry> {
    await this.page.locator(SELECTORS.sceneResetBtn).click();
    this.lastConfirmedHit = null;
    this.buildModeToggledByHarness = false;
    await this.waitForAnimationFrames(2);
    return await this.getTelemetry();
  }

  public async toggleAudioMute(): Promise<void> {
    await this.page.locator(SELECTORS.audioMuteBtn).click();
    await this.waitForAnimationFrames(1);
  }

  public async setPaused(paused: boolean): Promise<void> {
    const root = this.page.locator(SELECTORS.appRoot);
    const current = (await root.getAttribute('data-paused')) === 'true';
    if (current !== paused) {
      await this.page.locator(SELECTORS.timePauseBtn).click();
    }
    await expect(root).toHaveAttribute('data-paused', String(paused));
  }

  public async stepOnceWhenPaused(): Promise<{ tickBefore: number; tickAfter: number }> {
    await this.setPaused(true);
    const before = await this.getTelemetry();
    await this.page.locator(SELECTORS.timeStepBtn).click();

    await expect
      .poll(async () => (await this.getTelemetry()).tick, {
        timeout: 5_000,
        message: 'Ожидание продвижения tick после нажатия #time-step-btn',
      })
      .toBeGreaterThan(before.tick);

    const after = await this.getTelemetry();
    return { tickBefore: before.tick, tickAfter: after.tick };
  }

  public async toggleBulletTime(): Promise<number> {
    await this.page.locator(SELECTORS.timeBulletBtn).click();
    await this.waitForAnimationFrames(1);
    const state = await this.getAppRootState();
    return state.timeScale;
  }

  public async setTimeScale(targetScale: number): Promise<number> {
    await this.selectOptionAdaptive(SELECTORS.timeScaleSelect, {
      nearestNumber: targetScale,
    });
    await this.waitForAnimationFrames(1);
    const state = await this.getAppRootState();
    return state.timeScale;
  }

  public async waitForSimTicks(deltaTicks: number, timeoutMs = 15_000): Promise<E2ETelemetry> {
    await this.setPaused(false);
    const start = await this.getTelemetry();
    const targetTick = start.tick + Math.max(1, Math.round(deltaTicks));

    let latest = start;
    await expect
      .poll(
        async () => {
          latest = await this.getTelemetry();
          return latest.tick;
        },
        {
          timeout: timeoutMs,
          message: `Ожидание продвижения симуляции на ${deltaTicks} тиков (с ${start.tick} до ${targetTick})`,
        },
      )
      .toBeGreaterThanOrEqual(targetTick);

    return latest;
  }

  public async waitForSimTime(deltaSimSec: number, timeoutMs = 20_000): Promise<E2ETelemetry> {
    await this.setPaused(false);
    const start = await this.getTelemetry();
    const targetTime = start.simTimeSec + Math.max(0.016, deltaSimSec);

    let latest = start;
    await expect
      .poll(
        async () => {
          latest = await this.getTelemetry();
          return latest.simTimeSec;
        },
        {
          timeout: timeoutMs,
          message: `Ожидание продвижения модельного времени на ${deltaSimSec.toFixed(2)} с`,
        },
      )
      .toBeGreaterThanOrEqual(targetTime);

    return latest;
  }

  public async listSandboxBlueprints(): Promise<DomSelectOption[]> {
    await this.switchMode('sandbox');
    return await this.listSelectOptions(SELECTORS.sandboxSpawnSelect);
  }

  public async spawnSandboxStructure(
    blueprintOrIndex: SandboxBlueprintKey | number | string = 'tower',
    options: SpawnSandboxOptions = {},
  ): Promise<{
    selectedOption: DomSelectOption;
    before: E2ETelemetry;
    after: E2ETelemetry;
  }> {
    const { cleanResetFirst = true } = options;
    await this.switchMode('sandbox');

    const pickTargetOption = async (): Promise<DomSelectOption> => {
      if (typeof blueprintOrIndex === 'number') {
        return await this.selectOptionAdaptive(SELECTORS.sandboxSpawnSelect, {
          fallbackIndex: blueprintOrIndex,
        });
      }
      if (blueprintOrIndex in SANDBOX_BLUEPRINT_KEYWORDS) {
        const meta = SANDBOX_BLUEPRINT_KEYWORDS[blueprintOrIndex as SandboxBlueprintKey];
        return await this.selectOptionAdaptive(SELECTORS.sandboxSpawnSelect, {
          exactValue: blueprintOrIndex,
          keywords: meta.patterns,
          fallbackIndex: meta.fallbackIndex,
        });
      }
      return await this.selectOptionAdaptive(SELECTORS.sandboxSpawnSelect, {
        exactValue: blueprintOrIndex,
        keywords: [blueprintOrIndex],
      });
    };

    if (cleanResetFirst) {
      // Фиксируем сигнатуру дефолтного чертежа index 0 после сброса сцены (один раз за сессию)
      if (this.defaultSandboxIndex0Sig === null) {
        await this.selectOptionAdaptive(SELECTORS.sandboxSpawnSelect, { fallbackIndex: 0 });
        await this.page.locator(SELECTORS.sceneResetBtn).click();
        await this.waitForAnimationFrames(2);
        const tIndex0 = await this.getTelemetry();
        this.defaultSandboxIndex0Sig = {
          blocks: tIndex0.initialBlockCount,
          joints: tIndex0.initialJointCount,
          heightM: Number(tIndex0.targetMaxHeightM.toFixed(2)),
        };
      }

      const selectedOption = await pickTargetOption();
      await this.page.locator(SELECTORS.sceneResetBtn).click();
      this.buildModeToggledByHarness = false;
      this.lastConfirmedHit = null;
      await this.waitForAnimationFrames(2);

      // Если #scene-reset-btn сбросил значение select обратно на дефолтное, возвращаем выбор
      const selectLoc = this.page.locator(SELECTORS.sandboxSpawnSelect);
      const currentSelectVal = await selectLoc.inputValue();
      if (currentSelectVal !== selectedOption.value) {
        await selectLoc.selectOption({ value: selectedOption.value });
        await this.waitForAnimationFrames(2);
      }

      const afterReset = await this.getTelemetry();
      if (selectedOption.index === 0 && afterReset.intactBlockCount > 0) {
        this.defaultSandboxIndex0Sig = {
          blocks: afterReset.initialBlockCount,
          joints: afterReset.initialJointCount,
          heightM: Number(afterReset.targetMaxHeightM.toFixed(2)),
        };
      }

      if (afterReset.intactBlockCount === 0) {
        await this.page.locator(SELECTORS.sandboxSpawnBtn).click();
      } else if (selectedOption.index !== 0) {
        const sig0 = this.defaultSandboxIndex0Sig;
        const sigChangedFromIndex0 =
          sig0 !== null &&
          sig0.blocks > 0 &&
          (afterReset.initialBlockCount !== sig0.blocks ||
            afterReset.initialJointCount !== sig0.joints ||
            Math.abs(afterReset.targetMaxHeightM - sig0.heightM) > 0.15);

        if (!sigChangedFromIndex0) {
          await this.page.locator(SELECTORS.sandboxSpawnBtn).click();
        }
      }

      await expect
        .poll(async () => (await this.getTelemetry()).intactBlockCount, {
          timeout: 8_000,
          message: 'Ожидание появления конструктивных блоков после чистого спавна',
        })
        .toBeGreaterThan(0);
      await this.waitForAnimationFrames(2);
      const after = await this.getTelemetry();
      return { selectedOption, before: afterReset, after };
    }

    const selectedOption = await pickTargetOption();
    const before = await this.getTelemetry();
    await this.page.locator(SELECTORS.sandboxSpawnBtn).click();
    this.lastConfirmedHit = null;

    await expect
      .poll(async () => (await this.getTelemetry()).intactBlockCount, {
        timeout: 8_000,
        message: 'Ожидание появления конструктивных блоков после спавна',
      })
      .toBeGreaterThan(0);

    await this.waitForAnimationFrames(2);
    const after = await this.getTelemetry();
    return { selectedOption, before, after };
  }

  public async selectLabBench(bench: LabBenchId): Promise<E2ETelemetry> {
    await this.switchMode('lab');
    await this.page.locator(LAB_BENCH_BUTTON_MAP[bench]).click();
    this.lastConfirmedHit = null;
    await expect
      .poll(async () => (await this.getTelemetry()).initialBlockCount, {
        timeout: 8_000,
        message: `Ожидание инициализации стенда ${bench}`,
      })
      .toBeGreaterThan(0);
    await this.waitForAnimationFrames(2);
    return await this.getTelemetry();
  }

  public async triggerLabEarthquake(
    params: { freqHz?: number; ampM?: number; settleTicks?: number } = {},
  ): Promise<E2ETelemetry> {
    const { freqHz, ampM, settleTicks = 12 } = params;
    if (freqHz !== undefined) {
      await this.setRangeSlider('quakeFreqHz', freqHz);
    }
    if (ampM !== undefined) {
      await this.setRangeSlider('quakeAmp', ampM);
    }
    await this.page.locator(SELECTORS.btnTriggerQuake).click();
    return await this.waitForSimTicks(settleTicks);
  }

  public async selectContract(
    contractIndex1Based: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8,
  ): Promise<E2ETelemetry> {
    await this.switchMode('campaign');
    const selector = CONTRACT_SELECTORS[contractIndex1Based - 1];
    await this.page.locator(selector).click();
    this.lastConfirmedHit = null;
    await expect
      .poll(async () => (await this.getTelemetry()).initialBlockCount, {
        timeout: 8_000,
        message: `Ожидание загрузки сооружения контракта ${selector}`,
      })
      .toBeGreaterThan(0);
    await this.waitForAnimationFrames(2);
    return await this.getTelemetry();
  }

  // --------------------------------------------------------------------------
  // 4.5. 3D -> 2D проекция, проверка перекрытия HUD и взаимодействие со сценой
  // --------------------------------------------------------------------------

  public async projectWorldPointsToClickableScreen(
    worldPoints: ReadonlyArray<[number, number, number]>,
    minSpacingPx = 12,
  ): Promise<ConfirmedCanvasHit[]> {
    return await this.page.evaluate(
      ({
        points,
        canvasSelector,
        minDist,
      }: {
        points: ReadonlyArray<[number, number, number]>;
        canvasSelector: string;
        minDist: number;
      }): ConfirmedCanvasHit[] => {
        const bridge = window.__SHATTERPOINT__;
        const canvas = document.querySelector(canvasSelector);
        if (!bridge || !(canvas instanceof HTMLCanvasElement)) return [];

        const rect = canvas.getBoundingClientRect();
        const margin = 16;
        const accepted: ConfirmedCanvasHit[] = [];

        // Глобальное определение системы координат проекции (viewport vs canvas-local)
        // по симметричному 3D-вееру точек вокруг сцены
        const detectIsCanvasLocal = (): boolean => {
          if (Math.abs(rect.left) <= 1 && Math.abs(rect.top) <= 1) {
            return false;
          }

          const heights = [-45, -22, -8, 0, 4, 10, 20, 34, 52];
          const fanPoints: Array<[number, number, number]> = heights.map((h) => [0, h, 0]);
          const radii = [6, 14, 26, 40];
          for (const r of radii) {
            for (const h of heights) {
              for (let k = 0; k < 12; k++) {
                const angle = (k * Math.PI) / 6;
                fanPoints.push([
                  Number((Math.cos(angle) * r).toFixed(2)),
                  h,
                  Number((Math.sin(angle) * r).toFixed(2)),
                ]);
              }
            }
          }

          const vis = fanPoints
            .map((fp) => bridge.projectWorldPoint(fp[0], fp[1], fp[2]))
            .filter((p) => p.visible && Number.isFinite(p.x) && Number.isFinite(p.y));

          if (vis.length === 0) {
            return false;
          }

          const allWithinLocalSize = vis.every(
            (p) =>
              p.x >= -1.5 &&
              p.x <= rect.width + 1.5 &&
              p.y >= -1.5 &&
              p.y <= rect.height + 1.5,
          );
          const allWithinViewportRect = vis.every(
            (p) =>
              p.x >= rect.left - 1.5 &&
              p.x <= rect.right + 1.5 &&
              p.y >= rect.top - 1.5 &&
              p.y <= rect.bottom + 1.5,
          );

          if (allWithinLocalSize && !allWithinViewportRect) return true;
          if (allWithinViewportRect && !allWithinLocalSize) return false;

          const moderate = vis.filter(
            (p) =>
              p.x >= Math.min(0, rect.left) - rect.width &&
              p.x <= Math.max(rect.width, rect.right) + rect.width &&
              p.y >= Math.min(0, rect.top) - rect.height &&
              p.y <= Math.max(rect.height, rect.bottom) + rect.height,
          );
          const sample = moderate.length > 0 ? moderate : vis;

          let minX = Infinity;
          let maxX = -Infinity;
          let minY = Infinity;
          let maxY = -Infinity;
          for (const p of sample) {
            if (p.x < minX) minX = p.x;
            if (p.x > maxX) maxX = p.x;
            if (p.y < minY) minY = p.y;
            if (p.y > maxY) maxY = p.y;
          }
          const midX = (minX + maxX) * 0.5;
          const midY = (minY + maxY) * 0.5;

          const distLocal = Math.hypot(midX - rect.width * 0.5, midY - rect.height * 0.5);
          const distViewport = Math.hypot(
            midX - (rect.left + rect.width * 0.5),
            midY - (rect.top + rect.height * 0.5),
          );
          return distLocal < distViewport;
        };

        const isCanvasLocal = detectIsCanvasLocal();
        const offsetX = isCanvasLocal ? rect.left : 0;
        const offsetY = isCanvasLocal ? rect.top : 0;

        const resolveClientPoint = (
          proj: ProjectedWorldPoint,
        ): { x: number; y: number } | null => {
          if (!proj.visible || !Number.isFinite(proj.x) || !Number.isFinite(proj.y)) {
            return null;
          }

          const cx = proj.x + offsetX;
          const cy = proj.y + offsetY;
          if (
            cx < rect.left + margin ||
            cx > rect.right - margin ||
            cy < rect.top + margin ||
            cy > rect.bottom - margin
          ) {
            return null;
          }

          const topEl = document.elementFromPoint(cx, cy);
          if (topEl === canvas || (topEl && canvas.contains(topEl))) {
            return { x: Math.round(cx), y: Math.round(cy) };
          }
          return null;
        };

        for (const wp of points) {
          const proj = bridge.projectWorldPoint(wp[0], wp[1], wp[2]);
          const screen = resolveClientPoint(proj);
          if (!screen) continue;

          const tooClose = accepted.some(
            (prev) =>
              Math.hypot(prev.screen.x - screen.x, prev.screen.y - screen.y) < minDist,
          );
          if (!tooClose) {
            accepted.push({
              world: [wp[0], wp[1], wp[2]],
              screen,
            });
          }
        }
        return accepted;
      },
      { points: worldPoints, canvasSelector: SELECTORS.simCanvas, minDist: minSpacingPx },
    );
  }

  public async clickWorldPoint(
    x: number,
    y: number,
    z: number,
    options: { button?: 'left' | 'right'; holdMs?: number } = {},
  ): Promise<ConfirmedCanvasHit | null> {
    const hits = await this.projectWorldPointsToClickableScreen([[x, y, z]], 0);
    if (hits.length === 0) return null;

    const hit = hits[0];
    const { button = 'left', holdMs = 0 } = options;

    if (holdMs > 0) {
      await this.page.mouse.move(hit.screen.x, hit.screen.y);
      await this.page.mouse.down({ button });
      await this.waitForSimTicks(Math.max(2, Math.round(holdMs / 16)));
      await this.page.mouse.up({ button });
    } else {
      await this.page.mouse.click(hit.screen.x, hit.screen.y, { button });
    }
    return hit;
  }

  private buildStructureCandidateGrid(
    heightM: number,
    preferSide: 'left' | 'right' | 'center' | 'any' = 'any',
    heightFraction = 0.18,
    searchFullPolygon = false,
  ): Array<[number, number, number]> {
    const H = Math.max(3.0, Number.isFinite(heightM) && heightM > 0.5 ? heightM : 10.0);
    const yPrimary = Math.max(0.75, Math.min(H * 0.85, H * heightFraction));
    const yLevels = [
      yPrimary,
      Math.max(0.7, Math.min(2.2, H * 0.15)),
      Math.max(1.2, H * 0.32),
      Math.max(1.8, H * 0.5),
      0.55,
    ];

    let xOffsets: number[];
    if (preferSide === 'left') {
      xOffsets = [-2.5, -4.0, -1.5, -6.0, -8.0, 0, 2.0];
    } else if (preferSide === 'right') {
      xOffsets = [2.5, 4.0, 1.5, 6.0, 8.0, 0, -2.0];
    } else if (preferSide === 'center') {
      xOffsets = [0, -1.2, 1.2, -2.5, 2.5, -4.5, 4.5];
    } else {
      xOffsets = [0, -2.0, 2.0, -4.0, 4.0, -1.0, 1.0, -6.5, 6.5, -9.0, 9.0];
    }

    if (searchFullPolygon) {
      xOffsets = [...xOffsets, 12.0, -12.0, 15.0, -15.0, 18.0, -18.0];
    }

    const zOffsets = searchFullPolygon
      ? [0, 1.8, -1.8, 3.6, -3.6, 12.0, -12.0]
      : [0, 1.8, -1.8, 3.6, -3.6];

    const xzPairs: Array<[number, number]> = [];
    for (const z of zOffsets) {
      for (const x of xOffsets) {
        xzPairs.push([Number(x.toFixed(2)), Number(z.toFixed(2))]);
      }
    }

    const scoreXZ = ([x, z]: [number, number]): number => {
      const radialFromOrigin = Math.hypot(x, z);
      if (preferSide === 'left') {
        const sidePenalty = x > 0.2 ? 12 : x > -0.5 ? 4 : 0;
        const farOutskirtsPenalty = radialFromOrigin > 9.5 ? 10 : 0;
        return Math.hypot(x + 2.5, z) + sidePenalty + farOutskirtsPenalty;
      }
      if (preferSide === 'right') {
        const sidePenalty = x < -0.2 ? 12 : x < 0.5 ? 4 : 0;
        const farOutskirtsPenalty = radialFromOrigin > 9.5 ? 10 : 0;
        return Math.hypot(x - 2.5, z) + sidePenalty + farOutskirtsPenalty;
      }
      return radialFromOrigin;
    };

    xzPairs.sort((a, b) => scoreXZ(a) - scoreXZ(b));

    const nearPairs = xzPairs.filter(([x, z]) => Math.hypot(x, z) <= 9.5);
    const farPairs = xzPairs.filter(([x, z]) => Math.hypot(x, z) > 9.5);

    const grid: Array<[number, number, number]> = [];
    for (const y of yLevels) {
      for (const [x, z] of nearPairs) {
        grid.push([x, Number(y.toFixed(2)), z]);
      }
    }
    for (const y of yLevels) {
      for (const [x, z] of farPairs) {
        grid.push([x, Number(y.toFixed(2)), z]);
      }
    }
    return grid;
  }

  public async plantC4OnStructure(options: PlantC4Options = {}): Promise<PlantC4Result> {
    const {
      count = 1,
      delaySec,
      heightFraction = 0.16,
      preferSide = 'any',
      customWorldCandidates,
    } = options;

    await this.selectTool('c4');
    let appliedDelaySec: number | null = null;
    if (delaySec !== undefined) {
      appliedDelaySec = await this.setC4DelaySec(delaySec);
    }

    const telemetry = await this.getTelemetry();
    const worldGrid =
      customWorldCandidates ??
      this.buildStructureCandidateGrid(telemetry.targetMaxHeightM, preferSide, heightFraction, true);

    const clickableCandidates = await this.projectWorldPointsToClickableScreen(worldGrid, 14);
    const hits: ConfirmedCanvasHit[] = [];
    let plantedNow = 0;

    for (const candidate of clickableCandidates) {
      if (plantedNow >= count) break;
      const beforeCount = await this.getPlantedC4Count();
      await this.page.mouse.click(candidate.screen.x, candidate.screen.y, { button: 'left' });
      await this.waitForAnimationFrames(1);
      const afterCount = await this.getPlantedC4Count();

      if (afterCount > beforeCount) {
        plantedNow += afterCount - beforeCount;
        hits.push(candidate);
        this.lastConfirmedHit = candidate;
      }
    }

    const totalPlanted = await this.getPlantedC4Count();
    return {
      plantedNow,
      totalPlanted,
      appliedDelaySec,
      hits,
    };
  }

  public async removeC4AtHit(hit: ConfirmedCanvasHit): Promise<boolean> {
    await this.selectTool('c4');
    const before = await this.getPlantedC4Count();
    if (before <= 0) return false;

    const fresh = await this.projectWorldPointsToClickableScreen([hit.world], 0);
    const pt = fresh[0]?.screen ?? hit.screen;
    const offsets: Array<[number, number]> = [
      [0, 0],
      [4, 0],
      [-4, 0],
      [0, 4],
      [0, -4],
    ];

    for (const [dx, dy] of offsets) {
      await this.page.mouse.click(pt.x + dx, pt.y + dy, { button: 'right' });
      await this.waitForAnimationFrames(1);
      const after = await this.getPlantedC4Count();
      if (after < before) return true;
    }
    return false;
  }

  public async detonateC4AndSettle(settleTicks = 45): Promise<E2ETelemetry> {
    await this.setPaused(false);
    if ((await this.getPlantedC4Count()) > 0) {
      const availTools = await this.getAvailableTools();
      if (availTools.includes('c4')) {
        await this.selectTool('c4');
      } else if (!(await this.page.locator(SELECTORS.detonateC4Btn).isVisible())) {
        await this.clickOrVerifyDisabled(SELECTORS.toolC4);
      }
      await this.clickOrVerifyDisabled(SELECTORS.detonateC4Btn);
    } else {
      await this.clickOrVerifyDisabled(SELECTORS.detonateC4Btn);
    }
    return await this.waitForSimTicks(settleTicks);
  }

  private hasPhysicalResponse(
    before: E2ETelemetry,
    after: E2ETelemetry,
    tool: ToolId,
    options: Pick<StrikeStructureOptions, 'requireBurning' | 'requirePlasticHinge'> = {},
  ): boolean {
    if (options.requireBurning) {
      return after.burningNodeCount > 0;
    }
    if (options.requirePlasticHinge) {
      return after.plasticHingeCount > before.plasticHingeCount;
    }
    if (after.brokenJointCount > before.brokenJointCount) return true;
    if (after.intactBlockCount < before.intactBlockCount) return true;
    if (after.activeShardCount > before.activeShardCount) return true;
    if (after.destructionPct > before.destructionPct + 0.05) return true;
    if (after.snappedRebarCount > before.snappedRebarCount) return true;
    if (after.plasticHingeCount > before.plasticHingeCount) return true;
    if (after.detonatedExplosivesCount > before.detonatedExplosivesCount) return true;
    if (after.burningNodeCount > before.burningNodeCount) return true;
    if (after.maxTemperatureC > before.maxTemperatureC + 5.0) return true;
    if (tool === 'cannon' || tool === 'bomb') {
      if (after.kineticEnergyKJ > before.kineticEnergyKJ + 0.05) return true;
      if (after.maxStressUtilization > before.maxStressUtilization + 0.02) return true;
    }
    return false;
  }

  public async aimAndStrikeStructure(
    tool: Exclude<ToolId, 'c4' | 'seismic'>,
    options: StrikeStructureOptions = {},
  ): Promise<StrikeStructureResult> {
    const {
      worldPoint,
      preferSide = 'any',
      heightFraction = tool === 'bomb' ? 0.12 : 0.28,
      holdMs = tool === 'cutter' ? 680 : 0,
      settleTicks = tool === 'cannon' ? 24 : 18,
      maxAttempts,
      keepPaused = false,
      requireBurning = false,
      requirePlasticHinge = false,
      searchFullPolygon = false,
    } = options;

    if (!keepPaused) {
      await this.setPaused(false);
    }
    await this.selectTool(tool);

    const before = await this.getTelemetry();
    const defaultMaxAttempts =
      before.mode === 'campaign' ? 2 : requireBurning || requirePlasticHinge || searchFullPolygon ? 12 : 6;
    const limit = maxAttempts ?? defaultMaxAttempts;

    const candidatesWorld: Array<[number, number, number]> = [];
    if (worldPoint) {
      candidatesWorld.push(worldPoint);
    } else if (this.lastConfirmedHit && !requireBurning && !requirePlasticHinge) {
      candidatesWorld.push(this.lastConfirmedHit.world);
    }
    candidatesWorld.push(
      ...this.buildStructureCandidateGrid(
        before.targetMaxHeightM,
        preferSide,
        heightFraction,
        searchFullPolygon || requireBurning || requirePlasticHinge,
      ),
    );

    const screenCandidates = await this.projectWorldPointsToClickableScreen(candidatesWorld, 18);
    let attempts = 0;
    let usedPoint: ConfirmedCanvasHit | null = null;
    let latest = before;

    for (const candidate of screenCandidates) {
      if (attempts >= limit) break;
      attempts += 1;
      usedPoint = candidate;

      if (holdMs > 0) {
        const cutterJitterOffsets = [-2, -1, 0, 1, 2, 0];
        await this.page.mouse.move(candidate.screen.x, candidate.screen.y);
        await this.page.mouse.down({ button: 'left' });
        const ticksPerStep = Math.max(2, Math.round(holdMs / (cutterJitterOffsets.length * 16)));
        for (const dx of cutterJitterOffsets) {
          await this.page.mouse.move(candidate.screen.x + dx, candidate.screen.y);
          if (!keepPaused) {
            await this.waitForSimTicks(ticksPerStep);
          } else {
            await this.waitForAnimationFrames(1);
          }
        }
        await this.page.mouse.up({ button: 'left' });
      } else {
        await this.page.mouse.click(candidate.screen.x, candidate.screen.y, { button: 'left' });
      }

      if (keepPaused) {
        await this.waitForAnimationFrames(2);
        latest = await this.getTelemetry();
        break;
      }

      latest = await this.waitForSimTicks(settleTicks);
      if (
        this.hasPhysicalResponse(before, latest, tool, {
          requireBurning,
          requirePlasticHinge,
        })
      ) {
        this.lastConfirmedHit = candidate;
        return {
          impactConfirmed: true,
          attempts,
          usedPoint: candidate,
          before,
          after: latest,
        };
      }
    }

    return {
      impactConfirmed: this.hasPhysicalResponse(before, latest, tool, {
        requireBurning,
        requirePlasticHinge,
      }),
      attempts,
      usedPoint,
      before,
      after: latest,
    };
  }

  public async activateSeismicTool(
    options: { freqHz?: number; ampM?: number; settleTicks?: number } = {},
  ): Promise<E2ETelemetry> {
    const { freqHz, ampM, settleTicks = 25 } = options;
    await this.setPaused(false);
    await this.selectTool('seismic');

    if (freqHz !== undefined && (await this.page.locator(SELECTORS.sliderQuakeFreqHz).isVisible())) {
      await this.setRangeSlider('quakeFreqHz', freqHz);
    }
    if (ampM !== undefined && (await this.page.locator(SELECTORS.sliderQuakeAmp).isVisible())) {
      await this.setRangeSlider('quakeAmp', ampM);
    }

    const triggerBtn = this.page.locator(SELECTORS.btnTriggerQuake);
    if (await triggerBtn.isVisible()) {
      await triggerBtn.click();
    } else {
      const groundHits = await this.projectWorldPointsToClickableScreen(
        [
          [0, 0.8, 0],
          [0, 0.2, 0],
        ],
        0,
      );
      if (groundHits[0]) {
        await this.page.mouse.click(groundHits[0].screen.x, groundHits[0].screen.y);
      }
    }

    return await this.waitForSimTicks(settleTicks);
  }

  public async clickSkyMiss(
    options: { button?: 'left' | 'right' } = {},
  ): Promise<{ x: number; y: number }> {
    const { button = 'left' } = options;

    const skyWorldCandidates: Array<[number, number, number]> = [
      [-65, 85, -65],
      [65, 85, -65],
      [-55, 75, 55],
      [55, 75, 55],
      [-80, 60, 0],
      [80, 60, 0],
    ];
    const projectedSky = await this.projectWorldPointsToClickableScreen(skyWorldCandidates, 20);
    if (projectedSky.length > 0) {
      const pt = projectedSky[0].screen;
      await this.page.mouse.click(pt.x, pt.y, { button });
      return pt;
    }

    const centerHits = await this.projectWorldPointsToClickableScreen([[0, 5, 0]], 0);
    const centerClientX = centerHits[0]?.screen.x ?? null;

    const fallbackPt = await this.page.evaluate(
      ({ canvasSelector, knownCenterX }: { canvasSelector: string; knownCenterX: number | null }) => {
        const canvas = document.querySelector(canvasSelector);
        if (!(canvas instanceof HTMLCanvasElement)) {
          throw new Error('Элемент #sim-canvas не найден');
        }
        const rect = canvas.getBoundingClientRect();
        const centerX = knownCenterX ?? rect.left + rect.width * 0.5;

        const ratios: Array<[number, number]> = [
          [0.18, 0.16],
          [0.82, 0.16],
          [0.24, 0.2],
          [0.76, 0.2],
          [0.15, 0.28],
          [0.85, 0.28],
        ];

        for (const [rx, ry] of ratios) {
          const cx = Math.round(rect.left + rect.width * rx);
          const cy = Math.round(rect.top + rect.height * ry);
          if (Math.abs(cx - centerX) < 150) continue;
          const hitEl = document.elementFromPoint(cx, cy);
          if (hitEl === canvas || (hitEl && canvas.contains(hitEl))) {
            return { x: cx, y: cy };
          }
        }
        return {
          x: Math.round(rect.left + rect.width * 0.2),
          y: Math.round(rect.top + rect.height * 0.18),
        };
      },
      { canvasSelector: SELECTORS.simCanvas, knownCenterX: centerClientX },
    );

    await this.page.mouse.click(fallbackPt.x, fallbackPt.y, { button });
    return fallbackPt;
  }

  public async strikeProtectedZone(
    options: { untilDefeat?: boolean; maxStrikes?: number } = {},
  ): Promise<{ collateralDetected: boolean; telemetry: E2ETelemetry }> {
    const { untilDefeat = true, maxStrikes = 10 } = options;
    await this.setPaused(false);

    const available = await this.getAvailableTools();
    const ringWorldPoints: Array<[number, number, number]> = [
      [10, 2.0, 0],
      [-10, 2.0, 0],
      [0, 2.0, 10],
      [0, 2.0, -10],
      [14, 2.0, 0],
      [-14, 2.0, 0],
      [8, 1.8, 6],
      [-8, 1.8, 6],
      [8, 1.8, -6],
      [-8, 1.8, -6],
      [18, 2.5, 0],
      [-18, 2.5, 0],
    ];

    const candidates = await this.projectWorldPointsToClickableScreen(ringWorldPoints, 16);

    const preferredImpactTool: Exclude<ToolId, 'c4' | 'seismic'> | null = available.includes('bomb')
      ? 'bomb'
      : available.includes('cannon')
        ? 'cannon'
        : available.includes('incendiary')
          ? 'incendiary'
          : available.includes('cutter')
            ? 'cutter'
            : null;

    if (preferredImpactTool) {
      await this.selectTool(preferredImpactTool);
      let hitProtectedScreen: { x: number; y: number } | null = null;
      let strikes = 0;

      for (const candidate of candidates) {
        if (strikes >= maxStrikes) break;
        const targetScreen: { x: number; y: number } = hitProtectedScreen ?? candidate.screen;
        strikes += 1;

        await this.page.mouse.click(targetScreen.x, targetScreen.y, { button: 'left' });
        const t = await this.waitForSimTicks(22);

        if (t.protectedDamagePct > 0 || t.collateralPct > 0 || t.missionStatus === 'defeat') {
          hitProtectedScreen = targetScreen;
          if (!untilDefeat || t.missionStatus === 'defeat') {
            return { collateralDetected: true, telemetry: t };
          }
        }
      }
    }

    if (available.includes('c4')) {
      const planted = await this.plantC4OnStructure({
        count: 3,
        delaySec: 0,
        customWorldCandidates: [
          ...ringWorldPoints,
          [4.5, 1.5, 0],
          [-4.5, 1.5, 0],
        ],
      });
      if (planted.plantedNow > 0) {
        const afterDet = await this.detonateC4AndSettle(75);
        return {
          collateralDetected:
            afterDet.protectedDamagePct > 0 ||
            afterDet.collateralPct > 0 ||
            afterDet.missionStatus === 'defeat',
          telemetry: afterDet,
        };
      }
    }

    const finalTelemetry = await this.getTelemetry();
    return {
      collateralDetected:
        finalTelemetry.protectedDamagePct > 0 ||
        finalTelemetry.collateralPct > 0 ||
        finalTelemetry.missionStatus === 'defeat',
      telemetry: finalTelemetry,
    };
  }

  public async completeContractTargetDemolition(): Promise<MissionDomSnapshot> {
    await this.setPaused(false);

    for (let wave = 0; wave < 4; wave++) {
      const currentState = await this.readMissionDomState();
      if (currentState.missionStatus === 'victory' || currentState.missionStatus === 'defeat') {
        return currentState;
      }

      const available = await this.getAvailableTools();
      let actionTaken = false;

      if (available.includes('c4') && currentState.budgetRemaining > 0) {
        const planted = await this.plantC4OnStructure({
          count: wave === 0 ? 4 : 2,
          delaySec: 0,
          heightFraction: wave === 0 ? 0.14 : 0.25,
          preferSide: 'center',
        });
        if (planted.totalPlanted > 0) {
          await this.detonateC4AndSettle(95);
          actionTaken = true;
        }
      }

      if (!actionTaken && available.includes('bomb') && currentState.budgetRemaining > 0) {
        const res = await this.aimAndStrikeStructure('bomb', {
          preferSide: 'center',
          heightFraction: 0.12,
          settleTicks: 90,
          maxAttempts: 2,
        });
        actionTaken = res.attempts > 0;
      }

      if (!actionTaken && available.includes('cannon') && currentState.budgetRemaining > 0) {
        const res = await this.aimAndStrikeStructure('cannon', {
          preferSide: 'center',
          heightFraction: 0.16,
          settleTicks: 60,
          maxAttempts: 3,
        });
        actionTaken = res.attempts > 0;
      }

      if (!actionTaken && available.includes('cutter') && currentState.budgetRemaining > 0) {
        const res = await this.aimAndStrikeStructure('cutter', {
          preferSide: 'center',
          heightFraction: 0.16,
          holdMs: 800,
          settleTicks: 75,
          maxAttempts: 2,
        });
        actionTaken =
          res.impactConfirmed ||
          (res.attempts > 0 && !available.includes('incendiary') && !available.includes('seismic'));
      }

      if (!actionTaken && available.includes('incendiary') && currentState.budgetRemaining > 0) {
        const res = await this.aimAndStrikeStructure('incendiary', {
          heightFraction: 0.2,
          settleTicks: 35,
          searchFullPolygon: true,
        });
        actionTaken =
          res.impactConfirmed || (res.attempts > 0 && !available.includes('seismic'));
      }

      if (!actionTaken && available.includes('seismic') && currentState.budgetRemaining > 0) {
        await this.activateSeismicTool({
          freqHz: 2.8,
          ampM: 1.6,
          settleTicks: 40,
        });
        actionTaken = true;
      }

      if (!actionTaken) {
        await this.waitForSimTicks(60);
      }

      const afterWave = await this.readMissionDomState();
      if (afterWave.missionStatus === 'victory' || afterWave.missionStatus === 'defeat') {
        return afterWave;
      }
    }

    await this.waitForSimTicks(90);
    return await this.readMissionDomState();
  }

  private async readSandboxBuildExplicitMarker(): Promise<'on' | 'off' | 'unknown'> {
    return await this.page.evaluate(
      ({ rootSel, toggleSel }: { rootSel: string; toggleSel: string }): 'on' | 'off' | 'unknown' => {
        // Приоритет 1: строгие машинные атрибуты и телеметрия
        const bridgeTelemetry = window.__SHATTERPOINT__?.getTelemetry();
        if (typeof bridgeTelemetry?.buildModeActive === 'boolean') {
          return bridgeTelemetry.buildModeActive ? 'on' : 'off';
        }

        const root = document.querySelector(rootSel);
        const toggle = document.querySelector(toggleSel);

        const rootBuildMode = (root?.getAttribute('data-build-mode') ?? '').trim().toLowerCase();
        if (rootBuildMode === 'true') return 'on';
        if (rootBuildMode === 'false') return 'off';

        const activeTool = (root?.getAttribute('data-active-tool') ?? '').trim().toLowerCase();
        if (activeTool === 'build') return 'on';

        const toggleBuildMode = (toggle?.getAttribute('data-build-mode') ?? '')
          .trim()
          .toLowerCase();
        if (toggleBuildMode === 'true') return 'on';
        if (toggleBuildMode === 'false') return 'off';

        const ariaPressed = (toggle?.getAttribute('aria-pressed') ?? '').trim().toLowerCase();
        if (ariaPressed === 'true') return 'on';
        if (ariaPressed === 'false') return 'off';

        const dataActive = (toggle?.getAttribute('data-active') ?? '').trim().toLowerCase();
        if (dataActive === 'true') return 'on';
        if (dataActive === 'false') return 'off';

        const dataState = (toggle?.getAttribute('data-state') ?? '').trim().toLowerCase();
        if (dataState === 'on' || dataState === 'active') return 'on';
        if (dataState === 'off' || dataState === 'inactive') return 'off';

        // Приоритет 2: точные токены toggle.classList без регулярки с \b по className
        if (toggle) {
          const classes = Array.from(toggle.classList).map((c) => c.toLowerCase());
          const exactOnTokens = new Set([
            'active',
            'is-active',
            'selected',
            'is-selected',
            'pressed',
            'is-pressed',
            'on',
            'is-on',
          ]);
          const exactOffTokens = new Set([
            'inactive',
            'is-inactive',
            'not-active',
            'non-active',
            'unselected',
            'not-selected',
            'off',
            'is-off',
          ]);
          const hasOnClass = classes.some(
            (c) =>
              exactOnTokens.has(c) ||
              ((c.endsWith('--active') || c.endsWith('--on') || c.endsWith('--selected')) &&
                !c.startsWith('not-') &&
                !c.startsWith('non-') &&
                !c.includes('inactive')),
          );
          const hasOffClass = classes.some(
            (c) => exactOffTokens.has(c) || c.endsWith('--inactive') || c.endsWith('--off'),
          );
          if (hasOnClass && !hasOffClass) return 'on';
          if (hasOffClass && !hasOnClass) return 'off';
        }

        // Приоритет 3: текст кнопки — сначала глаголы действия, затем отдельные сокращения статуса
        const text = (toggle?.textContent ?? '').trim();
        if (text) {
          const hasTurnOffVerb = /выключить|завершить|выйти/i.test(text);
          const hasTurnOnVerb = /включить/i.test(text);
          if (hasTurnOffVerb && !hasTurnOnVerb) return 'on';
          if (hasTurnOnVerb && !hasTurnOffVerb) return 'off';

          const hasShortOn = /(?:^|[\s:(\[/|—–-])вкл\.?(?:$|[\s)\]/|—–-])/i.test(text);
          const hasShortOff = /(?:^|[\s:(\[/|—–-])выкл\.?(?:$|[\s)\]/|—–-])/i.test(text);
          if (hasShortOn && !hasShortOff) return 'on';
          if (hasShortOff && !hasShortOn) return 'off';
        }

        return 'unknown';
      },
      { rootSel: SELECTORS.appRoot, toggleSel: SELECTORS.sandboxBuildToggle },
    );
  }

  public async isSandboxBuildModeActive(): Promise<boolean> {
    const sampleMatBtn = this.page.locator(SELECTORS.matReinforcedConcrete);
    if (!(await sampleMatBtn.isVisible())) {
      const activeMode = await this.page
        .locator(SELECTORS.appRoot)
        .getAttribute('data-active-mode');
      if (activeMode === 'sandbox') {
        this.sandboxPaletteDynamic = true;
      }
      return false;
    }

    if (this.sandboxPaletteDynamic === true) {
      return true;
    }

    const explicitMarker = await this.readSandboxBuildExplicitMarker();
    if (explicitMarker === 'on') return true;
    if (explicitMarker === 'off') return false;
    return this.buildModeToggledByHarness;
  }

  public async placeSandboxBuildBlock(
    material: StructuralMaterialId,
    preferredWorldSpots: Array<[number, number, number]> = [
      [7.5, 0.6, 0],
      [-7.5, 0.6, 0],
      [0, 0.6, 7.5],
      [6.0, 0.6, 6.0],
      [-6.0, 0.6, 6.0],
      [0, 1.0, 0],
    ],
  ): Promise<{
    placed: boolean;
    beforeBlocks: number;
    afterBlocks: number;
    hit: ConfirmedCanvasHit | null;
  }> {
    await this.switchMode('sandbox');
    const before = await this.getTelemetry();

    const matBtn = this.page.locator(MATERIAL_BUTTON_MAP[material]);
    const toggleBtn = this.page.locator(SELECTORS.sandboxBuildToggle);

    if (!(await this.isSandboxBuildModeActive())) {
      await toggleBtn.click();
      await this.waitForAnimationFrames(1);
      if (!(await matBtn.isVisible())) {
        this.sandboxPaletteDynamic = true;
        await toggleBtn.click();
        await this.waitForAnimationFrames(1);
      }
      this.buildModeToggledByHarness = true;
    }

    await expect(matBtn).toBeVisible();
    await matBtn.click();
    await this.waitForAnimationFrames(1);

    const spots = await this.projectWorldPointsToClickableScreen(preferredWorldSpots, 14);
    const tryPlaceOnSpots = async (): Promise<{
      placed: boolean;
      afterBlocks: number;
      hit: ConfirmedCanvasHit | null;
    } | null> => {
      for (const spot of spots) {
        await this.page.mouse.click(spot.screen.x, spot.screen.y, { button: 'left' });
        await this.waitForAnimationFrames(2);
        const after = await this.getTelemetry();
        if (
          after.intactBlockCount > before.intactBlockCount ||
          after.initialBlockCount > before.initialBlockCount
        ) {
          this.buildModeToggledByHarness = true;
          return {
            placed: true,
            afterBlocks: after.initialBlockCount,
            hit: spot,
          };
        }
      }
      return null;
    };

    const firstPass = await tryPlaceOnSpots();
    if (firstPass) {
      return {
        placed: true,
        beforeBlocks: before.initialBlockCount,
        afterBlocks: firstPass.afterBlocks,
        hit: firstPass.hit,
      };
    }

    // Адаптивный повтор: если палитра статична и режим не был распознан, переключаем тоггл и повторяем
    if (spots.length > 0) {
      await toggleBtn.click();
      await this.waitForAnimationFrames(1);
      if (!(await matBtn.isVisible())) {
        this.sandboxPaletteDynamic = true;
        await toggleBtn.click();
        await this.waitForAnimationFrames(1);
      }
      await expect(matBtn).toBeVisible();
      await matBtn.click();
      await this.waitForAnimationFrames(1);

      const secondPass = await tryPlaceOnSpots();
      if (secondPass) {
        return {
          placed: true,
          beforeBlocks: before.initialBlockCount,
          afterBlocks: secondPass.afterBlocks,
          hit: secondPass.hit,
        };
      }
    }

    const fallbackAfter = await this.getTelemetry();
    const placed =
      fallbackAfter.intactBlockCount > before.intactBlockCount ||
      fallbackAfter.initialBlockCount > before.initialBlockCount;
    if (placed) {
      this.buildModeToggledByHarness = true;
    }
    return {
      placed,
      beforeBlocks: before.initialBlockCount,
      afterBlocks: fallbackAfter.initialBlockCount,
      hit: null,
    };
  }

  public async exitSandboxBuildMode(): Promise<void> {
    if (await this.isSandboxBuildModeActive()) {
      const sampleMatBtn = this.page.locator(SELECTORS.matReinforcedConcrete);
      const toggleBtn = this.page.locator(SELECTORS.sandboxBuildToggle);
      if (await toggleBtn.isVisible()) {
        await toggleBtn.click();
        this.buildModeToggledByHarness = false;
        await this.waitForAnimationFrames(1);

        if (!(await sampleMatBtn.isVisible())) {
          this.sandboxPaletteDynamic = true;
        } else {
          // Если после клика сохранился или появился явный маркер активности, возвращаем в OFF
          const accidentallyTurnedOn = (await this.readSandboxBuildExplicitMarker()) === 'on';
          if (accidentallyTurnedOn) {
            await toggleBtn.click();
            await this.waitForAnimationFrames(1);
          }
        }
      }
    }
    this.buildModeToggledByHarness = false;
  }

  public async orbitCameraDrag(dxPx = 140, dyPx = -35): Promise<void> {
    const probeBefore = await this.projectWorldPoint(4, 2, 0);

    const safeSky = await this.projectWorldPointsToClickableScreen(
      [
        [0, 5, 0],
        [-12, 8, 0],
      ],
      0,
    );
    const start =
      safeSky[0]?.screen ??
      (await this.page.evaluate((sel: string) => {
        const rect = document.querySelector(sel)!.getBoundingClientRect();
        return {
          x: Math.round(rect.left + rect.width * 0.5),
          y: Math.round(rect.top + rect.height * 0.35),
        };
      }, SELECTORS.simCanvas));

    const performDrag = async (button: 'right' | 'middle' | 'left') => {
      await this.page.mouse.move(start.x, start.y);
      await this.page.mouse.down({ button });
      const steps = 6;
      for (let i = 1; i <= steps; i++) {
        await this.page.mouse.move(
          start.x + Math.round((dxPx * i) / steps),
          start.y + Math.round((dyPx * i) / steps),
        );
        await this.waitForAnimationFrames(1);
      }
      await this.page.mouse.up({ button });
      await this.waitForAnimationFrames(2);
    };

    await performDrag('right');
    const afterRight = await this.projectWorldPoint(4, 2, 0);
    if (Math.hypot(afterRight.x - probeBefore.x, afterRight.y - probeBefore.y) > 8) {
      return;
    }

    await performDrag('middle');
    const afterMiddle = await this.projectWorldPoint(4, 2, 0);
    if (Math.hypot(afterMiddle.x - probeBefore.x, afterMiddle.y - probeBefore.y) > 8) {
      return;
    }

    await performDrag('left');
  }

  public async zoomCameraWheel(deltaY = -320): Promise<void> {
    const safePoints = await this.projectWorldPointsToClickableScreen([[0, 4, 0]], 0);
    const pt =
      safePoints[0]?.screen ??
      (await this.page.evaluate((sel: string) => {
        const rect = document.querySelector(sel)!.getBoundingClientRect();
        return {
          x: Math.round(rect.left + rect.width * 0.5),
          y: Math.round(rect.top + rect.height * 0.5),
        };
      }, SELECTORS.simCanvas));
    await this.page.mouse.move(pt.x, pt.y);
    await this.page.mouse.wheel(0, deltaY);
    await this.waitForAnimationFrames(2);
  }

  // --------------------------------------------------------------------------
  // 4.6. Расширения F24–F26 (R11–R12): Мастерская Ур. 1→5, Game Feel HUD,
  //      Авто-слоу-мо, Шкала звёзд, Секвенсор C4 и безопасные граничные клики
  // --------------------------------------------------------------------------

  public async clickOrVerifyDisabled(
    selector: string,
  ): Promise<{ wasDisabled: boolean; clicked: boolean }> {
    const loc = this.page.locator(selector);
    await expect(loc).toBeAttached();

    const state = await loc.evaluate((el: Element) => {
      if (!(el instanceof HTMLElement)) {
        return { nativelyUnclickable: true, softDisabled: true };
      }
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      const hiddenOrNoPointer =
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        style.pointerEvents === 'none' ||
        rect.width <= 0 ||
        rect.height <= 0;
      const nativeDisabled = Boolean((el as HTMLButtonElement).disabled) || el.matches(':disabled');
      const softDisabled =
        el.getAttribute('aria-disabled') === 'true' ||
        el.getAttribute('data-disabled') === 'true' ||
        el.classList.contains('disabled') ||
        el.classList.contains('is-disabled');

      return {
        nativelyUnclickable: hiddenOrNoPointer || nativeDisabled,
        softDisabled,
      };
    });

    if (state.nativelyUnclickable) {
      await this.waitForAnimationFrames(1);
      return { wasDisabled: true, clicked: false };
    }

    await loc.click();
    await this.waitForAnimationFrames(1);
    return { wasDisabled: state.softDisabled, clicked: true };
  }

  public async readWalletCreditsDom(): Promise<number> {
    const loc = this.page.locator(SELECTORS.walletCredits);
    await expect(loc).toBeAttached();
    const rawAttr = await loc.getAttribute('data-value');
    expect(
      rawAttr,
      `Индикатор ${SELECTORS.walletCredits} обязан иметь атрибут data-value="<int>"`,
    ).not.toBeNull();
    const parsed = Number(rawAttr);
    expect(
      Number.isFinite(parsed),
      `Атрибут data-value="${rawAttr}" на ${SELECTORS.walletCredits} должен быть конечным числом`,
    ).toBe(true);
    return parsed;
  }

  public async isWorkshopModalOpen(): Promise<boolean> {
    const modal = this.page.locator(SELECTORS.workshopModal);
    if ((await modal.count()) === 0) return false;
    return (await modal.getAttribute('data-open')) === 'true';
  }

  public async readWorkshopDomState(): Promise<WorkshopDomSnapshot> {
    const modal = this.page.locator(SELECTORS.workshopModal);
    await expect(modal).toBeAttached();

    const walletCredits = await this.readWalletCreditsDom();
    const modalMeta = await modal.evaluate((el: Element) => {
      const htmlEl = el as HTMLElement;
      const style = window.getComputedStyle(htmlEl);
      const rect = htmlEl.getBoundingClientRect();
      const visible =
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        Number(style.opacity ?? '1') > 0.01 &&
        rect.width > 0 &&
        rect.height > 0;
      return {
        isOpen: el.getAttribute('data-open') === 'true',
        visible,
      };
    });

    const buyAmmoBtn = this.page.locator(SELECTORS.buyExtraAmmoBtn);
    await expect(buyAmmoBtn).toBeAttached();
    const buyExtraAmmoDisabled = await buyAmmoBtn.evaluate((el: Element) => {
      return (
        Boolean((el as HTMLButtonElement).disabled) ||
        el.getAttribute('aria-disabled') === 'true' ||
        el.getAttribute('data-disabled') === 'true' ||
        el.classList.contains('disabled') ||
        el.classList.contains('is-disabled')
      );
    });

    const tools: ToolId[] = ['cannon', 'c4', 'bomb', 'cutter', 'incendiary', 'seismic'];
    const upgrades = {} as Record<ToolId, WorkshopToolUpgradeState>;

    for (const tool of tools) {
      const btn = this.page.locator(UPGRADE_BUTTON_MAP[tool]);
      await expect(btn).toBeAttached();
      upgrades[tool] = await btn.evaluate((el: Element, t: ToolId): WorkshopToolUpgradeState => {
        const levelRaw = el.getAttribute('data-level');
        const costRaw = el.getAttribute('data-cost');
        const disabled =
          Boolean((el as HTMLButtonElement).disabled) ||
          el.getAttribute('aria-disabled') === 'true' ||
          el.getAttribute('data-disabled') === 'true' ||
          el.classList.contains('disabled') ||
          el.classList.contains('is-disabled');
        return {
          tool: t,
          level: levelRaw !== null ? Number(levelRaw) : Number.NaN,
          cost: costRaw !== null ? Number(costRaw) : Number.NaN,
          disabled,
          label: (el.textContent ?? '').trim(),
        };
      }, tool);
    }

    return {
      isOpen: modalMeta.isOpen,
      modalVisible: modalMeta.visible,
      walletCredits,
      buyExtraAmmoDisabled,
      upgrades,
    };
  }

  public async openWorkshop(): Promise<WorkshopDomSnapshot> {
    if (!(await this.isWorkshopModalOpen())) {
      const openBtn = this.page.locator(SELECTORS.openWorkshopBtn);
      if (!(await openBtn.isVisible())) {
        await this.switchMode('campaign');
      }
      await expect(openBtn).toBeVisible();
      await openBtn.click();
    }
    const modal = this.page.locator(SELECTORS.workshopModal);
    await expect(modal).toHaveAttribute('data-open', 'true');
    await expect(modal).toBeVisible();
    await this.waitForAnimationFrames(1);
    return await this.readWorkshopDomState();
  }

  public async closeWorkshop(): Promise<void> {
    const modal = this.page.locator(SELECTORS.workshopModal);
    if ((await modal.count()) > 0 && (await modal.getAttribute('data-open')) === 'true') {
      const closeBtn = this.page.locator(SELECTORS.closeWorkshopBtn);
      await expect(closeBtn).toBeVisible();
      await closeBtn.click();
      await expect(modal).toHaveAttribute('data-open', 'false');
      await this.waitForAnimationFrames(1);
    }
  }

  public async tryUpgradeToolInWorkshop(tool: ToolId): Promise<UpgradeToolAttemptResult> {
    const beforeState = await this.openWorkshop();
    const upgBefore = beforeState.upgrades[tool];
    const creditsBefore = beforeState.walletCredits;

    const clickRes = await this.clickOrVerifyDisabled(UPGRADE_BUTTON_MAP[tool]);
    await this.waitForAnimationFrames(1);

    const afterState = await this.readWorkshopDomState();
    const upgAfter = afterState.upgrades[tool];
    const creditsAfter = afterState.walletCredits;

    return {
      tool,
      wasDisabled: clickRes.wasDisabled,
      upgraded: upgAfter.level > upgBefore.level,
      levelBefore: upgBefore.level,
      levelAfter: upgAfter.level,
      costBefore: upgBefore.cost,
      creditsBefore,
      creditsAfter,
    };
  }

  public async tryBuyExtraAmmoInWorkshop(): Promise<BuyExtraAmmoResult> {
    const modeBefore = (await this.getAppRootState()).activeMode;
    const budgetBefore =
      modeBefore === 'campaign'
        ? await this.readNumericIndicator(SELECTORS.missionBudgetRemaining)
        : 0;

    const beforeWorkshop = await this.openWorkshop();
    const creditsBefore = beforeWorkshop.walletCredits;

    const clickRes = await this.clickOrVerifyDisabled(SELECTORS.buyExtraAmmoBtn);
    await this.waitForAnimationFrames(1);

    const creditsAfter = await this.readWalletCreditsDom();
    const budgetAfter =
      modeBefore === 'campaign'
        ? await this.readNumericIndicator(SELECTORS.missionBudgetRemaining)
        : 0;

    return {
      wasDisabled: clickRes.wasDisabled,
      purchased: creditsAfter < creditsBefore,
      creditsBefore,
      creditsAfter,
      budgetBefore,
      budgetAfter,
    };
  }

  public async ensureWalletCreditsViaCampaign(minCreditsRequired: number): Promise<number> {
    await this.closeWorkshop();
    await this.switchMode('campaign');
    let currentCredits = await this.readWalletCreditsDom();
    if (currentCredits >= minCreditsRequired) {
      return currentCredits;
    }

    const contractOrder: Array<1 | 2 | 3 | 4 | 5 | 6 | 7 | 8> = [1, 2, 3, 4, 5, 6, 7, 8];
    for (const contractIdx of contractOrder) {
      if (currentCredits >= minCreditsRequired) break;
      await this.selectContract(contractIdx);
      await this.completeContractTargetDemolition();
      await this.waitForSimTicks(15);
      currentCredits = await this.readWalletCreditsDom();
    }
    return currentCredits;
  }

  public async setSandboxUpgradeLevel(level: ToolUpgradeLevel): Promise<DomSelectOption> {
    const currentMode = (await this.getAppRootState()).activeMode;
    if (currentMode === 'campaign') {
      await this.switchMode('sandbox');
    }
    const selectLoc = this.page.locator(SELECTORS.sandboxUpgradeLevelSelect);
    await expect(selectLoc).toBeVisible();

    const chosen = await this.selectOptionAdaptive(SELECTORS.sandboxUpgradeLevelSelect, {
      exactValue: String(level),
      nearestNumber: level,
      keywords: [
        `ур. ${level}`,
        `ур ${level}`,
        `уровень ${level}`,
        `lv ${level}`,
        `level ${level}`,
      ],
      fallbackIndex: level - 1,
    });
    await this.waitForAnimationFrames(1);
    return chosen;
  }

  public async getAutoSlowmoEnabled(): Promise<boolean> {
    const root = this.page.locator(SELECTORS.appRoot);
    const raw = await root.getAttribute('data-auto-slowmo');
    expect(
      raw,
      'На #app-root обязан присутствовать атрибут data-auto-slowmo="true|false"',
    ).not.toBeNull();
    expect(['true', 'false']).toContain(raw);
    return raw === 'true';
  }

  public async setAutoSlowmo(enabled: boolean): Promise<boolean> {
    const toggle = this.page.locator(SELECTORS.autoSlowmoToggle);
    await expect(toggle).toBeAttached();

    const meta = await toggle.evaluate((el: Element) => {
      const isCheckbox = el instanceof HTMLInputElement && el.type === 'checkbox';
      const labelEl = el.closest('label');
      const hasBox = (node: Element | null): boolean => {
        if (!(node instanceof HTMLElement)) return false;
        const st = window.getComputedStyle(node);
        const r = node.getBoundingClientRect();
        return st.display !== 'none' && st.visibility !== 'hidden' && r.width > 0 && r.height > 0;
      };
      return {
        isCheckbox,
        selfHasBox: hasBox(el),
        labelHasBox: hasBox(labelEl),
      };
    });

    if (!meta.isCheckbox) {
      await expect(toggle).toBeVisible();
    } else {
      expect(
        meta.selfHasBox || meta.labelHasBox,
        'Тумблер #auto-slowmo-toggle (или его родительский <label>) должен быть видим',
      ).toBe(true);
    }

    const root = this.page.locator(SELECTORS.appRoot);
    const current = await this.getAutoSlowmoEnabled();
    if (current !== enabled) {
      if (meta.isCheckbox) {
        const ancestorLabel = toggle.locator('xpath=ancestor::label[1]');
        if (meta.selfHasBox) {
          if (enabled) {
            await toggle.check({ force: true });
          } else {
            await toggle.uncheck({ force: true });
          }
          await this.waitForAnimationFrames(1);
        }
        if ((await root.getAttribute('data-auto-slowmo')) !== String(enabled)) {
          if (meta.labelHasBox && (await ancestorLabel.count()) > 0) {
            await ancestorLabel.click();
          } else {
            await toggle.click({ force: true });
          }
          await this.waitForAnimationFrames(1);
        }
      } else {
        await toggle.click();
        await this.waitForAnimationFrames(1);
      }
    }

    await expect
      .poll(async () => await root.getAttribute('data-auto-slowmo'), {
        timeout: 5_000,
        message: `Ожидание переключения #app-root[data-auto-slowmo] в "${String(enabled)}"`,
      })
      .toBe(String(enabled));

    return await this.getAutoSlowmoEnabled();
  }

  public async readGameFeelDomState(): Promise<GameFeelDomSnapshot> {
    const readRequiredAttrNum = async (selector: string, attrName: string): Promise<number> => {
      const loc = this.page.locator(selector);
      await expect(loc).toBeAttached();
      const raw = await loc.getAttribute(attrName);
      expect(
        raw,
        `Индикатор ${selector} обязан иметь атрибут ${attrName}`,
      ).not.toBeNull();
      const num = Number(raw);
      expect(
        Number.isFinite(num),
        `Атрибут ${attrName}="${raw}" на ${selector} должен быть конечным числом`,
      ).toBe(true);
      return num;
    };

    const [collapsedTons, destructionScore, comboMultiplier, feedMeta, autoSlowmoEnabled] =
      await Promise.all([
        readRequiredAttrNum(SELECTORS.hudCollapsedTons, 'data-value'),
        readRequiredAttrNum(SELECTORS.hudDestructionScore, 'data-value'),
        readRequiredAttrNum(SELECTORS.hudComboBadge, 'data-multiplier'),
        this.page.locator(SELECTORS.tacticalFeed).evaluate((el: Element) => {
          const lastEv = el.getAttribute('data-last-event');
          return {
            hasAttr: lastEv !== null,
            lastEvent: lastEv ?? '',
            text: (el.textContent ?? '').trim(),
          };
        }),
        this.getAutoSlowmoEnabled(),
      ]);

    expect(
      feedMeta.hasAttr,
      `Элемент ${SELECTORS.tacticalFeed} обязан иметь атрибут data-last-event`,
    ).toBe(true);

    return {
      collapsedTons,
      destructionScore,
      comboMultiplier,
      tacticalFeedLastEvent: feedMeta.lastEvent,
      tacticalFeedText: feedMeta.text,
      autoSlowmoEnabled,
    };
  }

  public async readDamageProgressBarState(): Promise<DamageProgressBarSnapshot> {
    return await this.page.evaluate(
      ({
        barSel,
        thresholdSels,
      }: {
        barSel: string;
        thresholdSels: readonly [string, string, string];
      }): DamageProgressBarSnapshot => {
        const isVis = (el: Element | null): boolean => {
          if (!(el instanceof HTMLElement)) return false;
          const st = window.getComputedStyle(el);
          const r = el.getBoundingClientRect();
          return (
            st.display !== 'none' &&
            st.visibility !== 'hidden' &&
            Number(st.opacity ?? '1') > 0.01 &&
            (r.width > 0 || r.height > 0)
          );
        };

        const barEl = document.querySelector(barSel);
        let progressNumericValue: number | null = null;
        if (barEl) {
          const rawVal =
            barEl.getAttribute('data-value') ??
            barEl.getAttribute('data-progress') ??
            barEl.getAttribute('aria-valuenow') ??
            (barEl instanceof HTMLProgressElement ? String(barEl.value) : null);
          if (rawVal !== null && rawVal.trim() !== '' && Number.isFinite(Number(rawVal))) {
            progressNumericValue = Number(rawVal);
          } else {
            const fillChild = barEl.querySelector('[data-value], [style*="width"]');
            if (fillChild instanceof HTMLElement) {
              const dv = fillChild.getAttribute('data-value');
              if (dv !== null && Number.isFinite(Number(dv))) {
                progressNumericValue = Number(dv);
              } else {
                const wMatch = fillChild.style.width.match(/(\d+(?:\.\d+)?)/);
                if (wMatch) progressNumericValue = Number(wMatch[1]);
              }
            }
          }
        }

        const tEls = thresholdSels.map((s) => document.querySelector(s));
        const extractMetric = (el: Element | null, idx: number): number => {
          if (!(el instanceof HTMLElement)) return idx;
          const attr =
            el.getAttribute('data-threshold') ??
            el.getAttribute('data-value') ??
            el.getAttribute('data-pct');
          if (attr !== null && attr.trim() !== '' && Number.isFinite(Number(attr))) {
            return Number(attr);
          }
          const rect = el.getBoundingClientRect();
          return Math.round(rect.left + rect.width * 0.5);
        };

        return {
          barAttached: Boolean(barEl),
          barVisible: isVis(barEl),
          progressNumericValue,
          thresholdsAttached: [Boolean(tEls[0]), Boolean(tEls[1]), Boolean(tEls[2])],
          thresholdsVisible: [isVis(tEls[0]), isVis(tEls[1]), isVis(tEls[2])],
          thresholdPositionsOrValues: [
            extractMetric(tEls[0], 0),
            extractMetric(tEls[1], 1),
            extractMetric(tEls[2], 2),
          ],
        };
      },
      { barSel: SELECTORS.damageProgressBar, thresholdSels: STAR_THRESHOLD_SELECTORS },
    );
  }

  public async readC4SequencerDomState(): Promise<C4SequencerDomSnapshot> {
    const panel = this.page.locator(SELECTORS.c4SequencerPanel);
    const list = this.page.locator(SELECTORS.c4SequencerList);
    await expect(panel).toBeAttached();
    await expect(list).toBeAttached();

    const rawCount = await list.getAttribute('data-queue-count');
    expect(
      rawCount,
      `Список ${SELECTORS.c4SequencerList} обязан иметь атрибут data-queue-count="<N>"`,
    ).not.toBeNull();
    const queueCountAttr = Number(rawCount);
    expect(Number.isInteger(queueCountAttr) && queueCountAttr >= 0).toBe(true);

    const meta = await this.page.evaluate(
      ({ panelSel, listSel }: { panelSel: string; listSel: string }) => {
        const panelEl = document.querySelector(panelSel) as HTMLElement | null;
        const listEl = document.querySelector(listSel) as HTMLElement | null;
        const panelVisible = panelEl
          ? (() => {
              const st = window.getComputedStyle(panelEl);
              const r = panelEl.getBoundingClientRect();
              return (
                st.display !== 'none' &&
                st.visibility !== 'hidden' &&
                r.width > 0 &&
                r.height > 0
              );
            })()
          : false;

        let renderedItemCount = 0;
        if (listEl) {
          const explicitItems = listEl.querySelectorAll(
            '[data-charge-id], [data-seq-index], li, .sequencer-item, .c4-seq-item, .c4-queue-item',
          );
          if (explicitItems.length > 0) {
            renderedItemCount = explicitItems.length;
          } else {
            renderedItemCount = Array.from(listEl.children).filter((ch) => {
              const cls = ch.className || '';
              return !/empty|placeholder|hint/i.test(cls);
            }).length;
          }
        }

        return {
          panelAttached: Boolean(panelEl),
          panelVisible,
          listAttached: Boolean(listEl),
          renderedItemCount,
          listText: (listEl?.textContent ?? '').trim(),
        };
      },
      { panelSel: SELECTORS.c4SequencerPanel, listSel: SELECTORS.c4SequencerList },
    );

    return {
      ...meta,
      queueCountAttr,
    };
  }

  public async updateC4SequencerItemDelay(
    queueIndex0Based: number,
    targetDelaySec: number,
  ): Promise<UpdateC4SequencerDelayResult> {
    await this.selectTool('c4');
    const beforeQueue = (await this.getTelemetry()).c4SequenceQueue.map((item) => ({ ...item }));
    if (queueIndex0Based < 0 || queueIndex0Based >= beforeQueue.length) {
      return { updated: false, beforeQueue, afterQueue: beforeQueue };
    }

    const targetChargeId = beforeQueue[queueIndex0Based].chargeId;
    const originalDelay = beforeQueue[queueIndex0Based].delaySec;
    const listLoc = this.page.locator(SELECTORS.c4SequencerList);
    await expect(listLoc).toBeVisible();

    const byChargeAttr = listLoc.locator(`[data-charge-id="${targetChargeId}"]`);
    const itemLoc =
      (await byChargeAttr.count()) > 0
        ? byChargeAttr.first()
        : listLoc.locator(':scope > *').nth(queueIndex0Based);
    await expect(itemLoc).toBeVisible();

    // Стратегия 1: Вложенный <select> задержки внутри элемента очереди
    const nestedSelect = itemLoc.locator('select');
    if ((await nestedSelect.count()) > 0 && (await nestedSelect.first().isVisible())) {
      const bestVal = await nestedSelect.first().evaluate((selEl: Element, desired: number) => {
        if (!(selEl instanceof HTMLSelectElement)) return null;
        let chosen = selEl.value;
        let bestDiff = Infinity;
        for (const opt of Array.from(selEl.options)) {
          if (opt.disabled) continue;
          const raw = `${opt.value} ${opt.textContent ?? ''}`.replace(',', '.');
          const m = raw.match(/([+-]?\d+(?:\.\d+)?)/);
          if (m) {
            const num = Number(m[1]);
            const diff = Math.abs(num - desired);
            if (diff < bestDiff) {
              bestDiff = diff;
              chosen = opt.value;
            }
          }
        }
        return chosen;
      }, targetDelaySec);
      if (bestVal !== null) {
        await nestedSelect.first().selectOption({ value: bestVal });
      }
      await this.waitForAnimationFrames(1);
    } else {
      // Стратегия 2: Вложенный <input type="range|number|text"> внутри элемента очереди
      const nestedInput = itemLoc.locator('input');
      if ((await nestedInput.count()) > 0 && (await nestedInput.first().isVisible())) {
        await nestedInput.first().evaluate((inpEl: Element, desired: number) => {
          if (!(inpEl instanceof HTMLInputElement)) return;
          const protoSetter = Object.getOwnPropertyDescriptor(
            HTMLInputElement.prototype,
            'value',
          )?.set;
          const strVal = String(desired);
          if (protoSetter) protoSetter.call(inpEl, strVal);
          else inpEl.value = strVal;
          inpEl.dispatchEvent(new Event('input', { bubbles: true }));
          inpEl.dispatchEvent(new Event('change', { bubbles: true }));
        }, targetDelaySec);
        await this.waitForAnimationFrames(1);
      } else {
        // Стратегия 3: Кнопки чипсов задержки (+0.25 с / +0.50 с), степперы (+/-) или циклический клик
        const buttons = itemLoc.locator('button');
        const btnCount = await buttons.count();
        let matchedChip = false;

        for (let b = 0; b < btnCount; b++) {
          const btn = buttons.nth(b);
          if (!(await btn.isVisible())) continue;
          const btnMeta = await btn.evaluate((el: Element) => {
            const dAttr = el.getAttribute('data-delay') ?? el.getAttribute('data-value') ?? '';
            const txt = (el.textContent ?? '').trim();
            return `${dAttr} ${txt}`.replace(',', '.');
          });
          const numMatch = btnMeta.match(/([+-]?\d+(?:\.\d+)?)/);
          if (numMatch && Math.abs(Number(numMatch[1]) - targetDelaySec) < 0.06) {
            await btn.click();
            await this.waitForAnimationFrames(1);
            matchedChip = true;
            break;
          }
        }

        if (!matchedChip) {
          let stepBtn: Locator | null = null;
          for (let b = 0; b < btnCount; b++) {
            const btn = buttons.nth(b);
            if (!(await btn.isVisible())) continue;
            const txt = ((await btn.textContent()) ?? '').trim().toLowerCase();
            const action = (await btn.getAttribute('data-action')) ?? '';
            if (/удал|снят|remove|del|×|✕/i.test(`${txt} ${action}`)) continue;
            if (
              targetDelaySec > originalDelay &&
              /\+|▲|inc|plus|след|шаг/i.test(`${txt} ${action}`)
            ) {
              stepBtn = btn;
              break;
            }
            if (targetDelaySec < originalDelay && /-|▼|dec|minus|пред/i.test(`${txt} ${action}`)) {
              stepBtn = btn;
              break;
            }
            if (!stepBtn) stepBtn = btn;
          }

          for (let clickAttempt = 0; clickAttempt < 5; clickAttempt++) {
            if (stepBtn) {
              await stepBtn.click();
            } else {
              await itemLoc.click();
            }
            await this.waitForAnimationFrames(1);
            const curQueue = (await this.getTelemetry()).c4SequenceQueue;
            const curEntry =
              curQueue.find((e) => e.chargeId === targetChargeId) ?? curQueue[queueIndex0Based];
            if (curEntry && Math.abs(curEntry.delaySec - targetDelaySec) < 0.08) {
              break;
            }
          }
        }
      }
    }

    const afterQueue = (await this.getTelemetry()).c4SequenceQueue.map((item) => ({ ...item }));
    const afterEntry =
      afterQueue.find((e) => e.chargeId === targetChargeId) ?? afterQueue[queueIndex0Based];
    const updated = Boolean(
      afterEntry &&
        (Math.abs(afterEntry.delaySec - targetDelaySec) < 0.15 ||
          Math.abs(afterEntry.delaySec - originalDelay) > 0.01),
    );

    return { updated, beforeQueue, afterQueue };
  }
}

// ============================================================================
// 5. PLAYWRIGHT FIXTURE (ЭКСПОРТ test И expect ДЛЯ ВСЕХ СПЕК TIERS 1-4)
// ============================================================================

export const test = base.extend<{ harness: ShatterpointHarness }>({
  harness: async ({ page }, use) => {
    const harness = new ShatterpointHarness(page);
    await use(harness);
    if (harness.isAutoAssertZeroErrorsEnabled()) {
      harness.assertZeroRuntimeErrors('завершения теста');
    }
  },
});

export { expect };
