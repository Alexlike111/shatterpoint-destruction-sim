import type { ToolId, Vec3 } from '../core/types';
import type { DestructionWorld, SceneRaycastHit } from '../physics/DestructionWorld';

/**
 * Базовый арсенал v0.1 Alpha (6 инструментов) — тонкая прослойка между лучом камеры и фасадом
 * DestructionWorld. Вся физика (баллистика, ударные волны, огонь, сейсмика) исполняется ядром M2.
 */

export const ALPHA_TOOL_ORDER: readonly ToolId[] = [
  'cannon',
  'c4',
  'bomb',
  'cutter',
  'incendiary',
  'seismic',
];

export const ALPHA_TOOL_LABELS_RU: Readonly<Record<ToolId, string>> = {
  cannon: 'Пушка',
  c4: 'Заряд C4',
  bomb: 'Фугас',
  cutter: 'Плазморезак',
  incendiary: 'Термит',
  seismic: 'Сейсмика',
};

export const ALPHA_C4_DELAYS_SEC: readonly number[] = [0, 0.25, 0.5, 1.0];

export interface AlphaRay {
  origin: Vec3;
  direction: Vec3;
}

export interface AlphaToolSettings {
  c4DelaySec: number;
  quakeFrequencyHz: number;
  quakeAmplitudeM: number;
}

export const DEFAULT_ALPHA_TOOL_SETTINGS: AlphaToolSettings = {
  c4DelaySec: 0,
  quakeFrequencyHz: 2.2,
  quakeAmplitudeM: 0.35,
};

export type AlphaToolOutcome =
  | { kind: 'projectile'; projectileId: number }
  | { kind: 'c4_planted'; chargeId: number; point: Vec3 }
  | { kind: 'blast'; center: Vec3 }
  | { kind: 'cut'; hit: SceneRaycastHit | null }
  | { kind: 'ignite'; center: Vec3; events: number }
  | { kind: 'quake' }
  | { kind: 'miss' };

const CANNON_SPEED_MPS = 320;
const CANNON_MASS_KG = 95;
const CANNON_RADIUS_M = 0.24;
const C4_YIELD_KG_TNT = 6;
const BOMB_YIELD_KG_TNT = 60;
const CUTTER_RANGE_M = 40;
const CUTTER_POWER_W = 900_000;
const INCENDIARY_RADIUS_M = 2.6;
const INCENDIARY_TEMP_C = 1150;

/**
 * Применяет выбранный инструмент вдоль луча. Возвращает честный итог операции.
 * Для резака dtSec — длительность прожига за текущий кадр удержания.
 */
export function applyAlphaTool(
  world: DestructionWorld,
  tool: ToolId,
  ray: AlphaRay,
  settings: AlphaToolSettings,
  dtSec = 1 / 60,
): AlphaToolOutcome {
  switch (tool) {
    case 'cannon': {
      const projectileId = world.fireProjectile({
        origin: ray.origin,
        direction: ray.direction,
        speedMpS: CANNON_SPEED_MPS,
        massKg: CANNON_MASS_KG,
        radiusM: CANNON_RADIUS_M,
      });
      return { kind: 'projectile', projectileId };
    }
    case 'c4': {
      const hit = world.raycastScene(ray.origin, ray.direction, 250);
      if (!hit || hit.isGround || hit.nodeId === undefined) {
        return { kind: 'miss' };
      }
      const chargeId = world.plantC4({
        worldPoint: hit.point,
        normal: hit.normal,
        targetNodeId: hit.nodeId,
        delaySec: settings.c4DelaySec,
        yieldKgTnt: C4_YIELD_KG_TNT,
      });
      return { kind: 'c4_planted', chargeId, point: hit.point };
    }
    case 'bomb': {
      const hit = world.raycastScene(ray.origin, ray.direction, 250);
      if (!hit) return { kind: 'miss' };
      const center: Vec3 = [
        hit.point[0] + hit.normal[0] * 0.4,
        hit.point[1] + hit.normal[1] * 0.4,
        hit.point[2] + hit.normal[2] * 0.4,
      ];
      world.triggerBlast({ center, yieldKgTnt: BOMB_YIELD_KG_TNT });
      return { kind: 'blast', center };
    }
    case 'cutter': {
      const hit = world.applyPlasmaCut({
        origin: ray.origin,
        direction: ray.direction,
        rangeM: CUTTER_RANGE_M,
        powerW: CUTTER_POWER_W,
        dtSec,
      });
      return { kind: 'cut', hit };
    }
    case 'incendiary': {
      const hit = world.raycastScene(ray.origin, ray.direction, 250);
      if (!hit) return { kind: 'miss' };
      const events = world.igniteArea({
        center: hit.point,
        radiusM: INCENDIARY_RADIUS_M,
        temperatureC: INCENDIARY_TEMP_C,
      });
      return { kind: 'ignite', center: hit.point, events };
    }
    case 'seismic': {
      world.triggerEarthquake({
        frequencyHz: settings.quakeFrequencyHz,
        amplitudeM: settings.quakeAmplitudeM,
        durationSec: 6,
      });
      return { kind: 'quake' };
    }
    default:
      return { kind: 'miss' };
  }
}
