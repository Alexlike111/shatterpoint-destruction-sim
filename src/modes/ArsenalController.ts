import type { ToolId, Vec3 } from '../core/types';
import type { DestructionWorld, SceneRaycastHit } from '../physics/DestructionWorld';
import type { ToolUpgradeLevel } from './ProgressionStore';

/**
 * Контроллер прокачиваемого арсенала разрушения (Ур. 1 -> Ур. 5, F18 + F24).
 * Масштабирует реальные физические параметры каждого из 6 инструментов по уровню улучшения:
 * - Пушка: масса, начальная скорость, калибр и раскалённый сердечник на Ур. 4–5
 * - Заряд C4: тротиловый эквивалент направленного заряда
 * - Фугас: тротиловый эквивалент и термобарическое воспламенение на Ур. 4–5
 * - Плазморезак: тепловая мощность дуги и эффективная дальность реза
 * - Термит: радиус разброса кассеты и пиковая температура горения
 * - Сейсмика: усиление амплитуды и длительности виброимпульса
 */

export const TOOL_ORDER: readonly ToolId[] = [
  'cannon',
  'c4',
  'bomb',
  'cutter',
  'incendiary',
  'seismic',
];

export const TOOL_META_RU: Readonly<
  Record<
    ToolId,
    {
      nameRu: string;
      shortDescRu: string;
      upgradeDescRu: string;
    }
  >
> = {
  cannon: {
    nameRu: 'Пушка',
    shortDescRu: 'Кинетический бронебойный снаряд',
    upgradeDescRu: 'Калибр, масса снаряда 85→280 кг и начальная скорость 300→490 м/с',
  },
  c4: {
    nameRu: 'Заряд C4',
    shortDescRu: 'Направленный брикет с секвенсором',
    upgradeDescRu: 'Мощность заряда 5→24 кг ТНТ для среза тяжёлых ЖБ-опор',
  },
  bomb: {
    nameRu: 'Фугас',
    shortDescRu: 'Объёмный взрыв волны Садовского',
    upgradeDescRu: 'Тротиловый эквивалент 48→210 кг ТНТ и термобарический поджог',
  },
  cutter: {
    nameRu: 'Плазморезак',
    shortDescRu: 'Непрерывный прожиг балок и арматуры',
    upgradeDescRu: 'Мощность плазменной дуги 0.8→3.0 МВт и дальность луча 36→56 м',
  },
  incendiary: {
    nameRu: 'Термит',
    shortDescRu: 'Высокотемпературная кассета поджога',
    upgradeDescRu: 'Радиус очага 2.4→5.8 м и температура 1150→1950 °C',
  },
  seismic: {
    nameRu: 'Сейсмика',
    shortDescRu: 'Импульс 3D-сейсмоплатформы',
    upgradeDescRu: 'Пиковая амплитуда и длительность сейсмического удара',
  },
};

export interface ToolLevelSpecs {
  cannonSpeedMpS: number;
  cannonMassKg: number;
  cannonRadiusM: number;
  cannonHot: boolean;
  c4YieldKgTnt: number;
  bombYieldKgTnt: number;
  bombIncendiary: boolean;
  cutterRangeM: number;
  cutterPowerW: number;
  incendiaryRadiusM: number;
  incendiaryTempC: number;
  seismicAmpMultiplier: number;
  seismicDurationSec: number;
}

export function getToolSpecsForLevel(level: ToolUpgradeLevel): ToolLevelSpecs {
  const t = (level - 1) / 4; // 0.0 на Ур. 1 .. 1.0 на Ур. 5
  return {
    cannonSpeedMpS: Math.round(300 + 190 * t),
    cannonMassKg: Math.round(85 + 195 * t),
    cannonRadiusM: Number((0.23 + 0.14 * t).toFixed(3)),
    cannonHot: level >= 4,
    c4YieldKgTnt: Number((8.5 + 17.5 * t).toFixed(2)),
    bombYieldKgTnt: Math.round(48 + 162 * t),
    bombIncendiary: level >= 4,
    cutterRangeM: Math.round(110 + 50 * t),
    cutterPowerW: Math.round(1_350_000 + 2_150_000 * t),
    incendiaryRadiusM: Number((2.4 + 3.4 * t).toFixed(2)),
    incendiaryTempC: Math.round(1150 + 800 * t),
    seismicAmpMultiplier: Number((1.0 + 0.85 * t).toFixed(2)),
    seismicDurationSec: Number((5.5 + 3.5 * t).toFixed(1)),
  };
}

/** Возвращает наглядный радиус 3D-прицела на грани для выбранного инструмента и его уровня. */
export function getToolPreviewRadiusM(tool: ToolId, level: ToolUpgradeLevel): number {
  const specs = getToolSpecsForLevel(level);
  switch (tool) {
    case 'cannon':
      return specs.cannonRadiusM * 2.2;
    case 'c4':
      return 0.55 + (level - 1) * 0.14;
    case 'bomb':
      return 1.8 * Math.cbrt(specs.bombYieldKgTnt / 10);
    case 'cutter':
      return 0.36;
    case 'incendiary':
      return specs.incendiaryRadiusM;
    case 'seismic':
      return 2.4;
  }
}

export type ArsenalStrikeOutcome =
  | { kind: 'projectile'; projectileId: number }
  | { kind: 'c4_planted'; chargeId: number; point: Vec3 }
  | { kind: 'blast'; center: Vec3 }
  | { kind: 'cut'; hit: SceneRaycastHit | null; beamEnd: Vec3 }
  | { kind: 'ignite'; center: Vec3; events: number }
  | { kind: 'quake'; freqHz: number; ampM: number }
  | { kind: 'miss' };

export function executeArsenalTool(params: {
  world: DestructionWorld;
  tool: ToolId;
  level: ToolUpgradeLevel;
  rayOrigin: Vec3;
  rayDirection: Vec3;
  c4DelaySec: number;
  quakeFrequencyHz: number;
  quakeAmplitudeM: number;
  dtSec?: number;
}): ArsenalStrikeOutcome {
  const {
    world,
    tool,
    level,
    rayOrigin,
    rayDirection,
    c4DelaySec,
    quakeFrequencyHz,
    quakeAmplitudeM,
    dtSec = 1 / 60,
  } = params;

  const specs = getToolSpecsForLevel(level);

  switch (tool) {
    case 'cannon': {
      const projectileId = world.fireProjectile({
        origin: rayOrigin,
        direction: rayDirection,
        speedMpS: specs.cannonSpeedMpS,
        massKg: specs.cannonMassKg,
        radiusM: specs.cannonRadiusM,
        hot: specs.cannonHot,
      });
      return { kind: 'projectile', projectileId };
    }

    case 'c4': {
      const hit = world.raycastScene(rayOrigin, rayDirection, 260);
      if (!hit || hit.isGround || hit.nodeId === undefined) {
        return { kind: 'miss' };
      }
      const chargeId = world.plantC4({
        worldPoint: hit.point,
        normal: hit.normal,
        targetNodeId: hit.nodeId,
        delaySec: c4DelaySec,
        yieldKgTnt: specs.c4YieldKgTnt,
      });
      return { kind: 'c4_planted', chargeId, point: hit.point };
    }

    case 'bomb': {
      const hit = world.raycastScene(rayOrigin, rayDirection, 260);
      if (!hit) return { kind: 'miss' };
      const center: Vec3 = [
        hit.point[0] + hit.normal[0] * 0.42,
        hit.point[1] + hit.normal[1] * 0.42,
        hit.point[2] + hit.normal[2] * 0.42,
      ];
      world.triggerBlast({
        center,
        yieldKgTnt: specs.bombYieldKgTnt,
        incendiary: specs.bombIncendiary,
      });
      return { kind: 'blast', center };
    }

    case 'cutter': {
      const hit = world.applyPlasmaCut({
        origin: rayOrigin,
        direction: rayDirection,
        rangeM: specs.cutterRangeM,
        powerW: specs.cutterPowerW,
        dtSec,
      });
      const beamEnd: Vec3 = hit
        ? hit.point
        : [
            rayOrigin[0] + rayDirection[0] * specs.cutterRangeM,
            rayOrigin[1] + rayDirection[1] * specs.cutterRangeM,
            rayOrigin[2] + rayDirection[2] * specs.cutterRangeM,
          ];
      return { kind: 'cut', hit, beamEnd };
    }

    case 'incendiary': {
      const hit = world.raycastScene(rayOrigin, rayDirection, 260);
      if (!hit) return { kind: 'miss' };
      const events = world.igniteArea({
        center: hit.point,
        radiusM: specs.incendiaryRadiusM,
        temperatureC: specs.incendiaryTempC,
      });
      return { kind: 'ignite', center: hit.point, events };
    }

    case 'seismic': {
      const effectiveAmp = Math.min(2.5, Math.max(0.05, quakeAmplitudeM * specs.seismicAmpMultiplier));
      world.triggerEarthquake({
        frequencyHz: quakeFrequencyHz,
        amplitudeM: effectiveAmp,
        durationSec: specs.seismicDurationSec,
      });
      return { kind: 'quake', freqHz: quakeFrequencyHz, ampM: effectiveAmp };
    }
  }
}
