/**
 * Канонические контракты типов и констант проекта «ТОЧКА РАЗЛОМА».
 * Нулевая зависимость от внешних библиотек, DOM, WebGL и глобального состояния.
 */

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

export interface Vec3Tuple {
  readonly 0: number;
  readonly 1: number;
  readonly 2: number;
}

export interface MaterialPhysicsProfile {
  id: StructuralMaterialId;
  nameRu: string;
  densityKgM3: number;
  compressiveStrengthMPa: number;
  tensileStrengthMPa: number;
  shearCohesionMPa: number;
  internalFrictionCoeff: number;
  youngsModulusGPa: number;
  brittleness: number;
  plasticYieldRatio: number;       // < 1.0 для стали (пластический шарнир), 1.0 для хрупких
  hasRebarTethers: boolean;        // true для железобетона
  voronoiAnisotropy: [number, number, number];
  flammable: boolean;
  ignitionTempC: number;
  volatile: boolean;               // true для взрывоопасных ёмкостей
  detonationTempC: number;
  detonationEquivalentKgTnt: number;
  thermalConductivity: number;
  friction: number;
  restitution: number;
  baseColorHex: number;
  interiorCutColorHex: number;
}

export interface ConvexFace3D {
  indices: number[];               // CCW снаружи
  normal: [number, number, number];
  isInteriorCut: boolean;
}

export interface ConvexPolyhedron3DData {
  vertices: Float32Array;          // Локальные координаты относительно центроида [x0,y0,z0, ...]
  faces: ConvexFace3D[];
  volumeM3: number;
  centroid: [number, number, number];
  halfExtentsApprox: [number, number, number];
}

export interface RebarStub3D {
  originLocal: [number, number, number];
  directionLocal: [number, number, number];
  lengthM: number;
  bendAngleRad: number;
}

export interface VoronoiShard3D {
  polyhedron: ConvexPolyhedron3DData;
  worldPosition: [number, number, number];
  massKg: number;
  rebarStubs: RebarStub3D[];
}

export interface PhysicsConstantsOverrides {
  gravityMpS2: number;               // По умолчанию 9.81 (0..30)
  jointStrengthMultiplier: number;   // По умолчанию 1.0 (0.1..5.0)
  secondaryDamageMultiplier: number; // По умолчанию 1.0 (0.0..3.0)
  blastFalloffMultiplier: number;    // По умолчанию 1.0 (0.25..3.0)
  fireSpreadMultiplier: number;      // По умолчанию 1.0 (0.0..4.0)
  seismicFrequencyHz: number;        // 0.5..15.0 Гц
  seismicAmplitudeM: number;         // 0.05..2.50 м
}

export interface BlockInputSpec {
  id?: string;
  materialId: StructuralMaterialId;
  center: [number, number, number];
  halfExtents: [number, number, number];
  rotationQuat?: [number, number, number, number];
  grounded?: boolean;              // Опирается ли напрямую на фундамент/сейсмоплатформу
  structureGroupTag?: string;      // 'target' | 'protected' | string (для миссий Кампании)
}

export interface RenderBlockInstance {
  nodeId: number;
  materialId: StructuralMaterialId;
  position: [number, number, number];
  quaternion: [number, number, number, number];
  halfExtents: [number, number, number];
  stressUtilization: number;       // 0.0 .. 1.5+
  damageRatio: number;             // 0.0 .. 1.0
  temperatureC: number;            // 20 .. 1200 °C
  charRatio: number;               // 0.0 .. 1.0 (обугливание)
  burning: boolean;
  structureGroupTag: string;
}

export interface RenderShardInstance {
  shardId: number;
  materialId: StructuralMaterialId;
  polyhedron: ConvexPolyhedron3DData;
  position: [number, number, number];
  quaternion: [number, number, number, number];
  temperatureC: number;
  charRatio: number;
  sleeping: boolean;
  rebarStubs: RebarStub3D[];
}

export interface RenderBondOrRebarLine {
  id: number;
  kind: 'bond' | 'rebar' | 'plastic_hinge';
  pointA: [number, number, number];
  pointB: [number, number, number];
  stressUtilization: number;
  axialForceN: number;             // > 0 растяжение, < 0 сжатие
  broken: boolean;
}

export interface PlantedChargeSnapshot {
  chargeId: number;
  position: [number, number, number];
  normal: [number, number, number];
  delaySec: number;
  armed: boolean;
  remainingCountdownSec: number | null;
}

export interface RenderSnapshot {
  tick: number;
  simTimeSec: number;
  platformOffset: [number, number, number];
  blocks: RenderBlockInstance[];
  shards: RenderShardInstance[];
  bondsAndRebars: RenderBondOrRebarLine[];
  plantedCharges: PlantedChargeSnapshot[];
  projectiles: Array<{
    id: number;
    position: [number, number, number];
    radiusM: number;
    velocity: [number, number, number];
    hot: boolean;
  }>;
}

export type SimulationEvent =
  | { type: 'fracture'; position: [number, number, number]; materialId: StructuralMaterialId; energyJ: number; shardCount: number }
  | { type: 'rebar_snap'; position: [number, number, number]; forceN: number }
  | { type: 'steel_yield'; position: [number, number, number]; angleRad: number }
  | { type: 'secondary_impact'; position: [number, number, number]; materialId: StructuralMaterialId; impulseNs: number; massKg: number; targetTag: string }
  | { type: 'explosion'; position: [number, number, number]; radiusM: number; equivalentKgTnt: number; isChainDetonation: boolean }
  | { type: 'fire_ignited'; nodeId: number; position: [number, number, number] }
  | { type: 'seismic_pulse'; frequencyHz: number; amplitudeM: number; groundAccelMpS2: number };

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
  destructionPct: number;          // 0..100% (по целевым/всем конструкциям)
  targetMaxHeightM: number;        // Текущая верхняя точка целевого сооружения
  protectedDamagePct: number;      // 0..100% урона охраняемым объектам ('protected')
  seismicActive: boolean;
  seismicFrequencyHz: number;
  seismicAmplitudeM: number;
  lastStepCpuMs: number;
}

export type Vec3 = [number, number, number];
export type QuatTuple = [number, number, number, number]; // [x, y, z, w]
export type SimulationEventType = SimulationEvent['type'];
export type SimulationEventByType<K extends SimulationEventType> = Extract<SimulationEvent, { type: K }>;

export const FIXED_DT = 1 / 60;
export const AMBIENT_TEMPERATURE_C = 20;
export const DEFAULT_SEED = 0x53484154; // 1397244244 ('SHAT')

export const STRUCTURAL_MATERIAL_IDS: readonly StructuralMaterialId[] = Object.freeze([
  'reinforced_concrete',
  'brick',
  'glass',
  'wood',
  'steel',
  'explosive',
]);

export const DEFAULT_PHYSICS_CONSTANTS: Readonly<PhysicsConstantsOverrides> = Object.freeze({
  gravityMpS2: 9.81,
  jointStrengthMultiplier: 1.0,
  secondaryDamageMultiplier: 1.0,
  blastFalloffMultiplier: 1.0,
  fireSpreadMultiplier: 1.0,
  seismicFrequencyHz: 2.5,
  seismicAmplitudeM: 0.35,
});

export const PHYSICS_CONSTANTS_BOUNDS: Readonly<
  Record<keyof PhysicsConstantsOverrides, readonly [number, number]>
> = Object.freeze({
  gravityMpS2: [0.0, 30.0],
  jointStrengthMultiplier: [0.1, 5.0],
  secondaryDamageMultiplier: [0.0, 3.0],
  blastFalloffMultiplier: [0.25, 3.0],
  fireSpreadMultiplier: [0.0, 4.0],
  seismicFrequencyHz: [0.5, 15.0],
  seismicAmplitudeM: [0.05, 2.5],
});
