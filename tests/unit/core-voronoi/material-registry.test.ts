import { describe, expect, it } from 'vitest';
import { STRUCTURAL_MATERIAL_IDS } from '../../../src/core/types';
import {
  computeThermalStiffnessRetention,
  computeThermalStrengthRetention,
  getAllMaterialProfiles,
  getMaterialProfile,
  GLASS_THERMAL_SHOCK_DELTA_C,
  GLASS_THERMAL_SHOCK_TEMP_C,
  isIgnitionTriggered,
  isThermalDetonationTriggered,
  isThermalShockTriggered,
  MASONRY_SPALLING_DELTA_C,
  MATERIAL_PROFILES,
  MIN_STIFFNESS_RETENTION,
} from '../../../src/physics/MaterialRegistry';

describe('Реестр физических профилей материалов в СИ и температурные кривые Еврокода', () => {
  it('проверяет полноту, иммутабельность и конечность всех 22 полей для каждого из 6 материалов', () => {
    expect(Object.isFrozen(MATERIAL_PROFILES)).toBe(true);
    const all = getAllMaterialProfiles();
    expect(all).toHaveLength(6);
    expect(Object.isFrozen(all)).toBe(true);

    for (const id of STRUCTURAL_MATERIAL_IDS) {
      const profile = getMaterialProfile(id);
      expect(profile.id).toBe(id);
      expect(Object.isFrozen(profile)).toBe(true);
      expect(Object.isFrozen(profile.voronoiAnisotropy)).toBe(true);
      expect(profile.nameRu.trim().length).toBeGreaterThan(3);

      // Все числовые характеристики должны быть строго конечными числами (без Infinity/NaN)
      const numericValues = [
        profile.densityKgM3,
        profile.compressiveStrengthMPa,
        profile.tensileStrengthMPa,
        profile.shearCohesionMPa,
        profile.internalFrictionCoeff,
        profile.youngsModulusGPa,
        profile.brittleness,
        profile.plasticYieldRatio,
        profile.voronoiAnisotropy[0],
        profile.voronoiAnisotropy[1],
        profile.voronoiAnisotropy[2],
        profile.ignitionTempC,
        profile.detonationTempC,
        profile.detonationEquivalentKgTnt,
        profile.thermalConductivity,
        profile.friction,
        profile.restitution,
        profile.baseColorHex,
        profile.interiorCutColorHex,
      ];
      for (const num of numericValues) {
        expect(Number.isFinite(num)).toBe(true);
      }
      expect(Object.keys(profile)).toHaveLength(22);
    }
  });

  it('проверяет физическую иерархию плотностей, прочностей, арматуры, горючести и взрывоопасности в СИ', () => {
    const rc = getMaterialProfile('reinforced_concrete');
    const brick = getMaterialProfile('brick');
    const glass = getMaterialProfile('glass');
    const wood = getMaterialProfile('wood');
    const steel = getMaterialProfile('steel');
    const explosive = getMaterialProfile('explosive');

    // Иерархия плотности СИ (кг/м³)
    expect(steel.densityKgM3).toBeGreaterThan(glass.densityKgM3);
    expect(glass.densityKgM3).toBeGreaterThan(rc.densityKgM3);
    expect(rc.densityKgM3).toBeGreaterThan(brick.densityKgM3);
    expect(brick.densityKgM3).toBeGreaterThan(explosive.densityKgM3);
    expect(explosive.densityKgM3).toBeGreaterThan(wood.densityKgM3);

    // Арматурные тяжи только у железобетона
    expect(rc.hasRebarTethers).toBe(true);
    expect(brick.hasRebarTethers).toBe(false);
    expect(glass.hasRebarTethers).toBe(false);
    expect(wood.hasRebarTethers).toBe(false);
    expect(steel.hasRebarTethers).toBe(false);
    expect(explosive.hasRebarTethers).toBe(false);

    // Пластический шарнир у конструкционной стали S355 (f_y / f_u < 1.0)
    expect(steel.plasticYieldRatio).toBeCloseTo(0.725, 4);
    expect(rc.plasticYieldRatio).toBe(1.0);
    expect(glass.plasticYieldRatio).toBe(1.0);

    // Стекло имеет минимальную предельную упругую деформацию растяжения f_t / E
    const glassStrainUlt = glass.tensileStrengthMPa / (glass.youngsModulusGPa * 1000);
    const rcStrainUlt = rc.tensileStrengthMPa / (rc.youngsModulusGPa * 1000);
    const woodStrainUlt = wood.tensileStrengthMPa / (wood.youngsModulusGPa * 1000);
    expect(glassStrainUlt).toBeLessThan(rcStrainUlt * 0.15);
    expect(glassStrainUlt).toBeLessThan(woodStrainUlt * 0.05);

    // Горючесть дерева и взрывоопасность ёмкостей
    expect(wood.flammable).toBe(true);
    expect(wood.ignitionTempC).toBe(260);
    expect(wood.volatile).toBe(false);

    expect(explosive.flammable).toBe(true);
    expect(explosive.volatile).toBe(true);
    expect(explosive.ignitionTempC).toBe(220);
    expect(explosive.detonationTempC).toBe(250);
    expect(explosive.detonationEquivalentKgTnt).toBe(25.0);
  });

  it('точно воспроизводит табличные узлы Еврокода EN 1993-1-2 (сталь) и EN 1992-1-2 (ЖБ)', () => {
    // EN 1993-1-2, Table 3.1 для стали
    expect(computeThermalStrengthRetention('steel', 20)).toBeCloseTo(1.0, 6);
    expect(computeThermalStrengthRetention('steel', 400)).toBeCloseTo(1.0, 6);
    expect(computeThermalStrengthRetention('steel', 500)).toBeCloseTo(0.78, 6);
    expect(computeThermalStrengthRetention('steel', 600)).toBeCloseTo(0.47, 6);
    expect(computeThermalStrengthRetention('steel', 700)).toBeCloseTo(0.23, 6);
    expect(computeThermalStrengthRetention('steel', 800)).toBeCloseTo(0.11, 6);

    expect(computeThermalStiffnessRetention('steel', 100)).toBeCloseTo(1.0, 6);
    expect(computeThermalStiffnessRetention('steel', 200)).toBeCloseTo(0.9, 6);
    expect(computeThermalStiffnessRetention('steel', 400)).toBeCloseTo(0.7, 6);
    expect(computeThermalStiffnessRetention('steel', 600)).toBeCloseTo(0.31, 6);
    expect(computeThermalStiffnessRetention('steel', 700)).toBeCloseTo(0.13, 6);
    expect(computeThermalStiffnessRetention('steel', 800)).toBeCloseTo(0.09, 6);

    // EN 1992-1-2, Table 3.1 для железобетона
    expect(computeThermalStrengthRetention('reinforced_concrete', 100)).toBeCloseTo(1.0, 6);
    expect(computeThermalStrengthRetention('reinforced_concrete', 200)).toBeCloseTo(0.95, 6);
    expect(computeThermalStrengthRetention('reinforced_concrete', 400)).toBeCloseTo(0.75, 6);
    expect(computeThermalStrengthRetention('reinforced_concrete', 600)).toBeCloseTo(0.45, 6);
    expect(computeThermalStrengthRetention('reinforced_concrete', 800)).toBeCloseTo(0.15, 6);
  });

  it('гарантирует монотонное убывание температурных кривых, выгорание дерева (charRatio) и пороги термошока', () => {
    for (const id of STRUCTURAL_MATERIAL_IDS) {
      let prevStrength = computeThermalStrengthRetention(id, 20);
      let prevStiffness = computeThermalStiffnessRetention(id, 20);
      expect(prevStrength).toBeCloseTo(1.0, 6);
      expect(prevStiffness).toBeCloseTo(1.0, 6);

      for (let temp = 45; temp <= 1250; temp += 25) {
        const curStrength = computeThermalStrengthRetention(id, temp);
        const curStiffness = computeThermalStiffnessRetention(id, temp);
        expect(curStrength).toBeLessThanOrEqual(prevStrength + 1e-12);
        expect(curStiffness).toBeLessThanOrEqual(prevStiffness + 1e-12);
        expect(curStiffness).toBeGreaterThanOrEqual(MIN_STIFFNESS_RETENTION);
        prevStrength = curStrength;
        prevStiffness = curStiffness;
      }
    }

    // Дерево при воспламенении (260 °C) и прогрессирующем обугливании charRatio -> 1.0
    expect(computeThermalStrengthRetention('wood', 260, 0)).toBeCloseTo(0.44, 6);
    const halfChar = computeThermalStrengthRetention('wood', 260, 0.5);
    expect(halfChar).toBeGreaterThan(0.1);
    expect(halfChar).toBeLessThan(0.2);
    expect(computeThermalStrengthRetention('wood', 260, 1.0)).toBe(0);
    expect(computeThermalStiffnessRetention('wood', 900, 1.0)).toBe(MIN_STIFFNESS_RETENTION);

    // Термошок стекла и шелушение кладки
    expect(isThermalShockTriggered('glass', GLASS_THERMAL_SHOCK_TEMP_C - 5, 20)).toBe(false);
    expect(isThermalShockTriggered('glass', GLASS_THERMAL_SHOCK_TEMP_C + 5, 0)).toBe(true);
    expect(isThermalShockTriggered('glass', 80, GLASS_THERMAL_SHOCK_DELTA_C + 5)).toBe(true);
    expect(isThermalShockTriggered('brick', 300, MASONRY_SPALLING_DELTA_C + 10)).toBe(true);
    expect(isThermalShockTriggered('steel', 900, 700)).toBe(false);

    // Воспламенение и тепловая детонация
    expect(isIgnitionTriggered('wood', 259)).toBe(false);
    expect(isIgnitionTriggered('wood', 260)).toBe(true);
    expect(isIgnitionTriggered('steel', 1100)).toBe(false);

    expect(isThermalDetonationTriggered('explosive', 249)).toBe(false);
    expect(isThermalDetonationTriggered('explosive', 250)).toBe(true);
    expect(isThermalDetonationTriggered('wood', 800)).toBe(false);
  });
});
