import * as THREE from 'three';
import { clamp } from '../core/math3d';
import type { RenderSnapshot, StructuralMaterialId, ToolId } from '../core/types';
import { getMaterialProfile } from '../physics/MaterialRegistry';

/**
 * Тактический 3D-оверлей сцены («ТОЧКА РАЗЛОМА»):
 * 1) Живой голографический 3D-прицел на гранях зданий и полигона (ориентирован по нормали грани,
 *    показывает реальный радиус ударной волны Фугаса / зоны Термита / контур C4 / перекрестие Пушки);
 * 2) Яркий 3D-луч плазморезака с раскалённым пятном контакта при удержании ЛКМ;
 * 3) Светящиеся баллистические трассеры летящих снарядов;
 * 4) Полупрозрачный 3D-призрак блока в режиме Конструктора Песочницы.
 *
 * Все геометрии переиспользуются без аллокаций в кадре и укладываются в 1–3 Draw Calls.
 */

export type SkyAtmospherePreset = 'day' | 'sunset' | 'night';

export interface AimReticleState {
  visible: boolean;
  point: [number, number, number];
  normal: [number, number, number];
  tool: ToolId;
  radiusM: number;
  buildMode: boolean;
  buildMaterialId: StructuralMaterialId;
  ghostCenter?: [number, number, number];
  ghostHalfExtents?: [number, number, number];
}

export interface PlasmaBeamState {
  active: boolean;
  origin: [number, number, number];
  hitPoint: [number, number, number];
}

const MAX_OVERLAY_SEGMENTS = 256;
const RING_SEGMENTS = 32;
const UP_Y = new THREE.Vector3(0, 1, 0);

const _origin = new THREE.Vector3();
const _target = new THREE.Vector3();
const _normal = new THREE.Vector3();
const _tangent = new THREE.Vector3();
const _bitangent = new THREE.Vector3();
const _mid = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _quat = new THREE.Quaternion();

function safeCoord(v: number, fallback = 0): number {
  return Number.isFinite(v) ? clamp(v, -1e4, 1e4) : fallback;
}

export class TacticalOverlay3D {
  private readonly root: THREE.Group;

  // Единый буфер линий для 3D-прицела и трассеров снарядов (1 Draw Call)
  private readonly linePositions: Float32Array;
  private readonly lineColors: Float32Array;
  private readonly lineGeometry: THREE.BufferGeometry;
  private readonly lineMaterial: THREE.LineBasicMaterial;
  private readonly lineSegments: THREE.LineSegments;

  // Луч плазморезака и пятно контакта
  private readonly beamGroup: THREE.Group;
  private readonly beamCoreGeometry: THREE.CylinderGeometry;
  private readonly beamGlowGeometry: THREE.CylinderGeometry;
  private readonly beamTipGeometry: THREE.SphereGeometry;
  private readonly beamCoreMaterial: THREE.MeshBasicMaterial;
  private readonly beamGlowMaterial: THREE.MeshBasicMaterial;
  private readonly beamCoreMesh: THREE.Mesh;
  private readonly beamGlowMesh: THREE.Mesh;
  private readonly beamTipMesh: THREE.Mesh;

  // Полупрозрачный 3D-призрак блока Конструктора
  private readonly ghostGeometry: THREE.BoxGeometry;
  private readonly ghostMaterial: THREE.MeshBasicMaterial;
  private readonly ghostMesh: THREE.Mesh;

  private reticleState: AimReticleState = {
    visible: false,
    point: [0, 0, 0],
    normal: [0, 1, 0],
    tool: 'cannon',
    radiusM: 1.0,
    buildMode: false,
    buildMaterialId: 'reinforced_concrete',
  };

  private beamState: PlasmaBeamState = {
    active: false,
    origin: [0, 2, 10],
    hitPoint: [0, 2, 0],
  };

  private projectiles: RenderSnapshot['projectiles'] = [];
  private animPhaseSec = 0;
  private disposed = false;

  constructor() {
    this.root = new THREE.Group();
    this.root.name = 'TacticalOverlay3DGroup';

    this.linePositions = new Float32Array(MAX_OVERLAY_SEGMENTS * 6);
    this.lineColors = new Float32Array(MAX_OVERLAY_SEGMENTS * 6);
    this.lineGeometry = new THREE.BufferGeometry();
    this.lineGeometry.setAttribute(
      'position',
      new THREE.BufferAttribute(this.linePositions, 3).setUsage(THREE.DynamicDrawUsage),
    );
    this.lineGeometry.setAttribute(
      'color',
      new THREE.BufferAttribute(this.lineColors, 3).setUsage(THREE.DynamicDrawUsage),
    );
    this.lineGeometry.setDrawRange(0, 0);

    this.lineMaterial = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.92,
      depthWrite: false,
    });

    this.lineSegments = new THREE.LineSegments(this.lineGeometry, this.lineMaterial);
    this.lineSegments.name = 'TacticalReticleAndTracers';
    this.lineSegments.frustumCulled = false;
    this.lineSegments.visible = false;
    this.root.add(this.lineSegments);

    // Инициализация 3D-луча плазморезака (бело-золотое ядро + янтарный ореол, 0% фиолетового)
    this.beamGroup = new THREE.Group();
    this.beamGroup.name = 'PlasmaCutterBeamGroup';
    this.beamGroup.visible = false;

    this.beamCoreGeometry = new THREE.CylinderGeometry(0.035, 0.035, 1, 8, 1, true);
    this.beamGlowGeometry = new THREE.CylinderGeometry(0.11, 0.08, 1, 10, 1, true);
    this.beamTipGeometry = new THREE.SphereGeometry(0.18, 10, 8);

    this.beamCoreMaterial = new THREE.MeshBasicMaterial({
      color: 0xfef3c7,
      transparent: true,
      opacity: 0.96,
      depthWrite: false,
    });
    this.beamGlowMaterial = new THREE.MeshBasicMaterial({
      color: 0xf59e0b,
      transparent: true,
      opacity: 0.45,
      depthWrite: false,
      side: THREE.DoubleSide,
    });

    this.beamCoreMesh = new THREE.Mesh(this.beamCoreGeometry, this.beamCoreMaterial);
    this.beamGlowMesh = new THREE.Mesh(this.beamGlowGeometry, this.beamGlowMaterial);
    this.beamTipMesh = new THREE.Mesh(this.beamTipGeometry, this.beamCoreMaterial);
    this.beamGroup.add(this.beamCoreMesh);
    this.beamGroup.add(this.beamGlowMesh);
    this.beamGroup.add(this.beamTipMesh);
    this.root.add(this.beamGroup);

    // Инициализация 3D-призрака блока для Конструктора
    this.ghostGeometry = new THREE.BoxGeometry(2, 2, 2);
    this.ghostMaterial = new THREE.MeshBasicMaterial({
      color: 0x38bdf8,
      transparent: true,
      opacity: 0.36,
      depthWrite: false,
    });
    this.ghostMesh = new THREE.Mesh(this.ghostGeometry, this.ghostMaterial);
    this.ghostMesh.name = 'SandboxBuilderGhostBlock';
    this.ghostMesh.visible = false;
    this.root.add(this.ghostMesh);
  }

  public getObject3D(): THREE.Group {
    return this.root;
  }

  public syncProjectiles(projectiles: RenderSnapshot['projectiles']): void {
    if (this.disposed) return;
    this.projectiles = projectiles;
    if (projectiles.length === 0 && !this.reticleState.visible) {
      this.lineGeometry.setDrawRange(0, 0);
      this.lineSegments.visible = false;
    }
  }

  public clear(): void {
    if (this.disposed) return;
    this.projectiles = [];
    this.reticleState.visible = false;
    this.beamState.active = false;
    this.lineGeometry.setDrawRange(0, 0);
    this.lineSegments.visible = false;
    this.beamGroup.visible = false;
    this.ghostMesh.visible = false;
  }

  public setAimReticle(state: Partial<AimReticleState>): void {
    if (this.disposed) return;
    this.reticleState = {
      ...this.reticleState,
      ...state,
    };
  }

  public setPlasmaBeam(state: PlasmaBeamState): void {
    if (this.disposed) return;
    this.beamState = state;
  }

  public update(dtRealSec: number): void {
    if (this.disposed) return;
    const dt = Number.isFinite(dtRealSec) && dtRealSec > 0 ? Math.min(0.25, dtRealSec) : 0;
    this.animPhaseSec = (this.animPhaseSec + dt) % 3600;

    let segCount = 0;

    const pushSeg = (
      ax: number,
      ay: number,
      az: number,
      bx: number,
      by: number,
      bz: number,
      r: number,
      g: number,
      b: number,
    ): void => {
      if (segCount >= MAX_OVERLAY_SEGMENTS) return;
      const off = segCount * 6;
      this.linePositions[off] = safeCoord(ax);
      this.linePositions[off + 1] = safeCoord(ay);
      this.linePositions[off + 2] = safeCoord(az);
      this.linePositions[off + 3] = safeCoord(bx);
      this.linePositions[off + 4] = safeCoord(by);
      this.linePositions[off + 5] = safeCoord(bz);

      this.lineColors[off] = r;
      this.lineColors[off + 1] = g;
      this.lineColors[off + 2] = b;
      this.lineColors[off + 3] = r;
      this.lineColors[off + 4] = g;
      this.lineColors[off + 5] = b;
      segCount += 1;
    };

    // 1. Трассеры летящих снарядов пушки
    for (let i = 0; i < this.projectiles.length; i++) {
      const p = this.projectiles[i]!;
      const [px, py, pz] = p.position;
      const [vx, vy, vz] = p.velocity;
      const speed = Math.hypot(vx, vy, vz);
      if (!Number.isFinite(speed) || speed < 0.5) continue;
      const tailLen = clamp(speed * 0.028, 0.8, 5.5);
      const invS = 1 / speed;
      const tx = px - vx * invS * tailLen;
      const ty = py - vy * invS * tailLen;
      const tz = pz - vz * invS * tailLen;
      pushSeg(px, py, pz, tx, ty, tz, 1.0, p.hot ? 0.52 : 0.78, 0.14);
    }

    // 2. Голографический 3D-прицел на грани и призрак блока Конструктора
    const ret = this.reticleState;
    if (ret.visible && ret.buildMode && ret.ghostCenter && ret.ghostHalfExtents) {
      const profile = getMaterialProfile(ret.buildMaterialId);
      this.ghostMaterial.color.setHex(profile.baseColorHex, THREE.SRGBColorSpace);
      this.ghostMaterial.opacity = 0.36 + 0.08 * Math.sin(this.animPhaseSec * 6);
      this.ghostMesh.position.set(
        safeCoord(ret.ghostCenter[0]),
        safeCoord(ret.ghostCenter[1]),
        safeCoord(ret.ghostCenter[2]),
      );
      this.ghostMesh.scale.set(
        clamp(ret.ghostHalfExtents[0], 0.05, 20),
        clamp(ret.ghostHalfExtents[1], 0.05, 20),
        clamp(ret.ghostHalfExtents[2], 0.05, 20),
      );
      this.ghostMesh.visible = true;

      // Контурные уголки вокруг призрака блока
      const [cx, cy, cz] = ret.ghostCenter;
      const [hx, hy, hz] = ret.ghostHalfExtents;
      for (const sx of [-1, 1]) {
        for (const sz of [-1, 1]) {
          pushSeg(
            cx + sx * hx,
            cy - hy,
            cz + sz * hz,
            cx + sx * hx,
            cy + hy,
            cz + sz * hz,
            0.22,
            0.85,
            0.96,
          );
        }
      }
    } else {
      this.ghostMesh.visible = false;
    }

    if (ret.visible && !ret.buildMode) {
      _normal.set(
        safeCoord(ret.normal[0], 0),
        safeCoord(ret.normal[1], 1),
        safeCoord(ret.normal[2], 0),
      );
      if (_normal.lengthSq() < 1e-6) {
        _normal.set(0, 1, 0);
      } else {
        _normal.normalize();
      }

      if (Math.abs(_normal.y) < 0.92) {
        _tangent.crossVectors(UP_Y, _normal).normalize();
      } else {
        _tangent.set(1, 0, 0).cross(_normal).normalize();
      }
      _bitangent.crossVectors(_normal, _tangent).normalize();

      // Слегка приподнимаем прицел над гранью на 2.5 см против z-fighting
      const cx = safeCoord(ret.point[0]) + _normal.x * 0.025;
      const cy = safeCoord(ret.point[1]) + _normal.y * 0.025;
      const cz = safeCoord(ret.point[2]) + _normal.z * 0.025;

      // Палитра прицела по инструменту (строго без фиолетового Hue 262..318)
      let cr = 0.96;
      let cg = 0.62;
      let cb = 0.05;
      if (ret.tool === 'cannon') {
        cr = 0.22;
        cg = 0.78;
        cb = 0.96;
      } else if (ret.tool === 'c4') {
        cr = 0.95;
        cg = 0.28;
        cb = 0.22;
      } else if (ret.tool === 'bomb') {
        cr = 0.98;
        cg = 0.52;
        cb = 0.08;
      } else if (ret.tool === 'cutter') {
        cr = 1.0;
        cg = 0.86;
        cb = 0.28;
      } else if (ret.tool === 'incendiary') {
        cr = 0.98;
        cg = 0.36;
        cb = 0.06;
      } else if (ret.tool === 'seismic') {
        cr = 0.12;
        cg = 0.82;
        cb = 0.62;
      }

      const pulse = 1 + 0.05 * Math.sin(this.animPhaseSec * 7.5);
      const outerR = clamp(ret.radiusM, 0.25, 14) * pulse;

      // Внешнее кольцо зоны воздействия
      for (let s = 0; s < RING_SEGMENTS; s++) {
        // Лёгкий пунктир для больших радиусов фугаса/термита
        if (outerR > 2.2 && s % 2 === 1) continue;
        const a0 = (s / RING_SEGMENTS) * Math.PI * 2 + this.animPhaseSec * 0.6;
        const a1 = ((s + 1) / RING_SEGMENTS) * Math.PI * 2 + this.animPhaseSec * 0.6;
        const c0 = Math.cos(a0) * outerR;
        const s0 = Math.sin(a0) * outerR;
        const c1 = Math.cos(a1) * outerR;
        const s1 = Math.sin(a1) * outerR;
        pushSeg(
          cx + _tangent.x * c0 + _bitangent.x * s0,
          cy + _tangent.y * c0 + _bitangent.y * s0,
          cz + _tangent.z * c0 + _bitangent.z * s0,
          cx + _tangent.x * c1 + _bitangent.x * s1,
          cy + _tangent.y * c1 + _bitangent.y * s1,
          cz + _tangent.z * c1 + _bitangent.z * s1,
          cr,
          cg,
          cb,
        );
      }

      // Центральное перекрестие и вектор нормали
      const crossR = Math.min(0.42, outerR * 0.65);
      pushSeg(
        cx - _tangent.x * crossR,
        cy - _tangent.y * crossR,
        cz - _tangent.z * crossR,
        cx + _tangent.x * crossR,
        cy + _tangent.y * crossR,
        cz + _tangent.z * crossR,
        cr,
        cg,
        cb,
      );
      pushSeg(
        cx - _bitangent.x * crossR,
        cy - _bitangent.y * crossR,
        cz - _bitangent.z * crossR,
        cx + _bitangent.x * crossR,
        cy + _bitangent.y * crossR,
        cz + _bitangent.z * crossR,
        cr,
        cg,
        cb,
      );
      pushSeg(
        cx,
        cy,
        cz,
        cx + _normal.x * 0.55,
        cy + _normal.y * 0.55,
        cz + _normal.z * 0.55,
        1.0,
        0.95,
        0.75,
      );
    }

    if (segCount > 0) {
      this.lineGeometry.setDrawRange(0, segCount * 2);
      const posAttr = this.lineGeometry.getAttribute('position') as THREE.BufferAttribute;
      const colAttr = this.lineGeometry.getAttribute('color') as THREE.BufferAttribute;
      posAttr.needsUpdate = true;
      colAttr.needsUpdate = true;
      this.lineSegments.visible = true;
    } else {
      this.lineGeometry.setDrawRange(0, 0);
      this.lineSegments.visible = false;
    }

    // 3. Обновление 3D-луча плазморезака
    if (this.beamState.active) {
      _origin.set(
        safeCoord(this.beamState.origin[0]),
        safeCoord(this.beamState.origin[1]),
        safeCoord(this.beamState.origin[2]),
      );
      _target.set(
        safeCoord(this.beamState.hitPoint[0]),
        safeCoord(this.beamState.hitPoint[1]),
        safeCoord(this.beamState.hitPoint[2]),
      );
      _dir.subVectors(_target, _origin);
      const len = _dir.length();
      if (len > 0.05) {
        _dir.multiplyScalar(1 / len);
        _mid.addVectors(_origin, _target).multiplyScalar(0.5);
        _quat.setFromUnitVectors(UP_Y, _dir);

        const flicker = 0.85 + 0.25 * Math.sin(this.animPhaseSec * 42);
        this.beamCoreMesh.position.copy(_mid);
        this.beamCoreMesh.quaternion.copy(_quat);
        this.beamCoreMesh.scale.set(flicker, len, flicker);

        this.beamGlowMesh.position.copy(_mid);
        this.beamGlowMesh.quaternion.copy(_quat);
        this.beamGlowMesh.scale.set(flicker * 1.15, len, flicker * 1.15);

        this.beamTipMesh.position.copy(_target);
        this.beamTipMesh.scale.setScalar(0.9 + 0.35 * Math.sin(this.animPhaseSec * 55));
        this.beamGroup.visible = true;
      } else {
        this.beamGroup.visible = false;
      }
    } else {
      this.beamGroup.visible = false;
    }
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.lineGeometry.dispose();
    this.lineMaterial.dispose();
    this.beamCoreGeometry.dispose();
    this.beamGlowGeometry.dispose();
    this.beamTipGeometry.dispose();
    this.beamCoreMaterial.dispose();
    this.beamGlowMaterial.dispose();
    this.ghostGeometry.dispose();
    this.ghostMaterial.dispose();
  }
}
