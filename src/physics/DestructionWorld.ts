import { SimulationEventBus } from '../core/events';
import {
  clamp,
  cleanZero,
  computePolyhedronVolumeAndCentroid,
  quatConjugate,
  quatInverseRotateVec3,
  quatMultiply,
  quatNormalize,
  quatRotateVec3,
  vec3Add,
  vec3AddScaled,
  vec3Cross,
  vec3Dist,
  vec3Dot,
  vec3Len,
  vec3Lerp,
  vec3Normalize,
  vec3Scale,
  vec3Sub,
} from '../core/math3d';
import { SeededRng } from '../core/rng';
import {
  AMBIENT_TEMPERATURE_C,
  DEFAULT_PHYSICS_CONSTANTS,
  DEFAULT_SEED,
  FIXED_DT,
  PHYSICS_CONSTANTS_BOUNDS,
  type BlockInputSpec,
  type ConvexPolyhedron3DData,
  type PhysicsConstantsOverrides,
  type QuatTuple,
  type RenderBlockInstance,
  type RenderBondOrRebarLine,
  type RenderShardInstance,
  type RenderSnapshot,
  type RebarStub3D,
  type SimulationEvent,
  type SimulationEventByType,
  type SimulationEventType,
  type SimulationTelemetry,
  type StructuralMaterialId,
  type Vec3,
  type Vec3Tuple,
  type VoronoiShard3D,
} from '../core/types';
import {
  BallisticsAndBlastSystem,
  distanceSegmentToSegment3D,
  type FractureRequest,
  type TetherSegmentView,
  type WorldColliderOwner,
} from './BallisticsAndBlast';
import { computeThermalStrengthRetention, getMaterialProfile } from './MaterialRegistry';
import { assertRapierInitialized, initRapier, RAPIER } from './rapier';
import { SeismicController } from './SeismicController';
import { StressSolver, type BrokenBondInfo } from './StressSolver';
import {
  StructuralGraph,
  type DetachedIsland,
  type StructuralBond,
  type StructuralNode,
} from './StructuralGraph';
import { ThermalFireSystem } from './ThermalFireSystem';
import { carveLocalBreach3D, fracturePolyhedronVoronoi3D } from './VoronoiFracture3D';

/**
 * Единый фасад физического мира разрушения «ТОЧКА РАЗЛОМА» (DestructionWorld).
 * Координирует Rapier3D WASM, граф структурной целостности, 6-DOF решатель напряжений PCG,
 * арматурные тяжи RebarTether, пластические шарниры стали, баллистику, взрывы Садовского,
 * пожар, 3D-сейсмоплатформу и запекание спящих обломков при строгом детерминизме по seed.
 */

export interface DestructionWorldOptions {
  seed?: number;
  physicsConstants?: Partial<PhysicsConstantsOverrides>;
  maxActiveShards?: number;
}

export interface CounterweightInputSpec {
  center: [number, number, number];
  halfExtents: [number, number, number];
  massKg: number;
  anchorPoint: [number, number, number];
  anchorNodeId?: number;
  tetherBreakForceN?: number;
}

export interface SceneRaycastHit {
  point: Vec3;
  normal: Vec3;
  distance: number;
  nodeId?: number;
  shardId?: number;
  materialId?: StructuralMaterialId;
  isGround: boolean;
}

interface DynamicShardRecord {
  shardId: number;
  materialId: StructuralMaterialId;
  polyhedron: ConvexPolyhedron3DData;
  rebarStubs: RebarStub3D[];
  massKg: number;
  bodyHandle: number;
  colliderHandle: number;
  position: Vec3;
  quaternion: QuatTuple;
  temperatureC: number;
  charRatio: number;
  calmTicks: number;
  spawnTick: number;
  baked: boolean;
  countsTowardTargetMass: boolean;
}

interface ActiveRebarTetherRecord {
  tetherId: number;
  jointHandle: number;
  bodyHandleA: number;
  bodyHandleB: number;
  localAnchorA: Vec3;
  localAnchorB: Vec3;
  restLengthM: number;
  stiffnessNPerM: number;
  dampingNsPerM: number;
  baseBreakForceN: number;
  maxExtensionM: number;
  nodeIdA?: number;
  nodeIdB?: number;
  currentTensionN: number;
  stressUtilization: number;
  plasmaHeatJ: number;
  snapped: boolean;
}

interface ActivePlasticHingeJointRecord {
  hingeId: number;
  bondId: number;
  jointHandle: number;
  bodyHandleA: number;
  bodyHandleB: number;
  localAnchorA: Vec3;
  localAnchorB: Vec3;
  localAxisA: Vec3;
  baseMomentCapacityNm: number;
  nodeIdA: number;
  nodeIdB?: number;
  ruptured: boolean;
}

interface SuspendedCounterweightRecord {
  triggerId: number;
  weightNodeId: number;
  weightBodyHandle: number;
  weightColliderHandle: number;
  anchorBodyHandle: number;
  anchorColliderHandle: number;
  anchorNodeId?: number;
  anchorLocalOnParent: Vec3;
  attachLocalOnWeight: Vec3;
  jointHandle: number;
  restLengthM: number;
  stiffnessNPerM: number;
  dampingNsPerM: number;
  baseBreakForceN: number;
  massKg: number;
  plasmaHeatJ: number;
  currentTensionN: number;
  released: boolean;
}

interface RawContactForceSample {
  c1: number;
  c2: number;
  totalForce: number;
  maxForce: number;
}

const DEFAULT_MAX_ACTIVE_SHARDS = 380;
const MAX_BAKED_RUBBLE_SHARDS = 900;
const MAX_FRACTURES_PER_TICK = 7;
const CALM_TICKS_TO_BAKE = 48;

function nowCpuMs(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

function buildTriangleIndicesFromFaces(poly: ConvexPolyhedron3DData): Uint32Array {
  let triCount = 0;
  for (let f = 0; f < poly.faces.length; f++) {
    const len = poly.faces[f]!.indices.length;
    if (len >= 3) {
      triCount += len - 2;
    }
  }
  const out = new Uint32Array(triCount * 3);
  let ptr = 0;
  for (let f = 0; f < poly.faces.length; f++) {
    const idx = poly.faces[f]!.indices;
    if (idx.length < 3) continue;
    const i0 = idx[0]!;
    for (let t = 1; t < idx.length - 1; t++) {
      out[ptr++] = i0;
      out[ptr++] = idx[t]!;
      out[ptr++] = idx[t + 1]!;
    }
  }
  return out;
}

function createColliderDescForPolyhedron(
  poly: ConvexPolyhedron3DData,
  isBox: boolean,
  halfExtents: Vec3Tuple,
): RAPIER.ColliderDesc {
  if (isBox) {
    return RAPIER.ColliderDesc.cuboid(
      Math.max(0.015, halfExtents[0]),
      Math.max(0.015, halfExtents[1]),
      Math.max(0.015, halfExtents[2]),
    );
  }
  const triIndices = buildTriangleIndicesFromFaces(poly);
  const meshDesc = RAPIER.ColliderDesc.convexMesh(poly.vertices, triIndices);
  if (meshDesc) {
    return meshDesc;
  }
  const hullDesc = RAPIER.ColliderDesc.convexHull(poly.vertices);
  if (hullDesc) {
    return hullDesc;
  }
  return RAPIER.ColliderDesc.cuboid(
    Math.max(0.02, poly.halfExtentsApprox[0]),
    Math.max(0.02, poly.halfExtentsApprox[1]),
    Math.max(0.02, poly.halfExtentsApprox[2]),
  );
}

function sanitizePhysicsConstants(
  base: PhysicsConstantsOverrides,
  partial?: Partial<PhysicsConstantsOverrides> & { gravityMps2?: number },
): PhysicsConstantsOverrides {
  if (!partial) {
    return { ...base };
  }
  const clampKey = (key: keyof PhysicsConstantsOverrides, rawVal: number | undefined): number => {
    if (rawVal === undefined || !Number.isFinite(rawVal)) {
      return base[key];
    }
    const [lo, hi] = PHYSICS_CONSTANTS_BOUNDS[key];
    return cleanZero(clamp(rawVal, lo, hi));
  };

  const gravInput =
    partial.gravityMpS2 !== undefined ? partial.gravityMpS2 : partial.gravityMps2;

  return {
    gravityMpS2: clampKey('gravityMpS2', gravInput),
    jointStrengthMultiplier: clampKey('jointStrengthMultiplier', partial.jointStrengthMultiplier),
    secondaryDamageMultiplier: clampKey(
      'secondaryDamageMultiplier',
      partial.secondaryDamageMultiplier,
    ),
    blastFalloffMultiplier: clampKey('blastFalloffMultiplier', partial.blastFalloffMultiplier),
    fireSpreadMultiplier: clampKey('fireSpreadMultiplier', partial.fireSpreadMultiplier),
    seismicFrequencyHz: clampKey('seismicFrequencyHz', partial.seismicFrequencyHz),
    seismicAmplitudeM: clampKey('seismicAmplitudeM', partial.seismicAmplitudeM),
  };
}

export class DestructionWorld {
  private initialSeed: number;
  private rng: SeededRng;
  private physicsConstants: PhysicsConstantsOverrides;
  private maxActiveShards: number;

  private world!: RAPIER.World;
  private eventQueue!: RAPIER.EventQueue;
  private groundBodyHandle = -1;
  private groundColliderHandle = -1;
  private monolithBodyHandle = -1;
  private bakedRubbleBodyHandle = -1;

  private readonly eventBus = new SimulationEventBus();
  private readonly graph = new StructuralGraph();
  private readonly stressSolver = new StressSolver();
  private readonly ballistics = new BallisticsAndBlastSystem();
  private readonly thermal = new ThermalFireSystem();
  private readonly seismic = new SeismicController();

  private readonly colliderOwners = new Map<number, WorldColliderOwner>();
  private readonly islands = new Map<number, DetachedIsland>();
  private readonly shards = new Map<number, DynamicShardRecord>();
  private readonly rebarTethers = new Map<number, ActiveRebarTetherRecord>();
  private readonly plasticHingeJoints = new Map<number, ActivePlasticHingeJointRecord>();
  private readonly counterweights = new Map<number, SuspendedCounterweightRecord>();
  private readonly plasmaNodeCutAccumJ = new Map<number, number>();
  private readonly bodyImpactCooldownTick = new Map<string, number>();

  private nextIslandId = 1;
  private nextShardId = 1;
  private nextTetherId = 1;
  private nextHingeId = 1;
  private nextTriggerId = 1;

  private tick = 0;
  private simTimeSec = 0;
  private accumulatorSec = 0;
  private paused = false;
  private timeScale = 1.0;
  private disposed = false;
  private stressDirty = true;

  // Накопительные метрики телеметрии
  private initialBlockCount = 0;
  private initialJointCount = 0;
  private brokenJointCount = 0;
  private snappedRebarCount = 0;
  private secondaryImpactsCount = 0;
  private detonatedExplosivesCount = 0;
  private bakedRubbleCount = 0;
  private collapsedMassKg = 0;
  private maxObservedDestructionPct = 0;
  private maxObservedProtectedDamagePct = 0;
  private lastMaxStressUtilization = 0;
  private lastStepCpuMs = 0;

  public static async create(options?: DestructionWorldOptions): Promise<DestructionWorld> {
    await initRapier();
    return new DestructionWorld(options);
  }

  constructor(options?: DestructionWorldOptions) {
    assertRapierInitialized();
    const rawSeed = options?.seed ?? DEFAULT_SEED;
    this.initialSeed = Number.isFinite(rawSeed) ? (Math.trunc(rawSeed) >>> 0) : DEFAULT_SEED;
    this.rng = new SeededRng(this.initialSeed);
    this.physicsConstants = sanitizePhysicsConstants(
      { ...DEFAULT_PHYSICS_CONSTANTS },
      options?.physicsConstants,
    );
    this.maxActiveShards = clamp(
      Math.round(options?.maxActiveShards ?? DEFAULT_MAX_ACTIVE_SHARDS),
      16,
      1024,
    );

    this.initRapierWorldInstance();
  }

  private initRapierWorldInstance(): void {
    this.world = new RAPIER.World({
      x: 0,
      y: -this.physicsConstants.gravityMpS2,
      z: 0,
    });
    this.world.timestep = FIXED_DT;
    this.world.numSolverIterations = 6;
    this.world.numInternalPgsIterations = 2;
    this.eventQueue = new RAPIER.EventQueue(true);

    // Плита полигона / сейсмоплатформы (верхняя плоскость ровно на y = 0.0 м)
    const groundRb = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(0, 0, 0),
    );
    const groundCol = this.world.createCollider(
      RAPIER.ColliderDesc.cuboid(140, 1.0, 140)
        .setTranslation(0, -1.0, 0)
        .setFriction(0.78)
        .setRestitution(0.08),
      groundRb,
    );
    this.groundBodyHandle = groundRb.handle;
    this.groundColliderHandle = groundCol.handle;
    this.colliderOwners.set(groundCol.handle, { kind: 'ground' });

    // Единое кинематическое супер-тело закреплённого монолита (0.000 м просадки в покое!)
    const monolithRb = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(0, 0, 0),
    );
    this.monolithBodyHandle = monolithRb.handle;

    // Статическое тело запечённых спящих руин
    const bakedRb = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, 0, 0));
    this.bakedRubbleBodyHandle = bakedRb.handle;
  }

  /**
   * Полностью очищает сцену, пересоздаёт детерминированный WASM-мир Rapier3D и сбрасывает ГПСЧ к начальному seed.
   */
  public clearScene(newSeed?: number): void {
    this.ensureNotDisposed();
    if (newSeed !== undefined && Number.isFinite(newSeed)) {
      this.initialSeed = Math.trunc(newSeed) >>> 0;
    }

    this.eventQueue.free();
    this.world.free();

    this.colliderOwners.clear();
    this.islands.clear();
    this.shards.clear();
    this.rebarTethers.clear();
    this.plasticHingeJoints.clear();
    this.counterweights.clear();
    this.plasmaNodeCutAccumJ.clear();
    this.bodyImpactCooldownTick.clear();

    this.graph.clear();
    this.ballistics.clear();
    this.thermal.clear();
    this.seismic.clear();
    this.eventBus.clear();

    this.rng = new SeededRng(this.initialSeed);

    this.nextIslandId = 1;
    this.nextShardId = 1;
    this.nextTetherId = 1;
    this.nextHingeId = 1;
    this.nextTriggerId = 1;

    this.tick = 0;
    this.simTimeSec = 0;
    this.accumulatorSec = 0;
    this.stressDirty = true;

    this.initialBlockCount = 0;
    this.initialJointCount = 0;
    this.brokenJointCount = 0;
    this.snappedRebarCount = 0;
    this.secondaryImpactsCount = 0;
    this.detonatedExplosivesCount = 0;
    this.bakedRubbleCount = 0;
    this.collapsedMassKg = 0;
    this.maxObservedDestructionPct = 0;
    this.maxObservedProtectedDamagePct = 0;
    this.lastMaxStressUtilization = 0;
    this.lastStepCpuMs = 0;

    this.initRapierWorldInstance();
  }

  public reset(newSeed?: number): void {
    this.clearScene(newSeed);
  }

  /**
   * Безопасно освобождает всю линейную WASM-память Rapier3D (идемпотентно).
   */
  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.eventBus.removeAllListeners();
    this.eventBus.clear();
    this.eventQueue.free();
    this.world.free();
  }

  public isDisposed(): boolean {
    return this.disposed;
  }

  private ensureNotDisposed(): void {
    if (this.disposed) {
      throw new Error('Экземпляр DestructionWorld уже уничтожен вызовом dispose().');
    }
  }

  // ==========================================================================
  // Управление константами физики, временем и событиями
  // ==========================================================================

  public setPhysicsConstants(
    partial: Partial<PhysicsConstantsOverrides> & {
      gravityMps2?: number;
      maxActiveShards?: number;
    },
  ): Readonly<PhysicsConstantsOverrides> {
    this.ensureNotDisposed();
    const prevGrav = this.physicsConstants.gravityMpS2;
    const prevJoint = this.physicsConstants.jointStrengthMultiplier;

    this.physicsConstants = sanitizePhysicsConstants(this.physicsConstants, partial);
    if (partial.maxActiveShards !== undefined && Number.isFinite(partial.maxActiveShards)) {
      this.maxActiveShards = clamp(Math.round(partial.maxActiveShards), 16, 1024);
    }

    if (Math.abs(this.physicsConstants.gravityMpS2 - prevGrav) > 1e-9) {
      this.world.gravity = { x: 0, y: -this.physicsConstants.gravityMpS2, z: 0 };
      this.world.forEachRigidBody((rb) => {
        if (rb.isDynamic()) {
          rb.wakeUp();
        }
      });
      this.stressDirty = true;
    }
    if (Math.abs(this.physicsConstants.jointStrengthMultiplier - prevJoint) > 1e-9) {
      this.stressDirty = true;
    }

    // Немедленно обновляем статическое распределение напряжений при изменении ползунков лаборатории
    if (this.stressDirty) {
      this.reconcileTopologyAndSolveStress(false);
    }

    return this.getPhysicsConstants();
  }

  public updatePhysicsConfig(
    partial: Partial<PhysicsConstantsOverrides> & {
      gravityMps2?: number;
      maxActiveShards?: number;
    },
  ): Readonly<PhysicsConstantsOverrides> {
    return this.setPhysicsConstants(partial);
  }

  public getPhysicsConstants(): Readonly<PhysicsConstantsOverrides> {
    return { ...this.physicsConstants };
  }

  public getMaxActiveShards(): number {
    return this.maxActiveShards;
  }

  public setMaxActiveShards(limit: number): void {
    if (Number.isFinite(limit)) {
      this.maxActiveShards = clamp(Math.round(limit), 16, 1024);
    }
  }

  public setPaused(paused: boolean): void {
    this.paused = Boolean(paused);
  }

  public isPaused(): boolean {
    return this.paused;
  }

  public setTimeScale(scale: number): void {
    if (Number.isFinite(scale)) {
      this.timeScale = cleanZero(clamp(scale, 0.05, 2.0));
    }
  }

  public getTimeScale(): number {
    return this.timeScale;
  }

  public getSeed(): number {
    return this.initialSeed;
  }

  public getEventBus(): SimulationEventBus {
    return this.eventBus;
  }

  public onEvent<K extends SimulationEventType>(
    type: K,
    handler: (event: SimulationEventByType<K>) => void,
  ): () => void {
    return this.eventBus.on(type, handler);
  }

  public drainEvents(): SimulationEvent[] {
    return this.eventBus.drain();
  }

  // ==========================================================================
  // Построение сооружений и объектов-триггеров (противовесы, бочки)
  // ==========================================================================

  public spawnStructure(blocks: readonly BlockInputSpec[]): number[] {
    this.ensureNotDisposed();
    if (blocks.length === 0) {
      return [];
    }

    const platformOffset = this.seismic.getPlatformOffset();
    const { createdNodes, createdBonds } = this.graph.addBlocks(blocks, platformOffset);
    const monolithRb = this.world.getRigidBody(this.monolithBodyHandle);

    const createdIds: number[] = [];
    for (let i = 0; i < createdNodes.length; i++) {
      const node = createdNodes[i]!;
      this.attachNodeColliderToMonolith(node, monolithRb);
      this.initialBlockCount++;
      createdIds.push(node.nodeId);
    }

    for (let i = 0; i < createdBonds.length; i++) {
      if (createdBonds[i]!.countsTowardInitialTotals) {
        this.initialJointCount++;
      }
    }

    this.world.propagateModifiedBodyPositionsToColliders();
    this.stressDirty = true;

    // Рассчитываем начальные напряжения покоя (без разрыва швов на нулевом тике сборки, если здание стоит на опорах),
    // чтобы сразу после загрузки сцены рентген видел несущие колонны и эпюру сжатия!
    this.computeInitialStaticEquilibrium();

    return createdIds;
  }

  public spawnBlock(spec: BlockInputSpec): number {
    const ids = this.spawnStructure([spec]);
    return ids[0]!;
  }

  /**
   * Создаёт подвешенный на стальном тросе многотонный противовес (фича F26).
   */
  public spawnSuspendedCounterweight(spec: CounterweightInputSpec): number {
    this.ensureNotDisposed();
    const triggerId = this.nextTriggerId++;
    const cwNode = this.graph.addCounterweightNode({
      center: spec.center,
      halfExtents: spec.halfExtents,
      massKg: spec.massKg,
    });

    const profile = getMaterialProfile('steel');
    const rbDesc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(cwNode.worldPos[0], cwNode.worldPos[1], cwNode.worldPos[2])
      .setLinearDamping(0.08)
      .setAngularDamping(0.25)
      .setCcdEnabled(true);
    const weightRb = this.world.createRigidBody(rbDesc);

    const colDesc = RAPIER.ColliderDesc.cuboid(
      cwNode.halfExtents[0],
      cwNode.halfExtents[1],
      cwNode.halfExtents[2],
    )
      .setMass(cwNode.massKg)
      .setFriction(profile.friction)
      .setRestitution(profile.restitution)
      .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS)
      .setContactForceEventThreshold(500);
    const weightCol = this.world.createCollider(colDesc, weightRb);
    cwNode.colliderHandle = weightCol.handle;
    this.colliderOwners.set(weightCol.handle, { kind: 'node', nodeId: cwNode.nodeId });

    // Определяем родительское тело точки подвеса (либо узел балки крана, либо фиксированный якорь)
    const anchorWorld: Vec3 = [
      cleanZero(spec.anchorPoint[0]),
      cleanZero(spec.anchorPoint[1]),
      cleanZero(spec.anchorPoint[2]),
    ];
    let anchorBody: RAPIER.RigidBody;
    let anchorLocalOnParent: Vec3;
    const anchorNode =
      spec.anchorNodeId !== undefined ? this.graph.getNode(spec.anchorNodeId) : undefined;

    if (anchorNode && anchorNode.alive) {
      if (anchorNode.islandId === 0) {
        anchorBody = this.world.getRigidBody(this.monolithBodyHandle);
        const pOffset = this.seismic.getPlatformOffset();
        anchorLocalOnParent = vec3Sub(anchorWorld, pOffset);
      } else {
        const isl = this.islands.get(anchorNode.islandId);
        anchorBody = isl
          ? this.world.getRigidBody(isl.bodyHandle)
          : this.world.getRigidBody(this.groundBodyHandle);
        const bodyPos = anchorBody.translation();
        const bodyRot = anchorBody.rotation();
        anchorLocalOnParent = quatInverseRotateVec3(
          [bodyRot.x, bodyRot.y, bodyRot.z, bodyRot.w],
          vec3Sub(anchorWorld, [bodyPos.x, bodyPos.y, bodyPos.z]),
        );
      }
    } else {
      anchorBody = this.world.getRigidBody(this.groundBodyHandle);
      const pOffset = this.seismic.getPlatformOffset();
      anchorLocalOnParent = vec3Sub(anchorWorld, pOffset);
    }

    // Небольшой сенсор-проушина в точке подвеса для попадания снаряда / резака
    const eyeletCol = this.world.createCollider(
      RAPIER.ColliderDesc.ball(0.28)
        .setSensor(true)
        .setTranslation(
          anchorLocalOnParent[0],
          anchorLocalOnParent[1],
          anchorLocalOnParent[2],
        ),
      anchorBody,
    );
    this.colliderOwners.set(eyeletCol.handle, { kind: 'anchor', triggerId });

    const attachLocalOnWeight: Vec3 = [0, cwNode.halfExtents[1], 0];
    const attachWorld = vec3Add(cwNode.worldPos, attachLocalOnWeight);
    const dist = Math.max(0.1, vec3Dist(anchorWorld, attachWorld));

    const defaultBreakForce = Math.max(cwNode.massKg * 9.81 * 2.8, 180_000);
    const baseBreakForceN =
      spec.tetherBreakForceN !== undefined && Number.isFinite(spec.tetherBreakForceN)
        ? Math.max(100, spec.tetherBreakForceN)
        : defaultBreakForce;

    // Устойчивая по Найквисту жёсткость троса при dt = 1/60 с: провисание в покое ~2.5 см
    const stiffness = Math.min(420 * cwNode.massKg, Math.max(cwNode.massKg * 320, 80_000));
    const damping = 0.85 * 2 * Math.sqrt(stiffness * cwNode.massKg);
    const restLengthM = Math.max(0.05, dist - (cwNode.massKg * this.physicsConstants.gravityMpS2) / stiffness);

    const jd = RAPIER.JointData.spring(
      restLengthM,
      stiffness,
      damping,
      { x: anchorLocalOnParent[0], y: anchorLocalOnParent[1], z: anchorLocalOnParent[2] },
      { x: attachLocalOnWeight[0], y: attachLocalOnWeight[1], z: attachLocalOnWeight[2] },
    );
    const joint = this.world.createImpulseJoint(jd, anchorBody, weightRb, true);
    joint.setContactsEnabled(true);

    this.counterweights.set(triggerId, {
      triggerId,
      weightNodeId: cwNode.nodeId,
      weightBodyHandle: weightRb.handle,
      weightColliderHandle: weightCol.handle,
      anchorBodyHandle: anchorBody.handle,
      anchorColliderHandle: eyeletCol.handle,
      anchorNodeId: anchorNode?.nodeId,
      anchorLocalOnParent,
      attachLocalOnWeight,
      jointHandle: joint.handle,
      restLengthM,
      stiffnessNPerM: stiffness,
      dampingNsPerM: damping,
      baseBreakForceN,
      massKg: cwNode.massKg,
      plasmaHeatJ: 0,
      currentTensionN: cwNode.massKg * this.physicsConstants.gravityMpS2,
      released: false,
    });

    this.world.propagateModifiedBodyPositionsToColliders();
    this.stressDirty = true;
    return triggerId;
  }

  private attachNodeColliderToMonolith(node: StructuralNode, monolithRb: RAPIER.RigidBody): void {
    const profile = getMaterialProfile(node.materialId);
    const colDesc = createColliderDescForPolyhedron(node.polyhedron, node.isBox, node.halfExtents)
      .setTranslation(
        node.localPlatformPos[0],
        node.localPlatformPos[1],
        node.localPlatformPos[2],
      )
      .setRotation({
        x: node.localPlatformQuat[0],
        y: node.localPlatformQuat[1],
        z: node.localPlatformQuat[2],
        w: node.localPlatformQuat[3],
      })
      .setDensity(profile.densityKgM3)
      .setFriction(profile.friction)
      .setRestitution(profile.restitution)
      .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS)
      .setContactForceEventThreshold(400);

    const col = this.world.createCollider(colDesc, monolithRb);
    node.colliderHandle = col.handle;
    this.colliderOwners.set(col.handle, { kind: 'node', nodeId: node.nodeId });
  }

  private computeInitialStaticEquilibrium(): void {
    // Нагружаем узлы крана весом подвешенных противовесов перед решением статики
    this.injectCounterweightLoadsIntoGraph();
    this.graph.findUnanchoredComponents();
    const res = this.stressSolver.solve({
      graph: this.graph,
      gravityMpS2: this.physicsConstants.gravityMpS2,
      jointStrengthMultiplier: this.physicsConstants.jointStrengthMultiplier,
      platformOffset: this.seismic.getPlatformOffset(),
    });
    this.lastMaxStressUtilization = res.maxStressUtilization;
    // Если сразу при спавне некоторые узлы висят в воздухе без единой опоры, оставляем stressDirty = true,
    // чтобы на первом же шаге step() они оторвались и упали по параболе!
    const floatingAtSpawn = this.graph.findUnanchoredComponents();
    this.stressDirty = floatingAtSpawn.length > 0 || res.newlyBrokenBonds.length > 0;
    // Откатываем досрочный разрыв при спавне, чтобы честный разрыв произошёл ровно на тике 1 симуляции с эмиссией событий
    for (let i = 0; i < res.newlyBrokenBonds.length; i++) {
      const b = res.newlyBrokenBonds[i]!.bond;
      b.broken = false;
      b.integrity = 1.0;
      b.concreteCracked = false;
    }
  }

  // ==========================================================================
  // Арсенал разрушения (6 инструментов) + Рейкаст сцены и Разведка опор
  // ==========================================================================

  public raycastScene(
    origin: Vec3Tuple,
    direction: Vec3Tuple,
    maxDist = 250,
  ): SceneRaycastHit | null {
    this.ensureNotDisposed();
    const dir = vec3Normalize(direction, [0, 0, -1]);
    const safeMaxDist = Math.max(0.01, Number.isFinite(maxDist) ? maxDist : 250);
    this.world.propagateModifiedBodyPositionsToColliders();

    const ray = new RAPIER.Ray(
      { x: origin[0], y: origin[1], z: origin[2] },
      { x: dir[0], y: dir[1], z: dir[2] },
    );

    const hit = this.world.castRayAndGetNormal(
      ray,
      safeMaxDist,
      true,
      undefined,
      undefined,
      undefined,
      undefined,
      (col) => {
        const owner = this.colliderOwners.get(col.handle);
        return Boolean(owner && owner.kind !== 'projectile');
      },
    );

    if (!hit) {
      return null;
    }

    const hitPoint = vec3AddScaled(origin, dir, hit.timeOfImpact);
    const normal = vec3Normalize([hit.normal.x, hit.normal.y, hit.normal.z], [0, 1, 0]);
    const owner = this.colliderOwners.get(hit.collider.handle);

    if (!owner || owner.kind === 'ground') {
      return {
        point: hitPoint,
        normal,
        distance: cleanZero(hit.timeOfImpact),
        isGround: true,
      };
    }

    if (owner.kind === 'node') {
      const node = this.graph.getNode(owner.nodeId);
      return {
        point: hitPoint,
        normal,
        distance: cleanZero(hit.timeOfImpact),
        nodeId: owner.nodeId,
        materialId: node?.materialId,
        isGround: false,
      };
    }

    if (owner.kind === 'shard') {
      const sh = this.shards.get(owner.shardId);
      return {
        point: hitPoint,
        normal,
        distance: cleanZero(hit.timeOfImpact),
        shardId: owner.shardId,
        materialId: sh?.materialId,
        isGround: false,
      };
    }

    return {
      point: hitPoint,
      normal,
      distance: cleanZero(hit.timeOfImpact),
      isGround: false,
    };
  }

  public castSceneRay(
    origin: Vec3Tuple,
    direction: Vec3Tuple,
    maxDist = 250,
  ): SceneRaycastHit | null {
    return this.raycastScene(origin, direction, maxDist);
  }

  public getCriticalLoadBearingNodeIds(topK = 6): number[] {
    this.ensureNotDisposed();
    return this.graph.computeCriticalLoadBearingNodeIds(topK);
  }

  public fireProjectile(params: {
    origin: [number, number, number];
    direction: [number, number, number];
    speedMpS: number;
    massKg: number;
    radiusM?: number;
    hot?: boolean;
  }): number {
    this.ensureNotDisposed();
    return this.ballistics.fireProjectile({
      world: this.world,
      colliderOwners: this.colliderOwners,
      origin: params.origin,
      direction: params.direction,
      speedMpS: params.speedMpS,
      massKg: params.massKg,
      radiusM: params.radiusM,
      hot: params.hot,
    });
  }

  public plantC4(params: {
    worldPoint: [number, number, number];
    normal: [number, number, number];
    targetNodeId?: number;
    delaySec: number;
    yieldKgTnt?: number;
  }): number {
    this.ensureNotDisposed();
    return this.ballistics.plantC4(params, this.graph);
  }

  public removeC4(chargeId: number): boolean {
    this.ensureNotDisposed();
    return this.ballistics.removeC4(chargeId);
  }

  public removeC4At(point: Vec3Tuple, maxRadiusM = 1.6): number | null {
    this.ensureNotDisposed();
    return this.ballistics.removeC4At(point, maxRadiusM);
  }

  public updateC4Delay(chargeId: number, delaySec: number): boolean {
    this.ensureNotDisposed();
    return this.ballistics.updateC4Delay(chargeId, delaySec);
  }

  public detonateAllC4(): void {
    this.ensureNotDisposed();
    this.ballistics.detonateAllC4();
  }

  public detonateQueuedC4(): void {
    this.detonateAllC4();
  }

  public getC4SequenceQueue(): Array<{ chargeId: number; delaySec: number }> {
    return this.ballistics.getC4SequenceQueue();
  }

  public getPlantedC4Count(): number {
    return this.ballistics.getPlantedC4Count();
  }

  public triggerBlast(params: {
    center: [number, number, number];
    yieldKgTnt: number;
    incendiary?: boolean;
  }): void {
    this.ensureNotDisposed();
    this.ballistics.enqueueBlast({
      center: params.center,
      yieldKgTnt: params.yieldKgTnt,
      incendiary: params.incendiary,
      isChainDetonation: false,
      delayTicks: 0,
    });
  }

  public detonate(params: {
    center: [number, number, number];
    yieldKgTnt: number;
    incendiary?: boolean;
  }): void {
    this.triggerBlast(params);
  }

  /**
   * Плазменный резак ближнего боя: пережигает стальные тяжи арматуры RebarTether, тросы противовесов,
   * нагревает узлы по Еврокоду и прорезает несущие балки/стены!
   */
  public applyPlasmaCut(params: {
    origin: [number, number, number];
    direction: [number, number, number];
    rangeM: number;
    powerW?: number;
    dtSec?: number;
  }): SceneRaycastHit | null {
    this.ensureNotDisposed();
    const dir = vec3Normalize(params.direction, [0, 0, -1]);
    const rangeM = clamp(Number.isFinite(params.rangeM) ? params.rangeM : 14, 0.5, 60);
    const powerW = clamp(Number.isFinite(params.powerW) ? params.powerW! : 220_000, 5_000, 5_000_000);
    const dtSec = clamp(Number.isFinite(params.dtSec) ? params.dtSec! : FIXED_DT, 1e-4, 1.0);
    const cutEnergyJ = powerW * dtSec;

    const rayEnd = vec3AddScaled(params.origin, dir, rangeM);

    // 1. Проверяем перерезание активных тяжей арматуры RebarTether лучом резака
    for (const tether of this.rebarTethers.values()) {
      if (tether.snapped) continue;
      const pts = this.getRebarTetherWorldEndpoints(tether);
      if (!pts) continue;
      const dSeg = distanceSegmentToSegment3D(params.origin, rayEnd, pts.pointA, pts.pointB);
      if (dSeg.distM <= 0.36) {
        tether.plasmaHeatJ += cutEnergyJ;
        if (tether.plasmaHeatJ >= 12_000) {
          this.snapRebarTether(tether, Math.max(tether.currentTensionN, tether.baseBreakForceN * 0.45));
          this.stressDirty = true;
        }
      }
    }

    // 2. Проверяем перерезание тросов подвешенных противовесов лучом резака
    for (const cw of this.counterweights.values()) {
      if (cw.released) continue;
      const pts = this.getCounterweightCableEndpoints(cw);
      if (!pts) continue;
      const dSeg = distanceSegmentToSegment3D(params.origin, rayEnd, pts.anchorWorld, pts.attachWorld);
      if (dSeg.distM <= 0.38) {
        cw.plasmaHeatJ += cutEnergyJ;
        if (cw.plasmaHeatJ >= 12_000) {
          this.releaseCounterweight(cw);
          this.stressDirty = true;
        }
      }
    }

    // 3. Проверяем попадание луча плазморезака в конструктивный блок или проушину
    const hit = this.raycastScene(params.origin, dir, rangeM);
    if (!hit) {
      return null;
    }

    if (hit.nodeId !== undefined) {
      const node = this.graph.getNode(hit.nodeId);
      if (node && node.alive && !node.isCounterweight) {
        // Разогреваем узел плазменной дугой
        const addedTemp = clamp((cutEnergyJ / Math.max(60, node.massKg)) * 32, 8, 280);
        const heatRes = this.thermal.heatNode(this.graph, node, addedTemp, 1150);
        if (heatRes.ignitedEvent) {
          this.eventBus.emit(heatRes.ignitedEvent);
        }
        if (heatRes.thermalDetonation) {
          if (this.ballistics.triggerExplosiveNodeDetonation(node, 0, true)) {
            this.detonatedExplosivesCount++;
          }
        } else if (heatRes.thermalShock) {
          this.executeFractureOnNode({
            nodeId: node.nodeId,
            impactPointWorld: hit.point,
            impulseDirWorld: dir,
            impulseMagnitudeNs: 120,
            energyJ: cutEnergyJ,
            preferLocalBreach: false,
            breachRadiusM: 0.45,
          });
          this.stressDirty = true;
          return hit;
        }

        // Ослабляем швы узла вблизи точки реза и накапливаем энергию сквозного разреза
        for (let i = 0; i < node.adjacencyBondIds.length; i++) {
          const bond = this.graph.getBond(node.adjacencyBondIds[i]!);
          if (!bond || bond.broken) continue;
          const bondPts = this.graph.getBondWorldPoints(bond, this.seismic.getPlatformOffset());
          const dBond = vec3Dist(hit.point, bondPts.midpoint);
          if (dBond <= 1.35) {
            const drop = clamp((cutEnergyJ / 35_000) * (1 - dBond / 1.6), 0.03, 0.65);
            bond.integrity = cleanZero(Math.max(0, bond.integrity - drop));
            bond.dirtyStiffness = true;
            if (bond.integrity <= 0.04) {
              bond.broken = true;
              bond.integrity = 0;
              this.brokenJointCount++;
              this.stressDirty = true;
            }
          }
        }

        const prevCutJ = this.plasmaNodeCutAccumJ.get(node.nodeId) ?? 0;
        const nextCutJ = prevCutJ + cutEnergyJ;
        this.plasmaNodeCutAccumJ.set(node.nodeId, nextCutJ);

        const cutThresholdJ =
          node.materialId === 'steel'
            ? 55_000
            : node.materialId === 'reinforced_concrete'
              ? 42_000
              : 24_000;

        node.damageRatio = cleanZero(clamp(Math.max(node.damageRatio, nextCutJ / cutThresholdJ), 0, 1));
        this.stressDirty = true;

        if (nextCutJ >= cutThresholdJ) {
          this.plasmaNodeCutAccumJ.delete(node.nodeId);
          const spans = [
            node.halfExtents[0] * 2,
            node.halfExtents[1] * 2,
            node.halfExtents[2] * 2,
          ].sort((a, b) => b - a);
          this.executeFractureOnNode({
            nodeId: node.nodeId,
            impactPointWorld: hit.point,
            impulseDirWorld: dir,
            impulseMagnitudeNs: 250,
            energyJ: nextCutJ,
            preferLocalBreach: spans[0]! >= 1.6 && node.materialId !== 'glass',
            breachRadiusM: 0.48,
          });
        }
      }
    }

    return hit;
  }

  public igniteArea(params: {
    center: [number, number, number];
    radiusM: number;
    temperatureC?: number;
  }): number {
    this.ensureNotDisposed();
    const res = this.thermal.igniteArea({
      graph: this.graph,
      center: params.center,
      radiusM: params.radiusM,
      temperatureC: params.temperatureC,
    });

    for (let i = 0; i < res.emittedEvents.length; i++) {
      this.eventBus.emit(res.emittedEvents[i]!);
    }

    for (let i = 0; i < res.thermalDetonationNodeIds.length; i++) {
      const node = this.graph.getNode(res.thermalDetonationNodeIds[i]!);
      if (node && node.alive && this.ballistics.triggerExplosiveNodeDetonation(node, 0, true)) {
        this.detonatedExplosivesCount++;
      }
    }

    for (let i = 0; i < res.thermalShockNodeIds.length; i++) {
      const node = this.graph.getNode(res.thermalShockNodeIds[i]!);
      if (node && node.alive) {
        this.executeFractureOnNode({
          nodeId: node.nodeId,
          impactPointWorld: node.worldPos,
          impulseDirWorld: [0, 1, 0],
          impulseMagnitudeNs: 180,
          energyJ: 4_500,
          preferLocalBreach: false,
          breachRadiusM: 0.5,
        });
      }
    }

    this.stressDirty = true;
    return res.emittedEvents.length;
  }

  public igniteSphere(params: {
    center: [number, number, number];
    radiusM: number;
    temperatureC?: number;
  }): number {
    return this.igniteArea(params);
  }

  public triggerEarthquake(params: {
    frequencyHz: number;
    amplitudeM: number;
    durationSec: number;
  }): void {
    this.ensureNotDisposed();
    this.seismic.trigger(params, this.rng);
    this.physicsConstants = sanitizePhysicsConstants(this.physicsConstants, {
      seismicFrequencyHz: params.frequencyHz,
      seismicAmplitudeM: params.amplitudeM,
    });
    this.world.forEachRigidBody((rb) => {
      if (rb.isDynamic()) {
        rb.wakeUp();
      }
    });
    this.stressDirty = true;
  }

  public stopEarthquake(): void {
    this.ensureNotDisposed();
    this.seismic.stop();
    const groundRb = this.world.getRigidBody(this.groundBodyHandle);
    const monolithRb = this.world.getRigidBody(this.monolithBodyHandle);
    groundRb.setNextKinematicTranslation({ x: 0, y: 0, z: 0 });
    monolithRb.setNextKinematicTranslation({ x: 0, y: 0, z: 0 });
    this.syncMonolithNodesWorldPose([0, 0, 0]);
    this.stressDirty = true;
  }

  // ==========================================================================
  // Цикл шага симуляции (фиксированный тик dt = 1/60 с)
  // ==========================================================================

  public step(dtSec?: number, maxSubsteps = 6): SimulationEvent[] {
    this.ensureNotDisposed();
    if (this.paused) {
      return [];
    }

    const startMs = nowCpuMs();
    const safeSubsteps = Math.max(1, Math.min(16, Math.trunc(maxSubsteps)));

    if (dtSec === undefined) {
      // Канонический фиксированный шаг (с учётом масштаба времени timeScale)
      if (Math.abs(this.timeScale - 1.0) <= 1e-6) {
        this.executeFixedTick();
      } else {
        this.accumulatorSec += FIXED_DT * this.timeScale;
        let steps = 0;
        while (this.accumulatorSec + 1e-9 >= FIXED_DT && steps < safeSubsteps) {
          this.accumulatorSec = Math.max(0, this.accumulatorSec - FIXED_DT);
          this.executeFixedTick();
          steps++;
        }
      }
    } else {
      const clampedDt = clamp(Number.isFinite(dtSec) ? dtSec : FIXED_DT, 0, 0.25);
      this.accumulatorSec += clampedDt * this.timeScale;
      let steps = 0;
      while (this.accumulatorSec + 1e-9 >= FIXED_DT && steps < safeSubsteps) {
        this.accumulatorSec = Math.max(0, this.accumulatorSec - FIXED_DT);
        this.executeFixedTick();
        steps++;
      }
      if (steps >= safeSubsteps && this.accumulatorSec > FIXED_DT) {
        this.accumulatorSec = 0;
      }
    }

    this.lastStepCpuMs = cleanZero(Math.max(0, nowCpuMs() - startMs));
    return this.eventBus.drain();
  }

  public stepSingleTick(): SimulationEvent[] {
    this.ensureNotDisposed();
    const startMs = nowCpuMs();
    this.executeFixedTick();
    this.lastStepCpuMs = cleanZero(Math.max(0, nowCpuMs() - startMs));
    return this.eventBus.drain();
  }

  private executeFixedTick(): void {
    this.tick += 1;
    this.simTimeSec = cleanZero(this.tick * FIXED_DT);

    let fracturesUsedThisTick = 0;
    const queuedFractures: FractureRequest[] = [];

    // ФАЗА 1: Сейсмоплатформа
    const seismicOut = this.seismic.step(FIXED_DT);
    const platformOffset = seismicOut.platformOffset;
    const groundRb = this.world.getRigidBody(this.groundBodyHandle);
    const monolithRb = this.world.getRigidBody(this.monolithBodyHandle);
    groundRb.setNextKinematicTranslation({
      x: platformOffset[0],
      y: platformOffset[1],
      z: platformOffset[2],
    });
    monolithRb.setNextKinematicTranslation({
      x: platformOffset[0],
      y: platformOffset[1],
      z: platformOffset[2],
    });
    this.syncMonolithNodesWorldPose(platformOffset);

    if (seismicOut.pulseEvent) {
      this.eventBus.emit(seismicOut.pulseEvent);
    }
    if (seismicOut.active) {
      this.stressDirty = true;
    }

    // ФАЗА 2: Баллистика, таймеры C4 и ударные волны Садовского
    const activeTetherViews = this.collectActiveTetherViews();
    const balOut = this.ballistics.stepPrePhysics({
      tick: this.tick,
      dtSec: FIXED_DT,
      world: this.world,
      graph: this.graph,
      colliderOwners: this.colliderOwners,
      blastFalloffMultiplier: this.physicsConstants.blastFalloffMultiplier,
      jointStrengthMultiplier: this.physicsConstants.jointStrengthMultiplier,
      gravityMpS2: this.physicsConstants.gravityMpS2,
      activeTethers: activeTetherViews,
    });

    for (let i = 0; i < balOut.emittedEvents.length; i++) {
      this.eventBus.emit(balOut.emittedEvents[i]!);
      this.stressDirty = true;
    }
    this.detonatedExplosivesCount += balOut.newlyDetonatedExplosiveNodeIds.length;

    for (let i = 0; i < balOut.incendiaryZones.length; i++) {
      const iz = balOut.incendiaryZones[i]!;
      const ignRes = this.thermal.igniteArea({
        graph: this.graph,
        center: iz.center,
        radiusM: iz.radiusM,
        temperatureC: iz.temperatureC,
      });
      for (let k = 0; k < ignRes.emittedEvents.length; k++) {
        this.eventBus.emit(ignRes.emittedEvents[k]!);
      }
    }

    for (let i = 0; i < balOut.severedTetherIds.length; i++) {
      const t = this.rebarTethers.get(balOut.severedTetherIds[i]!);
      if (t && !t.snapped) {
        this.snapRebarTether(t, Math.max(t.currentTensionN, t.baseBreakForceN * 0.5));
      }
    }
    for (let i = 0; i < balOut.severedCounterweightTriggerIds.length; i++) {
      const cw = this.counterweights.get(balOut.severedCounterweightTriggerIds[i]!);
      if (cw && !cw.released) {
        this.releaseCounterweight(cw);
      }
    }

    for (let i = 0; i < balOut.dynamicImpulses.length; i++) {
      const di = balOut.dynamicImpulses[i]!;
      if (!this.world.colliders.contains(di.colliderHandle)) continue;
      const col = this.world.getCollider(di.colliderHandle);
      const rb = col.parent();
      if (rb && rb.isDynamic()) {
        rb.applyImpulseAtPoint(
          { x: di.impulseWorldNs[0], y: di.impulseWorldNs[1], z: di.impulseWorldNs[2] },
          { x: di.contactPointWorld[0], y: di.contactPointWorld[1], z: di.contactPointWorld[2] },
          true,
        );
      }
    }

    for (let i = 0; i < balOut.fractureRequests.length; i++) {
      queuedFractures.push(balOut.fractureRequests[i]!);
    }

    // ФАЗА 3: Теплопередача, пожар, термошок стекла и тепловой взрыв бочек BLEVE
    const thermalOut = this.thermal.step(
      this.graph,
      FIXED_DT,
      this.physicsConstants.fireSpreadMultiplier,
    );
    for (let i = 0; i < thermalOut.emittedEvents.length; i++) {
      this.eventBus.emit(thermalOut.emittedEvents[i]!);
    }
    if (thermalOut.burningNodeCount > 0 || thermalOut.maxTemperatureC > 60) {
      this.stressDirty = true;
    }

    for (let i = 0; i < thermalOut.thermalDetonationNodeIds.length; i++) {
      const node = this.graph.getNode(thermalOut.thermalDetonationNodeIds[i]!);
      if (node && node.alive && this.ballistics.triggerExplosiveNodeDetonation(node, 0, true)) {
        this.detonatedExplosivesCount++;
        queuedFractures.push({
          nodeId: node.nodeId,
          impactPointWorld: node.worldPos,
          impulseDirWorld: [0, 1, 0],
          impulseMagnitudeNs: 2_500,
          energyJ: 45_000,
          preferLocalBreach: false,
          breachRadiusM: 0.8,
        });
      }
    }

    for (let i = 0; i < thermalOut.thermalShockNodeIds.length; i++) {
      const node = this.graph.getNode(thermalOut.thermalShockNodeIds[i]!);
      if (node && node.alive) {
        queuedFractures.push({
          nodeId: node.nodeId,
          impactPointWorld: node.worldPos,
          impulseDirWorld: [0, 1, 0],
          impulseMagnitudeNs: 180,
          energyJ: 5_000,
          preferLocalBreach: false,
          breachRadiusM: 0.5,
        });
      }
    }

    for (let i = 0; i < thermalOut.burnedOutNodeIds.length; i++) {
      const node = this.graph.getNode(thermalOut.burnedOutNodeIds[i]!);
      if (node && node.alive) {
        queuedFractures.push({
          nodeId: node.nodeId,
          impactPointWorld: node.worldPos,
          impulseDirWorld: [0, -1, 0],
          impulseMagnitudeNs: 80,
          energyJ: 3_000,
          preferLocalBreach: false,
          breachRadiusM: 0.5,
        });
      }
    }

    // Исполняем накопленные расколы до расчёта строительной статики, чтобы выбитые колонны СРАЗУ освободили верхние ярусы!
    if (queuedFractures.length > 0) {
      fracturesUsedThisTick += this.processFractureQueue(queuedFractures, fracturesUsedThisTick);
      queuedFractures.length = 0;
      this.stressDirty = true;
    }

    // ФАЗА 4: Граф целостности (Multi-Source BFS) и 6-DOF решатель напряжений (PCG)
    if (this.stressDirty || this.counterweights.size > 0) {
      this.reconcileTopologyAndSolveStress(true);
    }

    // ФАЗА 5: Пред-шаговое кэширование скоростей динамических тел и шаг Rapier3D WASM
    const preStepVelocities = new Map<number, { vel: Vec3; mass: number }>();
    this.world.forEachActiveRigidBody((rb) => {
      if (rb.isDynamic()) {
        const v = rb.linvel();
        preStepVelocities.set(rb.handle, {
          vel: [v.x, v.y, v.z],
          mass: Math.max(0.5, rb.mass()),
        });
      }
    });

    this.world.step(this.eventQueue);
    this.syncDynamicBodiesPostStep(platformOffset);

    // ФАЗА 6: Дренаж CONTACT_FORCE_EVENTS и вторичный кинетический урон (F07)
    const contactSamples: RawContactForceSample[] = [];
    this.eventQueue.drainContactForceEvents((ev) => {
      contactSamples.push({
        c1: ev.collider1(),
        c2: ev.collider2(),
        totalForce: ev.totalForceMagnitude(),
        maxForce: ev.maxForceMagnitude(),
      });
    });

    if (contactSamples.length > 0 && this.physicsConstants.secondaryDamageMultiplier > 0) {
      this.processSecondaryImpacts(contactSamples, preStepVelocities, queuedFractures);
      if (queuedFractures.length > 0 && fracturesUsedThisTick < MAX_FRACTURES_PER_TICK) {
        fracturesUsedThisTick += this.processFractureQueue(queuedFractures, fracturesUsedThisTick);
        queuedFractures.length = 0;
        this.reconcileTopologyAndSolveStress(true);
      }
    }

    // ФАЗА 7: Опрос натяжения и обрыва RebarTether, тросов противовесов и пластических шарниров стали
    this.stepJointsAndTethers();

    // ФАЗА 8: Контроль бюджета активных осколков и запекание успокоившихся руин
    this.enforceShardBudgetAndBakeCalmRubble();
  }

  private syncMonolithNodesWorldPose(platformOffset: Vec3Tuple): void {
    for (const node of this.graph.getNodesMap().values()) {
      if (node.alive && node.islandId === 0 && !node.isCounterweight) {
        node.worldPos = [
          cleanZero(node.localPlatformPos[0] + platformOffset[0]),
          cleanZero(node.localPlatformPos[1] + platformOffset[1]),
          cleanZero(node.localPlatformPos[2] + platformOffset[2]),
        ];
        node.worldQuat = [
          node.localPlatformQuat[0],
          node.localPlatformQuat[1],
          node.localPlatformQuat[2],
          node.localPlatformQuat[3],
        ];
      }
    }
  }

  private syncDynamicBodiesPostStep(platformOffset: Vec3Tuple): void {
    this.syncMonolithNodesWorldPose(platformOffset);

    // Обновляем позы узлов в оторванных составных островах
    for (const isl of this.islands.values()) {
      if (!this.world.bodies.contains(isl.bodyHandle)) continue;
      const rb = this.world.getRigidBody(isl.bodyHandle);
      const t = rb.translation();
      const r = rb.rotation();
      const islPos: Vec3 = [t.x, t.y, t.z];
      const islQuat: QuatTuple = quatNormalize([r.x, r.y, r.z, r.w]);

      for (let i = 0; i < isl.nodeIds.length; i++) {
        const n = this.graph.getNode(isl.nodeIds[i]!);
        if (!n || !n.alive || n.islandId !== isl.islandId) continue;
        const rotOff = quatRotateVec3(islQuat, n.localIslandOffset);
        n.worldPos = vec3Add(islPos, rotOff);
        n.worldQuat = quatNormalize(quatMultiply(islQuat, n.localIslandQuat));
      }
    }

    // Обновляем позы противовесов
    for (const cw of this.counterweights.values()) {
      const n = this.graph.getNode(cw.weightNodeId);
      if (!n || !n.alive || !this.world.bodies.contains(cw.weightBodyHandle)) continue;
      const rb = this.world.getRigidBody(cw.weightBodyHandle);
      const t = rb.translation();
      const r = rb.rotation();
      n.worldPos = [cleanZero(t.x), cleanZero(t.y), cleanZero(t.z)];
      n.worldQuat = quatNormalize([r.x, r.y, r.z, r.w]);
    }

    // Обновляем позы динамических осколков Вороного
    for (const sh of this.shards.values()) {
      if (sh.baked || !this.world.bodies.contains(sh.bodyHandle)) continue;
      const rb = this.world.getRigidBody(sh.bodyHandle);
      const t = rb.translation();
      const r = rb.rotation();
      sh.position = [cleanZero(t.x), cleanZero(t.y), cleanZero(t.z)];
      sh.quaternion = quatNormalize([r.x, r.y, r.z, r.w]);
    }

    // Обновляем позиции снарядов
    for (const proj of this.ballistics.getProjectilesMap().values()) {
      if (!this.world.bodies.contains(proj.bodyHandle)) continue;
      const rb = this.world.getRigidBody(proj.bodyHandle);
      const t = rb.translation();
      const v = rb.linvel();
      proj.position = [cleanZero(t.x), cleanZero(t.y), cleanZero(t.z)];
      proj.velocity = [cleanZero(v.x), cleanZero(v.y), cleanZero(v.z)];
    }
  }

  private injectCounterweightLoadsIntoGraph(): void {
    for (const cw of this.counterweights.values()) {
      if (cw.released || cw.anchorNodeId === undefined) continue;
      const anchorNode = this.graph.getNode(cw.anchorNodeId);
      if (anchorNode && anchorNode.alive && anchorNode.islandId === 0) {
        anchorNode.externalForceN[1] -= cw.massKg * this.physicsConstants.gravityMpS2;
      }
    }
  }

  /**
   * Выполняет отрыв потерявших опору островов (Multi-Source BFS) и расчёт напряжений 6-DOF PCG.
   */
  private reconcileTopologyAndSolveStress(emitEventsAndSpawnJoints: boolean): void {
    const platformOffset = this.seismic.getPlatformOffset();

    // 1. Первичный Multi-Source BFS: отделяем компоненты, уже потерявшие путь к фундаменту
    const detachedBefore = this.graph.findUnanchoredComponents();
    if (detachedBefore.length > 0) {
      this.detachNodeComponentsToDynamicIslands(detachedBefore, [], emitEventsAndSpawnJoints);
    }

    // 2. Передаём вес подвешенных противовесов на опорные балки и вычисляем высоту кластера для сейсморезонанса
    this.injectCounterweightLoadsIntoGraph();
    const clusterHeights = this.computeConnectedClusterHeights();

    const solveRes = this.stressSolver.solve({
      graph: this.graph,
      gravityMpS2: this.physicsConstants.gravityMpS2,
      jointStrengthMultiplier: this.physicsConstants.jointStrengthMultiplier,
      platformOffset,
      computeNodeSeismicAccel: this.seismic.isActive()
        ? (node) =>
            this.seismic.computeNodeSeismicAcceleration(
              node,
              clusterHeights.get(node.nodeId) ?? Math.max(1.5, node.initialTopY),
            )
        : undefined,
    });

    this.lastMaxStressUtilization = solveRes.maxStressUtilization;

    if (emitEventsAndSpawnJoints) {
      for (let i = 0; i < solveRes.emittedEvents.length; i++) {
        this.eventBus.emit(solveRes.emittedEvents[i]!);
      }
    }

    if (solveRes.newlyBrokenBonds.length > 0) {
      this.brokenJointCount += solveRes.newlyBrokenBonds.length;
      const detachedAfter = this.graph.findUnanchoredComponents();
      if (detachedAfter.length > 0) {
        this.detachNodeComponentsToDynamicIslands(
          detachedAfter,
          solveRes.newlyBrokenBonds,
          emitEventsAndSpawnJoints,
        );
      }
      this.stressDirty = true;
    } else if (!this.seismic.isActive()) {
      this.stressDirty = false;
    }
  }

  private computeConnectedClusterHeights(): Map<number, number> {
    const out = new Map<number, number>();
    if (!this.seismic.isActive()) {
      return out;
    }
    const nodesMap = this.graph.getNodesMap();
    const bondsMap = this.graph.getBondsMap();
    const visited = new Set<number>();

    for (const node of nodesMap.values()) {
      if (!node.alive || node.islandId !== 0 || node.isCounterweight || visited.has(node.nodeId)) {
        continue;
      }
      const comp: StructuralNode[] = [];
      const q: StructuralNode[] = [node];
      visited.add(node.nodeId);
      let maxH = node.initialTopY;
      let ptr = 0;
      while (ptr < q.length) {
        const cur = q[ptr++]!;
        comp.push(cur);
        if (cur.initialTopY > maxH) {
          maxH = cur.initialTopY;
        }
        for (let k = 0; k < cur.adjacencyBondIds.length; k++) {
          const b = bondsMap.get(cur.adjacencyBondIds[k]!);
          if (!b || b.broken || b.nodeIdB === -1) continue;
          const nbId = b.nodeIdA === cur.nodeId ? b.nodeIdB : b.nodeIdA;
          if (!visited.has(nbId)) {
            const nb = nodesMap.get(nbId);
            if (nb && nb.alive && nb.islandId === 0 && !nb.isCounterweight) {
              visited.add(nbId);
              q.push(nb);
            }
          }
        }
      }
      for (let i = 0; i < comp.length; i++) {
        out.set(comp[i]!.nodeId, maxH);
      }
    }
    return out;
  }

  /**
   * Переводит оторвавшиеся от фундамента связные компоненты в честные составные динамические тела Rapier3D,
   * создавая стальные тяжи RebarTether на разорванных ЖБ-швах и физические шарниры PlasticHinge на стальных узлах.
   */
  private detachNodeComponentsToDynamicIslands(
    components: readonly number[][],
    brokenBondsContext: readonly BrokenBondInfo[],
    spawnJoints: boolean,
  ): void {
    const brokenBondLookup = new Map<number, BrokenBondInfo>();
    for (let i = 0; i < brokenBondsContext.length; i++) {
      const info = brokenBondsContext[i]!;
      brokenBondLookup.set(info.bond.bondId, info);
    }

    for (let c = 0; c < components.length; c++) {
      const compIds = components[c]!;
      if (compIds.length === 0) continue;

      const compNodes: StructuralNode[] = [];
      let totalMass = 0;
      let comX = 0;
      let comY = 0;
      let comZ = 0;
      let impX = 0;
      let impY = 0;
      let impZ = 0;

      for (let i = 0; i < compIds.length; i++) {
        const n = this.graph.getNode(compIds[i]!);
        if (!n || !n.alive || n.islandId !== 0) continue;
        compNodes.push(n);
        totalMass += n.massKg;
        comX += n.massKg * n.worldPos[0];
        comY += n.massKg * n.worldPos[1];
        comZ += n.massKg * n.worldPos[2];
        impX += n.pendingImpulseNs[0];
        impY += n.pendingImpulseNs[1];
        impZ += n.pendingImpulseNs[2];
        n.pendingImpulseNs = [0, 0, 0];
      }

      if (compNodes.length === 0 || totalMass <= 0) continue;

      const comWorld: Vec3 = [
        cleanZero(comX / totalMass),
        cleanZero(comY / totalMass),
        cleanZero(comZ / totalMass),
      ];

      const islandId = this.nextIslandId++;
      const islRbDesc = RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(comWorld[0], comWorld[1], comWorld[2])
        .setLinearDamping(0.06)
        .setAngularDamping(0.18)
        .setCcdEnabled(true);
      const islRb = this.world.createRigidBody(islRbDesc);

      // Микроскопическое возмущение из SeededRng для реалистичного крена при вертикальном складывании башни
      const tiltTorqueNm = totalMass * this.rng.range(-0.18, 0.18);

      for (let i = 0; i < compNodes.length; i++) {
        const n = compNodes[i]!;
        // Удаляем старый коллайдер из monolithBody
        if (n.colliderHandle !== -1 && this.world.colliders.contains(n.colliderHandle)) {
          const oldCol = this.world.getCollider(n.colliderHandle);
          this.colliderOwners.delete(n.colliderHandle);
          this.world.removeCollider(oldCol, false);
        }

        const localOff = vec3Sub(n.worldPos, comWorld);
        n.localIslandOffset = localOff;
        n.localIslandQuat = [n.worldQuat[0], n.worldQuat[1], n.worldQuat[2], n.worldQuat[3]];
        n.islandId = islandId;

        const profile = getMaterialProfile(n.materialId);
        const colDesc = createColliderDescForPolyhedron(n.polyhedron, n.isBox, n.halfExtents)
          .setTranslation(localOff[0], localOff[1], localOff[2])
          .setRotation({
            x: n.localIslandQuat[0],
            y: n.localIslandQuat[1],
            z: n.localIslandQuat[2],
            w: n.localIslandQuat[3],
          })
          .setDensity(profile.densityKgM3)
          .setFriction(profile.friction)
          .setRestitution(profile.restitution)
          .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS)
          .setContactForceEventThreshold(400);

        const newCol = this.world.createCollider(colDesc, islRb);
        n.colliderHandle = newCol.handle;
        this.colliderOwners.set(newCol.handle, { kind: 'node', nodeId: n.nodeId });

        if (!n.isCounterweight && n.countsTowardInitialTotals) {
          this.collapsedMassKg += n.massKg;
        } else if (!n.isCounterweight) {
          this.collapsedMassKg += n.massKg;
        }
      }

      if (Math.hypot(impX, impY, impZ) > 1e-3) {
        const maxInitVel = 24;
        const cappedScale = Math.min(1, (totalMass * maxInitVel) / Math.hypot(impX, impY, impZ));
        islRb.applyImpulse(
          { x: impX * cappedScale, y: impY * cappedScale, z: impZ * cappedScale },
          true,
        );
      }
      if (Math.abs(tiltTorqueNm) > 1e-3) {
        islRb.applyTorqueImpulse({ x: tiltTorqueNm * 0.35, y: 0, z: tiltTorqueNm }, true);
      }

      this.islands.set(islandId, {
        islandId,
        bodyHandle: islRb.handle,
        nodeIds: compNodes.map((n) => n.nodeId),
        totalMassKg: totalMass,
        comWorldAtSpawn: comWorld,
      });

      // Если на оторвавшемся узле висел противовес, перепривязываем якорь или отпускаем его!
      for (const cw of this.counterweights.values()) {
        if (!cw.released && cw.anchorNodeId !== undefined) {
          const aNode = this.graph.getNode(cw.anchorNodeId);
          if (aNode && aNode.islandId === islandId) {
            this.releaseCounterweight(cw);
          }
        }
      }

      // Создаём RebarTether или PlasticHinge на разорванных граничных связях этого острова!
      if (spawnJoints) {
        const compSet = new Set<number>(compNodes.map((n) => n.nodeId));
        let spawnedJointsOnIsland = 0;

        for (let i = 0; i < compNodes.length && spawnedJointsOnIsland < 4; i++) {
          const n = compNodes[i]!;
          for (let k = 0; k < n.adjacencyBondIds.length && spawnedJointsOnIsland < 4; k++) {
            const bId = n.adjacencyBondIds[k]!;
            const bond = this.graph.getBond(bId);
            if (!bond || !bond.broken) continue;

            const aInComp = compSet.has(bond.nodeIdA);
            const bInComp = bond.nodeIdB !== -1 && compSet.has(bond.nodeIdB);
            if (aInComp === bInComp) continue; // Внутренняя связь острова

            const otherNode =
              bond.nodeIdB === -1
                ? undefined
                : this.graph.getNode(aInComp ? bond.nodeIdB : bond.nodeIdA);
            if (bond.nodeIdB !== -1 && (!otherNode || !otherNode.alive)) {
              continue;
            }

            const otherBodyHandle =
              bond.nodeIdB === -1 || (otherNode && otherNode.islandId === 0)
                ? this.monolithBodyHandle
                : otherNode
                  ? (this.islands.get(otherNode.islandId)?.bodyHandle ?? -1)
                  : -1;

            if (otherBodyHandle === -1 || !this.world.bodies.contains(otherBodyHandle)) {
              continue;
            }

            const brokenInfo = brokenBondLookup.get(bond.bondId);
            const profN = getMaterialProfile(n.materialId);
            const profOther = otherNode ? getMaterialProfile(otherNode.materialId) : profN;

            if (
              !bond.spawnedRebarTether &&
              profN.hasRebarTethers &&
              profOther.hasRebarTethers
            ) {
              bond.spawnedRebarTether = true;
              const pts = this.graph.getBondWorldPoints(bond, this.seismic.getPlatformOffset());
              this.spawnRebarTetherBetweenBodies({
                bodyHandleA: otherBodyHandle,
                bodyHandleB: islRb.handle,
                worldAnchor: pts.midpoint,
                bondAreaM2: bond.areaM2,
                reducedMassKg: totalMass,
                nodeIdA: otherNode?.nodeId,
                nodeIdB: n.nodeId,
              });
              spawnedJointsOnIsland++;
            } else if (
              !bond.spawnedPlasticJoint &&
              brokenInfo?.isSteelHingeRelease &&
              n.materialId === 'steel' &&
              (!otherNode || otherNode.materialId === 'steel')
            ) {
              bond.spawnedPlasticJoint = true;
              const pts = this.graph.getBondWorldPoints(bond, this.seismic.getPlatformOffset());
              this.spawnSteelPlasticHingeBetweenBodies({
                bond,
                bodyHandleA: otherBodyHandle,
                bodyHandleB: islRb.handle,
                worldAnchor: pts.midpoint,
                nodeIdA: n.nodeId,
                nodeIdB: otherNode?.nodeId,
              });
              spawnedJointsOnIsland++;
            }
          }
        }
      }
    }

    this.world.propagateModifiedBodyPositionsToColliders();
  }

  // ==========================================================================
  // Физические суставы Rapier3D: RebarTether, PlasticHinge и трос противовеса
  // ==========================================================================

  private spawnRebarTetherBetweenBodies(params: {
    bodyHandleA: number;
    bodyHandleB: number;
    worldAnchor: Vec3Tuple;
    bondAreaM2: number;
    reducedMassKg: number;
    nodeIdA?: number;
    nodeIdB?: number;
  }): number | null {
    if (
      params.bodyHandleA === params.bodyHandleB ||
      !this.world.bodies.contains(params.bodyHandleA) ||
      !this.world.bodies.contains(params.bodyHandleB)
    ) {
      return null;
    }

    const bodyA = this.world.getRigidBody(params.bodyHandleA);
    const bodyB = this.world.getRigidBody(params.bodyHandleB);

    const tA = bodyA.translation();
    const rA = bodyA.rotation();
    const localA = quatInverseRotateVec3(
      [rA.x, rA.y, rA.z, rA.w],
      vec3Sub(params.worldAnchor, [tA.x, tA.y, tA.z]),
    );

    const tB = bodyB.translation();
    const rB = bodyB.rotation();
    const localB = quatInverseRotateVec3(
      [rB.x, rB.y, rB.z, rB.w],
      vec3Sub(params.worldAnchor, [tB.x, tB.y, tB.z]),
    );

    const redMass = Math.max(25, params.reducedMassKg);
    // Сечение арматуры А500С пропорционально площади шва (калибровано так, чтобы консольная глыба держалась на весу,
    // а при дополнительной ударной/весовой нагрузке или резаке рвалась с событием rebar_snap!)
    const rebarAreaM2 = clamp(params.bondAreaM2 * 0.0016, 4.5e-5, 6.5e-4);
    const baseBreakForceN = rebarAreaM2 * 520e6;
    const rawStiffness = baseBreakForceN / 0.16;
    const stiffness = clamp(rawStiffness, 12_000, 420 * redMass);
    const damping = 0.35 * 2 * Math.sqrt(stiffness * redMass);
    const restLengthM = 0.04;

    const jd = RAPIER.JointData.spring(
      restLengthM,
      stiffness,
      damping,
      { x: localA[0], y: localA[1], z: localA[2] },
      { x: localB[0], y: localB[1], z: localB[2] },
    );
    const joint = this.world.createImpulseJoint(jd, bodyA, bodyB, true);
    joint.setContactsEnabled(true);

    const tetherId = this.nextTetherId++;
    this.rebarTethers.set(tetherId, {
      tetherId,
      jointHandle: joint.handle,
      bodyHandleA: params.bodyHandleA,
      bodyHandleB: params.bodyHandleB,
      localAnchorA: localA,
      localAnchorB: localB,
      restLengthM,
      stiffnessNPerM: stiffness,
      dampingNsPerM: damping,
      baseBreakForceN,
      maxExtensionM: 0.42,
      nodeIdA: params.nodeIdA,
      nodeIdB: params.nodeIdB,
      currentTensionN: 0,
      stressUtilization: 0,
      plasmaHeatJ: 0,
      snapped: false,
    });

    return tetherId;
  }

  private spawnSteelPlasticHingeBetweenBodies(params: {
    bond: StructuralBond;
    bodyHandleA: number;
    bodyHandleB: number;
    worldAnchor: Vec3Tuple;
    nodeIdA: number;
    nodeIdB?: number;
  }): number | null {
    if (
      params.bodyHandleA === params.bodyHandleB ||
      !this.world.bodies.contains(params.bodyHandleA) ||
      !this.world.bodies.contains(params.bodyHandleB)
    ) {
      return null;
    }

    const bodyA = this.world.getRigidBody(params.bodyHandleA);
    const bodyB = this.world.getRigidBody(params.bodyHandleB);

    const tA = bodyA.translation();
    const rA = bodyA.rotation();
    const qA: QuatTuple = [rA.x, rA.y, rA.z, rA.w];
    const localAnchorA = quatInverseRotateVec3(qA, vec3Sub(params.worldAnchor, [tA.x, tA.y, tA.z]));

    const tB = bodyB.translation();
    const rB = bodyB.rotation();
    const qB: QuatTuple = [rB.x, rB.y, rB.z, rB.w];
    const localAnchorB = quatInverseRotateVec3(qB, vec3Sub(params.worldAnchor, [tB.x, tB.y, tB.z]));

    // Ось пластического изгиба в плоскости шва
    const nodeA = this.graph.getNode(params.nodeIdA);
    const hingeAxisWorld = nodeA
      ? vec3Normalize(quatRotateVec3(nodeA.worldQuat, params.bond.tangentZLocalA), [0, 0, 1])
      : ([0, 0, 1] as Vec3);

    const localAxisA = quatInverseRotateVec3(qA, hingeAxisWorld);
    const localAxisB = quatInverseRotateVec3(qB, hingeAxisWorld);

    const jd = RAPIER.JointData.revoluteWithAxes(
      { x: localAnchorA[0], y: localAnchorA[1], z: localAnchorA[2] },
      { x: localAnchorB[0], y: localAnchorB[1], z: localAnchorB[2] },
      { x: localAxisA[0], y: localAxisA[1], z: localAxisA[2] },
      { x: localAxisB[0], y: localAxisB[1], z: localAxisB[2] },
    );

    const revJoint = this.world.createImpulseJoint(
      jd,
      bodyA,
      bodyB,
      true,
    ) as RAPIER.RevoluteImpulseJoint;
    revJoint.setContactsEnabled(false);
    revJoint.setLimits(-0.58, 0.58);

    const steelProfile = getMaterialProfile('steel');
    const wpPlastic = 1.25 * Math.max(params.bond.sectionModulusWyM3, params.bond.sectionModulusWzM3);
    const baseMomentCapacityNm =
      wpPlastic * steelProfile.tensileStrengthMPa * 1e6 * steelProfile.plasticYieldRatio;

    revJoint.configureMotorModel(RAPIER.MotorModel.ForceBased);
    revJoint.configureMotorVelocity(0, 1e5);
    revJoint.setMotorMaxForce(
      baseMomentCapacityNm * this.physicsConstants.jointStrengthMultiplier,
    );

    const hingeId = this.nextHingeId++;
    this.plasticHingeJoints.set(hingeId, {
      hingeId,
      bondId: params.bond.bondId,
      jointHandle: revJoint.handle,
      bodyHandleA: params.bodyHandleA,
      bodyHandleB: params.bodyHandleB,
      localAnchorA,
      localAnchorB,
      localAxisA,
      baseMomentCapacityNm,
      nodeIdA: params.nodeIdA,
      nodeIdB: params.nodeIdB,
      ruptured: false,
    });

    return hingeId;
  }

  private getRebarTetherWorldEndpoints(
    tether: ActiveRebarTetherRecord,
  ): { pointA: Vec3; pointB: Vec3 } | null {
    if (
      !this.world.bodies.contains(tether.bodyHandleA) ||
      !this.world.bodies.contains(tether.bodyHandleB)
    ) {
      return null;
    }
    const bA = this.world.getRigidBody(tether.bodyHandleA);
    const bB = this.world.getRigidBody(tether.bodyHandleB);
    const tA = bA.translation();
    const rA = bA.rotation();
    const tB = bB.translation();
    const rB = bB.rotation();

    const pA = vec3Add([tA.x, tA.y, tA.z], quatRotateVec3([rA.x, rA.y, rA.z, rA.w], tether.localAnchorA));
    const pB = vec3Add([tB.x, tB.y, tB.z], quatRotateVec3([rB.x, rB.y, rB.z, rB.w], tether.localAnchorB));
    return { pointA: pA, pointB: pB };
  }

  private getCounterweightCableEndpoints(
    cw: SuspendedCounterweightRecord,
  ): { anchorWorld: Vec3; attachWorld: Vec3 } | null {
    if (
      !this.world.bodies.contains(cw.anchorBodyHandle) ||
      !this.world.bodies.contains(cw.weightBodyHandle)
    ) {
      return null;
    }
    const aRb = this.world.getRigidBody(cw.anchorBodyHandle);
    const wRb = this.world.getRigidBody(cw.weightBodyHandle);
    const ta = aRb.translation();
    const ra = aRb.rotation();
    const tw = wRb.translation();
    const rw = wRb.rotation();

    const anchorWorld = vec3Add(
      [ta.x, ta.y, ta.z],
      quatRotateVec3([ra.x, ra.y, ra.z, ra.w], cw.anchorLocalOnParent),
    );
    const attachWorld = vec3Add(
      [tw.x, tw.y, tw.z],
      quatRotateVec3([rw.x, rw.y, rw.z, rw.w], cw.attachLocalOnWeight),
    );
    return { anchorWorld, attachWorld };
  }

  private collectActiveTetherViews(): TetherSegmentView[] {
    const out: TetherSegmentView[] = [];
    for (const tether of this.rebarTethers.values()) {
      if (tether.snapped) continue;
      const pts = this.getRebarTetherWorldEndpoints(tether);
      if (!pts) continue;
      out.push({
        id: tether.tetherId,
        isCounterweight: false,
        pointA: pts.pointA,
        pointB: pts.pointB,
        breakForceN: tether.baseBreakForceN * this.physicsConstants.jointStrengthMultiplier,
      });
    }
    for (const cw of this.counterweights.values()) {
      if (cw.released) continue;
      const pts = this.getCounterweightCableEndpoints(cw);
      if (!pts) continue;
      out.push({
        id: cw.triggerId,
        isCounterweight: true,
        pointA: pts.anchorWorld,
        pointB: pts.attachWorld,
        breakForceN: cw.baseBreakForceN * this.physicsConstants.jointStrengthMultiplier,
      });
    }
    return out;
  }

  private snapRebarTether(tether: ActiveRebarTetherRecord, reportedForceN: number): void {
    if (tether.snapped) return;
    const pts = this.getRebarTetherWorldEndpoints(tether);
    const snapPos: Vec3 = pts ? vec3Lerp(pts.pointA, pts.pointB, 0.5) : [0, 0, 0];

    if (this.world.impulseJoints.contains(tether.jointHandle)) {
      const j = this.world.getImpulseJoint(tether.jointHandle);
      this.world.removeImpulseJoint(j, true);
    }

    tether.snapped = true;
    tether.currentTensionN = 0;
    tether.stressUtilization = 0;
    this.snappedRebarCount++;

    this.eventBus.emit({
      type: 'rebar_snap',
      position: snapPos,
      forceN: cleanZero(Math.max(100, reportedForceN)),
    });
  }

  private releaseCounterweight(cw: SuspendedCounterweightRecord, reportedForceN?: number): void {
    if (cw.released) return;
    const pts = this.getCounterweightCableEndpoints(cw);
    const snapPos: Vec3 = pts ? vec3Lerp(pts.anchorWorld, pts.attachWorld, 0.5) : [0, 0, 0];

    if (this.world.impulseJoints.contains(cw.jointHandle)) {
      const j = this.world.getImpulseJoint(cw.jointHandle);
      this.world.removeImpulseJoint(j, true);
    }
    if (this.world.colliders.contains(cw.anchorColliderHandle)) {
      const eyeCol = this.world.getCollider(cw.anchorColliderHandle);
      this.colliderOwners.delete(cw.anchorColliderHandle);
      this.world.removeCollider(eyeCol, false);
    }
    if (this.world.bodies.contains(cw.weightBodyHandle)) {
      this.world.getRigidBody(cw.weightBodyHandle).wakeUp();
    }

    cw.released = true;
    cw.currentTensionN = 0;
    this.collapsedMassKg += cw.massKg;
    this.snappedRebarCount++;
    this.stressDirty = true;

    this.eventBus.emit({
      type: 'rebar_snap',
      position: snapPos,
      forceN: cleanZero(
        Math.max(1_000, reportedForceN ?? cw.baseBreakForceN * this.physicsConstants.jointStrengthMultiplier),
      ),
    });
  }

  private stepJointsAndTethers(): void {
    const safeStrengthMult = Math.max(0.1, this.physicsConstants.jointStrengthMultiplier);

    // 1. Опрос арматурных тяжей ЖБ RebarTether
    for (const tether of this.rebarTethers.values()) {
      if (tether.snapped) continue;
      if (
        !this.world.impulseJoints.contains(tether.jointHandle) ||
        !this.world.bodies.contains(tether.bodyHandleA) ||
        !this.world.bodies.contains(tether.bodyHandleB)
      ) {
        tether.snapped = true;
        continue;
      }

      const bA = this.world.getRigidBody(tether.bodyHandleA);
      const bB = this.world.getRigidBody(tether.bodyHandleB);
      const pts = this.getRebarTetherWorldEndpoints(tether);
      if (!pts) {
        tether.snapped = true;
        continue;
      }

      const delta = vec3Sub(pts.pointB, pts.pointA);
      const curLen = vec3Len(delta);
      const ext = curLen - tether.restLengthM;

      if (ext <= 0) {
        tether.currentTensionN = 0;
        tether.stressUtilization = 0;
        continue;
      }

      const dir = vec3Scale(delta, 1 / Math.max(1e-6, curLen));
      const vA = bA.velocityAtPoint({ x: pts.pointA[0], y: pts.pointA[1], z: pts.pointA[2] });
      const vB = bB.velocityAtPoint({ x: pts.pointB[0], y: pts.pointB[1], z: pts.pointB[2] });
      const relVelAlong =
        (vB.x - vA.x) * dir[0] + (vB.y - vA.y) * dir[1] + (vB.z - vA.z) * dir[2];

      const nodeA = tether.nodeIdA !== undefined ? this.graph.getNode(tether.nodeIdA) : undefined;
      const nodeB = tether.nodeIdB !== undefined ? this.graph.getNode(tether.nodeIdB) : undefined;
      const maxTemp = Math.max(nodeA?.temperatureC ?? 20, nodeB?.temperatureC ?? 20);
      const kThermal = computeThermalStrengthRetention('steel', maxTemp, 0);

      const breakForceN = tether.baseBreakForceN * safeStrengthMult * Math.max(0.05, kThermal);
      const tensionN = Math.max(
        0,
        tether.stiffnessNPerM * ext + tether.dampingNsPerM * Math.max(0, relVelAlong),
      );

      tether.currentTensionN = cleanZero(tensionN);
      tether.stressUtilization = cleanZero(tensionN / Math.max(1, breakForceN));

      if (tensionN >= breakForceN || ext >= tether.maxExtensionM) {
        this.snapRebarTether(tether, Math.max(tensionN, breakForceN));
      }
    }

    // 2. Опрос тросов противовесов
    for (const cw of this.counterweights.values()) {
      if (cw.released) continue;

      if (cw.anchorNodeId !== undefined) {
        const anchorNode = this.graph.getNode(cw.anchorNodeId);
        if (!anchorNode || !anchorNode.alive) {
          this.releaseCounterweight(cw);
          continue;
        }
      }

      if (
        !this.world.impulseJoints.contains(cw.jointHandle) ||
        !this.world.bodies.contains(cw.anchorBodyHandle) ||
        !this.world.bodies.contains(cw.weightBodyHandle)
      ) {
        this.releaseCounterweight(cw);
        continue;
      }

      const pts = this.getCounterweightCableEndpoints(cw);
      if (!pts) continue;
      const delta = vec3Sub(pts.attachWorld, pts.anchorWorld);
      const curLen = vec3Len(delta);
      const ext = Math.max(0, curLen - cw.restLengthM);
      const aRb = this.world.getRigidBody(cw.anchorBodyHandle);
      const wRb = this.world.getRigidBody(cw.weightBodyHandle);
      const dir = vec3Scale(delta, 1 / Math.max(1e-6, curLen));
      const vA = aRb.velocityAtPoint({
        x: pts.anchorWorld[0],
        y: pts.anchorWorld[1],
        z: pts.anchorWorld[2],
      });
      const vW = wRb.velocityAtPoint({
        x: pts.attachWorld[0],
        y: pts.attachWorld[1],
        z: pts.attachWorld[2],
      });
      const relVel = (vW.x - vA.x) * dir[0] + (vW.y - vA.y) * dir[1] + (vW.z - vA.z) * dir[2];
      const tensionN = Math.max(0, cw.stiffnessNPerM * ext + cw.dampingNsPerM * Math.max(0, relVel));
      cw.currentTensionN = cleanZero(tensionN);

      const breakLimitN = cw.baseBreakForceN * safeStrengthMult;
      if (tensionN >= breakLimitN) {
        this.releaseCounterweight(cw, tensionN);
      }
    }

    // 3. Обновление температурного ослабления и разрыва динамических пластических шарниров стали
    for (const hinge of this.plasticHingeJoints.values()) {
      if (hinge.ruptured) continue;
      if (
        !this.world.impulseJoints.contains(hinge.jointHandle) ||
        !this.world.bodies.contains(hinge.bodyHandleA) ||
        !this.world.bodies.contains(hinge.bodyHandleB)
      ) {
        hinge.ruptured = true;
        continue;
      }

      const bA = this.world.getRigidBody(hinge.bodyHandleA);
      const bB = this.world.getRigidBody(hinge.bodyHandleB);
      const rA = bA.rotation();
      const rB = bB.rotation();
      const qA: QuatTuple = [rA.x, rA.y, rA.z, rA.w];
      const qB: QuatTuple = [rB.x, rB.y, rB.z, rB.w];
      const qRel = quatMultiply(quatConjugate(qA), qB);
      const relAngleRad = 2 * Math.acos(clamp(Math.abs(qRel[3]), 0, 1));

      const bond = this.graph.getBond(hinge.bondId);
      if (bond && relAngleRad > bond.plasticAngleRad) {
        bond.plasticAngleRad = cleanZero(relAngleRad);
      }

      const nA = this.graph.getNode(hinge.nodeIdA);
      const nB = hinge.nodeIdB !== undefined ? this.graph.getNode(hinge.nodeIdB) : undefined;
      const maxTemp = Math.max(nA?.temperatureC ?? 20, nB?.temperatureC ?? 20);
      const kThermal = computeThermalStrengthRetention('steel', maxTemp, 0);

      const joint = this.world.getImpulseJoint(hinge.jointHandle) as RAPIER.RevoluteImpulseJoint;
      joint.setMotorMaxForce(
        hinge.baseMomentCapacityNm * safeStrengthMult * Math.max(0.03, kThermal),
      );

      if (relAngleRad >= 0.54) {
        this.world.removeImpulseJoint(joint, true);
        hinge.ruptured = true;
      }
    }
  }

  // ==========================================================================
  // Раскол Вороного, локальный пролом стен и вторичный кинетический урон
  // ==========================================================================

  private processFractureQueue(requests: readonly FractureRequest[], alreadyUsed: number): number {
    let executed = 0;
    const processedNodeIds = new Set<number>();

    for (let i = 0; i < requests.length; i++) {
      if (alreadyUsed + executed >= MAX_FRACTURES_PER_TICK) {
        break;
      }
      const req = requests[i]!;
      if (processedNodeIds.has(req.nodeId)) continue;
      processedNodeIds.add(req.nodeId);

      if (this.executeFractureOnNode(req)) {
        executed++;
      }
    }

    return executed;
  }

  private executeFractureOnNode(req: FractureRequest): boolean {
    const node = this.graph.getNode(req.nodeId);
    if (!node || !node.alive || node.isCounterweight) {
      return false;
    }

    const parentIslandId = node.islandId;
    const parentIsland = parentIslandId > 0 ? this.islands.get(parentIslandId) : undefined;
    let inheritedLinVel: Vec3 = [0, 0, 0];
    let inheritedAngVel: Vec3 = [0, 0, 0];
    let parentCom: Vec3 = node.worldPos;

    if (parentIsland && this.world.bodies.contains(parentIsland.bodyHandle)) {
      const pRb = this.world.getRigidBody(parentIsland.bodyHandle);
      const lv = pRb.linvel();
      const av = pRb.angvel();
      const tr = pRb.translation();
      inheritedLinVel = [lv.x, lv.y, lv.z];
      inheritedAngVel = [av.x, av.y, av.z];
      parentCom = [tr.x, tr.y, tr.z];
    }

    const impactLocal = quatInverseRotateVec3(
      node.worldQuat,
      vec3Sub(req.impactPointWorld, node.worldPos),
    );

    const activeShardCountNow = this.countActiveDynamicShards();
    const headroom = Math.max(2, this.maxActiveShards - activeShardCountNow);
    const profile = getMaterialProfile(node.materialId);
    const baseShardTarget =
      node.materialId === 'glass'
        ? 10
        : node.materialId === 'brick'
          ? 8
          : node.materialId === 'wood'
            ? 7
            : 6;
    const desiredShards = clamp(Math.min(baseShardTarget, Math.ceil(headroom * 0.25) + 3), 3, 14);
    const fracSeed = this.rng.nextUint32();

    // Удаляем старый коллайдер узла из Rapier3D
    if (node.colliderHandle !== -1 && this.world.colliders.contains(node.colliderHandle)) {
      const oldCol = this.world.getCollider(node.colliderHandle);
      this.colliderOwners.delete(node.colliderHandle);
      this.world.removeCollider(oldCol, true);
      node.colliderHandle = -1;
    }

    // Вариант А: локальный сквозной/кратерный пролом широкой стены или плиты в закреплённом монолите
    if (req.preferLocalBreach && parentIslandId === 0) {
      const breachRes = carveLocalBreach3D({
        polyhedron: node.polyhedron,
        materialId: node.materialId,
        worldPosition: node.worldPos,
        worldQuaternion: node.worldQuat,
        impactPointLocal: impactLocal,
        breachRadiusM: req.breachRadiusM,
        shardCount: Math.max(3, Math.round(desiredShards * 0.75)),
        seed: fracSeed,
      });

      if (breachRes.isLocalBreach && breachRes.survivingPieces.length > 0) {
        const monolithRb = this.world.getRigidBody(this.monolithBodyHandle);
        const rep = this.graph.replaceNodeWithBreachPieces(
          node,
          breachRes.survivingPieces,
          this.seismic.getPlatformOffset(),
        );
        this.brokenJointCount += rep.brokenParentBondsCount;

        for (let p = 0; p < rep.pieceNodes.length; p++) {
          this.attachNodeColliderToMonolith(rep.pieceNodes[p]!, monolithRb);
        }

        const spawnedHandles = this.spawnDynamicVoronoiShards({
          shards: breachRes.breachShards,
          parentNode: node,
          inheritedLinVel,
          inheritedAngVel,
          parentCom,
          impactPointWorld: req.impactPointWorld,
          impulseDirWorld: req.impulseDirWorld,
          impulseMagnitudeNs: req.impulseMagnitudeNs,
        });

        // Для ЖБ связываем 1-2 выбитых осколка пролома с выжившей стеной арматурными тяжами RebarTether!
        if (profile.hasRebarTethers && spawnedHandles.length > 0 && rep.pieceNodes.length > 0) {
          const firstShard = this.shards.get(spawnedHandles[0]!);
          if (firstShard && firstShard.massKg >= 15) {
            this.spawnRebarTetherBetweenBodies({
              bodyHandleA: this.monolithBodyHandle,
              bodyHandleB: firstShard.bodyHandle,
              worldAnchor: vec3Lerp(rep.pieceNodes[0]!.worldPos, firstShard.position, 0.5),
              bondAreaM2: Math.max(0.08, Math.pow(firstShard.polyhedron.volumeM3, 2 / 3)),
              reducedMassKg: firstShard.massKg,
              nodeIdA: rep.pieceNodes[0]!.nodeId,
            });
          }
        }

        let coreMass = 0;
        for (let s = 0; s < breachRes.breachShards.length; s++) {
          coreMass += breachRes.breachShards[s]!.massKg;
        }
        this.collapsedMassKg += coreMass;

        this.eventBus.emit({
          type: 'fracture',
          position: [req.impactPointWorld[0], req.impactPointWorld[1], req.impactPointWorld[2]],
          materialId: node.materialId,
          energyJ: cleanZero(Math.max(1, req.energyJ)),
          shardCount: breachRes.breachShards.length,
        });

        this.world.propagateModifiedBodyPositionsToColliders();
        return true;
      }
    }

    // Вариант Б: полный анизотропный 3D-раскол Вороного всего узла
    node.alive = false;
    let newlyBrokenNodeBonds = 0;
    let neighborMonolithNode: StructuralNode | undefined;

    for (let i = 0; i < node.adjacencyBondIds.length; i++) {
      const bond = this.graph.getBond(node.adjacencyBondIds[i]!);
      if (!bond) continue;
      if (!bond.broken) {
        bond.broken = true;
        bond.integrity = 0;
        newlyBrokenNodeBonds++;
      }
      if (bond.nodeIdB !== -1) {
        const otherId = bond.nodeIdA === node.nodeId ? bond.nodeIdB : bond.nodeIdA;
        const other = this.graph.getNode(otherId);
        if (other && other.alive && other.islandId === 0) {
          neighborMonolithNode = other;
        }
      }
    }
    this.brokenJointCount += newlyBrokenNodeBonds;

    if (parentIslandId === 0) {
      this.collapsedMassKg += node.massKg;
    }

    const vorRes = fracturePolyhedronVoronoi3D({
      polyhedron: node.polyhedron,
      materialId: node.materialId,
      worldPosition: node.worldPos,
      worldQuaternion: node.worldQuat,
      impactPointLocal: impactLocal,
      shardCount: desiredShards,
      seed: fracSeed,
    });

    const spawnedShardIds = this.spawnDynamicVoronoiShards({
      shards: vorRes.shards,
      parentNode: node,
      inheritedLinVel,
      inheritedAngVel,
      parentCom,
      impactPointWorld: req.impactPointWorld,
      impulseDirWorld: req.impulseDirWorld,
      impulseMagnitudeNs: req.impulseMagnitudeNs,
    });

    // Для ЖБ создаём реальные физические арматурные тяжи RebarTether между крупными осколками и опорой!
    if (profile.hasRebarTethers && spawnedShardIds.length >= 2) {
      const sh0 = this.shards.get(spawnedShardIds[0]!);
      const sh1 = this.shards.get(spawnedShardIds[1]!);
      if (sh0 && sh1) {
        this.spawnRebarTetherBetweenBodies({
          bodyHandleA: sh0.bodyHandle,
          bodyHandleB: sh1.bodyHandle,
          worldAnchor: vec3Lerp(sh0.position, sh1.position, 0.5),
          bondAreaM2: Math.max(0.08, Math.pow(sh0.polyhedron.volumeM3, 2 / 3)),
          reducedMassKg: (sh0.massKg * sh1.massKg) / Math.max(1, sh0.massKg + sh1.massKg),
        });
      }
      if (sh0 && (node.grounded || neighborMonolithNode)) {
        const anchorPt: Vec3 = neighborMonolithNode
          ? vec3Lerp(neighborMonolithNode.worldPos, sh0.position, 0.5)
          : [sh0.position[0], Math.max(0.05, sh0.position[1] - node.halfExtents[1]), sh0.position[2]];
        this.spawnRebarTetherBetweenBodies({
          bodyHandleA: this.monolithBodyHandle,
          bodyHandleB: sh0.bodyHandle,
          worldAnchor: anchorPt,
          bondAreaM2: Math.max(0.1, Math.pow(sh0.polyhedron.volumeM3, 2 / 3)),
          reducedMassKg: sh0.massKg,
          nodeIdA: neighborMonolithNode?.nodeId,
        });
      }
    }

    // Если разрушенный узел входил в динамический остров, проверяем распад острова на части
    if (parentIsland) {
      this.reconcileDamagedDynamicIsland(parentIsland, inheritedLinVel, inheritedAngVel);
    }

    // Если на этом узле крепился трос противовеса — освобождаем противовес
    for (const cw of this.counterweights.values()) {
      if (!cw.released && cw.anchorNodeId === node.nodeId) {
        this.releaseCounterweight(cw);
      }
    }

    this.eventBus.emit({
      type: 'fracture',
      position: [req.impactPointWorld[0], req.impactPointWorld[1], req.impactPointWorld[2]],
      materialId: node.materialId,
      energyJ: cleanZero(Math.max(1, req.energyJ)),
      shardCount: vorRes.shards.length,
    });

    this.world.propagateModifiedBodyPositionsToColliders();
    return true;
  }

  private reconcileDamagedDynamicIsland(
    island: DetachedIsland,
    linVel: Vec3,
    angVel: Vec3,
  ): void {
    const subComps = this.graph.findIslandSubcomponents(island.islandId, island.nodeIds);
    if (subComps.length === 0) {
      if (this.world.bodies.contains(island.bodyHandle)) {
        this.world.removeRigidBody(this.world.getRigidBody(island.bodyHandle));
      }
      this.islands.delete(island.islandId);
      return;
    }

    island.nodeIds = subComps[0]!;
    if (subComps.length === 1) {
      return;
    }

    // Отделившиеся подкомпоненты переносим в собственные динамические тела с сохранением скорости
    for (let s = 1; s < subComps.length; s++) {
      const subIds = subComps[s]!;
      let subMass = 0;
      let cx = 0;
      let cy = 0;
      let cz = 0;
      const subNodes: StructuralNode[] = [];
      for (let i = 0; i < subIds.length; i++) {
        const n = this.graph.getNode(subIds[i]!);
        if (!n || !n.alive) continue;
        subNodes.push(n);
        subMass += n.massKg;
        cx += n.massKg * n.worldPos[0];
        cy += n.massKg * n.worldPos[1];
        cz += n.massKg * n.worldPos[2];
      }
      if (subNodes.length === 0 || subMass <= 0) continue;
      const subCom: Vec3 = [cx / subMass, cy / subMass, cz / subMass];
      const newIslId = this.nextIslandId++;
      const newRb = this.world.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic()
          .setTranslation(subCom[0], subCom[1], subCom[2])
          .setLinvel(linVel[0], linVel[1], linVel[2])
          .setAngvel(angVel[0], angVel[1], angVel[2])
          .setLinearDamping(0.06)
          .setAngularDamping(0.18),
      );

      for (let i = 0; i < subNodes.length; i++) {
        const n = subNodes[i]!;
        if (n.colliderHandle !== -1 && this.world.colliders.contains(n.colliderHandle)) {
          this.colliderOwners.delete(n.colliderHandle);
          this.world.removeCollider(this.world.getCollider(n.colliderHandle), false);
        }
        const localOff = vec3Sub(n.worldPos, subCom);
        n.localIslandOffset = localOff;
        n.localIslandQuat = [n.worldQuat[0], n.worldQuat[1], n.worldQuat[2], n.worldQuat[3]];
        n.islandId = newIslId;

        const profile = getMaterialProfile(n.materialId);
        const colDesc = createColliderDescForPolyhedron(n.polyhedron, n.isBox, n.halfExtents)
          .setTranslation(localOff[0], localOff[1], localOff[2])
          .setRotation({
            x: n.localIslandQuat[0],
            y: n.localIslandQuat[1],
            z: n.localIslandQuat[2],
            w: n.localIslandQuat[3],
          })
          .setDensity(profile.densityKgM3)
          .setFriction(profile.friction)
          .setRestitution(profile.restitution)
          .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS)
          .setContactForceEventThreshold(400);
        const col = this.world.createCollider(colDesc, newRb);
        n.colliderHandle = col.handle;
        this.colliderOwners.set(col.handle, { kind: 'node', nodeId: n.nodeId });
      }

      this.islands.set(newIslId, {
        islandId: newIslId,
        bodyHandle: newRb.handle,
        nodeIds: subNodes.map((n) => n.nodeId),
        totalMassKg: subMass,
        comWorldAtSpawn: subCom,
      });
    }
  }

  private spawnDynamicVoronoiShards(params: {
    shards: readonly VoronoiShard3D[];
    parentNode: StructuralNode;
    inheritedLinVel: Vec3;
    inheritedAngVel: Vec3;
    parentCom: Vec3;
    impactPointWorld: Vec3Tuple;
    impulseDirWorld: Vec3Tuple;
    impulseMagnitudeNs: number;
  }): number[] {
    const {
      shards,
      parentNode,
      inheritedLinVel,
      inheritedAngVel,
      parentCom,
      impactPointWorld,
      impulseDirWorld,
      impulseMagnitudeNs,
    } = params;

    const profile = getMaterialProfile(parentNode.materialId);
    const createdIds: number[] = [];
    const totalMass = Math.max(
      1,
      shards.reduce((acc, s) => acc + s.massKg, 0),
    );

    for (let i = 0; i < shards.length; i++) {
      const sh = shards[i]!;
      const localPoly: ConvexPolyhedron3DData = {
        ...sh.polyhedron,
        centroid: [0, 0, 0],
      };

      const rArm = vec3Sub(sh.worldPosition, parentCom);
      const tangVel = vec3Cross(inheritedAngVel, rArm);
      const baseVel = vec3Add(inheritedLinVel, tangVel);

      // Радиальный и направленный разлёт от точки удара/взрыва с зажимом от нереалистичного гиперзвука
      const radialVec = vec3Sub(sh.worldPosition, impactPointWorld);
      const radialDir = vec3Normalize(
        vec3Add(vec3Normalize(radialVec, impulseDirWorld), vec3Scale(impulseDirWorld, 0.75)),
        [0, 1, 0],
      );
      const shareImpulse = impulseMagnitudeNs * (sh.massKg / totalMass);
      const deltaSpeed = Math.min(26, shareImpulse / Math.max(0.5, sh.massKg));
      const initVel = vec3AddScaled(baseVel, radialDir, deltaSpeed);

      const rbDesc = RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(sh.worldPosition[0], sh.worldPosition[1], sh.worldPosition[2])
        .setRotation({
          x: parentNode.worldQuat[0],
          y: parentNode.worldQuat[1],
          z: parentNode.worldQuat[2],
          w: parentNode.worldQuat[3],
        })
        .setLinvel(initVel[0], initVel[1], initVel[2])
        .setAngvel(
          inheritedAngVel[0] + this.rng.range(-1.8, 1.8),
          inheritedAngVel[1] + this.rng.range(-1.8, 1.8),
          inheritedAngVel[2] + this.rng.range(-1.8, 1.8),
        )
        .setLinearDamping(0.08)
        .setAngularDamping(0.22);

      const rb = this.world.createRigidBody(rbDesc);
      const colDesc = createColliderDescForPolyhedron(
        localPoly,
        false,
        localPoly.halfExtentsApprox,
      )
        .setDensity(profile.densityKgM3)
        .setFriction(profile.friction)
        .setRestitution(profile.restitution)
        .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS)
        .setContactForceEventThreshold(600);

      const col = this.world.createCollider(colDesc, rb);
      const shardId = this.nextShardId++;
      this.colliderOwners.set(col.handle, { kind: 'shard', shardId });

      this.shards.set(shardId, {
        shardId,
        materialId: parentNode.materialId,
        polyhedron: localPoly,
        rebarStubs: sh.rebarStubs,
        massKg: sh.massKg,
        bodyHandle: rb.handle,
        colliderHandle: col.handle,
        position: [sh.worldPosition[0], sh.worldPosition[1], sh.worldPosition[2]],
        quaternion: [
          parentNode.worldQuat[0],
          parentNode.worldQuat[1],
          parentNode.worldQuat[2],
          parentNode.worldQuat[3],
        ],
        temperatureC: parentNode.temperatureC,
        charRatio: parentNode.charRatio,
        calmTicks: 0,
        spawnTick: this.tick,
        baked: false,
        countsTowardTargetMass: parentNode.structureGroupTag === 'target',
      });

      createdIds.push(shardId);
    }

    return createdIds;
  }

  /**
   * Обрабатывает контактные ударные силы падающих секций, противовесов и глыб (F07: вторичный кинетический урон).
   */
  private processSecondaryImpacts(
    samples: readonly RawContactForceSample[],
    preStepVelocities: ReadonlyMap<number, { vel: Vec3; mass: number }>,
    outFractureQueue: FractureRequest[],
  ): void {
    const mult = this.physicsConstants.secondaryDamageMultiplier;
    if (mult <= 0) {
      return;
    }

    for (let i = 0; i < samples.length; i++) {
      const s = samples[i]!;
      const o1 = this.colliderOwners.get(s.c1);
      const o2 = this.colliderOwners.get(s.c2);
      if (!o1 || !o2) continue;
      if (o1.kind === 'projectile' || o2.kind === 'projectile') continue;
      if (o1.kind === 'anchor' || o2.kind === 'anchor') continue;
      if (!this.world.colliders.contains(s.c1) || !this.world.colliders.contains(s.c2)) continue;

      const col1 = this.world.getCollider(s.c1);
      const col2 = this.world.getCollider(s.c2);
      const rb1 = col1.parent();
      const rb2 = col2.parent();
      if (!rb1 || !rb2 || rb1.handle === rb2.handle) continue;

      const dyn1 = rb1.isDynamic();
      const dyn2 = rb2.isDynamic();
      if (!dyn1 && !dyn2) continue;

      // Кулдаун на пару тел (4 тика), чтобы лежащая глыба не спамила ударными событиями каждый кадр
      const loRb = Math.min(rb1.handle, rb2.handle);
      const hiRb = Math.max(rb1.handle, rb2.handle);
      const pairKey = `${loRb}:${hiRb}`;
      const prevImpactTick = this.bodyImpactCooldownTick.get(pairKey) ?? -99;
      if (this.tick - prevImpactTick < 4) {
        continue;
      }

      const pre1 = preStepVelocities.get(rb1.handle);
      const pre2 = preStepVelocities.get(rb2.handle);
      const v1: Vec3 = pre1 ? pre1.vel : [0, 0, 0];
      const v2: Vec3 = pre2 ? pre2.vel : [0, 0, 0];
      const m1 = dyn1 ? (pre1 ? pre1.mass : Math.max(1, rb1.mass())) : 1e9;
      const m2 = dyn2 ? (pre2 ? pre2.mass : Math.max(1, rb2.mass())) : 1e9;

      const p1 = col1.translation();
      const p2 = col2.translation();
      const pos1: Vec3 = [p1.x, p1.y, p1.z];
      const pos2: Vec3 = [p2.x, p2.y, p2.z];
      const relVel = vec3Sub(v1, v2);
      const relSpeed = vec3Len(relVel);

      // Отсекаем спокойное покоящееся трение (требуем ощутимую скорость удара >= 1.65 м/с)
      if (relSpeed < 1.65) {
        continue;
      }

      const reducedMass = (m1 * m2) / Math.max(1, m1 + m2);
      const rawImpulseNs = Math.max(s.totalForce * FIXED_DT * 0.45, reducedMass * relSpeed);
      const effectiveImpulseNs = mult * rawImpulseNs;

      if (effectiveImpulseNs < 900) {
        continue;
      }

      this.bodyImpactCooldownTick.set(pairKey, this.tick);

      const impactPos = vec3Lerp(pos1, pos2, 0.5);
      const impactDir1To2 = vec3Normalize(relVel, [0, -1, 0]);
      const strikerMassKg = dyn1 && dyn2 ? Math.max(m1, m2) : dyn1 ? m1 : m2;

      const node1 = o1.kind === 'node' ? this.graph.getNode(o1.nodeId) : undefined;
      const node2 = o2.kind === 'node' ? this.graph.getNode(o2.nodeId) : undefined;
      const shard1 = o1.kind === 'shard' ? this.shards.get(o1.shardId) : undefined;
      const shard2 = o2.kind === 'shard' ? this.shards.get(o2.shardId) : undefined;

      const reportedMat: StructuralMaterialId =
        node2?.materialId ??
        node1?.materialId ??
        shard2?.materialId ??
        shard1?.materialId ??
        'reinforced_concrete';
      const targetTag =
        node2 && !node2.isCounterweight
          ? node2.structureGroupTag
          : node1 && !node1.isCounterweight
            ? node1.structureGroupTag
            : 'ground';

      this.secondaryImpactsCount++;
      this.eventBus.emit({
        type: 'secondary_impact',
        position: impactPos,
        materialId: reportedMat,
        impulseNs: cleanZero(effectiveImpulseNs),
        massKg: cleanZero(Math.min(1e6, strikerMassKg)),
        targetTag,
      });

      const kineticImpactEnergyJ = 0.5 * reducedMass * relSpeed * relSpeed * mult;

      // Применяем вторичный кинетический урон к обоим вовлечённым конструктивным узлам
      if (node1 && node1.alive && !node1.isCounterweight) {
        this.applySecondaryImpactToNode(
          node1,
          impactPos,
          vec3Scale(impactDir1To2, -1),
          effectiveImpulseNs,
          kineticImpactEnergyJ,
          outFractureQueue,
        );
      }
      if (node2 && node2.alive && !node2.isCounterweight) {
        this.applySecondaryImpactToNode(
          node2,
          impactPos,
          impactDir1To2,
          effectiveImpulseNs,
          kineticImpactEnergyJ,
          outFractureQueue,
        );
      }

      // Если падающий многотонный противовес или глыба проломили тонкое перекрытие внизу,
      // частично сохраняем им вертикальный импульс пробоя, чтобы груз продолжил крушить нижние ярусы!
      if (
        (node1?.isCounterweight && node2 && !node2.alive) ||
        (node2?.isCounterweight && node1 && !node1.alive)
      ) {
        const cwRb = node1?.isCounterweight ? rb1 : rb2;
        const cwPre = preStepVelocities.get(cwRb.handle);
        if (cwPre) {
          cwRb.setLinvel(
            { x: cwPre.vel[0] * 0.85, y: cwPre.vel[1] * 0.82, z: cwPre.vel[2] * 0.85 },
            true,
          );
        }
      }
    }
  }

  private applySecondaryImpactToNode(
    node: StructuralNode,
    impactPos: Vec3,
    dirIntoNode: Vec3,
    effectiveImpulseNs: number,
    impactEnergyJ: number,
    outFractureQueue: FractureRequest[],
  ): void {
    if (node.materialId === 'explosive' && effectiveImpulseNs >= 2_500) {
      if (this.ballistics.triggerExplosiveNodeDetonation(node, 0, true)) {
        this.detonatedExplosivesCount++;
      }
      outFractureQueue.push({
        nodeId: node.nodeId,
        impactPointWorld: impactPos,
        impulseDirWorld: dirIntoNode,
        impulseMagnitudeNs: effectiveImpulseNs,
        energyJ: impactEnergyJ,
        preferLocalBreach: false,
        breachRadiusM: 0.7,
      });
      return;
    }

    const profile = getMaterialProfile(node.materialId);
    const kThermal = computeThermalStrengthRetention(
      node.materialId,
      node.temperatureC,
      node.charRatio,
    );
    const resistJ =
      Math.max(800, node.volumeM3 * profile.compressiveStrengthMPa * 1_650) *
      Math.max(0.08, kThermal) *
      Math.max(0.1, this.physicsConstants.jointStrengthMultiplier);

    const dmgDelta = clamp(impactEnergyJ / resistJ, 0, 2.0);
    node.damageRatio = cleanZero(clamp(node.damageRatio + dmgDelta * 0.75, 0, 1));

    for (let i = 0; i < node.adjacencyBondIds.length; i++) {
      const bond = this.graph.getBond(node.adjacencyBondIds[i]!);
      if (!bond || bond.broken) continue;
      bond.integrity = cleanZero(Math.max(0, bond.integrity - dmgDelta * 0.6));
      bond.dirtyStiffness = true;
      if (bond.integrity <= 0.04) {
        bond.broken = true;
        bond.integrity = 0;
        this.brokenJointCount++;
      }
    }

    if (node.islandId === 0) {
      node.pendingImpulseNs = vec3AddScaled(node.pendingImpulseNs, dirIntoNode, effectiveImpulseNs * 0.55);
      this.stressDirty = true;
    }

    if (node.damageRatio >= 0.96 || dmgDelta >= 1.0) {
      const spans = [
        node.halfExtents[0] * 2,
        node.halfExtents[1] * 2,
        node.halfExtents[2] * 2,
      ].sort((a, b) => b - a);
      outFractureQueue.push({
        nodeId: node.nodeId,
        impactPointWorld: impactPos,
        impulseDirWorld: dirIntoNode,
        impulseMagnitudeNs: effectiveImpulseNs * 0.45,
        energyJ: impactEnergyJ,
        preferLocalBreach: spans[0]! >= 2.2 && node.materialId !== 'glass' && dmgDelta < 1.8,
        breachRadiusM: 0.85,
      });
    }
  }

  // ==========================================================================
  // Контроль бюджета активных осколков и запекание спящих обломков
  // ==========================================================================

  private countActiveDynamicShards(): number {
    let count = 0;
    for (const sh of this.shards.values()) {
      if (!sh.baked) {
        count++;
      }
    }
    return count;
  }

  private hasActiveJointOnBody(bodyHandle: number): boolean {
    for (const t of this.rebarTethers.values()) {
      if (!t.snapped && (t.bodyHandleA === bodyHandle || t.bodyHandleB === bodyHandle)) {
        return true;
      }
    }
    return false;
  }

  private bakeSingleShard(sh: DynamicShardRecord): void {
    if (sh.baked) return;

    if (this.world.bodies.contains(sh.bodyHandle)) {
      const rb = this.world.getRigidBody(sh.bodyHandle);
      const t = rb.translation();
      const r = rb.rotation();
      sh.position = [cleanZero(t.x), cleanZero(t.y), cleanZero(t.z)];
      sh.quaternion = quatNormalize([r.x, r.y, r.z, r.w]);
      this.colliderOwners.delete(sh.colliderHandle);
      this.world.removeRigidBody(rb);
    }

    const bakedRb = this.world.getRigidBody(this.bakedRubbleBodyHandle);
    const profile = getMaterialProfile(sh.materialId);
    const colDesc = createColliderDescForPolyhedron(
      sh.polyhedron,
      false,
      sh.polyhedron.halfExtentsApprox,
    )
      .setTranslation(sh.position[0], sh.position[1], sh.position[2])
      .setRotation({
        x: sh.quaternion[0],
        y: sh.quaternion[1],
        z: sh.quaternion[2],
        w: sh.quaternion[3],
      })
      .setFriction(profile.friction)
      .setRestitution(profile.restitution * 0.5);

    const newCol = this.world.createCollider(colDesc, bakedRb);
    sh.colliderHandle = newCol.handle;
    sh.bodyHandle = this.bakedRubbleBodyHandle;
    sh.baked = true;
    this.colliderOwners.set(newCol.handle, { kind: 'shard', shardId: sh.shardId });
    this.bakedRubbleCount++;
  }

  private enforceShardBudgetAndBakeCalmRubble(): void {
    const activeDynamic: DynamicShardRecord[] = [];
    const bakedList: DynamicShardRecord[] = [];

    for (const sh of this.shards.values()) {
      if (sh.baked) {
        bakedList.push(sh);
        continue;
      }
      if (!this.world.bodies.contains(sh.bodyHandle)) {
        this.colliderOwners.delete(sh.colliderHandle);
        this.shards.delete(sh.shardId);
        continue;
      }

      const rb = this.world.getRigidBody(sh.bodyHandle);
      if (sh.position[1] < -30) {
        this.colliderOwners.delete(sh.colliderHandle);
        this.world.removeRigidBody(rb);
        this.shards.delete(sh.shardId);
        continue;
      }

      const lv = rb.linvel();
      const av = rb.angvel();
      const linSpeed = Math.hypot(lv.x, lv.y, lv.z);
      const angSpeed = Math.hypot(av.x, av.y, av.z);

      const isCalm = rb.isSleeping() || (linSpeed < 0.14 && angSpeed < 0.22);
      if (isCalm && !this.seismic.isActive()) {
        sh.calmTicks++;
      } else {
        sh.calmTicks = 0;
      }

      if (
        (rb.isSleeping() || sh.calmTicks >= CALM_TICKS_TO_BAKE) &&
        !this.hasActiveJointOnBody(sh.bodyHandle)
      ) {
        this.bakeSingleShard(sh);
        bakedList.push(sh);
      } else {
        activeDynamic.push(sh);
      }
    }

    // Принудительное запекание самых старых и медленных мелких осколков сверх лимита maxActiveShards
    if (activeDynamic.length > this.maxActiveShards) {
      const overflow = activeDynamic.length - this.maxActiveShards;
      activeDynamic.sort((a, b) => {
        const aJoint = this.hasActiveJointOnBody(a.bodyHandle) ? 1 : 0;
        const bJoint = this.hasActiveJointOnBody(b.bodyHandle) ? 1 : 0;
        if (aJoint !== bJoint) return aJoint - bJoint;
        if (a.spawnTick !== b.spawnTick) return a.spawnTick - b.spawnTick;
        return a.massKg - b.massKg;
      });
      for (let i = 0; i < overflow; i++) {
        const victim = activeDynamic[i]!;
        if (this.hasActiveJointOnBody(victim.bodyHandle)) continue;
        this.bakeSingleShard(victim);
        bakedList.push(victim);
      }
    }

    // Ограничение верхнего потолка запечённых осколков, чтобы не раздувать статический BVH при бесконечной игре
    if (bakedList.length > MAX_BAKED_RUBBLE_SHARDS) {
      bakedList.sort((a, b) => a.massKg - b.massKg || a.shardId - b.shardId);
      const dropCount = bakedList.length - MAX_BAKED_RUBBLE_SHARDS;
      for (let i = 0; i < dropCount; i++) {
        const old = bakedList[i]!;
        if (this.world.colliders.contains(old.colliderHandle)) {
          this.world.removeCollider(this.world.getCollider(old.colliderHandle), false);
        }
        this.colliderOwners.delete(old.colliderHandle);
        this.shards.delete(old.shardId);
      }
    }
  }

  // ==========================================================================
  // Снимки рендера (RenderSnapshot) и телеметрия (SimulationTelemetry)
  // ==========================================================================

  public getCollapsedMassKg(): number {
    return cleanZero(Math.max(0, this.collapsedMassKg));
  }

  public getRenderSnapshot(): RenderSnapshot {
    this.ensureNotDisposed();
    const platformOffset = this.seismic.getPlatformOffset();

    const blocks: RenderBlockInstance[] = [];
    for (const n of this.graph.getNodesMap().values()) {
      if (!n.alive) continue;
      blocks.push({
        nodeId: n.nodeId,
        materialId: n.materialId,
        position: [n.worldPos[0], n.worldPos[1], n.worldPos[2]],
        quaternion: [n.worldQuat[0], n.worldQuat[1], n.worldQuat[2], n.worldQuat[3]],
        halfExtents: [n.halfExtents[0], n.halfExtents[1], n.halfExtents[2]],
        stressUtilization: cleanZero(Math.max(0, n.stressUtilization)),
        damageRatio: cleanZero(clamp(n.damageRatio, 0, 1)),
        temperatureC: cleanZero(n.temperatureC),
        charRatio: cleanZero(clamp(n.charRatio, 0, 1)),
        burning: n.burning,
        structureGroupTag: n.structureGroupTag,
      });
    }

    const shardsOut: RenderShardInstance[] = [];
    for (const sh of this.shards.values()) {
      let sleeping = sh.baked;
      if (!sh.baked && this.world.bodies.contains(sh.bodyHandle)) {
        sleeping = this.world.getRigidBody(sh.bodyHandle).isSleeping() || sh.calmTicks >= 20;
      }
      shardsOut.push({
        shardId: sh.shardId,
        materialId: sh.materialId,
        polyhedron: sh.polyhedron,
        position: [sh.position[0], sh.position[1], sh.position[2]],
        quaternion: [sh.quaternion[0], sh.quaternion[1], sh.quaternion[2], sh.quaternion[3]],
        temperatureC: cleanZero(sh.temperatureC),
        charRatio: cleanZero(sh.charRatio),
        sleeping,
        rebarStubs: sh.rebarStubs,
      });
    }

    const bondsAndRebars: RenderBondOrRebarLine[] = [];
    for (const bond of this.graph.getBondsMap().values()) {
      if (bond.broken) continue;
      const nodeA = this.graph.getNode(bond.nodeIdA);
      if (!nodeA || !nodeA.alive) continue;
      if (bond.nodeIdB !== -1) {
        const nodeB = this.graph.getNode(bond.nodeIdB);
        if (!nodeB || !nodeB.alive) continue;
      }
      const pts = this.graph.getBondWorldPoints(bond, platformOffset);
      bondsAndRebars.push({
        id: bond.bondId,
        kind: bond.isPlasticHinge ? 'plastic_hinge' : 'bond',
        pointA: pts.pointA,
        pointB: pts.pointB,
        stressUtilization: cleanZero(Math.max(0, bond.stressUtilization)),
        axialForceN: cleanZero(bond.axialForceN),
        broken: false,
      });
    }

    for (const tether of this.rebarTethers.values()) {
      if (tether.snapped) continue;
      const pts = this.getRebarTetherWorldEndpoints(tether);
      if (!pts) continue;
      bondsAndRebars.push({
        id: 100_000 + tether.tetherId,
        kind: 'rebar',
        pointA: pts.pointA,
        pointB: pts.pointB,
        stressUtilization: cleanZero(Math.max(0, tether.stressUtilization)),
        axialForceN: cleanZero(tether.currentTensionN),
        broken: false,
      });
    }

    for (const cw of this.counterweights.values()) {
      if (cw.released) continue;
      const pts = this.getCounterweightCableEndpoints(cw);
      if (!pts) continue;
      const util =
        cw.currentTensionN /
        Math.max(1, cw.baseBreakForceN * this.physicsConstants.jointStrengthMultiplier);
      bondsAndRebars.push({
        id: 200_000 + cw.triggerId,
        kind: 'rebar',
        pointA: pts.anchorWorld,
        pointB: pts.attachWorld,
        stressUtilization: cleanZero(Math.max(0, util)),
        axialForceN: cleanZero(cw.currentTensionN),
        broken: false,
      });
    }

    const projectilesOut: RenderSnapshot['projectiles'] = [];
    for (const p of this.ballistics.getProjectilesMap().values()) {
      projectilesOut.push({
        id: p.projectileId,
        position: [p.position[0], p.position[1], p.position[2]],
        radiusM: p.radiusM,
        velocity: [p.velocity[0], p.velocity[1], p.velocity[2]],
        hot: p.hot,
      });
    }

    return {
      tick: this.tick,
      simTimeSec: this.simTimeSec,
      platformOffset,
      blocks,
      shards: shardsOut,
      bondsAndRebars,
      plantedCharges: this.ballistics.getPlantedChargesSnapshot(this.graph),
      projectiles: projectilesOut,
    };
  }

  public getTelemetry(): SimulationTelemetry {
    this.ensureNotDisposed();
    const platformOffset = this.seismic.getPlatformOffset();

    let intactBlockCount = 0;
    let burningNodeCount = 0;
    let maxTemperatureC = AMBIENT_TEMPERATURE_C;
    let maxStressUtil = 0;

    let hasExplicitTarget = false;
    for (const n of this.graph.getNodesMap().values()) {
      if (!n.isCounterweight && n.structureGroupTag === 'target') {
        hasExplicitTarget = true;
        break;
      }
    }

    let totalTargetBaselineMass = 0;
    let damagedTargetMassWeighted = 0;
    let totalProtectedBaselineMass = 0;
    let damagedProtectedMassWeighted = 0;
    let targetMaxHeightM = 0;

    for (const n of this.graph.getNodesMap().values()) {
      if (n.isCounterweight) continue;

      const isTarget = hasExplicitTarget
        ? n.structureGroupTag === 'target'
        : n.structureGroupTag !== 'protected';
      const isProtected = n.structureGroupTag === 'protected';

      // В знаменатель базы входят только изначально заспавненные узлы (countsTowardInitialTotals),
      // чтобы замена стены на куски при carveLocalBreach3D не задваивала исходную массу!
      if (n.countsTowardInitialTotals) {
        if (isTarget) {
          totalTargetBaselineMass += n.massKg;
        }
        if (isProtected) {
          totalProtectedBaselineMass += n.massKg;
        }
      }

      if (!n.alive) {
        continue;
      }

      intactBlockCount++;
      if (n.burning) {
        burningNodeCount++;
      }
      if (n.temperatureC > maxTemperatureC) {
        maxTemperatureC = n.temperatureC;
      }
      if (n.stressUtilization > maxStressUtil) {
        maxStressUtil = n.stressUtilization;
      }

      const relCenterY = n.worldPos[1] - platformOffset[1];
      const approxTopRelY = Math.max(0, relCenterY + n.halfExtents[1]);
      if (isTarget && approxTopRelY > targetMaxHeightM) {
        targetMaxHeightM = approxTopRelY;
      }
    }

    // Вычисляем сохранённую массу по живым узлам (включая выжившие сегменты после проломов)
    let survivingTargetMassWeighted = 0;
    let survivingProtectedMassWeighted = 0;

    for (const n of this.graph.getNodesMap().values()) {
      if (!n.alive || n.isCounterweight) continue;
      const isTarget = hasExplicitTarget
        ? n.structureGroupTag === 'target'
        : n.structureGroupTag !== 'protected';
      const isProtected = n.structureGroupTag === 'protected';

      const relCenterY = n.worldPos[1] - platformOffset[1];
      const dropRatio =
        n.initialCenter[1] > 0.3
          ? clamp((n.initialCenter[1] - relCenterY) / Math.max(0.4, n.initialCenter[1]), 0, 1)
          : 0;

      let nodeLossFraction = 0;
      if (n.islandId !== 0) {
        // Оторванный от фундамента блок считается минимум на 75% разрушенным, и до 100% по мере падения вниз
        nodeLossFraction = clamp(0.75 + 0.25 * dropRatio, 0.75, 1.0);
      } else {
        nodeLossFraction = clamp(
          Math.max(n.damageRatio * 0.75, n.charRatio * 0.9, dropRatio * 0.85),
          0,
          1,
        );
      }

      const intactWeight = n.massKg * (1 - nodeLossFraction);
      if (isTarget) {
        survivingTargetMassWeighted += intactWeight;
      }
      if (isProtected) {
        survivingProtectedMassWeighted += intactWeight;
      }
    }

    if (totalTargetBaselineMass > 0) {
      damagedTargetMassWeighted = Math.max(0, totalTargetBaselineMass - survivingTargetMassWeighted);
    }
    if (totalProtectedBaselineMass > 0) {
      damagedProtectedMassWeighted = Math.max(
        0,
        totalProtectedBaselineMass - survivingProtectedMassWeighted,
      );
    }

    let intactJointCount = 0;
    let plasticHingeCount = 0;
    for (const bond of this.graph.getBondsMap().values()) {
      if (!bond.broken) {
        intactJointCount++;
        if (bond.stressUtilization > maxStressUtil) {
          maxStressUtil = bond.stressUtilization;
        }
        if (bond.isPlasticHinge) {
          plasticHingeCount++;
        }
      }
    }
    for (const hj of this.plasticHingeJoints.values()) {
      if (!hj.ruptured) {
        plasticHingeCount++;
      }
    }

    let activeRebarCount = 0;
    for (const t of this.rebarTethers.values()) {
      if (!t.snapped) {
        activeRebarCount++;
      }
    }

    let activeShardCount = 0;
    for (const sh of this.shards.values()) {
      if (!sh.baked) {
        activeShardCount++;
      }
      if (sh.temperatureC > maxTemperatureC) {
        maxTemperatureC = sh.temperatureC;
      }
    }

    // Кинетическая энергия всех активных динамических тел в кДж
    let kineticEnergyJ = 0;
    this.world.forEachActiveRigidBody((rb) => {
      if (!rb.isDynamic()) return;
      const m = rb.mass();
      const lv = rb.linvel();
      const av = rb.angvel();
      const inertia = rb.principalInertia();
      const linSq = lv.x * lv.x + lv.y * lv.y + lv.z * lv.z;
      const rotE =
        0.5 * (inertia.x * av.x * av.x + inertia.y * av.y * av.y + inertia.z * av.z * av.z);
      const bodyE = 0.5 * m * linSq + rotE;
      if (Number.isFinite(bodyE) && bodyE > 0) {
        kineticEnergyJ += bodyE;
      }
    });

    const rawDestructionPct =
      totalTargetBaselineMass > 0
        ? clamp((damagedTargetMassWeighted / totalTargetBaselineMass) * 100, 0, 100)
        : 0;
    const rawProtectedPct =
      totalProtectedBaselineMass > 0
        ? clamp((damagedProtectedMassWeighted / totalProtectedBaselineMass) * 100, 0, 100)
        : 0;

    if (rawDestructionPct > this.maxObservedDestructionPct && this.initialBlockCount > 0) {
      // Если не было достройки новых блоков, разрушение монотонно не убывает; при достройке пересчитывается честно по доле
      this.maxObservedDestructionPct = rawDestructionPct;
    }
    if (rawProtectedPct > this.maxObservedProtectedDamagePct) {
      this.maxObservedProtectedDamagePct = rawProtectedPct;
    }

    const safeFloat = (v: number, minVal = 0): number =>
      Number.isFinite(v) ? cleanZero(Math.max(minVal, v)) : minVal;

    const safeInt = (v: number): number =>
      Number.isFinite(v) ? Math.max(0, Math.trunc(v)) : 0;

    return {
      tick: safeInt(this.tick),
      simTimeSec: safeFloat(this.simTimeSec, 0),
      intactBlockCount: safeInt(intactBlockCount),
      initialBlockCount: safeInt(Math.max(this.initialBlockCount, intactBlockCount)),
      intactJointCount: safeInt(intactJointCount),
      initialJointCount: safeInt(Math.max(this.initialJointCount, intactJointCount)),
      brokenJointCount: safeInt(this.brokenJointCount),
      activeRebarCount: safeInt(activeRebarCount),
      snappedRebarCount: safeInt(this.snappedRebarCount),
      plasticHingeCount: safeInt(plasticHingeCount),
      activeShardCount: safeInt(activeShardCount),
      bakedRubbleCount: safeInt(this.bakedRubbleCount),
      burningNodeCount: safeInt(burningNodeCount),
      maxTemperatureC: safeFloat(maxTemperatureC, AMBIENT_TEMPERATURE_C),
      maxStressUtilization: safeFloat(Math.max(maxStressUtil, 0), 0),
      kineticEnergyKJ: safeFloat(kineticEnergyJ * 0.001, 0),
      secondaryImpactsCount: safeInt(this.secondaryImpactsCount),
      detonatedExplosivesCount: safeInt(this.detonatedExplosivesCount),
      destructionPct: cleanZero(clamp(safeFloat(rawDestructionPct, 0), 0, 100)),
      targetMaxHeightM: safeFloat(targetMaxHeightM, 0),
      protectedDamagePct: cleanZero(clamp(safeFloat(rawProtectedPct, 0), 0, 100)),
      seismicActive: Boolean(this.seismic.isActive()),
      seismicFrequencyHz: safeFloat(this.seismic.getFrequencyHz(), 0.5),
      seismicAmplitudeM: safeFloat(this.seismic.getAmplitudeM(), 0.05),
      lastStepCpuMs: safeFloat(this.lastStepCpuMs, 0),
    };
  }
}
