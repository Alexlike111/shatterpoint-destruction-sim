import * as THREE from 'three';
import { clamp } from '../core/math3d';
import type {
  PlantedChargeSnapshot,
  QualityPreset,
  RenderSnapshot,
  RenderViewMode,
} from '../core/types';

/**
 * Слой 3D-визуализации графа внутренних связей (bond), арматурных тяжей (rebar),
 * пластических шарниров стали (plastic_hinge), маркеров критических опор,
 * зарядов C4 с очередью секвенсора (delaySec / remainingCountdownSec) и летящих снарядов.
 */

export interface RebarAndJointStats {
  visibleBondLines: number;
  visibleRebars: number;
  visibleHinges: number;
  visibleCharges: number;
  visibleProjectiles: number;
  estimatedDrawCalls: number;
}

const INITIAL_LINE_SEGMENTS_CAPACITY = 4096;
const INITIAL_REBAR_CAPACITY = 1024;
const INITIAL_HINGE_CAPACITY = 512;
const INITIAL_C4_CAPACITY = 128;
const INITIAL_PROJECTILE_CAPACITY = 128;

const UP_Y = new THREE.Vector3(0, 1, 0);
const _pos = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _scale = new THREE.Vector3();
const _mat4 = new THREE.Matrix4();
const _workColor = new THREE.Color();
const _colorA = new THREE.Color();
const _colorB = new THREE.Color();

function sanitizeCoord(v: number, fallback = 0): number {
  return Number.isFinite(v) ? clamp(v, -1e5, 1e5) : fallback;
}

function sanitizeExtent(v: number, min: number, max: number, fallback: number): number {
  return Number.isFinite(v) ? clamp(v, min, max) : fallback;
}

function sanitizeFinite(v: number, min: number, max: number, fallback: number): number {
  return Number.isFinite(v) ? clamp(v, min, max) : fallback;
}

function lerpSrgbHex(
  hexA: number,
  hexB: number,
  t: number,
  target: THREE.Color,
): THREE.Color {
  const clampedT = Number.isFinite(t) ? clamp(t, 0, 1) : 0;
  _colorA.setHex(hexA, THREE.SRGBColorSpace);
  _colorB.setHex(hexB, THREE.SRGBColorSpace);
  return target.copy(_colorA).lerp(_colorB, clampedT);
}

/**
 * Вычисляет цвет несущей связи по осевому усилию сжатия/растяжения и коэффициенту использования прочности.
 * Кусочно-линейная интерполяция проходит через бирюзовый, изумрудный, лаймовый и янтарный,
 * математически исключая фиолетовый сектор Hue 262°..318°.
 */
export function computeBondStressColor(
  axialForceN: number,
  stressUtilization: number,
  animTimeSec = 0,
  target: THREE.Color = new THREE.Color(),
): THREE.Color {
  const safeU = sanitizeFinite(stressUtilization, 0, 1.5, 0);
  const safeForce = sanitizeFinite(axialForceN, -1e12, 1e12, 0);
  const safeTime = sanitizeFinite(animTimeSec, -1e5, 1e5, 0);

  // Критическая зона предразрушения (u >= 0.85) — переход от сигнального янтаря к алому накалу
  if (safeU >= 0.85) {
    const tCrit = clamp((safeU - 0.85) / 0.15, 0, 1);
    lerpSrgbHex(0xf59e0b, 0xef4438, tCrit, target);
    if (safeU >= 0.95) {
      const pulse = 0.9 + 0.25 * Math.sin(safeTime * 10.0);
      target.multiplyScalar(pulse);
    }
    return target;
  }

  // Сжатие (axialForceN < -1.0 Н): голубой -> бирюзовый -> оливково-лаймовый -> янтарный
  if (safeForce < -1.0) {
    if (safeU <= 0.35) {
      return lerpSrgbHex(0x38bdf8, 0x14b8a6, safeU / 0.35, target);
    }
    if (safeU <= 0.62) {
      return lerpSrgbHex(0x14b8a6, 0x84cc16, (safeU - 0.35) / 0.27, target);
    }
    return lerpSrgbHex(0x84cc16, 0xf59e0b, (safeU - 0.62) / 0.23, target);
  }

  // Растяжение (axialForceN > +1.0 Н): изумрудный -> лаймовый -> тёплое золото -> медно-оранжевый
  if (safeForce > 1.0) {
    if (safeU <= 0.28) {
      return lerpSrgbHex(0x10b981, 0x84cc16, safeU / 0.28, target);
    }
    if (safeU <= 0.56) {
      return lerpSrgbHex(0x84cc16, 0xfbbf24, (safeU - 0.28) / 0.28, target);
    }
    return lerpSrgbHex(0xfbbf24, 0xea580c, (safeU - 0.56) / 0.29, target);
  }

  // Чистый сдвиг / кручение около нулевого осевого усилия
  if (safeU <= 0.45) {
    return lerpSrgbHex(0x2dd4bf, 0x84cc16, safeU / 0.45, target);
  }
  return lerpSrgbHex(0x84cc16, 0xf59e0b, (safeU - 0.45) / 0.4, target);
}

/**
 * Вычисляет высоту светового столбика и цвет индикатора очереди секвенсора подрыва C4 (без фиолетового).
 */
export function computeC4SequencerBeaconSpec(
  charge: PlantedChargeSnapshot,
  animTimeSec = 0,
  target: THREE.Color = new THREE.Color(),
): { heightM: number; color: THREE.Color } {
  const safeDelay = sanitizeFinite(charge.delaySec, 0, 3600, 0);
  const effectiveSec =
    charge.remainingCountdownSec !== null && Number.isFinite(charge.remainingCountdownSec)
      ? clamp(charge.remainingCountdownSec, 0, 3600)
      : safeDelay;

  const heightM = 0.14 + clamp(effectiveSec, 0, 2.5) * 0.38;

  if (safeDelay <= 0.02) {
    // 1-я мгновенная волна (0.00 с) — сигнальный алый
    target.setHex(0xef4438, THREE.SRGBColorSpace);
  } else if (safeDelay <= 0.35) {
    // 2-я волна (+0.25 с) — сигнальный янтарь
    target.setHex(0xf59e0b, THREE.SRGBColorSpace);
  } else if (safeDelay <= 0.75) {
    // 3-я волна (+0.50 с) — тёплое золото
    target.setHex(0xeab308, THREE.SRGBColorSpace);
  } else {
    // Дальняя волна (+1.00 с и выше) — холодный циан/бирюза
    target.setHex(0x06b6d4, THREE.SRGBColorSpace);
  }

  if (charge.armed) {
    const safeTime = sanitizeFinite(animTimeSec, -1e5, 1e5, 0);
    const safeChargePhase = Number.isFinite(charge.chargeId)
      ? (charge.chargeId % 1024) * 0.8
      : 0;
    const freq = effectiveSec < 0.25 ? 24.0 : 12.0;
    const strobe = 0.62 + 0.38 * Math.sin(safeTime * freq + safeChargePhase);
    target.multiplyScalar(strobe * 1.25);
  }

  return { heightM, color: target };
}

export class RebarAndJointLayer {
  public readonly group: THREE.Group;

  private lineGeometry: THREE.BufferGeometry;
  private linePositions: Float32Array;
  private lineColors: Float32Array;
  private lineSegmentCapacity: number;
  private readonly lineMaterial: THREE.LineBasicMaterial;
  private readonly bondLines: THREE.LineSegments;

  private readonly rebarGeometry: THREE.CylinderGeometry;
  private readonly rebarMaterialPbr: THREE.MeshStandardMaterial;
  private readonly rebarMaterialOverlay: THREE.MeshBasicMaterial;
  private rebarMesh: THREE.InstancedMesh;
  private rebarCapacity: number;

  private readonly hingeGeometry: THREE.OctahedronGeometry;
  private readonly hingeMaterial: THREE.MeshBasicMaterial;
  private hingeAndCriticalMesh: THREE.InstancedMesh;
  private hingeCapacity: number;

  private readonly c4PackGeometry: THREE.BoxGeometry;
  private readonly c4PackMaterial: THREE.MeshStandardMaterial;
  private c4PackMesh: THREE.InstancedMesh;

  private readonly c4BeaconGeometry: THREE.CylinderGeometry;
  private readonly c4BeaconMaterial: THREE.MeshBasicMaterial;
  private c4BeaconMesh: THREE.InstancedMesh;
  private c4Capacity: number;

  private readonly projectileGeometry: THREE.IcosahedronGeometry;
  private readonly projectileMaterial: THREE.MeshStandardMaterial;
  private projectileMesh: THREE.InstancedMesh;

  private readonly tracerGeometry: THREE.ConeGeometry;
  private readonly tracerMaterial: THREE.MeshBasicMaterial;
  private projectileTracerMesh: THREE.InstancedMesh;
  private projectileCapacity: number;

  private viewMode: RenderViewMode = 'pbr';

  private visibleBondLines = 0;
  private visibleRebars = 0;
  private visibleHinges = 0;
  private visibleCharges = 0;
  private visibleProjectiles = 0;
  private visibleTracers = 0;

  private lastSnapshot: RenderSnapshot | null = null;
  private lastCriticalNodeIds: Set<number> = new Set();
  private lastAnimTimeSec = 0;
  private disposed = false;

  constructor() {
    this.group = new THREE.Group();
    this.group.name = 'RebarAndJointLayer';

    // 1. Граф связей (LineSegments)
    this.lineSegmentCapacity = INITIAL_LINE_SEGMENTS_CAPACITY;
    this.linePositions = new Float32Array(this.lineSegmentCapacity * 6);
    this.lineColors = new Float32Array(this.lineSegmentCapacity * 6);
    this.lineGeometry = new THREE.BufferGeometry();
    const posAttr = new THREE.BufferAttribute(this.linePositions, 3);
    posAttr.setUsage(THREE.DynamicDrawUsage);
    const colAttr = new THREE.BufferAttribute(this.lineColors, 3);
    colAttr.setUsage(THREE.DynamicDrawUsage);
    this.lineGeometry.setAttribute('position', posAttr);
    this.lineGeometry.setAttribute('color', colAttr);
    this.lineGeometry.setDrawRange(0, 0);

    this.lineMaterial = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.9,
      depthTest: true,
      depthWrite: false,
      toneMapped: false,
    });
    this.bondLines = new THREE.LineSegments(this.lineGeometry, this.lineMaterial);
    this.bondLines.name = 'StructuralBondLines';
    this.bondLines.frustumCulled = false;
    this.bondLines.visible = false;
    this.bondLines.renderOrder = 8;
    this.group.add(this.bondLines);

    // 2. Физические 3D-тяги оголённой арматуры (rebarMesh)
    this.rebarGeometry = new THREE.CylinderGeometry(1, 1, 1, 6, 1);
    this.rebarMaterialPbr = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.42,
      metalness: 0.78,
    });
    this.rebarMaterialOverlay = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.95,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    this.rebarCapacity = INITIAL_REBAR_CAPACITY;
    this.rebarMesh = this.createInstancedMesh(
      'RebarTethers3D',
      this.rebarGeometry,
      this.rebarMaterialPbr,
      this.rebarCapacity,
      10,
    );
    this.group.add(this.rebarMesh);

    // 3. Пластические шарниры стали + узловые маркеры критических опор
    this.hingeGeometry = new THREE.OctahedronGeometry(1, 0);
    this.hingeMaterial = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.92,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    this.hingeCapacity = INITIAL_HINGE_CAPACITY;
    this.hingeAndCriticalMesh = this.createInstancedMesh(
      'PlasticHingesAndCriticals',
      this.hingeGeometry,
      this.hingeMaterial,
      this.hingeCapacity,
      16,
    );
    this.group.add(this.hingeAndCriticalMesh);

    // 4. Заряды C4 и световые столбики секвенсора
    this.c4PackGeometry = new THREE.BoxGeometry(0.34, 0.12, 0.22);
    this.c4PackMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.52,
      metalness: 0.36,
    });
    this.c4BeaconGeometry = new THREE.CylinderGeometry(0.055, 0.055, 1.0, 10);
    this.c4BeaconMaterial = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.92,
      toneMapped: false,
    });
    this.c4Capacity = INITIAL_C4_CAPACITY;
    this.c4PackMesh = this.createInstancedMesh(
      'PlantedC4Packs',
      this.c4PackGeometry,
      this.c4PackMaterial,
      this.c4Capacity,
      5,
    );
    this.c4BeaconMesh = this.createInstancedMesh(
      'PlantedC4Beacons',
      this.c4BeaconGeometry,
      this.c4BeaconMaterial,
      this.c4Capacity,
      15,
    );
    this.group.add(this.c4PackMesh);
    this.group.add(this.c4BeaconMesh);

    // 5. Баллистические снаряды и их огненные трассеры
    this.projectileGeometry = new THREE.IcosahedronGeometry(1, 1);
    this.projectileMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.28,
      metalness: 0.85,
    });
    // Сдвигаем основание конуса трассера так, чтобы вершина была у снаряда, а хвост уходил назад вдоль -Y
    this.tracerGeometry = new THREE.ConeGeometry(0.55, 1.0, 8);
    this.tracerMaterial = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.74,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    });
    this.projectileCapacity = INITIAL_PROJECTILE_CAPACITY;
    this.projectileMesh = this.createInstancedMesh(
      'BallisticProjectiles',
      this.projectileGeometry,
      this.projectileMaterial,
      this.projectileCapacity,
      4,
    );
    this.projectileTracerMesh = this.createInstancedMesh(
      'BallisticTracers',
      this.tracerGeometry,
      this.tracerMaterial,
      this.projectileCapacity,
      7,
    );
    this.group.add(this.projectileMesh);
    this.group.add(this.projectileTracerMesh);
  }

  public getObject3D(): THREE.Group {
    return this.group;
  }

  /**
   * Синхронизирует связи, арматуру, пластические шарниры, критические опоры, C4 и снаряды.
   */
  public sync(
    snapshot: RenderSnapshot,
    viewMode: RenderViewMode,
    criticalNodeIds: ReadonlySet<number>,
    animTimeSec: number,
  ): void {
    if (this.disposed) return;

    this.viewMode = viewMode;
    this.lastSnapshot = snapshot;
    this.lastAnimTimeSec = sanitizeFinite(animTimeSec, -1e5, 1e5, 0);
    this.lastCriticalNodeIds = new Set(criticalNodeIds);

    this.applyModeMaterials();
    this.syncBondsRebarsAndHinges(snapshot, criticalNodeIds, this.lastAnimTimeSec);
    this.syncPlantedCharges(snapshot.plantedCharges, this.lastAnimTimeSec);
    this.syncProjectiles(snapshot.projectiles);
  }

  /**
   * Немедленно меняет режим визуализации и перестраивает видимость связей по последнему снимку (даже на паузе).
   */
  public setViewMode(mode: RenderViewMode): void {
    if (this.disposed) return;
    this.viewMode = mode;
    this.applyModeMaterials();

    if (this.lastSnapshot) {
      this.syncBondsRebarsAndHinges(
        this.lastSnapshot,
        this.lastCriticalNodeIds,
        this.lastAnimTimeSec,
      );
    }
  }

  public setQualityPreset(_preset: QualityPreset): void {
    if (this.disposed) return;
  }

  public clear(): void {
    if (this.disposed) return;
    this.lastSnapshot = null;

    this.visibleBondLines = 0;
    this.lineGeometry.setDrawRange(0, 0);
    this.bondLines.visible = false;

    this.visibleRebars = 0;
    this.rebarMesh.count = 0;
    this.rebarMesh.visible = false;

    this.visibleHinges = 0;
    this.hingeAndCriticalMesh.count = 0;
    this.hingeAndCriticalMesh.visible = false;

    this.visibleCharges = 0;
    this.c4PackMesh.count = 0;
    this.c4PackMesh.visible = false;
    this.c4BeaconMesh.count = 0;
    this.c4BeaconMesh.visible = false;

    this.visibleProjectiles = 0;
    this.visibleTracers = 0;
    this.projectileMesh.count = 0;
    this.projectileMesh.visible = false;
    this.projectileTracerMesh.count = 0;
    this.projectileTracerMesh.visible = false;
  }

  public getStats(): RebarAndJointStats {
    if (this.disposed) {
      return {
        visibleBondLines: 0,
        visibleRebars: 0,
        visibleHinges: 0,
        visibleCharges: 0,
        visibleProjectiles: 0,
        estimatedDrawCalls: 0,
      };
    }

    let estimatedDrawCalls = 0;
    if (this.bondLines.visible && this.visibleBondLines > 0) estimatedDrawCalls += 1;
    if (this.rebarMesh.visible && this.visibleRebars > 0) estimatedDrawCalls += 1;
    if (this.hingeAndCriticalMesh.visible && this.visibleHinges > 0) estimatedDrawCalls += 1;
    if (this.c4PackMesh.visible && this.visibleCharges > 0) estimatedDrawCalls += 1;
    if (this.c4BeaconMesh.visible && this.visibleCharges > 0) estimatedDrawCalls += 1;
    if (this.projectileMesh.visible && this.visibleProjectiles > 0) estimatedDrawCalls += 1;
    if (this.projectileTracerMesh.visible && this.visibleTracers > 0) estimatedDrawCalls += 1;

    return {
      visibleBondLines: this.visibleBondLines,
      visibleRebars: this.visibleRebars,
      visibleHinges: this.visibleHinges,
      visibleCharges: this.visibleCharges,
      visibleProjectiles: this.visibleProjectiles,
      estimatedDrawCalls,
    };
  }

  public dispose(): void {
    if (this.disposed) return;
    this.clear();
    this.disposed = true;

    this.group.remove(this.bondLines);
    this.lineGeometry.dispose();
    this.lineMaterial.dispose();

    this.group.remove(this.rebarMesh);
    this.rebarMesh.dispose();
    this.rebarGeometry.dispose();
    this.rebarMaterialPbr.dispose();
    this.rebarMaterialOverlay.dispose();

    this.group.remove(this.hingeAndCriticalMesh);
    this.hingeAndCriticalMesh.dispose();
    this.hingeGeometry.dispose();
    this.hingeMaterial.dispose();

    this.group.remove(this.c4PackMesh);
    this.group.remove(this.c4BeaconMesh);
    this.c4PackMesh.dispose();
    this.c4BeaconMesh.dispose();
    this.c4PackGeometry.dispose();
    this.c4PackMaterial.dispose();
    this.c4BeaconGeometry.dispose();
    this.c4BeaconMaterial.dispose();

    this.group.remove(this.projectileMesh);
    this.group.remove(this.projectileTracerMesh);
    this.projectileMesh.dispose();
    this.projectileTracerMesh.dispose();
    this.projectileGeometry.dispose();
    this.projectileMaterial.dispose();
    this.tracerGeometry.dispose();
    this.tracerMaterial.dispose();
  }

  private createInstancedMesh(
    name: string,
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    capacity: number,
    renderOrder: number,
  ): THREE.InstancedMesh {
    const mesh = new THREE.InstancedMesh(geometry, material, capacity);
    mesh.name = name;
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.renderOrder = renderOrder;
    mesh.count = 0;
    mesh.visible = false;

    _workColor.setRGB(1, 1, 1, THREE.LinearSRGBColorSpace);
    mesh.setColorAt(0, _workColor);
    return mesh;
  }

  private applyModeMaterials(): void {
    if (this.viewMode === 'xray') {
      this.lineMaterial.depthTest = false;
      this.lineMaterial.opacity = 0.92;
      this.bondLines.renderOrder = 14;
      this.rebarMesh.material = this.rebarMaterialOverlay;
      this.rebarMesh.renderOrder = 15;
    } else if (this.viewMode === 'stress') {
      this.lineMaterial.depthTest = false;
      this.lineMaterial.opacity = 0.78;
      this.bondLines.renderOrder = 8;
      this.rebarMesh.material = this.rebarMaterialOverlay;
      this.rebarMesh.renderOrder = 10;
    } else {
      this.lineMaterial.depthTest = true;
      this.lineMaterial.opacity = 0.85;
      this.bondLines.renderOrder = 4;
      this.rebarMesh.material = this.rebarMaterialPbr;
      this.rebarMesh.renderOrder = 2;
    }
  }

  private ensureLineCapacity(neededSegments: number): void {
    if (neededSegments <= this.lineSegmentCapacity) return;

    const newCap = Math.max(neededSegments, this.lineSegmentCapacity * 2);
    this.lineSegmentCapacity = newCap;
    this.linePositions = new Float32Array(newCap * 6);
    this.lineColors = new Float32Array(newCap * 6);

    this.lineGeometry.dispose();
    this.lineGeometry = new THREE.BufferGeometry();
    const posAttr = new THREE.BufferAttribute(this.linePositions, 3);
    posAttr.setUsage(THREE.DynamicDrawUsage);
    const colAttr = new THREE.BufferAttribute(this.lineColors, 3);
    colAttr.setUsage(THREE.DynamicDrawUsage);
    this.lineGeometry.setAttribute('position', posAttr);
    this.lineGeometry.setAttribute('color', colAttr);
    this.bondLines.geometry = this.lineGeometry;
  }

  private syncBondsRebarsAndHinges(
    snapshot: RenderSnapshot,
    criticalNodeIds: ReadonlySet<number>,
    animTimeSec: number,
  ): void {
    const lines = snapshot.bondsAndRebars;
    const showInternalBonds = this.viewMode === 'stress' || this.viewMode === 'xray';

    let neededLines = 0;
    let neededRebars = 0;
    let neededHinges = 0;

    for (let i = 0; i < lines.length; i++) {
      const item = lines[i]!;
      if (item.broken) continue;
      if (showInternalBonds) {
        neededLines += 1;
      }
      if (item.kind === 'rebar') {
        neededRebars += 1;
      } else if (item.kind === 'plastic_hinge') {
        neededHinges += 1;
      }
    }

    if (showInternalBonds && criticalNodeIds.size > 0) {
      for (let i = 0; i < snapshot.blocks.length; i++) {
        if (criticalNodeIds.has(snapshot.blocks[i]!.nodeId)) {
          neededHinges += 1;
        }
      }
    }

    // При необходимости увеличиваем буферы
    if (neededLines > 0) {
      this.ensureLineCapacity(neededLines);
    }
    if (neededRebars > this.rebarCapacity) {
      this.group.remove(this.rebarMesh);
      this.rebarMesh.dispose();
      this.rebarCapacity = Math.max(neededRebars, this.rebarCapacity * 2);
      this.rebarMesh = this.createInstancedMesh(
        'RebarTethers3D',
        this.rebarGeometry,
        this.viewMode === 'pbr' ? this.rebarMaterialPbr : this.rebarMaterialOverlay,
        this.rebarCapacity,
        this.viewMode === 'xray' ? 15 : 4,
      );
      this.group.add(this.rebarMesh);
    }
    if (neededHinges > this.hingeCapacity) {
      this.group.remove(this.hingeAndCriticalMesh);
      this.hingeAndCriticalMesh.dispose();
      this.hingeCapacity = Math.max(neededHinges, this.hingeCapacity * 2);
      this.hingeAndCriticalMesh = this.createInstancedMesh(
        'PlasticHingesAndCriticals',
        this.hingeGeometry,
        this.hingeMaterial,
        this.hingeCapacity,
        16,
      );
      this.group.add(this.hingeAndCriticalMesh);
    }

    let lineIdx = 0;
    let rebarIdx = 0;
    let hingeIdx = 0;
    const rebarRadius = this.viewMode === 'xray' ? 0.042 : 0.028;

    const safeAnimTime = sanitizeFinite(animTimeSec, -1e5, 1e5, 0);

    for (let i = 0; i < lines.length; i++) {
      const item = lines[i]!;
      if (item.broken) continue;

      const ax = sanitizeCoord(item.pointA[0]);
      const ay = sanitizeCoord(item.pointA[1]);
      const az = sanitizeCoord(item.pointA[2]);
      const bx = sanitizeCoord(item.pointB[0]);
      const by = sanitizeCoord(item.pointB[1]);
      const bz = sanitizeCoord(item.pointB[2]);
      const safeU = sanitizeFinite(item.stressUtilization, 0, 1.5, 0);
      const safeForce = sanitizeFinite(item.axialForceN, -1e12, 1e12, 0);

      if (showInternalBonds) {
        computeBondStressColor(safeForce, safeU, safeAnimTime, _workColor);
        const off = lineIdx * 6;
        this.linePositions[off] = ax;
        this.linePositions[off + 1] = ay;
        this.linePositions[off + 2] = az;
        this.linePositions[off + 3] = bx;
        this.linePositions[off + 4] = by;
        this.linePositions[off + 5] = bz;

        this.lineColors[off] = _workColor.r;
        this.lineColors[off + 1] = _workColor.g;
        this.lineColors[off + 2] = _workColor.b;
        this.lineColors[off + 3] = _workColor.r;
        this.lineColors[off + 4] = _workColor.g;
        this.lineColors[off + 5] = _workColor.b;
        lineIdx += 1;
      }

      if (item.kind === 'rebar') {
        _dir.set(bx - ax, by - ay, bz - az);
        const len = _dir.length();
        if (Number.isFinite(len) && len >= 1e-4) {
          _dir.multiplyScalar(1 / len);
          _pos.set((ax + bx) * 0.5, (ay + by) * 0.5, (az + bz) * 0.5);
          _quat.setFromUnitVectors(UP_Y, _dir);
          _scale.set(rebarRadius, len, rebarRadius);
          _mat4.compose(_pos, _quat, _scale);
          this.rebarMesh.setMatrixAt(rebarIdx, _mat4);

          if (this.viewMode === 'pbr') {
            const u = clamp(safeU, 0, 1.2);
            if (u <= 0.65) {
              _workColor.setHex(0x94a3b8, THREE.SRGBColorSpace);
            } else if (u <= 0.9) {
              lerpSrgbHex(0x94a3b8, 0xf59e0b, (u - 0.65) / 0.25, _workColor);
            } else {
              lerpSrgbHex(0xf59e0b, 0xef4438, (u - 0.9) / 0.3, _workColor);
            }
          } else {
            computeBondStressColor(safeForce, safeU, safeAnimTime, _workColor);
          }

          this.rebarMesh.setColorAt(rebarIdx, _workColor);
          rebarIdx += 1;
        }
      } else if (item.kind === 'plastic_hinge') {
        _pos.set((ax + bx) * 0.5, (ay + by) * 0.5, (az + bz) * 0.5);
        _quat.identity();
        const r = 0.14 + 0.08 * safeU;
        _scale.set(r, r, r);
        _mat4.compose(_pos, _quat, _scale);
        this.hingeAndCriticalMesh.setMatrixAt(hingeIdx, _mat4);

        lerpSrgbHex(
          0xf59e0b,
          0xea580c,
          clamp((safeU - 0.5) / 0.5, 0, 1),
          _workColor,
        );
        this.hingeAndCriticalMesh.setColorAt(hingeIdx, _workColor);
        hingeIdx += 1;
      }
    }

    // Узловые 3D-маяки критических несущих опор в режимах 'stress' и 'xray'
    if (showInternalBonds && criticalNodeIds.size > 0) {
      for (let i = 0; i < snapshot.blocks.length; i++) {
        const block = snapshot.blocks[i]!;
        if (!Number.isFinite(block.nodeId) || !criticalNodeIds.has(block.nodeId)) continue;

        const px = sanitizeCoord(block.position[0]);
        const py = sanitizeCoord(block.position[1]);
        const pz = sanitizeCoord(block.position[2]);
        const hx = sanitizeExtent(block.halfExtents[0], 1e-4, 1e4, 0.5);
        const hy = sanitizeExtent(block.halfExtents[1], 1e-4, 1e4, 0.5);
        const hz = sanitizeExtent(block.halfExtents[2], 1e-4, 1e4, 0.5);
        const minHalf = Math.max(0.12, Math.min(hx, hy, hz) * 0.62);
        const safeNodePhase = block.nodeId % 1024;
        const pulse = 0.85 + 0.15 * Math.sin(safeAnimTime * 6.5 + safeNodePhase * 0.7);

        _pos.set(px, py, pz);
        _quat.setFromAxisAngle(UP_Y, safeAnimTime * 1.4 + safeNodePhase * 0.5);
        _scale.set(minHalf * pulse, minHalf * pulse, minHalf * pulse);
        _mat4.compose(_pos, _quat, _scale);
        this.hingeAndCriticalMesh.setMatrixAt(hingeIdx, _mat4);

        const safeBlockU = sanitizeFinite(block.stressUtilization, 0, 10, 0);
        if (safeBlockU >= 0.75) {
          _workColor.setHex(0xef4438, THREE.SRGBColorSpace);
        } else {
          _workColor.setHex(0xf59e0b, THREE.SRGBColorSpace);
        }
        this.hingeAndCriticalMesh.setColorAt(hingeIdx, _workColor);
        hingeIdx += 1;
      }
    }

    // Фиксация буфера связей LineSegments
    this.visibleBondLines = lineIdx;
    this.lineGeometry.setDrawRange(0, lineIdx * 2);
    this.bondLines.visible = lineIdx > 0;
    if (lineIdx > 0) {
      const posAttr = this.lineGeometry.getAttribute('position');
      const colAttr = this.lineGeometry.getAttribute('color');
      if (posAttr instanceof THREE.BufferAttribute) posAttr.needsUpdate = true;
      if (colAttr instanceof THREE.BufferAttribute) colAttr.needsUpdate = true;
    }

    // Фиксация 3D-тяжей арматуры
    this.visibleRebars = rebarIdx;
    this.rebarMesh.count = rebarIdx;
    this.rebarMesh.visible = rebarIdx > 0;
    if (rebarIdx > 0) {
      this.rebarMesh.instanceMatrix.needsUpdate = true;
      if (this.rebarMesh.instanceColor) this.rebarMesh.instanceColor.needsUpdate = true;
    }

    // Фиксация шарниров и маяков критических узлов
    this.visibleHinges = hingeIdx;
    this.hingeAndCriticalMesh.count = hingeIdx;
    this.hingeAndCriticalMesh.visible = hingeIdx > 0;
    if (hingeIdx > 0) {
      this.hingeAndCriticalMesh.instanceMatrix.needsUpdate = true;
      if (this.hingeAndCriticalMesh.instanceColor) {
        this.hingeAndCriticalMesh.instanceColor.needsUpdate = true;
      }
    }
  }

  private syncPlantedCharges(
    charges: readonly PlantedChargeSnapshot[],
    animTimeSec: number,
  ): void {
    const count = charges.length;
    if (count === 0) {
      this.visibleCharges = 0;
      this.c4PackMesh.count = 0;
      this.c4PackMesh.visible = false;
      this.c4BeaconMesh.count = 0;
      this.c4BeaconMesh.visible = false;
      return;
    }

    if (count > this.c4Capacity) {
      this.group.remove(this.c4PackMesh);
      this.group.remove(this.c4BeaconMesh);
      this.c4PackMesh.dispose();
      this.c4BeaconMesh.dispose();

      this.c4Capacity = Math.max(count, this.c4Capacity * 2);
      this.c4PackMesh = this.createInstancedMesh(
        'PlantedC4Packs',
        this.c4PackGeometry,
        this.c4PackMaterial,
        this.c4Capacity,
        5,
      );
      this.c4BeaconMesh = this.createInstancedMesh(
        'PlantedC4Beacons',
        this.c4BeaconGeometry,
        this.c4BeaconMaterial,
        this.c4Capacity,
        15,
      );
      this.group.add(this.c4PackMesh);
      this.group.add(this.c4BeaconMesh);
    }

    const safeAnimTime = sanitizeFinite(animTimeSec, -1e5, 1e5, 0);

    for (let i = 0; i < count; i++) {
      const ch = charges[i]!;
      const cx = sanitizeCoord(ch.position[0]);
      const cy = sanitizeCoord(ch.position[1]);
      const cz = sanitizeCoord(ch.position[2]);

      const nx = ch.normal[0];
      const ny = ch.normal[1];
      const nz = ch.normal[2];
      if (Number.isFinite(nx) && Number.isFinite(ny) && Number.isFinite(nz)) {
        const maxN = Math.max(Math.abs(nx), Math.abs(ny), Math.abs(nz));
        if (maxN > 1e-6) {
          const invMax = 1 / maxN;
          _dir.set(nx * invMax, ny * invMax, nz * invMax);
          const lenSq = _dir.lengthSq();
          if (!(lenSq > 1e-8) || !Number.isFinite(lenSq)) {
            _dir.set(0, 1, 0);
          } else {
            _dir.multiplyScalar(1 / Math.sqrt(lenSq));
          }
        } else {
          _dir.set(0, 1, 0);
        }
      } else {
        _dir.set(0, 1, 0);
      }
      _quat.setFromUnitVectors(UP_Y, _dir);

      // Пакет взрывчатки C4
      _pos.set(
        cx + _dir.x * 0.065,
        cy + _dir.y * 0.065,
        cz + _dir.z * 0.065,
      );
      _scale.set(1, 1, 1);
      _mat4.compose(_pos, _quat, _scale);
      this.c4PackMesh.setMatrixAt(i, _mat4);

      if (ch.armed) {
        _workColor.setHex(0x991b1b, THREE.SRGBColorSpace);
      } else {
        _workColor.setHex(0x3b4754, THREE.SRGBColorSpace);
      }
      this.c4PackMesh.setColorAt(i, _workColor);

      // Световой столбик очереди секвенсора каскадного подрыва
      const beaconSpec = computeC4SequencerBeaconSpec(ch, safeAnimTime, _workColor);
      const halfBeacon = beaconSpec.heightM * 0.5;
      _pos.set(
        cx + _dir.x * (0.125 + halfBeacon),
        cy + _dir.y * (0.125 + halfBeacon),
        cz + _dir.z * (0.125 + halfBeacon),
      );
      _scale.set(1, beaconSpec.heightM, 1);
      _mat4.compose(_pos, _quat, _scale);
      this.c4BeaconMesh.setMatrixAt(i, _mat4);
      this.c4BeaconMesh.setColorAt(i, beaconSpec.color);
    }

    this.visibleCharges = count;
    this.c4PackMesh.count = count;
    this.c4PackMesh.visible = true;
    this.c4PackMesh.instanceMatrix.needsUpdate = true;
    if (this.c4PackMesh.instanceColor) this.c4PackMesh.instanceColor.needsUpdate = true;

    this.c4BeaconMesh.count = count;
    this.c4BeaconMesh.visible = true;
    this.c4BeaconMesh.instanceMatrix.needsUpdate = true;
    if (this.c4BeaconMesh.instanceColor) this.c4BeaconMesh.instanceColor.needsUpdate = true;
  }

  private syncProjectiles(projectiles: RenderSnapshot['projectiles']): void {
    const count = projectiles.length;
    if (count === 0) {
      this.visibleProjectiles = 0;
      this.visibleTracers = 0;
      this.projectileMesh.count = 0;
      this.projectileMesh.visible = false;
      this.projectileTracerMesh.count = 0;
      this.projectileTracerMesh.visible = false;
      return;
    }

    if (count > this.projectileCapacity) {
      this.group.remove(this.projectileMesh);
      this.group.remove(this.projectileTracerMesh);
      this.projectileMesh.dispose();
      this.projectileTracerMesh.dispose();

      this.projectileCapacity = Math.max(count, this.projectileCapacity * 2);
      this.projectileMesh = this.createInstancedMesh(
        'BallisticProjectiles',
        this.projectileGeometry,
        this.projectileMaterial,
        this.projectileCapacity,
        4,
      );
      this.projectileTracerMesh = this.createInstancedMesh(
        'BallisticTracers',
        this.tracerGeometry,
        this.tracerMaterial,
        this.projectileCapacity,
        7,
      );
      this.group.add(this.projectileMesh);
      this.group.add(this.projectileTracerMesh);
    }

    let tracerCursor = 0;

    for (let i = 0; i < count; i++) {
      const proj = projectiles[i]!;
      const px = sanitizeCoord(proj.position[0]);
      const py = sanitizeCoord(proj.position[1]);
      const pz = sanitizeCoord(proj.position[2]);
      const r =
        Number.isFinite(proj.radiusM) && proj.radiusM > 0
          ? clamp(proj.radiusM, 0.06, 100)
          : 0.14;

      _pos.set(px, py, pz);
      _quat.identity();
      _scale.set(r, r, r);
      _mat4.compose(_pos, _quat, _scale);
      this.projectileMesh.setMatrixAt(i, _mat4);

      if (proj.hot) {
        _workColor.setRGB(1.85, 0.85, 0.25, THREE.LinearSRGBColorSpace);
      } else {
        _workColor.setHex(0xcbd5e1, THREE.SRGBColorSpace);
      }
      this.projectileMesh.setColorAt(i, _workColor);

      // Трассер позади летящего снаряда
      const vx = sanitizeFinite(proj.velocity[0], -1e5, 1e5, 0);
      const vy = sanitizeFinite(proj.velocity[1], -1e5, 1e5, 0);
      const vz = sanitizeFinite(proj.velocity[2], -1e5, 1e5, 0);
      const speed = Math.hypot(vx, vy, vz);
      if (Number.isFinite(speed) && speed > 0.5) {
        _dir.set(vx / speed, vy / speed, vz / speed);
        const tracerLen = clamp(speed * 0.045, r * 1.8, Math.max(5.5, r * 1.8));
        _pos.set(
          px - _dir.x * (tracerLen * 0.5 + r * 0.4),
          py - _dir.y * (tracerLen * 0.5 + r * 0.4),
          pz - _dir.z * (tracerLen * 0.5 + r * 0.4),
        );
        _quat.setFromUnitVectors(UP_Y, _dir);
        _scale.set(r * 1.15, tracerLen, r * 1.15);
        _mat4.compose(_pos, _quat, _scale);
        this.projectileTracerMesh.setMatrixAt(tracerCursor, _mat4);

        if (proj.hot) {
          _workColor.setHex(0xf97316, THREE.SRGBColorSpace);
        } else {
          _workColor.setHex(0xf59e0b, THREE.SRGBColorSpace);
        }
        this.projectileTracerMesh.setColorAt(tracerCursor, _workColor);
        tracerCursor += 1;
      }
    }

    this.visibleProjectiles = count;
    this.projectileMesh.count = count;
    this.projectileMesh.visible = true;
    this.projectileMesh.instanceMatrix.needsUpdate = true;
    if (this.projectileMesh.instanceColor) this.projectileMesh.instanceColor.needsUpdate = true;

    this.visibleTracers = tracerCursor;
    this.projectileTracerMesh.count = tracerCursor;
    this.projectileTracerMesh.visible = tracerCursor > 0;
    if (tracerCursor > 0) {
      this.projectileTracerMesh.instanceMatrix.needsUpdate = true;
      if (this.projectileTracerMesh.instanceColor) {
        this.projectileTracerMesh.instanceColor.needsUpdate = true;
      }
    }
  }
}
