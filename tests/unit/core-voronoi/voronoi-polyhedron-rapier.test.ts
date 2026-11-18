import { beforeAll, describe, expect, it } from 'vitest';
import {
  computePrincipalStretch3D,
  quatFromAxisAngle,
  vec3Add,
  vec3Dist,
  vec3Dot,
  vec3Len,
  vec3Normalize,
} from '../../../src/core/math3d';
import { SeededRng } from '../../../src/core/rng';
import { STRUCTURAL_MATERIAL_IDS, type Vec3 } from '../../../src/core/types';
import {
  clipConvexPolyhedronByPlane,
  computePolyhedronMinThickness,
  createBoxPolyhedron,
  toRawPolyhedron64,
  validateWatertightConvexPolyhedron,
} from '../../../src/physics/ConvexPolyhedron3D';
import {
  assertRapierInitialized,
  initRapier,
  isRapierInitialized,
  RAPIER,
} from '../../../src/physics/rapier';
import {
  carveLocalBreach3D,
  fractureBoxVoronoi3D,
  fracturePolyhedronVoronoi3D,
} from '../../../src/physics/VoronoiFracture3D';

describe('Выпуклые 3D-полиэдры, анизотропный Вороной, локальный пролом и живой WASM Rapier3D', () => {
  const initWarnings: string[] = [];

  beforeAll(async () => {
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      initWarnings.push(args.map(String).join(' '));
      origWarn.apply(console, args);
    };
    try {
      // Конкурентная и повторная инициализация WASM без гонок и предупреждений
      const [m1, m2] = await Promise.all([initRapier(), initRapier()]);
      const m3 = await initRapier();
      expect(m1).toBe(RAPIER);
      expect(m2).toBe(RAPIER);
      expect(m3).toBe(RAPIER);
    } finally {
      console.warn = origWarn;
    }
  });

  it('подтверждает идемпотентность initRapier(), отсутствие console.warn и готовность WASM-ядра', () => {
    expect(isRapierInitialized()).toBe(true);
    expect(() => assertRapierInitialized()).not.toThrow();
    expect(initWarnings).toHaveLength(0);
  });

  it('проверяет топологию createBoxPolyhedron и каноническое бинарное отсечение clipConvexPolyhedronByPlane', () => {
    const box = createBoxPolyhedron([1.5, 2.0, 0.4]);
    expect(box.vertices.length).toBe(24);
    expect(box.faces.length).toBe(6);
    expect(box.faces.every((f) => f.isInteriorCut === false)).toBe(true);
    expect(box.volumeM3).toBeCloseTo(9.6, 5);
    expect(box.centroid).toEqual([0, 0, 0]);

    const boxCheck = validateWatertightConvexPolyhedron(box);
    expect(boxCheck).toEqual({ valid: true, euler: 2 });

    // Каноническое бинарное рассечение серией произвольных наклонных плоскостей
    const rng = new SeededRng(551122);
    for (let trial = 0; trial < 15; trial++) {
      const planePt: Vec3 = [rng.range(-0.6, 0.6), rng.range(-0.8, 0.8), rng.range(-0.15, 0.15)];
      const planeNormal = rng.unitVec3();
      const negNormal: Vec3 = [-planeNormal[0], -planeNormal[1], -planeNormal[2]];

      const halfPos = clipConvexPolyhedronByPlane(box, planePt, planeNormal, true);
      const halfNeg = clipConvexPolyhedronByPlane(box, planePt, negNormal, true);

      expect(halfPos).not.toBeNull();
      expect(halfNeg).not.toBeNull();
      if (!halfPos || !halfNeg) continue;

      expect(validateWatertightConvexPolyhedron(halfPos)).toEqual({ valid: true, euler: 2 });
      expect(validateWatertightConvexPolyhedron(halfNeg)).toEqual({ valid: true, euler: 2 });

      // Сумма объёмов двух половин строго равна исходному объёму
      expect(Math.abs(halfPos.volumeM3 + halfNeg.volumeM3 - box.volumeM3)).toBeLessThan(1e-5);

      // Ровно одна новая внутренняя грань среза у каждой половины с внешней нормалью ∓planeNormal
      const posCutFaces = halfPos.faces.filter((f) => f.isInteriorCut);
      const negCutFaces = halfNeg.faces.filter((f) => f.isInteriorCut);
      expect(posCutFaces).toHaveLength(1);
      expect(negCutFaces).toHaveLength(1);
      expect(vec3Dist(posCutFaces[0]!.normal, negNormal)).toBeLessThan(1e-6);
      expect(vec3Dist(negCutFaces[0]!.normal, planeNormal)).toBeLessThan(1e-6);

      // Общие вершины на плоскости среза в родительских координатах (centroid + v_local) совпадают до Float32
      const posCapWorld = posCutFaces[0]!.indices.map((idx) =>
        vec3Add(halfPos.centroid, [
          halfPos.vertices[idx * 3]!,
          halfPos.vertices[idx * 3 + 1]!,
          halfPos.vertices[idx * 3 + 2]!,
        ]),
      );
      const negCapWorld = negCutFaces[0]!.indices.map((idx) =>
        vec3Add(halfNeg.centroid, [
          halfNeg.vertices[idx * 3]!,
          halfNeg.vertices[idx * 3 + 1]!,
          halfNeg.vertices[idx * 3 + 2]!,
        ]),
      );
      expect(posCapWorld.length).toBe(negCapWorld.length);
      for (const p of posCapWorld) {
        let minDist = Number.POSITIVE_INFINITY;
        for (const q of negCapWorld) {
          const d = vec3Dist(p, q);
          if (d < minDist) minDist = d;
        }
        expect(minDist).toBeLessThan(1e-6);
      }
    }

    // Граничные случаи: плоскость снаружи сохраняет тело, касательная/отсекающая всё тело возвращает null
    const untouched = clipConvexPolyhedronByPlane(box, [10, 0, 0], [-1, 0, 0], true);
    expect(untouched).not.toBeNull();
    expect(untouched!.faces.every((f) => f.isInteriorCut === false)).toBe(true);
    expect(untouched!.volumeM3).toBeCloseTo(box.volumeM3, 5);

    // Касание грани (+X = 1.5), ребра (1.5, 2.0, z) и вершины (1.5, 2.0, 0.4) с внешней нормалью наружу -> null
    expect(clipConvexPolyhedronByPlane(box, [1.5, 0, 0], [1, 0, 0], true)).toBeNull();
    expect(clipConvexPolyhedronByPlane(box, [1.5, 2.0, 0], [1, 1, 0], true)).toBeNull();
    expect(clipConvexPolyhedronByPlane(box, [1.5, 2.0, 0.4], [1, 1, 1], true)).toBeNull();
  });

  it('проверяет 3D Вороного на всех 6 материалах, 8 seed и реальную физику RAPIER.ColliderDesc.convexHull', () => {
    const seeds = [101, 202, 303, 404, 505, 606, 707, 808];
    const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });

    try {
      for (const materialId of STRUCTURAL_MATERIAL_IDS) {
        for (let sIdx = 0; sIdx < seeds.length; sIdx++) {
          const seed = seeds[sIdx]!;
          // Чередуем удары внутри блока и далеко за пределами полиэдра
          const impactPointLocal: Vec3 =
            sIdx % 2 === 0 ? [0.15, -0.1, 0.05] : [25.0, -18.0, 12.0];

          const res = fractureBoxVoronoi3D({
            halfExtents: [0.8, 0.6, 0.45],
            materialId,
            worldPosition: [sIdx * 4, 5.0, 0],
            impactPointLocal,
            shardCount: 10,
            seed,
          });

          expect(res.shards.length).toBeGreaterThanOrEqual(4);

          const volRelErr =
            Math.abs(res.totalShardsVolumeM3 - res.originalVolumeM3) / res.originalVolumeM3;
          const massRelErr =
            Math.abs(res.totalShardsMassKg - res.originalMassKg) / res.originalMassKg;

          expect(volRelErr).toBeLessThan(0.005);
          expect(massRelErr).toBeLessThan(0.005);

          for (const shard of res.shards) {
            const topo = validateWatertightConvexPolyhedron(shard.polyhedron);
            expect(topo).toEqual({ valid: true, euler: 2 });

            const hullDesc = RAPIER.ColliderDesc.convexHull(shard.polyhedron.vertices);
            expect(hullDesc).not.toBeNull();

            const rbDesc = RAPIER.RigidBodyDesc.dynamic().setTranslation(
              shard.worldPosition[0],
              shard.worldPosition[1],
              shard.worldPosition[2],
            );
            const rb = world.createRigidBody(rbDesc);
            const density = shard.massKg / shard.polyhedron.volumeM3;
            world.createCollider(hullDesc!.setDensity(density), rb);
            expect(rb.mass()).toBeGreaterThan(0);
            expect(Math.abs(rb.mass() - shard.massKg) / shard.massKg).toBeLessThan(0.02);

            // Очищаем созданное тело, чтобы мир оставался компактным между сотнями осколков
            world.removeRigidBody(rb);
          }
        }
      }

      // Проверяем побитовую воспроизводимость при одинаковом seed
      const detA = fractureBoxVoronoi3D({
        halfExtents: [1.0, 0.8, 0.5],
        materialId: 'reinforced_concrete',
        impactPointLocal: [0.2, 0.1, -0.1],
        shardCount: 12,
        seed: 424242,
      });
      const detB = fractureBoxVoronoi3D({
        halfExtents: [1.0, 0.8, 0.5],
        materialId: 'reinforced_concrete',
        impactPointLocal: [0.2, 0.1, -0.1],
        shardCount: 12,
        seed: 424242,
      });
      expect(detA).toEqual(detB);
    } finally {
      world.free();
    }
  });

  it('проверяет анизотропное щепление дерева вдоль волокон, тонкое стекло, арматуру ЖБ и раскол 2-го поколения', () => {
    const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    try {
      // 1. Горизонтальный и вертикальный деревянный брус: средняя вытянутость щепок > 2.0 вдоль оси бруса
      for (const orient of [
        { halfExtents: [1.8, 0.15, 0.15] as Vec3, axis: [1, 0, 0] as Vec3 },
        { halfExtents: [0.15, 1.8, 0.15] as Vec3, axis: [0, 1, 0] as Vec3 },
      ]) {
        const woodRes = fractureBoxVoronoi3D({
          halfExtents: orient.halfExtents,
          materialId: 'wood',
          impactPointLocal: [0, 0, 0],
          shardCount: 10,
          seed: 7070,
        });
        expect(woodRes.shards.length).toBeGreaterThanOrEqual(5);
        const relErr =
          Math.abs(woodRes.totalShardsVolumeM3 - woodRes.originalVolumeM3) /
          woodRes.originalVolumeM3;
        expect(relErr).toBeLessThan(0.005);

        let sumAxisRatio = 0;
        for (const sh of woodRes.shards) {
          const stretch = computePrincipalStretch3D(sh.polyhedron.vertices, orient.axis);
          sumAxisRatio += stretch.axisSpanRatio;
          expect(RAPIER.ColliderDesc.convexHull(sh.polyhedron.vertices)).not.toBeNull();
        }
        const meanAxisRatio = sumAxisRatio / woodRes.shards.length;
        expect(meanAxisRatio).toBeGreaterThan(2.0);
      }

      // 2. Тонкий витражный лист калёного стекла (толщина 2 см = 2 * 0.01 м)
      const impactGlass: Vec3 = [0.15, -0.2, 0];
      const glassRes = fractureBoxVoronoi3D({
        halfExtents: [1.2, 1.5, 0.01],
        materialId: 'glass',
        impactPointLocal: impactGlass,
        shardCount: 18,
        seed: 9191,
      });
      expect(glassRes.shards.length).toBeGreaterThanOrEqual(12);
      const glassVolErr =
        Math.abs(glassRes.totalShardsVolumeM3 - glassRes.originalVolumeM3) /
        glassRes.originalVolumeM3;
      expect(glassVolErr).toBeLessThan(0.005);

      const shardsByDist = glassRes.shards
        .map((sh) => ({
          shard: sh,
          dist: vec3Dist(sh.polyhedron.centroid, impactGlass),
        }))
        .sort((a, b) => a.dist - b.dist);

      for (const item of shardsByDist) {
        expect(computePolyhedronMinThickness(item.shard.polyhedron)).toBeGreaterThan(0.015);
        expect(RAPIER.ColliderDesc.convexHull(item.shard.polyhedron.vertices)).not.toBeNull();
      }

      const halfCount = Math.floor(shardsByDist.length / 2);
      const nearMeanVol =
        shardsByDist.slice(0, halfCount).reduce((acc, x) => acc + x.shard.polyhedron.volumeM3, 0) /
        halfCount;
      const farMeanVol =
        shardsByDist
          .slice(halfCount)
          .reduce((acc, x) => acc + x.shard.polyhedron.volumeM3, 0) /
        (shardsByDist.length - halfCount);
      expect(nearMeanVol).toBeLessThan(farMeanVol);

      // 3. Железобетон: наличие 3D гнутых прутьев арматуры на внутренних гранях скола + раскол 2-го поколения
      const rcGen1 = fractureBoxVoronoi3D({
        halfExtents: [1.0, 1.0, 0.5],
        materialId: 'reinforced_concrete',
        worldPosition: [0, 3, 0],
        impactPointLocal: [0.1, 0.1, 0],
        shardCount: 8,
        seed: 31337,
      });

      let totalRebars = 0;
      let gen2VolumeSum = 0;

      for (let i = 0; i < rcGen1.shards.length; i++) {
        const sh1 = rcGen1.shards[i]!;
        totalRebars += sh1.rebarStubs.length;

        const interiorNormals = sh1.polyhedron.faces
          .filter((f) => f.isInteriorCut)
          .map((f) => f.normal);

        for (const stub of sh1.rebarStubs) {
          expect(Math.abs(vec3Len(stub.directionLocal) - 1)).toBeLessThan(1e-6);
          expect(stub.lengthM).toBeGreaterThan(0.05);
          // Вектор прута арматуры обязан смотреть наружу хотя бы из одной внутренней грани скола
          const maxAlign = interiorNormals.reduce(
            (best, n) => Math.max(best, vec3Dot(stub.directionLocal, n)),
            -1,
          );
          expect(maxAlign).toBeGreaterThan(0.85);
        }

        // Каскадный раскол 2-го поколения каждого осколка 1-го поколения
        const gen2 = fracturePolyhedronVoronoi3D({
          polyhedron: sh1.polyhedron,
          materialId: 'reinforced_concrete',
          worldPosition: sh1.worldPosition,
          shardCount: 4,
          seed: 5000 + i,
        });
        const gen2Err =
          Math.abs(gen2.totalShardsVolumeM3 - sh1.polyhedron.volumeM3) / sh1.polyhedron.volumeM3;
        expect(gen2Err).toBeLessThan(0.005);
        gen2VolumeSum += gen2.totalShardsVolumeM3;

        for (const sh2 of gen2.shards) {
          expect(validateWatertightConvexPolyhedron(sh2.polyhedron)).toEqual({
            valid: true,
            euler: 2,
          });
          const hull2 = RAPIER.ColliderDesc.convexHull(sh2.polyhedron.vertices);
          expect(hull2).not.toBeNull();
          const rb = world.createRigidBody(
            RAPIER.RigidBodyDesc.dynamic().setTranslation(
              sh2.worldPosition[0],
              sh2.worldPosition[1],
              sh2.worldPosition[2],
            ),
          );
          world.createCollider(hull2!.setDensity(2450), rb);
        }
      }

      expect(totalRebars).toBeGreaterThan(0);
      expect(Math.abs(gen2VolumeSum - rcGen1.originalVolumeM3) / rcGen1.originalVolumeM3).toBeLessThan(
        0.005,
      );

      // Выполняем несколько реальных шагов динамики Rapier3D для всех осколков 2-го поколения
      world.timestep = 1 / 60;
      for (let step = 0; step < 5; step++) {
        world.step();
      }
    } finally {
      world.free();
    }
  });

  it('вырезает сквозной локальный пролом carveLocalBreach3D в ЖБ-стене и подтверждает дыру лучом world.castRay', () => {
    const wallPoly = createBoxPolyhedron([3.0, 2.0, 0.25]);
    const impactLocal: Vec3 = [0.2, -0.1, 0];

    const breach = carveLocalBreach3D({
      polyhedron: wallPoly,
      materialId: 'reinforced_concrete',
      worldPosition: [0, 2.5, 0],
      impactPointLocal: impactLocal,
      breachRadiusM: 0.9,
      shardCount: 6,
      seed: 888444,
    });

    expect(breach.isLocalBreach).toBe(true);
    expect(breach.survivingPieces.length).toBeGreaterThanOrEqual(2);
    expect(breach.breachShards.length).toBeGreaterThanOrEqual(3);

    const volRelErr =
      Math.abs(breach.totalResultVolumeM3 - breach.originalVolumeM3) / breach.originalVolumeM3;
    expect(volRelErr).toBeLessThan(0.0005); // Погрешность строго < 0.05%!

    const survivingRebars = breach.survivingPieces.reduce(
      (sum, p) => sum + p.rebarStubs.length,
      0,
    );
    const shardRebars = breach.breachShards.reduce((sum, p) => sum + p.rebarStubs.length, 0);
    expect(survivingRebars).toBeGreaterThan(0);
    expect(shardRebars).toBeGreaterThan(0);

    const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    try {
      // Размещаем в мире ТОЛЬКО уцелевшие сегменты стены (survivingPieces)
      for (const piece of breach.survivingPieces) {
        expect(validateWatertightConvexPolyhedron(piece.polyhedron)).toEqual({
          valid: true,
          euler: 2,
        });
        const desc = RAPIER.ColliderDesc.convexHull(piece.polyhedron.vertices);
        expect(desc).not.toBeNull();
        const rb = world.createRigidBody(
          RAPIER.RigidBodyDesc.fixed().setTranslation(
            piece.worldPosition[0],
            piece.worldPosition[1],
            piece.worldPosition[2],
          ),
        );
        world.createCollider(desc!, rb);
      }

      // Проверяем также валидность коллайдеров всех выбитых осколков бреши (без вставки на линию луча)
      for (const sh of breach.breachShards) {
        expect(validateWatertightConvexPolyhedron(sh.polyhedron)).toEqual({
          valid: true,
          euler: 2,
        });
        expect(RAPIER.ColliderDesc.convexHull(sh.polyhedron.vertices)).not.toBeNull();
      }

      // Обновляем структуры ускорения запросов сцены (BVH/BroadPhase) перед raycast
      world.timestep = 1 / 60;
      world.step();

      // 1. Луч сквозь точку пробитой бреши (мировая координата [0.2, 2.5 - 0.1, z]) проходит свободно!
      const rayThroughHole = new RAPIER.Ray({ x: 0.2, y: 2.4, z: -2.0 }, { x: 0, y: 0, z: 1 });
      const holeHit = world.castRay(rayThroughHole, 10.0, true);
      expect(holeHit).toBeNull();

      // 2. Луч в уцелевший левый пилон стены (x = -2.2, y = 2.5) уверенно попадает в бетон!
      const rayIntoIntactPillar = new RAPIER.Ray(
        { x: -2.2, y: 2.5, z: -2.0 },
        { x: 0, y: 0, z: 1 },
      );
      const pillarHit = world.castRay(rayIntoIntactPillar, 10.0, true);
      expect(pillarHit).not.toBeNull();
      expect(pillarHit!.timeOfImpact).toBeCloseTo(1.75, 2);
    } finally {
      world.free();
    }
  });

  it('сохраняет мировой центр масс при 3D-вращении, пробивает горизонтальное перекрытие и делает несквозной кратер в массиве', () => {
    // 1. Последовательное 4-квадрантное рассечение куба двумя косыми плоскостями в родительских координатах
    const cube = createBoxPolyhedron([1.2, 1.2, 1.2]);
    const n1: Vec3 = [0.8, 0.6, 0];
    const n2: Vec3 = [-0.2, 0.5, 0.842614977];
    const pA = clipConvexPolyhedronByPlane(cube, [0.1, -0.1, 0], n1, true)!;
    const pB = clipConvexPolyhedronByPlane(cube, [0.1, -0.1, 0], [-n1[0], -n1[1], -n1[2]], true)!;
    const q1 = clipConvexPolyhedronByPlane(pA, [-0.05, 0.15, 0.1], n2, true)!;
    const q2 = clipConvexPolyhedronByPlane(pA, [-0.05, 0.15, 0.1], [-n2[0], -n2[1], -n2[2]], true)!;
    const q3 = clipConvexPolyhedronByPlane(pB, [-0.05, 0.15, 0.1], n2, true)!;
    const q4 = clipConvexPolyhedronByPlane(pB, [-0.05, 0.15, 0.1], [-n2[0], -n2[1], -n2[2]], true)!;

    for (const q of [q1, q2, q3, q4]) {
      expect(validateWatertightConvexPolyhedron(q)).toEqual({ valid: true, euler: 2 });
    }
    expect(Math.abs(q1.volumeM3 + q2.volumeM3 + q3.volumeM3 + q4.volumeM3 - cube.volumeM3)).toBeLessThan(
      1e-4,
    );

    // 2. Сохранение мирового центра масс при нетривиальном 3D-повороте worldQuaternion
    const worldPos: Vec3 = [12.5, 8.25, -6.75];
    const worldQuat = quatFromAxisAngle([0.6, 0.7, -0.38], 1.12);

    const rotVoronoi = fractureBoxVoronoi3D({
      halfExtents: [1.4, 0.9, 0.5],
      materialId: 'steel',
      worldPosition: worldPos,
      worldQuaternion: worldQuat,
      impactPointLocal: [0.3, -0.2, 0.1],
      shardCount: 12,
      seed: 123987,
    });

    const comVoronoi: Vec3 = [0, 0, 0];
    for (const s of rotVoronoi.shards) {
      comVoronoi[0] += s.massKg * s.worldPosition[0];
      comVoronoi[1] += s.massKg * s.worldPosition[1];
      comVoronoi[2] += s.massKg * s.worldPosition[2];
    }
    comVoronoi[0] /= rotVoronoi.totalShardsMassKg;
    comVoronoi[1] /= rotVoronoi.totalShardsMassKg;
    comVoronoi[2] /= rotVoronoi.totalShardsMassKg;
    expect(vec3Dist(comVoronoi, worldPos)).toBeLessThan(1e-4);

    // 3. Горизонтальная плита перекрытия + несквозной кратер толстого массива + компактный блок
    const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    try {
      const slab = createBoxPolyhedron([3.0, 0.2, 2.5]);
      const slabBreach = carveLocalBreach3D({
        polyhedron: slab,
        materialId: 'reinforced_concrete',
        worldPosition: [0, 4.0, 0],
        impactPointLocal: [-0.3, 0, 0.4],
        breachRadiusM: 0.85,
        shardCount: 6,
        seed: 654321,
      });
      expect(slabBreach.isLocalBreach).toBe(true);
      expect(slabBreach.survivingPieces.length).toBe(4);

      for (const piece of slabBreach.survivingPieces) {
        const desc = RAPIER.ColliderDesc.convexHull(piece.polyhedron.vertices)!;
        const rb = world.createRigidBody(
          RAPIER.RigidBodyDesc.fixed().setTranslation(
            piece.worldPosition[0],
            piece.worldPosition[1],
            piece.worldPosition[2],
          ),
        );
        world.createCollider(desc, rb);
      }
      world.step();

      // Вертикальный луч сквозь пролом в перекрытии проходит свободно
      const downRayHole = new RAPIER.Ray({ x: -0.3, y: 8.0, z: 0.4 }, { x: 0, y: -1, z: 0 });
      expect(world.castRay(downRayHole, 10.0, true)).toBeNull();

      // Несквозной кратер в массивном блоке (толщина L2 = 4.0 м > 2.4 * 0.7 = 1.68 м)
      const bunkerBlock = createBoxPolyhedron([3.0, 3.0, 2.0]);
      const crater = carveLocalBreach3D({
        polyhedron: bunkerBlock,
        materialId: 'brick',
        worldPosition: [20, 3.0, 0],
        impactPointLocal: [0, 0, -1.85], // Удар в переднюю грань z = -2.0
        breachRadiusM: 0.7,
        shardCount: 5,
        seed: 777888,
      });
      expect(crater.isLocalBreach).toBe(true);
      expect(crater.survivingPieces.length).toBe(5); // 4 боковых + 1 тыльная стенка кратера!
      expect(
        Math.abs(crater.totalResultVolumeM3 - crater.originalVolumeM3) / crater.originalVolumeM3,
      ).toBeLessThan(0.0005);

      // Компактный блок автоматически откатывается к полному расколу (isLocalBreach === false)
      const compact = createBoxPolyhedron([0.4, 0.4, 0.4]);
      const fullFallback = carveLocalBreach3D({
        polyhedron: compact,
        materialId: 'brick',
        impactPointLocal: [0, 0, 0],
        breachRadiusM: 0.9,
        shardCount: 6,
        seed: 112233,
      });
      expect(fullFallback.isLocalBreach).toBe(false);
      expect(fullFallback.survivingPieces).toHaveLength(0);
      expect(fullFallback.breachShards.length).toBeGreaterThanOrEqual(3);
    } finally {
      world.free();
    }
  });

  it('регрессия №1: сохраняет 100% объёма и водонепроницаемость при скользящих разрезах вблизи вершин и острых углов', () => {
    const cube = createBoxPolyhedron([1.0, 1.0, 1.0]); // Объём = 8.0 м³
    const distances = [1e-8, 2e-7, 5e-7, 1e-6, 3e-6];

    // 1. Скользящие разрезы около вершины куба (+1, +1, +1) и (-1, -1, -1), а также ребра (+1, +1, 0)
    const diagInward = vec3Normalize([-1, -1, -1]);
    const edgeInward = vec3Normalize([-1, -1, 0]);

    for (const d of distances) {
      // Вершина (+1, +1, +1), нормаль внутрь куба
      const ptCorner: Vec3 = [
        1 + diagInward[0] * d,
        1 + diagInward[1] * d,
        1 + diagInward[2] * d,
      ];
      const halfPos = clipConvexPolyhedronByPlane(cube, ptCorner, diagInward, true);
      const halfNeg = clipConvexPolyhedronByPlane(
        cube,
        ptCorner,
        [-diagInward[0], -diagInward[1], -diagInward[2]],
        true,
      );

      expect(halfPos).not.toBeNull();
      if (halfPos) {
        expect(validateWatertightConvexPolyhedron(halfPos)).toEqual({ valid: true, euler: 2 });
        expect(RAPIER.ColliderDesc.convexHull(halfPos.vertices)).not.toBeNull();
      }
      if (halfNeg) {
        expect(validateWatertightConvexPolyhedron(halfNeg)).toEqual({ valid: true, euler: 2 });
        expect(RAPIER.ColliderDesc.convexHull(halfNeg.vertices)).not.toBeNull();
      }
      const sumCornerVol = (halfPos?.volumeM3 ?? 0) + (halfNeg?.volumeM3 ?? 0);
      expect(Math.abs(sumCornerVol - 8.0)).toBeLessThan(1e-4);

      // Ребро (+1, +1, z), скользящий наклонный срез
      const skewedEdgeNormal = vec3Normalize([-1, -1, -0.02]);
      const ptEdge: Vec3 = [
        1 + edgeInward[0] * d,
        1 + edgeInward[1] * d,
        0,
      ];
      const edgePos = clipConvexPolyhedronByPlane(cube, ptEdge, skewedEdgeNormal, true);
      const edgeNeg = clipConvexPolyhedronByPlane(
        cube,
        ptEdge,
        [-skewedEdgeNormal[0], -skewedEdgeNormal[1], -skewedEdgeNormal[2]],
        true,
      );
      expect(edgePos).not.toBeNull();
      if (edgePos) {
        expect(validateWatertightConvexPolyhedron(edgePos)).toEqual({ valid: true, euler: 2 });
      }
      if (edgeNeg) {
        expect(validateWatertightConvexPolyhedron(edgeNeg)).toEqual({ valid: true, euler: 2 });
      }
      expect(Math.abs((edgePos?.volumeM3 ?? 0) + (edgeNeg?.volumeM3 ?? 0) - 8.0)).toBeLessThan(1e-4);
    }

    // Точный репродьюсер ревьюера: [-1 + 3e-7, -1 + 3e-7, -1 + 3e-7] с нормалью [1, 1, 1]
    const ptRev: Vec3 = [-1 + 3e-7, -1 + 3e-7, -1 + 3e-7];
    const revPos = clipConvexPolyhedronByPlane(cube, ptRev, [1, 1, 1], true);
    const revNeg = clipConvexPolyhedronByPlane(cube, ptRev, [-1, -1, -1], true);
    expect(revPos).not.toBeNull();
    expect(validateWatertightConvexPolyhedron(revPos!)).toEqual({ valid: true, euler: 2 });
    expect(Math.abs((revPos?.volumeM3 ?? 0) + (revNeg?.volumeM3 ?? 0) - 8.0)).toBeLessThan(1e-4);

    // 2. Острый трёхгранный угол (узкий клин-тетраэдр, высеченный из куба)
    let acuteWedge = clipConvexPolyhedronByPlane(
      cube,
      [0, 0, 0],
      vec3Normalize([0.12, -1, 0]),
      true,
    )!;
    acuteWedge = clipConvexPolyhedronByPlane(
      acuteWedge,
      [0, 0, 0],
      vec3Normalize([0.12, 1, 0]),
      true,
    )!;
    expect(validateWatertightConvexPolyhedron(acuteWedge)).toEqual({ valid: true, euler: 2 });

    const wedgeRaw = toRawPolyhedron64(acuteWedge);
    // Находим самую выступающую вдоль +X вершину острого ребра клина
    let tipIdx = 0;
    let maxTipX = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < wedgeRaw.vertices.length / 3; i++) {
      if (wedgeRaw.vertices[i * 3]! > maxTipX) {
        maxTipX = wedgeRaw.vertices[i * 3]!;
        tipIdx = i;
      }
    }
    const tipPt: Vec3 = [
      wedgeRaw.vertices[tipIdx * 3]!,
      wedgeRaw.vertices[tipIdx * 3 + 1]!,
      wedgeRaw.vertices[tipIdx * 3 + 2]!,
    ];
    const inwardFromTip = vec3Normalize([-1, -0.05, -0.08]);

    for (const d of distances) {
      const cutPt: Vec3 = [
        tipPt[0] + inwardFromTip[0] * d,
        tipPt[1] + inwardFromTip[1] * d,
        tipPt[2] + inwardFromTip[2] * d,
      ];
      const wPos = clipConvexPolyhedronByPlane(acuteWedge, cutPt, inwardFromTip, true);
      const wNeg = clipConvexPolyhedronByPlane(
        acuteWedge,
        cutPt,
        [-inwardFromTip[0], -inwardFromTip[1], -inwardFromTip[2]],
        true,
      );
      expect(wPos).not.toBeNull();
      if (wPos) {
        expect(validateWatertightConvexPolyhedron(wPos)).toEqual({ valid: true, euler: 2 });
      }
      if (wNeg) {
        expect(validateWatertightConvexPolyhedron(wNeg)).toEqual({ valid: true, euler: 2 });
      }
      const sumWedge = (wPos?.volumeM3 ?? 0) + (wNeg?.volumeM3 ?? 0);
      expect(Math.abs(sumWedge - acuteWedge.volumeM3)).toBeLessThan(1e-4);
    }
  });

  it('регрессия №2: выдерживает стресс-цепочку последовательных отсечений (20 trials × 15 шагов) с euler === 2 на каждом шаге', () => {
    // Проверяем весь спектр пограничных отступов: точный репродьюсер challenger_m1_1 (1.05e-6),
    // границу VERTEX_MERGE_EPS (2.05e-6), переходную зону mergeTol (5e-6, 1.5e-5, 3.15e-5) и MIN_POLY_THICKNESS_M (1e-4)
    for (const baseEps of [1.05e-6, 2.05e-6, 5e-6, 1.5e-5, 3.15e-5, 1e-4]) {
      for (let trial = 0; trial < 20; trial++) {
        const rng = new SeededRng(0x13572468 + trial * 997);
        let current = createBoxPolyhedron([3.0, 3.0, 3.0]);

        for (let step = 0; step < 15; step++) {
          const prevVolume = current.volumeM3;
          const vCount = current.vertices.length / 3;
          const n = rng.unitVec3();
          const vi = rng.int(0, vCount - 1);
          const eps = step % 4 === 0 ? 0 : baseEps;
          const planePt: Vec3 =
            step % 2 === 0
              ? [
                  current.centroid[0] + current.vertices[vi * 3]! - n[0] * eps,
                  current.centroid[1] + current.vertices[vi * 3 + 1]! - n[1] * eps,
                  current.centroid[2] + current.vertices[vi * 3 + 2]! - n[2] * eps,
                ]
              : (() => {
                  const off = computePolyhedronMinThickness(current) * rng.range(-0.25, 0.25);
                  return [
                    current.centroid[0] + n[0] * off,
                    current.centroid[1] + n[1] * off,
                    current.centroid[2] + n[2] * off,
                  ];
                })();

          const p1 = clipConvexPolyhedronByPlane(current, planePt, n, true);
          const p2 = clipConvexPolyhedronByPlane(
            current,
            planePt,
            [-n[0], -n[1], -n[2]],
            true,
          );

          expect(p1 !== null || p2 !== null).toBe(true);

          if (p1) {
            expect(validateWatertightConvexPolyhedron(p1)).toEqual({ valid: true, euler: 2 });
            expect(RAPIER.ColliderDesc.convexHull(p1.vertices)).not.toBeNull();
          }
          if (p2) {
            expect(validateWatertightConvexPolyhedron(p2)).toEqual({ valid: true, euler: 2 });
            expect(RAPIER.ColliderDesc.convexHull(p2.vertices)).not.toBeNull();
          }

          const stepVolumeSum = (p1?.volumeM3 ?? 0) + (p2?.volumeM3 ?? 0);
          expect(Math.abs(stepVolumeSum - prevVolume) / prevVolume).toBeLessThan(1e-3);

          current = p1 && p2 ? (p1.volumeM3 >= p2.volumeM3 ? p1 : p2) : (p1 ?? p2)!;
        }
      }
    }
  });

  it('регрессия №3: строго соблюдает верхнюю границу shardCount = 1 и shardCount = 2 для всех 6 материалов (включая glass)', () => {
    for (const materialId of STRUCTURAL_MATERIAL_IDS) {
      for (const shardCount of [1, 2]) {
        for (const halfExtents of [
          [1.0, 1.0, 0.01] as Vec3,
          [0.8, 0.6, 0.4] as Vec3,
        ]) {
          for (const seed of [1, 42, 777]) {
            const res = fractureBoxVoronoi3D({
              halfExtents,
              materialId,
              shardCount,
              seed,
            });

            expect(res.shards.length).toBeGreaterThanOrEqual(1);
            expect(res.shards.length).toBeLessThanOrEqual(shardCount);

            const volRelErr =
              Math.abs(res.totalShardsVolumeM3 - res.originalVolumeM3) / res.originalVolumeM3;
            expect(volRelErr).toBeLessThan(0.005);

            for (const sh of res.shards) {
              expect(validateWatertightConvexPolyhedron(sh.polyhedron)).toEqual({
                valid: true,
                euler: 2,
              });
            }
          }
        }
      }
    }
  });

  it('регрессия №4: исключает двойное смещение worldPosition и сбрасывает локальный centroid при shardCount = 1 и в carveLocalBreach3D', () => {
    // Получаем реальный осколок 1-го поколения с заведомо ненулевым собственным polyhedron.centroid
    const gen1 = fractureBoxVoronoi3D({
      halfExtents: [2.5, 1.8, 0.3],
      materialId: 'reinforced_concrete',
      worldPosition: [10, 5, -3],
      shardCount: 4,
      seed: 90909,
    });
    const shiftedShard = gen1.shards.find((s) => vec3Len(s.polyhedron.centroid) > 0.2)!;
    expect(shiftedShard).toBeDefined();

    // 1. Раскол с shardCount = 1 обязан вернуть локальный centroid = [0, 0, 0] и точный worldPosition без удвоения
    const singleRes = fracturePolyhedronVoronoi3D({
      polyhedron: shiftedShard.polyhedron,
      materialId: 'reinforced_concrete',
      worldPosition: shiftedShard.worldPosition,
      shardCount: 1,
      seed: 123,
    });
    expect(singleRes.shards).toHaveLength(1);
    expect(singleRes.shards[0]!.polyhedron.centroid).toEqual([0, 0, 0]);
    expect(singleRes.shards[0]!.worldPosition).toEqual(shiftedShard.worldPosition);

    // 2. Вызов carveLocalBreach3D на сегменте стены с ненулевым входным polyhedron.centroid:
    // взвешенный по массе мировой центр масс всех частей обязан точно совпадать с parentWorldPos
    const parentWall = createBoxPolyhedron([4.0, 2.5, 0.3]);
    const shiftedWallPiece = clipConvexPolyhedronByPlane(
      parentWall,
      [-1.0, 0, 0],
      [1, 0, 0],
      true,
    )!;
    expect(vec3Len(shiftedWallPiece.centroid)).toBeGreaterThan(0.4);

    const parentWorldPos: Vec3 = [15.0, 4.0, -8.0];
    const quat = quatFromAxisAngle([0, 1, 0], 0.55);

    const breach = carveLocalBreach3D({
      polyhedron: shiftedWallPiece,
      materialId: 'reinforced_concrete',
      worldPosition: parentWorldPos,
      worldQuaternion: quat,
      impactPointLocal: [0.1, 0.0, 0.0],
      breachRadiusM: 0.7,
      shardCount: 4,
      seed: 556677,
    });
    expect(breach.isLocalBreach).toBe(true);

    const allParts = [...breach.survivingPieces, ...breach.breachShards];
    const comWorld: Vec3 = [0, 0, 0];
    for (const part of allParts) {
      comWorld[0] += part.massKg * part.worldPosition[0];
      comWorld[1] += part.massKg * part.worldPosition[1];
      comWorld[2] += part.massKg * part.worldPosition[2];
    }
    comWorld[0] /= breach.totalResultMassKg;
    comWorld[1] /= breach.totalResultMassKg;
    comWorld[2] /= breach.totalResultMassKg;
    expect(vec3Dist(comWorld, parentWorldPos)).toBeLessThan(1e-4);

    // И проверка fallback-ветки carveLocalBreach3D с shardCount = 1 на компактном полиэдре с ненулевым centroid
    const compactBase = createBoxPolyhedron([0.5, 0.5, 0.5]);
    const shiftedCompact = clipConvexPolyhedronByPlane(
      compactBase,
      [-0.1, 0, 0],
      [1, 0, 0],
      true,
    )!;
    expect(vec3Len(shiftedCompact.centroid)).toBeGreaterThan(0.02);

    const compactWorldPos: Vec3 = [-6.0, 2.0, 9.0];
    const fallbackBreach = carveLocalBreach3D({
      polyhedron: shiftedCompact,
      materialId: 'brick',
      worldPosition: compactWorldPos,
      impactPointLocal: [0, 0, 0],
      breachRadiusM: 1.2,
      shardCount: 1,
      seed: 334455,
    });
    expect(fallbackBreach.isLocalBreach).toBe(false);
    expect(fallbackBreach.breachShards).toHaveLength(1);
    expect(fallbackBreach.breachShards[0]!.polyhedron.centroid).toEqual([0, 0, 0]);
    expect(fallbackBreach.breachShards[0]!.worldPosition).toEqual(compactWorldPos);
  });

  it('регрессия №5: исключает самопроизвольный разлёт EPA в RAPIER.World при g = 0 (Gen1/Gen2 бреши и Вороной) и соблюдает shardCount = 1..2 в carveLocalBreach3D', () => {
    const simulateZeroGravityEnsemble = (
      parts: ReadonlyArray<{
        polyhedron: { vertices: Float32Array; volumeM3: number };
        worldPosition: [number, number, number];
        massKg: number;
      }>,
      quat: readonly [number, number, number, number],
      fixedPrefixCount = 0,
    ): { maxSpeedMpS: number; maxDriftM: number } => {
      const world = new RAPIER.World({ x: 0, y: 0, z: 0 });
      world.timestep = 1 / 60;
      try {
        const bodies: Array<{ rb: ReturnType<typeof world.createRigidBody>; start: Vec3 }> = [];
        for (let i = 0; i < parts.length; i++) {
          const part = parts[i]!;
          const hull = RAPIER.ColliderDesc.convexHull(part.polyhedron.vertices);
          expect(hull).not.toBeNull();
          const density = Math.max(100, part.massKg / Math.max(1e-9, part.polyhedron.volumeM3));
          const rbDesc = (
            i < fixedPrefixCount ? RAPIER.RigidBodyDesc.fixed() : RAPIER.RigidBodyDesc.dynamic()
          )
            .setTranslation(part.worldPosition[0], part.worldPosition[1], part.worldPosition[2])
            .setRotation({ x: quat[0], y: quat[1], z: quat[2], w: quat[3] });
          const rb = world.createRigidBody(rbDesc);
          world.createCollider(hull!.setDensity(density), rb);
          if (i >= fixedPrefixCount) {
            bodies.push({
              rb,
              start: [part.worldPosition[0], part.worldPosition[1], part.worldPosition[2]],
            });
          }
        }

        let maxSpeedMpS = 0;
        let maxDriftM = 0;
        for (let step = 0; step < 60; step++) {
          world.step();
          for (let b = 0; b < bodies.length; b++) {
            const { rb, start } = bodies[b]!;
            const v = rb.linvel();
            const speed = Math.hypot(v.x, v.y, v.z);
            if (speed > maxSpeedMpS) {
              maxSpeedMpS = speed;
            }
            const p = rb.translation();
            const drift = Math.hypot(p.x - start[0], p.y - start[1], p.z - start[2]);
            if (drift > maxDriftM) {
              maxDriftM = drift;
            }
          }
        }
        return { maxSpeedMpS, maxDriftM };
      } finally {
        world.free();
      }
    };

    const elevatedPos: Vec3 = [14.5, 22.0, -9.3];
    const quats: ReadonlyArray<readonly [number, number, number, number]> = [
      [0, 0, 0, 1],
      quatFromAxisAngle([0.55, 0.72, -0.42], 0.94),
      quatFromAxisAngle([-0.31, 0.48, 0.82], 1.47),
    ];

    // 1. Горизонтальная плита [4.2, 0.22, 3.6] и ЖБ-стена: проверка shardCount ∈ {1, 2, 10} и покоя при g = 0
    const slabPoly = createBoxPolyhedron([4.2, 0.22, 3.6]);
    const wallPoly = createBoxPolyhedron([3.2, 2.1, 0.25]);

    for (let qIdx = 0; qIdx < quats.length; qIdx++) {
      const quat = quats[qIdx]!;
      for (const shardCount of [1, 2, 10]) {
        const slabBreach = carveLocalBreach3D({
          polyhedron: slabPoly,
          materialId: 'reinforced_concrete',
          worldPosition: elevatedPos,
          worldQuaternion: [quat[0], quat[1], quat[2], quat[3]],
          impactPointLocal: [-0.5, 0, 0.4],
          breachRadiusM: 0.8,
          shardCount,
          seed: 11000 + qIdx * 100 + shardCount,
        });

        expect(slabBreach.isLocalBreach).toBe(true);
        expect(slabBreach.breachShards.length).toBeGreaterThanOrEqual(1);
        expect(slabBreach.breachShards.length).toBeLessThanOrEqual(shardCount);

        const slabVolErr =
          Math.abs(slabBreach.totalResultVolumeM3 - slabBreach.originalVolumeM3) /
          slabBreach.originalVolumeM3;
        expect(slabVolErr).toBeLessThan(0.0005);

        const allSlabParts = [...slabBreach.survivingPieces, ...slabBreach.breachShards];
        const dynStats = simulateZeroGravityEnsemble(allSlabParts, quat, 0);
        expect(dynStats.maxSpeedMpS).toBeLessThan(0.01);
        expect(dynStats.maxDriftM).toBeLessThan(0.005);

        // Режим fixed уцелевших сегментов + dynamic выбитых осколков
        const mixedStats = simulateZeroGravityEnsemble(
          allSlabParts,
          quat,
          slabBreach.survivingPieces.length,
        );
        expect(mixedStats.maxSpeedMpS).toBeLessThan(0.01);

        const wallBreach = carveLocalBreach3D({
          polyhedron: wallPoly,
          materialId: 'brick',
          worldPosition: elevatedPos,
          worldQuaternion: [quat[0], quat[1], quat[2], quat[3]],
          impactPointLocal: [0.3, -0.2, 0],
          breachRadiusM: 0.75,
          shardCount,
          seed: 22000 + qIdx * 100 + shardCount,
        });
        expect(wallBreach.isLocalBreach).toBe(true);
        expect(wallBreach.breachShards.length).toBeGreaterThanOrEqual(1);
        expect(wallBreach.breachShards.length).toBeLessThanOrEqual(shardCount);
        const wallVolErr =
          Math.abs(wallBreach.totalResultVolumeM3 - wallBreach.originalVolumeM3) /
          wallBreach.originalVolumeM3;
        expect(wallVolErr).toBeLessThan(0.0005);

        const wallDynStats = simulateZeroGravityEnsemble(
          [...wallBreach.survivingPieces, ...wallBreach.breachShards],
          quat,
          0,
        );
        expect(wallDynStats.maxSpeedMpS).toBeLessThan(0.01);
      }
    }

    // 2. Каскадный пролом 2-го поколения (Gen1 + повторный пролом survivingPieces[0] Gen2) на плите [4.2, 0.22, 3.6]
    for (let qIdx = 0; qIdx < quats.length; qIdx++) {
      const quat = quats[qIdx]!;
      const gen1 = carveLocalBreach3D({
        polyhedron: slabPoly,
        materialId: 'reinforced_concrete',
        worldPosition: elevatedPos,
        worldQuaternion: [quat[0], quat[1], quat[2], quat[3]],
        impactPointLocal: [-0.9, 0, 0.5],
        breachRadiusM: 0.75,
        shardCount: 8,
        seed: 33100 + qIdx,
      });
      expect(gen1.isLocalBreach).toBe(true);
      expect(gen1.survivingPieces.length).toBeGreaterThanOrEqual(2);

      // Выбираем первый уцелевший сегмент survivingPieces[0] и пробиваем в нём второй пролом Gen2
      const targetSeg = gen1.survivingPieces[0]!;
      const gen2 = carveLocalBreach3D({
        polyhedron: targetSeg.polyhedron,
        materialId: 'reinforced_concrete',
        worldPosition: targetSeg.worldPosition,
        worldQuaternion: [quat[0], quat[1], quat[2], quat[3]],
        impactPointLocal: [0, 0, 0],
        breachRadiusM: 0.55,
        shardCount: 6,
        seed: 44200 + qIdx,
      });

      const combinedEnsemble = [
        ...gen1.survivingPieces.slice(1),
        ...gen1.breachShards,
        ...gen2.survivingPieces,
        ...gen2.breachShards,
      ];
      const totalCascadeVol = combinedEnsemble.reduce((s, p) => s + p.polyhedron.volumeM3, 0);
      expect(Math.abs(totalCascadeVol - slabPoly.volumeM3) / slabPoly.volumeM3).toBeLessThan(
        0.0005,
      );

      const cascadeStats = simulateZeroGravityEnsemble(combinedEnsemble, quat, 0);
      expect(cascadeStats.maxSpeedMpS).toBeLessThan(0.01);
      expect(cascadeStats.maxDriftM).toBeLessThan(0.005);
    }

    // 3. Чистый fractureBoxVoronoi3D (включая тонкое стекло 12–20 мм, стеклянный блок и все 6 материалов) при g = 0
    const voronoiCases: Array<{
      halfExtents: Vec3;
      materialId: (typeof STRUCTURAL_MATERIAL_IDS)[number];
      shardCount: number;
      seed: number;
    }> = [
      { halfExtents: [0.45, 0.55, 0.45], materialId: 'glass', shardCount: 10, seed: 14110 },
      { halfExtents: [1.2, 1.5, 0.01], materialId: 'glass', shardCount: 14, seed: 9191 },
      { halfExtents: [0.8, 1.0, 0.006], materialId: 'glass', shardCount: 12, seed: 9292 },
      {
        halfExtents: [0.9, 0.7, 0.45],
        materialId: 'reinforced_concrete',
        shardCount: 12,
        seed: 5101,
      },
      { halfExtents: [0.9, 0.7, 0.45], materialId: 'brick', shardCount: 12, seed: 5102 },
      { halfExtents: [1.4, 0.2, 0.2], materialId: 'wood', shardCount: 10, seed: 5103 },
      { halfExtents: [0.8, 0.6, 0.4], materialId: 'steel', shardCount: 12, seed: 5104 },
      { halfExtents: [0.5, 0.6, 0.5], materialId: 'explosive', shardCount: 10, seed: 5105 },
    ];

    for (const tc of voronoiCases) {
      const quat = quats[1]!;
      const res = fractureBoxVoronoi3D({
        halfExtents: tc.halfExtents,
        materialId: tc.materialId,
        worldPosition: elevatedPos,
        worldQuaternion: [quat[0], quat[1], quat[2], quat[3]],
        impactPointLocal: [0.08, -0.06, 0],
        shardCount: tc.shardCount,
        seed: tc.seed,
      });
      const volErr =
        Math.abs(res.totalShardsVolumeM3 - res.originalVolumeM3) / res.originalVolumeM3;
      expect(volErr).toBeLessThan(0.005);

      const stats = simulateZeroGravityEnsemble(res.shards, quat, 0);
      expect(stats.maxSpeedMpS).toBeLessThan(0.01);
      expect(stats.maxDriftM).toBeLessThan(0.005);
    }
  });

  it('регрессия №6: укладывает среднее CPU-время fractureBoxVoronoi3D (shardCount = 12, 6 материалов, 60 вызовов) строго в бюджет < 2.0 мс', () => {
    const halfExtents: Vec3 = [1.1, 0.8, 0.45];
    const worldPos: Vec3 = [14.5, 22.0, -9.3];
    const worldQuat = quatFromAxisAngle([0.48, 0.71, -0.51], 0.88);

    // Короткий прогрев JIT-компилятора V8 перед замером
    for (let w = 0; w < 18; w++) {
      const mat = STRUCTURAL_MATERIAL_IDS[w % STRUCTURAL_MATERIAL_IDS.length]!;
      const warmRes = fractureBoxVoronoi3D({
        halfExtents,
        materialId: mat,
        worldPosition: worldPos,
        worldQuaternion: worldQuat,
        impactPointLocal: [0.1, -0.05, 0.02],
        shardCount: 12,
        seed: 7000 + w,
      });
      expect(warmRes.shards.length).toBeGreaterThanOrEqual(4);
    }

    const totalRuns = 60;
    let totalShardsProduced = 0;
    const tStart = performance.now();

    for (let i = 0; i < totalRuns; i++) {
      const mat = STRUCTURAL_MATERIAL_IDS[i % STRUCTURAL_MATERIAL_IDS.length]!;
      const impact: Vec3 = [
        ((i % 5) - 2) * 0.14,
        (((i * 3) % 5) - 2) * 0.1,
        (((i * 7) % 3) - 1) * 0.08,
      ];
      const res = fractureBoxVoronoi3D({
        halfExtents,
        materialId: mat,
        worldPosition: worldPos,
        worldQuaternion: worldQuat,
        impactPointLocal: impact,
        shardCount: 12,
        seed: 90000 + i * 37,
      });
      totalShardsProduced += res.shards.length;
    }

    const elapsedMs = performance.now() - tStart;
    const meanMs = elapsedMs / totalRuns;

    expect(totalShardsProduced).toBeGreaterThanOrEqual(totalRuns * 6);
    expect(meanMs).toBeLessThan(2.0);
  });
});

