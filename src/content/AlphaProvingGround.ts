import type { BlockInputSpec, StructuralMaterialId } from '../core/types';
import type { DestructionWorld } from '../physics/DestructionWorld';

/**
 * Испытательный полигон v0.1 Alpha (веха M3A).
 * Пятиэтажное каркасно-монолитное здание из разных материалов, подвешенный противовес
 * в двухсветном атриуме, группа газовых резервуаров у основания и ряд плит «домино».
 * Все блоки стыкуются гранями вплотную, чтобы StructuralGraph построил честные пятна контакта.
 */

export const ALPHA_STOREY_HEIGHT_M = 3.0;
export const ALPHA_SLAB_THICKNESS_M = 0.3;
export const ALPHA_FLOORS = 5;

/** Сетка осей колонн каркаса (м). */
export const ALPHA_GRID_X: readonly number[] = [-6, -2, 2, 6];
export const ALPHA_GRID_Z: readonly number[] = [-4, 0, 4];

/** Ячейка атриума (индексы пролёта по X и Z) без перекрытия 4-го яруса (этаж с индексом 3). */
const ATRIUM_BAY: readonly [number, number] = [1, 0];
const ATRIUM_OMITTED_SLAB_FLOOR = 3;

export interface AlphaProvingGroundInfo {
  /** Все узлы основного здания-мишени. */
  buildingNodeIds: number[];
  /** Узлы газовых резервуаров (материал explosive). */
  explosiveNodeIds: number[];
  /** Узлы плит домино. */
  dominoNodeIds: number[];
  /** Идентификатор триггера подвешенного противовеса. */
  counterweightTriggerId: number;
  /** Центр и радиус полигона для наведения камеры. */
  focusCenter: [number, number, number];
  focusRadiusM: number;
  totalBlocks: number;
}

function columnMaterialForFloor(floor: number): StructuralMaterialId {
  if (floor <= 2) return 'reinforced_concrete';
  if (floor === 3) return 'steel';
  return 'wood';
}

function columnHalfForMaterial(mat: StructuralMaterialId): number {
  if (mat === 'steel') return 0.18;
  if (mat === 'wood') return 0.2;
  return 0.32;
}

function slabMaterialForFloor(floor: number): StructuralMaterialId {
  return floor >= ALPHA_FLOORS - 1 ? 'wood' : 'reinforced_concrete';
}

/**
 * Формирует спецификации блоков пятиэтажного здания (без триггеров).
 * Экспортируется отдельно, чтобы интеграционный тест мог проверить геометрию стыков.
 */
export function buildAlphaBuildingSpecs(): BlockInputSpec[] {
  const specs: BlockInputSpec[] = [];
  const H = ALPHA_STOREY_HEIGHT_M;
  const T = ALPHA_SLAB_THICKNESS_M;
  const clear = H - T;
  const nx = ALPHA_GRID_X.length;
  const nz = ALPHA_GRID_Z.length;
  const edgeOverhang = 0.32;

  for (let floor = 0; floor < ALPHA_FLOORS; floor++) {
    const baseY = floor * H;
    const colMat = columnMaterialForFloor(floor);
    const ch = columnHalfForMaterial(colMat);

    // Колонны яруса
    for (let ix = 0; ix < nx; ix++) {
      for (let iz = 0; iz < nz; iz++) {
        specs.push({
          id: `col-f${floor}-${ix}-${iz}`,
          materialId: colMat,
          center: [ALPHA_GRID_X[ix]!, baseY + clear / 2, ALPHA_GRID_Z[iz]!],
          halfExtents: [ch, clear / 2, ch],
          grounded: floor === 0,
          structureGroupTag: 'target',
        });
      }
    }

    // Панели перекрытия по пролётам (стыкуются по осям колонн)
    const slabMat = slabMaterialForFloor(floor);
    for (let bx = 0; bx < nx - 1; bx++) {
      for (let bz = 0; bz < nz - 1; bz++) {
        if (floor === ATRIUM_OMITTED_SLAB_FLOOR && bx === ATRIUM_BAY[0] && bz === ATRIUM_BAY[1]) {
          continue; // двухсветный атриум под противовесом
        }
        const x0 = ALPHA_GRID_X[bx]! - (bx === 0 ? edgeOverhang : 0);
        const x1 = ALPHA_GRID_X[bx + 1]! + (bx === nx - 2 ? edgeOverhang : 0);
        const z0 = ALPHA_GRID_Z[bz]! - (bz === 0 ? edgeOverhang : 0);
        const z1 = ALPHA_GRID_Z[bz + 1]! + (bz === nz - 2 ? edgeOverhang : 0);
        specs.push({
          id: `slab-f${floor}-${bx}-${bz}`,
          materialId: slabMat,
          center: [(x0 + x1) / 2, baseY + clear + T / 2, (z0 + z1) / 2],
          halfExtents: [(x1 - x0) / 2, T / 2, (z1 - z0) / 2],
          structureGroupTag: 'target',
        });
      }
    }

    // Ограждающие конструкции: кирпич (тыл и левый торец, цокольный ярус) и стекло (фасад, ярусы 0–2).
    // Ненесущее заполнение: деформационный зазор сверху и по бокам (больше шва сварки графа),
    // опирается только на нижнюю плиту/фундамент и не воспринимает нагрузку каркаса.
    if (floor <= 2) {
      const gap = 0.06;
      const infillH = clear - gap;
      for (let bx = 0; bx < nx - 1; bx++) {
        const xa = ALPHA_GRID_X[bx]! + ch + gap;
        const xb = ALPHA_GRID_X[bx + 1]! - ch - gap;
        const cx = (xa + xb) / 2;
        const hx = (xb - xa) / 2;
        specs.push({
          id: `glass-f${floor}-${bx}`,
          materialId: 'glass',
          center: [cx, baseY + infillH / 2, ALPHA_GRID_Z[nz - 1]!],
          halfExtents: [hx, infillH / 2, 0.05],
          grounded: floor === 0,
          structureGroupTag: 'target',
        });
        if (floor === 0) {
          specs.push({
            id: `brick-f${floor}-${bx}`,
            materialId: 'brick',
            center: [cx, baseY + infillH / 2, ALPHA_GRID_Z[0]!],
            halfExtents: [hx, infillH / 2, 0.12],
            grounded: true,
            structureGroupTag: 'target',
          });
        }
      }
      if (floor === 0) {
        for (let bz = 0; bz < nz - 1; bz++) {
          const za = ALPHA_GRID_Z[bz]! + ch + gap;
          const zb = ALPHA_GRID_Z[bz + 1]! - ch - gap;
          specs.push({
            id: `brick-side-${bz}`,
            materialId: 'brick',
            center: [ALPHA_GRID_X[0]!, infillH / 2, (za + zb) / 2],
            halfExtents: [0.12, infillH / 2, (zb - za) / 2],
            grounded: true,
            structureGroupTag: 'target',
          });
        }
      }
    }
  }

  return specs;
}

/** Газовые резервуары у основания здания (цепная детонация). */
export function buildAlphaGasTankSpecs(): BlockInputSpec[] {
  const specs: BlockInputSpec[] = [];
  const positions: Array<[number, number]> = [
    [8.6, 1.6],
    [8.6, 3.2],
    [10.0, 2.4],
  ];
  for (let i = 0; i < positions.length; i++) {
    const [x, z] = positions[i]!;
    specs.push({
      id: `gas-tank-${i}`,
      materialId: 'explosive',
      center: [x, 0.65, z],
      halfExtents: [0.45, 0.65, 0.45],
      grounded: true,
      structureGroupTag: 'trigger',
    });
  }
  return specs;
}

/** Ряд кирпичных плит-«домино» слева от здания. */
export function buildAlphaDominoSpecs(): BlockInputSpec[] {
  const specs: BlockInputSpec[] = [];
  const count = 7;
  for (let i = 0; i < count; i++) {
    specs.push({
      id: `domino-${i}`,
      materialId: 'brick',
      center: [-9.5, 1.7, 7.5 - i * 1.6],
      halfExtents: [0.9, 1.7, 0.16],
      grounded: true,
      structureGroupTag: 'domino',
    });
  }
  return specs;
}

/**
 * Полностью очищает мир и возводит полигон v0.1 Alpha.
 */
export function buildAlphaProvingGround(world: DestructionWorld): AlphaProvingGroundInfo {
  world.clearScene();

  const buildingSpecs = buildAlphaBuildingSpecs();
  const buildingNodeIds = world.spawnStructure(buildingSpecs);
  const explosiveNodeIds = world.spawnStructure(buildAlphaGasTankSpecs());
  const dominoNodeIds = world.spawnStructure(buildAlphaDominoSpecs());

  // Противовес подвешен к панели кровли над атриумом
  const H = ALPHA_STOREY_HEIGHT_M;
  const T = ALPHA_SLAB_THICKNESS_M;
  const roofFloor = ALPHA_FLOORS - 1;
  const ax = (ALPHA_GRID_X[ATRIUM_BAY[0]]! + ALPHA_GRID_X[ATRIUM_BAY[0] + 1]!) / 2;
  const az = (ALPHA_GRID_Z[ATRIUM_BAY[1]]! + ALPHA_GRID_Z[ATRIUM_BAY[1] + 1]!) / 2;
  const roofUndersideY = roofFloor * H + (H - T);
  const roofSlabId = `slab-f${roofFloor}-${ATRIUM_BAY[0]}-${ATRIUM_BAY[1]}`;
  const roofIdx = buildingSpecs.findIndex((s) => s.id === roofSlabId);
  const anchorNodeId = roofIdx >= 0 ? buildingNodeIds[roofIdx] : undefined;

  const counterweightTriggerId = world.spawnSuspendedCounterweight({
    anchorNodeId,
    anchorPoint: [ax, roofUndersideY, az],
    center: [ax, roofUndersideY - 2.1, az],
    halfExtents: [0.7, 0.55, 0.7],
    massKg: 14_000,
  });

  const totalBlocks =
    buildingNodeIds.length + explosiveNodeIds.length + dominoNodeIds.length;

  return {
    buildingNodeIds,
    explosiveNodeIds,
    dominoNodeIds,
    counterweightTriggerId,
    focusCenter: [0, 6.5, 0],
    focusRadiusM: 17,
    totalBlocks,
  };
}
