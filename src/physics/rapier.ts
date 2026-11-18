import * as RAPIER from '@dimforge/rapier3d-deterministic-compat';

export type RapierModule = typeof RAPIER;

let rapierInitPromise: Promise<RapierModule> | null = null;
let rapierInitialized = false;

/**
 * Идемпотентно инициализирует WASM-ядро @dimforge/rapier3d-deterministic-compat.
 * Безопасен для повторных и конкурентных вызовов (Promise.all) в Node.js (Vitest) и браузере.
 */
export async function initRapier(): Promise<RapierModule> {
  if (rapierInitialized) {
    return RAPIER;
  }
  if (!rapierInitPromise) {
    rapierInitPromise = RAPIER.init()
      .then(() => {
        rapierInitialized = true;
        return RAPIER;
      })
      .catch((error: unknown) => {
        rapierInitPromise = null;
        throw error;
      });
  }
  return rapierInitPromise;
}

/**
 * Возвращает true, если WASM-модуль Rapier3D уже полностью инициализирован.
 */
export function isRapierInitialized(): boolean {
  return rapierInitialized;
}

/**
 * Синхронная проверка готовности WASM-ядра перед созданием физических объектов.
 */
export function assertRapierInitialized(): void {
  if (!rapierInitialized) {
    throw new Error(
      'Rapier3D WASM ещё не инициализирован. Дождитесь завершения await initRapier() перед созданием мира или коллайдеров.',
    );
  }
}

export { RAPIER };
export default RAPIER;
