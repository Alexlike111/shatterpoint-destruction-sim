import { describe, expect, it } from 'vitest';
import { SimulationEventBus } from '../../../src/core/events';
import { SeededRng } from '../../../src/core/rng';
import {
  AMBIENT_TEMPERATURE_C,
  DEFAULT_PHYSICS_CONSTANTS,
  DEFAULT_SEED,
  FIXED_DT,
  PHYSICS_CONSTANTS_BOUNDS,
  STRUCTURAL_MATERIAL_IDS,
  type PhysicsConstantsOverrides,
  type SimulationEvent,
} from '../../../src/core/types';

describe('Детерминированное ядро: константы, SeededRng (Mulberry32) и SimulationEventBus', () => {
  it('проверяет канонические константы и границы параметров физики из types.ts', () => {
    expect(FIXED_DT).toBeCloseTo(1 / 60, 12);
    expect(AMBIENT_TEMPERATURE_C).toBe(20);
    expect(DEFAULT_SEED).toBe(0x53484154);

    expect(Object.isFrozen(STRUCTURAL_MATERIAL_IDS)).toBe(true);
    expect(STRUCTURAL_MATERIAL_IDS).toEqual([
      'reinforced_concrete',
      'brick',
      'glass',
      'wood',
      'steel',
      'explosive',
    ]);

    expect(Object.isFrozen(DEFAULT_PHYSICS_CONSTANTS)).toBe(true);
    expect(Object.isFrozen(PHYSICS_CONSTANTS_BOUNDS)).toBe(true);

    const keys = Object.keys(DEFAULT_PHYSICS_CONSTANTS) as Array<keyof PhysicsConstantsOverrides>;
    expect(keys.length).toBe(7);
    for (const key of keys) {
      const val = DEFAULT_PHYSICS_CONSTANTS[key];
      const [minVal, maxVal] = PHYSICS_CONSTANTS_BOUNDS[key];
      expect(val).toBeGreaterThanOrEqual(minVal);
      expect(val).toBeLessThanOrEqual(maxVal);
    }
  });

  it('гарантирует побитовый детерминизм на 10 000 шагов и отсутствие глобального состояния', () => {
    const rngA = new SeededRng(20261117);
    const rngB = new SeededRng(20261117);
    const noiseRng = new SeededRng(999999);

    for (let i = 0; i < 10_000; i++) {
      // Интенсивно дергаем сторонний генератор между вызовами rngA и rngB
      noiseRng.nextUint32();
      noiseRng.unitVec3();

      expect(rngA.nextUint32()).toBe(rngB.nextUint32());
      expect(rngA.next()).toBe(rngB.next());
      expect(rngA.range(-50.5, 120.25)).toBe(rngB.range(-50.5, 120.25));
      expect(rngA.int(-15, 42)).toBe(rngB.int(-15, 42));
      expect(rngA.unitVec3()).toEqual(rngB.unitVec3());
    }
  });

  it('сохраняет инвариант сериализации getState() и clone() включая граничные seed (0, -1, NaN)', () => {
    for (const edgeSeed of [0, -1, 0xffffffff, Number.NaN, Number.POSITIVE_INFINITY, 12345.678]) {
      const rng = new SeededRng(edgeSeed);
      const fromInitialState = new SeededRng(rng.getState());
      const clonedInitial = rng.clone();

      expect(fromInitialState.nextUint32()).toBe(clonedInitial.nextUint32());
      expect(rng.nextUint32()).toBeDefined();

      // Продвигаем на произвольное число шагов и снова клонируем/восстанавливаем
      for (let step = 0; step < 37; step++) {
        rng.nextUint32();
      }
      const stateMid = rng.getState();
      const restored = new SeededRng(stateMid);
      const cloned = rng.clone();

      for (let k = 0; k < 100; k++) {
        const expected = rng.nextUint32();
        expect(restored.nextUint32()).toBe(expected);
        expect(cloned.nextUint32()).toBe(expected);
      }
    }
  });

  it('проверяет изотропию и единичную евклидову норму unitVec3() на выборке 5 000 векторов', () => {
    const rng = new SeededRng(777111);
    const sampleCount = 5_000;
    let sumX = 0;
    let sumY = 0;
    let sumZ = 0;
    let sumX2 = 0;
    let sumY2 = 0;
    let sumZ2 = 0;

    for (let i = 0; i < sampleCount; i++) {
      const [x, y, z] = rng.unitVec3();
      const norm = Math.hypot(x, y, z);
      expect(Math.abs(norm - 1)).toBeLessThan(1e-12);
      sumX += x;
      sumY += y;
      sumZ += z;
      sumX2 += x * x;
      sumY2 += y * y;
      sumZ2 += z * z;
    }

    expect(Math.abs(sumX / sampleCount)).toBeLessThan(0.03);
    expect(Math.abs(sumY / sampleCount)).toBeLessThan(0.03);
    expect(Math.abs(sumZ / sampleCount)).toBeLessThan(0.03);

    // Второй момент равномерного распределения на S^2 по каждой координате равен 1/3 ≈ 0.3333
    expect(sumX2 / sampleCount).toBeGreaterThan(0.30);
    expect(sumX2 / sampleCount).toBeLessThan(0.37);
    expect(sumY2 / sampleCount).toBeGreaterThan(0.30);
    expect(sumY2 / sampleCount).toBeLessThan(0.37);
    expect(sumZ2 / sampleCount).toBeGreaterThan(0.30);
    expect(sumZ2 / sampleCount).toBeLessThan(0.37);
  });

  it('проверяет независимость ветвления fork(salt) и валидацию аргументов range/int/pick/shuffle', () => {
    const childA1 = new SeededRng(99).fork(1);
    const childA2 = new SeededRng(99).fork(2);
    const childA1Repeat = new SeededRng(99).fork(1);

    expect(childA1.nextUint32()).not.toBe(childA2.nextUint32());
    const childA1Reset = new SeededRng(99).fork(1);
    for (let i = 0; i < 50; i++) {
      expect(childA1Reset.nextUint32()).toBe(childA1Repeat.nextUint32());
    }

    const rng = new SeededRng(42);
    expect(() => rng.range(10, 5)).toThrow(RangeError);
    expect(() => rng.int(5, 2)).toThrow(RangeError);
    expect(() => rng.pick([])).toThrow(RangeError);

    expect(rng.chance(0)).toBe(false);
    expect(rng.chance(-0.5)).toBe(false);
    expect(rng.chance(1)).toBe(true);
    expect(rng.chance(1.5)).toBe(true);

    const arr = [1, 2, 3, 4, 5, 6, 7, 8];
    const shuffled = rng.shuffleInPlace(arr.slice());
    expect(shuffled).toHaveLength(arr.length);
    expect([...shuffled].sort((a, b) => a - b)).toEqual(arr);
    expect(shuffled).not.toEqual(arr);
  });

  it('проверяет типизированную шину SimulationEventBus, отписку внутри emit, drain и clear', () => {
    const bus = new SimulationEventBus();
    const fractureEnergies: number[] = [];
    const allTypes: string[] = [];
    let onceCalls = 0;

    const unsubOnce = bus.on('fracture', () => {
      onceCalls++;
      // Отписываемся прямо во время обхода подписчиков в emit
      unsubOnce();
    });

    bus.on('fracture', (ev) => {
      fractureEnergies.push(ev.energyJ);
    });

    const unsubAll = bus.onAll((ev) => {
      allTypes.push(ev.type);
    });

    const ev1: SimulationEvent = {
      type: 'fracture',
      position: [1, 2, 3],
      materialId: 'reinforced_concrete',
      energyJ: 1500,
      shardCount: 8,
    };
    const ev2: SimulationEvent = {
      type: 'explosion',
      position: [0, 1, 0],
      radiusM: 6.5,
      equivalentKgTnt: 25,
      isChainDetonation: true,
    };
    const ev3: SimulationEvent = {
      type: 'fracture',
      position: [2, 3, 4],
      materialId: 'glass',
      energyJ: 420,
      shardCount: 14,
    };

    bus.emit(ev1);
    bus.emit(ev2);
    bus.emit(ev3);

    expect(onceCalls).toBe(1);
    expect(fractureEnergies).toEqual([1500, 420]);
    expect(allTypes).toEqual(['fracture', 'explosion', 'fracture']);

    expect(bus.peek()).toHaveLength(3);
    const drained = bus.drain();
    expect(drained).toEqual([ev1, ev2, ev3]);
    expect(bus.peek()).toHaveLength(0);
    expect(bus.drain()).toEqual([]);

    // clear() очищает буфер, но сохраняет активных подписчиков
    bus.emit(ev2);
    expect(bus.peek()).toHaveLength(1);
    bus.clear();
    expect(bus.peek()).toHaveLength(0);

    bus.emit(ev3);
    expect(fractureEnergies).toEqual([1500, 420, 420]);

    unsubAll();
    bus.removeAllListeners();
    bus.clear();
    bus.emit(ev1);
    expect(fractureEnergies).toEqual([1500, 420, 420]);
    expect(bus.drain()).toEqual([ev1]);
  });
});
