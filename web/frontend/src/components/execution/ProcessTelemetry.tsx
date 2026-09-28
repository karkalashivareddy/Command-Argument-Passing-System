import { useMemo, useState } from "react";
import { Activity, Box, Copy, Cpu, HardDrive, MemoryStick, MousePointerClick, Radio, Workflow } from "lucide-react";
import { Link } from "react-router-dom";

import { Badge, Button } from "../ui";
import type { CanonicalEvent, TelemetryMetric } from "../../types/observability";
import { buildInspector, collectSamples, deriveRuntimePeaks } from "../../lib/telemetry";
import type { ProcessIdentity } from "../../lib/evidenceCorrelation";
import { identityMatchesSample } from "../../lib/evidenceCorrelation";
import { fmtClock, fmtDuration, formatCount, formatKibPerSec, formatMiB, formatPercent } from "../../lib/format";

type View = "HUMAN" | "LINUX" | "EDUCATIONAL" | "RAW";

export interface ProcessTelemetryProps {
  events: CanonicalEvent[];
  replay: boolean;
  cursorMs: number | null;
  /**
   * The selected process. When present, the inspector shows only samples whose
   * PID and derived start time match that identity, and a link offers the same
   * selection in the 3D view. A PID on its own is never a filter.
   */
  identity?: ProcessIdentity | null;
}

/**
 * The inspector is a cursor-driven view of exactly one persisted sample. It
 * never averages, never interpolates, and never invents a value the kernel did
 * not report — unavailable metrics keep the backend's own reason.
 */
export function ProcessTelemetry({ events, replay, cursorMs, identity = null }: ProcessTelemetryProps) {
  const [view, setView] = useState<View>("HUMAN");
  const [copyState, setCopyState] = useState("Copy snapshot JSON");

  const allSamples = useMemo(() => collectSamples(events), [events]);
  // A selected process narrows the inspector to that process's own samples.
  const samples = useMemo(
    () => (identity === null ? allSamples : allSamples.filter((sample) => identityMatchesSample(identity, sample.snapshot))),
    [allSamples, identity],
  );
  const peaks = useMemo(() => deriveRuntimePeaks(events), [events]);
  const inspector = useMemo(() => buildInspector(samples, cursorMs), [samples, cursorMs]);
  const sample = inspector.sample;
  const snapshot = sample?.snapshot ?? null;

  const copyRaw = async () => {
    if (!sample) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(sample.event, null, 2));
      setCopyState("Copied actual event");
    } catch {
      setCopyState("Clipboard unavailable");
    }
    window.setTimeout(() => setCopyState("Copy snapshot JSON"), 1800);
  };

  return (
    <section className="rounded-[var(--r-lg)] border border-[var(--line-0)] bg-[var(--bg-1)]">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-[var(--line-0)] px-4 py-3">
        <div>
          <h2 className="text-[13px] font-semibold text-[var(--fg-0)]">Process microscope</h2>
          <p className="mt-0.5 text-[12px] text-[var(--fg-2)]">Linux procfs snapshots tied to the CAPS-reported child PID.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {identity !== null ? (
            <span className="rounded border border-[var(--violet-soft)] bg-[var(--violet-soft)] px-2 py-0.5 font-mono text-[10px] text-[var(--violet)]">
              filtered to PID {identity.pid} · {identity.processStartTime ?? "start UNAVAILABLE"}
            </span>
          ) : null}
          <Badge tone={replay ? "violet" : "active"}>{replay ? "RECORDED" : "LIVE"}</Badge>
          <span className="font-mono text-[10px] text-[var(--fg-3)]">
            {allSamples.length === samples.length
              ? `${samples.length} samples · 500 ms target`
              : `${samples.length} / ${allSamples.length} samples · filtered to the selected process`}
          </span>
          {identity !== null ? (
            <Link to={`/execution/${identity.sessionId}/3d`} title="Show this exact process in the 3D process space">
              <Button size="sm" variant="ghost">
                <Box className="h-3 w-3" /> Select in 3D
              </Button>
            </Link>
          ) : null}
        </div>
      </header>

      <div className="flex flex-wrap gap-1 border-b border-[var(--line-0)] px-3 py-2" role="tablist" aria-label="Process telemetry views">
        {(["HUMAN", "LINUX", "EDUCATIONAL", "RAW"] as const).map((item) => (
          <button key={item} role="tab" aria-selected={view === item} onClick={() => setView(item)}
            className={`rounded px-2.5 py-1 font-mono text-[10px] tracking-wide focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)] ${view === item ? "bg-[var(--accent-soft)] text-[var(--accent)]" : "text-[var(--fg-3)] hover:bg-[var(--bg-2)] hover:text-[var(--fg-1)]"}`}>
            {item === "HUMAN" ? "SUMMARY" : item}
          </button>
        ))}
        {view === "RAW" && sample ? <button onClick={() => void copyRaw()} className="ml-auto inline-flex items-center gap-1 rounded px-2 py-1 text-[10px] text-[var(--fg-2)] hover:text-[var(--accent)]"><Copy className="h-3 w-3" />{copyState}</button> : null}
      </div>

      {!sample || !snapshot ? (
        <div className="px-4 py-8 text-center">
          <Activity className="mx-auto h-5 w-5 text-[var(--fg-3)]" />
          <p className="mt-2 text-[12px] font-medium text-[var(--fg-1)]">Waiting for a CAPS process-start observation</p>
          <p className="mt-1 text-[11px] text-[var(--fg-3)]">Snapshots are collected only after CAPS reports the child PID. A very short process may exit before procfs can be read.</p>
        </div>
      ) : view === "RAW" ? (
        <pre className="max-h-[32rem] overflow-auto p-4 text-[10.5px] leading-relaxed text-[var(--fg-2)]">{JSON.stringify(sample.event, null, 2)}</pre>
      ) : view === "EDUCATIONAL" ? (
        <div className="grid gap-3 p-4 text-[12px] text-[var(--fg-2)] md:grid-cols-2">
          <Explanation icon={<Workflow className="h-4 w-4" />} title="What this sample means">The gateway read the tracked process's procfs files at {fmtClock(sample.event.timestamp)}. These are point-in-time kernel-exposed process attributes, not syscall tracing.</Explanation>
          <Explanation icon={<Cpu className="h-4 w-4" />} title="CPU time and utilization">User and system CPU times are procfs tick counters converted using the Linux clock-tick rate. Total CPU time is their sum. CPU utilization is a DERIVED rate from two valid samples, measured against one core, so a multithreaded process can exceed 100%.</Explanation>
          <Explanation icon={<MemoryStick className="h-4 w-4" />} title="Memory">RSS is resident memory reported by VmRSS; virtual size is VmSize. They measure different address-space properties and are not interchangeable.</Explanation>
          <Explanation icon={<HardDrive className="h-4 w-4" />} title="Two different I/O counters">rchar/wchar count characters handed to read() and write(), including page-cache hits. read_bytes/write_bytes count bytes that reached the block layer. Neither is a request-latency measurement, and character counters are not disk throughput.</Explanation>
          <Explanation icon={<Radio className="h-4 w-4" />} title="Page faults">Minor faults were satisfied without disk I/O; major faults required I/O. The per-second figures are DERIVED by differencing the cumulative counters over one real sample interval.</Explanation>
          <Explanation icon={<MousePointerClick className="h-4 w-4" />} title="Why the first sample has no rates">A rate needs two valid samples separated by a measured interval. The gateway therefore records the first sample with every rate marked UNAVAILABLE and a reason, rather than inventing a zero or a prior value.</Explanation>
        </div>
      ) : (
        <div className="space-y-4 p-4">
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-[10.5px] text-[var(--fg-3)]">
            <span>CAPS EXECUTION ID · <code className="font-mono text-[var(--fg-2)]">{sample.event.sessionId}</code></span>
            <span>LINUX PID · <code className="font-mono text-[var(--fg-2)]">{show(snapshot.pid)}</code></span>
            <span>INSPECTING · <code className="font-mono text-[var(--fg-2)]">t={fmtDuration(inspector.atMs)}</code></span>
            <span>SAMPLED · <code className="font-mono text-[var(--fg-2)]">{fmtClock(sample.event.timestamp)}</code></span>
            <span>SOURCE · <code className="font-mono text-[var(--fg-2)]">/proc/{show(snapshot.pid)}/stat + status + io</code></span>
          </div>

          {view === "HUMAN" ? (
            <>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
                <MetricCard label="Kernel state" metric={snapshot.state} format={(v) => String(v)} />
                <MetricCard label="CPU time (u+s)" metric={snapshot.cpuTimeMs} format={(v) => fmtDuration(Number(v))} />
                <MetricCard label="Resident memory" metric={snapshot.rssBytes} format={formatMiB} />
                <MetricCard label="Write rate" metric={snapshot.wcharBytesPerSec} format={formatKibPerSec} note="characters, not disk" />
                <MetricCard label="Page faults" metric={snapshot.minorFaults} format={formatCount} note="minor, cumulative" />
              </div>
              <SectionGrid sections={inspector.sections.filter((section) => section.id === "cpu" || section.id === "memory" || section.id === "io" || section.id === "faults")} />
            </>
          ) : (
            <SectionGrid sections={inspector.sections} />
          )}

          <div className="rounded border border-[var(--line-0)] bg-[var(--bg-2)] px-3 py-2">
            <div className="text-[9px] uppercase tracking-wide text-[var(--fg-3)]">Session totals · last valid observation of each cumulative counter</div>
            <div className="mt-1.5 grid grid-cols-2 gap-x-4 gap-y-1 text-[10.5px] sm:grid-cols-4">
              <Total label="rchar" value={peaks.totalRcharBytes} format={formatMiB} />
              <Total label="wchar" value={peaks.totalWcharBytes} format={formatMiB} />
              <Total label="block read" value={peaks.totalReadBytes} format={formatMiB} />
              <Total label="block write" value={peaks.totalWriteBytes} format={formatMiB} />
            </div>
            <div className="mt-1.5 grid grid-cols-2 gap-x-4 gap-y-1 text-[10.5px] sm:grid-cols-4">
              <Total label="peak RSS" value={peaks.peakRssBytes?.value ?? null} format={formatMiB} />
              <Total label="peak CPU util" value={peaks.peakCpuPercent?.value ?? null} format={formatPercent} />
              <Total label="peak major faults" value={peaks.peakMajorFaults?.value ?? null} format={formatCount} />
              <Total label="peak wchar rate" value={peaks.peakWcharBytesPerSec?.value ?? null} format={formatKibPerSec} />
            </div>
          </div>

          {inspector.unavailable.length > 0 ? (
            <details className="rounded border border-[var(--line-0)] bg-[var(--bg-2)] px-3 py-2">
              <summary className="cursor-pointer text-[10px] font-semibold uppercase tracking-wide text-[var(--fg-2)]">
                Not available for this sample or not collected at all ({inspector.unavailable.length})
              </summary>
              <ul className="mt-1.5 space-y-1 text-[10.5px] text-[var(--fg-3)]">
                {inspector.unavailable.map((entry) => (
                  <li key={entry.metric} className="flex flex-wrap gap-x-2">
                    <span className="font-mono text-[var(--fg-1)]">{entry.metric}</span>
                    <span>{entry.reason}</span>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}

          <p className="border-t border-[var(--line-0)] pt-2 text-[10px] text-[var(--fg-3)]">Sample sequence and values are persisted as <code>process.snapshot</code> events. This inspector follows the same cursor as the resource tracks and the peaks panel.</p>
        </div>
      )}
    </section>
  );
}

function SectionGrid({ sections }: { sections: ReturnType<typeof buildInspector>["sections"] }) {
  return (
    <div className="grid gap-3 md:grid-cols-2">
      {sections.map((section) => (
        <div key={section.id} className="rounded border border-[var(--line-0)] bg-[var(--bg-2)] px-3 py-2">
          <div className="mb-1 text-[9px] uppercase tracking-wide text-[var(--fg-3)]">{section.title}</div>
          {section.items.map((entry) => (
            <div key={entry.label} className="flex min-w-0 justify-between gap-2 border-b border-[var(--line-0)] py-1 last:border-b-0">
              <span className="text-[10.5px] text-[var(--fg-3)]">
                {entry.label}
                {entry.note ? <span className="ml-1 text-[8.5px] text-[var(--fg-4)]">({entry.note})</span> : null}
              </span>
              <span className="min-w-0 text-right">
                <span className="block break-all font-mono text-[10.5px] text-[var(--fg-1)]">{entry.display}</span>
                <span className="block text-[8px] font-mono text-[var(--fg-3)]" title={entry.metric.reason}>
                  {entry.metric.provenance}{entry.metric.reason ? ` · ${entry.metric.reason}` : ""}
                </span>
              </span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function MetricCard<T>({ label, metric, format, note }: { label: string; metric: TelemetryMetric<T> | undefined; format: (value: T) => string; note?: string }) {
  // A snapshot payload can legitimately lack a field, and an older record is
  // not a reason to take the whole view down: the card reports the field as
  // UNAVAILABLE, exactly as a kernel that did not report it would.
  const absent = "This record carries no value for this field in this snapshot";
  return <div className="min-w-0 rounded border border-[var(--line-0)] bg-[var(--bg-2)] px-3 py-2">
    <div className="text-[9px] uppercase tracking-wide text-[var(--fg-3)]">{label}</div>
    <div className="mt-1 truncate font-mono text-[13px] text-[var(--fg-0)]" title={metric === undefined ? absent : metric.reason}>{showMetric(metric, format)}</div>
    <div className="mt-1 text-[8.5px] font-mono text-[var(--fg-3)]">{(metric?.provenance ?? "UNAVAILABLE")}{note ? ` · ${note}` : ""}</div>
  </div>;
}

function Total({ label, value, format }: { label: string; value: number | null; format: (value: number) => string }) {
  return <div className="flex justify-between gap-2">
    <span className="text-[var(--fg-3)]">{label}</span>
    <span className="font-mono text-[var(--fg-1)]" title={value === null ? "No valid sample collected this counter" : undefined}>
      {value === null ? "UNAVAILABLE" : format(value)}
    </span>
  </div>;
}

function Explanation({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return <div className="flex gap-2 border-l-2 border-[var(--violet-soft)] pl-3"><div className="mt-0.5 text-[var(--violet)]">{icon}</div><div><p className="font-semibold text-[var(--fg-1)]">{title} <span className="font-mono text-[8px] text-[var(--violet)]">EDUCATIONAL</span></p><p className="mt-1 leading-relaxed">{children}</p></div></div>;
}

function show<T>(metric: TelemetryMetric<T> | undefined): string {
  if (metric === undefined || metric.value === null) return "UNAVAILABLE";
  return String(metric.value);
}
function showMetric<T>(metric: TelemetryMetric<T> | undefined, format: (value: T) => string): string {
  if (metric === undefined) return "UNAVAILABLE";
  return metric.value === null ? `UNAVAILABLE${metric.reason ? ` · ${metric.reason}` : ""}` : format(metric.value);
}
