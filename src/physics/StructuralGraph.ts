import {
  buildOrthonormalPlaneBasis,
  clamp,
  cleanZero,
  computeAabbFromPoints,
  computePrincipalAxes3D,
  obbIntersectsObb,
  quatInverseRotateVec3,
  quatNormalize,
  quatRotateVec3,
  vec3Add,
  vec3AddScaled,
  vec3Cross,
  vec3Dist,
  vec3Dot,
  vec3Len,
  vec3Normalize,
  vec3Sub,
} from '../core/math3d';
import {
  AMBIENT_TEMPERATURE_C,
  type BlockInputSpec,
  type ConvexFace3D,
  type ConvexPolyhedron3DData,
  type QuatTuple,
  type StructuralMaterialId,
  type Vec3,
  type Vec3Tuple,
} from '../core/types';
import {
  clipRawPolyhedronByPlane64,
  createBoxPolyhedron,
  type RawPolyhedron64,
} from './ConvexPolyhedron3D';
import { getMaterialProfile } from './MaterialRegistry';

/**
 * Граф структурной целостности сооружения, расчёт геометрии строительных швов
 * по 3D-пересечению полиэдров и Multi-Source BFS поиска оторванных островов за O(V + E).
 */

export const WELD_HALF_MARGIN_M = 0.018;
export const MIN_CONTACT_AREA_M2 = 0.0025;
export const GROUND_CONTACT_TOLERANCE_M = 0.045;

export interface StructuralNode {
  nodeId: number;
  externalId?: string;
  materialId: StructuralMaterialId;
  structureGroupTag: string;
  polyhedron: ConvexPolyhedron3DData;
  halfExtents: Vec3;
  isBox: boolean;
  isCounterweight: boolean;
  countsTowardInitialTotals: boolean;
  volumeM3: number;
  massKg: number;
  initialCenter: Vec3;
  initialQuat: QuatTuple;
  initialTopY: number;
  localPlatformPos: Vec3;
  localPlatformQuat: QuatTuple;
  worldPos: Vec3;
  worldQuat: QuatTuple;
  localIslandOffset: Vec3;
  localIslandQuat: QuatTuple;
  grounded: boolean;
  alive: boolean;
  islandId: number; // 0 = закреплённый монолит на платформе, >0 = динамический остров
  colliderHandle: number;
  bfsDepth: number;
  stressUtilization: number;
  damageRatio: number;
  temperatureC: number;
  charRatio: number;
  burning: boolean;
  fuelRemaining: number;
  pendingImpulseNs: Vec3;
  externalForceN: Vec3;
  prevDisplacement6: Float64Array;
  adjacencyBondIds: number[];
}

export interface StructuralBond {
  bondId: number;
  nodeIdA: number;
  nodeIdB: number; // -1 означает связь узла A напрямую с фундаментом GroundAnchor
  contactCenterLocalA: Vec3;
  contactCenterLocalB: Vec3;
  normalLocalA: Vec3;
  tangentYLocalA: Vec3;
  tangentZLocalA: Vec3;
  areaM2: number;
  iyM4: number;
  izM4: number;
  polarJM4: number;
  sectionModulusWyM3: number;
  sectionModulusWzM3: number;
  torsionModulusWpM3: number;
  lengthM: number;
  integrity: number;
  broken: boolean;
  countsTowardInitialTotals: boolean;
  isPlasticHinge: boolean;
  plasticAngleRad: number;
  emittedSteelYield: boolean;
  concreteCracked: boolean;
  spawnedRebarTether: boolean;
  spawnedPlasticJoint: boolean;
  axialForceN: number;
  shearForceN: number;
  bendingMomentNm: number;
  torsionMomentNm: number;
  stressUtilization: number;
  dirtyStiffness: boolean;
  lastTempA: number;
  lastTempB: number;
  lastCharA: number;
  lastCharB: number;
  lastIntegrity: number;
  lastPlasticFlag: boolean;
  kAA: Float64Array;
  kBB: Float64Array;
  kAB: Float64Array;
  rot9: Float64Array;
  localCoeffs: Float64Array; // [ka, kt, kby1, kby2, kby3, kby4, kbz1, kbz2, kbz3, kbz4]
}

export interface DetachedIsland {
  islandId: number;
  bodyHandle: number;
  nodeIds: number[];
  totalMassKg: number;
  comWorldAtSpawn: Vec3;
}

interface Point2D {
  u: number;
  v: number;
}

interface ContactSectionMetrics {
  centerWorld: Vec3;
  normalWorld: Vec3;
  tangentYWorld: Vec3;
  tangentZWorld: Vec3;
  areaM2: number;
  iyM4: number;
  izM4: number;
  polarJM4: number;
  wyM3: number;
  wzM3: number;
  wpM3: number;
}

/**
 * Преобразует локальный полиэдр узла в мировые (или платформенные) координаты Float64,
 * опционально сдвигая вершины наружу вдоль локальных направлений от центроида для захвата строительного зазора.
 */
function buildTransformedRawPolyhedron64(
  poly: ConvexPolyhedron3DData,
  pos: Vec3Tuple,
  quat: QuatTuple,
  outwardMarginM: number,
): RawPolyhedron64 {
  const count = Math.floor(poly.vertices.length / 3);
  const vertices = new Array<number>(count * 3);

  for (let i = 0; i < count; i++) {
    const lx = poly.vertices[i * 3]!;
    const ly = poly.vertices[i * 3 + 1]!;
    const lz = poly.vertices[i * 3 + 2]!;
    let sx = lx;
    let sy = ly;
    let sz = lz;
    if (outwardMarginM > 0) {
      const len = Math.hypot(lx, ly, lz);
      if (len > 1e-9) {
        // Для вершины куба/полиэдра сдвиг вдоль единичного радиус-вектора на sqrt(3)*margin гарантирует сдвиг граней минимум на margin
        const scale = (len + outwardMarginM * 1.65) / len;
        sx = lx * scale;
        sy = ly * scale;
        sz = lz * scale;
      }
    }
    const rot = quatRotateVec3(quat, [sx, sy, sz]);
    vertices[i * 3] = pos[0] + rot[0];
    vertices[i * 3 + 1] = pos[1] + rot[1];
    vertices[i * 3 + 2] = pos[2] + rot[2];
  }

  const faces: ConvexFace3D[] = poly.faces.map((f) => ({
    indices: f.indices.slice(),
    normal: quatRotateVec3(quat, f.normal),
    isInteriorCut: f.isInteriorCut,
  }));

  return { vertices, faces };
}

/**
 * Алгоритм монотонной цепи Эндрю для построения 2D выпуклой оболочки в обходе CCW.
 */
function convexHull2D(points: readonly Point2D[]): Point2D[] {
  if (points.length < 3) {
    return [];
  }
  const sorted = points.slice().sort((a, b) => (a.u !== b.u ? a.u - b.u : a.v - b.v));
  const unique: Point2D[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const p = sorted[i]!;
    if (
      unique.length === 0 ||
      Math.hypot(p.u - unique[unique.length - 1]!.u, p.v - unique[unique.length - 1]!.v) > 1e-5
    ) {
      unique.push(p);
    }
  }
  if (unique.length < 3) {
    return [];
  }

  const cross = (o: Point2D, a: Point2D, b: Point2D): number =>
    (a.u - o.u) * (b.v - o.v) - (a.v - o.v) * (b.u - o.u);

  const lower: Point2D[] = [];
  for (let i = 0; i < unique.length; i++) {
    const p = unique[i]!;
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, p) <= 1e-10) {
      lower.pop();
    }
    lower.push(p);
  }

  const upper: Point2D[] = [];
  for (let i = unique.length - 1; i >= 0; i--) {
    const p = unique[i]!;
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, p) <= 1e-10) {
      upper.pop();
    }
    upper.push(p);
  }

  lower.pop();
  upper.pop();
  const hull = lower.concat(upper);
  return hull.length >= 3 ? hull : [];
}

/**
 * Вычисляет площадь, точный центроид и главные моменты инерции 2D-сечения шва по формулам Грина.
 */
function computeSectionMetricsFromProjectedVerts(
  worldVerts: readonly number[],
  normalWorld: Vec3Tuple,
  refCenterWorld: Vec3Tuple,
): ContactSectionMetrics | null {
  const vCount = Math.floor(worldVerts.length / 3);
  if (vCount < 3) {
    return null;
  }

  const basis = buildOrthonormalPlaneBasis(normalWorld);
  const pts2d: Point2D[] = new Array(vCount);
  let meanNormalOffset = 0;

  for (let i = 0; i < vCount; i++) {
    const dx = worldVerts[i * 3]! - refCenterWorld[0];
    const dy = worldVerts[i * 3 + 1]! - refCenterWorld[1];
    const dz = worldVerts[i * 3 + 2]! - refCenterWorld[2];
    pts2d[i] = {
      u: dx * basis.u[0] + dy * basis.u[1] + dz * basis.u[2],
      v: dx * basis.v[0] + dy * basis.v[1] + dz * basis.v[2],
    };
    meanNormalOffset += dx * basis.n[0] + dy * basis.n[1] + dz * basis.n[2];
  }
  meanNormalOffset /= vCount;

  const hull = convexHull2D(pts2d);
  if (hull.length < 3) {
    return null;
  }

  let signedArea2 = 0;
  let cxSum = 0;
  let cySum = 0;
  const k = hull.length;

  for (let i = 0; i < k; i++) {
    const a = hull[i]!;
    const b = hull[(i + 1) % k]!;
    const cr = a.u * b.v - b.u * a.v;
    signedArea2 += cr;
    cxSum += (a.u + b.u) * cr;
    cySum += (a.v + b.v) * cr;
  }

  const area = Math.abs(signedArea2) * 0.5;
  if (!Number.isFinite(area) || area < MIN_CONTACT_AREA_M2) {
    return null;
  }

  const inv6A = 1 / (3 * signedArea2);
  const uBar = cxSum * inv6A;
  const vBar = cySum * inv6A;

  // Сдвигаем вершины 2D-оболочки в её собственный центроид (uBar, vBar)
  const centered: Point2D[] = new Array(k);
  for (let i = 0; i < k; i++) {
    centered[i] = {
      u: hull[i]!.u - uBar,
      v: hull[i]!.v - vBar,
    };
  }

  if (signedArea2 < 0) {
    centered.reverse();
  }

  let iuu = 0;
  let ivv = 0;
  let iuv = 0;
  for (let i = 0; i < k; i++) {
    const a = centered[i]!;
    const b = centered[(i + 1) % k]!;
    const cr = a.u * b.v - b.u * a.v;
    iuu += cr * (a.v * a.v + a.v * b.v + b.v * b.v);
    ivv += cr * (a.u * a.u + a.u * b.u + b.u * b.u);
    iuv += cr * (a.u * b.v + 2 * a.u * a.v + 2 * b.u * b.v + b.u * a.v);
  }
  iuu = Math.max(1e-8, iuu / 12);
  ivv = Math.max(1e-8, ivv / 12);
  iuv /= 24;

  // Главный угол поворота осей инерции сечения
  const alpha = 0.5 * Math.atan2(-2 * iuv, iuu - ivv);
  const ca = Math.cos(alpha);
  const sa = Math.sin(alpha);

  const tangentYWorld = vec3Normalize([
    basis.u[0] * ca + basis.v[0] * sa,
    basis.u[1] * ca + basis.v[1] * sa,
    basis.u[2] * ca + basis.v[2] * sa,
  ]);
  const tangentZWorld = vec3Normalize(vec3Cross(basis.n, tangentYWorld));

  let iy = 0;
  let iz = 0;
  let maxAbsY = 0.02;
  let maxAbsZ = 0.02;
  let maxRad = 0.028;

  const rotPts: Array<{ y: number; z: number }> = new Array(k);
  for (let i = 0; i < k; i++) {
    const p = centered[i]!;
    const py = p.u * ca + p.v * sa;
    const pz = -p.u * sa + p.v * ca;
    rotPts[i] = { y: py, z: pz };
    if (Math.abs(py) > maxAbsY) maxAbsY = Math.abs(py);
    if (Math.abs(pz) > maxAbsZ) maxAbsZ = Math.abs(pz);
    const r = Math.hypot(py, pz);
    if (r > maxRad) maxRad = r;
  }

  for (let i = 0; i < k; i++) {
    const a = rotPts[i]!;
    const b = rotPts[(i + 1) % k]!;
    const cr = a.y * b.z - b.y * a.z;
    iy += cr * (a.z * a.z + a.z * b.z + b.z * b.z);
    iz += cr * (a.y * a.y + a.y * b.y + b.y * b.y);
  }
  iy = Math.max(1e-8, Math.abs(iy) / 12);
  iz = Math.max(1e-8, Math.abs(iz) / 12);

  // Аппроксимация крутильной жёсткости Сен-Венана по Коши для сплошного выпуклого сечения
  const polarJ = Math.max(1e-8, Math.pow(area, 4) / (40 * (iy + iz)));
  const wy = iy / maxAbsZ;
  const wz = iz / maxAbsY;
  const wp = polarJ / maxRad;

  const centerWorld: Vec3 = [
    cleanZero(refCenterWorld[0] + basis.n[0] * meanNormalOffset + basis.u[0] * uBar + basis.v[0] * vBar),
    cleanZero(refCenterWorld[1] + basis.n[1] * meanNormalOffset + basis.u[1] * uBar + basis.v[1] * vBar),
    cleanZero(refCenterWorld[2] + basis.n[2] * meanNormalOffset + basis.u[2] * uBar + basis.v[2] * vBar),
  ];

  return {
    centerWorld,
    normalWorld: basis.n,
    tangentYWorld,
    tangentZWorld,
    areaM2: cleanZero(area),
    iyM4: cleanZero(iy),
    izM4: cleanZero(iz),
    polarJM4: cleanZero(polarJ),
    wyM3: cleanZero(wy),
    wzM3: cleanZero(wz),
    wpM3: cleanZero(wp),
  };
}

/**
 * Вычисляет контактный шов между двумя узлами A и B в системе координат платформы.
 */
function computeContactBetweenNodes(nodeA: StructuralNode, nodeB: StructuralNode): ContactSectionMetrics | null {
  const rawAExp = buildTransformedRawPolyhedron64(
    nodeA.polyhedron,
    nodeA.localPlatformPos,
    nodeA.localPlatformQuat,
    WELD_HALF_MARGIN_M,
  );
  const rawBOrig = buildTransformedRawPolyhedron64(
    nodeB.polyhedron,
    nodeB.localPlatformPos,
    nodeB.localPlatformQuat,
    0,
  );

  let inter: RawPolyhedron64 | null = rawAExp;
  for (let f = 0; f < rawBOrig.faces.length; f++) {
    const face = rawBOrig.faces[f]!;
    if (face.indices.length < 3) continue;
    const i0 = face.indices[0]!;
    const fx = rawBOrig.vertices[i0 * 3]!;
    const fy = rawBOrig.vertices[i0 * 3 + 1]!;
    const fz = rawBOrig.vertices[i0 * 3 + 2]!;
    const nx = face.normal[0];
    const ny = face.normal[1];
    const nz = face.normal[2];
    const shiftedPt: Vec3 = [
      fx + nx * WELD_HALF_MARGIN_M,
      fy + ny * WELD_HALF_MARGIN_M,
      fz + nz * WELD_HALF_MARGIN_M,
    ];
    const inwardNormal: Vec3 = [-nx, -ny, -nz];
    inter = clipRawPolyhedronByPlane64(inter, shiftedPt, inwardNormal, false, false);
    if (!inter || inter.vertices.length < 9) {
      return null;
    }
  }

  if (!inter || inter.vertices.length < 9) {
    return null;
  }

  const vCount = Math.floor(inter.vertices.length / 3);
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (let i = 0; i < vCount; i++) {
    cx += inter.vertices[i * 3]!;
    cy += inter.vertices[i * 3 + 1]!;
    cz += inter.vertices[i * 3 + 2]!;
  }
  cx /= vCount;
  cy /= vCount;
  cz /= vCount;
  const interCenter: Vec3 = [cx, cy, cz];

  // Ищем пару смежных антипараллельных граней A и B вблизи центра пересечения
  const rawAOrig = buildTransformedRawPolyhedron64(
    nodeA.polyhedron,
    nodeA.localPlatformPos,
    nodeA.localPlatformQuat,
    0,
  );

  let bestGap = Number.POSITIVE_INFINITY;
  let chosenNormal: Vec3 | null = null;

  for (let fa = 0; fa < rawAOrig.faces.length; fa++) {
    const faceA = rawAOrig.faces[fa]!;
    if (faceA.indices.length === 0) continue;
    const ia = faceA.indices[0]!;
    const pax = rawAOrig.vertices[ia * 3]!;
    const pay = rawAOrig.vertices[ia * 3 + 1]!;
    const paz = rawAOrig.vertices[ia * 3 + 2]!;
    const distA = Math.abs(
      (cx - pax) * faceA.normal[0] + (cy - pay) * faceA.normal[1] + (cz - paz) * faceA.normal[2],
    );
    if (distA > 0.06) continue;

    for (let fb = 0; fb < rawBOrig.faces.length; fb++) {
      const faceB = rawBOrig.faces[fb]!;
      if (faceB.indices.length === 0) continue;
      const dotN = vec3Dot(faceA.normal, faceB.normal);
      if (dotN > -0.72) continue;

      const ib = faceB.indices[0]!;
      const pbx = rawBOrig.vertices[ib * 3]!;
      const pby = rawBOrig.vertices[ib * 3 + 1]!;
      const pbz = rawBOrig.vertices[ib * 3 + 2]!;
      const distB = Math.abs(
        (cx - pbx) * faceB.normal[0] + (cy - pby) * faceB.normal[1] + (cz - pbz) * faceB.normal[2],
      );
      if (distB > 0.06) continue;

      const gap = distA + distB;
      if (gap < bestGap) {
        bestGap = gap;
        chosenNormal = vec3Normalize(vec3Sub(faceA.normal, faceB.normal));
      }
    }
  }

  const abVec = vec3Sub(nodeB.localPlatformPos, nodeA.localPlatformPos);
  if (!chosenNormal) {
    const eigen = computePrincipalAxes3D(new Float32Array(inter.vertices));
    let thinAxis = eigen.axes[2];
    if (vec3Len(abVec) > 1e-5 && vec3Dot(thinAxis, abVec) < 0) {
      thinAxis = [-thinAxis[0], -thinAxis[1], -thinAxis[2]];
    }
    chosenNormal = vec3Len(thinAxis) > 1e-6 ? thinAxis : vec3Normalize(abVec, [0, 1, 0]);
  } else if (vec3Len(abVec) > 1e-5 && vec3Dot(chosenNormal, abVec) < 0) {
    chosenNormal = [-chosenNormal[0], -chosenNormal[1], -chosenNormal[2]];
  }

  return computeSectionMetricsFromProjectedVerts(inter.vertices, chosenNormal, interCenter);
}

/**
 * Вычисляет контактный шов узла с плоскостью фундамента Y = 0 (или явной заделкой grounded: true).
 */
function computeGroundAnchorSection(
  node: StructuralNode,
  explicitGrounded: boolean,
): ContactSectionMetrics | null {
  const raw = buildTransformedRawPolyhedron64(
    node.polyhedron,
    node.localPlatformPos,
    node.localPlatformQuat,
    0,
  );
  const vCount = Math.floor(raw.vertices.length / 3);
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < vCount; i++) {
    const y = raw.vertices[i * 3 + 1]!;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }

  const touchesGround = minY <= GROUND_CONTACT_TOLERANCE_M && maxY > 0.01;
  if (!explicitGrounded && !touchesGround) {
    return null;
  }

  if (touchesGround) {
    // Отсекаем подошву плоскостью y <= max(0.05, minY + 0.05) -> оставляем { p | (p - [0, cutY, 0]) · [0, -1, 0] >= 0 }
    const cutY = Math.max(0.05, minY + 0.05);
    const clipped = clipRawPolyhedronByPlane64(raw, [0, cutY, 0], [0, -1, 0], false, true);
    if (clipped && clipped.vertices.length >= 9) {
      const footCenter: Vec3 = [node.localPlatformPos[0], Math.max(0, minY), node.localPlatformPos[2]];
      const metrics = computeSectionMetricsFromProjectedVerts(
        clipped.vertices,
        [0, -1, 0],
        footCenter,
      );
      if (metrics) {
        metrics.centerWorld = [metrics.centerWorld[0], cleanZero(Math.max(0, minY)), metrics.centerWorld[2]];
        return metrics;
      }
    }
  }

  // Явный консольный/боковой задел (explicitGrounded = true выше уровня земли)
  const hx = Math.max(0.05, node.halfExtents[0]);
  const hy = Math.max(0.05, node.halfExtents[1]);
  const hz = Math.max(0.05, node.halfExtents[2]);
  const area = 4 * hx * hz;
  const iy = (4 * hx * Math.pow(hz, 3)) / 3;
  const iz = (4 * hz * Math.pow(hx, 3)) / 3;
  const polarJ = Math.max(1e-8, Math.pow(area, 4) / (40 * (iy + iz)));
  const normalWorld = quatRotateVec3(node.localPlatformQuat, [0, -1, 0]);
  const tangentYWorld = quatRotateVec3(node.localPlatformQuat, [1, 0, 0]);
  const tangentZWorld = quatRotateVec3(node.localPlatformQuat, [0, 0, 1]);
  const anchorCenter = vec3AddScaled(node.localPlatformPos, normalWorld, hy);

  return {
    centerWorld: anchorCenter,
    normalWorld,
    tangentYWorld,
    tangentZWorld,
    areaM2: cleanZero(area),
    iyM4: cleanZero(iy),
    izM4: cleanZero(iz),
    polarJM4: cleanZero(polarJ),
    wyM3: cleanZero(iy / hz),
    wzM3: cleanZero(iz / hx),
    wpM3: cleanZero(polarJ / Math.hypot(hx, hz)),
  };
}

export class StructuralGraph {
  private readonly nodes = new Map<number, StructuralNode>();
  private readonly bonds = new Map<number, StructuralBond>();
  private nextNodeId = 1;
  private nextBondId = 1;

  private bfsVisited = new Uint8Array(256);
  private bfsQueue = new Int32Array(256);

  public clear(): void {
    this.nodes.clear();
    this.bonds.clear();
    this.nextNodeId = 1;
    this.nextBondId = 1;
  }

  public getNode(nodeId: number): StructuralNode | undefined {
    return this.nodes.get(nodeId);
  }

  public getNodesMap(): ReadonlyMap<number, StructuralNode> {
    return this.nodes;
  }

  public getBond(bondId: number): StructuralBond | undefined {
    return this.bonds.get(bondId);
  }

  public getBondsMap(): ReadonlyMap<number, StructuralBond> {
    return this.bonds;
  }

  /**
   * Добавляет пакет конструктивных блоков в граф, автоматически вычисляет пятна контакта
   * между новыми блоками, уже стоящими закреплёнными блоками и фундаментом GroundAnchor.
   */
  public addBlocks(
    specs: readonly BlockInputSpec[],
    platformOffset: Vec3Tuple = [0, 0, 0],
  ): { createdNodes: StructuralNode[]; createdBonds: StructuralBond[] } {
    const createdNodes: StructuralNode[] = [];
    const createdBonds: StructuralBond[] = [];

    for (let i = 0; i < specs.length; i++) {
      const spec = specs[i]!;
      const hx = Math.max(0.02, spec.halfExtents[0]);
      const hy = Math.max(0.02, spec.halfExtents[1]);
      const hz = Math.max(0.02, spec.halfExtents[2]);
      const halfExtents: Vec3 = [cleanZero(hx), cleanZero(hy), cleanZero(hz)];
      const poly = createBoxPolyhedron(halfExtents);
      const profile = getMaterialProfile(spec.materialId);
      const quat = spec.rotationQuat ? quatNormalize(spec.rotationQuat) : ([0, 0, 0, 1] as QuatTuple);
      const localPos: Vec3 = [
        cleanZero(spec.center[0]),
        cleanZero(spec.center[1]),
        cleanZero(spec.center[2]),
      ];
      const worldPos: Vec3 = [
        cleanZero(localPos[0] + platformOffset[0]),
        cleanZero(localPos[1] + platformOffset[1]),
        cleanZero(localPos[2] + platformOffset[2]),
      ];

      // Вычисляем верхнюю точку в СК платформы
      const rawVerts = buildTransformedRawPolyhedron64(poly, localPos, quat, 0).vertices;
      let topY = 0;
      for (let v = 0; v < rawVerts.length; v += 3) {
        if (rawVerts[v + 1]! > topY) {
          topY = rawVerts[v + 1]!;
        }
      }

      const nodeId = this.nextNodeId++;
      const node: StructuralNode = {
        nodeId,
        externalId: spec.id,
        materialId: spec.materialId,
        structureGroupTag: spec.structureGroupTag ?? 'default',
        polyhedron: poly,
        halfExtents,
        isBox: true,
        isCounterweight: false,
        countsTowardInitialTotals: true,
        volumeM3: poly.volumeM3,
        massKg: poly.volumeM3 * profile.densityKgM3,
        initialCenter: [localPos[0], localPos[1], localPos[2]],
        initialQuat: [quat[0], quat[1], quat[2], quat[3]],
        initialTopY: cleanZero(topY),
        localPlatformPos: localPos,
        localPlatformQuat: quat,
        worldPos,
        worldQuat: [quat[0], quat[1], quat[2], quat[3]],
        localIslandOffset: [0, 0, 0],
        localIslandQuat: [0, 0, 0, 1],
        grounded: Boolean(spec.grounded),
        alive: true,
        islandId: 0,
        colliderHandle: -1,
        bfsDepth: -1,
        stressUtilization: 0,
        damageRatio: 0,
        temperatureC: AMBIENT_TEMPERATURE_C,
        charRatio: 0,
        burning: false,
        fuelRemaining: profile.flammable ? 1.0 : 0.0,
        pendingImpulseNs: [0, 0, 0],
        externalForceN: [0, 0, 0],
        prevDisplacement6: new Float64Array(6),
        adjacencyBondIds: [],
      };

      this.nodes.set(nodeId, node);
      createdNodes.push(node);

      // Проверяем связь с фундаментом GroundAnchor
      const groundSec = computeGroundAnchorSection(node, Boolean(spec.grounded));
      if (groundSec) {
        node.grounded = true;
        const gBond = this.createGroundBond(node, groundSec, true);
        createdBonds.push(gBond);
      }
    }

    if (createdNodes.length === 0) {
      return { createdNodes, createdBonds };
    }

    // Широкая фаза: индексируем все живые закреплённые узлы (islandId === 0, не противовесы) в Spatial Hash Grid
    const cellSize = 2.0;
    const grid = new Map<string, StructuralNode[]>();
    const newIdSet = new Set<number>();
    for (let i = 0; i < createdNodes.length; i++) {
      newIdSet.add(createdNodes[i]!.nodeId);
    }

    const candidates: StructuralNode[] = [];
    for (const n of this.nodes.values()) {
      if (n.alive && n.islandId === 0 && !n.isCounterweight) {
        candidates.push(n);
      }
    }

    const nodeAabbs = new Map<number, { min: Vec3; max: Vec3 }>();
    for (let i = 0; i < candidates.length; i++) {
      const n = candidates[i]!;
      const raw = buildTransformedRawPolyhedron64(
        n.polyhedron,
        n.localPlatformPos,
        n.localPlatformQuat,
        0,
      );
      const aabb = computeAabbFromPoints(new Float32Array(raw.vertices));
      const pad = WELD_HALF_MARGIN_M * 2.2;
      const min: Vec3 = [aabb.min[0] - pad, aabb.min[1] - pad, aabb.min[2] - pad];
      const max: Vec3 = [aabb.max[0] + pad, aabb.max[1] + pad, aabb.max[2] + pad];
      nodeAabbs.set(n.nodeId, { min, max });

      const ix0 = Math.floor(min[0] / cellSize);
      const iy0 = Math.floor(min[1] / cellSize);
      const iz0 = Math.floor(min[2] / cellSize);
      const ix1 = Math.floor(max[0] / cellSize);
      const iy1 = Math.floor(max[1] / cellSize);
      const iz1 = Math.floor(max[2] / cellSize);

      for (let ix = ix0; ix <= ix1; ix++) {
        for (let iy = iy0; iy <= iy1; iy++) {
          for (let iz = iz0; iz <= iz1; iz++) {
            const key = `${ix},${iy},${iz}`;
            let bucket = grid.get(key);
            if (!bucket) {
              bucket = [];
              grid.set(key, bucket);
            }
            bucket.push(n);
          }
        }
      }
    }

    const testedPairs = new Set<string>();

    for (let i = 0; i < createdNodes.length; i++) {
      const nodeA = createdNodes[i]!;
      const boxA = nodeAabbs.get(nodeA.nodeId);
      if (!boxA) continue;

      const ix0 = Math.floor(boxA.min[0] / cellSize);
      const iy0 = Math.floor(boxA.min[1] / cellSize);
      const iz0 = Math.floor(boxA.min[2] / cellSize);
      const ix1 = Math.floor(boxA.max[0] / cellSize);
      const iy1 = Math.floor(boxA.max[1] / cellSize);
      const iz1 = Math.floor(boxA.max[2] / cellSize);

      for (let ix = ix0; ix <= ix1; ix++) {
        for (let iy = iy0; iy <= iy1; iy++) {
          for (let iz = iz0; iz <= iz1; iz++) {
            const bucket = grid.get(`${ix},${iy},${iz}`);
            if (!bucket) continue;
            for (let bIdx = 0; bIdx < bucket.length; bIdx++) {
              const nodeB = bucket[bIdx]!;
              if (nodeA.nodeId === nodeB.nodeId) continue;
              if (newIdSet.has(nodeB.nodeId) && nodeA.nodeId > nodeB.nodeId) continue;

              const lo = Math.min(nodeA.nodeId, nodeB.nodeId);
              const hi = Math.max(nodeA.nodeId, nodeB.nodeId);
              const pairKey = `${lo}:${hi}`;
              if (testedPairs.has(pairKey)) continue;
              testedPairs.add(pairKey);

              const boxB = nodeAabbs.get(nodeB.nodeId);
              if (!boxB) continue;
              if (
                boxA.max[0] < boxB.min[0] ||
                boxA.min[0] > boxB.max[0] ||
                boxA.max[1] < boxB.min[1] ||
                boxA.min[1] > boxB.max[1] ||
                boxA.max[2] < boxB.min[2] ||
                boxA.min[2] > boxB.max[2]
              ) {
                continue;
              }

              const nLo = lo === nodeA.nodeId ? nodeA : nodeB;
              const nHi = lo === nodeA.nodeId ? nodeB : nodeA;

              if (
                nLo.isBox &&
                nHi.isBox &&
                !obbIntersectsObb(
                  {
                    center: nLo.localPlatformPos,
                    halfExtents: nLo.halfExtents,
                    rotationQuat: nLo.localPlatformQuat,
                  },
                  {
                    center: nHi.localPlatformPos,
                    halfExtents: nHi.halfExtents,
                    rotationQuat: nHi.localPlatformQuat,
                  },
                  WELD_HALF_MARGIN_M * 2,
                )
              ) {
                continue;
              }

              const sec = computeContactBetweenNodes(nLo, nHi);
              if (sec) {
                const bond = this.createNodePairBond(nLo, nHi, sec, true);
                createdBonds.push(bond);
              }
            }
          }
        }
      }
    }

    return { createdNodes, createdBonds };
  }

  /**
   * Регистрирует специальный узел многотонного противовеса (без строительных швов с соседями).
   */
  public addCounterweightNode(params: {
    center: Vec3Tuple;
    halfExtents: Vec3Tuple;
    massKg: number;
  }): StructuralNode {
    const hx = Math.max(0.05, params.halfExtents[0]);
    const hy = Math.max(0.05, params.halfExtents[1]);
    const hz = Math.max(0.05, params.halfExtents[2]);
    const halfExtents: Vec3 = [cleanZero(hx), cleanZero(hy), cleanZero(hz)];
    const poly = createBoxPolyhedron(halfExtents);
    const pos: Vec3 = [cleanZero(params.center[0]), cleanZero(params.center[1]), cleanZero(params.center[2])];
    const nodeId = this.nextNodeId++;

    const node: StructuralNode = {
      nodeId,
      materialId: 'steel',
      structureGroupTag: 'counterweight',
      polyhedron: poly,
      halfExtents,
      isBox: true,
      isCounterweight: true,
      countsTowardInitialTotals: false,
      volumeM3: poly.volumeM3,
      massKg: Math.max(50, params.massKg),
      initialCenter: [pos[0], pos[1], pos[2]],
      initialQuat: [0, 0, 0, 1],
      initialTopY: cleanZero(pos[1] + hy),
      localPlatformPos: [pos[0], pos[1], pos[2]],
      localPlatformQuat: [0, 0, 0, 1],
      worldPos: [pos[0], pos[1], pos[2]],
      worldQuat: [0, 0, 0, 1],
      localIslandOffset: [0, 0, 0],
      localIslandQuat: [0, 0, 0, 1],
      grounded: false,
      alive: true,
      islandId: -1, // Специальное собственное динамическое тело противовеса
      colliderHandle: -1,
      bfsDepth: -1,
      stressUtilization: 0,
      damageRatio: 0,
      temperatureC: AMBIENT_TEMPERATURE_C,
      charRatio: 0,
      burning: false,
      fuelRemaining: 0,
      pendingImpulseNs: [0, 0, 0],
      externalForceN: [0, 0, 0],
      prevDisplacement6: new Float64Array(6),
      adjacencyBondIds: [],
    };
    this.nodes.set(nodeId, node);
    return node;
  }

  /**
   * Заменяет закреплённый стеновой/плитный узел на выжившие выпуклые сегменты после локального пролома carveLocalBreach3D,
   * пересобирая их связи друг с другом, с бывшими соседями родителя и с фундаментом.
   */
  public replaceNodeWithBreachPieces(
    parentNode: StructuralNode,
    pieces: readonly { polyhedron: ConvexPolyhedron3DData; worldPosition: Vec3; massKg: number }[],
    platformOffset: Vec3Tuple,
  ): {
    pieceNodes: StructuralNode[];
    newBonds: StructuralBond[];
    brokenParentBondsCount: number;
  } {
    const neighborIds = new Set<number>();
    let hadExplicitGround = parentNode.grounded;
    let brokenParentBondsCount = 0;

    for (let i = 0; i < parentNode.adjacencyBondIds.length; i++) {
      const bId = parentNode.adjacencyBondIds[i]!;
      const bond = this.bonds.get(bId);
      if (!bond) continue;
      if (!bond.broken) {
        bond.broken = true;
        bond.integrity = 0;
        brokenParentBondsCount++;
      }
      if (bond.nodeIdB === -1) {
        hadExplicitGround = true;
      } else {
        const otherId = bond.nodeIdA === parentNode.nodeId ? bond.nodeIdB : bond.nodeIdA;
        const other = this.nodes.get(otherId);
        if (other && other.alive && other.islandId === 0) {
          neighborIds.add(otherId);
        }
      }
    }

    parentNode.alive = false;

    const pieceNodes: StructuralNode[] = [];
    const newBonds: StructuralBond[] = [];

    for (let i = 0; i < pieces.length; i++) {
      const p = pieces[i]!;
      const localPlatPos: Vec3 = [
        cleanZero(p.worldPosition[0] - platformOffset[0]),
        cleanZero(p.worldPosition[1] - platformOffset[1]),
        cleanZero(p.worldPosition[2] - platformOffset[2]),
      ];
      const quat: QuatTuple = [
        parentNode.localPlatformQuat[0],
        parentNode.localPlatformQuat[1],
        parentNode.localPlatformQuat[2],
        parentNode.localPlatformQuat[3],
      ];
      const rawVerts = buildTransformedRawPolyhedron64(p.polyhedron, localPlatPos, quat, 0).vertices;
      let topY = 0;
      for (let v = 0; v < rawVerts.length; v += 3) {
        if (rawVerts[v + 1]! > topY) topY = rawVerts[v + 1]!;
      }

      const nodeId = this.nextNodeId++;
      const subNode: StructuralNode = {
        nodeId,
        materialId: parentNode.materialId,
        structureGroupTag: parentNode.structureGroupTag,
        polyhedron: { ...p.polyhedron, centroid: [0, 0, 0] },
        halfExtents: [
          p.polyhedron.halfExtentsApprox[0],
          p.polyhedron.halfExtentsApprox[1],
          p.polyhedron.halfExtentsApprox[2],
        ],
        isBox: false,
        isCounterweight: false,
        countsTowardInitialTotals: false,
        volumeM3: p.polyhedron.volumeM3,
        massKg: p.massKg,
        initialCenter: [localPlatPos[0], localPlatPos[1], localPlatPos[2]],
        initialQuat: [quat[0], quat[1], quat[2], quat[3]],
        initialTopY: cleanZero(topY),
        localPlatformPos: localPlatPos,
        localPlatformQuat: quat,
        worldPos: [p.worldPosition[0], p.worldPosition[1], p.worldPosition[2]],
        worldQuat: [
          parentNode.worldQuat[0],
          parentNode.worldQuat[1],
          parentNode.worldQuat[2],
          parentNode.worldQuat[3],
        ],
        localIslandOffset: [0, 0, 0],
        localIslandQuat: [0, 0, 0, 1],
        grounded: false,
        alive: true,
        islandId: 0,
        colliderHandle: -1,
        bfsDepth: -1,
        stressUtilization: 0,
        damageRatio: parentNode.damageRatio * 0.35,
        temperatureC: parentNode.temperatureC,
        charRatio: parentNode.charRatio,
        burning: parentNode.burning,
        fuelRemaining: parentNode.fuelRemaining,
        pendingImpulseNs: [0, 0, 0],
        externalForceN: [0, 0, 0],
        prevDisplacement6: new Float64Array(6),
        adjacencyBondIds: [],
      };
      this.nodes.set(nodeId, subNode);
      pieceNodes.push(subNode);

      // Проверяем касание фундамента выжившим куском
      const gSec = computeGroundAnchorSection(subNode, false);
      if (gSec && hadExplicitGround) {
        subNode.grounded = true;
        newBonds.push(this.createGroundBond(subNode, gSec, false));
      }
    }

    // Связи между самими выжившими сегментами и с бывшими соседями родителя
    for (let i = 0; i < pieceNodes.length; i++) {
      const pA = pieceNodes[i]!;
      for (let j = i + 1; j < pieceNodes.length; j++) {
        const pB = pieceNodes[j]!;
        const sec = computeContactBetweenNodes(pA, pB);
        if (sec) {
          newBonds.push(this.createNodePairBond(pA, pB, sec, false));
        }
      }
      for (const nId of neighborIds) {
        const nb = this.nodes.get(nId);
        if (!nb || !nb.alive || nb.islandId !== 0) continue;
        const lo = pA.nodeId < nb.nodeId ? pA : nb;
        const hi = pA.nodeId < nb.nodeId ? nb : pA;
        const sec = computeContactBetweenNodes(lo, hi);
        if (sec) {
          newBonds.push(this.createNodePairBond(lo, hi, sec, false));
        }
      }
    }

    return { pieceNodes, newBonds, brokenParentBondsCount };
  }

  private createGroundBond(
    node: StructuralNode,
    sec: ContactSectionMetrics,
    countsTowardInitialTotals: boolean,
  ): StructuralBond {
    const bondId = this.nextBondId++;
    const relA = vec3Sub(sec.centerWorld, node.localPlatformPos);
    const contactCenterLocalA = quatInverseRotateVec3(node.localPlatformQuat, relA);
    const normalLocalA = quatInverseRotateVec3(node.localPlatformQuat, sec.normalWorld);
    const tangentYLocalA = quatInverseRotateVec3(node.localPlatformQuat, sec.tangentYWorld);
    const tangentZLocalA = quatInverseRotateVec3(node.localPlatformQuat, sec.tangentZWorld);
    const lengthM = Math.max(0.08, vec3Dist(node.localPlatformPos, sec.centerWorld));

    const bond: StructuralBond = {
      bondId,
      nodeIdA: node.nodeId,
      nodeIdB: -1,
      contactCenterLocalA,
      contactCenterLocalB: [sec.centerWorld[0], sec.centerWorld[1], sec.centerWorld[2]],
      normalLocalA,
      tangentYLocalA,
      tangentZLocalA,
      areaM2: sec.areaM2,
      iyM4: sec.iyM4,
      izM4: sec.izM4,
      polarJM4: sec.polarJM4,
      sectionModulusWyM3: sec.wyM3,
      sectionModulusWzM3: sec.wzM3,
      torsionModulusWpM3: sec.wpM3,
      lengthM: cleanZero(lengthM),
      integrity: 1.0,
      broken: false,
      countsTowardInitialTotals,
      isPlasticHinge: false,
      plasticAngleRad: 0,
      emittedSteelYield: false,
      concreteCracked: false,
      spawnedRebarTether: false,
      spawnedPlasticJoint: false,
      axialForceN: 0,
      shearForceN: 0,
      bendingMomentNm: 0,
      torsionMomentNm: 0,
      stressUtilization: 0,
      dirtyStiffness: true,
      lastTempA: -999,
      lastTempB: -999,
      lastCharA: -1,
      lastCharB: -1,
      lastIntegrity: -1,
      lastPlasticFlag: false,
      kAA: new Float64Array(36),
      kBB: new Float64Array(36),
      kAB: new Float64Array(36),
      rot9: new Float64Array(9),
      localCoeffs: new Float64Array(10),
    };

    this.bonds.set(bondId, bond);
    node.adjacencyBondIds.push(bondId);
    return bond;
  }

  private createNodePairBond(
    nodeA: StructuralNode,
    nodeB: StructuralNode,
    sec: ContactSectionMetrics,
    countsTowardInitialTotals: boolean,
  ): StructuralBond {
    const bondId = this.nextBondId++;
    const contactCenterLocalA = quatInverseRotateVec3(
      nodeA.localPlatformQuat,
      vec3Sub(sec.centerWorld, nodeA.localPlatformPos),
    );
    const contactCenterLocalB = quatInverseRotateVec3(
      nodeB.localPlatformQuat,
      vec3Sub(sec.centerWorld, nodeB.localPlatformPos),
    );
    const normalLocalA = quatInverseRotateVec3(nodeA.localPlatformQuat, sec.normalWorld);
    const tangentYLocalA = quatInverseRotateVec3(nodeA.localPlatformQuat, sec.tangentYWorld);
    const tangentZLocalA = quatInverseRotateVec3(nodeA.localPlatformQuat, sec.tangentZWorld);
    const lengthM = Math.max(0.08, vec3Dist(nodeA.localPlatformPos, nodeB.localPlatformPos));

    const bond: StructuralBond = {
      bondId,
      nodeIdA: nodeA.nodeId,
      nodeIdB: nodeB.nodeId,
      contactCenterLocalA,
      contactCenterLocalB,
      normalLocalA,
      tangentYLocalA,
      tangentZLocalA,
      areaM2: sec.areaM2,
      iyM4: sec.iyM4,
      izM4: sec.izM4,
      polarJM4: sec.polarJM4,
      sectionModulusWyM3: sec.wyM3,
      sectionModulusWzM3: sec.wzM3,
      torsionModulusWpM3: sec.wpM3,
      lengthM: cleanZero(lengthM),
      integrity: 1.0,
      broken: false,
      countsTowardInitialTotals,
      isPlasticHinge: false,
      plasticAngleRad: 0,
      emittedSteelYield: false,
      concreteCracked: false,
      spawnedRebarTether: false,
      spawnedPlasticJoint: false,
      axialForceN: 0,
      shearForceN: 0,
      bendingMomentNm: 0,
      torsionMomentNm: 0,
      stressUtilization: 0,
      dirtyStiffness: true,
      lastTempA: -999,
      lastTempB: -999,
      lastCharA: -1,
      lastCharB: -1,
      lastIntegrity: -1,
      lastPlasticFlag: false,
      kAA: new Float64Array(36),
      kBB: new Float64Array(36),
      kAB: new Float64Array(36),
      rot9: new Float64Array(9),
      localCoeffs: new Float64Array(10),
    };

    this.bonds.set(bondId, bond);
    nodeA.adjacencyBondIds.push(bondId);
    nodeB.adjacencyBondIds.push(bondId);
    return bond;
  }

  /**
   * Выполняет Multi-Source BFS от всех узлов, имеющих неразорванную связь с фундаментом GroundAnchor.
   * Возвращает список связных компонент (массивов nodeId), потерявших опору на фундамент.
   */
  public findUnanchoredComponents(): number[][] {
    const cap = this.nextNodeId + 4;
    if (this.bfsVisited.length < cap) {
      this.bfsVisited = new Uint8Array(Math.max(cap * 2, 512));
      this.bfsQueue = new Int32Array(Math.max(cap * 2, 512));
    }
    const visited = this.bfsVisited;
    const queue = this.bfsQueue;
    visited.fill(0, 0, cap);

    let head = 0;
    let tail = 0;

    for (const node of this.nodes.values()) {
      if (!node.alive || node.islandId !== 0 || node.isCounterweight) continue;
      node.bfsDepth = -1;
      let hasLiveGroundBond = false;
      for (let i = 0; i < node.adjacencyBondIds.length; i++) {
        const b = this.bonds.get(node.adjacencyBondIds[i]!);
        if (b && !b.broken && b.nodeIdB === -1) {
          hasLiveGroundBond = true;
          break;
        }
      }
      if (hasLiveGroundBond) {
        visited[node.nodeId] = 1;
        node.bfsDepth = 0;
        queue[tail++] = node.nodeId;
      }
    }

    while (head < tail) {
      const uId = queue[head++]!;
      const uNode = this.nodes.get(uId);
      if (!uNode) continue;
      const nextDepth = uNode.bfsDepth + 1;

      for (let i = 0; i < uNode.adjacencyBondIds.length; i++) {
        const b = this.bonds.get(uNode.adjacencyBondIds[i]!);
        if (!b || b.broken || b.nodeIdB === -1) continue;
        const vId = b.nodeIdA === uId ? b.nodeIdB : b.nodeIdA;
        if (visited[vId] === 0) {
          const vNode = this.nodes.get(vId);
          if (vNode && vNode.alive && vNode.islandId === 0 && !vNode.isCounterweight) {
            visited[vId] = 1;
            vNode.bfsDepth = nextDepth;
            queue[tail++] = vId;
          }
        }
      }
    }

    const detachedComponents: number[][] = [];

    for (const node of this.nodes.values()) {
      if (!node.alive || node.islandId !== 0 || node.isCounterweight) continue;
      if (visited[node.nodeId] !== 0) continue;

      const comp: number[] = [];
      let cHead = 0;
      let cTail = 0;
      visited[node.nodeId] = 2;
      queue[cTail++] = node.nodeId;

      while (cHead < cTail) {
        const curId = queue[cHead++]!;
        comp.push(curId);
        const curNode = this.nodes.get(curId);
        if (!curNode) continue;

        for (let i = 0; i < curNode.adjacencyBondIds.length; i++) {
          const b = this.bonds.get(curNode.adjacencyBondIds[i]!);
          if (!b || b.broken || b.nodeIdB === -1) continue;
          const nbId = b.nodeIdA === curId ? b.nodeIdB : b.nodeIdA;
          if (visited[nbId] === 0) {
            const nbNode = this.nodes.get(nbId);
            if (nbNode && nbNode.alive && nbNode.islandId === 0 && !nbNode.isCounterweight) {
              visited[nbId] = 2;
              queue[cTail++] = nbId;
            }
          }
        }
      }

      if (comp.length > 0) {
        comp.sort((a, b) => a - b);
        detachedComponents.push(comp);
      }
    }

    return detachedComponents;
  }

  /**
   * Проверяет связность уже оторванного динамического острова после разрушения узла или связи внутри него.
   */
  public findIslandSubcomponents(islandId: number, candidateNodeIds: readonly number[]): number[][] {
    const aliveIds: number[] = [];
    const aliveSet = new Set<number>();
    for (let i = 0; i < candidateNodeIds.length; i++) {
      const id = candidateNodeIds[i]!;
      const n = this.nodes.get(id);
      if (n && n.alive && n.islandId === islandId) {
        aliveIds.push(id);
        aliveSet.add(id);
      }
    }
    if (aliveIds.length <= 1) {
      return aliveIds.length === 1 ? [aliveIds] : [];
    }

    const seen = new Set<number>();
    const comps: number[][] = [];

    for (let i = 0; i < aliveIds.length; i++) {
      const startId = aliveIds[i]!;
      if (seen.has(startId)) continue;
      const comp: number[] = [];
      const q: number[] = [startId];
      seen.add(startId);
      let ptr = 0;
      while (ptr < q.length) {
        const uId = q[ptr++]!;
        comp.push(uId);
        const uNode = this.nodes.get(uId);
        if (!uNode) continue;
        for (let k = 0; k < uNode.adjacencyBondIds.length; k++) {
          const b = this.bonds.get(uNode.adjacencyBondIds[k]!);
          if (!b || b.broken || b.nodeIdB === -1) continue;
          const vId = b.nodeIdA === uId ? b.nodeIdB : b.nodeIdA;
          if (aliveSet.has(vId) && !seen.has(vId)) {
            seen.add(vId);
            q.push(vId);
          }
        }
      }
      comp.sort((a, b) => a - b);
      comps.push(comp);
    }

    return comps;
  }

  /**
   * Возвращает мировую точку центра пятна контакта связи.
   */
  public getBondWorldPoints(
    bond: StructuralBond,
    platformOffset: Vec3Tuple,
  ): { pointA: Vec3; pointB: Vec3; midpoint: Vec3 } {
    const nodeA = this.nodes.get(bond.nodeIdA);
    const pointA: Vec3 = nodeA
      ? vec3Add(nodeA.worldPos, quatRotateVec3(nodeA.worldQuat, bond.contactCenterLocalA))
      : [0, 0, 0];

    if (bond.nodeIdB === -1) {
      const pointB: Vec3 = [
        cleanZero(bond.contactCenterLocalB[0] + platformOffset[0]),
        cleanZero(bond.contactCenterLocalB[1] + platformOffset[1]),
        cleanZero(bond.contactCenterLocalB[2] + platformOffset[2]),
      ];
      const midpoint: Vec3 = nodeA ? pointB : pointA;
      return { pointA: nodeA ? nodeA.worldPos : pointA, pointB, midpoint };
    }

    const nodeB = this.nodes.get(bond.nodeIdB);
    const pointB: Vec3 = nodeB ? nodeB.worldPos : pointA;
    const midpoint = pointA;
    return {
      pointA: nodeA ? nodeA.worldPos : pointA,
      pointB,
      midpoint,
    };
  }

  /**
   * Ранжирует наиболее нагруженные ключевые несущие опоры для тактической разведки на рентгене.
   */
  public computeCriticalLoadBearingNodeIds(topK = 6): number[] {
    const limit = Math.max(0, Math.trunc(topK));
    if (limit === 0) {
      return [];
    }

    let hasTargetTag = false;
    for (const n of this.nodes.values()) {
      if (n.alive && !n.isCounterweight && n.structureGroupTag === 'target') {
        hasTargetTag = true;
        break;
      }
    }

    const eligible: StructuralNode[] = [];
    let totalWeightN = 0;
    let maxHeightY = 1.0;

    for (const n of this.nodes.values()) {
      if (!n.alive || n.islandId !== 0 || n.isCounterweight || n.materialId === 'explosive') {
        continue;
      }
      if (hasTargetTag && n.structureGroupTag !== 'target') {
        continue;
      }
      if (!hasTargetTag && n.structureGroupTag === 'protected') {
        continue;
      }
      eligible.push(n);
      totalWeightN += n.massKg * 9.81;
      if (n.initialTopY > maxHeightY) {
        maxHeightY = n.initialTopY;
      }
    }

    if (eligible.length === 0) {
      // Если в target ничего не осталось, рассматриваем любые живые закреплённые конструктивные узлы
      for (const n of this.nodes.values()) {
        if (n.alive && n.islandId === 0 && !n.isCounterweight && n.materialId !== 'explosive') {
          eligible.push(n);
          totalWeightN += n.massKg * 9.81;
          if (n.initialTopY > maxHeightY) {
            maxHeightY = n.initialTopY;
          }
        }
      }
    }

    if (eligible.length === 0) {
      return [];
    }

    // Оценка потока веса сверху вниз по убыванию bfsDepth (или координаты Y)
    const subtreeMass = new Map<number, number>();
    const sortedTopDown = eligible
      .slice()
      .sort((a, b) => b.localPlatformPos[1] - a.localPlatformPos[1] || b.bfsDepth - a.bfsDepth);

    for (let i = 0; i < sortedTopDown.length; i++) {
      subtreeMass.set(sortedTopDown[i]!.nodeId, sortedTopDown[i]!.massKg);
    }

    let maxSubtreeMass = 1;
    for (let i = 0; i < sortedTopDown.length; i++) {
      const u = sortedTopDown[i]!;
      const mHere = subtreeMass.get(u.nodeId) ?? u.massKg;
      if (mHere > maxSubtreeMass) maxSubtreeMass = mHere;

      const lowerSupports: number[] = [];
      for (let k = 0; k < u.adjacencyBondIds.length; k++) {
        const b = this.bonds.get(u.adjacencyBondIds[k]!);
        if (!b || b.broken || b.nodeIdB === -1) continue;
        const vId = b.nodeIdA === u.nodeId ? b.nodeIdB : b.nodeIdA;
        const v = this.nodes.get(vId);
        if (!v || !v.alive || v.islandId !== 0) continue;
        if (
          v.localPlatformPos[1] < u.localPlatformPos[1] - 0.05 ||
          (v.bfsDepth >= 0 && u.bfsDepth >= 0 && v.bfsDepth < u.bfsDepth)
        ) {
          lowerSupports.push(vId);
        }
      }
      if (lowerSupports.length > 0) {
        const share = mHere / lowerSupports.length;
        for (let s = 0; s < lowerSupports.length; s++) {
          const supId = lowerSupports[s]!;
          const updated = (subtreeMass.get(supId) ?? 0) + share;
          subtreeMass.set(supId, updated);
          if (updated > maxSubtreeMass) maxSubtreeMass = updated;
        }
      }
    }

    const denomW = Math.max(1, totalWeightN);
    const scored: Array<{ nodeId: number; score: number }> = [];

    for (let i = 0; i < eligible.length; i++) {
      const n = eligible[i]!;
      let compressiveFlowN = 0;
      let maxBondUtil = n.stressUtilization;
      let hasGround = false;

      for (let k = 0; k < n.adjacencyBondIds.length; k++) {
        const b = this.bonds.get(n.adjacencyBondIds[k]!);
        if (!b || b.broken) continue;
        if (b.nodeIdB === -1) {
          hasGround = true;
        }
        if (b.stressUtilization > maxBondUtil) {
          maxBondUtil = b.stressUtilization;
        }
        if (b.axialForceN < 0) {
          compressiveFlowN += -b.axialForceN;
        }
      }

      const subMassRatio = (subtreeMass.get(n.nodeId) ?? n.massKg) / maxSubtreeMass;
      const heightPenalty = Math.exp(-Math.max(0, n.localPlatformPos[1]) / Math.max(1, maxHeightY));
      const depthBonus = n.bfsDepth >= 0 ? 1 / (1 + n.bfsDepth) : 0;

      const score =
        0.42 * maxBondUtil +
        0.32 * (compressiveFlowN / denomW) +
        0.38 * subMassRatio +
        0.28 * (hasGround ? 1 : 0) +
        0.18 * depthBonus +
        0.12 * heightPenalty;

      scored.push({ nodeId: n.nodeId, score });
    }

    scored.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.nodeId - b.nodeId));
    const count = Math.min(limit, scored.length);
    const out: number[] = new Array(count);
    for (let i = 0; i < count; i++) {
      out[i] = scored[i]!.nodeId;
    }
    return out;
  }
}
