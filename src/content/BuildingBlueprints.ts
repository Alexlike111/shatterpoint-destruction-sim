import type { BlockInputSpec, StructuralMaterialId, Vec3 } from '../core/types';
import type { DestructionWorld } from '../physics/DestructionWorld';

/**
 * Каталог из 6 архитектурных сооружений для Свободной Песочницы («ТОЧКА РАЗЛОМА»):
 * 1) tower     — Высотная ЖБ-башня «Монолит-7» с атриумом, противовесом и резервуарами
 * 2) viaduct   — Инженерный двухпролётный виадук (мост) со стальными фермами
 * 3) fortress  — Кирпичная цитадель «Бастион» с башнями и пороховым погребом
 * 4) hangar    — Промышленный стальной ангар с кран-балкой и 18-тонной турбиной
 * 5) warehouse — Многоярусный деревянный склад (пакгауз) с бочками ГСМ
 * 6) domino    — Мега-каскад «Эффект Домино» из нарастающих стел и финальной башни
 */

export type SandboxBlueprintId =
  | 'tower'
  | 'viaduct'
  | 'fortress'
  | 'hangar'
  | 'warehouse'
  | 'domino';

export interface BlueprintCounterweightSpec {
  anchorBlockId?: string;
  anchorPoint: Vec3;
  center: Vec3;
  halfExtents: Vec3;
  massKg: number;
  tetherBreakForceN?: number;
}

export interface BuiltBlueprintData {
  id: SandboxBlueprintId;
  nameRu: string;
  blocks: BlockInputSpec[];
  counterweights: BlueprintCounterweightSpec[];
  focusCenter: Vec3;
  focusRadiusM: number;
}

export const SANDBOX_BLUEPRINT_CATALOG: ReadonlyArray<{
  id: SandboxBlueprintId;
  nameRu: string;
  subtitleRu: string;
}> = [
  {
    id: 'tower',
    nameRu: 'Высотная ЖБ-башня «Монолит»',
    subtitleRu: '6 этажей, арматура, стеклянный фасад и лифтовой противовес',
  },
  {
    id: 'viaduct',
    nameRu: 'Двухпролётный виадук (мост)',
    subtitleRu: 'Массивные быки, стальные пролёты и цистерны на полотне',
  },
  {
    id: 'fortress',
    nameRu: 'Кирпичная крепость «Бастион»',
    subtitleRu: 'Толстые стены, угловые башни и взрывоопасный арсенал',
  },
  {
    id: 'hangar',
    nameRu: 'Промышленный стальной ангар',
    subtitleRu: 'Стальной каркас, подвешенная турбина 16 т и газовый узел',
  },
  {
    id: 'warehouse',
    nameRu: 'Деревянный склад-пакгауз',
    subtitleRu: '4 яруса бруса и настилов с высокой пожарной нагрузкой',
  },
  {
    id: 'domino',
    nameRu: 'Каскад плит «Эффект Домино»',
    subtitleRu: 'Цепное падение стел с ударом по топливному терминалу',
  },
];

function shiftVec3(v: Vec3, offset: Vec3): Vec3 {
  return [v[0] + offset[0], v[1] + offset[1], v[2] + offset[2]];
}

/**
 * Строит каркасно-панельное здание заданной сетки осей и этажности.
 * Все стыки колонн и плит перекрытий точные (зазор 0 м), ненесущее остекление/кладка отделены
 * деформационным зазором сверху/сбоку, чтобы здание идеально стояло в покое (0% разрушений на старте).
 */
export function generateFramedBuildingSpecs(params: {
  prefix: string;
  gridX: readonly number[];
  gridZ: readonly number[];
  floors: number;
  storeyHeightM?: number;
  slabThicknessM?: number;
  columnMaterial: (floor: number) => StructuralMaterialId;
  slabMaterial: (floor: number) => StructuralMaterialId;
  glassMinFloor?: number;
  glassFloorsMax?: number;
  brickGroundWalls?: boolean;
  omitSlabAt?: { floor: number; bx: number; bz: number };
  groupTag?: string;
  offset?: Vec3;
}): BlockInputSpec[] {
  const {
    prefix,
    gridX,
    gridZ,
    floors,
    storeyHeightM = 2.9,
    slabThicknessM = 0.3,
    columnMaterial,
    slabMaterial,
    glassMinFloor = 0,
    glassFloorsMax = -1,
    brickGroundWalls = false,
    omitSlabAt,
    groupTag = 'target',
    offset = [0, 0, 0],
  } = params;

  const specs: BlockInputSpec[] = [];
  const H = storeyHeightM;
  const T = slabThicknessM;
  const clear = H - T;
  const nx = gridX.length;
  const nz = gridZ.length;
  const overhang = 0.28;

  for (let floor = 0; floor < floors; floor++) {
    const baseY = floor * H;
    const colMat = columnMaterial(floor);
    const ch = colMat === 'steel' ? 0.2 : colMat === 'wood' ? 0.22 : 0.32;

    for (let ix = 0; ix < nx; ix++) {
      for (let iz = 0; iz < nz; iz++) {
        specs.push({
          id: `${prefix}-col-${floor}-${ix}-${iz}`,
          materialId: colMat,
          center: shiftVec3([gridX[ix]!, baseY + clear * 0.5, gridZ[iz]!], offset),
          halfExtents: [ch, clear * 0.5, ch],
          grounded: floor === 0,
          structureGroupTag: groupTag,
        });
      }
    }

    const sMat = slabMaterial(floor);
    for (let bx = 0; bx < nx - 1; bx++) {
      for (let bz = 0; bz < nz - 1; bz++) {
        if (
          omitSlabAt &&
          omitSlabAt.floor === floor &&
          omitSlabAt.bx === bx &&
          omitSlabAt.bz === bz
        ) {
          continue;
        }
        const x0 = gridX[bx]! - (bx === 0 ? overhang : 0);
        const x1 = gridX[bx + 1]! + (bx === nx - 2 ? overhang : 0);
        const z0 = gridZ[bz]! - (bz === 0 ? overhang : 0);
        const z1 = gridZ[bz + 1]! + (bz === nz - 2 ? overhang : 0);
        specs.push({
          id: `${prefix}-slab-${floor}-${bx}-${bz}`,
          materialId: sMat,
          center: shiftVec3([(x0 + x1) * 0.5, baseY + clear + T * 0.5, (z0 + z1) * 0.5], offset),
          halfExtents: [(x1 - x0) * 0.5, T * 0.5, (z1 - z0) * 0.5],
          structureGroupTag: groupTag,
        });
      }
    }

    const gap = 0.06;
    const infillH = clear - gap;
    if (floor >= glassMinFloor && floor <= glassFloorsMax) {
      for (let bx = 0; bx < nx - 1; bx++) {
        const xa = gridX[bx]! + ch + gap;
        const xb = gridX[bx + 1]! - ch - gap;
        if (xb - xa <= 0.2) continue;
        specs.push({
          id: `${prefix}-glass-front-${floor}-${bx}`,
          materialId: 'glass',
          center: shiftVec3([(xa + xb) * 0.5, baseY + infillH * 0.5, gridZ[nz - 1]!], offset),
          halfExtents: [(xb - xa) * 0.5, infillH * 0.5, 0.05],
          grounded: floor === 0,
          structureGroupTag: groupTag,
        });
      }
    }

    if (brickGroundWalls && floor === 0) {
      for (let bx = 0; bx < nx - 1; bx++) {
        const xa = gridX[bx]! + ch + gap;
        const xb = gridX[bx + 1]! - ch - gap;
        if (xb - xa <= 0.2) continue;
        specs.push({
          id: `${prefix}-brick-back-${bx}`,
          materialId: 'brick',
          center: shiftVec3([(xa + xb) * 0.5, infillH * 0.5, gridZ[0]!], offset),
          halfExtents: [(xb - xa) * 0.5, infillH * 0.5, 0.14],
          grounded: true,
          structureGroupTag: groupTag,
        });
      }
    }
  }

  return specs;
}

export function buildSandboxBlueprintData(
  id: SandboxBlueprintId,
  offset: Vec3 = [0, 0, 0],
  prefix: string = id,
): BuiltBlueprintData {
  switch (id) {
    case 'tower': {
      const gridX = [-2.2, 0, 2.2];
      const gridZ = [-1.8, 1.8];
      const floors = 6;
      const H = 2.75;
      const T = 0.3;
      const blocks = generateFramedBuildingSpecs({
        prefix,
        gridX,
        gridZ,
        floors,
        storeyHeightM: H,
        slabThicknessM: T,
        columnMaterial: () => 'reinforced_concrete',
        slabMaterial: () => 'reinforced_concrete',
        glassMinFloor: 1,
        glassFloorsMax: 4,
        brickGroundWalls: false,
        offset,
      });

      // Газовые резервуары с тыльной стороны башни (вдали от боковых площадок конструктора)
      const tankCoords: Array<[number, number]> = [
        [-0.8, -3.3],
        [0.8, -3.3],
      ];
      for (let i = 0; i < tankCoords.length; i++) {
        blocks.push({
          id: `${prefix}-tank-${i}`,
          materialId: 'explosive',
          center: shiftVec3([tankCoords[i]![0], 0.65, tankCoords[i]![1]], offset),
          halfExtents: [0.45, 0.65, 0.45],
          grounded: true,
          structureGroupTag: 'target',
        });
      }

      const roofUnderY = (floors - 1) * H + (H - T);
      return {
        id,
        nameRu: 'Высотная ЖБ-башня «Монолит»',
        blocks,
        counterweights: [
          {
            anchorBlockId: `${prefix}-col-${floors - 1}-1-0`,
            anchorPoint: shiftVec3([0, roofUnderY - 0.3, -1.8], offset),
            center: shiftVec3([0, roofUnderY - 1.9, 0], offset),
            halfExtents: [0.48, 0.4, 0.48],
            massKg: 2_000,
          },
        ],
        focusCenter: shiftVec3([1.8, 7.0, 1.2], offset),
        focusRadiusM: 15.5,
      };
    }

    case 'viaduct': {
      const blocks: BlockInputSpec[] = [];
      const pierXs = [-7.2, -2.4, 2.4, 7.2];
      const pierZs = [-1.8, 1.8];
      const pierH = 4.2;

      // Массивные опоры-быки виадука и поперечные ригели
      for (let p = 0; p < pierXs.length; p++) {
        const px = pierXs[p]!;
        for (let iz = 0; iz < pierZs.length; iz++) {
          const pz = pierZs[iz]!;
          blocks.push({
            id: `${prefix}-pier-bot-${p}-${iz}`,
            materialId: 'reinforced_concrete',
            center: shiftVec3([px, pierH * 0.25, pz], offset),
            halfExtents: [0.48, pierH * 0.25, 0.48],
            grounded: true,
            structureGroupTag: 'target',
          });
          blocks.push({
            id: `${prefix}-pier-top-${p}-${iz}`,
            materialId: 'reinforced_concrete',
            center: shiftVec3([px, pierH * 0.75, pz], offset),
            halfExtents: [0.44, pierH * 0.25, 0.44],
            structureGroupTag: 'target',
          });
        }
        // Поперечный стальной ригель на опоре
        blocks.push({
          id: `${prefix}-cap-${p}`,
          materialId: 'steel',
          center: shiftVec3([px, pierH + 0.22, 0], offset),
          halfExtents: [0.5, 0.22, 2.4],
          structureGroupTag: 'target',
        });
      }

      // Пролётные стальные балки и железобетонные плиты дорожного полотна
      const deckBaseY = pierH + 0.44;
      for (let span = 0; span < pierXs.length - 1; span++) {
        const x0 = pierXs[span]!;
        const x1 = pierXs[span + 1]!;
        const midX = (x0 + x1) * 0.5;
        const halfSpan = (x1 - x0) * 0.5 + (span === 0 || span === pierXs.length - 2 ? 0.4 : 0);
        const centerSpanX =
          span === 0 ? midX - 0.2 : span === pierXs.length - 2 ? midX + 0.2 : midX;

        blocks.push({
          id: `${prefix}-deck-${span}`,
          materialId: 'reinforced_concrete',
          center: shiftVec3([centerSpanX, deckBaseY + 0.22, 0], offset),
          halfExtents: [halfSpan, 0.22, 2.45],
          structureGroupTag: 'target',
        });

        // Кирпичные парапеты и мачты освещения
        blocks.push({
          id: `${prefix}-parapet-f-${span}`,
          materialId: 'brick',
          center: shiftVec3([midX, deckBaseY + 0.44 + 0.28, 2.15], offset),
          halfExtents: [1.8, 0.28, 0.16],
          structureGroupTag: 'target',
        });
        blocks.push({
          id: `${prefix}-parapet-b-${span}`,
          materialId: 'brick',
          center: shiftVec3([midX, deckBaseY + 0.44 + 0.28, -2.15], offset),
          halfExtents: [1.8, 0.28, 0.16],
          structureGroupTag: 'target',
        });
      }

      // Топливные цистерны на центральном пролёте
      blocks.push({
        id: `${prefix}-fuel-0`,
        materialId: 'explosive',
        center: shiftVec3([-0.7, deckBaseY + 0.44 + 0.55, 0], offset),
        halfExtents: [0.55, 0.55, 0.55],
        structureGroupTag: 'target',
      });
      blocks.push({
        id: `${prefix}-fuel-1`,
        materialId: 'explosive',
        center: shiftVec3([0.7, deckBaseY + 0.44 + 0.55, 0], offset),
        halfExtents: [0.55, 0.55, 0.55],
        structureGroupTag: 'target',
      });

      return {
        id,
        nameRu: 'Двухпролётный виадук (мост)',
        blocks,
        counterweights: [
          {
            anchorBlockId: `${prefix}-deck-1`,
            anchorPoint: shiftVec3([0, deckBaseY, 0], offset),
            center: shiftVec3([0, deckBaseY - 1.9, 0], offset),
            halfExtents: [0.65, 0.45, 0.65],
            massKg: 12_000,
          },
        ],
        focusCenter: shiftVec3([0, 3.6, 0], offset),
        focusRadiusM: 15.5,
      };
    }

    case 'fortress': {
      const blocks: BlockInputSpec[] = [];
      // Четыре угловые кирпичные башни (3 яруса) и крепостные куртины между ними
      const corners: Array<[number, number]> = [
        [-4.5, -4.0],
        [4.5, -4.0],
        [-4.5, 4.0],
        [4.5, 4.0],
      ];
      for (let c = 0; c < corners.length; c++) {
        const [cx, cz] = corners[c]!;
        for (let tier = 0; tier < 3; tier++) {
          const y0 = tier * 2.2;
          blocks.push({
            id: `${prefix}-turret-${c}-${tier}`,
            materialId: 'brick',
            center: shiftVec3([cx, y0 + 1.1, cz], offset),
            halfExtents: [0.95, 1.1, 0.95],
            grounded: tier === 0,
            structureGroupTag: 'target',
          });
        }
        // Деревянный шатёр башни
        blocks.push({
          id: `${prefix}-turret-roof-${c}`,
          materialId: 'wood',
          center: shiftVec3([cx, 6.6 + 0.35, cz], offset),
          halfExtents: [1.05, 0.35, 1.05],
          structureGroupTag: 'target',
        });
      }

      // Крепостные стены (2 яруса) между угловыми башнями
      for (let tier = 0; tier < 2; tier++) {
        const y0 = tier * 2.2;
        for (const zSide of [-4.0, 4.0]) {
          for (const segX of [-1.75, 1.75]) {
            blocks.push({
              id: `${prefix}-wall-x-${tier}-${zSide}-${segX}`,
              materialId: 'brick',
              center: shiftVec3([segX, y0 + 1.1, zSide], offset),
              halfExtents: [1.75, 1.1, 0.48],
              grounded: tier === 0,
              structureGroupTag: 'target',
            });
          }
        }
        for (const xSide of [-4.5, 4.5]) {
          for (const segZ of [-1.5, 1.5]) {
            blocks.push({
              id: `${prefix}-wall-z-${tier}-${xSide}-${segZ}`,
              materialId: 'brick',
              center: shiftVec3([xSide, y0 + 1.1, segZ], offset),
              halfExtents: [0.48, 1.1, 1.5],
              grounded: tier === 0,
              structureGroupTag: 'target',
            });
          }
        }
      }

      // Центральный донжон и пороховой арсенал во дворе
      for (let tier = 0; tier < 3; tier++) {
        blocks.push({
          id: `${prefix}-keep-${tier}`,
          materialId: tier === 0 ? 'reinforced_concrete' : 'brick',
          center: shiftVec3([0, tier * 2.4 + 1.2, 0], offset),
          halfExtents: [1.4, 1.2, 1.4],
          grounded: tier === 0,
          structureGroupTag: 'target',
        });
      }
      blocks.push({
        id: `${prefix}-powder-0`,
        materialId: 'explosive',
        center: shiftVec3([-2.1, 0.6, 0], offset),
        halfExtents: [0.5, 0.6, 0.5],
        grounded: true,
        structureGroupTag: 'target',
      });
      blocks.push({
        id: `${prefix}-powder-1`,
        materialId: 'explosive',
        center: shiftVec3([2.1, 0.6, 0], offset),
        halfExtents: [0.5, 0.6, 0.5],
        grounded: true,
        structureGroupTag: 'target',
      });

      return {
        id,
        nameRu: 'Кирпичная крепость «Бастион»',
        blocks,
        counterweights: [],
        focusCenter: shiftVec3([0, 3.6, 0], offset),
        focusRadiusM: 14.5,
      };
    }

    case 'hangar': {
      const blocks: BlockInputSpec[] = [];
      const frameZs = [-4.2, -1.4, 1.4, 4.2];
      const colH = 6.2;
      const beamH = 0.45;

      for (let i = 0; i < frameZs.length; i++) {
        const fz = frameZs[i]!;
        for (const sx of [-5.2, 5.2]) {
          blocks.push({
            id: `${prefix}-scol-b-${i}-${sx}`,
            materialId: 'steel',
            center: shiftVec3([sx, colH * 0.25, fz], offset),
            halfExtents: [0.28, colH * 0.25, 0.28],
            grounded: true,
            structureGroupTag: 'target',
          });
          blocks.push({
            id: `${prefix}-scol-t-${i}-${sx}`,
            materialId: 'steel',
            center: shiftVec3([sx, colH * 0.75, fz], offset),
            halfExtents: [0.26, colH * 0.25, 0.26],
            structureGroupTag: 'target',
          });
        }
        // Главная стальная ферма перекрытия ангара
        blocks.push({
          id: `${prefix}-truss-l-${i}`,
          materialId: 'steel',
          center: shiftVec3([-2.75, colH + beamH * 0.5, fz], offset),
          halfExtents: [2.75, beamH * 0.5, 0.3],
          structureGroupTag: 'target',
        });
        blocks.push({
          id: `${prefix}-truss-r-${i}`,
          materialId: 'steel',
          center: shiftVec3([2.75, colH + beamH * 0.5, fz], offset),
          halfExtents: [2.75, beamH * 0.5, 0.3],
          structureGroupTag: 'target',
        });
      }

      // Кровельные прогоны и световые фонари
      const roofY = colH + beamH;
      for (let bz = 0; bz < frameZs.length - 1; bz++) {
        const midZ = (frameZs[bz]! + frameZs[bz + 1]!) * 0.5;
        const hz = (frameZs[bz + 1]! - frameZs[bz]!) * 0.5;
        blocks.push({
          id: `${prefix}-roof-l-${bz}`,
          materialId: 'steel',
          center: shiftVec3([-3.2, roofY + 0.14, midZ], offset),
          halfExtents: [2.2, 0.14, hz],
          structureGroupTag: 'target',
        });
        blocks.push({
          id: `${prefix}-roof-r-${bz}`,
          materialId: 'steel',
          center: shiftVec3([3.2, roofY + 0.14, midZ], offset),
          halfExtents: [2.2, 0.14, hz],
          structureGroupTag: 'target',
        });
        blocks.push({
          id: `${prefix}-skylight-${bz}`,
          materialId: 'glass',
          center: shiftVec3([0, roofY + 0.12, midZ], offset),
          halfExtents: [0.95, 0.1, hz - 0.04],
          structureGroupTag: 'target',
        });
      }

      // Центральная стальная консольная кран-балка с тяжёлым тельфером по оси [0, y, 0] (турбина висит свободно в пролёте z = -1.4)
      blocks.push({
        id: `${prefix}-crane-col-0`,
        materialId: 'steel',
        center: shiftVec3([0, 1.2, 0], offset),
        halfExtents: [0.18, 1.2, 0.18],
        grounded: true,
        structureGroupTag: 'target',
      });
      blocks.push({
        id: `${prefix}-crane-col-1`,
        materialId: 'steel',
        center: shiftVec3([0, 2.95, 0], offset),
        halfExtents: [0.17, 0.55, 0.17],
        structureGroupTag: 'target',
      });
      blocks.push({
        id: `${prefix}-crane-arm`,
        materialId: 'steel',
        center: shiftVec3([0.92, 3.64, 0], offset),
        halfExtents: [1.1, 0.14, 0.17],
        structureGroupTag: 'target',
      });
      blocks.push({
        id: `${prefix}-crane-hoist`,
        materialId: 'steel',
        center: shiftVec3([1.75, 4.02, 0], offset),
        halfExtents: [0.42, 0.24, 0.42],
        structureGroupTag: 'target',
      });

      for (const tx of [-3.8, 3.8]) {
        blocks.push({
          id: `${prefix}-htank-${tx}`,
          materialId: 'explosive',
          center: shiftVec3([tx, 0.7, -3.8], offset),
          halfExtents: [0.52, 0.7, 0.52],
          grounded: true,
          structureGroupTag: 'target',
        });
      }

      return {
        id,
        nameRu: 'Промышленный стальной ангар',
        blocks,
        counterweights: [
          {
            anchorBlockId: `${prefix}-truss-l-1`,
            anchorPoint: shiftVec3([0, colH, -1.4], offset),
            center: shiftVec3([0, colH - 1.85, -1.4], offset),
            halfExtents: [0.72, 0.52, 0.72],
            massKg: 9_500,
          },
        ],
        focusCenter: shiftVec3([0, 3.8, 0], offset),
        focusRadiusM: 15.0,
      };
    }

    case 'warehouse': {
      const gridX = [-4.2, -1.4, 1.4, 4.2];
      const gridZ = [-2.8, 0, 2.8];
      const blocks = generateFramedBuildingSpecs({
        prefix,
        gridX,
        gridZ,
        floors: 4,
        storeyHeightM: 2.6,
        slabThicknessM: 0.26,
        columnMaterial: (f) => (f === 0 ? 'brick' : 'wood'),
        slabMaterial: () => 'wood',
        glassFloorsMax: 1,
        brickGroundWalls: true,
        offset,
      });

      // Деревянные паллеты и бочки с ГСМ внутри первого яруса для быстрого распространения огня
      for (const px of [-2.8, 0, 2.8]) {
        blocks.push({
          id: `${prefix}-crate-${px}`,
          materialId: 'wood',
          center: shiftVec3([px, 0.55, 1.3], offset),
          halfExtents: [0.65, 0.55, 0.65],
          grounded: true,
          structureGroupTag: 'target',
        });
      }
      blocks.push({
        id: `${prefix}-barrel-l`,
        materialId: 'explosive',
        center: shiftVec3([-5.4, 0.6, 1.2], offset),
        halfExtents: [0.46, 0.6, 0.46],
        grounded: true,
        structureGroupTag: 'target',
      });
      blocks.push({
        id: `${prefix}-barrel-r`,
        materialId: 'explosive',
        center: shiftVec3([5.4, 0.6, 1.2], offset),
        halfExtents: [0.46, 0.6, 0.46],
        grounded: true,
        structureGroupTag: 'target',
      });

      return {
        id,
        nameRu: 'Деревянный склад-пакгауз',
        blocks,
        counterweights: [],
        focusCenter: shiftVec3([0, 4.8, 0], offset),
        focusRadiusM: 14.0,
      };
    }

    case 'domino': {
      const blocks: BlockInputSpec[] = [];
      // Каскад из 9 высоких плит вдоль оси X (от x = -6.4 до x = +6.4), заваливающихся друг на друга
      const count = 9;
      for (let i = 0; i < count; i++) {
        const x = -6.4 + i * 1.6;
        const h = 3.2 + i * 0.28;
        // Двухсекционная стела (основание + верхняя плита), чтобы при ударе рвались швы и накапливались очки/вторичный урон
        const lowerH = h * 0.45;
        const upperH = h * 0.55;
        blocks.push({
          id: `${prefix}-dom-base-${i}`,
          materialId: i % 2 === 0 ? 'brick' : 'reinforced_concrete',
          center: shiftVec3([x, lowerH * 0.5, 0], offset),
          halfExtents: [0.22, lowerH * 0.5, 1.35],
          grounded: true,
          structureGroupTag: 'target',
        });
        blocks.push({
          id: `${prefix}-dom-top-${i}`,
          materialId: i % 2 === 0 ? 'brick' : 'reinforced_concrete',
          center: shiftVec3([x, lowerH + upperH * 0.5, 0], offset),
          halfExtents: [0.22, upperH * 0.5, 1.35],
          structureGroupTag: 'target',
        });
      }

      // Финальный топливный терминал на правом конце каскада
      blocks.push({
        id: `${prefix}-dom-tank-0`,
        materialId: 'explosive',
        center: shiftVec3([8.2, 0.68, -0.7], offset),
        halfExtents: [0.5, 0.68, 0.5],
        grounded: true,
        structureGroupTag: 'target',
      });
      blocks.push({
        id: `${prefix}-dom-tank-1`,
        materialId: 'explosive',
        center: shiftVec3([8.2, 0.68, 0.7], offset),
        halfExtents: [0.5, 0.68, 0.5],
        grounded: true,
        structureGroupTag: 'target',
      });

      return {
        id,
        nameRu: 'Каскад плит «Эффект Домино»',
        blocks,
        counterweights: [],
        focusCenter: shiftVec3([0.5, 2.8, 0], offset),
        focusRadiusM: 15.0,
      };
    }
  }
}

/**
 * Возводит выбранный чертёж в физическом мире DestructionWorld (с очисткой или добавлением рядом).
 */
export function spawnBlueprintInWorld(
  world: DestructionWorld,
  blueprintId: SandboxBlueprintId,
  options: { clearFirst?: boolean; offset?: Vec3; instanceIndex?: number } = {},
): BuiltBlueprintData {
  const { clearFirst = true, offset = [0, 0, 0], instanceIndex = 0 } = options;
  if (clearFirst) {
    world.clearScene();
  }

  const data = buildSandboxBlueprintData(
    blueprintId,
    offset,
    `${blueprintId}-${instanceIndex}`,
  );
  const nodeIds = world.spawnStructure(data.blocks);

  for (const cw of data.counterweights) {
    let anchorNodeId: number | undefined;
    if (cw.anchorBlockId) {
      const idx = data.blocks.findIndex((b) => b.id === cw.anchorBlockId);
      if (idx >= 0) {
        anchorNodeId = nodeIds[idx];
      }
    }
    world.spawnSuspendedCounterweight({
      anchorNodeId,
      anchorPoint: cw.anchorPoint,
      center: cw.center,
      halfExtents: cw.halfExtents,
      massKg: cw.massKg,
      tetherBreakForceN: cw.tetherBreakForceN,
    });
  }

  return data;
}
