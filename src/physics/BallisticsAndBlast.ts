import {
  clamp,
  cleanZero,
  quatInverseRotateVec3,
  quatRotateVec3,
  vec3Add,
  vec3AddScaled,
  vec3Dist,
  vec3Dot,
  vec3Len,
  vec3Normalize,
  vec3Scale,
  vec3Sub,
} from '../core/math3d';
import {
  FIXED_DT,
  type PlantedChargeSnapshot,
  type SimulationEvent,
  type StructuralMaterialId,
  type Vec3,
  type Vec3Tuple,
} from '../core/types';
import { computeThermalStrengthRetention, getMaterialProfile } from './MaterialRegistry';
import { RAPIER } from './rapier';
import type { StructuralGraph, StructuralNode } from './StructuralGraph';

/**
 * Подсистема кинетической баллистики (непрерывный sweep-raycast без туннелирования и сквозной пробой),
 * сферических ударных волн Садовского с 3D raycast-окклюзией стенами, секвенсора C4 и цепной детонации.
 */

export type WorldColliderOwner =
  | { kind: 'ground' }
  | { kind: 'node'; nodeId: number }
  | { kind: 'shard'; shardId: number }
  | { kind: 'projectile'; projectileId: number }
  | { kind: 'anchor'; triggerId: number };

export interface ActiveProjectile {
  projectileId: number;
  bodyHandle: number;
  colliderHandle: number;
  radiusM: number;
  massKg: number;
  position: Vec3;
  velocity: Vec3;
  hot: boolean;
  remainingPenetrations: number;
  ageTicks: number;
  hitNodeIds: Set<number>;
  ignoreShardsUntilTick: number;
}

export interface PlantedC4Charge {
  chargeId: number;
  worldPoint: Vec3;
  normal: Vec3;
  targetNodeId?: number;
  localOffsetOnNode: Vec3;
  localNormalOnNode: Vec3;
  delaySec: number;
  yieldKgTnt: number;
  armed: boolean;
  remainingCountdownSec: number | null;
}

export interface QueuedBlast {
  center: Vec3;
  yieldKgTnt: number;
  incendiary: boolean;
  isChainDetonation: boolean;
  contactC4TargetNodeId?: number;
  delayTicks: number;
}

export interface FractureRequest {
  nodeId: number;
  impactPointWorld: Vec3;
  impulseDirWorld: Vec3;
  impulseMagnitudeNs: number;
  energyJ: number;
  preferLocalBreach: boolean;
  breachRadiusM: number;
}

export interface BlastDynamicImpulse {
  owner: WorldColliderOwner;
  colliderHandle: number;
  impulseWorldNs: Vec3;
  contactPointWorld: Vec3;
}

export interface TetherSegmentView {
  id: number;
  isCounterweight: boolean;
  pointA: Vec3;
  pointB: Vec3;
  breakForceN: number;
}

export interface BallisticsStepOutput {
  emittedEvents: SimulationEvent[];
  fractureRequests: FractureRequest[];
  dynamicImpulses: BlastDynamicImpulse[];
  severedTetherIds: number[];
  severedCounterweightTriggerIds: number[];
  newlyDetonatedExplosiveNodeIds: number[];
  incendiaryZones: Array<{ center: Vec3; radiusM: number; temperatureC: number }>;
}

/**
 * Вычисляет кратчайшее расстояние между двумя 3D-отрезками [p1, q1] и [p2, q2].
 */
export function distanceSegmentToSegment3D(
  p1: Vec3Tuple,
  q1: Vec3Tuple,
  p2: Vec3Tuple,
  q2: Vec3Tuple,
): { distM: number; closestOnA: Vec3; closestOnB: Vec3 } {
  const d1 = vec3Sub(q1, p1);
  const d2 = vec3Sub(q2, p2);
  const r = vec3Sub(p1, p2);
  const a = vec3Dot(d1, d1);
  const e = vec3Dot(d2, d2);
  const f = vec3Dot(d2, r);

  let s = 0;
  let t = 0;

  if (a <= 1e-12 && e <= 1e-12) {
    return {
      distM: vec3Dist(p1, p2),
      closestOnA: [p1[0], p1[1], p1[2]],
      closestOnB: [p2[0], p2[1], p2[2]],
    };
  }
  if (a <= 1e-12) {
    s = 0;
    t = clamp(f / e, 0, 1);
  } else {
    const c = vec3Dot(d1, r);
    if (e <= 1e-12) {
      t = 0;
      s = clamp(-c / a, 0, 1);
    } else {
      const b = vec3Dot(d1, d2);
      const denom = a * e - b * b;
      if (denom !== 0) {
        s = clamp((b * f - c * e) / denom, 0, 1);
      } else {
        s = 0;
      }
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = clamp(-c / a, 0, 1);
      } else if (t > 1) {
        t = 1;
        s = clamp((b - c) / a, 0, 1);
      }
    }
  }

  const c1 = vec3AddScaled(p1, d1, s);
  const c2 = vec3AddScaled(p2, d2, t);
  return {
    distM: vec3Dist(c1, c2),
    closestOnA: c1,
    closestOnB: c2,
  };
}

function getBaseMaterialFractureEnergyJPerM3(materialId: StructuralMaterialId): number {
  switch (materialId) {
    case 'glass':
      return 2_200;
    case 'brick':
      return 18_000;
    case 'wood':
      return 26_000;
    case 'explosive':
      return 8_500;
    case 'reinforced_concrete':
      return 92_000;
    case 'steel':
      return 420_000;
  }
}

export class BallisticsAndBlastSystem {
  private readonly projectiles = new Map<number, ActiveProjectile>();
  private readonly plantedC4 = new Map<number, PlantedC4Charge>();
  private readonly blastQueue: QueuedBlast[] = [];
  private readonly detonatedExplosiveNodes = new Set<number>();

  private nextProjectileId = 1;
  private nextChargeId = 1;

  public clear(world?: RAPIER.World, colliderOwners?: Map<number, WorldColliderOwner>): void {
    if (world && colliderOwners) {
      for (const proj of this.projectiles.values()) {
        colliderOwners.delete(proj.colliderHandle);
        if (world.bodies.contains(proj.bodyHandle)) {
          const rb = world.getRigidBody(proj.bodyHandle);
          world.removeRigidBody(rb);
        }
      }
    }
    this.projectiles.clear();
    this.plantedC4.clear();
    this.blastQueue.length = 0;
    this.detonatedExplosiveNodes.clear();
    this.nextProjectileId = 1;
    this.nextChargeId = 1;
  }

  public isExplosiveNodeDetonated(nodeId: number): boolean {
    return this.detonatedExplosiveNodes.has(nodeId);
  }

  public getProjectilesMap(): ReadonlyMap<number, ActiveProjectile> {
    return this.projectiles;
  }

  public getPlantedC4Count(): number {
    return this.plantedC4.size;
  }

  /**
   * Спавнит кинетический снаряд с физическим телом в Rapier3D и поддержкой непрерывного sweep-пробоя.
   */
  public fireProjectile(params: {
    world: RAPIER.World;
    colliderOwners: Map<number, WorldColliderOwner>;
    origin: Vec3Tuple;
    direction: Vec3Tuple;
    speedMpS: number;
    massKg: number;
    radiusM?: number;
    hot?: boolean;
  }): number {
    const dir = vec3Normalize(params.direction, [0, 0, -1]);
    const speed = clamp(Number.isFinite(params.speedMpS) ? params.speedMpS : 85, 1, 1500);
    const massKg = clamp(Number.isFinite(params.massKg) ? params.massKg : 65, 0.5, 50_000);
    const radiusM = clamp(Number.isFinite(params.radiusM) ? params.radiusM! : 0.22, 0.04, 2.5);
    const vel = vec3Scale(dir, speed);
    const pos: Vec3 = [
      cleanZero(params.origin[0]),
      cleanZero(params.origin[1]),
      cleanZero(params.origin[2]),
    ];

    const rbDesc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(pos[0], pos[1], pos[2])
      .setLinvel(vel[0], vel[1], vel[2])
      .setCcdEnabled(true)
      .setSoftCcdPrediction(Math.max(0.5, radiusM * 4))
      .setLinearDamping(0.015)
      .setAngularDamping(0.05);
    const rb = params.world.createRigidBody(rbDesc);

    const colDesc = RAPIER.ColliderDesc.ball(radiusM)
      .setMass(massKg)
      .setFriction(0.35)
      .setRestitution(0.12)
      .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS)
      .setContactForceEventThreshold(100);
    const col = params.world.createCollider(colDesc, rb);

    const projectileId = this.nextProjectileId++;
    params.colliderOwners.set(col.handle, { kind: 'projectile', projectileId });

    this.projectiles.set(projectileId, {
      projectileId,
      bodyHandle: rb.handle,
      colliderHandle: col.handle,
      radiusM,
      massKg,
      position: pos,
      velocity: vel,
      hot: Boolean(params.hot),
      remainingPenetrations: 6,
      ageTicks: 0,
      hitNodeIds: new Set<number>(),
      ignoreShardsUntilTick: -1,
    });

    return projectileId;
  }

  /**
   * Устанавливает заряд C4 с программируемой задержкой каскадного секвенсора.
   */
  public plantC4(
    params: {
      worldPoint: Vec3Tuple;
      normal: Vec3Tuple;
      targetNodeId?: number;
      delaySec: number;
      yieldKgTnt?: number;
    },
    graph: StructuralGraph,
  ): number {
    const chargeId = this.nextChargeId++;
    const wp: Vec3 = [
      cleanZero(params.worldPoint[0]),
      cleanZero(params.worldPoint[1]),
      cleanZero(params.worldPoint[2]),
    ];
    const nrm = vec3Normalize(params.normal, [0, 1, 0]);
    const delaySec = cleanZero(clamp(Number.isFinite(params.delaySec) ? params.delaySec : 0, 0, 30));
    const yieldKgTnt = clamp(Number.isFinite(params.yieldKgTnt) ? params.yieldKgTnt! : 18, 0.5, 2000);

    let localOffset: Vec3 = [0, 0, 0];
    let localNormal: Vec3 = nrm;
    const targetNode =
      params.targetNodeId !== undefined ? graph.getNode(params.targetNodeId) : undefined;
    if (targetNode && targetNode.alive) {
      localOffset = quatInverseRotateVec3(targetNode.worldQuat, vec3Sub(wp, targetNode.worldPos));
      localNormal = quatInverseRotateVec3(targetNode.worldQuat, nrm);
    }

    this.plantedC4.set(chargeId, {
      chargeId,
      worldPoint: wp,
      normal: nrm,
      targetNodeId: targetNode ? targetNode.nodeId : params.targetNodeId,
      localOffsetOnNode: localOffset,
      localNormalOnNode: localNormal,
      delaySec,
      yieldKgTnt,
      armed: false,
      remainingCountdownSec: null,
    });

    return chargeId;
  }

  public removeC4(chargeId: number): boolean {
    return this.plantedC4.delete(chargeId);
  }

  public removeC4At(point: Vec3Tuple, maxRadiusM = 1.6): number | null {
    let bestId: number | null = null;
    let bestDist = maxRadiusM;
    for (const c of this.plantedC4.values()) {
      const d = vec3Dist(point, c.worldPoint);
      if (d <= bestDist) {
        bestDist = d;
        bestId = c.chargeId;
      }
    }
    if (bestId !== null) {
      this.plantedC4.delete(bestId);
    }
    return bestId;
  }

  public updateC4Delay(chargeId: number, delaySec: number): boolean {
    const rec = this.plantedC4.get(chargeId);
    if (!rec) {
      return false;
    }
    const safeDelay = cleanZero(clamp(Number.isFinite(delaySec) ? delaySec : 0, 0, 30));
    rec.delaySec = safeDelay;
    if (rec.armed) {
      rec.remainingCountdownSec = safeDelay;
    }
    return true;
  }

  public detonateAllC4(): void {
    for (const rec of this.plantedC4.values()) {
      if (!rec.armed) {
        rec.armed = true;
        rec.remainingCountdownSec = rec.delaySec;
      }
    }
  }

  public getC4SequenceQueue(): Array<{ chargeId: number; delaySec: number }> {
    const list: Array<{ chargeId: number; delaySec: number }> = [];
    for (const rec of this.plantedC4.values()) {
      list.push({ chargeId: rec.chargeId, delaySec: rec.delaySec });
    }
    list.sort((a, b) => (a.delaySec !== b.delaySec ? a.delaySec - b.delaySec : a.chargeId - b.chargeId));
    return list;
  }

  public syncPlantedC4Positions(graph: StructuralGraph): void {
    for (const rec of this.plantedC4.values()) {
      if (rec.targetNodeId === undefined) continue;
      const node = graph.getNode(rec.targetNodeId);
      if (node && node.alive) {
        rec.worldPoint = vec3Add(
          node.worldPos,
          quatRotateVec3(node.worldQuat, rec.localOffsetOnNode),
        );
        rec.normal = vec3Normalize(quatRotateVec3(node.worldQuat, rec.localNormalOnNode), rec.normal);
      }
    }
  }

  public getPlantedChargesSnapshot(graph: StructuralGraph): PlantedChargeSnapshot[] {
    this.syncPlantedC4Positions(graph);
    const out: PlantedChargeSnapshot[] = [];
    for (const rec of this.plantedC4.values()) {
      out.push({
        chargeId: rec.chargeId,
        position: [rec.worldPoint[0], rec.worldPoint[1], rec.worldPoint[2]],
        normal: [rec.normal[0], rec.normal[1], rec.normal[2]],
        delaySec: rec.delaySec,
        armed: rec.armed,
        remainingCountdownSec:
          rec.remainingCountdownSec !== null ? cleanZero(Math.max(0, rec.remainingCountdownSec)) : null,
      });
    }
    out.sort((a, b) => a.chargeId - b.chargeId);
    return out;
  }

  public enqueueBlast(params: {
    center: Vec3Tuple;
    yieldKgTnt: number;
    incendiary?: boolean;
    isChainDetonation?: boolean;
    contactC4TargetNodeId?: number;
    delayTicks?: number;
  }): void {
    this.blastQueue.push({
      center: [cleanZero(params.center[0]), cleanZero(params.center[1]), cleanZero(params.center[2])],
      yieldKgTnt: clamp(Number.isFinite(params.yieldKgTnt) ? params.yieldKgTnt : 25, 0.1, 5000),
      incendiary: Boolean(params.incendiary),
      isChainDetonation: Boolean(params.isChainDetonation),
      contactC4TargetNodeId: params.contactC4TargetNodeId,
      delayTicks: Math.max(0, Math.trunc(params.delayTicks ?? 0)),
    });
  }

  /**
   * Инициирует детонацию взрывоопасного узла (materialId === 'explosive') идемпотентно (строго 1 раз).
   */
  public triggerExplosiveNodeDetonation(
    node: StructuralNode,
    delayTicks = 0,
    incendiary = true,
  ): boolean {
    if (this.detonatedExplosiveNodes.has(node.nodeId)) {
      return false;
    }
    this.detonatedExplosiveNodes.add(node.nodeId);
    const profile = getMaterialProfile(node.materialId);
    const eqTnt = Math.max(12, profile.detonationEquivalentKgTnt || 25);
    this.enqueueBlast({
      center: node.worldPos,
      yieldKgTnt: eqTnt,
      incendiary,
      isChainDetonation: true,
      delayTicks,
    });
    return true;
  }

  /**
   * Выполняет шаг таймеров C4, ударных волн Садовского и непрерывной баллистики снарядов до world.step().
   */
  public stepPrePhysics(params: {
    tick: number;
    dtSec: number;
    world: RAPIER.World;
    graph: StructuralGraph;
    colliderOwners: Map<number, WorldColliderOwner>;
    blastFalloffMultiplier: number;
    jointStrengthMultiplier: number;
    gravityMpS2: number;
    activeTethers: readonly TetherSegmentView[];
  }): BallisticsStepOutput {
    const {
      tick,
      dtSec,
      world,
      graph,
      colliderOwners,
      blastFalloffMultiplier,
      jointStrengthMultiplier,
      gravityMpS2,
      activeTethers,
    } = params;

    const emittedEvents: SimulationEvent[] = [];
    const fractureRequests: FractureRequest[] = [];
    const dynamicImpulses: BlastDynamicImpulse[] = [];
    const severedTetherIdSet = new Set<number>();
    const severedCounterweightIdSet = new Set<number>();
    const newlyDetonatedExplosiveNodeIds: number[] = [];
    const incendiaryZones: Array<{ center: Vec3; radiusM: number; temperatureC: number }> = [];

    // 1. Обновление позиций и таймеров взведённых зарядов C4
    this.syncPlantedC4Positions(graph);
    const dueCharges: PlantedC4Charge[] = [];
    for (const rec of this.plantedC4.values()) {
      if (!rec.armed || rec.remainingCountdownSec === null) continue;
      rec.remainingCountdownSec -= dtSec;
      if (rec.remainingCountdownSec <= 1e-6) {
        dueCharges.push(rec);
      }
    }
    if (dueCharges.length > 0) {
      dueCharges.sort((a, b) => a.chargeId - b.chargeId);
      for (let i = 0; i < dueCharges.length; i++) {
        const c = dueCharges[i]!;
        this.plantedC4.delete(c.chargeId);
        this.enqueueBlast({
          center: c.worldPoint,
          yieldKgTnt: c.yieldKgTnt,
          incendiary: false,
          isChainDetonation: false,
          contactC4TargetNodeId: c.targetNodeId,
          delayTicks: 0,
        });
      }
    }

    // 2. Обработка очереди взрывов текущего тика
    world.propagateModifiedBodyPositionsToColliders();
    const readyBlasts: QueuedBlast[] = [];
    for (let i = this.blastQueue.length - 1; i >= 0; i--) {
      const qb = this.blastQueue[i]!;
      if (qb.delayTicks <= 0) {
        readyBlasts.push(qb);
        this.blastQueue.splice(i, 1);
      } else {
        qb.delayTicks--;
      }
    }
    readyBlasts.reverse();

    for (let bIdx = 0; bIdx < readyBlasts.length; bIdx++) {
      const blast = readyBlasts[bIdx]!;
      this.executeSingleBlast({
        blast,
        world,
        graph,
        colliderOwners,
        blastFalloffMultiplier,
        jointStrengthMultiplier,
        activeTethers,
        emittedEvents,
        fractureRequests,
        dynamicImpulses,
        severedTetherIdSet,
        severedCounterweightIdSet,
        newlyDetonatedExplosiveNodeIds,
        incendiaryZones,
      });
    }

    // 3. Непрерывная баллистика снарядов (анти-туннелирующий каскадный sweep-raycast + сквозной пробой)
    for (const [projId, proj] of this.projectiles.entries()) {
      proj.ageTicks++;
      if (!world.bodies.contains(proj.bodyHandle)) {
        colliderOwners.delete(proj.colliderHandle);
        this.projectiles.delete(projId);
        continue;
      }

      const rb = world.getRigidBody(proj.bodyHandle);
      const pCur = rb.translation();
      const vCur = rb.linvel();
      proj.position = [cleanZero(pCur.x), cleanZero(pCur.y), cleanZero(pCur.z)];
      proj.velocity = [cleanZero(vCur.x), cleanZero(vCur.y), cleanZero(vCur.z)];

      // Удаляем снаряды, улетевшие далеко за пределы полигона или давно остановившиеся
      if (
        proj.ageTicks > 360 ||
        proj.position[1] < -25 ||
        Math.hypot(proj.position[0], proj.position[2]) > 260
      ) {
        colliderOwners.delete(proj.colliderHandle);
        world.removeRigidBody(rb);
        this.projectiles.delete(projId);
        continue;
      }

      const speed = vec3Len(proj.velocity);
      if (speed < 1.2) {
        continue;
      }

      const dir = vec3Scale(proj.velocity, 1 / speed);
      const stepDist = speed * dtSec + proj.radiusM;
      const segEnd = vec3AddScaled(proj.position, dir, stepDist);

      // 3А. Проверка перебивания тросов противовесов и арматуры летящим снарядом
      for (let t = 0; t < activeTethers.length; t++) {
        const tether = activeTethers[t]!;
        const segDist = distanceSegmentToSegment3D(
          proj.position,
          segEnd,
          tether.pointA,
          tether.pointB,
        );
        const hitRadius = Math.max(0.38, proj.radiusM + 0.25);
        if (segDist.distM <= hitRadius) {
          if (tether.isCounterweight) {
            severedCounterweightIdSet.add(tether.id);
          } else {
            severedTetherIdSet.add(tether.id);
          }
        }
      }

      // 3Б. Каскадный проход луча по преградам внутри одного шага dtSec (до 4 тонких преград за тик на высоких скоростях!)
      let curOrigin: Vec3 = [proj.position[0], proj.position[1], proj.position[2]];
      let remDist = stepDist;
      let curEnergyJ = 0.5 * proj.massKg * speed * speed;
      let penetratedInThisTick = false;

      for (let hop = 0; hop < 4 && remDist > 0.01 && proj.remainingPenetrations > 0; hop++) {
        const ray = new RAPIER.Ray(
          { x: curOrigin[0], y: curOrigin[1], z: curOrigin[2] },
          { x: dir[0], y: dir[1], z: dir[2] },
        );
        const hit = world.castRayAndGetNormal(
          ray,
          remDist,
          true,
          undefined,
          undefined,
          undefined,
          rb,
          (col) => {
            const owner = colliderOwners.get(col.handle);
            if (!owner) return false;
            if (owner.kind === 'projectile') return false;
            if (owner.kind === 'shard' && tick <= proj.ignoreShardsUntilTick) return false;
            if (owner.kind === 'node' && proj.hitNodeIds.has(owner.nodeId)) return false;
            return true;
          },
        );

        if (!hit) {
          break;
        }

        const hitColHandle = hit.collider.handle;
        const owner = colliderOwners.get(hitColHandle);
        const hitPoint = vec3AddScaled(curOrigin, dir, hit.timeOfImpact);
        if (!owner) {
          break;
        }

        if (owner.kind === 'anchor') {
          severedCounterweightIdSet.add(owner.triggerId);
          curOrigin = vec3AddScaled(hitPoint, dir, 0.04);
          remDist = Math.max(0, remDist - hit.timeOfImpact - 0.04);
          continue;
        }

        if (owner.kind === 'ground') {
          break;
        }

        if (owner.kind === 'shard') {
          const curSpeed = Math.sqrt((2 * curEnergyJ) / proj.massKg);
          dynamicImpulses.push({
            owner,
            colliderHandle: hitColHandle,
            impulseWorldNs: vec3Scale(dir, proj.massKg * curSpeed * 0.45),
            contactPointWorld: hitPoint,
          });
          break;
        }

        if (owner.kind === 'node') {
          const node = graph.getNode(owner.nodeId);
          if (!node || !node.alive) {
            proj.hitNodeIds.add(owner.nodeId);
            curOrigin = vec3AddScaled(hitPoint, dir, 0.03);
            remDist = Math.max(0, remDist - hit.timeOfImpact - 0.03);
            continue;
          }

          proj.hitNodeIds.add(node.nodeId);

          if (node.isCounterweight) {
            const curSpeed = Math.sqrt((2 * curEnergyJ) / proj.massKg);
            dynamicImpulses.push({
              owner,
              colliderHandle: hitColHandle,
              impulseWorldNs: vec3Scale(dir, proj.massKg * curSpeed * 0.8),
              contactPointWorld: hitPoint,
            });
            break;
          }

          // Прямое попадание в взрывоопасную бочку мгновенно детонирует её!
          if (node.materialId === 'explosive') {
            if (this.triggerExplosiveNodeDetonation(node, 0, true)) {
              newlyDetonatedExplosiveNodeIds.push(node.nodeId);
            }
            fractureRequests.push({
              nodeId: node.nodeId,
              impactPointWorld: hitPoint,
              impulseDirWorld: dir,
              impulseMagnitudeNs: proj.massKg * Math.sqrt((2 * curEnergyJ) / proj.massKg),
              energyJ: curEnergyJ,
              preferLocalBreach: false,
              breachRadiusM: 0.6,
            });
            curEnergyJ *= 0.65;
            proj.remainingPenetrations--;
            penetratedInThisTick = true;
            curOrigin = vec3AddScaled(hitPoint, dir, 0.05);
            remDist = Math.max(0, remDist - hit.timeOfImpact - 0.05);
            continue;
          }

          // Оценка толщины блока вдоль направления полёта снаряда
          const dirLocal = quatInverseRotateVec3(node.worldQuat, dir);
          const tx = Math.abs(dirLocal[0]) > 1e-4 ? (2 * node.halfExtents[0]) / Math.abs(dirLocal[0]) : 999;
          const ty = Math.abs(dirLocal[1]) > 1e-4 ? (2 * node.halfExtents[1]) / Math.abs(dirLocal[1]) : 999;
          const tz = Math.abs(dirLocal[2]) > 1e-4 ? (2 * node.halfExtents[2]) / Math.abs(dirLocal[2]) : 999;
          const thicknessAlongRay = clamp(Math.min(tx, ty, tz), 0.04, 4.0);

          const projArea = Math.PI * proj.radiusM * proj.radiusM;
          const baseFractureEnergy = getBaseMaterialFractureEnergyJPerM3(node.materialId);
          const kThermal = computeThermalStrengthRetention(
            node.materialId,
            node.temperatureC,
            node.charRatio,
          );
          const resistEnergyJ =
            0.085 *
            baseFractureEnergy *
            Math.max(0.05, kThermal) *
            Math.max(0.15, 1 - 0.7 * node.damageRatio) *
            (projArea * thicknessAlongRay) *
            Math.max(0.1, jointStrengthMultiplier);

          const curSpeed = Math.sqrt(Math.max(0, (2 * curEnergyJ) / proj.massKg));
          const hitNormalWorld: Vec3 = [hit.normal.x, hit.normal.y, hit.normal.z];
          const cosIncidence = Math.max(0.25, Math.abs(vec3Dot(dir, hitNormalWorld)));
          const normalEnergyJ = curEnergyJ * cosIncidence * cosIncidence;

          const spans = [
            node.halfExtents[0] * 2,
            node.halfExtents[1] * 2,
            node.halfExtents[2] * 2,
          ].sort((a, b) => b - a);
          const isWideWallOrSlab =
            node.materialId !== 'glass' && spans[0]! >= 1.5 && spans[1]! >= 1.1;
          const breachRadiusM = clamp(proj.radiusM * 2.4 + 0.18, 0.35, 1.35);

          const fractureThresholdJ =
            node.materialId === 'steel' ? resistEnergyJ * 16.0 : resistEnergyJ;

          if (normalEnergyJ >= fractureThresholdJ) {
            // Пробой или полный раскол преграды!
            const transferredImpulse = Math.min(
              proj.massKg * curSpeed,
              proj.massKg * curSpeed * clamp(resistEnergyJ / Math.max(1, curEnergyJ) + 0.25, 0.25, 1.0),
            );
            fractureRequests.push({
              nodeId: node.nodeId,
              impactPointWorld: hitPoint,
              impulseDirWorld: dir,
              impulseMagnitudeNs: transferredImpulse,
              energyJ: Math.min(curEnergyJ, Math.max(resistEnergyJ * 1.5, curEnergyJ * 0.45)),
              preferLocalBreach: isWideWallOrSlab,
              breachRadiusM,
            });

            curEnergyJ = Math.max(0, curEnergyJ - resistEnergyJ);
            proj.remainingPenetrations--;
            proj.ignoreShardsUntilTick = tick + 2;

            if (curEnergyJ > 0.08 * (0.5 * proj.massKg * speed * speed) && proj.remainingPenetrations > 0) {
              penetratedInThisTick = true;
              const advance = Math.min(remDist, hit.timeOfImpact + Math.min(0.35, thicknessAlongRay * 0.6));
              curOrigin = vec3AddScaled(curOrigin, dir, advance);
              remDist = Math.max(0, remDist - advance);
              continue;
            } else {
              // Снаряд израсходовал энергию внутри преграды
              rb.setLinvel({ x: dir[0] * 1.5, y: dir[1] * 1.5 - gravityMpS2 * dtSec, z: dir[2] * 1.5 }, true);
              break;
            }
          } else {
            // Пластическая деформация / непробитие (например, стальная двутавровая опора или толстая броня):
            // наносим локальное смятие полки, передаём ударный импульс в граф и формируем пластический шарнир стали
            const dmgDelta = clamp(normalEnergyJ / Math.max(1, resistEnergyJ), 0.02, 0.85);
            node.damageRatio = cleanZero(clamp(node.damageRatio + dmgDelta * 0.55, 0, 0.98));
            const impVec = vec3Scale(dir, proj.massKg * curSpeed);
            if (node.islandId === 0) {
              node.pendingImpulseNs = vec3Add(node.pendingImpulseNs, impVec);
              for (let k = 0; k < node.adjacencyBondIds.length; k++) {
                const bond = graph.getBond(node.adjacencyBondIds[k]!);
                if (!bond || bond.broken) continue;
                bond.integrity = cleanZero(Math.max(0.22, bond.integrity - dmgDelta * 0.35));
                bond.dirtyStiffness = true;

                if (node.materialId === 'steel') {
                  const otherNode =
                    bond.nodeIdB === -1
                      ? undefined
                      : graph.getNode(bond.nodeIdA === node.nodeId ? bond.nodeIdB : bond.nodeIdA);
                  if (!otherNode || otherNode.materialId === 'steel') {
                    bond.plasticAngleRad = cleanZero(
                      Math.min(0.34, bond.plasticAngleRad + Math.max(0.04, dmgDelta * 0.08)),
                    );
                    bond.isPlasticHinge = true;
                    if (!bond.emittedSteelYield) {
                      bond.emittedSteelYield = true;
                      emittedEvents.push({
                        type: 'steel_yield',
                        position: [hitPoint[0], hitPoint[1], hitPoint[2]],
                        angleRad: bond.plasticAngleRad,
                      });
                    }
                  }
                }
              }
            } else {
              dynamicImpulses.push({
                owner,
                colliderHandle: hitColHandle,
                impulseWorldNs: impVec,
                contactPointWorld: hitPoint,
              });
            }
            rb.setLinvel(
              { x: -dir[0] * 2.5, y: Math.max(-4, dir[1] * 0.5 - 2.0), z: -dir[2] * 2.5 },
              true,
            );
            break;
          }
        }
      }

      // Если снаряд пробил тонкую стенку / стекло навылет, восстанавливаем остаточную скорость и сдвигаем сквозь плоскость удара,
      // чтобы контактный солвер Rapier3D не остановил шар об удаляемый в Фазе 9 коллайдер!
      if (penetratedInThisTick && world.bodies.contains(proj.bodyHandle)) {
        const postSpeed = Math.sqrt(Math.max(0, (2 * curEnergyJ) / proj.massKg));
        const nextVel: Vec3 = [
          cleanZero(dir[0] * postSpeed),
          cleanZero(dir[1] * postSpeed),
          cleanZero(dir[2] * postSpeed),
        ];
        rb.setTranslation({ x: curOrigin[0], y: curOrigin[1], z: curOrigin[2] }, true);
        rb.setLinvel({ x: nextVel[0], y: nextVel[1], z: nextVel[2] }, true);
        proj.position = curOrigin;
        proj.velocity = nextVel;
      }
    }

    return {
      emittedEvents,
      fractureRequests,
      dynamicImpulses,
      severedTetherIds: Array.from(severedTetherIdSet),
      severedCounterweightTriggerIds: Array.from(severedCounterweightIdSet),
      newlyDetonatedExplosiveNodeIds,
      incendiaryZones,
    };
  }

  private executeSingleBlast(ctx: {
    blast: QueuedBlast;
    world: RAPIER.World;
    graph: StructuralGraph;
    colliderOwners: Map<number, WorldColliderOwner>;
    blastFalloffMultiplier: number;
    jointStrengthMultiplier: number;
    activeTethers: readonly TetherSegmentView[];
    emittedEvents: SimulationEvent[];
    fractureRequests: FractureRequest[];
    dynamicImpulses: BlastDynamicImpulse[];
    severedTetherIdSet: Set<number>;
    severedCounterweightIdSet: Set<number>;
    newlyDetonatedExplosiveNodeIds: number[];
    incendiaryZones: Array<{ center: Vec3; radiusM: number; temperatureC: number }>;
  }): void {
    const {
      blast,
      world,
      graph,
      colliderOwners,
      blastFalloffMultiplier,
      jointStrengthMultiplier,
      activeTethers,
      emittedEvents,
      fractureRequests,
      dynamicImpulses,
      severedTetherIdSet,
      severedCounterweightIdSet,
      newlyDetonatedExplosiveNodeIds,
      incendiaryZones,
    } = ctx;

    const kFalloff = clamp(
      Number.isFinite(blastFalloffMultiplier) ? blastFalloffMultiplier : 1.0,
      0.25,
      3.0,
    );
    const wTnt = Math.max(0.1, blast.yieldKgTnt);
    const wRoot = Math.cbrt(wTnt);
    const radiusM = cleanZero(clamp((6.8 * wRoot) / Math.pow(kFalloff, 0.85), 1.8, 52.0));
    const c = blast.center;

    emittedEvents.push({
      type: 'explosion',
      position: [c[0], c[1], c[2]],
      radiusM,
      equivalentKgTnt: cleanZero(wTnt),
      isChainDetonation: blast.isChainDetonation,
    });

    if (blast.incendiary) {
      incendiaryZones.push({
        center: [c[0], c[1], c[2]],
        radiusM: Math.min(radiusM * 0.55, 4.2),
        temperatureC: 720,
      });
    }

    // 1. Проверка обрыва тросов противовесов и арматуры ударной волной вблизи эпицентра
    for (let t = 0; t < activeTethers.length; t++) {
      const tether = activeTethers[t]!;
      const mid: Vec3 = [
        0.5 * (tether.pointA[0] + tether.pointB[0]),
        0.5 * (tether.pointA[1] + tether.pointB[1]),
        0.5 * (tether.pointA[2] + tether.pointB[2]),
      ];
      const d = Math.min(vec3Dist(c, tether.pointA), vec3Dist(c, mid));
      if (d > radiusM) continue;
      const zScaled = (Math.max(0.18, d) * kFalloff) / wRoot;
      const deltaPMPa = 0.084 / zScaled + 0.27 / (zScaled * zScaled) + 0.7 / Math.pow(zScaled, 3);
      if (d <= 1.8 * wRoot * 0.45 || deltaPMPa * 1e6 * 0.12 >= 0.35 * tether.breakForceN) {
        if (tether.isCounterweight) {
          severedCounterweightIdSet.add(tether.id);
        } else {
          severedTetherIdSet.add(tether.id);
        }
      }
    }

    // 2. Сбор всех коллайдеров в AABB сферы радиуса radiusM
    const candidateHandles: number[] = [];
    world.collidersWithAabbIntersectingAabb(
      { x: c[0], y: c[1], z: c[2] },
      { x: radiusM, y: radiusM, z: radiusM },
      (col) => {
        candidateHandles.push(col.handle);
        return true;
      },
    );

    const processedNodes = new Set<number>();
    const safeJointMult = Math.max(0.1, jointStrengthMultiplier);

    for (let i = 0; i < candidateHandles.length; i++) {
      const handle = candidateHandles[i]!;
      const owner = colliderOwners.get(handle);
      if (!owner || owner.kind === 'ground' || owner.kind === 'projectile') continue;
      if (!world.colliders.contains(handle)) continue;
      const col = world.getCollider(handle);

      if (owner.kind === 'anchor') {
        const anchorPt = col.translation();
        const d = Math.hypot(anchorPt.x - c[0], anchorPt.y - c[1], anchorPt.z - c[2]);
        if (d <= Math.min(radiusM, 3.2 * wRoot * 0.5 + 1.2)) {
          severedCounterweightIdSet.add(owner.triggerId);
        }
        continue;
      }

      if (owner.kind === 'shard') {
        const p = col.translation();
        const shardPos: Vec3 = [p.x, p.y, p.z];
        const d = vec3Dist(c, shardPos);
        if (d > radiusM) continue;
        const transmission = this.computeBlastTransmission(world, colliderOwners, c, shardPos, handle);
        const zScaled = (Math.max(0.22, d) * kFalloff) / wRoot;
        const specImp = (220 * wRoot) / Math.pow(zScaled, 1.35);
        const mass = Math.max(2, col.mass());
        const areaApprox = Math.max(0.05, Math.pow(mass / 2000, 2 / 3));
        const impMag = Math.min(mass * 38, transmission * specImp * areaApprox * 2.2);
        const rawDir = vec3Sub(shardPos, c);
        const outDir = vec3Normalize([rawDir[0], rawDir[1] + 0.22 * Math.max(0.4, d), rawDir[2]], [0, 1, 0]);
        dynamicImpulses.push({
          owner,
          colliderHandle: handle,
          impulseWorldNs: vec3Scale(outDir, impMag),
          contactPointWorld: shardPos,
        });
        continue;
      }

      if (owner.kind === 'node') {
        if (processedNodes.has(owner.nodeId)) continue;
        processedNodes.add(owner.nodeId);

        const node = graph.getNode(owner.nodeId);
        if (!node || !node.alive) continue;

        const proj = col.projectPoint({ x: c[0], y: c[1], z: c[2] }, true);
        const closestPt: Vec3 = proj ? [proj.point.x, proj.point.y, proj.point.z] : node.worldPos;
        const distM = vec3Dist(c, closestPt);
        if (distM > radiusM) continue;

        const aimPt: Vec3 = [
          0.65 * closestPt[0] + 0.35 * node.worldPos[0],
          0.65 * closestPt[1] + 0.35 * node.worldPos[1],
          0.65 * closestPt[2] + 0.35 * node.worldPos[2],
        ];
        const isDirectContactC4 =
          blast.contactC4TargetNodeId === node.nodeId || distM <= 0.16;
        const transmission = isDirectContactC4
          ? 1.0
          : this.computeBlastTransmission(world, colliderOwners, c, aimPt, handle, node.nodeId);

        const zScaled = (Math.max(0.18, distM) * kFalloff) / wRoot;
        const deltaPMPa =
          (0.084 / zScaled + 0.27 / (zScaled * zScaled) + 0.7 / Math.pow(zScaled, 3)) *
          transmission;
        const specImpPaS = ((220 * wRoot) / Math.pow(zScaled, 1.35)) * transmission;

        const dims = [
          node.halfExtents[0] * 2,
          node.halfExtents[1] * 2,
          node.halfExtents[2] * 2,
        ].sort((a, b) => b - a);
        const exposedArea = Math.max(0.12, dims[0]! * dims[1]!);
        const blastImpulseNs = (deltaPMPa * 1e6 * 0.0045 + specImpPaS) * exposedArea;

        const rawDir = vec3Sub(node.worldPos, c);
        const dirOut = vec3Normalize(
          [rawDir[0], rawDir[1] + 0.18 * Math.max(0.5, distM), rawDir[2]],
          [0, 1, 0],
        );

        if (node.isCounterweight) {
          dynamicImpulses.push({
            owner,
            colliderHandle: handle,
            impulseWorldNs: vec3Scale(dirOut, Math.min(node.massKg * 25, blastImpulseNs)),
            contactPointWorld: closestPt,
          });
          continue;
        }

        // Цепная детонация взрывоопасной ёмкости ('explosive') при ударной волне
        if (node.materialId === 'explosive') {
          if (deltaPMPa >= 0.042 || (transmission > 0.5 && distM <= 4.6)) {
            const fuseTicks = clamp(Math.round((distM / 340 + 0.03) / FIXED_DT), 1, 5);
            if (this.triggerExplosiveNodeDetonation(node, fuseTicks, true)) {
              newlyDetonatedExplosiveNodeIds.push(node.nodeId);
            }
            fractureRequests.push({
              nodeId: node.nodeId,
              impactPointWorld: closestPt,
              impulseDirWorld: dirOut,
              impulseMagnitudeNs: blastImpulseNs,
              energyJ: deltaPMPa * 1e6 * node.volumeM3,
              preferLocalBreach: false,
              breachRadiusM: 0.8,
            });
          }
          continue;
        }

        const profile = getMaterialProfile(node.materialId);
        const kThermal = computeThermalStrengthRetention(
          node.materialId,
          node.temperatureC,
          node.charRatio,
        );

        // Калёное стекло вылетает от слабой воздушной волны (>= 8 кПа = 0.008 МПа в прямой видимости)
        const criticalPressureMPa =
          node.materialId === 'glass'
            ? 0.008 * safeJointMult
            : Math.max(
                0.04,
                profile.tensileStrengthMPa * 0.14 * Math.max(0.08, kThermal) * safeJointMult,
              );

        const damageIncrement = clamp(deltaPMPa / Math.max(0.002, criticalPressureMPa), 0, 2.5);

        // Ослабление прилегающих строительных швов ударной волной
        for (let k = 0; k < node.adjacencyBondIds.length; k++) {
          const bond = graph.getBond(node.adjacencyBondIds[k]!);
          if (!bond || bond.broken) continue;
          const bondDrop = isDirectContactC4 ? 1.0 : damageIncrement * 0.55;
          bond.integrity = cleanZero(clamp(bond.integrity - bondDrop, 0, 1));
          bond.dirtyStiffness = true;
          if (bond.integrity <= 0.04) {
            bond.broken = true;
            bond.integrity = 0;
            bond.concreteCracked = profile.hasRebarTethers;
          }
        }

        if (isDirectContactC4 || damageIncrement >= 1.0) {
          const isWideWall =
            node.materialId !== 'glass' &&
            dims[0]! >= 2.2 &&
            dims[1]! >= 1.6 &&
            wTnt < 65;
          fractureRequests.push({
            nodeId: node.nodeId,
            impactPointWorld: closestPt,
            impulseDirWorld: dirOut,
            impulseMagnitudeNs: blastImpulseNs,
            energyJ: Math.max(1500, deltaPMPa * 1e6 * node.volumeM3 * 0.5),
            preferLocalBreach: isWideWall,
            breachRadiusM: clamp(0.65 * wRoot, 0.55, 2.2),
          });
        } else if (damageIncrement >= 0.04) {
          node.damageRatio = cleanZero(clamp(node.damageRatio + damageIncrement * 0.68, 0, 0.99));
          if (node.damageRatio >= 0.98) {
            fractureRequests.push({
              nodeId: node.nodeId,
              impactPointWorld: closestPt,
              impulseDirWorld: dirOut,
              impulseMagnitudeNs: blastImpulseNs,
              energyJ: Math.max(800, deltaPMPa * 1e6 * node.volumeM3 * 0.35),
              preferLocalBreach: false,
              breachRadiusM: 0.75,
            });
          } else if (node.islandId === 0) {
            node.pendingImpulseNs = vec3AddScaled(node.pendingImpulseNs, dirOut, blastImpulseNs);
          } else {
            dynamicImpulses.push({
              owner,
              colliderHandle: handle,
              impulseWorldNs: vec3Scale(dirOut, Math.min(node.massKg * 32, blastImpulseNs)),
              contactPointWorld: closestPt,
            });
          }
        }
      }
    }
  }

  /**
   * Проверяет через 3D raycast наличие массивной экранирующей преграды между эпицентром взрыва и мишенью.
   * Массивная ЖБ/стальная/кирпичная стена гасит 88% ударной волны (transmission = 0.12).
   */
  private computeBlastTransmission(
    world: RAPIER.World,
    colliderOwners: ReadonlyMap<number, WorldColliderOwner>,
    blastCenter: Vec3Tuple,
    targetPoint: Vec3Tuple,
    targetColliderHandle: number,
    targetNodeId?: number,
  ): number {
    const delta = vec3Sub(targetPoint, blastCenter);
    const dist = vec3Len(delta);
    if (dist <= 0.12) {
      return 1.0;
    }
    const dir: Vec3 = [delta[0] / dist, delta[1] / dist, delta[2] / dist];
    const startOffset = Math.min(0.05, dist * 0.25);
    const rayOrigin: Vec3 = [
      blastCenter[0] + dir[0] * startOffset,
      blastCenter[1] + dir[1] * startOffset,
      blastCenter[2] + dir[2] * startOffset,
    ];
    const maxToi = Math.max(0.01, dist - startOffset - 0.04);
    const ray = new RAPIER.Ray(
      { x: rayOrigin[0], y: rayOrigin[1], z: rayOrigin[2] },
      { x: dir[0], y: dir[1], z: dir[2] },
    );

    const hit = world.castRay(
      ray,
      maxToi,
      false, // solid = false: если заряд на поверхности стены, луч не блокируется тем коллайдером, из которого выходит наружу
      undefined,
      undefined,
      undefined,
      undefined,
      (col) => {
        if (col.handle === targetColliderHandle) return false;
        const owner = colliderOwners.get(col.handle);
        if (!owner) return false;
        if (owner.kind === 'projectile' || owner.kind === 'anchor') return false;
        if (owner.kind === 'node') {
          if (targetNodeId !== undefined && owner.nodeId === targetNodeId) return false;
          return true;
        }
        if (owner.kind === 'shard') {
          // Мелкие летящие осколки не создают глухой акустической тени
          return col.volume() >= 0.25;
        }
        return true; // ground экранирует
      },
    );

    if (!hit) {
      return 1.0;
    }

    const blockerOwner = colliderOwners.get(hit.collider.handle);
    if (!blockerOwner) {
      return 1.0;
    }
    if (blockerOwner.kind === 'ground') {
      return 0.12;
    }
    if (blockerOwner.kind === 'shard') {
      return 0.45;
    }
    return 0.12;
  }
}
