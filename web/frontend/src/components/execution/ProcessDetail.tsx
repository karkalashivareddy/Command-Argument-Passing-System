/**
 * Process Detail: everything known about one process, and why.
 *
 * The organising principle is that this surface never shows a bare number
 * without saying where it came from, and never shows a blank where a value
 * should be. Every metric renders as one of:
 *
 *   value + unit + provenance + source     when the kernel reported it
 *   the gateway's stated reason             when it did not
 *
 * That is more verbose than a table of numbers, and deliberately so: the whole
 * claim of a process-observability tool is that its figures are real, and a
 * figure with no provenance is exactly the thing that makes such a tool
 * untrustworthy.
 *
 * Ownership is stated in the header rather than implied by styling, because it
 * determines whether CAPS can terminate this process at all.
 */

import { useCallback, useEffect, useState } from "react";

import { catalogApi, type HostProcessRow, type RelationshipConfidence, type SystemMetric } from "../../api/observability";
import { Card, Spinner, StatusDot, type Tone } from "../ui";
import {
  formatBytes,
  formatCount,
  formatCpuTime,
  hasValue,
  provenanceLabel,
  renderMetric,
} from "../../lib/hostTelemetry";
import { commandLabel, relationshipConfidenceOf } from "../../lib/processExplorer";

const CONFIDENCE_TONE: Record<RelationshipConfidence, Tone> = {
  VERIFIED: "success",
  UNVERIFIED: "warn",
  UNAVAILABLE: "danger",
};

/**
 * The identity tuple, restated.
 *
 * A PID alone is not an identity, and a reader who sees only a PID will treat it
 * as one. Showing the start ticks and boot id makes the difference legible and
 * gives a reader what they need to check the row against /proc themselves.
 */
export function ProcessDetail({ row, onClose }: { row: HostProcessRow; onClose: () => void }): React.JSX.Element {
  return (
    <Card
      title={`Process ${row.identity.pid}`}
      subtitle={commandLabel(row) || row.name.value || "name unreadable"}
      actions={
        <button type="button" onClick={onClose}>
          Close
        </button>
      }
    >
      <Section title="Identity">
        <dl className="grid grid-cols-[minmax(7rem,auto)_1fr] gap-x-4 gap-y-1 text-[11.5px]">
          <Row label="PID" value={String(row.identity.pid)} note="Field 1 of /proc/<pid>/stat." />
          <Row
            label="Start ticks"
            value={row.identity.startTicks === null ? null : String(row.identity.startTicks)}
            note={
              row.identity.startTicks === null
                ? undefined
                : "Field 22: the process's start time in clock ticks since boot. The part that distinguishes this process from a later one that reuses the PID."
            }
          />
          <Row
            label="Boot ID"
            value={row.identity.bootId ?? null}
            note={
              row.identity.bootId === null
                ? undefined
                : "From /proc/sys/kernel/random/boot_id. Scopes the start ticks, which are only meaningful within one boot."
            }
          />
          <Row
            label="Identity key"
            value={row.identity.key}
            note="The tuple CAPS uses to decide it is looking at the same process as last time."
          />
          <Row
            label="Sampled on this pass"
            value={row.sampled ? "yes" : "no"}
            note={
              row.sampled
                ? undefined
                : "The per-process sample budget was reached before this process was reached, so its row carries identity fields only. That is a statement about the sample, not about the process."
            }
          />
          <Row
            label="Ownership"
            value={row.capsOwned ? "started by CAPS" : "host process: CAPS did not start it and will not signal it"}
            note={
              row.capsOwned
                ? "Matched on the full identity, PID plus start ticks plus boot id, against the sessions this gateway started. Never a command-name match."
                : undefined
            }
          />
        </dl>
      </Section>

      <Section title="Relationships">
        <dl className="grid grid-cols-[minmax(7rem,auto)_1fr] gap-x-4 gap-y-1 text-[11.5px]">
          <MetricRow label="Parent PID" metric={row.ppid} format={formatCount} />
          <MetricRow label="Process group" metric={row.processGroupId} format={formatCount} />
          <MetricRow label="Session" metric={row.sessionId} format={formatCount} />
          <Row
            label="Relationship confidence"
            value={relationshipConfidenceOf(row)}
            tone={CONFIDENCE_TONE[relationshipConfidenceOf(row)]}
            note={
              row.relationshipConfidence.reason ??
              "How far the kernel's parent PID can be trusted as a link. UNVERIFIED means the parent was not itself present in this sample."
            }
          />
        </dl>
      </Section>

      <Section title="Execution">
        <dl className="grid grid-cols-[minmax(7rem,auto)_1fr] gap-x-4 gap-y-1 text-[11.5px]">
          <Row label="Command" value={commandLabel(row) || null} note={row.name.reason} />
          <Row label="Arguments" value={row.cmdline.value === null ? null : row.cmdline.value.join(" ")} note={row.cmdline.reason} />
          <MetricRow label="Kernel state" metric={row.state} format={(v) => String(v)} />
          <MetricRow label="Decoded state" metric={row.stateName} format={(v) => String(v)} />
        </dl>
      </Section>

      <Section title="CPU">
        <dl className="grid grid-cols-[minmax(7rem,auto)_1fr] gap-x-4 gap-y-1 text-[11.5px]">
          {/*
           * `cpuTimeMs` is the kernel's own total, already the sum of every
           * thread's user and system time. It replaces a client-side sum of
           * separate user and system figures: adding two numbers the client
           * already had adds nothing, and if either half were unavailable the
           * client would have had to invent the total.
           */}
          <MetricRow label="Total CPU time" metric={row.cpuTimeMs} format={formatCpuTime} />
          <MetricRow label="CPU share" metric={row.cpuPercent} format={(v) => `${v.toFixed(1)}%`} />
          <MetricRow label="Threads" metric={row.threads} format={formatCount} />
          <MetricRow label="Run-queue wait" metric={row.schedulerWaitNs} format={(v) => formatNanoseconds(v)} />
          <MetricRow label="Scheduler runtime" metric={row.schedulerRuntimeNs} format={(v) => formatNanoseconds(v)} />
          <MetricRow
            label="Voluntary context switches"
            metric={row.voluntaryContextSwitches}
            format={formatCount}
          />
          <MetricRow
            label="Non-voluntary context switches"
            metric={row.nonVoluntaryContextSwitches}
            format={formatCount}
          />
        </dl>
        <p className="mt-1.5 text-[var(--fg-3)]">
          CPU time is time spent executing, not wall-clock time. A process blocked on I/O accrues none of it, which is
          why it can be small while the process has been alive for a long time.
        </p>
      </Section>

      <Section title="Memory">
        <dl className="grid grid-cols-[minmax(7rem,auto)_1fr] gap-x-4 gap-y-1 text-[11.5px]">
          <MetricRow label="Resident set size (RSS)" metric={row.rssBytes} format={formatBytes} />
          <MetricRow
            label="Proportional set size (PSS)"
            metric={row.pssBytes}
            format={formatBytes}
          />
        </dl>
        <p className="mt-1.5 text-[var(--fg-3)]">
          RSS counts every page mapped into the process, including pages shared with other processes, so summing RSS
          across a host double-counts. PSS divides each shared page among its mappers, which is why it is the figure to
          use for an honest total. PSS is read from smaps_rollup on a slow cadence, so it is legitimately absent from
          most rows at any instant — that is reported as unavailable, not as zero.
        </p>
      </Section>

      <Section title="I/O">
        <dl className="grid grid-cols-[minmax(7rem,auto)_1fr] gap-x-4 gap-y-1 text-[11.5px]">
          <MetricRow label="Bytes read" metric={row.readBytes} format={formatBytes} />
          <MetricRow label="Bytes written" metric={row.writeBytes} format={formatBytes} />
          <MetricRow label="Minor page faults" metric={row.minorFaults} format={formatCount} />
          <MetricRow label="Major page faults" metric={row.majorFaults} format={formatCount} />
        </dl>
        <p className="mt-1.5 text-[var(--fg-3)]">
          These are the process's own counters from /proc/&lt;pid&gt;/io. CAPS does not attribute network traffic to
          individual processes: Linux exposes no per-process byte counters in procfs, so a figure here would have to be
          invented.
        </p>
      </Section>
    </Card>
  );
}

function formatNanoseconds(ns: number): string {
  if (ns >= 1_000_000_000) return `${(ns / 1_000_000_000).toFixed(2)} s`;
  if (ns >= 1_000_000) return `${(ns / 1_000_000).toFixed(2)} ms`;
  return `${formatCount(ns)} ns`;
}

function Section({ title, children }: { title: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <section>
      <h3>{title}</h3>
      {children}
    </section>
  );
}

function Row({
  label,
  value,
  note,
  tone,
}: {
  label: string;
  value: string | null;
  note?: string;
  tone?: Tone;
}): React.JSX.Element {
  return (
    <div>
      <dt>{label}</dt>
      <dd>
        {value === null ? (
          <span className="text-[var(--fg-3)]">{note ?? "unavailable"}</span>
        ) : tone !== undefined ? (
          <StatusDot tone={tone} label={value} />
        ) : (
          <span title={note}>{value}</span>
        )}
      </dd>
    </div>
  );
}

/**
 * One metric, rendered with its provenance and source.
 *
 * The absent case renders the gateway's own reason in place of the value. That
 * is the difference between "we looked and could not read it" and a blank cell,
 * which a reader cannot interpret at all.
 */
function MetricRow<T>({
  label,
  metric,
  format,
}: {
  label: string;
  metric: SystemMetric<T> | null | undefined;
  format: (value: T) => string;
}): React.JSX.Element {
  const rendered = renderMetric(metric, format);
  return (
    <div>
      <dt>{label}</dt>
      <dd>
        {hasValue(rendered) ? (
          <>
            <span title={`${provenanceLabel(rendered)} from ${rendered.source}`}>{rendered.text}</span>{" "}
            <span className="text-[var(--fg-3)]">{rendered.unit}</span>
            {rendered.reason !== null && rendered.provenance === "DERIVED" && (
              <span className="text-[10px] uppercase tracking-[0.1em] text-[var(--fg-3)]" title={rendered.reason}>
                {provenanceLabel(rendered)}
              </span>
            )}
          </>
        ) : (
          <span className="text-[var(--fg-3)]" title={rendered.source}>
            {rendered.reason}
          </span>
        )}
      </dd>
    </div>
  );
}

/**
 * Process Detail as a route, fetching the row by its identity key.
 *
 * Separate from the presentational component above so the same evidence surface
 * can be opened from the explorer's table and from a deep link, and both read
 * the identical record.
 */
export function ProcessDetailRoute({ identity }: { identity: string }): React.JSX.Element {
  const [row, setRow] = useState<HostProcessRow | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await catalogApi.process(identity);
      setRow(res.process);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [identity]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error !== null) {
    return (
      <Card title="Process detail">
        <p role="alert">{error}</p>
      </Card>
    );
  }
  if (row === null) {
    return (
      <Card title="Process detail">
        <Spinner label="Reading /proc…" />
      </Card>
    );
  }
  if (row === undefined) {
    return (
      <Card title="Process detail">
        <p>
          No sample of this process is retained. CAPS keeps the current host sample rather than a history, so a process
          that has exited since the last sample has no record here.
        </p>
      </Card>
    );
  }
  return <ProcessDetail row={row} onClose={() => undefined} />;
}
