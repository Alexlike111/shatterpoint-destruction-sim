import type { BlockInputSpec, LabBenchId, StructuralMaterialId, Vec3 } from '../core/types';
import type { DestructionWorld } from '../physics/DestructionWorld';
import { generateFramedBuildingSpecs } from './BuildingBlueprints';

/**
 * 4 калиброванных испытательных стенда Физической Лаборатории-полигона («ТОЧКА РАЗЛОМА», F21):
 * 1) materials  — Стенд материаловедения и термодинамики (все 5 конструкционных материалов + взрывчатка)
 * 2) ballistics — Баллистический коридор пробития и испытания гравитации / прочности швов
 * 3) blast      — Полигон ударных волн Садовского, экранирования и цепной детонации
 * 4) seismic    — Сейсмоплатформа частотного резонанса (3 макета разной этажности и жёсткости)
 */

export interface LabBenchSpec {
  id: LabBenchId;
  nameRu: string;
  descriptionRu: string;
  focusCenter: Vec3;
  focusRadiusM: number;
  buildBlocks: () => BlockInputSpec[];
}

export const LAB_BENCHES: Readonly<Record<LabBenchId, LabBenchSpec>> = {
  materials: {
    id: 'materials',
    nameRu: 'Материаловедение и Термика',
    descriptionRu:
      'Сравнительный стенд образцов ЖБ, кирпича, стали, дерева и калёного стекла под нагрузкой и термическим нагревом по Еврокоду.',
    focusCenter: [0, 2.8, 0],
    focusRadiusM: 13.5,
    buildBlocks: () => {
      const blocks: BlockInputSpec[] = [];
      // Центральная связанная деревянно-комбинированная этажерка для наглядного распространения огня (fireRate)
      for (let tier = 0; tier < 3; tier++) {
        const y0 = tier * 1.8;
        for (const x of [-1.2, 1.2]) {
          blocks.push({
            id: `mat-wood-col-${tier}-${x}`,
            materialId: 'wood',
            center: [x, y0 + 0.75, 0],
            halfExtents: [0.24, 0.75, 0.24],
            grounded: tier === 0,
            structureGroupTag: 'target',
          });
        }
        blocks.push({
          id: `mat-wood-beam-${tier}`,
          materialId: 'wood',
          center: [0, y0 + 1.65, 0],
          halfExtents: [1.65, 0.15, 0.55],
          structureGroupTag: 'target',
        });
      }

      // Боковые калиброванные порталы из остальных материалов (ЖБ, сталь, кирпич, стекло)
      const samples: Array<{ x: number; z: number; mat: StructuralMaterialId }> = [
        { x: -4.2, z: 0, mat: 'reinforced_concrete' },
        { x: 4.2, z: 0, mat: 'steel' },
        { x: -2.6, z: 2.2, mat: 'brick' },
        { x: 2.6, z: 2.2, mat: 'glass' },
      ];
      for (const s of samples) {
        blocks.push({
          id: `mat-sample-l-${s.mat}`,
          materialId: s.mat,
          center: [s.x - 0.65, 1.1, s.z],
          halfExtents: [0.24, 1.1, 0.28],
          grounded: true,
          structureGroupTag: 'target',
        });
        blocks.push({
          id: `mat-sample-r-${s.mat}`,
          materialId: s.mat,
          center: [s.x + 0.65, 1.1, s.z],
          halfExtents: [0.24, 1.1, 0.28],
          grounded: true,
          structureGroupTag: 'target',
        });
        blocks.push({
          id: `mat-sample-cap-${s.mat}`,
          materialId: s.mat === 'glass' ? 'steel' : s.mat,
          center: [s.x, 2.38, s.z],
          halfExtents: [0.98, 0.18, 0.34],
          structureGroupTag: 'target',
        });
      }

      blocks.push({
        id: 'mat-explosive-tank',
        materialId: 'explosive',
        center: [0, 0.58, -2.6],
        halfExtents: [0.46, 0.58, 0.46],
        grounded: true,
        structureGroupTag: 'target',
      });

      return blocks;
    },
  },

  ballistics: {
    id: 'ballistics',
    nameRu: 'Баллистика и Прочность связей',
    descriptionRu:
      'Эшелонированный коридор преград и нагруженная многоярусная рама для калибровки гравитации, прочности швов и вторичного урона.',
    focusCenter: [0, 4.2, 0],
    focusRadiusM: 14.0,
    buildBlocks: () => {
      // Центральная нагруженная 4-этажная рама (чувствительная к ползункам гравитации, прочности связей и вторичного урона)
      const blocks = generateFramedBuildingSpecs({
        prefix: 'lab-bal',
        gridX: [-2.4, 0, 2.4],
        gridZ: [-1.8, 1.8],
        floors: 4,
        storeyHeightM: 2.4,
        slabThicknessM: 0.28,
        columnMaterial: (f) => (f <= 2 ? 'reinforced_concrete' : 'steel'),
        slabMaterial: () => 'reinforced_concrete',
        glassFloorsMax: 2,
        brickGroundWalls: true,
      });

      // Эшелон преград перед рамой (стекло -> дерево -> кирпич)
      const shields: Array<{ z: number; mat: StructuralMaterialId; hz: number }> = [
        { z: 4.2, mat: 'glass', hz: 0.08 },
        { z: 3.3, mat: 'wood', hz: 0.16 },
      ];
      for (const sh of shields) {
        blocks.push({
          id: `bal-shield-${sh.mat}`,
          materialId: sh.mat,
          center: [0, 1.3, sh.z],
          halfExtents: [1.6, 1.3, sh.hz],
          grounded: true,
          structureGroupTag: 'target',
        });
      }
      return blocks;
    },
  },

  blast: {
    id: 'blast',
    nameRu: 'Ударные волны и Детонация',
    descriptionRu:
      'Полигон закона Садовского: открытый сектор цепной детонации слева и экранированный капитальной ЖБ-стеной сектор справа.',
    focusCenter: [0, 3.0, 0],
    focusRadiusM: 15.0,
    buildBlocks: () => {
      const blocks: BlockInputSpec[] = [];

      // Левый и правый испытательные павильоны
      blocks.push(
        ...generateFramedBuildingSpecs({
          prefix: 'blast-left',
          gridX: [-5.5, -4.0, -2.5],
          gridZ: [-1.6, 1.6],
          floors: 3,
          storeyHeightM: 2.3,
          slabThicknessM: 0.25,
          columnMaterial: (f) => (f === 0 ? 'reinforced_concrete' : 'wood'),
          slabMaterial: () => 'wood',
          glassFloorsMax: 2,
          brickGroundWalls: true,
        }),
      );
      blocks.push(
        ...generateFramedBuildingSpecs({
          prefix: 'blast-right',
          gridX: [2.5, 4.0, 5.5],
          gridZ: [-1.6, 1.6],
          floors: 3,
          storeyHeightM: 2.3,
          slabThicknessM: 0.25,
          columnMaterial: (f) => (f === 0 ? 'reinforced_concrete' : 'wood'),
          slabMaterial: () => 'wood',
          glassFloorsMax: 2,
          brickGroundWalls: true,
        }),
      );

      // Капитальный железобетонный бронеэкран между секторами (демонстрация raycast-окклюзии волны)
      blocks.push({
        id: 'blast-bunker-wall',
        materialId: 'reinforced_concrete',
        center: [0.8, 2.2, 0],
        halfExtents: [0.42, 2.2, 2.8],
        grounded: true,
        structureGroupTag: 'target',
      });

      // Цепочка взрывоопасных резервуаров в открытом секторе и у центра
      const tanks: Array<[number, number]> = [
        [-4.0, 0],
        [-1.6, 0],
        [-0.5, 1.2],
        [4.0, 0],
      ];
      for (let i = 0; i < tanks.length; i++) {
        blocks.push({
          id: `blast-tank-${i}`,
          materialId: 'explosive',
          center: [tanks[i]![0], 0.6, tanks[i]![1]],
          halfExtents: [0.48, 0.6, 0.48],
          grounded: true,
          structureGroupTag: 'target',
        });
      }

      return blocks;
    },
  },

  seismic: {
    id: 'seismic',
    nameRu: 'Сейсмоплатформа и Резонанс',
    descriptionRu:
      'Три макета разной этажности (2, 4 и 6 ярусов) на единой 3D-виброплатформе для демонстрации избирательного частотного резонанса.',
    focusCenter: [0, 5.5, 0],
    focusRadiusM: 16.0,
    buildBlocks: () => {
      const blocks: BlockInputSpec[] = [];
      // Низкая жёсткая башня слева (2 этажа)
      blocks.push(
        ...generateFramedBuildingSpecs({
          prefix: 'seis-low',
          gridX: [-6.4, -4.4],
          gridZ: [-1.2, 1.2],
          floors: 2,
          storeyHeightM: 2.3,
          slabThicknessM: 0.26,
          columnMaterial: () => 'reinforced_concrete',
          slabMaterial: () => 'reinforced_concrete',
        }),
      );
      // Высокая гибкая башня в центре (высота ~13 м, собственная частота ~2.2 Гц — входит в резонанс!)
      blocks.push(
        ...generateFramedBuildingSpecs({
          prefix: 'seis-tall',
          gridX: [-1.6, 1.6],
          gridZ: [-1.5, 1.5],
          floors: 5,
          storeyHeightM: 2.5,
          slabThicknessM: 0.28,
          columnMaterial: (f) => (f <= 1 ? 'reinforced_concrete' : 'wood'),
          slabMaterial: (f) => (f === 4 ? 'reinforced_concrete' : 'wood'),
        }),
      );
      // Средняя башня справа (4 этажа)
      blocks.push(
        ...generateFramedBuildingSpecs({
          prefix: 'seis-mid',
          gridX: [4.4, 6.4],
          gridZ: [-1.2, 1.2],
          floors: 4,
          storeyHeightM: 2.3,
          slabThicknessM: 0.26,
          columnMaterial: (f) => (f <= 1 ? 'reinforced_concrete' : 'wood'),
          slabMaterial: (f) => (f <= 1 ? 'reinforced_concrete' : 'wood'),
        }),
      );
      // Стройная кирпичная колокольня-резонатор (высота 13.0 м, резонансный пик 2.2 Гц)
      for (let tier = 0; tier < 5; tier++) {
        blocks.push({
          id: `seis-spire-${tier}`,
          materialId: 'brick',
          center: [0, tier * 2.4 + 1.2, 3.6],
          halfExtents: [0.28, 1.2, 0.28],
          grounded: tier === 0,
          structureGroupTag: 'target',
        });
      }
      blocks.push({
        id: 'seis-spire-cap',
        materialId: 'reinforced_concrete',
        center: [0, 12.0 + 0.5, 3.6],
        halfExtents: [0.62, 0.5, 0.62],
        structureGroupTag: 'target',
      });
      return blocks;
    },
  },
};

export function spawnLabBenchInWorld(
  world: DestructionWorld,
  benchId: LabBenchId,
): LabBenchSpec {
  const spec = LAB_BENCHES[benchId];
  world.clearScene();
  world.spawnStructure(spec.buildBlocks());
  return spec;
}
