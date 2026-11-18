import * as THREE from 'three';
import { clamp } from '../core/math3d';
import { SeededRng } from '../core/rng';
import {
  DEFAULT_SEED,
  STRUCTURAL_MATERIAL_IDS,
  type QualityPreset,
  type RenderBlockInstance,
  type RenderViewMode,
  type StructuralMaterialId,
} from '../core/types';
import { getMaterialProfile } from '../physics/MaterialRegistry';

/**
 * Инстансированный слой рендеринга целых конструктивных блоков сооружений (THREE.InstancedMesh).
 * Поддерживает 6 физических материалов с процедурными DataTexture (совместимо с WebGL2 и Node.js),
 * визуализацию трещин (damageRatio), обугливания (charRatio), каления по температуре (temperatureC),
 * инженерную тепловую карту напряжений, голографический рентген и 3D-рамки критических несущих опор.
 */

export interface BlockLayerDiagnostics {
  totalBlocks: number;
  activeMaterialSlots: number;
  criticalHighlightsCount: number;
  countsByMaterial: Record<StructuralMaterialId, number>;
  capacitiesByMaterial: Record<StructuralMaterialId, number>;
  estimatedDrawCalls: number;
}

interface MaterialTexturesPair {
  albedoMap: THREE.DataTexture;
  bumpMap: THREE.DataTexture;
}

interface MaterialInstancedSlot {
  readonly materialId: StructuralMaterialId;
  readonly textures: MaterialTexturesPair;
  readonly materials: Record<RenderViewMode, THREE.Material>;
  mesh: THREE.InstancedMesh;
  capacity: number;
  activeCount: number;
}

const INITIAL_SLOT_CAPACITY = 512;
const INITIAL_CRITICAL_CAPACITY = 128;
const TEXTURE_SIZE = 64;

// Внутренние переиспользуемые объекты для полного отсутствия аллокаций в горячем цикле
const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _scale = new THREE.Vector3();
const _mat4 = new THREE.Matrix4();
const _workColor = new THREE.Color();
const _cutColor = new THREE.Color();
const _charTargetColor = new THREE.Color().setRGB(0.018, 0.016, 0.013, THREE.LinearSRGBColorSpace);

function sanitizeCoord(v: number, fallback = 0): number {
  return Number.isFinite(v) ? clamp(v, -1e5, 1e5) : fallback;
}

function sanitizeHalfExtent(v: number, fallback = 0.5): number {
  return Number.isFinite(v) ? clamp(v, 1e-4, 1e4) : fallback;
}

function sanitizeFinite(v: number, min: number, max: number, fallback: number): number {
  return Number.isFinite(v) ? clamp(v, min, max) : fallback;
}

function sanitizeQuaternionInto(
  out: THREE.Quaternion,
  q: readonly [number, number, number, number],
): THREE.Quaternion {
  const qx = q[0];
  const qy = q[1];
  const qz = q[2];
  const qw = q[3];
  if (
    !Number.isFinite(qx) ||
    !Number.isFinite(qy) ||
    !Number.isFinite(qz) ||
    !Number.isFinite(qw)
  ) {
    return out.set(0, 0, 0, 1);
  }
  const maxAbs = Math.max(Math.abs(qx), Math.abs(qy), Math.abs(qz), Math.abs(qw));
  if (maxAbs < 1e-12) {
    return out.set(0, 0, 0, 1);
  }
  const invMax = 1 / maxAbs;
  const nx = qx * invMax;
  const ny = qy * invMax;
  const nz = qz * invMax;
  const nw = qw * invMax;
  const len = Math.hypot(nx, ny, nz, nw);
  if (!Number.isFinite(len) || len <= 1e-12) {
    return out.set(0, 0, 0, 1);
  }
  const invLen = 1 / len;
  return out.set(nx * invLen, ny * invLen, nz * invLen, nw * invLen);
}

// Узловые точки инженерной тепловой шкалы напряжений в sRGB [0..1] (строго без фиолетового спектра!)
const STRESS_HEATMAP_STOPS: ReadonlyArray<readonly [u: number, r: number, g: number, b: number]> = [
  [0.0, 30 / 255, 77 / 255, 92 / 255],    // #1e4d5c — холодный бирюзово-сланцевый покой (Hue ~195°)
  [0.25, 13 / 255, 148 / 255, 136 / 255], // #0d9488 — малая рабочая нагрузка (Hue ~175°)
  [0.5, 16 / 255, 185 / 255, 129 / 255],  // #10b981 — штатная изумрудная нагрузка (Hue ~160°)
  [0.64, 132 / 255, 204 / 255, 22 / 255], // #84cc16 — оливково-лаймовый переход (Hue ~84°, B погашен!)
  [0.8, 245 / 255, 158 / 255, 11 / 255],  // #f59e0b — сигнальный янтарь предразрушения (Hue ~38°)
  [1.0, 239 / 255, 68 / 255, 56 / 255],   // #ef4438 — сигнальный алый предел прочности (Hue ~3°)
];

/**
 * Вычисляет цвет инженерной тепловой карты механических напряжений без единого захода в фиолетовый спектр.
 */
export function sampleStressHeatmapColor(
  stressUtilization: number,
  target: THREE.Color = new THREE.Color(),
): THREE.Color {
  const safeU = sanitizeFinite(stressUtilization, 0, 10, 0);

  if (safeU <= 0) {
    const first = STRESS_HEATMAP_STOPS[0]!;
    return target.setRGB(first[1], first[2], first[3], THREE.SRGBColorSpace);
  }

  if (safeU >= 1.0) {
    const last = STRESS_HEATMAP_STOPS[STRESS_HEATMAP_STOPS.length - 1]!;
    target.setRGB(last[1], last[2], last[3], THREE.SRGBColorSpace);
    if (safeU > 1.0) {
      const over = clamp((safeU - 1.0) / 0.35, 0, 1);
      const rLin = target.r + (1.85 - target.r) * over;
      const gLin = target.g + (0.24 - target.g) * over;
      const bLin = target.b + (0.03 - target.b) * over;
      target.setRGB(rLin, gLin, bLin, THREE.LinearSRGBColorSpace);
    }
    return target;
  }

  for (let i = 0; i < STRESS_HEATMAP_STOPS.length - 1; i++) {
    const a = STRESS_HEATMAP_STOPS[i]!;
    const b = STRESS_HEATMAP_STOPS[i + 1]!;
    if (safeU >= a[0] && safeU <= b[0]) {
      const span = b[0] - a[0];
      const t = span > 1e-6 ? (safeU - a[0]) / span : 0;
      const sr = a[1] + (b[1] - a[1]) * t;
      const sg = a[2] + (b[2] - a[2]) * t;
      const sb = a[3] + (b[3] - a[3]) * t;
      return target.setRGB(sr, sg, sb, THREE.SRGBColorSpace);
    }
  }

  const fallback = STRESS_HEATMAP_STOPS[STRESS_HEATMAP_STOPS.length - 1]!;
  return target.setRGB(fallback[1], fallback[2], fallback[3], THREE.SRGBColorSpace);
}

/**
 * Возвращает аддитивную компоненту теплового свечения накала в Linear-пространстве при T > 420°C.
 * Все компоненты строго подчиняются R >= G >= B >= 0 (эмиссия абсолютно чёрного тела без пурпура).
 */
export function computeThermalGlowAdditiveLinear(
  materialId: StructuralMaterialId,
  temperatureC: number,
): [number, number, number] {
  if (!Number.isFinite(temperatureC) || temperatureC <= 420) {
    return [0, 0, 0];
  }

  const safeTemp = clamp(temperatureC, 420, 5000);
  const emissivity =
    materialId === 'steel' ? 1.0 : materialId === 'explosive' ? 0.85 : 0.65;

  let r = 0;
  let g = 0;
  let b = 0;

  if (safeTemp <= 600) {
    const t = (safeTemp - 420) / 180;
    r = 0.48 * t;
    g = 0.06 * t;
    b = 0.004 * t;
  } else if (safeTemp <= 900) {
    const t = (safeTemp - 600) / 300;
    r = 0.48 + (1.45 - 0.48) * t;
    g = 0.06 + (0.44 - 0.06) * t;
    b = 0.004 + (0.03 - 0.004) * t;
  } else {
    const t = clamp((safeTemp - 900) / 300, 0, 1.5);
    r = 1.45 + 0.95 * t;
    g = 0.44 + 0.72 * t;
    b = 0.03 + 0.16 * t;
  }

  return [r * emissivity, g * emissivity, b * emissivity];
}

/**
 * Вычисляет итоговый инстансный цвет конструктивного блока в заданном режиме визуализации.
 */
export function computeBlockInstanceColor(
  block: RenderBlockInstance,
  viewMode: RenderViewMode,
  simTimeSec: number,
  target: THREE.Color = new THREE.Color(),
): THREE.Color {
  const safeTime = sanitizeFinite(simTimeSec, -1e5, 1e5, 0);
  const safeStress = sanitizeFinite(block.stressUtilization, 0, 10, 0);

  if (viewMode === 'stress') {
    if (block.structureGroupTag === 'protected' && safeStress < 0.35) {
      target.setRGB(16 / 255, 185 / 255, 129 / 255, THREE.SRGBColorSpace);
      if (safeStress > 0.15) {
        const blend = (safeStress - 0.15) / 0.2;
        sampleStressHeatmapColor(safeStress, _cutColor);
        target.lerp(_cutColor, blend);
      }
      return target;
    }
    return sampleStressHeatmapColor(safeStress, target);
  }

  if (viewMode === 'xray') {
    if (block.structureGroupTag === 'protected') {
      return target.setRGB(0.05, 0.42, 0.26, THREE.LinearSRGBColorSpace);
    }
    // Голографическая сланцево-бирюзовая оболочка, теплеющая через оливковый к янтарному при перегрузке
    if (safeStress <= 0.65) {
      return target.setRGB(0.12, 0.30, 0.36, THREE.LinearSRGBColorSpace);
    }
    if (safeStress <= 0.85) {
      const t = (safeStress - 0.65) / 0.2;
      return target.setRGB(
        0.12 + (0.34 - 0.12) * t,
        0.30 + (0.46 - 0.30) * t,
        0.36 + (0.06 - 0.36) * t,
        THREE.LinearSRGBColorSpace,
      );
    }
    const t = clamp((safeStress - 0.85) / 0.3, 0, 1);
    return target.setRGB(
      0.34 + (0.78 - 0.34) * t,
      0.46 + (0.38 - 0.46) * t,
      0.06 + (0.03 - 0.06) * t,
      THREE.LinearSRGBColorSpace,
    );
  }

  // Режим 'pbr' — физический цвет материала + повреждения + обугливание + огонь + накал
  const profile = getMaterialProfile(block.materialId);
  target.setHex(profile.baseColorHex, THREE.SRGBColorSpace);

  const dmg = Number.isFinite(block.damageRatio) ? clamp(block.damageRatio, 0, 1) : 0;
  if (dmg > 0) {
    _cutColor.setHex(profile.interiorCutColorHex, THREE.SRGBColorSpace);
    target.lerp(_cutColor, dmg * 0.45);
    target.multiplyScalar(1 - dmg * 0.24);
  }

  const charRatio = Number.isFinite(block.charRatio) ? clamp(block.charRatio, 0, 1) : 0;
  if (charRatio > 0) {
    target.lerp(_charTargetColor, clamp(charRatio * 0.92, 0, 0.92));
  }

  const tempC = sanitizeFinite(block.temperatureC, -273.15, 5000, 20);
  const hasThermalEmission = block.burning || tempC > 420;

  if (hasThermalEmission) {
    // Гасим избыток холодного синего отражения (например, у стекла) перед добавлением красного накала,
    // чтобы исключить смешение синего и красного в пурпурный оттенок
    const heatAtten = block.burning
      ? 0.88
      : clamp((tempC - 420) / 240, 0, 0.92);
    if (target.b > target.g * 0.82) {
      target.b = target.b + (target.g * 0.72 - target.b) * heatAtten;
    }
  }

  if (block.burning) {
    const safeNodePhase = Number.isFinite(block.nodeId) ? (block.nodeId % 1024) * 1.37 : 0;
    const pulse = 0.68 + 0.32 * Math.sin(safeTime * 9.5 + safeNodePhase);
    target.r += 0.78 * pulse;
    target.g += 0.24 * pulse;
    target.b += 0.02 * pulse;
  }

  if (tempC > 420) {
    const [gr, gg, gb] = computeThermalGlowAdditiveLinear(block.materialId, tempC);
    target.r += gr;
    target.g += gg;
    target.b += gb;
  }

  return target;
}

/**
 * Генерирует пару процедурных тайловых текстур (albedo + bump) 64x64 для заданного материала.
 * Полностью детерминировано через SeededRng и работает без DOM/Canvas (чистый Uint8Array DataTexture).
 */
function createProceduralMaterialTextures(
  materialId: StructuralMaterialId,
  rng: SeededRng,
): MaterialTexturesPair {
  const pixelCount = TEXTURE_SIZE * TEXTURE_SIZE;
  const albedoBytes = new Uint8Array(pixelCount * 4);
  const bumpBytes = new Uint8Array(pixelCount * 4);

  for (let y = 0; y < TEXTURE_SIZE; y++) {
    for (let x = 0; x < TEXTURE_SIZE; x++) {
      const idx = (y * TEXTURE_SIZE + x) * 4;
      const grain = rng.range(-1, 1);

      let lum = 236;
      let bump = 128;
      let rTint = 1.0;
      let gTint = 1.0;
      let bTint = 1.0;

      switch (materialId) {
        case 'reinforced_concrete': {
          const seamY = y % 16 === 0 ? -18 : 0;
          const tieHole =
            (x === 16 || x === 48) && (y === 8 || y === 24 || y === 40 || y === 56) ? -28 : 0;
          lum = clamp(Math.round(235 + grain * 14 + seamY + tieHole), 180, 255);
          bump = clamp(Math.round(128 + grain * 28 + seamY * 2 + tieHole * 2), 30, 235);
          break;
        }
        case 'brick': {
          const row = Math.floor(y / 8);
          const isMortarH = y % 8 === 0;
          const offsetX = (row % 2) * 8;
          const isMortarV = (x + offsetX) % 16 === 0;
          if (isMortarH || isMortarV) {
            lum = clamp(Math.round(212 + grain * 8), 190, 235);
            bump = 78;
            rTint = 0.96;
            gTint = 0.96;
            bTint = 0.92;
          } else {
            lum = clamp(Math.round(238 + grain * 16), 198, 255);
            bump = clamp(Math.round(145 + grain * 24), 100, 220);
          }
          break;
        }
        case 'glass': {
          const diag = (x + y) % 32;
          const sheen = diag === 0 || diag === 1 ? 14 : diag === 12 ? 8 : 0;
          lum = clamp(Math.round(240 + sheen + grain * 2), 232, 255);
          bump = 128;
          break;
        }
        case 'wood': {
          const wave = Math.sin(y * 0.55 + Math.sin(x * 0.14) * 1.6);
          const fiber = wave * 16 + grain * 7;
          lum = clamp(Math.round(234 + fiber), 192, 255);
          bump = clamp(Math.round(128 + fiber * 2.1), 50, 215);
          break;
        }
        case 'steel': {
          const rib = x % 16 === 0 || y % 16 === 0 ? -14 : 0;
          const isRivet =
            ((x === 3 || x === 60) && y % 8 === 4) ||
            ((y === 3 || y === 60) && x % 8 === 4);
          const rivetDelta = isRivet ? 18 : 0;
          lum = clamp(Math.round(236 + rib + rivetDelta + grain * 5), 195, 255);
          bump = clamp(Math.round(128 + rib * 2 + (isRivet ? 64 : 0) + grain * 8), 45, 245);
          break;
        }
        case 'explosive': {
          const inHazardBand = y >= 24 && y <= 39;
          if (inHazardBand) {
            const stripe = ((x + y) >> 3) & 1;
            if (stripe === 0) {
              // Сигнальная жёлто-янтарная диагональ без малейшего синего/фиолетового тона
              lum = 250;
              rTint = 1.0;
              gTint = 0.92;
              bTint = 0.35;
              bump = 142;
            } else {
              lum = 128;
              rTint = 0.95;
              gTint = 0.92;
              bTint = 0.85;
              bump = 118;
            }
          } else {
            const ring = y === 10 || y === 53 ? 14 : 0;
            lum = clamp(Math.round(236 + ring + grain * 7), 195, 255);
            bump = clamp(Math.round(128 + ring * 3 + grain * 10), 70, 220);
          }
          break;
        }
      }

      albedoBytes[idx] = clamp(Math.round(lum * rTint), 0, 255);
      albedoBytes[idx + 1] = clamp(Math.round(lum * gTint), 0, 255);
      albedoBytes[idx + 2] = clamp(Math.round(lum * bTint), 0, 255);
      albedoBytes[idx + 3] = 255;

      bumpBytes[idx] = bump;
      bumpBytes[idx + 1] = bump;
      bumpBytes[idx + 2] = bump;
      bumpBytes[idx + 3] = 255;
    }
  }

  const albedoMap = new THREE.DataTexture(
    albedoBytes,
    TEXTURE_SIZE,
    TEXTURE_SIZE,
    THREE.RGBAFormat,
    THREE.UnsignedByteType,
  );
  albedoMap.wrapS = THREE.RepeatWrapping;
  albedoMap.wrapT = THREE.RepeatWrapping;
  albedoMap.magFilter = THREE.LinearFilter;
  albedoMap.minFilter = THREE.LinearMipmapLinearFilter;
  albedoMap.generateMipmaps = true;
  albedoMap.colorSpace = THREE.SRGBColorSpace;
  albedoMap.needsUpdate = true;

  const bumpMap = new THREE.DataTexture(
    bumpBytes,
    TEXTURE_SIZE,
    TEXTURE_SIZE,
    THREE.RGBAFormat,
    THREE.UnsignedByteType,
  );
  bumpMap.wrapS = THREE.RepeatWrapping;
  bumpMap.wrapT = THREE.RepeatWrapping;
  bumpMap.magFilter = THREE.LinearFilter;
  bumpMap.minFilter = THREE.LinearFilter;
  bumpMap.colorSpace = THREE.NoColorSpace;
  bumpMap.needsUpdate = true;

  return { albedoMap, bumpMap };
}

/**
 * Создаёт объединённую 3D-геометрию объёмной тактической реберной рамки (12 планок вдоль рёбер куба)
 * для наглядной подсветки критических несущих опор в режимах 'stress' и 'xray' за 1 Draw Call.
 */
function createCriticalBracketCageGeometry(): THREE.BufferGeometry {
  const edgeCount = 12;
  const vertsPerBox = 24;
  const indicesPerBox = 36;

  const positions = new Float32Array(edgeCount * vertsPerBox * 3);
  const normals = new Float32Array(edgeCount * vertsPerBox * 3);
  const indices = new Uint16Array(edgeCount * indicesPerBox);

  const offset = 0.516;
  const halfLen = 0.538;
  const halfThick = 0.022;

  const edgeSpecs: Array<{
    cx: number;
    cy: number;
    cz: number;
    hx: number;
    hy: number;
    hz: number;
  }> = [];

  for (const s1 of [-1, 1]) {
    for (const s2 of [-1, 1]) {
      // 4 ребра вдоль оси X
      edgeSpecs.push({
        cx: 0,
        cy: s1 * offset,
        cz: s2 * offset,
        hx: halfLen,
        hy: halfThick,
        hz: halfThick,
      });
      // 4 ребра вдоль оси Y
      edgeSpecs.push({
        cx: s1 * offset,
        cy: 0,
        cz: s2 * offset,
        hx: halfThick,
        hy: halfLen,
        hz: halfThick,
      });
      // 4 ребра вдоль оси Z
      edgeSpecs.push({
        cx: s1 * offset,
        cy: s2 * offset,
        cz: 0,
        hx: halfThick,
        hy: halfThick,
        hz: halfLen,
      });
    }
  }

  const unitBox = new THREE.BoxGeometry(2, 2, 2);
  const srcPos = unitBox.getAttribute('position');
  const srcNorm = unitBox.getAttribute('normal');
  const srcIdx = unitBox.getIndex();

  if (srcPos && srcNorm && srcIdx) {
    for (let b = 0; b < edgeSpecs.length; b++) {
      const spec = edgeSpecs[b]!;
      const vBase = b * vertsPerBox;
      const iBase = b * indicesPerBox;

      for (let v = 0; v < vertsPerBox; v++) {
        const outOffset = (vBase + v) * 3;
        positions[outOffset] = spec.cx + srcPos.getX(v) * spec.hx;
        positions[outOffset + 1] = spec.cy + srcPos.getY(v) * spec.hy;
        positions[outOffset + 2] = spec.cz + srcPos.getZ(v) * spec.hz;

        normals[outOffset] = srcNorm.getX(v);
        normals[outOffset + 1] = srcNorm.getY(v);
        normals[outOffset + 2] = srcNorm.getZ(v);
      }

      for (let k = 0; k < indicesPerBox; k++) {
        indices[iBase + k] = vBase + srcIdx.getX(k);
      }
    }
  }

  unitBox.dispose();

  const cageGeom = new THREE.BufferGeometry();
  cageGeom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  cageGeom.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  cageGeom.setIndex(new THREE.BufferAttribute(indices, 1));
  cageGeom.computeBoundingBox();
  cageGeom.computeBoundingSphere();
  return cageGeom;
}

function buildSlotMaterials(
  materialId: StructuralMaterialId,
  textures: MaterialTexturesPair,
): Record<RenderViewMode, THREE.Material> {
  const isGlass = materialId === 'glass';

  let roughness = 0.85;
  let metalness = 0.05;
  let bumpScale = 0.03;

  switch (materialId) {
    case 'reinforced_concrete':
      roughness = 0.88;
      metalness = 0.06;
      bumpScale = 0.03;
      break;
    case 'brick':
      roughness = 0.84;
      metalness = 0.02;
      bumpScale = 0.04;
      break;
    case 'glass':
      roughness = 0.07;
      metalness = 0.16;
      bumpScale = 0.0;
      break;
    case 'wood':
      roughness = 0.75;
      metalness = 0.0;
      bumpScale = 0.03;
      break;
    case 'steel':
      roughness = 0.30;
      metalness = 0.86;
      bumpScale = 0.02;
      break;
    case 'explosive':
      roughness = 0.40;
      metalness = 0.48;
      bumpScale = 0.02;
      break;
  }

  const pbrMaterial = isGlass
    ? new THREE.MeshStandardMaterial({
        color: 0xffffff,
        map: textures.albedoMap,
        roughness,
        metalness,
        transparent: true,
        opacity: 0.44,
        depthWrite: false,
        side: THREE.DoubleSide,
        forceSinglePass: true,
      })
    : new THREE.MeshStandardMaterial({
        color: 0xffffff,
        map: textures.albedoMap,
        bumpMap: textures.bumpMap,
        bumpScale,
        roughness,
        metalness,
      });

  const stressMaterial = isGlass
    ? new THREE.MeshStandardMaterial({
        color: 0xffffff,
        roughness: 0.35,
        metalness: 0.12,
        transparent: true,
        opacity: 0.76,
        depthWrite: false,
        side: THREE.DoubleSide,
        forceSinglePass: true,
      })
    : new THREE.MeshStandardMaterial({
        color: 0xffffff,
        roughness: 0.52,
        metalness: 0.10,
      });

  const xrayMaterial = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.16,
    depthWrite: false,
    side: THREE.DoubleSide,
    forceSinglePass: true,
  });

  return {
    pbr: pbrMaterial,
    stress: stressMaterial,
    xray: xrayMaterial,
  };
}

export class InstancedBlockLayer {
  public readonly group: THREE.Group;

  private readonly unitBoxGeometry: THREE.BoxGeometry;
  private readonly criticalCageGeometry: THREE.BufferGeometry;
  private readonly criticalHighlightMaterial: THREE.MeshBasicMaterial;
  private readonly slots: Map<StructuralMaterialId, MaterialInstancedSlot>;

  private criticalHighlightMesh: THREE.InstancedMesh;
  private criticalCapacity: number;
  private activeCriticalCount = 0;

  private viewMode: RenderViewMode = 'pbr';
  private qualityPreset: QualityPreset = 'high';
  private criticalNodeIds: Set<number> = new Set();
  private lastBlocks: RenderBlockInstance[] = [];
  private lastSimTimeSec = 0;
  private animTimeSec = 0;
  private disposed = false;

  constructor(options?: { quality?: QualityPreset; seed?: number }) {
    this.group = new THREE.Group();
    this.group.name = 'InstancedBlockLayer';

    this.qualityPreset = options?.quality ?? 'high';
    const rng = new SeededRng(options?.seed ?? DEFAULT_SEED);

    this.unitBoxGeometry = new THREE.BoxGeometry(1, 1, 1);
    this.slots = new Map();

    for (let i = 0; i < STRUCTURAL_MATERIAL_IDS.length; i++) {
      const matId = STRUCTURAL_MATERIAL_IDS[i]!;
      const textures = createProceduralMaterialTextures(matId, rng.fork(i + 101));
      const materials = buildSlotMaterials(matId, textures);
      const mesh = this.createInstancedSlotMesh(
        matId,
        materials[this.viewMode],
        INITIAL_SLOT_CAPACITY,
      );
      this.group.add(mesh);

      this.slots.set(matId, {
        materialId: matId,
        textures,
        materials,
        mesh,
        capacity: INITIAL_SLOT_CAPACITY,
        activeCount: 0,
      });
    }

    this.criticalCageGeometry = createCriticalBracketCageGeometry();
    this.criticalHighlightMaterial = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.92,
      depthWrite: false,
      toneMapped: false,
    });

    this.criticalCapacity = INITIAL_CRITICAL_CAPACITY;
    this.criticalHighlightMesh = this.createCriticalMesh(this.criticalCapacity);
    this.group.add(this.criticalHighlightMesh);

    this.applyShadowSettings();
  }

  public getObject3D(): THREE.Group {
    return this.group;
  }

  public getViewMode(): RenderViewMode {
    return this.viewMode;
  }

  public getMaterialMesh(materialId: StructuralMaterialId): THREE.InstancedMesh {
    const slot = this.slots.get(materialId);
    if (!slot) {
      throw new RangeError(`Неизвестный слот материала в InstancedBlockLayer: ${String(materialId)}`);
    }
    return slot.mesh;
  }

  public getCriticalHighlightMesh(): THREE.InstancedMesh {
    return this.criticalHighlightMesh;
  }

  /**
   * Синхронизирует матрицы и цвета всех конструктивных блоков по текущему снимку мира.
   */
  public syncBlocks(blocks: readonly RenderBlockInstance[], simTimeSec?: number): void {
    if (this.disposed) return;

    this.lastBlocks = blocks.slice();
    if (simTimeSec !== undefined && Number.isFinite(simTimeSec)) {
      this.lastSimTimeSec = clamp(simTimeSec, -1e5, 1e5);
    }

    // Подсчёт требуемого количества инстансов для каждого материала
    const neededByMat: Record<StructuralMaterialId, number> = {
      reinforced_concrete: 0,
      brick: 0,
      glass: 0,
      wood: 0,
      steel: 0,
      explosive: 0,
    };

    let neededCritical = 0;
    const hasCriticals = this.criticalNodeIds.size > 0;

    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i]!;
      if (neededByMat[b.materialId] !== undefined) {
        neededByMat[b.materialId] += 1;
      }
      if (hasCriticals && Number.isFinite(b.nodeId) && this.criticalNodeIds.has(b.nodeId)) {
        neededCritical += 1;
      }
    }

    // При необходимости расширяем ёмкость слотов до записи матриц
    for (const matId of STRUCTURAL_MATERIAL_IDS) {
      const slot = this.slots.get(matId);
      if (!slot) continue;
      const needed = neededByMat[matId];
      if (needed > slot.capacity) {
        this.growSlotCapacity(slot, Math.max(needed, slot.capacity * 2));
      }
      slot.activeCount = 0;
    }

    if (neededCritical > this.criticalCapacity) {
      this.growCriticalCapacity(Math.max(neededCritical, this.criticalCapacity * 2));
    }

    const effectiveTime = sanitizeFinite(this.lastSimTimeSec + this.animTimeSec, -1e5, 1e5, 0);

    // Записываем матрицы (с умножением halfExtents * 2!) и цвета инстансов
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i]!;
      const slot = this.slots.get(block.materialId);
      if (!slot) continue;

      const instanceIdx = slot.activeCount;
      slot.activeCount += 1;

      const px = sanitizeCoord(block.position[0]);
      const py = sanitizeCoord(block.position[1]);
      const pz = sanitizeCoord(block.position[2]);
      const hx = sanitizeHalfExtent(block.halfExtents[0]);
      const hy = sanitizeHalfExtent(block.halfExtents[1]);
      const hz = sanitizeHalfExtent(block.halfExtents[2]);

      _pos.set(px, py, pz);
      sanitizeQuaternionInto(_quat, block.quaternion);
      _scale.set(hx * 2, hy * 2, hz * 2);
      _mat4.compose(_pos, _quat, _scale);

      slot.mesh.setMatrixAt(instanceIdx, _mat4);
      computeBlockInstanceColor(block, this.viewMode, effectiveTime, _workColor);
      slot.mesh.setColorAt(instanceIdx, _workColor);
    }

    for (const matId of STRUCTURAL_MATERIAL_IDS) {
      const slot = this.slots.get(matId);
      if (!slot) continue;
      slot.mesh.count = slot.activeCount;
      slot.mesh.visible = slot.activeCount > 0;
      if (slot.activeCount > 0) {
        slot.mesh.instanceMatrix.needsUpdate = true;
        if (slot.mesh.instanceColor) {
          slot.mesh.instanceColor.needsUpdate = true;
        }
      }
    }

    this.rebuildCriticalHighlights();
  }

  /**
   * Задаёт набор критических несущих узлов и немедленно обновляет 3D-индикацию (в том числе на паузе).
   */
  public setCriticalNodes(nodeIds: Iterable<number>): void {
    if (this.disposed) return;

    this.criticalNodeIds.clear();
    for (const id of nodeIds) {
      if (Number.isFinite(id)) {
        this.criticalNodeIds.add(id);
      }
    }

    this.rebuildCriticalHighlights();
  }

  /**
   * Переключает режим рендеринга ('pbr' | 'stress' | 'xray') и мгновенно перекрашивает кэшированные блоки.
   */
  public setViewMode(mode: RenderViewMode): void {
    if (this.disposed) return;

    this.viewMode = mode;
    for (const matId of STRUCTURAL_MATERIAL_IDS) {
      const slot = this.slots.get(matId);
      if (!slot) continue;
      slot.mesh.material = slot.materials[mode];
      slot.mesh.renderOrder = mode === 'xray' ? 1 : matId === 'glass' ? 2 : 0;
    }

    this.applyShadowSettings();
    this.recolorLastBlocksInPlace();
    this.rebuildCriticalHighlights();
  }

  /**
   * Настраивает тени в зависимости от выбранного пресета качества без пересоздания буферов.
   */
  public setQualityPreset(preset: QualityPreset): void {
    if (this.disposed) return;
    this.qualityPreset = preset;
    this.applyShadowSettings();
  }

  /**
   * Продвигает фазу визуальной пульсации горящих узлов и рамок критических опор.
   */
  public updateAnimation(dtRealSec: number): void {
    if (this.disposed) return;
    const safeDt = Number.isFinite(dtRealSec) && dtRealSec > 0 ? Math.min(0.25, dtRealSec) : 0;
    if (safeDt <= 0) return;

    this.animTimeSec = (this.animTimeSec + safeDt) % 86400;

    if (this.viewMode !== 'pbr' && this.activeCriticalCount > 0) {
      this.rebuildCriticalHighlights();
    } else if (this.viewMode === 'pbr' && this.lastBlocks.some((b) => b.burning)) {
      this.recolorLastBlocksInPlace();
    }
  }

  public clear(): void {
    if (this.disposed) return;
    this.lastBlocks = [];
    for (const matId of STRUCTURAL_MATERIAL_IDS) {
      const slot = this.slots.get(matId);
      if (!slot) continue;
      slot.activeCount = 0;
      slot.mesh.count = 0;
      slot.mesh.visible = false;
    }
    this.activeCriticalCount = 0;
    this.criticalHighlightMesh.count = 0;
    this.criticalHighlightMesh.visible = false;
  }

  public getEstimatedDrawCalls(includeShadowPass = false): number {
    if (this.disposed) return 0;

    let calls = 0;
    for (const matId of STRUCTURAL_MATERIAL_IDS) {
      const slot = this.slots.get(matId);
      if (!slot) continue;
      if (slot.mesh.visible && slot.mesh.count > 0) {
        calls += 1;
        if (includeShadowPass && slot.mesh.castShadow) {
          calls += 1;
        }
      }
    }
    if (this.criticalHighlightMesh.visible && this.criticalHighlightMesh.count > 0) {
      calls += 1;
    }
    return calls;
  }

  public getDiagnostics(): BlockLayerDiagnostics {
    const countsByMaterial: Record<StructuralMaterialId, number> = {
      reinforced_concrete: 0,
      brick: 0,
      glass: 0,
      wood: 0,
      steel: 0,
      explosive: 0,
    };
    const capacitiesByMaterial: Record<StructuralMaterialId, number> = {
      reinforced_concrete: 0,
      brick: 0,
      glass: 0,
      wood: 0,
      steel: 0,
      explosive: 0,
    };

    if (this.disposed) {
      return {
        totalBlocks: 0,
        activeMaterialSlots: 0,
        criticalHighlightsCount: 0,
        countsByMaterial,
        capacitiesByMaterial,
        estimatedDrawCalls: 0,
      };
    }

    let totalBlocks = 0;
    let activeMaterialSlots = 0;

    for (const matId of STRUCTURAL_MATERIAL_IDS) {
      const slot = this.slots.get(matId);
      if (!slot) continue;
      countsByMaterial[matId] = slot.activeCount;
      capacitiesByMaterial[matId] = slot.capacity;
      totalBlocks += slot.activeCount;
      if (slot.mesh.visible && slot.activeCount > 0) {
        activeMaterialSlots += 1;
      }
    }

    const shadowsOn = this.qualityPreset !== 'performance' && this.viewMode !== 'xray';

    return {
      totalBlocks,
      activeMaterialSlots,
      criticalHighlightsCount: this.criticalHighlightMesh.visible ? this.activeCriticalCount : 0,
      countsByMaterial,
      capacitiesByMaterial,
      estimatedDrawCalls: this.getEstimatedDrawCalls(shadowsOn),
    };
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    for (const slot of this.slots.values()) {
      slot.activeCount = 0;
      slot.capacity = 0;
      slot.mesh.count = 0;
      slot.mesh.visible = false;
      this.group.remove(slot.mesh);
      slot.mesh.dispose();
      slot.materials.pbr.dispose();
      slot.materials.stress.dispose();
      slot.materials.xray.dispose();
      slot.textures.albedoMap.dispose();
      slot.textures.bumpMap.dispose();
    }

    this.activeCriticalCount = 0;
    this.criticalCapacity = 0;
    this.criticalHighlightMesh.count = 0;
    this.criticalHighlightMesh.visible = false;
    this.group.remove(this.criticalHighlightMesh);
    this.criticalHighlightMesh.dispose();
    this.criticalHighlightMaterial.dispose();
    this.criticalCageGeometry.dispose();
    this.unitBoxGeometry.dispose();
    this.lastBlocks = [];
  }

  private createInstancedSlotMesh(
    materialId: StructuralMaterialId,
    material: THREE.Material,
    capacity: number,
  ): THREE.InstancedMesh {
    const mesh = new THREE.InstancedMesh(this.unitBoxGeometry, material, capacity);
    mesh.name = `BlockSlot_${materialId}`;
    mesh.frustumCulled = false;
    mesh.count = 0;
    mesh.visible = false;
    mesh.renderOrder = this.viewMode === 'xray' ? 1 : materialId === 'glass' ? 2 : 0;

    // Инициализируем атрибут instanceColor сразу, чтобы setColorAt/instanceColor были доступны с 0-го кадра
    _workColor.setRGB(1, 1, 1, THREE.LinearSRGBColorSpace);
    mesh.setColorAt(0, _workColor);
    return mesh;
  }

  private createCriticalMesh(capacity: number): THREE.InstancedMesh {
    const mesh = new THREE.InstancedMesh(
      this.criticalCageGeometry,
      this.criticalHighlightMaterial,
      capacity,
    );
    mesh.name = 'CriticalLoadBearingCage';
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.renderOrder = 6;
    mesh.count = 0;
    mesh.visible = false;

    _workColor.setRGB(1, 1, 1, THREE.LinearSRGBColorSpace);
    mesh.setColorAt(0, _workColor);
    return mesh;
  }

  private growSlotCapacity(slot: MaterialInstancedSlot, newCapacity: number): void {
    this.group.remove(slot.mesh);
    slot.mesh.dispose();

    const newMesh = this.createInstancedSlotMesh(
      slot.materialId,
      slot.materials[this.viewMode],
      newCapacity,
    );
    slot.mesh = newMesh;
    slot.capacity = newCapacity;
    this.group.add(newMesh);
    this.applyShadowSettings();
  }

  private growCriticalCapacity(newCapacity: number): void {
    this.group.remove(this.criticalHighlightMesh);
    this.criticalHighlightMesh.dispose();

    this.criticalCapacity = newCapacity;
    this.criticalHighlightMesh = this.createCriticalMesh(newCapacity);
    this.group.add(this.criticalHighlightMesh);
  }

  private applyShadowSettings(): void {
    const enableShadows = this.qualityPreset !== 'performance' && this.viewMode !== 'xray';
    for (const matId of STRUCTURAL_MATERIAL_IDS) {
      const slot = this.slots.get(matId);
      if (!slot) continue;
      const isGlass = matId === 'glass';
      slot.mesh.castShadow = enableShadows && !isGlass;
      slot.mesh.receiveShadow = enableShadows;
    }
  }

  private recolorLastBlocksInPlace(): void {
    if (this.disposed || this.lastBlocks.length === 0) return;

    const writeCursor: Record<StructuralMaterialId, number> = {
      reinforced_concrete: 0,
      brick: 0,
      glass: 0,
      wood: 0,
      steel: 0,
      explosive: 0,
    };

    const effectiveTime = sanitizeFinite(this.lastSimTimeSec + this.animTimeSec, -1e5, 1e5, 0);

    for (let i = 0; i < this.lastBlocks.length; i++) {
      const block = this.lastBlocks[i]!;
      const slot = this.slots.get(block.materialId);
      if (!slot) continue;

      const idx = writeCursor[block.materialId];
      writeCursor[block.materialId] = idx + 1;
      if (idx >= slot.activeCount) continue;

      computeBlockInstanceColor(block, this.viewMode, effectiveTime, _workColor);
      slot.mesh.setColorAt(idx, _workColor);
    }

    for (const matId of STRUCTURAL_MATERIAL_IDS) {
      const slot = this.slots.get(matId);
      if (!slot) continue;
      if (slot.activeCount > 0 && slot.mesh.instanceColor) {
        slot.mesh.instanceColor.needsUpdate = true;
      }
    }
  }

  private rebuildCriticalHighlights(): void {
    if (this.disposed || this.criticalNodeIds.size === 0 || this.lastBlocks.length === 0) {
      this.activeCriticalCount = 0;
      this.criticalHighlightMesh.count = 0;
      this.criticalHighlightMesh.visible = false;
      return;
    }

    let needed = 0;
    for (let i = 0; i < this.lastBlocks.length; i++) {
      const id = this.lastBlocks[i]!.nodeId;
      if (Number.isFinite(id) && this.criticalNodeIds.has(id)) {
        needed += 1;
      }
    }

    if (needed === 0) {
      this.activeCriticalCount = 0;
      this.criticalHighlightMesh.count = 0;
      this.criticalHighlightMesh.visible = false;
      return;
    }

    if (needed > this.criticalCapacity) {
      this.growCriticalCapacity(Math.max(needed, this.criticalCapacity * 2));
    }

    const effectiveTime = sanitizeFinite(this.lastSimTimeSec + this.animTimeSec, -1e5, 1e5, 0);
    let cursor = 0;

    for (let i = 0; i < this.lastBlocks.length; i++) {
      const block = this.lastBlocks[i]!;
      if (!Number.isFinite(block.nodeId) || !this.criticalNodeIds.has(block.nodeId)) continue;

      const px = sanitizeCoord(block.position[0]);
      const py = sanitizeCoord(block.position[1]);
      const pz = sanitizeCoord(block.position[2]);
      const hx = sanitizeHalfExtent(block.halfExtents[0]);
      const hy = sanitizeHalfExtent(block.halfExtents[1]);
      const hz = sanitizeHalfExtent(block.halfExtents[2]);

      _pos.set(px, py, pz);
      sanitizeQuaternionInto(_quat, block.quaternion);
      _scale.set(hx * 2, hy * 2, hz * 2);
      _mat4.compose(_pos, _quat, _scale);
      this.criticalHighlightMesh.setMatrixAt(cursor, _mat4);

      const pulse = 0.78 + 0.22 * Math.sin(effectiveTime * 6.0 + (cursor % 1024) * 0.9);
      const safeStress = sanitizeFinite(block.stressUtilization, 0, 10, 0);
      if (safeStress >= 0.75) {
        // Сигнальный алый маркер перегруженной опоры
        _workColor.setRGB(239 / 255, 68 / 255, 56 / 255, THREE.SRGBColorSpace);
      } else {
        // Сигнальный янтарный маркер ключевой несущей опоры
        _workColor.setRGB(245 / 255, 158 / 255, 11 / 255, THREE.SRGBColorSpace);
      }
      _workColor.multiplyScalar(pulse);
      this.criticalHighlightMesh.setColorAt(cursor, _workColor);

      cursor += 1;
    }

    this.activeCriticalCount = cursor;
    this.criticalHighlightMesh.count = cursor;
    // По контракту PROJECT.md §4 индикация критических опор отображается в режимах 'stress' и 'xray'
    this.criticalHighlightMesh.visible = this.viewMode !== 'pbr' && cursor > 0;

    if (cursor > 0) {
      this.criticalHighlightMesh.instanceMatrix.needsUpdate = true;
      if (this.criticalHighlightMesh.instanceColor) {
        this.criticalHighlightMesh.instanceColor.needsUpdate = true;
      }
    }
  }
}
