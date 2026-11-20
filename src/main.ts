import {
  FIXED_DT,
  STRUCTURAL_MATERIAL_IDS,
  type AppMode,
  type LabBenchId,
  type QualityPreset,
  type RenderViewMode,
  type SimulationEvent,
  type StructuralMaterialId,
  type ToolId,
  type Vec3,
} from './core/types';
import { DestructionWorld } from './physics/DestructionWorld';
import { SceneRenderer } from './render/SceneRenderer';
import type { SkyAtmospherePreset } from './render/TacticalOverlay3D';
import { DestructionSoundEngine } from './audio/DestructionSoundEngine';
import {
  spawnBlueprintInWorld,
  type SandboxBlueprintId,
} from './content/BuildingBlueprints';
import {
  CAMPAIGN_CONTRACTS,
  spawnCampaignContractInWorld,
  type CampaignContractSpec,
} from './content/CampaignMissions';
import { LAB_BENCHES, spawnLabBenchInWorld } from './content/LabBenches';
import {
  EXTRA_AMMO_BUDGET_BONUS,
  EXTRA_AMMO_PACK_COST,
  ProgressionStore,
  type ToolUpgradeLevel,
} from './modes/ProgressionStore';
import {
  executeArsenalTool,
  getToolPreviewRadiusM,
  TOOL_ORDER,
} from './modes/ArsenalController';

/**
 * Главная точка входа «ТОЧКА РАЗЛОМА» (v1.0 Complete Edition):
 * - 3 полноценных режима: Кампания (8 контрактов), Свободная Песочница (6 чертежей + 3D-Конструктор),
 *   Физическая Лаборатория (4 стенда + 7 ползунков СИ);
 * - Экономическая прогрессия и Мастерская улучшений Ур. 1 -> Ур. 5 (localStorage);
 * - Живой 3D-прицел на гранях, 3D-луч плазморезака, трассеры пушки и переключатель неба (День / Закат / Ночь);
 * - Диагностический мост Read-Only window.__SHATTERPOINT__ для сквозной браузерной верификации.
 */

type MissionStatus = 'planning' | 'running' | 'victory' | 'defeat';
type MissionFailReason = 'none' | 'collateral' | 'budget_exhausted';

interface BridgeTelemetry {
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
  mode: AppMode;
  missionStatus: MissionStatus;
  collateralPct: number;
  stars: number;
  fps: number;
  drawCalls: number;
  walletCredits: number;
  toolLevels: Record<ToolId, number>;
  collapsedMassTons: number;
  destructionScore: number;
  comboMultiplier: number;
  criticalNodesCount: number;
  c4SequenceQueue: Array<{ chargeId: number; delaySec: number }>;
  activeTriggersCount: number;
  activeBench?: LabBenchId | null;
  activeContractId?: string | null;
  audioMuted?: boolean;
  activeMaterialId?: StructuralMaterialId;
  buildModeActive?: boolean;
  qualityPreset?: QualityPreset;
}

declare global {
  interface Window {
    __SHATTERPOINT__?: {
      getTelemetry(): BridgeTelemetry;
      projectWorldPoint(x: number, y: number, z: number): { x: number; y: number; visible: boolean };
    };
  }
}

const VIEW_MODE_ORDER: readonly RenderViewMode[] = ['pbr', 'stress', 'xray'];
const C4_DELAY_PRESETS: readonly number[] = [0, 0.25, 0.5, 1.0, 1.5];
const SANDBOX_MULTI_OFFSETS: readonly Vec3[] = [
  [0, 0, 0],
  [14, 0, 0],
  [-14, 0, 0],
  [0, 0, 11],
  [0, 0, -11],
  [14, 0, 10],
  [-14, 0, -10],
];
const DRAG_CLICK_THRESHOLD_PX = 5;

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) {
    throw new Error(`Не найден обязательный элемент DOM #${id}`);
  }
  return el as T;
}

function formatStarsString(stars: number): string {
  const s = Math.min(3, Math.max(0, Math.trunc(stars)));
  return '★'.repeat(s) + '☆'.repeat(3 - s);
}

function getBuilderBlockHalfExtents(materialId: StructuralMaterialId): Vec3 {
  if (materialId === 'explosive') return [0.48, 0.6, 0.48];
  if (materialId === 'glass') return [0.72, 0.68, 0.68];
  if (materialId === 'steel') return [0.65, 0.65, 0.65];
  return [0.75, 0.65, 0.75];
}

function computeBuilderPlacementCenter(
  hitPoint: Vec3,
  hitNormal: Vec3,
  halfExtents: Vec3,
  isGround: boolean,
): Vec3 {
  if (isGround) {
    return [
      Number(hitPoint[0].toFixed(2)),
      halfExtents[1],
      Number(hitPoint[2].toFixed(2)),
    ];
  }
  const offsetDist =
    Math.abs(hitNormal[0]) * halfExtents[0] +
    Math.abs(hitNormal[1]) * halfExtents[1] +
    Math.abs(hitNormal[2]) * halfExtents[2];
  return [
    Number((hitPoint[0] + hitNormal[0] * offsetDist).toFixed(3)),
    Math.max(halfExtents[1], Number((hitPoint[1] + hitNormal[1] * offsetDist).toFixed(3))),
    Number((hitPoint[2] + hitNormal[2] * offsetDist).toFixed(3)),
  ];
}

async function bootstrapApplication(): Promise<void> {
  const root = byId<HTMLDivElement>('app-root');
  const canvas = byId<HTMLCanvasElement>('sim-canvas');
  const loadingOverlay = byId<HTMLDivElement>('loading-overlay');
  const loadingText = byId<HTMLParagraphElement>('loading-text');

  // Режимы и экономика
  const modeCampaignBtn = byId<HTMLButtonElement>('mode-campaign-btn');
  const modeSandboxBtn = byId<HTMLButtonElement>('mode-sandbox-btn');
  const modeLabBtn = byId<HTMLButtonElement>('mode-lab-btn');
  const elWalletCredits = byId<HTMLSpanElement>('wallet-credits');
  const openWorkshopBtn = byId<HTMLButtonElement>('open-workshop-btn');
  const workshopModal = byId<HTMLDivElement>('workshop-modal');
  const closeWorkshopBtn = byId<HTMLButtonElement>('close-workshop-btn');
  const buyExtraAmmoBtn = byId<HTMLButtonElement>('buy-extra-ammo-btn');

  // Время, вид, атмосфера, качество, звук, сброс
  const pauseBtn = byId<HTMLButtonElement>('time-pause-btn');
  const stepBtn = byId<HTMLButtonElement>('time-step-btn');
  const bulletBtn = byId<HTMLButtonElement>('time-bullet-btn');
  const timeScaleSelect = byId<HTMLSelectElement>('time-scale-select');
  const viewPbrBtn = byId<HTMLButtonElement>('view-pbr-btn');
  const viewStressBtn = byId<HTMLButtonElement>('view-stress-btn');
  const viewXrayBtn = byId<HTMLButtonElement>('view-xray-btn');
  const skyDayBtn = byId<HTMLButtonElement>('sky-day-btn');
  const skySunsetBtn = byId<HTMLButtonElement>('sky-sunset-btn');
  const skyNightBtn = byId<HTMLButtonElement>('sky-night-btn');
  const qualitySelect = byId<HTMLSelectElement>('quality-select');
  const muteBtn = byId<HTMLButtonElement>('audio-mute-btn');
  const resetBtn = byId<HTMLButtonElement>('scene-reset-btn');

  // Шкала прогресса и комбо
  const elDestructionScore = byId<HTMLSpanElement>('hud-destruction-score');
  const elComboBadge = byId<HTMLDivElement>('hud-combo-badge');
  const elDamageBar = byId<HTMLDivElement>('damage-progress-bar');
  const elDamageFill = byId<HTMLDivElement>('damage-progress-fill');
  const elStarThreshold1 = byId<HTMLSpanElement>('star-threshold-1');
  const elStarThreshold2 = byId<HTMLSpanElement>('star-threshold-2');
  const elStarThreshold3 = byId<HTMLSpanElement>('star-threshold-3');

  // Арсенал и секвенсор C4
  const arsenalModeHint = byId<HTMLSpanElement>('arsenal-mode-hint');
  const toolButtons = new Map<ToolId, HTMLButtonElement>();
  for (const t of TOOL_ORDER) {
    toolButtons.set(t, byId<HTMLButtonElement>(`tool-${t}`));
  }
  const c4DelaySelect = byId<HTMLSelectElement>('c4-delay-select');
  const c4SequencerList = byId<HTMLOListElement>('c4-sequencer-list');
  const detonateC4Btn = byId<HTMLButtonElement>('detonate-c4-btn');
  const autoSlowmoToggle = byId<HTMLInputElement>('auto-slowmo-toggle');

  // Песочница и Конструктор
  const sandboxPanel = byId<HTMLDivElement>('sandbox-controls-panel');
  const sandboxUpgradeSelect = byId<HTMLSelectElement>('sandbox-upgrade-level-select');
  const sandboxSpawnSelect = byId<HTMLSelectElement>('sandbox-spawn-select');
  const sandboxSpawnBtn = byId<HTMLButtonElement>('sandbox-spawn-btn');
  const sandboxBuildToggle = byId<HTMLButtonElement>('sandbox-build-toggle');
  const materialButtons = new Map<StructuralMaterialId, HTMLButtonElement>();
  for (const m of STRUCTURAL_MATERIAL_IDS) {
    materialButtons.set(m, byId<HTMLButtonElement>(`mat-${m}`));
  }

  // Кампания
  const campaignPanel = byId<HTMLElement>('campaign-panel');
  const contractButtons = CAMPAIGN_CONTRACTS.map((c) => byId<HTMLButtonElement>(c.selectorId));
  const missionResultPanel = byId<HTMLDivElement>('mission-result-panel');
  const missionTitleText = byId<HTMLDivElement>('mission-title-text');
  const missionBriefingText = byId<HTMLParagraphElement>('mission-briefing-text');
  const elMissionBudget = byId<HTMLSpanElement>('mission-budget-remaining');
  const elMissionProgress = byId<HTMLSpanElement>('mission-target-progress');
  const elMissionCollateral = byId<HTMLSpanElement>('mission-collateral-pct');
  const elMissionStatusBadge = byId<HTMLSpanElement>('mission-status-badge');
  const elMissionStars = byId<HTMLSpanElement>('mission-stars');
  const nextContractBtn = byId<HTMLButtonElement>('next-contract-btn');

  // Лаборатория
  const labPanel = byId<HTMLElement>('lab-panel');
  const labBenchButtons: Record<LabBenchId, HTMLButtonElement> = {
    materials: byId<HTMLButtonElement>('lab-bench-materials'),
    ballistics: byId<HTMLButtonElement>('lab-bench-ballistics'),
    blast: byId<HTMLButtonElement>('lab-bench-blast'),
    seismic: byId<HTMLButtonElement>('lab-bench-seismic'),
  };
  const labBenchDesc = byId<HTMLParagraphElement>('lab-bench-desc');
  const sliderGravity = byId<HTMLInputElement>('slider-gravity');
  const sliderJointStrength = byId<HTMLInputElement>('slider-joint-strength');
  const sliderSecondaryDmg = byId<HTMLInputElement>('slider-secondary-dmg');
  const sliderBlastFalloff = byId<HTMLInputElement>('slider-blast-falloff');
  const sliderFireRate = byId<HTMLInputElement>('slider-fire-rate');
  const sliderQuakeFreqHz = byId<HTMLInputElement>('slider-quake-freq-hz');
  const sliderQuakeAmp = byId<HTMLInputElement>('slider-quake-amp');
  const valGravity = byId<HTMLElement>('val-gravity');
  const valJointStrength = byId<HTMLElement>('val-joint-strength');
  const valSecondaryDmg = byId<HTMLElement>('val-secondary-dmg');
  const valBlastFalloff = byId<HTMLElement>('val-blast-falloff');
  const valFireRate = byId<HTMLElement>('val-fire-rate');
  const valQuakeFreq = byId<HTMLElement>('val-quake-freq');
  const valQuakeAmp = byId<HTMLElement>('val-quake-amp');
  const btnTriggerQuake = byId<HTMLButtonElement>('btn-trigger-quake');

  // Телеметрия и подсказка
  const elCollapsedTons = byId<HTMLSpanElement>('hud-collapsed-tons');
  const elDestructionPct = byId<HTMLSpanElement>('telemetry-destruction-pct');
  const elIntactJoints = byId<HTMLSpanElement>('telemetry-intact-joints');
  const elRebarLinks = byId<HTMLSpanElement>('telemetry-rebar-links');
  const elBurningNodes = byId<HTMLSpanElement>('telemetry-burning-nodes');
  const elMaxTemp = byId<HTMLSpanElement>('telemetry-max-temp-c');
  const elKineticKj = byId<HTMLSpanElement>('telemetry-kinetic-kj');
  const elFps = byId<HTMLSpanElement>('telemetry-fps');
  const tacticalFeed = byId<HTMLDivElement>('tactical-feed');
  const controlsHint = byId<HTMLElement>('controls-hint');
  const hintCloseBtn = byId<HTMLButtonElement>('hint-close-btn');

  // Кнопки апгрейдов Мастерской
  const upgradeButtons: Record<ToolId, HTMLButtonElement> = {
    cannon: byId<HTMLButtonElement>('upgrade-cannon-btn'),
    c4: byId<HTMLButtonElement>('upgrade-c4-btn'),
    bomb: byId<HTMLButtonElement>('upgrade-bomb-btn'),
    cutter: byId<HTMLButtonElement>('upgrade-cutter-btn'),
    incendiary: byId<HTMLButtonElement>('upgrade-incendiary-btn'),
    seismic: byId<HTMLButtonElement>('upgrade-seismic-btn'),
  };
  const upgradeBadges: Record<ToolId, HTMLElement> = {
    cannon: byId<HTMLElement>('lvl-badge-cannon'),
    c4: byId<HTMLElement>('lvl-badge-c4'),
    bomb: byId<HTMLElement>('lvl-badge-bomb'),
    cutter: byId<HTMLElement>('lvl-badge-cutter'),
    incendiary: byId<HTMLElement>('lvl-badge-incendiary'),
    seismic: byId<HTMLElement>('lvl-badge-seismic'),
  };

  // Инициализация систем
  const progression = new ProgressionStore();
  loadingText.textContent = 'Инициализация WASM-ядра Rapier3D…';
  const world = await DestructionWorld.create({ seed: 2026 });

  loadingText.textContent = 'Запуск 3D PBR-рендерера…';
  const renderer = new SceneRenderer({
    canvas,
    quality: (qualitySelect.value as QualityPreset) || 'high',
    seed: 2026,
  });

  const audio = new DestructionSoundEngine({
    seed: 2026,
    masterVolume: 0.72,
    autoUnlockOnInteraction: true,
  });

  // Состояние приложения
  let activeMode: AppMode = 'sandbox';
  let activeTool: ToolId = 'cannon';
  let viewMode: RenderViewMode = 'pbr';
  let skyPreset: SkyAtmospherePreset = 'day';
  let paused = false;
  let userTimeScale = 1;
  let bulletTimeActive = false;
  let autoSlowmoEnabled = false;
  let autoSlowmoImpulseSec = 0;
  let muted = false;
  let workshopOpen = false;

  // Состояние Песочницы и Конструктора
  let sandboxLevelOverride: ToolUpgradeLevel | null = null;
  let sandboxMultiIndex = 1;
  let buildModeActive = false;
  let activeMaterialId: StructuralMaterialId = 'reinforced_concrete';

  // Состояние Лаборатории
  let activeBenchId: LabBenchId = 'materials';
  let quakeFreqHz = 2.5;
  let quakeAmpM = 0.35;

  // Состояние Кампании
  let activeContract: CampaignContractSpec = CAMPAIGN_CONTRACTS[0]!;
  let missionStatus: MissionStatus = 'planning';
  let missionFailReason: MissionFailReason = 'none';
  let missionStars: 0 | 1 | 2 | 3 = 0;
  let missionAwardedStars: 0 | 1 | 2 | 3 = 0;
  let missionBudgetRemaining = activeContract.budgetLimit;
  let missionAmmo: Partial<Record<ToolId, number>> = {};
  let c4PlantedCostLedger = new Map<number, number>();
  let exhaustedWaitTicks = 0;

  // Секвенсор C4 и Game Feel метрики
  let c4DelaySec = 0;
  let accumulatedFractureTons = 0;
  let destructionScore = 0;
  let comboMultiplier = 1.0;
  let criticalNodeIdsCache: number[] = [];
  let lastCriticalTick = -100;

  // Состояние мыши и 3D-прицела
  let pointerInsideCanvas = false;
  let pointerClientX = 0;
  let pointerClientY = 0;
  let primaryPointerDown = false;
  let primaryPointerId: number | null = null;
  let rightDownPos: { x: number; y: number } | null = null;
  let cutterBeamHoldTimerSec = 0;

  // Тайминги кадров
  let accumulatorSec = 0;
  let lastFrameMs = performance.now();
  let fpsSmoothed = 60;

  const feedMessages: Array<{ text: string; critical: boolean }> = [];

  function pushTacticalMessage(text: string, critical = false): void {
    if (feedMessages.length > 0 && feedMessages[0]!.text === text) {
      return;
    }
    feedMessages.unshift({ text, critical });
    if (feedMessages.length > 4) {
      feedMessages.length = 4;
    }
    tacticalFeed.dataset.lastEvent = text;
    tacticalFeed.replaceChildren(
      ...feedMessages.map((item) => {
        const div = document.createElement('div');
        div.className = item.critical ? 'tactical-item critical' : 'tactical-item';
        div.textContent = item.text;
        return div;
      }),
    );
  }

  function getEffectiveToolLevels(): Record<ToolId, ToolUpgradeLevel> {
    if (activeMode === 'campaign' || workshopOpen || sandboxLevelOverride === null) {
      return progression.getToolLevelsCopy();
    }
    return {
      cannon: sandboxLevelOverride,
      c4: sandboxLevelOverride,
      bomb: sandboxLevelOverride,
      cutter: sandboxLevelOverride,
      incendiary: sandboxLevelOverride,
      seismic: sandboxLevelOverride,
    };
  }

  function getEffectiveLevelForTool(tool: ToolId): ToolUpgradeLevel {
    return getEffectiveToolLevels()[tool];
  }

  function getDisplayedTimeScale(): number {
    return bulletTimeActive ? 0.2 : userTimeScale;
  }

  function getPhysicsSimulationTimeScale(): number {
    const base = getDisplayedTimeScale();
    if (autoSlowmoEnabled && autoSlowmoImpulseSec > 0) {
      return Math.max(0.35, Math.min(base, 0.42));
    }
    return base;
  }

  function syncTimeScaleState(): void {
    const displayed = getDisplayedTimeScale();
    const simScale = getPhysicsSimulationTimeScale();
    world.setTimeScale(simScale);
    audio.setTimeScale(simScale);
    // Пользовательский data-time-scale строго сохраняет выбранный масштаб без перезаписи авто-слоу-мо!
    root.dataset.timeScale = String(Number(displayed.toFixed(2)));
  }

  function setPausedState(nextPaused: boolean): void {
    paused = nextPaused;
    world.setPaused(paused);
    root.dataset.paused = String(paused);
    pauseBtn.classList.toggle('active', paused);
    pauseBtn.textContent = paused ? '▶ Пуск' : '⏸ Пауза';
  }

  function setBulletTime(active: boolean): void {
    bulletTimeActive = active;
    bulletBtn.classList.toggle('active', bulletTimeActive);
    syncTimeScaleState();
  }

  function setViewMode(mode: RenderViewMode): void {
    viewMode = mode;
    renderer.setViewMode(mode);
    root.dataset.renderMode = mode;
    viewPbrBtn.classList.toggle('active', mode === 'pbr');
    viewStressBtn.classList.toggle('active', mode === 'stress');
    viewXrayBtn.classList.toggle('active', mode === 'xray');
  }

  function setSkyPreset(preset: SkyAtmospherePreset): void {
    skyPreset = preset;
    renderer.setSkyPreset(preset);
    skyDayBtn.classList.toggle('active', preset === 'day');
    skySunsetBtn.classList.toggle('active', preset === 'sunset');
    skyNightBtn.classList.toggle('active', preset === 'night');
  }

  function setBuildMode(enabled: boolean): void {
    const next = activeMode === 'sandbox' ? enabled : false;
    buildModeActive = next;
    root.dataset.buildMode = String(next);
    sandboxBuildToggle.dataset.buildMode = String(next);
    sandboxBuildToggle.setAttribute('aria-pressed', String(next));
    sandboxBuildToggle.classList.toggle('active', next);
    sandboxBuildToggle.textContent = next
      ? '🧱 Выключить конструктор'
      : '🧱 Включить конструктор';
    updateAimReticleOverlay();
  }

  function setActiveMaterial(mat: StructuralMaterialId): void {
    activeMaterialId = mat;
    root.dataset.activeMaterial = mat;
    for (const [id, btn] of materialButtons) {
      btn.classList.toggle('active', id === mat);
    }
    updateAimReticleOverlay();
  }

  function isToolAvailableInCurrentState(tool: ToolId): boolean {
    if (activeMode !== 'campaign') return true;
    if (missionStatus === 'defeat') return false;
    const ammo = missionAmmo[tool] ?? 0;
    const cost = activeContract.toolCosts[tool];
    if (cost === undefined || ammo <= 0) return false;
    return missionBudgetRemaining >= cost;
  }

  function syncToolButtonsUI(): void {
    const levels = getEffectiveToolLevels();
    arsenalModeHint.textContent =
      activeMode === 'campaign' ? 'По смете' : `Ур. ${levels[activeTool]}`;

    for (const tool of TOOL_ORDER) {
      const btn = toolButtons.get(tool)!;
      const metaSpan = btn.querySelector('[data-role="meta"]');
      const lvl = levels[tool];
      const available = isToolAvailableInCurrentState(tool);

      btn.disabled = !available;
      btn.setAttribute('aria-disabled', String(!available));
      btn.classList.toggle('active', activeTool === tool && !buildModeActive);

      if (activeMode === 'campaign') {
        const ammo = Math.max(0, missionAmmo[tool] ?? 0);
        btn.setAttribute('data-ammo', String(ammo));
        if (metaSpan) {
          metaSpan.textContent =
            activeContract.toolCosts[tool] !== undefined ? `×${ammo} · Ур.${lvl}` : '—';
        }
      } else {
        btn.removeAttribute('data-ammo');
        if (metaSpan) {
          metaSpan.textContent = `Ур.${lvl}`;
        }
      }
    }
  }

  function setActiveTool(tool: ToolId): void {
    activeTool = tool;
    root.dataset.activeTool = tool;
    if (buildModeActive) {
      setBuildMode(false);
    }
    syncToolButtonsUI();
    updateAimReticleOverlay();
  }

  function syncWorkshopUI(): void {
    const credits = progression.getWalletCredits();
    elWalletCredits.textContent = String(credits);
    elWalletCredits.dataset.value = String(credits);

    workshopModal.dataset.open = String(workshopOpen);
    const canAmmo = progression.canBuyExtraAmmo();
    buyExtraAmmoBtn.disabled = !canAmmo;
    buyExtraAmmoBtn.setAttribute('aria-disabled', String(!canAmmo));
    buyExtraAmmoBtn.dataset.cost = String(EXTRA_AMMO_PACK_COST);
    buyExtraAmmoBtn.textContent = `Купить пакет (+1) · ${EXTRA_AMMO_PACK_COST} кр. [купленно: ${progression.getExtraAmmoPacks()}]`;

    for (const tool of TOOL_ORDER) {
      const lvl = progression.getToolLevel(tool);
      const cost = progression.getUpgradeCost(tool);
      const canUpg = progression.canUpgradeTool(tool);
      const btn = upgradeButtons[tool];
      const badge = upgradeBadges[tool];

      badge.textContent = `Ур. ${lvl} / 5`;
      btn.dataset.level = String(lvl);
      btn.dataset.cost = String(cost);
      btn.disabled = !canUpg;
      btn.setAttribute('aria-disabled', String(!canUpg));
      btn.textContent =
        lvl >= 5 ? 'Макс. уровень (Ур. 5)' : `Улучшить до Ур. ${lvl + 1} · ${cost} кр.`;
    }
  }

  function syncContractCardsUI(): void {
    for (let i = 0; i < CAMPAIGN_CONTRACTS.length; i++) {
      const spec = CAMPAIGN_CONTRACTS[i]!;
      const btn = contractButtons[i]!;
      const rec = progression.getContractRecord(spec.id);
      const shortTitle = spec.titleRu.split('·')[1]?.trim().split(' ')[0] ?? spec.titleRu;
      const numStr = String(spec.index1Based).padStart(2, '0');
      const starsBadge = rec.completed ? ` ${'★'.repeat(rec.bestStars)}` : '';
      btn.textContent = `${numStr} · ${shortTitle}${starsBadge}`;
      btn.dataset.completed = String(rec.completed);
      btn.dataset.bestStars = String(rec.bestStars);
      btn.classList.toggle('active', activeContract.id === spec.id);
    }
  }

  function syncStarThresholdsBar(thresholds: readonly [number, number, number]): void {
    const [t1, t2, t3] = thresholds;
    elStarThreshold1.dataset.threshold = String(t1);
    elStarThreshold1.style.left = `${t1}%`;
    elStarThreshold2.dataset.threshold = String(t2);
    elStarThreshold2.style.left = `${t2}%`;
    elStarThreshold3.dataset.threshold = String(t3);
    elStarThreshold3.style.left = `${t3}%`;
  }

  function getCollapsedMassTons(): number {
    const coreTons = world.getCollapsedMassKg() / 1000;
    return Number(Math.max(coreTons, accumulatedFractureTons).toFixed(2));
  }

  function syncC4SequencerUI(): void {
    const queue = world.getC4SequenceQueue();
    root.dataset.plantedC4 = String(queue.length);
    c4SequencerList.dataset.queueCount = String(queue.length);

    // Обновляем список только если изменился состав или задержки, чтобы не сбивать открытый <select>
    const currentSignature = queue.map((q) => `${q.chargeId}:${q.delaySec.toFixed(2)}`).join('|');
    if (c4SequencerList.dataset.renderSig === currentSignature) {
      return;
    }
    c4SequencerList.dataset.renderSig = currentSignature;

    c4SequencerList.replaceChildren(
      ...queue.map((item, idx) => {
        const li = document.createElement('li');
        li.className = 'c4-queue-item';
        li.dataset.chargeId = String(item.chargeId);
        li.dataset.seqIndex = String(idx);

        const label = document.createElement('span');
        label.textContent = `#${idx + 1}`;

        const sel = document.createElement('select');
        sel.setAttribute('aria-label', `Задержка заряда C4 #${idx + 1}`);
        const delays = C4_DELAY_PRESETS.includes(Number(item.delaySec.toFixed(2)))
          ? C4_DELAY_PRESETS
          : [...C4_DELAY_PRESETS, Number(item.delaySec.toFixed(2))].sort((a, b) => a - b);

        for (const d of delays) {
          const opt = document.createElement('option');
          opt.value = String(d);
          opt.textContent = `+${d.toFixed(2)} с`;
          if (Math.abs(d - item.delaySec) < 0.01) {
            opt.selected = true;
          }
          sel.appendChild(opt);
        }

        sel.addEventListener('change', () => {
          const nextDelay = Number.parseFloat(sel.value);
          if (Number.isFinite(nextDelay) && nextDelay >= 0) {
            world.updateC4Delay(item.chargeId, nextDelay);
            renderer.syncSnapshot(world.getRenderSnapshot());
            c4SequencerList.dataset.renderSig = '';
            syncC4SequencerUI();
          }
        });

        const delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'c4-remove-btn';
        delBtn.dataset.action = 'remove';
        delBtn.title = 'Снять заряд C4';
        delBtn.textContent = '×';
        delBtn.addEventListener('click', () => {
          removeChargeAndRefund(item.chargeId);
        });

        li.append(label, sel, delBtn);
        return li;
      }),
    );
  }

  function removeChargeAndRefund(chargeId: number): boolean {
    const removed = world.removeC4(chargeId);
    if (!removed) return false;
    if (activeMode === 'campaign') {
      const refundedCost = c4PlantedCostLedger.get(chargeId) ?? 0;
      c4PlantedCostLedger.delete(chargeId);
      missionBudgetRemaining += refundedCost;
      missionAmmo.c4 = (missionAmmo.c4 ?? 0) + 1;
      syncToolButtonsUI();
    }
    pushTacticalMessage('Заряд C4 снят с конструкции');
    renderer.syncSnapshot(world.getRenderSnapshot());
    c4SequencerList.dataset.renderSig = '';
    syncC4SequencerUI();
    syncAllHud();
    return true;
  }

  function evaluateCampaignMissionRules(): void {
    if (activeMode !== 'campaign') return;
    const t = world.getTelemetry();
    const collateral = t.protectedDamagePct;
    const destr = t.destructionPct;

    if (missionStatus !== 'defeat' && collateral > activeContract.maxCollateralPct) {
      missionStatus = 'defeat';
      missionFailReason = 'collateral';
      missionStars = 0;
      pushTacticalMessage('Контракт сорван: превышен ущерб соседним зданиям!', true);
      syncToolButtonsUI();
      return;
    }

    if (missionStatus !== 'defeat' && destr >= activeContract.targetDestructionPct) {
      const [s1, s2, s3] = activeContract.starThresholdsPct;
      const computedStars: 1 | 2 | 3 = destr >= s3 ? 3 : destr >= s2 ? 2 : s1 >= 0 ? 1 : 1;

      if (missionStatus !== 'victory') {
        missionStatus = 'victory';
        missionFailReason = 'none';
        missionStars = computedStars;
        missionAwardedStars = computedStars;
        const budgetSavedBonus = Math.round(missionBudgetRemaining * 0.15);
        const comboBonus = Math.round((comboMultiplier - 1) * 80);
        const earned = progression.recordContractVictory({
          contractId: activeContract.id,
          stars: computedStars,
          destructionPct: destr,
          baseRewardCredits: activeContract.rewardCredits,
          budgetSavedBonus,
          comboBonus,
        });
        pushTacticalMessage(`Контракт выполнен (${computedStars}★)! +${earned} кр.`, true);
        syncWorkshopUI();
        syncContractCardsUI();
      } else if (computedStars > missionAwardedStars) {
        const diffStars = computedStars - missionAwardedStars;
        missionStars = computedStars;
        missionAwardedStars = computedStars;
        progression.recordContractVictory({
          contractId: activeContract.id,
          stars: computedStars,
          destructionPct: destr,
          baseRewardCredits: diffStars * 120,
          budgetSavedBonus: 0,
          comboBonus: 0,
        });
        syncWorkshopUI();
        syncContractCardsUI();
      }
      return;
    }

    if (missionStatus === 'running') {
      const anyToolUsable = TOOL_ORDER.some((tool) => isToolAvailableInCurrentState(tool));
      const c4Pending = world.getPlantedC4Count() > 0;
      const snap = world.getRenderSnapshot();
      const projectilesFlying = snap.projectiles.length > 0;
      const calm = t.kineticEnergyKJ < 8 && t.burningNodeCount === 0 && !t.seismicActive;

      if (!anyToolUsable && !c4Pending && !projectilesFlying) {
        exhaustedWaitTicks += calm ? 2 : 1;
        if (exhaustedWaitTicks >= 95 && destr < activeContract.targetDestructionPct) {
          missionStatus = 'defeat';
          missionFailReason = 'budget_exhausted';
          missionStars = 0;
          pushTacticalMessage('Сметный бюджет исчерпан — норма сноса не достигнута', true);
          syncToolButtonsUI();
        }
      } else {
        exhaustedWaitTicks = 0;
      }
    }
  }

  function syncMissionPanelUI(): void {
    const t = world.getTelemetry();
    missionResultPanel.dataset.missionStatus = missionStatus;
    missionResultPanel.dataset.failReason = missionFailReason;
    missionResultPanel.dataset.stars = String(missionStars);

    missionTitleText.textContent = activeContract.titleRu;
    missionBriefingText.textContent = activeContract.briefingRu;

    const cleanBudget = Math.max(0, Math.round(missionBudgetRemaining));
    elMissionBudget.textContent = String(cleanBudget);
    elMissionBudget.dataset.value = String(cleanBudget);

    elMissionProgress.textContent = t.destructionPct.toFixed(1);
    elMissionProgress.dataset.value = t.destructionPct.toFixed(2);

    elMissionCollateral.textContent = t.protectedDamagePct.toFixed(1);
    elMissionCollateral.dataset.value = t.protectedDamagePct.toFixed(2);

    elMissionStars.textContent = formatStarsString(missionStars);

    if (missionStatus === 'victory') {
      elMissionStatusBadge.textContent = `Победа · ${missionStars}★`;
      nextContractBtn.classList.toggle('hidden', activeContract.index1Based >= 8);
    } else if (missionStatus === 'defeat') {
      elMissionStatusBadge.textContent =
        missionFailReason === 'collateral' ? 'Провал: ущерб соседям' : 'Провал: бюджет исчерпан';
      nextContractBtn.classList.add('hidden');
    } else if (missionStatus === 'running') {
      elMissionStatusBadge.textContent = `В работе (цель ${activeContract.targetDestructionPct}%)`;
      nextContractBtn.classList.add('hidden');
    } else {
      elMissionStatusBadge.textContent = `Цель сноса: ${activeContract.targetDestructionPct}%`;
      nextContractBtn.classList.add('hidden');
    }
  }

  function syncAllHud(): void {
    const t = world.getTelemetry();
    const tons = getCollapsedMassTons();
    const cleanScore = Math.max(0, Math.round(destructionScore));
    const cleanCombo = Number(comboMultiplier.toFixed(2));

    elCollapsedTons.textContent = tons.toFixed(1);
    elCollapsedTons.dataset.value = String(tons);

    elDestructionScore.textContent = String(cleanScore);
    elDestructionScore.dataset.value = String(cleanScore);

    elComboBadge.textContent = `×${cleanCombo.toFixed(1)} КОМБО`;
    elComboBadge.dataset.multiplier = String(cleanCombo);
    elComboBadge.classList.toggle('hot', cleanCombo > 1.05);

    const pct = t.destructionPct;
    elDamageBar.dataset.value = pct.toFixed(2);
    elDamageBar.setAttribute('aria-valuenow', pct.toFixed(1));
    elDamageFill.style.width = `${Math.min(100, Math.max(0, pct)).toFixed(1)}%`;

    elDestructionPct.textContent = pct.toFixed(1);
    elDestructionPct.dataset.value = pct.toFixed(2);
    elIntactJoints.textContent = String(t.intactJointCount);
    elIntactJoints.dataset.value = String(t.intactJointCount);
    elRebarLinks.textContent = String(t.activeRebarCount);
    elRebarLinks.dataset.value = String(t.activeRebarCount);
    elBurningNodes.textContent = String(t.burningNodeCount);
    elBurningNodes.dataset.value = String(t.burningNodeCount);
    elMaxTemp.textContent = String(Math.round(t.maxTemperatureC));
    elMaxTemp.dataset.value = String(Number(t.maxTemperatureC.toFixed(1)));
    elKineticKj.textContent = t.kineticEnergyKJ.toFixed(0);
    elKineticKj.dataset.value = t.kineticEnergyKJ.toFixed(2);
    const fpsInt = Math.max(1, Math.round(fpsSmoothed));
    elFps.textContent = String(fpsInt);
    elFps.dataset.value = String(fpsInt);

    root.dataset.simTick = String(t.tick);
    syncC4SequencerUI();
    if (activeMode === 'campaign') {
      syncMissionPanelUI();
    }
  }

  function resetRunMetrics(): void {
    accumulatedFractureTons = 0;
    destructionScore = 0;
    comboMultiplier = 1.0;
    autoSlowmoImpulseSec = 0;
    exhaustedWaitTicks = 0;
    c4PlantedCostLedger.clear();
    c4SequencerList.dataset.renderSig = '';
    lastCriticalTick = -100;
    feedMessages.length = 0;
    tacticalFeed.dataset.lastEvent = 'Полигон готов к работе';
    tacticalFeed.replaceChildren();
    syncTimeScaleState();
  }

  function refreshCriticalNodesAndSnapshot(): void {
    criticalNodeIdsCache = world.getCriticalLoadBearingNodeIds(8);
    renderer.setCriticalNodes(criticalNodeIdsCache);
    renderer.syncSnapshot(world.getRenderSnapshot());
    lastCriticalTick = world.getTelemetry().tick;
  }

  function warmUpStaticScene(): void {
    // Обновляем broad-phase Rapier и начальные контактные пары без накопления ложного тоннажа
    world.step();
    world.step();
    accumulatedFractureTons = 0;
    destructionScore = 0;
    comboMultiplier = 1.0;
    refreshCriticalNodesAndSnapshot();
  }

  function loadSandboxBlueprint(blueprintId: SandboxBlueprintId, clearFirst: boolean): void {
    if (clearFirst) {
      resetRunMetrics();
      sandboxMultiIndex = 1;
      const built = spawnBlueprintInWorld(world, blueprintId, {
        clearFirst: true,
        offset: [0, 0, 0],
        instanceIndex: 0,
      });
      warmUpStaticScene();
      renderer.focusOnBounds(built.focusCenter, built.focusRadiusM);
      pushTacticalMessage(`Возведён объект: ${built.nameRu}`);
    } else {
      const offsetSlot = SANDBOX_MULTI_OFFSETS[sandboxMultiIndex % SANDBOX_MULTI_OFFSETS.length]!;
      const built = spawnBlueprintInWorld(world, blueprintId, {
        clearFirst: false,
        offset: offsetSlot,
        instanceIndex: sandboxMultiIndex,
      });
      sandboxMultiIndex += 1;
      world.step();
      refreshCriticalNodesAndSnapshot();
      pushTacticalMessage(`Добавлен рядом: ${built.nameRu}`);
    }
    syncToolButtonsUI();
    syncAllHud();
  }

  function loadCampaignContract(contract: CampaignContractSpec): void {
    activeContract = contract;
    root.dataset.activeContract = contract.id;
    resetRunMetrics();

    missionStatus = 'planning';
    missionFailReason = 'none';
    missionStars = 0;
    missionAwardedStars = 0;

    const packs = progression.getExtraAmmoPacks();
    missionBudgetRemaining = contract.budgetLimit + packs * EXTRA_AMMO_BUDGET_BONUS;
    missionAmmo = {};
    for (const tool of TOOL_ORDER) {
      const base = contract.initialAmmo[tool];
      if (base !== undefined) {
        missionAmmo[tool] = base + packs * 2;
      }
    }

    const focus = spawnCampaignContractInWorld(world, contract);
    warmUpStaticScene();
    renderer.focusOnBounds(focus.focusCenter, focus.focusRadiusM);
    syncStarThresholdsBar(contract.starThresholdsPct);

    // Автоматически выбираем первый доступный инструмент миссии
    if (!isToolAvailableInCurrentState(activeTool)) {
      const firstAvail = TOOL_ORDER.find((t) => isToolAvailableInCurrentState(t));
      if (firstAvail) {
        activeTool = firstAvail;
        root.dataset.activeTool = firstAvail;
      }
    }

    syncContractCardsUI();
    syncToolButtonsUI();
    syncMissionPanelUI();
    pushTacticalMessage(`Контракт загружен: ${contract.titleRu}`);
    syncAllHud();
  }

  function applySlidersToPhysicsWorld(): void {
    const g = Number.parseFloat(sliderGravity.value);
    const js = Number.parseFloat(sliderJointStrength.value);
    const sd = Number.parseFloat(sliderSecondaryDmg.value);
    const bf = Number.parseFloat(sliderBlastFalloff.value);
    const fr = Number.parseFloat(sliderFireRate.value);
    const qf = Number.parseFloat(sliderQuakeFreqHz.value);
    const qa = Number.parseFloat(sliderQuakeAmp.value);

    quakeFreqHz = Number.isFinite(qf) ? qf : 2.5;
    quakeAmpM = Number.isFinite(qa) ? qa : 0.35;

    valGravity.textContent = g.toFixed(2);
    valJointStrength.textContent = js.toFixed(1);
    valSecondaryDmg.textContent = sd.toFixed(1);
    valBlastFalloff.textContent = bf.toFixed(2);
    valFireRate.textContent = fr.toFixed(1);
    valQuakeFreq.textContent = quakeFreqHz.toFixed(1);
    valQuakeAmp.textContent = quakeAmpM.toFixed(2);

    world.setPhysicsConstants({
      gravityMpS2: g,
      jointStrengthMultiplier: js,
      secondaryDamageMultiplier: sd,
      blastFalloffMultiplier: bf,
      fireSpreadMultiplier: fr,
      seismicFrequencyHz: quakeFreqHz,
      seismicAmplitudeM: quakeAmpM,
    });
    refreshCriticalNodesAndSnapshot();
  }

  function resetPhysicsConstantsForGameplay(): void {
    world.setPhysicsConstants({
      gravityMpS2: 9.81,
      jointStrengthMultiplier: 1.0,
      secondaryDamageMultiplier: 1.0,
      blastFalloffMultiplier: 1.0,
      fireSpreadMultiplier: 1.0,
      seismicFrequencyHz: 2.5,
      seismicAmplitudeM: 0.35,
    });
  }

  function loadLabBench(benchId: LabBenchId): void {
    activeBenchId = benchId;
    root.dataset.activeBench = benchId;
    resetRunMetrics();
    const spec = spawnLabBenchInWorld(world, benchId);
    applySlidersToPhysicsWorld();
    warmUpStaticScene();
    renderer.focusOnBounds(spec.focusCenter, spec.focusRadiusM);

    labBenchDesc.textContent = spec.descriptionRu;
    for (const [id, btn] of Object.entries(labBenchButtons) as Array<
      [LabBenchId, HTMLButtonElement]
    >) {
      btn.classList.toggle('active', id === benchId);
    }
    syncStarThresholdsBar([25, 50, 75]);
    syncToolButtonsUI();
    pushTacticalMessage(`Стенд активен: ${spec.nameRu}`);
    syncAllHud();
  }

  function switchMode(mode: AppMode): void {
    activeMode = mode;
    root.dataset.activeMode = mode;

    modeCampaignBtn.classList.toggle('active', mode === 'campaign');
    modeCampaignBtn.setAttribute('aria-pressed', String(mode === 'campaign'));
    modeSandboxBtn.classList.toggle('active', mode === 'sandbox');
    modeSandboxBtn.setAttribute('aria-pressed', String(mode === 'sandbox'));
    modeLabBtn.classList.toggle('active', mode === 'lab');
    modeLabBtn.setAttribute('aria-pressed', String(mode === 'lab'));

    campaignPanel.classList.toggle('hidden', mode !== 'campaign');
    sandboxPanel.classList.toggle('hidden', mode !== 'sandbox');
    labPanel.classList.toggle('hidden', mode !== 'lab');

    if (mode !== 'sandbox' && buildModeActive) {
      setBuildMode(false);
    }

    if (mode === 'campaign') {
      resetPhysicsConstantsForGameplay();
      loadCampaignContract(activeContract);
    } else if (mode === 'sandbox') {
      resetPhysicsConstantsForGameplay();
      syncStarThresholdsBar([25, 50, 75]);
      const bp = (sandboxSpawnSelect.value as SandboxBlueprintId) || 'tower';
      loadSandboxBlueprint(bp, true);
    } else {
      loadLabBench(activeBenchId);
    }
  }

  function processSimulationEvents(events: SimulationEvent[]): void {
    if (events.length === 0) return;
    renderer.consumeEvents(events);
    audio.consumeEvents(events, world.getTelemetry());

    let comboBump = 0;
    let scoreAdd = 0;
    let triggerSlowmo = false;

    for (let i = 0; i < events.length; i++) {
      const ev = events[i]!;
      if (ev.type === 'explosion') {
        comboBump += ev.isChainDetonation ? 0.55 : 0.25;
        scoreAdd += Math.round(ev.equivalentKgTnt * (ev.isChainDetonation ? 45 : 22));
        if (ev.isChainDetonation) {
          pushTacticalMessage('Цепная детонация резервуара!', true);
          triggerSlowmo = true;
        }
      } else if (ev.type === 'fracture') {
        accumulatedFractureTons += Math.min(4.8, Math.max(0.25, ev.energyJ / 420_000));
        comboBump += 0.18;
        scoreAdd += Math.max(25, Math.round(ev.shardCount * 18 + ev.energyJ / 900));
        if (ev.shardCount >= 6 && ev.energyJ >= 38_000) {
          pushTacticalMessage('Срез несущей конструкции!', true);
          triggerSlowmo = true;
        }
      } else if (ev.type === 'rebar_snap') {
        comboBump += 0.14;
        scoreAdd += 65;
        pushTacticalMessage('Разрыв стальной арматуры!');
      } else if (ev.type === 'steel_yield') {
        comboBump += 0.12;
        scoreAdd += 55;
        pushTacticalMessage('Пластический шарнир стали!');
      } else if (ev.type === 'secondary_impact') {
        accumulatedFractureTons += ev.massKg / 1400;
        comboBump += 0.28;
        scoreAdd += Math.max(40, Math.round(ev.massKg * 0.08));
        if (ev.impulseNs >= 16_000) {
          pushTacticalMessage(
            `Каскадный обвал (${(ev.massKg / 1000).toFixed(1)} т)!`,
            true,
          );
          triggerSlowmo = true;
        }
      } else if (ev.type === 'fire_ignited') {
        comboBump += 0.1;
        scoreAdd += 35;
        pushTacticalMessage('Возгорание узла конструкции');
      } else if (ev.type === 'seismic_pulse') {
        scoreAdd += 20;
      }
    }

    if (comboBump > 0) {
      comboMultiplier = Math.min(5.0, comboMultiplier + comboBump);
    }
    if (scoreAdd > 0) {
      destructionScore += Math.round(scoreAdd * comboMultiplier);
    }

    if (triggerSlowmo && autoSlowmoEnabled && !paused) {
      autoSlowmoImpulseSec = 0.45;
      syncTimeScaleState();
    }
  }

  function stepSimulationTick(forceSingle = false): void {
    const prevBroken = world.getTelemetry().brokenJointCount;
    const events = forceSingle ? world.stepSingleTick() : world.step();
    const afterTelemetry = world.getTelemetry();

    if (afterTelemetry.brokenJointCount > prevBroken && events.length === 0) {
      const brokenDelta = afterTelemetry.brokenJointCount - prevBroken;
      comboMultiplier = Math.min(5.0, comboMultiplier + brokenDelta * 0.12);
      destructionScore += Math.round(brokenDelta * 40 * comboMultiplier);
    }

    processSimulationEvents(events);
    evaluateCampaignMissionRules();

    if (afterTelemetry.tick - lastCriticalTick >= 15 || afterTelemetry.brokenJointCount !== prevBroken) {
      criticalNodeIdsCache = world.getCriticalLoadBearingNodeIds(8);
      renderer.setCriticalNodes(criticalNodeIdsCache);
      lastCriticalTick = afterTelemetry.tick;
    }
    renderer.syncSnapshot(world.getRenderSnapshot());
  }

  function updateAimReticleOverlay(): void {
    if (!pointerInsideCanvas || workshopOpen) {
      renderer.setAimReticle({ visible: false });
      return;
    }
    const [ndcX, ndcY] = renderer.clientPointToNdc(pointerClientX, pointerClientY);
    const ray = renderer.screenPointToRay(ndcX, ndcY);
    const hit = world.raycastScene(ray.origin, ray.direction, 260);
    if (!hit) {
      renderer.setAimReticle({ visible: false });
      return;
    }

    if (buildModeActive && activeMode === 'sandbox') {
      const halfExtents = getBuilderBlockHalfExtents(activeMaterialId);
      const ghostCenter = computeBuilderPlacementCenter(
        hit.point,
        hit.normal,
        halfExtents,
        hit.isGround,
      );
      renderer.setAimReticle({
        visible: true,
        point: hit.point,
        normal: hit.normal,
        tool: activeTool,
        radiusM: 0.8,
        buildMode: true,
        buildMaterialId: activeMaterialId,
        ghostCenter,
        ghostHalfExtents: halfExtents,
      });
      return;
    }

    const lvl = getEffectiveLevelForTool(activeTool);
    renderer.setAimReticle({
      visible: true,
      point: hit.point,
      normal: hit.normal,
      tool: activeTool,
      radiusM: getToolPreviewRadiusM(activeTool, lvl),
      buildMode: false,
      buildMaterialId: activeMaterialId,
    });
  }

  function consumeCampaignToolBudget(tool: ToolId): number | null {
    if (activeMode !== 'campaign') return 0;
    if (!isToolAvailableInCurrentState(tool)) return null;
    const cost = activeContract.toolCosts[tool] ?? 0;
    missionBudgetRemaining = Math.max(0, missionBudgetRemaining - cost);
    missionAmmo[tool] = Math.max(0, (missionAmmo[tool] ?? 1) - 1);
    if (missionStatus === 'planning') {
      missionStatus = 'running';
    }
    syncToolButtonsUI();
    syncMissionPanelUI();
    return cost;
  }

  function handleCanvasPrimaryAction(clientX: number, clientY: number, dtSec = FIXED_DT, isHold = false): void {
    audio.unlock();
    const [ndcX, ndcY] = renderer.clientPointToNdc(clientX, clientY);
    const ray = renderer.screenPointToRay(ndcX, ndcY);

    // 1. Режим 3D-Конструктора в Песочнице
    if (buildModeActive && activeMode === 'sandbox') {
      if (isHold) return;
      const hit = world.raycastScene(ray.origin, ray.direction, 260);
      if (!hit) return;
      const halfExtents = getBuilderBlockHalfExtents(activeMaterialId);
      const center = computeBuilderPlacementCenter(
        hit.point,
        hit.normal,
        halfExtents,
        hit.isGround,
      );
      world.spawnBlock({
        materialId: activeMaterialId,
        center,
        halfExtents,
        grounded: hit.isGround || center[1] - halfExtents[1] <= 0.08,
        structureGroupTag: 'target',
      });
      refreshCriticalNodesAndSnapshot();
      pushTacticalMessage('Установлен конструктивный блок');
      syncAllHud();
      return;
    }

    // 2. Применение оружия из арсенала
    if (activeMode === 'campaign') {
      if (activeTool === 'cutter' && isHold) {
        // При непрерывном удержании плазморезака списываем по 1 заряду каждые 0.55 с реза
        cutterBeamHoldTimerSec += dtSec;
        if (cutterBeamHoldTimerSec >= 0.55) {
          cutterBeamHoldTimerSec = 0;
          if (consumeCampaignToolBudget('cutter') === null) {
            renderer.setPlasmaBeam({ active: false, origin: ray.origin, hitPoint: ray.origin });
            return;
          }
        } else if ((missionAmmo.cutter ?? 0) <= 0 && missionStatus !== 'running') {
          return;
        }
      } else if (activeTool === 'c4') {
        const probeHit = world.raycastScene(ray.origin, ray.direction, 260);
        if (!probeHit || probeHit.isGround || probeHit.nodeId === undefined) {
          return;
        }
        const spent = consumeCampaignToolBudget('c4');
        if (spent === null) return;
        const lvl = getEffectiveLevelForTool('c4');
        const out = executeArsenalTool({
          world,
          tool: 'c4',
          level: lvl,
          rayOrigin: ray.origin,
          rayDirection: ray.direction,
          c4DelaySec,
          quakeFrequencyHz: quakeFreqHz,
          quakeAmplitudeM: quakeAmpM,
          dtSec,
        });
        if (out.kind === 'c4_planted') {
          c4PlantedCostLedger.set(out.chargeId, spent);
          pushTacticalMessage(`Заряд C4 заложен (+${c4DelaySec.toFixed(2)} с)`);
          renderer.syncSnapshot(world.getRenderSnapshot());
          c4SequencerList.dataset.renderSig = '';
          syncAllHud();
        }
        return;
      } else {
        if (activeTool === 'bomb' || activeTool === 'incendiary') {
          const probeHit = world.raycastScene(ray.origin, ray.direction, 260);
          if (!probeHit) return;
        }
        const spent = consumeCampaignToolBudget(activeTool);
        if (spent === null) return;
        cutterBeamHoldTimerSec = 0;
      }
    }

    const lvl = getEffectiveLevelForTool(activeTool);
    const effQuakeFreq = activeMode === 'lab' ? quakeFreqHz : 2.3;
    const effQuakeAmp = activeMode === 'lab' ? quakeAmpM : Math.max(quakeAmpM, 1.35);
    const outcome = executeArsenalTool({
      world,
      tool: activeTool,
      level: lvl,
      rayOrigin: ray.origin,
      rayDirection: ray.direction,
      c4DelaySec,
      quakeFrequencyHz: effQuakeFreq,
      quakeAmplitudeM: effQuakeAmp,
      dtSec,
    });

    if (outcome.kind === 'c4_planted') {
      pushTacticalMessage(`Заряд C4 установлен (+${c4DelaySec.toFixed(2)} с)`);
      renderer.syncSnapshot(world.getRenderSnapshot());
      c4SequencerList.dataset.renderSig = '';
      syncAllHud();
    } else if (outcome.kind === 'blast') {
      pushTacticalMessage(`Подрыв фугаса (Ур.${lvl})!`, true);
    } else if (outcome.kind === 'cut') {
      const camPos = renderer.getCameraRig().camera.position;
      const camRightX = Math.cos(renderer.getCameraRig().getSphericalState().azimuthRad);
      const camRightZ = -Math.sin(renderer.getCameraRig().getSphericalState().azimuthRad);
      const emitterOrigin: Vec3 = [
        camPos.x + camRightX * 0.65,
        camPos.y - 0.45,
        camPos.z + camRightZ * 0.65,
      ];
      renderer.setPlasmaBeam({
        active: true,
        origin: emitterOrigin,
        hitPoint: outcome.beamEnd,
      });
    } else if (outcome.kind === 'ignite' && outcome.events > 0) {
      pushTacticalMessage('Термитная кассета активирована');
    } else if (outcome.kind === 'quake') {
      pushTacticalMessage(
        `Сейсмоудар ${outcome.freqHz.toFixed(1)} Гц · ${outcome.ampM.toFixed(2)} м`,
        true,
      );
    }
  }

  // Слушатели мыши на 3D-канвасе
  canvas.addEventListener('pointerenter', (e: PointerEvent) => {
    pointerInsideCanvas = true;
    pointerClientX = e.clientX;
    pointerClientY = e.clientY;
    updateAimReticleOverlay();
  });

  canvas.addEventListener('pointerleave', () => {
    pointerInsideCanvas = false;
    renderer.setAimReticle({ visible: false });
  });

  canvas.addEventListener('pointerdown', (e: PointerEvent) => {
    audio.unlock();
    pointerInsideCanvas = true;
    pointerClientX = e.clientX;
    pointerClientY = e.clientY;
    if (e.button === 0 && !e.altKey) {
      primaryPointerDown = true;
      primaryPointerId = e.pointerId;
      cutterBeamHoldTimerSec = 0;
      handleCanvasPrimaryAction(e.clientX, e.clientY, FIXED_DT, false);
    } else if (e.button === 2) {
      rightDownPos = { x: e.clientX, y: e.clientY };
    }
  });

  window.addEventListener('pointermove', (e: PointerEvent) => {
    pointerClientX = e.clientX;
    pointerClientY = e.clientY;
    if (pointerInsideCanvas) {
      updateAimReticleOverlay();
    }
  });

  window.addEventListener('pointerup', (e: PointerEvent) => {
    if (e.pointerId === primaryPointerId) {
      primaryPointerDown = false;
      primaryPointerId = null;
      renderer.setPlasmaBeam({ active: false, origin: [0, 0, 0], hitPoint: [0, 0, 0] });
    }
    if (e.button === 2 && rightDownPos) {
      const dist = Math.hypot(e.clientX - rightDownPos.x, e.clientY - rightDownPos.y);
      rightDownPos = null;
      if (dist <= DRAG_CLICK_THRESHOLD_PX && world.getPlantedC4Count() > 0) {
        const [ndcX, ndcY] = renderer.clientPointToNdc(e.clientX, e.clientY);
        const ray = renderer.screenPointToRay(ndcX, ndcY);
        const hit = world.raycastScene(ray.origin, ray.direction, 260);
        if (hit) {
          const queueBefore = world.getC4SequenceQueue();
          const removedId = world.removeC4At(hit.point, 2.5);
          if (removedId !== null) {
            if (activeMode === 'campaign' && queueBefore.some((q) => q.chargeId === removedId)) {
              const refundedCost = c4PlantedCostLedger.get(removedId) ?? 0;
              c4PlantedCostLedger.delete(removedId);
              missionBudgetRemaining += refundedCost;
              missionAmmo.c4 = (missionAmmo.c4 ?? 0) + 1;
              syncToolButtonsUI();
            }
            pushTacticalMessage('Заряд C4 снят');
            renderer.syncSnapshot(world.getRenderSnapshot());
            c4SequencerList.dataset.renderSig = '';
            syncAllHud();
          }
        }
      }
    }
  });

  // Слушатели кнопок интерфейса
  modeCampaignBtn.addEventListener('click', () => switchMode('campaign'));
  modeSandboxBtn.addEventListener('click', () => switchMode('sandbox'));
  modeLabBtn.addEventListener('click', () => switchMode('lab'));

  openWorkshopBtn.addEventListener('click', () => {
    workshopOpen = true;
    syncWorkshopUI();
  });
  closeWorkshopBtn.addEventListener('click', () => {
    workshopOpen = false;
    syncWorkshopUI();
    syncToolButtonsUI();
  });
  workshopModal.addEventListener('click', (e) => {
    if (e.target === workshopModal) {
      workshopOpen = false;
      syncWorkshopUI();
      syncToolButtonsUI();
    }
  });

  buyExtraAmmoBtn.addEventListener('click', () => {
    if (progression.buyExtraAmmoPack()) {
      if (activeMode === 'campaign' && missionStatus !== 'defeat') {
        missionBudgetRemaining += EXTRA_AMMO_BUDGET_BONUS;
        for (const tool of TOOL_ORDER) {
          if (activeContract.initialAmmo[tool] !== undefined) {
            missionAmmo[tool] = (missionAmmo[tool] ?? 0) + 2;
          }
        }
      }
      pushTacticalMessage('Пакет снабжения приобретён!');
      syncWorkshopUI();
      syncToolButtonsUI();
      syncAllHud();
    }
  });

  for (const tool of TOOL_ORDER) {
    upgradeButtons[tool].addEventListener('click', () => {
      if (progression.upgradeTool(tool)) {
        const newLvl = progression.getToolLevel(tool);
        pushTacticalMessage(`Улучшено до Ур. ${newLvl}!`, true);
        syncWorkshopUI();
        syncToolButtonsUI();
      }
    });
  }

  pauseBtn.addEventListener('click', () => setPausedState(!paused));
  stepBtn.addEventListener('click', () => {
    setPausedState(true);
    stepSimulationTick(true);
    syncAllHud();
  });
  bulletBtn.addEventListener('click', () => setBulletTime(!bulletTimeActive));
  timeScaleSelect.addEventListener('change', () => {
    const val = Number.parseFloat(timeScaleSelect.value);
    if (Number.isFinite(val) && val > 0) {
      userTimeScale = val;
      bulletTimeActive = false;
      bulletBtn.classList.remove('active');
      syncTimeScaleState();
    }
  });

  viewPbrBtn.addEventListener('click', () => setViewMode('pbr'));
  viewStressBtn.addEventListener('click', () => setViewMode('stress'));
  viewXrayBtn.addEventListener('click', () => setViewMode('xray'));

  skyDayBtn.addEventListener('click', () => setSkyPreset('day'));
  skySunsetBtn.addEventListener('click', () => setSkyPreset('sunset'));
  skyNightBtn.addEventListener('click', () => setSkyPreset('night'));

  qualitySelect.addEventListener('change', () => {
    renderer.setQualityPreset(qualitySelect.value as QualityPreset);
  });

  muteBtn.addEventListener('click', () => {
    muted = !muted;
    audio.setMuted(muted);
    root.dataset.audioMuted = String(muted);
    muteBtn.classList.toggle('active', muted);
    muteBtn.textContent = muted ? '🔇' : '🔊';
  });

  resetBtn.addEventListener('click', () => {
    setBuildMode(false);
    if (activeMode === 'campaign') {
      loadCampaignContract(activeContract);
    } else if (activeMode === 'sandbox') {
      const bp = (sandboxSpawnSelect.value as SandboxBlueprintId) || 'tower';
      loadSandboxBlueprint(bp, true);
    } else {
      loadLabBench(activeBenchId);
    }
  });

  for (const [tool, btn] of toolButtons) {
    btn.addEventListener('click', () => setActiveTool(tool));
  }

  c4DelaySelect.addEventListener('change', () => {
    const v = Number.parseFloat(c4DelaySelect.value);
    c4DelaySec = Number.isFinite(v) && v >= 0 ? v : 0;
  });

  detonateC4Btn.addEventListener('click', () => {
    audio.unlock();
    if (world.getPlantedC4Count() > 0) {
      if (activeMode === 'campaign' && missionStatus === 'planning') {
        missionStatus = 'running';
      }
      world.detonateAllC4();
      pushTacticalMessage('Каскадный подрыв очереди C4!', true);
      c4SequencerList.dataset.renderSig = '';
      syncAllHud();
    }
  });

  autoSlowmoToggle.addEventListener('change', () => {
    autoSlowmoEnabled = autoSlowmoToggle.checked;
    root.dataset.autoSlowmo = String(autoSlowmoEnabled);
    if (!autoSlowmoEnabled) {
      autoSlowmoImpulseSec = 0;
    }
    syncTimeScaleState();
  });

  // События Песочницы
  sandboxUpgradeSelect.addEventListener('change', () => {
    const lvl = Math.min(5, Math.max(1, Number.parseInt(sandboxUpgradeSelect.value, 10) || 1));
    sandboxLevelOverride = lvl as ToolUpgradeLevel;
    syncToolButtonsUI();
    updateAimReticleOverlay();
  });

  sandboxSpawnSelect.addEventListener('change', () => {
    const bp = (sandboxSpawnSelect.value as SandboxBlueprintId) || 'tower';
    if (world.getTelemetry().intactBlockCount === 0) {
      loadSandboxBlueprint(bp, true);
    } else {
      const label = sandboxSpawnSelect.selectedOptions[0]?.textContent?.trim() ?? bp;
      pushTacticalMessage(`Чертёж: ${label} (+ Возвести рядом или ↺ Сброс)`);
    }
  });

  sandboxSpawnBtn.addEventListener('click', () => {
    const bp = (sandboxSpawnSelect.value as SandboxBlueprintId) || 'tower';
    const hasBlocks = world.getTelemetry().intactBlockCount > 0;
    loadSandboxBlueprint(bp, !hasBlocks);
  });

  sandboxBuildToggle.addEventListener('click', () => {
    setBuildMode(!buildModeActive);
    syncToolButtonsUI();
  });

  for (const [mat, btn] of materialButtons) {
    btn.addEventListener('click', () => setActiveMaterial(mat));
  }

  // События Кампании
  for (let i = 0; i < CAMPAIGN_CONTRACTS.length; i++) {
    const spec = CAMPAIGN_CONTRACTS[i]!;
    contractButtons[i]!.addEventListener('click', () => {
      loadCampaignContract(spec);
    });
  }

  nextContractBtn.addEventListener('click', () => {
    const nextIdx = Math.min(CAMPAIGN_CONTRACTS.length - 1, activeContract.index1Based);
    const nextSpec = CAMPAIGN_CONTRACTS[nextIdx];
    if (nextSpec) {
      loadCampaignContract(nextSpec);
    }
  });

  // События Лаборатории
  for (const [benchId, btn] of Object.entries(labBenchButtons) as Array<
    [LabBenchId, HTMLButtonElement]
  >) {
    btn.addEventListener('click', () => loadLabBench(benchId));
  }

  const allSliders = [
    sliderGravity,
    sliderJointStrength,
    sliderSecondaryDmg,
    sliderBlastFalloff,
    sliderFireRate,
    sliderQuakeFreqHz,
    sliderQuakeAmp,
  ];
  for (const sl of allSliders) {
    sl.addEventListener('input', () => applySlidersToPhysicsWorld());
    sl.addEventListener('change', () => applySlidersToPhysicsWorld());
  }

  btnTriggerQuake.addEventListener('click', () => {
    audio.unlock();
    applySlidersToPhysicsWorld();
    if (activeMode === 'campaign') {
      if (consumeCampaignToolBudget('seismic') === null) return;
    }
    world.triggerEarthquake({
      frequencyHz: quakeFreqHz,
      amplitudeM: quakeAmpM,
      durationSec: 6.5,
    });
    pushTacticalMessage(
      `Вибростенд: ${quakeFreqHz.toFixed(1)} Гц · ${quakeAmpM.toFixed(2)} м`,
      true,
    );
    syncAllHud();
  });

  hintCloseBtn.addEventListener('click', () => {
    controlsHint.classList.add('hidden');
  });

  // Горячие клавиши
  window.addEventListener('keydown', (e: KeyboardEvent) => {
    if (
      e.target instanceof HTMLInputElement ||
      e.target instanceof HTMLSelectElement ||
      e.target instanceof HTMLTextAreaElement
    ) {
      return;
    }
    if (e.key === 'Escape' && workshopOpen) {
      workshopOpen = false;
      syncWorkshopUI();
      return;
    }
    const key = e.key.toLowerCase();
    if (key >= '1' && key <= '6') {
      const tool = TOOL_ORDER[Number(key) - 1];
      if (tool) setActiveTool(tool);
    } else if (e.code === 'Space') {
      e.preventDefault();
      setPausedState(!paused);
    } else if (key === '.') {
      setPausedState(true);
      stepSimulationTick(true);
      syncAllHud();
    } else if (key === 'b' || key === 'и') {
      setBulletTime(!bulletTimeActive);
    } else if (key === 'v' || key === 'м') {
      const nextIdx = (VIEW_MODE_ORDER.indexOf(viewMode) + 1) % VIEW_MODE_ORDER.length;
      setViewMode(VIEW_MODE_ORDER[nextIdx]!);
    } else if (key === 'd' || key === 'в') {
      detonateC4Btn.click();
    } else if (key === 'r' || key === 'к') {
      resetBtn.click();
    } else if (key === 'm' || key === 'ь') {
      muteBtn.click();
    }
  });

  // Публикация Read-Only моста window.__SHATTERPOINT__
  window.__SHATTERPOINT__ = {
    getTelemetry(): BridgeTelemetry {
      const base = world.getTelemetry();
      const levels = getEffectiveToolLevels();
      return {
        ...base,
        mode: activeMode,
        missionStatus,
        collateralPct: base.protectedDamagePct,
        stars: missionStars,
        fps: Math.max(1, Math.round(fpsSmoothed)),
        drawCalls: renderer.getDrawCallsCount(),
        walletCredits: progression.getWalletCredits(),
        toolLevels: levels,
        collapsedMassTons: getCollapsedMassTons(),
        destructionScore: Math.max(0, Math.round(destructionScore)),
        comboMultiplier: Number(comboMultiplier.toFixed(2)),
        criticalNodesCount: criticalNodeIdsCache.length,
        c4SequenceQueue: world.getC4SequenceQueue(),
        activeTriggersCount: world.getActiveTriggersCount(),
        activeBench: activeMode === 'lab' ? activeBenchId : null,
        activeContractId: activeMode === 'campaign' ? activeContract.id : null,
        audioMuted: muted,
        activeMaterialId,
        buildModeActive,
        qualityPreset: renderer.getQualityPreset(),
      };
    },
    projectWorldPoint(x: number, y: number, z: number) {
      return renderer.projectWorldToScreen([x, y, z]);
    },
  };

  // Стартовая загрузка полигона Песочницы
  syncWorkshopUI();
  syncContractCardsUI();
  loadSandboxBlueprint('tower', true);
  renderer.renderFrame(FIXED_DT);
  syncAllHud();

  root.dataset.ready = 'true';
  loadingOverlay.classList.add('hidden');

  // Главный цикл реального времени
  function frame(nowMs: number): void {
    const dtReal = Math.min(0.1, Math.max(0.001, (nowMs - lastFrameMs) / 1000));
    lastFrameMs = nowMs;
    fpsSmoothed = fpsSmoothed * 0.9 + (1 / dtReal) * 0.1;

    if (autoSlowmoImpulseSec > 0) {
      autoSlowmoImpulseSec = Math.max(0, autoSlowmoImpulseSec - dtReal);
      if (autoSlowmoImpulseSec === 0) {
        syncTimeScaleState();
      }
    }

    if (!paused && comboMultiplier > 1.0) {
      comboMultiplier = Math.max(1.0, comboMultiplier - dtReal * 0.28);
    }

    // Непрерывная работа плазморезака при удержании ЛКМ
    if (primaryPointerDown && !buildModeActive && activeTool === 'cutter' && !paused) {
      handleCanvasPrimaryAction(
        pointerClientX,
        pointerClientY,
        dtReal * getPhysicsSimulationTimeScale(),
        true,
      );
    }

    if (!paused) {
      const simScale = getPhysicsSimulationTimeScale();
      accumulatorSec = Math.min(accumulatorSec + dtReal * simScale, FIXED_DT * 5);
      let substeps = 0;
      while (accumulatorSec >= FIXED_DT && substeps < 4) {
        stepSimulationTick();
        accumulatorSec -= FIXED_DT;
        substeps += 1;
      }
    }

    renderer.renderFrame(dtReal);
    syncAllHud();

    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
}

bootstrapApplication().catch((err) => {
  const loadingText = document.getElementById('loading-text');
  if (loadingText) {
    loadingText.textContent = `Ошибка запуска: ${err instanceof Error ? err.message : String(err)}`;
  }
  console.error(err);
});
