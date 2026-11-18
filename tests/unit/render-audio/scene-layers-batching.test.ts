import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { SeededRng } from '../../../src/core/rng';
import {
  STRUCTURAL_MATERIAL_IDS,
  type PlantedChargeSnapshot,
  type RenderBlockInstance,
  type RenderBondOrRebarLine,
  type RenderShardInstance,
  type RenderSnapshot,
  type RenderViewMode,
  type StructuralMaterialId,
} from '../../../src/core/types';
import { getMaterialProfile } from '../../../src/physics/MaterialRegistry';
import { fractureBoxVoronoi3D } from '../../../src/physics/VoronoiFracture3D';
import {
  BatchedShardLayer,
  buildShardBufferGeometry,
  computeShardInstanceTint,
} from '../../../src/render/BatchedShardLayer';
import { getMaterialDustColorHex } from '../../../src/render/CollapseVFXSystem';
import {
  computeBlockInstanceColor,
  InstancedBlockLayer,
  sampleStressHeatmapColor,
} from '../../../src/render/InstancedBlockLayer';
import {
  computeBondStressColor,
  computeC4SequencerBeaconSpec,
  RebarAndJointLayer,
} from '../../../src/render/RebarAndJointLayer';
import { SceneRenderer } from '../../../src/render/SceneRenderer';

/**
 * Комплексные безмоковые модульные тесты слоёв рендеринга и батчинга Вехи M3:
 * InstancedBlockLayer, BatchedShardLayer, RebarAndJointLayer и главный фасад SceneRenderer.
 */

function linearChannelToSrgb(c: number): number {
  const clamped = Math.max(0, c);
  if (clamped <= 0.0031308) {
    return clamped * 12.92;
  }
  return 1.055 * Math.pow(clamped, 1 / 2.4) - 0.055;
}

/**
 * Переводит линейный цвет THREE.Color (с учётом возможного HDR > 1.0) в HSV (hueDeg in [0, 360), sat in [0, 1]).
 */
function colorToHsvDeg(color: THREE.Color): { hueDeg: number; sat: number; val: number } {
  const maxLin = Math.max(1.0, color.r, color.g, color.b);
  const r = linearChannelToSrgb(color.r / maxLin);
  const g = linearChannelToSrgb(color.g / maxLin);
  const b = linearChannelToSrgb(color.b / maxLin);

  const cMax = Math.max(r, g, b);
  const cMin = Math.min(r, g, b);
  const delta = cMax - cMin;

  let hueDeg = 0;
  if (delta > 1e-6) {
    if (cMax === r) {
      hueDeg = 60 * (((g - b) / delta) % 6);
    } else if (cMax === g) {
      hueDeg = 60 * ((b - r) / delta + 2);
    } else {
      hueDeg = 60 * ((r - g) / delta + 4);
    }
    if (hueDeg < 0) hueDeg += 360;
  }

  const sat = cMax > 1e-6 ? delta / cMax : 0;
  return { hueDeg, sat, val: cMax };
}

function assertNotPurple(color: THREE.Color, contextLabel: string): void {
  const { hueDeg, sat, val } = colorToHsvDeg(color);
  if (sat > 0.08 && val > 0.05) {
    const isForbiddenPurple = hueDeg >= 262 && hueDeg <= 318;
    expect(
      isForbiddenPurple,
      `Обнаружен запрещённый фиолетовый оттенок (${contextLabel}): hue=${hueDeg.toFixed(1)}°, sat=${sat.toFixed(2)}`,
    ).toBe(false);
  }
}

function makeBlock(
  nodeId: number,
  materialId: StructuralMaterialId,
  overrides?: Partial<RenderBlockInstance>,
): RenderBlockInstance {
  return {
    nodeId,
    materialId,
    position: [0, 2, 0],
    quaternion: [0, 0, 0, 1],
    halfExtents: [1.2, 0.45, 0.8],
    stressUtilization: 0.25,
    damageRatio: 0,
    temperatureC: 20,
    charRatio: 0,
    burning: false,
    structureGroupTag: 'target',
    ...overrides,
  };
}

describe('Математическая гарантия отсутствия фиолетовых цветов (No Purple) во всех слоях', () => {
  it('исключает сектор Hue 262°..318° на тепловой шкале напряжений, блоках, осколках, связях и маяках C4', () => {
    const tmp = new THREE.Color();
    const baseCol = new THREE.Color();

    // 1. Тепловая карта механических напряжений (220 точек от -0.2 до 2.0)
    for (let i = 0; i <= 220; i++) {
      const u = -0.2 + (i / 220) * 2.2;
      sampleStressHeatmapColor(u, tmp);
      assertNotPurple(tmp, `sampleStressHeatmapColor(u=${u.toFixed(3)})`);
    }

    // 2. Блоки всех 6 материалов во всех режимах, температурах, повреждениях и горении
    const modes: RenderViewMode[] = ['pbr', 'stress', 'xray'];
    const temps = [20, 280, 460, 580, 750, 980, 1200];
    const chars = [0, 0.4, 0.9];
    const damages = [0, 0.5, 1.0];

    for (const matId of STRUCTURAL_MATERIAL_IDS) {
      const dustColor = new THREE.Color().setHex(
        getMaterialDustColorHex(matId),
        THREE.SRGBColorSpace,
      );
      assertNotPurple(dustColor, `dustColor(${matId})`);

      for (const mode of modes) {
        for (const tempC of temps) {
          for (const charRatio of chars) {
            for (const damageRatio of damages) {
              for (const burning of [false, true]) {
                const blk = makeBlock(7, matId, {
                  stressUtilization: 0.72,
                  damageRatio,
                  temperatureC: tempC,
                  charRatio,
                  burning,
                });
                computeBlockInstanceColor(blk, mode, 1.25, tmp);
                assertNotPurple(
                  tmp,
                  `block(${matId},${mode},T=${tempC},char=${charRatio},burn=${String(burning)})`,
                );
              }
            }
          }

          // Произведение вершинного цвета осколка на его инстансный множитель в BatchedMesh
          const profile = getMaterialProfile(matId);
          for (const hex of [profile.baseColorHex, profile.interiorCutColorHex]) {
            baseCol.setHex(hex, THREE.SRGBColorSpace);
            computeShardInstanceTint(
              { materialId: matId, temperatureC: tempC, charRatio: 0.25 },
              mode,
              tmp,
            );
            tmp.multiply(baseCol);
            assertNotPurple(tmp, `shard(${matId},${mode},T=${tempC})`);
          }
        }
      }
    }

    // 3. Связи при сжатии, растяжении и нулевом осевом усилии
    for (const force of [-800_000, -100, 0, 100, 800_000]) {
      for (let k = 0; k <= 140; k++) {
        const u = (k / 140) * 1.4;
        computeBondStressColor(force, u, 0.8, tmp);
        assertNotPurple(tmp, `bond(F=${force},u=${u.toFixed(2)})`);
      }
    }

    // 4. Световые столбики очереди секвенсора C4
    for (const delaySec of [0, 0.25, 0.5, 0.75, 1.0, 1.75]) {
      for (const armed of [false, true]) {
        const spec = computeC4SequencerBeaconSpec({
          chargeId: 1,
          position: [0, 1, 0],
          normal: [0, 0, 1],
          delaySec,
          armed,
          remainingCountdownSec: armed ? delaySec * 0.5 : null,
        });
        assertNotPurple(spec.color, `c4Beacon(delay=${delaySec},armed=${String(armed)})`);
      }
    }
  });
});

describe('InstancedBlockLayer — батчинг 6 материалов, масштаб halfExtents*2, пауза и критические узлы', () => {
  it('масштабирует BoxGeometry(1,1,1) строго на 2*halfExtents и скрывает пустые слоты материалов', () => {
    const layer = new InstancedBlockLayer({ quality: 'high', seed: 42 });

    const blocks: RenderBlockInstance[] = [
      makeBlock(101, 'reinforced_concrete', {
        position: [3, 4, -2],
        halfExtents: [1.5, 0.6, 2.25],
      }),
      makeBlock(102, 'glass', {
        position: [-1, 2, 5],
        halfExtents: [0.8, 1.1, 0.08],
      }),
    ];

    layer.syncBlocks(blocks, 0);

    const concreteMesh = layer.getMaterialMesh('reinforced_concrete');
    const glassMesh = layer.getMaterialMesh('glass');
    const brickMesh = layer.getMaterialMesh('brick');

    expect(concreteMesh.visible).toBe(true);
    expect(concreteMesh.count).toBe(1);
    expect(glassMesh.visible).toBe(true);
    expect(glassMesh.count).toBe(1);
    expect(glassMesh.castShadow).toBe(false);
    expect(brickMesh.visible).toBe(false);
    expect(brickMesh.count).toBe(0);

    const m = new THREE.Matrix4();
    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    concreteMesh.getMatrixAt(0, m);
    m.decompose(pos, quat, scale);

    expect(pos.x).toBeCloseTo(3, 5);
    expect(pos.y).toBeCloseTo(4, 5);
    expect(pos.z).toBeCloseTo(-2, 5);
    expect(scale.x).toBeCloseTo(3.0, 5);
    expect(scale.y).toBeCloseTo(1.2, 5);
    expect(scale.z).toBeCloseTo(4.5, 5);

    layer.dispose();
  });

  it('автоматически расширяет ёмкость слота свыше 512 блоков и мгновенно меняет режим и критические опоры на паузе', () => {
    const layer = new InstancedBlockLayer({ quality: 'performance', seed: 99 });

    const manyBlocks: RenderBlockInstance[] = [];
    for (let i = 0; i < 620; i++) {
      manyBlocks.push(
        makeBlock(i + 1, 'steel', {
          position: [(i % 20) * 1.2, Math.floor(i / 20) * 0.8 + 0.5, 0],
          stressUtilization: (i % 10) * 0.11,
          temperatureC: i === 0 ? 850 : 20,
        }),
      );
    }

    layer.syncBlocks(manyBlocks, 1.0);
    const diagPbr = layer.getDiagnostics();
    expect(diagPbr.totalBlocks).toBe(620);
    expect(diagPbr.capacitiesByMaterial.steel).toBeGreaterThanOrEqual(620);
    expect(diagPbr.activeMaterialSlots).toBe(1);

    const steelMesh = layer.getMaterialMesh('steel');
    const colorPbr = new THREE.Color();
    steelMesh.getColorAt(0, colorPbr);

    // Задаём критические узлы и переключаем режим БЕЗ повторного вызова syncBlocks (эмуляция паузы!)
    layer.setCriticalNodes([1, 2, 3]);
    expect(layer.getCriticalHighlightMesh().visible).toBe(false); // в PBR рамка скрыта

    layer.setViewMode('stress');
    expect(layer.getCriticalHighlightMesh().visible).toBe(true);
    expect(layer.getCriticalHighlightMesh().count).toBe(3);

    const colorStress = new THREE.Color();
    steelMesh.getColorAt(0, colorStress);
    expect(
      Math.abs(colorPbr.r - colorStress.r) +
        Math.abs(colorPbr.g - colorStress.g) +
        Math.abs(colorPbr.b - colorStress.b),
    ).toBeGreaterThan(0.05);

    layer.setViewMode('xray');
    expect(layer.getCriticalHighlightMesh().visible).toBe(true);
    const colorXray = new THREE.Color();
    steelMesh.getColorAt(0, colorXray);
    expect(
      Math.abs(colorStress.r - colorXray.r) +
        Math.abs(colorStress.g - colorXray.g) +
        Math.abs(colorStress.b - colorXray.b),
    ).toBeGreaterThan(0.05);

    layer.dispose();
  });
});

describe('BatchedShardLayer — реальные 3D-осколки Вороного, грани скола isInteriorCut и rebarStubs', () => {
  it('строит центрированную геометрию осколка с контрастными цветами коры (baseColorHex) и скола (interiorCutColorHex)', () => {
    const fracture = fractureBoxVoronoi3D({
      halfExtents: [1.4, 0.8, 1.0],
      materialId: 'brick',
      worldPosition: [12, 8, -6], // Заведомо далеко от нуля для проверки отсутствия смещения на centroid!
      shardCount: 8,
      seed: 1337,
    });

    expect(fracture.shards.length).toBeGreaterThanOrEqual(4);
    const profile = getMaterialProfile('brick');
    const extExpected = new THREE.Color().setHex(profile.baseColorHex, THREE.SRGBColorSpace);
    const cutExpected = new THREE.Color().setHex(profile.interiorCutColorHex, THREE.SRGBColorSpace);

    let sawExteriorVertex = false;
    let sawInteriorCutVertex = false;

    for (const shard of fracture.shards) {
      const geom = buildShardBufferGeometry(shard.polyhedron, profile);
      expect(geom).not.toBeNull();
      if (!geom) continue;

      // BoundingSphere локальной геометрии обязана оставаться около (0,0,0), а НЕ улетать в [12, 8, -6]!
      expect(geom.boundingSphere).not.toBeNull();
      expect(geom.boundingSphere!.center.length()).toBeLessThan(2.5);

      const colAttr = geom.getAttribute('color');
      expect(colAttr).toBeDefined();
      for (let v = 0; v < colAttr.count; v++) {
        const r = colAttr.getX(v);
        const g = colAttr.getY(v);
        const b = colAttr.getZ(v);
        if (
          Math.abs(r - extExpected.r) < 1e-4 &&
          Math.abs(g - extExpected.g) < 1e-4 &&
          Math.abs(b - extExpected.b) < 1e-4
        ) {
          sawExteriorVertex = true;
        }
        if (
          Math.abs(r - cutExpected.r) < 1e-4 &&
          Math.abs(g - cutExpected.g) < 1e-4 &&
          Math.abs(b - cutExpected.b) < 1e-4
        ) {
          sawInteriorCutVertex = true;
        }
      }
      geom.dispose();
    }

    expect(sawExteriorVertex).toBe(true);
    expect(sawInteriorCutVertex).toBe(true);
  });

  it('объединяет осколки всех 6 материалов в 3 BatchedMesh, рендерит rebarStubs и чисто пересоздаёт пустые бакеты', () => {
    const layer = new BatchedShardLayer({ quality: 'high' });
    const shards: RenderShardInstance[] = [];
    let nextShardId = 1;

    for (const matId of STRUCTURAL_MATERIAL_IDS) {
      const res = fractureBoxVoronoi3D({
        halfExtents: [1.0, 0.7, 0.7],
        materialId: matId,
        worldPosition: [0, 3, 0],
        shardCount: 6,
        seed: 500 + nextShardId,
      });

      for (const s of res.shards) {
        shards.push({
          shardId: nextShardId++,
          materialId: matId,
          polyhedron: s.polyhedron,
          position: s.worldPosition,
          quaternion: [0, 0, 0, 1],
          temperatureC: matId === 'steel' ? 760 : 20,
          charRatio: matId === 'wood' ? 0.55 : 0,
          sleeping: false,
          rebarStubs: s.rebarStubs,
        });
      }
    }

    layer.syncShards(shards);
    const diag = layer.getDiagnostics();
    expect(diag.activeShardCount).toBe(shards.length);
    expect(diag.countsByBucket.matte).toBeGreaterThan(0);
    expect(diag.countsByBucket.metallic).toBeGreaterThan(0);
    expect(diag.countsByBucket.glass).toBeGreaterThan(0);
    expect(diag.activeRebarStubCount).toBeGreaterThan(0);
    expect(layer.getRebarStubMesh().visible).toBe(true);
    // Все 3 бакета + 1 меш арматуры (+ 2 теневых от matte/metallic) = всего 6 Draw Calls на десятки полиэдров!
    expect(diag.estimatedDrawCalls).toBeLessThanOrEqual(6);

    // Помечаем осколки спящими и проверяем повторную синхронизацию и смену режима на паузе
    const sleepingShards = shards.map((s) => ({ ...s, sleeping: true }));
    layer.syncShards(sleepingShards);
    layer.setViewMode('xray');
    expect(layer.getViewMode()).toBe('xray');
    expect(layer.getBatchMesh('matte').visible).toBe(true);

    // Полное опустошение снимка обязано скрыть все меши и обнулить Draw Calls без утечек
    layer.syncShards([]);
    const emptyDiag = layer.getDiagnostics();
    expect(emptyDiag.activeShardCount).toBe(0);
    expect(emptyDiag.activeRebarStubCount).toBe(0);
    expect(emptyDiag.estimatedDrawCalls).toBe(0);

    layer.dispose();
  });
});

describe('RebarAndJointLayer и SceneRenderer — секвенсор C4, связи и бюджет <= 40 Draw Calls', () => {
  it('скрывает внутренние связи bond в PBR, включает их в Stress/X-Ray и масштабирует маяки секвенсора C4', () => {
    const layer = new RebarAndJointLayer();

    const bondsAndRebars: RenderBondOrRebarLine[] = [
      {
        id: 1,
        kind: 'bond',
        pointA: [0, 0.5, 0],
        pointB: [0, 2.5, 0],
        stressUtilization: 0.4,
        axialForceN: -120_000,
        broken: false,
      },
      {
        id: 2,
        kind: 'rebar',
        pointA: [1, 1.0, 0],
        pointB: [1, 2.2, 0],
        stressUtilization: 0.82,
        axialForceN: 95_000,
        broken: false,
      },
      {
        id: 3,
        kind: 'plastic_hinge',
        pointA: [-1, 3.0, 0],
        pointB: [-1, 3.4, 0],
        stressUtilization: 0.91,
        axialForceN: -45_000,
        broken: false,
      },
    ];

    const charges: PlantedChargeSnapshot[] = [
      {
        chargeId: 10,
        position: [0, 1, 1],
        normal: [0, 0, 1],
        delaySec: 0.0,
        armed: false,
        remainingCountdownSec: null,
      },
      {
        chargeId: 11,
        position: [1, 1, 1],
        normal: [0, 0, 1],
        delaySec: 0.25,
        armed: false,
        remainingCountdownSec: null,
      },
      {
        chargeId: 12,
        position: [2, 1, 1],
        normal: [0, 0, 1],
        delaySec: 1.0,
        armed: true,
        remainingCountdownSec: 0.8,
      },
    ];

    const snapshot: RenderSnapshot = {
      tick: 12,
      simTimeSec: 0.2,
      platformOffset: [0, 0, 0],
      blocks: [makeBlock(5, 'reinforced_concrete')],
      shards: [],
      bondsAndRebars,
      plantedCharges: charges,
      projectiles: [
        {
          id: 1,
          position: [-6, 4, 4],
          radiusM: 0.18,
          velocity: [45, -2, -30],
          hot: true,
        },
      ],
    };

    layer.sync(snapshot, 'pbr', new Set([5]), 0.2);
    const statsPbr = layer.getStats();
    expect(statsPbr.visibleBondLines).toBe(0); // внутренние связи скрыты в PBR
    expect(statsPbr.visibleRebars).toBe(1);    // физическая арматура видна в 3D
    expect(statsPbr.visibleHinges).toBe(1);    // пластический шарнир виден
    expect(statsPbr.visibleCharges).toBe(3);
    expect(statsPbr.visibleProjectiles).toBe(1);

    // Проверка ступенчатого роста высоты столбика секвенсора C4 по delaySec
    const b0 = computeC4SequencerBeaconSpec(charges[0]!);
    const b1 = computeC4SequencerBeaconSpec(charges[1]!);
    const b2 = computeC4SequencerBeaconSpec(charges[2]!);
    expect(b1.heightM).toBeGreaterThan(b0.heightM);
    expect(b2.heightM).toBeGreaterThan(b1.heightM);

    // Переключение в X-Ray на паузе (без повторного вызова sync) включает все связи и маяк критического узла!
    layer.setViewMode('xray');
    const statsXray = layer.getStats();
    expect(statsXray.visibleBondLines).toBe(3);
    expect(statsXray.visibleHinges).toBe(2); // 1 plastic_hinge + 1 критическая опора #5

    layer.dispose();
  });

  it('выдерживает экстремально нагруженную сцену разрушения строго в бюджете 0 < DrawCalls <= 40 во всех пресетах', () => {
    const renderer = new SceneRenderer({ headless: true, quality: 'ultra', seed: 2026 });
    expect(renderer.isHeadless()).toBe(true);

    const rng = new SeededRng(2026);
    const blocks: RenderBlockInstance[] = [];
    for (let i = 0; i < 360; i++) {
      const matId = STRUCTURAL_MATERIAL_IDS[i % STRUCTURAL_MATERIAL_IDS.length]!;
      blocks.push(
        makeBlock(i + 1, matId, {
          position: [rng.range(-12, 12), rng.range(0.5, 16), rng.range(-8, 8)],
          stressUtilization: rng.range(0, 1.15),
          damageRatio: rng.range(0, 0.8),
          temperatureC: i % 15 === 0 ? 780 : 20,
          burning: matId === 'wood' && i % 12 === 0,
        }),
      );
    }

    const shards: RenderShardInstance[] = [];
    let shardId = 1;
    for (const matId of STRUCTURAL_MATERIAL_IDS) {
      const frac = fractureBoxVoronoi3D({
        halfExtents: [1.1, 0.6, 0.8],
        materialId: matId,
        worldPosition: [0, 5, 0],
        shardCount: 16,
        seed: 700 + shardId,
      });
      for (const sh of frac.shards) {
        shards.push({
          shardId: shardId++,
          materialId: matId,
          polyhedron: sh.polyhedron,
          position: sh.worldPosition,
          quaternion: [0, 0, 0, 1],
          temperatureC: 20,
          charRatio: 0,
          sleeping: false,
          rebarStubs: sh.rebarStubs,
        });
      }
    }

    const bonds: RenderBondOrRebarLine[] = [];
    for (let i = 0; i < 300; i++) {
      bonds.push({
        id: i + 1,
        kind: i % 10 === 0 ? 'rebar' : i % 25 === 0 ? 'plastic_hinge' : 'bond',
        pointA: [0, 1, 0],
        pointB: [0, 2.2, 0],
        stressUtilization: (i % 10) * 0.1,
        axialForceN: i % 2 === 0 ? -50_000 : 40_000,
        broken: false,
      });
    }

    const heavySnapshot: RenderSnapshot = {
      tick: 180,
      simTimeSec: 3.0,
      platformOffset: [0.42, 0.03, -0.19],
      blocks,
      shards,
      bondsAndRebars: bonds,
      plantedCharges: [
        {
          chargeId: 1,
          position: [0, 2, 1],
          normal: [0, 0, 1],
          delaySec: 0,
          armed: true,
          remainingCountdownSec: 0.1,
        },
        {
          chargeId: 2,
          position: [2, 2, 1],
          normal: [0, 0, 1],
          delaySec: 0.5,
          armed: true,
          remainingCountdownSec: 0.6,
        },
      ],
      projectiles: [
        {
          id: 1,
          position: [-8, 5, 6],
          radiusM: 0.2,
          velocity: [60, 0, -40],
          hot: true,
        },
      ],
    };

    renderer.syncSnapshot(heavySnapshot);
    renderer.setCriticalNodes([1, 2, 3, 4, 5, 6]);
    renderer.consumeEvents([
      {
        type: 'explosion',
        position: [0, 3, 0],
        radiusM: 9.0,
        equivalentKgTnt: 25,
        isChainDetonation: true,
      },
      {
        type: 'rebar_snap',
        position: [1, 4, 0],
        forceN: 180_000,
      },
      {
        type: 'fire_ignited',
        nodeId: 4,
        position: [-2, 2, 0],
      },
    ]);

    // Проверяем точное смещение подвижной 3D-сейсмоплатформы
    const platPos = renderer.getSeismicPlatformGroup().position;
    expect(platPos.x).toBeCloseTo(0.42, 5);
    expect(platPos.y).toBeCloseTo(0.03, 5);
    expect(platPos.z).toBeCloseTo(-0.19, 5);

    renderer.renderFrame(1 / 60);
    const ultraPbrCalls = renderer.getDrawCallsCount();
    expect(ultraPbrCalls).toBeGreaterThan(8);
    expect(ultraPbrCalls).toBeLessThanOrEqual(40);

    // 15 циклов переключения режимов и пресетов подряд не должны вызывать утечку Draw Calls
    for (let cycle = 0; cycle < 5; cycle++) {
      renderer.setViewMode('stress');
      expect(renderer.getDrawCallsCount()).toBeGreaterThan(8);
      expect(renderer.getDrawCallsCount()).toBeLessThanOrEqual(40);

      renderer.setViewMode('xray');
      expect(renderer.getDrawCallsCount()).toBeGreaterThan(6);
      expect(renderer.getDrawCallsCount()).toBeLessThanOrEqual(40);

      renderer.setViewMode('pbr');
    }

    renderer.setQualityPreset('performance');
    renderer.renderFrame(1 / 60);
    const perfCalls = renderer.getDrawCallsCount();
    expect(perfCalls).toBeGreaterThan(6);
    expect(perfCalls).toBeLessThan(ultraPbrCalls); // без теневого прохода вызовов строго меньше!
    expect(perfCalls).toBeLessThanOrEqual(40);

    // Проверка автоочистки VFX и тряски при сбросе мира назад во времени (tick: 0 < 180)
    renderer.syncSnapshot({
      tick: 0,
      simTimeSec: 0,
      platformOffset: [0, 0, 0],
      blocks: [],
      shards: [],
      bondsAndRebars: [],
      plantedCharges: [],
      projectiles: [],
    });
    expect(renderer.getLayers().vfxSystem.getActiveCounts().total).toBe(0);
    expect(renderer.getCameraRig().getShakeOffset()).toEqual([0, 0, 0]);
    expect(renderer.getDrawCallsCount()).toBe(3); // только пол + плита + сетка полигона!

    // Идемпотентный dispose()
    renderer.dispose();
    expect(() => renderer.dispose()).not.toThrow();
  });
});

describe('Состязательная защита от вызовов после dispose() и отравленных NaN/Infinity снимков (R7 Fix)', () => {
  it('гарантирует безопасную работу (no-op / нули без исключений) ВСЕХ публичных методов после dispose() и повторного dispose()', () => {
    const blockLayer = new InstancedBlockLayer({ quality: 'high', seed: 11 });
    const shardLayer = new BatchedShardLayer({ quality: 'high' });
    const rebarLayer = new RebarAndJointLayer();
    const renderer = new SceneRenderer({ headless: true, quality: 'high', seed: 11 });

    const frac = fractureBoxVoronoi3D({
      halfExtents: [1.0, 0.6, 0.8],
      materialId: 'reinforced_concrete',
      worldPosition: [0, 2, 0],
      shardCount: 5,
      seed: 11,
    });

    const sampleSnapshot: RenderSnapshot = {
      tick: 5,
      simTimeSec: 0.1,
      platformOffset: [0, 0, 0],
      blocks: [makeBlock(1, 'reinforced_concrete', { burning: true })],
      shards: frac.shards.map((s, idx) => ({
        shardId: idx + 1,
        materialId: 'reinforced_concrete',
        polyhedron: s.polyhedron,
        position: s.worldPosition,
        quaternion: [0, 0, 0, 1],
        temperatureC: 500,
        charRatio: 0.1,
        sleeping: false,
        rebarStubs: s.rebarStubs,
      })),
      bondsAndRebars: [
        {
          id: 1,
          kind: 'rebar',
          pointA: [0, 1, 0],
          pointB: [0, 2, 0],
          stressUtilization: 0.8,
          axialForceN: 50_000,
          broken: false,
        },
      ],
      plantedCharges: [
        {
          chargeId: 1,
          position: [0, 1, 0.8],
          normal: [0, 0, 1],
          delaySec: 0.25,
          armed: true,
          remainingCountdownSec: 0.2,
        },
      ],
      projectiles: [
        {
          id: 1,
          position: [-3, 2, 3],
          radiusM: 0.15,
          velocity: [25, 0, -25],
          hot: true,
        },
      ],
    };

    blockLayer.syncBlocks(sampleSnapshot.blocks, 0.1);
    blockLayer.setCriticalNodes([1]);
    shardLayer.syncShards(sampleSnapshot.shards);
    rebarLayer.sync(sampleSnapshot, 'xray', new Set([1]), 0.1);
    renderer.syncSnapshot(sampleSnapshot);

    // Освобождаем все слои и вызываем повторный dispose()
    blockLayer.dispose();
    blockLayer.dispose();
    shardLayer.dispose();
    shardLayer.dispose();
    rebarLayer.dispose();
    rebarLayer.dispose();
    renderer.dispose();
    renderer.dispose();

    // Проверка ВСЕХ публичных методов InstancedBlockLayer после dispose()
    expect(() => {
      blockLayer.syncBlocks(sampleSnapshot.blocks, 0.2);
      blockLayer.setCriticalNodes([1, 2]);
      blockLayer.setViewMode('stress');
      blockLayer.setQualityPreset('performance');
      blockLayer.updateAnimation(0.05);
      blockLayer.clear();
      blockLayer.getObject3D();
      blockLayer.getViewMode();
      blockLayer.getCriticalHighlightMesh();
      for (const matId of STRUCTURAL_MATERIAL_IDS) {
        blockLayer.getMaterialMesh(matId);
      }
    }).not.toThrow();
    expect(blockLayer.getEstimatedDrawCalls(true)).toBe(0);
    expect(blockLayer.getDiagnostics().totalBlocks).toBe(0);
    expect(blockLayer.getDiagnostics().estimatedDrawCalls).toBe(0);

    // Проверка ВСЕХ публичных методов BatchedShardLayer после dispose()
    expect(() => {
      shardLayer.syncShards(sampleSnapshot.shards);
      shardLayer.setViewMode('xray');
      shardLayer.setQualityPreset('ultra');
      shardLayer.clear();
      shardLayer.getObject3D();
      shardLayer.getViewMode();
      shardLayer.getBatchMesh('matte');
      shardLayer.getBatchMesh('metallic');
      shardLayer.getBatchMesh('glass');
      shardLayer.getRebarStubMesh();
    }).not.toThrow();
    expect(shardLayer.getEstimatedDrawCalls(true)).toBe(0);
    expect(shardLayer.getDiagnostics().activeShardCount).toBe(0);
    expect(shardLayer.getDiagnostics().estimatedDrawCalls).toBe(0);

    // Проверка ВСЕХ публичных методов RebarAndJointLayer после dispose()
    expect(() => {
      rebarLayer.sync(sampleSnapshot, 'stress', new Set([1]), 0.5);
      rebarLayer.setViewMode('pbr');
      rebarLayer.setQualityPreset('high');
      rebarLayer.clear();
      rebarLayer.getObject3D();
    }).not.toThrow();
    expect(rebarLayer.getStats().estimatedDrawCalls).toBe(0);
    expect(rebarLayer.getStats().visibleCharges).toBe(0);

    // Проверка ВСЕХ публичных методов SceneRenderer после dispose()
    expect(() => {
      renderer.syncSnapshot(sampleSnapshot);
      renderer.setCriticalNodes([1]);
      renderer.consumeEvents([
        {
          type: 'explosion',
          position: [0, 2, 0],
          radiusM: 6,
          equivalentKgTnt: 10,
          isChainDetonation: false,
        },
      ]);
      renderer.setViewMode('xray');
      renderer.setQualityPreset('performance');
      renderer.renderFrame(1 / 60);
      renderer.focusOnBounds([0, 3, 0], 8);
      renderer.resize(800, 600);
      renderer.screenPointToRay(0, 0);
      renderer.projectWorldToScreen([0, 2, 0]);
      renderer.clientPointToNdc(400, 300);
      renderer.getCameraRig();
      renderer.getViewMode();
      renderer.getQualityPreset();
      renderer.isHeadless();
      renderer.getScene();
      renderer.getSeismicPlatformGroup();
      renderer.getLayers();
    }).not.toThrow();
    expect(renderer.getDrawCallsCount()).toBe(0);
  });

  it('санитизирует патологический RenderSnapshot с NaN, ±Infinity, ±MAX_VALUE и нулевыми кватернионами без единого NaN в GPU-буферах', () => {
    const renderer = new SceneRenderer({ headless: true, quality: 'ultra', seed: 9001 });

    const validFrac = fractureBoxVoronoi3D({
      halfExtents: [1.0, 0.7, 0.7],
      materialId: 'steel',
      worldPosition: [0, 3, 0],
      shardCount: 4,
      seed: 303,
    });
    const basePoly = validFrac.shards[0]!.polyhedron;

    // Создаём повреждённую копию полиэдра с NaN/±Infinity в вершинах и нормалях
    const corruptedVerts = new Float32Array(basePoly.vertices.length);
    corruptedVerts.set(basePoly.vertices);
    corruptedVerts[0] = Number.NaN;
    corruptedVerts[1] = Number.POSITIVE_INFINITY;
    corruptedVerts[2] = Number.NEGATIVE_INFINITY;

    const corruptedPoly = {
      ...basePoly,
      vertices: corruptedVerts,
      faces: basePoly.faces.map((f, idx) => ({
        ...f,
        normal:
          idx === 0
            ? ([Number.NaN, 0, Number.POSITIVE_INFINITY] as [number, number, number])
            : idx === 1
              ? ([0, 0, 0] as [number, number, number])
              : f.normal,
      })),
    };

    const toxicSnapshot: RenderSnapshot = {
      tick: Number.NaN,
      simTimeSec: Number.POSITIVE_INFINITY,
      platformOffset: [Number.NaN, Number.POSITIVE_INFINITY, -Number.MAX_VALUE],
      blocks: [
        makeBlock(1, 'wood', {
          position: [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY],
          quaternion: [0, 0, 0, 0],
          halfExtents: [-1.5, Number.NaN, Number.POSITIVE_INFINITY],
          stressUtilization: Number.NaN,
          damageRatio: Number.POSITIVE_INFINITY,
          temperatureC: Number.POSITIVE_INFINITY,
          charRatio: Number.NaN,
          burning: true,
        }),
        makeBlock(Number.POSITIVE_INFINITY, 'steel', {
          position: [Number.MAX_VALUE, -Number.MAX_VALUE, 2],
          quaternion: [Number.MAX_VALUE, -Number.MAX_VALUE, Number.NaN, 1],
          halfExtents: [Number.MAX_VALUE, 0, -5],
          stressUtilization: Number.MAX_VALUE,
          damageRatio: -10,
          temperatureC: Number.NaN,
          charRatio: 99,
          burning: true,
        }),
      ],
      shards: [
        {
          shardId: Number.NaN,
          materialId: 'reinforced_concrete',
          polyhedron: corruptedPoly,
          position: [Number.NaN, Number.POSITIVE_INFINITY, -Number.MAX_VALUE],
          quaternion: [0, 0, 0, 0],
          temperatureC: Number.POSITIVE_INFINITY,
          charRatio: Number.NaN,
          sleeping: false,
          rebarStubs: [
            {
              originLocal: [Number.NaN, Number.POSITIVE_INFINITY, -Number.MAX_VALUE],
              directionLocal: [0, 0, 0],
              lengthM: Number.POSITIVE_INFINITY,
              bendAngleRad: Number.NaN,
            },
            {
              originLocal: [0.1, 0.1, 0.1],
              directionLocal: [Number.NaN, Number.MAX_VALUE, Number.NEGATIVE_INFINITY],
              lengthM: -5,
              bendAngleRad: Number.POSITIVE_INFINITY,
            },
          ],
        },
      ],
      bondsAndRebars: [
        {
          id: 1,
          kind: 'bond',
          pointA: [Number.NaN, 0, Number.POSITIVE_INFINITY],
          pointB: [Number.MAX_VALUE, -Number.MAX_VALUE, Number.NEGATIVE_INFINITY],
          stressUtilization: Number.NaN,
          axialForceN: Number.POSITIVE_INFINITY,
          broken: false,
        },
        {
          id: 2,
          kind: 'rebar',
          pointA: [0, 1, 0],
          pointB: [Number.MAX_VALUE, 2, Number.NaN],
          stressUtilization: Number.POSITIVE_INFINITY,
          axialForceN: Number.NaN,
          broken: false,
        },
        {
          id: 3,
          kind: 'plastic_hinge',
          pointA: [Number.NaN, 2, 0],
          pointB: [0, Number.NEGATIVE_INFINITY, 0],
          stressUtilization: Number.NaN,
          axialForceN: -Number.MAX_VALUE,
          broken: false,
        },
      ],
      plantedCharges: [
        {
          chargeId: Number.POSITIVE_INFINITY,
          position: [Number.NaN, Number.POSITIVE_INFINITY, -Number.MAX_VALUE],
          normal: [0, 0, 0],
          delaySec: Number.NaN,
          armed: true,
          remainingCountdownSec: Number.POSITIVE_INFINITY,
        },
        {
          chargeId: Number.NaN,
          position: [1, 2, 1],
          normal: [Number.NaN, Number.POSITIVE_INFINITY, -Number.MAX_VALUE],
          delaySec: Number.MAX_VALUE,
          armed: true,
          remainingCountdownSec: Number.NaN,
        },
      ],
      projectiles: [
        {
          id: 1,
          position: [Number.NaN, Number.POSITIVE_INFINITY, -Number.MAX_VALUE],
          radiusM: Number.POSITIVE_INFINITY,
          velocity: [Number.POSITIVE_INFINITY, Number.NaN, -Number.MAX_VALUE],
          hot: true,
        },
        {
          id: 2,
          position: [2, 3, 4],
          radiusM: Number.NaN,
          velocity: [Number.MAX_VALUE, 0, 0],
          hot: false,
        },
      ],
    };

    const assertAllSceneGpuBuffersFinite = (modeLabel: string): void => {
      let checkedFloatCount = 0;
      renderer.getScene().traverse((obj) => {
        for (let k = 0; k < 16; k++) {
          if (!Number.isFinite(obj.matrix.elements[k])) {
            expect.fail(`Неконечный элемент matrix[${k}] у ${obj.name || obj.type} (${modeLabel})`);
          }
          if (!Number.isFinite(obj.matrixWorld.elements[k])) {
            expect.fail(
              `Неконечный элемент matrixWorld[${k}] у ${obj.name || obj.type} (${modeLabel})`,
            );
          }
          checkedFloatCount += 2;
        }

        if (obj instanceof THREE.Light && !Number.isFinite(obj.intensity)) {
          expect.fail(`Неконечный intensity у источника света ${obj.name} (${modeLabel})`);
        }

        if (obj instanceof THREE.InstancedMesh) {
          const matArr = obj.instanceMatrix.array;
          for (let i = 0; i < matArr.length; i++) {
            if (!Number.isFinite(matArr[i])) {
              expect.fail(
                `Неконечное число в instanceMatrix[${i}] меша ${obj.name} (${modeLabel})`,
              );
            }
          }
          checkedFloatCount += matArr.length;
          if (obj.instanceColor) {
            const colArr = obj.instanceColor.array;
            for (let i = 0; i < colArr.length; i++) {
              if (!Number.isFinite(colArr[i])) {
                expect.fail(
                  `Неконечное число в instanceColor[${i}] меша ${obj.name} (${modeLabel})`,
                );
              }
            }
            checkedFloatCount += colArr.length;
          }
        }

        if (obj instanceof THREE.Mesh || obj instanceof THREE.LineSegments) {
          for (const attrName of ['position', 'normal', 'color']) {
            const attr = obj.geometry.getAttribute(attrName);
            if (attr) {
              const arr = attr.array;
              for (let i = 0; i < arr.length; i++) {
                if (!Number.isFinite(arr[i])) {
                  expect.fail(
                    `Неконечное число в geometry.${attrName}[${i}] объекта ${obj.name} (${modeLabel})`,
                  );
                }
              }
              checkedFloatCount += arr.length;
            }
          }
        }

        if (obj instanceof THREE.BatchedMesh && obj.instanceCount > 0) {
          const m4 = new THREE.Matrix4();
          const c = new THREE.Color();
          obj.getMatrixAt(0, m4);
          obj.getColorAt(0, c);
          for (const el of m4.elements) {
            expect(Number.isFinite(el)).toBe(true);
          }
          expect(Number.isFinite(c.r) && Number.isFinite(c.g) && Number.isFinite(c.b)).toBe(true);
        }
      });
      expect(checkedFloatCount).toBeGreaterThan(100_000);
    };

    expect(() => {
      renderer.syncSnapshot(toxicSnapshot);
      renderer.setCriticalNodes([1, Number.NaN, Number.POSITIVE_INFINITY]);
      renderer.renderFrame(0.1);
    }).not.toThrow();

    assertAllSceneGpuBuffersFinite('pbr');

    for (const mode of ['stress', 'xray', 'pbr'] as const) {
      renderer.setViewMode(mode);
      renderer.renderFrame(0.1);
      assertAllSceneGpuBuffersFinite(mode);
    }

    renderer.dispose();
  });
});

