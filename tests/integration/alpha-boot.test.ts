import { afterEach, describe, expect, it } from 'vitest';
import { DestructionWorld } from '../../src/physics/DestructionWorld';
import {
  buildAlphaBuildingSpecs,
  buildAlphaProvingGround,
} from '../../src/content/AlphaProvingGround';
import {
  applyAlphaTool,
  DEFAULT_ALPHA_TOOL_SETTINGS,
} from '../../src/modes/AlphaArsenal';
import { SceneRenderer } from '../../src/render/SceneRenderer';
import { DestructionSoundEngine } from '../../src/audio/DestructionSoundEngine';
import type { SimulationEvent, Vec3 } from '../../src/core/types';

/**
 * Интеграционный тест сборки v0.1 Alpha: полигон стоит под собственным весом,
 * инструменты реально разрушают конструкции, а headless-рендер и звук принимают снимки и события.
 */

let world: DestructionWorld | null = null;

afterEach(() => {
  world?.dispose();
  world = null;
});

function stepMany(w: DestructionWorld, ticks: number): SimulationEvent[] {
  const all: SimulationEvent[] = [];
  for (let i = 0; i < ticks; i++) {
    const ev = w.step();
    for (const e of ev) all.push(e);
  }
  return all;
}

function aimAt(from: Vec3, to: Vec3): { origin: Vec3; direction: Vec3 } {
  const d: Vec3 = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
  const len = Math.hypot(d[0], d[1], d[2]);
  return { origin: from, direction: [d[0] / len, d[1] / len, d[2] / len] };
}

describe('Сборка v0.1 Alpha — полигон и арсенал', () => {
  it('спецификация здания содержит все пять конструкционных материалов', () => {
    const mats = new Set(buildAlphaBuildingSpecs().map((s) => s.materialId));
    for (const m of ['reinforced_concrete', 'steel', 'glass', 'wood', 'brick'] as const) {
      expect(mats.has(m)).toBe(true);
    }
  });

  it('полигон возводится и устойчиво стоит под собственным весом 2 с', async () => {
    world = await DestructionWorld.create({ seed: 2026 });
    const info = buildAlphaProvingGround(world);
    expect(info.buildingNodeIds.length).toBeGreaterThan(80);
    expect(info.explosiveNodeIds.length).toBe(3);
    expect(info.dominoNodeIds.length).toBe(7);

    const t0 = world.getTelemetry();
    expect(t0.initialBlockCount).toBe(info.totalBlocks);
    expect(t0.initialJointCount).toBeGreaterThan(100);

    stepMany(world, 120);
    const t1 = world.getTelemetry();
    // Без воздействия игрока здание не должно разваливаться само
    expect(t1.destructionPct).toBeLessThan(5);
    expect(t1.brokenJointCount).toBeLessThanOrEqual(Math.ceil(t0.initialJointCount * 0.05));
    expect(world.getCriticalLoadBearingNodeIds(6).length).toBeGreaterThan(0);
  });

  it('залп пушки по колонне первого этажа реально дробит конструкцию', async () => {
    world = await DestructionWorld.create({ seed: 2026 });
    buildAlphaProvingGround(world);
    stepMany(world, 2); // broad-phase Rapier обновляется на шаге — прогрев перед рейкастом
    stepMany(world, 10);
    const before = world.getTelemetry();

    const ray = aimAt([-2, 1.5, 30], [-2, 1.5, 4]);
    const events: SimulationEvent[] = [];
    for (let shot = 0; shot < 3; shot++) {
      const out = applyAlphaTool(world, 'cannon', ray, DEFAULT_ALPHA_TOOL_SETTINGS);
      expect(out.kind).toBe('projectile');
      events.push(...stepMany(world, 40));
    }
    const after = world.getTelemetry();
    const fractures = events.filter((e) => e.type === 'fracture');
    expect(fractures.length).toBeGreaterThan(0);
    expect(after.intactBlockCount + after.activeShardCount + after.bakedRubbleCount).toBeGreaterThan(0);
    expect(after.brokenJointCount).toBeGreaterThan(before.brokenJointCount);
  });

  it('C4 с задержкой секвенсора ставится на грань и подрывается детонатором', async () => {
    world = await DestructionWorld.create({ seed: 2026 });
    buildAlphaProvingGround(world);
    stepMany(world, 2); // broad-phase Rapier обновляется на шаге — прогрев перед рейкастом
    const ray = aimAt([6, 1.3, 20], [6, 1.3, 4]);
    const out = applyAlphaTool(world, 'c4', ray, { ...DEFAULT_ALPHA_TOOL_SETTINGS, c4DelaySec: 0.25 });
    expect(out.kind).toBe('c4_planted');
    expect(world.getPlantedC4Count()).toBe(1);
    expect(world.getC4SequenceQueue()[0]!.delaySec).toBeCloseTo(0.25, 5);

    world.detonateAllC4();
    const events = stepMany(world, 60);
    expect(events.some((e) => e.type === 'explosion')).toBe(true);
    expect(world.getPlantedC4Count()).toBe(0);
  });

  it('фугас у газовых резервуаров вызывает цепную детонацию', async () => {
    world = await DestructionWorld.create({ seed: 2026 });
    buildAlphaProvingGround(world);
    stepMany(world, 2); // broad-phase Rapier обновляется на шаге — прогрев перед рейкастом
    const ray = aimAt([9.3, 6, 12], [9.3, 0.65, 2.4]);
    const out = applyAlphaTool(world, 'bomb', ray, DEFAULT_ALPHA_TOOL_SETTINGS);
    expect(out.kind).toBe('blast');
    const events = stepMany(world, 60);
    expect(events.some((e) => e.type === 'explosion' && e.isChainDetonation)).toBe(true);
    expect(world.getTelemetry().detonatedExplosivesCount).toBeGreaterThan(0);
  });

  it('термит поджигает деревянную надстройку, сейсмика запускает платформу', async () => {
    world = await DestructionWorld.create({ seed: 2026 });
    buildAlphaProvingGround(world);
    stepMany(world, 2); // broad-phase Rapier обновляется на шаге — прогрев перед рейкастом
    const ray = aimAt([2, 13.4, 25], [2, 13.4, 4]);
    const ign = applyAlphaTool(world, 'incendiary', ray, DEFAULT_ALPHA_TOOL_SETTINGS);
    expect(ign.kind).toBe('ignite');
    stepMany(world, 30);
    expect(world.getTelemetry().maxTemperatureC).toBeGreaterThan(200);

    applyAlphaTool(world, 'seismic', ray, DEFAULT_ALPHA_TOOL_SETTINGS);
    stepMany(world, 10);
    expect(world.getTelemetry().seismicActive).toBe(true);
  });

  it('headless-рендер и звуковой движок принимают снимок и события без исключений', async () => {
    world = await DestructionWorld.create({ seed: 2026 });
    buildAlphaProvingGround(world);
    stepMany(world, 2); // broad-phase Rapier обновляется на шаге — прогрев перед рейкастом
    const renderer = new SceneRenderer({ headless: true });
    const audio = new DestructionSoundEngine();
    const ray = aimAt([-2, 1.5, 30], [-2, 1.5, 4]);
    applyAlphaTool(world, 'cannon', ray, DEFAULT_ALPHA_TOOL_SETTINGS);
    const events = stepMany(world, 30);
    const snap = world.getRenderSnapshot();
    expect(snap.blocks.length).toBeGreaterThan(0);
    renderer.syncSnapshot(snap);
    renderer.setViewMode('xray');
    renderer.setCriticalNodes(world.getCriticalLoadBearingNodeIds(6));
    renderer.consumeEvents(events);
    renderer.renderFrame(1 / 60);
    audio.consumeEvents(events, world.getTelemetry());
    expect(renderer.getDrawCallsCount()).toBeGreaterThan(0);
    renderer.dispose();
    audio.dispose();
  });
});
