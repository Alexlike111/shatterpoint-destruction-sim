import { clamp, cleanZero, vec3Len } from '../core/math3d';
import type { SeededRng } from '../core/rng';
import {
  PHYSICS_CONSTANTS_BOUNDS,
  type SimulationEvent,
  type StructuralMaterialId,
  type Vec3,
} from '../core/types';
import type { StructuralNode } from './StructuralGraph';

/**
 * Контроллер 3D-сейсмоплатформы: генерирует двухосные гармоническо-стохастические колебания основания
 * и рассчитывает частотно-избирательные резонансные ускорения зданий разной этажности (Еврокод 8).
 */

export interface SeismicStepOutput {
  active: boolean;
  platformOffset: Vec3;
  groundAccelMpS2: number;
  pulseEvent: SimulationEvent | null;
}

function getMaterialStiffnessFreqConstant(materialId: StructuralMaterialId): number {
  switch (materialId) {
    case 'reinforced_concrete':
      return 21.0;
    case 'brick':
      return 19.5;
    case 'glass':
      return 20.0;
    case 'steel':
      return 18.0;
    case 'wood':
      return 16.5;
    case 'explosive':
      return 18.0;
  }
}

export class SeismicController {
  private active = false;
  private frequencyHz = 2.5;
  private amplitudeM = 0.35;
  private durationSec = 0;
  private elapsedSec = 0;
  private phaseSeed = 0;
  private pulseTickCounter = 0;
  private platformOffset: Vec3 = [0, 0, 0];
  private currentWaveDir: Vec3 = [1, 0, 0];
  private currentBaseAccelMpS2 = 0;

  public clear(): void {
    this.stop();
  }

  public trigger(
    params: { frequencyHz: number; amplitudeM: number; durationSec: number },
    rng: SeededRng,
  ): void {
    const [minFreq, maxFreq] = PHYSICS_CONSTANTS_BOUNDS.seismicFrequencyHz;
    const [minAmp, maxAmp] = PHYSICS_CONSTANTS_BOUNDS.seismicAmplitudeM;

    const rawFreq = Number.isFinite(params.frequencyHz) ? params.frequencyHz : 2.5;
    const rawAmp = Number.isFinite(params.amplitudeM) ? params.amplitudeM : 0.35;
    const rawDur = Number.isFinite(params.durationSec) ? params.durationSec : 5.0;

    this.frequencyHz = cleanZero(clamp(rawFreq, minFreq, maxFreq));
    this.amplitudeM = cleanZero(clamp(rawAmp, minAmp, maxAmp));
    this.durationSec = cleanZero(clamp(rawDur, 0.05, 60.0));
    this.elapsedSec = 0;
    this.pulseTickCounter = 0;
    this.phaseSeed = rng.range(0, Math.PI * 2);
    this.active = true;
  }

  public stop(): void {
    this.active = false;
    this.elapsedSec = 0;
    this.pulseTickCounter = 0;
    this.platformOffset = [0, 0, 0];
    this.currentWaveDir = [1, 0, 0];
    this.currentBaseAccelMpS2 = 0;
  }

  public isActive(): boolean {
    return this.active;
  }

  public getFrequencyHz(): number {
    return this.frequencyHz;
  }

  public getAmplitudeM(): number {
    return this.amplitudeM;
  }

  public getPlatformOffset(): Vec3 {
    return [this.platformOffset[0], this.platformOffset[1], this.platformOffset[2]];
  }

  /**
   * Продвигает кинематику сейсмоплатформы на один фиксированный шаг dtSec.
   */
  public step(dtSec: number): SeismicStepOutput {
    if (!this.active) {
      return {
        active: false,
        platformOffset: [0, 0, 0],
        groundAccelMpS2: 0,
        pulseEvent: null,
      };
    }

    this.elapsedSec += dtSec;
    if (this.elapsedSec >= this.durationSec) {
      this.stop();
      return {
        active: false,
        platformOffset: [0, 0, 0],
        groundAccelMpS2: 0,
        pulseEvent: null,
      };
    }

    const t = this.elapsedSec;
    const rampUp = Math.min(0.22, this.durationSec * 0.2);
    const rampDown = Math.min(0.32, this.durationSec * 0.25);
    let env = 1.0;
    if (rampUp > 1e-4 && t < rampUp) {
      env = t / rampUp;
    } else if (rampDown > 1e-4 && this.durationSec - t < rampDown) {
      env = Math.max(0, (this.durationSec - t) / rampDown);
    }

    const omega = 2 * Math.PI * this.frequencyHz;
    const phase = omega * t;

    // Мягкое ограничение кинематического хода плиты на высоких частотах, чтобы пол не катапультировал осколки
    const kinAmp = Math.min(this.amplitudeM, 3.6 / Math.max(1, omega * 0.24));

    const waveX = Math.sin(phase) + 0.12 * Math.sin(2.17 * phase + this.phaseSeed);
    const waveY = 0.18 * Math.cos(phase);
    const waveZ = 0.42 * Math.sin(phase + 0.9) + 0.08 * Math.cos(1.73 * phase + this.phaseSeed);

    this.platformOffset = [
      cleanZero(env * kinAmp * waveX),
      cleanZero(env * kinAmp * waveY),
      cleanZero(env * kinAmp * waveZ),
    ];

    // Вектор мгновенной фазы ускорения (-d²x/dt² пропорционален +sin(phase))
    const dirRaw: Vec3 = [waveX, waveY * 0.65, waveZ];
    const dirLen = vec3Len(dirRaw);
    this.currentWaveDir =
      dirLen > 1e-6 ? [dirRaw[0] / dirLen, dirRaw[1] / dirLen, dirRaw[2] / dirLen] : [1, 0, 0];

    // Спектральное пиковое ускорение основания PGA
    const pgaMpS2 = 9.81 * this.amplitudeM * (0.38 * Math.pow(this.frequencyHz, 0.85)) * env;
    this.currentBaseAccelMpS2 = cleanZero(pgaMpS2 * Math.min(1.25, dirLen));

    let pulseEvent: SimulationEvent | null = null;
    if (this.pulseTickCounter % 6 === 0) {
      pulseEvent = {
        type: 'seismic_pulse',
        frequencyHz: this.frequencyHz,
        amplitudeM: this.amplitudeM,
        groundAccelMpS2: this.currentBaseAccelMpS2,
      };
    }
    this.pulseTickCounter++;

    return {
      active: true,
      platformOffset: [this.platformOffset[0], this.platformOffset[1], this.platformOffset[2]],
      groundAccelMpS2: this.currentBaseAccelMpS2,
      pulseEvent,
    };
  }

  /**
   * Вычисляет локальное сейсмическое ускорение узла с учётом частотного резонанса DAF(f, f_0)
   * собственной частоты здания высотой structureHeightM и первой консольной моды колебаний.
   */
  public computeNodeSeismicAcceleration(
    node: StructuralNode,
    structureHeightM: number,
  ): Vec3 {
    if (!this.active || this.currentBaseAccelMpS2 <= 1e-8) {
      return [0, 0, 0];
    }

    const effH = Math.max(0.8, structureHeightM);
    const cStiff = getMaterialStiffnessFreqConstant(node.materialId);
    const naturalFreqHz = clamp(cStiff / Math.pow(effH, 0.85), 0.75, 14.0);

    const beta = this.frequencyHz / naturalFreqHz;
    const zeta = 0.115; // Коэффициент конструкционного демпфирования (11.5%)
    const denom = Math.hypot(1 - beta * beta, 2 * zeta * beta);
    const daf = clamp(1 / Math.max(0.05, denom), 0.12, 4.4);

    // Треугольная эпюра первой собственной формы колебаний по высоте
    const relY = clamp(node.localPlatformPos[1] / effH, 0, 1.25);
    const modeFactor = 0.52 + 0.92 * relY;

    const mag = this.currentBaseAccelMpS2 * daf * modeFactor;
    return [
      cleanZero(this.currentWaveDir[0] * mag),
      cleanZero(this.currentWaveDir[1] * mag),
      cleanZero(this.currentWaveDir[2] * mag),
    ];
  }
}
