/**
 * Host observability API.
 *
 * Every route here reads the live kernel. None of them accepts a filesystem
 * path, a PID without validation, or a metric name that is not in a closed set,
 * because the browser is not trusted to name what the observer reads.
 *
 * THE UNAVAILABLE CONTRACT
 * ------------------------
 * A metric the kernel does not provide is returned as an object with
 * `provenance: "UNAVAILABLE"`, `value: null`, and a `reason` string. It is
 * never returned as `0`, and a route never fails wholesale because one
 * subsystem is missing: a kernel with no PSI still returns a complete snapshot
 * whose pressure block is fully unavailable with the reason. A 200 with an
 * honest gap is more useful to a dashboard than a 500.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { SystemRepository } from "../db/repositories/system.js";
import type { SystemService, SystemEvent } from "../events/systemStream.js";
import { SYSTEM_SSE_FRAME, SYSTEM_SSE_END_FRAME } from "../events/systemStream.js";
import { AGGREGABLE_COLUMNS, COLUMN_LABELS, COLUMN_UNITS } from "../db/repositories/system.js";
import { CADENCE } from "../telemetry/system/collector.js";
import { THERMAL_ABSENT_REASON } from "../telemetry/system/thermal.js";
import { FREQUENCY_ABSENT_REASON } from "../telemetry/system/frequency.js";
import { valueOf } from "../telemetry/system/types.js";
import type { HostProcess } from "../telemetry/system/processes.js";
import { buildSmapsRollup } from "../telemetry/system/smaps.js";
import { readHostProcess, probeClockTicks, annotateRelationships } from "../telemetry/system/processes.js";
import { readBootId } from "../telemetry/system/read.js";
import { logger } from "../utils/logger.js";

/** Maximum simultaneous host-stream connections. */
const MAX_STREAM_CLIENTS = 8;

/** How often an idle stream emits a comment frame to keep proxies from closing it. */
const KEEPALIVE_MS = 15_000;

export interface SystemRouteDeps {
  system: SystemService;
  systemRepo: SystemRepository;
  version: string;
  /** The configured retention window, published rather than left implicit. */
  retentionDays: number;
}

const METRIC_QUERY = z.object({
  metric: z.string().min(1).max(64),
});

const WINDOW_QUERY = z.object({
  window: z.enum(["1m", "5m", "15m", "1h", "6h", "24h", "7d"]).default("1h"),
  bootId: z.string().min(1).max(64).optional(),
  limit: z.coerce.number().int().min(1).max(5000).default(600),
});

const PROCESSES_QUERY = z.object({
  limit: z.coerce.number().int().min(1).max(2000).default(250),
  /** Only rows whose kernel permitted a full read. */
  live: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  /** PSS is only present when the slow pass has run for that process. */
  withPss: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  state: z.string().min(1).max(16).optional(),
});

const WINDOW_SECONDS: Readonly<Record<string, number>> = {
  "1m": 60,
  "5m": 300,
  "15m": 900,
  "1h": 3600,
  "6h": 21_600,
  "24h": 86_400,
  "7d": 604_800,
};

function sendError(reply: FastifyReply, status: number, code: string, message: string): FastifyReply {
  return reply.code(status).send({ error: { code, message } });
}

/** Parse a `Last-Event-ID` header. Returns -1 when absent or malformed. */
function readLastEventId(req: FastifyRequest): number {
  const raw = req.headers["last-event-id"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined) return -1;
  if (!/^\d{1,15}$/.test(value)) return -1;
  return Number(value);
}

export function registerSystemRoutes(app: FastifyInstance, deps: SystemRouteDeps): void {
  const { system, systemRepo } = deps;

  // ------------------------------------------------------------ capabilities
  app.get("/api/system/capabilities", async () => ({
    version: deps.version,
    /**
     * What the host observer actually implements, stated as a capability list
     * rather than implied by a populated chart. A client can use this to decide
     * whether to render a "not available" notice or simply omit a panel.
     */
    subsystems: [
      { id: "cpu", label: "CPU", source: "/proc/stat", available: true, note: "Cumulative USER_HZ counters differenced across samples. Reports aggregate and per-core." },
      { id: "memory", label: "Memory", source: "/proc/meminfo", available: true, note: "used is computed as total - MemAvailable. MemAvailable is a kernel estimate and is labelled as one." },
      { id: "load", label: "Load", source: "/proc/loadavg", available: true, note: "Runnable and uninterruptible task averages. Not CPU utilization." },
      { id: "pressure", label: "Pressure (PSI)", source: "/proc/pressure/{cpu,memory,io}", available: true, note: "Requires CONFIG_PSI. Each field is independently unavailable when the kernel omits the file." },
      { id: "thermal", label: "Thermal", source: "/sys/class/thermal, /sys/class/hwmon", available: true, note: "Discovery only. A host with no sensor reports UNAVAILABLE; no temperature is ever synthesised." },
      { id: "frequency", label: "CPU frequency", source: "/sys/devices/system/cpu/cpufreq", available: true, note: "Policy/governor frequency only. No hardware frequency measurement is implemented." },
      { id: "disk", label: "Disk", source: "/proc/diskstats, statfs(2), /proc/self/mountinfo", available: true, note: "Block-device counters and filesystem capacity are reported separately and never summed." },
      { id: "network", label: "Network", source: "/proc/net/dev", available: true, note: "Host-wide interface counters. Per-process network accounting is not available on Linux and is reported UNAVAILABLE." },
      { id: "processes", label: "Processes", source: "/proc/<pid>", available: true, note: "Identity is (pid, start_ticks, boot_id), not pid alone. Rows carry LIVE, EXITED, DISAPPEARED, PERMISSION_DENIED, or UNAVAILABLE, each classified from the read failure that actually occurred." },
      { id: "pss", label: "PSS", source: "/proc/<pid>/smaps_rollup", available: true, note: "Sampled on a slow cadence for a bounded number of processes, never on the fast pass. Requires CONFIG_PROC_PAGE_MONITOR." },
      { id: "scheduler", label: "Scheduler", source: "/proc/<pid>/schedstat", available: true, note: "Optional kernel telemetry, gated by CONFIG_SCHEDSTATS." },
    ],
    notImplemented: [
      { id: "hardwareFrequency", label: "Measured hardware CPU frequency", reason: "Requires MSR or fixed performance counter access. CAPS installs neither, so no value is reported." },
      { id: "perProcessNetwork", label: "Per-process network traffic", reason: "Linux exposes no per-process byte counters in procfs. An eBPF or netfilter hook would be required." },
      { id: "thermalControl", label: "Fan or thermal-zone control", reason: "CAPS never writes to /sys/class/thermal, /sys/class/hwmon, or any MSR. It observes temperature and never manipulates hardware." },
      { id: "syscallTracing", label: "Syscall tracing", reason: "No ptrace or strace. Only kernel-exposed procfs counters are read." },
      { id: "ebpf", label: "eBPF probes", reason: "No probe attachment. The gateway only reads procfs and sysfs." },
    ],
    cadence: {
      fastMs: CADENCE.fastMs,
      slowMs: CADENCE.slowMs,
      discoveryMs: CADENCE.discoveryMs,
      pssMs: CADENCE.pssMs,
      pssMaxProcesses: CADENCE.pssMaxProcesses,
      detail: "CPU, memory, load, pressure, disk, and network are sampled on the fast cadence. Thermal and frequency are sysfs walks sampled more slowly. Process discovery has its own interval, and PSS is excluded from the fast pass entirely because smaps makes the kernel walk every page table.",
    },
    stream: { frame: SYSTEM_SSE_FRAME, endFrame: SYSTEM_SSE_END_FRAME, maxClients: MAX_STREAM_CLIENTS },
  }));

  // --------------------------------------------------------------- snapshot
  app.get("/api/system/snapshot", async (_req, reply) => {
    const snapshot = system.snapshot;
    if (snapshot === null) {
      // The collector produces a snapshot synchronously on start, so reaching
      // this branch means the collector is not running. That is a real fault
      // and is reported as one, rather than as an empty snapshot that a
      // dashboard would render as a machine with no CPU, no memory, and no
      // processes.
      return sendError(reply, 503, "NO_SNAPSHOT", "The host collector has not produced a snapshot yet.");
    }
    return snapshot;
  });

  // --------------------------------------------------------- process detail
  /**
   * One process, with PSS read on demand.
   *
   * This is the only route that reads `smaps_rollup` for a caller-named
   * process, and that is the whole reason it exists: the fast pass must not do
   * it, so a user who selects a process gets the precise figure on the spot.
   * The PID is validated as a positive integer and looked up by *identity*, so
   * a response describes one specific process rather than whatever holds that
   * PID when a second request is served.
   */
  app.get("/api/system/processes/:identity", async (req, reply) => {
    const params = z
      .object({ identity: z.string().min(3).max(256).regex(/^\d+@[\d?]+#[A-Za-z0-9-]+$/) })
      .safeParse(req.params ?? {});
    if (!params.success) {
      return sendError(
        reply,
        400,
        "INVALID_ARGUMENT",
        "identity must be `<pid>@<startTicks>#<bootId>`, for example `1234@8812345#9fc1ac46-fb28-4e1d-9063-2b1fc7ff5020`. A bare PID is refused because a PID alone is not a process identity: it is reused.",
      );
    }
    const identityKey = params.data.identity;
    const all = system.processes;
    const match = all.find((p) => p.identity.key === identityKey);
    if (match === undefined) {
      return sendError(
        reply,
        404,
        "PROCESS_NOT_FOUND",
        `No live process currently has identity ${identityKey}. It has either exited or been replaced by a different process with the same PID. Query /api/system/processes for the current identities.`,
      );
    }

    const pid = valueOf(match.pid);
    const timestamp = new Date().toISOString();
    // Re-read the identity from procfs at request time. A row cached from the
    // last discovery pass could belong to a process that has since exited and
    // had its PID reused, in which case a fresh read is refused.
    const rollup = pid === null ? null : buildSmapsRollup({ proc: "/proc", sys: "/sys" }, pid, timestamp);
    const fresh = pid === null ? null : readHostProcess({ proc: "/proc", sys: "/sys" }, pid, probeClockTicks(), readBootId({ proc: "/proc", sys: "/sys" }), null, Date.now(), null, {
      includePss: rollup !== null,
      smaps: rollup,
      timestamp,
    });

    // Prefer the freshly-read row. Its identity is the kernel's answer right
    // now, and the cached row is only used when the fresh read failed, in which
    // case the fresh row's UNAVAILABLE fields already say why.
    const row = fresh !== null && fresh.row.identity.key === identityKey ? { ...fresh.row, pssBytes: rollup?.pss ?? fresh.row.pssBytes } : match;

    /*
     * Settle ownership and the parent link against the SAME context the list
     * route uses.
     *
     * `readHostProcess` cannot answer either one: capsOwned asks "did *we*
     * start this?", which only the execution registry knows, and a parent link
     * can only be judged against the rest of the inventory. Both are normally
     * settled by `annotateRelationships` during discovery.
     *
     * A fresh read produced here skips discovery entirely, so it returned
     * capsOwned: false for a process the inventory beside it reported as
     * CAPS-owned. That is the worst kind of disagreement in this product: the
     * detail view is the one a user opens to decide whether a process is
     * attributable and signalable, and it was answering "no" about a process
     * CAPS had forked and still held a verified identity for. The same
     * (pid, startTicks, bootId) must produce the same answer in every view, so
     * the ownership set and the sampled-PID set are both taken from the service
     * rather than from this single row.
     */
    annotateRelationships([row], system.ownedIdentityKeys(), timestamp, new Set(all.map((p) => p.identity.pid)));

    return {
      process: rollup === null ? row : { ...row, pssBytes: rollup.pss, anonymousBytes: rollup.anonymous, fileBackedBytes: rollup.fileBacked, sharedBytes: rollup.shared },
      pss: rollup,
      pssNote:
        "PSS was read from /proc/<pid>/smaps_rollup for this request. It is the precise memory-accounting figure: each shared page is divided among the processes mapping it, so PSS sums correctly across a host where RSS does not.",
      hostContext: {
        cpuBusyPercent: system.snapshot?.cpu.utilization.busyPercent ?? null,
        memoryUsedPercent: system.snapshot?.memory.usedPercent ?? null,
        pressure: system.snapshot?.pressure ?? [],
        thermalHighestCelsius: system.snapshot?.thermal.highestCelsius ?? null,
        load1: system.snapshot?.load.load1 ?? null,
      },
      history: systemRepo.processHistory(identityKey, 600).map((row2) => {
        try {
          return { timestamp: row2.timestamp, process: JSON.parse(row2.payload) as unknown };
        } catch {
          // A corrupt stored row is reported as absent rather than parsed into
          // a partial object that would render as a real measurement.
          return { timestamp: row2.timestamp, process: null };
        }
      }),
    };
  });

  // -------------------------------------------------------------- processes
  app.get("/api/system/processes", async (req, reply) => {
    const parsed = PROCESSES_QUERY.safeParse(req.query ?? {});
    if (!parsed.success) {
      return sendError(reply, 400, "INVALID_ARGUMENT", `Invalid query: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
    }
    const { limit, live, withPss, state } = parsed.data;
    const all = system.processes;
    const filtered = all.filter((p) => {
      if (live && p.rowState !== "LIVE") return false;
      if (state !== undefined && p.state.value !== state) return false;
      return true;
    });
    // PSS is dropped from the response when it has not been read, so a client
    // cannot mistake an absent PSS for a zero one. The full row, including the
    // UNAVAILABLE metric and its reason, is always available per process.
    const rows = filtered.slice(0, limit).map((p) => (withPss ? p : omitPss(p)));
    return {
      processes: rows,
      total: filtered.length,
      returned: rows.length,
      /** Whether this kernel can produce PSS at all, probed once at startup. */
      pssSupported: system.pssSupported,
      pssNote:
        "PSS is read from /proc/<pid>/smaps_rollup on a slow cadence for a bounded number of processes. It is absent from most rows at any instant, which is expected and is reported as UNAVAILABLE with a reason, never as zero.",
      cadence: { fastMs: CADENCE.fastMs, discoveryMs: CADENCE.discoveryMs, pssMs: CADENCE.pssMs, pssMaxProcesses: CADENCE.pssMaxProcesses },
    };
  });

  // ---------------------------------------------------------------- thermal
  app.get("/api/system/thermal", async (_req, reply) => {
    const snapshot = system.snapshot;
    if (snapshot === null) {
      // `sendError` calls `reply.code(...)` immediately, so it needs the real
    // reply object. Passing a literal `{}` -- cast to FastifyReply to satisfy
    // the compiler, and the result cast to `never` to satisfy the caller --
    // threw `reply.code is not a function` and turned a designed 503 into a 500
    // with a stack trace, in exactly the degraded-startup window this branch
    // exists to report cleanly.
    return sendError(reply, 503, "NO_SNAPSHOT", "The host collector has not produced a snapshot yet.");
    }
    return {
      ...snapshot.thermal,
      /**
       * Rendered verbatim by the UI when there is no sensor. Having the exact
       * sentence in the API means the client cannot invent a friendlier but
       * vaguer one.
       */
      absentReason: THERMAL_ABSENT_REASON,
    };
  });

  app.get("/api/system/frequency", async (_req, reply) => {
    const snapshot = system.snapshot;
    if (snapshot === null) {
      // See the thermal route above: a literal `{}` threw inside `sendError`.
      return sendError(reply, 503, "NO_SNAPSHOT", "The host collector has not produced a snapshot yet.");
    }
    return { ...snapshot.frequency, absentReason: FREQUENCY_ABSENT_REASON };
  });

  // --------------------------------------------------------------- analytics
  app.get("/api/system/analytics", async (req, reply) => {
    const parsed = WINDOW_QUERY.safeParse(req.query ?? {});
    if (!parsed.success) {
      return sendError(reply, 400, "INVALID_ARGUMENT", `Invalid query: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
    }
    const { window, bootId, limit } = parsed.data;
    const seconds = WINDOW_SECONDS[window] ?? 3600;
    const since = new Date(Date.now() - seconds * 1000).toISOString();

    const metrics: Record<string, unknown> = {};
    for (const column of AGGREGABLE_COLUMNS) {
      metrics[column] = {
        label: COLUMN_LABELS[column] ?? column,
        unit: COLUMN_UNITS[column] ?? "1",
        mean: systemRepo.aggregate(column, since, bootId ?? null),
        percentiles: systemRepo.percentiles(column, since, bootId ?? null),
        series: systemRepo.series(column, limit, bootId ?? null),
      };
    }
    return {
      window,
      windowSeconds: seconds,
      since,
      bootId: bootId ?? null,
      /** A NULL column is an UNAVAILABLE sample and is excluded, not zeroed. */
      missingDataNote:
        "Every aggregate reports how many samples carried a value and how many did not. A metric the kernel stopped publishing shrinks the sample count rather than dragging the average toward zero.",
      retention: {
        days: deps.retentionDays,
        /**
         * The policy, stated in the response rather than only in the
         * configuration.
         *
         * A retention window that exists but is invisible is indistinguishable
         * from no retention at all, which is precisely the situation an operator
         * reading the API is trying to rule out.
         */
        policy:
          `Host snapshots and their process rows older than ${deps.retentionDays} day(s) are deleted. ` +
          `Sessions and their events use the same window. The sweep is bounded per pass, so a large backlog is cleared ` +
          `over several passes rather than in one long transaction.`,
        whatIsDeleted: [
          "host snapshots older than the cutoff",
          "process rows belonging to those snapshots",
          "sessions older than the cutoff",
          "events belonging to those sessions",
        ],
        whatIsNeverDeleted: [
          "any metric's recorded values: a sweep removes whole samples, it never rewrites one",
          "boot_id: the per-boot breakdown is derived from the samples that remain",
        ],
      },
      metrics,
      storage: systemRepo.stats(),
    };
  });

  app.get("/api/system/health", async () => {
    const snapshot = system.snapshot;
    return {
      collectorHealth: snapshot === null ? null : snapshot.collectorHealth,
      identity: snapshot === null ? null : snapshot.identity,
      streamClients: system.subscriberCount,
      storage: systemRepo.stats(),
      pssSupported: system.pssSupported,
      cadence: {
        fastMs: CADENCE.fastMs,
        slowMs: CADENCE.slowMs,
        discoveryMs: CADENCE.discoveryMs,
        pssMs: CADENCE.pssMs,
        pssMaxProcesses: CADENCE.pssMaxProcesses,
      },
    };
  });

  // ---------------------------------------------------------------- retention
  app.post("/api/system/retention/sweep", async (req, reply) => {
    const parsed = z
      .object({ olderThanHours: z.coerce.number().int().min(1).max(24 * 365).default(24) })
      .safeParse(req.body ?? {});
    if (!parsed.success) {
      return sendError(reply, 400, "INVALID_ARGUMENT", `Invalid body: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
    }
    const cutoff = new Date(Date.now() - parsed.data.olderThanHours * 3600 * 1000).toISOString();
    const removed = systemRepo.purgeOlderThan(cutoff);
    return { cutoff, removed, storage: systemRepo.stats() };
  });

  // ------------------------------------------------------------------ stream
  app.get("/api/system/stream", async (req, reply) => {
    if (system.subscriberCount >= MAX_STREAM_CLIENTS) {
      return sendError(
        reply,
        503,
        "STREAM_LIMIT_REACHED",
        `The host stream already has ${system.subscriberCount} of ${MAX_STREAM_CLIENTS} permitted clients. Host telemetry is a broadcast, not a per-client subscription service, and the cap exists so a browser loop cannot exhaust the collector.`,
      );
    }

    const lastEventId = readLastEventId(req);

    // Subscription is attached BEFORE the backlog is read, with delivery
    // paused. Doing it the other way round loses any event published between
    // the backlog read and the subscribe, and the client would have no way to
    // know.
    const { subscription, backlog } = system.subscribe(lastEventId);

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    reply.raw.flushHeaders?.();

    const sent = new Set<number>();
    const write = (event: SystemEvent): void => {
      sent.add(event.sequence);
      reply.raw.write(`id: ${event.sequence}\nevent: ${SYSTEM_SSE_FRAME}\ndata: ${JSON.stringify(event)}\n\n`);
    };

    for (const event of backlog) {
      if (sent.has(event.sequence)) continue;
      write(event);
    }
    // A client that resumed is told what it missed, so a gap is visible rather
    // than silent. The backlog above already filled it from the store, so this
    // is a statement of fact, not an apology.
    if (lastEventId >= 0 && backlog.length > 0) {
      const first = backlog[0]!.sequence;
      if (first > lastEventId + 1) {
        reply.raw.write(
          `event: system.gap\ndata: ${JSON.stringify({
            from: lastEventId + 1,
            to: first - 1,
            reason: "These sequences are older than the retained host history. Every metric in the gap is recoverable as UNAVAILABLE, not as a zero.",
          })}\n\n`,
        );
      }
    }

    const keepalive = setInterval(() => {
      reply.raw.write(": ping\n\n");
    }, KEEPALIVE_MS);
    keepalive.unref?.();

    system.setDelivery(subscription, write);

    const cleanup = (): void => {
      clearInterval(keepalive);
      const dropped = system.droppedFor(subscription);
      /*
       * The advertised end frame is written before the socket closes, so a client
       * can distinguish "the gateway finished the stream" from "the connection
       * broke". It carries no `id:` on purpose: a terminal marker is not a resume
       * position, and giving it one would move the client's cursor past the last
       * real frame.
       *
       * `res.end` is the success path and `res.destroy` the client-vanished one.
       * A write on a destroyed socket throws inside an event handler, so it is
       * guarded rather than assumed.
       */
      const closed = req.raw.destroyed;
      if (!closed) {
        try {
          reply.raw.write(`event: ${SYSTEM_SSE_END_FRAME}\ndata: ${JSON.stringify({
            reason: "closed",
            dropped,
            sent: sent.size,
            lastSequence: sent.size === 0 ? null : Math.max(...sent),
          })}\n\n`);
          reply.raw.end();
        } catch {
          // The peer went away between the check and the write. Nothing to
          // report and nothing to recover: the subscription is closed below.
        }
      }
      subscription.close();
      logger.debug("SSE", "host stream closed", { client: subscription.id, sent: sent.size, dropped });
    };
    req.raw.on("close", cleanup);
    req.raw.on("error", cleanup);

    // The handler returns without resolving the response: the socket stays open
    // until the client disconnects, which is how SSE is implemented in Fastify.
    return reply;
  });
}

/** Strip PSS from a row so a client cannot read an absent PSS as zero. */
function omitPss(process: HostProcess): HostProcess {
  return {
    ...process,
    pssBytes: { ...process.pssBytes, value: null, provenance: "UNAVAILABLE" as const, reason: "PSS was not requested for this response. Request withPss=true, or use the process detail route, which reads smaps_rollup on demand." },
    anonymousBytes: { ...process.anonymousBytes, value: null, provenance: "UNAVAILABLE" as const, reason: "Derived from smaps_rollup and not requested for this response." },
    fileBackedBytes: { ...process.fileBackedBytes, value: null, provenance: "UNAVAILABLE" as const, reason: "Derived from smaps_rollup and not requested for this response." },
  };
}
