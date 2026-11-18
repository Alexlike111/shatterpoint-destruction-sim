import * as THREE from 'three';
import { clamp } from '../core/math3d';
import type {
  ConvexPolyhedron3DData,
  MaterialPhysicsProfile,
  QualityPreset,
  RenderShardInstance,
  RenderViewMode,
  StructuralMaterialId,
} from '../core/types';
import { getMaterialProfile } from '../physics/MaterialRegistry';
import { computeThermalGlowAdditiveLinear } from './InstancedBlockLayer';

/**
 * Высокопроизводительный слой батчинга уникальных 3D-осколков Вороного на базе THREE.BatchedMesh
 * (3 оптических бакета: matte, metallic, glass) и инстансированных двухколенных 3D-прутьев арматуры (rebarStubs).
 * Удерживает рендер сотен уникальных полиэдров осколков в пределах 1–4 Draw Calls.
 */

export type ShardBucketKey = 'matte' | 'metallic' | 'glass';

export interface ShardLayerDiagnostics {
  activeShardCount: number;
  activeRebarStubCount: number;
  countsByBucket: Record<ShardBucketKey, number>;
  estimatedDrawCalls: number;
}

interface ShardBatchBucket {
  readonly key: ShardBucketKey;
  readonly initialMaxInstances: number;
  readonly initialMaxVertices: number;
  readonly initialMaxIndices: number;
  readonly materials: Record<RenderViewMode, THREE.Material>;
  mesh: THREE.BatchedMesh;
  maxVertices: number;
  maxIndices: number;
  activeCount: number;
  hadDeletions: boolean;
}

interface CachedShardEntry {
  shardId: number;
  materialId: StructuralMaterialId;
  bucketKey: ShardBucketKey;
  geometryId: number;
  instanceId: number;
  verticesRef: Float32Array;
  faceCount: number;
  lastPos: [number, number, number];
  lastQuat: [number, number, number, number];
  lastTempC: number;
  lastCharRatio: number;
  seenGeneration: number;
}

const INITIAL_BATCH_VERTICES = 65536; // > 65535 для немедленной инициализации Uint32Array индексов
const INITIAL_BATCH_INDICES = 196608;
const INITIAL_REBAR_STUB_CAPACITY = 512;

const UP_Y = new THREE.Vector3(0, 1, 0);
const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _scale = new THREE.Vector3(1, 1, 1);
const _mat4 = new THREE.Matrix4();
const _localVec = new THREE.Vector3();
const _worldDir = new THREE.Vector3();
const _twistQuat = new THREE.Quaternion();
const _alignQuat = new THREE.Quaternion();
const _workColor = new THREE.Color();
const _extColor = new THREE.Color();
const _cutColor = new THREE.Color();

function sanitizeCoord(v: number, limit = 1e5, fallback = 0): number {
  return Number.isFinite(v) ? clamp(v, -limit, limit) : fallback;
}

function sanitizeFinite(v: number, min: number, max: number, fallback: number): number {
  return Number.isFinite(v) ? clamp(v, min, max) : fallback;
}

function sanitizeQuaternionInto(
  out: THREE.Quaternion,
  q: readonly [number, number, number, number],
): THREE.Quaternion {
  const qx = q[0];
  const qy = q[1];
  const qz = q[2];
  const qw = q[3];
  if (
    !Number.isFinite(qx) ||
    !Number.isFinite(qy) ||
    !Number.isFinite(qz) ||
    !Number.isFinite(qw)
  ) {
    return out.set(0, 0, 0, 1);
  }
  const maxAbs = Math.max(Math.abs(qx), Math.abs(qy), Math.abs(qz), Math.abs(qw));
  if (maxAbs < 1e-12) {
    return out.set(0, 0, 0, 1);
  }
  const invMax = 1 / maxAbs;
  const nx = qx * invMax;
  const ny = qy * invMax;
  const nz = qz * invMax;
  const nw = qw * invMax;
  const len = Math.hypot(nx, ny, nz, nw);
  if (!Number.isFinite(len) || len <= 1e-12) {
    return out.set(0, 0, 0, 1);
  }
  const invLen = 1 / len;
  return out.set(nx * invLen, ny * invLen, nz * invLen, nw * invLen);
}

export function getShardBucketKey(materialId: StructuralMaterialId): ShardBucketKey {
  if (materialId === 'glass') {
    return 'glass';
  }
  if (materialId === 'steel' || materialId === 'explosive') {
    return 'metallic';
  }
  return 'matte';
}

/**
 * Собирает индексированную BufferGeometry выпуклого многогранника осколка с плоскими нормалями
 * и вершинными цветами внешних граней (baseColorHex) и внутренних сколов (interiorCutColorHex).
 * ВАЖНО: вершины polyhedron.vertices уже центрированы вокруг (0, 0, 0) — смещение на centroid НЕ применяется!
 */
export function buildShardBufferGeometry(
  polyhedron: ConvexPolyhedron3DData,
  profile: Readonly<MaterialPhysicsProfile>,
): THREE.BufferGeometry | null {
  if (!polyhedron || !polyhedron.vertices || !Array.isArray(polyhedron.faces)) {
    return null;
  }

  const verts = polyhedron.vertices;
  const faces = polyhedron.faces;
  const vertexPoolCount = Math.floor(verts.length / 3);

  if (vertexPoolCount < 4 || faces.length < 4) {
    return null;
  }

  let totalVerts = 0;
  let totalIndices = 0;

  for (let f = 0; f < faces.length; f++) {
    const face = faces[f]!;
    const m = face.indices.length;
    if (m < 3) continue;
    totalVerts += m;
    totalIndices += (m - 2) * 3;
  }

  if (totalVerts < 3 || totalIndices < 3) {
    return null;
  }

  const positions = new Float32Array(totalVerts * 3);
  const normals = new Float32Array(totalVerts * 3);
  const colors = new Float32Array(totalVerts * 3);
  const indices =
    totalVerts > 65535 ? new Uint32Array(totalIndices) : new Uint16Array(totalIndices);

  _extColor.setHex(profile.baseColorHex, THREE.SRGBColorSpace);
  _cutColor.setHex(profile.interiorCutColorHex, THREE.SRGBColorSpace);

  let vCursor = 0;
  let iCursor = 0;

  for (let f = 0; f < faces.length; f++) {
    const face = faces[f]!;
    const faceIndices = face.indices;
    const m = faceIndices.length;
    if (m < 3) continue;

    const faceColor = face.isInteriorCut ? _cutColor : _extColor;
    const cr = faceColor.r;
    const cg = faceColor.g;
    const cb = faceColor.b;

    const baseVertex = vCursor;

    for (let k = 0; k < m; k++) {
      const srcIdx = faceIndices[k]!;
      const safeSrcIdx =
        Number.isInteger(srcIdx) && srcIdx >= 0 && srcIdx < vertexPoolCount ? srcIdx : 0;
      const srcOff = safeSrcIdx * 3;
      const dstOff = vCursor * 3;

      positions[dstOff] = sanitizeCoord(verts[srcOff]!, 1e4, 0);
      positions[dstOff + 1] = sanitizeCoord(verts[srcOff + 1]!, 1e4, 0);
      positions[dstOff + 2] = sanitizeCoord(verts[srcOff + 2]!, 1e4, 0);

      colors[dstOff] = cr;
      colors[dstOff + 1] = cg;
      colors[dstOff + 2] = cb;

      vCursor += 1;
    }

    // Санитизация нормали грани (с пересчётом по вершинам или откатом в [0, 1, 0] при вырождении)
    let nx = face.normal[0];
    let ny = face.normal[1];
    let nz = face.normal[2];
    let hasValidNormal = false;

    if (Number.isFinite(nx) && Number.isFinite(ny) && Number.isFinite(nz)) {
      const maxN = Math.max(Math.abs(nx), Math.abs(ny), Math.abs(nz));
      if (maxN > 1e-8) {
        const invMax = 1 / maxN;
        const sx = nx * invMax;
        const sy = ny * invMax;
        const sz = nz * invMax;
        const len = Math.hypot(sx, sy, sz);
        if (Number.isFinite(len) && len > 1e-8) {
          nx = sx / len;
          ny = sy / len;
          nz = sz / len;
          hasValidNormal = true;
        }
      }
    }

    if (!hasValidNormal) {
      const o0 = baseVertex * 3;
      const o1 = (baseVertex + 1) * 3;
      const o2 = (baseVertex + 2) * 3;
      const e1x = positions[o1]! - positions[o0]!;
      const e1y = positions[o1 + 1]! - positions[o0 + 1]!;
      const e1z = positions[o1 + 2]! - positions[o0 + 2]!;
      const e2x = positions[o2]! - positions[o0]!;
      const e2y = positions[o2 + 1]! - positions[o0 + 1]!;
      const e2z = positions[o2 + 2]! - positions[o0 + 2]!;
      const cx = e1y * e2z - e1z * e2y;
      const cy = e1z * e2x - e1x * e2z;
      const cz = e1x * e2y - e1y * e2x;
      const cLen = Math.hypot(cx, cy, cz);
      if (Number.isFinite(cLen) && cLen > 1e-8) {
        nx = cx / cLen;
        ny = cy / cLen;
        nz = cz / cLen;
      } else {
        nx = 0;
        ny = 1;
        nz = 0;
      }
    }

    for (let k = 0; k < m; k++) {
      const dstOff = (baseVertex + k) * 3;
      normals[dstOff] = nx;
      normals[dstOff + 1] = ny;
      normals[dstOff + 2] = nz;
    }

    // Веерная триангуляция выпуклого полигона грани (обход CCW снаружи сохранён)
    for (let t = 1; t < m - 1; t++) {
      indices[iCursor] = baseVertex;
      indices[iCursor + 1] = baseVertex + t;
      indices[iCursor + 2] = baseVertex + t + 1;
      iCursor += 3;
    }
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geom.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geom.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geom.setIndex(new THREE.BufferAttribute(indices, 1));
  geom.computeBoundingBox();
  geom.computeBoundingSphere();
  return geom;
}

/**
 * Вычисляет линейный цветовой множитель инстанса осколка в BatchedMesh (без фиолетовых оттенков).
 */
export function computeShardInstanceTint(
  shard: Pick<RenderShardInstance, 'materialId' | 'temperatureC' | 'charRatio'>,
  viewMode: RenderViewMode,
  target: THREE.Color = new THREE.Color(),
): THREE.Color {
  if (viewMode === 'stress') {
    // Спокойный сланцево-бирюзовый тон (G >= B > R), не отвлекающий от тепловой карты несущих конструкций
    return target.setRGB(0.62, 0.76, 0.74, THREE.LinearSRGBColorSpace);
  }

  if (viewMode === 'xray') {
    // Прозрачно-аквамариновый контур, сквозь который контрастно светятся янтарные стержни rebarStubs
    return target.setRGB(0.50, 0.88, 0.86, THREE.LinearSRGBColorSpace);
  }

  const charRatio = sanitizeFinite(shard.charRatio, 0, 1, 0);
  const baseAtten = 1 - charRatio * 0.86;

  const tempC = sanitizeFinite(shard.temperatureC, -273.15, 5000, 20);
  if (tempC <= 420) {
    return target.setRGB(baseAtten, baseAtten, baseAtten, THREE.LinearSRGBColorSpace);
  }

  const heatFactor = clamp((tempC - 420) / 380, 0, 1);
  const [gr, gg, gb] = computeThermalGlowAdditiveLinear(shard.materialId, tempC);

  // Подавляем холодный синий множитель при нагреве, чтобы даже голубое стекло светилось тёплым накалом без пурпура
  const rMul = baseAtten + gr * 2.1;
  const gMul = baseAtten * (1 - 0.14 * heatFactor) + gg * 1.85 + gr * 0.24;
  const bMul = baseAtten * (1 - 0.88 * heatFactor) + gb * 0.5;

  return target.setRGB(rMul, gMul, bMul, THREE.LinearSRGBColorSpace);
}

/**
 * Создаёт эталонную 3D-геометрию двухколенного гнутого стального прута арматуры вдоль оси +Y (длина ~1.0).
 */
function createBentRebarStubGeometry(): THREE.BufferGeometry {
  const radialSegments = 6;
  const radius = 0.011;

  // Три сечения вдоль стержня: основание (0,0,0), изгиб (0, 0.46, 0), кончик (0.14, 0.985, 0)
  const rings: ReadonlyArray<readonly [cx: number, cy: number, cz: number, tiltRad: number]> = [
    [0.0, 0.0, 0.0, 0.0],
    [0.0, 0.46, 0.0, 0.13],
    [0.14, 0.985, 0.0, 0.26],
  ];

  const ringCount = rings.length;
  const sideVerts = ringCount * radialSegments;
  const capCenterVert = sideVerts;
  const totalVerts = sideVerts + 1;

  const positions = new Float32Array(totalVerts * 3);
  const normals = new Float32Array(totalVerts * 3);

  for (let r = 0; r < ringCount; r++) {
    const [cx, cy, cz, tilt] = rings[r]!;
    const cosT = Math.cos(tilt);
    const sinT = Math.sin(tilt);

    for (let s = 0; s < radialSegments; s++) {
      const angle = (s / radialSegments) * Math.PI * 2;
      const lx = Math.cos(angle);
      const lz = Math.sin(angle);

      // Поворачиваем локальное кольцо в плоскости XY на угол изгиба tilt
      const nx = lx * cosT;
      const ny = -lx * sinT;
      const nz = lz;

      const vIdx = (r * radialSegments + s) * 3;
      positions[vIdx] = cx + nx * radius;
      positions[vIdx + 1] = cy + ny * radius;
      positions[vIdx + 2] = cz + nz * radius;

      normals[vIdx] = nx;
      normals[vIdx + 1] = ny;
      normals[vIdx + 2] = nz;
    }
  }

  // Центр торцевой крышки на кончике арматуры
  const tip = rings[ringCount - 1]!;
  positions[capCenterVert * 3] = tip[0];
  positions[capCenterVert * 3 + 1] = tip[1];
  positions[capCenterVert * 3 + 2] = tip[2];
  normals[capCenterVert * 3] = Math.sin(tip[3]);
  normals[capCenterVert * 3 + 1] = Math.cos(tip[3]);
  normals[capCenterVert * 3 + 2] = 0;

  const quadCount = (ringCount - 1) * radialSegments;
  const totalIndices = quadCount * 6 + radialSegments * 3;
  const indices = new Uint16Array(totalIndices);
  let iCursor = 0;

  for (let r = 0; r < ringCount - 1; r++) {
    const rowA = r * radialSegments;
    const rowB = (r + 1) * radialSegments;

    for (let s = 0; s < radialSegments; s++) {
      const sNext = (s + 1) % radialSegments;
      const a0 = rowA + s;
      const a1 = rowA + sNext;
      const b0 = rowB + s;
      const b1 = rowB + sNext;

      indices[iCursor++] = a0;
      indices[iCursor++] = b0;
      indices[iCursor++] = b1;

      indices[iCursor++] = a0;
      indices[iCursor++] = b1;
      indices[iCursor++] = a1;
    }
  }

  // Торцевая крышка на верхнем кольце
  const topRow = (ringCount - 1) * radialSegments;
  for (let s = 0; s < radialSegments; s++) {
    const sNext = (s + 1) % radialSegments;
    indices[iCursor++] = capCenterVert;
    indices[iCursor++] = topRow + sNext;
    indices[iCursor++] = topRow + s;
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geom.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geom.setIndex(new THREE.BufferAttribute(indices, 1));
  geom.computeBoundingBox();
  geom.computeBoundingSphere();
  return geom;
}

function buildBucketMaterials(key: ShardBucketKey): Record<RenderViewMode, THREE.Material> {
  if (key === 'glass') {
    return {
      pbr: new THREE.MeshStandardMaterial({
        color: 0xffffff,
        vertexColors: true,
        roughness: 0.08,
        metalness: 0.16,
        transparent: true,
        opacity: 0.48,
        depthWrite: false,
        side: THREE.DoubleSide,
        forceSinglePass: true,
      }),
      stress: new THREE.MeshStandardMaterial({
        color: 0xffffff,
        vertexColors: true,
        roughness: 0.36,
        metalness: 0.12,
        transparent: true,
        opacity: 0.56,
        depthWrite: false,
        side: THREE.DoubleSide,
        forceSinglePass: true,
      }),
      xray: new THREE.MeshBasicMaterial({
        color: 0xffffff,
        vertexColors: true,
        transparent: true,
        opacity: 0.16,
        depthWrite: false,
        side: THREE.DoubleSide,
        forceSinglePass: true,
      }),
    };
  }

  if (key === 'metallic') {
    return {
      pbr: new THREE.MeshStandardMaterial({
        color: 0xffffff,
        vertexColors: true,
        roughness: 0.34,
        metalness: 0.78,
      }),
      stress: new THREE.MeshStandardMaterial({
        color: 0xffffff,
        vertexColors: true,
        roughness: 0.52,
        metalness: 0.25,
      }),
      xray: new THREE.MeshBasicMaterial({
        color: 0xffffff,
        vertexColors: true,
        transparent: true,
        opacity: 0.18,
        depthWrite: false,
        side: THREE.DoubleSide,
        forceSinglePass: true,
      }),
    };
  }

  return {
    pbr: new THREE.MeshStandardMaterial({
      color: 0xffffff,
      vertexColors: true,
      roughness: 0.85,
      metalness: 0.04,
    }),
    stress: new THREE.MeshStandardMaterial({
      color: 0xffffff,
      vertexColors: true,
      roughness: 0.62,
      metalness: 0.08,
    }),
    xray: new THREE.MeshBasicMaterial({
      color: 0xffffff,
      vertexColors: true,
      transparent: true,
      opacity: 0.18,
      depthWrite: false,
      side: THREE.DoubleSide,
      forceSinglePass: true,
    }),
  };
}

export class BatchedShardLayer {
  public readonly group: THREE.Group;

  private readonly buckets: Record<ShardBucketKey, ShardBatchBucket>;
  private readonly shardCache: Map<number, CachedShardEntry> = new Map();

  private readonly rebarStubGeometry: THREE.BufferGeometry;
  private readonly rebarStubMaterials: Record<RenderViewMode, THREE.Material>;
  private rebarStubMesh: THREE.InstancedMesh;
  private rebarStubCapacity: number;
  private activeRebarStubCount = 0;

  private viewMode: RenderViewMode = 'pbr';
  private qualityPreset: QualityPreset = 'high';
  private syncGeneration = 0;
  private lastShards: RenderShardInstance[] = [];
  private disposed = false;

  constructor(options?: { quality?: QualityPreset }) {
    this.group = new THREE.Group();
    this.group.name = 'BatchedShardLayer';
    this.qualityPreset = options?.quality ?? 'high';

    this.buckets = {
      matte: this.initBucket('matte', 512),
      metallic: this.initBucket('metallic', 256),
      glass: this.initBucket('glass', 256),
    };

    this.rebarStubGeometry = createBentRebarStubGeometry();
    this.rebarStubMaterials = {
      pbr: new THREE.MeshStandardMaterial({
        color: 0xffffff,
        roughness: 0.44,
        metalness: 0.82,
      }),
      stress: new THREE.MeshStandardMaterial({
        color: 0xffffff,
        roughness: 0.48,
        metalness: 0.6,
      }),
      xray: new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.94,
        depthTest: false,
        depthWrite: false,
      }),
    };

    this.rebarStubCapacity = INITIAL_REBAR_STUB_CAPACITY;
    this.rebarStubMesh = this.createRebarStubMesh(this.rebarStubCapacity);
    this.group.add(this.rebarStubMesh);

    this.applyShadowSettings();
  }

  public getObject3D(): THREE.Group {
    return this.group;
  }

  public getViewMode(): RenderViewMode {
    return this.viewMode;
  }

  public getBatchMesh(bucketKey: ShardBucketKey): THREE.BatchedMesh {
    return this.buckets[bucketKey].mesh;
  }

  public getRebarStubMesh(): THREE.InstancedMesh {
    return this.rebarStubMesh;
  }

  /**
   * Синхронизирует набор активных 3D-осколков Вороного и их гнутых выпусков арматуры rebarStubs.
   */
  public syncShards(shards: readonly RenderShardInstance[]): void {
    if (this.disposed) return;

    this.lastShards = shards.slice();
    this.syncGeneration += 1;
    const gen = this.syncGeneration;

    let totalStubsNeeded = 0;

    for (let i = 0; i < shards.length; i++) {
      const shard = shards[i]!;
      totalStubsNeeded += shard.rebarStubs.length;

      const safeShardId = Number.isFinite(shard.shardId)
        ? shard.shardId
        : -(i + 1) - 1_000_000;
      let entry = this.shardCache.get(safeShardId);
      const targetBucketKey = getShardBucketKey(shard.materialId);

      // Если осколок с этим ID сменил полиэдр или материал — пересоздаём запись
      if (
        entry &&
        (entry.bucketKey !== targetBucketKey ||
          entry.materialId !== shard.materialId ||
          entry.verticesRef !== shard.polyhedron.vertices ||
          entry.faceCount !== shard.polyhedron.faces.length)
      ) {
        this.removeCachedEntry(entry);
        entry = undefined;
      }

      if (!entry) {
        entry = this.insertNewShard(shard, safeShardId, targetBucketKey, gen);
        if (!entry) {
          continue;
        }
      } else {
        entry.seenGeneration = gen;
        const bucket = this.buckets[entry.bucketKey];

        const px = sanitizeCoord(shard.position[0], 1e5, 0);
        const py = sanitizeCoord(shard.position[1], 1e5, 0);
        const pz = sanitizeCoord(shard.position[2], 1e5, 0);
        sanitizeQuaternionInto(_quat, shard.quaternion);
        const qx = _quat.x;
        const qy = _quat.y;
        const qz = _quat.z;
        const qw = _quat.w;

        const poseUnchanged =
          entry.lastPos[0] === px &&
          entry.lastPos[1] === py &&
          entry.lastPos[2] === pz &&
          entry.lastQuat[0] === qx &&
          entry.lastQuat[1] === qy &&
          entry.lastQuat[2] === qz &&
          entry.lastQuat[3] === qw;

        // Для спящих осколков с неизменной позой пропускаем пересчёт 4x4 матрицы
        if (!(shard.sleeping && poseUnchanged)) {
          _pos.set(px, py, pz);
          _scale.set(1, 1, 1);
          _mat4.compose(_pos, _quat, _scale);
          bucket.mesh.setMatrixAt(entry.instanceId, _mat4);

          entry.lastPos[0] = px;
          entry.lastPos[1] = py;
          entry.lastPos[2] = pz;
          entry.lastQuat[0] = qx;
          entry.lastQuat[1] = qy;
          entry.lastQuat[2] = qz;
          entry.lastQuat[3] = qw;
        }

        const safeTempC = sanitizeFinite(shard.temperatureC, -273.15, 5000, 20);
        const safeChar = sanitizeFinite(shard.charRatio, 0, 1, 0);

        if (
          this.viewMode === 'pbr' &&
          (Math.abs(entry.lastTempC - safeTempC) > 0.5 ||
            Math.abs(entry.lastCharRatio - safeChar) > 0.005)
        ) {
          computeShardInstanceTint(shard, this.viewMode, _workColor);
          bucket.mesh.setColorAt(entry.instanceId, _workColor);
          entry.lastTempC = safeTempC;
          entry.lastCharRatio = safeChar;
        }
      }
    }

    // Удаляем осколки, исчезнувшие из снимка (запечённые в покой или очищенные)
    for (const entry of this.shardCache.values()) {
      if (entry.seenGeneration !== gen) {
        this.removeCachedEntry(entry);
      }
    }

    // Обновляем видимость бакетов и пересоздаём опустевшие бакеты (обход бага пустого optimize() в Three r170)
    for (const key of ['matte', 'metallic', 'glass'] as const) {
      const bucket = this.buckets[key];
      if (bucket.activeCount === 0 && bucket.hadDeletions) {
        this.recreateEmptyBucketMesh(bucket);
      }
      bucket.mesh.visible = bucket.activeCount > 0;
    }

    // Синхронизируем 3D-выпуски гнутой арматуры rebarStubs
    this.syncRebarStubs(shards, totalStubsNeeded);
  }

  /**
   * Мгновенно переключает режим отображения ('pbr' | 'stress' | 'xray') для всех осколков и арматуры (включая паузу).
   */
  public setViewMode(mode: RenderViewMode): void {
    if (this.disposed) return;
    this.viewMode = mode;

    for (const key of ['matte', 'metallic', 'glass'] as const) {
      const bucket = this.buckets[key];
      bucket.mesh.material = bucket.materials[mode];
      bucket.mesh.renderOrder = mode === 'xray' ? 2 : key === 'glass' ? 3 : 0;
    }

    this.rebarStubMesh.material = this.rebarStubMaterials[mode];
    this.rebarStubMesh.renderOrder = mode === 'xray' ? 12 : 1;

    this.applyShadowSettings();

    // Немедленно обновляем инстансные цвета всех закэшированных осколков
    for (const entry of this.shardCache.values()) {
      const bucket = this.buckets[entry.bucketKey];
      computeShardInstanceTint(
        {
          materialId: entry.materialId,
          temperatureC: entry.lastTempC,
          charRatio: entry.lastCharRatio,
        },
        this.viewMode,
        _workColor,
      );
      bucket.mesh.setColorAt(entry.instanceId, _workColor);
    }

    if (this.lastShards.length > 0) {
      let totalStubs = 0;
      for (let i = 0; i < this.lastShards.length; i++) {
        totalStubs += this.lastShards[i]!.rebarStubs.length;
      }
      this.syncRebarStubs(this.lastShards, totalStubs);
    }
  }

  public setQualityPreset(preset: QualityPreset): void {
    if (this.disposed) return;
    this.qualityPreset = preset;
    this.applyShadowSettings();
  }

  /**
   * Полная очистка всех осколков и чистое пересоздание буферов BatchedMesh без утечек геометрии.
   */
  public clear(): void {
    if (this.disposed) return;

    this.lastShards = [];
    this.shardCache.clear();

    for (const key of ['matte', 'metallic', 'glass'] as const) {
      const bucket = this.buckets[key];
      if (bucket.activeCount > 0 || bucket.hadDeletions) {
        bucket.activeCount = 0;
        this.recreateEmptyBucketMesh(bucket);
      }
      bucket.mesh.visible = false;
    }

    this.activeRebarStubCount = 0;
    this.rebarStubMesh.count = 0;
    this.rebarStubMesh.visible = false;
  }

  public getEstimatedDrawCalls(includeShadowPass = false): number {
    if (this.disposed) return 0;
    let calls = 0;
    for (const key of ['matte', 'metallic', 'glass'] as const) {
      const bucket = this.buckets[key];
      if (bucket.mesh.visible && bucket.activeCount > 0) {
        calls += 1;
        if (includeShadowPass && bucket.mesh.castShadow) {
          calls += 1;
        }
      }
    }
    if (this.rebarStubMesh.visible && this.activeRebarStubCount > 0) {
      calls += 1;
    }
    return calls;
  }

  public getDiagnostics(): ShardLayerDiagnostics {
    if (this.disposed) {
      return {
        activeShardCount: 0,
        activeRebarStubCount: 0,
        countsByBucket: {
          matte: 0,
          metallic: 0,
          glass: 0,
        },
        estimatedDrawCalls: 0,
      };
    }
    const shadowsOn = this.qualityPreset !== 'performance' && this.viewMode !== 'xray';
    return {
      activeShardCount: this.shardCache.size,
      activeRebarStubCount: this.activeRebarStubCount,
      countsByBucket: {
        matte: this.buckets.matte.activeCount,
        metallic: this.buckets.metallic.activeCount,
        glass: this.buckets.glass.activeCount,
      },
      estimatedDrawCalls: this.getEstimatedDrawCalls(shadowsOn),
    };
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    this.shardCache.clear();
    this.lastShards = [];

    for (const key of ['matte', 'metallic', 'glass'] as const) {
      const bucket = this.buckets[key];
      bucket.activeCount = 0;
      bucket.mesh.visible = false;
      this.group.remove(bucket.mesh);
      bucket.mesh.dispose();
      bucket.materials.pbr.dispose();
      bucket.materials.stress.dispose();
      bucket.materials.xray.dispose();
    }

    this.activeRebarStubCount = 0;
    this.rebarStubMesh.count = 0;
    this.rebarStubMesh.visible = false;
    this.group.remove(this.rebarStubMesh);
    this.rebarStubMesh.dispose();
    this.rebarStubMaterials.pbr.dispose();
    this.rebarStubMaterials.stress.dispose();
    this.rebarStubMaterials.xray.dispose();
    this.rebarStubGeometry.dispose();
  }

  private initBucket(key: ShardBucketKey, initialMaxInstances: number): ShardBatchBucket {
    const materials = buildBucketMaterials(key);
    const mesh = this.createConfiguredBatchedMesh(
      key,
      initialMaxInstances,
      INITIAL_BATCH_VERTICES,
      INITIAL_BATCH_INDICES,
      materials[this.viewMode],
    );
    this.group.add(mesh);

    return {
      key,
      initialMaxInstances,
      initialMaxVertices: INITIAL_BATCH_VERTICES,
      initialMaxIndices: INITIAL_BATCH_INDICES,
      materials,
      mesh,
      maxVertices: INITIAL_BATCH_VERTICES,
      maxIndices: INITIAL_BATCH_INDICES,
      activeCount: 0,
      hadDeletions: false,
    };
  }

  private createConfiguredBatchedMesh(
    key: ShardBucketKey,
    maxInstances: number,
    maxVertices: number,
    maxIndices: number,
    material: THREE.Material,
  ): THREE.BatchedMesh {
    const mesh = new THREE.BatchedMesh(maxInstances, maxVertices, maxIndices, material);
    mesh.name = `ShardBatch_${key}`;
    mesh.frustumCulled = false;
    mesh.perObjectFrustumCulled = false;
    mesh.sortObjects = key === 'glass';
    mesh.visible = false;
    mesh.renderOrder = this.viewMode === 'xray' ? 2 : key === 'glass' ? 3 : 0;
    return mesh;
  }

  private recreateEmptyBucketMesh(bucket: ShardBatchBucket): void {
    this.group.remove(bucket.mesh);
    bucket.mesh.dispose();

    bucket.maxVertices = bucket.initialMaxVertices;
    bucket.maxIndices = bucket.initialMaxIndices;
    bucket.activeCount = 0;
    bucket.hadDeletions = false;
    bucket.mesh = this.createConfiguredBatchedMesh(
      bucket.key,
      bucket.initialMaxInstances,
      bucket.initialMaxVertices,
      bucket.initialMaxIndices,
      bucket.materials[this.viewMode],
    );
    this.group.add(bucket.mesh);
    this.applyShadowSettings();
  }

  private ensureBucketSpace(
    bucket: ShardBatchBucket,
    requiredVertices: number,
    requiredIndices: number,
  ): void {
    const mesh = bucket.mesh;

    if (mesh.instanceCount >= mesh.maxInstanceCount) {
      mesh.setInstanceCount(Math.max(mesh.maxInstanceCount * 2, mesh.instanceCount + 64));
    }

    if (
      mesh.unusedVertexCount < requiredVertices ||
      mesh.unusedIndexCount < requiredIndices
    ) {
      if (bucket.hadDeletions && bucket.activeCount > 0) {
        mesh.optimize();
        bucket.hadDeletions = false;
      }
    }

    if (
      mesh.unusedVertexCount < requiredVertices ||
      mesh.unusedIndexCount < requiredIndices
    ) {
      const usedVerts = bucket.maxVertices - mesh.unusedVertexCount;
      const usedIndices = bucket.maxIndices - mesh.unusedIndexCount;
      const newMaxVerts = Math.max(
        bucket.maxVertices * 2,
        usedVerts + requiredVertices + 8192,
      );
      const newMaxIndices = Math.max(
        bucket.maxIndices * 2,
        usedIndices + requiredIndices + 24576,
      );
      mesh.setGeometrySize(newMaxVerts, newMaxIndices);
      bucket.maxVertices = newMaxVerts;
      bucket.maxIndices = newMaxIndices;
    }
  }

  private insertNewShard(
    shard: RenderShardInstance,
    safeShardId: number,
    bucketKey: ShardBucketKey,
    gen: number,
  ): CachedShardEntry | undefined {
    const profile = getMaterialProfile(shard.materialId);
    const geom = buildShardBufferGeometry(shard.polyhedron, profile);
    if (!geom) {
      return undefined;
    }

    const posAttr = geom.getAttribute('position');
    const idxAttr = geom.getIndex();
    const vertCount = posAttr ? posAttr.count : 0;
    const idxCount = idxAttr ? idxAttr.count : 0;

    if (vertCount < 3 || idxCount < 3) {
      geom.dispose();
      return undefined;
    }

    const bucket = this.buckets[bucketKey];
    this.ensureBucketSpace(bucket, vertCount, idxCount);

    const geometryId = bucket.mesh.addGeometry(geom);
    const instanceId = bucket.mesh.addInstance(geometryId);
    geom.dispose();

    const px = sanitizeCoord(shard.position[0], 1e5, 0);
    const py = sanitizeCoord(shard.position[1], 1e5, 0);
    const pz = sanitizeCoord(shard.position[2], 1e5, 0);
    sanitizeQuaternionInto(_quat, shard.quaternion);

    _pos.set(px, py, pz);
    _scale.set(1, 1, 1);
    _mat4.compose(_pos, _quat, _scale);
    bucket.mesh.setMatrixAt(instanceId, _mat4);

    computeShardInstanceTint(shard, this.viewMode, _workColor);
    bucket.mesh.setColorAt(instanceId, _workColor);

    bucket.activeCount += 1;

    const safeTempC = sanitizeFinite(shard.temperatureC, -273.15, 5000, 20);
    const safeChar = sanitizeFinite(shard.charRatio, 0, 1, 0);

    const entry: CachedShardEntry = {
      shardId: safeShardId,
      materialId: shard.materialId,
      bucketKey,
      geometryId,
      instanceId,
      verticesRef: shard.polyhedron.vertices,
      faceCount: shard.polyhedron.faces.length,
      lastPos: [px, py, pz],
      lastQuat: [_quat.x, _quat.y, _quat.z, _quat.w],
      lastTempC: safeTempC,
      lastCharRatio: safeChar,
      seenGeneration: gen,
    };

    this.shardCache.set(safeShardId, entry);
    return entry;
  }

  private removeCachedEntry(entry: CachedShardEntry): void {
    const bucket = this.buckets[entry.bucketKey];
    bucket.mesh.deleteGeometry(entry.geometryId);
    bucket.activeCount = Math.max(0, bucket.activeCount - 1);
    bucket.hadDeletions = true;
    this.shardCache.delete(entry.shardId);
  }

  private createRebarStubMesh(capacity: number): THREE.InstancedMesh {
    const mesh = new THREE.InstancedMesh(
      this.rebarStubGeometry,
      this.rebarStubMaterials[this.viewMode],
      capacity,
    );
    mesh.name = 'ShardRebarStubs';
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.renderOrder = this.viewMode === 'xray' ? 12 : 1;
    mesh.count = 0;
    mesh.visible = false;

    _workColor.setRGB(1, 1, 1, THREE.LinearSRGBColorSpace);
    mesh.setColorAt(0, _workColor);
    return mesh;
  }

  private growRebarStubCapacity(newCapacity: number): void {
    this.group.remove(this.rebarStubMesh);
    this.rebarStubMesh.dispose();

    this.rebarStubCapacity = newCapacity;
    this.rebarStubMesh = this.createRebarStubMesh(newCapacity);
    this.group.add(this.rebarStubMesh);
  }

  private syncRebarStubs(shards: readonly RenderShardInstance[], neededCount: number): void {
    if (neededCount <= 0) {
      this.activeRebarStubCount = 0;
      this.rebarStubMesh.count = 0;
      this.rebarStubMesh.visible = false;
      return;
    }

    if (neededCount > this.rebarStubCapacity) {
      this.growRebarStubCapacity(Math.max(neededCount, this.rebarStubCapacity * 2));
    }

    let stubCursor = 0;

    for (let i = 0; i < shards.length; i++) {
      const shard = shards[i]!;
      const stubs = shard.rebarStubs;
      if (stubs.length === 0) continue;

      const sx = sanitizeCoord(shard.position[0], 1e5, 0);
      const sy = sanitizeCoord(shard.position[1], 1e5, 0);
      const sz = sanitizeCoord(shard.position[2], 1e5, 0);
      sanitizeQuaternionInto(_quat, shard.quaternion);

      const safeTempC = sanitizeFinite(shard.temperatureC, -273.15, 5000, 20);
      const safeShardPhase = Number.isFinite(shard.shardId)
        ? (shard.shardId % 1024) * 1.6180339
        : 0;

      for (let s = 0; s < stubs.length; s++) {
        const stub = stubs[s]!;

        _localVec.set(
          sanitizeCoord(stub.originLocal[0], 1e3, 0),
          sanitizeCoord(stub.originLocal[1], 1e3, 0),
          sanitizeCoord(stub.originLocal[2], 1e3, 0),
        );
        _localVec.applyQuaternion(_quat);
        _pos.set(
          clamp(sx + _localVec.x, -1e5, 1e5),
          clamp(sy + _localVec.y, -1e5, 1e5),
          clamp(sz + _localVec.z, -1e5, 1e5),
        );

        const dx = stub.directionLocal[0];
        const dy = stub.directionLocal[1];
        const dz = stub.directionLocal[2];
        if (Number.isFinite(dx) && Number.isFinite(dy) && Number.isFinite(dz)) {
          const maxDir = Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz));
          if (maxDir > 1e-6) {
            const invMax = 1 / maxDir;
            _worldDir.set(dx * invMax, dy * invMax, dz * invMax).applyQuaternion(_quat);
            const lenSq = _worldDir.lengthSq();
            if (!(lenSq > 1e-10) || !Number.isFinite(lenSq)) {
              _worldDir.set(0, 1, 0);
            } else {
              _worldDir.multiplyScalar(1 / Math.sqrt(lenSq));
            }
          } else {
            _worldDir.set(0, 1, 0);
          }
        } else {
          _worldDir.set(0, 1, 0);
        }

        _alignQuat.setFromUnitVectors(UP_Y, _worldDir);
        const twistAngle = safeShardPhase + (s % 1024) * 2.3999632;
        _twistQuat.setFromAxisAngle(UP_Y, twistAngle);
        _alignQuat.multiply(_twistQuat);

        const safeBend = sanitizeFinite(stub.bendAngleRad, -Math.PI, Math.PI, 0.24);
        const bendScaleX = clamp(Math.abs(safeBend) / 0.24, 0.25, 2.2);
        const safeLen =
          Number.isFinite(stub.lengthM) && stub.lengthM > 0
            ? clamp(stub.lengthM, 1e-3, 100)
            : 0.18;
        _scale.set(bendScaleX, safeLen, 1.0);

        _mat4.compose(_pos, _alignQuat, _scale);
        this.rebarStubMesh.setMatrixAt(stubCursor, _mat4);

        if (this.viewMode === 'xray') {
          // Яркий сигнальный янтарь, контрастно читаемый сквозь полупрозрачный рентген бетона
          _workColor.setHex(0xf59e0b, THREE.SRGBColorSpace);
        } else if (this.viewMode === 'stress') {
          _workColor.setHex(0x94a3b8, THREE.SRGBColorSpace);
        } else {
          _workColor.setHex(0x525b66, THREE.SRGBColorSpace);
          if (safeTempC > 450) {
            const [gr, gg, gb] = computeThermalGlowAdditiveLinear('steel', safeTempC);
            _workColor.r += gr;
            _workColor.g += gg;
            _workColor.b += gb;
          }
        }

        this.rebarStubMesh.setColorAt(stubCursor, _workColor);
        stubCursor += 1;
      }
    }

    this.activeRebarStubCount = stubCursor;
    this.rebarStubMesh.count = stubCursor;
    this.rebarStubMesh.visible = stubCursor > 0;

    if (stubCursor > 0) {
      this.rebarStubMesh.instanceMatrix.needsUpdate = true;
      if (this.rebarStubMesh.instanceColor) {
        this.rebarStubMesh.instanceColor.needsUpdate = true;
      }
    }
  }

  private applyShadowSettings(): void {
    const enableShadows =
      (this.qualityPreset === 'high' || this.qualityPreset === 'ultra') &&
      this.viewMode !== 'xray';

    this.buckets.matte.mesh.castShadow = enableShadows;
    this.buckets.matte.mesh.receiveShadow = enableShadows;

    this.buckets.metallic.mesh.castShadow = enableShadows;
    this.buckets.metallic.mesh.receiveShadow = enableShadows;

    this.buckets.glass.mesh.castShadow = false;
    this.buckets.glass.mesh.receiveShadow = false;
  }
}
