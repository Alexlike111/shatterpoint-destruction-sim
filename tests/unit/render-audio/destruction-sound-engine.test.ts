import { describe, expect, it } from 'vitest';
import {
  DestructionSoundEngine,
  asAudioContextLike,
  asRealtimeAudioContextLike,
} from '../../../src/audio/DestructionSoundEngine';
import { SeededRng } from '../../../src/core/rng';
import {
  AMBIENT_TEMPERATURE_C,
  STRUCTURAL_MATERIAL_IDS,
  type SimulationEvent,
  type SimulationTelemetry,
} from '../../../src/core/types';
import {
  DiagnosticAudioParam,
  DiagnosticWebAudioContext,
} from './helpers/diagnostic-audio-context';

/**
 * Безмоковые модульные тесты многослойного процедурного синтезатора DestructionSoundEngine (фича F16).
 * Проверяют физико-акустическую монотонность всех 8 слоёв синтеза, спектральные инварианты шума,
 * математику фильтра Bullet-Time, коалесценцию 500 событий, пул голосов и строгость стандарта W3C Web Audio.
 */

function makeTelemetry(overrides?: Partial<SimulationTelemetry>): SimulationTelemetry {
  return {
    tick: 1,
    simTimeSec: 1 / 60,
    intactBlockCount: 24,
    initialBlockCount: 24,
    intactJointCount: 40,
    initialJointCount: 40,
    brokenJointCount: 0,
    activeRebarCount: 0,
    snappedRebarCount: 0,
    plasticHingeCount: 0,
    activeShardCount: 0,
    bakedRubbleCount: 0,
    burningNodeCount: 0,
    maxTemperatureC: AMBIENT_TEMPERATURE_C,
    maxStressUtilization: 0.15,
    kineticEnergyKJ: 0,
    secondaryImpactsCount: 0,
    detonatedExplosivesCount: 0,
    destructionPct: 0,
    targetMaxHeightM: 18,
    protectedDamagePct: 0,
    seismicActive: false,
    seismicFrequencyHz: 2.5,
    seismicAmplitudeM: 0.35,
    lastStepCpuMs: 0.8,
    ...overrides,
  };
}

function computeMeanSquaredFirstDifference(samples: Float32Array): number {
  if (samples.length < 2) {
    return 0;
  }
  let sumSq = 0;
  for (let i = 1; i < samples.length; i++) {
    const diff = samples[i]! - samples[i - 1]!;
    sumSq += diff * diff;
  }
  return sumSq / (samples.length - 1);
}

describe('DestructionSoundEngine — процедурный многослойный Web Audio синтезатор разрушения (F16)', () => {
  it('1. Безопасно работает в чистом headless-режиме Node.js без AudioContext, поддерживает идемпотентный dispose и гасит отклонённый resume()', async () => {
    expect(typeof asAudioContextLike).toBe('function');
    expect(typeof asRealtimeAudioContextLike).toBe('function');

    const headlessEngine = new DestructionSoundEngine({ seed: 101, maxPolyphony: 16 });
    expect(headlessEngine.isHeadless()).toBe(true);
    expect(headlessEngine.isDisposed()).toBe(false);
    expect(headlessEngine.getMaxPolyphony()).toBe(16);

    headlessEngine.unlock();
    headlessEngine.setTimeScale(0.35);
    expect(headlessEngine.getTimeScale()).toBeCloseTo(0.35, 6);

    const allSevenEvents: SimulationEvent[] = [
      { type: 'fracture', position: [0, 2, 0], materialId: 'glass', energyJ: 900, shardCount: 12 },
      { type: 'rebar_snap', position: [1, 3, 0], forceN: 85_000 },
      { type: 'steel_yield', position: [-1, 4, 0], angleRad: 0.18 },
      {
        type: 'secondary_impact',
        position: [0, 0.5, 1],
        materialId: 'reinforced_concrete',
        impulseNs: 45_000,
        massKg: 3_200,
        targetTag: 'target',
      },
      {
        type: 'explosion',
        position: [2, 1, -1],
        radiusM: 9,
        equivalentKgTnt: 18,
        isChainDetonation: false,
      },
      { type: 'fire_ignited', nodeId: 7, position: [0, 5, 0] },
      { type: 'seismic_pulse', frequencyHz: 3.5, amplitudeM: 0.4, groundAccelMpS2: 14 },
    ];

    headlessEngine.consumeEvents(
      allSevenEvents,
      makeTelemetry({
        simTimeSec: 0.1,
        burningNodeCount: 5,
        maxTemperatureC: 640,
        seismicActive: true,
        seismicFrequencyHz: 3.5,
        seismicAmplitudeM: 0.6,
      }),
    );

    const snapBeforeDispose = headlessEngine.getAcousticSnapshot();
    expect(snapBeforeDispose.headless).toBe(true);
    expect(snapBeforeDispose.activeVoices).toBeGreaterThan(0);
    expect(snapBeforeDispose.activeVoices).toBeLessThanOrEqual(16);
    expect(snapBeforeDispose.fireLoopGain).toBeGreaterThan(0);
    expect(snapBeforeDispose.seismicLoopGain).toBeGreaterThan(0);
    expect(snapBeforeDispose.seismicModulationHz).toBeCloseTo(3.5, 6);

    // Идемпотентный двойной dispose и блокировка мутаций после закрытия
    headlessEngine.dispose();
    headlessEngine.dispose();
    expect(headlessEngine.isDisposed()).toBe(true);
    expect(headlessEngine.getActiveVoiceCount()).toBe(0);

    headlessEngine.setTimeScale(1.8);
    headlessEngine.setMuted(true);
    headlessEngine.consumeEvents(allSevenEvents, makeTelemetry({ simTimeSec: 0.5 }));
    expect(headlessEngine.getTimeScale()).toBeCloseTo(0.35, 6);
    expect(headlessEngine.isMuted()).toBe(false);
    expect(headlessEngine.getActiveVoiceCount()).toBe(0);

    // Проверка защиты от unhandledrejection при блокировке автовоспроизведения в браузере
    const blockedCtx = new DiagnosticWebAudioContext({
      initialState: 'suspended',
      rejectResume: true,
    });
    const blockedEngine = new DestructionSoundEngine({
      audioContextFactory: () => blockedCtx,
      autoUnlockOnInteraction: false,
    });
    blockedEngine.unlock();
    await Promise.resolve();
    expect(blockedCtx.resumeCount).toBe(1);
    blockedEngine.dispose();
  });

  it('2. Инициализирует мастер-тракт с лимитером, проверяет спектр 3 буферов шума (white > pink > brown), детерминизм seed и setMuted()', () => {
    const ctx = new DiagnosticWebAudioContext({ initialState: 'suspended' });
    const engine = new DestructionSoundEngine({
      audioContextFactory: () => ctx,
      seed: 0x778899aa,
      masterVolume: 0.8,
      autoUnlockOnInteraction: false,
    });

    expect(ctx.state).toBe('suspended');
    engine.unlock();
    expect(ctx.state).toBe('running');
    expect(ctx.resumeCount).toBe(1);

    // Проверка мастер-тракта: MixBus -> HPF(22 Гц) -> WorldLPF(19500 Гц) -> WaveShaper -> Compressor -> MasterGain -> destination
    expect(ctx.gains.length).toBe(2);
    const mixBus = ctx.gains[0]!;
    const masterGain = ctx.gains[1]!;
    expect(ctx.hasActivePathToDestination(mixBus)).toBe(true);
    expect(masterGain.gain.value).toBeCloseTo(0.8, 6);

    const hpf = ctx.filters.find((f) => f.type === 'highpass');
    const lpf = ctx.filters.find((f) => f.type === 'lowpass');
    expect(hpf).toBeDefined();
    expect(lpf).toBeDefined();
    expect(hpf!.frequency.value).toBeCloseTo(22, 5);
    expect(lpf!.frequency.value).toBeCloseTo(19500, 5);

    expect(ctx.waveShapers.length).toBe(1);
    const shaper = ctx.waveShapers[0]!;
    expect(shaper.oversample).toBe('2x');
    expect(shaper.curve).not.toBeNull();
    expect(shaper.curve!.length).toBe(1025);
    expect(shaper.curve![0]!).toBeCloseTo(-1, 5);
    expect(shaper.curve![512]!).toBeCloseTo(0, 6);
    expect(shaper.curve![1024]!).toBeCloseTo(1, 5);

    expect(ctx.compressors.length).toBe(1);
    const limiter = ctx.compressors[0]!;
    expect(limiter.threshold.value).toBeLessThanOrEqual(-6);
    expect(limiter.ratio.value).toBeGreaterThanOrEqual(8);

    // Проверка 3 предгенерированных буферов шума (белый, розовый, коричневый)
    expect(ctx.buffers.length).toBe(3);
    const [whiteBuf, pinkBuf, brownBuf] = ctx.buffers;
    for (const buf of [whiteBuf!, pinkBuf!, brownBuf!]) {
      expect(buf.length).toBe(88200);
      const data = buf.getChannelData(0);
      let allFinite = true;
      let minVal = Number.POSITIVE_INFINITY;
      let maxVal = Number.NEGATIVE_INFINITY;
      let mean = 0;
      let peak = 0;
      for (let i = 0; i < data.length; i++) {
        const s = data[i]!;
        if (!Number.isFinite(s)) {
          allFinite = false;
        }
        if (s < minVal) minVal = s;
        if (s > maxVal) maxVal = s;
        mean += s;
        const absS = Math.abs(s);
        if (absS > peak) {
          peak = absS;
        }
      }
      expect(allFinite).toBe(true);
      expect(minVal).toBeGreaterThanOrEqual(-1);
      expect(maxVal).toBeLessThanOrEqual(1);
      expect(Math.abs(mean / data.length)).toBeLessThan(0.01);
      expect(peak).toBeCloseTo(0.92, 2);
    }

    const whiteDiffE = computeMeanSquaredFirstDifference(whiteBuf!.getChannelData(0));
    const pinkDiffE = computeMeanSquaredFirstDifference(pinkBuf!.getChannelData(0));
    const brownDiffE = computeMeanSquaredFirstDifference(brownBuf!.getChannelData(0));

    // Строгое спектральное неравенство ВЧ-энергии первых разностей: white > pink > brown
    expect(whiteDiffE).toBeGreaterThan(pinkDiffE * 3);
    expect(pinkDiffE).toBeGreaterThan(brownDiffE * 4);
    expect(brownDiffE).toBeGreaterThan(0.0005);

    // Побитовый детерминизм буферов при одинаковом seed и отличие при другом seed
    const ctxSameSeed = new DiagnosticWebAudioContext({ initialState: 'running' });
    const engineSameSeed = new DestructionSoundEngine({
      audioContextFactory: () => ctxSameSeed,
      seed: 0x778899aa,
    });
    engineSameSeed.unlock();
    expect(Array.from(ctxSameSeed.buffers[1]!.getChannelData(0).subarray(0, 64))).toEqual(
      Array.from(pinkBuf!.getChannelData(0).subarray(0, 64)),
    );

    const ctxOtherSeed = new DiagnosticWebAudioContext({ initialState: 'running' });
    const engineOtherSeed = new DestructionSoundEngine({
      audioContextFactory: () => ctxOtherSeed,
      seed: 0x11223344,
    });
    engineOtherSeed.unlock();
    expect(Array.from(ctxOtherSeed.buffers[1]!.getChannelData(0).subarray(0, 64))).not.toEqual(
      Array.from(pinkBuf!.getChannelData(0).subarray(0, 64)),
    );

    // Проверка setMuted(true) и setMuted(false)
    engine.setMuted(true);
    expect(engine.isMuted()).toBe(true);
    ctx.advanceTime(0.2);
    expect(masterGain.gain.valueAt(ctx.currentTime)).toBeLessThan(0.001);

    const oscBeforeMutedEvent = ctx.oscillators.length;
    engine.consumeEvents(
      [{ type: 'rebar_snap', position: [0, 1, 0], forceN: 120_000 }],
      makeTelemetry({ simTimeSec: 0.2 }),
    );
    expect(ctx.oscillators.length).toBe(oscBeforeMutedEvent);
    expect(engine.getActiveVoiceCount()).toBe(0);

    expect(engine.toggleMute()).toBe(false);
    ctx.advanceTime(0.2);
    expect(masterGain.gain.valueAt(ctx.currentTime)).toBeCloseTo(0.8, 2);

    engine.consumeEvents(
      [{ type: 'rebar_snap', position: [0, 1, 0], forceN: 120_000 }],
      makeTelemetry({ simTimeSec: 0.4 }),
    );
    expect(ctx.oscillators.length).toBeGreaterThan(oscBeforeMutedEvent);
    expect(engine.getActiveVoiceCount()).toBe(1);

    engineSameSeed.dispose();
    engineOtherSeed.dispose();
    engine.dispose();
  });

  it('3. Соблюдает строгую монотонность Bullet-Time (setTimeScale 0.05..2.0) и инвариантен к порядку вызова относительно unlock()', () => {
    const ctx = new DiagnosticWebAudioContext({ initialState: 'running' });
    const engine = new DestructionSoundEngine({
      audioContextFactory: () => ctx,
      seed: 2026,
    });
    engine.unlock();

    const worldLowpass = ctx.filters.find((f) => f.type === 'lowpass')!;

    engine.setTimeScale(0.05);
    const lp005 = worldLowpass.frequency.valueAt(ctx.currentTime);
    engine.setTimeScale(0.25);
    const lp025 = worldLowpass.frequency.valueAt(ctx.currentTime);
    engine.setTimeScale(0.5);
    const lp050 = worldLowpass.frequency.valueAt(ctx.currentTime);
    engine.setTimeScale(1.0);
    const lp100 = worldLowpass.frequency.valueAt(ctx.currentTime);
    engine.setTimeScale(2.0);
    const lp200 = worldLowpass.frequency.valueAt(ctx.currentTime);

    expect(lp005).toBeGreaterThan(350);
    expect(lp005).toBeLessThan(lp025);
    expect(lp025).toBeLessThan(lp050);
    expect(lp050).toBeLessThan(lp100);
    expect(lp100).toBeCloseTo(19500, 5);
    expect(lp200).toBeCloseTo(19500, 5);

    // Сравнение синтеза одинакового события при timeScale = 1.0 vs timeScale = 0.2
    const testEvent: SimulationEvent = {
      type: 'rebar_snap',
      position: [0, 3, 0],
      forceN: 150_000,
    };

    const ctxNormal = new DiagnosticWebAudioContext({ initialState: 'running' });
    const engNormal = new DestructionSoundEngine({
      audioContextFactory: () => ctxNormal,
      seed: 555,
    });
    engNormal.unlock();
    engNormal.setTimeScale(1.0);
    engNormal.consumeEvents([testEvent], makeTelemetry());

    const ctxSlow = new DiagnosticWebAudioContext({ initialState: 'running' });
    const engSlow = new DestructionSoundEngine({
      audioContextFactory: () => ctxSlow,
      seed: 555,
    });
    // Вызываем setTimeScale(0.2) ДО unlock(), чтобы заодно проверить инвариантность порядка!
    engSlow.setTimeScale(0.2);
    engSlow.unlock();

    const ctxSlowAfter = new DiagnosticWebAudioContext({ initialState: 'running' });
    const engSlowAfter = new DestructionSoundEngine({
      audioContextFactory: () => ctxSlowAfter,
      seed: 555,
    });
    engSlowAfter.unlock();
    engSlowAfter.setTimeScale(0.2);

    const slowLpBefore = ctxSlow.filters.find((f) => f.type === 'lowpass')!;
    const slowLpAfter = ctxSlowAfter.filters.find((f) => f.type === 'lowpass')!;
    expect(slowLpBefore.frequency.valueAt(0)).toBeCloseTo(slowLpAfter.frequency.valueAt(0), 6);
    expect(slowLpBefore.Q.valueAt(0)).toBeCloseTo(slowLpAfter.Q.valueAt(0), 6);
    expect(engSlow.getAcousticSnapshot()).toEqual(engSlowAfter.getAcousticSnapshot());

    engSlow.consumeEvents([testEvent], makeTelemetry());

    const mainOscNormal = ctxNormal.oscillators[0]!;
    const mainOscSlow = ctxSlow.oscillators[0]!;
    expect(mainOscSlow.frequency.firstScheduledValue()).toBeLessThan(
      mainOscNormal.frequency.firstScheduledValue(),
    );
    const durNormal = mainOscNormal.stopTime! - mainOscNormal.startTime!;
    const durSlow = mainOscSlow.stopTime! - mainOscSlow.startTime!;
    expect(durSlow).toBeGreaterThan(durNormal * 1.8);

    engine.dispose();
    engNormal.dispose();
    engSlow.dispose();
    engSlowAfter.dispose();
  });

  it('4. Синтезирует различимую акустическую сигнатуру калёного стекла (моды 2.4–7.5 кГц) и щепления дерева (каскад 420–2150 Гц)', () => {
    // 4A. Калёное стекло
    const ctxGlass = new DiagnosticWebAudioContext({ initialState: 'running' });
    const engGlass = new DestructionSoundEngine({
      audioContextFactory: () => ctxGlass,
      seed: 701,
    });
    engGlass.unlock();
    const baseFiltersCount = ctxGlass.filters.length;

    engGlass.consumeEvents(
      [
        {
          type: 'fracture',
          position: [0, 4, 0],
          materialId: 'glass',
          energyJ: 1400,
          shardCount: 18,
        },
      ],
      makeTelemetry(),
    );

    expect(ctxGlass.oscillators.length).toBeGreaterThanOrEqual(4);
    for (let i = 0; i < ctxGlass.oscillators.length; i++) {
      const osc = ctxGlass.oscillators[i]!;
      const hz = osc.frequency.firstScheduledValue();
      expect(hz).toBeGreaterThanOrEqual(2400);
      expect(hz).toBeLessThanOrEqual(7500);
      if (i > 0) {
        expect(osc.startTime!).toBeGreaterThan(ctxGlass.oscillators[i - 1]!.startTime!);
      }
    }
    const glassFilters = ctxGlass.filters.slice(baseFiltersCount);
    expect(glassFilters.some((f) => f.frequency.value >= 2500)).toBe(true);

    // 4B. Конструкционный деревянный брус
    const ctxWood = new DiagnosticWebAudioContext({ initialState: 'running' });
    const engWood = new DestructionSoundEngine({
      audioContextFactory: () => ctxWood,
      seed: 702,
    });
    engWood.unlock();
    const woodBaseFilterCount = ctxWood.filters.length;

    engWood.consumeEvents(
      [
        {
          type: 'fracture',
          position: [1, 2, 0],
          materialId: 'wood',
          energyJ: 1100,
          shardCount: 10,
        },
      ],
      makeTelemetry(),
    );

    const woodBandFilters = ctxWood.filters
      .slice(woodBaseFilterCount)
      .filter((f) => f.type === 'bandpass');
    expect(woodBandFilters.length).toBeGreaterThanOrEqual(3);
    for (const bp of woodBandFilters) {
      expect(bp.frequency.value).toBeGreaterThanOrEqual(400);
      expect(bp.frequency.value).toBeLessThanOrEqual(2200);
    }

    expect(ctxWood.bufferSources.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < ctxWood.bufferSources.length; i++) {
      expect(ctxWood.bufferSources[i]!.startTime!).toBeGreaterThan(
        ctxWood.bufferSources[i - 1]!.startTime!,
      );
    }
    // Наличие низкочастотного корпусного удара бруса
    expect(ctxWood.oscillators.length).toBe(1);
    expect(ctxWood.oscillators[0]!.frequency.lastScheduledValue()).toBeLessThan(100);

    engGlass.dispose();
    engWood.dispose();
  });

  it('5. Масштабирует питч-бенд и звон разрыва арматуры (rebar_snap) по forceN и резонансный скрежет стали (steel_yield) по angleRad', () => {
    // 5A. Разрыв арматуры: 10 кН vs 300 кН
    const ctxLowRebar = new DiagnosticWebAudioContext({ initialState: 'running' });
    const engLowRebar = new DestructionSoundEngine({
      audioContextFactory: () => ctxLowRebar,
      seed: 801,
    });
    engLowRebar.unlock();
    engLowRebar.consumeEvents(
      [{ type: 'rebar_snap', position: [0, 1, 0], forceN: 10_000 }],
      makeTelemetry(),
    );

    const ctxHighRebar = new DiagnosticWebAudioContext({ initialState: 'running' });
    const engHighRebar = new DestructionSoundEngine({
      audioContextFactory: () => ctxHighRebar,
      seed: 801,
    });
    engHighRebar.unlock();
    engHighRebar.consumeEvents(
      [{ type: 'rebar_snap', position: [0, 1, 0], forceN: 300_000 }],
      makeTelemetry(),
    );

    const oscLow = ctxLowRebar.oscillators[0]!;
    const oscHigh = ctxHighRebar.oscillators[0]!;
    // Нисходящий питч-бенд упругой отдачи стержня
    expect(oscLow.frequency.lastScheduledValue()).toBeLessThan(
      oscLow.frequency.firstScheduledValue(),
    );
    expect(oscHigh.frequency.lastScheduledValue()).toBeLessThan(
      oscHigh.frequency.firstScheduledValue(),
    );
    // Строгая монотонность по силе разрыва forceN
    expect(oscHigh.frequency.firstScheduledValue()).toBeGreaterThan(
      oscLow.frequency.firstScheduledValue(),
    );
    const maxVoiceGainLow = Math.max(
      ...ctxLowRebar.gains.slice(3).map((g) => g.gain.peakScheduledValue()),
    );
    const maxVoiceGainHigh = Math.max(
      ...ctxHighRebar.gains.slice(3).map((g) => g.gain.peakScheduledValue()),
    );
    expect(maxVoiceGainHigh).toBeGreaterThan(maxVoiceGainLow);

    // 5B. Пластическая деформация стали: 0.02 рад vs 0.35 рад
    const ctxMildSteel = new DiagnosticWebAudioContext({ initialState: 'running' });
    const engMildSteel = new DestructionSoundEngine({
      audioContextFactory: () => ctxMildSteel,
      seed: 802,
    });
    engMildSteel.unlock();
    engMildSteel.consumeEvents(
      [{ type: 'steel_yield', position: [0, 3, 0], angleRad: 0.02 }],
      makeTelemetry(),
    );

    const ctxDeepSteel = new DiagnosticWebAudioContext({ initialState: 'running' });
    const engDeepSteel = new DestructionSoundEngine({
      audioContextFactory: () => ctxDeepSteel,
      seed: 802,
    });
    engDeepSteel.unlock();
    engDeepSteel.consumeEvents(
      [{ type: 'steel_yield', position: [0, 3, 0], angleRad: 0.35 }],
      makeTelemetry(),
    );

    expect(ctxDeepSteel.oscillators.length).toBe(2);
    expect(ctxDeepSteel.oscillators[0]!.detune.value).toBeLessThan(0);
    expect(ctxDeepSteel.oscillators[1]!.detune.value).toBeGreaterThan(0);

    const bpMild = ctxMildSteel.filters.find((f) => f.type === 'bandpass')!;
    const bpDeep = ctxDeepSteel.filters.find((f) => f.type === 'bandpass')!;
    expect(bpMild.Q.value).toBeGreaterThanOrEqual(5.5);
    expect(bpDeep.Q.value).toBeGreaterThan(bpMild.Q.value);
    expect(bpDeep.frequency.firstScheduledValue()).toBeGreaterThan(
      bpMild.frequency.firstScheduledValue(),
    );
    expect(ctxDeepSteel.gains[3]!.gain.peakScheduledValue()).toBeGreaterThan(
      ctxMildSteel.gains[3]!.gain.peakScheduledValue(),
    );

    engLowRebar.dispose();
    engHighRebar.dispose();
    engMildSteel.dispose();
    engDeepSteel.dispose();
  });

  it('6. Физически масштабирует суббас (35–110 Гц), пиковый гейн и длину хвоста обвала по массе, импульсу и энергии для всех тяжёлых материалов', () => {
    const ctxSmall = new DiagnosticWebAudioContext({ initialState: 'running' });
    const engSmall = new DestructionSoundEngine({
      audioContextFactory: () => ctxSmall,
      seed: 901,
    });
    engSmall.unlock();
    engSmall.consumeEvents(
      [
        {
          type: 'secondary_impact',
          position: [0, 0.2, 0],
          materialId: 'reinforced_concrete',
          impulseNs: 100,
          massKg: 10,
          targetTag: 'target',
        },
      ],
      makeTelemetry(),
    );

    const ctxFloorCollapse = new DiagnosticWebAudioContext({ initialState: 'running' });
    const engFloorCollapse = new DestructionSoundEngine({
      audioContextFactory: () => ctxFloorCollapse,
      seed: 901,
    });
    engFloorCollapse.unlock();
    engFloorCollapse.consumeEvents(
      [
        {
          type: 'secondary_impact',
          position: [0, 0.5, 0],
          materialId: 'reinforced_concrete',
          impulseNs: 400_000,
          massKg: 40_000,
          targetTag: 'target',
        },
      ],
      makeTelemetry(),
    );

    const subSmall = ctxSmall.oscillators[0]!;
    const subHeavy = ctxFloorCollapse.oscillators[0]!;

    // Оба суббаса лежат в полосе 35..110 Гц, но у 40-тонного этажа частота строго ниже!
    expect(subSmall.frequency.firstScheduledValue()).toBeLessThanOrEqual(110);
    expect(subSmall.frequency.lastScheduledValue()).toBeGreaterThanOrEqual(35);
    expect(subHeavy.frequency.firstScheduledValue()).toBeLessThan(
      subSmall.frequency.firstScheduledValue(),
    );
    expect(subHeavy.frequency.lastScheduledValue()).toBeLessThan(
      subSmall.frequency.lastScheduledValue(),
    );
    expect(subHeavy.frequency.lastScheduledValue()).toBeGreaterThanOrEqual(35);

    // Длительность раската и пиковый гейн строго больше у 40-тонного этажа
    const rumbleSmall = ctxSmall.bufferSources[0]!;
    const rumbleHeavy = ctxFloorCollapse.bufferSources[0]!;
    expect(rumbleHeavy.stopTime! - rumbleHeavy.startTime!).toBeGreaterThan(
      (rumbleSmall.stopTime! - rumbleSmall.startTime!) * 1.8,
    );

    const peakSmall = Math.max(...ctxSmall.gains.slice(3).map((g) => g.gain.peakScheduledValue()));
    const peakHeavy = Math.max(
      ...ctxFloorCollapse.gains.slice(3).map((g) => g.gain.peakScheduledValue()),
    );
    expect(peakHeavy).toBeGreaterThan(peakSmall * 1.6);

    // Проверка всех остальных материалов из STRUCTURAL_MATERIAL_IDS (включая звон двутавра steel и бочки explosive)
    for (const matId of STRUCTURAL_MATERIAL_IDS) {
      const ctxMat = new DiagnosticWebAudioContext({ initialState: 'running' });
      const engMat = new DestructionSoundEngine({
        audioContextFactory: () => ctxMat,
        seed: 905,
      });
      engMat.unlock();
      engMat.consumeEvents(
        [{ type: 'fracture', position: [0, 2, 0], materialId: matId, energyJ: 25_000, shardCount: 8 }],
        makeTelemetry(),
      );
      expect(engMat.getActiveVoiceCount()).toBe(1);
      if (matId === 'steel') {
        expect(ctxMat.oscillators.some((o) => Math.abs(o.frequency.firstScheduledValue() - 440) < 1)).toBe(true);
      }
      engMat.dispose();
    }

    engSmall.dispose();
    engFloorCollapse.dispose();
  });

  it('7. Синтезирует 4-слойную ударную волну взрыва (суббас 28–80 Гц + DelayNode) с усилением эхо-хвоста при isChainDetonation', () => {
    const ctxSmallBlast = new DiagnosticWebAudioContext({ initialState: 'running' });
    const engSmallBlast = new DestructionSoundEngine({
      audioContextFactory: () => ctxSmallBlast,
      seed: 1001,
    });
    engSmallBlast.unlock();
    engSmallBlast.consumeEvents(
      [
        {
          type: 'explosion',
          position: [0, 1, 0],
          radiusM: 4,
          equivalentKgTnt: 1,
          isChainDetonation: false,
        },
      ],
      makeTelemetry(),
    );

    const ctxHugeBlast = new DiagnosticWebAudioContext({ initialState: 'running' });
    const engHugeBlast = new DestructionSoundEngine({
      audioContextFactory: () => ctxHugeBlast,
      seed: 1001,
    });
    engHugeBlast.unlock();
    engHugeBlast.consumeEvents(
      [
        {
          type: 'explosion',
          position: [0, 1, 0],
          radiusM: 25,
          equivalentKgTnt: 500,
          isChainDetonation: false,
        },
      ],
      makeTelemetry(),
    );

    const subSmall = ctxSmallBlast.oscillators[0]!;
    const subHuge = ctxHugeBlast.oscillators[0]!;
    expect(subSmall.frequency.firstScheduledValue()).toBeLessThanOrEqual(80);
    expect(subHuge.frequency.lastScheduledValue()).toBeGreaterThanOrEqual(28);
    expect(subHuge.stopTime! - subHuge.startTime!).toBeGreaterThan(
      (subSmall.stopTime! - subSmall.startTime!) * 1.4,
    );
    expect(ctxHugeBlast.delays.length).toBe(1);

    // Сравнение одиночного взрыва и цепной детонации (isChainDetonation: false vs true) при равном эквиваленте
    const ctxSingle = new DiagnosticWebAudioContext({ initialState: 'running' });
    const engSingle = new DestructionSoundEngine({
      audioContextFactory: () => ctxSingle,
      seed: 1002,
    });
    engSingle.unlock();
    engSingle.consumeEvents(
      [
        {
          type: 'explosion',
          position: [0, 2, 0],
          radiusM: 10,
          equivalentKgTnt: 25,
          isChainDetonation: false,
        },
      ],
      makeTelemetry(),
    );

    const ctxChain = new DiagnosticWebAudioContext({ initialState: 'running' });
    const engChain = new DestructionSoundEngine({
      audioContextFactory: () => ctxChain,
      seed: 1002,
    });
    engChain.unlock();
    engChain.consumeEvents(
      [
        {
          type: 'explosion',
          position: [0, 2, 0],
          radiusM: 10,
          equivalentKgTnt: 25,
          isChainDetonation: true,
        },
      ],
      makeTelemetry(),
    );

    // Последний GainNode голоса взрыва — echoGain после линии задержки DelayNode
    const echoGainSingle = ctxSingle.gains[ctxSingle.gains.length - 1]!;
    const echoGainChain = ctxChain.gains[ctxChain.gains.length - 1]!;
    expect(echoGainChain.gain.peakScheduledValue()).toBeGreaterThan(
      echoGainSingle.gain.peakScheduledValue() * 1.35,
    );
    const blastSrcSingle = ctxSingle.bufferSources[ctxSingle.bufferSources.length - 1]!;
    const blastSrcChain = ctxChain.bufferSources[ctxChain.bufferSources.length - 1]!;
    expect(blastSrcChain.stopTime!).toBeGreaterThan(blastSrcSingle.stopTime!);

    engSmallBlast.dispose();
    engHugeBlast.dispose();
    engSingle.dispose();
    engChain.dispose();
  });

  it('8. Управляет непрерывной петлёй пожара по burningNodeCount и maxTemperatureC без утечки узлов и гасит её строго в 0 при потухании', () => {
    const ctx = new DiagnosticWebAudioContext({ initialState: 'running' });
    const engine = new DestructionSoundEngine({
      audioContextFactory: () => ctx,
      seed: 1101,
    });
    engine.unlock();

    // При отсутствии горящих узлов петля молчит
    engine.consumeEvents([], makeTelemetry({ burningNodeCount: 0, maxTemperatureC: 20 }));
    expect(engine.getAcousticSnapshot().fireLoopGain).toBe(0);
    expect(ctx.bufferSources.filter((s) => s.loop).length).toBe(0);

    // Воспламенение + монотонный рост по числу горящих узлов (1 -> 10 -> 40)
    engine.consumeEvents(
      [{ type: 'fire_ignited', nodeId: 1, position: [0, 1, 0] }],
      makeTelemetry({ simTimeSec: 0.05, burningNodeCount: 1, maxTemperatureC: 300 }),
    );
    const snap1 = engine.getAcousticSnapshot();
    expect(snap1.fireLoopGain).toBeGreaterThan(0);

    ctx.advanceTime(0.05);
    engine.consumeEvents(
      [],
      makeTelemetry({ simTimeSec: 0.1, burningNodeCount: 10, maxTemperatureC: 300 }),
    );
    const snap10 = engine.getAcousticSnapshot();

    ctx.advanceTime(0.05);
    engine.consumeEvents(
      [],
      makeTelemetry({ simTimeSec: 0.15, burningNodeCount: 40, maxTemperatureC: 300 }),
    );
    const snap40 = engine.getAcousticSnapshot();

    expect(snap10.fireLoopGain).toBeGreaterThan(snap1.fireLoopGain);
    expect(snap40.fireLoopGain).toBeGreaterThan(snap10.fireLoopGain);

    // Рост температуры с 300 °C до 900 °C повышает частоту фильтра жара и интенсивность петли
    ctx.advanceTime(0.05);
    engine.consumeEvents(
      [],
      makeTelemetry({ simTimeSec: 0.2, burningNodeCount: 10, maxTemperatureC: 900 }),
    );
    const snapHot = engine.getAcousticSnapshot();
    expect(snapHot.fireCenterHz).toBeGreaterThan(snap10.fireCenterHz + 300);
    expect(snapHot.fireLoopGain).toBeGreaterThan(snap10.fireLoopGain);

    // Прогон 60 кадров горения не должен порождать новые зацикленные источники петли (ровно 2: тяга + шипение)
    for (let frame = 0; frame < 60; frame++) {
      ctx.advanceTime(1 / 60);
      engine.consumeEvents(
        [],
        makeTelemetry({
          simTimeSec: 0.2 + (frame + 1) / 60,
          burningNodeCount: 12,
          maxTemperatureC: 750,
        }),
      );
    }
    expect(ctx.bufferSources.filter((s) => s.loop).length).toBe(2);

    // Потухание пожара переводит гейн петли строго в 0
    ctx.advanceTime(0.05);
    engine.consumeEvents(
      [],
      makeTelemetry({ simTimeSec: 1.5, burningNodeCount: 0, maxTemperatureC: 65 }),
    );
    expect(engine.getAcousticSnapshot().fireLoopGain).toBe(0);

    // fireMasterGain — третий созданный GainNode после mixBus, masterGain и голоса fire_ignited
    const loopedSources = ctx.bufferSources.filter((s) => s.loop);
    expect(loopedSources.length).toBe(2);
    const fireMasterEdge = ctx.nodeEdges.find(
      (e) => e.to === ctx.gains[0] && e.from !== ctx.gains[1] && e.active,
    );
    expect(fireMasterEdge).toBeDefined();
    const fireMasterGain = ctx.gains.find((g) => g.id === fireMasterEdge!.from.id)!;
    expect(fireMasterGain.gain.valueAt(ctx.currentTime)).toBe(0);

    engine.dispose();
  });

  it('9. Модулирует петлю сейсмоплатформы реальным LFO-осциллятором точно на частоте clamp(seismicFrequencyHz, 0.5, 15.0) Гц и масштабирует по амплитуде', () => {
    const ctx = new DiagnosticWebAudioContext({ initialState: 'running' });
    const engine = new DestructionSoundEngine({
      audioContextFactory: () => ctx,
      seed: 1201,
    });
    engine.unlock();

    // Включение землетрясения 1.8 Гц, амплитуда 0.1 м
    engine.consumeEvents(
      [],
      makeTelemetry({
        seismicActive: true,
        seismicFrequencyHz: 1.8,
        seismicAmplitudeM: 0.1,
      }),
    );

    // Должна быть создана честная связь модуляции AudioParam (lfoDepthGain -> modGain.gain)
    expect(ctx.paramEdges.length).toBe(1);
    expect(ctx.oscillators.length).toBe(2);
    const lfoOsc = ctx.oscillators[0]!;
    expect(lfoOsc.frequency.valueAt(ctx.currentTime)).toBeCloseTo(1.8, 6);
    const gainAmp01 = engine.getAcousticSnapshot().seismicLoopGain;
    expect(gainAmp01).toBeGreaterThan(0);

    // Повышение частоты до 6.5 Гц и амплитуды до 2.0 м
    ctx.advanceTime(0.1);
    engine.consumeEvents(
      [{ type: 'seismic_pulse', frequencyHz: 6.5, amplitudeM: 2.0, groundAccelMpS2: 18 }],
      makeTelemetry({
        simTimeSec: 0.1,
        seismicActive: true,
        seismicFrequencyHz: 6.5,
        seismicAmplitudeM: 2.0,
      }),
    );
    expect(lfoOsc.frequency.valueAt(ctx.currentTime)).toBeCloseTo(6.5, 6);
    const gainAmp20 = engine.getAcousticSnapshot().seismicLoopGain;
    expect(gainAmp20).toBeGreaterThan(gainAmp01 * 2.2);

    // Проверка зажима границ диапазона [0.5, 15.0] Гц
    ctx.advanceTime(0.1);
    engine.consumeEvents(
      [],
      makeTelemetry({
        simTimeSec: 0.2,
        seismicActive: true,
        seismicFrequencyHz: 0.05,
        seismicAmplitudeM: 1.0,
      }),
    );
    expect(lfoOsc.frequency.valueAt(ctx.currentTime)).toBeCloseTo(0.5, 6);

    ctx.advanceTime(0.1);
    engine.consumeEvents(
      [],
      makeTelemetry({
        simTimeSec: 0.3,
        seismicActive: true,
        seismicFrequencyHz: 45.0,
        seismicAmplitudeM: 1.0,
      }),
    );
    expect(lfoOsc.frequency.valueAt(ctx.currentTime)).toBeCloseTo(15.0, 6);

    // Остановка землетрясения переводит гейн петли строго в 0
    ctx.advanceTime(0.1);
    engine.consumeEvents(
      [],
      makeTelemetry({
        simTimeSec: 0.4,
        seismicActive: false,
        seismicFrequencyHz: 4.0,
        seismicAmplitudeM: 1.0,
      }),
    );
    expect(engine.getAcousticSnapshot().seismicLoopGain).toBe(0);
    // masterGain петли сейсмики (первый созданный GainNode после mixBus и masterGain)
    const seismicMasterGain = ctx.gains[2]!;
    expect(seismicMasterGain.gain.valueAt(ctx.currentTime)).toBe(0);

    engine.dispose();
  });

  it('10. Выдерживает шторм из 500 событий за тик при maxPolyphony = 20, вытесняет мелкие осколки в пользу взрывов и очищает пул по времени', () => {
    const ctx = new DiagnosticWebAudioContext({ initialState: 'running' });
    const engine = new DestructionSoundEngine({
      audioContextFactory: () => ctx,
      maxPolyphony: 20,
      seed: 1301,
    });
    engine.unlock();

    // Сначала забиваем все 20 слотов полифонии мелкими расколами стекла (по одному на микрошаг)
    for (let i = 0; i < 20; i++) {
      ctx.advanceTime(0.002);
      engine.consumeEvents(
        [{ type: 'fracture', position: [0, 1, 0], materialId: 'glass', energyJ: 80, shardCount: 4 }],
        makeTelemetry({ simTimeSec: (i + 1) * 0.002 }),
      );
    }
    expect(engine.getActiveVoiceCount()).toBe(20);

    // Теперь подаём пакет из 500 смешанных событий за один тик (включая взрывы, арматуру, обвалы)
    const rng = new SeededRng(9999);
    const stormEvents: SimulationEvent[] = [];
    for (let i = 0; i < 500; i++) {
      const mod = i % 7;
      if (mod === 0) {
        stormEvents.push({
          type: 'fracture',
          position: [0, 2, 0],
          materialId: STRUCTURAL_MATERIAL_IDS[i % STRUCTURAL_MATERIAL_IDS.length]!,
          energyJ: rng.range(50, 20_000),
          shardCount: rng.int(3, 18),
        });
      } else if (mod === 1) {
        stormEvents.push({
          type: 'secondary_impact',
          position: [1, 0, 1],
          materialId: STRUCTURAL_MATERIAL_IDS[(i + 2) % STRUCTURAL_MATERIAL_IDS.length]!,
          impulseNs: rng.range(200, 150_000),
          massKg: rng.range(20, 12_000),
          targetTag: 'target',
        });
      } else if (mod === 2) {
        stormEvents.push({
          type: 'rebar_snap',
          position: [0, 3, 0],
          forceN: rng.range(5_000, 280_000),
        });
      } else if (mod === 3) {
        stormEvents.push({
          type: 'steel_yield',
          position: [0, 4, 0],
          angleRad: rng.range(0.03, 0.4),
        });
      } else if (mod === 4) {
        stormEvents.push({
          type: 'explosion',
          position: [0, 1, 0],
          radiusM: rng.range(5, 22),
          equivalentKgTnt: rng.range(5, 180),
          isChainDetonation: i % 14 === 0,
        });
      } else if (mod === 5) {
        stormEvents.push({
          type: 'fire_ignited',
          nodeId: i,
          position: [0, 2, 0],
        });
      } else {
        stormEvents.push({
          type: 'seismic_pulse',
          frequencyHz: rng.range(1, 10),
          amplitudeM: rng.range(0.1, 1.5),
          groundAccelMpS2: rng.range(2, 25),
        });
      }
    }

    const delaysBeforeStorm = ctx.delays.length;
    engine.consumeEvents(stormEvents, makeTelemetry({ simTimeSec: 0.1 }));

    // Строгий инвариант потолка голосов
    expect(engine.getActiveVoiceCount()).toBeLessThanOrEqual(20);
    expect(engine.getActiveVoiceCount()).toBe(20);
    // Взрывы гарантированно вытеснили низкоприоритетное стекло и создали линии эха DelayNode
    expect(ctx.delays.length - delaysBeforeStorm).toBe(3);

    // Спустя 6 секунд все одноразовые голоса полностью завершаются и очищаются из пула
    ctx.advanceTime(6.0);
    engine.consumeEvents([], makeTelemetry({ simTimeSec: 6.1 }));
    expect(engine.getActiveVoiceCount()).toBe(0);

    engine.dispose();
  });

  it('11. Демонстрирует состязательную устойчивость к NaN, ±Infinity и отрицательным числам без единого нарушения W3C AudioParam', () => {
    const ctx = new DiagnosticWebAudioContext({ initialState: 'running' });
    const engine = new DestructionSoundEngine({
      audioContextFactory: () => ctx,
      maxPolyphony: Number.NaN,
      masterVolume: Number.POSITIVE_INFINITY,
      seed: Number.NaN,
    });
    engine.unlock();

    engine.setTimeScale(Number.NaN);
    engine.setTimeScale(Number.NEGATIVE_INFINITY);
    engine.setTimeScale(Number.POSITIVE_INFINITY);
    engine.setTimeScale(-5);
    expect(engine.getTimeScale()).toBeCloseTo(0.05, 6);

    engine.setMasterVolume(Number.NaN);
    engine.setMasterVolume(-10);
    expect(engine.getMasterVolume()).toBe(0);
    engine.setMasterVolume(99);
    expect(engine.getMasterVolume()).toBe(1);

    const hostileEvents: SimulationEvent[] = [
      {
        type: 'fracture',
        position: [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY],
        materialId: 'glass',
        energyJ: Number.NaN,
        shardCount: -50,
      },
      {
        type: 'fracture',
        position: [0, 0, 0],
        materialId: 'wood',
        energyJ: Number.NEGATIVE_INFINITY,
        shardCount: Number.POSITIVE_INFINITY,
      },
      {
        type: 'rebar_snap',
        position: [0, 0, 0],
        forceN: Number.NaN,
      },
      {
        type: 'steel_yield',
        position: [0, 0, 0],
        angleRad: -999,
      },
      {
        type: 'secondary_impact',
        position: [0, 0, 0],
        materialId: 'brick',
        impulseNs: Number.POSITIVE_INFINITY,
        massKg: Number.NEGATIVE_INFINITY,
        targetTag: '',
      },
      {
        type: 'explosion',
        position: [0, 0, 0],
        radiusM: Number.NaN,
        equivalentKgTnt: -100,
        isChainDetonation: true,
      },
      {
        type: 'seismic_pulse',
        frequencyHz: Number.NaN,
        amplitudeM: -5,
        groundAccelMpS2: Number.POSITIVE_INFINITY,
      },
    ];

    const hostileTelemetry = makeTelemetry({
      simTimeSec: Number.NaN,
      burningNodeCount: Number.POSITIVE_INFINITY,
      maxTemperatureC: Number.NaN,
      seismicActive: true,
      seismicFrequencyHz: Number.NEGATIVE_INFINITY,
      seismicAmplitudeM: Number.POSITIVE_INFINITY,
    });

    expect(() => engine.consumeEvents(hostileEvents, hostileTelemetry)).not.toThrow();

    // Проверка каждого параметра каждого узла графа на отсутствие NaN и бесконечности
    const allParams = ctx.getAllParams();
    expect(allParams.length).toBeGreaterThan(15);
    for (const p of allParams) {
      expect(Number.isFinite(p.value)).toBe(true);
      expect(Number.isFinite(p.valueAt(0))).toBe(true);
      expect(Number.isFinite(p.valueAt(0.5))).toBe(true);
    }

    engine.dispose();
  });

  it('12. Полностью останавливает и отключает все петли, голоса и мастер-тракт при dispose(), а валидатор W3C строго ловит ошибки AudioParam', () => {
    // Контрольная проверка честности валидатора DiagnosticAudioParam
    const strictParam = new DiagnosticAudioParam(999, 'testParam', 1.0);
    expect(() => strictParam.exponentialRampToValueAtTime(0, 0.5)).toThrow(RangeError);
    expect(() => strictParam.exponentialRampToValueAtTime(-0.1, 0.5)).toThrow(RangeError);
    expect(() => strictParam.setTargetAtTime(0, 0.1, 0)).toThrow(RangeError);

    const ctx = new DiagnosticWebAudioContext({ initialState: 'running' });
    const engine = new DestructionSoundEngine({
      audioContextFactory: () => ctx,
      seed: 1501,
    });
    engine.unlock();

    const mixBus = ctx.gains[0]!;
    expect(ctx.hasActivePathToDestination(mixBus)).toBe(true);

    engine.consumeEvents(
      [
        {
          type: 'explosion',
          position: [0, 1, 0],
          radiusM: 12,
          equivalentKgTnt: 35,
          isChainDetonation: true,
        },
        { type: 'fracture', position: [0, 2, 0], materialId: 'glass', energyJ: 800, shardCount: 9 },
      ],
      makeTelemetry({
        burningNodeCount: 8,
        maxTemperatureC: 720,
        seismicActive: true,
        seismicFrequencyHz: 3.2,
        seismicAmplitudeM: 0.9,
      }),
    );

    expect(ctx.oscillators.length).toBeGreaterThanOrEqual(7);
    expect(ctx.bufferSources.length).toBeGreaterThanOrEqual(5);

    ctx.advanceTime(0.05);
    engine.dispose();

    expect(ctx.state).toBe('closed');
    expect(ctx.closeCount).toBe(1);
    expect(ctx.hasActivePathToDestination(mixBus)).toBe(false);
    expect(engine.getActiveVoiceCount()).toBe(0);

    for (const osc of ctx.oscillators) {
      expect(osc.started).toBe(true);
      expect(osc.stopped).toBe(true);
      expect(osc.disconnectCount).toBeGreaterThanOrEqual(1);
    }
    for (const src of ctx.bufferSources) {
      expect(src.started).toBe(true);
      expect(src.stopped).toBe(true);
      expect(src.disconnectCount).toBeGreaterThanOrEqual(1);
    }
  });
});
