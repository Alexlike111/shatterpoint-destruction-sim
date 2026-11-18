import type { ConvexFace3D, QuatTuple, Vec3, Vec3Tuple } from './types';

/**
 * Чистая 3D-математика: векторы, кватернионы, OBB/SAT, теорема Остроградского—Гаусса
 * для объёма и центроида многогранника и спектральный анализ вытянутости Якоби 3×3.
 */

export function cleanZero(x: number): number {
  return x === 0 ? 0 : x;
}

export function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

export function vec3Add(a: Vec3Tuple, b: Vec3Tuple): Vec3 {
  return [cleanZero(a[0] + b[0]), cleanZero(a[1] + b[1]), cleanZero(a[2] + b[2])];
}

export function vec3Sub(a: Vec3Tuple, b: Vec3Tuple): Vec3 {
  return [cleanZero(a[0] - b[0]), cleanZero(a[1] - b[1]), cleanZero(a[2] - b[2])];
}

export function vec3Scale(a: Vec3Tuple, s: number): Vec3 {
  return [cleanZero(a[0] * s), cleanZero(a[1] * s), cleanZero(a[2] * s)];
}

export function vec3AddScaled(a: Vec3Tuple, b: Vec3Tuple, s: number): Vec3 {
  return [
    cleanZero(a[0] + b[0] * s),
    cleanZero(a[1] + b[1] * s),
    cleanZero(a[2] + b[2] * s),
  ];
}

export function vec3MulElem(a: Vec3Tuple, b: Vec3Tuple): Vec3 {
  return [cleanZero(a[0] * b[0]), cleanZero(a[1] * b[1]), cleanZero(a[2] * b[2])];
}

export function vec3DivElem(a: Vec3Tuple, b: Vec3Tuple): Vec3 {
  return [cleanZero(a[0] / b[0]), cleanZero(a[1] / b[1]), cleanZero(a[2] / b[2])];
}

export function vec3Dot(a: Vec3Tuple, b: Vec3Tuple): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function vec3Cross(a: Vec3Tuple, b: Vec3Tuple): Vec3 {
  return [
    cleanZero(a[1] * b[2] - a[2] * b[1]),
    cleanZero(a[2] * b[0] - a[0] * b[2]),
    cleanZero(a[0] * b[1] - a[1] * b[0]),
  ];
}

export function vec3LenSq(a: Vec3Tuple): number {
  return a[0] * a[0] + a[1] * a[1] + a[2] * a[2];
}

export function vec3Len(a: Vec3Tuple): number {
  return Math.hypot(a[0], a[1], a[2]);
}

export function vec3DistSq(a: Vec3Tuple, b: Vec3Tuple): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const dz = a[2] - b[2];
  return dx * dx + dy * dy + dz * dz;
}

export function vec3Dist(a: Vec3Tuple, b: Vec3Tuple): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

export function vec3Normalize(a: Vec3Tuple, fallback: Vec3Tuple = [0, 1, 0]): Vec3 {
  const lenSq = vec3LenSq(a);
  if (!Number.isFinite(lenSq) || lenSq < 1e-24) {
    return [cleanZero(fallback[0]), cleanZero(fallback[1]), cleanZero(fallback[2])];
  }
  const invLen = 1 / Math.sqrt(lenSq);
  return [cleanZero(a[0] * invLen), cleanZero(a[1] * invLen), cleanZero(a[2] * invLen)];
}

export function vec3Lerp(a: Vec3Tuple, b: Vec3Tuple, t: number): Vec3 {
  return [
    cleanZero(a[0] + (b[0] - a[0]) * t),
    cleanZero(a[1] + (b[1] - a[1]) * t),
    cleanZero(a[2] + (b[2] - a[2]) * t),
  ];
}

/**
 * Строит правый ортонормированный базис плоскости с нормалью n так, что u × v = +n.
 * Сортировка точек по atan2((p - c)·v, (p - c)·u) гарантирует обход CCW при взгляде со стороны +n.
 */
export function buildOrthonormalPlaneBasis(normal: Vec3Tuple): { n: Vec3; u: Vec3; v: Vec3 } {
  const n = vec3Normalize(normal, [0, 1, 0]);
  const ref: Vec3 = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const proj = vec3Dot(ref, n);
  const uRaw: Vec3 = [ref[0] - proj * n[0], ref[1] - proj * n[1], ref[2] - proj * n[2]];
  const u = vec3Normalize(uRaw, [1, 0, 0]);
  const v = vec3Normalize(vec3Cross(n, u), [0, 0, 1]);
  return { n, u, v };
}

// ============================================================================
// Кватернионы [x, y, z, w]
// ============================================================================

export function quatIdentity(): QuatTuple {
  return [0, 0, 0, 1];
}

export function quatNormalize(q: readonly [number, number, number, number]): QuatTuple {
  const lenSq = q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3];
  if (!Number.isFinite(lenSq) || lenSq < 1e-24) {
    return [0, 0, 0, 1];
  }
  const invLen = 1 / Math.sqrt(lenSq);
  return [
    cleanZero(q[0] * invLen),
    cleanZero(q[1] * invLen),
    cleanZero(q[2] * invLen),
    cleanZero(q[3] * invLen),
  ];
}

export function quatConjugate(q: readonly [number, number, number, number]): QuatTuple {
  return [cleanZero(-q[0]), cleanZero(-q[1]), cleanZero(-q[2]), cleanZero(q[3])];
}

export function quatMultiply(
  a: readonly [number, number, number, number],
  b: readonly [number, number, number, number],
): QuatTuple {
  const ax = a[0];
  const ay = a[1];
  const az = a[2];
  const aw = a[3];
  const bx = b[0];
  const by = b[1];
  const bz = b[2];
  const bw = b[3];

  return [
    cleanZero(aw * bx + ax * bw + ay * bz - az * by),
    cleanZero(aw * by - ax * bz + ay * bw + az * bx),
    cleanZero(aw * bz + ax * by - ay * bx + az * bw),
    cleanZero(aw * bw - ax * bx - ay * by - az * bz),
  ];
}

export function quatFromAxisAngle(axis: Vec3Tuple, angleRad: number): QuatTuple {
  const u = vec3Normalize(axis, [0, 1, 0]);
  const half = angleRad * 0.5;
  const s = Math.sin(half);
  const c = Math.cos(half);
  return quatNormalize([u[0] * s, u[1] * s, u[2] * s, c]);
}

export function quatRotateVec3(
  q: readonly [number, number, number, number],
  v: Vec3Tuple,
): Vec3 {
  const qn =
    Math.abs(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3] - 1) > 1e-6
      ? quatNormalize(q)
      : q;
  const qx = qn[0];
  const qy = qn[1];
  const qz = qn[2];
  const qw = qn[3];

  const vx = v[0];
  const vy = v[1];
  const vz = v[2];

  const tx = 2 * (qy * vz - qz * vy);
  const ty = 2 * (qz * vx - qx * vz);
  const tz = 2 * (qx * vy - qy * vx);

  return [
    cleanZero(vx + qw * tx + (qy * tz - qz * ty)),
    cleanZero(vy + qw * ty + (qz * tx - qx * tz)),
    cleanZero(vz + qw * tz + (qx * ty - qy * tx)),
  ];
}

export function quatInverseRotateVec3(
  q: readonly [number, number, number, number],
  v: Vec3Tuple,
): Vec3 {
  const qn =
    Math.abs(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3] - 1) > 1e-6
      ? quatNormalize(q)
      : q;
  const qx = qn[0];
  const qy = qn[1];
  const qz = qn[2];
  const qw = qn[3];

  const vx = v[0];
  const vy = v[1];
  const vz = v[2];

  const tx = 2 * (qy * vz - qz * vy);
  const ty = 2 * (qz * vx - qx * vz);
  const tz = 2 * (qx * vy - qy * vx);

  return [
    cleanZero(vx - qw * tx + (qy * tz - qz * ty)),
    cleanZero(vy - qw * ty + (qz * tx - qx * tz)),
    cleanZero(vz - qw * tz + (qx * ty - qy * tx)),
  ];
}

// ============================================================================
// OBB, AABB и 15-осевой SAT
// ============================================================================

export function computeObbWorldVertices(
  center: Vec3Tuple,
  halfExtents: Vec3Tuple,
  rotationQuat: readonly [number, number, number, number] = [0, 0, 0, 1],
): Vec3[] {
  const hx = halfExtents[0];
  const hy = halfExtents[1];
  const hz = halfExtents[2];
  const signs: readonly Vec3[] = [
    [-hx, -hy, -hz],
    [+hx, -hy, -hz],
    [+hx, +hy, -hz],
    [-hx, +hy, -hz],
    [-hx, -hy, +hz],
    [+hx, -hy, +hz],
    [+hx, +hy, +hz],
    [-hx, +hy, +hz],
  ];

  const result: Vec3[] = new Array(8);
  for (let i = 0; i < 8; i++) {
    const rotated = quatRotateVec3(rotationQuat, signs[i]!);
    result[i] = vec3Add(center, rotated);
  }
  return result;
}

export function computeAabbFromPoints(points: readonly Vec3Tuple[] | Float32Array): {
  min: Vec3;
  max: Vec3;
  halfExtents: Vec3;
  center: Vec3;
} {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;

  if (points instanceof Float32Array) {
    const count = Math.floor(points.length / 3);
    if (count === 0) {
      return { min: [0, 0, 0], max: [0, 0, 0], halfExtents: [0, 0, 0], center: [0, 0, 0] };
    }
    for (let i = 0; i < count; i++) {
      const x = points[i * 3]!;
      const y = points[i * 3 + 1]!;
      const z = points[i * 3 + 2]!;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (z < minZ) minZ = z;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (z > maxZ) maxZ = z;
    }
  } else {
    if (points.length === 0) {
      return { min: [0, 0, 0], max: [0, 0, 0], halfExtents: [0, 0, 0], center: [0, 0, 0] };
    }
    for (let i = 0; i < points.length; i++) {
      const p = points[i]!;
      const x = p[0];
      const y = p[1];
      const z = p[2];
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (z < minZ) minZ = z;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (z > maxZ) maxZ = z;
    }
  }

  return {
    min: [cleanZero(minX), cleanZero(minY), cleanZero(minZ)],
    max: [cleanZero(maxX), cleanZero(maxY), cleanZero(maxZ)],
    halfExtents: [
      cleanZero((maxX - minX) * 0.5),
      cleanZero((maxY - minY) * 0.5),
      cleanZero((maxZ - minZ) * 0.5),
    ],
    center: [
      cleanZero((minX + maxX) * 0.5),
      cleanZero((minY + maxY) * 0.5),
      cleanZero((minZ + maxZ) * 0.5),
    ],
  };
}

/**
 * Полный 15-осевой тест разделяющей оси (SAT) для двух ориентированных параллелепипедов (OBB).
 */
export function obbIntersectsObb(
  a: {
    center: Vec3Tuple;
    halfExtents: Vec3Tuple;
    rotationQuat?: readonly [number, number, number, number];
  },
  b: {
    center: Vec3Tuple;
    halfExtents: Vec3Tuple;
    rotationQuat?: readonly [number, number, number, number];
  },
  marginM = 0,
): boolean {
  const qa = a.rotationQuat ?? [0, 0, 0, 1];
  const qb = b.rotationQuat ?? [0, 0, 0, 1];

  const axesA: [Vec3, Vec3, Vec3] = [
    quatRotateVec3(qa, [1, 0, 0]),
    quatRotateVec3(qa, [0, 1, 0]),
    quatRotateVec3(qa, [0, 0, 1]),
  ];
  const axesB: [Vec3, Vec3, Vec3] = [
    quatRotateVec3(qb, [1, 0, 0]),
    quatRotateVec3(qb, [0, 1, 0]),
    quatRotateVec3(qb, [0, 0, 1]),
  ];

  const ea: [number, number, number] = [
    Math.max(0, a.halfExtents[0]),
    Math.max(0, a.halfExtents[1]),
    Math.max(0, a.halfExtents[2]),
  ];
  const eb: [number, number, number] = [
    Math.max(0, b.halfExtents[0]),
    Math.max(0, b.halfExtents[1]),
    Math.max(0, b.halfExtents[2]),
  ];

  const R: [[number, number, number], [number, number, number], [number, number, number]] = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  const AbsR: [[number, number, number], [number, number, number], [number, number, number]] = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];

  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      const rij = vec3Dot(axesA[i]!, axesB[j]!);
      R[i]![j] = rij;
      AbsR[i]![j] = Math.abs(rij) + 1e-9;
    }
  }

  const diff = vec3Sub(b.center, a.center);
  const t: [number, number, number] = [
    vec3Dot(diff, axesA[0]),
    vec3Dot(diff, axesA[1]),
    vec3Dot(diff, axesA[2]),
  ];

  // 1..3: Оси граней A
  for (let i = 0; i < 3; i++) {
    const ra = ea[i]!;
    const rb = eb[0] * AbsR[i]![0] + eb[1] * AbsR[i]![1] + eb[2] * AbsR[i]![2];
    if (Math.abs(t[i]!) > ra + rb + marginM) {
      return false;
    }
  }

  // 4..6: Оси граней B
  for (let j = 0; j < 3; j++) {
    const ra = ea[0] * AbsR[0][j]! + ea[1] * AbsR[1][j]! + ea[2] * AbsR[2][j]!;
    const rb = eb[j]!;
    const proj = Math.abs(t[0] * R[0][j]! + t[1] * R[1][j]! + t[2] * R[2][j]!);
    if (proj > ra + rb + marginM) {
      return false;
    }
  }

  // 7..15: Перекрёстные оси рёбер A_i × B_j
  for (let i = 0; i < 3; i++) {
    const i1 = (i + 1) % 3;
    const i2 = (i + 2) % 3;
    for (let j = 0; j < 3; j++) {
      const sinSq = 1 - R[i]![j]! * R[i]![j]!;
      if (sinSq <= 1e-12) {
        continue;
      }
      const sinLen = Math.sqrt(sinSq);
      const j1 = (j + 1) % 3;
      const j2 = (j + 2) % 3;
      const ra = ea[i1]! * AbsR[i2]![j]! + ea[i2]! * AbsR[i1]![j]!;
      const rb = eb[j1]! * AbsR[i]![j2]! + eb[j2]! * AbsR[i]![j1]!;
      const proj = Math.abs(t[i2]! * R[i1]![j]! - t[i1]! * R[i2]![j]!);
      if (proj > ra + rb + marginM * sinLen) {
        return false;
      }
    }
  }

  return true;
}

// ============================================================================
// Объём, центроид (Остроградский—Гаусс) и главные оси полиэдров (Якоби 3×3)
// ============================================================================

function unpackPoints64(points: Float32Array | readonly Vec3Tuple[]): number[] {
  if (points instanceof Float32Array) {
    const n = Math.floor(points.length / 3) * 3;
    const out = new Array<number>(n);
    for (let i = 0; i < n; i++) {
      out[i] = points[i]!;
    }
    return out;
  }
  const out = new Array<number>(points.length * 3);
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    out[i * 3] = p[0];
    out[i * 3 + 1] = p[1];
    out[i * 3 + 2] = p[2];
  }
  return out;
}

/**
 * Вычисляет объём и истинный объёмный центроид замкнутого полиэдра по теореме Остроградского—Гаусса.
 * Вычитает внутреннюю опорную точку p_ref перед суммированием тетраэдров, что полностью исключает
 * катастрофическую потерю точности на удалённых от (0,0,0) координатах.
 */
export function computePolyhedronVolumeAndCentroid(
  vertices: Float32Array | readonly Vec3Tuple[],
  faces: readonly Pick<ConvexFace3D, 'indices'>[],
): {
  volumeM3: number;
  signedVolumeM3: number;
  centroid: Vec3;
  halfExtentsApprox: Vec3;
} {
  const coords = unpackPoints64(vertices);
  const vertCount = Math.floor(coords.length / 3);
  if (vertCount === 0 || faces.length === 0) {
    return {
      volumeM3: 0,
      signedVolumeM3: 0,
      centroid: [0, 0, 0],
      halfExtentsApprox: [0, 0, 0],
    };
  }

  const usedMask = new Uint8Array(vertCount);
  let usedCount = 0;
  let refSumX = 0;
  let refSumY = 0;
  let refSumZ = 0;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;

  for (let f = 0; f < faces.length; f++) {
    const idxList = faces[f]!.indices;
    for (let k = 0; k < idxList.length; k++) {
      const idx = idxList[k]!;
      if (idx >= 0 && idx < vertCount && usedMask[idx] === 0) {
        usedMask[idx] = 1;
        usedCount++;
        const x = coords[idx * 3]!;
        const y = coords[idx * 3 + 1]!;
        const z = coords[idx * 3 + 2]!;
        refSumX += x;
        refSumY += y;
        refSumZ += z;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (z < minZ) minZ = z;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
        if (z > maxZ) maxZ = z;
      }
    }
  }

  if (usedCount === 0) {
    return {
      volumeM3: 0,
      signedVolumeM3: 0,
      centroid: [0, 0, 0],
      halfExtentsApprox: [0, 0, 0],
    };
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
    if (indices.length < 3) continue;

    const i0 = indices[0]!;
    const ax = coords[i0 * 3]! - pRefX;
    const ay = coords[i0 * 3 + 1]! - pRefY;
    const az = coords[i0 * 3 + 2]! - pRefZ;

    for (let t = 1; t < indices.length - 1; t++) {
      const i1 = indices[t]!;
      const i2 = indices[t + 1]!;

      const bx = coords[i1 * 3]! - pRefX;
      const by = coords[i1 * 3 + 1]! - pRefY;
      const bz = coords[i1 * 3 + 2]! - pRefZ;

      const cx = coords[i2 * 3]! - pRefX;
      const cy = coords[i2 * 3 + 1]! - pRefY;
      const cz = coords[i2 * 3 + 2]! - pRefZ;

      // D_T = a · (b × c) = 6 * V_T
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

  const signedVolumeM3 = sumD / 6;
  const volumeM3 = Math.abs(signedVolumeM3);

  let centroidX = pRefX;
  let centroidY = pRefY;
  let centroidZ = pRefZ;

  if (Math.abs(sumD) > 1e-18) {
    const invDenom = 1 / (4 * sumD); // 4 * sumD === 24 * signedVolumeM3
    centroidX += momX * invDenom;
    centroidY += momY * invDenom;
    centroidZ += momZ * invDenom;
  }

  return {
    volumeM3: cleanZero(volumeM3),
    signedVolumeM3: cleanZero(signedVolumeM3),
    centroid: [cleanZero(centroidX), cleanZero(centroidY), cleanZero(centroidZ)],
    halfExtentsApprox: [
      cleanZero((maxX - minX) * 0.5),
      cleanZero((maxY - minY) * 0.5),
      cleanZero((maxZ - minZ) * 0.5),
    ],
  };
}

/**
 * В плоскости с правым ортонормированным базисом (u0, v0) находит пару ортогональных осей (e1, e2),
 * минимизирующую площадь описывающего прямоугольника поперечного сечения (снимает вырождение квадратных сечений).
 */
function findTightTransverseAxes(
  coords: readonly number[],
  count: number,
  axis0: Vec3Tuple,
): {
  e1: Vec3;
  e2: Vec3;
  span1: number;
  span2: number;
} {
  const basis = buildOrthonormalPlaneBasis(axis0);
  const xs = new Float64Array(count);
  const ys = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    const px = coords[i * 3]!;
    const py = coords[i * 3 + 1]!;
    const pz = coords[i * 3 + 2]!;
    xs[i] = px * basis.u[0] + py * basis.u[1] + pz * basis.u[2];
    ys[i] = px * basis.v[0] + py * basis.v[1] + pz * basis.v[2];
  }

  const evalAngle = (theta: number): { area: number; span1: number; span2: number } => {
    const c = Math.cos(theta);
    const s = Math.sin(theta);
    let min1 = Number.POSITIVE_INFINITY;
    let max1 = Number.NEGATIVE_INFINITY;
    let min2 = Number.POSITIVE_INFINITY;
    let max2 = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < count; i++) {
      const x = xs[i]!;
      const y = ys[i]!;
      const p1 = x * c + y * s;
      const p2 = -x * s + y * c;
      if (p1 < min1) min1 = p1;
      if (p1 > max1) max1 = p1;
      if (p2 < min2) min2 = p2;
      if (p2 > max2) max2 = p2;
    }
    const span1 = Math.max(0, max1 - min1);
    const span2 = Math.max(0, max2 - min2);
    return { area: span1 * span2, span1, span2 };
  };

  const halfPi = Math.PI * 0.5;
  const gridSteps = 36;
  const stepRad = halfPi / gridSteps;
  let bestTheta = 0;
  let bestEval = evalAngle(0);

  for (let s = 1; s < gridSteps; s++) {
    const theta = s * stepRad;
    const cur = evalAngle(theta);
    if (cur.area < bestEval.area) {
      bestEval = cur;
      bestTheta = theta;
    }
  }

  // Уточнение минимума методом золотого сечения
  const invPhi = (Math.sqrt(5) - 1) * 0.5;
  let a = bestTheta - stepRad;
  let b = bestTheta + stepRad;
  let cPt = b - (b - a) * invPhi;
  let dPt = a + (b - a) * invPhi;
  let fc = evalAngle(cPt);
  let fd = evalAngle(dPt);

  for (let iter = 0; iter < 22; iter++) {
    if (fc.area <= fd.area) {
      b = dPt;
      dPt = cPt;
      fd = fc;
      cPt = b - (b - a) * invPhi;
      fc = evalAngle(cPt);
    } else {
      a = cPt;
      cPt = dPt;
      fc = fd;
      dPt = a + (b - a) * invPhi;
      fd = evalAngle(dPt);
    }
  }

  let finalTheta = (a + b) * 0.5;
  let finalEval = evalAngle(finalTheta);
  if (bestEval.area < finalEval.area) {
    finalTheta = bestTheta;
    finalEval = bestEval;
  }

  // Упорядочиваем поперечные оси так, чтобы span1 >= span2, сохраняя правую тройку (axis0, e1, e2)
  if (finalEval.span2 > finalEval.span1) {
    finalTheta += halfPi;
    finalEval = evalAngle(finalTheta);
  }

  const ct = Math.cos(finalTheta);
  const st = Math.sin(finalTheta);
  const e1 = vec3Normalize([
    basis.u[0] * ct + basis.v[0] * st,
    basis.u[1] * ct + basis.v[1] * st,
    basis.u[2] * ct + basis.v[2] * st,
  ]);
  const e2 = vec3Normalize(vec3Cross(basis.n, e1), [0, 0, 1]);

  return {
    e1,
    e2,
    span1: cleanZero(finalEval.span1),
    span2: cleanZero(finalEval.span2),
  };
}

/**
 * Вычисляет правую ортонормированную тройку главных осей протяжённости (e0, e1, e2)
 * и габаритные размахи (L0 >= L1 >= L2) облака 3D-точек методом вращений Якоби 3×3.
 */
export function computePrincipalAxes3D(points: Float32Array | readonly Vec3Tuple[]): {
  axes: [Vec3, Vec3, Vec3];
  spans: [number, number, number];
} {
  const coords = unpackPoints64(points);
  const count = Math.floor(coords.length / 3);
  if (count === 0) {
    return {
      axes: [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ],
      spans: [0, 0, 0],
    };
  }

  let meanX = 0;
  let meanY = 0;
  let meanZ = 0;
  for (let i = 0; i < count; i++) {
    meanX += coords[i * 3]!;
    meanY += coords[i * 3 + 1]!;
    meanZ += coords[i * 3 + 2]!;
  }
  meanX /= count;
  meanY /= count;
  meanZ /= count;

  let c00 = 0;
  let c01 = 0;
  let c02 = 0;
  let c11 = 0;
  let c12 = 0;
  let c22 = 0;

  for (let i = 0; i < count; i++) {
    const dx = coords[i * 3]! - meanX;
    const dy = coords[i * 3 + 1]! - meanY;
    const dz = coords[i * 3 + 2]! - meanZ;
    c00 += dx * dx;
    c01 += dx * dy;
    c02 += dx * dz;
    c11 += dy * dy;
    c12 += dy * dz;
    c22 += dz * dz;
  }

  const C = [
    [c00, c01, c02],
    [c01, c11, c12],
    [c02, c12, c22],
  ];
  const V = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];

  // Итерации вращений Якоби для симметричной матрицы 3×3
  for (let iter = 0; iter < 15; iter++) {
    let p = 0;
    let q = 1;
    let maxOff = Math.abs(C[0]![1]!);
    if (Math.abs(C[0]![2]!) > maxOff) {
      maxOff = Math.abs(C[0]![2]!);
      p = 0;
      q = 2;
    }
    if (Math.abs(C[1]![2]!) > maxOff) {
      maxOff = Math.abs(C[1]![2]!);
      p = 1;
      q = 2;
    }
    if (maxOff <= 1e-15) {
      break;
    }

    const cpp = C[p]![p]!;
    const cqq = C[q]![q]!;
    const cpq = C[p]![q]!;
    const tau = (cqq - cpp) / (2 * cpq);
    const t = tau >= 0 ? 1 / (tau + Math.sqrt(1 + tau * tau)) : -1 / (-tau + Math.sqrt(1 + tau * tau));
    const c = 1 / Math.sqrt(1 + t * t);
    const s = t * c;

    C[p]![p] = cpp - t * cpq;
    C[q]![q] = cqq + t * cpq;
    C[p]![q] = 0;
    C[q]![p] = 0;

    const r = 3 - p - q;
    const crp = C[r]![p]!;
    const crq = C[r]![q]!;
    C[r]![p] = c * crp - s * crq;
    C[p]![r] = C[r]![p]!;
    C[r]![q] = s * crp + c * crq;
    C[q]![r] = C[r]![q]!;

    for (let k = 0; k < 3; k++) {
      const vkp = V[k]![p]!;
      const vkq = V[k]![q]!;
      V[k]![p] = c * vkp - s * vkq;
      V[k]![q] = s * vkp + c * vkq;
    }
  }

  const projectSpan = (axis: Vec3Tuple): number => {
    let minP = Number.POSITIVE_INFINITY;
    let maxP = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < count; i++) {
      const proj =
        coords[i * 3]! * axis[0] + coords[i * 3 + 1]! * axis[1] + coords[i * 3 + 2]! * axis[2];
      if (proj < minP) minP = proj;
      if (proj > maxP) maxP = proj;
    }
    return cleanZero(Math.max(0, maxP - minP));
  };

  // Выбираем собственный вектор наибольшей дисперсии (при вырождении — наибольшего размаха) как e0
  const candidates: Array<{ axis: Vec3; span: number; eig: number }> = [];
  for (let col = 0; col < 3; col++) {
    const ax = vec3Normalize(
      [V[0]![col]!, V[1]![col]!, V[2]![col]!],
      col === 0 ? [1, 0, 0] : col === 1 ? [0, 1, 0] : [0, 0, 1],
    );
    candidates.push({
      axis: ax,
      span: projectSpan(ax),
      eig: C[col]![col]!,
    });
  }

  candidates.sort((a, b) => {
    if (Math.abs(b.eig - a.eig) > 1e-9 * Math.max(1, a.eig, b.eig)) {
      return b.eig - a.eig;
    }
    return b.span - a.span;
  });

  const e0 = candidates[0]!.axis;
  const span0 = candidates[0]!.span;
  const transverse = findTightTransverseAxes(coords, count, e0);

  // Если сечение оказалось шире выбранной оси (например, у сплюснутой плиты), пересортируем по размаху
  const finalAxes: Array<{ axis: Vec3; span: number }> = [
    { axis: e0, span: span0 },
    { axis: transverse.e1, span: transverse.span1 },
    { axis: transverse.e2, span: transverse.span2 },
  ];
  finalAxes.sort((a, b) => b.span - a.span);

  const outE0 = finalAxes[0]!.axis;
  const e1Proj = vec3Dot(finalAxes[1]!.axis, outE0);
  const outE1 = vec3Normalize(vec3AddScaled(finalAxes[1]!.axis, outE0, -e1Proj), [0, 1, 0]);
  const outE2 = vec3Normalize(vec3Cross(outE0, outE1), [0, 0, 1]);

  return {
    axes: [outE0, outE1, outE2],
    spans: [projectSpan(outE0), projectSpan(outE1), projectSpan(outE2)],
  };
}

/**
 * Оценивает главную ось и коэффициенты анизотропной вытянутости облака вершин многогранника.
 */
export function computePrincipalStretch3D(
  points: Float32Array | readonly Vec3Tuple[],
  referenceAxis?: Vec3Tuple,
): {
  majorAxis: Vec3;
  elongationRatio: number;
  axisSpanRatio: number;
} {
  const { axes, spans } = computePrincipalAxes3D(points);
  const elongationRatio = spans[0] / Math.max(1e-6, spans[1]);

  if (!referenceAxis) {
    const meanTransverse = 0.5 * (spans[1] + spans[2]);
    return {
      majorAxis: axes[0],
      elongationRatio: cleanZero(elongationRatio),
      axisSpanRatio: cleanZero(spans[0] / Math.max(1e-6, meanTransverse)),
    };
  }

  const coords = unpackPoints64(points);
  const count = Math.floor(coords.length / 3);
  if (count === 0) {
    return {
      majorAxis: axes[0],
      elongationRatio: 0,
      axisSpanRatio: 0,
    };
  }

  const refNorm = vec3Normalize(referenceAxis, [1, 0, 0]);
  let minRef = Number.POSITIVE_INFINITY;
  let maxRef = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < count; i++) {
    const proj =
      coords[i * 3]! * refNorm[0] +
      coords[i * 3 + 1]! * refNorm[1] +
      coords[i * 3 + 2]! * refNorm[2];
    if (proj < minRef) minRef = proj;
    if (proj > maxRef) maxRef = proj;
  }
  const spanAlongRef = Math.max(0, maxRef - minRef);
  const tightTransverse = findTightTransverseAxes(coords, count, refNorm);
  const meanTransverseSpan = 0.5 * (tightTransverse.span1 + tightTransverse.span2);

  return {
    majorAxis: axes[0],
    elongationRatio: cleanZero(elongationRatio),
    axisSpanRatio: cleanZero(spanAlongRef / Math.max(1e-6, meanTransverseSpan)),
  };
}
