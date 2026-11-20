import { afterEach, describe, expect, it } from 'vitest';
import { DestructionWorld } from '../../src/physics/DestructionWorld';
import {
  SANDBOX_BLUEPRINT_CATALOG,
  spawnBlueprintInWorld,
} from '../../src/content/BuildingBlueprints';
import {
  CAMPAIGN_CONTRACTS,
  spawnCampaignContractInWorld,
} from '../../src/content/CampaignMissions';
import { LAB_BENCHES, spawnLabBenchInWorld } from '../../src/content/LabBenches';
import { ProgressionStore } from '../../src/modes/ProgressionStore';
import { executeArsenalTool, getToolSpecsForLevel } from '../../src/modes/ArsenalController';
import { SceneRenderer } from '../../src/render/SceneRenderer';

let world: DestructionWorld | null = null;

afterEach(() => {
  world?.dispose();
  world = null;
});

function stepTicks(w: DestructionWorld, count: number): void {
  for (let i = 0; i < count; i++) {
    w.step();
  }
}

describe('Полная интеграция v1.0: 6 чертежей Песочницы, 8 контрактов Кампании, 4 стенда Лаборатории и прокачка Ур. 1–5', () => {
  it('все 6 архитектурных сооружений Песочницы устойчиво стоят в покое без саморазрушения', async () => {
    world = await DestructionWorld.create({ seed: 2026 });
    for (const entry of SANDBOX_BLUEPRINT_CATALOG) {
      spawnBlueprintInWorld(world, entry.id, { clearFirst: true });
      stepTicks(world, 45);
      const t = world.getTelemetry();
      expect(t.initialBlockCount, `Чертёж ${entry.id}: блоки`).toBeGreaterThan(10);
      expect(t.destructionPct, `Чертёж ${entry.id}: саморазрушение`).toBeLessThan(2);
      expect(t.brokenJointCount, `Чертёж ${entry.id}: ложные обрывы`).toBe(0);
    }

    // Проверка перераспределения напряжений на 6-м тике после подрыва угловой опоры tower одним зарядом C4 Ур. 1
    spawnBlueprintInWorld(world, 'tower', { clearFirst: true });
    stepTicks(world, 15);
    const s0 = world.getTelemetry().maxStressUtilization;
    executeArsenalTool({
      world,
      tool: 'c4',
      level: 1,
      rayOrigin: [-2.2, 1.8, 12],
      rayDirection: [0, 0, -1],
      c4DelaySec: 0,
      quakeFrequencyHz: 2.5,
      quakeAmplitudeM: 0.35,
    });
    world.detonateAllC4();
    stepTicks(world, 6);
    const sAfter6 = world.getTelemetry().maxStressUtilization;
    expect(world.getTelemetry().brokenJointCount).toBeGreaterThanOrEqual(1);
    expect(sAfter6).toBeGreaterThan(s0);
  });

  it('все 8 контрактов Кампании загружаются со стабильным каркасом и нулевым ущербом соседям в покое', async () => {
    world = await DestructionWorld.create({ seed: 2026 });
    for (const contract of CAMPAIGN_CONTRACTS) {
      spawnCampaignContractInWorld(world, contract);
      stepTicks(world, 35);
      const t = world.getTelemetry();
      expect(t.initialBlockCount, `Контракт ${contract.id}`).toBeGreaterThan(8);
      expect(t.destructionPct, `Контракт ${contract.id}: снос в покое`).toBeLessThan(2);
      expect(t.protectedDamagePct, `Контракт ${contract.id}: ущерб соседям в покое`).toBe(0);
      expect(t.brokenJointCount, `Контракт ${contract.id}: связи в покое`).toBe(0);
    }
  });

  it('все 4 стенда Физической Лаборатории стоят в покое и поддерживают переключение атмосферы рендера', async () => {
    world = await DestructionWorld.create({ seed: 2026 });
    const renderer = new SceneRenderer({ headless: true });

    for (const benchId of Object.keys(LAB_BENCHES) as Array<keyof typeof LAB_BENCHES>) {
      spawnLabBenchInWorld(world, benchId);
      stepTicks(world, 35);
      const t = world.getTelemetry();
      expect(t.initialBlockCount, `Стенд ${benchId}`).toBeGreaterThanOrEqual(5);
      expect(t.brokenJointCount, `Стенд ${benchId}: обрывы в покое`).toBe(0);
    }

    renderer.setSkyPreset('sunset');
    expect(renderer.getSkyPreset()).toBe('sunset');
    renderer.setSkyPreset('night');
    expect(renderer.getSkyPreset()).toBe('night');
    renderer.setAimReticle({
      visible: true,
      point: [0, 1.5, 2],
      normal: [0, 0, 1],
      tool: 'bomb',
      radiusM: 3.2,
      buildMode: false,
      buildMaterialId: 'reinforced_concrete',
    });
    renderer.syncSnapshot(world.getRenderSnapshot());
    renderer.renderFrame(1 / 60);
    expect(renderer.getDrawCallsCount()).toBeLessThanOrEqual(40);
    renderer.dispose();

    // Проверка резонансного разрушения на вибростенде seismic (2.2 Гц, 1.7 м)
    spawnLabBenchInWorld(world, 'seismic');
    stepTicks(world, 10);
    expect(world.getTelemetry().brokenJointCount).toBe(0);
    world.triggerEarthquake({ frequencyHz: 2.2, amplitudeM: 1.7, durationSec: 6.5 });
    let maxStress = 0;
    for (let i = 0; i < 90; i++) {
      world.step();
      const s = world.getTelemetry().maxStressUtilization;
      if (s > maxStress) maxStress = s;
    }
    expect(maxStress).toBeGreaterThan(0.6);
    expect(world.getTelemetry().brokenJointCount).toBeGreaterThan(0);
  });

  it('прокачка инструмента Ур. 1 -> Ур. 5 увеличивает мощность сноса в физическом мире', async () => {
    const store = new ProgressionStore();
    store.recordContractVictory({
      contractId: 'contract-01',
      stars: 3,
      destructionPct: 80,
      baseRewardCredits: 5000,
      budgetSavedBonus: 100,
      comboBonus: 100,
    });
    expect(store.upgradeTool('cannon')).toBe(true);
    expect(store.getToolLevel('cannon')).toBe(2);
    expect(getToolSpecsForLevel(5).cannonMassKg).toBeGreaterThan(getToolSpecsForLevel(1).cannonMassKg);

    world = await DestructionWorld.create({ seed: 2026 });
    spawnBlueprintInWorld(world, 'fortress', { clearFirst: true });
    stepTicks(world, 2);
    executeArsenalTool({
      world,
      tool: 'cannon',
      level: 1,
      rayOrigin: [0, 1.5, 20],
      rayDirection: [0, 0, -1],
      c4DelaySec: 0,
      quakeFrequencyHz: 2.5,
      quakeAmplitudeM: 0.35,
    });
    stepTicks(world, 30);
    const brokenLv1 = world.getTelemetry().brokenJointCount;

    spawnBlueprintInWorld(world, 'fortress', { clearFirst: true });
    stepTicks(world, 2);
    executeArsenalTool({
      world,
      tool: 'cannon',
      level: 5,
      rayOrigin: [0, 1.5, 20],
      rayDirection: [0, 0, -1],
      c4DelaySec: 0,
      quakeFrequencyHz: 2.5,
      quakeAmplitudeM: 0.35,
    });
    stepTicks(world, 30);
    const brokenLv5 = world.getTelemetry().brokenJointCount;

    expect(brokenLv5).toBeGreaterThanOrEqual(brokenLv1);
    expect(world.getTelemetry().destructionPct).toBeGreaterThan(0);
  });
});
