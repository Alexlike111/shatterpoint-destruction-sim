import type { SimulationEvent, SimulationEventByType, SimulationEventType } from './types';

type AnyEventHandler = (event: SimulationEvent) => void;

/**
 * Типизированная синхронная шина и буфер событий симуляции за тик.
 */
export class SimulationEventBus {
  private readonly listeners = new Map<SimulationEventType, Set<AnyEventHandler>>();
  private readonly wildcardListeners = new Set<AnyEventHandler>();
  private buffer: SimulationEvent[] = [];

  /**
   * Подписывает обработчик на конкретный тип события SimulationEvent.
   * Возвращает функцию отписки.
   */
  public on<K extends SimulationEventType>(
    type: K,
    handler: (event: SimulationEventByType<K>) => void,
  ): () => void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set<AnyEventHandler>();
      this.listeners.set(type, set);
    }
    const wrapped = handler as AnyEventHandler;
    set.add(wrapped);
    return () => {
      this.off(type, handler);
    };
  }

  /**
   * Отписывает обработчик от конкретного типа события.
   */
  public off<K extends SimulationEventType>(
    type: K,
    handler: (event: SimulationEventByType<K>) => void,
  ): void {
    const set = this.listeners.get(type);
    if (!set) {
      return;
    }
    set.delete(handler as AnyEventHandler);
    if (set.size === 0) {
      this.listeners.delete(type);
    }
  }

  /**
   * Подписывает универсальный обработчик на все типы событий симуляции.
   */
  public onAll(handler: (event: SimulationEvent) => void): () => void {
    this.wildcardListeners.add(handler);
    return () => {
      this.offAll(handler);
    };
  }

  /**
   * Отписывает универсальный обработчик.
   */
  public offAll(handler: (event: SimulationEvent) => void): void {
    this.wildcardListeners.delete(handler);
  }

  /**
   * Публикует событие в буфер тика и синхронно уведомляет подписчиков (по снимку множества).
   */
  public emit(event: SimulationEvent): void {
    this.buffer.push(event);

    const typedSet = this.listeners.get(event.type);
    if (typedSet && typedSet.size > 0) {
      const snapshot = Array.from(typedSet);
      for (const handler of snapshot) {
        handler(event);
      }
    }

    if (this.wildcardListeners.size > 0) {
      const wildcardSnapshot = Array.from(this.wildcardListeners);
      for (const handler of wildcardSnapshot) {
        handler(event);
      }
    }
  }

  /**
   * Извлекает накопленные за тик события и очищает внутренний буфер.
   */
  public drain(): SimulationEvent[] {
    if (this.buffer.length === 0) {
      return [];
    }
    const drained = this.buffer;
    this.buffer = [];
    return drained;
  }

  /**
   * Возвращает доступ только для чтения к текущему буферу событий без очистки.
   */
  public peek(): readonly SimulationEvent[] {
    return this.buffer;
  }

  /**
   * Очищает буфер накопленных событий, сохраняя всех активных подписчиков.
   */
  public clear(): void {
    this.buffer = [];
  }

  /**
   * Полностью удаляет все подписки (вызывается при уничтожении мира).
   */
  public removeAllListeners(): void {
    this.listeners.clear();
    this.wildcardListeners.clear();
  }
}
