import type { BlockInputSpec, ToolId, Vec3 } from '../core/types';
import type { DestructionWorld } from '../physics/DestructionWorld';
import {
  buildSandboxBlueprintData,
  generateFramedBuildingSpecs,
  type BlueprintCounterweightSpec,
} from './BuildingBlueprints';

/**
 * Кампания из 8 инженерно-тактических контрактов сноса («ТОЧКА РАЗЛОМА», F19).
 * Включает целевые сооружения ('target'), охраняемые соседние здания ('protected'),
 * сметный бюджет, боекомплект спецсредств, пороги 1–3 звёзд и денежные вознаграждения.
 */

export interface CampaignContractSpec {
  id: string;
  index1Based: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
  selectorId: string;
  titleRu: string;
  briefingRu: string;
  budgetLimit: number;
  toolCosts: Partial<Record<ToolId, number>>;
  initialAmmo: Partial<Record<ToolId, number>>;
  targetDestructionPct: number;
  starThresholdsPct: readonly [number, number, number];
  maxCollateralPct: number;
  rewardCredits: number;
  hasProtectedBuildings: boolean;
  buildScene: () => {
    blocks: BlockInputSpec[];
    counterweights: BlueprintCounterweightSpec[];
    focusCenter: Vec3;
    focusRadiusM: number;
  };
}

/**
 * Создаёт аккуратное охраняемое соседнее здание ('protected') в заданных координатах.
 */
function createProtectedNeighborBuilding(prefix: string, centerX: number, centerZ: number): BlockInputSpec[] {
  return generateFramedBuildingSpecs({
    prefix,
    gridX: [-1.8, 0, 1.8],
    gridZ: [-1.6, 1.6],
    floors: 2,
    storeyHeightM: 2.4,
    slabThicknessM: 0.26,
    columnMaterial: () => 'reinforced_concrete',
    slabMaterial: () => 'reinforced_concrete',
    glassFloorsMax: 0,
    brickGroundWalls: true,
    groupTag: 'protected',
    offset: [centerX, 0, centerZ],
  });
}

export const CAMPAIGN_CONTRACTS: readonly CampaignContractSpec[] = [
  {
    id: 'contract-01',
    index1Based: 1,
    selectorId: 'contract-01',
    titleRu: '01 · Аварийная водонапорная башня',
    briefingRu:
      'Подрежьте нижние опоры старой водонапорной башни зарядами C4 или снарядами пушки. Рядом нет охраняемых зданий.',
    budgetLimit: 1200,
    toolCosts: { c4: 120, cannon: 100, bomb: 240 },
    initialAmmo: { c4: 6, cannon: 6, bomb: 2 },
    targetDestructionPct: 22,
    starThresholdsPct: [22, 42, 65],
    maxCollateralPct: 100,
    rewardCredits: 450,
    hasProtectedBuildings: false,
    buildScene: () => {
      const blocks = generateFramedBuildingSpecs({
        prefix: 'c01',
        gridX: [-2.4, 0, 2.4],
        gridZ: [-2.0, 2.0],
        floors: 4,
        storeyHeightM: 2.7,
        slabThicknessM: 0.28,
        columnMaterial: (f) => (f <= 2 ? 'reinforced_concrete' : 'wood'),
        slabMaterial: (f) => (f < 3 ? 'reinforced_concrete' : 'wood'),
        glassFloorsMax: 1,
        brickGroundWalls: true,
      });
      blocks.push({
        id: 'c01-tank-0',
        materialId: 'explosive',
        center: [3.4, 0.6, 0],
        halfExtents: [0.5, 0.6, 0.5],
        grounded: true,
        structureGroupTag: 'target',
      });
      return {
        blocks,
        counterweights: [],
        focusCenter: [0, 5.0, 0],
        focusRadiusM: 13.5,
      };
    },
  },
  {
    id: 'contract-02',
    index1Based: 2,
    selectorId: 'contract-02',
    titleRu: '02 · Демонтаж зернового элеватора',
    briefingRu:
      'Обрушьте корпус элеватора с подвесным бункером. Осторожно: справа расположена действующая трансформаторная подстанция!',
    budgetLimit: 1500,
    toolCosts: { c4: 130, cannon: 110, cutter: 90, bomb: 260 },
    initialAmmo: { c4: 6, cannon: 5, cutter: 4, bomb: 2 },
    targetDestructionPct: 24,
    starThresholdsPct: [24, 45, 68],
    maxCollateralPct: 14,
    rewardCredits: 600,
    hasProtectedBuildings: true,
    buildScene: () => {
      const blocks = generateFramedBuildingSpecs({
        prefix: 'c02-target',
        gridX: [-3.0, 0, 3.0],
        gridZ: [-2.4, 0, 2.4],
        floors: 5,
        storeyHeightM: 2.8,
        slabThicknessM: 0.3,
        columnMaterial: (f) => (f <= 3 ? 'reinforced_concrete' : 'steel'),
        slabMaterial: (f) => (f < 4 ? 'reinforced_concrete' : 'wood'),
        omitSlabAt: { floor: 3, bx: 0, bz: 0 },
      });
      blocks.push({
        id: 'c02-gas',
        materialId: 'explosive',
        center: [-3.9, 0.6, 0],
        halfExtents: [0.48, 0.6, 0.48],
        grounded: true,
        structureGroupTag: 'target',
      });
      blocks.push(...createProtectedNeighborBuilding('c02-prot-r', 10.5, 0));

      const roofY = 4 * 2.8 + (2.8 - 0.3);
      return {
        blocks,
        counterweights: [
          {
            anchorBlockId: 'c02-target-slab-4-0-0',
            anchorPoint: [-1.5, roofY, -1.2],
            center: [-1.5, roofY - 1.9, -1.2],
            halfExtents: [0.58, 0.48, 0.58],
            massKg: 11_000,
          },
        ],
        focusCenter: [1.2, 5.6, 0],
        focusRadiusM: 16.5,
      };
    },
  },
  {
    id: 'contract-03',
    index1Based: 3,
    selectorId: 'contract-03',
    titleRu: '03 · Хирургический снос в квартале',
    briefingRu:
      'Офисный центр зажат между двумя охраняемыми корпусами слева и справа! Используйте C4 и плазморезак для обрушения строго внутрь контура.',
    budgetLimit: 1600,
    toolCosts: { c4: 130, cutter: 95, cannon: 120, bomb: 320 },
    initialAmmo: { c4: 7, cutter: 5, cannon: 4, bomb: 1 },
    targetDestructionPct: 24,
    starThresholdsPct: [24, 46, 70],
    maxCollateralPct: 12,
    rewardCredits: 800,
    hasProtectedBuildings: true,
    buildScene: () => {
      const blocks = generateFramedBuildingSpecs({
        prefix: 'c03-target',
        gridX: [-3.2, 0, 3.2],
        gridZ: [-2.4, 0, 2.4],
        floors: 5,
        storeyHeightM: 2.75,
        slabThicknessM: 0.28,
        columnMaterial: (f) => (f <= 2 ? 'reinforced_concrete' : f === 3 ? 'steel' : 'wood'),
        slabMaterial: (f) => (f < 4 ? 'reinforced_concrete' : 'wood'),
        glassFloorsMax: 3,
        brickGroundWalls: true,
      });
      blocks.push(...createProtectedNeighborBuilding('c03-prot-l', -10.2, 0));
      blocks.push(...createProtectedNeighborBuilding('c03-prot-r', 10.2, 0));
      return {
        blocks,
        counterweights: [],
        focusCenter: [0, 5.5, 0],
        focusRadiusM: 17.5,
      };
    },
  },
  {
    id: 'contract-04',
    index1Based: 4,
    selectorId: 'contract-04',
    titleRu: '04 · Термическая ликвидация пакгауза',
    briefingRu:
      'Подожгите аварийный деревянный склад с резервуарами ГСМ термитной кассетой и обрушьте перекрытия цепным пожаром.',
    budgetLimit: 1650,
    toolCosts: { incendiary: 130, c4: 140, cannon: 115, bomb: 260 },
    initialAmmo: { incendiary: 6, c4: 5, cannon: 4, bomb: 2 },
    targetDestructionPct: 22,
    starThresholdsPct: [22, 46, 72],
    maxCollateralPct: 18,
    rewardCredits: 900,
    hasProtectedBuildings: true,
    buildScene: () => {
      const wh = buildSandboxBlueprintData('warehouse', [0, 0, 0], 'c04-wh');
      const blocks = [...wh.blocks, ...createProtectedNeighborBuilding('c04-prot-b', 0, -10.2)];
      return {
        blocks,
        counterweights: wh.counterweights,
        focusCenter: [0, 4.6, -1.0],
        focusRadiusM: 16.5,
      };
    },
  },
  {
    id: 'contract-05',
    index1Based: 5,
    selectorId: 'contract-05',
    titleRu: '05 · Снос аварийного путепровода',
    briefingRu:
      'Заложите каскадную серию зарядов C4 по быкам сталежелезобетонного виадука и обрушьте пролёты без ущерба павильону.',
    budgetLimit: 1800,
    toolCosts: { c4: 130, bomb: 250, cutter: 100, cannon: 115 },
    initialAmmo: { c4: 8, bomb: 3, cutter: 4, cannon: 4 },
    targetDestructionPct: 24,
    starThresholdsPct: [24, 48, 72],
    maxCollateralPct: 15,
    rewardCredits: 1050,
    hasProtectedBuildings: true,
    buildScene: () => {
      const vd = buildSandboxBlueprintData('viaduct', [0, 0, 0], 'c05-vd');
      const blocks = [...vd.blocks, ...createProtectedNeighborBuilding('c05-prot-f', 0, 10.2)];
      return {
        blocks,
        counterweights: vd.counterweights,
        focusCenter: [0, 3.8, 1.0],
        focusRadiusM: 17.5,
      };
    },
  },
  {
    id: 'contract-06',
    index1Based: 6,
    selectorId: 'contract-06',
    titleRu: '06 · Турбинный ангар промзоны',
    briefingRu:
      'Пережгите крепления 16-тонной турбины и стальные фермы ангара, вызвав каскадный обвал и детонацию газового узла.',
    budgetLimit: 1950,
    toolCosts: { cutter: 100, c4: 140, incendiary: 130, cannon: 120, bomb: 270 },
    initialAmmo: { cutter: 6, c4: 6, incendiary: 4, cannon: 5, bomb: 2 },
    targetDestructionPct: 25,
    starThresholdsPct: [25, 50, 74],
    maxCollateralPct: 15,
    rewardCredits: 1250,
    hasProtectedBuildings: true,
    buildScene: () => {
      const hg = buildSandboxBlueprintData('hangar', [0, 0, 0], 'c06-hg');
      const blocks = [...hg.blocks, ...createProtectedNeighborBuilding('c06-prot-l', -10.6, 0)];
      return {
        blocks,
        counterweights: hg.counterweights,
        focusCenter: [-1.0, 4.0, 0],
        focusRadiusM: 17.0,
      };
    },
  },
  {
    id: 'contract-07',
    index1Based: 7,
    selectorId: 'contract-07',
    titleRu: '07 · Сейсмоиспытание высотного ядра',
    briefingRu:
      'Ослабьте нижний ярус сейсмостойкой башни и запустите резонансный импульс сейсмоплатформы для полного разрушения каркаса.',
    budgetLimit: 2100,
    toolCosts: { seismic: 220, c4: 135, cannon: 115, bomb: 260 },
    initialAmmo: { seismic: 4, c4: 6, cannon: 5, bomb: 2 },
    targetDestructionPct: 24,
    starThresholdsPct: [24, 50, 75],
    maxCollateralPct: 100,
    rewardCredits: 1400,
    hasProtectedBuildings: false,
    buildScene: () => {
      const blocks = generateFramedBuildingSpecs({
        prefix: 'c07-seismic',
        gridX: [-2.8, 0, 2.8],
        gridZ: [-2.4, 0, 2.4],
        floors: 6,
        storeyHeightM: 2.85,
        slabThicknessM: 0.28,
        columnMaterial: (f) => (f <= 3 ? 'reinforced_concrete' : f === 4 ? 'steel' : 'wood'),
        slabMaterial: (f) => (f < 5 ? 'reinforced_concrete' : 'wood'),
        glassFloorsMax: 3,
      });
      return {
        blocks,
        counterweights: [],
        focusCenter: [0, 7.5, 0],
        focusRadiusM: 16.5,
      };
    },
  },
  {
    id: 'contract-08',
    index1Based: 8,
    selectorId: 'contract-08',
    titleRu: '08 · Финал: Комплекс «Точка Разлома»',
    briefingRu:
      'Главный контракт карьеры: снесите укреплённый высотный комплекс с арматурным ядром и противовесом в окружении двух охраняемых корпусов!',
    budgetLimit: 2500,
    toolCosts: { c4: 135, bomb: 270, cannon: 120, cutter: 100, incendiary: 130, seismic: 250 },
    initialAmmo: { c4: 8, bomb: 3, cannon: 6, cutter: 5, incendiary: 3, seismic: 2 },
    targetDestructionPct: 26,
    starThresholdsPct: [26, 52, 78],
    maxCollateralPct: 14,
    rewardCredits: 2000,
    hasProtectedBuildings: true,
    buildScene: () => {
      const tw = buildSandboxBlueprintData('tower', [0, 0, 0], 'c08-tw');
      const blocks = [
        ...tw.blocks,
        ...createProtectedNeighborBuilding('c08-prot-l', -10.5, 0),
        ...createProtectedNeighborBuilding('c08-prot-r', 10.5, 0),
      ];
      return {
        blocks,
        counterweights: tw.counterweights,
        focusCenter: [0, 7.2, 0],
        focusRadiusM: 18.5,
      };
    },
  },
];

export function spawnCampaignContractInWorld(
  world: DestructionWorld,
  contract: CampaignContractSpec,
): { focusCenter: Vec3; focusRadiusM: number } {
  world.clearScene();
  const scene = contract.buildScene();
  const nodeIds = world.spawnStructure(scene.blocks);

  for (const cw of scene.counterweights) {
    let anchorNodeId: number | undefined;
    if (cw.anchorBlockId) {
      const idx = scene.blocks.findIndex((b) => b.id === cw.anchorBlockId);
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

  return {
    focusCenter: scene.focusCenter,
    focusRadiusM: scene.focusRadiusM,
  };
}
