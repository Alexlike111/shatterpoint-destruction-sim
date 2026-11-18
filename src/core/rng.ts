import { DEFAULT_SEED } from './types';

/**
 * Детерминированный изолированный генератор псевдослучайных чисел на базе алгоритма Mulberry32.
 * Не обращается к системным недетерминированным источникам случайности и не имеет глобального состояния.
 */
export class SeededRng {
  private state: number;

  constructor(seed: number = DEFAULT_SEED) {
    this.state = Number.isFinite(seed) ? (Math.trunc(seed) >>> 0) : DEFAULT_SEED;
  }

  /**
   * Возвращает очередное беззнаковое 32-битное целое число в диапазоне [0, 4294967295].
   */
  public nextUint32(): number {
    const s = (this.state + 0x6d2b79f5) >>> 0;
    this.state = s;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (t ^ (t >>> 14)) >>> 0;
  }

  /**
   * Возвращает равномерно распределённое число с плавающей точкой в полуинтервале [0, 1).
   */
  public next(): number {
    return this.nextUint32() / 4294967296;
  }

  /**
   * Возвращает равномерное вещественное число в полуинтервале [min, max).
   */
  public range(min: number, max: number): number {
    if (!Number.isFinite(min) || !Number.isFinite(max) || min > max) {
      throw new RangeError(`Некорректный диапазон SeededRng.range: [${min}, ${max}]`);
    }
    return min + (max - min) * this.next();
  }

  /**
   * Возвращает равномерное целое число в отрезке [minInclusive, maxInclusive].
   */
  public int(minInclusive: number, maxInclusive: number): number {
    const min = Math.ceil(minInclusive);
    const max = Math.floor(maxInclusive);
    if (!Number.isFinite(min) || !Number.isFinite(max) || min > max) {
      throw new RangeError(`Некорректный целочисленный диапазон SeededRng.int: [${minInclusive}, ${maxInclusive}]`);
    }
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /**
   * Возвращает true с вероятностью probability (всегда расходует ровно 1 шаг состояния).
   */
  public chance(probability: number): boolean {
    const u = this.next();
    if (!Number.isFinite(probability) || probability <= 0) {
      return false;
    }
    if (probability >= 1) {
      return true;
    }
    return u < probability;
  }

  /**
   * Равномерно выбирает случайный элемент непустого массива.
   */
  public pick<T>(items: readonly T[]): T {
    if (items.length === 0) {
      throw new RangeError('Невозможно выбрать элемент из пустого массива в SeededRng.pick');
    }
    return items[this.int(0, items.length - 1)]!;
  }

  /**
   * Перемешивает массив на месте по алгоритму Фишера—Йетса и возвращает его.
   */
  public shuffleInPlace<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; i--) {
      const j = this.int(0, i);
      const tmp = items[i]!;
      items[i] = items[j]!;
      items[j] = tmp;
    }
    return items;
  }

  /**
   * Генерирует изотропный единичный вектор на сфере S^2 через цилиндрическую проекцию Архимеда (за O(1)).
   */
  public unitVec3(): [number, number, number] {
    const z = this.range(-1, 1);
    const phi = this.range(0, Math.PI * 2);
    const r = Math.sqrt(Math.max(0, 1 - z * z));
    return [r * Math.cos(phi), r * Math.sin(phi), z];
  }

  /**
   * Порождает независимый дочерний генератор через лавинный финализатор MurmurHash3 (fmix32).
   */
  public fork(salt = 0): SeededRng {
    const saltBits = Number.isFinite(salt) ? (Math.trunc(salt) >>> 0) : 0;
    let h = (this.nextUint32() ^ Math.imul((saltBits + 0x9e3779b9) >>> 0, 0x85ebca6b)) >>> 0;
    h ^= h >>> 16;
    h = Math.imul(h, 0xc2b2ae35) >>> 0;
    h ^= h >>> 16;
    return new SeededRng(h >>> 0);
  }

  /**
   * Возвращает текущее 32-битное состояние генератора для сериализации.
   */
  public getState(): number {
    return this.state >>> 0;
  }

  /**
   * Создаёт точную независимую копию генератора с идентичным внутренним состоянием.
   */
  public clone(): SeededRng {
    return new SeededRng(this.state);
  }
}
