import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { RenderBlockInstance, SimulationEvent } from '../../../src/core/types';
import { CameraRig } from '../../../src/render/CameraRig';
import { CollapseVFXSystem } from '../../../src/render/CollapseVFXSystem';
import { SceneRenderer } from '../../../src/render/SceneRenderer';

/**
 * Комплексные безмоковые модульные тесты 3D-камеры (CameraRig) и инстансированной системы частиц (CollapseVFXSystem).
 */

function linearToSrgb(c: number): number {
  const x = Math.max(0, c);
  return x <= 0.0031308 ? x * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
}

function assertColorNotPurple(color: THREE.Color, label: string): void {
  const maxC = Math.max(1.0, color.r, color.g, color.b);
  const r = linearToSrgb(color.r / maxC);
  const g = linearToSrgb(color.g / maxC);
  const b = linearToSrgb(color.b / maxC);
  const cMax = Math.max(r, g, b);
  const cMin = Math.min(r, g, b);
  const delta = cMax - cMin;
  if (cMax <= 0.05 || delta / cMax <= 0.08) return;

  let hue = 0;
  if (cMax === r) {
    hue = 60 * (((g - b) / delta) % 6);
  } else if (cMax === g) {
    hue = 60 * ((b - r) / delta + 2);
  } else {
    hue = 60 * ((r - g) / delta + 4);
  }
  if (hue < 0) hue += 360;

  expect(
    hue >= 262 && hue <= 318,
    `Запрещённый фиолетовый тон в VFX (${label}): hue=${hue.toFixed(1)}°`,
  ).toBe(false);
}

describe('CameraRig — обзор полигона 1280x720, мгновенные матрицы, лучи и физическая тряска', () => {
  it('гарантирует видимость всей сетки полигона (±14, 2, 0) с отступом > 16 px и условие upper.y < lower.y - 10', () => {
    const rig = new CameraRig();
    const width = 1280;
    const height = 720;

    const lower = rig.projectWorldToScreen([0, 1.5, 0], width, height);
    const upper = rig.projectWorldToScreen([0, 7.5, 0], width, height);
    expect(lower.visible).toBe(true);
    expect(upper.visible).toBe(true);
    expect(upper.y).toBeLessThan(lower.y - 10);

    const keyPoints: Array<[number, number, number]> = [
      [0, 1.5, 0],
      [0, 7.5, 0],
      [4, 2, 0],
      [-4, 2, 0],
      [14, 2, 0],
      [-14, 2, 0],
      [0, 2, 10],
      [0, 2, -10],
    ];

    for (const pt of keyPoints) {
      const proj = rig.projectWorldToScreen(pt, width, height);
      expect(proj.visible).toBe(true);
      expect(proj.x).toBeGreaterThan(16);
      expect(proj.x).toBeLessThan(width - 16);
      expect(proj.y).toBeGreaterThan(16);
      expect(proj.y).toBeLessThan(height - 16);
    }

    // Точка позади камеры обязана возвращать visible: false
    const camPos = rig.camera.position;
    const behindPoint: [number, number, number] = [
      camPos.x * 2.2,
      camPos.y * 2.2,
      camPos.z * 2.2,
    ];
    expect(rig.projectWorldToScreen(behindPoint, width, height).visible).toBe(false);

    // Защита от NaN / Infinity
    expect(rig.projectWorldToScreen([Number.NaN, 2, 0], width, height)).toEqual({
      x: 0,
      y: 0,
      visible: false,
    });
    expect(rig.projectWorldToScreen([0, Number.POSITIVE_INFINITY, 0], width, height)).toEqual({
      x: 0,
      y: 0,
      visible: false,
    });

    rig.dispose();
  });

  it('мгновенно обновляет проекции и лучи после orbit, pan, zoom, focusOnBounds и зажимает пределы углов', () => {
    const rig = new CameraRig();

    // Центральный луч (0, 0) обязан иметь единичную длину и точно проходить через начальную точку фокуса [0, 5.5, 0]
    const centerRay = rig.screenPointToRay(0, 0);
    const dirNorm = Math.hypot(
      centerRay.direction[0],
      centerRay.direction[1],
      centerRay.direction[2],
    );
    expect(dirNorm).toBeCloseTo(1.0, 6);

    const state0 = rig.getSphericalState();
    const hitCenterX = centerRay.origin[0] + centerRay.direction[0] * state0.distanceM;
    const hitCenterY = centerRay.origin[1] + centerRay.direction[1] * state0.distanceM;
    const hitCenterZ = centerRay.origin[2] + centerRay.direction[2] * state0.distanceM;
    expect(hitCenterX).toBeCloseTo(state0.target[0], 3);
    expect(hitCenterY).toBeCloseTo(state0.target[1], 3);
    expect(hitCenterZ).toBeCloseTo(state0.target[2], 3);

    // Мгновенный сдвиг проекции при вращении орбиты без промежуточного renderFrame
    const beforeOrbit = rig.projectWorldToScreen([4, 2, 0], 1280, 720);
    rig.orbit(0.42, -0.15);
    const afterOrbit = rig.projectWorldToScreen([4, 2, 0], 1280, 720);
    expect(Math.hypot(afterOrbit.x - beforeOrbit.x, afterOrbit.y - beforeOrbit.y)).toBeGreaterThan(
      25,
    );

    // Проверка приближения зумом колеса мыши (-360) — экранный размах между (-4,2,0) и (4,2,0) обязан вырасти
    rig.resetView();
    const leftBefore = rig.projectWorldToScreen([-4, 2, 0], 1280, 720);
    const rightBefore = rig.projectWorldToScreen([4, 2, 0], 1280, 720);
    const spanBefore = Math.hypot(rightBefore.x - leftBefore.x, rightBefore.y - leftBefore.y);

    rig.zoomByWheelDelta(-360);
    const leftAfter = rig.projectWorldToScreen([-4, 2, 0], 1280, 720);
    const rightAfter = rig.projectWorldToScreen([4, 2, 0], 1280, 720);
    const spanAfter = Math.hypot(rightAfter.x - leftAfter.x, rightAfter.y - leftAfter.y);
    expect(spanAfter).toBeGreaterThan(spanBefore + 25);

    // Экстремальные углы и дистанции обязаны безопасно зажиматься без переворота в зените и провала под землю
    rig.orbit(0, 10.0);
    expect(rig.camera.position.y).toBeGreaterThanOrEqual(0.45);
    expect(rig.getSphericalState().polarRad).toBeLessThan(Math.PI * 0.5);

    rig.orbit(0, -20.0);
    expect(rig.getSphericalState().polarRad).toBeGreaterThanOrEqual(0.08);

    rig.zoom(0.0001);
    expect(rig.getSphericalState().distanceM).toBeGreaterThanOrEqual(3.5);
    rig.zoom(100000);
    expect(rig.getSphericalState().distanceM).toBeLessThanOrEqual(180.0);

    // Панорамирование и фокусировка на границах
    rig.pan(3.5, 2.0);
    rig.focusOnBounds([-6, 8, 4], 9.0);
    const focusedProj = rig.projectWorldToScreen([-6, 8, 4], 1280, 720);
    expect(focusedProj.visible).toBe(true);
    expect(Math.abs(focusedProj.x - 640)).toBeLessThan(2.0);
    expect(Math.abs(focusedProj.y - 360)).toBeLessThan(2.0);

    rig.dispose();
  });

  it('возбуждает физическую 3D-тряску от взрывов и сейсмоплатформы и плавно гасит её в точный [0, 0, 0]', () => {
    const rig = new CameraRig({ seed: 777 });
    expect(rig.getShakeOffset()).toEqual([0, 0, 0]);

    rig.consumeEvents([
      {
        type: 'explosion',
        position: [0, 3, 0],
        radiusM: 8.5,
        equivalentKgTnt: 25,
        isChainDetonation: true,
      },
      {
        type: 'seismic_pulse',
        frequencyHz: 4.5,
        amplitudeM: 0.45,
        groundAccelMpS2: 6.2,
      },
    ]);

    const shakeNow = rig.getShakeOffset();
    const ampNow = Math.hypot(shakeNow[0], shakeNow[1], shakeNow[2]);
    expect(ampNow).toBeGreaterThan(0.01);

    // Продвигаем время на 1.5 секунды реального времени — тряска обязана полностью затухнуть в точный [0, 0, 0]
    for (let step = 0; step < 90; step++) {
      rig.update(1 / 60);
    }
    expect(rig.getShakeOffset()).toEqual([0, 0, 0]);

    // Проверка согласованности clientPointToNdc и projectWorldToScreen в SceneRenderer
    const renderer = new SceneRenderer({ headless: true, width: 1280, height: 720 });
    const ndcCenter = renderer.clientPointToNdc(640, 360);
    expect(ndcCenter[0]).toBeCloseTo(0, 5);
    expect(ndcCenter[1]).toBeCloseTo(0, 5);

    renderer.dispose();
    rig.dispose();
  });

  it('разделяет одиночный ПКМ (< 4 px), ПКМ-орбиту (>= 4 px), Shift+ПКМ-панораму и оставляет обычный ЛКМ свободным для оружия', () => {
    class SyntheticPointerEvent extends Event {
      public readonly pointerId: number;
      public readonly pointerType: string;
      public readonly button: number;
      public readonly clientX: number;
      public readonly clientY: number;
      public readonly shiftKey: boolean;
      public readonly ctrlKey: boolean;
      public readonly altKey: boolean;

      constructor(
        type: string,
        init: {
          pointerId?: number;
          pointerType?: string;
          button?: number;
          clientX?: number;
          clientY?: number;
          shiftKey?: boolean;
          ctrlKey?: boolean;
          altKey?: boolean;
        },
      ) {
        super(type, { cancelable: true });
        this.pointerId = init.pointerId ?? 1;
        this.pointerType = init.pointerType ?? 'mouse';
        this.button = init.button ?? 0;
        this.clientX = init.clientX ?? 0;
        this.clientY = init.clientY ?? 0;
        this.shiftKey = init.shiftKey ?? false;
        this.ctrlKey = init.ctrlKey ?? false;
        this.altKey = init.altKey ?? false;
      }
    }

    class SyntheticWheelEvent extends Event {
      public readonly deltaY: number;
      constructor(deltaY: number) {
        super('wheel', { cancelable: true });
        this.deltaY = deltaY;
      }
    }

    const surface = new EventTarget();
    const rig = new CameraRig();
    rig.attachCanvas(surface);

    const initialAz = rig.getSphericalState().azimuthRad;

    // 1. Обычный ЛКМ drag (резка плазморезаком) НЕ должен вращать камеру
    surface.dispatchEvent(
      new SyntheticPointerEvent('pointerdown', { button: 0, clientX: 500, clientY: 360 }),
    );
    surface.dispatchEvent(
      new SyntheticPointerEvent('pointermove', { button: 0, clientX: 650, clientY: 320 }),
    );
    surface.dispatchEvent(
      new SyntheticPointerEvent('pointerup', { button: 0, clientX: 650, clientY: 320 }),
    );
    expect(rig.getSphericalState().azimuthRad).toBeCloseTo(initialAz, 8);

    // 2. Одиночный правый клик с микросдвигом 2 px (< 4 px) НЕ должен сбивать прицел снятия C4
    surface.dispatchEvent(
      new SyntheticPointerEvent('pointerdown', { button: 2, clientX: 500, clientY: 360 }),
    );
    surface.dispatchEvent(
      new SyntheticPointerEvent('pointermove', { button: 2, clientX: 502, clientY: 361 }),
    );
    surface.dispatchEvent(
      new SyntheticPointerEvent('pointerup', { button: 2, clientX: 502, clientY: 361 }),
    );
    expect(rig.getSphericalState().azimuthRad).toBeCloseTo(initialAz, 8);

    // 3. Перетаскивание ПКМ на 150 px (>= 4 px) обязано плавно повернуть орбиту
    const projBefore = rig.projectWorldToScreen([4, 2, 0], 1280, 720);
    surface.dispatchEvent(
      new SyntheticPointerEvent('pointerdown', { button: 2, clientX: 500, clientY: 360 }),
    );
    surface.dispatchEvent(
      new SyntheticPointerEvent('pointermove', { button: 2, clientX: 650, clientY: 325 }),
    );
    surface.dispatchEvent(
      new SyntheticPointerEvent('pointerup', { button: 2, clientX: 650, clientY: 325 }),
    );
    const projAfter = rig.projectWorldToScreen([4, 2, 0], 1280, 720);
    expect(Math.hypot(projAfter.x - projBefore.x, projAfter.y - projBefore.y)).toBeGreaterThan(15);

    // 4. Shift + ПКМ панорамирует точку фокуса target
    const targetBefore = rig.getSphericalState().target;
    surface.dispatchEvent(
      new SyntheticPointerEvent('pointerdown', {
        button: 2,
        shiftKey: true,
        clientX: 400,
        clientY: 300,
      }),
    );
    surface.dispatchEvent(
      new SyntheticPointerEvent('pointermove', {
        button: 2,
        shiftKey: true,
        clientX: 520,
        clientY: 240,
      }),
    );
    surface.dispatchEvent(
      new SyntheticPointerEvent('pointerup', {
        button: 2,
        shiftKey: true,
        clientX: 520,
        clientY: 240,
      }),
    );
    const targetAfter = rig.getSphericalState().target;
    expect(
      Math.hypot(
        targetAfter[0] - targetBefore[0],
        targetAfter[1] - targetBefore[1],
        targetAfter[2] - targetBefore[2],
      ),
    ).toBeGreaterThan(0.5);

    // 5. Колесо мыши приближает дистанцию и вызывает preventDefault(), а contextmenu блокируется
    const distBefore = rig.getSphericalState().distanceM;
    const wheelEv = new SyntheticWheelEvent(-300);
    surface.dispatchEvent(wheelEv);
    expect(wheelEv.defaultPrevented).toBe(true);
    expect(rig.getSphericalState().distanceM).toBeLessThan(distBefore);

    const ctxMenuEv = new Event('contextmenu', { cancelable: true });
    surface.dispatchEvent(ctxMenuEv);
    expect(ctxMenuEv.defaultPrevented).toBe(true);

    rig.detachCanvas();
    rig.dispose();
  });
});

describe('CollapseVFXSystem — 4 SoA-пула частиц, баллистический отскок искр и угасание в 0 Draw Calls', () => {
  it('порождает частицы на все 7 типов SimulationEvent, имитирует отскок искр от пола и гаснет обратно в 0 Draw Calls', () => {
    const vfx = new CollapseVFXSystem({ quality: 'high', seed: 1024 });

    // В покое — строго 0 активных частиц и 0 Draw Calls
    expect(vfx.getActiveCounts().total).toBe(0);
    expect(vfx.getEstimatedDrawCalls()).toBe(0);

    const allEvents: SimulationEvent[] = [
      {
        type: 'fracture',
        position: [0, 2.5, 0],
        materialId: 'reinforced_concrete',
        energyJ: 6000,
        shardCount: 10,
      },
      {
        type: 'rebar_snap',
        position: [0.5, 0.25, 0], // низко над плитой, чтобы искры быстро ударились об пол и отскочили
        forceN: 240_000,
      },
      {
        type: 'steel_yield',
        position: [-1, 3.0, 0],
        angleRad: 0.35,
      },
      {
        type: 'secondary_impact',
        position: [2, 0.2, -1],
        materialId: 'brick',
        impulseNs: 45_000,
        massKg: 1800,
        targetTag: 'target',
      },
      {
        type: 'explosion',
        position: [0, 1.5, 0],
        radiusM: 7.5,
        equivalentKgTnt: 15,
        isChainDetonation: false,
      },
      {
        type: 'fire_ignited',
        nodeId: 12,
        position: [-2, 1.2, 1],
      },
      {
        type: 'seismic_pulse',
        frequencyHz: 3.0,
        amplitudeM: 0.5,
        groundAccelMpS2: 4.8,
      },
    ];

    vfx.consumeEvents(allEvents);
    const countsAfterBurst = vfx.getActiveCounts();
    expect(countsAfterBurst.dustAndSmoke).toBeGreaterThan(0);
    expect(countsAfterBurst.flames).toBeGreaterThan(0);
    expect(countsAfterBurst.sparks).toBeGreaterThan(0);
    expect(countsAfterBurst.shockwaves).toBe(2); // вспышка эпицентра + ударная сфера Садовского
    expect(vfx.getEstimatedDrawCalls()).toBe(4); // ровно 4 батча на все системы частиц!

    // Непрерывная эмиссия пламени и дыма от горящего деревянного блока
    const burningBlocks: RenderBlockInstance[] = [
      {
        nodeId: 12,
        materialId: 'wood',
        position: [-2, 1.5, 1],
        quaternion: [0, 0, 0, 1],
        halfExtents: [0.8, 0.5, 0.8],
        stressUtilization: 0.3,
        damageRatio: 0.2,
        temperatureC: 540,
        charRatio: 0.4,
        burning: true,
        structureGroupTag: 'target',
      },
    ];
    vfx.syncBurningBlocks(burningBlocks, 0.16);
    expect(vfx.getActiveCounts().flames).toBeGreaterThan(countsAfterBurst.flames);

    // Продвигаем баллистику на несколько кадров и проверяем отсутствие фиолетового и непроваливание искр под пол
    const meshes = vfx.getMeshes();
    const m4 = new THREE.Matrix4();
    const pos = new THREE.Vector3();
    const col = new THREE.Color();

    for (let step = 0; step < 12; step++) {
      vfx.update(1 / 60);
    }

    for (let i = 0; i < meshes.sparksMesh.count; i++) {
      meshes.sparksMesh.getMatrixAt(i, m4);
      pos.setFromMatrixPosition(m4);
      expect(pos.y).toBeGreaterThanOrEqual(0.039);
      meshes.sparksMesh.getColorAt(i, col);
      assertColorNotPurple(col, `spark#${i}`);
    }

    for (let i = 0; i < meshes.flameMesh.count; i++) {
      meshes.flameMesh.getColorAt(i, col);
      assertColorNotPurple(col, `flame#${i}`);
    }

    for (let i = 0; i < meshes.shockwaveMesh.count; i++) {
      meshes.shockwaveMesh.getColorAt(i, col);
      assertColorNotPurple(col, `shockwave#${i}`);
    }

    // Проверка соблюдения потолков кольцевого буфера при переключении в 'performance'
    for (let burst = 0; burst < 15; burst++) {
      vfx.consumeEvents(allEvents);
    }
    vfx.setQualityPreset('performance');
    const perfCounts = vfx.getActiveCounts();
    expect(perfCounts.dustAndSmoke).toBeLessThanOrEqual(160);
    expect(perfCounts.flames).toBeLessThanOrEqual(120);
    expect(perfCounts.sparks).toBeLessThanOrEqual(140);
    expect(perfCounts.shockwaves).toBeLessThanOrEqual(32);

    // Продвигаем время на 2.5 с без новых событий — все частицы обязаны естественным образом погаснуть
    for (let step = 0; step < 150; step++) {
      vfx.update(1 / 60);
    }
    expect(vfx.getActiveCounts().total).toBe(0);
    expect(vfx.getEstimatedDrawCalls()).toBe(0);
    expect(meshes.dustSmokeMesh.visible).toBe(false);
    expect(meshes.flameMesh.visible).toBe(false);
    expect(meshes.sparksMesh.visible).toBe(false);
    expect(meshes.shockwaveMesh.visible).toBe(false);

    vfx.dispose();
    expect(() => vfx.dispose()).not.toThrow();
  });

  it('безопасно обрабатывает горящие блоки с отрицательными и NaN/Infinity halfExtents и вызовы после dispose()', () => {
    const renderer = new SceneRenderer({ headless: true, quality: 'high', seed: 5150 });

    const trickyBurningBlocks: RenderBlockInstance[] = [
      {
        nodeId: 1,
        materialId: 'wood',
        position: [0, 2, 0],
        quaternion: [0, 0, 0, 1],
        halfExtents: [-1.0, -0.5, -0.8],
        stressUtilization: 0.4,
        damageRatio: 0.3,
        temperatureC: 620,
        charRatio: 0.5,
        burning: true,
        structureGroupTag: 'target',
      },
      {
        nodeId: 2,
        materialId: 'wood',
        position: [2, 3, -1],
        quaternion: [0, 0, 0, 1],
        halfExtents: [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY],
        stressUtilization: 0.5,
        damageRatio: 0.2,
        temperatureC: 700,
        charRatio: 0.3,
        burning: true,
        structureGroupTag: 'target',
      },
      {
        nodeId: 3,
        materialId: 'wood',
        position: [Number.NaN, Number.POSITIVE_INFINITY, 0],
        quaternion: [0, 0, 0, 1],
        halfExtents: [-2, Number.MAX_VALUE, Number.NaN],
        stressUtilization: 0.1,
        damageRatio: 0,
        temperatureC: 500,
        charRatio: 0.1,
        burning: true,
        structureGroupTag: 'target',
      },
    ];

    expect(() => {
      renderer.syncSnapshot({
        tick: 1,
        simTimeSec: 0.05,
        platformOffset: [0, 0, 0],
        blocks: trickyBurningBlocks,
        shards: [],
        bondsAndRebars: [],
        plantedCharges: [],
        projectiles: [],
      });
      renderer.consumeEvents([
        {
          type: 'fracture',
          position: [Number.NaN, 2, 0],
          materialId: 'brick',
          energyJ: Number.NaN,
          shardCount: Number.POSITIVE_INFINITY,
        },
        {
          type: 'explosion',
          position: [0, 2, 0],
          radiusM: Number.NaN,
          equivalentKgTnt: Number.POSITIVE_INFINITY,
          isChainDetonation: true,
        },
        {
          type: 'explosion',
          position: [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY],
          radiusM: Number.POSITIVE_INFINITY,
          equivalentKgTnt: Number.NaN,
          isChainDetonation: false,
        },
        {
          type: 'seismic_pulse',
          frequencyHz: Number.NaN,
          amplitudeM: Number.NaN,
          groundAccelMpS2: Number.POSITIVE_INFINITY,
        },
      ]);
      renderer.renderFrame(0.1);
      renderer.renderFrame(Number.NaN);
      renderer.renderFrame(Number.POSITIVE_INFINITY);
      renderer.renderFrame(-1);
    }).not.toThrow();

    const vfx = renderer.getLayers().vfxSystem;
    expect(vfx.getActiveCounts().flames).toBeGreaterThan(0);

    // Все элементы матриц и цветов сцены (включая частицы VFX и свет вспышки) обязаны оставаться конечными
    renderer.getScene().traverse((obj) => {
      for (const el of obj.matrixWorld.elements) {
        if (!Number.isFinite(el)) {
          expect.fail(`Неконечный элемент matrixWorld у ${obj.name || obj.type}`);
        }
      }
      if (obj instanceof THREE.Light) {
        expect(Number.isFinite(obj.intensity)).toBe(true);
      }
      if (obj instanceof THREE.InstancedMesh) {
        for (let i = 0; i < obj.instanceMatrix.array.length; i++) {
          if (!Number.isFinite(obj.instanceMatrix.array[i])) {
            expect.fail(`Неконечный элемент instanceMatrix[${i}] у ${obj.name}`);
          }
        }
      }
    });

    // После dispose() все публичные методы CollapseVFXSystem безопасны и возвращают нули
    vfx.dispose();
    vfx.dispose();
    expect(() => {
      vfx.consumeEvents([
        { type: 'rebar_snap', position: [0, 1, 0], forceN: 100_000 },
      ]);
      vfx.syncBurningBlocks(trickyBurningBlocks, 0.1);
      vfx.update(0.05);
      vfx.setQualityPreset('performance');
      vfx.clear();
      vfx.getObject3D();
      vfx.getMeshes();
    }).not.toThrow();
    expect(vfx.getActiveCounts().total).toBe(0);
    expect(vfx.getEstimatedDrawCalls()).toBe(0);

    renderer.dispose();
  });
});

describe('Состязательная устойчивость CameraRig и SceneRenderer к near >= far, NaN и ±Infinity (R7 Fix)', () => {
  it('гарантирует far >= near + 100 при любых опциях near/far и защищает матрицы камеры, тряску и NDC от NaN/Infinity', () => {
    const cases = [
      new CameraRig({ near: 600 }),
      new CameraRig({ near: 600, far: Number.NaN }),
      new CameraRig({ near: 600, far: 605 }),
      new CameraRig({ near: 5000 }),
      new CameraRig({ near: Number.POSITIVE_INFINITY, far: Number.NEGATIVE_INFINITY }),
    ];

    for (const rig of cases) {
      expect(Number.isFinite(rig.camera.near)).toBe(true);
      expect(Number.isFinite(rig.camera.far)).toBe(true);
      expect(rig.camera.near).toBeGreaterThanOrEqual(0.01);
      expect(rig.camera.far).toBeGreaterThanOrEqual(rig.camera.near + 100);
      for (const el of rig.camera.projectionMatrix.elements) {
        expect(Number.isFinite(el)).toBe(true);
      }
      for (const el of rig.camera.matrixWorld.elements) {
        expect(Number.isFinite(el)).toBe(true);
      }
      rig.dispose();
    }

    const rig = new CameraRig();
    rig.pan(Number.MAX_VALUE, -Number.MAX_VALUE);
    rig.orbit(Number.MAX_VALUE, -Number.MAX_VALUE);
    rig.zoom(Number.NaN);
    rig.zoom(Number.POSITIVE_INFINITY);
    rig.focusOnBounds([Number.NaN, Number.POSITIVE_INFINITY, -Number.MAX_VALUE], Number.NaN);
    rig.consumeEvents([
      {
        type: 'seismic_pulse',
        frequencyHz: Number.NaN,
        amplitudeM: Number.NaN,
        groundAccelMpS2: 5.0,
      },
      {
        type: 'explosion',
        position: [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY],
        radiusM: Number.NaN,
        equivalentKgTnt: Number.NaN,
        isChainDetonation: true,
      },
    ]);
    rig.update(1 / 60);

    for (const c of rig.getShakeOffset()) {
      expect(Number.isFinite(c)).toBe(true);
    }
    for (const el of rig.camera.matrixWorld.elements) {
      expect(Number.isFinite(el)).toBe(true);
    }

    const maxProj = rig.projectWorldToScreen([Number.MAX_VALUE, -Number.MAX_VALUE, 0], 1280, 720);
    expect(Number.isFinite(maxProj.x)).toBe(true);
    expect(Number.isFinite(maxProj.y)).toBe(true);
    expect(maxProj.visible).toBe(false);

    const rayBad = rig.screenPointToRay(Number.NaN, Number.POSITIVE_INFINITY);
    expect(rayBad.origin.every(Number.isFinite)).toBe(true);
    expect(rayBad.direction.every(Number.isFinite)).toBe(true);

    // Проверка публичных методов CameraRig после dispose()
    rig.dispose();
    rig.dispose();
    expect(() => {
      rig.orbit(0.2, 0.1);
      rig.pan(1, 1);
      rig.zoom(0.8);
      rig.zoomByWheelDelta(-120);
      rig.focusOnBounds([0, 4, 0], 10);
      rig.resetView();
      rig.addShakeImpulse(0.5, 18);
      rig.update(0.05);
      rig.resize(800, 600);
      rig.screenPointToRay(0, 0);
      rig.projectWorldToScreen([0, 2, 0]);
    }).not.toThrow();

    // Проверка SceneRenderer.clientPointToNdc на неконечных входах
    const renderer = new SceneRenderer({ headless: true, width: 1280, height: 720 });
    expect(renderer.clientPointToNdc(Number.NaN, 360)).toEqual([0, 0]);
    expect(renderer.clientPointToNdc(640, Number.POSITIVE_INFINITY)).toEqual([0, 0]);
    expect(renderer.clientPointToNdc(Number.NEGATIVE_INFINITY, Number.NaN)).toEqual([0, 0]);
    const extremeNdc = renderer.clientPointToNdc(Number.MAX_VALUE, -Number.MAX_VALUE);
    expect(extremeNdc[0]).toBe(1);
    expect(extremeNdc[1]).toBe(1);
    renderer.dispose();
  });
});

