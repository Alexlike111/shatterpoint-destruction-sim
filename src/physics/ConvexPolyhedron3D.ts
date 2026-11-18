import {
  buildOrthonormalPlaneBasis,
  clamp,
  cleanZero,
  computePolyhedronVolumeAndCentroid,
  computePrincipalAxes3D,
  vec3Cross,
  vec3Dot,
  vec3Len,
  vec3Normalize,
  vec3Sub,
} from '../core/math3d';
import type { ConvexFace3D, ConvexPolyhedron3DData, Vec3, Vec3Tuple } from '../core/types';

/**
 * Геометрическое ядро выпуклых 3D-многогранников и канонического безщелевого отсечения
 * полупространством (3D Сазерленд—Ходжман в Float64 с лексикографической 0-ULP симметрией).
 */

export const PLANE_CLIP_EPS = 1e-7;
export const VERTEX_MERGE_EPS = 2e-6;
export const MIN_POLY_VOLUME_M3 = 1e-9;
export const MIN_POLY_THICKNESS_M = 1e-4;

/**
 * Высокоточное Float64-представление многогранника в родительской системе отсчёта.
 */
export interface RawPolyhedron64 {
  /** Плоский массив координат [x0, y0, z0, ...] в Float64 */
  vertices: number[];
  faces: ConvexFace3D[];
}

/**
 * Создаёт канонический выпуклый прямоугольный параллелепипед с полуразмерами [hx, hy, hz].
 * Все 6 граней упорядочены против часовой стрелки снаружи (CCW outward) с isInteriorCut = false.
 */
export function createBoxPolyhedron(halfExtents: Vec3Tuple): ConvexPolyhedron3DData {
  const hx = halfExtents[0];
  const hy = halfExtents[1];
  const hz = halfExtents[2];
  if (!Number.isFinite(hx) || !Number.isFinite(hy) || !Number.isFinite(hz) || hx <= 0 || hy <= 0 || hz <= 0) {
    throw new RangeError(
      `Некорректные полуразмеры createBoxPolyhedron: [${hx}, ${hy}, ${hz}] (ожидаются положительные числа)`,
    );
  }

  const vertices = new Float32Array([
    -hx, -hy, -hz, // 0
    +hx, -hy, -hz, // 1
    +hx, +hy, -hz, // 2
    -hx, +hy, -hz, // 3
    -hx, -hy, +hz, // 4
    +hx, -hy, +hz, // 5
    +hx, +hy, +hz, // 6
    -hx, +hy, +hz, // 7
  ]);

  const faces: ConvexFace3D[] = [
    { indices: [1, 2, 6, 5], normal: [1, 0, 0], isInteriorCut: false },
    { indices: [0, 4, 7, 3], normal: [-1, 0, 0], isInteriorCut: false },
    { indices: [3, 7, 6, 2], normal: [0, 1, 0], isInteriorCut: false },
    { indices: [0, 1, 5, 4], normal: [0, -1, 0], isInteriorCut: false },
    { indices: [4, 5, 6, 7], normal: [0, 0, 1], isInteriorCut: false },
    { indices: [0, 3, 2, 1], normal: [0, 0, -1], isInteriorCut: false },
  ];

  // Вычисляем объём по фактическим Float32-вершинам для точного согласования с последующими срезами
  const metrics = computePolyhedronVolumeAndCentroid(vertices, faces);

  return {
    vertices,
    faces,
    volumeM3: metrics.volumeM3,
    centroid: [0, 0, 0],
    halfExtentsApprox: metrics.halfExtentsApprox,
  };
}

/**
 * Конвертирует ConvexPolyhedron3DData в RawPolyhedron64 в родительских координатах (centroid + v_local).
 */
export function toRawPolyhedron64(poly: ConvexPolyhedron3DData): RawPolyhedron64 {
  const count = Math.floor(poly.vertices.length / 3);
  const vertices = new Array<number>(count * 3);
  const cx = poly.centroid[0];
  const cy = poly.centroid[1];
  const cz = poly.centroid[2];

  for (let i = 0; i < count; i++) {
    vertices[i * 3] = cx + poly.vertices[i * 3]!;
    vertices[i * 3 + 1] = cy + poly.vertices[i * 3 + 1]!;
    vertices[i * 3 + 2] = cz + poly.vertices[i * 3 + 2]!;
  }

  const faces: ConvexFace3D[] = poly.faces.map((f) => ({
    indices: f.indices.slice(),
    normal: [f.normal[0], f.normal[1], f.normal[2]],
    isInteriorCut: f.isInteriorCut,
  }));

  return { vertices, faces };
}

/**
 * Конвертирует локальные вершины ConvexPolyhedron3DData (относительно его собственного центра масс [0,0,0])
 * в RawPolyhedron64 без добавления старого смещения centroid от предыдущего родителя.
 */
export function localPolyhedronToRaw64(poly: ConvexPolyhedron3DData): RawPolyhedron64 {
  const count = Math.floor(poly.vertices.length / 3);
  const vertices = new Array<number>(count * 3);
  for (let i = 0; i < count; i++) {
    vertices[i * 3] = poly.vertices[i * 3]!;
    vertices[i * 3 + 1] = poly.vertices[i * 3 + 1]!;
    vertices[i * 3 + 2] = poly.vertices[i * 3 + 2]!;
  }
  const faces: ConvexFace3D[] = poly.faces.map((f) => ({
    indices: f.indices.slice(),
    normal: [f.normal[0], f.normal[1], f.normal[2]],
    isInteriorCut: f.isInteriorCut,
  }));
  return { vertices, faces };
}

let scratchVolMask = new Uint8Array(128);
let scratchClipDists = new Float64Array(128);
let scratchClipSide = new Int8Array(128);
let scratchOldToNew = new Int32Array(128);
let scratchInFaceMarks = new Int32Array(128);

/**
 * Быстро вычисляет объём и центроид RawPolyhedron64 напрямую в Float64 по теореме Остроградского—Гаусса
 * с вычитанием внутренней опорной точки p_ref без аллокации промежуточных массивов и без сварки Union-Find.
 */
export function computeRawPolyhedronVolumeAndCentroid64(raw: RawPolyhedron64): {
  volumeM3: number;
  centroid: Vec3;
} {
  const coords = raw.vertices;
  const faces = raw.faces;
  const vertCount = Math.floor(coords.length / 3);
  if (vertCount < 4 || faces.length < 4) {
    return { volumeM3: 0, centroid: [0, 0, 0] };
  }

  if (scratchVolMask.length < vertCount) {
    scratchVolMask = new Uint8Array(Math.max(vertCount * 2, 256));
  }
  scratchVolMask.fill(0, 0, vertCount);

  let usedCount = 0;
  let refSumX = 0;
  let refSumY = 0;
  let refSumZ = 0;

  for (let f = 0; f < faces.length; f++) {
    const idxList = faces[f]!.indices;
    for (let k = 0; k < idxList.length; k++) {
      const idx = idxList[k]!;
      if (idx >= 0 && idx < vertCount && scratchVolMask[idx] === 0) {
        scratchVolMask[idx] = 1;
        usedCount++;
        refSumX += coords[idx * 3]!;
        refSumY += coords[idx * 3 + 1]!;
        refSumZ += coords[idx * 3 + 2]!;
      }
    }
  }

  if (usedCount < 4) {
    return { volumeM3: 0, centroid: [0, 0, 0] };
  }

  const pRefX = refSumX / usedCount;
  const pRefY = refSumY / usedCount;
  const pRefZ = refSumZ / usedCount;

  let sumD = 0;
  let momX = 0;
  let momY = 0;
  let momZ = 0;

  for (let f = 0; f < faces.length; f++) {
    const indices = faces[f]!.indices;
    const m = indices.length;
    if (m < 3) continue;

    const i0 = indices[0]!;
    const ax = coords[i0 * 3]! - pRefX;
    const ay = coords[i0 * 3 + 1]! - pRefY;
    const az = coords[i0 * 3 + 2]! - pRefZ;

    for (let t = 1; t < m - 1; t++) {
      const i1 = indices[t]!;
      const i2 = indices[t + 1]!;

      const bx = coords[i1 * 3]! - pRefX;
      const by = coords[i1 * 3 + 1]! - pRefY;
      const bz = coords[i1 * 3 + 2]! - pRefZ;

      const cx = coords[i2 * 3]! - pRefX;
      const cy = coords[i2 * 3 + 1]! - pRefY;
      const cz = coords[i2 * 3 + 2]! - pRefZ;

      const crossX = by * cz - bz * cy;
      const crossY = bz * cx - bx * cz;
      const crossZ = bx * cy - by * cx;
      const det = ax * crossX + ay * crossY + az * crossZ;

      sumD += det;
      momX += det * (ax + bx + cx);
      momY += det * (ay + by + cy);
      momZ += det * (az + bz + cz);
    }
  }

  const volumeM3 = Math.abs(sumD) / 6;
  let centroidX = pRefX;
  let centroidY = pRefY;
  let centroidZ = pRefZ;

  if (Math.abs(sumD) > 1e-18) {
    const invDenom = 1 / (4 * sumD);
    centroidX += momX * invDenom;
    centroidY += momY * invDenom;
    centroidZ += momZ * invDenom;
  }

  return {
    volumeM3: cleanZero(volumeM3),
    centroid: [cleanZero(centroidX), cleanZero(centroidY), cleanZero(centroidZ)],
  };
}

function computeFaceAreaVector64(
  coords: readonly number[],
  indices: readonly number[],
): Vec3 {
  if (indices.length < 3) return [0, 0, 0];
  const i0 = indices[0]!;
  const x0 = coords[i0 * 3]!;
  const y0 = coords[i0 * 3 + 1]!;
  const z0 = coords[i0 * 3 + 2]!;
  let sx = 0;
  let sy = 0;
  let sz = 0;
  for (let t = 1; t < indices.length - 1; t++) {
    const i1 = indices[t]!;
    const i2 = indices[t + 1]!;
    const ux = coords[i1 * 3]! - x0;
    const uy = coords[i1 * 3 + 1]! - y0;
    const uz = coords[i1 * 3 + 2]! - z0;
    const vx = coords[i2 * 3]! - x0;
    const vy = coords[i2 * 3 + 1]! - y0;
    const vz = coords[i2 * 3 + 2]! - z0;
    sx += uy * vz - uz * vy;
    sy += uz * vx - ux * vz;
    sz += ux * vy - uy * vx;
  }
  return [sx * 0.5, sy * 0.5, sz * 0.5];
}

function computeFaceAreaVectorFloat32Centered(
  posX: Float64Array,
  posY: Float64Array,
  posZ: Float64Array,
  refX: number,
  refY: number,
  refZ: number,
  indices: readonly number[],
): Vec3 {
  if (indices.length < 3) return [0, 0, 0];
  const i0 = indices[0]!;
  const x0 = Math.fround(posX[i0]! - refX);
  const y0 = Math.fround(posY[i0]! - refY);
  const z0 = Math.fround(posZ[i0]! - refZ);
  let sx = 0;
  let sy = 0;
  let sz = 0;
  for (let t = 1; t < indices.length - 1; t++) {
    const i1 = indices[t]!;
    const i2 = indices[t + 1]!;
    const ux = Math.fround(posX[i1]! - refX) - x0;
    const uy = Math.fround(posY[i1]! - refY) - y0;
    const uz = Math.fround(posZ[i1]! - refZ) - z0;
    const vx = Math.fround(posX[i2]! - refX) - x0;
    const vy = Math.fround(posY[i2]! - refY) - y0;
    const vz = Math.fround(posZ[i2]! - refZ) - z0;
    sx += uy * vz - uz * vy;
    sy += uz * vx - ux * vz;
    sz += ux * vy - uy * vx;
  }
  return [sx * 0.5, sy * 0.5, sz * 0.5];
}

/**
 * Циклически очищает список вершин грани после слияния вершин в Union-Find:
 * удаляет подряд идущие дубликаты (включая стык конца с началом) и возвратные шипы вида a -> b -> a.
 */
function cleanFaceCycle(
  rawIndices: readonly number[],
  mapVertex: (v: number) => number,
): number[] {
  let cur: number[] = [];
  for (let i = 0; i < rawIndices.length; i++) {
    const v = mapVertex(rawIndices[i]!);
    if (cur.length === 0 || cur[cur.length - 1] !== v) {
      cur.push(v);
    }
  }

  let changed = true;
  while (changed && cur.length >= 2) {
    changed = false;
    while (cur.length >= 2 && cur[0] === cur[cur.length - 1]) {
      cur.pop();
      changed = true;
    }
    if (cur.length < 3) {
      break;
    }

    const next: number[] = [];
    for (let i = 0; i < cur.length; i++) {
      const v = cur[i]!;
      if (next.length > 0 && next[next.length - 1] === v) {
        changed = true;
        continue;
      }
      if (next.length >= 2 && next[next.length - 2] === v) {
        next.pop();
        changed = true;
        continue;
      }
      next.push(v);
    }

    if (next.length >= 4 && next[1] === next[next.length - 1]) {
      next.shift();
      changed = true;
    } else if (next.length >= 4 && next[0] === next[next.length - 2]) {
      next.pop();
      next.pop();
      changed = true;
    }

    cur = next;
  }

  return cur.length >= 3 ? cur : [];
}

/**
 * Финализирует RawPolyhedron64 в ConvexPolyhedron3DData:
 * выполняет топологическую сварку сверхблизких вершин и стягивание вырожденных микро-граней через Union-Find,
 * проверяет обход граней CCW снаружи (в Float64 и Float32), вычисляет объём/центроид и сертифицирует замкнутость.
 */
export function finalizePolyhedron3D(raw: RawPolyhedron64): ConvexPolyhedron3DData | null {
  const srcVertCount = Math.floor(raw.vertices.length / 3);
  if (srcVertCount < 4 || raw.faces.length < 4) {
    return null;
  }

  // 1. Первичная выборка реально используемых в гранях вершин
  const remap = new Int32Array(srcVertCount).fill(-1);
  const compactCoords: number[] = [];
  let compactCount = 0;
  let initMinX = Number.POSITIVE_INFINITY;
  let initMinY = Number.POSITIVE_INFINITY;
  let initMinZ = Number.POSITIVE_INFINITY;
  let initMaxX = Number.NEGATIVE_INFINITY;
  let initMaxY = Number.NEGATIVE_INFINITY;
  let initMaxZ = Number.NEGATIVE_INFINITY;

  let workFaces: Array<{ indices: number[]; normal: Vec3; isInteriorCut: boolean }> = [];

  for (let f = 0; f < raw.faces.length; f++) {
    const face = raw.faces[f]!;
    if (face.indices.length < 3) continue;
    const mappedFace: number[] = [];
    for (let k = 0; k < face.indices.length; k++) {
      const oldIdx = face.indices[k]!;
      if (oldIdx < 0 || oldIdx >= srcVertCount) return null;
      let cIdx = remap[oldIdx]!;
      if (cIdx === -1) {
        const vx = raw.vertices[oldIdx * 3]!;
        const vy = raw.vertices[oldIdx * 3 + 1]!;
        const vz = raw.vertices[oldIdx * 3 + 2]!;
        if (!Number.isFinite(vx) || !Number.isFinite(vy) || !Number.isFinite(vz)) {
          return null;
        }
        cIdx = compactCount++;
        remap[oldIdx] = cIdx;
        compactCoords.push(vx, vy, vz);
        if (vx < initMinX) initMinX = vx;
        if (vy < initMinY) initMinY = vy;
        if (vz < initMinZ) initMinZ = vz;
        if (vx > initMaxX) initMaxX = vx;
        if (vy > initMaxY) initMaxY = vy;
        if (vz > initMaxZ) initMaxZ = vz;
      }
      mappedFace.push(cIdx);
    }
    workFaces.push({
      indices: mappedFace,
      normal: vec3Normalize(face.normal, [0, 1, 0]),
      isInteriorCut: face.isInteriorCut,
    });
  }

  if (compactCount < 4 || workFaces.length < 4) {
    return null;
  }

  const maxSpan = Math.max(initMaxX - initMinX, initMaxY - initMinY, initMaxZ - initMinZ);
  if (!Number.isFinite(maxSpan) || maxSpan < MIN_POLY_THICKNESS_M) {
    return null;
  }

  // 2. Структура Union-Find для синхронной топологической сварки вершин во всех гранях
  const parent = new Int32Array(compactCount);
  const clusterSize = new Int32Array(compactCount);
  const sumX = new Float64Array(compactCount);
  const sumY = new Float64Array(compactCount);
  const sumZ = new Float64Array(compactCount);
  const posX = new Float64Array(compactCount);
  const posY = new Float64Array(compactCount);
  const posZ = new Float64Array(compactCount);

  for (let i = 0; i < compactCount; i++) {
    parent[i] = i;
    clusterSize[i] = 1;
    const x = compactCoords[i * 3]!;
    const y = compactCoords[i * 3 + 1]!;
    const z = compactCoords[i * 3 + 2]!;
    sumX[i] = x;
    sumY[i] = y;
    sumZ[i] = z;
    posX[i] = x;
    posY[i] = y;
    posZ[i] = z;
  }

  const findRoot = (i: number): number => {
    let root = i;
    while (parent[root] !== root) {
      root = parent[root]!;
    }
    let cur = i;
    while (cur !== root) {
      const nxt = parent[cur]!;
      parent[cur] = root;
      cur = nxt;
    }
    return root;
  };

  const unionRoots = (a: number, b: number): boolean => {
    let ra = findRoot(a);
    let rb = findRoot(b);
    if (ra === rb) return false;
    if (clusterSize[ra]! < clusterSize[rb]! || (clusterSize[ra] === clusterSize[rb] && ra > rb)) {
      const tmp = ra;
      ra = rb;
      rb = tmp;
    }
    parent[rb] = ra;
    const newSize = clusterSize[ra]! + clusterSize[rb]!;
    clusterSize[ra] = newSize;
    sumX[ra] = sumX[ra]! + sumX[rb]!;
    sumY[ra] = sumY[ra]! + sumY[rb]!;
    sumZ[ra] = sumZ[ra]! + sumZ[rb]!;
    posX[ra] = sumX[ra]! / newSize;
    posY[ra] = sumY[ra]! / newSize;
    posZ[ra] = sumZ[ra]! / newSize;
    return true;
  };

  const snapRootToAnchor = (moving: number, anchor: number): boolean => {
    const rm = findRoot(moving);
    const ra = findRoot(anchor);
    if (rm === ra) return false;
    parent[rm] = ra;
    return true;
  };

  // Фаза А: итеративная метрическая сварка близких вершин (< max(VERTEX_MERGE_EPS, 5e-6 * maxSpan))
  const mergeTol = Math.max(VERTEX_MERGE_EPS, 5e-6 * maxSpan);
  const mergeTolSq = mergeTol * mergeTol;

  let mergedInPass = true;
  for (let pass = 0; pass < 8 && mergedInPass; pass++) {
    mergedInPass = false;
    for (let i = 0; i < compactCount; i++) {
      if (parent[i] !== i) continue;
      for (let j = i + 1; j < compactCount; j++) {
        if (parent[j] !== j) continue;
        const ri = findRoot(i);
        const rj = findRoot(j);
        if (ri === rj) continue;
        const dx = posX[ri]! - posX[rj]!;
        const dy = posY[ri]! - posY[rj]!;
        const dz = posZ[ri]! - posZ[rj]!;
        if (dx * dx + dy * dy + dz * dz < mergeTolSq) {
          if (unionRoots(ri, rj)) {
            mergedInPass = true;
          }
        }
      }
    }
  }

  // Фаза Б: синхронная очистка циклов и локальное стягивание вырожденных микро-граней (без одиночного выбрасывания граней!)
  const activeMask = new Uint8Array(compactCount);
  for (let collapseIter = 0; collapseIter < 32; collapseIter++) {
    const nextFaces: Array<{ indices: number[]; normal: Vec3; isInteriorCut: boolean }> = [];
    activeMask.fill(0);
    let activeRootCount = 0;

    for (let f = 0; f < workFaces.length; f++) {
      const wf = workFaces[f]!;
      const cleaned = cleanFaceCycle(wf.indices, findRoot);
      if (cleaned.length < 3) {
        continue;
      }
      for (let k = 0; k < cleaned.length; k++) {
        const r = cleaned[k]!;
        if (activeMask[r] === 0) {
          activeMask[r] = 1;
          activeRootCount++;
        }
      }
      nextFaces.push({
        indices: cleaned,
        normal: wf.normal,
        isInteriorCut: wf.isInteriorCut,
      });
    }

    workFaces = nextFaces;
    if (activeRootCount < 4 || workFaces.length < 4) {
      return null;
    }

    let refX = 0;
    let refY = 0;
    let refZ = 0;
    for (let i = 0; i < compactCount; i++) {
      if (activeMask[i] !== 0) {
        refX += posX[i]!;
        refY += posY[i]!;
        refZ += posZ[i]!;
      }
    }
    refX /= activeRootCount;
    refY /= activeRootCount;
    refZ /= activeRootCount;

    let bestShortEdgeU = -1;
    let bestShortEdgeV = -1;
    let bestShortEdgeDistSq = Number.POSITIVE_INFINITY;
    let collinearVertex = -1;
    let collinearAnchor = -1;
    let foundDegenerate = false;

    for (let f = 0; f < workFaces.length; f++) {
      const wf = workFaces[f]!;
      const idx = wf.indices;
      let normal = wf.normal;
      const i0 = idx[0]!;
      const rel0X = posX[i0]! - refX;
      const rel0Y = posY[i0]! - refY;
      const rel0Z = posZ[i0]! - refZ;
      if (rel0X * normal[0] + rel0Y * normal[1] + rel0Z * normal[2] < 0) {
        normal = [cleanZero(-normal[0]), cleanZero(-normal[1]), cleanZero(-normal[2])];
        wf.normal = normal;
      }

      // Вектор площади грани в Float64 по текущим координатам кластеров
      const x0 = posX[i0]!;
      const y0 = posY[i0]!;
      const z0 = posZ[i0]!;
      let sx = 0;
      let sy = 0;
      let sz = 0;
      for (let t = 1; t < idx.length - 1; t++) {
        const i1 = idx[t]!;
        const i2 = idx[t + 1]!;
        const ux = posX[i1]! - x0;
        const uy = posY[i1]! - y0;
        const uz = posZ[i1]! - z0;
        const vx = posX[i2]! - x0;
        const vy = posY[i2]! - y0;
        const vz = posZ[i2]! - z0;
        sx += uy * vz - uz * vy;
        sy += uz * vx - ux * vz;
        sz += ux * vy - uy * vx;
      }
      let areaVec64: Vec3 = [sx * 0.5, sy * 0.5, sz * 0.5];
      const areaLen64 = vec3Len(areaVec64);

      if (areaLen64 > 1e-18 && vec3Dot(areaVec64, normal) < 0) {
        idx.reverse();
        areaVec64 = [-areaVec64[0], -areaVec64[1], -areaVec64[2]];
      }

      const areaVec32 = computeFaceAreaVectorFloat32Centered(posX, posY, posZ, refX, refY, refZ, idx);
      const dotArea32 = vec3Dot(areaVec32, normal);

      if (areaLen64 <= 1e-12 || dotArea32 <= 1e-11) {
        foundDegenerate = true;
        const m = idx.length;
        for (let k = 0; k < m; k++) {
          const u = idx[k]!;
          const v = idx[(k + 1) % m]!;
          const dx = posX[u]! - posX[v]!;
          const dy = posY[u]! - posY[v]!;
          const dz = posZ[u]! - posZ[v]!;
          const dSq = dx * dx + dy * dy + dz * dz;
          if (dSq < bestShortEdgeDistSq) {
            bestShortEdgeDistSq = dSq;
            bestShortEdgeU = u;
            bestShortEdgeV = v;
          }
        }

        // Проверяем также наличие коллинеарной промежуточной вершины (угол ~ 180°) на длинном ребре
        let worstCos = 1.0;
        for (let k = 0; k < m; k++) {
          const prev = idx[(k + m - 1) % m]!;
          const mid = idx[k]!;
          const nxt = idx[(k + 1) % m]!;
          const ax = posX[prev]! - posX[mid]!;
          const ay = posY[prev]! - posY[mid]!;
          const az = posZ[prev]! - posZ[mid]!;
          const bx = posX[nxt]! - posX[mid]!;
          const by = posY[nxt]! - posY[mid]!;
          const bz = posZ[nxt]! - posZ[mid]!;
          const la = Math.hypot(ax, ay, az);
          const lb = Math.hypot(bx, by, bz);
          if (la > 1e-12 && lb > 1e-12) {
            const cosAng = (ax * bx + ay * by + az * bz) / (la * lb);
            if (cosAng < worstCos) {
              worstCos = cosAng;
              collinearVertex = mid;
              collinearAnchor = la <= lb ? prev : nxt;
            }
          }
        }
      }
    }

    if (!foundDegenerate) {
      break;
    }

    const shortLimitSq = Math.pow(25 * mergeTol, 2);
    let collapsed = false;
    if (bestShortEdgeU !== -1 && bestShortEdgeV !== -1 && bestShortEdgeDistSq <= shortLimitSq) {
      collapsed = unionRoots(bestShortEdgeU, bestShortEdgeV);
    } else if (collinearVertex !== -1 && collinearAnchor !== -1) {
      collapsed = snapRootToAnchor(collinearVertex, collinearAnchor);
    } else if (bestShortEdgeU !== -1 && bestShortEdgeV !== -1) {
      collapsed = unionRoots(bestShortEdgeU, bestShortEdgeV);
    }

    if (!collapsed) {
      return null;
    }
  }

  // 3. Финальная плотная компактификация выживших корней и граней
  const rootToFinal = new Int32Array(compactCount).fill(-1);
  const finalCoords64: number[] = [];
  let finalVertCount = 0;
  const finalFaces: ConvexFace3D[] = [];

  for (let f = 0; f < workFaces.length; f++) {
    const wf = workFaces[f]!;
    const cleaned = cleanFaceCycle(wf.indices, findRoot);
    if (cleaned.length < 3) {
      continue;
    }
    const mapped: number[] = new Array(cleaned.length);
    for (let k = 0; k < cleaned.length; k++) {
      const r = cleaned[k]!;
      let fIdx = rootToFinal[r]!;
      if (fIdx === -1) {
        fIdx = finalVertCount++;
        rootToFinal[r] = fIdx;
        finalCoords64.push(posX[r]!, posY[r]!, posZ[r]!);
      }
      mapped[k] = fIdx;
    }
    finalFaces.push({
      indices: mapped,
      normal: wf.normal,
      isInteriorCut: wf.isInteriorCut,
    });
  }

  if (finalVertCount < 4 || finalFaces.length < 4) {
    return null;
  }

  let centerRefX = 0;
  let centerRefY = 0;
  let centerRefZ = 0;
  for (let i = 0; i < finalVertCount; i++) {
    centerRefX += finalCoords64[i * 3]!;
    centerRefY += finalCoords64[i * 3 + 1]!;
    centerRefZ += finalCoords64[i * 3 + 2]!;
  }
  centerRefX /= finalVertCount;
  centerRefY /= finalVertCount;
  centerRefZ /= finalVertCount;

  for (let f = 0; f < finalFaces.length; f++) {
    const face = finalFaces[f]!;
    let normal = vec3Normalize(face.normal, [0, 1, 0]);
    const i0 = face.indices[0]!;
    const v0RelX = finalCoords64[i0 * 3]! - centerRefX;
    const v0RelY = finalCoords64[i0 * 3 + 1]! - centerRefY;
    const v0RelZ = finalCoords64[i0 * 3 + 2]! - centerRefZ;

    if (v0RelX * normal[0] + v0RelY * normal[1] + v0RelZ * normal[2] < 0) {
      normal = [cleanZero(-normal[0]), cleanZero(-normal[1]), cleanZero(-normal[2])];
    }

    const areaVec = computeFaceAreaVector64(finalCoords64, face.indices);
    const areaLen = vec3Len(areaVec);
    // Категорически запрещено выбрасывать одиночную грань через continue: если грань вырождена — весь полиэдр невалиден
    if (areaLen <= 1e-13) {
      return null;
    }

    if (vec3Dot(areaVec, normal) < 0) {
      face.indices.reverse();
    }
    face.normal = normal;
  }

  // 4. Интегрирование Остроградского—Гаусса напрямую в Float64 и перевод вершин в Float32Array
  const metrics = computeRawPolyhedronVolumeAndCentroid64({
    vertices: finalCoords64,
    faces: finalFaces,
  });
  if (!Number.isFinite(metrics.volumeM3) || metrics.volumeM3 < MIN_POLY_VOLUME_M3) {
    return null;
  }

  const cx = metrics.centroid[0];
  const cy = metrics.centroid[1];
  const cz = metrics.centroid[2];

  const vertices32 = new Float32Array(finalVertCount * 3);
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;

  for (let i = 0; i < finalVertCount; i++) {
    const lx = cleanZero(finalCoords64[i * 3]! - cx);
    const ly = cleanZero(finalCoords64[i * 3 + 1]! - cy);
    const lz = cleanZero(finalCoords64[i * 3 + 2]! - cz);
    vertices32[i * 3] = lx;
    vertices32[i * 3 + 1] = ly;
    vertices32[i * 3 + 2] = lz;
    const fx = vertices32[i * 3]!;
    const fy = vertices32[i * 3 + 1]!;
    const fz = vertices32[i * 3 + 2]!;
    if (fx < minX) minX = fx;
    if (fy < minY) minY = fy;
    if (fz < minZ) minZ = fz;
    if (fx > maxX) maxX = fx;
    if (fy > maxY) maxY = fy;
    if (fz > maxZ) maxZ = fz;
  }

  const minAxisSpan = Math.min(maxX - minX, maxY - minY, maxZ - minZ);
  if (minAxisSpan < MIN_POLY_THICKNESS_M) {
    return null;
  }

  for (let f = 0; f < finalFaces.length; f++) {
    const n = finalFaces[f]!.normal;
    let lo = Number.POSITIVE_INFINITY;
    let hi = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < finalVertCount; i++) {
      const p =
        vertices32[i * 3]! * n[0] +
        vertices32[i * 3 + 1]! * n[1] +
        vertices32[i * 3 + 2]! * n[2];
      if (p < lo) lo = p;
      if (p > hi) hi = p;
    }
    if (hi - lo < MIN_POLY_THICKNESS_M) {
      return null;
    }
  }

  const result: ConvexPolyhedron3DData = {
    vertices: vertices32,
    faces: finalFaces,
    volumeM3: metrics.volumeM3,
    centroid: metrics.centroid,
    halfExtentsApprox: [
      cleanZero((maxX - minX) * 0.5),
      cleanZero((maxY - minY) * 0.5),
      cleanZero((maxZ - minZ) * 0.5),
    ],
  };

  // 5. Обязательная проверка водонепроницаемости (V - E + F = 2, спаренность полурёбер, площадь граней в Float32)
  const watertight = validateWatertightConvexPolyhedron(result);
  if (!watertight.valid) {
    return null;
  }

  return result;
}

/**
 * Лексикографически-симметричное пересечение ребра с плоскостью в Float64 (0 ULP расхождения при смене +n <-> -n).
 */
function intersectEdgeCanonical64(
  ax: number,
  ay: number,
  az: number,
  absDa: number,
  bx: number,
  by: number,
  bz: number,
  absDb: number,
): Vec3 {
  let aIsLo = false;
  if (ax !== bx) {
    aIsLo = ax < bx;
  } else if (ay !== by) {
    aIsLo = ay < by;
  } else {
    aIsLo = az <= bz;
  }

  const lox = aIsLo ? ax : bx;
  const loy = aIsLo ? ay : by;
  const loz = aIsLo ? az : bz;
  const dLo = aIsLo ? absDa : absDb;

  const hix = aIsLo ? bx : ax;
  const hiy = aIsLo ? by : ay;
  const hiz = aIsLo ? bz : az;
  const dHi = aIsLo ? absDb : absDa;

  const denom = dLo + dHi;
  if (denom <= 0) {
    return [(lox + hix) * 0.5, (loy + hiy) * 0.5, (loz + hiz) * 0.5];
  }
  if (dLo < dHi) {
    const t = dLo / denom;
    return [lox + (hix - lox) * t, loy + (hiy - loy) * t, loz + (hiz - loz) * t];
  }
  if (dHi < dLo) {
    const t = dHi / denom;
    return [hix + (lox - hix) * t, hiy + (loy - hiy) * t, hiz + (loz - hiz) * t];
  }
  return [(lox + hix) * 0.5, (loy + hiy) * 0.5, (loz + hiz) * 0.5];
}

/**
 * Отсекает RawPolyhedron64 полупространством (p - planePoint) · normalize(planeNormal) >= 0.
 * Новая грань среза получает внешнюю нормаль -normalize(planeNormal) и флаг isInteriorCut = markCutInterior.
 * При cloneIfUntouched = false и полном попадании всех вершин строго внутрь полупространства
 * возвращает исходный raw за O(1) без аллокации массивов.
 */
export function clipRawPolyhedronByPlane64(
  raw: RawPolyhedron64,
  planePoint: Vec3Tuple,
  planeNormal: Vec3Tuple,
  markCutInterior = true,
  cloneIfUntouched = true,
): RawPolyhedron64 | null {
  const vertCount = Math.floor(raw.vertices.length / 3);
  if (vertCount < 4 || raw.faces.length < 4) {
    return null;
  }

  const nLen = Math.hypot(planeNormal[0], planeNormal[1], planeNormal[2]);
  if (!Number.isFinite(nLen) || nLen < 1e-20) {
    return null;
  }
  const nx = planeNormal[0] / nLen;
  const ny = planeNormal[1] / nLen;
  const nz = planeNormal[2] / nLen;

  const p0x = planePoint[0];
  const p0y = planePoint[1];
  const p0z = planePoint[2];

  if (scratchClipDists.length < vertCount) {
    const cap = Math.max(vertCount * 2, 256);
    scratchClipDists = new Float64Array(cap);
    scratchClipSide = new Int8Array(cap);
    scratchOldToNew = new Int32Array(cap);
  }
  const dists = scratchClipDists;
  let maxPos = 0;
  let maxNeg = 0;
  let minDist = Number.POSITIVE_INFINITY;

  for (let i = 0; i < vertCount; i++) {
    const dx = raw.vertices[i * 3]! - p0x;
    const dy = raw.vertices[i * 3 + 1]! - p0y;
    const dz = raw.vertices[i * 3 + 2]! - p0z;
    const d = dx * nx + dy * ny + dz * nz;
    dists[i] = d;
    if (d > maxPos) maxPos = d;
    if (-d > maxNeg) maxNeg = -d;
    if (d < minDist) minDist = d;
  }

  // Симметричный порог толстой плоскости по инвариантному к замене +n <-> -n полному размаху:
  // исключает «мёртвую зону» потери 100% объёма при скользящих срезах вблизи вершин и острых рёбер
  const eps =
    maxPos + maxNeg > 4 * VERTEX_MERGE_EPS ? VERTEX_MERGE_EPS : PLANE_CLIP_EPS;

  // Если ни одна вершина не выступает в положительное полупространство дальше eps — остаток пуст
  if (maxPos <= eps) {
    return null;
  }

  // Быстрый выход O(1) без аллокаций, когда все вершины лежат строго в POS (negCount === 0 && onCount === 0)
  if (!cloneIfUntouched && minDist > eps) {
    return raw;
  }

  // side: 1 = POS, 0 = ON, -1 = NEG
  const side = scratchClipSide;
  let posCount = 0;
  let negCount = 0;
  let onCount = 0;

  for (let i = 0; i < vertCount; i++) {
    const d = dists[i]!;
    if (d > eps) {
      side[i] = 1;
      posCount++;
    } else if (d < -eps) {
      side[i] = -1;
      negCount++;
    } else {
      side[i] = 0;
      onCount++;
    }
  }

  if (posCount === 0) {
    return null;
  }

  if (negCount === 0 && onCount === 0 && !cloneIfUntouched) {
    return raw;
  }

  const outNormal: Vec3 = [cleanZero(-nx), cleanZero(-ny), cleanZero(-nz)];

  const cloneUntouchedRaw = (): RawPolyhedron64 => {
    const clonedFaces: ConvexFace3D[] = raw.faces.map((face) => {
      let allOn = true;
      for (let k = 0; k < face.indices.length; k++) {
        if (side[face.indices[k]!] !== 0) {
          allOn = false;
          break;
        }
      }
      const alignedWithCut = allOn && vec3Dot(face.normal, outNormal) > 0.9999;
      return {
        indices: face.indices.slice(),
        normal: [face.normal[0], face.normal[1], face.normal[2]],
        isInteriorCut: alignedWithCut ? face.isInteriorCut || markCutInterior : face.isInteriorCut,
      };
    });
    return {
      vertices: raw.vertices.slice(),
      faces: clonedFaces,
    };
  };

  // Если ни одна вершина не попала в NEG — весь полиэдр остаётся целым
  if (negCount === 0) {
    return cloneUntouchedRaw();
  }

  const newVertices: number[] = [];
  const oldToNew = scratchOldToNew;
  oldToNew.fill(-1, 0, vertCount);
  const onCutPlaneFlags: boolean[] = [];

  const getMappedVertex = (oldIdx: number): number => {
    let mapped = oldToNew[oldIdx]!;
    if (mapped === -1) {
      mapped = Math.floor(newVertices.length / 3);
      oldToNew[oldIdx] = mapped;
      newVertices.push(
        raw.vertices[oldIdx * 3]!,
        raw.vertices[oldIdx * 3 + 1]!,
        raw.vertices[oldIdx * 3 + 2]!,
      );
      onCutPlaneFlags.push(side[oldIdx] === 0);
    }
    return mapped;
  };

  const edgeCutCache = new Map<number, number>();
  const getEdgeCutVertex = (a: number, b: number): number => {
    const lo = a < b ? a : b;
    const hi = a < b ? b : a;
    const key = lo * vertCount + hi;
    const existing = edgeCutCache.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const pt = intersectEdgeCanonical64(
      raw.vertices[a * 3]!,
      raw.vertices[a * 3 + 1]!,
      raw.vertices[a * 3 + 2]!,
      Math.abs(dists[a]!),
      raw.vertices[b * 3]!,
      raw.vertices[b * 3 + 1]!,
      raw.vertices[b * 3 + 2]!,
      Math.abs(dists[b]!),
    );
    const idx = Math.floor(newVertices.length / 3);
    newVertices.push(pt[0], pt[1], pt[2]);
    onCutPlaneFlags.push(true);
    edgeCutCache.set(key, idx);
    return idx;
  };

  const clippedFaces: ConvexFace3D[] = [];

  for (let f = 0; f < raw.faces.length; f++) {
    const face = raw.faces[f]!;
    const indices = face.indices;
    const m = indices.length;
    if (m < 3) continue;

    let faceHasPos = false;
    for (let k = 0; k < m; k++) {
      if (side[indices[k]!] === 1) {
        faceHasPos = true;
        break;
      }
    }
    // Если у грани нет ни одной вершины строго в POS — вся грань отсечена полупространством
    if (!faceHasPos) {
      continue;
    }

    const outIndices: number[] = [];
    for (let k = 0; k < m; k++) {
      const a = indices[k]!;
      const b = indices[(k + 1) % m]!;
      const sa = side[a]!;
      const sb = side[b]!;

      if (sa !== -1) {
        outIndices.push(getMappedVertex(a));
      }
      if ((sa === 1 && sb === -1) || (sa === -1 && sb === 1)) {
        outIndices.push(getEdgeCutVertex(a, b));
      }
    }

    if (outIndices.length >= 3) {
      clippedFaces.push({
        indices: outIndices,
        normal: [face.normal[0], face.normal[1], face.normal[2]],
        isInteriorCut: face.isInteriorCut,
      });
    }
  }

  if (clippedFaces.length < 3) {
    return maxPos > maxNeg ? cloneUntouchedRaw() : null;
  }

  // Находим все неспаренные полурёбра u -> v сохранённых боковых граней и строим точную крышку среза v -> u
  const totalVerts = Math.floor(newVertices.length / 3);
  const halfEdgeSet = new Set<number>();
  const halfEdgeKeys: number[] = [];
  for (let f = 0; f < clippedFaces.length; f++) {
    const idx = clippedFaces[f]!.indices;
    const m = idx.length;
    for (let k = 0; k < m; k++) {
      const u = idx[k]!;
      const v = idx[(k + 1) % m]!;
      const key = u * totalVerts + v;
      halfEdgeSet.add(key);
      halfEdgeKeys.push(key);
    }
  }

  // Для крышки среза каждому неспаренному u -> v соответствует обратное ребро v -> u
  const nextCapMap = new Map<number, number>();
  let boundaryCount = 0;
  let chainValid = true;
  let startCapVertex = -1;

  for (let i = 0; i < halfEdgeKeys.length; i++) {
    const key = halfEdgeKeys[i]!;
    const u = Math.floor(key / totalVerts);
    const v = key - u * totalVerts;
    if (!halfEdgeSet.has(v * totalVerts + u)) {
      boundaryCount++;
      if (nextCapMap.has(v)) {
        chainValid = false;
      } else {
        nextCapMap.set(v, u);
        if (startCapVertex === -1) {
          startCapVertex = v;
        }
      }
    }
  }

  let capIndices: number[] = [];

  if (chainValid && boundaryCount >= 3 && startCapVertex !== -1) {
    let curr = startCapVertex;
    for (let step = 0; step < boundaryCount; step++) {
      capIndices.push(curr);
      const nxt = nextCapMap.get(curr);
      if (nxt === undefined) {
        chainValid = false;
        break;
      }
      curr = nxt;
      if (curr === startCapVertex && step < boundaryCount - 1) {
        chainValid = false;
        break;
      }
    }
    if (curr !== startCapVertex || capIndices.length !== boundaryCount) {
      chainValid = false;
    }
  } else {
    chainValid = false;
  }

  // Резервная угловая сортировка в правом базисе внешней нормали outNormal (u × v = +outNormal => CCW снаружи)
  if (!chainValid) {
    const capSet = new Set<number>();
    for (let f = 0; f < clippedFaces.length; f++) {
      const idx = clippedFaces[f]!.indices;
      for (let k = 0; k < idx.length; k++) {
        const vIdx = idx[k]!;
        if (onCutPlaneFlags[vIdx]) {
          capSet.add(vIdx);
        }
      }
    }
    const rawCap = Array.from(capSet);
    if (rawCap.length < 3) {
      return maxPos > maxNeg ? cloneUntouchedRaw() : null;
    }
    let cx = 0;
    let cy = 0;
    let cz = 0;
    for (let i = 0; i < rawCap.length; i++) {
      const id = rawCap[i]!;
      cx += newVertices[id * 3]!;
      cy += newVertices[id * 3 + 1]!;
      cz += newVertices[id * 3 + 2]!;
    }
    cx /= rawCap.length;
    cy /= rawCap.length;
    cz /= rawCap.length;

    const basis = buildOrthonormalPlaneBasis(outNormal);
    rawCap.sort((a, b) => {
      const dax = newVertices[a * 3]! - cx;
      const day = newVertices[a * 3 + 1]! - cy;
      const daz = newVertices[a * 3 + 2]! - cz;
      const dbx = newVertices[b * 3]! - cx;
      const dby = newVertices[b * 3 + 1]! - cy;
      const dbz = newVertices[b * 3 + 2]! - cz;
      const angA = Math.atan2(
        dax * basis.v[0] + day * basis.v[1] + daz * basis.v[2],
        dax * basis.u[0] + day * basis.u[1] + daz * basis.u[2],
      );
      const angB = Math.atan2(
        dbx * basis.v[0] + dby * basis.v[1] + dbz * basis.v[2],
        dbx * basis.u[0] + dby * basis.u[1] + dbz * basis.u[2],
      );
      return angA - angB;
    });
    capIndices = rawCap;
  }

  const capAreaVec = computeFaceAreaVector64(newVertices, capIndices);
  const capArea = vec3Len(capAreaVec);
  if (capArea <= 1e-12) {
    return maxPos > maxNeg ? cloneUntouchedRaw() : null;
  }
  if (vec3Dot(capAreaVec, outNormal) < 0) {
    capIndices.reverse();
  }

  clippedFaces.push({
    indices: capIndices,
    normal: outNormal,
    isInteriorCut: markCutInterior,
  });

  return {
    vertices: newVertices,
    faces: clippedFaces,
  };
}

/**
 * Публичное каноническое отсечение ConvexPolyhedron3DData полупространством:
 * оставляет { p | (p - planePoint) · planeNormal >= 0 }.
 * Внешняя нормаль новой грани среза равна -normalize(planeNormal), флаг грани isInteriorCut = markCutInterior.
 */
export function clipConvexPolyhedronByPlane(
  poly: ConvexPolyhedron3DData,
  planePoint: Vec3Tuple,
  planeNormal: Vec3Tuple,
  markCutInterior = true,
): ConvexPolyhedron3DData | null {
  const raw = toRawPolyhedron64(poly);
  const clipped = clipRawPolyhedronByPlane64(raw, planePoint, planeNormal, markCutInterior);
  if (!clipped) {
    return null;
  }
  const finalized = finalizePolyhedron3D(clipped);
  if (finalized) {
    return finalized;
  }

  // Если плоскость лишь вскользь коснулась края (maxPos >> maxNeg), а пограничный срез не прошёл финализацию,
  // сохраняем исходный валидный многогранник без потери объёма
  const nLen = Math.hypot(planeNormal[0], planeNormal[1], planeNormal[2]);
  if (Number.isFinite(nLen) && nLen >= 1e-20) {
    const invN = 1 / nLen;
    const nx = planeNormal[0] * invN;
    const ny = planeNormal[1] * invN;
    const nz = planeNormal[2] * invN;
    const vertCount = Math.floor(raw.vertices.length / 3);
    let maxPos = 0;
    let maxNeg = 0;
    for (let i = 0; i < vertCount; i++) {
      const d =
        (raw.vertices[i * 3]! - planePoint[0]) * nx +
        (raw.vertices[i * 3 + 1]! - planePoint[1]) * ny +
        (raw.vertices[i * 3 + 2]! - planePoint[2]) * nz;
      if (d > maxPos) maxPos = d;
      if (-d > maxNeg) maxNeg = -d;
    }
    if (maxPos > maxNeg && maxNeg <= Math.max(MIN_POLY_THICKNESS_M, 1e-3 * (maxPos + maxNeg))) {
      return finalizePolyhedron3D(raw);
    }
  }

  return null;
}

/**
 * Вычисляет минимальную 3D-толщину штангенциркуля (caliper thickness) по нормалям всех граней и собственным осям.
 */
export function computePolyhedronMinThickness(poly: ConvexPolyhedron3DData): number {
  const count = Math.floor(poly.vertices.length / 3);
  if (count < 4 || poly.faces.length < 4) {
    return 0;
  }

  let minSpan = Number.POSITIVE_INFINITY;

  for (let f = 0; f < poly.faces.length; f++) {
    const n = poly.faces[f]!.normal;
    let minP = Number.POSITIVE_INFINITY;
    let maxP = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < count; i++) {
      const proj =
        poly.vertices[i * 3]! * n[0] +
        poly.vertices[i * 3 + 1]! * n[1] +
        poly.vertices[i * 3 + 2]! * n[2];
      if (proj < minP) minP = proj;
      if (proj > maxP) maxP = proj;
    }
    const span = maxP - minP;
    if (span < minSpan) {
      minSpan = span;
    }
  }

  const { spans } = computePrincipalAxes3D(poly.vertices);
  if (spans[2] < minSpan) {
    minSpan = spans[2];
  }

  return Number.isFinite(minSpan) ? Math.max(0, minSpan) : 0;
}

/**
 * Зажимает произвольную локальную точку строго внутрь выпуклого полиэдра (к центроиду [0,0,0] с запасом marginRatio).
 */
export function clampPointInsidePolyhedron(
  poly: ConvexPolyhedron3DData,
  pointLocal: Vec3Tuple,
  marginRatio = 0.1,
): [number, number, number] {
  const safeMargin = clamp(marginRatio, 0.01, 0.9);
  const keepFactor = 1 - safeMargin;
  const px = pointLocal[0];
  const py = pointLocal[1];
  const pz = pointLocal[2];

  if (!Number.isFinite(px) || !Number.isFinite(py) || !Number.isFinite(pz)) {
    return [0, 0, 0];
  }

  let tMax = 1.0;

  for (let f = 0; f < poly.faces.length; f++) {
    const face = poly.faces[f]!;
    if (face.indices.length === 0) continue;
    const i0 = face.indices[0]!;
    const v0x = poly.vertices[i0 * 3]!;
    const v0y = poly.vertices[i0 * 3 + 1]!;
    const v0z = poly.vertices[i0 * 3 + 2]!;
    const nx = face.normal[0];
    const ny = face.normal[1];
    const nz = face.normal[2];

    const hFace = v0x * nx + v0y * ny + v0z * nz;
    const projP = px * nx + py * ny + pz * nz;

    if (projP > 1e-12 && hFace > 0) {
      const allowed = keepFactor * hFace;
      if (projP > allowed) {
        const ratio = allowed / projP;
        if (ratio < tMax) {
          tMax = ratio;
        }
      }
    } else if (hFace <= 0) {
      return [0, 0, 0];
    }
  }

  tMax = Math.max(0, Math.min(1, tMax));
  return [cleanZero(px * tMax), cleanZero(py * tMax), cleanZero(pz * tMax)];
}

/**
 * Проверяет водонепроницаемость (V - E + F === 2, взаимная спаренность всех полурёбер),
 * выпуклость и строгий обход всех граней против часовой стрелки снаружи (CCW outward).
 */
export function validateWatertightConvexPolyhedron(
  poly: ConvexPolyhedron3DData,
): { valid: boolean; euler: number; reason?: string } {
  if (poly.vertices.length % 3 !== 0) {
    return { valid: false, euler: 0, reason: 'Длина массива vertices не кратна 3' };
  }
  const V = poly.vertices.length / 3;
  const F = poly.faces.length;
  if (V < 4 || F < 4) {
    return { valid: false, euler: V - F, reason: `Недостаточно вершин (${V}) или граней (${F})` };
  }
  if (!Number.isFinite(poly.volumeM3) || poly.volumeM3 <= 0) {
    return { valid: false, euler: 0, reason: `Неположительный объём: ${poly.volumeM3}` };
  }

  for (let i = 0; i < poly.vertices.length; i++) {
    if (!Number.isFinite(poly.vertices[i]!)) {
      return { valid: false, euler: 0, reason: 'Обнаружена NaN/Infinity координата вершины' };
    }
  }

  const usedVerts = new Uint8Array(V);
  const halfEdges = new Set<number>();
  if (scratchInFaceMarks.length < V) {
    scratchInFaceMarks = new Int32Array(Math.max(V * 2, 256));
  }
  const inFaceMarks = scratchInFaceMarks;
  inFaceMarks.fill(-1, 0, V);

  for (let f = 0; f < F; f++) {
    const face = poly.faces[f]!;
    const m = face.indices.length;
    if (m < 3) {
      return { valid: false, euler: 0, reason: `Грань ${f} имеет меньше 3 вершин` };
    }
    for (let k = 0; k < m; k++) {
      const u = face.indices[k]!;
      const v = face.indices[(k + 1) % m]!;
      if (!Number.isInteger(u) || u < 0 || u >= V) {
        return { valid: false, euler: 0, reason: `Индекс вершины ${u} вне диапазона [0, ${V})` };
      }
      if (!Number.isInteger(v) || v < 0 || v >= V) {
        return { valid: false, euler: 0, reason: `Индекс вершины ${v} вне диапазона [0, ${V})` };
      }
      if (inFaceMarks[u] === f) {
        return { valid: false, euler: 0, reason: `Повтор вершины ${u} внутри грани ${f}` };
      }
      inFaceMarks[u] = f;
      usedVerts[u] = 1;

      const key = u * V + v;
      if (halfEdges.has(key)) {
        return { valid: false, euler: 0, reason: `Дублирование ориентированного полуребра ${u}:${v}` };
      }
      halfEdges.add(key);
    }
  }

  for (let i = 0; i < V; i++) {
    if (usedVerts[i] === 0) {
      return { valid: false, euler: 0, reason: `Неиспользуемая висячая вершина ${i}` };
    }
  }

  for (const key of halfEdges) {
    const u = Math.floor(key / V);
    const v = key - u * V;
    if (!halfEdges.has(v * V + u)) {
      return {
        valid: false,
        euler: V - Math.floor(halfEdges.size / 2) + F,
        reason: `Неспаренное граничное полуребро ${u}:${v} (щель в оболочке)`,
      };
    }
  }

  const E = halfEdges.size / 2;
  const euler = V - E + F;
  if (euler !== 2) {
    return {
      valid: false,
      euler,
      reason: `Нарушена характеристика Эйлера: V(${V}) - E(${E}) + F(${F}) = ${euler} !== 2`,
    };
  }

  // Проверка обхода CCW снаружи и выпуклости по каждой грани
  for (let f = 0; f < F; f++) {
    const face = poly.faces[f]!;
    const n = vec3Normalize(face.normal, [0, 1, 0]);
    const i0 = face.indices[0]!;
    const v0: Vec3 = [
      poly.vertices[i0 * 3]!,
      poly.vertices[i0 * 3 + 1]!,
      poly.vertices[i0 * 3 + 2]!,
    ];

    if (vec3Dot(v0, n) <= -1e-5) {
      return {
        valid: false,
        euler,
        reason: `Нормаль грани ${f} направлена внутрь центроида`,
      };
    }

    let areaVec: Vec3 = [0, 0, 0];
    for (let t = 1; t < face.indices.length - 1; t++) {
      const i1 = face.indices[t]!;
      const i2 = face.indices[t + 1]!;
      const v1: Vec3 = [
        poly.vertices[i1 * 3]!,
        poly.vertices[i1 * 3 + 1]!,
        poly.vertices[i1 * 3 + 2]!,
      ];
      const v2: Vec3 = [
        poly.vertices[i2 * 3]!,
        poly.vertices[i2 * 3 + 1]!,
        poly.vertices[i2 * 3 + 2]!,
      ];
      const cross = vec3Cross(vec3Sub(v1, v0), vec3Sub(v2, v0));
      areaVec = [areaVec[0] + cross[0], areaVec[1] + cross[1], areaVec[2] + cross[2]];
    }

    if (vec3Dot(areaVec, n) <= 0) {
      return {
        valid: false,
        euler,
        reason: `Обход вершин грани ${f} не является CCW относительно внешней нормали`,
      };
    }

    // Все вершины полиэдра лежат внутри полупространства грани (с учётом округления Float32)
    const maxScale = Math.max(
      1,
      poly.halfExtentsApprox[0],
      poly.halfExtentsApprox[1],
      poly.halfExtentsApprox[2],
    );
    const convexTol = 2e-4 * maxScale;
    for (let j = 0; j < V; j++) {
      const dx = poly.vertices[j * 3]! - v0[0];
      const dy = poly.vertices[j * 3 + 1]! - v0[1];
      const dz = poly.vertices[j * 3 + 2]! - v0[2];
      if (dx * n[0] + dy * n[1] + dz * n[2] > convexTol) {
        return {
          valid: false,
          euler,
          reason: `Нарушение выпуклости: вершина ${j} выступает за плоскость грани ${f}`,
        };
      }
    }
  }

  return { valid: true, euler };
}
