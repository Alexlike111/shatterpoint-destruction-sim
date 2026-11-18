import * as THREE from 'three';
import { clamp, cleanZero } from '../core/math3d';
import { SeededRng } from '../core/rng';
import { DEFAULT_SEED, type SimulationEvent } from '../core/types';

/**
 * Орбитально-панорамная 3D-камера испытательного полигона (CameraRig):
 * - Бесконфликтный пользовательский ввод на canvas (порог перетаскивания 4 px, ПКМ/СКМ/Alt+ЛКМ орбита,
 *   Shift+ПКМ панорама, колесо мыши зум, свободный ЛКМ для стрельбы и плазморезака);
 * - Мгновенная синхронизация матриц проекции и мира после каждой операции (включая паузу и headless-тесты);
 * - Пружинно-гармоническая физическая тряска от взрывов, вторичных обвалов и сейсмоплатформы с затуханием в [0,0,0];
 * - Точная математика screenPointToRay и projectWorldToScreen с отсечением точек за спиной камеры.
 */

export interface CameraRigOptions {
  fovDeg?: number;
  aspect?: number;
  near?: number;
  far?: number;
  initialTarget?: [number, number, number];
  initialDistance?: number;
  initialAzimuthRad?: number;
  initialPolarRad?: number;
  seed?: number;
}

export interface SphericalCameraState {
  azimuthRad: number;
  polarRad: number;
  distanceM: number;
  target: [number, number, number];
}

const DEFAULT_FOV_DEG = 50;
const DEFAULT_ASPECT = 1280 / 720;
const DEFAULT_NEAR_M = 0.2;
const DEFAULT_FAR_M = 600;
const DEFAULT_TARGET: readonly [number, number, number] = [0, 5.5, 0];
const DEFAULT_DISTANCE_M = 28;
const DEFAULT_AZIMUTH_RAD = 0.62;
const DEFAULT_POLAR_RAD = 1.18;

const MIN_POLAR_RAD = 0.08;
const MAX_POLAR_RAD = Math.PI * 0.485;
const MIN_DISTANCE_M = 3.5;
const MAX_DISTANCE_M = 180.0;
const MIN_EYE_HEIGHT_M = 0.45;
const DRAG_THRESHOLD_PX = 4.0;

const _vWorld = new THREE.Vector3();
const _vCam = new THREE.Vector3();
const _vNdc = new THREE.Vector3();
const _ndc2 = new THREE.Vector2();
const _lookTarget = new THREE.Vector3();

export class CameraRig {
  public readonly camera: THREE.PerspectiveCamera;

  private readonly rng: SeededRng;
  private readonly raycaster: THREE.Raycaster;

  private readonly defaultTarget: [number, number, number];
  private readonly defaultDistanceM: number;
  private readonly defaultAzimuthRad: number;
  private readonly defaultPolarRad: number;

  private target: [number, number, number];
  private distanceM: number;
  private azimuthRad: number;
  private polarRad: number;

  private viewportWidth = 1280;
  private viewportHeight = 720;

  // Состояние физической 3D-тряски камеры
  private shakeTrauma = 0;
  private shakeFreqHz = 18.0;
  private shakeTimeSec = 0;
  private shakeSeedOffsets: [number, number, number] = [0, 2.1, 4.2];
  private seismicAmpM = 0;
  private seismicFreqHz = 2.5;
  private seismicTimerSec = 0;
  private shakeOffset: [number, number, number] = [0, 0, 0];

  // Управление вводом на HTMLCanvasElement / EventTarget
  private attachedCanvas: EventTarget | null = null;
  private activePointerId: number | null = null;
  private pendingDragMode: 'none' | 'orbit' | 'pan' = 'none';
  private dragExceededThreshold = false;
  private dragStartX = 0;
  private dragStartY = 0;
  private dragLastX = 0;
  private dragLastY = 0;
  private readonly activeTouchPointers: Map<number, { x: number; y: number }> = new Map();
  private prevPinchDistPx = 0;
  private prevPinchMidX = 0;
  private prevPinchMidY = 0;

  private readonly boundOnPointerDown: EventListener;
  private readonly boundOnPointerMove: EventListener;
  private readonly boundOnPointerUp: EventListener;
  private readonly boundOnWheel: EventListener;
  private readonly boundOnContextMenu: EventListener;

  private disposed = false;

  constructor(options?: CameraRigOptions) {
    const fov =
      options?.fovDeg !== undefined && Number.isFinite(options.fovDeg)
        ? clamp(options.fovDeg, 20, 110)
        : DEFAULT_FOV_DEG;
    const aspect =
      options?.aspect !== undefined && Number.isFinite(options.aspect) && options.aspect > 0
        ? clamp(options.aspect, 0.2, 6.0)
        : DEFAULT_ASPECT;
    const near =
      options?.near !== undefined && Number.isFinite(options.near) && options.near > 0
        ? clamp(options.near, 0.01, 1000)
        : DEFAULT_NEAR_M;
    const far =
      options?.far !== undefined && Number.isFinite(options.far) && options.far > near + 10
        ? Math.min(1e6, Math.max(options.far, near + 100))
        : Math.max(DEFAULT_FAR_M, near + 100);

    this.camera = new THREE.PerspectiveCamera(fov, aspect, near, far);
    this.rng = new SeededRng(options?.seed ?? (DEFAULT_SEED ^ 0x43414d52));
    this.raycaster = new THREE.Raycaster();

    const initT = options?.initialTarget ?? DEFAULT_TARGET;
    this.defaultTarget = [
      Number.isFinite(initT[0]) ? clamp(initT[0], -120, 120) : DEFAULT_TARGET[0],
      Number.isFinite(initT[1]) ? clamp(initT[1], -1.5, 85) : DEFAULT_TARGET[1],
      Number.isFinite(initT[2]) ? clamp(initT[2], -120, 120) : DEFAULT_TARGET[2],
    ];
    this.defaultDistanceM =
      options?.initialDistance !== undefined && Number.isFinite(options.initialDistance)
        ? clamp(options.initialDistance, MIN_DISTANCE_M, MAX_DISTANCE_M)
        : DEFAULT_DISTANCE_M;
    this.defaultAzimuthRad =
      options?.initialAzimuthRad !== undefined && Number.isFinite(options.initialAzimuthRad)
        ? this.normalizeAngleRad(options.initialAzimuthRad)
        : DEFAULT_AZIMUTH_RAD;
    this.defaultPolarRad =
      options?.initialPolarRad !== undefined && Number.isFinite(options.initialPolarRad)
        ? clamp(options.initialPolarRad, MIN_POLAR_RAD, MAX_POLAR_RAD)
        : DEFAULT_POLAR_RAD;

    this.target = [this.defaultTarget[0], this.defaultTarget[1], this.defaultTarget[2]];
    this.distanceM = this.defaultDistanceM;
    this.azimuthRad = this.defaultAzimuthRad;
    this.polarRad = this.defaultPolarRad;

    this.boundOnPointerDown = (e: Event) => this.handlePointerDown(e);
    this.boundOnPointerMove = (e: Event) => this.handlePointerMove(e);
    this.boundOnPointerUp = (e: Event) => this.handlePointerUp(e);
    this.boundOnWheel = (e: Event) => this.handleWheel(e);
    this.boundOnContextMenu = (e: Event) => {
      e.preventDefault();
    };

    this.syncCameraMatrices();
  }

  /**
   * Подключает обработчики мыши, колеса и мультитача к целевому canvas без конфликта с ЛКМ оружия.
   */
  public attachCanvas(canvas: HTMLCanvasElement | EventTarget): void {
    if (this.disposed) return;
    if (this.attachedCanvas === canvas) return;

    this.detachCanvas();
    this.attachedCanvas = canvas;

    canvas.addEventListener('pointerdown', this.boundOnPointerDown);
    canvas.addEventListener('wheel', this.boundOnWheel, { passive: false });
    canvas.addEventListener('contextmenu', this.boundOnContextMenu);

    if (typeof window !== 'undefined') {
      window.addEventListener('pointermove', this.boundOnPointerMove);
      window.addEventListener('pointerup', this.boundOnPointerUp);
      window.addEventListener('pointercancel', this.boundOnPointerUp);
    } else {
      canvas.addEventListener('pointermove', this.boundOnPointerMove);
      canvas.addEventListener('pointerup', this.boundOnPointerUp);
      canvas.addEventListener('pointercancel', this.boundOnPointerUp);
    }
  }

  public detachCanvas(): void {
    const canvas = this.attachedCanvas;
    if (!canvas) return;

    canvas.removeEventListener('pointerdown', this.boundOnPointerDown);
    canvas.removeEventListener('wheel', this.boundOnWheel);
    canvas.removeEventListener('contextmenu', this.boundOnContextMenu);

    if (typeof window !== 'undefined') {
      window.removeEventListener('pointermove', this.boundOnPointerMove);
      window.removeEventListener('pointerup', this.boundOnPointerUp);
      window.removeEventListener('pointercancel', this.boundOnPointerUp);
    } else {
      canvas.removeEventListener('pointermove', this.boundOnPointerMove);
      canvas.removeEventListener('pointerup', this.boundOnPointerUp);
      canvas.removeEventListener('pointercancel', this.boundOnPointerUp);
    }

    this.attachedCanvas = null;
    this.activePointerId = null;
    this.pendingDragMode = 'none';
    this.dragExceededThreshold = false;
    this.activeTouchPointers.clear();
  }

  public resize(width: number, height: number): void {
    if (this.disposed) return;
    const safeW = Number.isFinite(width) && width > 1 ? clamp(width, 2, 16384) : 1280;
    const safeH = Number.isFinite(height) && height > 1 ? clamp(height, 2, 16384) : 720;
    this.viewportWidth = safeW;
    this.viewportHeight = safeH;
    this.camera.aspect = clamp(safeW / safeH, 0.2, 6.0);
    this.syncCameraMatrices();
  }

  /**
   * Вращает камеру по азимуту и полярному углу с жёсткой защитой от переворота в зените и ухода под землю.
   */
  public orbit(deltaAzimuthRad: number, deltaPolarRad: number): void {
    if (this.disposed) return;
    const dAz = Number.isFinite(deltaAzimuthRad)
      ? clamp(deltaAzimuthRad, -Math.PI * 8, Math.PI * 8)
      : 0;
    const dPol = Number.isFinite(deltaPolarRad)
      ? clamp(deltaPolarRad, -Math.PI * 8, Math.PI * 8)
      : 0;

    this.azimuthRad = this.normalizeAngleRad(this.azimuthRad + dAz);
    this.polarRad = clamp(this.polarRad + dPol, MIN_POLAR_RAD, MAX_POLAR_RAD);
    this.syncCameraMatrices();
  }

  /**
   * Панорамирует точку фокуса камеры вдоль локальных осей экрана (вправо и вверх, в метрах).
   */
  public pan(deltaRightM: number, deltaUpM: number): void {
    if (this.disposed) return;
    const dR = Number.isFinite(deltaRightM) ? clamp(deltaRightM, -1e5, 1e5) : 0;
    const dU = Number.isFinite(deltaUpM) ? clamp(deltaUpM, -1e5, 1e5) : 0;

    const sinAz = Math.sin(this.azimuthRad);
    const cosAz = Math.cos(this.azimuthRad);
    const rightX = cosAz;
    const rightZ = -sinAz;

    const cosPol = Math.cos(this.polarRad);
    const sinPol = Math.sin(this.polarRad);
    const upX = -cosPol * sinAz;
    const upY = sinPol;
    const upZ = -cosPol * cosAz;

    this.target[0] = clamp(this.target[0] + rightX * dR + upX * dU, -120, 120);
    this.target[1] = clamp(this.target[1] + upY * dU, -1.5, 85);
    this.target[2] = clamp(this.target[2] + rightZ * dR + upZ * dU, -120, 120);

    this.syncCameraMatrices();
  }

  /**
   * Масштабирует дистанцию орбиты мультипликативным коэффициентом (< 1 — приближение, > 1 — отдаление).
   */
  public zoom(scaleFactor: number): void {
    if (this.disposed) return;
    if (!Number.isFinite(scaleFactor) || scaleFactor <= 0) return;

    const clampedFactor = clamp(scaleFactor, 0.1, 10.0);
    this.distanceM = clamp(this.distanceM * clampedFactor, MIN_DISTANCE_M, MAX_DISTANCE_M);
    this.syncCameraMatrices();
  }

  /**
   * Масштабирует дистанцию орбиты по сырому значению прокрутки колеса мыши deltaY.
   */
  public zoomByWheelDelta(deltaY: number): void {
    if (!Number.isFinite(deltaY) || deltaY === 0) return;
    const factor = Math.exp(clamp(deltaY, -600, 600) * 0.0012);
    this.zoom(factor);
  }

  /**
   * Наводит камеру на заданную ограничивающую сферу сооружения так, чтобы оно целиком помещалось в кадр.
   */
  public focusOnBounds(center: [number, number, number], radiusM: number): void {
    if (this.disposed) return;

    const cx = Number.isFinite(center[0]) ? clamp(center[0], -120, 120) : 0;
    const cy = Number.isFinite(center[1]) ? clamp(center[1], -1.5, 85) : 5.5;
    const cz = Number.isFinite(center[2]) ? clamp(center[2], -120, 120) : 0;
    const safeRadius = Number.isFinite(radiusM) ? clamp(radiusM, 1.0, 120.0) : 10.0;

    const vFovRad = THREE.MathUtils.degToRad(this.camera.fov);
    const hFovRad = 2 * Math.atan(Math.tan(vFovRad * 0.5) * this.camera.aspect);
    const minHalfFov = Math.max(0.15, Math.min(vFovRad, hFovRad) * 0.5);

    const optimalDist = (safeRadius * 1.25) / Math.sin(minHalfFov);

    this.target = [cx, cy, cz];
    this.distanceM = clamp(optimalDist, MIN_DISTANCE_M, MAX_DISTANCE_M);
    this.syncCameraMatrices();
  }

  public resetView(): void {
    if (this.disposed) return;
    this.target = [this.defaultTarget[0], this.defaultTarget[1], this.defaultTarget[2]];
    this.distanceM = this.defaultDistanceM;
    this.azimuthRad = this.defaultAzimuthRad;
    this.polarRad = this.defaultPolarRad;
    this.resetShake();
    this.syncCameraMatrices();
  }

  /**
   * Реагирует на события взрывов, вторичных ударов обломков и сейсмоплатформы физической тряской камеры.
   */
  public consumeEvents(events: readonly SimulationEvent[]): void {
    if (this.disposed || events.length === 0) return;

    const camPos = this.camera.position;

    for (let i = 0; i < events.length; i++) {
      const ev = events[i]!;
      switch (ev.type) {
        case 'explosion': {
          const [ex, ey, ez] = ev.position;
          if (!Number.isFinite(ex) || !Number.isFinite(ey) || !Number.isFinite(ez)) break;
          const dist = Math.hypot(
            clamp(ex, -1e5, 1e5) - camPos.x,
            clamp(ey, -1e5, 1e5) - camPos.y,
            clamp(ez, -1e5, 1e5) - camPos.z,
          );
          const atten = 1 / (1 + dist * 0.035);
          const safeTnt = Number.isFinite(ev.equivalentKgTnt)
            ? clamp(ev.equivalentKgTnt, 0.5, 1e9)
            : 0.5;
          const yieldFactor = Math.cbrt(safeTnt);
          const chainBoost = ev.isChainDetonation ? 1.3 : 1.0;
          const impulse = clamp(yieldFactor * 0.18 * chainBoost * atten, 0.06, 0.95);
          this.addShakeImpulse(impulse, 20.0);
          break;
        }
        case 'secondary_impact': {
          const [ix, iy, iz] = ev.position;
          if (!Number.isFinite(ix) || !Number.isFinite(iy) || !Number.isFinite(iz)) break;
          const dist = Math.hypot(
            clamp(ix, -1e5, 1e5) - camPos.x,
            clamp(iy, -1e5, 1e5) - camPos.y,
            clamp(iz, -1e5, 1e5) - camPos.z,
          );
          const atten = 1 / (1 + dist * 0.04);
          const safeImpulse = Number.isFinite(ev.impulseNs)
            ? clamp(ev.impulseNs, 0, 1e12)
            : 0;
          const safeMass = Number.isFinite(ev.massKg) ? clamp(ev.massKg, 0, 1e12) : 0;
          const mag = Math.log10(1 + safeImpulse * 0.001 + safeMass * 0.01);
          if (mag > 0.1) {
            this.addShakeImpulse(clamp(mag * 0.12 * atten, 0.02, 0.55), 14.0);
          }
          break;
        }
        case 'fracture': {
          const safeEnergy = Number.isFinite(ev.energyJ) ? clamp(ev.energyJ, 0, 1e12) : 0;
          if (safeEnergy > 8000) {
            const [fx, fy, fz] = ev.position;
            if (!Number.isFinite(fx) || !Number.isFinite(fy) || !Number.isFinite(fz)) break;
            const dist = Math.hypot(
              clamp(fx, -1e5, 1e5) - camPos.x,
              clamp(fy, -1e5, 1e5) - camPos.y,
              clamp(fz, -1e5, 1e5) - camPos.z,
            );
            const atten = 1 / (1 + dist * 0.05);
            this.addShakeImpulse(clamp(0.08 * atten, 0.01, 0.25), 16.0);
          }
          break;
        }
        case 'seismic_pulse': {
          const safeFreq = Number.isFinite(ev.frequencyHz) ? clamp(ev.frequencyHz, 0.5, 20) : 2.5;
          const safeAccel = Number.isFinite(ev.groundAccelMpS2)
            ? clamp(ev.groundAccelMpS2, 0, 1e5)
            : 0;
          const safeAmp = Number.isFinite(ev.amplitudeM) ? clamp(ev.amplitudeM, 0, 100) : 0;
          this.seismicFreqHz = safeFreq;
          this.seismicAmpM = clamp(safeAccel * 0.009 + safeAmp * 0.08, 0, 0.22);
          this.seismicTimerSec = 0.26;
          this.recomputeShakeOffset();
          this.syncCameraMatrices();
          break;
        }
        default:
          break;
      }
    }
  }

  public addShakeImpulse(intensity: number, frequencyHz = 18.0): void {
    if (this.disposed) return;
    if (!Number.isFinite(intensity) || intensity <= 0) return;

    const wasResting = this.shakeTrauma <= 1e-4;
    this.shakeTrauma = clamp(this.shakeTrauma + intensity, 0, 1.0);
    if (Number.isFinite(frequencyHz) && frequencyHz > 0) {
      this.shakeFreqHz = clamp(frequencyHz, 2.0, 40.0);
    }

    if (wasResting) {
      this.shakeSeedOffsets = [
        this.rng.range(0.35, 5.8),
        this.rng.range(0.35, 5.8),
        this.rng.range(0.35, 5.8),
      ];
    }

    this.recomputeShakeOffset();
    this.syncCameraMatrices();
  }

  public resetShake(): void {
    this.shakeTrauma = 0;
    this.seismicAmpM = 0;
    this.seismicTimerSec = 0;
    this.shakeTimeSec = 0;
    this.shakeOffset = [0, 0, 0];
    if (!this.disposed) {
      this.syncCameraMatrices();
    }
  }

  /**
   * Продвигает затухание физической тряски камеры; при полном затухании обнуляет смещение в точный [0, 0, 0].
   */
  public update(dtRealSec: number): void {
    if (this.disposed) return;
    const dt = Number.isFinite(dtRealSec) ? clamp(dtRealSec, 0, 0.25) : 0;
    if (dt <= 0) return;

    const hadShake = this.shakeTrauma > 0 || this.seismicTimerSec > 0;
    if (!hadShake) return;

    this.shakeTimeSec += dt;
    this.shakeTrauma = Math.max(0, this.shakeTrauma - dt * 1.85);
    this.seismicTimerSec = Math.max(0, this.seismicTimerSec - dt);

    if (this.shakeTrauma <= 1e-4 && this.seismicTimerSec <= 0) {
      this.shakeTrauma = 0;
      this.seismicAmpM = 0;
      this.seismicTimerSec = 0;
      this.shakeOffset = [0, 0, 0];
    } else {
      this.recomputeShakeOffset();
    }

    this.syncCameraMatrices();
  }

  public getShakeOffset(): [number, number, number] {
    return [this.shakeOffset[0], this.shakeOffset[1], this.shakeOffset[2]];
  }

  public getSphericalState(): SphericalCameraState {
    return {
      azimuthRad: this.azimuthRad,
      polarRad: this.polarRad,
      distanceM: this.distanceM,
      target: [this.target[0], this.target[1], this.target[2]],
    };
  }

  /**
   * Строит нормированный мировой луч из экранных координат NDC [-1..1, -1..1].
   */
  public screenPointToRay(
    ndcX: number,
    ndcY: number,
  ): { origin: [number, number, number]; direction: [number, number, number] } {
    const sx = Number.isFinite(ndcX) ? clamp(ndcX, -2, 2) : 0;
    const sy = Number.isFinite(ndcY) ? clamp(ndcY, -2, 2) : 0;

    this.camera.updateMatrixWorld(true);
    _ndc2.set(sx, sy);
    this.raycaster.setFromCamera(_ndc2, this.camera);

    const o = this.raycaster.ray.origin;
    const d = this.raycaster.ray.direction;

    return {
      origin: [cleanZero(o.x), cleanZero(o.y), cleanZero(o.z)],
      direction: [cleanZero(d.x), cleanZero(d.y), cleanZero(d.z)],
    };
  }

  /**
   * Проецирует мировую 3D-точку в экранные пиксели и определяет её фактическую видимость внутри пирамиды видимости.
   */
  public projectWorldToScreen(
    worldPos: [number, number, number],
    viewportWidth: number = this.viewportWidth,
    viewportHeight: number = this.viewportHeight,
    offsetLeft = 0,
    offsetTop = 0,
  ): { x: number; y: number; visible: boolean } {
    if (
      !Number.isFinite(worldPos[0]) ||
      !Number.isFinite(worldPos[1]) ||
      !Number.isFinite(worldPos[2])
    ) {
      return { x: 0, y: 0, visible: false };
    }

    const safeW =
      Number.isFinite(viewportWidth) && viewportWidth > 0
        ? clamp(viewportWidth, 1, 16384)
        : 1280;
    const safeH =
      Number.isFinite(viewportHeight) && viewportHeight > 0
        ? clamp(viewportHeight, 1, 16384)
        : 720;
    const safeLeft = Number.isFinite(offsetLeft) ? clamp(offsetLeft, -1e6, 1e6) : 0;
    const safeTop = Number.isFinite(offsetTop) ? clamp(offsetTop, -1e6, 1e6) : 0;

    if (
      Math.abs(worldPos[0]) > 1e7 ||
      Math.abs(worldPos[1]) > 1e7 ||
      Math.abs(worldPos[2]) > 1e7
    ) {
      return { x: 0, y: 0, visible: false };
    }

    this.camera.updateMatrixWorld(true);

    _vWorld.set(worldPos[0], worldPos[1], worldPos[2]);
    _vCam.copy(_vWorld).applyMatrix4(this.camera.matrixWorldInverse);

    const depthInFront = -_vCam.z;
    if (!(depthInFront > this.camera.near && depthInFront <= this.camera.far)) {
      _vNdc.copy(_vWorld).project(this.camera);
      const outX = safeLeft + (_vNdc.x * 0.5 + 0.5) * safeW;
      const outY = safeTop + (-_vNdc.y * 0.5 + 0.5) * safeH;
      return {
        x: Number.isFinite(outX) ? clamp(outX, -1e7, 1e7) : 0,
        y: Number.isFinite(outY) ? clamp(outY, -1e7, 1e7) : 0,
        visible: false,
      };
    }

    _vNdc.copy(_vWorld).project(this.camera);
    const rawX = safeLeft + (_vNdc.x * 0.5 + 0.5) * safeW;
    const rawY = safeTop + (-_vNdc.y * 0.5 + 0.5) * safeH;
    const x = Number.isFinite(rawX) ? clamp(rawX, -1e7, 1e7) : 0;
    const y = Number.isFinite(rawY) ? clamp(rawY, -1e7, 1e7) : 0;
    const visible =
      Number.isFinite(rawX) &&
      Number.isFinite(rawY) &&
      Math.abs(_vNdc.x) <= 1.0 &&
      Math.abs(_vNdc.y) <= 1.0 &&
      Math.abs(_vNdc.z) <= 1.0;

    return { x, y, visible };
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.detachCanvas();
    this.resetShake();
  }

  private normalizeAngleRad(angle: number): number {
    if (!Number.isFinite(angle)) return DEFAULT_AZIMUTH_RAD;
    const twoPi = Math.PI * 2;
    let wrapped = angle % twoPi;
    if (wrapped > Math.PI) wrapped -= twoPi;
    if (wrapped < -Math.PI) wrapped += twoPi;
    return wrapped;
  }

  private recomputeShakeOffset(): void {
    const t = this.shakeTimeSec;
    const ampImpulse = this.shakeTrauma * this.shakeTrauma * 0.42;
    const w = this.shakeFreqHz * Math.PI * 2;

    let sx =
      ampImpulse *
      (Math.sin(t * w + this.shakeSeedOffsets[0]) * 0.7 +
        Math.cos(t * w * 1.73 + this.shakeSeedOffsets[1]) * 0.3);
    let sy =
      ampImpulse *
      (Math.sin(t * w * 1.31 + this.shakeSeedOffsets[1]) * 0.75 +
        Math.sin(t * w * 2.17 + this.shakeSeedOffsets[2]) * 0.25);
    let sz =
      ampImpulse *
      (Math.cos(t * w * 0.93 + this.shakeSeedOffsets[2]) * 0.7 +
        Math.sin(t * w * 1.89 + this.shakeSeedOffsets[0]) * 0.3);

    if (this.seismicTimerSec > 0 && this.seismicAmpM > 0) {
      const fade = clamp(this.seismicTimerSec / 0.26, 0, 1);
      const sw = this.seismicFreqHz * Math.PI * 2;
      sx += Math.sin(t * sw + 0.5) * this.seismicAmpM * fade;
      sy += Math.sin(t * sw * 2.0 + 1.1) * this.seismicAmpM * 0.45 * fade;
      sz += Math.cos(t * sw * 0.85 + 2.2) * this.seismicAmpM * 0.75 * fade;
    }

    this.shakeOffset = [cleanZero(sx), cleanZero(sy), cleanZero(sz)];
  }

  private syncCameraMatrices(): void {
    const sinPol = Math.sin(this.polarRad);
    const cosPol = Math.cos(this.polarRad);
    const sinAz = Math.sin(this.azimuthRad);
    const cosAz = Math.cos(this.azimuthRad);

    const baseEyeX = this.target[0] + this.distanceM * sinPol * sinAz;
    const baseEyeY = Math.max(MIN_EYE_HEIGHT_M, this.target[1] + this.distanceM * cosPol);
    const baseEyeZ = this.target[2] + this.distanceM * sinPol * cosAz;

    const [ox, oy, oz] = this.shakeOffset;

    this.camera.up.set(0, 1, 0);
    this.camera.position.set(
      baseEyeX + ox,
      Math.max(0.25, baseEyeY + oy),
      baseEyeZ + oz,
    );

    _lookTarget.set(
      this.target[0] + ox * 0.35,
      this.target[1] + oy * 0.35,
      this.target[2] + oz * 0.35,
    );
    this.camera.lookAt(_lookTarget);
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld(true);
  }

  private extractPointerFields(ev: Event): {
    pointerId: number;
    pointerType: string;
    button: number;
    clientX: number;
    clientY: number;
    shiftKey: boolean;
    ctrlKey: boolean;
    altKey: boolean;
  } {
    const pointerId =
      'pointerId' in ev && typeof ev.pointerId === 'number' && Number.isFinite(ev.pointerId)
        ? ev.pointerId
        : 1;
    const pointerType =
      'pointerType' in ev && typeof ev.pointerType === 'string' ? ev.pointerType : 'mouse';
    const button =
      'button' in ev && typeof ev.button === 'number' && Number.isFinite(ev.button)
        ? ev.button
        : 0;
    const clientX =
      'clientX' in ev && typeof ev.clientX === 'number' && Number.isFinite(ev.clientX)
        ? clamp(ev.clientX, -1e6, 1e6)
        : 0;
    const clientY =
      'clientY' in ev && typeof ev.clientY === 'number' && Number.isFinite(ev.clientY)
        ? clamp(ev.clientY, -1e6, 1e6)
        : 0;
    const shiftKey = 'shiftKey' in ev && typeof ev.shiftKey === 'boolean' ? ev.shiftKey : false;
    const ctrlKey = 'ctrlKey' in ev && typeof ev.ctrlKey === 'boolean' ? ev.ctrlKey : false;
    const altKey = 'altKey' in ev && typeof ev.altKey === 'boolean' ? ev.altKey : false;
    return {
      pointerId,
      pointerType,
      button,
      clientX,
      clientY,
      shiftKey,
      ctrlKey,
      altKey,
    };
  }

  private handlePointerDown(rawEvent: Event): void {
    if (this.disposed) return;
    const e = this.extractPointerFields(rawEvent);

    if (e.pointerType === 'touch') {
      this.activeTouchPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.activeTouchPointers.size === 2) {
        const pts = Array.from(this.activeTouchPointers.values());
        const p0 = pts[0]!;
        const p1 = pts[1]!;
        this.prevPinchDistPx = Math.hypot(p1.x - p0.x, p1.y - p0.y);
        this.prevPinchMidX = (p0.x + p1.x) * 0.5;
        this.prevPinchMidY = (p0.y + p1.y) * 0.5;
        this.pendingDragMode = 'none';
      }
      return;
    }

    let mode: 'none' | 'orbit' | 'pan' = 'none';
    if ((e.button === 2 || e.button === 1) && (e.shiftKey || e.ctrlKey)) {
      mode = 'pan';
    } else if (e.button === 2 || e.button === 1 || (e.button === 0 && e.altKey)) {
      mode = 'orbit';
    }

    if (mode === 'none') {
      return;
    }

    this.activePointerId = e.pointerId;
    this.pendingDragMode = mode;
    this.dragExceededThreshold = false;
    this.dragStartX = e.clientX;
    this.dragStartY = e.clientY;
    this.dragLastX = e.clientX;
    this.dragLastY = e.clientY;
  }

  private handlePointerMove(rawEvent: Event): void {
    if (this.disposed) return;
    const e = this.extractPointerFields(rawEvent);

    if (e.pointerType === 'touch' && this.activeTouchPointers.has(e.pointerId)) {
      this.activeTouchPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.activeTouchPointers.size === 2) {
        const pts = Array.from(this.activeTouchPointers.values());
        const p0 = pts[0]!;
        const p1 = pts[1]!;
        const dist = Math.hypot(p1.x - p0.x, p1.y - p0.y);
        const midX = (p0.x + p1.x) * 0.5;
        const midY = (p0.y + p1.y) * 0.5;

        if (this.prevPinchDistPx > 8 && dist > 8) {
          this.zoom(this.prevPinchDistPx / dist);
        }
        const panScale = this.distanceM * 0.0016;
        this.pan(-(midX - this.prevPinchMidX) * panScale, (midY - this.prevPinchMidY) * panScale);

        this.prevPinchDistPx = dist;
        this.prevPinchMidX = midX;
        this.prevPinchMidY = midY;
      }
      return;
    }

    if (this.activePointerId === null || e.pointerId !== this.activePointerId) {
      return;
    }
    if (this.pendingDragMode === 'none') {
      return;
    }

    const totalDist = Math.hypot(e.clientX - this.dragStartX, e.clientY - this.dragStartY);
    if (!this.dragExceededThreshold) {
      if (totalDist < DRAG_THRESHOLD_PX) {
        return;
      }
      this.dragExceededThreshold = true;
    }

    const dx = e.clientX - this.dragLastX;
    const dy = e.clientY - this.dragLastY;
    this.dragLastX = e.clientX;
    this.dragLastY = e.clientY;

    if (this.pendingDragMode === 'orbit') {
      const orbitSensitivity = 0.0055;
      this.orbit(-dx * orbitSensitivity, -dy * orbitSensitivity);
    } else if (this.pendingDragMode === 'pan') {
      const panScale = this.distanceM * 0.0018;
      this.pan(-dx * panScale, dy * panScale);
    }
  }

  private handlePointerUp(rawEvent: Event): void {
    const e = this.extractPointerFields(rawEvent);
    if (this.activeTouchPointers.has(e.pointerId)) {
      this.activeTouchPointers.delete(e.pointerId);
      if (this.activeTouchPointers.size < 2) {
        this.prevPinchDistPx = 0;
      }
    }

    if (this.activePointerId !== null && e.pointerId === this.activePointerId) {
      this.activePointerId = null;
      this.pendingDragMode = 'none';
      this.dragExceededThreshold = false;
    }
  }

  private handleWheel(rawEvent: Event): void {
    if (this.disposed) return;
    rawEvent.preventDefault();
    const deltaY = 'deltaY' in rawEvent && typeof rawEvent.deltaY === 'number' ? rawEvent.deltaY : 0;
    this.zoomByWheelDelta(deltaY);
  }
}
