import {
  FIXED_DT,
  type QualityPreset,
  type RenderViewMode,
  type SimulationEvent,
  type ToolId,
} from './core/types';
import { DestructionWorld } from './physics/DestructionWorld';
import { SceneRenderer } from './render/SceneRenderer';
import { DestructionSoundEngine } from './audio/DestructionSoundEngine';
import { buildAlphaProvingGround } from './content/AlphaProvingGround';
import {
  ALPHA_TOOL_ORDER,
  applyAlphaTool,
  DEFAULT_ALPHA_TOOL_SETTINGS,
  type AlphaToolSettings,
} from './modes/AlphaArsenal';

/**
 * Точка входа v0.1 Alpha («ТОЧКА РАЗЛОМА»).
 * Связывает физическое ядро DestructionWorld, 3D PBR-рендерер SceneRenderer,
 * процедурный звук DestructionSoundEngine и русскоязычную панель управления.
 */

const VIEW_MODE_ORDER: readonly RenderViewMode[] = ['pbr', 'stress', 'xray'];
const DRAG_CLICK_THRESHOLD_PX = 5;

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) {
    throw new Error(`Не найден обязательный элемент интерфейса #${id}`);
  }
  return el as T;
}

async function bootstrapAlpha(): Promise<void> {
  const root = byId<HTMLDivElement>('app-root');
  const canvas = byId<HTMLCanvasElement>('sim-canvas');
  const loadingOverlay = byId<HTMLDivElement>('loading-overlay');
  const loadingText = byId<HTMLParagraphElement>('loading-text');

  // Кнопки управления временем и видом
  const pauseBtn = byId<HTMLButtonElement>('time-pause-btn');
  const stepBtn = byId<HTMLButtonElement>('time-step-btn');
  const bulletBtn = byId<HTMLButtonElement>('time-bullet-btn');
  const timeScaleSelect = byId<HTMLSelectElement>('time-scale-select');
  const viewPbrBtn = byId<HTMLButtonElement>('view-pbr-btn');
  const viewStressBtn = byId<HTMLButtonElement>('view-stress-btn');
  const viewXrayBtn = byId<HTMLButtonElement>('view-xray-btn');
  const qualitySelect = byId<HTMLSelectElement>('quality-select');
  const muteBtn = byId<HTMLButtonElement>('audio-mute-btn');
  const resetBtn = byId<HTMLButtonElement>('scene-reset-btn');

  // Арсенал и секвенсор C4
  const toolButtons = new Map<ToolId, HTMLButtonElement>();
  for (const toolId of ALPHA_TOOL_ORDER) {
    toolButtons.set(toolId, byId<HTMLButtonElement>(`tool-${toolId}`));
  }
  const c4DelaySelect = byId<HTMLSelectElement>('c4-delay-select');
  const c4ListEl = byId<HTMLOListElement>('c4-sequencer-list');
  const detonateC4Btn = byId<HTMLButtonElement>('detonate-c4-btn');
  const autoSlowmoToggle = byId<HTMLInputElement>('auto-slowmo-toggle');

  // Телеметрия и подсказка
  const elCollapsedTons = byId<HTMLSpanElement>('hud-collapsed-tons');
  const elDestructionPct = byId<HTMLSpanElement>('telemetry-destruction-pct');
  const elIntactJoints = byId<HTMLSpanElement>('telemetry-intact-joints');
  const elRebarLinks = byId<HTMLSpanElement>('telemetry-rebar-links');
  const elBurningNodes = byId<HTMLSpanElement>('telemetry-burning-nodes');
  const elMaxTemp = byId<HTMLSpanElement>('telemetry-max-temp-c');
  const elKineticKj = byId<HTMLSpanElement>('telemetry-kinetic-kj');
  const elShards = byId<HTMLSpanElement>('telemetry-shards');
  const elFps = byId<HTMLSpanElement>('telemetry-fps');
  const tacticalFeed = byId<HTMLDivElement>('tactical-feed');
  const controlsHint = byId<HTMLElement>('controls-hint');
  const hintCloseBtn = byId<HTMLButtonElement>('hint-close-btn');

  // Инициализация WASM-мира, 3D-рендера и звукового движка
  loadingText.textContent = 'Инициализация физического ядра Rapier3D…';
  const world = await DestructionWorld.create({ seed: 2026 });

  loadingText.textContent = 'Возведение испытательного полигона…';
  const groundInfo = buildAlphaProvingGround(world);
  // Прогрев broad-phase Rapier3D, чтобы первый же клик точно попадал по граням
  world.step();
  world.step();

  loadingText.textContent = 'Запуск 3D PBR-рендерера…';
  const renderer = new SceneRenderer({
    canvas,
    quality: (qualitySelect.value as QualityPreset) || 'high',
    seed: 2026,
  });
  renderer.focusOnBounds(groundInfo.focusCenter, groundInfo.focusRadiusM);

  const audio = new DestructionSoundEngine({
    seed: 2026,
    masterVolume: 0.72,
    autoUnlockOnInteraction: true,
  });

  // Состояние интерфейса
  let activeTool: ToolId = 'cannon';
  let paused = false;
  let userTimeScale = 1;
  let effectiveTimeScale = 1;
  let bulletTimeActive = false;
  let muted = false;
  let autoSlowmoEnabled = false;
  let autoSlowmoRemainSec = 0;
  let viewMode: RenderViewMode = 'pbr';
  const toolSettings: AlphaToolSettings = { ...DEFAULT_ALPHA_TOOL_SETTINGS };

  // Удержание ЛКМ (для плазморезака) и отслеживание короткого клика ПКМ (снятие C4)
  let primaryPointerDown = false;
  let primaryPointerId: number | null = null;
  let pointerClientX = 0;
  let pointerClientY = 0;
  let rightDownPos: { x: number; y: number } | null = null;

  // Учёт FPS и накопления шага физики
  let accumulatorSec = 0;
  let lastFrameMs = performance.now();
  let fpsSmoothed = 60;
  let hudSyncElapsed = 0;
  let lastCriticalTick = -100;

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

  function applyEffectiveTimeScale(): void {
    let targetScale = bulletTimeActive ? 0.2 : userTimeScale;
    if (autoSlowmoRemainSec > 0) {
      targetScale = Math.min(targetScale, 0.22);
    }
    effectiveTimeScale = targetScale;
    world.setTimeScale(effectiveTimeScale);
    audio.setTimeScale(effectiveTimeScale);
    root.dataset.timeScale = String(Number(effectiveTimeScale.toFixed(2)));
  }

  function setPausedState(nextPaused: boolean): void {
    paused = nextPaused;
    world.setPaused(paused);
    root.dataset.paused = String(paused);
    pauseBtn.classList.toggle('active', paused);
    pauseBtn.textContent = paused ? '▶ Продолжить' : '⏸ Пауза';
  }

  function setBulletTime(active: boolean): void {
    bulletTimeActive = active;
    bulletBtn.classList.toggle('active', bulletTimeActive);
    applyEffectiveTimeScale();
  }

  function setActiveTool(tool: ToolId): void {
    activeTool = tool;
    root.dataset.activeTool = tool;
    for (const [id, btn] of toolButtons) {
      btn.classList.toggle('active', id === tool);
    }
  }

  function setViewMode(mode: RenderViewMode): void {
    viewMode = mode;
    renderer.setViewMode(mode);
    root.dataset.renderMode = mode;
    viewPbrBtn.classList.toggle('active', mode === 'pbr');
    viewStressBtn.classList.toggle('active', mode === 'stress');
    viewXrayBtn.classList.toggle('active', mode === 'xray');
  }

  function syncC4QueueUI(): void {
    const queue = world.getC4SequenceQueue();
    root.dataset.plantedC4 = String(queue.length);
    c4ListEl.dataset.queueCount = String(queue.length);
    c4ListEl.replaceChildren(
      ...queue.map((item, idx) => {
        const li = document.createElement('li');
        li.textContent = `C4 #${idx + 1} · +${item.delaySec.toFixed(2)} с`;
        return li;
      }),
    );
  }

  let collapsedMassTons = 0;

  function syncTelemetryUI(): void {
    const t = world.getTelemetry();
    elCollapsedTons.textContent = collapsedMassTons.toFixed(1);
    elCollapsedTons.dataset.value = collapsedMassTons.toFixed(2);
    elDestructionPct.textContent = t.destructionPct.toFixed(1);
    elDestructionPct.dataset.value = t.destructionPct.toFixed(2);
    elIntactJoints.textContent = String(t.intactJointCount);
    elIntactJoints.dataset.value = String(t.intactJointCount);
    elRebarLinks.textContent = String(t.activeRebarCount);
    elRebarLinks.dataset.value = String(t.activeRebarCount);
    elBurningNodes.textContent = String(t.burningNodeCount);
    elBurningNodes.dataset.value = String(t.burningNodeCount);
    elMaxTemp.textContent = String(Math.round(t.maxTemperatureC));
    elMaxTemp.dataset.value = String(Math.round(t.maxTemperatureC));
    elKineticKj.textContent = t.kineticEnergyKJ.toFixed(0);
    elKineticKj.dataset.value = t.kineticEnergyKJ.toFixed(1);
    elShards.textContent = String(t.activeShardCount);
    elShards.dataset.value = String(t.activeShardCount);
    elFps.textContent = String(Math.round(fpsSmoothed));
    elFps.dataset.value = String(Math.round(fpsSmoothed));
    root.dataset.simTick = String(t.tick);
    syncC4QueueUI();
  }

  function processSimulationEvents(events: SimulationEvent[]): void {
    if (events.length === 0) return;
    renderer.consumeEvents(events);
    audio.consumeEvents(events, world.getTelemetry());

    let triggerSlowmo = false;
    for (let i = 0; i < events.length; i++) {
      const ev = events[i]!;
      if (ev.type === 'explosion' && ev.isChainDetonation) {
        pushTacticalMessage('Цепная детонация резервуара!', true);
        triggerSlowmo = true;
      } else if (ev.type === 'fracture') {
        collapsedMassTons += Math.max(0.2, ev.energyJ / 25_000);
        if (ev.shardCount >= 6 && ev.energyJ >= 40_000) {
          pushTacticalMessage('Разлом несущей конструкции!', true);
          triggerSlowmo = true;
        }
      } else if (ev.type === 'rebar_snap') {
        pushTacticalMessage('Разрыв несущей арматуры!');
      } else if (ev.type === 'steel_yield') {
        pushTacticalMessage('Пластический изгиб стали!');
      } else if (ev.type === 'secondary_impact' && ev.impulseNs >= 18_000) {
        collapsedMassTons += ev.massKg / 1000;
        pushTacticalMessage(
          `Пролом обломками (${(ev.massKg / 1000).toFixed(1)} т)!`,
          true,
        );
        triggerSlowmo = true;
      } else if (ev.type === 'fire_ignited') {
        pushTacticalMessage('Очаг возгорания конструкции');
      } else if (ev.type === 'seismic_pulse') {
        pushTacticalMessage(
          `Сейсмический толчок ${ev.frequencyHz.toFixed(1)} Гц`,
          true,
        );
      }
    }

    if (triggerSlowmo && autoSlowmoEnabled && !paused) {
      autoSlowmoRemainSec = 1.1;
      applyEffectiveTimeScale();
    }
  }

  function stepOnceAndSync(): void {
    const events = world.step();
    processSimulationEvents(events);
    const snap = world.getRenderSnapshot();
    const tick = world.getTelemetry().tick;
    if (tick - lastCriticalTick >= 15) {
      renderer.setCriticalNodes(world.getCriticalLoadBearingNodeIds(8));
      lastCriticalTick = tick;
    }
    renderer.syncSnapshot(snap);
  }

  function resetScene(): void {
    autoSlowmoRemainSec = 0;
    collapsedMassTons = 0;
    lastCriticalTick = -100;
    const info = buildAlphaProvingGround(world);
    world.step();
    world.step();
    renderer.focusOnBounds(info.focusCenter, info.focusRadiusM);
    renderer.setCriticalNodes(world.getCriticalLoadBearingNodeIds(8));
    renderer.syncSnapshot(world.getRenderSnapshot());
    feedMessages.length = 0;
    tacticalFeed.replaceChildren();
    pushTacticalMessage('Полигон восстановлен');
    applyEffectiveTimeScale();
    syncTelemetryUI();
  }

  function fireActiveToolAtClient(clientX: number, clientY: number, dtSec = FIXED_DT): void {
    audio.unlock();
    const [ndcX, ndcY] = renderer.clientPointToNdc(clientX, clientY);
    const ray = renderer.screenPointToRay(ndcX, ndcY);
    const outcome = applyAlphaTool(world, activeTool, ray, toolSettings, dtSec);
    if (outcome.kind === 'c4_planted') {
      pushTacticalMessage(`Заряд C4 установлен (+${toolSettings.c4DelaySec.toFixed(2)} с)`);
      syncC4QueueUI();
      renderer.syncSnapshot(world.getRenderSnapshot());
    } else if (outcome.kind === 'blast') {
      pushTacticalMessage('Подрыв фугасного заряда!', true);
    } else if (outcome.kind === 'ignite' && outcome.events > 0) {
      pushTacticalMessage('Термит активирован');
    } else if (outcome.kind === 'quake') {
      pushTacticalMessage('Сейсмоплатформа запущена', true);
    }
  }

  // Обработчики ввода на 3D-холсте
  canvas.addEventListener('pointerdown', (e: PointerEvent) => {
    audio.unlock();
    pointerClientX = e.clientX;
    pointerClientY = e.clientY;
    if (e.button === 0 && !e.altKey) {
      primaryPointerDown = true;
      primaryPointerId = e.pointerId;
      fireActiveToolAtClient(e.clientX, e.clientY, FIXED_DT);
    } else if (e.button === 2) {
      rightDownPos = { x: e.clientX, y: e.clientY };
    }
  });

  window.addEventListener('pointermove', (e: PointerEvent) => {
    if (primaryPointerDown && e.pointerId === primaryPointerId) {
      pointerClientX = e.clientX;
      pointerClientY = e.clientY;
    }
  });

  window.addEventListener('pointerup', (e: PointerEvent) => {
    if (e.pointerId === primaryPointerId) {
      primaryPointerDown = false;
      primaryPointerId = null;
    }
    if (e.button === 2 && rightDownPos) {
      const dist = Math.hypot(e.clientX - rightDownPos.x, e.clientY - rightDownPos.y);
      rightDownPos = null;
      // Короткий клик ПКМ без вращения камеры — снятие ближайшего C4
      if (dist <= DRAG_CLICK_THRESHOLD_PX && world.getPlantedC4Count() > 0) {
        const [ndcX, ndcY] = renderer.clientPointToNdc(e.clientX, e.clientY);
        const ray = renderer.screenPointToRay(ndcX, ndcY);
        const hit = world.raycastScene(ray.origin, ray.direction, 250);
        if (hit) {
          const removedId = world.removeC4At(hit.point, 2.2);
          if (removedId !== null) {
            pushTacticalMessage('Заряд C4 снят');
            syncC4QueueUI();
            renderer.syncSnapshot(world.getRenderSnapshot());
          }
        }
      }
    }
  });

  // События кнопок интерфейса
  pauseBtn.addEventListener('click', () => setPausedState(!paused));
  stepBtn.addEventListener('click', () => {
    setPausedState(true);
    stepOnceAndSync();
    syncTelemetryUI();
  });
  bulletBtn.addEventListener('click', () => setBulletTime(!bulletTimeActive));
  timeScaleSelect.addEventListener('change', () => {
    const val = Number.parseFloat(timeScaleSelect.value);
    if (Number.isFinite(val) && val > 0) {
      userTimeScale = val;
      bulletTimeActive = false;
      bulletBtn.classList.remove('active');
      applyEffectiveTimeScale();
    }
  });

  viewPbrBtn.addEventListener('click', () => setViewMode('pbr'));
  viewStressBtn.addEventListener('click', () => setViewMode('stress'));
  viewXrayBtn.addEventListener('click', () => setViewMode('xray'));

  qualitySelect.addEventListener('change', () => {
    renderer.setQualityPreset(qualitySelect.value as QualityPreset);
  });

  muteBtn.addEventListener('click', () => {
    muted = !muted;
    audio.setMuted(muted);
    muteBtn.classList.toggle('active', muted);
    muteBtn.textContent = muted ? '🔇 Без звука' : '🔊 Звук';
  });

  resetBtn.addEventListener('click', () => resetScene());

  for (const [toolId, btn] of toolButtons) {
    btn.addEventListener('click', () => setActiveTool(toolId));
  }

  c4DelaySelect.addEventListener('change', () => {
    const v = Number.parseFloat(c4DelaySelect.value);
    toolSettings.c4DelaySec = Number.isFinite(v) && v >= 0 ? v : 0;
  });

  detonateC4Btn.addEventListener('click', () => {
    audio.unlock();
    if (world.getPlantedC4Count() > 0) {
      world.detonateAllC4();
      pushTacticalMessage('Запуск каскадного подрыва C4!', true);
      syncC4QueueUI();
    }
  });

  autoSlowmoToggle.addEventListener('change', () => {
    autoSlowmoEnabled = autoSlowmoToggle.checked;
    root.dataset.autoSlowmo = String(autoSlowmoEnabled);
    if (!autoSlowmoEnabled && autoSlowmoRemainSec > 0) {
      autoSlowmoRemainSec = 0;
      applyEffectiveTimeScale();
    }
  });

  hintCloseBtn.addEventListener('click', () => {
    controlsHint.classList.add('hidden');
  });

  // Горячие клавиши
  window.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) {
      return;
    }
    const key = e.key.toLowerCase();
    if (key >= '1' && key <= '6') {
      const tool = ALPHA_TOOL_ORDER[Number(key) - 1];
      if (tool) setActiveTool(tool);
    } else if (e.code === 'Space') {
      e.preventDefault();
      setPausedState(!paused);
    } else if (key === '.') {
      setPausedState(true);
      stepOnceAndSync();
      syncTelemetryUI();
    } else if (key === 'b' || key === 'и') {
      setBulletTime(!bulletTimeActive);
    } else if (key === 'v' || key === 'м') {
      const nextIdx = (VIEW_MODE_ORDER.indexOf(viewMode) + 1) % VIEW_MODE_ORDER.length;
      setViewMode(VIEW_MODE_ORDER[nextIdx]!);
    } else if (key === 'd' || key === 'в') {
      audio.unlock();
      if (world.getPlantedC4Count() > 0) {
        world.detonateAllC4();
        pushTacticalMessage('Запуск каскадного подрыва C4!', true);
      }
    } else if (key === 'r' || key === 'к') {
      resetScene();
    } else if (key === 'm' || key === 'ь') {
      muteBtn.click();
    }
  });

  // Первый снимок и снятие экрана загрузки
  renderer.setCriticalNodes(world.getCriticalLoadBearingNodeIds(8));
  renderer.syncSnapshot(world.getRenderSnapshot());
  renderer.renderFrame(FIXED_DT);
  syncTelemetryUI();
  pushTacticalMessage('Полигон готов к испытаниям');
  root.dataset.ready = 'true';
  loadingOverlay.classList.add('hidden');

  // Главный цикл симуляции и рендера
  function frame(nowMs: number): void {
    const dtReal = Math.min(0.1, Math.max(0.001, (nowMs - lastFrameMs) / 1000));
    lastFrameMs = nowMs;
    fpsSmoothed = fpsSmoothed * 0.9 + (1 / dtReal) * 0.1;

    if (autoSlowmoRemainSec > 0) {
      autoSlowmoRemainSec = Math.max(0, autoSlowmoRemainSec - dtReal);
      if (autoSlowmoRemainSec === 0) {
        applyEffectiveTimeScale();
      }
    }

    // Непрерывный прожиг плазморезаком при удержании ЛКМ
    if (primaryPointerDown && activeTool === 'cutter' && !paused) {
      fireActiveToolAtClient(pointerClientX, pointerClientY, dtReal * effectiveTimeScale);
    }

    if (!paused) {
      accumulatorSec = Math.min(accumulatorSec + dtReal * effectiveTimeScale, FIXED_DT * 4);
      let stepsThisFrame = 0;
      while (accumulatorSec >= FIXED_DT && stepsThisFrame < 3) {
        stepOnceAndSync();
        accumulatorSec -= FIXED_DT;
        stepsThisFrame += 1;
      }
    }

    renderer.renderFrame(dtReal);

    hudSyncElapsed += dtReal;
    if (hudSyncElapsed >= 0.08) {
      hudSyncElapsed = 0;
      syncTelemetryUI();
    }

    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
}

bootstrapAlpha().catch((err) => {
  const loadingText = document.getElementById('loading-text');
  if (loadingText) {
    loadingText.textContent = `Ошибка запуска симулятора: ${err instanceof Error ? err.message : String(err)}`;
  }
  console.error(err);
});
