import * as THREE from 'three';
import { clamp } from '../core/math3d';
import type {
  QualityPreset,
  RenderSnapshot,
  RenderViewMode,
  SimulationEvent,
} from '../core/types';
import { BatchedShardLayer } from './BatchedShardLayer';
import { CameraRig } from './CameraRig';
import { CollapseVFXSystem } from './CollapseVFXSystem';
import { InstancedBlockLayer } from './InstancedBlockLayer';
import { RebarAndJointLayer } from './RebarAndJointLayer';

/**
 * Главный 3D PBR-рендерер испытательного полигона «ТОЧКА РАЗЛОМА» (SceneRenderer).
 * Объединяет WebGL2-конвейер Three.js (ACESFilmicToneMapping, PCFSoftShadowMap, освещение полигона,
 * подвижную сейсмоплатформу) и безопасный честный графовый Headless-режим для Node.js / Vitest.
 */

export interface SceneRendererOptions {
  canvas?: HTMLCanvasElement;
  quality?: QualityPreset;
  headless?: boolean;
  width?: number;
  height?: number;
  seed?: number;
}

const BG_COLOR_PBR = 0x0b1016;    // Глубокий графитовый сланец (Hue ~213°)
const BG_COLOR_STRESS = 0x080e14; // Тёмный инженерный титан (Hue ~210°)
const BG_COLOR_XRAY = 0x050b10;   // Голографический чертёжный сланец (Hue ~207°)

/**
 * Честный рекурсивный подсчёт активных Draw Calls по видимому графу Three.js сцены
 * (для Headless-среды без WebGL и стартовой диагностики). Никаких захардкоженных констант!
 */
export function countActiveSceneDrawCalls(
  root: THREE.Object3D,
  shadowsEnabled: boolean,
): number {
  if (!root.visible) {
    return 0;
  }

  let calls = 0;

  if (root instanceof THREE.BatchedMesh) {
    if (root.instanceCount > 0) {
      calls += 1;
      if (shadowsEnabled && root.castShadow) {
        calls += 1;
      }
    }
  } else if (root instanceof THREE.InstancedMesh) {
    const posAttr = root.geometry.getAttribute('position');
    if (root.count > 0 && posAttr && posAttr.count > 0) {
      calls += 1;
      if (shadowsEnabled && root.castShadow) {
        calls += 1;
      }
    }
  } else if (root instanceof THREE.Mesh) {
    const posAttr = root.geometry.getAttribute('position');
    const drawCount = root.geometry.drawRange.count;
    if (posAttr && posAttr.count > 0 && drawCount > 0) {
      calls += 1;
      if (shadowsEnabled && root.castShadow) {
        calls += 1;
      }
    }
  } else if (root instanceof THREE.LineSegments) {
    const posAttr = root.geometry.getAttribute('position');
    const drawCount = root.geometry.drawRange.count;
    if (posAttr && posAttr.count > 0 && drawCount > 0) {
      calls += 1;
    }
  }

  const children = root.children;
  for (let i = 0; i < children.length; i++) {
    calls += countActiveSceneDrawCalls(children[i]!, shadowsEnabled);
  }

  return calls;
}

/**
 * Строит геометрию координатной сетки и сигнально-янтарного контура сейсмоплатформы за 1 Draw Call.
 */
function createPlatformGridLineSegments(
  widthM: number,
  depthM: number,
  stepM: number,
): THREE.LineSegments {
  const halfW = widthM * 0.5;
  const halfD = depthM * 0.5;
  const countX = Math.floor(widthM / stepM) + 1;
  const countZ = Math.floor(depthM / stepM) + 1;

  // Внутренние линии сетки + 4 линии внешнего сигнального периметра
  const totalSegments = countX + countZ + 4;
  const positions = new Float32Array(totalSegments * 6);
  const colors = new Float32Array(totalSegments * 6);

  const gridMinor = new THREE.Color().setHex(0x334155, THREE.SRGBColorSpace);
  const gridAxis = new THREE.Color().setHex(0x475569, THREE.SRGBColorSpace);
  const perimeterAmber = new THREE.Color().setHex(0xd97706, THREE.SRGBColorSpace);

  let segIdx = 0;
  const y = 0.006;

  const pushSegment = (
    ax: number,
    az: number,
    bx: number,
    bz: number,
    col: THREE.Color,
  ): void => {
    const off = segIdx * 6;
    positions[off] = ax;
    positions[off + 1] = y;
    positions[off + 2] = az;
    positions[off + 3] = bx;
    positions[off + 4] = y;
    positions[off + 5] = bz;

    colors[off] = col.r;
    colors[off + 1] = col.g;
    colors[off + 2] = col.b;
    colors[off + 3] = col.r;
    colors[off + 4] = col.g;
    colors[off + 5] = col.b;
    segIdx += 1;
  };

  for (let ix = 0; ix < countX; ix++) {
    const x = -halfW + ix * stepM;
    const isCenter = Math.abs(x) < 1e-3;
    pushSegment(x, -halfD, x, halfD, isCenter ? gridAxis : gridMinor);
  }

  for (let iz = 0; iz < countZ; iz++) {
    const z = -halfD + iz * stepM;
    const isCenter = Math.abs(z) < 1e-3;
    pushSegment(-halfW, z, halfW, z, isCenter ? gridAxis : gridMinor);
  }

  // Внешний контур безопасности сейсмоплатформы (сигнальный янтарь)
  const pW = halfW - 0.08;
  const pD = halfD - 0.08;
  pushSegment(-pW, -pD, pW, -pD, perimeterAmber);
  pushSegment(pW, -pD, pW, pD, perimeterAmber);
  pushSegment(pW, pD, -pW, pD, perimeterAmber);
  pushSegment(-pW, pD, -pW, -pD, perimeterAmber);

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geom.setAttribute('color', new THREE.BufferAttribute(colors, 3));

  const mat = new THREE.LineBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 0.78,
  });

  const lines = new THREE.LineSegments(geom, mat);
  lines.name = 'SeismicPlatformGrid';
  lines.frustumCulled = false;
  return lines;
}

export class SceneRenderer {
  private readonly scene: THREE.Scene;
  private readonly fog: THREE.FogExp2;
  private readonly backgroundColor: THREE.Color;

  private readonly cameraRig: CameraRig;
  private readonly blockLayer: InstancedBlockLayer;
  private readonly shardLayer: BatchedShardLayer;
  private readonly rebarLayer: RebarAndJointLayer;
  private readonly vfxSystem: CollapseVFXSystem;

  private readonly hemiLight: THREE.HemisphereLight;
  private readonly sunLight: THREE.DirectionalLight;
  private readonly rimLight: THREE.DirectionalLight;
  private readonly blastFlashLight: THREE.PointLight;

  private readonly outerGroundGeometry: THREE.PlaneGeometry;
  private readonly outerGroundMaterial: THREE.MeshStandardMaterial;
  private readonly outerGroundMesh: THREE.Mesh;

  private readonly seismicPlatformGroup: THREE.Group;
  private readonly platformSlabGeometry: THREE.BoxGeometry;
  private readonly platformSlabMaterial: THREE.MeshStandardMaterial;
  private readonly platformSlabMesh: THREE.Mesh;
  private readonly platformGridLines: THREE.LineSegments;

  private webglRenderer: THREE.WebGLRenderer | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private boundWindowResize: (() => void) | null = null;

  private headless: boolean;
  private viewMode: RenderViewMode = 'pbr';
  private qualityPreset: QualityPreset;
  private viewportWidth: number;
  private viewportHeight: number;

  private readonly criticalNodeIds: Set<number> = new Set();
  private lastSnapshot: RenderSnapshot | null = null;
  private lastSafeTick = 0;
  private lastSafeSimTimeSec = 0;
  private elapsedVisualSec = 0;
  private blastFlashTimerSec = 0;
  private lastDrawCalls = 0;
  private disposed = false;

  constructor(options?: SceneRendererOptions) {
    this.qualityPreset = options?.quality ?? 'high';

    const initW = this.resolveInitialWidth(options);
    const initH = this.resolveInitialHeight(options);
    this.viewportWidth = initW;
    this.viewportHeight = initH;

    this.scene = new THREE.Scene();
    this.scene.name = 'ShatterpointProvingGroundScene';

    this.backgroundColor = new THREE.Color(BG_COLOR_PBR);
    this.scene.background = this.backgroundColor;
    this.fog = new THREE.FogExp2(BG_COLOR_PBR, 0.0042);
    this.scene.fog = this.fog;

    this.cameraRig = new CameraRig({
      aspect: initW / initH,
      seed: options?.seed,
    });
    this.cameraRig.resize(initW, initH);

    // Освещение строительного испытательного полигона
    this.hemiLight = new THREE.HemisphereLight(0xdbeafe, 0x1e293b, 0.84);
    this.scene.add(this.hemiLight);

    this.sunLight = new THREE.DirectionalLight(0xfffbeb, 1.95);
    this.sunLight.position.set(28, 44, 24);
    this.sunLight.shadow.camera.left = -32;
    this.sunLight.shadow.camera.right = 32;
    this.sunLight.shadow.camera.top = 32;
    this.sunLight.shadow.camera.bottom = -32;
    this.sunLight.shadow.camera.near = 2;
    this.sunLight.shadow.camera.far = 115;
    this.sunLight.shadow.bias = -0.0005;
    this.sunLight.shadow.normalBias = 0.025;
    this.scene.add(this.sunLight);
    this.scene.add(this.sunLight.target);

    this.rimLight = new THREE.DirectionalLight(0x93c5fd, 0.48);
    this.rimLight.position.set(-22, 20, -22);
    this.scene.add(this.rimLight);

    this.blastFlashLight = new THREE.PointLight(0xff8c1a, 0, 42, 1.6);
    this.blastFlashLight.castShadow = false;
    this.scene.add(this.blastFlashLight);

    // Внешний стапельный пол полигона
    this.outerGroundGeometry = new THREE.PlaneGeometry(180, 180);
    this.outerGroundGeometry.rotateX(-Math.PI * 0.5);
    this.outerGroundMaterial = new THREE.MeshStandardMaterial({
      color: 0x111822,
      roughness: 0.94,
      metalness: 0.05,
    });
    this.outerGroundMesh = new THREE.Mesh(this.outerGroundGeometry, this.outerGroundMaterial);
    this.outerGroundMesh.name = 'OuterProvingGroundFloor';
    this.outerGroundMesh.position.set(0, -0.62, 0);
    this.outerGroundMesh.castShadow = false;
    this.scene.add(this.outerGroundMesh);

    // Подвижная 3D-сейсмоплатформа (верхняя грань на y = 0.0 м)
    this.seismicPlatformGroup = new THREE.Group();
    this.seismicPlatformGroup.name = 'SeismicPlatformGroup';

    this.platformSlabGeometry = new THREE.BoxGeometry(48, 0.6, 36);
    this.platformSlabMaterial = new THREE.MeshStandardMaterial({
      color: 0x1e293b,
      roughness: 0.86,
      metalness: 0.14,
    });
    this.platformSlabMesh = new THREE.Mesh(
      this.platformSlabGeometry,
      this.platformSlabMaterial,
    );
    this.platformSlabMesh.name = 'SeismicPlatformSlab';
    this.platformSlabMesh.position.set(0, -0.3, 0);
    this.platformSlabMesh.castShadow = false;
    this.seismicPlatformGroup.add(this.platformSlabMesh);

    this.platformGridLines = createPlatformGridLineSegments(48, 36, 2);
    this.seismicPlatformGroup.add(this.platformGridLines);
    this.scene.add(this.seismicPlatformGroup);

    // Четыре батчинговых слоя разрушаемого мира
    this.blockLayer = new InstancedBlockLayer({
      quality: this.qualityPreset,
      seed: options?.seed,
    });
    this.shardLayer = new BatchedShardLayer({
      quality: this.qualityPreset,
    });
    this.rebarLayer = new RebarAndJointLayer();
    this.vfxSystem = new CollapseVFXSystem({
      quality: this.qualityPreset,
      seed: options?.seed,
    });

    this.scene.add(this.blockLayer.getObject3D());
    this.scene.add(this.shardLayer.getObject3D());
    this.scene.add(this.rebarLayer.getObject3D());
    this.scene.add(this.vfxSystem.getObject3D());

    // Безопасная инициализация WebGL2 или автоматический переход в Headless
    this.headless = true;
    if (options?.headless !== true && options?.canvas && typeof window !== 'undefined') {
      this.tryInitializeWebGL2(options.canvas);
    }

    this.applyQualitySettings();
    this.scene.updateMatrixWorld(true);
    this.lastDrawCalls = countActiveSceneDrawCalls(this.scene, this.areShadowsActive());
  }

  /**
   * Синхронизирует все слои 3D-рендера и положение сейсмоплатформы по снимку физического мира.
   */
  public syncSnapshot(snapshot: RenderSnapshot): void {
    if (this.disposed) return;

    const safeTick = Number.isFinite(snapshot.tick)
      ? clamp(Math.trunc(snapshot.tick), 0, 1e12)
      : this.lastSafeTick;
    const safeSimTimeSec = Number.isFinite(snapshot.simTimeSec)
      ? clamp(snapshot.simTimeSec, 0, 1e6)
      : this.lastSafeSimTimeSec;

    // Автоочистка частиц и тряски при сбросе сцены назад во времени
    if (this.lastSnapshot !== null && safeTick < this.lastSafeTick) {
      this.vfxSystem.clear();
      this.cameraRig.resetShake();
      this.blastFlashTimerSec = 0;
      this.blastFlashLight.intensity = 0;
    }

    this.lastSnapshot = snapshot;
    this.lastSafeTick = safeTick;
    this.lastSafeSimTimeSec = safeSimTimeSec;

    const [px, py, pz] = snapshot.platformOffset;
    this.seismicPlatformGroup.position.set(
      Number.isFinite(px) ? clamp(px, -1e4, 1e4) : 0,
      Number.isFinite(py) ? clamp(py, -1e4, 1e4) : 0,
      Number.isFinite(pz) ? clamp(pz, -1e4, 1e4) : 0,
    );

    this.blockLayer.syncBlocks(snapshot.blocks, safeSimTimeSec);
    this.shardLayer.syncShards(snapshot.shards);
    this.rebarLayer.sync(
      snapshot,
      this.viewMode,
      this.criticalNodeIds,
      safeSimTimeSec + this.elapsedVisualSec,
    );

    if (this.headless) {
      this.scene.updateMatrixWorld(true);
      this.lastDrawCalls = countActiveSceneDrawCalls(this.scene, this.areShadowsActive());
    }
  }

  /**
   * Задаёт список критических несущих опор для тактической подсветки в режимах 'stress' и 'xray'.
   * Немедленно перестраивает визуальное состояние даже на паузе!
   */
  public setCriticalNodes(nodeIds: number[]): void {
    if (this.disposed) return;

    this.criticalNodeIds.clear();
    for (let i = 0; i < nodeIds.length; i++) {
      const id = nodeIds[i]!;
      if (Number.isFinite(id)) {
        this.criticalNodeIds.add(id);
      }
    }

    this.blockLayer.setCriticalNodes(this.criticalNodeIds);
    if (this.lastSnapshot !== null) {
      this.rebarLayer.sync(
        this.lastSnapshot,
        this.viewMode,
        this.criticalNodeIds,
        this.lastSafeSimTimeSec + this.elapsedVisualSec,
      );
    }

    if (this.headless) {
      this.scene.updateMatrixWorld(true);
      this.lastDrawCalls = countActiveSceneDrawCalls(this.scene, this.areShadowsActive());
    }
  }

  /**
   * Передаёт события разрушения в систему частиц VFX, физическую тряску камеры и вспышечный свет.
   */
  public consumeEvents(events: SimulationEvent[]): void {
    if (this.disposed || events.length === 0) return;

    this.vfxSystem.consumeEvents(events);
    this.cameraRig.consumeEvents(events);

    for (let i = 0; i < events.length; i++) {
      const ev = events[i]!;
      if (ev.type === 'explosion') {
        const [ex, ey, ez] = ev.position;
        if (Number.isFinite(ex) && Number.isFinite(ey) && Number.isFinite(ez)) {
          this.blastFlashLight.position.set(
            clamp(ex, -1e4, 1e4),
            clamp(ey, -1e4, 1e4) + 0.6,
            clamp(ez, -1e4, 1e4),
          );
          const safeTnt = Number.isFinite(ev.equivalentKgTnt)
            ? clamp(ev.equivalentKgTnt, 0, 1e9)
            : 0;
          const peakIntensity = clamp(
            4.5 * Math.cbrt(Math.max(1, safeTnt)) * (ev.isChainDetonation ? 1.25 : 1.0),
            3.0,
            18.0,
          );
          this.blastFlashLight.intensity = Math.max(this.blastFlashLight.intensity, peakIntensity);
          this.blastFlashTimerSec = 0.24;
        }
      }
    }

    if (this.headless) {
      this.scene.updateMatrixWorld(true);
      this.lastDrawCalls = countActiveSceneDrawCalls(this.scene, this.areShadowsActive());
    }
  }

  /**
   * Переключает режим визуализации ('pbr' | 'stress' | 'xray') и мгновенно перекрашивает сцену даже на паузе.
   */
  public setViewMode(mode: RenderViewMode): void {
    if (this.disposed) return;

    this.viewMode = mode;

    if (mode === 'stress') {
      this.backgroundColor.setHex(BG_COLOR_STRESS);
      this.fog.color.setHex(BG_COLOR_STRESS);
      this.fog.density = 0.0035;
      this.outerGroundMaterial.color.setHex(0x0c131c);
      this.platformSlabMaterial.color.setHex(0x16202c);
    } else if (mode === 'xray') {
      this.backgroundColor.setHex(BG_COLOR_XRAY);
      this.fog.color.setHex(BG_COLOR_XRAY);
      this.fog.density = 0.0016;
      this.outerGroundMaterial.color.setHex(0x070d14);
      this.platformSlabMaterial.color.setHex(0x0d1722);
    } else {
      this.backgroundColor.setHex(BG_COLOR_PBR);
      this.fog.color.setHex(BG_COLOR_PBR);
      this.fog.density = 0.0042;
      this.outerGroundMaterial.color.setHex(0x111822);
      this.platformSlabMaterial.color.setHex(0x1e293b);
    }

    this.blockLayer.setViewMode(mode);
    this.shardLayer.setViewMode(mode);
    this.rebarLayer.setViewMode(mode);
    this.applyShadowMapFlag();

    if (this.lastSnapshot !== null) {
      this.rebarLayer.sync(
        this.lastSnapshot,
        this.viewMode,
        this.criticalNodeIds,
        this.lastSafeSimTimeSec + this.elapsedVisualSec,
      );
    }

    if (this.headless) {
      this.scene.updateMatrixWorld(true);
      this.lastDrawCalls = countActiveSceneDrawCalls(this.scene, this.areShadowsActive());
    }
  }

  /**
   * Меняет пресет качества ('performance' | 'high' | 'ultra') на живом рендерере без потери WebGL-контекста.
   */
  public setQualityPreset(preset: QualityPreset): void {
    if (this.disposed) return;

    this.qualityPreset = preset;
    this.blockLayer.setQualityPreset(preset);
    this.shardLayer.setQualityPreset(preset);
    this.rebarLayer.setQualityPreset(preset);
    this.vfxSystem.setQualityPreset(preset);
    this.applyQualitySettings();

    if (this.headless) {
      this.lastDrawCalls = countActiveSceneDrawCalls(this.scene, this.areShadowsActive());
    }
  }

  /**
   * Обновляет анимации камеры, света и частиц и рендерит очередной кадр.
   */
  public renderFrame(dtRealSec: number): void {
    if (this.disposed) return;

    const safeDt = Number.isFinite(dtRealSec) && dtRealSec > 0 ? Math.min(0.25, dtRealSec) : 0;
    this.elapsedVisualSec = (this.elapsedVisualSec + safeDt) % 86400;

    if (safeDt > 0) {
      this.cameraRig.update(safeDt);
      this.blockLayer.updateAnimation(safeDt);

      if (this.lastSnapshot !== null && this.lastSnapshot.blocks.length > 0) {
        this.vfxSystem.syncBurningBlocks(this.lastSnapshot.blocks, safeDt);
      }
      this.vfxSystem.update(safeDt);

      if (this.blastFlashTimerSec > 0) {
        this.blastFlashTimerSec = Math.max(0, this.blastFlashTimerSec - safeDt);
        const ratio = this.blastFlashTimerSec / 0.24;
        this.blastFlashLight.intensity *= ratio;
        if (this.blastFlashTimerSec <= 0) {
          this.blastFlashLight.intensity = 0;
        }
      }
    }

    if (this.webglRenderer && !this.headless) {
      const gl = this.webglRenderer.getContext();
      if (!gl.isContextLost()) {
        this.syncCanvasSizeIfNeeded();
        this.webglRenderer.render(this.scene, this.cameraRig.camera);
        const hwCalls = this.webglRenderer.info.render.calls;
        this.lastDrawCalls =
          hwCalls > 0
            ? hwCalls
            : countActiveSceneDrawCalls(this.scene, this.areShadowsActive());
        return;
      }
    }

    // Честный расчёт мировых матриц и активных Draw Calls в Headless-режиме
    this.scene.updateMatrixWorld(true);
    this.lastDrawCalls = countActiveSceneDrawCalls(this.scene, this.areShadowsActive());
  }

  public screenPointToRay(
    ndcX: number,
    ndcY: number,
  ): { origin: [number, number, number]; direction: [number, number, number] } {
    return this.cameraRig.screenPointToRay(ndcX, ndcY);
  }

  public projectWorldToScreen(
    worldPos: [number, number, number],
  ): { x: number; y: number; visible: boolean } {
    if (this.canvas && typeof this.canvas.getBoundingClientRect === 'function') {
      const rect = this.canvas.getBoundingClientRect();
      if (
        Number.isFinite(rect.width) &&
        Number.isFinite(rect.height) &&
        rect.width > 0 &&
        rect.height > 0
      ) {
        return this.cameraRig.projectWorldToScreen(
          worldPos,
          rect.width,
          rect.height,
          rect.left,
          rect.top,
        );
      }
    }
    return this.cameraRig.projectWorldToScreen(
      worldPos,
      this.viewportWidth,
      this.viewportHeight,
      0,
      0,
    );
  }

  /**
   * Переводит клиентские координаты указателя (clientX, clientY) в нормализованные координаты устройства NDC [-1..1].
   */
  public clientPointToNdc(clientX: number, clientY: number): [number, number] {
    if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) {
      return [0, 0];
    }

    let left = 0;
    let top = 0;
    let width = this.viewportWidth;
    let height = this.viewportHeight;

    if (this.canvas && typeof this.canvas.getBoundingClientRect === 'function') {
      const rect = this.canvas.getBoundingClientRect();
      if (
        Number.isFinite(rect.width) &&
        Number.isFinite(rect.height) &&
        rect.width > 0 &&
        rect.height > 0 &&
        Number.isFinite(rect.left) &&
        Number.isFinite(rect.top)
      ) {
        left = rect.left;
        top = rect.top;
        width = rect.width;
        height = rect.height;
      }
    }

    const safeClientX = clamp(clientX, -1e6, 1e6);
    const safeClientY = clamp(clientY, -1e6, 1e6);
    const ndcX = ((safeClientX - left) / Math.max(1, width)) * 2 - 1;
    const ndcY = -(((safeClientY - top) / Math.max(1, height)) * 2 - 1);
    return [
      Number.isFinite(ndcX) ? clamp(ndcX, -1, 1) : 0,
      Number.isFinite(ndcY) ? clamp(ndcY, -1, 1) : 0,
    ];
  }

  public focusOnBounds(center: [number, number, number], radiusM: number): void {
    this.cameraRig.focusOnBounds(center, radiusM);
  }

  public resize(width: number, height: number): void {
    if (this.disposed) return;

    const safeW =
      Number.isFinite(width) && width > 1 ? clamp(Math.round(width), 2, 16384) : 1280;
    const safeH =
      Number.isFinite(height) && height > 1 ? clamp(Math.round(height), 2, 16384) : 720;
    this.viewportWidth = safeW;
    this.viewportHeight = safeH;
    this.cameraRig.resize(safeW, safeH);

    if (this.webglRenderer && !this.headless) {
      this.webglRenderer.setSize(safeW, safeH, false);
    }
  }

  public getDrawCallsCount(): number {
    return this.lastDrawCalls;
  }

  public getCameraRig(): CameraRig {
    return this.cameraRig;
  }

  public getViewMode(): RenderViewMode {
    return this.viewMode;
  }

  public getQualityPreset(): QualityPreset {
    return this.qualityPreset;
  }

  public isHeadless(): boolean {
    return this.headless;
  }

  public getScene(): THREE.Scene {
    return this.scene;
  }

  public getSeismicPlatformGroup(): THREE.Group {
    return this.seismicPlatformGroup;
  }

  public getLayers(): {
    blockLayer: InstancedBlockLayer;
    shardLayer: BatchedShardLayer;
    rebarLayer: RebarAndJointLayer;
    vfxSystem: CollapseVFXSystem;
  } {
    return {
      blockLayer: this.blockLayer,
      shardLayer: this.shardLayer,
      rebarLayer: this.rebarLayer,
      vfxSystem: this.vfxSystem,
    };
  }

  /**
   * Идемпотентно освобождает все GPU-ресурсы, наблюдатели размеров и слушатели событий.
   */
  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }

    if (this.boundWindowResize && typeof window !== 'undefined') {
      window.removeEventListener('resize', this.boundWindowResize);
      this.boundWindowResize = null;
    }

    this.cameraRig.dispose();
    this.blockLayer.dispose();
    this.shardLayer.dispose();
    this.rebarLayer.dispose();
    this.vfxSystem.dispose();

    this.outerGroundGeometry.dispose();
    this.outerGroundMaterial.dispose();
    this.platformSlabGeometry.dispose();
    this.platformSlabMaterial.dispose();
    this.platformGridLines.geometry.dispose();
    if (this.platformGridLines.material instanceof THREE.Material) {
      this.platformGridLines.material.dispose();
    }

    if (this.sunLight.shadow.map) {
      this.sunLight.shadow.map.dispose();
      this.sunLight.shadow.map = null;
    }

    if (this.webglRenderer) {
      this.webglRenderer.dispose();
      this.webglRenderer = null;
    }

    this.canvas = null;
    this.lastSnapshot = null;
    this.lastDrawCalls = 0;
  }

  private resolveInitialWidth(options?: SceneRendererOptions): number {
    if (options?.width !== undefined && Number.isFinite(options.width) && options.width > 1) {
      return clamp(Math.round(options.width), 2, 16384);
    }
    const c = options?.canvas;
    if (c) {
      if (Number.isFinite(c.clientWidth) && c.clientWidth > 1) {
        return clamp(Math.round(c.clientWidth), 2, 16384);
      }
      if (Number.isFinite(c.width) && c.width > 1) {
        return clamp(Math.round(c.width), 2, 16384);
      }
    }
    return 1280;
  }

  private resolveInitialHeight(options?: SceneRendererOptions): number {
    if (options?.height !== undefined && Number.isFinite(options.height) && options.height > 1) {
      return clamp(Math.round(options.height), 2, 16384);
    }
    const c = options?.canvas;
    if (c) {
      if (Number.isFinite(c.clientHeight) && c.clientHeight > 1) {
        return clamp(Math.round(c.clientHeight), 2, 16384);
      }
      if (Number.isFinite(c.height) && c.height > 1) {
        return clamp(Math.round(c.height), 2, 16384);
      }
    }
    return 720;
  }

  private tryInitializeWebGL2(canvas: HTMLCanvasElement): void {
    try {
      const preferAntialias = this.qualityPreset !== 'performance';
      let gl = canvas.getContext('webgl2', {
        antialias: preferAntialias,
        alpha: false,
        depth: true,
        stencil: false,
        powerPreference: 'high-performance',
      });
      if (!gl && preferAntialias) {
        gl = canvas.getContext('webgl2', {
          antialias: false,
          alpha: false,
          depth: true,
          stencil: false,
        });
      }

      if (!gl) {
        this.headless = true;
        return;
      }

      const renderer = new THREE.WebGLRenderer({
        canvas,
        context: gl,
        antialias: preferAntialias,
        powerPreference: 'high-performance',
      });

      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.08;
      renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      renderer.setSize(this.viewportWidth, this.viewportHeight, false);

      this.webglRenderer = renderer;
      this.canvas = canvas;
      this.headless = false;

      this.cameraRig.attachCanvas(canvas);

      if (typeof ResizeObserver !== 'undefined') {
        this.resizeObserver = new ResizeObserver((entries) => {
          for (let i = 0; i < entries.length; i++) {
            const cr = entries[i]!.contentRect;
            if (cr.width > 4 && cr.height > 4) {
              this.resize(cr.width, cr.height);
            }
          }
        });
        this.resizeObserver.observe(canvas);
      } else if (typeof window !== 'undefined') {
        this.boundWindowResize = () => {
          if (this.canvas) {
            const w = this.canvas.clientWidth || this.viewportWidth;
            const h = this.canvas.clientHeight || this.viewportHeight;
            this.resize(w, h);
          }
        };
        window.addEventListener('resize', this.boundWindowResize);
      }
    } catch {
      this.webglRenderer = null;
      this.headless = true;
    }
  }

  private syncCanvasSizeIfNeeded(): void {
    if (!this.canvas || !this.webglRenderer) return;
    const cw = this.canvas.clientWidth;
    const ch = this.canvas.clientHeight;
    if (
      cw > 4 &&
      ch > 4 &&
      (Math.abs(cw - this.viewportWidth) >= 2 || Math.abs(ch - this.viewportHeight) >= 2)
    ) {
      this.resize(cw, ch);
    }
  }

  private areShadowsActive(): boolean {
    return this.qualityPreset !== 'performance' && this.viewMode !== 'xray';
  }

  private applyShadowMapFlag(): void {
    const shadowsOn = this.areShadowsActive();
    this.sunLight.castShadow = shadowsOn;
    this.outerGroundMesh.receiveShadow = shadowsOn;
    this.platformSlabMesh.receiveShadow = shadowsOn;

    if (this.webglRenderer) {
      this.webglRenderer.shadowMap.enabled = shadowsOn;
      this.webglRenderer.shadowMap.needsUpdate = true;
    }
  }

  private applyQualitySettings(): void {
    const shadowsOn = this.areShadowsActive();
    const targetShadowSize = this.qualityPreset === 'ultra' ? 2048 : 1536;

    if (
      this.sunLight.shadow.mapSize.x !== targetShadowSize ||
      this.sunLight.shadow.mapSize.y !== targetShadowSize
    ) {
      if (this.sunLight.shadow.map) {
        this.sunLight.shadow.map.dispose();
        this.sunLight.shadow.map = null;
      }
      this.sunLight.shadow.mapSize.set(targetShadowSize, targetShadowSize);
    }

    this.sunLight.castShadow = shadowsOn;
    this.outerGroundMesh.receiveShadow = shadowsOn;
    this.platformSlabMesh.receiveShadow = shadowsOn;

    if (this.webglRenderer) {
      const deviceDpr =
        typeof window !== 'undefined' && Number.isFinite(window.devicePixelRatio)
          ? window.devicePixelRatio
          : 1;
      const maxDpr =
        this.qualityPreset === 'performance'
          ? 1.0
          : this.qualityPreset === 'high'
            ? 1.5
            : 2.0;

      this.webglRenderer.setPixelRatio(Math.min(Math.max(1, deviceDpr), maxDpr));
      this.webglRenderer.setSize(this.viewportWidth, this.viewportHeight, false);
      this.webglRenderer.shadowMap.enabled = shadowsOn;
      this.webglRenderer.shadowMap.type = THREE.PCFSoftShadowMap;
      this.webglRenderer.shadowMap.needsUpdate = true;
    }
  }
}
