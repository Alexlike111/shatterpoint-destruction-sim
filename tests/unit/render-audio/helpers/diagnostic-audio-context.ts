import type {
  AudioBufferLike,
  AudioBufferSourceNodeLike,
  AudioContextLike,
  AudioNodeLike,
  AudioParamLike,
  BiquadFilterNodeLike,
  DelayNodeLike,
  DynamicsCompressorNodeLike,
  GainNodeLike,
  OscillatorNodeLike,
  WaveShaperNodeLike,
} from '../../../../src/audio/DestructionSoundEngine';

/**
 * Строгий детерминированный диагностический граф W3C Web Audio API для безмоковых модульных тестов.
 * Валидирует математические ограничения спецификации W3C (запрет <= 0 в экспоненциальных рампах,
 * запрет timeConstant <= 0, запрет stop < start и повторного start) и аналитически вычисляет
 * траектории параметров valueAt(timeSec).
 */

export type AudioAutomationEvent =
  | { readonly kind: 'setValue'; readonly value: number; readonly time: number }
  | { readonly kind: 'linearRamp'; readonly value: number; readonly time: number }
  | { readonly kind: 'exponentialRamp'; readonly value: number; readonly time: number }
  | {
      readonly kind: 'setTarget';
      readonly value: number;
      readonly time: number;
      readonly timeConstant: number;
    };

export type DiagnosticNodeKind =
  | 'destination'
  | 'gain'
  | 'oscillator'
  | 'biquadFilter'
  | 'dynamicsCompressor'
  | 'waveShaper'
  | 'delay'
  | 'bufferSource';

export interface DiagnosticNodeEdge {
  readonly from: DiagnosticAudioNodeBase;
  readonly to: AudioNodeLike;
  active: boolean;
}

export interface DiagnosticParamEdge {
  readonly from: DiagnosticAudioNodeBase;
  readonly toParam: AudioParamLike;
  active: boolean;
}

function assertFiniteNumber(value: number, label: string): void {
  if (!Number.isFinite(value)) {
    throw new RangeError(`W3C Web Audio: параметр "${label}" должен быть конечным числом, получено ${String(value)}`);
  }
}

function assertNonNegativeTime(timeSec: number, label: string): void {
  assertFiniteNumber(timeSec, label);
  if (timeSec < 0) {
    throw new RangeError(`W3C Web Audio: время "${label}" не может быть отрицательным, получено ${timeSec}`);
  }
}

export class DiagnosticAudioParam implements AudioParamLike {
  public readonly ownerNodeId: number;
  public readonly name: string;
  private baseValue: number;
  private readonly initialDefaultValue: number;
  private eventsList: AudioAutomationEvent[] = [];

  constructor(ownerNodeId: number, name: string, initialValue: number) {
    assertFiniteNumber(initialValue, `${name}.initialValue`);
    this.ownerNodeId = ownerNodeId;
    this.name = name;
    this.baseValue = initialValue;
    this.initialDefaultValue = initialValue;
  }

  public get value(): number {
    return this.baseValue;
  }

  public set value(next: number) {
    assertFiniteNumber(next, `${this.name}.value`);
    this.baseValue = next;
  }

  public getEvents(): readonly AudioAutomationEvent[] {
    return this.eventsList;
  }

  public setValueAtTime(value: number, startTime: number): this {
    assertFiniteNumber(value, `${this.name}.setValueAtTime.value`);
    assertNonNegativeTime(startTime, `${this.name}.setValueAtTime.startTime`);
    this.insertEvent({ kind: 'setValue', value, time: startTime });
    return this;
  }

  public linearRampToValueAtTime(value: number, endTime: number): this {
    assertFiniteNumber(value, `${this.name}.linearRampToValueAtTime.value`);
    assertNonNegativeTime(endTime, `${this.name}.linearRampToValueAtTime.endTime`);
    this.insertEvent({ kind: 'linearRamp', value, time: endTime });
    return this;
  }

  public exponentialRampToValueAtTime(value: number, endTime: number): this {
    assertFiniteNumber(value, `${this.name}.exponentialRampToValueAtTime.value`);
    assertNonNegativeTime(endTime, `${this.name}.exponentialRampToValueAtTime.endTime`);
    if (value <= 0) {
      throw new RangeError(
        `W3C Web Audio: exponentialRampToValueAtTime для "${this.name}" требует строго положительное значение (> 0), получено ${value}`,
      );
    }
    this.insertEvent({ kind: 'exponentialRamp', value, time: endTime });
    return this;
  }

  public setTargetAtTime(target: number, startTime: number, timeConstant: number): this {
    assertFiniteNumber(target, `${this.name}.setTargetAtTime.target`);
    assertNonNegativeTime(startTime, `${this.name}.setTargetAtTime.startTime`);
    assertFiniteNumber(timeConstant, `${this.name}.setTargetAtTime.timeConstant`);
    if (timeConstant <= 0) {
      throw new RangeError(
        `W3C Web Audio: setTargetAtTime для "${this.name}" требует строго положительную постоянную времени (> 0), получено ${timeConstant}`,
      );
    }
    this.insertEvent({ kind: 'setTarget', value: target, time: startTime, timeConstant });
    return this;
  }

  public cancelScheduledValues(startTime: number): this {
    assertNonNegativeTime(startTime, `${this.name}.cancelScheduledValues.startTime`);
    if (this.eventsList.length === 0) {
      return this;
    }
    const snapshotValue = this.valueAt(startTime);
    const hadFutureEvents = this.eventsList.some((e) => e.time >= startTime);
    this.eventsList = this.eventsList.filter((e) => e.time < startTime);
    if (hadFutureEvents && this.eventsList.length > 0) {
      this.eventsList.push({ kind: 'setValue', value: snapshotValue, time: startTime });
    }
    return this;
  }

  /**
   * Аналитический расчёт мгновенного значения параметра в момент timeSec по кривым W3C Web Audio API.
   */
  public valueAt(timeSec: number): number {
    assertNonNegativeTime(timeSec, `${this.name}.valueAt.timeSec`);
    if (this.eventsList.length === 0) {
      return this.baseValue;
    }

    let currentVal = this.initialDefaultValue;
    let anchorTime = 0;

    for (let i = 0; i < this.eventsList.length; i++) {
      const ev = this.eventsList[i]!;
      const nextEv = i + 1 < this.eventsList.length ? this.eventsList[i + 1]! : undefined;

      if (i === 0 && timeSec < ev.time) {
        if (ev.kind === 'linearRamp') {
          const span = Math.max(1e-9, ev.time - anchorTime);
          const u = (timeSec - anchorTime) / span;
          return currentVal + (ev.value - currentVal) * u;
        }
        if (ev.kind === 'exponentialRamp' && currentVal > 0 && ev.value > 0) {
          const span = Math.max(1e-9, ev.time - anchorTime);
          const u = (timeSec - anchorTime) / span;
          return currentVal * Math.pow(ev.value / currentVal, u);
        }
        return this.baseValue;
      }

      if (ev.kind === 'setValue') {
        currentVal = ev.value;
        anchorTime = ev.time;
      } else if (ev.kind === 'linearRamp') {
        if (timeSec <= ev.time) {
          const span = Math.max(1e-9, ev.time - anchorTime);
          const u = Math.max(0, Math.min(1, (timeSec - anchorTime) / span));
          return currentVal + (ev.value - currentVal) * u;
        }
        currentVal = ev.value;
        anchorTime = ev.time;
      } else if (ev.kind === 'exponentialRamp') {
        const safeStart = Math.max(1e-6, currentVal);
        if (timeSec <= ev.time) {
          const span = Math.max(1e-9, ev.time - anchorTime);
          const u = Math.max(0, Math.min(1, (timeSec - anchorTime) / span));
          return safeStart * Math.pow(ev.value / safeStart, u);
        }
        currentVal = ev.value;
        anchorTime = ev.time;
      } else if (ev.kind === 'setTarget') {
        const endLimit = nextEv !== undefined ? Math.min(timeSec, nextEv.time) : timeSec;
        const dt = Math.max(0, endLimit - ev.time);
        const decayed = ev.value + (currentVal - ev.value) * Math.exp(-dt / ev.timeConstant);
        if (nextEv === undefined || timeSec < nextEv.time) {
          return decayed;
        }
        currentVal = decayed;
        anchorTime = nextEv.time;
      }

      if (
        nextEv !== undefined &&
        timeSec >= anchorTime &&
        timeSec < nextEv.time &&
        nextEv.kind !== 'linearRamp' &&
        nextEv.kind !== 'exponentialRamp'
      ) {
        return currentVal;
      }
    }

    return currentVal;
  }

  public peakScheduledValue(): number {
    let peak = this.baseValue;
    for (let i = 0; i < this.eventsList.length; i++) {
      const v = this.eventsList[i]!.value;
      if (v > peak) {
        peak = v;
      }
    }
    return peak;
  }

  public minScheduledValue(): number {
    let minVal = this.baseValue;
    for (let i = 0; i < this.eventsList.length; i++) {
      const v = this.eventsList[i]!.value;
      if (v < minVal) {
        minVal = v;
      }
    }
    return minVal;
  }

  public firstScheduledValue(): number {
    return this.eventsList.length > 0 ? this.eventsList[0]!.value : this.baseValue;
  }

  public lastScheduledValue(): number {
    return this.eventsList.length > 0
      ? this.eventsList[this.eventsList.length - 1]!.value
      : this.baseValue;
  }

  private insertEvent(event: AudioAutomationEvent): void {
    let idx = this.eventsList.length;
    while (idx > 0 && this.eventsList[idx - 1]!.time > event.time) {
      idx--;
    }
    this.eventsList.splice(idx, 0, event);
  }
}

function isAudioNodeTarget(target: AudioNodeLike | AudioParamLike): target is AudioNodeLike {
  return 'disconnect' in target && typeof target.disconnect === 'function';
}

export class DiagnosticAudioNodeBase implements AudioNodeLike {
  public readonly id: number;
  public readonly kind: DiagnosticNodeKind;
  public disconnectCount = 0;
  protected readonly ownerCtx: DiagnosticWebAudioContext;

  constructor(ownerCtx: DiagnosticWebAudioContext, id: number, kind: DiagnosticNodeKind) {
    this.ownerCtx = ownerCtx;
    this.id = id;
    this.kind = kind;
  }

  public connect(destinationNode: AudioNodeLike): AudioNodeLike;
  public connect(destinationParam: AudioParamLike): void;
  public connect(target: AudioNodeLike | AudioParamLike): AudioNodeLike | void {
    if (isAudioNodeTarget(target)) {
      this.ownerCtx.registerNodeEdge(this, target);
      return target;
    }
    this.ownerCtx.registerParamEdge(this, target);
  }

  public disconnect(): void {
    this.disconnectCount++;
    this.ownerCtx.deactivateEdgesFrom(this);
  }
}

export class DiagnosticGainNode extends DiagnosticAudioNodeBase implements GainNodeLike {
  public readonly gain: DiagnosticAudioParam;

  constructor(ownerCtx: DiagnosticWebAudioContext, id: number) {
    super(ownerCtx, id, 'gain');
    this.gain = new DiagnosticAudioParam(id, 'GainNode.gain', 1.0);
  }
}

export class DiagnosticOscillatorNode
  extends DiagnosticAudioNodeBase
  implements OscillatorNodeLike
{
  public type: OscillatorType = 'sine';
  public readonly frequency: DiagnosticAudioParam;
  public readonly detune: DiagnosticAudioParam;
  public started = false;
  public stopped = false;
  public startTime: number | null = null;
  public stopTime: number | null = null;

  constructor(ownerCtx: DiagnosticWebAudioContext, id: number) {
    super(ownerCtx, id, 'oscillator');
    this.frequency = new DiagnosticAudioParam(id, 'OscillatorNode.frequency', 440);
    this.detune = new DiagnosticAudioParam(id, 'OscillatorNode.detune', 0);
  }

  public start(when = this.ownerCtx.currentTime): void {
    if (this.started) {
      throw new Error(`W3C Web Audio: повторный вызов start() на OscillatorNode #${this.id}`);
    }
    assertNonNegativeTime(when, 'OscillatorNode.start.when');
    this.started = true;
    this.startTime = when;
  }

  public stop(when = this.ownerCtx.currentTime): void {
    if (!this.started || this.startTime === null) {
      throw new Error(`W3C Web Audio: вызов stop() до start() на OscillatorNode #${this.id}`);
    }
    assertNonNegativeTime(when, 'OscillatorNode.stop.when');
    if (when < this.startTime) {
      throw new RangeError(
        `W3C Web Audio: время stop (${when}) меньше времени start (${this.startTime}) на OscillatorNode #${this.id}`,
      );
    }
    this.stopped = true;
    this.stopTime = when;
  }
}

export class DiagnosticBiquadFilterNode
  extends DiagnosticAudioNodeBase
  implements BiquadFilterNodeLike
{
  public type: BiquadFilterType = 'lowpass';
  public readonly frequency: DiagnosticAudioParam;
  public readonly Q: DiagnosticAudioParam;
  public readonly gain: DiagnosticAudioParam;

  constructor(ownerCtx: DiagnosticWebAudioContext, id: number) {
    super(ownerCtx, id, 'biquadFilter');
    this.frequency = new DiagnosticAudioParam(id, 'BiquadFilterNode.frequency', 350);
    this.Q = new DiagnosticAudioParam(id, 'BiquadFilterNode.Q', 1.0);
    this.gain = new DiagnosticAudioParam(id, 'BiquadFilterNode.gain', 0);
  }
}

export class DiagnosticDynamicsCompressorNode
  extends DiagnosticAudioNodeBase
  implements DynamicsCompressorNodeLike
{
  public readonly threshold: DiagnosticAudioParam;
  public readonly knee: DiagnosticAudioParam;
  public readonly ratio: DiagnosticAudioParam;
  public readonly attack: DiagnosticAudioParam;
  public readonly release: DiagnosticAudioParam;

  constructor(ownerCtx: DiagnosticWebAudioContext, id: number) {
    super(ownerCtx, id, 'dynamicsCompressor');
    this.threshold = new DiagnosticAudioParam(id, 'DynamicsCompressor.threshold', -24);
    this.knee = new DiagnosticAudioParam(id, 'DynamicsCompressor.knee', 30);
    this.ratio = new DiagnosticAudioParam(id, 'DynamicsCompressor.ratio', 12);
    this.attack = new DiagnosticAudioParam(id, 'DynamicsCompressor.attack', 0.003);
    this.release = new DiagnosticAudioParam(id, 'DynamicsCompressor.release', 0.25);
  }
}

export class DiagnosticWaveShaperNode
  extends DiagnosticAudioNodeBase
  implements WaveShaperNodeLike
{
  public curve: Float32Array<ArrayBuffer> | null = null;
  public oversample: OverSampleType = 'none';

  constructor(ownerCtx: DiagnosticWebAudioContext, id: number) {
    super(ownerCtx, id, 'waveShaper');
  }
}

export class DiagnosticDelayNode extends DiagnosticAudioNodeBase implements DelayNodeLike {
  public readonly maxDelayTime: number;
  public readonly delayTime: DiagnosticAudioParam;

  constructor(ownerCtx: DiagnosticWebAudioContext, id: number, maxDelayTime = 1.0) {
    super(ownerCtx, id, 'delay');
    assertFiniteNumber(maxDelayTime, 'DelayNode.maxDelayTime');
    if (maxDelayTime <= 0 || maxDelayTime > 180) {
      throw new RangeError(`W3C Web Audio: некорректный maxDelayTime = ${maxDelayTime}`);
    }
    this.maxDelayTime = maxDelayTime;
    this.delayTime = new DiagnosticAudioParam(id, 'DelayNode.delayTime', 0);
  }
}

export class DiagnosticAudioBuffer implements AudioBufferLike {
  public readonly numberOfChannels: number;
  public readonly length: number;
  public readonly sampleRate: number;
  public readonly duration: number;
  private readonly channels: Float32Array<ArrayBuffer>[];

  constructor(numberOfChannels: number, length: number, sampleRate: number) {
    if (!Number.isInteger(numberOfChannels) || numberOfChannels < 1 || numberOfChannels > 32) {
      throw new RangeError(`W3C Web Audio: некорректное число каналов ${numberOfChannels}`);
    }
    if (!Number.isInteger(length) || length < 1) {
      throw new RangeError(`W3C Web Audio: некорректная длина буфера ${length}`);
    }
    if (!Number.isFinite(sampleRate) || sampleRate < 3000 || sampleRate > 768000) {
      throw new RangeError(`W3C Web Audio: некорректная частота дискретизации ${sampleRate}`);
    }
    this.numberOfChannels = numberOfChannels;
    this.length = length;
    this.sampleRate = sampleRate;
    this.duration = length / sampleRate;
    this.channels = [];
    for (let c = 0; c < numberOfChannels; c++) {
      this.channels.push(new Float32Array(length));
    }
  }

  public getChannelData(channel: number): Float32Array<ArrayBuffer> {
    if (!Number.isInteger(channel) || channel < 0 || channel >= this.numberOfChannels) {
      throw new RangeError(`W3C Web Audio: выход за границы индекса канала ${channel}`);
    }
    return this.channels[channel]!;
  }

  public copyFromChannel(
    destination: Float32Array<ArrayBuffer>,
    channelNumber: number,
    bufferOffset = 0,
  ): void {
    const src = this.getChannelData(channelNumber);
    const start = Math.max(0, Math.trunc(bufferOffset));
    const count = Math.max(0, Math.min(destination.length, src.length - start));
    for (let i = 0; i < count; i++) {
      destination[i] = src[start + i]!;
    }
  }

  public copyToChannel(
    source: Float32Array<ArrayBuffer>,
    channelNumber: number,
    bufferOffset = 0,
  ): void {
    const dst = this.getChannelData(channelNumber);
    const start = Math.max(0, Math.trunc(bufferOffset));
    const count = Math.max(0, Math.min(source.length, dst.length - start));
    for (let i = 0; i < count; i++) {
      dst[start + i] = source[i]!;
    }
  }
}

export class DiagnosticAudioBufferSourceNode
  extends DiagnosticAudioNodeBase
  implements AudioBufferSourceNodeLike
{
  public buffer: AudioBufferLike | null = null;
  public loop = false;
  public loopStart = 0;
  public loopEnd = 0;
  public readonly playbackRate: DiagnosticAudioParam;
  public started = false;
  public stopped = false;
  public startTime: number | null = null;
  public stopTime: number | null = null;
  public startOffset = 0;
  public startDuration: number | undefined = undefined;

  constructor(ownerCtx: DiagnosticWebAudioContext, id: number) {
    super(ownerCtx, id, 'bufferSource');
    this.playbackRate = new DiagnosticAudioParam(id, 'AudioBufferSourceNode.playbackRate', 1.0);
  }

  public start(when = this.ownerCtx.currentTime, offset = 0, duration?: number): void {
    if (this.started) {
      throw new Error(`W3C Web Audio: повторный вызов start() на AudioBufferSourceNode #${this.id}`);
    }
    assertNonNegativeTime(when, 'AudioBufferSourceNode.start.when');
    assertNonNegativeTime(offset, 'AudioBufferSourceNode.start.offset');
    if (duration !== undefined) {
      assertNonNegativeTime(duration, 'AudioBufferSourceNode.start.duration');
    }
    this.started = true;
    this.startTime = when;
    this.startOffset = offset;
    this.startDuration = duration;
  }

  public stop(when = this.ownerCtx.currentTime): void {
    if (!this.started || this.startTime === null) {
      throw new Error(`W3C Web Audio: вызов stop() до start() на AudioBufferSourceNode #${this.id}`);
    }
    assertNonNegativeTime(when, 'AudioBufferSourceNode.stop.when');
    if (when < this.startTime) {
      throw new RangeError(
        `W3C Web Audio: время stop (${when}) меньше времени start (${this.startTime}) на AudioBufferSourceNode #${this.id}`,
      );
    }
    this.stopped = true;
    this.stopTime = when;
  }
}

export class DiagnosticWebAudioContext implements AudioContextLike {
  public readonly sampleRate: number;
  public readonly destination: DiagnosticAudioNodeBase;

  public readonly gains: DiagnosticGainNode[] = [];
  public readonly oscillators: DiagnosticOscillatorNode[] = [];
  public readonly filters: DiagnosticBiquadFilterNode[] = [];
  public readonly compressors: DiagnosticDynamicsCompressorNode[] = [];
  public readonly waveShapers: DiagnosticWaveShaperNode[] = [];
  public readonly delays: DiagnosticDelayNode[] = [];
  public readonly bufferSources: DiagnosticAudioBufferSourceNode[] = [];
  public readonly buffers: DiagnosticAudioBuffer[] = [];

  public readonly nodeEdges: DiagnosticNodeEdge[] = [];
  public readonly paramEdges: DiagnosticParamEdge[] = [];

  public resumeCount = 0;
  public closeCount = 0;

  private ctxState: AudioContextState;
  private clockSec = 0;
  private nextNodeId = 1;
  private readonly rejectResume: boolean;

  constructor(options?: {
    initialState?: AudioContextState;
    sampleRate?: number;
    rejectResume?: boolean;
  }) {
    this.ctxState = options?.initialState ?? 'suspended';
    this.sampleRate = options?.sampleRate ?? 44100;
    this.rejectResume = options?.rejectResume ?? false;
    this.destination = new DiagnosticAudioNodeBase(this, this.nextNodeId++, 'destination');
  }

  public get state(): AudioContextState {
    return this.ctxState;
  }

  public get currentTime(): number {
    return this.clockSec;
  }

  public advanceTime(dtSec: number): void {
    assertNonNegativeTime(dtSec, 'DiagnosticWebAudioContext.advanceTime');
    this.clockSec += dtSec;
  }

  public resume(): Promise<void> {
    this.resumeCount++;
    if (this.ctxState === 'closed') {
      return Promise.reject(new Error('Невозможно возобновить закрытый AudioContext'));
    }
    if (this.rejectResume) {
      return Promise.reject(new Error('Автовоспроизведение заблокировано политикой браузера'));
    }
    this.ctxState = 'running';
    return Promise.resolve();
  }

  public close(): Promise<void> {
    this.closeCount++;
    this.ctxState = 'closed';
    return Promise.resolve();
  }

  public createGain(): DiagnosticGainNode {
    const node = new DiagnosticGainNode(this, this.nextNodeId++);
    this.gains.push(node);
    return node;
  }

  public createOscillator(): DiagnosticOscillatorNode {
    const node = new DiagnosticOscillatorNode(this, this.nextNodeId++);
    this.oscillators.push(node);
    return node;
  }

  public createBiquadFilter(): DiagnosticBiquadFilterNode {
    const node = new DiagnosticBiquadFilterNode(this, this.nextNodeId++);
    this.filters.push(node);
    return node;
  }

  public createDynamicsCompressor(): DiagnosticDynamicsCompressorNode {
    const node = new DiagnosticDynamicsCompressorNode(this, this.nextNodeId++);
    this.compressors.push(node);
    return node;
  }

  public createWaveShaper(): DiagnosticWaveShaperNode {
    const node = new DiagnosticWaveShaperNode(this, this.nextNodeId++);
    this.waveShapers.push(node);
    return node;
  }

  public createDelay(maxDelayTime = 1.0): DiagnosticDelayNode {
    const node = new DiagnosticDelayNode(this, this.nextNodeId++, maxDelayTime);
    this.delays.push(node);
    return node;
  }

  public createBuffer(
    numberOfChannels: number,
    length: number,
    sampleRate: number,
  ): DiagnosticAudioBuffer {
    const buf = new DiagnosticAudioBuffer(numberOfChannels, length, sampleRate);
    this.buffers.push(buf);
    return buf;
  }

  public createBufferSource(): DiagnosticAudioBufferSourceNode {
    const node = new DiagnosticAudioBufferSourceNode(this, this.nextNodeId++);
    this.bufferSources.push(node);
    return node;
  }

  public registerNodeEdge(from: DiagnosticAudioNodeBase, to: AudioNodeLike): void {
    this.nodeEdges.push({ from, to, active: true });
  }

  public registerParamEdge(from: DiagnosticAudioNodeBase, toParam: AudioParamLike): void {
    this.paramEdges.push({ from, toParam, active: true });
  }

  public deactivateEdgesFrom(from: DiagnosticAudioNodeBase): void {
    for (let i = 0; i < this.nodeEdges.length; i++) {
      if (this.nodeEdges[i]!.from === from) {
        this.nodeEdges[i]!.active = false;
      }
    }
    for (let i = 0; i < this.paramEdges.length; i++) {
      if (this.paramEdges[i]!.from === from) {
        this.paramEdges[i]!.active = false;
      }
    }
  }

  /**
   * Проверяет наличие активного маршрута сигнала от заданного узла до destination обходом в ширину (BFS).
   */
  public hasActivePathToDestination(startNode: AudioNodeLike): boolean {
    if (startNode === this.destination) {
      return true;
    }
    const visited = new Set<AudioNodeLike>([startNode]);
    const queue: AudioNodeLike[] = [startNode];

    while (queue.length > 0) {
      const current = queue.shift()!;
      for (let i = 0; i < this.nodeEdges.length; i++) {
        const edge = this.nodeEdges[i]!;
        if (!edge.active || edge.from !== current) {
          continue;
        }
        if (edge.to === this.destination) {
          return true;
        }
        if (!visited.has(edge.to)) {
          visited.add(edge.to);
          queue.push(edge.to);
        }
      }
    }
    return false;
  }

  /**
   * Возвращает все параметры всех узлов графа для комплексной проверки отсутствия NaN и невалидных кривых.
   */
  public getAllParams(): DiagnosticAudioParam[] {
    const all: DiagnosticAudioParam[] = [];
    for (const g of this.gains) {
      all.push(g.gain);
    }
    for (const osc of this.oscillators) {
      all.push(osc.frequency, osc.detune);
    }
    for (const f of this.filters) {
      all.push(f.frequency, f.Q, f.gain);
    }
    for (const c of this.compressors) {
      all.push(c.threshold, c.knee, c.ratio, c.attack, c.release);
    }
    for (const d of this.delays) {
      all.push(d.delayTime);
    }
    for (const s of this.bufferSources) {
      all.push(s.playbackRate);
    }
    return all;
  }
}
