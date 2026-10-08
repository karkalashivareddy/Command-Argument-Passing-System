/**
 * The live execution panel.
 *
 * WHAT THIS SHOWS, AND WHAT IT WILL NOT
 * -------------------------------------
 * Command, PID, state, elapsed, and the four telemetry a reviewer asks for first.
 * Every value is read from the persisted event stream for the session being
 * described, and every metric carries its provenance.
 *
 * The discipline that shapes the whole component: a metric that is UNAVAILABLE
 * renders as `—` with its reason, never as `0`. This is the specific failure the
 * project has already made twice -- an axis formatter that returned "0" for a
 * negative time, and a first-sample CPU rate rendered as if measured -- and it is
 * the failure a demo audience is least likely to catch and most likely to repeat.
 *
 * WHY TELEMETRY IS "LATEST SAMPLE" AND NOT "MAXIMUM SO FAR"
 * -------------------------------------------------------
 * Showing a peak would be more impressive and would be a different claim. A peak is
 * a property of the observation window; the value here is the most recent reading
 * from procfs, labelled as such. Peaks belong on the peaks panel, which states its
 * own window.
 */

import { clsx } from "clsx";
import { Activity, Cpu, HardDrive, MemoryStick, Timer } from "lucide-react";

import { fmtDuration, shortId } from "../../lib/format";
import { STATUS_META } from "../../lib/stages";
import { collectSamples, latestVisualState } from "../../lib/telemetry";
import { StatusDot } from "../ui";
import type { CanonicalEvent, SessionRecord } from "../../types/observability";
import { MetricProvenance } from "./Provenance";

interface LiveExecutionProps {
  session: SessionRecord | null;
  events: readonly CanonicalEvent[];
  /** Elapsed ms while running; null once terminal, so a stopped clock is never shown as live. */
  elapsedMs: number | null;
  className?: string;
}

export function LiveExecution({ session, events, elapsedMs, className }: LiveExecutionProps) {
  if (session === null) {
    return (
      <section className={clsx("glass-panel rounded-[var(--r-lg)] border border-[var(--line-0)] p-4", className)}>
        <div className="mb-3 flex items-center gap-2">
          <Activity className="h-3.5 w-3.5 text-[var(--fg-3)]" aria-hidden="true" />
          <h2 className="text-[13px] font-semibold text-[var(--fg-0)]">Execution</h2>
        </div>
        <p className="text-[12.5px] leading-relaxed text-[var(--fg-3)]">
          No execution has been started from this page yet. The command above will run against the real
          <code className="mx-1 font-mono">./caps</code>
          engine, and every stage it reaches appears here.
        </p>
      </section>
    );
  }

  const meta = STATUS_META[session.status] ?? STATUS_META.CREATED;
  const terminal = ["COMPLETED", "FAILED", "TIMED_OUT", "CANCELLED"].includes(session.status);
  const samples = collectSamples([...events]);
  const visual = latestVisualState(samples);

  const duration =
    elapsedMs !== null && !terminal
      ? elapsedMs
      : session.durationMs !== null && session.durationMs !== undefined
        ? session.durationMs
        : null;

  return (
    <section className={clsx("glass-panel rounded-[var(--r-lg)] border border-[var(--line-0)]", className)}>
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-[var(--line-0)] px-4 py-3">
        <span className="text-[10px] font-semibold uppercase tracking-[var(--tracking-micro)] text-[var(--fg-3)]">
          Execution
        </span>
        <code className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-[var(--fg-0)]">
          {session.command}
          {session.args.length > 0 ? ` ${session.args.join(" ")}` : ""}
        </code>
        <span className={clsx("font-mono text-[10px] text-[var(--fg-4)]")} title="Session id">
          {shortId(session.id)}
        </span>
      </header>

      <div className="px-4 py-3">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2.5 sm:grid-cols-4">
          <Fact label="PID" value={session.pid !== null ? String(session.pid) : "—"} mono source="/proc/<pid>/stat" unavailable={session.pid === null} reason={session.pid === null ? "the engine has not reported a child PID yet" : undefined} />
          <div>
            <dt className="text-[9.5px] font-semibold uppercase tracking-[var(--tracking-micro)] text-[var(--fg-4)]">State</dt>
            <dd className="mt-1 flex items-center gap-1.5">
              {/*
                One dot, driven by the SHARED tone mapping in components/ui.tsx,
                rather than a colour picked here. Two places choosing "what
                running looks like" is how a status dot and a badge end up
                disagreeing on the same screen.
              */}
              <StatusDot tone={terminal ? meta.tone : "active"} pulse={!terminal} />
              <span className={clsx("font-mono text-[12.5px] font-medium", terminal ? "text-[var(--fg-1)]" : "text-[var(--role-observed)]")}>
                {meta.label}
              </span>
            </dd>
          </div>
          <Fact
            label="Elapsed"
            value={duration !== null ? fmtDuration(duration) : "—"}
            mono
            unavailable={duration === null}
            reason={duration === null ? "not measured: the session has not been finalised" : undefined}
            source="gateway monotonic clock"
          />
          <Fact
            label="Events"
            value={String(events.length)}
            mono
            source="persisted event store"
            detail="sequences 0"
          />
        </dl>

        <div className="mt-3.5 border-t border-[var(--line-0)] pt-3.5">
          <div className="mb-2.5 flex items-center gap-3">
            <span className="text-[9.5px] font-semibold uppercase tracking-[var(--tracking-micro)] text-[var(--fg-4)]">
              Telemetry
            </span>
            <span className="text-[10px] text-[var(--fg-4)]">latest procfs sample</span>
          </div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-3 lg:grid-cols-4">
            <MetricProvenance
              label="CPU"
              metric={visual?.raw.cpuPercent ?? null}
              format={(v) => `${v.toFixed(1)}%`}
              unit="of one core"
            />
            <MetricProvenance
              label="RSS"
              metric={visual?.raw.rssBytes ?? null}
              format={(v) => `${(v / 1024 / 1024).toFixed(1)} MB`}
            />
            <MetricProvenance
              label="I/O"
              metric={visual?.raw.readBytesPerSec ?? null}
              format={(v) => `${(v / 1024).toFixed(1)} KiB/s`}
            />
            <MetricProvenance
              label="Faults"
              metric={visual?.raw.minorFaultsPerSec ?? null}
              format={(v) => `${v.toFixed(0)}/s`}
            />
          </div>
          {samples.length === 0 ? (
            <p className="mt-2.5 flex items-start gap-1.5 text-[11px] leading-relaxed text-[var(--fg-4)]">
              <Timer className="mt-px h-3 w-3 shrink-0" aria-hidden="true" />
              No procfs sample yet. CAPS samples at a fixed interval, so a program that exits in under one
              interval records no telemetry at all. That is a fact about the run, not a gap in the record.
            </p>
          ) : null}
        </div>
      </div>
      {/*
        No lifecycle rail here.

        The rail lives in the Overview hero, above this panel, and it is driven by
        the same event stream this panel reads. Rendering it a second time here
        would put two copies of the same state on one screen; if they ever
        disagreed -- a live feed updating one and not the other -- a reader would
        have no way to tell which one was the observation. One rail, one source.
      */}
    </section>
  );
}

function Fact({
  label,
  value,
  mono = false,
  unavailable = false,
  reason,
  source,
  detail,
}: {
  label: string;
  value: string;
  mono?: boolean;
  unavailable?: boolean;
  reason?: string;
  source?: string;
  detail?: string;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-[9.5px] font-semibold uppercase tracking-[var(--tracking-micro)] text-[var(--fg-4)]">
        {label}
      </dt>
      <dd
        className={clsx(
          "mt-1 truncate text-[13px] font-medium",
          mono && "font-mono",
          unavailable ? "text-[var(--fg-4)]" : "text-[var(--fg-0)]",
        )}
        title={unavailable ? reason : source}
      >
        {value}
        {detail !== undefined ? <span className="ml-1.5 text-[10px] text-[var(--fg-4)]">{detail}</span> : null}
      </dd>
    </div>
  );
}

/** Metric icons re-exported so a caller can label the same four readings elsewhere. */
export const TELEMETRY_ICONS = {
  cpu: Cpu,
  memory: MemoryStick,
  io: HardDrive,
} as const;
