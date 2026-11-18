import { clamp, cleanZero, vec3Dist } from '../core/math3d';
import {
  AMBIENT_TEMPERATURE_C,
  type SimulationEvent,
  type Vec3,
  type Vec3Tuple,
} from '../core/types';
import {
  getMaterialProfile,
  isIgnitionTriggered,
  isThermalDetonationTriggered,
  isThermalShockTriggered,
} from './MaterialRegistry';
import type { StructuralGraph, StructuralNode } from './StructuralGraph';

/**
 * Трёхмерная система теплопередачи, горения дерева, конвективной тяги вверх (+Y),
 * термошока калёного стекла, ослабления стали и тепловой детонации взрывоопасных ёмкостей (BLEVE).
 */

interface ActiveThermiteZone {
  center: Vec3;
  radiusM: number;
  peakTempC: number;
  remainingSec: number;
  seededNodeIds: Set<number>;
}

export interface ThermalStepResult {
  emittedEvents: SimulationEvent[];
  thermalShockNodeIds: number[];
  thermalDetonationNodeIds: number[];
  burnedOutNodeIds: number[];
  burningNodeCount: number;
  maxTemperatureC: number;
}

const MAX_SIM_TEMP_C = 1200;
const FLAME_EQUILIBRIUM_TEMP_C = 790;
const CONDUCTION_ACCEL = 380;
const PLUME_HEAT_COEFF = 2.6;

export class ThermalFireSystem {
  private readonly thermiteZones: ActiveThermiteZone[] = [];
  private deltaTempScratch = new Float64Array(256);

  public clear(): void {
    this.thermiteZones.length = 0;
  }

  /**
   * Мгновенно засевает сферическую область высокотемпературным термитом / зажигательным составом.
   * Блоки внутри первичного радиуса нагреваются и воспламеняются немедленно (даже при fireSpreadMultiplier === 0).
   */
  public igniteArea(params: {
    graph: StructuralGraph;
    center: Vec3Tuple;
    radiusM: number;
    temperatureC?: number;
  }): {
    emittedEvents: SimulationEvent[];
    thermalShockNodeIds: number[];
    thermalDetonationNodeIds: number[];
  } {
    const { graph, center } = params;
    const radiusM = Math.max(0.15, Number.isFinite(params.radiusM) ? params.radiusM : 2.5);
    const peakTempC = clamp(
      Number.isFinite(params.temperatureC) ? params.temperatureC! : 850,
      AMBIENT_TEMPERATURE_C,
      MAX_SIM_TEMP_C,
    );

    const emittedEvents: SimulationEvent[] = [];
    const thermalShockNodeIds: number[] = [];
    const thermalDetonationNodeIds: number[] = [];
    const seededNodeIds = new Set<number>();

    for (const node of graph.getNodesMap().values()) {
      if (!node.alive || node.isCounterweight) continue;
      const d = this.distanceToNodeSurfaceApprox(center, node);
      if (d > radiusM) continue;

      seededNodeIds.add(node.nodeId);
      const falloff = 1 - 0.38 * (d / radiusM);
      const targetTemp = clamp(peakTempC * falloff, AMBIENT_TEMPERATURE_C, MAX_SIM_TEMP_C);
      const prevTemp = node.temperatureC;

      if (targetTemp > node.temperatureC) {
        node.temperatureC = cleanZero(targetTemp);
        this.markAdjacentBondsDirty(graph, node);
      }

      const deltaT = Math.max(0, node.temperatureC - prevTemp);

      if (!node.burning && node.fuelRemaining > 0.02 && isIgnitionTriggered(node.materialId, node.temperatureC)) {
        node.burning = true;
        emittedEvents.push({
          type: 'fire_ignited',
          nodeId: node.nodeId,
          position: [node.worldPos[0], node.worldPos[1], node.worldPos[2]],
        });
      }

      if (isThermalDetonationTriggered(node.materialId, node.temperatureC)) {
        thermalDetonationNodeIds.push(node.nodeId);
      } else if (isThermalShockTriggered(node.materialId, node.temperatureC, deltaT)) {
        thermalShockNodeIds.push(node.nodeId);
      }
    }

    this.thermiteZones.push({
      center: [cleanZero(center[0]), cleanZero(center[1]), cleanZero(center[2])],
      radiusM,
      peakTempC,
      remainingSec: 4.0,
      seededNodeIds,
    });

    return {
      emittedEvents,
      thermalShockNodeIds,
      thermalDetonationNodeIds,
    };
  }

  /**
   * Локальный нагрев одного узла (например, от плазморезака, эпицентра фугаса или удара горящей балки).
   */
  public heatNode(
    graph: StructuralGraph,
    node: StructuralNode,
    addedTempC: number,
    maxCapTempC = MAX_SIM_TEMP_C,
  ): {
    ignitedEvent: SimulationEvent | null;
    thermalShock: boolean;
    thermalDetonation: boolean;
  } {
    if (!node.alive || addedTempC <= 0) {
      return { ignitedEvent: null, thermalShock: false, thermalDetonation: false };
    }
    const prevTemp = node.temperatureC;
    node.temperatureC = cleanZero(clamp(prevTemp + addedTempC, AMBIENT_TEMPERATURE_C, maxCapTempC));
    const deltaT = node.temperatureC - prevTemp;
    if (deltaT > 1.0) {
      this.markAdjacentBondsDirty(graph, node);
    }

    let ignitedEvent: SimulationEvent | null = null;
    if (!node.burning && node.fuelRemaining > 0.02 && isIgnitionTriggered(node.materialId, node.temperatureC)) {
      node.burning = true;
      ignitedEvent = {
        type: 'fire_ignited',
        nodeId: node.nodeId,
        position: [node.worldPos[0], node.worldPos[1], node.worldPos[2]],
      };
    }

    const thermalDetonation = isThermalDetonationTriggered(node.materialId, node.temperatureC);
    const thermalShock =
      !thermalDetonation && isThermalShockTriggered(node.materialId, node.temperatureC, deltaT);

    return { ignitedEvent, thermalShock, thermalDetonation };
  }

  /**
   * Интегрирует теплопередачу (кондукция + конвекция вверх + выгорание) на шаге dtSec.
   */
  public step(
    graph: StructuralGraph,
    dtSec: number,
    fireSpreadMultiplier: number,
  ): ThermalStepResult {
    const spreadMult = clamp(
      Number.isFinite(fireSpreadMultiplier) ? fireSpreadMultiplier : 1.0,
      0.0,
      4.0,
    );

    const nodesMap = graph.getNodesMap();
    const bondsMap = graph.getBondsMap();
    const aliveNodes: StructuralNode[] = [];
    let maxNodeId = 0;

    for (const node of nodesMap.values()) {
      if (!node.alive) continue;
      aliveNodes.push(node);
      if (node.nodeId > maxNodeId) {
        maxNodeId = node.nodeId;
      }
    }

    if (this.deltaTempScratch.length <= maxNodeId) {
      this.deltaTempScratch = new Float64Array(Math.max((maxNodeId + 1) * 2, 512));
    }
    const dTemp = this.deltaTempScratch;
    dTemp.fill(0, 0, maxNodeId + 1);

    // 1. Подпитка активных термитных зон
    for (let z = this.thermiteZones.length - 1; z >= 0; z--) {
      const zone = this.thermiteZones[z]!;
      zone.remainingSec -= dtSec;
      if (zone.remainingSec <= 0) {
        this.thermiteZones.splice(z, 1);
        continue;
      }
      for (let i = 0; i < aliveNodes.length; i++) {
        const node = aliveNodes[i]!;
        if (node.isCounterweight) continue;
        // При spreadMult === 0 термитный очаг поддерживает только изначально зажжённые им блоки, не расползаясь
        if (spreadMult <= 0 && !zone.seededNodeIds.has(node.nodeId)) {
          continue;
        }
        const dist = this.distanceToNodeSurfaceApprox(zone.center, node);
        if (dist <= zone.radiusM) {
          const holdTemp = zone.peakTempC * (1 - 0.35 * (dist / zone.radiusM));
          if (node.temperatureC < holdTemp) {
            dTemp[node.nodeId] += (holdTemp - node.temperatureC) * Math.min(1, dtSec * 4.5);
          }
        }
      }
    }

    // 2. Межблочная теплопередача строго масштабируется на spreadMult (при spreadMult === 0 равна 0!)
    if (spreadMult > 0) {
      // 2А. Кондукция через активные строительные связи
      for (const bond of bondsMap.values()) {
        if (bond.broken || bond.nodeIdB === -1) continue;
        const nA = nodesMap.get(bond.nodeIdA);
        const nB = nodesMap.get(bond.nodeIdB);
        if (!nA || !nB || !nA.alive || !nB.alive) continue;

        const diff = nB.temperatureC - nA.temperatureC;
        if (Math.abs(diff) < 0.25) continue;

        const pA = getMaterialProfile(nA.materialId);
        const pB = getMaterialProfile(nB.materialId);
        const lambdaEff = (2 * pA.thermalConductivity * pB.thermalConductivity) /
          Math.max(0.05, pA.thermalConductivity + pB.thermalConductivity);

        const fluxPower =
          spreadMult *
          CONDUCTION_ACCEL *
          lambdaEff *
          (bond.areaM2 / Math.max(0.15, bond.lengthM)) *
          diff;

        const capA = Math.max(40, nA.massKg * 0.85);
        const capB = Math.max(40, nB.massKg * 0.85);
        dTemp[nA.nodeId] += (fluxPower / capA) * dtSec;
        dTemp[nB.nodeId] -= (fluxPower / capB) * dtSec;
      }

      // 2Б. Конвективный факел вверх (+Y) и боковое тепловое излучение от горящих и раскалённых узлов
      const hotSources: StructuralNode[] = [];
      for (let i = 0; i < aliveNodes.length; i++) {
        const n = aliveNodes[i]!;
        if (n.burning || n.temperatureC > 300) {
          hotSources.push(n);
        }
      }

      if (hotSources.length > 0) {
        // Индексируем приёмники в пространственную сетку с ячейкой 2.5 м для O(1) выборки соседей
        const cell = 2.5;
        const spatial = new Map<string, StructuralNode[]>();
        for (let i = 0; i < aliveNodes.length; i++) {
          const n = aliveNodes[i]!;
          if (n.isCounterweight) continue;
          const kx = Math.floor(n.worldPos[0] / cell);
          const ky = Math.floor(n.worldPos[1] / cell);
          const kz = Math.floor(n.worldPos[2] / cell);
          const key = `${kx},${ky},${kz}`;
          let arr = spatial.get(key);
          if (!arr) {
            arr = [];
            spatial.set(key, arr);
          }
          arr.push(n);
        }

        const radHoriz = 2.9;
        const maxUpY = 4.6;
        const maxDownY = 0.85;

        for (let s = 0; s < hotSources.length; s++) {
          const src = hotSources[s]!;
          const sx = src.worldPos[0];
          const sy = src.worldPos[1];
          const sz = src.worldPos[2];

          const ix0 = Math.floor((sx - radHoriz) / cell);
          const ix1 = Math.floor((sx + radHoriz) / cell);
          const iy0 = Math.floor((sy - maxDownY) / cell);
          const iy1 = Math.floor((sy + maxUpY) / cell);
          const iz0 = Math.floor((sz - radHoriz) / cell);
          const iz1 = Math.floor((sz + radHoriz) / cell);

          for (let ix = ix0; ix <= ix1; ix++) {
            for (let iy = iy0; iy <= iy1; iy++) {
              for (let iz = iz0; iz <= iz1; iz++) {
                const bucket = spatial.get(`${ix},${iy},${iz}`);
                if (!bucket) continue;
                for (let b = 0; b < bucket.length; b++) {
                  const dst = bucket[b]!;
                  if (dst.nodeId === src.nodeId) continue;
                  if (src.temperatureC <= dst.temperatureC + 2) continue;

                  const dy = dst.worldPos[1] - sy;
                  if (dy < -maxDownY || dy > maxUpY) continue;

                  // Поверхностно-габаритное расстояние между центрами с учётом полуразмеров
                  const gapDx = Math.max(
                    0,
                    Math.abs(dst.worldPos[0] - sx) - (src.halfExtents[0] + dst.halfExtents[0]),
                  );
                  const gapDz = Math.max(
                    0,
                    Math.abs(dst.worldPos[2] - sz) - (src.halfExtents[2] + dst.halfExtents[2]),
                  );
                  const horizGap = Math.hypot(gapDx, gapDz);
                  if (horizGap > radHoriz) continue;

                  const gapDy = Math.max(
                    0,
                    Math.abs(dy) - (src.halfExtents[1] + dst.halfExtents[1]),
                  );
                  const effDist = Math.hypot(horizGap, gapDy * (dy > 0 ? 0.45 : 1.3));
                  const maxReach = dy > 0.2 ? maxUpY * 0.65 : radHoriz * 0.85;
                  if (effDist >= maxReach) continue;

                  // Анизотропия конвективной струи: вверх в 3.8× сильнее, чем сбоку, и в 19× сильнее, чем вниз!
                  let dirFactor = 1.0;
                  if (dy > 0.22) {
                    dirFactor = 3.8;
                  } else if (dy < -0.22) {
                    dirFactor = 0.2;
                  }

                  const atten = Math.pow(1 - effDist / maxReach, 1.6);
                  const rate =
                    spreadMult *
                    PLUME_HEAT_COEFF *
                    dirFactor *
                    atten *
                    (src.burning ? 1.35 : 0.65) *
                    (src.temperatureC - dst.temperatureC);

                  dTemp[dst.nodeId] += rate * dtSec;
                }
              }
            }
          }
        }
      }
    }

    // 3. Интегрирование температур узлов, саморазогрев пламени, выгорание дерева и проверка порогов
    const emittedEvents: SimulationEvent[] = [];
    const thermalShockNodeIds: number[] = [];
    const thermalDetonationNodeIds: number[] = [];
    const burnedOutNodeIds: number[] = [];
    let burningNodeCount = 0;
    let maxTemperatureC = AMBIENT_TEMPERATURE_C;

    for (let i = 0; i < aliveNodes.length; i++) {
      const node = aliveNodes[i]!;
      const prevTemp = node.temperatureC;
      let nextTemp = prevTemp + dTemp[node.nodeId]!;

      if (node.burning) {
        const burnRateScale = Math.max(0.35, spreadMult > 0 ? spreadMult : 0.5);
        if (nextTemp < FLAME_EQUILIBRIUM_TEMP_C) {
          nextTemp += (FLAME_EQUILIBRIUM_TEMP_C - nextTemp) * Math.min(1, 1.8 * burnRateScale * dtSec);
        }
        const charStep = 0.145 * burnRateScale * dtSec;
        node.charRatio = cleanZero(clamp(node.charRatio + charStep, 0, 1));
        node.fuelRemaining = cleanZero(clamp(node.fuelRemaining - charStep * 0.95, 0, 1));

        if (node.fuelRemaining <= 0.01) {
          node.burning = false;
        }
        if (node.materialId === 'wood' && node.charRatio >= 0.96) {
          burnedOutNodeIds.push(node.nodeId);
        }
      } else if (nextTemp > AMBIENT_TEMPERATURE_C) {
        // Естественное конвективное охлаждение Ньютона к температуре окружающей среды 20 °C
        nextTemp -= 0.055 * (nextTemp - AMBIENT_TEMPERATURE_C) * dtSec;
      }

      nextTemp = cleanZero(clamp(nextTemp, AMBIENT_TEMPERATURE_C, MAX_SIM_TEMP_C));
      node.temperatureC = nextTemp;

      const stepDeltaT = Math.max(0, nextTemp - prevTemp);
      if (Math.abs(nextTemp - prevTemp) > 1.5 || node.burning) {
        this.markAdjacentBondsDirty(graph, node);
      }

      if (!node.burning && node.fuelRemaining > 0.02 && isIgnitionTriggered(node.materialId, nextTemp)) {
        node.burning = true;
        emittedEvents.push({
          type: 'fire_ignited',
          nodeId: node.nodeId,
          position: [node.worldPos[0], node.worldPos[1], node.worldPos[2]],
        });
      }

      if (node.burning) {
        burningNodeCount++;
      }
      if (nextTemp > maxTemperatureC) {
        maxTemperatureC = nextTemp;
      }

      if (isThermalDetonationTriggered(node.materialId, nextTemp)) {
        thermalDetonationNodeIds.push(node.nodeId);
      } else if (isThermalShockTriggered(node.materialId, nextTemp, stepDeltaT)) {
        thermalShockNodeIds.push(node.nodeId);
      }
    }

    return {
      emittedEvents,
      thermalShockNodeIds,
      thermalDetonationNodeIds,
      burnedOutNodeIds,
      burningNodeCount,
      maxTemperatureC: cleanZero(maxTemperatureC),
    };
  }

  private distanceToNodeSurfaceApprox(point: Vec3Tuple, node: StructuralNode): number {
    const dx = Math.max(0, Math.abs(point[0] - node.worldPos[0]) - node.halfExtents[0]);
    const dy = Math.max(0, Math.abs(point[1] - node.worldPos[1]) - node.halfExtents[1]);
    const dz = Math.max(0, Math.abs(point[2] - node.worldPos[2]) - node.halfExtents[2]);
    return Math.min(vec3Dist(point, node.worldPos), Math.hypot(dx, dy, dz));
  }

  private markAdjacentBondsDirty(graph: StructuralGraph, node: StructuralNode): void {
    const bondsMap = graph.getBondsMap();
    for (let i = 0; i < node.adjacencyBondIds.length; i++) {
      const b = bondsMap.get(node.adjacencyBondIds[i]!);
      if (b && !b.broken) {
        b.dirtyStiffness = true;
      }
    }
  }
}
