import { clamp } from '../core/math3d';
import { SeededRng } from '../core/rng';
import {
  AMBIENT_TEMPERATURE_C,
  DEFAULT_SEED,
  PHYSICS_CONSTANTS_BOUNDS,
  type SimulationEvent,
  type SimulationEventByType,
  type SimulationTelemetry,
  type StructuralMaterialId,
} from '../core/types';

/**
 * Многослойный процедурный синтезатор разрушения на чистом Web Audio API (фича F16).
 * Работает без внешних медиафайлов, полностью детерминирован через SeededRng,
 * защищён от клиппинга мастер-лимитером и безопасно работает в headless-среде (Node/Vitest).
 */

declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext;
  }
}

export interface AudioParamLike {
  value: number;
  setValueAtTime(value: number, startTime: number): unknown;
  linearRampToValueAtTime(value: number, endTime: number): unknown;
  exponentialRampToValueAtTime(value: number, endTime: number): unknown;
  setTargetAtTime(target: number, startTime: number, timeConstant: number): unknown;
  cancelScheduledValues(startTime: number): unknown;
}

export interface AudioNodeLike {
  connect(destinationNode: AudioNodeLike): unknown;
  connect(destinationParam: AudioParamLike): void;
  disconnect(): void;
}

export interface GainNodeLike extends AudioNodeLike {
  readonly gain: AudioParamLike;
}

export interface OscillatorNodeLike extends AudioNodeLike {
  type: OscillatorType;
  readonly frequency: AudioParamLike;
  readonly detune: AudioParamLike;
  start(when?: number): void;
  stop(when?: number): void;
}

export interface BiquadFilterNodeLike extends AudioNodeLike {
  type: BiquadFilterType;
  readonly frequency: AudioParamLike;
  readonly Q: AudioParamLike;
  readonly gain: AudioParamLike;
}

export interface DynamicsCompressorNodeLike extends AudioNodeLike {
  readonly threshold: AudioParamLike;
  readonly knee: AudioParamLike;
  readonly ratio: AudioParamLike;
  readonly attack: AudioParamLike;
  readonly release: AudioParamLike;
}

export interface WaveShaperNodeLike extends AudioNodeLike {
  curve: Float32Array<ArrayBuffer> | null;
  oversample: OverSampleType;
}

export interface DelayNodeLike extends AudioNodeLike {
  readonly delayTime: AudioParamLike;
}

export interface AudioBufferLike {
  readonly sampleRate: number;
  readonly length: number;
  readonly duration: number;
  readonly numberOfChannels: number;
  getChannelData(channel: number): Float32Array<ArrayBuffer>;
  copyFromChannel(
    destination: Float32Array<ArrayBuffer>,
    channelNumber: number,
    bufferOffset?: number,
  ): void;
  copyToChannel(
    source: Float32Array<ArrayBuffer>,
    channelNumber: number,
    bufferOffset?: number,
  ): void;
}

export interface AudioBufferSourceNodeLike extends AudioNodeLike {
  buffer: AudioBufferLike | null;
  loop: boolean;
  loopStart: number;
  loopEnd: number;
  readonly playbackRate: AudioParamLike;
  start(when?: number, offset?: number, duration?: number): void;
  stop(when?: number): void;
}

export interface AudioContextLike {
  readonly state: AudioContextState;
  readonly currentTime: number;
  readonly sampleRate: number;
  readonly destination: AudioNodeLike;
  resume?(): Promise<void> | void;
  close?(): Promise<void> | void;
  createGain(): GainNodeLike;
  createOscillator(): OscillatorNodeLike;
  createBiquadFilter(): BiquadFilterNodeLike;
  createDynamicsCompressor(): DynamicsCompressorNodeLike;
  createWaveShaper(): WaveShaperNodeLike;
  createDelay(maxDelayTime?: number): DelayNodeLike;
  createBuffer(numberOfChannels: number, length: number, sampleRate: number): AudioBufferLike;
  createBufferSource(): AudioBufferSourceNodeLike;
}

/**
 * Статическая проверка 100% структурной совместимости нативных браузерных
 * BaseAudioContext и AudioContext с портом AudioContextLike без приведений типов.
 */
export function asAudioContextLike(ctx: BaseAudioContext): AudioContextLike {
  return ctx;
}

export function asRealtimeAudioContextLike(ctx: AudioContext): AudioContextLike {
  return ctx;
}

export interface DestructionSoundEngineOptions {
  audioContextFactory?: () => AudioContextLike;
  maxPolyphony?: number;
  seed?: number;
  masterVolume?: number;
  autoUnlockOnInteraction?: boolean;
}

export interface AcousticDiagnosticsSnapshot {
  readonly headless: boolean;
  readonly disposed: boolean;
  readonly unlocked: boolean;
  readonly muted: boolean;
  readonly masterVolume: number;
  readonly timeScale: number;
  readonly masterLowpassHz: number;
  readonly masterFilterQ: number;
  readonly pitchScale: number;
  readonly durationScale: number;
  readonly activeVoices: number;
  readonly maxPolyphony: number;
  readonly fireLoopGain: number;
  readonly fireCenterHz: number;
  readonly seismicLoopGain: number;
  readonly seismicCarrierHz: number;
  readonly seismicModulationHz: number;
}

type VoiceCategory =
  | 'explosion'
  | 'masonry_impact'
  | 'seismic_pulse'
  | 'rebar_snap'
  | 'steel_yield'
  | 'wood'
  | 'fire_ignite'
  | 'glass'
  | 'fire_crackle';

interface ScheduledSourceHandle {
  stop(when?: number): void;
  disconnect(): void;
}

interface ActiveVoiceRecord {
  readonly id: number;
  readonly category: VoiceCategory;
  readonly priority: number;
  readonly startTimeSec: number;
  readonly durationSec: number;
  readonly endTimeSec: number;
  readonly rootGain: GainNodeLike | null;
  readonly sources: ScheduledSourceHandle[];
  readonly nodes: AudioNodeLike[];
}

interface FireLoopRig {
  readonly masterGain: GainNodeLike;
  readonly draftFilter: BiquadFilterNodeLike;
  readonly hissFilter: BiquadFilterNodeLike;
  readonly draftSource: AudioBufferSourceNodeLike;
  readonly hissSource: AudioBufferSourceNodeLike;
}

interface SeismicLoopRig {
  readonly masterGain: GainNodeLike;
  readonly modGain: GainNodeLike;
  readonly lfoDepthGain: GainNodeLike;
  readonly lfoOsc: OscillatorNodeLike;
  readonly carrierOsc: OscillatorNodeLike;
  readonly rumbleFilter: BiquadFilterNodeLike;
  readonly rumbleSource: AudioBufferSourceNodeLike;
}

interface CoalescedExplosionCandidate {
  readonly kind: 'explosion';
  readonly equivalentKgTnt: number;
  readonly radiusM: number;
  readonly isChainDetonation: boolean;
  readonly extraEchoBoost: number;
}

interface CoalescedFractureCandidate {
  readonly kind: 'fracture';
  readonly materialId: StructuralMaterialId;
  readonly energyJ: number;
  readonly shardCount: number;
}

interface CoalescedImpactCandidate {
  readonly kind: 'secondary_impact';
  readonly materialId: StructuralMaterialId;
  readonly impulseNs: number;
  readonly massKg: number;
}

interface CoalescedRebarCandidate {
  readonly kind: 'rebar_snap';
  readonly forceN: number;
  readonly offsetSec: number;
}

interface CoalescedSteelCandidate {
  readonly kind: 'steel_yield';
  readonly angleRad: number;
  readonly offsetSec: number;
}

interface CoalescedFireIgniteCandidate {
  readonly kind: 'fire_ignited';
  readonly offsetSec: number;
}

interface CoalescedSeismicPulseCandidate {
  readonly kind: 'seismic_pulse';
  readonly frequencyHz: number;
  readonly amplitudeM: number;
  readonly groundAccelMpS2: number;
}

type CoalescedCandidate =
  | CoalescedExplosionCandidate
  | CoalescedFractureCandidate
  | CoalescedImpactCandidate
  | CoalescedRebarCandidate
  | CoalescedSteelCandidate
  | CoalescedFireIgniteCandidate
  | CoalescedSeismicPulseCandidate;

const AUDIO_SEED_SALT = 0x41554449; // 'AUDI'
const NOISE_BUFFER_SALT = 0x4e4f4953; // 'NOIS'
const NOISE_BUFFER_DURATION_SEC = 2.0;
const MIN_EXP_VALUE = 0.0001;
const MIN_TIME_STEP_SEC = 0.001;
const MIN_TIME_SCALE = 0.05;
const MAX_TIME_SCALE = 2.0;
const MAX_WORLD_LOWPASS_HZ = 19500;
const SUBSONIC_HIGHPASS_HZ = 22;

const GLASS_MODAL_FREQUENCIES_HZ: readonly number[] = Object.freeze([
  2460, 3190, 4110, 4980, 5870, 6650, 7350,
]);

const CATEGORY_BASE_PRIORITY: Readonly<Record<VoiceCategory, number>> = Object.freeze({
  explosion: 100,
  masonry_impact: 80,
  seismic_pulse: 80,
  rebar_snap: 65,
  steel_yield: 65,
  wood: 52,
  fire_ignite: 50,
  glass: 45,
  fire_crackle: 20,
});

function finiteNonNegative(value: number, fallback = 0): number {
  if (Number.isNaN(value)) {
    return fallback;
  }
  if (value === Number.POSITIVE_INFINITY) {
    return 1e12;
  }
  if (value <= 0) {
    return 0;
  }
  return value;
}

function finiteClamped(value: number, min: number, max: number, fallback: number): number {
  if (Number.isNaN(value)) {
    return fallback;
  }
  if (value === Number.POSITIVE_INFINITY) {
    return max;
  }
  if (value === Number.NEGATIVE_INFINITY) {
    return min;
  }
  return clamp(value, min, max);
}

function safeAudioTime(rawTime: number): number {
  if (!Number.isFinite(rawTime) || rawTime < 0) {
    return 0;
  }
  return rawTime;
}

function safeAfter(anchorTimeSec: number, deltaSec: number): number {
  const base = safeAudioTime(anchorTimeSec);
  const delta = Number.isFinite(deltaSec) ? Math.max(MIN_TIME_STEP_SEC, deltaSec) : MIN_TIME_STEP_SEC;
  return base + delta;
}

function safeExpGain(gain: number): number {
  if (!Number.isFinite(gain)) {
    return MIN_EXP_VALUE;
  }
  return clamp(gain, MIN_EXP_VALUE, 4.0);
}

function safeExpFreq(freqHz: number, minHz = 10, maxHz = 20000): number {
  if (!Number.isFinite(freqHz)) {
    return Math.max(MIN_EXP_VALUE, minHz);
  }
  return clamp(freqHz, Math.max(MIN_EXP_VALUE, minHz), maxHz);
}

function swallowPromiseResult(maybePromise: Promise<void> | void): void {
  if (maybePromise !== undefined && maybePromise !== null) {
    Promise.resolve(maybePromise).catch(() => {
      // Политика автовоспроизведения браузера может отклонить resume/close до жеста пользователя.
    });
  }
}

function detectBrowserAudioContextFactory(): (() => AudioContextLike) | null {
  if (typeof AudioContext === 'function') {
    return () => new AudioContext();
  }
  if (typeof window !== 'undefined' && typeof window.webkitAudioContext === 'function') {
    const WebkitCtor = window.webkitAudioContext;
    return () => new WebkitCtor();
  }
  return null;
}

function buildWarmSaturationCurve(samples = 1025): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(samples);
  const drive = 1.5;
  const norm = 1 / Math.tanh(drive);
  const lastIdx = Math.max(1, samples - 1);
  for (let i = 0; i < samples; i++) {
    const x = (i / lastIdx) * 2 - 1;
    curve[i] = Math.tanh(drive * x) * norm;
  }
  return curve;
}

function computeBulletTimeCharacteristics(scale: number): {
  timeScale: number;
  masterLowpassHz: number;
  masterFilterQ: number;
  pitchScale: number;
  durationScale: number;
} {
  const s = clamp(scale, MIN_TIME_SCALE, MAX_TIME_SCALE);
  if (s < 1.0) {
    const masterLowpassHz = 320 + 19180 * Math.pow(s, 1.85);
    const masterFilterQ = 0.707 + 0.85 * (1 - s);
    const pitchScale = 0.42 + 0.58 * Math.pow(s, 0.65);
    const durationScale = clamp(Math.pow(s, -0.55), 1.0, 3.2);
    return {
      timeScale: s,
      masterLowpassHz,
      masterFilterQ,
      pitchScale,
      durationScale,
    };
  }
  const masterLowpassHz = MAX_WORLD_LOWPASS_HZ;
  const masterFilterQ = 0.707;
  const pitchScale = clamp(Math.pow(s, 0.25), 1.0, 1.25);
  const durationScale = clamp(Math.pow(s, -0.35), 0.75, 1.0);
  return {
    timeScale: s,
    masterLowpassHz,
    masterFilterQ,
    pitchScale,
    durationScale,
  };
}

export class DestructionSoundEngine {
  private readonly contextFactory: (() => AudioContextLike) | null;
  private readonly hasExplicitFactory: boolean;
  private readonly baseSeed: number;
  private readonly rng: SeededRng;
  private readonly maxPolyphony: number;

  private ctx: AudioContextLike | null = null;
  private mixBus: GainNodeLike | null = null;
  private subsonicHighpass: BiquadFilterNodeLike | null = null;
  private worldLowpass: BiquadFilterNodeLike | null = null;
  private warmWaveShaper: WaveShaperNodeLike | null = null;
  private limiter: DynamicsCompressorNodeLike | null = null;
  private masterGain: GainNodeLike | null = null;

  private whiteNoiseBuffer: AudioBufferLike | null = null;
  private pinkNoiseBuffer: AudioBufferLike | null = null;
  private brownNoiseBuffer: AudioBufferLike | null = null;

  private fireLoopRig: FireLoopRig | null = null;
  private seismicLoopRig: SeismicLoopRig | null = null;

  private readonly activeVoices: ActiveVoiceRecord[] = [];
  private nextVoiceId = 1;

  private headless: boolean;
  private disposed = false;
  private unlocked = false;
  private muted = false;
  private masterVolume: number;

  private timeScale = 1.0;
  private masterLowpassHz = MAX_WORLD_LOWPASS_HZ;
  private masterFilterQ = 0.707;
  private pitchScale = 1.0;
  private durationScale = 1.0;

  private fireLoopGain = 0;
  private fireCenterHz = 480;
  private nextFireCrackleTimeSec = 0;

  private seismicLoopGain = 0;
  private seismicCarrierHz = 40;
  private seismicModulationHz = PHYSICS_CONSTANTS_BOUNDS.seismicFrequencyHz[0];

  private virtualClockSec = 0;
  private lastSimTimeSec: number | null = null;

  private interactionUnlockHandler: (() => void) | null = null;

  constructor(options?: DestructionSoundEngineOptions) {
    const rawSeed = options?.seed;
    this.baseSeed = Number.isFinite(rawSeed)
      ? (Math.trunc(rawSeed!) >>> 0)
      : ((DEFAULT_SEED ^ AUDIO_SEED_SALT) >>> 0);
    this.rng = new SeededRng(this.baseSeed);

    const rawPoly = options?.maxPolyphony;
    this.maxPolyphony = Number.isFinite(rawPoly)
      ? Math.round(clamp(rawPoly!, 4, 128))
      : 28;

    const rawVol = options?.masterVolume;
    this.masterVolume = Number.isFinite(rawVol) ? clamp(rawVol!, 0, 1) : 0.85;

    if (options?.audioContextFactory !== undefined) {
      this.contextFactory = options.audioContextFactory;
      this.hasExplicitFactory = true;
      this.headless = false;
    } else {
      const browserFactory = detectBrowserAudioContextFactory();
      this.contextFactory = browserFactory;
      this.hasExplicitFactory = false;
      this.headless = browserFactory === null;
    }

    const initialBt = computeBulletTimeCharacteristics(1.0);
    this.timeScale = initialBt.timeScale;
    this.masterLowpassHz = initialBt.masterLowpassHz;
    this.masterFilterQ = initialBt.masterFilterQ;
    this.pitchScale = initialBt.pitchScale;
    this.durationScale = initialBt.durationScale;

    const shouldAutoUnlock = options?.autoUnlockOnInteraction !== false;
    if (!this.headless && shouldAutoUnlock && typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      const handler = (): void => {
        if (this.disposed) {
          this.detachInteractionListeners();
          return;
        }
        this.unlock();
        if (this.ctx !== null && this.ctx.state === 'running') {
          this.detachInteractionListeners();
        }
      };
      this.interactionUnlockHandler = handler;
      window.addEventListener('pointerdown', handler, { capture: true, passive: true });
      window.addEventListener('keydown', handler, { capture: true, passive: true });
    }
  }

  /**
   * Инициализирует мастер-тракт Web Audio и возобновляет контекст после пользовательского жеста.
   */
  public unlock(): void {
    if (this.disposed) {
      return;
    }
    const ctx = this.ensureContext();
    if (ctx === null) {
      return;
    }
    this.unlocked = true;
    if (ctx.state === 'suspended' && typeof ctx.resume === 'function') {
      try {
        swallowPromiseResult(ctx.resume());
      } catch {
        // Игнорируем синхронные ошибки политики браузера до пользовательского жеста.
      }
    }
    if (ctx.state === 'running') {
      this.detachInteractionListeners();
    }
  }

  /**
   * Включает или выключает беззвучный режим (плавно гасит мастер-шину, петли и блокирует новые голоса).
   */
  public setMuted(muted: boolean): void {
    if (this.disposed) {
      return;
    }
    const nextMuted = Boolean(muted);
    this.muted = nextMuted;

    if (nextMuted) {
      this.fireLoopGain = 0;
      this.seismicLoopGain = 0;
    }

    if (this.ctx !== null && this.masterGain !== null) {
      const now = safeAudioTime(this.ctx.currentTime);
      const targetMaster = nextMuted ? 0 : this.masterVolume;
      this.masterGain.gain.cancelScheduledValues(now);
      this.masterGain.gain.value = targetMaster;
      this.masterGain.gain.setTargetAtTime(targetMaster, now, 0.015);

      if (nextMuted) {
        if (this.fireLoopRig !== null) {
          this.fireLoopRig.masterGain.gain.cancelScheduledValues(now);
          this.fireLoopRig.masterGain.gain.value = 0;
          this.fireLoopRig.masterGain.gain.setTargetAtTime(0, now, 0.02);
        }
        if (this.seismicLoopRig !== null) {
          this.seismicLoopRig.masterGain.gain.cancelScheduledValues(now);
          this.seismicLoopRig.masterGain.gain.value = 0;
          this.seismicLoopRig.masterGain.gain.setTargetAtTime(0, now, 0.02);
        }
        this.stopAllActiveVoices(now);
      }
    } else if (nextMuted) {
      this.activeVoices.length = 0;
    }
  }

  public isMuted(): boolean {
    return this.muted;
  }

  public toggleMute(): boolean {
    if (this.disposed) {
      return this.muted;
    }
    this.setMuted(!this.muted);
    return this.muted;
  }

  public setMasterVolume(volume: number): void {
    if (this.disposed || !Number.isFinite(volume)) {
      return;
    }
    this.masterVolume = clamp(volume, 0, 1);
    if (this.ctx !== null && this.masterGain !== null && !this.muted) {
      const now = safeAudioTime(this.ctx.currentTime);
      this.masterGain.gain.cancelScheduledValues(now);
      this.masterGain.gain.value = this.masterVolume;
      this.masterGain.gain.setTargetAtTime(this.masterVolume, now, 0.015);
    }
  }

  public getMasterVolume(): number {
    return this.masterVolume;
  }

  /**
   * Настраивает частоту среза мастер-ФНЧ, сдвиг тона и растяжение огибающих в режиме Bullet-Time.
   * Результат инвариантен к порядку вызова относительно unlock().
   */
  public setTimeScale(scale: number): void {
    if (this.disposed || !Number.isFinite(scale)) {
      return;
    }
    const bt = computeBulletTimeCharacteristics(scale);
    this.timeScale = bt.timeScale;
    this.masterLowpassHz = bt.masterLowpassHz;
    this.masterFilterQ = bt.masterFilterQ;
    this.pitchScale = bt.pitchScale;
    this.durationScale = bt.durationScale;

    if (this.ctx !== null && this.worldLowpass !== null) {
      const now = safeAudioTime(this.ctx.currentTime);
      this.applyBulletTimeToWorldFilter(now);
    }
  }

  public getTimeScale(): number {
    return this.timeScale;
  }

  public isHeadless(): boolean {
    return this.headless;
  }

  public isDisposed(): boolean {
    return this.disposed;
  }

  public getActiveVoiceCount(): number {
    return this.activeVoices.length;
  }

  public getMaxPolyphony(): number {
    return this.maxPolyphony;
  }

  public getAcousticSnapshot(): AcousticDiagnosticsSnapshot {
    return {
      headless: this.headless,
      disposed: this.disposed,
      unlocked: this.unlocked,
      muted: this.muted,
      masterVolume: this.masterVolume,
      timeScale: this.timeScale,
      masterLowpassHz: this.masterLowpassHz,
      masterFilterQ: this.masterFilterQ,
      pitchScale: this.pitchScale,
      durationScale: this.durationScale,
      activeVoices: this.activeVoices.length,
      maxPolyphony: this.maxPolyphony,
      fireLoopGain: this.fireLoopGain,
      fireCenterHz: this.fireCenterHz,
      seismicLoopGain: this.seismicLoopGain,
      seismicCarrierHz: this.seismicCarrierHz,
      seismicModulationHz: this.seismicModulationHz,
    };
  }

  /**
   * Потребляет пакет событий физического тика и обновляет непрерывные петли пожара и сейсмоплатформы.
   */
  public consumeEvents(events: readonly SimulationEvent[], telemetry: SimulationTelemetry): void {
    if (this.disposed) {
      return;
    }

    this.advanceVirtualClockFromTelemetry(telemetry);

    // Если передана явная фабрика контекста (или звук уже разблокирован), убеждаемся в готовности мастер-шины.
    const ctx = this.unlocked || this.hasExplicitFactory ? this.ensureContext() : this.ctx;
    const nowSec = ctx !== null ? safeAudioTime(ctx.currentTime) : this.virtualClockSec;

    this.pruneFinishedVoices(nowSec);
    this.updateFireLoop(telemetry, ctx, nowSec);
    this.updateSeismicLoop(telemetry, ctx, nowSec);

    if (this.muted || events.length === 0) {
      return;
    }

    // В реальном браузере до первого пользовательского жеста (когда контекст ещё не создан или заморожен)
    // не накапливаем отложенные одноразовые осцилляторы в t = 0.
    if (!this.headless && !this.hasExplicitFactory && (ctx === null || ctx.state !== 'running')) {
      return;
    }

    const candidates = this.coalesceEvents(events);
    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i]!;
      this.synthesizeCandidate(candidate, ctx, nowSec);
    }
  }

  /**
   * Идемпотентно останавливает все петли и активные голоса, отключает мастер-тракт и закрывает контекст.
   */
  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.detachInteractionListeners();

    const nowSec = this.ctx !== null ? safeAudioTime(this.ctx.currentTime) : this.virtualClockSec;
    this.stopAllActiveVoices(nowSec);

    this.teardownFireLoop(nowSec);
    this.teardownSeismicLoop(nowSec);

    this.fireLoopGain = 0;
    this.seismicLoopGain = 0;

    try {
      this.mixBus?.disconnect();
      this.subsonicHighpass?.disconnect();
      this.worldLowpass?.disconnect();
      this.warmWaveShaper?.disconnect();
      this.limiter?.disconnect();
      this.masterGain?.disconnect();
    } catch {
      // Безопасное игнорирование повторного отключения узлов.
    }

    const ctxToClose = this.ctx;
    this.ctx = null;
    this.mixBus = null;
    this.subsonicHighpass = null;
    this.worldLowpass = null;
    this.warmWaveShaper = null;
    this.limiter = null;
    this.masterGain = null;
    this.whiteNoiseBuffer = null;
    this.pinkNoiseBuffer = null;
    this.brownNoiseBuffer = null;

    if (ctxToClose !== null && ctxToClose.state !== 'closed' && typeof ctxToClose.close === 'function') {
      try {
        swallowPromiseResult(ctxToClose.close());
      } catch {
        // Безопасное игнорирование ошибок закрытия контекста.
      }
    }
  }

  // ============================================================================
  // Инициализация мастер-тракта и предгенерированных шумовых буферов
  // ============================================================================

  private detachInteractionListeners(): void {
    if (
      this.interactionUnlockHandler !== null &&
      typeof window !== 'undefined' &&
      typeof window.removeEventListener === 'function'
    ) {
      window.removeEventListener('pointerdown', this.interactionUnlockHandler, { capture: true });
      window.removeEventListener('keydown', this.interactionUnlockHandler, { capture: true });
    }
    this.interactionUnlockHandler = null;
  }

  private ensureContext(): AudioContextLike | null {
    if (this.disposed) {
      return null;
    }
    if (this.ctx !== null) {
      return this.ctx;
    }
    if (this.contextFactory === null) {
      this.headless = true;
      return null;
    }

    let created: AudioContextLike;
    try {
      created = this.contextFactory();
    } catch {
      this.headless = true;
      return null;
    }

    this.ctx = created;
    this.headless = false;
    const now = safeAudioTime(created.currentTime);

    const mixBus = created.createGain();
    mixBus.gain.value = 1.0;
    mixBus.gain.setValueAtTime(1.0, now);

    const subsonicHighpass = created.createBiquadFilter();
    subsonicHighpass.type = 'highpass';
    subsonicHighpass.frequency.value = SUBSONIC_HIGHPASS_HZ;
    subsonicHighpass.frequency.setValueAtTime(SUBSONIC_HIGHPASS_HZ, now);
    subsonicHighpass.Q.value = 0.707;
    subsonicHighpass.Q.setValueAtTime(0.707, now);

    const worldLowpass = created.createBiquadFilter();
    worldLowpass.type = 'lowpass';
    worldLowpass.frequency.value = this.masterLowpassHz;
    worldLowpass.frequency.setValueAtTime(this.masterLowpassHz, now);
    worldLowpass.Q.value = this.masterFilterQ;
    worldLowpass.Q.setValueAtTime(this.masterFilterQ, now);

    const warmWaveShaper = created.createWaveShaper();
    warmWaveShaper.curve = buildWarmSaturationCurve(1025);
    warmWaveShaper.oversample = '2x';

    const limiter = created.createDynamicsCompressor();
    limiter.threshold.value = -10;
    limiter.threshold.setValueAtTime(-10, now);
    limiter.knee.value = 8;
    limiter.knee.setValueAtTime(8, now);
    limiter.ratio.value = 12;
    limiter.ratio.setValueAtTime(12, now);
    limiter.attack.value = 0.002;
    limiter.attack.setValueAtTime(0.002, now);
    limiter.release.value = 0.14;
    limiter.release.setValueAtTime(0.14, now);

    const initialMasterGain = this.muted ? 0 : this.masterVolume;
    const masterGain = created.createGain();
    masterGain.gain.value = initialMasterGain;
    masterGain.gain.setValueAtTime(initialMasterGain, now);

    mixBus.connect(subsonicHighpass);
    subsonicHighpass.connect(worldLowpass);
    worldLowpass.connect(warmWaveShaper);
    warmWaveShaper.connect(limiter);
    limiter.connect(masterGain);
    masterGain.connect(created.destination);

    this.mixBus = mixBus;
    this.subsonicHighpass = subsonicHighpass;
    this.worldLowpass = worldLowpass;
    this.warmWaveShaper = warmWaveShaper;
    this.limiter = limiter;
    this.masterGain = masterGain;

    this.buildDeterministicNoiseBuffers(created);
    return created;
  }

  private applyBulletTimeToWorldFilter(nowSec: number): void {
    if (this.worldLowpass === null) {
      return;
    }
    this.worldLowpass.frequency.cancelScheduledValues(nowSec);
    this.worldLowpass.frequency.value = this.masterLowpassHz;
    this.worldLowpass.frequency.setValueAtTime(this.masterLowpassHz, nowSec);

    this.worldLowpass.Q.cancelScheduledValues(nowSec);
    this.worldLowpass.Q.value = this.masterFilterQ;
    this.worldLowpass.Q.setValueAtTime(this.masterFilterQ, nowSec);
  }

  /**
   * Предгенерирует 3 детерминированных 2-секундных шумовых буфера:
   * 1) Белый шум (равномерный спектр);
   * 2) Розовый шум (-3 дБ/окт, 7-каскадный фильтр Пола Келлетта);
   * 3) Коричневый шум (-6 дБ/окт, интегратор с утечкой против ухода в DC).
   */
  private buildDeterministicNoiseBuffers(ctx: AudioContextLike): void {
    const sr = Number.isFinite(ctx.sampleRate) && ctx.sampleRate >= 8000 ? Math.round(ctx.sampleRate) : 44100;
    const length = Math.max(2048, Math.round(sr * NOISE_BUFFER_DURATION_SEC));
    const noiseRng = new SeededRng(this.baseSeed).fork(NOISE_BUFFER_SALT);

    // 1. Белый шум
    const whiteBuf = ctx.createBuffer(1, length, sr);
    const whiteCh = whiteBuf.getChannelData(0);
    let whiteSum = 0;
    for (let i = 0; i < length; i++) {
      const sample = noiseRng.range(-1, 1);
      whiteCh[i] = sample;
      whiteSum += sample;
    }
    const whiteMean = whiteSum / length;
    let whitePeak = 1e-6;
    for (let i = 0; i < length; i++) {
      const centered = whiteCh[i]! - whiteMean;
      whiteCh[i] = centered;
      const absVal = Math.abs(centered);
      if (absVal > whitePeak) {
        whitePeak = absVal;
      }
    }
    const whiteScale = 0.92 / whitePeak;
    for (let i = 0; i < length; i++) {
      whiteCh[i] = clamp(whiteCh[i]! * whiteScale, -1, 1);
    }

    // 2. Розовый шум (-3 дБ/окт по Полу Келлетту)
    const pinkBuf = ctx.createBuffer(1, length, sr);
    const pinkCh = pinkBuf.getChannelData(0);
    let b0 = 0;
    let b1 = 0;
    let b2 = 0;
    let b3 = 0;
    let b4 = 0;
    let b5 = 0;
    let b6 = 0;
    // Прогрев каскадов фильтра
    for (let w = 0; w < 256; w++) {
      const wn = noiseRng.range(-1, 1);
      b0 = 0.99886 * b0 + wn * 0.0555179;
      b1 = 0.99332 * b1 + wn * 0.0750759;
      b2 = 0.96900 * b2 + wn * 0.1538520;
      b3 = 0.86650 * b3 + wn * 0.3104856;
      b4 = 0.55000 * b4 + wn * 0.5329522;
      b5 = -0.7616 * b5 - wn * 0.0168980;
      b6 = wn * 0.115926;
    }
    let pinkSum = 0;
    for (let i = 0; i < length; i++) {
      const wn = noiseRng.range(-1, 1);
      b0 = 0.99886 * b0 + wn * 0.0555179;
      b1 = 0.99332 * b1 + wn * 0.0750759;
      b2 = 0.96900 * b2 + wn * 0.1538520;
      b3 = 0.86650 * b3 + wn * 0.3104856;
      b4 = 0.55000 * b4 + wn * 0.5329522;
      b5 = -0.7616 * b5 - wn * 0.0168980;
      const raw = b0 + b1 + b2 + b3 + b4 + b5 + b6 + wn * 0.5362;
      b6 = wn * 0.115926;
      pinkCh[i] = raw;
      pinkSum += raw;
    }
    const pinkMean = pinkSum / length;
    let pinkPeak = 1e-6;
    for (let i = 0; i < length; i++) {
      const centered = pinkCh[i]! - pinkMean;
      pinkCh[i] = centered;
      const absVal = Math.abs(centered);
      if (absVal > pinkPeak) {
        pinkPeak = absVal;
      }
    }
    const pinkScale = 0.92 / pinkPeak;
    for (let i = 0; i < length; i++) {
      pinkCh[i] = clamp(pinkCh[i]! * pinkScale, -1, 1);
    }

    // 3. Коричневый шум (-6 дБ/окт, интегратор с утечкой)
    const brownBuf = ctx.createBuffer(1, length, sr);
    const brownCh = brownBuf.getChannelData(0);
    let acc = 0;
    for (let w = 0; w < 256; w++) {
      acc = 0.985 * acc + 0.12 * noiseRng.range(-1, 1);
    }
    let brownSum = 0;
    for (let i = 0; i < length; i++) {
      acc = 0.985 * acc + 0.12 * noiseRng.range(-1, 1);
      brownCh[i] = acc;
      brownSum += acc;
    }
    const brownMean = brownSum / length;
    let brownPeak = 1e-6;
    for (let i = 0; i < length; i++) {
      const centered = brownCh[i]! - brownMean;
      brownCh[i] = centered;
      const absVal = Math.abs(centered);
      if (absVal > brownPeak) {
        brownPeak = absVal;
      }
    }
    const brownScale = 0.92 / brownPeak;
    for (let i = 0; i < length; i++) {
      brownCh[i] = clamp(brownCh[i]! * brownScale, -1, 1);
    }

    this.whiteNoiseBuffer = whiteBuf;
    this.pinkNoiseBuffer = pinkBuf;
    this.brownNoiseBuffer = brownBuf;
  }

  // ============================================================================
  // Управление пулом голосов и приоритетным вытеснением (maxPolyphony)
  // ============================================================================

  private advanceVirtualClockFromTelemetry(telemetry: SimulationTelemetry): void {
    const simTime = telemetry?.simTimeSec;
    if (Number.isFinite(simTime) && simTime >= 0) {
      if (this.lastSimTimeSec !== null && simTime >= this.lastSimTimeSec) {
        this.virtualClockSec += simTime - this.lastSimTimeSec;
      } else {
        this.virtualClockSec += 1 / 60;
      }
      this.lastSimTimeSec = simTime;
    } else {
      this.virtualClockSec += 1 / 60;
    }
  }

  private pruneFinishedVoices(nowSec: number): void {
    for (let i = this.activeVoices.length - 1; i >= 0; i--) {
      const voice = this.activeVoices[i]!;
      if (nowSec >= voice.endTimeSec) {
        this.disconnectVoiceNodes(voice);
        this.activeVoices.splice(i, 1);
      }
    }
  }

  private disconnectVoiceNodes(voice: ActiveVoiceRecord): void {
    for (let i = 0; i < voice.nodes.length; i++) {
      try {
        voice.nodes[i]!.disconnect();
      } catch {
        // Игнорируем повторное отключение завершённого узла.
      }
    }
  }

  private stopVoiceImmediately(voice: ActiveVoiceRecord, nowSec: number): void {
    if (voice.rootGain !== null) {
      try {
        voice.rootGain.gain.cancelScheduledValues(nowSec);
        voice.rootGain.gain.setTargetAtTime(MIN_EXP_VALUE, nowSec, 0.003);
      } catch {
        // Безопасная очистка при вытеснении голоса.
      }
    }
    const stopAt = safeAfter(nowSec, 0.012);
    for (let i = 0; i < voice.sources.length; i++) {
      try {
        voice.sources[i]!.stop(stopAt);
      } catch {
        // Источник уже мог быть остановлен.
      }
    }
    this.disconnectVoiceNodes(voice);
  }

  private stopAllActiveVoices(nowSec: number): void {
    for (let i = 0; i < this.activeVoices.length; i++) {
      this.stopVoiceImmediately(this.activeVoices[i]!, nowSec);
    }
    this.activeVoices.length = 0;
  }

  private allocateVoiceSlot(
    category: VoiceCategory,
    peakGain: number,
    startTimeSec: number,
    durationSec: number,
    ctx: AudioContextLike | null,
    nowSec: number,
  ): ActiveVoiceRecord | null {
    const safeStart = Math.max(nowSec, safeAudioTime(startTimeSec));
    const safeDuration = Math.max(0.02, Number.isFinite(durationSec) ? durationSec : 0.1);
    const priority = CATEGORY_BASE_PRIORITY[category] + clamp(peakGain, 0, 1) * 12;

    if (this.activeVoices.length >= this.maxPolyphony) {
      let weakestIdx = -1;
      let weakestEffectiveScore = Number.POSITIVE_INFINITY;
      let weakestRawPriority = Number.POSITIVE_INFINITY;

      for (let i = 0; i < this.activeVoices.length; i++) {
        const v = this.activeVoices[i]!;
        const remainingRatio = clamp(
          (v.endTimeSec - nowSec) / Math.max(0.02, v.durationSec),
          0.05,
          1.0,
        );
        const effectiveScore = v.priority * remainingRatio;
        if (effectiveScore < weakestEffectiveScore) {
          weakestEffectiveScore = effectiveScore;
          weakestRawPriority = v.priority;
          weakestIdx = i;
        }
      }

      if (weakestIdx < 0 || (priority <= weakestEffectiveScore && priority < weakestRawPriority)) {
        return null;
      }

      const evicted = this.activeVoices[weakestIdx]!;
      this.stopVoiceImmediately(evicted, nowSec);
      this.activeVoices.splice(weakestIdx, 1);
    }

    let rootGain: GainNodeLike | null = null;
    const nodes: AudioNodeLike[] = [];
    if (ctx !== null && this.mixBus !== null) {
      rootGain = ctx.createGain();
      rootGain.gain.value = 1.0;
      rootGain.gain.setValueAtTime(1.0, safeStart);
      rootGain.connect(this.mixBus);
      nodes.push(rootGain);
    }

    const record: ActiveVoiceRecord = {
      id: this.nextVoiceId++,
      category,
      priority,
      startTimeSec: safeStart,
      durationSec: safeDuration,
      endTimeSec: safeStart + safeDuration,
      rootGain,
      sources: [],
      nodes,
    };
    this.activeVoices.push(record);
    return record;
  }

  // ============================================================================
  // Кадровая коалесценция однотипных событий разрушения
  // ============================================================================

  private coalesceEvents(events: readonly SimulationEvent[]): CoalescedCandidate[] {
    const explosions: SimulationEventByType<'explosion'>[] = [];
    const fracturesByMat = new Map<
      StructuralMaterialId,
      { energyJ: number; shardCount: number }
    >();
    const glassImpacts: SimulationEventByType<'secondary_impact'>[] = [];
    const woodImpacts: SimulationEventByType<'secondary_impact'>[] = [];
    const steelImpacts: SimulationEventByType<'secondary_impact'>[] = [];
    const masonryImpacts: SimulationEventByType<'secondary_impact'>[] = [];
    const rebarSnaps: SimulationEventByType<'rebar_snap'>[] = [];
    const steelYields: SimulationEventByType<'steel_yield'>[] = [];
    let fireIgnitedCount = 0;
    let bestSeismicPulse: CoalescedSeismicPulseCandidate | null = null;

    for (let i = 0; i < events.length; i++) {
      const ev = events[i];
      if (!ev) {
        continue;
      }
      switch (ev.type) {
        case 'explosion': {
          explosions.push(ev);
          break;
        }
        case 'fracture': {
          const mat = ev.materialId;
          const e = finiteNonNegative(ev.energyJ);
          const sh = Math.max(1, Math.round(finiteNonNegative(ev.shardCount, 1)));
          const prev = fracturesByMat.get(mat);
          if (prev !== undefined) {
            prev.energyJ += e;
            prev.shardCount += sh;
          } else {
            fracturesByMat.set(mat, { energyJ: e, shardCount: sh });
          }
          break;
        }
        case 'secondary_impact': {
          if (ev.materialId === 'glass') {
            glassImpacts.push(ev);
          } else if (ev.materialId === 'wood') {
            woodImpacts.push(ev);
          } else if (ev.materialId === 'steel') {
            steelImpacts.push(ev);
          } else {
            masonryImpacts.push(ev);
          }
          break;
        }
        case 'rebar_snap': {
          rebarSnaps.push(ev);
          break;
        }
        case 'steel_yield': {
          steelYields.push(ev);
          break;
        }
        case 'fire_ignited': {
          fireIgnitedCount++;
          break;
        }
        case 'seismic_pulse': {
          const accel = finiteNonNegative(ev.groundAccelMpS2);
          const amp = finiteNonNegative(ev.amplitudeM);
          const freq = finiteClamped(
            ev.frequencyHz,
            PHYSICS_CONSTANTS_BOUNDS.seismicFrequencyHz[0],
            PHYSICS_CONSTANTS_BOUNDS.seismicFrequencyHz[1],
            2.5,
          );
          if (bestSeismicPulse === null || accel > bestSeismicPulse.groundAccelMpS2) {
            bestSeismicPulse = {
              kind: 'seismic_pulse',
              frequencyHz: freq,
              amplitudeM: amp,
              groundAccelMpS2: accel,
            };
          }
          break;
        }
        default: {
          const exhaustiveCheck: never = ev;
          void exhaustiveCheck;
          break;
        }
      }
    }

    const result: CoalescedCandidate[] = [];

    // 1. Взрывы (наивысший приоритет, до 3 голосов + остаток энергии в эхо-хвост)
    if (explosions.length > 0) {
      explosions.sort(
        (a, b) => finiteNonNegative(b.equivalentKgTnt) - finiteNonNegative(a.equivalentKgTnt),
      );
      const anyChain = explosions.some((e) => Boolean(e.isChainDetonation));
      let extraTnt = 0;
      for (let i = 3; i < explosions.length; i++) {
        extraTnt += finiteNonNegative(explosions[i]!.equivalentKgTnt);
      }
      const extraBoost = extraTnt > 0 ? clamp(Math.log10(1 + extraTnt) * 0.06, 0, 0.22) : 0;
      const count = Math.min(3, explosions.length);
      for (let i = 0; i < count; i++) {
        const ex = explosions[i]!;
        result.push({
          kind: 'explosion',
          equivalentKgTnt: finiteNonNegative(ex.equivalentKgTnt),
          radiusM: finiteNonNegative(ex.radiusM),
          isChainDetonation: Boolean(ex.isChainDetonation) || (i === 0 && anyChain),
          extraEchoBoost: i === 0 ? extraBoost : 0,
        });
      }
    }

    // 2. Сейсмический импульс
    if (bestSeismicPulse !== null) {
      result.push(bestSeismicPulse);
    }

    // 3. Вторичные удары тяжёлых обломков (группированные по акустическому классу)
    this.pushAggregatedImpacts(masonryImpacts, 2, result);
    this.pushAggregatedImpacts(steelImpacts, 1, result);
    this.pushAggregatedImpacts(woodImpacts, 1, result);
    this.pushAggregatedImpacts(glassImpacts, 1, result);

    // 4. Первичные расколы по каждому материалу (до 6 голосов за кадр)
    for (const [materialId, agg] of fracturesByMat.entries()) {
      result.push({
        kind: 'fracture',
        materialId,
        energyJ: agg.energyJ,
        shardCount: agg.shardCount,
      });
    }

    // 5. Каскадный разрыв стержней арматуры (до 3 голосов со ступенчатым сдвигом старта)
    if (rebarSnaps.length > 0) {
      rebarSnaps.sort((a, b) => finiteNonNegative(b.forceN) - finiteNonNegative(a.forceN));
      const offsets = [0, 0.018, 0.038];
      const count = Math.min(3, rebarSnaps.length);
      for (let i = 0; i < count; i++) {
        result.push({
          kind: 'rebar_snap',
          forceN: finiteNonNegative(rebarSnaps[i]!.forceN),
          offsetSec: offsets[i]!,
        });
      }
    }

    // 6. Пластическая деформация стали (до 2 голосов)
    if (steelYields.length > 0) {
      steelYields.sort((a, b) => finiteNonNegative(b.angleRad) - finiteNonNegative(a.angleRad));
      const count = Math.min(2, steelYields.length);
      for (let i = 0; i < count; i++) {
        result.push({
          kind: 'steel_yield',
          angleRad: finiteNonNegative(steelYields[i]!.angleRad),
          offsetSec: i * 0.025,
        });
      }
    }

    // 7. Вспышки воспламенения (до 2 голосов)
    const igniteVoices = Math.min(2, fireIgnitedCount);
    for (let i = 0; i < igniteVoices; i++) {
      result.push({
        kind: 'fire_ignited',
        offsetSec: i * 0.03,
      });
    }

    return result;
  }

  private pushAggregatedImpacts(
    impacts: SimulationEventByType<'secondary_impact'>[],
    maxVoices: number,
    out: CoalescedCandidate[],
  ): void {
    if (impacts.length === 0) {
      return;
    }
    impacts.sort(
      (a, b) =>
        finiteNonNegative(b.impulseNs) +
        finiteNonNegative(b.massKg) * 10 -
        (finiteNonNegative(a.impulseNs) + finiteNonNegative(a.massKg) * 10),
    );
    if (maxVoices <= 1 || impacts.length === 1) {
      let sumImpulse = 0;
      let sumMass = 0;
      for (let i = 0; i < impacts.length; i++) {
        sumImpulse += finiteNonNegative(impacts[i]!.impulseNs);
        sumMass += finiteNonNegative(impacts[i]!.massKg);
      }
      out.push({
        kind: 'secondary_impact',
        materialId: impacts[0]!.materialId,
        impulseNs: sumImpulse,
        massKg: sumMass,
      });
      return;
    }

    // Два голоса: крупнейший прямой удар + суммарный каскад остальных глыб
    const lead = impacts[0]!;
    out.push({
      kind: 'secondary_impact',
      materialId: lead.materialId,
      impulseNs: finiteNonNegative(lead.impulseNs),
      massKg: finiteNonNegative(lead.massKg),
    });

    let tailImpulse = 0;
    let tailMass = 0;
    for (let i = 1; i < impacts.length; i++) {
      tailImpulse += finiteNonNegative(impacts[i]!.impulseNs);
      tailMass += finiteNonNegative(impacts[i]!.massKg);
    }
    out.push({
      kind: 'secondary_impact',
      materialId: impacts[1]!.materialId,
      impulseNs: tailImpulse,
      massKg: tailMass,
    });
  }

  // ============================================================================
  // Синтез всех 8 физико-акустических слоёв разрушения
  // ============================================================================

  private synthesizeCandidate(
    candidate: CoalescedCandidate,
    ctx: AudioContextLike | null,
    nowSec: number,
  ): void {
    switch (candidate.kind) {
      case 'explosion': {
        this.synthExplosionVoice(candidate, ctx, nowSec);
        break;
      }
      case 'fracture': {
        if (candidate.materialId === 'glass') {
          const intensity = clamp(
            0.20 +
              0.26 * Math.log10(1 + candidate.energyJ / 120) +
              0.006 * clamp(candidate.shardCount, 1, 64),
            0.18,
            1.0,
          );
          this.synthGlassVoice(intensity, ctx, nowSec);
        } else if (candidate.materialId === 'wood') {
          const intensity = clamp(
            0.18 +
              0.28 * Math.log10(1 + candidate.energyJ / 90) +
              0.005 * clamp(candidate.shardCount, 1, 64),
            0.16,
            1.0,
          );
          this.synthWoodVoice(intensity, ctx, nowSec);
        } else {
          const normSeverity = clamp(
            Math.log10(1 + candidate.energyJ / 50 + candidate.shardCount * 0.25) / 5.5,
            0.06,
            1.0,
          );
          this.synthHeavyMaterialVoice(candidate.materialId, normSeverity, ctx, nowSec);
        }
        break;
      }
      case 'secondary_impact': {
        if (candidate.materialId === 'glass') {
          const intensity = clamp(
            0.18 + 0.28 * Math.log10(1 + (candidate.impulseNs + 8 * candidate.massKg) / 50),
            0.18,
            1.0,
          );
          this.synthGlassVoice(intensity, ctx, nowSec);
        } else if (candidate.materialId === 'wood') {
          const intensity = clamp(
            0.16 + 0.28 * Math.log10(1 + (candidate.impulseNs + 10 * candidate.massKg) / 60),
            0.16,
            1.0,
          );
          this.synthWoodVoice(intensity, ctx, nowSec);
        } else {
          const massTerm = Math.log10(1 + candidate.massKg / 5) / 5.0;
          const impulseTerm = Math.log10(1 + candidate.impulseNs / 25) / 5.2;
          const normSeverity = clamp(0.5 * massTerm + 0.5 * impulseTerm, 0.06, 1.0);
          this.synthHeavyMaterialVoice(candidate.materialId, normSeverity, ctx, nowSec);
        }
        break;
      }
      case 'rebar_snap': {
        this.synthRebarSnapVoice(candidate.forceN, candidate.offsetSec, ctx, nowSec);
        break;
      }
      case 'steel_yield': {
        this.synthSteelYieldVoice(candidate.angleRad, candidate.offsetSec, ctx, nowSec);
        break;
      }
      case 'fire_ignited': {
        this.synthFireIgnitedVoice(candidate.offsetSec, ctx, nowSec);
        break;
      }
      case 'seismic_pulse': {
        this.synthSeismicPulseVoice(candidate, ctx, nowSec);
        break;
      }
      default: {
        const exhaustiveCheck: never = candidate;
        void exhaustiveCheck;
        break;
      }
    }
  }

  /**
   * Слой 1: Высокочастотный звон и осыпание калёного стекла (моды пластины Кирхгофа 2.4–7.5 кГц + ВЧ-шум).
   */
  private synthGlassVoice(
    intensity: number,
    ctx: AudioContextLike | null,
    nowSec: number,
  ): void {
    const partialCount = clamp(4 + Math.floor(intensity * 3.5), 4, GLASS_MODAL_FREQUENCIES_HZ.length);
    const shimmerDur = (0.20 + 0.16 * intensity) * this.durationScale;
    const totalDur = shimmerDur + partialCount * 0.018 * this.durationScale + 0.05;
    const peakGain = 0.22 + 0.48 * intensity;

    const voice = this.allocateVoiceSlot('glass', peakGain, nowSec, totalDur, ctx, nowSec);
    if (voice === null || ctx === null || voice.rootGain === null) {
      return;
    }

    const t0 = voice.startTimeSec;

    // 1. ВЧ-щелчок трещины стекла
    if (this.whiteNoiseBuffer !== null) {
      const snapSrc = this.createNoiseSource(ctx, this.whiteNoiseBuffer, false);
      const snapFilter = ctx.createBiquadFilter();
      snapFilter.type = 'highpass';
      const hpHz = safeExpFreq(3200 * this.pitchScale, 400, 18500);
      snapFilter.frequency.value = hpHz;
      snapFilter.frequency.setValueAtTime(hpHz, t0);
      snapFilter.Q.value = 1.1;

      const snapGain = ctx.createGain();
      const snapPeak = safeExpGain((0.18 + 0.34 * intensity) * 0.85);
      const snapEnd = safeAfter(t0, 0.085 * this.durationScale);
      snapGain.gain.value = snapPeak;
      snapGain.gain.setValueAtTime(snapPeak, t0);
      snapGain.gain.exponentialRampToValueAtTime(MIN_EXP_VALUE, snapEnd);

      snapSrc.connect(snapFilter);
      snapFilter.connect(snapGain);
      snapGain.connect(voice.rootGain);

      snapSrc.start(t0, this.rng.range(0, 0.8));
      snapSrc.stop(safeAfter(snapEnd, 0.01));
      voice.sources.push(snapSrc);
      voice.nodes.push(snapSrc, snapFilter, snapGain);
    }

    // 2. Россыпь негармонических мод пластины (строго в полосе 2400..7500 Гц при pitchScale = 1)
    for (let k = 0; k < partialCount; k++) {
      const baseHz = GLASS_MODAL_FREQUENCIES_HZ[k]!;
      const jitter = this.rng.range(0.985, 1.015);
      const modalHz = safeExpFreq(baseHz * jitter * this.pitchScale, 250, 19000);
      const pStart = t0 + k * 0.016 * this.durationScale;
      const pAttack = safeAfter(pStart, 0.004);
      const pEnd = safeAfter(pAttack, (0.10 + 0.14 * intensity) * this.durationScale);

      const osc = ctx.createOscillator();
      osc.type = k % 2 === 0 ? 'sine' : 'triangle';
      osc.frequency.value = modalHz;
      osc.frequency.setValueAtTime(modalHz, pStart);

      const pGain = ctx.createGain();
      const amp = safeExpGain((0.08 + 0.18 * intensity) / Math.sqrt(1 + k * 0.45));
      pGain.gain.value = MIN_EXP_VALUE;
      pGain.gain.setValueAtTime(MIN_EXP_VALUE, pStart);
      pGain.gain.linearRampToValueAtTime(amp, pAttack);
      pGain.gain.exponentialRampToValueAtTime(MIN_EXP_VALUE, pEnd);

      osc.connect(pGain);
      pGain.connect(voice.rootGain);

      osc.start(pStart);
      osc.stop(safeAfter(pEnd, 0.01));
      voice.sources.push(osc);
      voice.nodes.push(osc, pGain);
    }

    // 3. Шлейф осыпающихся мелких осколков
    if (this.whiteNoiseBuffer !== null) {
      const tailStart = t0 + 0.025 * this.durationScale;
      const tailPeakAt = safeAfter(tailStart, 0.025 * this.durationScale);
      const tailEnd = safeAfter(tailPeakAt, shimmerDur);

      const tailSrc = this.createNoiseSource(ctx, this.whiteNoiseBuffer, false);
      const tailBp = ctx.createBiquadFilter();
      tailBp.type = 'bandpass';
      const bpHz = safeExpFreq(5200 * this.pitchScale, 500, 18500);
      tailBp.frequency.value = bpHz;
      tailBp.frequency.setValueAtTime(bpHz, tailStart);
      tailBp.Q.value = 2.4;

      const tailGain = ctx.createGain();
      const tailAmp = safeExpGain(0.10 + 0.22 * intensity);
      tailGain.gain.value = MIN_EXP_VALUE;
      tailGain.gain.setValueAtTime(MIN_EXP_VALUE, tailStart);
      tailGain.gain.linearRampToValueAtTime(tailAmp, tailPeakAt);
      tailGain.gain.exponentialRampToValueAtTime(MIN_EXP_VALUE, tailEnd);

      tailSrc.connect(tailBp);
      tailBp.connect(tailGain);
      tailGain.connect(voice.rootGain);

      tailSrc.start(tailStart, this.rng.range(0, 0.9));
      tailSrc.stop(safeAfter(tailEnd, 0.01));
      voice.sources.push(tailSrc);
      voice.nodes.push(tailSrc, tailBp, tailGain);
    }
  }

  /**
   * Слой 2: Хлёсткий металлический разрыв стержня арматуры с упругим нисходящим питч-бендом пропорционально forceN.
   */
  private synthRebarSnapVoice(
    forceN: number,
    offsetSec: number,
    ctx: AudioContextLike | null,
    nowSec: number,
  ): void {
    const safeForce = finiteNonNegative(forceN);
    const tension = clamp(Math.log10(1 + safeForce / 1000) / 3.0, 0.12, 1.0);
    const ringDur = (0.18 + 0.14 * tension) * this.durationScale;
    const startAt = nowSec + Math.max(0, offsetSec) * this.durationScale;
    const peakGain = 0.20 + 0.50 * tension;

    const voice = this.allocateVoiceSlot(
      'rebar_snap',
      peakGain,
      startAt,
      ringDur + 0.04,
      ctx,
      nowSec,
    );
    if (voice === null || ctx === null || voice.rootGain === null) {
      return;
    }

    const t0 = voice.startTimeSec;

    // 1. Щелчок разрыва стальной шейки
    if (this.whiteNoiseBuffer !== null) {
      const snapSrc = this.createNoiseSource(ctx, this.whiteNoiseBuffer, false);
      const snapBp = ctx.createBiquadFilter();
      snapBp.type = 'bandpass';
      const clickHz = safeExpFreq((2100 + 1400 * tension) * this.pitchScale, 300, 18000);
      snapBp.frequency.value = clickHz;
      snapBp.frequency.setValueAtTime(clickHz, t0);
      snapBp.Q.value = 3.5;

      const snapGain = ctx.createGain();
      const clickAmp = safeExpGain(0.18 + 0.36 * tension);
      const clickEnd = safeAfter(t0, 0.028 * this.durationScale);
      snapGain.gain.value = clickAmp;
      snapGain.gain.setValueAtTime(clickAmp, t0);
      snapGain.gain.exponentialRampToValueAtTime(MIN_EXP_VALUE, clickEnd);

      snapSrc.connect(snapBp);
      snapBp.connect(snapGain);
      snapGain.connect(voice.rootGain);

      snapSrc.start(t0, this.rng.range(0, 1.0));
      snapSrc.stop(safeAfter(clickEnd, 0.01));
      voice.sources.push(snapSrc);
      voice.nodes.push(snapSrc, snapBp, snapGain);
    }

    // 2. Упругий звон стержня с быстрым падением частоты (endFreq < startFreq)
    const startFreq = safeExpFreq((920 + 1350 * tension) * this.pitchScale, 120, 16000);
    const endFreq = safeExpFreq(startFreq * 0.48, 60, startFreq * 0.85);
    const ringAttack = safeAfter(t0, 0.004);
    const ringEnd = safeAfter(ringAttack, ringDur);

    const mainOsc = ctx.createOscillator();
    mainOsc.type = 'triangle';
    mainOsc.frequency.value = startFreq;
    mainOsc.frequency.setValueAtTime(startFreq, t0);
    mainOsc.frequency.exponentialRampToValueAtTime(endFreq, ringEnd);

    const overtoneStart = safeExpFreq(startFreq * 1.52, 180, 18500);
    const overtoneEnd = safeExpFreq(overtoneStart * 0.52, 90, overtoneStart * 0.85);
    const overtoneEndAt = safeAfter(ringAttack, ringDur * 0.78);

    const overtoneOsc = ctx.createOscillator();
    overtoneOsc.type = 'sine';
    overtoneOsc.frequency.value = overtoneStart;
    overtoneOsc.frequency.setValueAtTime(overtoneStart, t0);
    overtoneOsc.frequency.exponentialRampToValueAtTime(overtoneEnd, overtoneEndAt);

    const ringGain = ctx.createGain();
    const ringAmp = safeExpGain(0.18 + 0.44 * tension);
    ringGain.gain.value = MIN_EXP_VALUE;
    ringGain.gain.setValueAtTime(MIN_EXP_VALUE, t0);
    ringGain.gain.linearRampToValueAtTime(ringAmp, ringAttack);
    ringGain.gain.exponentialRampToValueAtTime(MIN_EXP_VALUE, ringEnd);

    mainOsc.connect(ringGain);
    overtoneOsc.connect(ringGain);
    ringGain.connect(voice.rootGain);

    mainOsc.start(t0);
    mainOsc.stop(safeAfter(ringEnd, 0.01));
    overtoneOsc.start(t0);
    overtoneOsc.stop(safeAfter(overtoneEndAt, 0.01));

    voice.sources.push(mainOsc, overtoneOsc);
    voice.nodes.push(mainOsc, overtoneOsc, ringGain);
  }

  /**
   * Слой 3: Металлический стон и скрежет пластического шарнира стальной балки пропорционально angleRad.
   */
  private synthSteelYieldVoice(
    angleRad: number,
    offsetSec: number,
    ctx: AudioContextLike | null,
    nowSec: number,
  ): void {
    const safeAngle = finiteNonNegative(angleRad);
    const strain = clamp(
      Math.log10(1 + safeAngle * 18) / Math.log10(1 + 0.6 * 18),
      0.10,
      1.0,
    );
    const groanDur = (0.28 + 0.28 * strain) * this.durationScale;
    const startAt = nowSec + Math.max(0, offsetSec) * this.durationScale;
    const peakGain = 0.16 + 0.40 * strain;

    const voice = this.allocateVoiceSlot(
      'steel_yield',
      peakGain,
      startAt,
      groanDur + 0.05,
      ctx,
      nowSec,
    );
    if (voice === null || ctx === null || voice.rootGain === null) {
      return;
    }

    const t0 = voice.startTimeSec;
    const attackAt = safeAfter(t0, 0.035 * this.durationScale);
    const endAt = safeAfter(attackAt, groanDur);

    const baseHz = safeExpFreq((145 + 210 * strain) * this.pitchScale, 45, 4000);
    const baseEndHz = safeExpFreq(baseHz * 0.82, 35, 3500);

    const oscA = ctx.createOscillator();
    oscA.type = 'sawtooth';
    oscA.detune.value = -18;
    oscA.detune.setValueAtTime(-18, t0);
    oscA.frequency.value = baseHz;
    oscA.frequency.setValueAtTime(baseHz, t0);
    oscA.frequency.exponentialRampToValueAtTime(baseEndHz, endAt);

    const modeHz = safeExpFreq(baseHz * 2.76, 100, 10000);
    const modeEndHz = safeExpFreq(modeHz * 0.78, 80, 9000);

    const oscB = ctx.createOscillator();
    oscB.type = 'triangle';
    oscB.detune.value = 19;
    oscB.detune.setValueAtTime(19, t0);
    oscB.frequency.value = modeHz;
    oscB.frequency.setValueAtTime(modeHz, t0);
    oscB.frequency.exponentialRampToValueAtTime(modeEndHz, endAt);

    const resonantBp = ctx.createBiquadFilter();
    resonantBp.type = 'bandpass';
    const bpStartHz = safeExpFreq((420 + 950 * strain) * this.pitchScale, 120, 12000);
    const bpEndHz = safeExpFreq((240 + 320 * strain) * this.pitchScale, 90, 8000);
    const qVal = 5.5 + 4.0 * strain;
    resonantBp.frequency.value = bpStartHz;
    resonantBp.frequency.setValueAtTime(bpStartHz, t0);
    resonantBp.frequency.exponentialRampToValueAtTime(bpEndHz, endAt);
    resonantBp.Q.value = qVal;
    resonantBp.Q.setValueAtTime(qVal, t0);

    const groanGain = ctx.createGain();
    const amp = safeExpGain(0.14 + 0.38 * strain);
    groanGain.gain.value = MIN_EXP_VALUE;
    groanGain.gain.setValueAtTime(MIN_EXP_VALUE, t0);
    groanGain.gain.linearRampToValueAtTime(amp, attackAt);
    groanGain.gain.exponentialRampToValueAtTime(MIN_EXP_VALUE, endAt);

    oscA.connect(resonantBp);
    oscB.connect(resonantBp);
    resonantBp.connect(groanGain);
    groanGain.connect(voice.rootGain);

    oscA.start(t0);
    oscA.stop(safeAfter(endAt, 0.01));
    oscB.start(t0);
    oscB.stop(safeAfter(endAt, 0.01));

    voice.sources.push(oscA, oscB);
    voice.nodes.push(oscA, oscB, resonantBp, groanGain);
  }

  /**
   * Слой 4: Сухой анизотропный треск и щепление древесных волокон (серия полосовых импульсов 420–2150 Гц + удар бруса).
   */
  private synthWoodVoice(
    intensity: number,
    ctx: AudioContextLike | null,
    nowSec: number,
  ): void {
    const pulseCount = clamp(3 + Math.floor(intensity * 2.5), 3, 5);
    const stepSec = 0.022 * this.durationScale;
    const pulseDur = 0.062 * this.durationScale;
    const totalDur = pulseCount * stepSec + pulseDur + 0.08 * this.durationScale;
    const peakGain = 0.20 + 0.46 * intensity;

    const voice = this.allocateVoiceSlot('wood', peakGain, nowSec, totalDur, ctx, nowSec);
    if (voice === null || ctx === null || voice.rootGain === null) {
      return;
    }

    const t0 = voice.startTimeSec;

    // 1. Зубчатая серия микро-импульсов расщепления волокон (розовый шум в полосе 420..2150 Гц)
    if (this.pinkNoiseBuffer !== null) {
      const spanDenom = Math.max(1, pulseCount - 1);
      for (let k = 0; k < pulseCount; k++) {
        const frac = k / spanDenom;
        const pStart = t0 + k * stepSec;
        const pAttack = safeAfter(pStart, 0.004);
        const pEnd = safeAfter(pAttack, pulseDur);

        const baseBandHz = 470 + frac * 1490 + this.rng.range(-30, 30);
        const bandHz = safeExpFreq(baseBandHz * this.pitchScale, 200, 14000);

        const src = this.createNoiseSource(ctx, this.pinkNoiseBuffer, false);
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = bandHz;
        bp.frequency.setValueAtTime(bandHz, pStart);
        bp.Q.value = 3.2;

        const pGain = ctx.createGain();
        const amp = safeExpGain((0.16 + 0.30 * intensity) * (1 - 0.12 * k));
        pGain.gain.value = MIN_EXP_VALUE;
        pGain.gain.setValueAtTime(MIN_EXP_VALUE, pStart);
        pGain.gain.linearRampToValueAtTime(amp, pAttack);
        pGain.gain.exponentialRampToValueAtTime(MIN_EXP_VALUE, pEnd);

        src.connect(bp);
        bp.connect(pGain);
        pGain.connect(voice.rootGain);

        src.start(pStart, this.rng.range(0, 1.2));
        src.stop(safeAfter(pEnd, 0.01));
        voice.sources.push(src);
        voice.nodes.push(src, bp, pGain);
      }
    }

    // 2. Сухой корпусной удар бруса
    const thumpOsc = ctx.createOscillator();
    thumpOsc.type = 'triangle';
    const thumpStartHz = safeExpFreq((180 + 35 * intensity) * this.pitchScale, 50, 2000);
    const thumpEndHz = safeExpFreq(68 * this.pitchScale, 30, 1200);
    const thumpEndAt = safeAfter(t0, (0.12 + 0.06 * intensity) * this.durationScale);

    thumpOsc.frequency.value = thumpStartHz;
    thumpOsc.frequency.setValueAtTime(thumpStartHz, t0);
    thumpOsc.frequency.exponentialRampToValueAtTime(thumpEndHz, thumpEndAt);

    const thumpGain = ctx.createGain();
    const thumpAmp = safeExpGain(0.16 + 0.28 * intensity);
    thumpGain.gain.value = thumpAmp;
    thumpGain.gain.setValueAtTime(thumpAmp, t0);
    thumpGain.gain.exponentialRampToValueAtTime(MIN_EXP_VALUE, thumpEndAt);

    thumpOsc.connect(thumpGain);
    thumpGain.connect(voice.rootGain);

    thumpOsc.start(t0);
    thumpOsc.stop(safeAfter(thumpEndAt, 0.01));
    voice.sources.push(thumpOsc);
    voice.nodes.push(thumpOsc, thumpGain);
  }

  /**
   * Слой 5: Каменный удар и сейсмический грохот падающих глыб/этажей
   * (reinforced_concrete, brick, steel, explosive) с монотонным масштабированием суббаса 35–110 Гц,
   * пикового гейна и длины хвоста обвала по энергии/импульсу/массе.
   */
  private synthHeavyMaterialVoice(
    materialId: StructuralMaterialId,
    normSeverity: number,
    ctx: AudioContextLike | null,
    nowSec: number,
  ): void {
    const m = clamp(normSeverity, 0.06, 1.0);
    const tailDur = (0.24 + 0.98 * m) * this.durationScale;
    const peakGain = 0.16 + 0.68 * m;

    const voice = this.allocateVoiceSlot(
      'masonry_impact',
      peakGain,
      nowSec,
      tailDur + 0.06,
      ctx,
      nowSec,
    );
    if (voice === null || ctx === null || voice.rootGain === null) {
      return;
    }

    const t0 = voice.startTimeSec;

    // 1. Суббасовый сейсмический удар в полосе 35..110 Гц (чем тяжелее глыба, тем ниже частота!)
    const subStartHz = safeExpFreq((108 - 44 * m) * this.pitchScale, 16, 400);
    const subEndHz = safeExpFreq((52 - 17 * m) * this.pitchScale, 14, 250);
    const subAttack = safeAfter(t0, 0.006);
    const subEnd = safeAfter(subAttack, (0.18 + 0.62 * m) * this.durationScale);

    const subOsc = ctx.createOscillator();
    subOsc.type = 'sine';
    subOsc.frequency.value = subStartHz;
    subOsc.frequency.setValueAtTime(subStartHz, t0);
    subOsc.frequency.exponentialRampToValueAtTime(subEndHz, subEnd);

    const subGain = ctx.createGain();
    const subAmp = safeExpGain(0.14 + 0.66 * m);
    subGain.gain.value = MIN_EXP_VALUE;
    subGain.gain.setValueAtTime(MIN_EXP_VALUE, t0);
    subGain.gain.linearRampToValueAtTime(subAmp, subAttack);
    subGain.gain.exponentialRampToValueAtTime(MIN_EXP_VALUE, subEnd);

    subOsc.connect(subGain);
    subGain.connect(voice.rootGain);

    subOsc.start(t0);
    subOsc.stop(safeAfter(subEnd, 0.01));
    voice.sources.push(subOsc);
    voice.nodes.push(subOsc, subGain);

    // 2. Низкочастотный грохот обвала (коричневый шум через закрывающийся ФНЧ)
    if (this.brownNoiseBuffer !== null) {
      const rumbleSrc = this.createNoiseSource(ctx, this.brownNoiseBuffer, false);
      const rumbleLp = ctx.createBiquadFilter();
      rumbleLp.type = 'lowpass';
      const lpStart = safeExpFreq((980 - 220 * m) * this.pitchScale, 90, 12000);
      const lpEnd = safeExpFreq((130 - 35 * m) * this.pitchScale, 40, 2000);
      const rumbleAttack = safeAfter(t0, 0.014 * this.durationScale);
      const rumbleEnd = safeAfter(rumbleAttack, tailDur);

      rumbleLp.frequency.value = lpStart;
      rumbleLp.frequency.setValueAtTime(lpStart, t0);
      rumbleLp.frequency.exponentialRampToValueAtTime(lpEnd, rumbleEnd);
      rumbleLp.Q.value = 1.05;

      const rumbleGain = ctx.createGain();
      const rumbleAmp = safeExpGain(0.12 + 0.58 * m);
      rumbleGain.gain.value = MIN_EXP_VALUE;
      rumbleGain.gain.setValueAtTime(MIN_EXP_VALUE, t0);
      rumbleGain.gain.linearRampToValueAtTime(rumbleAmp, rumbleAttack);
      rumbleGain.gain.exponentialRampToValueAtTime(MIN_EXP_VALUE, rumbleEnd);

      rumbleSrc.connect(rumbleLp);
      rumbleLp.connect(rumbleGain);
      rumbleGain.connect(voice.rootGain);

      rumbleSrc.start(t0, this.rng.range(0, 0.6));
      rumbleSrc.stop(safeAfter(rumbleEnd, 0.015));
      voice.sources.push(rumbleSrc);
      voice.nodes.push(rumbleSrc, rumbleLp, rumbleGain);
    }

    // 3. Характерный переходный акцент материала
    if (materialId === 'steel') {
      const clangOsc = ctx.createOscillator();
      clangOsc.type = 'triangle';
      const cStart = safeExpFreq(440 * this.pitchScale, 100, 6000);
      const cEnd = safeExpFreq(392 * this.pitchScale, 80, 5000);
      const cEndAt = safeAfter(t0, (0.20 + 0.24 * m) * this.durationScale);
      clangOsc.frequency.value = cStart;
      clangOsc.frequency.setValueAtTime(cStart, t0);
      clangOsc.frequency.exponentialRampToValueAtTime(cEnd, cEndAt);

      const clangGain = ctx.createGain();
      const cAmp = safeExpGain(0.10 + 0.28 * m);
      clangGain.gain.value = cAmp;
      clangGain.gain.setValueAtTime(cAmp, t0);
      clangGain.gain.exponentialRampToValueAtTime(MIN_EXP_VALUE, cEndAt);

      clangOsc.connect(clangGain);
      clangGain.connect(voice.rootGain);

      clangOsc.start(t0);
      clangOsc.stop(safeAfter(cEndAt, 0.01));
      voice.sources.push(clangOsc);
      voice.nodes.push(clangOsc, clangGain);
    } else if (materialId === 'explosive') {
      const drumOsc = ctx.createOscillator();
      drumOsc.type = 'triangle';
      const dStart = safeExpFreq(260 * this.pitchScale, 70, 3000);
      const dEnd = safeExpFreq(165 * this.pitchScale, 45, 2000);
      const dEndAt = safeAfter(t0, 0.18 * this.durationScale);
      drumOsc.frequency.value = dStart;
      drumOsc.frequency.setValueAtTime(dStart, t0);
      drumOsc.frequency.exponentialRampToValueAtTime(dEnd, dEndAt);

      const drumGain = ctx.createGain();
      const dAmp = safeExpGain(0.10 + 0.24 * m);
      drumGain.gain.value = dAmp;
      drumGain.gain.setValueAtTime(dAmp, t0);
      drumGain.gain.exponentialRampToValueAtTime(MIN_EXP_VALUE, dEndAt);

      drumOsc.connect(drumGain);
      drumGain.connect(voice.rootGain);

      drumOsc.start(t0);
      drumOsc.stop(safeAfter(dEndAt, 0.01));
      voice.sources.push(drumOsc);
      voice.nodes.push(drumOsc, drumGain);
    } else if (this.pinkNoiseBuffer !== null) {
      const crunchSrc = this.createNoiseSource(ctx, this.pinkNoiseBuffer, false);
      const crunchBp = ctx.createBiquadFilter();
      crunchBp.type = 'bandpass';
      const centerHz = materialId === 'brick' ? 1180 : 860;
      const bpHz = safeExpFreq(centerHz * this.pitchScale, 180, 12000);
      crunchBp.frequency.value = bpHz;
      crunchBp.frequency.setValueAtTime(bpHz, t0);
      crunchBp.Q.value = materialId === 'brick' ? 2.2 : 1.8;

      const crunchGain = ctx.createGain();
      const crunchEnd = safeAfter(t0, (0.11 + 0.10 * m) * this.durationScale);
      const crunchAmp = safeExpGain(0.10 + 0.30 * m);
      crunchGain.gain.value = crunchAmp;
      crunchGain.gain.setValueAtTime(crunchAmp, t0);
      crunchGain.gain.exponentialRampToValueAtTime(MIN_EXP_VALUE, crunchEnd);

      crunchSrc.connect(crunchBp);
      crunchBp.connect(crunchGain);
      crunchGain.connect(voice.rootGain);

      crunchSrc.start(t0, this.rng.range(0, 1.0));
      crunchSrc.stop(safeAfter(crunchEnd, 0.01));
      voice.sources.push(crunchSrc);
      voice.nodes.push(crunchSrc, crunchBp, crunchGain);
    }
  }

  /**
   * Слой 6: Взрывная ударная волна (щелчок детонации + суббас 28–80 Гц + закрывающийся рёв коричневого шума + эхо-хвост).
   */
  private synthExplosionVoice(
    candidate: CoalescedExplosionCandidate,
    ctx: AudioContextLike | null,
    nowSec: number,
  ): void {
    const power = clamp(
      Math.log10(1 + 2.5 * candidate.equivalentKgTnt + 0.15 * candidate.radiusM) / 3.8,
      0.15,
      1.0,
    );
    const chainMultiplier = candidate.isChainDetonation ? 1.42 : 1.0;
    const blastDur = (0.72 + 1.38 * power) * this.durationScale;
    const echoExtraDur = (0.28 + (candidate.isChainDetonation ? 0.24 : 0)) * this.durationScale;
    const totalDur = blastDur + echoExtraDur + 0.08;
    const peakGain = clamp(0.38 + 0.58 * power, 0.35, 1.0);

    const voice = this.allocateVoiceSlot('explosion', peakGain, nowSec, totalDur, ctx, nowSec);
    if (voice === null || ctx === null || voice.rootGain === null) {
      return;
    }

    const t0 = voice.startTimeSec;

    // 1. Детонационный щелчок (белый шум через ВЧ-фильтр)
    if (this.whiteNoiseBuffer !== null) {
      const clickSrc = this.createNoiseSource(ctx, this.whiteNoiseBuffer, false);
      const clickHp = ctx.createBiquadFilter();
      clickHp.type = 'highpass';
      const hpHz = safeExpFreq(1250 * this.pitchScale, 250, 16000);
      clickHp.frequency.value = hpHz;
      clickHp.frequency.setValueAtTime(hpHz, t0);
      clickHp.Q.value = 0.9;

      const clickGain = ctx.createGain();
      const clickAmp = safeExpGain(
        clamp((0.34 + 0.46 * power) * (candidate.isChainDetonation ? 1.15 : 1.0), 0.15, 0.95),
      );
      const clickEnd = safeAfter(t0, 0.024 * this.durationScale);
      clickGain.gain.value = clickAmp;
      clickGain.gain.setValueAtTime(clickAmp, t0);
      clickGain.gain.exponentialRampToValueAtTime(MIN_EXP_VALUE, clickEnd);

      clickSrc.connect(clickHp);
      clickHp.connect(clickGain);
      clickGain.connect(voice.rootGain);

      clickSrc.start(t0, this.rng.range(0, 1.0));
      clickSrc.stop(safeAfter(clickEnd, 0.01));
      voice.sources.push(clickSrc);
      voice.nodes.push(clickSrc, clickHp, clickGain);
    }

    // 2. Глубокий суббасовый удар в полосе 28..80 Гц
    const subStartHz = safeExpFreq((78 - 18 * power) * this.pitchScale, 14, 240);
    const subEndHz = safeExpFreq((36 - 8 * power) * this.pitchScale, 12, 160);
    const subAttack = safeAfter(t0, 0.008);
    const subEnd = safeAfter(subAttack, (0.52 + 0.96 * power) * this.durationScale);

    const subOsc = ctx.createOscillator();
    subOsc.type = 'sine';
    subOsc.frequency.value = subStartHz;
    subOsc.frequency.setValueAtTime(subStartHz, t0);
    subOsc.frequency.exponentialRampToValueAtTime(subEndHz, subEnd);

    const subGain = ctx.createGain();
    const subAmp = safeExpGain(0.32 + 0.56 * power);
    subGain.gain.value = MIN_EXP_VALUE;
    subGain.gain.setValueAtTime(MIN_EXP_VALUE, t0);
    subGain.gain.linearRampToValueAtTime(subAmp, subAttack);
    subGain.gain.exponentialRampToValueAtTime(MIN_EXP_VALUE, subEnd);

    subOsc.connect(subGain);
    subGain.connect(voice.rootGain);

    subOsc.start(t0);
    subOsc.stop(safeAfter(subEnd, 0.01));
    voice.sources.push(subOsc);
    voice.nodes.push(subOsc, subGain);

    // 3. Рёв ударной волны (коричневый шум через закрывающийся ФНЧ) + 4. Эхо-хвост отражений (DelayNode)
    if (this.brownNoiseBuffer !== null) {
      const blastSrc = this.createNoiseSource(ctx, this.brownNoiseBuffer, true);
      const blastLp = ctx.createBiquadFilter();
      blastLp.type = 'lowpass';
      const lpStart = safeExpFreq((2800 + 1400 * power) * this.pitchScale, 250, MAX_WORLD_LOWPASS_HZ);
      const lpEnd = safeExpFreq(88 * this.pitchScale, 35, 1200);
      const blastAttack = safeAfter(t0, 0.012);
      const blastEnd = safeAfter(blastAttack, blastDur);

      blastLp.frequency.value = lpStart;
      blastLp.frequency.setValueAtTime(lpStart, t0);
      blastLp.frequency.exponentialRampToValueAtTime(lpEnd, blastEnd);
      blastLp.Q.value = 1.15;

      const blastGain = ctx.createGain();
      const blastAmp = safeExpGain(0.28 + 0.54 * power);
      blastGain.gain.value = MIN_EXP_VALUE;
      blastGain.gain.setValueAtTime(MIN_EXP_VALUE, t0);
      blastGain.gain.linearRampToValueAtTime(blastAmp, blastAttack);
      blastGain.gain.exponentialRampToValueAtTime(MIN_EXP_VALUE, blastEnd);

      // Эхо-хвост на линии задержки с усилением при цепной детонации
      const delaySec = clamp((0.14 + 0.08 * power) * this.durationScale, 0.05, 0.48);
      const echoDelay = ctx.createDelay(1.0);
      echoDelay.delayTime.value = delaySec;
      echoDelay.delayTime.setValueAtTime(delaySec, t0);

      const echoLp = ctx.createBiquadFilter();
      echoLp.type = 'lowpass';
      const echoLpHz = safeExpFreq(260 * this.pitchScale, 70, 2200);
      echoLp.frequency.value = echoLpHz;
      echoLp.frequency.setValueAtTime(echoLpHz, t0);
      echoLp.Q.value = 0.85;

      const echoGain = ctx.createGain();
      const echoPeak = safeExpGain(
        clamp((0.12 + 0.24 * power + candidate.extraEchoBoost) * chainMultiplier, 0.05, 0.90),
      );
      const echoPeakAt = safeAfter(t0, delaySec + 0.02);
      const echoEndAt = safeAfter(echoPeakAt, blastDur * 0.65 + echoExtraDur);
      echoGain.gain.value = MIN_EXP_VALUE;
      echoGain.gain.setValueAtTime(MIN_EXP_VALUE, t0);
      echoGain.gain.linearRampToValueAtTime(echoPeak, echoPeakAt);
      echoGain.gain.exponentialRampToValueAtTime(MIN_EXP_VALUE, echoEndAt);

      blastSrc.connect(blastLp);
      blastLp.connect(blastGain);
      blastGain.connect(voice.rootGain);

      blastLp.connect(echoDelay);
      echoDelay.connect(echoLp);
      echoLp.connect(echoGain);
      echoGain.connect(voice.rootGain);

      blastSrc.start(t0, this.rng.range(0, 0.5));
      blastSrc.stop(safeAfter(Math.max(blastEnd, echoEndAt), 0.02));
      voice.sources.push(blastSrc);
      voice.nodes.push(blastSrc, blastLp, blastGain, echoDelay, echoLp, echoGain);
    }
  }

  /**
   * Вспышка воспламенения узла (событие fire_ignited).
   */
  private synthFireIgnitedVoice(
    offsetSec: number,
    ctx: AudioContextLike | null,
    nowSec: number,
  ): void {
    const startAt = nowSec + Math.max(0, offsetSec) * this.durationScale;
    const dur = 0.24 * this.durationScale;
    const peakGain = 0.26;

    const voice = this.allocateVoiceSlot('fire_ignite', peakGain, startAt, dur + 0.03, ctx, nowSec);
    if (voice === null || ctx === null || voice.rootGain === null || this.pinkNoiseBuffer === null) {
      return;
    }

    const t0 = voice.startTimeSec;
    const attackAt = safeAfter(t0, 0.03 * this.durationScale);
    const endAt = safeAfter(attackAt, dur);

    const src = this.createNoiseSource(ctx, this.pinkNoiseBuffer, false);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    const startHz = safeExpFreq(340 * this.pitchScale, 90, 4000);
    const endHz = safeExpFreq(125 * this.pitchScale, 50, 2000);
    bp.frequency.value = startHz;
    bp.frequency.setValueAtTime(startHz, t0);
    bp.frequency.exponentialRampToValueAtTime(endHz, endAt);
    bp.Q.value = 1.4;

    const g = ctx.createGain();
    g.gain.value = MIN_EXP_VALUE;
    g.gain.setValueAtTime(MIN_EXP_VALUE, t0);
    g.gain.linearRampToValueAtTime(peakGain, attackAt);
    g.gain.exponentialRampToValueAtTime(MIN_EXP_VALUE, endAt);

    src.connect(bp);
    bp.connect(g);
    g.connect(voice.rootGain);

    src.start(t0, this.rng.range(0, 1.0));
    src.stop(safeAfter(endAt, 0.01));
    voice.sources.push(src);
    voice.nodes.push(src, bp, g);
  }

  /**
   * Слой 7: Непрерывная петля гула и потрескивания пожара по burningNodeCount и maxTemperatureC.
   */
  private updateFireLoop(
    telemetry: SimulationTelemetry,
    ctx: AudioContextLike | null,
    nowSec: number,
  ): void {
    const burningCount = Math.floor(finiteNonNegative(telemetry?.burningNodeCount));
    const maxTempC = finiteClamped(
      telemetry?.maxTemperatureC,
      AMBIENT_TEMPERATURE_C,
      2000,
      AMBIENT_TEMPERATURE_C,
    );

    if (this.muted || burningCount <= 0) {
      this.fireLoopGain = 0;
      this.fireCenterHz = 480;
      if (this.fireLoopRig !== null) {
        this.fireLoopRig.masterGain.gain.cancelScheduledValues(nowSec);
        this.fireLoopRig.masterGain.gain.value = 0;
        this.fireLoopRig.masterGain.gain.setValueAtTime(0, nowSec);
      }
      return;
    }

    const burnScale = clamp(Math.log10(1 + burningCount) / Math.log10(65), 0.08, 1.0);
    const heatScale = clamp((maxTempC - 180) / 920, 0, 1.0);

    const targetGain = clamp((0.05 + 0.26 * burnScale) * (0.78 + 0.22 * heatScale), 0.02, 0.36);
    const targetCenterHz = clamp(
      (480 + 780 * heatScale + 140 * burnScale) * this.pitchScale,
      220,
      4500,
    );
    const targetDraftHz = clamp((180 + 180 * burnScale) * this.pitchScale, 80, 1200);

    this.fireLoopGain = targetGain;
    this.fireCenterHz = targetCenterHz;

    if (
      ctx === null ||
      this.mixBus === null ||
      this.brownNoiseBuffer === null ||
      this.pinkNoiseBuffer === null
    ) {
      return;
    }

    if (!this.hasExplicitFactory && ctx.state !== 'running') {
      return;
    }

    if (this.fireLoopRig === null) {
      const masterGain = ctx.createGain();
      masterGain.gain.value = 0;
      masterGain.gain.setValueAtTime(0, nowSec);
      masterGain.connect(this.mixBus);

      const draftFilter = ctx.createBiquadFilter();
      draftFilter.type = 'lowpass';
      draftFilter.frequency.value = targetDraftHz;
      draftFilter.frequency.setValueAtTime(targetDraftHz, nowSec);
      draftFilter.Q.value = 0.85;
      draftFilter.connect(masterGain);

      const hissFilter = ctx.createBiquadFilter();
      hissFilter.type = 'bandpass';
      hissFilter.frequency.value = targetCenterHz;
      hissFilter.frequency.setValueAtTime(targetCenterHz, nowSec);
      hissFilter.Q.value = 1.35;
      hissFilter.connect(masterGain);

      const draftSource = this.createNoiseSource(ctx, this.brownNoiseBuffer, true);
      draftSource.connect(draftFilter);
      draftSource.start(nowSec, this.rng.range(0, 0.5));

      const hissSource = this.createNoiseSource(ctx, this.pinkNoiseBuffer, true);
      hissSource.connect(hissFilter);
      hissSource.start(nowSec, this.rng.range(0, 0.5));

      this.fireLoopRig = {
        masterGain,
        draftFilter,
        hissFilter,
        draftSource,
        hissSource,
      };
    }

    this.fireLoopRig.masterGain.gain.cancelScheduledValues(nowSec);
    this.fireLoopRig.masterGain.gain.value = targetGain;
    this.fireLoopRig.masterGain.gain.setTargetAtTime(targetGain, nowSec, 0.05);

    this.fireLoopRig.draftFilter.frequency.cancelScheduledValues(nowSec);
    this.fireLoopRig.draftFilter.frequency.value = targetDraftHz;
    this.fireLoopRig.draftFilter.frequency.setValueAtTime(targetDraftHz, nowSec);

    this.fireLoopRig.hissFilter.frequency.cancelScheduledValues(nowSec);
    this.fireLoopRig.hissFilter.frequency.value = targetCenterHz;
    this.fireLoopRig.hissFilter.frequency.setValueAtTime(targetCenterHz, nowSec);

    // Детерминированные микро-щелчки тлеющих углей (без утечки осцилляторов и строго в свободном пуле)
    if (
      nowSec >= this.nextFireCrackleTimeSec &&
      this.activeVoices.length < this.maxPolyphony - 2 &&
      this.whiteNoiseBuffer !== null
    ) {
      const interval = (0.24 - 0.14 * burnScale) * this.durationScale;
      this.nextFireCrackleTimeSec = nowSec + Math.max(0.06, interval);
      this.spawnFireCrackleTick(burnScale, ctx, nowSec);
    }
  }

  private spawnFireCrackleTick(
    burnScale: number,
    ctx: AudioContextLike,
    nowSec: number,
  ): void {
    if (this.whiteNoiseBuffer === null) {
      return;
    }
    const dur = 0.026 * this.durationScale;
    const amp = safeExpGain(0.04 + 0.09 * burnScale);
    const voice = this.allocateVoiceSlot('fire_crackle', amp, nowSec, dur + 0.015, ctx, nowSec);
    if (voice === null || voice.rootGain === null) {
      return;
    }
    const t0 = voice.startTimeSec;
    const endAt = safeAfter(t0, dur);

    const src = this.createNoiseSource(ctx, this.whiteNoiseBuffer, false);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    const freq = safeExpFreq(this.rng.range(2200, 3600) * this.pitchScale, 500, 16000);
    bp.frequency.value = freq;
    bp.frequency.setValueAtTime(freq, t0);
    bp.Q.value = 4.2;

    const g = ctx.createGain();
    g.gain.value = amp;
    g.gain.setValueAtTime(amp, t0);
    g.gain.exponentialRampToValueAtTime(MIN_EXP_VALUE, endAt);

    src.connect(bp);
    bp.connect(g);
    g.connect(voice.rootGain);

    src.start(t0, this.rng.range(0, 1.4));
    src.stop(safeAfter(endAt, 0.008));
    voice.sources.push(src);
    voice.nodes.push(src, bp, g);
  }

  private teardownFireLoop(nowSec: number): void {
    if (this.fireLoopRig === null) {
      return;
    }
    const stopAt = safeAfter(nowSec, 0.01);
    try {
      this.fireLoopRig.draftSource.stop(stopAt);
    } catch {
      // Игнорируем ошибку остановки.
    }
    try {
      this.fireLoopRig.hissSource.stop(stopAt);
    } catch {
      // Игнорируем ошибку остановки.
    }
    try {
      this.fireLoopRig.draftSource.disconnect();
      this.fireLoopRig.hissSource.disconnect();
      this.fireLoopRig.draftFilter.disconnect();
      this.fireLoopRig.hissFilter.disconnect();
      this.fireLoopRig.masterGain.disconnect();
    } catch {
      // Игнорируем повторное отключение.
    }
    this.fireLoopRig = null;
  }

  /**
   * Слой 8: Непрерывная петля сейсмоплатформы с реальным инфразвуковым LFO-осциллятором
   * точно на частоте clamp(seismicFrequencyHz, 0.5, 15.0) Гц и гейном по seismicAmplitudeM.
   */
  private updateSeismicLoop(
    telemetry: SimulationTelemetry,
    ctx: AudioContextLike | null,
    nowSec: number,
  ): void {
    const active = Boolean(telemetry?.seismicActive);
    const [minHz, maxHz] = PHYSICS_CONSTANTS_BOUNDS.seismicFrequencyHz;
    const modHz = finiteClamped(telemetry?.seismicFrequencyHz, minHz, maxHz, 2.5);
    const ampM = finiteClamped(
      telemetry?.seismicAmplitudeM,
      0,
      PHYSICS_CONSTANTS_BOUNDS.seismicAmplitudeM[1],
      0.35,
    );

    const ampNorm = clamp(ampM / PHYSICS_CONSTANTS_BOUNDS.seismicAmplitudeM[1], 0, 1);
    const carrierHz = clamp((36 + 1.8 * modHz + 6 * ampNorm) * this.pitchScale, 24, 95);

    this.seismicModulationHz = modHz;
    this.seismicCarrierHz = carrierHz;

    if (this.muted || !active || ampM <= 0) {
      this.seismicLoopGain = 0;
      if (this.seismicLoopRig !== null) {
        this.seismicLoopRig.masterGain.gain.cancelScheduledValues(nowSec);
        this.seismicLoopRig.masterGain.gain.value = 0;
        this.seismicLoopRig.masterGain.gain.setValueAtTime(0, nowSec);
      }
      return;
    }

    const targetGain = clamp(0.06 + 0.38 * Math.pow(ampNorm, 0.72), 0.04, 0.44);
    const rumbleCutoffHz = clamp((95 + 75 * ampNorm) * this.pitchScale, 50, 450);
    this.seismicLoopGain = targetGain;

    if (ctx === null || this.mixBus === null || this.brownNoiseBuffer === null) {
      return;
    }

    if (!this.hasExplicitFactory && ctx.state !== 'running') {
      return;
    }

    if (this.seismicLoopRig === null) {
      const masterGain = ctx.createGain();
      masterGain.gain.value = 0;
      masterGain.gain.setValueAtTime(0, nowSec);
      masterGain.connect(this.mixBus);

      const modGain = ctx.createGain();
      modGain.gain.value = 0.62;
      modGain.gain.setValueAtTime(0.62, nowSec);
      modGain.connect(masterGain);

      // Инфразвуковой LFO-осциллятор реальной частоты землетрясения (0.5..15.0 Гц)
      const lfoOsc = ctx.createOscillator();
      lfoOsc.type = 'sine';
      lfoOsc.frequency.value = modHz;
      lfoOsc.frequency.setValueAtTime(modHz, nowSec);

      const lfoDepthGain = ctx.createGain();
      lfoDepthGain.gain.value = 0.38;
      lfoDepthGain.gain.setValueAtTime(0.38, nowSec);

      lfoOsc.connect(lfoDepthGain);
      lfoDepthGain.connect(modGain.gain);

      const carrierOsc = ctx.createOscillator();
      carrierOsc.type = 'triangle';
      carrierOsc.frequency.value = carrierHz;
      carrierOsc.frequency.setValueAtTime(carrierHz, nowSec);
      carrierOsc.connect(modGain);

      const rumbleFilter = ctx.createBiquadFilter();
      rumbleFilter.type = 'lowpass';
      rumbleFilter.frequency.value = rumbleCutoffHz;
      rumbleFilter.frequency.setValueAtTime(rumbleCutoffHz, nowSec);
      rumbleFilter.Q.value = 1.1;
      rumbleFilter.connect(modGain);

      const rumbleSource = this.createNoiseSource(ctx, this.brownNoiseBuffer, true);
      rumbleSource.connect(rumbleFilter);

      lfoOsc.start(nowSec);
      carrierOsc.start(nowSec);
      rumbleSource.start(nowSec, this.rng.range(0, 0.4));

      this.seismicLoopRig = {
        masterGain,
        modGain,
        lfoDepthGain,
        lfoOsc,
        carrierOsc,
        rumbleFilter,
        rumbleSource,
      };
    }

    this.seismicLoopRig.lfoOsc.frequency.cancelScheduledValues(nowSec);
    this.seismicLoopRig.lfoOsc.frequency.value = modHz;
    this.seismicLoopRig.lfoOsc.frequency.setValueAtTime(modHz, nowSec);

    this.seismicLoopRig.carrierOsc.frequency.cancelScheduledValues(nowSec);
    this.seismicLoopRig.carrierOsc.frequency.value = carrierHz;
    this.seismicLoopRig.carrierOsc.frequency.setValueAtTime(carrierHz, nowSec);

    this.seismicLoopRig.rumbleFilter.frequency.cancelScheduledValues(nowSec);
    this.seismicLoopRig.rumbleFilter.frequency.value = rumbleCutoffHz;
    this.seismicLoopRig.rumbleFilter.frequency.setValueAtTime(rumbleCutoffHz, nowSec);

    this.seismicLoopRig.masterGain.gain.cancelScheduledValues(nowSec);
    this.seismicLoopRig.masterGain.gain.value = targetGain;
    this.seismicLoopRig.masterGain.gain.setTargetAtTime(targetGain, nowSec, 0.045);
  }

  private teardownSeismicLoop(nowSec: number): void {
    if (this.seismicLoopRig === null) {
      return;
    }
    const stopAt = safeAfter(nowSec, 0.01);
    try {
      this.seismicLoopRig.lfoOsc.stop(stopAt);
    } catch {
      // Игнорируем ошибку остановки.
    }
    try {
      this.seismicLoopRig.carrierOsc.stop(stopAt);
    } catch {
      // Игнорируем ошибку остановки.
    }
    try {
      this.seismicLoopRig.rumbleSource.stop(stopAt);
    } catch {
      // Игнорируем ошибку остановки.
    }
    try {
      this.seismicLoopRig.lfoOsc.disconnect();
      this.seismicLoopRig.lfoDepthGain.disconnect();
      this.seismicLoopRig.carrierOsc.disconnect();
      this.seismicLoopRig.rumbleSource.disconnect();
      this.seismicLoopRig.rumbleFilter.disconnect();
      this.seismicLoopRig.modGain.disconnect();
      this.seismicLoopRig.masterGain.disconnect();
    } catch {
      // Игнорируем повторное отключение.
    }
    this.seismicLoopRig = null;
  }

  /**
   * Импульсный тектонический толчок (событие seismic_pulse) пропорционально ускорению грунта groundAccelMpS2.
   */
  private synthSeismicPulseVoice(
    candidate: CoalescedSeismicPulseCandidate,
    ctx: AudioContextLike | null,
    nowSec: number,
  ): void {
    const strength = clamp(
      Math.log10(1 + candidate.groundAccelMpS2 + candidate.amplitudeM * 12) / 2.2,
      0.12,
      1.0,
    );
    const dur = (0.28 + 0.44 * strength) * this.durationScale;
    const peakGain = 0.18 + 0.50 * strength;

    const voice = this.allocateVoiceSlot('seismic_pulse', peakGain, nowSec, dur + 0.04, ctx, nowSec);
    if (voice === null || ctx === null || voice.rootGain === null) {
      return;
    }

    const t0 = voice.startTimeSec;
    const attackAt = safeAfter(t0, 0.012);
    const endAt = safeAfter(attackAt, dur);

    const subOsc = ctx.createOscillator();
    subOsc.type = 'sine';
    const startHz = safeExpFreq((56 + 1.5 * candidate.frequencyHz) * this.pitchScale, 18, 220);
    const endHz = safeExpFreq(30 * this.pitchScale, 14, 120);
    subOsc.frequency.value = startHz;
    subOsc.frequency.setValueAtTime(startHz, t0);
    subOsc.frequency.exponentialRampToValueAtTime(endHz, endAt);

    const subGain = ctx.createGain();
    const subAmp = safeExpGain(0.18 + 0.48 * strength);
    subGain.gain.value = MIN_EXP_VALUE;
    subGain.gain.setValueAtTime(MIN_EXP_VALUE, t0);
    subGain.gain.linearRampToValueAtTime(subAmp, attackAt);
    subGain.gain.exponentialRampToValueAtTime(MIN_EXP_VALUE, endAt);

    subOsc.connect(subGain);
    subGain.connect(voice.rootGain);

    subOsc.start(t0);
    subOsc.stop(safeAfter(endAt, 0.01));
    voice.sources.push(subOsc);
    voice.nodes.push(subOsc, subGain);

    if (this.brownNoiseBuffer !== null) {
      const src = this.createNoiseSource(ctx, this.brownNoiseBuffer, false);
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      const lpHz = safeExpFreq(180 * this.pitchScale, 45, 1200);
      lp.frequency.value = lpHz;
      lp.frequency.setValueAtTime(lpHz, t0);
      lp.Q.value = 1.0;

      const g = ctx.createGain();
      const gAmp = safeExpGain(0.12 + 0.34 * strength);
      g.gain.value = MIN_EXP_VALUE;
      g.gain.setValueAtTime(MIN_EXP_VALUE, t0);
      g.gain.linearRampToValueAtTime(gAmp, attackAt);
      g.gain.exponentialRampToValueAtTime(MIN_EXP_VALUE, endAt);

      src.connect(lp);
      lp.connect(g);
      g.connect(voice.rootGain);

      src.start(t0, this.rng.range(0, 0.6));
      src.stop(safeAfter(endAt, 0.01));
      voice.sources.push(src);
      voice.nodes.push(src, lp, g);
    }
  }

  private createNoiseSource(
    ctx: AudioContextLike,
    buffer: AudioBufferLike,
    loop: boolean,
  ): AudioBufferSourceNodeLike {
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = loop;
    if (loop) {
      src.loopStart = 0;
      src.loopEnd = buffer.duration;
    }
    const rate = clamp(this.pitchScale, 0.25, 2.0);
    src.playbackRate.value = rate;
    return src;
  }
}
