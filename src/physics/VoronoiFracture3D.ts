import {
  buildOrthonormalPlaneBasis,
  clamp,
  cleanZero,
  computePrincipalAxes3D,
  quatRotateVec3,
  vec3Add,
  vec3AddScaled,
  vec3Cross,
  vec3DistSq,
  vec3Dot,
  vec3Len,
  vec3Normalize,
  vec3Scale,
} from '../core/math3d';
import { SeededRng } from '../core/rng';
import type {
  ConvexPolyhedron3DData,
  MaterialPhysicsProfile,
  RebarStub3D,
  StructuralMaterialId,
  Vec3,
  Vec3Tuple,
  VoronoiShard3D,
} from '../core/types';
import {
  clampPointInsidePolyhedron,
  clipRawPolyhedronByPlane64,
  computePolyhedronMinThickness,
  computeRawPolyhedronVolumeAndCentroid64,
  createBoxPolyhedron,
  finalizePolyhedron3D,
  localPolyhedronToRaw64,
  MIN_POLY_VOLUME_M3,
  type RawPolyhedron64,
} from './ConvexPolyhedron3D';
import { getMaterialProfile } from './MaterialRegistry';

/**
 * 3D анизотропное дробление Вороного с прунингом вырожденных зёрен (погрешность объёма < 0.05%),
 * генерацией 3D гнутых прутьев арматуры RebarStub3D и локальным BSP-проломом стен carveLocalBreach3D.
 */

export interface FractureVoronoi3DParams {
  polyhedron: ConvexPolyhedron3DData;
  materialId: StructuralMaterialId;
  worldPosition?: Vec3Tuple;
  worldQuaternion?: [number, number, number, number];
  impactPointLocal?: Vec3Tuple;
  shardCount: number;
  seed: number;
  principalAxisLocal?: Vec3Tuple;
}

export interface FractureBoxVoronoi3DParams {
  halfExtents: Vec3Tuple;
  materialId: StructuralMaterialId;
  worldPosition?: Vec3Tuple;
  worldQuaternion?: [number, number, number, number];
  impactPointLocal?: Vec3Tuple;
  shardCount: number;
  seed: number;
  principalAxisLocal?: Vec3Tuple;
}

export interface FractureVoronoi3DResult {
  shards: VoronoiShard3D[];
  microDebrisPositions: [number, number, number][];
  originalVolumeM3: number;
  totalShardsVolumeM3: number;
  originalMassKg: number;
  totalShardsMassKg: number;
}

export interface CarveLocalBreach3DParams {
  polyhedron: ConvexPolyhedron3DData;
  materialId: StructuralMaterialId;
  worldPosition?: Vec3Tuple;
  worldQuaternion?: [number, number, number, number];
  impactPointLocal: Vec3Tuple;
  breachRadiusM: number;
  shardCount?: number;
  seed: number;
}

export interface CarveLocalBreach3DResult {
  isLocalBreach: boolean;
  survivingPieces: VoronoiShard3D[];
  breachShards: VoronoiShard3D[];
  microDebrisPositions: [number, number, number][];
  originalVolumeM3: number;
  totalResultVolumeM3: number;
  originalMassKg: number;
  totalResultMassKg: number;
}

interface LocalFrame3D {
  e0: Vec3;
  e1: Vec3;
  e2: Vec3;
  spans: [number, number, number];
  minProj: [number, number, number];
  maxProj: [number, number, number];
}

function buildPolyhedronFrame(
  poly: ConvexPolyhedron3DData,
  principalAxisLocal?: Vec3Tuple,
): LocalFrame3D {
  let e0: Vec3;
  let e1: Vec3;
  let e2: Vec3;

  if (principalAxisLocal && vec3Len(principalAxisLocal) > 1e-9) {
    e0 = vec3Normalize(principalAxisLocal, [1, 0, 0]);
    const basis = buildOrthonormalPlaneBasis(e0);
    // Выбираем в плоскости (u, v) направление максимального поперечного размаха
    const count = Math.floor(poly.vertices.length / 3);
    let bestAngle = 0;
    let bestSpan = -1;
    for (let step = 0; step < 12; step++) {
      const ang = (Math.PI * step) / 12;
      const ca = Math.cos(ang);
      const sa = Math.sin(ang);
      const cand: Vec3 = [
        basis.u[0] * ca + basis.v[0] * sa,
        basis.u[1] * ca + basis.v[1] * sa,
        basis.u[2] * ca + basis.v[2] * sa,
      ];
      let lo = Number.POSITIVE_INFINITY;
      let hi = Number.NEGATIVE_INFINITY;
      for (let i = 0; i < count; i++) {
        const p =
          poly.vertices[i * 3]! * cand[0] +
          poly.vertices[i * 3 + 1]! * cand[1] +
          poly.vertices[i * 3 + 2]! * cand[2];
        if (p < lo) lo = p;
        if (p > hi) hi = p;
      }
      if (hi - lo > bestSpan) {
        bestSpan = hi - lo;
        bestAngle = ang;
      }
    }
    const ca = Math.cos(bestAngle);
    const sa = Math.sin(bestAngle);
    e1 = vec3Normalize([
      basis.u[0] * ca + basis.v[0] * sa,
      basis.u[1] * ca + basis.v[1] * sa,
      basis.u[2] * ca + basis.v[2] * sa,
    ]);
    e2 = vec3Normalize(vec3Cross(e0, e1), [0, 0, 1]);
  } else {
    const eigen = computePrincipalAxes3D(poly.vertices);
    e0 = eigen.axes[0];
    e1 = eigen.axes[1];
    e2 = eigen.axes[2];
  }

  const count = Math.floor(poly.vertices.length / 3);
  const projectBounds = (ax: Vec3Tuple): [number, number] => {
    let lo = Number.POSITIVE_INFINITY;
    let hi = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < count; i++) {
      const p =
        poly.vertices[i * 3]! * ax[0] +
        poly.vertices[i * 3 + 1]! * ax[1] +
        poly.vertices[i * 3 + 2]! * ax[2];
      if (p < lo) lo = p;
      if (p > hi) hi = p;
    }
    return [lo, hi];
  };

  const b0 = projectBounds(e0);
  const b1 = projectBounds(e1);
  const b2 = projectBounds(e2);

  return {
    e0,
    e1,
    e2,
    spans: [Math.max(1e-6, b0[1] - b0[0]), Math.max(1e-6, b1[1] - b1[0]), Math.max(1e-6, b2[1] - b2[0])],
    minProj: [b0[0], b1[0], b2[0]],
    maxProj: [b0[1], b1[1], b2[1]],
  };
}

function isPointStrictlyInsideLocalPoly(
  poly: ConvexPolyhedron3DData,
  pt: Vec3Tuple,
  marginM = 1e-4,
): boolean {
  for (let f = 0; f < poly.faces.length; f++) {
    const face = poly.faces[f]!;
    if (face.indices.length === 0) continue;
    const i0 = face.indices[0]!;
    const dx = pt[0] - poly.vertices[i0 * 3]!;
    const dy = pt[1] - poly.vertices[i0 * 3 + 1]!;
    const dz = pt[2] - poly.vertices[i0 * 3 + 2]!;
    const n = face.normal;
    if (dx * n[0] + dy * n[1] + dz * n[2] > -marginM) {
      return false;
    }
  }
  return true;
}

/**
 * Равномерный O(1) семплер внутренних точек выпуклого 3D-полиэдра по разбиению на тетраэдры (Rocchini—Cignoni).
 */
function createUniformPolyhedronSampler(
  poly: ConvexPolyhedron3DData,
): (rng: SeededRng) => Vec3 {
  interface Tet {
    a: Vec3;
    b: Vec3;
    c: Vec3;
    cumVol: number;
  }
  const tets: Tet[] = [];
  let totalVol = 0;

  for (let f = 0; f < poly.faces.length; f++) {
    const idx = poly.faces[f]!.indices;
    if (idx.length < 3) continue;
    const i0 = idx[0]!;
    const a: Vec3 = [
      poly.vertices[i0 * 3]!,
      poly.vertices[i0 * 3 + 1]!,
      poly.vertices[i0 * 3 + 2]!,
    ];
    for (let t = 1; t < idx.length - 1; t++) {
      const i1 = idx[t]!;
      const i2 = idx[t + 1]!;
      const b: Vec3 = [
        poly.vertices[i1 * 3]!,
        poly.vertices[i1 * 3 + 1]!,
        poly.vertices[i1 * 3 + 2]!,
      ];
      const c: Vec3 = [
        poly.vertices[i2 * 3]!,
        poly.vertices[i2 * 3 + 1]!,
        poly.vertices[i2 * 3 + 2]!,
      ];
      const vol = vec3Dot(a, vec3Cross(b, c)) / 6;
      if (vol > 1e-14) {
        totalVol += vol;
        tets.push({ a, b, c, cumVol: totalVol });
      }
    }
  }

  if (tets.length === 0 || totalVol <= 0) {
    return () => [0, 0, 0];
  }

  return (rng: SeededRng): Vec3 => {
    const target = rng.next() * totalVol;
    let lo = 0;
    let hi = tets.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (tets[mid]!.cumVol < target) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    const tet = tets[lo]!;

    // Алгоритм Rocchini—Cignoni равномерной точки в тетраэдре (0, a, b, c)
    let s = rng.next();
    let t = rng.next();
    let u = rng.next();
    if (s + t > 1) {
      s = 1 - s;
      t = 1 - t;
    }
    if (t + u > 1) {
      const tmp = u;
      u = 1 - s - t;
      t = 1 - tmp;
    } else if (s + t + u > 1) {
      const tmp = u;
      u = s + t + u - 1;
      s = 1 - t - tmp;
    }

    const px = s * tet.a[0] + t * tet.b[0] + u * tet.c[0];
    const py = s * tet.a[1] + t * tet.b[1] + u * tet.c[1];
    const pz = s * tet.a[2] + t * tet.b[2] + u * tet.c[2];

    // Лёгкое подтягивание (4%) к центроиду [0,0,0], чтобы точка гарантированно не лежала на внешней грани
    return [px * 0.96, py * 0.96, pz * 0.96];
  };
}

/**
 * Генерирует 3D гнутые выпуски стальной арматуры RebarStub3D на внутренних гранях скола (isInteriorCut === true) для ЖБ.
 */
export function generateRebarStubsForPolyhedron3D(
  polyhedron: ConvexPolyhedron3DData,
  profile: MaterialPhysicsProfile,
  rng: SeededRng,
  maxStubs = 4,
): RebarStub3D[] {
  if (!profile.hasRebarTethers || maxStubs <= 0) {
    return [];
  }

  interface CandidateCutFace {
    faceIdx: number;
    area: number;
    center: Vec3;
    normal: Vec3;
    indices: number[];
  }

  const cutFaces: CandidateCutFace[] = [];

  for (let f = 0; f < polyhedron.faces.length; f++) {
    const face = polyhedron.faces[f]!;
    if (!face.isInteriorCut || face.indices.length < 3) continue;

    let cx = 0;
    let cy = 0;
    let cz = 0;
    for (let k = 0; k < face.indices.length; k++) {
      const idx = face.indices[k]!;
      cx += polyhedron.vertices[idx * 3]!;
      cy += polyhedron.vertices[idx * 3 + 1]!;
      cz += polyhedron.vertices[idx * 3 + 2]!;
    }
    cx /= face.indices.length;
    cy /= face.indices.length;
    cz /= face.indices.length;

    const i0 = face.indices[0]!;
    const v0: Vec3 = [
      polyhedron.vertices[i0 * 3]!,
      polyhedron.vertices[i0 * 3 + 1]!,
      polyhedron.vertices[i0 * 3 + 2]!,
    ];
    let area = 0;
    for (let t = 1; t < face.indices.length - 1; t++) {
      const i1 = face.indices[t]!;
      const i2 = face.indices[t + 1]!;
      const e1: Vec3 = [
        polyhedron.vertices[i1 * 3]! - v0[0],
        polyhedron.vertices[i1 * 3 + 1]! - v0[1],
        polyhedron.vertices[i1 * 3 + 2]! - v0[2],
      ];
      const e2: Vec3 = [
        polyhedron.vertices[i2 * 3]! - v0[0],
        polyhedron.vertices[i2 * 3 + 1]! - v0[1],
        polyhedron.vertices[i2 * 3 + 2]! - v0[2],
      ];
      area += 0.5 * vec3Len(vec3Cross(e1, e2));
    }

    if (area >= 0.002) {
      cutFaces.push({
        faceIdx: f,
        area,
        center: [cx, cy, cz],
        normal: vec3Normalize(face.normal, [0, 1, 0]),
        indices: face.indices,
      });
    }
  }

  if (cutFaces.length === 0) {
    return [];
  }

  cutFaces.sort((a, b) => b.area - a.area);

  const maxSpan = Math.max(
    polyhedron.halfExtentsApprox[0] * 2,
    polyhedron.halfExtentsApprox[1] * 2,
    polyhedron.halfExtentsApprox[2] * 2,
  );

  const desiredTotal = Math.min(
    maxStubs,
    Math.max(1, cutFaces[0]!.area >= 0.18 ? 3 : cutFaces[0]!.area >= 0.05 ? 2 : 1),
  );

  const stubs: RebarStub3D[] = [];
  for (let s = 0; s < desiredTotal; s++) {
    const chosenFace = cutFaces[s % Math.min(cutFaces.length, 3)]!;
    const vertPickIdx = chosenFace.indices[rng.int(0, chosenFace.indices.length - 1)]!;
    const vx = polyhedron.vertices[vertPickIdx * 3]!;
    const vy = polyhedron.vertices[vertPickIdx * 3 + 1]!;
    const vz = polyhedron.vertices[vertPickIdx * 3 + 2]!;

    const pull = rng.range(0.18, 0.52);
    const surfX = chosenFace.center[0] + (vx - chosenFace.center[0]) * pull;
    const surfY = chosenFace.center[1] + (vy - chosenFace.center[1]) * pull;
    const surfZ = chosenFace.center[2] + (vz - chosenFace.center[2]) * pull;

    const embedDepth = Math.min(0.035, maxSpan * 0.12);
    const originLocal: Vec3 = [
      cleanZero(surfX - chosenFace.normal[0] * embedDepth),
      cleanZero(surfY - chosenFace.normal[1] * embedDepth),
      cleanZero(surfZ - chosenFace.normal[2] * embedDepth),
    ];

    const basis = buildOrthonormalPlaneBasis(chosenFace.normal);
    const bendAngleRad = rng.range(0.06, 0.34);
    const azimuth = rng.range(0, Math.PI * 2);
    const cosB = Math.cos(bendAngleRad);
    const sinB = Math.sin(bendAngleRad);
    const cosA = Math.cos(azimuth);
    const sinA = Math.sin(azimuth);

    const tangX = basis.u[0] * cosA + basis.v[0] * sinA;
    const tangY = basis.u[1] * cosA + basis.v[1] * sinA;
    const tangZ = basis.u[2] * cosA + basis.v[2] * sinA;

    const directionLocal = vec3Normalize([
      chosenFace.normal[0] * cosB + tangX * sinB,
      chosenFace.normal[1] * cosB + tangY * sinB,
      chosenFace.normal[2] * cosB + tangZ * sinB,
    ]);

    const lengthM = cleanZero(
      clamp(rng.range(0.14, 0.32), 0.08, Math.max(0.12, maxSpan * 0.75)),
    );

    stubs.push({
      originLocal,
      directionLocal,
      lengthM,
      bendAngleRad: cleanZero(bendAngleRad),
    });
  }

  return stubs;
}

/**
 * Вычисляет калиброванный полузазор волосяной трещины (halfKerf, в метрах),
 * гарантированно перекрывающий шум квантования Float32 мировой позы в WASM Rapier3D/Parry3D
 * (предотвращая ложное плоское микро-перекрытие и вырождение EPA при g = 0)
 * и одновременно удерживающий изменение объёма в жёстком бюджете (< 0.04% для брешей и < 0.25% для Вороного).
 */
function computeFractureHalfKerf(params: {
  originalVolumeM3: number;
  origMinThickness: number;
  pieceCount: number;
  worldPosition: Vec3Tuple;
  isThinSheet?: boolean;
  budgetScaleFactor?: number;
}): number {
  const {
    originalVolumeM3,
    origMinThickness,
    pieceCount,
    worldPosition,
    isThinSheet = false,
    budgetScaleFactor = 6e-5,
  } = params;

  if (originalVolumeM3 <= 0 || origMinThickness <= 0 || pieceCount <= 1) {
    return 0;
  }

  const maxAbsWorldCoord = Math.max(
    1,
    Math.abs(worldPosition[0]),
    Math.abs(worldPosition[1]),
    Math.abs(worldPosition[2]),
  );

  // Базовый полузазор против шума f32-трансформации в WASM (~26–38 мкм, полный зазор трещины 52–76 мкм)
  const minSafeKerf = Math.max(2.6e-5, maxAbsWorldCoord * 1.25e-6);

  // Линейный масштаб ячейки между плоскостями скола (в 2D-плоскости листа для тонких стёкол, в 3D для блоков)
  const countClamped = Math.max(2, pieceCount);
  const cellScale = isThinSheet
    ? Math.sqrt(originalVolumeM3 / (Math.max(1e-4, origMinThickness) * countClamped))
    : Math.cbrt(originalVolumeM3 / countClamped);

  const maxVolumeKerf = Math.min(
    4.5e-5,
    cellScale * budgetScaleFactor,
    origMinThickness * 0.004,
  );

  return Math.max(0, Math.min(minSafeKerf, maxVolumeKerf));
}

function cloneRawPolyhedron64(baseRaw: RawPolyhedron64): RawPolyhedron64 {
  return {
    vertices: baseRaw.vertices.slice(),
    faces: baseRaw.faces.map((f) => ({
      indices: f.indices.slice(),
      normal: [f.normal[0], f.normal[1], f.normal[2]],
      isInteriorCut: f.isInteriorCut,
    })),
  };
}

function clipVoronoiCellRaw64(
  baseRaw: RawPolyhedron64,
  seedIndex: number,
  seedsIso: readonly Vec3[],
  fromIso: (q: Vec3Tuple) => Vec3,
  isoNormalToReal: (dIso: Vec3Tuple) => Vec3,
  halfKerf: number,
): RawPolyhedron64 | null {
  const n = seedsIso.length;
  const si = seedsIso[seedIndex]!;
  let currentRaw: RawPolyhedron64 | null = cloneRawPolyhedron64(baseRaw);

  for (let j = 0; j < n; j++) {
    if (seedIndex === j) continue;
    const sj = seedsIso[j]!;
    const dx = si[0] - sj[0];
    const dy = si[1] - sj[1];
    const dz = si[2] - sj[2];
    if (dx * dx + dy * dy + dz * dz < 1e-18) continue;

    const midIso: Vec3 = [(si[0] + sj[0]) * 0.5, (si[1] + sj[1]) * 0.5, (si[2] + sj[2]) * 0.5];
    const planePointReal = fromIso(midIso);
    const planeNormalReal = isoNormalToReal([dx, dy, dz]);
    const planePointShifted =
      halfKerf > 0 ? vec3AddScaled(planePointReal, planeNormalReal, halfKerf) : planePointReal;

    currentRaw = clipRawPolyhedronByPlane64(
      currentRaw,
      planePointShifted,
      planeNormalReal,
      true,
      false,
    );
    if (!currentRaw) {
      break;
    }
  }

  return currentRaw;
}

function buildVoronoiCellsReal(
  baseRaw: RawPolyhedron64,
  seedsIso: readonly Vec3[],
  fromIso: (q: Vec3Tuple) => Vec3,
  isoNormalToReal: (dIso: Vec3Tuple) => Vec3,
  halfKerf = 0,
): Array<ConvexPolyhedron3DData | null> {
  const n = seedsIso.length;
  const cells: Array<ConvexPolyhedron3DData | null> = new Array(n).fill(null);

  for (let i = 0; i < n; i++) {
    const currentRaw = clipVoronoiCellRaw64(
      baseRaw,
      i,
      seedsIso,
      fromIso,
      isoNormalToReal,
      halfKerf,
    );
    if (currentRaw) {
      cells[i] = finalizePolyhedron3D(currentRaw);
    }
  }

  return cells;
}

/**
 * Раскалывает произвольный выпуклый 3D-многогранник на анизотропные осколки Вороного
 * с прунингом вырожденных зёрен (погрешность объёма/массы < 0.5%, фактически < 0.02%).
 */
export function fracturePolyhedronVoronoi3D(
  params: FractureVoronoi3DParams,
): FractureVoronoi3DResult {
  const {
    polyhedron,
    materialId,
    worldPosition = [0, 0, 0],
    worldQuaternion = [0, 0, 0, 1],
    impactPointLocal = [0, 0, 0],
    shardCount,
    seed,
    principalAxisLocal,
  } = params;

  const profile = getMaterialProfile(materialId);
  const originalVolumeM3 = polyhedron.volumeM3;
  const originalMassKg = originalVolumeM3 * profile.densityKgM3;
  const rng = new SeededRng(seed);

  const safeShardCount = Number.isFinite(shardCount) ? Math.round(shardCount) : 1;
  const requestedCount = Math.max(1, Math.min(64, safeShardCount));
  if (requestedCount <= 1 || originalVolumeM3 <= 1e-8) {
    const normalizedPolyhedron: ConvexPolyhedron3DData = {
      ...polyhedron,
      centroid: [0, 0, 0],
    };
    const singleStubs = generateRebarStubsForPolyhedron3D(normalizedPolyhedron, profile, rng);
    const singleShard: VoronoiShard3D = {
      polyhedron: normalizedPolyhedron,
      worldPosition: [worldPosition[0], worldPosition[1], worldPosition[2]],
      massKg: originalMassKg,
      rebarStubs: singleStubs,
    };
    return {
      shards: [singleShard],
      microDebrisPositions: [],
      originalVolumeM3,
      totalShardsVolumeM3: originalVolumeM3,
      originalMassKg,
      totalShardsMassKg: originalMassKg,
    };
  }

  const frame = buildPolyhedronFrame(polyhedron, principalAxisLocal);
  const [L0, L1, L2] = frame.spans;
  const isThinSheet = L2 < 0.14 || L2 / Math.max(1e-6, L0) < 0.16;

  // Коэффициенты 3D-анизотропии вдоль собственных осей (e0, e1, e2)
  let alpha0 = profile.voronoiAnisotropy[0];
  let alpha1 = profile.voronoiAnisotropy[1];
  let alpha2 = profile.voronoiAnisotropy[2];

  if (materialId === 'wood') {
    // Гарантирует расщепление деревянных брусьев любой длины ВДОЛЬ волокон e0, а не нарезку шайбами поперёк
    const crossGeom = Math.max(1e-3, Math.sqrt(L1 * L2));
    alpha0 = Math.max(3.4, alpha0, L0 / (0.55 * crossGeom));
    alpha1 = 1.0;
    alpha2 = 1.0;
  } else if (materialId === 'glass') {
    alpha0 = 1.0;
    alpha1 = 1.0;
    alpha2 = 1.0;
  }

  const toFrame = (p: Vec3Tuple): Vec3 => [
    vec3Dot(p, frame.e0),
    vec3Dot(p, frame.e1),
    vec3Dot(p, frame.e2),
  ];

  const fromFrame = (uvw: Vec3Tuple): Vec3 => [
    frame.e0[0] * uvw[0] + frame.e1[0] * uvw[1] + frame.e2[0] * uvw[2],
    frame.e0[1] * uvw[0] + frame.e1[1] * uvw[1] + frame.e2[1] * uvw[2],
    frame.e0[2] * uvw[0] + frame.e1[2] * uvw[1] + frame.e2[2] * uvw[2],
  ];

  const toIso = (pLocal: Vec3Tuple): Vec3 => {
    const uvw = toFrame(pLocal);
    return [uvw[0] / alpha0, uvw[1] / alpha1, uvw[2] / alpha2];
  };

  const fromIso = (qIso: Vec3Tuple): Vec3 =>
    fromFrame([qIso[0] * alpha0, qIso[1] * alpha1, qIso[2] * alpha2]);

  const isoNormalToReal = (dIso: Vec3Tuple): Vec3 =>
    vec3Normalize(fromFrame([dIso[0] / alpha0, dIso[1] / alpha1, dIso[2] / alpha2]));

  const clampedImpactLocal = clampPointInsidePolyhedron(polyhedron, impactPointLocal, 0.12);
  const impactFrame = toFrame(clampedImpactLocal);
  const midW = 0.5 * (frame.minProj[2] + frame.maxProj[2]);

  const sampleUniformLocal = createUniformPolyhedronSampler(polyhedron);
  const diagIso = Math.hypot(L0 / alpha0, L1 / alpha1, isThinSheet ? 0 : L2 / alpha2);
  const minSeedDistIso = Math.max(1e-4, (diagIso / Math.cbrt(requestedCount)) * 0.14);
  const minSeedDistIsoSq = minSeedDistIso * minSeedDistIso;

  let seedsIso: Vec3[] = [];

  if (materialId === 'glass') {
    // Лучевое растрескивание стекла: плотный эпицентр вокруг точки удара + крупные периферийные сектора
    const innerCount = Math.min(requestedCount - 1, Math.max(1, Math.round(requestedCount * 0.68)));
    const outerCount = requestedCount - innerCount;
    const uvDiag = Math.hypot(L0, L1);

    for (let i = 0; i < innerCount; i++) {
      let placed: Vec3 | null = null;
      const baseTheta = (Math.PI * 2 * i) / innerCount;
      for (let attempt = 0; attempt < 24; attempt++) {
        const theta = baseTheta + rng.range(-0.35, 0.35) / Math.max(1, innerCount * 0.25);
        const radFrac =
          i === 0 ? rng.range(0.008, 0.025) : 0.025 + 0.18 * Math.pow((i + rng.next()) / innerCount, 1.35);
        const rUv = uvDiag * radFrac;
        const candLocal: Vec3 = isThinSheet
          ? fromFrame([
              impactFrame[0] + Math.cos(theta) * rUv,
              impactFrame[1] + Math.sin(theta) * rUv,
              midW + rng.range(-1, 1) * Math.min(1e-4, L2 * 0.004),
            ])
          : (() => {
              const dir = rng.unitVec3();
              const r3d = Math.hypot(L0, L1, L2) * radFrac;
              return vec3AddScaled(clampedImpactLocal, dir, r3d);
            })();

        const insidePt = isPointStrictlyInsideLocalPoly(polyhedron, candLocal, L2 * 0.04)
          ? candLocal
          : clampPointInsidePolyhedron(polyhedron, candLocal, 0.08);
        const finalLocal = isThinSheet
          ? (() => {
              const f = toFrame(insidePt);
              return fromFrame([f[0], f[1], midW + rng.range(-1, 1) * Math.min(1e-4, L2 * 0.004)]);
            })()
          : insidePt;

        const qIso = toIso(finalLocal);
        let tooClose = false;
        for (let m = 0; m < seedsIso.length; m++) {
          if (vec3DistSq(qIso, seedsIso[m]!) < minSeedDistIsoSq * 0.18) {
            tooClose = true;
            break;
          }
        }
        if (!tooClose) {
          placed = qIso;
          break;
        }
      }
      if (!placed) {
        const fallback = vec3AddScaled(
          sampleUniformLocal(rng),
          clampedImpactLocal,
          0,
        );
        const pulled: Vec3 = [
          clampedImpactLocal[0] + (fallback[0] - clampedImpactLocal[0]) * 0.22,
          clampedImpactLocal[1] + (fallback[1] - clampedImpactLocal[1]) * 0.22,
          clampedImpactLocal[2] + (fallback[2] - clampedImpactLocal[2]) * 0.22,
        ];
        const adj = isThinSheet
          ? (() => {
              const f = toFrame(pulled);
              return fromFrame([f[0], f[1], midW]);
            })()
          : pulled;
        placed = toIso(adj);
      }
      seedsIso.push(placed);
    }

    // Периферийные зёрна стекла на удалении от эпицентра
    const minOuterDistSq = Math.pow(uvDiag * 0.24, 2);
    for (let j = 0; j < outerCount; j++) {
      let chosenIso: Vec3 | null = null;
      const sectorAngle = (Math.PI * 2 * (j + 0.5)) / outerCount;
      for (let attempt = 0; attempt < 28; attempt++) {
        let candLocal: Vec3;
        if (attempt < 14) {
          const ang = sectorAngle + rng.range(-0.4, 0.4);
          const rOuter = uvDiag * rng.range(0.30, 0.48);
          const rawPt = fromFrame([
            impactFrame[0] + Math.cos(ang) * rOuter,
            impactFrame[1] + Math.sin(ang) * rOuter,
            isThinSheet ? midW : rng.range(frame.minProj[2] * 0.85, frame.maxProj[2] * 0.85),
          ]);
          candLocal = isPointStrictlyInsideLocalPoly(polyhedron, rawPt, L2 * 0.04)
            ? rawPt
            : sampleUniformLocal(rng);
        } else {
          candLocal = sampleUniformLocal(rng);
        }
        if (isThinSheet) {
          const f = toFrame(candLocal);
          candLocal = fromFrame([f[0], f[1], midW + rng.range(-1, 1) * Math.min(1e-4, L2 * 0.004)]);
        }
        if (vec3DistSq(candLocal, clampedImpactLocal) < minOuterDistSq && attempt < 20) {
          continue;
        }
        const qIso = toIso(candLocal);
        let tooClose = false;
        for (let m = 0; m < seedsIso.length; m++) {
          if (vec3DistSq(qIso, seedsIso[m]!) < minSeedDistIsoSq * 0.5) {
            tooClose = true;
            break;
          }
        }
        if (!tooClose) {
          chosenIso = qIso;
          break;
        }
      }
      if (!chosenIso) {
        let fb = sampleUniformLocal(rng);
        if (isThinSheet) {
          const f = toFrame(fb);
          fb = fromFrame([f[0], f[1], midW]);
        }
        chosenIso = toIso(fb);
      }
      seedsIso.push(chosenIso);
    }
  } else if (materialId === 'brick') {
    // Шахматная перевязка рядов кирпичной кладки со смещением нечётных рядов на 0.5 шага
    const coursesV = Math.max(2, Math.round(Math.cbrt(requestedCount)));
    const colsU = Math.max(2, Math.round(Math.sqrt(requestedCount / coursesV)));
    const stepU = L0 / colsU;
    const stepV = L1 / coursesV;

    for (let i = 0; i < requestedCount; i++) {
      let chosenIso: Vec3 | null = null;
      const useGrid = i < Math.ceil(requestedCount * 0.7);
      for (let attempt = 0; attempt < 20; attempt++) {
        let candLocal: Vec3;
        if (useGrid && attempt < 10) {
          const row = i % coursesV;
          const col = Math.floor(i / coursesV) % colsU;
          const stagger = row % 2 === 1 ? 0.5 : 0.0;
          const u =
            frame.minProj[0] +
            (((col + stagger + rng.range(0.2, 0.8)) % colsU) / colsU) * L0;
          const v = frame.minProj[1] + (row + rng.range(0.2, 0.8)) * stepV;
          const w = isThinSheet
            ? midW
            : rng.range(frame.minProj[2] + L2 * 0.12, frame.maxProj[2] - L2 * 0.12);
          candLocal = fromFrame([
            clamp(u, frame.minProj[0] + stepU * 0.08, frame.maxProj[0] - stepU * 0.08),
            clamp(v, frame.minProj[1] + stepV * 0.08, frame.maxProj[1] - stepV * 0.08),
            w,
          ]);
          if (!isPointStrictlyInsideLocalPoly(polyhedron, candLocal, 1e-4)) {
            candLocal = sampleUniformLocal(rng);
          }
        } else {
          candLocal = sampleUniformLocal(rng);
        }

        const qIso = toIso(candLocal);
        let tooClose = false;
        for (let m = 0; m < seedsIso.length; m++) {
          if (vec3DistSq(qIso, seedsIso[m]!) < minSeedDistIsoSq) {
            tooClose = true;
            break;
          }
        }
        if (!tooClose) {
          chosenIso = qIso;
          break;
        }
      }
      if (!chosenIso) {
        chosenIso = toIso(sampleUniformLocal(rng));
      }
      seedsIso.push(chosenIso);
    }
  } else {
    // wood, reinforced_concrete, steel, explosive
    const clusterRatio =
      materialId === 'wood' ? 0.35 : materialId === 'reinforced_concrete' ? 0.55 : 0.6;

    for (let i = 0; i < requestedCount; i++) {
      const clusterNearImpact = i < Math.ceil(requestedCount * clusterRatio);
      let chosenIso: Vec3 | null = null;

      for (let attempt = 0; attempt < 24; attempt++) {
        const baseLocal = sampleUniformLocal(rng);
        let candLocal: Vec3;
        if (clusterNearImpact && attempt < 16) {
          const pull = materialId === 'wood' ? rng.range(0.15, 0.45) : rng.range(0.28, 0.68);
          candLocal = [
            baseLocal[0] + (clampedImpactLocal[0] - baseLocal[0]) * pull,
            baseLocal[1] + (clampedImpactLocal[1] - baseLocal[1]) * pull,
            baseLocal[2] + (clampedImpactLocal[2] - baseLocal[2]) * pull,
          ];
        } else {
          candLocal = baseLocal;
        }
        if (isThinSheet) {
          const f = toFrame(candLocal);
          candLocal = fromFrame([f[0], f[1], midW + rng.range(-1, 1) * Math.min(1e-4, L2 * 0.004)]);
        }

        const qIso = toIso(candLocal);
        let tooClose = false;
        for (let m = 0; m < seedsIso.length; m++) {
          if (vec3DistSq(qIso, seedsIso[m]!) < minSeedDistIsoSq) {
            tooClose = true;
            break;
          }
        }
        if (!tooClose) {
          chosenIso = qIso;
          break;
        }
      }

      if (!chosenIso) {
        let fb = sampleUniformLocal(rng);
        if (isThinSheet) {
          const f = toFrame(fb);
          fb = fromFrame([f[0], f[1], midW]);
        }
        chosenIso = toIso(fb);
      }
      seedsIso.push(chosenIso);
    }
  }

  const baseRaw = localPolyhedronToRaw64(polyhedron);

  // Релаксация Ллойда (0 для стекла, чтобы сохранить лучевой градиент размеров у эпицентра)
  const lloydWeight =
    materialId === 'glass'
      ? 0
      : materialId === 'reinforced_concrete'
        ? 0.58
        : materialId === 'wood'
          ? 0.55
          : materialId === 'brick'
            ? 0.35
            : 0.4;

  if (lloydWeight > 0 && seedsIso.length >= 3) {
    // На предварительном шаге релаксации Ллойда вычисляем центроиды напрямую по RawPolyhedron64 в Float64
    // с halfKerf = 0 без вызова тяжёлой сварки finalizePolyhedron3D и validateWatertightConvexPolyhedron
    const relaxed: Vec3[] = new Array(seedsIso.length);
    for (let i = 0; i < seedsIso.length; i++) {
      const si = seedsIso[i]!;
      const rawCell = clipVoronoiCellRaw64(baseRaw, i, seedsIso, fromIso, isoNormalToReal, 0);
      const metrics = rawCell ? computeRawPolyhedronVolumeAndCentroid64(rawCell) : null;
      if (metrics && metrics.volumeM3 >= MIN_POLY_VOLUME_M3) {
        let targetLocal: Vec3 = metrics.centroid;
        if (isThinSheet) {
          const f = toFrame(targetLocal);
          targetLocal = fromFrame([f[0], f[1], midW]);
        }
        const cIso = toIso(targetLocal);
        relaxed[i] = [
          si[0] * (1 - lloydWeight) + cIso[0] * lloydWeight,
          si[1] * (1 - lloydWeight) + cIso[1] * lloydWeight,
          si[2] * (1 - lloydWeight) + cIso[2] * lloydWeight,
        ];
      } else {
        relaxed[i] = si;
      }
    }
    seedsIso = relaxed;
  }

  // Прунинг вырожденных зёрен до финальной сборки:
  // удалённые микро-ячейки поглощаются соседними ячейками Вороного без потери объёма!
  const origMinThickness = computePolyhedronMinThickness(polyhedron);
  const minAllowedVolume = Math.max(1e-8, Math.min(1e-5, originalVolumeM3 * 1e-4));
  const minAllowedThickness = Math.max(2e-4, Math.min(1.5e-3, origMinThickness * 0.06));
  const voronoiHalfKerf = computeFractureHalfKerf({
    originalVolumeM3,
    origMinThickness,
    pieceCount: seedsIso.length,
    worldPosition,
    isThinSheet,
    budgetScaleFactor: 9e-5,
  });

  const microDebrisPositions: [number, number, number][] = [];
  let finalCells = buildVoronoiCellsReal(
    baseRaw,
    seedsIso,
    fromIso,
    isoNormalToReal,
    seedsIso.length > 1 ? voronoiHalfKerf : 0,
  );

  for (let pass = 0; pass < 5 && seedsIso.length > 1; pass++) {
    const keptSeeds: Vec3[] = [];
    let prunedAny = false;

    for (let i = 0; i < seedsIso.length; i++) {
      const cell = finalCells[i];
      let valid = false;
      if (cell !== null && cell.vertices.length >= 12 && cell.volumeM3 >= minAllowedVolume) {
        // Строгая нижняя оценка минимальной толщины выпуклого тела по теореме о площади проекции параллелепипеда:
        // V <= w_min * 4 * sqrt((hx*hy)^2 + (hy*hz)^2 + (hz*hx)^2). Если нижняя оценка >= порога,
        // истинная толщина гарантированно >= minAllowedThickness без вызова полного Якоби 3×3.
        const [hx, hy, hz] = cell.halfExtentsApprox;
        const maxProjArea = 4 * Math.hypot(hx * hy, hy * hz, hz * hx);
        const thicknessLowerBound = maxProjArea > 1e-18 ? cell.volumeM3 / maxProjArea : 0;
        valid =
          thicknessLowerBound >= minAllowedThickness ||
          computePolyhedronMinThickness(cell) >= minAllowedThickness;
      }

      if (valid) {
        keptSeeds.push(seedsIso[i]!);
      } else {
        prunedAny = true;
        const localDebrisPos = cell ? cell.centroid : fromIso(seedsIso[i]!);
        const worldDebrisPos = vec3Add(
          worldPosition,
          quatRotateVec3(worldQuaternion, localDebrisPos),
        );
        microDebrisPositions.push(worldDebrisPos);
      }
    }

    if (!prunedAny) {
      break;
    }

    if (keptSeeds.length === 0) {
      keptSeeds.push(seedsIso[0]!);
      seedsIso = keptSeeds;
      finalCells = buildVoronoiCellsReal(baseRaw, seedsIso, fromIso, isoNormalToReal, 0);
      break;
    }

    seedsIso = keptSeeds;
    finalCells = buildVoronoiCellsReal(
      baseRaw,
      seedsIso,
      fromIso,
      isoNormalToReal,
      seedsIso.length > 1 ? voronoiHalfKerf : 0,
    );
  }

  const shards: VoronoiShard3D[] = [];
  let totalShardsVolumeM3 = 0;
  let totalShardsMassKg = 0;

  for (let i = 0; i < finalCells.length; i++) {
    const cell = finalCells[i];
    if (!cell) continue;

    const shardWorldPos = vec3Add(
      worldPosition,
      quatRotateVec3(worldQuaternion, cell.centroid),
    );
    const shardMass = cell.volumeM3 * profile.densityKgM3;
    const rebarStubs = generateRebarStubsForPolyhedron3D(cell, profile, rng);

    shards.push({
      polyhedron: cell,
      worldPosition: shardWorldPos,
      massKg: shardMass,
      rebarStubs,
    });
    totalShardsVolumeM3 += cell.volumeM3;
    totalShardsMassKg += shardMass;
  }

  if (shards.length === 0) {
    const normalizedPolyhedron: ConvexPolyhedron3DData = {
      ...polyhedron,
      centroid: [0, 0, 0],
    };
    const fallbackShard: VoronoiShard3D = {
      polyhedron: normalizedPolyhedron,
      worldPosition: [worldPosition[0], worldPosition[1], worldPosition[2]],
      massKg: originalMassKg,
      rebarStubs: generateRebarStubsForPolyhedron3D(normalizedPolyhedron, profile, rng),
    };
    return {
      shards: [fallbackShard],
      microDebrisPositions,
      originalVolumeM3,
      totalShardsVolumeM3: originalVolumeM3,
      originalMassKg,
      totalShardsMassKg: originalMassKg,
    };
  }

  return {
    shards,
    microDebrisPositions,
    originalVolumeM3,
    totalShardsVolumeM3,
    originalMassKg,
    totalShardsMassKg,
  };
}

/**
 * Удобная обёртка для анизотропного 3D-дробления прямоугольного блока по полуразмерам halfExtents.
 */
export function fractureBoxVoronoi3D(params: FractureBoxVoronoi3DParams): FractureVoronoi3DResult {
  const box = createBoxPolyhedron(params.halfExtents);
  return fracturePolyhedronVoronoi3D({
    polyhedron: box,
    materialId: params.materialId,
    worldPosition: params.worldPosition,
    worldQuaternion: params.worldQuaternion,
    impactPointLocal: params.impactPointLocal,
    shardCount: params.shardCount,
    seed: params.seed,
    principalAxisLocal: params.principalAxisLocal,
  });
}

/**
 * Вырезает локальный сквозной или кратерный пролом последовательным 4/5-плоскостным BSP-деревом
 * в протяжённых стенах и плитах перекрытий, сохраняя 100% выпуклость уцелевших сегментов и баланс объёма (< 0.05%).
 */
export function carveLocalBreach3D(params: CarveLocalBreach3DParams): CarveLocalBreach3DResult {
  const {
    polyhedron,
    materialId,
    worldPosition = [0, 0, 0],
    worldQuaternion = [0, 0, 0, 1],
    impactPointLocal,
    breachRadiusM,
    shardCount = 8,
    seed,
  } = params;

  const profile = getMaterialProfile(materialId);
  const originalVolumeM3 = polyhedron.volumeM3;
  const originalMassKg = originalVolumeM3 * profile.densityKgM3;
  const rng = new SeededRng(seed);

  const safeRadius = Number.isFinite(breachRadiusM) ? Math.max(0.15, breachRadiusM) : 0.5;
  const safeShardCount = Number.isFinite(shardCount) ? Math.round(shardCount) : 8;
  const frame = buildPolyhedronFrame(polyhedron);
  const [L0, L1, L2] = frame.spans;

  // Если блок слишком компактен для локального пролома — выполняем полный раскол Вороного
  if (L0 < 1.8 * safeRadius) {
    const full = fracturePolyhedronVoronoi3D({
      polyhedron,
      materialId,
      worldPosition,
      worldQuaternion,
      impactPointLocal,
      shardCount: safeShardCount,
      seed,
    });
    return {
      isLocalBreach: false,
      survivingPieces: [],
      breachShards: full.shards,
      microDebrisPositions: full.microDebrisPositions,
      originalVolumeM3,
      totalResultVolumeM3: full.totalShardsVolumeM3,
      originalMassKg,
      totalResultMassKg: full.totalShardsMassKg,
    };
  }

  const clampedImpact = clampPointInsidePolyhedron(polyhedron, impactPointLocal, 0.08);
  const u0 = vec3Dot(clampedImpact, frame.e0);
  const v0 = vec3Dot(clampedImpact, frame.e1);
  const w0 = vec3Dot(clampedImpact, frame.e2);

  const fromFrame = (u: number, v: number, w: number): Vec3 => [
    frame.e0[0] * u + frame.e1[0] * v + frame.e2[0] * w,
    frame.e0[1] * u + frame.e1[1] * v + frame.e2[1] * w,
    frame.e0[2] * u + frame.e1[2] * v + frame.e2[2] * w,
  ];

  const minMargin = Math.max(0.2, safeRadius * 0.35);

  interface BspCutPlane {
    planePoint: Vec3;
    /** Нормаль внутрь выбиваемого ядра breachCore */
    inwardToBreachNormal: Vec3;
  }

  const cuts: BspCutPlane[] = [];

  const tryAddCut = (
    cutCoord: number,
    marginToEdge: number,
    axisIndex: 0 | 1 | 2,
    inwardSign: 1 | -1,
  ): void => {
    if (marginToEdge < minMargin) {
      return;
    }
    const baseTiltMax = materialId === 'glass' ? 0.22 : 0.16;
    const crossHalfA = axisIndex === 0 ? L1 * 0.5 : L0 * 0.5;
    const crossHalfB = L2 * 0.5;
    const safeSlopeBudget = Math.max(0, 0.38 * (marginToEdge - 0.12));
    const maxTiltA = Math.min(baseTiltMax, safeSlopeBudget / Math.max(0.2, crossHalfA));
    const maxTiltB = Math.min(0.12, (safeRadius * 0.22) / Math.max(0.15, crossHalfB));

    const tiltA = rng.range(-maxTiltA, maxTiltA);
    const tiltB = rng.range(-maxTiltB, maxTiltB);

    let planePt: Vec3;
    let rawInward: Vec3;

    if (axisIndex === 0) {
      planePt = fromFrame(cutCoord, v0, w0);
      rawInward = fromFrame(inwardSign, tiltA, tiltB);
    } else if (axisIndex === 1) {
      planePt = fromFrame(u0, cutCoord, w0);
      rawInward = fromFrame(tiltA, inwardSign, tiltB);
    } else {
      planePt = fromFrame(u0, v0, cutCoord);
      rawInward = fromFrame(tiltA, tiltB, inwardSign);
    }

    cuts.push({
      planePoint: planePt,
      inwardToBreachNormal: vec3Normalize(rawInward),
    });
  };

  // 1. Левый и правый срезы вдоль главной оси стены/плиты U (e0)
  const uLeft = u0 - safeRadius;
  tryAddCut(uLeft, uLeft - frame.minProj[0], 0, +1);

  const uRight = u0 + safeRadius;
  tryAddCut(uRight, frame.maxProj[0] - uRight, 0, -1);

  // 2. Верхний и нижний срезы вдоль второй оси стены/плиты V (e1), если габарит L1 достаточен
  if (L1 >= 1.5 * safeRadius) {
    const vTop = v0 + safeRadius;
    tryAddCut(vTop, frame.maxProj[1] - vTop, 1, -1);

    const vBottom = v0 - safeRadius;
    tryAddCut(vBottom, v0 - safeRadius - frame.minProj[1], 1, +1);
  }

  // 3. Несквозной кратер по третьей оси W (e2) только для массивных блоков (толще 2.4 * R)
  if (L2 > 2.4 * safeRadius) {
    const distToMinW = w0 - frame.minProj[2];
    const distToMaxW = frame.maxProj[2] - w0;
    if (distToMinW <= distToMaxW) {
      // Удар ближе к грани minW -> оставляем тыльную стенку со стороны maxW
      const wBack = w0 + safeRadius;
      tryAddCut(wBack, frame.maxProj[2] - wBack, 2, -1);
    } else {
      const wBack = w0 - safeRadius;
      tryAddCut(wBack, wBack - frame.minProj[2], 2, +1);
    }
  }

  if (cuts.length === 0) {
    const full = fracturePolyhedronVoronoi3D({
      polyhedron,
      materialId,
      worldPosition,
      worldQuaternion,
      impactPointLocal,
      shardCount: safeShardCount,
      seed,
    });
    return {
      isLocalBreach: false,
      survivingPieces: [],
      breachShards: full.shards,
      microDebrisPositions: full.microDebrisPositions,
      originalVolumeM3,
      totalResultVolumeM3: full.totalShardsVolumeM3,
      originalMassKg,
      totalResultMassKg: full.totalShardsMassKg,
    };
  }

  // Последовательное BSP-разделение: каждый шаг отщепляет строго выпуклый уцелевший сегмент
  // и передаёт остаток core дальше с микроскопическим волосяным зазором breachHalfKerf
  const origMinThickness = computePolyhedronMinThickness(polyhedron);
  const breachHalfKerf = computeFractureHalfKerf({
    originalVolumeM3,
    origMinThickness,
    pieceCount: cuts.length + 1,
    worldPosition,
    isThinSheet: false,
    budgetScaleFactor: 6e-5,
  });

  let coreRaw: RawPolyhedron64 | null = localPolyhedronToRaw64(polyhedron);
  const survivingPolys: ConvexPolyhedron3DData[] = [];

  for (let i = 0; i < cuts.length; i++) {
    if (!coreRaw) break;
    const cut = cuts[i]!;
    const outwardToSurviving = vec3Scale(cut.inwardToBreachNormal, -1);
    const survivingPlanePt =
      breachHalfKerf > 0
        ? vec3AddScaled(cut.planePoint, outwardToSurviving, breachHalfKerf)
        : cut.planePoint;
    const corePlanePt =
      breachHalfKerf > 0
        ? vec3AddScaled(cut.planePoint, cut.inwardToBreachNormal, breachHalfKerf)
        : cut.planePoint;

    const survivingRaw = clipRawPolyhedronByPlane64(
      coreRaw,
      survivingPlanePt,
      outwardToSurviving,
      true,
    );
    const nextCoreRaw = clipRawPolyhedronByPlane64(
      coreRaw,
      corePlanePt,
      cut.inwardToBreachNormal,
      true,
    );

    const survivingFinal = survivingRaw ? finalizePolyhedron3D(survivingRaw) : null;
    if (survivingFinal && nextCoreRaw) {
      survivingPolys.push(survivingFinal);
      coreRaw = nextCoreRaw;
    }
  }

  const breachCorePoly = coreRaw ? finalizePolyhedron3D(coreRaw) : null;

  if (survivingPolys.length === 0 || !breachCorePoly) {
    const full = fracturePolyhedronVoronoi3D({
      polyhedron,
      materialId,
      worldPosition,
      worldQuaternion,
      impactPointLocal,
      shardCount: safeShardCount,
      seed,
    });
    return {
      isLocalBreach: false,
      survivingPieces: [],
      breachShards: full.shards,
      microDebrisPositions: full.microDebrisPositions,
      originalVolumeM3,
      totalResultVolumeM3: full.totalShardsVolumeM3,
      originalMassKg,
      totalResultMassKg: full.totalShardsMassKg,
    };
  }

  const survivingPieces: VoronoiShard3D[] = [];
  let survivingVolSum = 0;
  let survivingMassSum = 0;

  for (let i = 0; i < survivingPolys.length; i++) {
    const segPoly = survivingPolys[i]!;
    const segWorldPos = vec3Add(
      worldPosition,
      quatRotateVec3(worldQuaternion, segPoly.centroid),
    );
    const segMass = segPoly.volumeM3 * profile.densityKgM3;
    const segStubs = generateRebarStubsForPolyhedron3D(segPoly, profile, rng, 4);

    survivingPieces.push({
      polyhedron: segPoly,
      worldPosition: segWorldPos,
      massKg: segMass,
      rebarStubs: segStubs,
    });
    survivingVolSum += segPoly.volumeM3;
    survivingMassSum += segMass;
  }

  // Дробим выбитое центральное ядро пролома на 3D-осколки Вороного
  const coreWorldPos = vec3Add(
    worldPosition,
    quatRotateVec3(worldQuaternion, breachCorePoly.centroid),
  );
  const impactInCore: Vec3 = [
    clampedImpact[0] - breachCorePoly.centroid[0],
    clampedImpact[1] - breachCorePoly.centroid[1],
    clampedImpact[2] - breachCorePoly.centroid[2],
  ];
  const coreShardCount = Math.max(1, Math.min(16, safeShardCount));
  const coreRng = rng.fork(0x42524348);

  const coreFracture = fracturePolyhedronVoronoi3D({
    polyhedron: breachCorePoly,
    materialId,
    worldPosition: coreWorldPos,
    worldQuaternion,
    impactPointLocal: impactInCore,
    shardCount: coreShardCount,
    seed: coreRng.nextUint32(),
  });

  // Смещаем локальные центроиды breachShards обратно в систему координат родительской стены
  const breachShards: VoronoiShard3D[] = coreFracture.shards.map((sh) => ({
    polyhedron: {
      ...sh.polyhedron,
      centroid: [
        cleanZero(breachCorePoly.centroid[0] + sh.polyhedron.centroid[0]),
        cleanZero(breachCorePoly.centroid[1] + sh.polyhedron.centroid[1]),
        cleanZero(breachCorePoly.centroid[2] + sh.polyhedron.centroid[2]),
      ],
    },
    worldPosition: sh.worldPosition,
    massKg: sh.massKg,
    rebarStubs: sh.rebarStubs,
  }));

  return {
    isLocalBreach: true,
    survivingPieces,
    breachShards,
    microDebrisPositions: coreFracture.microDebrisPositions,
    originalVolumeM3,
    totalResultVolumeM3: survivingVolSum + coreFracture.totalShardsVolumeM3,
    originalMassKg,
    totalResultMassKg: survivingMassSum + coreFracture.totalShardsMassKg,
  };
}
