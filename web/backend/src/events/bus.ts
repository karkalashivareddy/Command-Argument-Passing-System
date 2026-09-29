import type { CanonicalEvent } from "../types/observability.js";

type Listener = (ev: CanonicalEvent) => void;

/**
 * In-process pub/sub.
 *
 * The bus exists to deliver events that happen *after* a subscriber attaches;
 * the event store is the source of truth for everything before that.  The
 * previous route code read the store, computed the last sequence, and only
 * then subscribed -- a window in which an event could be both persisted and
 * published with nobody listening, so a connected client silently missed it.
 *
 * `subscribeBuffered` closes that window by attaching the listener *first*,
 * with delivery paused into a buffer.  The caller then reads the store, sends
 * the persisted backlog, and finally calls `flush()`, which delivers whatever
 * accumulated during the read and drops anything already sent.  There is no
 * window in which a published event has no listener.
 */
export class EventBus {
  private readonly channels = new Map<string, Set<Listener>>();
  /** "global" pseudo-channel for listeners that want every session event. */
  static readonly GLOBAL = "*global*";

  subscribe(channel: string, fn: Listener): () => void {
    let set = this.channels.get(channel);
    if (!set) {
      set = new Set<Listener>();
      this.channels.set(channel, set);
    }
    set.add(fn);
    return () => {
      set!.delete(fn);
      if (set!.size === 0) this.channels.delete(channel);
    };
  }

  publish(ev: CanonicalEvent): void {
    const channel = this.channels.get(ev.sessionId);
    // Copy before iterating: a listener may unsubscribe during delivery.
    if (channel) for (const fn of [...channel]) fn(ev);

    const global = this.channels.get(EventBus.GLOBAL);
    if (global) for (const fn of [...global]) fn(ev);
  }

  listenerCount(channel: string): number {
    return this.channels.get(channel)?.size ?? 0;
  }

  /**
   * Subscribe with a delivery buffer.
   *
   * Usage order is load-bearing and the type system cannot express it, so it
   * is stated here: `subscribeBuffered()` first, then read the store, then
   * `flush()`.  Calling `flush()` before the read is a bug -- it would restore
   * the very race this function exists to remove.
   */
  subscribeBuffered(channel: string): BufferedSubscription {
    const buffer: CanonicalEvent[] = [];
    let live = false;
    let released = false;
    let current: (ev: CanonicalEvent) => void = () => {};

    const listener: Listener = (ev) => {
      // Before the flush, delivery is paused into the buffer; after it, events
      // go straight to the live target.  The flag is what makes the second
      // state different from the first, so it is set by flush() and not by
      // setDelivery() -- a caller that sets the target early is still buffering.
      if (live) {
        current(ev);
        return;
      }
      buffer.push(ev);
    };

    const unsubscribe = this.subscribe(channel, listener);

    return {
      /** Replace the live delivery target; used once the backlog has been sent. */
      setDelivery(fn: (ev: CanonicalEvent) => void): void {
        current = fn;
      },
      /**
       * Deliver everything buffered while the store was being read, then
       * switch to live delivery.
       *
       * `isDuplicate` is consulted for the buffered events only, so this stays
       * O(buffer) rather than O(history).
       */
      flush(isDuplicate: (ev: CanonicalEvent) => boolean): CanonicalEvent[] {
        const delivered: CanonicalEvent[] = [];
        for (const ev of buffer) {
          if (released) break;
          if (isDuplicate(ev)) continue;
          current(ev);
          delivered.push(ev);
        }
        buffer.length = 0;
        // Live from here on.  Set even if `released`, so a post-close publish
        // is a no-op rather than growing the buffer forever.
        live = true;
        return delivered;
      },
      /** Stop buffering and deliver nothing further. */
      close(): void {
        released = true;
        live = true;
        buffer.length = 0;
        unsubscribe();
      },
      get pending(): number {
        return buffer.length;
      },
    };
  }
}

export interface BufferedSubscription {
  setDelivery(fn: (ev: CanonicalEvent) => void): void;
  flush(isDuplicate: (ev: CanonicalEvent) => boolean): CanonicalEvent[];
  close(): void;
  readonly pending: number;
}
