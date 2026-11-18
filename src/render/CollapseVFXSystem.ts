import * as THREE from 'three';
import { clamp } from '../core/math3d';
import { SeededRng } from '../core/rng';
import {
  DEFAULT_SEED,
  type QualityPreset,
  type RenderBlockInstance,
  type SimulationEvent,
  type StructuralMaterialId,
} from '../core/types';

/**
 * Полностью инстансированная система частиц разрушения (CollapseVFXSystem) на SoA-буферах без GC-аллокаций:
 * 1) Клубы строительной пыли и дыма пожара (dustSmokeMesh),
 * 2) Языки пламени (flameMesh),
 * 3) Баллистические снопы искр стали и арматуры с гравитацией и отскоком от пола (sparksMesh),
 * 4) Огненная вспышка и расширяющаяся ударная сфера взрыва по радиусу Садовского (shockwaveMesh).
 */

export interface VFXActiveCounts {
  dustAndSmoke: number;
  flames: number;
  sparks: number;
  shockwaves: number;
  total: number;
}

interface PoolCapacities {
  dust: number;
  flame: number;
  sparks: number;
  shockwave: number;
}

const PRESET_CAPACITIES: Readonly<Record<QualityPreset, PoolCapacities>> = {
  performance: { dust: 160, flame: 120, sparks: 140, shockwave: 32 },
  high: { dust: 360, flame: 280, sparks: 320, shockwave: 48 },
  ultra: { dust: 640, flame: 480, sparks: 560, shockwave: 64 },
};

const MAX_POOL_CAPACITIES: PoolCapacities = PRESET_CAPACITIES.ultra;

interface SoAParticlePool {
  readonly maxCapacity: number;
  effectiveLimit: number;
  cursor: number;
  activeCount: number;
  readonly alive: Uint8Array;
  readonly kind: Uint8Array; // подтип частицы (например, 0 = пыль, 1 = дым; 0 = вспышка, 1 = волна)
  readonly age: Float32Array;
  readonly maxLife: Float32Array;
  readonly px: Float32Array;
  readonly py: Float32Array;
  readonly pz: Float32Array;
  readonly vx: Float32Array;
  readonly vy: Float32Array;
  readonly vz: Float32Array;
  readonly size0: Float32Array;
  readonly size1: Float32Array;
  readonly baseR: Float32Array;
  readonly baseG: Float32Array;
  readonly baseB: Float32Array;
  readonly phase: Float32Array;
  readonly mesh: THREE.InstancedMesh;
}

const UP_Y = new THREE.Vector3(0, 1, 0);
const _pos = new THREE.Vector3();
const _velDir = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _scale = new THREE.Vector3();
const _mat4 = new THREE.Matrix4();
const _workColor = new THREE.Color();

function createSoAPool(
  name: string,
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  maxCapacity: number,
  effectiveLimit: number,
  renderOrder: number,
): SoAParticlePool {
  const mesh = new THREE.InstancedMesh(geometry, material, maxCapacity);
  mesh.name = name;
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.renderOrder = renderOrder;
  mesh.count = 0;
  mesh.visible = false;

  _workColor.setRGB(1, 1, 1, THREE.LinearSRGBColorSpace);
  mesh.setColorAt(0, _workColor);

  return {
    maxCapacity,
    effectiveLimit,
    cursor: 0,
    activeCount: 0,
    alive: new Uint8Array(maxCapacity),
    kind: new Uint8Array(maxCapacity),
    age: new Float32Array(maxCapacity),
    maxLife: new Float32Array(maxCapacity),
    px: new Float32Array(maxCapacity),
    py: new Float32Array(maxCapacity),
    pz: new Float32Array(maxCapacity),
    vx: new Float32Array(maxCapacity),
    vy: new Float32Array(maxCapacity),
    vz: new Float32Array(maxCapacity),
    size0: new Float32Array(maxCapacity),
    size1: new Float32Array(maxCapacity),
    baseR: new Float32Array(maxCapacity),
    baseG: new Float32Array(maxCapacity),
    baseB: new Float32Array(maxCapacity),
    phase: new Float32Array(maxCapacity),
    mesh,
  };
}

function isFiniteVec3(v: readonly [number, number, number]): boolean {
  return Number.isFinite(v[0]) && Number.isFinite(v[1]) && Number.isFinite(v[2]);
}

function sanitizeVfxCoord(v: number, fallback = 0): number {
  return Number.isFinite(v) ? clamp(v, -1e5, 1e5) : fallback;
}

function sanitizeNonNegScalar(v: number, maxVal = 1e12): number {
  return Number.isFinite(v) ? Math.min(maxVal, Math.max(0, v)) : 0;
}

/**
 * Возвращает базовый цвет пыли разрушения для заданного материала (строго без фиолетовых тонов).
 */
export function getMaterialDustColorHex(materialId: StructuralMaterialId): number {
  switch (materialId) {
    case 'reinforced_concrete':
      return 0x94a3b8; // цементно-сланцевая пыль
    case 'brick':
      return 0xb45309; // терракотовая кирпичная пыль
    case 'wood':
      return 0xa16207; // древесная щепа и опилки
    case 'glass':
      return 0xe0f2fe; // ледяная алмазная крошка стекла
    case 'steel':
      return 0x64748b; // графитовая окалина стали
    case 'explosive':
      return 0x44403c; // густая тёмно-бурая копоть
    default:
      return 0x94a3b8;
  }
}

export class CollapseVFXSystem {
  public readonly group: THREE.Group;

  private readonly rng: SeededRng;
  private qualityPreset: QualityPreset;

  private readonly dustGeometry: THREE.IcosahedronGeometry;
  private readonly dustMaterial: THREE.MeshLambertMaterial;
  private readonly dustPool: SoAParticlePool;

  private readonly flameGeometry: THREE.ConeGeometry;
  private readonly flameMaterial: THREE.MeshBasicMaterial;
  private readonly flamePool: SoAParticlePool;

  private readonly sparksGeometry: THREE.BoxGeometry;
  private readonly sparksMaterial: THREE.MeshBasicMaterial;
  private readonly sparksPool: SoAParticlePool;

  private readonly shockwaveGeometry: THREE.SphereGeometry;
  private readonly shockwaveMaterial: THREE.MeshBasicMaterial;
  private readonly shockwavePool: SoAParticlePool;

  private burnEmitAccumulator = 0;
  private disposed = false;

  constructor(options?: { quality?: QualityPreset; seed?: number }) {
    this.group = new THREE.Group();
    this.group.name = 'CollapseVFXSystem';

    this.qualityPreset = options?.quality ?? 'high';
    this.rng = new SeededRng(options?.seed ?? (DEFAULT_SEED ^ 0x56465833));

    const limits = PRESET_CAPACITIES[this.qualityPreset];

    // 1. Клубы пыли и дыма
    this.dustGeometry = new THREE.IcosahedronGeometry(1, 1);
    this.dustMaterial = new THREE.MeshLambertMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.48,
      depthWrite: false,
      forceSinglePass: true,
    });
    this.dustPool = createSoAPool(
      'VFX_DustAndSmoke',
      this.dustGeometry,
      this.dustMaterial,
      MAX_POOL_CAPACITIES.dust,
      limits.dust,
      9,
    );
    this.group.add(this.dustPool.mesh);

    // 2. Языки пламени
    this.flameGeometry = new THREE.ConeGeometry(0.58, 1.35, 5);
    this.flameMaterial = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.85,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    });
    this.flamePool = createSoAPool(
      'VFX_Flames',
      this.flameGeometry,
      this.flameMaterial,
      MAX_POOL_CAPACITIES.flame,
      limits.flame,
      11,
    );
    this.group.add(this.flamePool.mesh);

    // 3. Баллистические снопы искр стали и арматуры
    this.sparksGeometry = new THREE.BoxGeometry(0.038, 1.0, 0.038);
    this.sparksMaterial = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.96,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    });
    this.sparksPool = createSoAPool(
      'VFX_Sparks',
      this.sparksGeometry,
      this.sparksMaterial,
      MAX_POOL_CAPACITIES.sparks,
      limits.sparks,
      12,
    );
    this.group.add(this.sparksPool.mesh);

    // 4. Ударные сферы Садовского и огненные вспышки детонации
    this.shockwaveGeometry = new THREE.SphereGeometry(1, 18, 12);
    this.shockwaveMaterial = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.66,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      forceSinglePass: true,
      toneMapped: false,
    });
    this.shockwavePool = createSoAPool(
      'VFX_Shockwaves',
      this.shockwaveGeometry,
      this.shockwaveMaterial,
      MAX_POOL_CAPACITIES.shockwave,
      limits.shockwave,
      13,
    );
    this.group.add(this.shockwavePool.mesh);
  }

  public getObject3D(): THREE.Group {
    return this.group;
  }

  public getMeshes(): {
    dustSmokeMesh: THREE.InstancedMesh;
    flameMesh: THREE.InstancedMesh;
    sparksMesh: THREE.InstancedMesh;
    shockwaveMesh: THREE.InstancedMesh;
  } {
    return {
      dustSmokeMesh: this.dustPool.mesh,
      flameMesh: this.flamePool.mesh,
      sparksMesh: this.sparksPool.mesh,
      shockwaveMesh: this.shockwavePool.mesh,
    };
  }

  /**
   * Обрабатывает пакет физических событий симуляции и порождает соответствующие частицы разрушения.
   */
  public consumeEvents(events: readonly SimulationEvent[]): void {
    if (this.disposed || events.length === 0) return;

    const densityScale =
      this.qualityPreset === 'performance' ? 0.5 : this.qualityPreset === 'ultra' ? 1.35 : 1.0;

    for (let i = 0; i < events.length; i++) {
      const ev = events[i]!;
      switch (ev.type) {
        case 'fracture': {
          if (!isFiniteVec3(ev.position)) break;
          const pos: [number, number, number] = [
            sanitizeVfxCoord(ev.position[0]),
            sanitizeVfxCoord(ev.position[1]),
            sanitizeVfxCoord(ev.position[2]),
          ];
          const safeEnergyJ = sanitizeNonNegScalar(ev.energyJ, 1e12);
          const safeShardCount = sanitizeNonNegScalar(ev.shardCount, 1000);
          const dustHex = getMaterialDustColorHex(ev.materialId);
          const energyFactor = clamp(Math.log10(1 + safeEnergyJ * 0.01), 0.25, 2.5);
          const count = Math.max(
            2,
            Math.round((3 + Math.min(12, safeShardCount * 0.65)) * densityScale),
          );
          this.emitDustBurst(pos, count, dustHex, 1.4 * energyFactor, 0.28, 1.15, 0);

          if (
            ev.materialId === 'steel' ||
            ev.materialId === 'explosive' ||
            (ev.materialId === 'reinforced_concrete' && safeEnergyJ > 2500)
          ) {
            const sparkCount = Math.max(3, Math.round(8 * densityScale));
            this.emitSparks(pos, sparkCount, 0xf59e0b, 7.5);
          }
          break;
        }

        case 'rebar_snap': {
          if (!isFiniteVec3(ev.position)) break;
          const pos: [number, number, number] = [
            sanitizeVfxCoord(ev.position[0]),
            sanitizeVfxCoord(ev.position[1]),
            sanitizeVfxCoord(ev.position[2]),
          ];
          const safeForceN = sanitizeNonNegScalar(ev.forceN, 1e12);
          const forceScale = clamp(Math.log10(10 + safeForceN * 0.001), 0.6, 2.2);
          const sparkCount = Math.max(4, Math.round(14 * densityScale));
          this.emitSparks(pos, sparkCount, 0xfef08a, 9.5 * forceScale);
          this.emitDustBurst(
            pos,
            Math.max(1, Math.round(3 * densityScale)),
            0x94a3b8,
            1.1,
            0.18,
            0.65,
            0,
          );
          break;
        }

        case 'steel_yield': {
          if (!isFiniteVec3(ev.position)) break;
          const pos: [number, number, number] = [
            sanitizeVfxCoord(ev.position[0]),
            sanitizeVfxCoord(ev.position[1]),
            sanitizeVfxCoord(ev.position[2]),
          ];
          const safeAngle = sanitizeNonNegScalar(ev.angleRad, Math.PI * 2);
          const angleBoost = 1 + 0.1 * Math.min(1, safeAngle);
          const sparkCount = Math.max(3, Math.round(10 * densityScale));
          this.emitSparks(pos, sparkCount, 0xf97316, 6.2 * angleBoost);
          break;
        }

        case 'secondary_impact': {
          if (!isFiniteVec3(ev.position)) break;
          const pos: [number, number, number] = [
            sanitizeVfxCoord(ev.position[0]),
            sanitizeVfxCoord(ev.position[1]),
            sanitizeVfxCoord(ev.position[2]),
          ];
          const safeImpulse = sanitizeNonNegScalar(ev.impulseNs, 1e12);
          const safeMass = sanitizeNonNegScalar(ev.massKg, 1e12);
          const impactScale = clamp(
            Math.log10(1 + safeImpulse * 0.001 + safeMass * 0.01),
            0.35,
            2.8,
          );
          const dustHex = getMaterialDustColorHex(ev.materialId);
          const count = Math.max(3, Math.round(9 * impactScale * densityScale));
          this.emitHorizontalImpactPlume(pos, count, dustHex, 2.6 * impactScale);
          break;
        }

        case 'explosion': {
          if (!isFiniteVec3(ev.position)) break;
          const pos: [number, number, number] = [
            sanitizeVfxCoord(ev.position[0]),
            sanitizeVfxCoord(ev.position[1]),
            sanitizeVfxCoord(ev.position[2]),
          ];
          const safeTnt = sanitizeNonNegScalar(ev.equivalentKgTnt, 1e9);
          const radius =
            Number.isFinite(ev.radiusM) && ev.radiusM > 0
              ? clamp(ev.radiusM, 2.0, 500.0)
              : clamp(2.0 + Math.cbrt(safeTnt) * 1.5, 2.0, 500.0);
          const chainBoost = ev.isChainDetonation ? 1.18 : 1.0;

          // 1) Плотная яркая вспышка эпицентра
          this.allocateParticle(
            this.shockwavePool,
            0,
            pos[0],
            pos[1],
            pos[2],
            0,
            0,
            0,
            0.35,
            Math.max(1.8, radius * 0.45 * chainBoost),
            0.18,
            0xfef08a,
          );
          // 2) Расширяющаяся сферическая волна Садовского
          this.allocateParticle(
            this.shockwavePool,
            1,
            pos[0],
            pos[1],
            pos[2],
            0,
            0,
            0,
            0.45,
            radius * chainBoost,
            0.38,
            0xfdba74,
          );

          const flameCount = Math.max(4, Math.round(12 * densityScale));
          for (let f = 0; f < flameCount; f++) {
            const dir = this.rng.unitVec3();
            const speed = this.rng.range(2.2, 6.5) * chainBoost;
            this.allocateParticle(
              this.flamePool,
              0,
              pos[0] + dir[0] * 0.35,
              pos[1] + Math.abs(dir[1]) * 0.35,
              pos[2] + dir[2] * 0.35,
              dir[0] * speed * 0.65,
              Math.abs(dir[1]) * speed + 2.4,
              dir[2] * speed * 0.65,
              this.rng.range(0.45, 0.85),
              this.rng.range(1.1, 2.1) * chainBoost,
              this.rng.range(0.32, 0.68),
              0xfef08a,
            );
          }

          const sparkCount = Math.max(6, Math.round(20 * densityScale));
          this.emitSparks(pos, sparkCount, 0xfdba74, 13.5 * chainBoost);

          const smokeCount = Math.max(4, Math.round(12 * densityScale));
          this.emitDustBurst(
            pos,
            smokeCount,
            0x475569,
            4.2 * chainBoost,
            0.55,
            2.4 * chainBoost,
            1,
          );
          break;
        }

        case 'fire_ignited': {
          if (!isFiniteVec3(ev.position)) break;
          const pos: [number, number, number] = [
            sanitizeVfxCoord(ev.position[0]),
            sanitizeVfxCoord(ev.position[1]),
            sanitizeVfxCoord(ev.position[2]),
          ];
          const count = Math.max(2, Math.round(5 * densityScale));
          for (let f = 0; f < count; f++) {
            this.allocateParticle(
              this.flamePool,
              0,
              pos[0] + this.rng.range(-0.25, 0.25),
              pos[1] + this.rng.range(0, 0.35),
              pos[2] + this.rng.range(-0.25, 0.25),
              this.rng.range(-0.4, 0.4),
              this.rng.range(1.6, 3.4),
              this.rng.range(-0.4, 0.4),
              0.32,
              0.72,
              this.rng.range(0.38, 0.75),
              0xfef08a,
            );
          }
          this.emitDustBurst(pos, 2, 0x334155, 0.8, 0.25, 1.1, 1);
          break;
        }

        case 'seismic_pulse': {
          const safeAccel = sanitizeNonNegScalar(ev.groundAccelMpS2, 1e6);
          if (safeAccel > 1.2) {
            const puffs = Math.max(1, Math.round(3 * densityScale));
            for (let p = 0; p < puffs; p++) {
              const rx = this.rng.range(-10, 10);
              const rz = this.rng.range(-8, 8);
              this.allocateParticle(
                this.dustPool,
                0,
                rx,
                0.15,
                rz,
                this.rng.range(-0.8, 0.8),
                this.rng.range(0.5, 1.6),
                this.rng.range(-0.8, 0.8),
                0.22,
                0.95,
                this.rng.range(0.55, 1.1),
                0x94a3b8,
              );
            }
          }
          break;
        }
      }
    }

    this.flushAllPools();
  }

  /**
   * Непрерывно порождает языки пламени и восходящий дым на горящих блоках (burning === true).
   */
  public syncBurningBlocks(blocks: readonly RenderBlockInstance[], dtRealSec: number): void {
    if (this.disposed || blocks.length === 0) return;
    if (!(dtRealSec > 0) || !Number.isFinite(dtRealSec)) return;

    const safeDt = Math.min(0.25, dtRealSec);

    const burningBlocks: RenderBlockInstance[] = [];
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i]!;
      if (b.burning && isFiniteVec3(b.position)) {
        burningBlocks.push(b);
      }
    }

    if (burningBlocks.length === 0) return;

    const rateScale =
      this.qualityPreset === 'performance' ? 6 : this.qualityPreset === 'ultra' ? 18 : 12;
    this.burnEmitAccumulator += safeDt * burningBlocks.length * rateScale;

    const emitQuota = Math.min(24, Math.floor(this.burnEmitAccumulator));
    if (emitQuota <= 0) return;
    this.burnEmitAccumulator -= emitQuota;

    for (let k = 0; k < emitQuota; k++) {
      const block = burningBlocks[this.rng.int(0, burningBlocks.length - 1)]!;
      const bx = sanitizeVfxCoord(block.position[0]);
      const by = sanitizeVfxCoord(block.position[1]);
      const bz = sanitizeVfxCoord(block.position[2]);

      const [rawHx, rawHy, rawHz] = block.halfExtents;
      const hx = Number.isFinite(rawHx) ? Math.min(1e4, Math.abs(rawHx)) : 0;
      const hy = Number.isFinite(rawHy) ? Math.min(1e4, Math.abs(rawHy)) : 0;
      const hz = Number.isFinite(rawHz) ? Math.min(1e4, Math.abs(rawHz)) : 0;

      const ox = bx + this.rng.range(-hx * 0.85, hx * 0.85);
      const oy = by + this.rng.range(-hy * 0.2, hy * 0.95);
      const oz = bz + this.rng.range(-hz * 0.85, hz * 0.85);

      this.allocateParticle(
        this.flamePool,
        0,
        ox,
        oy,
        oz,
        this.rng.range(-0.45, 0.45),
        this.rng.range(1.8, 3.9),
        this.rng.range(-0.45, 0.45),
        this.rng.range(0.24, 0.48),
        this.rng.range(0.55, 1.05),
        this.rng.range(0.35, 0.72),
        0xfef08a,
      );

      if (this.rng.chance(0.38)) {
        this.allocateParticle(
          this.dustPool,
          1,
          ox,
          oy + 0.35,
          oz,
          this.rng.range(-0.35, 0.35),
          this.rng.range(1.2, 2.5),
          this.rng.range(-0.35, 0.35),
          0.28,
          1.35,
          this.rng.range(0.9, 1.65),
          0x334155,
        );
      }
    }

    this.flushPoolToMesh(this.flamePool, 'flame');
    this.flushPoolToMesh(this.dustPool, 'dust');
  }

  /**
   * Продвигает физику всех 4 пулов частиц (сопротивление воздуха, плавучесть, гравитация, отскок искр)
   * и записывает матрицы/цвета активных частиц в GPU-буферы InstancedMesh.
   */
  public update(dtRealSec: number): void {
    if (this.disposed) return;

    const dt = Number.isFinite(dtRealSec) && dtRealSec > 0 ? Math.min(0.25, dtRealSec) : 0;
    if (dt <= 0) return;

    this.stepDustPool(dt);
    this.stepFlamePool(dt);
    this.stepSparksPool(dt);
    this.stepShockwavePool(dt);

    this.flushAllPools();
  }

  public setQualityPreset(preset: QualityPreset): void {
    if (this.disposed) return;
    this.qualityPreset = preset;
    const limits = PRESET_CAPACITIES[preset];
    this.dustPool.effectiveLimit = limits.dust;
    this.flamePool.effectiveLimit = limits.flame;
    this.sparksPool.effectiveLimit = limits.sparks;
    this.shockwavePool.effectiveLimit = limits.shockwave;

    this.trimPoolToLimit(this.dustPool);
    this.trimPoolToLimit(this.flamePool);
    this.trimPoolToLimit(this.sparksPool);
    this.trimPoolToLimit(this.shockwavePool);
    this.flushAllPools();
  }

  public clear(): void {
    if (this.disposed) return;
    this.burnEmitAccumulator = 0;
    this.clearPool(this.dustPool);
    this.clearPool(this.flamePool);
    this.clearPool(this.sparksPool);
    this.clearPool(this.shockwavePool);
  }

  public getActiveCounts(): VFXActiveCounts {
    if (this.disposed) {
      return {
        dustAndSmoke: 0,
        flames: 0,
        sparks: 0,
        shockwaves: 0,
        total: 0,
      };
    }
    const dustAndSmoke = this.dustPool.activeCount;
    const flames = this.flamePool.activeCount;
    const sparks = this.sparksPool.activeCount;
    const shockwaves = this.shockwavePool.activeCount;
    return {
      dustAndSmoke,
      flames,
      sparks,
      shockwaves,
      total: dustAndSmoke + flames + sparks + shockwaves,
    };
  }

  public getEstimatedDrawCalls(): number {
    if (this.disposed) return 0;
    let calls = 0;
    if (this.dustPool.mesh.visible && this.dustPool.activeCount > 0) calls += 1;
    if (this.flamePool.mesh.visible && this.flamePool.activeCount > 0) calls += 1;
    if (this.sparksPool.mesh.visible && this.sparksPool.activeCount > 0) calls += 1;
    if (this.shockwavePool.mesh.visible && this.shockwavePool.activeCount > 0) calls += 1;
    return calls;
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.burnEmitAccumulator = 0;

    for (const pool of [
      this.dustPool,
      this.flamePool,
      this.sparksPool,
      this.shockwavePool,
    ]) {
      this.clearPool(pool);
      this.group.remove(pool.mesh);
      pool.mesh.dispose();
    }

    this.dustGeometry.dispose();
    this.dustMaterial.dispose();
    this.flameGeometry.dispose();
    this.flameMaterial.dispose();
    this.sparksGeometry.dispose();
    this.sparksMaterial.dispose();
    this.shockwaveGeometry.dispose();
    this.shockwaveMaterial.dispose();
  }

  private allocateParticle(
    pool: SoAParticlePool,
    kind: number,
    x: number,
    y: number,
    z: number,
    vx: number,
    vy: number,
    vz: number,
    size0: number,
    size1: number,
    maxLife: number,
    hexColor: number,
  ): void {
    if (
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      !Number.isFinite(z) ||
      !Number.isFinite(vx) ||
      !Number.isFinite(vy) ||
      !Number.isFinite(vz) ||
      !Number.isFinite(size0) ||
      !Number.isFinite(size1) ||
      !Number.isFinite(maxLife)
    ) {
      return;
    }

    const limit = Math.max(1, Math.min(pool.effectiveLimit, pool.maxCapacity));
    const idx = pool.cursor % limit;
    pool.cursor = (idx + 1) % limit;

    if (pool.alive[idx] === 0) {
      pool.alive[idx] = 1;
      pool.activeCount += 1;
    }

    pool.kind[idx] = kind;
    pool.age[idx] = 0;
    pool.maxLife[idx] = clamp(maxLife, 0.05, 60);
    pool.px[idx] = clamp(x, -1e5, 1e5);
    pool.py[idx] = clamp(y, -1e5, 1e5);
    pool.pz[idx] = clamp(z, -1e5, 1e5);
    pool.vx[idx] = clamp(vx, -1e4, 1e4);
    pool.vy[idx] = clamp(vy, -1e4, 1e4);
    pool.vz[idx] = clamp(vz, -1e4, 1e4);
    pool.size0[idx] = clamp(size0, 1e-4, 1e4);
    pool.size1[idx] = clamp(size1, 1e-4, 1e4);

    _workColor.setHex(hexColor, THREE.SRGBColorSpace);
    pool.baseR[idx] = _workColor.r;
    pool.baseG[idx] = _workColor.g;
    pool.baseB[idx] = _workColor.b;
    pool.phase[idx] = this.rng.range(0, Math.PI * 2);
  }

  private emitDustBurst(
    origin: [number, number, number],
    count: number,
    hexColor: number,
    speedMax: number,
    r0: number,
    r1: number,
    subKind: number,
  ): void {
    for (let i = 0; i < count; i++) {
      const dir = this.rng.unitVec3();
      const speed = this.rng.range(0.35, 1.0) * speedMax;
      const vyBias = subKind === 1 ? 1.35 : 0.45;
      this.allocateParticle(
        this.dustPool,
        subKind,
        origin[0] + dir[0] * 0.18,
        Math.max(0.08, origin[1] + dir[1] * 0.18),
        origin[2] + dir[2] * 0.18,
        dir[0] * speed,
        dir[1] * speed * 0.6 + vyBias,
        dir[2] * speed,
        r0 * this.rng.range(0.8, 1.25),
        r1 * this.rng.range(0.85, 1.3),
        this.rng.range(0.65, 1.45),
        hexColor,
      );
    }
  }

  private emitHorizontalImpactPlume(
    origin: [number, number, number],
    count: number,
    hexColor: number,
    radialSpeed: number,
  ): void {
    for (let i = 0; i < count; i++) {
      const angle = this.rng.range(0, Math.PI * 2);
      const speed = this.rng.range(0.45, 1.05) * radialSpeed;
      this.allocateParticle(
        this.dustPool,
        0,
        origin[0] + Math.cos(angle) * 0.22,
        Math.max(0.08, origin[1] + 0.08),
        origin[2] + Math.sin(angle) * 0.22,
        Math.cos(angle) * speed,
        this.rng.range(0.25, 1.15),
        Math.sin(angle) * speed,
        this.rng.range(0.25, 0.45),
        this.rng.range(0.95, 1.85),
        this.rng.range(0.7, 1.5),
        hexColor,
      );
    }
  }

  private emitSparks(
    origin: [number, number, number],
    count: number,
    hexColor: number,
    speedMax: number,
  ): void {
    for (let i = 0; i < count; i++) {
      const dir = this.rng.unitVec3();
      const speed = this.rng.range(0.4, 1.0) * speedMax;
      this.allocateParticle(
        this.sparksPool,
        0,
        origin[0] + dir[0] * 0.08,
        Math.max(0.06, origin[1] + dir[1] * 0.08),
        origin[2] + dir[2] * 0.08,
        dir[0] * speed,
        dir[1] * speed + this.rng.range(1.2, 3.4),
        dir[2] * speed,
        this.rng.range(0.14, 0.34),
        0.04,
        this.rng.range(0.28, 0.72),
        hexColor,
      );
    }
  }

  private stepDustPool(dt: number): void {
    const pool = this.dustPool;
    if (pool.activeCount === 0) return;

    const drag = Math.exp(-2.2 * dt);
    const limit = pool.effectiveLimit;

    for (let i = 0; i < limit; i++) {
      if (pool.alive[i] === 0) continue;

      const nextAge = pool.age[i]! + dt;
      if (nextAge >= pool.maxLife[i]!) {
        pool.alive[i] = 0;
        pool.activeCount = Math.max(0, pool.activeCount - 1);
        continue;
      }

      pool.age[i] = nextAge;
      const buoyancy = pool.kind[i] === 1 ? 1.45 : 0.25;
      pool.vx[i] = pool.vx[i]! * drag;
      pool.vy[i] = pool.vy[i]! * drag + buoyancy * dt;
      pool.vz[i] = pool.vz[i]! * drag;

      pool.px[i] = pool.px[i]! + pool.vx[i]! * dt;
      pool.py[i] = Math.max(0.05, pool.py[i]! + pool.vy[i]! * dt);
      pool.pz[i] = pool.pz[i]! + pool.vz[i]! * dt;
    }
  }

  private stepFlamePool(dt: number): void {
    const pool = this.flamePool;
    if (pool.activeCount === 0) return;

    const limit = pool.effectiveLimit;

    for (let i = 0; i < limit; i++) {
      if (pool.alive[i] === 0) continue;

      const nextAge = pool.age[i]! + dt;
      if (nextAge >= pool.maxLife[i]!) {
        pool.alive[i] = 0;
        pool.activeCount = Math.max(0, pool.activeCount - 1);
        continue;
      }

      pool.age[i] = nextAge;
      const swirl = Math.sin(nextAge * 11.0 + pool.phase[i]!) * 0.9;
      pool.px[i] = pool.px[i]! + (pool.vx[i]! + swirl * 0.35) * dt;
      pool.py[i] = pool.py[i]! + pool.vy[i]! * dt;
      pool.pz[i] = pool.pz[i]! + (pool.vz[i]! + Math.cos(nextAge * 9.0 + pool.phase[i]!) * 0.3) * dt;
    }
  }

  private stepSparksPool(dt: number): void {
    const pool = this.sparksPool;
    if (pool.activeCount === 0) return;

    const airDrag = Math.exp(-0.85 * dt);
    const limit = pool.effectiveLimit;

    for (let i = 0; i < limit; i++) {
      if (pool.alive[i] === 0) continue;

      const nextAge = pool.age[i]! + dt;
      if (nextAge >= pool.maxLife[i]!) {
        pool.alive[i] = 0;
        pool.activeCount = Math.max(0, pool.activeCount - 1);
        continue;
      }

      pool.age[i] = nextAge;
      let vx = pool.vx[i]! * airDrag;
      let vy = (pool.vy[i]! - 9.81 * dt) * airDrag;
      let vz = pool.vz[i]! * airDrag;

      let nx = pool.px[i]! + vx * dt;
      let ny = pool.py[i]! + vy * dt;
      let nz = pool.pz[i]! + vz * dt;

      // Физический отскок раскалённой искры от плиты полигона y = 0.04
      if (ny <= 0.04 && vy < 0) {
        ny = 0.04;
        vy = Math.abs(vy) * 0.38;
        vx *= 0.72;
        vz *= 0.72;
      }

      pool.vx[i] = vx;
      pool.vy[i] = vy;
      pool.vz[i] = vz;
      pool.px[i] = nx;
      pool.py[i] = ny;
      pool.pz[i] = nz;
    }
  }

  private stepShockwavePool(dt: number): void {
    const pool = this.shockwavePool;
    if (pool.activeCount === 0) return;

    const limit = pool.effectiveLimit;
    for (let i = 0; i < limit; i++) {
      if (pool.alive[i] === 0) continue;

      const nextAge = pool.age[i]! + dt;
      if (nextAge >= pool.maxLife[i]!) {
        pool.alive[i] = 0;
        pool.activeCount = Math.max(0, pool.activeCount - 1);
        continue;
      }
      pool.age[i] = nextAge;
    }
  }

  private flushAllPools(): void {
    this.flushPoolToMesh(this.dustPool, 'dust');
    this.flushPoolToMesh(this.flamePool, 'flame');
    this.flushPoolToMesh(this.sparksPool, 'sparks');
    this.flushPoolToMesh(this.shockwavePool, 'shockwave');
  }

  private flushPoolToMesh(
    pool: SoAParticlePool,
    mode: 'dust' | 'flame' | 'sparks' | 'shockwave',
  ): void {
    if (pool.activeCount <= 0) {
      pool.activeCount = 0;
      pool.mesh.count = 0;
      pool.mesh.visible = false;
      return;
    }

    let writeIdx = 0;
    const limit = pool.effectiveLimit;

    for (let i = 0; i < limit; i++) {
      if (pool.alive[i] === 0) continue;

      const t = clamp(pool.age[i]! / pool.maxLife[i]!, 0, 1);
      _pos.set(pool.px[i]!, pool.py[i]!, pool.pz[i]!);

      if (mode === 'dust') {
        const easeOut = 1 - (1 - t) * (1 - t);
        const fadeTail = t > 0.7 ? (1 - t) / 0.3 : 1.0;
        const radius =
          (pool.size0[i]! + (pool.size1[i]! - pool.size0[i]!) * easeOut) *
          (0.35 + 0.65 * fadeTail);

        _quat.setFromAxisAngle(UP_Y, pool.phase[i]! + t * 1.2);
        _scale.set(radius, radius * 0.86, radius);
        _mat4.compose(_pos, _quat, _scale);
        pool.mesh.setMatrixAt(writeIdx, _mat4);

        const shade = 0.55 + 0.45 * fadeTail;
        _workColor.setRGB(
          pool.baseR[i]! * shade,
          pool.baseG[i]! * shade,
          pool.baseB[i]! * shade,
          THREE.LinearSRGBColorSpace,
        );
        pool.mesh.setColorAt(writeIdx, _workColor);
      } else if (mode === 'flame') {
        const fade = 1 - t;
        const sXZ = (pool.size0[i]! + (pool.size1[i]! - pool.size0[i]!) * t) * (0.4 + 0.6 * fade);
        const sY = sXZ * (1.25 + 0.6 * fade);

        _quat.setFromAxisAngle(UP_Y, pool.phase[i]! + t * 3.0);
        _scale.set(sXZ, sY, sXZ);
        _mat4.compose(_pos, _quat, _scale);
        pool.mesh.setMatrixAt(writeIdx, _mat4);

        // Эволюция пламени в аддитивном блендинге (строго R >= G >= B, без фиолетового!):
        // бело-жёлтое ядро -> сигнальный янтарь -> алый -> угасание в 0
        let r: number;
        let g: number;
        let b: number;
        if (t < 0.35) {
          const k = t / 0.35;
          r = 1.25;
          g = 0.95 - 0.48 * k;
          b = 0.24 * (1 - k);
        } else if (t < 0.75) {
          const k = (t - 0.35) / 0.4;
          r = 1.25 - 0.45 * k;
          g = 0.47 * (1 - k * 0.85);
          b = 0.01;
        } else {
          const k = (1 - t) / 0.25;
          r = 0.8 * k;
          g = 0.07 * k;
          b = 0;
        }
        _workColor.setRGB(r, g, b, THREE.LinearSRGBColorSpace);
        pool.mesh.setColorAt(writeIdx, _workColor);
      } else if (mode === 'sparks') {
        const vx = pool.vx[i]!;
        const vy = pool.vy[i]!;
        const vz = pool.vz[i]!;
        const speed = Math.hypot(vx, vy, vz);
        if (speed > 1e-4) {
          _velDir.set(vx / speed, vy / speed, vz / speed);
          _quat.setFromUnitVectors(UP_Y, _velDir);
        } else {
          _quat.identity();
        }

        const fade = 1 - t;
        const streakLen = Math.max(0.06, pool.size0[i]! * (0.4 + speed * 0.12) * fade);
        _scale.set(1, streakLen, 1);
        _mat4.compose(_pos, _quat, _scale);
        pool.mesh.setMatrixAt(writeIdx, _mat4);

        const glow = fade * fade * 1.6;
        _workColor.setRGB(
          pool.baseR[i]! * glow,
          pool.baseG[i]! * glow * (0.55 + 0.45 * fade),
          pool.baseB[i]! * glow * fade * 0.5,
          THREE.LinearSRGBColorSpace,
        );
        pool.mesh.setColorAt(writeIdx, _workColor);
      } else {
        // Ударная сфера Садовского и вспышка эпицентра
        const ease = 1 - Math.pow(1 - t, 2.4);
        const radius = pool.size0[i]! + (pool.size1[i]! - pool.size0[i]!) * ease;
        _quat.identity();
        _scale.set(radius, radius, radius);
        _mat4.compose(_pos, _quat, _scale);
        pool.mesh.setMatrixAt(writeIdx, _mat4);

        const fade = Math.pow(1 - t, 1.8);
        const intensity = pool.kind[i] === 0 ? 1.8 * fade : 0.85 * fade;
        _workColor.setRGB(
          pool.baseR[i]! * intensity,
          pool.baseG[i]! * intensity * (0.65 + 0.35 * fade),
          pool.baseB[i]! * intensity * fade * 0.35,
          THREE.LinearSRGBColorSpace,
        );
        pool.mesh.setColorAt(writeIdx, _workColor);
      }

      writeIdx += 1;
    }

    pool.activeCount = writeIdx;
    pool.mesh.count = writeIdx;
    pool.mesh.visible = writeIdx > 0;

    if (writeIdx > 0) {
      pool.mesh.instanceMatrix.needsUpdate = true;
      if (pool.mesh.instanceColor) {
        pool.mesh.instanceColor.needsUpdate = true;
      }
    }
  }

  private trimPoolToLimit(pool: SoAParticlePool): void {
    let active = 0;
    for (let i = 0; i < pool.maxCapacity; i++) {
      if (i >= pool.effectiveLimit) {
        pool.alive[i] = 0;
      } else if (pool.alive[i] !== 0) {
        active += 1;
      }
    }
    pool.activeCount = active;
    pool.cursor = pool.cursor % Math.max(1, pool.effectiveLimit);
  }

  private clearPool(pool: SoAParticlePool): void {
    pool.alive.fill(0);
    pool.activeCount = 0;
    pool.cursor = 0;
    pool.mesh.count = 0;
    pool.mesh.visible = false;
  }
}
