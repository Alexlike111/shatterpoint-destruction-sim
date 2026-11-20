import { clamp } from '../core/math3d';
import {
  STRUCTURAL_MATERIAL_IDS,
  type MaterialPhysicsProfile,
  type StructuralMaterialId,
} from '../core/types';

/**
 * Реестр калиброванных физических профилей материалов в системе СИ
 * и температурных кривых ослабления по Еврокодам EN 1992-1-2, EN 1993-1-2, EN 1995-1-2, EN 1996-1-2.
 */

export const GLASS_THERMAL_SHOCK_TEMP_C = 180;
export const GLASS_THERMAL_SHOCK_DELTA_C = 90;
export const MASONRY_SPALLING_DELTA_C = 1400;
export const MIN_STIFFNESS_RETENTION = 0.01;

type ThermalCurveNode = readonly [tempC: number, factor: number];

function freezeProfile(profile: MaterialPhysicsProfile): Readonly<MaterialPhysicsProfile> {
  Object.freeze(profile.voronoiAnisotropy);
  return Object.freeze(profile);
}

export const MATERIAL_PROFILES: Readonly<
  Record<StructuralMaterialId, Readonly<MaterialPhysicsProfile>>
> = Object.freeze({
  reinforced_concrete: freezeProfile({
    id: 'reinforced_concrete',
    nameRu: 'Армированный железобетон',
    densityKgM3: 2450,
    compressiveStrengthMPa: 42.0,
    tensileStrengthMPa: 11.5,
    shearCohesionMPa: 9.0,
    internalFrictionCoeff: 0.85,
    youngsModulusGPa: 34.0,
    brittleness: 0.72,
    plasticYieldRatio: 1.0,
    hasRebarTethers: true,
    voronoiAnisotropy: [1.2, 1.0, 1.2],
    flammable: false,
    ignitionTempC: 9999,
    volatile: false,
    detonationTempC: 9999,
    detonationEquivalentKgTnt: 0,
    thermalConductivity: 1.6,
    friction: 0.78,
    restitution: 0.08,
    baseColorHex: 0x64707d,
    interiorCutColorHex: 0x434c56,
  }),
  brick: freezeProfile({
    id: 'brick',
    nameRu: 'Кирпичная кладка',
    densityKgM3: 1800,
    compressiveStrengthMPa: 12.0,
    tensileStrengthMPa: 0.65,
    shearCohesionMPa: 0.9,
    internalFrictionCoeff: 0.7,
    youngsModulusGPa: 14.0,
    brittleness: 0.88,
    plasticYieldRatio: 1.0,
    hasRebarTethers: false,
    voronoiAnisotropy: [1.6, 0.85, 1.2],
    flammable: false,
    ignitionTempC: 9999,
    volatile: false,
    detonationTempC: 9999,
    detonationEquivalentKgTnt: 0,
    thermalConductivity: 0.85,
    friction: 0.72,
    restitution: 0.1,
    baseColorHex: 0x9e4332,
    interiorCutColorHex: 0x6e2a1e,
  }),
  glass: freezeProfile({
    id: 'glass',
    nameRu: 'Калёное стекло',
    densityKgM3: 2500,
    compressiveStrengthMPa: 18.0,
    tensileStrengthMPa: 2.2,
    shearCohesionMPa: 1.6,
    internalFrictionCoeff: 0.4,
    youngsModulusGPa: 70.0,
    brittleness: 0.98,
    plasticYieldRatio: 1.0,
    hasRebarTethers: false,
    voronoiAnisotropy: [1.75, 1.75, 0.65],
    flammable: false,
    ignitionTempC: 9999,
    volatile: false,
    detonationTempC: 9999,
    detonationEquivalentKgTnt: 0,
    thermalConductivity: 1.05,
    friction: 0.24,
    restitution: 0.24,
    baseColorHex: 0x7dd3fc,
    interiorCutColorHex: 0xe0f2fe,
  }),
  wood: freezeProfile({
    id: 'wood',
    nameRu: 'Конструкционный брус',
    densityKgM3: 680,
    compressiveStrengthMPa: 36.0,
    tensileStrengthMPa: 14.0,
    shearCohesionMPa: 4.2,
    internalFrictionCoeff: 0.55,
    youngsModulusGPa: 12.0,
    brittleness: 0.45,
    plasticYieldRatio: 1.0,
    hasRebarTethers: false,
    voronoiAnisotropy: [3.4, 1.0, 1.0],
    flammable: true,
    ignitionTempC: 260,
    volatile: false,
    detonationTempC: 9999,
    detonationEquivalentKgTnt: 0,
    thermalConductivity: 0.18,
    friction: 0.58,
    restitution: 0.15,
    baseColorHex: 0x8b5a2b,
    interiorCutColorHex: 0xc68b53,
  }),
  steel: freezeProfile({
    id: 'steel',
    nameRu: 'Конструкционная сталь',
    densityKgM3: 7850,
    compressiveStrengthMPa: 490.0,
    tensileStrengthMPa: 490.0,
    shearCohesionMPa: 280.0,
    internalFrictionCoeff: 0.0,
    youngsModulusGPa: 200.0,
    brittleness: 0.08,
    plasticYieldRatio: 0.725,
    hasRebarTethers: false,
    voronoiAnisotropy: [1.8, 0.9, 0.9],
    flammable: false,
    ignitionTempC: 9999,
    volatile: false,
    detonationTempC: 9999,
    detonationEquivalentKgTnt: 0,
    thermalConductivity: 50.0,
    friction: 0.52,
    restitution: 0.18,
    baseColorHex: 0x475569,
    interiorCutColorHex: 0x94a3b8,
  }),
  explosive: freezeProfile({
    id: 'explosive',
    nameRu: 'Взрывоопасная ёмкость',
    densityKgM3: 1150,
    compressiveStrengthMPa: 8.5,
    tensileStrengthMPa: 4.5,
    shearCohesionMPa: 3.2,
    internalFrictionCoeff: 0.25,
    youngsModulusGPa: 28.0,
    brittleness: 0.6,
    plasticYieldRatio: 0.85,
    hasRebarTethers: false,
    voronoiAnisotropy: [1.15, 1.0, 1.15],
    flammable: true,
    ignitionTempC: 220,
    volatile: true,
    detonationTempC: 250,
    detonationEquivalentKgTnt: 25.0,
    thermalConductivity: 18.0,
    friction: 0.55,
    restitution: 0.16,
    baseColorHex: 0xc2410c,
    interiorCutColorHex: 0x431407,
  }),
});

const ALL_MATERIAL_PROFILES_LIST: readonly Readonly<MaterialPhysicsProfile>[] = Object.freeze(
  STRUCTURAL_MATERIAL_IDS.map((id) => MATERIAL_PROFILES[id]),
);

const STRENGTH_CURVES: Readonly<Record<StructuralMaterialId, readonly ThermalCurveNode[]>> =
  Object.freeze({
    // EN 1993-1-2, Table 3.1 (k_y,theta)
    steel: [
      [20, 1.0],
      [100, 1.0],
      [200, 1.0],
      [300, 1.0],
      [400, 1.0],
      [500, 0.78],
      [600, 0.47],
      [700, 0.23],
      [800, 0.11],
      [900, 0.06],
      [1000, 0.04],
      [1100, 0.02],
      [1200, 0.01],
    ],
    // EN 1992-1-2, Table 3.1 (силикатный заполнитель k_c,theta)
    reinforced_concrete: [
      [20, 1.0],
      [100, 1.0],
      [200, 0.95],
      [300, 0.85],
      [400, 0.75],
      [500, 0.6],
      [600, 0.45],
      [700, 0.3],
      [800, 0.15],
      [900, 0.08],
      [1000, 0.04],
      [1100, 0.02],
      [1200, 0.01],
    ],
    // EN 1996-1-2 (кирпичная кладка на цементно-известковом растворе)
    brick: [
      [20, 1.0],
      [200, 1.0],
      [400, 0.96],
      [600, 0.85],
      [700, 0.75],
      [800, 0.58],
      [900, 0.38],
      [1000, 0.2],
      [1100, 0.08],
      [1200, 0.03],
    ],
    // EN 1995-1-2 (прогрев ядра древесины до вычета обугленного слоя)
    wood: [
      [20, 1.0],
      [60, 0.92],
      [100, 0.8],
      [150, 0.68],
      [200, 0.56],
      [260, 0.44],
      [300, 0.35],
      [400, 0.22],
      [600, 0.12],
      [800, 0.05],
      [1000, 0.02],
    ],
    // Калёное стекло: термошок при ~180 °C и отпуск закалочных напряжений
    glass: [
      [20, 1.0],
      [100, 0.98],
      [150, 0.9],
      [180, 0.45],
      [220, 0.15],
      [300, 0.08],
      [550, 0.03],
      [800, 0.01],
    ],
    // Корпус взрывоопасной ёмкости до теплового взрыва BLEVE
    explosive: [
      [20, 1.0],
      [100, 0.92],
      [180, 0.72],
      [220, 0.5],
      [250, 0.25],
      [350, 0.1],
      [600, 0.03],
    ],
  });

const STIFFNESS_CURVES: Readonly<Record<StructuralMaterialId, readonly ThermalCurveNode[]>> =
  Object.freeze({
    // EN 1993-1-2, Table 3.1 (k_E,theta)
    steel: [
      [20, 1.0],
      [100, 1.0],
      [200, 0.9],
      [300, 0.8],
      [400, 0.7],
      [500, 0.6],
      [600, 0.31],
      [700, 0.13],
      [800, 0.09],
      [900, 0.0675],
      [1000, 0.045],
      [1100, 0.0225],
      [1200, 0.01],
    ],
    // EN 1992-1-2 (касательный модуль упругости бетона)
    reinforced_concrete: [
      [20, 1.0],
      [100, 1.0],
      [200, 0.87],
      [300, 0.72],
      [400, 0.56],
      [500, 0.4],
      [600, 0.25],
      [700, 0.15],
      [800, 0.08],
      [900, 0.05],
      [1000, 0.03],
      [1100, 0.02],
      [1200, 0.01],
    ],
    brick: [
      [20, 1.0],
      [200, 0.98],
      [400, 0.9],
      [600, 0.75],
      [700, 0.62],
      [800, 0.45],
      [900, 0.28],
      [1000, 0.14],
      [1200, 0.03],
    ],
    wood: [
      [20, 1.0],
      [100, 0.85],
      [200, 0.65],
      [260, 0.5],
      [300, 0.4],
      [400, 0.25],
      [600, 0.12],
      [800, 0.05],
      [1000, 0.02],
    ],
    glass: [
      [20, 1.0],
      [150, 0.98],
      [250, 0.92],
      [400, 0.8],
      [550, 0.35],
      [700, 0.05],
      [900, 0.01],
    ],
    explosive: [
      [20, 1.0],
      [100, 0.95],
      [200, 0.8],
      [250, 0.6],
      [400, 0.25],
      [600, 0.05],
    ],
  });

function interpolateThermalCurve(curve: readonly ThermalCurveNode[], tempC: number): number {
  const first = curve[0]!;
  if (!Number.isFinite(tempC) || tempC <= first[0]) {
    return first[1];
  }
  const last = curve[curve.length - 1]!;
  if (tempC >= last[0]) {
    return last[1];
  }
  for (let i = 0; i < curve.length - 1; i++) {
    const a = curve[i]!;
    const b = curve[i + 1]!;
    if (tempC >= a[0] && tempC <= b[0]) {
      const span = b[0] - a[0];
      if (span <= 0) return b[1];
      const t = (tempC - a[0]) / span;
      return a[1] + (b[1] - a[1]) * t;
    }
  }
  return last[1];
}

export function getMaterialProfile(id: StructuralMaterialId): Readonly<MaterialPhysicsProfile> {
  const profile = MATERIAL_PROFILES[id];
  if (!profile) {
    throw new RangeError(`Неизвестный идентификатор материала: ${String(id)}`);
  }
  return profile;
}

export function getAllMaterialProfiles(): readonly Readonly<MaterialPhysicsProfile>[] {
  return ALL_MATERIAL_PROFILES_LIST;
}

/**
 * Коэффициент сохранения несущей прочности материала при температуре tempC (°C)
 * и степени обугливания charRatio (0..1) по Еврокодам.
 */
export function computeThermalStrengthRetention(
  materialId: StructuralMaterialId,
  tempC: number,
  charRatio = 0,
): number {
  const baseFactor = interpolateThermalCurve(STRENGTH_CURVES[materialId], tempC);
  const safeChar = Number.isFinite(charRatio) ? clamp(charRatio, 0, 1) : 0;
  if (materialId === 'wood') {
    if (safeChar >= 1) {
      return 0;
    }
    const sectionFactor = Math.pow(1 - safeChar, 1.5);
    return clamp(baseFactor * sectionFactor, 0, 1);
  }
  if (safeChar > 0) {
    const damageFactor = 1 - 0.5 * safeChar;
    return clamp(baseFactor * damageFactor, 0, 1);
  }
  return clamp(baseFactor, 0, 1);
}

/**
 * Коэффициент сохранения модуля упругости (жёсткости E) при температуре tempC (°C).
 * Никогда не опускается ниже MIN_STIFFNESS_RETENTION (0.01) для невырожденности матрицы жёсткости.
 */
export function computeThermalStiffnessRetention(
  materialId: StructuralMaterialId,
  tempC: number,
  charRatio = 0,
): number {
  const baseFactor = interpolateThermalCurve(STIFFNESS_CURVES[materialId], tempC);
  const safeChar = Number.isFinite(charRatio) ? clamp(charRatio, 0, 1) : 0;
  if (materialId === 'wood') {
    const sectionFactor = safeChar >= 1 ? 0 : Math.pow(1 - safeChar, 1.5);
    return clamp(Math.max(MIN_STIFFNESS_RETENTION, baseFactor * sectionFactor), MIN_STIFFNESS_RETENTION, 1);
  }
  return clamp(Math.max(MIN_STIFFNESS_RETENTION, baseFactor), MIN_STIFFNESS_RETENTION, 1);
}

/**
 * Проверяет наступление хрупкого термошока (растрескивание стекла при нагреве/перепаде температуры
 * или термическое шелушение каменной кладки/бетона при экстремальном перепаде).
 */
export function isThermalShockTriggered(
  materialId: StructuralMaterialId,
  tempC: number,
  deltaTempC = 0,
): boolean {
  const safeTemp = Number.isFinite(tempC) ? tempC : 20;
  const safeDelta = Number.isFinite(deltaTempC) ? Math.abs(deltaTempC) : 0;
  if (materialId === 'glass') {
    return safeTemp >= GLASS_THERMAL_SHOCK_TEMP_C || safeDelta >= GLASS_THERMAL_SHOCK_DELTA_C;
  }
  if (materialId === 'brick' || materialId === 'reinforced_concrete') {
    return safeDelta >= MASONRY_SPALLING_DELTA_C;
  }
  return false;
}

export function isIgnitionTriggered(materialId: StructuralMaterialId, tempC: number): boolean {
  const profile = getMaterialProfile(materialId);
  return profile.flammable && Number.isFinite(tempC) && tempC >= profile.ignitionTempC;
}

export function isThermalDetonationTriggered(
  materialId: StructuralMaterialId,
  tempC: number,
): boolean {
  const profile = getMaterialProfile(materialId);
  return profile.volatile && Number.isFinite(tempC) && tempC >= profile.detonationTempC;
}
