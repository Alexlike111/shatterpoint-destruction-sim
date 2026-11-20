import {
  cleanZero,
  quatRotateVec3,
  vec3Add,
  vec3Cross,
  vec3Dot,
  vec3Normalize,
  vec3Sub,
} from '../core/math3d';
import {
  FIXED_DT,
  type SimulationEvent,
  type StructuralMaterialId,
  type Vec3,
  type Vec3Tuple,
} from '../core/types';
import {
  computeThermalStiffnessRetention,
  computeThermalStrengthRetention,
  getMaterialProfile,
} from './MaterialRegistry';
import type { StructuralBond, StructuralGraph, StructuralNode } from './StructuralGraph';

/**
 * Пространственный 6-DOF решатель строительной механики балок Эйлера—Бернулли
 * на базе предобусловленного метода сопряжённых градиентов (PCG с тёплым стартом),
 * асимметричного критерия Ренкина—Мора—Кулона, устойчивости Эйлера и пластических шарниров стали.
 */

const POISSON_RATIO = 0.25;
const MAX_PCG_ITERATIONS = 32;
const PCG_REL_TOL = 1e-4;
const MAX_BONDS_BROKEN_PER_STEP = 24;
const IMPULSE_TAU_SEC = 2 * FIXED_DT;

export interface BrokenBondInfo {
  bond: StructuralBond;
  worldPoint: Vec3;
  hasRebarPotential: boolean;
  isSteelHingeRelease: boolean;
}

export interface StressSolveResult {
  maxStressUtilization: number;
  newlyBrokenBonds: BrokenBondInfo[];
  newlyFormedPlasticHingesCount: number;
  emittedEvents: SimulationEvent[];
  pcgIterations: number;
}

/**
 * Поворачивает локальный блок жёсткости 6×6 в мировую СК: K_world = T^T * K_loc * T,
 * где строки 3×3 матрицы R (rot9) являются ортами локальных осей элемента в мировых координатах (v_loc = R * v_world).
 */
function rotateStiffnessBlock6x6(
  kLoc36: Float64Array,
  rot9: Float64Array,
  outWorld36: Float64Array,
  scratch9A: Float64Array,
  scratch9B: Float64Array,
): void {
  // Разбиваем 6×6 на четыре подблока 3×3: (br ∈ {0, 3}, bc ∈ {0, 3})
  for (let br = 0; br < 6; br += 3) {
    for (let bc = 0; bc < 6; bc += 3) {
      // M = K_sub (3×3)
      for (let r = 0; r < 3; r++) {
        for (let c = 0; c < 3; c++) {
          scratch9A[r * 3 + c] = kLoc36[(br + r) * 6 + (bc + c)]!;
        }
      }
      // B = M * R (3×3): B[i, j] = sum_k M[i, k] * R[k, j]
      for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) {
          scratch9B[i * 3 + j] =
            scratch9A[i * 3]! * rot9[j]! +
            scratch9A[i * 3 + 1]! * rot9[3 + j]! +
            scratch9A[i * 3 + 2]! * rot9[6 + j]!;
        }
      }
      // W = R^T * B: W[i, j] = sum_k R[k, i] * B[k, j]
      for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) {
          outWorld36[(br + i) * 6 + (bc + j)] =
            rot9[i]! * scratch9B[j]! +
            rot9[3 + i]! * scratch9B[3 + j]! +
            rot9[6 + i]! * scratch9B[6 + j]!;
        }
      }
    }
  }
}

export class StressSolver {
  private uVec = new Float64Array(6 * 128);
  private fVec = new Float64Array(6 * 128);
  private rVec = new Float64Array(6 * 128);
  private zVec = new Float64Array(6 * 128);
  private pVec = new Float64Array(6 * 128);
  private apVec = new Float64Array(6 * 128);
  private diagVec = new Float64Array(6 * 128);
  private invDiagVec = new Float64Array(6 * 128);
  private nodeIdToDofSlot = new Int32Array(256);

  private readonly scratchLocAA = new Float64Array(36);
  private readonly scratchLocBB = new Float64Array(36);
  private readonly scratchLocAB = new Float64Array(36);
  private readonly scratch9A = new Float64Array(9);
  private readonly scratch9B = new Float64Array(9);
  private readonly scratchUA = new Float64Array(6);
  private readonly scratchUB = new Float64Array(6);

  private ensureCapacity(nodeCount: number, maxNodeId: number): void {
    const dofCount = Math.max(6, nodeCount * 6);
    if (this.uVec.length < dofCount) {
      const cap = Math.max(dofCount * 2, 768);
      this.uVec = new Float64Array(cap);
      this.fVec = new Float64Array(cap);
      this.rVec = new Float64Array(cap);
      this.zVec = new Float64Array(cap);
      this.pVec = new Float64Array(cap);
      this.apVec = new Float64Array(cap);
      this.diagVec = new Float64Array(cap);
      this.invDiagVec = new Float64Array(cap);
    }
    if (this.nodeIdToDofSlot.length <= maxNodeId) {
      this.nodeIdToDofSlot = new Int32Array(Math.max((maxNodeId + 1) * 2, 512));
    }
  }

  /**
   * Обновляет локальный базис и мировые блоки жёсткости 6×6 ребра при изменении температуры, целостности или шарнира.
   */
  private updateBondStiffnessIfNeeded(
    bond: StructuralBond,
    nodeA: StructuralNode,
    nodeB: StructuralNode | undefined,
  ): void {
    const tempB = nodeB ? nodeB.temperatureC : 20;
    const charB = nodeB ? nodeB.charRatio : 0;
    const needsRebuild =
      bond.dirtyStiffness ||
      Math.abs(nodeA.temperatureC - bond.lastTempA) > 1.5 ||
      Math.abs(tempB - bond.lastTempB) > 1.5 ||
      Math.abs(nodeA.charRatio - bond.lastCharA) > 0.01 ||
      Math.abs(charB - bond.lastCharB) > 0.01 ||
      Math.abs(bond.integrity - bond.lastIntegrity) > 0.005 ||
      bond.isPlasticHinge !== bond.lastPlasticFlag;

    if (!needsRebuild) {
      return;
    }

    const profA = getMaterialProfile(nodeA.materialId);
    const kEA = computeThermalStiffnessRetention(nodeA.materialId, nodeA.temperatureC, nodeA.charRatio);
    const eA = profA.youngsModulusGPa * 1e9 * kEA;

    let eEff: number;
    if (nodeB) {
      const profB = getMaterialProfile(nodeB.materialId);
      const kEB = computeThermalStiffnessRetention(nodeB.materialId, nodeB.temperatureC, nodeB.charRatio);
      const eB = profB.youngsModulusGPa * 1e9 * kEB;
      eEff = Math.max(1e5, bond.integrity) * ((2 * eA * eB) / Math.max(1, eA + eB));
    } else {
      eEff = Math.max(1e5, bond.integrity) * eA;
    }
    // Коррекция: bond.integrity ∈ [0.02, 1], а не 1e5!
    const safeIntegrity = Math.max(0.02, bond.integrity);
    if (nodeB) {
      const profB = getMaterialProfile(nodeB.materialId);
      const kEB = computeThermalStiffnessRetention(nodeB.materialId, nodeB.temperatureC, nodeB.charRatio);
      const eB = profB.youngsModulusGPa * 1e9 * kEB;
      eEff = safeIntegrity * ((2 * eA * eB) / Math.max(1, eA + eB));
    } else {
      eEff = safeIntegrity * eA;
    }

    const gEff = eEff / (2 * (1 + POISSON_RATIO));

    const areaEff = bond.isPlasticHinge ? bond.areaM2 * 0.65 : bond.areaM2;
    const bendScale = bond.isPlasticHinge ? 0.06 : 1.0;
    const torsScale = bond.isPlasticHinge ? 0.1 : 1.0;
    const iyEff = bond.iyM4 * bendScale;
    const izEff = bond.izM4 * bendScale;
    const jEff = bond.polarJM4 * torsScale;

    const L = Math.max(0.08, bond.lengthM);
    const L2 = L * L;
    const L3 = L2 * L;

    const ka = (eEff * areaEff) / L;
    const kt = (gEff * jEff) / L;
    const kby1 = (12 * eEff * izEff) / L3;
    const kby2 = (6 * eEff * izEff) / L2;
    const kby3 = (4 * eEff * izEff) / L;
    const kby4 = (2 * eEff * izEff) / L;
    const kbz1 = (12 * eEff * iyEff) / L3;
    const kbz2 = (6 * eEff * iyEff) / L2;
    const kbz3 = (4 * eEff * iyEff) / L;
    const kbz4 = (2 * eEff * iyEff) / L;

    bond.localCoeffs[0] = ka;
    bond.localCoeffs[1] = kt;
    bond.localCoeffs[2] = kby1;
    bond.localCoeffs[3] = kby2;
    bond.localCoeffs[4] = kby3;
    bond.localCoeffs[5] = kby4;
    bond.localCoeffs[6] = kbz1;
    bond.localCoeffs[7] = kbz2;
    bond.localCoeffs[8] = kbz3;
    bond.localCoeffs[9] = kbz4;

    // Строим правую ортонормированную тройку (ex, ey, ez) в СК платформы
    const posB = nodeB ? nodeB.localPlatformPos : bond.contactCenterLocalB;
    const ex = vec3Normalize(vec3Sub(posB, nodeA.localPlatformPos), [0, 1, 0]);
    const rawEy = quatRotateVec3(nodeA.localPlatformQuat, bond.tangentYLocalA);
    const projEy = vec3Dot(rawEy, ex);
    let ey = vec3Normalize([
      rawEy[0] - projEy * ex[0],
      rawEy[1] - projEy * ex[1],
      rawEy[2] - projEy * ex[2],
    ]);
    if (Math.abs(vec3Dot(ey, ex)) > 0.9) {
      const alt: Vec3 = Math.abs(ex[0]) < 0.85 ? [1, 0, 0] : [0, 0, 1];
      const pAlt = vec3Dot(alt, ex);
      ey = vec3Normalize([alt[0] - pAlt * ex[0], alt[1] - pAlt * ex[1], alt[2] - pAlt * ex[2]]);
    }
    const ez = vec3Normalize(vec3Cross(ex, ey));

    const r9 = bond.rot9;
    r9[0] = ex[0];
    r9[1] = ex[1];
    r9[2] = ex[2];
    r9[3] = ey[0];
    r9[4] = ey[1];
    r9[5] = ey[2];
    r9[6] = ez[0];
    r9[7] = ez[1];
    r9[8] = ez[2];

    const kAA = this.scratchLocAA;
    const kBB = this.scratchLocBB;
    const kAB = this.scratchLocAB;
    kAA.fill(0);
    kBB.fill(0);
    kAB.fill(0);

    // K_AA^loc
    kAA[0 * 6 + 0] = ka;
    kAA[1 * 6 + 1] = kby1;
    kAA[1 * 6 + 5] = kby2;
    kAA[5 * 6 + 1] = kby2;
    kAA[2 * 6 + 2] = kbz1;
    kAA[2 * 6 + 4] = -kbz2;
    kAA[4 * 6 + 2] = -kbz2;
    kAA[3 * 6 + 3] = kt;
    kAA[4 * 6 + 4] = kbz3;
    kAA[5 * 6 + 5] = kby3;

    // K_BB^loc
    kBB[0 * 6 + 0] = ka;
    kBB[1 * 6 + 1] = kby1;
    kBB[1 * 6 + 5] = -kby2;
    kBB[5 * 6 + 1] = -kby2;
    kBB[2 * 6 + 2] = kbz1;
    kBB[2 * 6 + 4] = kbz2;
    kBB[4 * 6 + 2] = kbz2;
    kBB[3 * 6 + 3] = kt;
    kBB[4 * 6 + 4] = kbz3;
    kBB[5 * 6 + 5] = kby3;

    // K_AB^loc
    kAB[0 * 6 + 0] = -ka;
    kAB[1 * 6 + 1] = -kby1;
    kAB[1 * 6 + 5] = kby2;
    kAB[2 * 6 + 2] = -kbz1;
    kAB[2 * 6 + 4] = -kbz2;
    kAB[3 * 6 + 3] = -kt;
    kAB[4 * 6 + 2] = kbz2;
    kAB[4 * 6 + 4] = kbz4;
    kAB[5 * 6 + 1] = -kby2;
    kAB[5 * 6 + 5] = kby4;

    rotateStiffnessBlock6x6(kAA, r9, bond.kAA, this.scratch9A, this.scratch9B);
    if (nodeB) {
      rotateStiffnessBlock6x6(kBB, r9, bond.kBB, this.scratch9A, this.scratch9B);
      rotateStiffnessBlock6x6(kAB, r9, bond.kAB, this.scratch9A, this.scratch9B);
    }

    bond.dirtyStiffness = false;
    bond.lastTempA = nodeA.temperatureC;
    bond.lastTempB = tempB;
    bond.lastCharA = nodeA.charRatio;
    bond.lastCharB = charB;
    bond.lastIntegrity = bond.integrity;
    bond.lastPlasticFlag = bond.isPlasticHinge;
  }

  /**
   * Выполняет полный цикл расчёта внутренних усилий, пластичности стали и разрыва перегруженных связей
   * для всех живых закреплённых на фундаменте узлов (islandId === 0).
   */
  public solve(params: {
    graph: StructuralGraph;
    gravityMpS2: number;
    jointStrengthMultiplier: number;
    platformOffset: Vec3Tuple;
    computeNodeSeismicAccel?: (node: StructuralNode) => Vec3;
  }): StressSolveResult {
    const {
      graph,
      gravityMpS2,
      jointStrengthMultiplier,
      platformOffset,
      computeNodeSeismicAccel,
    } = params;

    const nodesMap = graph.getNodesMap();
    const bondsMap = graph.getBondsMap();

    const activeNodes: StructuralNode[] = [];
    let maxNodeId = 0;

    for (const node of nodesMap.values()) {
      node.stressUtilization = 0;
      if (node.alive && node.islandId === 0 && !node.isCounterweight) {
        activeNodes.push(node);
        if (node.nodeId > maxNodeId) {
          maxNodeId = node.nodeId;
        }
      }
    }

    if (activeNodes.length === 0) {
      for (const bond of bondsMap.values()) {
        if (bond.broken) {
          bond.stressUtilization = 0;
        }
      }
      return {
        maxStressUtilization: 0,
        newlyBrokenBonds: [],
        newlyFormedPlasticHingesCount: 0,
        emittedEvents: [],
        pcgIterations: 0,
      };
    }

    this.ensureCapacity(activeNodes.length, maxNodeId);
    const slotMap = this.nodeIdToDofSlot;
    slotMap.fill(-1, 0, maxNodeId + 1);

    const nNodes = activeNodes.length;
    const nDof = nNodes * 6;
    const u = this.uVec;
    const f = this.fVec;
    const diag = this.diagVec;
    const invDiag = this.invDiagVec;

    f.fill(0, 0, nDof);
    diag.fill(0, 0, nDof);

    // 1. Заполняем вектор узловых нагрузок и тёплый старт uVec
    for (let idx = 0; idx < nNodes; idx++) {
      const node = activeNodes[idx]!;
      const base = idx * 6;
      slotMap[node.nodeId] = base;

      for (let d = 0; d < 6; d++) {
        u[base + d] = node.prevDisplacement6[d]!;
      }

      let fx = node.externalForceN[0] + node.pendingImpulseNs[0] / IMPULSE_TAU_SEC;
      let fy =
        -node.massKg * gravityMpS2 +
        node.externalForceN[1] +
        node.pendingImpulseNs[1] / IMPULSE_TAU_SEC;
      let fz = node.externalForceN[2] + node.pendingImpulseNs[2] / IMPULSE_TAU_SEC;

      if (computeNodeSeismicAccel) {
        const aSeis = computeNodeSeismicAccel(node);
        // Инерционная сила Даламбера -m * a_seismic
        fx -= node.massKg * aSeis[0];
        fy -= node.massKg * aSeis[1];
        fz -= node.massKg * aSeis[2];
      }

      f[base] = fx;
      f[base + 1] = fy;
      f[base + 2] = fz;
      f[base + 3] = 0;
      f[base + 4] = 0;
      f[base + 5] = 0;

      // Затухание импульса удара и сброс одношаговых контактных сил
      node.pendingImpulseNs[0] = cleanZero(node.pendingImpulseNs[0] * 0.25);
      node.pendingImpulseNs[1] = cleanZero(node.pendingImpulseNs[1] * 0.25);
      node.pendingImpulseNs[2] = cleanZero(node.pendingImpulseNs[2] * 0.25);
      node.externalForceN[0] = 0;
      node.externalForceN[1] = 0;
      node.externalForceN[2] = 0;
    }

    // 2. Отбираем активные рёбра закреплённого графа и обновляем их матрицы жёсткости
    const activeBonds: StructuralBond[] = [];
    for (const bond of bondsMap.values()) {
      if (bond.broken) {
        bond.stressUtilization = 0;
        bond.axialForceN = 0;
        bond.shearForceN = 0;
        bond.bendingMomentNm = 0;
        bond.torsionMomentNm = 0;
        continue;
      }
      const slotA = bond.nodeIdA <= maxNodeId ? slotMap[bond.nodeIdA]! : -1;
      if (slotA === -1) {
        // Связь принадлежит уже оторванному динамическому острову
        bond.stressUtilization = cleanZero(bond.stressUtilization * 0.85);
        continue;
      }

      if (bond.nodeIdB === -1) {
        const nodeA = nodesMap.get(bond.nodeIdA)!;
        this.updateBondStiffnessIfNeeded(bond, nodeA, undefined);
        activeBonds.push(bond);
        for (let d = 0; d < 6; d++) {
          diag[slotA + d] += bond.kAA[d * 6 + d]!;
        }
      } else {
        const slotB = bond.nodeIdB <= maxNodeId ? slotMap[bond.nodeIdB]! : -1;
        if (slotB === -1) {
          continue;
        }
        const nodeA = nodesMap.get(bond.nodeIdA)!;
        const nodeB = nodesMap.get(bond.nodeIdB)!;
        this.updateBondStiffnessIfNeeded(bond, nodeA, nodeB);
        activeBonds.push(bond);
        for (let d = 0; d < 6; d++) {
          diag[slotA + d] += bond.kAA[d * 6 + d]!;
          diag[slotB + d] += bond.kBB[d * 6 + d]!;
        }
      }
    }

    if (activeBonds.length === 0) {
      return {
        maxStressUtilization: 0,
        newlyBrokenBonds: [],
        newlyFormedPlasticHingesCount: 0,
        emittedEvents: [],
        pcgIterations: 0,
      };
    }

    // Микро-регуляризация диагонали для строгой положительной определённости (SPD) и предобуславливатель Якоби
    for (let idx = 0; idx < nNodes; idx++) {
      const base = idx * 6;
      const maxTrans = Math.max(1e3, diag[base]!, diag[base + 1]!, diag[base + 2]!);
      const maxRot = Math.max(1e2, diag[base + 3]!, diag[base + 4]!, diag[base + 5]!);
      const regTrans = maxTrans * 1e-4;
      const regRot = maxRot * 1e-4;
      for (let d = 0; d < 3; d++) {
        diag[base + d] += regTrans;
        invDiag[base + d] = 1 / diag[base + d]!;
      }
      for (let d = 3; d < 6; d++) {
        diag[base + d] += regRot;
        invDiag[base + d] = 1 / diag[base + d]!;
      }
    }

    // Функция матрично-векторного умножения out = K * x без сборки CSR
    const multiplyK = (x: Float64Array, out: Float64Array): void => {
      for (let i = 0; i < nNodes; i++) {
        const base = i * 6;
        const maxTrans = Math.max(1e3, diag[base]!, diag[base + 1]!, diag[base + 2]!);
        const maxRot = Math.max(1e2, diag[base + 3]!, diag[base + 4]!, diag[base + 5]!);
        const regT = maxTrans * 1e-4;
        const regR = maxRot * 1e-4;
        out[base] = regT * x[base]!;
        out[base + 1] = regT * x[base + 1]!;
        out[base + 2] = regT * x[base + 2]!;
        out[base + 3] = regR * x[base + 3]!;
        out[base + 4] = regR * x[base + 4]!;
        out[base + 5] = regR * x[base + 5]!;
      }

      for (let e = 0; e < activeBonds.length; e++) {
        const b = activeBonds[e]!;
        const sA = slotMap[b.nodeIdA]!;
        const kAA = b.kAA;

        if (b.nodeIdB === -1) {
          for (let r = 0; r < 6; r++) {
            const rowOff = r * 6;
            out[sA + r] +=
              kAA[rowOff]! * x[sA]! +
              kAA[rowOff + 1]! * x[sA + 1]! +
              kAA[rowOff + 2]! * x[sA + 2]! +
              kAA[rowOff + 3]! * x[sA + 3]! +
              kAA[rowOff + 4]! * x[sA + 4]! +
              kAA[rowOff + 5]! * x[sA + 5]!;
          }
        } else {
          const sB = slotMap[b.nodeIdB]!;
          const kBB = b.kBB;
          const kAB = b.kAB;
          for (let r = 0; r < 6; r++) {
            const rowOff = r * 6;
            out[sA + r] +=
              kAA[rowOff]! * x[sA]! +
              kAA[rowOff + 1]! * x[sA + 1]! +
              kAA[rowOff + 2]! * x[sA + 2]! +
              kAA[rowOff + 3]! * x[sA + 3]! +
              kAA[rowOff + 4]! * x[sA + 4]! +
              kAA[rowOff + 5]! * x[sA + 5]! +
              kAB[rowOff]! * x[sB]! +
              kAB[rowOff + 1]! * x[sB + 1]! +
              kAB[rowOff + 2]! * x[sB + 2]! +
              kAB[rowOff + 3]! * x[sB + 3]! +
              kAB[rowOff + 4]! * x[sB + 4]! +
              kAB[rowOff + 5]! * x[sB + 5]!;

            out[sB + r] +=
              kBB[rowOff]! * x[sB]! +
              kBB[rowOff + 1]! * x[sB + 1]! +
              kBB[rowOff + 2]! * x[sB + 2]! +
              kBB[rowOff + 3]! * x[sB + 3]! +
              kBB[rowOff + 4]! * x[sB + 4]! +
              kBB[rowOff + 5]! * x[sB + 5]! +
              kAB[0 * 6 + r]! * x[sA]! +
              kAB[1 * 6 + r]! * x[sA + 1]! +
              kAB[2 * 6 + r]! * x[sA + 2]! +
              kAB[3 * 6 + r]! * x[sA + 3]! +
              kAB[4 * 6 + r]! * x[sA + 4]! +
              kAB[5 * 6 + r]! * x[sA + 5]!;
          }
        }
      }
    };

    // 3. Запуск PCG с тёплым стартом
    let fNormSq = 0;
    for (let i = 0; i < nDof; i++) {
      fNormSq += f[i]! * f[i]!;
    }

    let pcgIters = 0;
    if (fNormSq < 1e-12) {
      u.fill(0, 0, nDof);
    } else {
      const r = this.rVec;
      const z = this.zVec;
      const p = this.pVec;
      const ap = this.apVec;

      multiplyK(u, ap);
      let rNormSq = 0;
      let rz = 0;
      for (let i = 0; i < nDof; i++) {
        const ri = f[i]! - ap[i]!;
        r[i] = ri;
        rNormSq += ri * ri;
        const zi = ri * invDiag[i]!;
        z[i] = zi;
        p[i] = zi;
        rz += ri * zi;
      }

      // Если тёплый старт сильно разошёлся (например, после резкого удара), обнуляем начальное приближение
      if (!Number.isFinite(rNormSq) || rNormSq > fNormSq * 1e6) {
        u.fill(0, 0, nDof);
        rNormSq = fNormSq;
        rz = 0;
        for (let i = 0; i < nDof; i++) {
          const ri = f[i]!;
          r[i] = ri;
          const zi = ri * invDiag[i]!;
          z[i] = zi;
          p[i] = zi;
          rz += ri * zi;
        }
      }

      const stopTolSq = PCG_REL_TOL * PCG_REL_TOL * fNormSq;

      while (pcgIters < MAX_PCG_ITERATIONS && rNormSq > stopTolSq) {
        multiplyK(p, ap);
        let pAp = 0;
        for (let i = 0; i < nDof; i++) {
          pAp += p[i]! * ap[i]!;
        }
        if (pAp <= 1e-24 || !Number.isFinite(pAp)) {
          break;
        }
        const alpha = rz / pAp;
        rNormSq = 0;
        let rzNext = 0;
        for (let i = 0; i < nDof; i++) {
          u[i] += alpha * p[i]!;
          const ri = r[i]! - alpha * ap[i]!;
          r[i] = ri;
          rNormSq += ri * ri;
          const zi = ri * invDiag[i]!;
          z[i] = zi;
          rzNext += ri * zi;
        }
        pcgIters++;
        if (rNormSq <= stopTolSq || rz <= 1e-30) {
          break;
        }
        const beta = rzNext / rz;
        rz = rzNext;
        for (let i = 0; i < nDof; i++) {
          p[i] = z[i]! + beta * p[i]!;
        }
      }
    }

    // Сохраняем решение для тёплого старта следующего тика
    for (let idx = 0; idx < nNodes; idx++) {
      const node = activeNodes[idx]!;
      const base = idx * 6;
      for (let d = 0; d < 6; d++) {
        const val = u[base + d]!;
        node.prevDisplacement6[d] = Number.isFinite(val) ? val : 0;
      }
    }

    // 4. Извлечение внутренних усилий на каждом ребре и проверка прочности / пластичности
    let maxStressUtilization = 0;
    let newlyFormedPlasticHingesCount = 0;
    const emittedEvents: SimulationEvent[] = [];
    const breakCandidates: Array<{
      bond: StructuralBond;
      utilization: number;
      worldPoint: Vec3;
      hasRebarPotential: boolean;
      isSteelHingeRelease: boolean;
    }> = [];

    const uALoc = this.scratchUA;
    const uBLoc = this.scratchUB;
    const safeStrengthMult = Math.max(0.1, jointStrengthMultiplier);

    for (let e = 0; e < activeBonds.length; e++) {
      const bond = activeBonds[e]!;
      const nodeA = nodesMap.get(bond.nodeIdA)!;
      const nodeB = bond.nodeIdB !== -1 ? nodesMap.get(bond.nodeIdB) : undefined;
      const sA = slotMap[bond.nodeIdA]!;
      const r9 = bond.rot9;

      // Перевод u_A в локальный базис элемента: u_loc = R * u_world
      for (let off = 0; off < 6; off += 3) {
        const wx = u[sA + off]!;
        const wy = u[sA + off + 1]!;
        const wz = u[sA + off + 2]!;
        uALoc[off] = r9[0]! * wx + r9[1]! * wy + r9[2]! * wz;
        uALoc[off + 1] = r9[3]! * wx + r9[4]! * wy + r9[5]! * wz;
        uALoc[off + 2] = r9[6]! * wx + r9[7]! * wy + r9[8]! * wz;
      }

      if (nodeB) {
        const sB = slotMap[bond.nodeIdB]!;
        for (let off = 0; off < 6; off += 3) {
          const wx = u[sB + off]!;
          const wy = u[sB + off + 1]!;
          const wz = u[sB + off + 2]!;
          uBLoc[off] = r9[0]! * wx + r9[1]! * wy + r9[2]! * wz;
          uBLoc[off + 1] = r9[3]! * wx + r9[4]! * wy + r9[5]! * wz;
          uBLoc[off + 2] = r9[6]! * wx + r9[7]! * wy + r9[8]! * wz;
        }
      } else {
        uBLoc.fill(0);
      }

      const c = bond.localCoeffs;
      const ka = c[0]!;
      const kt = c[1]!;
      const kby1 = c[2]!;
      const kby2 = c[3]!;
      const kby3 = c[4]!;
      const kby4 = c[5]!;
      const kbz1 = c[6]!;
      const kbz2 = c[7]!;
      const kbz3 = c[8]!;
      const kbz4 = c[9]!;

      // Продольная сила (> 0 растяжение, < 0 сжатие)
      const axialN = ka * (uBLoc[0]! - uALoc[0]!);
      const vy = kby1 * (uALoc[1]! - uBLoc[1]!) + kby2 * (uALoc[5]! + uBLoc[5]!);
      const vz = kbz1 * (uALoc[2]! - uBLoc[2]!) - kbz2 * (uALoc[4]! + uBLoc[4]!);
      const shearN = Math.hypot(vy, vz);
      const torsionNm = kt * (uBLoc[3]! - uALoc[3]!);

      const myA = -kbz2 * (uALoc[2]! - uBLoc[2]!) + kbz3 * uALoc[4]! + kbz4 * uBLoc[4]!;
      const myB = -kbz2 * (uALoc[2]! - uBLoc[2]!) + kbz4 * uALoc[4]! + kbz3 * uBLoc[4]!;
      const mzA = kby2 * (uALoc[1]! - uBLoc[1]!) + kby3 * uALoc[5]! + kby4 * uBLoc[5]!;
      const mzB = kby2 * (uALoc[1]! - uBLoc[1]!) + kby4 * uALoc[5]! + kby3 * uBLoc[5]!;

      let myEff: number;
      let mzEff: number;
      if (bond.nodeIdB === -1) {
        myEff = Math.max(Math.abs(myB), 0.75 * Math.abs(myA));
        mzEff = Math.max(Math.abs(mzB), 0.75 * Math.abs(mzA));
      } else {
        myEff = Math.max(0.5 * Math.abs(myA - myB), 0.65 * Math.max(Math.abs(myA), Math.abs(myB)));
        mzEff = Math.max(0.5 * Math.abs(mzA - mzB), 0.65 * Math.max(Math.abs(mzA), Math.abs(mzB)));
      }

      bond.axialForceN = cleanZero(axialN);
      bond.shearForceN = cleanZero(shearN);
      bond.bendingMomentNm = cleanZero(Math.hypot(myEff, mzEff));
      bond.torsionMomentNm = cleanZero(Math.abs(torsionNm));

      // Расчёт предельных сопротивлений шва с учётом температуры и обугливания
      const matA: StructuralMaterialId = nodeA.materialId;
      const profA = getMaterialProfile(matA);
      const kStrA = computeThermalStrengthRetention(matA, nodeA.temperatureC, nodeA.charRatio);

      let ftMPa = profA.tensileStrengthMPa * kStrA;
      let fcMPa = profA.compressiveStrengthMPa * kStrA;
      let tau0MPa = profA.shearCohesionMPa * kStrA;
      let mu = profA.internalFrictionCoeff;
      let eBucklePa =
        profA.youngsModulusGPa *
        1e9 *
        computeThermalStiffnessRetention(matA, nodeA.temperatureC, nodeA.charRatio);
      let isSteelJoint = matA === 'steel';
      let hasRebar = profA.hasRebarTethers;

      if (nodeB) {
        const matB = nodeB.materialId;
        const profB = getMaterialProfile(matB);
        const kStrB = computeThermalStrengthRetention(matB, nodeB.temperatureC, nodeB.charRatio);
        ftMPa = Math.min(ftMPa, profB.tensileStrengthMPa * kStrB);
        fcMPa = Math.min(fcMPa, profB.compressiveStrengthMPa * kStrB);
        tau0MPa = Math.min(tau0MPa, profB.shearCohesionMPa * kStrB);
        mu = Math.min(mu, profB.internalFrictionCoeff);
        const eBPa =
          profB.youngsModulusGPa *
          1e9 *
          computeThermalStiffnessRetention(matB, nodeB.temperatureC, nodeB.charRatio);
        eBucklePa = Math.min(eBucklePa, eBPa);
        isSteelJoint = isSteelJoint && matB === 'steel';
        hasRebar = hasRebar && profB.hasRebarTethers;
      }

      const scaleFactor = safeStrengthMult * Math.max(0.01, bond.integrity) * 1e6;
      const ftPa = Math.max(1e2, ftMPa * scaleFactor);
      const fcPa = Math.max(1e2, fcMPa * scaleFactor);
      const tau0Pa = Math.max(1e2, tau0MPa * scaleFactor);

      // Если деревянный узел полностью выгорел (kStr === 0), прочность падает в 0 -> гарантированный разрыв
      const burnedOut =
        kStrA <= 0.005 ||
        (nodeB !== undefined &&
          computeThermalStrengthRetention(nodeB.materialId, nodeB.temperatureC, nodeB.charRatio) <=
            0.005);

      // Для прокатных стальных двутавров / ферм эффективная площадь стенки и полок составляет ~8.5% габаритного AABB
      const sectionFill = isSteelJoint ? 0.085 : 1.0;
      const effArea = Math.max(1e-5, bond.areaM2 * sectionFill);
      const effWy = Math.max(1e-6, bond.sectionModulusWyM3 * sectionFill);
      const effWz = Math.max(1e-6, bond.sectionModulusWzM3 * sectionFill);
      const effWp = Math.max(1e-6, bond.torsionModulusWpM3 * sectionFill);

      const sigmaAxial = axialN / effArea;
      const sigmaBend = myEff / effWy + mzEff / effWz;

      const sigmaMaxT = Math.max(0, sigmaAxial + sigmaBend);
      const etaT = sigmaMaxT / ftPa;

      const minI = Math.min(bond.iyM4, bond.izM4) * sectionFill;
      const effLen = 0.85 * bond.lengthM;
      const eulerPcr = Math.max(1e3, (Math.PI * Math.PI * eBucklePa * minI) / (effLen * effLen));
      const phiBuckling = 1 / (1 + Math.max(0, -axialN) / eulerPcr);

      const sigmaMaxC = Math.max(0, -sigmaAxial + sigmaBend);
      const etaC = sigmaMaxC / Math.max(1e2, phiBuckling * fcPa);

      const tauApplied = shearN / effArea + Math.abs(torsionNm) / effWp;
      const normalClampCompression = Math.min(0.6 * fcPa, Math.max(0, -sigmaAxial));
      const tauAllow = tau0Pa + mu * normalClampCompression;
      const etaS = tauApplied / Math.max(1e2, tauAllow);

      let eta: number;
      if (burnedOut) {
        eta = 5.0;
      } else if (isSteelJoint) {
        const maxNorm = Math.max(etaT, etaC);
        eta = Math.hypot(maxNorm, etaS);
      } else {
        eta = Math.max(etaT, etaC, Math.hypot(etaS, 0.5916 * etaT));
      }

      if (!Number.isFinite(eta) || eta < 0) {
        eta = 0;
      }

      bond.stressUtilization = cleanZero(eta);
      if (eta > maxStressUtilization) {
        maxStressUtilization = eta;
      }
      if (eta > nodeA.stressUtilization) {
        nodeA.stressUtilization = cleanZero(eta);
      }
      if (nodeB && eta > nodeB.stressUtilization) {
        nodeB.stressUtilization = cleanZero(eta);
      }

      const contactWorldPos: Vec3 = vec3Add(
        nodeA.worldPos,
        quatRotateVec3(nodeA.worldQuat, bond.contactCenterLocalA),
      );
      if (bond.nodeIdB === -1) {
        contactWorldPos[0] = cleanZero(bond.contactCenterLocalB[0] + platformOffset[0]);
        contactWorldPos[1] = cleanZero(bond.contactCenterLocalB[1] + platformOffset[1]);
        contactWorldPos[2] = cleanZero(bond.contactCenterLocalB[2] + platformOffset[2]);
      }

      if (isSteelJoint) {
        const yieldRatio = profA.plasticYieldRatio; // 0.725
        if (eta >= yieldRatio) {
          const deltaAngle = Math.min(0.085, (eta - yieldRatio) * 0.065 + 0.012);
          bond.plasticAngleRad = cleanZero(bond.plasticAngleRad + deltaAngle);
          if (!bond.isPlasticHinge) {
            bond.isPlasticHinge = true;
            bond.dirtyStiffness = true;
            newlyFormedPlasticHingesCount++;
          }
          if (!bond.emittedSteelYield) {
            bond.emittedSteelYield = true;
            emittedEvents.push({
              type: 'steel_yield',
              position: [contactWorldPos[0], contactWorldPos[1], contactWorldPos[2]],
              angleRad: Math.max(0.02, bond.plasticAngleRad),
            });
          }
          // Внутри стальной рамы пластический шарнир работает с пониженной изгибной жёсткостью (bendScale = 0.06)
          // и отпускает монолитный шов в динамический RevoluteImpulseJoint при накоплении угла >= 0.38 рад или eta >= 2.2
          if (eta >= 2.2 || bond.plasticAngleRad >= 0.38) {
            breakCandidates.push({
              bond,
              utilization: eta,
              worldPoint: contactWorldPos,
              hasRebarPotential: false,
              isSteelHingeRelease: bond.plasticAngleRad < 0.52 && eta < 15.0,
            });
          }
        }
      } else if (eta >= 1.0) {
        breakCandidates.push({
          bond,
          utilization: eta,
          worldPoint: contactWorldPos,
          hasRebarPotential: hasRebar,
          isSteelHingeRelease: false,
        });
      }
    }

    // 5. Сортируем кандидатов на разрыв по убыванию перегрузки и разрываем до MAX_BONDS_BROKEN_PER_STEP швов
    const newlyBrokenBonds: BrokenBondInfo[] = [];
    if (breakCandidates.length > 0) {
      breakCandidates.sort((a, b) =>
        b.utilization !== a.utilization
          ? b.utilization - a.utilization
          : a.bond.bondId - b.bond.bondId,
      );
      const count = Math.min(MAX_BONDS_BROKEN_PER_STEP, breakCandidates.length);
      for (let i = 0; i < count; i++) {
        const cand = breakCandidates[i]!;
        cand.bond.broken = true;
        cand.bond.integrity = 0;
        cand.bond.concreteCracked = cand.hasRebarPotential;
        newlyBrokenBonds.push({
          bond: cand.bond,
          worldPoint: cand.worldPoint,
          hasRebarPotential: cand.hasRebarPotential,
          isSteelHingeRelease: cand.isSteelHingeRelease,
        });
      }
    }

    return {
      maxStressUtilization: cleanZero(maxStressUtilization),
      newlyBrokenBonds,
      newlyFormedPlasticHingesCount,
      emittedEvents,
      pcgIterations: pcgIters,
    };
  }
}
