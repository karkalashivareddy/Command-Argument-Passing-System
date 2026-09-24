import type { CanonicalEvent } from "../types/observability.js";

type Listener = (ev: CanonicalEvent) => void;

/**
 * In-process pub/sub for events. The execution runner publishes;
 * per-session SSE streams and any live watchers subscribe. Sessions that
 * are already stored are replayed from SQLite on connect, so the bus only
 * needs to deliver events that occur after a connection is established.
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
    if (channel) for (const fn of channel) fn(ev);

    const global = this.channels.get(EventBus.GLOBAL);
    if (global) for (const fn of global) fn(ev);
  }

  listenerCount(channel: string): number {
    return this.channels.get(channel)?.size ?? 0;
  }
}
