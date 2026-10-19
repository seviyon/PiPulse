import type { Sample } from '@pipulse/storage';

/** An in-process publish/subscribe channel; the API never imports the producers directly. */
export interface Feed<T> {
  /** Registers a listener; returns a function that removes it. */
  subscribe(listener: (value: T) => void): () => void;
}

/** Live samples for the /api/live WebSocket. */
export type LiveFeed = Feed<Sample>;

export function createFeed<T>(): Feed<T> & { publish(value: T): void } {
  const listeners = new Set<(value: T) => void>();
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    publish(value) {
      for (const listener of listeners) {
        try {
          listener(value);
        } catch {
          // One broken subscriber (e.g. a socket mid-close) must not starve the others.
        }
      }
    }
  };
}

/** An in-process LiveFeed the scheduler publishes into. */
export function createLiveFeed(): LiveFeed & { publish(sample: Sample): void } {
  return createFeed<Sample>();
}
