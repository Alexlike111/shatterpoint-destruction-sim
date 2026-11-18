import { describe, expect, it } from 'vitest';
import {
  buildOrthonormalPlaneBasis,
  computeAabbFromPoints,
  computeObbWorldVertices,
  computePolyhedronVolumeAndCentroid,
  computePrincipalStretch3D,
  obbIntersectsObb,
  quatConjugate,
  quatFromAxisAngle,
  quatIdentity,
  quatInverseRotateVec3,
  quatMultiply,
  quatRotateVec3,
  vec3Add,
  vec3Cross,
  vec3Dist,
  vec3Dot,
  vec3Len,
  vec3Scale,
} from '../../../src/core/math3d';
import { SeededRng } from '../../../src/core/rng';
import type { ConvexFace3D, Vec3 } from '../../../src/core/types';

describe('Трёхмерная математика ядра (math3d): кватернионы, базисы, SAT OBB и Остроградский—Гаусс', () => {
  it('исключает отрицательный ноль (-0) в кватернионах и масштабировании векторов', () => {
    const conj = quatConjugate(quatIdentity());
    expect(conj).toEqual([0, 0, 0, 1]);
    expect(Object.is(conj[0], -0)).toBe(false);
    expect(Object.is(conj[1], -0)).toBe(false);
    expect(Object.is(conj[2], -0)).toBe(false);

    const scaled = vec3Scale([0, -5, 3], 0);
    expect(scaled).toEqual([0, 0, 0]);
    expect(Object.is(scaled[1], -0)).toBe(false);
  });

  it('гарантирует правую ортонормированную тройку u × v = +n на 200 направлениях сферы и осях ±X/±Y/±Z', () => {
    const rng = new SeededRng(314159);
    const directions: Vec3[] = [
      [1, 0, 0],
      [-1, 0, 0],
      [0, 1, 0],
      [0, -1, 0],
      [0, 0, 1],
      [0, 0, -1],
    ];
    for (let i = 0; i < 200; i++) {
      directions.push(rng.unitVec3());
    }

    for (const dir of directions) {
      const { n, u, v } = buildOrthonormalPlaneBasis(dir);
      expect(Math.abs(vec3Len(n) - 1)).toBeLessThan(1e-12);
      expect(Math.abs(vec3Len(u) - 1)).toBeLessThan(1e-12);
      expect(Math.abs(vec3Len(v) - 1)).toBeLessThan(1e-12);

      expect(Math.abs(vec3Dot(n, u))).toBeLessThan(1e-12);
      expect(Math.abs(vec3Dot(n, v))).toBeLessThan(1e-12);
      expect(Math.abs(vec3Dot(u, v))).toBeLessThan(1e-12);

      const crossUV = vec3Cross(u, v);
      expect(vec3Dist(crossUV, n)).toBeLessThan(1e-12);
    }
  });

  it('проверяет взаимную обратность поворотов кватернионов и композицию quatMultiply', () => {
    const rng = new SeededRng(271828);
    for (let i = 0; i < 100; i++) {
      const q1 = quatFromAxisAngle(rng.unitVec3(), rng.range(-Math.PI, Math.PI));
      const q2 = quatFromAxisAngle(rng.unitVec3(), rng.range(-Math.PI, Math.PI));
      const v: Vec3 = [rng.range(-10, 10), rng.range(-10, 10), rng.range(-10, 10)];

      const rotated = quatRotateVec3(q1, v);
      expect(Math.abs(vec3Len(rotated) - vec3Len(v))).toBeLessThan(1e-11);

      const restored = quatInverseRotateVec3(q1, rotated);
      expect(vec3Dist(restored, v)).toBeLessThan(1e-11);

      // Композиция поворотов: (q1 * q2)(v) === q1(q2(v))
      const q12 = quatMultiply(q1, q2);
      const stepByStep = quatRotateVec3(q1, quatRotateVec3(q2, v));
      const combined = quatRotateVec3(q12, v);
      expect(vec3Dist(combined, stepByStep)).toBeLessThan(1e-11);
    }
  });

  it('точно вычисляет объём и центроид параллелепипеда и несимметричного тетраэдра по Остроградскому—Гауссу', () => {
    // 1. Сдвинутый параллелепипед 2 × 3 × 5 м (V = 30 м³) с центром [4.5, -2.0, 7.25]
    const center: Vec3 = [4.5, -2.0, 7.25];
    const boxVerts = computeObbWorldVertices(center, [1.0, 1.5, 2.5]);
    const boxFaces: Pick<ConvexFace3D, 'indices'>[] = [
      { indices: [1, 2, 6, 5] },
      { indices: [0, 4, 7, 3] },
      { indices: [3, 7, 6, 2] },
      { indices: [0, 1, 5, 4] },
      { indices: [4, 5, 6, 7] },
      { indices: [0, 3, 2, 1] },
    ];
    const boxMetrics = computePolyhedronVolumeAndCentroid(boxVerts, boxFaces);
    expect(Math.abs(boxMetrics.volumeM3 - 30)).toBeLessThan(1e-12);
    expect(Math.abs(boxMetrics.signedVolumeM3 - 30)).toBeLessThan(1e-12);
    expect(vec3Dist(boxMetrics.centroid, center)).toBeLessThan(1e-12);
    expect(vec3Dist(boxMetrics.halfExtentsApprox, [1.0, 1.5, 2.5])).toBeLessThan(1e-12);

    // 2. Прямоугольный тетраэдр с вершинами (0,0,0), (3,0,0), (0,4,0), (0,0,6):
    // V = (3 * 4 * 6) / 6 = 12 м³, аналитический центроид = (3/4, 4/4, 6/4) = (0.75, 1.0, 1.5)
    const tetVerts: Vec3[] = [
      [0, 0, 0], // 0
      [3, 0, 0], // 1
      [0, 4, 0], // 2
      [0, 0, 6], // 3
    ];
    // Все грани строго CCW снаружи
    const tetFaces: Pick<ConvexFace3D, 'indices'>[] = [
      { indices: [0, 2, 1] }, // нормаль -Z
      { indices: [0, 1, 3] }, // нормаль -Y
      { indices: [0, 3, 2] }, // нормаль -X
      { indices: [1, 2, 3] }, // нормаль (+,+,+)
    ];
    const tetMetrics = computePolyhedronVolumeAndCentroid(tetVerts, tetFaces);
    expect(Math.abs(tetMetrics.volumeM3 - 12)).toBeLessThan(1e-12);
    expect(vec3Dist(tetMetrics.centroid, [0.75, 1.0, 1.5])).toBeLessThan(1e-12);
  });

  it('сохраняет точность объёма мелкого Float32-осколка на огромном удалении от начала координат благодаря p_ref', () => {
    // Осколок 0.08 × 0.10 × 0.12 м (истинный объём 0.00096 м³), сдвинутый на ~30 км!
    // При использовании степеней двойки в полуразмерах или точных Float32 сдвигах без p_ref ошибка составила бы ~1000 м³!
    const offset: Vec3 = [10_000, -25_000, 15_000];
    const localVerts = computeObbWorldVertices([0, 0, 0], [0.04, 0.05, 0.06]);
    const farFloat32 = new Float32Array(24);
    for (let i = 0; i < 8; i++) {
      farFloat32[i * 3] = offset[0] + localVerts[i]![0];
      farFloat32[i * 3 + 1] = offset[1] + localVerts[i]![1];
      farFloat32[i * 3 + 2] = offset[2] + localVerts[i]![2];
    }

    const boxFaces: Pick<ConvexFace3D, 'indices'>[] = [
      { indices: [1, 2, 6, 5] },
      { indices: [0, 4, 7, 3] },
      { indices: [3, 7, 6, 2] },
      { indices: [0, 1, 5, 4] },
      { indices: [4, 5, 6, 7] },
      { indices: [0, 3, 2, 1] },
    ];

    const localFloat32 = new Float32Array(24);
    for (let i = 0; i < 8; i++) {
      localFloat32[i * 3] = farFloat32[i * 3]! - farFloat32[0]! - 0.04;
      localFloat32[i * 3 + 1] = farFloat32[i * 3 + 1]! - farFloat32[1]! - 0.05;
      localFloat32[i * 3 + 2] = farFloat32[i * 3 + 2]! - farFloat32[2]! - 0.06;
    }

    const farMetrics = computePolyhedronVolumeAndCentroid(farFloat32, boxFaces);
    const refMetrics = computePolyhedronVolumeAndCentroid(localFloat32, boxFaces);
    expect(Math.abs(farMetrics.volumeM3 - refMetrics.volumeM3)).toBeLessThan(1e-7);
    expect(farMetrics.volumeM3).toBeGreaterThan(0.0009);
    expect(farMetrics.volumeM3).toBeLessThan(0.00105);
  });

  it('корректно определяет пересечения и разделения повёрнутых OBB по всем 15 осям SAT и оценивает анизотропию Якоби', () => {
    const q45Z = quatFromAxisAngle([0, 0, 1], Math.PI / 4);
    const q45X = quatFromAxisAngle([1, 0, 0], Math.PI / 4);

    // Пересекающиеся повёрнутые балки
    expect(
      obbIntersectsObb(
        { center: [0, 0, 0], halfExtents: [2.0, 0.2, 0.2], rotationQuat: q45Z },
        { center: [0.1, -0.1, 0], halfExtents: [2.0, 0.2, 0.2], rotationQuat: q45X },
      ),
    ).toBe(true);

    // Скрещивающиеся наклонные балки, разделённые перекрёстной осью A_i × B_j
    const beamA = {
      center: [0, 0, 0] as Vec3,
      halfExtents: [3.0, 0.15, 0.15] as Vec3,
      rotationQuat: quatFromAxisAngle([0, 0, 1], Math.PI / 4),
    };
    const beamB = {
      center: [0, 0, 0.45] as Vec3,
      halfExtents: [3.0, 0.15, 0.15] as Vec3,
      rotationQuat: quatFromAxisAngle([0, 0, 1], -Math.PI / 4),
    };
    expect(obbIntersectsObb(beamA, beamB, 0)).toBe(false);
    expect(obbIntersectsObb(beamA, beamB, 0.2)).toBe(true);

    // Спектральная оценка вытянутости на повёрнутом брусе 3.4 × 1.0 × 1.0 м
    const rotQuat = quatFromAxisAngle([0.4, -0.7, 0.5], 1.15);
    const rotatedBeamVerts = computeObbWorldVertices([3, -4, 2], [1.7, 0.5, 0.5], rotQuat);
    const expectedAxis = quatRotateVec3(rotQuat, [1, 0, 0]);
    const stretch = computePrincipalStretch3D(rotatedBeamVerts, expectedAxis);

    expect(Math.abs(Math.abs(vec3Dot(stretch.majorAxis, expectedAxis)) - 1)).toBeLessThan(1e-6);
    expect(stretch.elongationRatio).toBeCloseTo(3.4, 3);
    expect(stretch.axisSpanRatio).toBeCloseTo(3.4, 3);

    const aabb = computeAabbFromPoints(rotatedBeamVerts);
    expect(vec3Dist(aabb.center, [3, -4, 2])).toBeLessThan(1e-12);
    expect(vec3Add(aabb.min, vec3Scale(aabb.halfExtents, 2))).toEqual(aabb.max);
  });
});
