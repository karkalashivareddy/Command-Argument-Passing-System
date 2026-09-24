import type { CanonicalEvent, RuntimePeakPoint, RuntimePeaks } from "../types/observability";

function metricValue(value: unknown): number | null {
  if (typeof value !== "object" || value === null || !("value" in value) || !("provenance" in value)) return null;
  const metric = value as { value?: unknown; provenance?: unknown };
  return metric.provenance !== "UNAVAILABLE" && typeof metric.value === "number" && Number.isFinite(metric.value) ? metric.value : null;
}

/**
 * Per-execution peaks and moments derived strictly from the events the UI
 * already holds (persisted process.snapshot events). Mirrors the gateway's
 * computeRuntimePeaks so a value shown here matches what an export contains.
 */
export function deriveRuntimePeaks(events: CanonicalEvent[]): RuntimePeaks {
  const out: RuntimePeaks = {
    sampleCount: 0,
    firstSampleAt: null,
    lastSampleAt: null,
    minElapsedMs: null,
    maxElapsedMs: null,
    peakRssBytes: null,
    medianRssBytes: null,
    peakCpuPercent: null,
    cpuTimeMs: null,
  };
  const base = events.length > 0 ? new Date(events[0]!.timestamp).getTime() : 0;
  const rssValues: number[] = [];
  let lastUser: number | null = null;
  let lastSystem: number | null = null;

  const pin = (value: number, ts: string): RuntimePeakPoint => ({
    value,
    atTimeMs: Math.max(0, new Date(ts).getTime() - base),
    atTimestamp: ts,
  });

  for (const ev of events) {
    if (ev.type !== "process.snapshot") continue;
    const payload = ev.payload as Record<string, unknown>;
    const ts = ev.timestamp;
    out.sampleCount++;
    if (out.firstSampleAt === null) out.firstSampleAt = ts;
    out.lastSampleAt = ts;

    const rss = metricValue(payload.rssBytes);
    if (rss !== null) {
      rssValues.push(rss);
      if (out.peakRssBytes === null || rss > out.peakRssBytes.value) out.peakRssBytes = pin(rss, ts);
    }

    const cpu = metricValue(payload.cpuPercent);
    if (cpu !== null && (out.peakCpuPercent === null || cpu > out.peakCpuPercent.value)) out.peakCpuPercent = pin(cpu, ts);

    const elapsed = metricValue(payload.elapsedMs);
    if (elapsed !== null) {
      out.minElapsedMs = out.minElapsedMs === null ? elapsed : Math.min(out.minElapsedMs, elapsed);
      out.maxElapsedMs = out.maxElapsedMs === null ? elapsed : Math.max(out.maxElapsedMs, elapsed);
    }

    const user = metricValue(payload.cpuUserMs);
    const system = metricValue(payload.cpuSystemMs);
    if (user !== null && system !== null) {
      lastUser = user;
      lastSystem = system;
    }
  }

  if (rssValues.length >= 2) {
    const sorted = [...rssValues].sort((a, b) => a - b);
    out.medianRssBytes = sorted[Math.floor(sorted.length / 2)] ?? null;
  }
  if (lastUser !== null && lastSystem !== null) out.cpuTimeMs = lastUser + lastSystem;

  return out;
}

export interface TimelinePoint {
  /** seconds relative to the first event in the session */
  t: number;
  rssMiB: number | null;
  cpuPct: number | null;
}

export interface TimelineAnnotation {
  t: number;
  type: string;
  label: string;
  tone: "start" | "end" | "signal" | "event";
}

/** Annotations worth drawing on the resource timeline (lifecycle, not sampling). */
const ANNOTATION_TYPES = new Set(["process.started", "process.exited", "process.exec_error", "redirection.opened", "redirection.failed", "signal.received", "execution.timeout", "execution.failed"]);

export function buildTimeline(events: CanonicalEvent[]): { points: TimelinePoint[]; annotations: TimelineAnnotation[]; spanSeconds: number } {
  const base = events.length > 0 ? new Date(events[0]!.timestamp).getTime() : 0;
  const points: TimelinePoint[] = [];
  for (const ev of events) {
    if (ev.type !== "process.snapshot") continue;
    const payload = ev.payload as unknown as Record<string, unknown>;
    const t = Math.max(0, (new Date(ev.timestamp).getTime() - base) / 1000);
    const rss = metricValue(payload.rssBytes);
    points.push({
      t,
      rssMiB: rss === null ? null : rss / (1024 * 1024),
      cpuPct: metricValue(payload.cpuPercent),
    });
  }
  const annotations: TimelineAnnotation[] = [];
  for (const ev of events) {
    if (!ANNOTATION_TYPES.has(ev.type)) continue;
    const t = Math.max(0, (new Date(ev.timestamp).getTime() - base) / 1000);
    annotations.push({
      t,
      type: ev.type,
      label: ev.type,
      tone: ev.type === "process.exec_error" || ev.type === "execution.failed" ? "signal"
        : ev.type === "signal.received" ? "signal"
        : ev.type === "process.started" || ev.type === "redirection.opened" ? "start"
        : ev.type === "process.exited" ? "end"
        : "event",
    });
  }
  const last = events.at(-1);
  const spanSeconds = last ? Math.max(0.5, (new Date(last.timestamp).getTime() - base) / 1000) : 0;
  return { points, annotations, spanSeconds };
}

export interface SequenceIntegrity {
  contiguous: boolean;
  gaps: number;
  missingSequences: number;
}

export function sequenceIntegrity(events: CanonicalEvent[]): SequenceIntegrity {
  let gaps = 0;
  let missing = 0;
  for (let i = 1; i < events.length; i++) {
    const diff = events[i]!.sequence - events[i - 1]!.sequence;
    if (diff > 1) {
      gaps++;
      missing += diff - 1;
    }
  }
  return { contiguous: missing === 0, gaps, missingSequences: missing };
}
