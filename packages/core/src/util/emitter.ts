/** Minimal typed event emitter. A throwing listener never breaks the session or other listeners. */
export class Emitter<Events extends object> {
  readonly #listeners = new Map<keyof Events, Set<(payload: never) => void>>();

  on<K extends keyof Events>(event: K, listener: (payload: Events[K]) => void): () => void {
    let set = this.#listeners.get(event);
    if (!set) {
      set = new Set();
      this.#listeners.set(event, set);
    }
    set.add(listener);
    return () => set.delete(listener);
  }

  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    const set = this.#listeners.get(event);
    if (!set) return;
    for (const listener of [...set]) {
      try {
        (listener as (payload: Events[K]) => void)(payload);
      } catch (error) {
        // Listener bugs are the app's problem. Report them asynchronously so they still surface.
        queueMicrotask(() => {
          throw error;
        });
      }
    }
  }

  clear(): void {
    this.#listeners.clear();
  }
}
