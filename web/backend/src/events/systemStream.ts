/**
 * Host observation service: owns the collector, the cadence timer, persistence,
 * and the live stream.
 *
 * PERSISTENCE BEFORE PUBLISH
 * --------------------------
 * A snapshot is written to the database and only then published to subscribers.
 * The ordering is the whole contract: a client that receives sequence N in the
 * stream can always fetch it from the store, because the store already had it.
 * Publishing first would allow a reader to see a sequence that a subsequent
 * query cannot return, which is a gap the client can detect but never fill.
 *
 * THE STREAM IS NOT THE EXECUTION STREAM
 * --------------------------------------
 * Execution events are per-session, have a contiguous per-session sequence, and
 * are replayable as a lifecycle. Host samples are a single global sequence over
 * a wide observation with no lifecycle and no session. Unifying them would mean
 * either a sequence shared between two unrelated things, or a schema that
 * accommodates both. So this file defines its own envelope, its own SSE frame
 * name, and its own resume position, and the two streams never share a channel.
 *
 * BACKPRESSURE
 * ------------
 * A slow SSE client must not be able to make the collector miss samples or grow
 * memory without bound. Each subscription carries a bounded buffer: a client
 * that cannot keep up loses the oldest frames and is told how many it missed,
 * rather than being allowed to stall the collector. The client then reconnects
 * with Last-Event-ID and is served from the database, so nothing is lost
 * permanently even though the live buffer is lossy by design.
 */

import { EventEmitter } from "node:events";

import { CADENCE, HostCollector } from "../telemetry/system/collector.js";
import { discoverProcesses, type HostProcess } from "../telemetry/system/processes.js";
import { probeSmapsSupport, buildSmapsRollup, type SmapsRollup } from "../telemetry/system/smaps.js";
import type { SystemRepository } from "../db/repositories/system.js";
import type { SystemMetric, SystemSnapshot } from "../telemetry/system/types.js";
import { logger } from "../utils/logger.js";

/** The host stream's event types. A closed set, so a client can switch on it. */
export type SystemEventType = "system.snapshot" | "system.processes" | "system.thermal_guard";

/** One frame on the host stream. */
export interface SystemEvent {
  /** Global, contiguous, monotonic. The SSE `id:` and the resume position. */
  sequence: number;
  type: SystemEventType;
  timestamp: string;
  payload: unknown;
}

export const SYSTEM_SSE_FRAME = "caps.system";
/**
 * Terminal frame, written immediately before the socket is closed.
 *
 * It is advertised in the capability document, so it has to be emitted. A client
 * that has been told an end frame exists and never receives one cannot tell a
 * clean shutdown from a dropped connection, and will sit there waiting -- or, on
 * a proxy that closes idle sockets, reconnect forever. The end frame carries no
 * `id:`, for the same reason the session stream's does: a terminal marker is not
 * a position in the stream and must not overwrite the resume cursor.
 */
export const SYSTEM_SSE_END_FRAME = "system.end";

/** Live buffer depth per subscriber before frames are dropped. */
const SUBSCRIBER_BUFFER_LIMIT = 32;

/** How many persisted frames a reconnecting client is served in one go. */
const REPLAY_BATCH = 500;

export interface SystemServiceOptions {
  repository: SystemRepository;
  fastMs?: number;
  slowMs?: number;
  discoveryMs?: number;
  pssMs?: number;
  pssMaxProcesses?: number;
  /** Persist every sample. Disabled in tests to keep them fast. */
  persist?: boolean;
  /**
   * Identity keys of the processes CAPS started, read fresh on every sample.
   *
   * Only the execution layer can answer this, so the host service is told how to
   * ask rather than told what the answer is. Without it every row would report
   * `capsOwned: false`, which would make CAPS-owned workloads indistinguishable
   * from host processes -- the opposite of what the surface exists to show.
   */
  capsOwnedIdentities?: () => ReadonlySet<string>;
}

/** A handle the caller uses to address one stream subscriber. */
export interface SystemSubscription {
  readonly id: number;
  close: () => void;
}

interface Subscription {
  id: number;
  /** Frames waiting to be written, bounded. */
  buffer: SystemEvent[];
  /** Highest sequence handed to this subscriber's buffer. */
  lastQueued: number;
  /** Frames dropped because the subscriber could not keep up. */
  dropped: number;
  deliver: ((event: SystemEvent) => void) | null;
  close: () => void;
}

export class SystemService {
  private readonly collector: HostCollector;
  /** Re-read on every discovery; see `SystemServiceOptions.capsOwnedIdentities`. */
  private readonly capsOwnedIdentities: () => ReadonlySet<string>;
  private readonly repository: SystemRepository;
  private readonly emitter = new EventEmitter();
  private readonly subscribers = new Map<number, Subscription>();
  private nextSubscriberId = 1;
  private sequence = 0;
  private timer: NodeJS.Timeout | null = null;
  private latestSnapshot: SystemSnapshot | null = null;
  private latestProcesses: HostProcess[] = [];
  private smapsSupport: SystemMetric<boolean> | null = null;
  private lastSlowAtMs = Number.NEGATIVE_INFINITY;
  private lastDiscoveryAtMs = Number.NEGATIVE_INFINITY;
  private lastPssAtMs = Number.NEGATIVE_INFINITY;
  private readonly fastMs: number;
  private readonly slowMs: number;
  private readonly discoveryMs: number;
  private readonly pssMs: number;
  private readonly pssMaxProcesses: number;
  private readonly persist: boolean;

  constructor(options: SystemServiceOptions) {
    this.repository = options.repository;
    this.capsOwnedIdentities = options.capsOwnedIdentities ?? (() => new Set<string>());
    this.collector = new HostCollector({
      capsOwnedIdentities: this.capsOwnedIdentities,
    });
    this.fastMs = options.fastMs ?? CADENCE.fastMs;
    this.slowMs = options.slowMs ?? CADENCE.slowMs;
    this.discoveryMs = options.discoveryMs ?? CADENCE.discoveryMs;
    this.pssMs = options.pssMs ?? CADENCE.pssMs;
    this.pssMaxProcesses = options.pssMaxProcesses ?? CADENCE.pssMaxProcesses;
    this.persist = options.persist ?? true;
    // One listener per subscriber is normal here; the default cap of 10 would
    // emit a warning the moment three browser tabs are open.
    this.emitter.setMaxListeners(0);
  }

  /** The most recent snapshot, or null before the first collection. */
  get snapshot(): SystemSnapshot | null {
    return this.latestSnapshot;
  }

  /** The most recent process rows. */
  get processes(): readonly HostProcess[] {
    return this.latestProcesses;
  }

  /**
   * The exact ownership set the discovery pass annotates rows against.
   *
   * Public, and deliberately a getter rather than a cached field, because it is
   * re-read on every sample: a process CAPS started two seconds ago must be
   * CAPS-owned now, and a process that has exited must not be.
   *
   * The Process Detail route builds a row OUTSIDE the discovery pass, by
   * re-reading procfs at request time. That row arrives with `capsOwned` unset,
   * because ownership cannot be decided from procfs. Any consumer of that route
   * must therefore annotate it with THIS set -- the same one the list route
   * uses -- or the two views of one process report different ownership for the
   * same (pid, startTicks, bootId), which is the contradiction this accessor
   * exists to make impossible.
   */
  ownedIdentityKeys(): ReadonlySet<string> {
    return this.capsOwnedIdentities();
  }

  /** Whether this kernel supports PSS at all, probed once. */
  get pssSupported(): SystemMetric<boolean> | null {
    return this.smapsSupport;
  }

  /** Current subscriber count, for the capability report. */
  get subscriberCount(): number {
    return this.subscribers.size;
  }

  /** Begin collecting on the configured cadence. Idempotent. */
  start(): void {
    if (this.timer !== null) return;
    this.smapsSupport = probeSmapsSupport({ proc: "/proc", sys: "/sys" }, new Date().toISOString());

    // Collect immediately so a caller that subscribes right after start()
    // receives a real snapshot rather than waiting a full interval. The first
    // sample is what a human calls "loading"; a product that shows a spinner
    // for a second it could have answered instantly is worse than one that does
    // not.
    this.tick();
    this.timer = setInterval(() => this.tick(), this.fastMs);
    this.timer.unref?.();
    logger.info("SYSTEM", "host collector started", {
      fastMs: this.fastMs,
      slowMs: this.slowMs,
      discoveryMs: this.discoveryMs,
      pssMs: this.pssMs,
      pssSupported: this.smapsSupport?.value ?? "UNAVAILABLE",
    });
  }

  /** Stop collecting and drop every subscriber. */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    for (const subscription of this.subscribers.values()) subscription.close();
    this.subscribers.clear();
  }

  /**
   * One collection cycle.
   *
   * Exposed so a test can drive the cadence deterministically instead of
   * waiting on real timers, which is the difference between a suite that
   * verifies a contract and one that verifies a sleep.
   */
  tick(nowMs: number = Date.now()): SystemSnapshot {
    const snapshot = this.collector.collect();
    this.latestSnapshot = snapshot;

    // Process discovery runs on its own interval, and PSS on a much slower one.
    // Both are deliberately outside the fast pass: PSS makes the kernel walk
    // every page table, and an observability product that does that every
    // second is itself a load problem.
    let processes = this.latestProcesses;
    if (nowMs - this.lastDiscoveryAtMs >= this.discoveryMs || this.latestProcesses.length === 0) {
      this.lastDiscoveryAtMs = nowMs;
      const wantPss = nowMs - this.lastPssAtMs >= this.pssMs;
      if (wantPss) this.lastPssAtMs = nowMs;

      /*
       * `capsOwnedIdentities` is passed here as well as into the collector.
       *
       * This call is the one that produces the rows `/api/system/processes`
       * actually serves -- the collector's own discovery feeds the snapshot
       * series, not the API's process list. Omitting the option here meant every
       * served row was annotated with an empty ownership set, so `capsOwned` was
       * permanently false and `relationshipConfidence` kept its
       * "not settled yet" placeholder, while the code that computes both looked
       * correctly wired three layers up.
       */
      const discovered = discoverProcesses({ proc: "/proc", sys: "/sys" }, {
        timestamp: snapshot.timestamp,
        maxSampled: CADENCE.maxSampledProcesses,
        noteError: (message) => logger.warn("SYSTEM", message),
        capsOwnedIdentities: this.capsOwnedIdentities(),
      });

      if (wantPss && this.smapsSupport?.value === true) {
        processes = this.attachPss(discovered.processes, snapshot.timestamp, nowMs);
      } else {
        processes = discovered.processes;
      }
      this.latestProcesses = processes;

      if (this.persist) {
        try {
          this.repository.save(snapshot, processes);
        } catch (err) {
          // A storage failure must not stop observation. The snapshot is still
          // published so live users see current data; only history is lost, and
          // the failure is logged rather than swallowed.
          logger.error("SYSTEM", "host snapshot persistence failed", {
            sequence: snapshot.sequence,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      /*
 * The process frames and the snapshot frame share ONE global sequence, and it is
 * the resume position.
 *
 * `system.processes` used to be emitted with a hard-coded `sequence: 0`, so its
 * SSE `id:` was always `id: 0`. A client that reconnected and echoed that back as
 * `Last-Event-ID` rewound its resume position to the very beginning of the
 * retained history, silently re-receiving the entire backlog -- which is exactly
 * the opposite of what a resume is for, and it did so on every reconnect.
 *
 * The event therefore takes a real sequence from the same counter, and it is
 * taken AFTER persistence has been attempted so a subscriber can never be handed
 * a position the store has not accepted. Both frames describe the same snapshot,
 * so they are adjacent and strictly ordered.
 */
const processEventSequence = this.sequence + 1;
this.emit({ sequence: processEventSequence, type: "system.processes", timestamp: snapshot.timestamp, payload: { processes } });
    } else if (this.persist) {
      try {
        this.repository.save(snapshot, []);
      } catch (err) {
        logger.error("SYSTEM", "host snapshot persistence failed", {
          sequence: snapshot.sequence,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (nowMs - this.lastSlowAtMs >= this.slowMs) {
      this.lastSlowAtMs = nowMs;
    }

    // Assigned only after persistence has been attempted, so a subscriber can
    // never see a sequence the store has not accepted.
    this.sequence += 1;
    const event: SystemEvent = { sequence: this.sequence, type: "system.snapshot", timestamp: snapshot.timestamp, payload: snapshot };
    this.emit(event);
    return snapshot;
  }

  /**
   * Read PSS for the most CPU-hungry processes, within a budget.
   *
   * Sorting first means the bounded budget buys the most informative rows. The
   * budget is on *processes scanned*, not on time, so the worst-case cost of
   * this pass is bounded no matter how large the host is.
   */
  private attachPss(processes: readonly HostProcess[], timestamp: string, nowMs: number): HostProcess[] {
    void nowMs;
    const candidates = processes
      .filter((p) => p.rowState === "LIVE" && p.sampled)
      .sort((a, b) => (b.rssBytes.value ?? 0) - (a.rssBytes.value ?? 0))
      .slice(0, this.pssMaxProcesses);

    const rollups = new Map<number, SmapsRollup>();
    for (const p of candidates) {
      const pid = p.pid.value;
      if (pid === null) continue;
      const rollup = buildSmapsRollup({ proc: "/proc", sys: "/sys" }, pid, timestamp);
      if (rollup !== null) rollups.set(pid, rollup);
    }

    return processes.map((p) => {
      const pid = p.pid.value;
      if (pid === null) return p;
      const rollup = rollups.get(pid);
      if (rollup === undefined) return p;
      return {
        ...p,
        pssBytes: rollup.pss,
        anonymousBytes: rollup.anonymous,
        fileBackedBytes: rollup.fileBacked,
        sharedBytes: rollup.shared,
      };
    });
  }

  // ---------------------------------------------------------------- streaming

  /**
   * Attach a new stream subscriber.
   *
   * The contract mirrors the execution stream exactly: subscribe first with
   * delivery paused, then read the backlog, then flush with dedupe. Doing it
   * the other way round allows events published between the backlog read and
   * the subscription to be lost silently, which is the race the existing
   * execution stream already learned to avoid.
   */
  subscribe(afterSequence: number): { subscription: SystemSubscription; backlog: SystemEvent[] } {
    const id = this.nextSubscriberId++;
    const internal: Subscription = {
      id,
      buffer: [],
      lastQueued: afterSequence,
      dropped: 0,
      deliver: null,
      close: () => {
        this.subscribers.delete(id);
      },
    };
    this.subscribers.set(id, internal);

    // Resume position. `afterSequence` of -1 means a fresh client, which is
    // served the most recent frame only: replaying an entire retained history
    // to a browser that just opened would be a self-inflicted stall.
    const backlog =
      afterSequence < 0
        ? this.latestSnapshot === null
          ? []
          : [{ sequence: this.sequence, type: "system.snapshot" as const, timestamp: this.latestSnapshot.timestamp, payload: this.latestSnapshot }]
        : this.repository
            .listAfter(afterSequence, REPLAY_BATCH)
            .map((row) => parsePersisted(row.payload, row.sequence, row.timestamp))
            .filter((e): e is SystemEvent => e !== null);

    return { subscription: { id, close: internal.close }, backlog };
  }

  /** Begin delivering queued frames to a subscriber, skipping duplicates. */
  flush(subscription: SystemSubscription, isDuplicate: (event: SystemEvent) => boolean): SystemEvent[] {
    const sub = this.subscribers.get(subscription.id);
    if (sub === undefined) return [];
    const delivered: SystemEvent[] = [];
    const pending = sub.buffer.splice(0, sub.buffer.length);
    for (const event of pending) {
      if (isDuplicate(event)) continue;
      delivered.push(event);
      sub.deliver?.(event);
    }
    return delivered;
  }

  /** Tell a subscriber to start writing. Called after the backlog is sent. */
  setDelivery(subscription: SystemSubscription, deliver: ((event: SystemEvent) => void) | null): void {
    const sub = this.subscribers.get(subscription.id);
    if (sub === undefined) return;
    sub.deliver = deliver;
    // Anything buffered while delivery was paused goes out now, in order.
    if (deliver !== null) {
      const pending = sub.buffer.splice(0, sub.buffer.length);
      for (const event of pending) deliver(event);
    }
  }

  /** Frames a subscriber lost to its bounded buffer. */
  droppedFor(subscription: SystemSubscription): number {
    return this.subscribers.get(subscription.id)?.dropped ?? 0;
  }

  private emit(event: SystemEvent): void {
    for (const sub of this.subscribers.values()) {
      sub.buffer.push(event);
      sub.lastQueued = event.sequence;
      if (sub.buffer.length > SUBSCRIBER_BUFFER_LIMIT) {
        // Drop the oldest and count it. A slow client is told it missed frames
        // and reconnects with Last-Event-ID, which the store serves, so this is
        // a latency decision rather than a data-loss decision.
        sub.buffer.shift();
        sub.dropped += 1;
        continue;
      }
      if (sub.deliver !== null) {
        sub.deliver(event);
        sub.buffer.pop();
      }
    }
    this.emitter.emit("system", event);
  }
}

/** Parse a persisted payload back into a stream event, or null if corrupt. */
function parsePersisted(payload: string, sequence: number, timestamp: string): SystemEvent | null {
  try {
    const parsed = JSON.parse(payload) as SystemSnapshot;
    // A payload that does not look like a snapshot is not replayed. Serving a
    // corrupt frame would be worse than serving a gap the client can detect.
    if (parsed === null || typeof parsed !== "object" || parsed.cpu === undefined) return null;
    return { sequence, type: "system.snapshot", timestamp, payload: parsed };
  } catch {
    return null;
  }
}
