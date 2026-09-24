import { useMemo, useState } from "react";
import { Activity, Copy, Cpu, MemoryStick, Radio, Workflow } from "lucide-react";

import { Badge } from "../ui";
import type { CanonicalEvent, ProcessSnapshot, TelemetryMetric } from "../../types/observability";
import { fmtTimestamp } from "../../lib/format";

type View = "HUMAN" | "LINUX" | "EDUCATIONAL" | "RAW";

export function ProcessTelemetry({ events, replay }: { events: CanonicalEvent[]; replay: boolean }) {
  const [view, setView] = useState<View>("HUMAN");
  const [copyState, setCopyState] = useState("Copy snapshot JSON");
  const samples = useMemo(() => events.flatMap((event) => {
    if (event.type !== "process.snapshot" || typeof event.payload !== "object" || event.payload === null) return [];
    const payload = event.payload as unknown as ProcessSnapshot;
    return payload.pid && payload.timestamp ? [{ event, snapshot: payload }] : [];
  }), [events]);
  const latest = samples.at(-1);
  const snapshotCount = samples.length;

  const copyRaw = async () => {
    if (!latest) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(latest.event, null, 2));
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
        <div className="flex items-center gap-2">
          <Badge tone={replay ? "violet" : "active"}>{replay ? "RECORDED" : "LIVE"}</Badge>
          <span className="font-mono text-[10px] text-[var(--fg-3)]">{snapshotCount} samples · 500 ms target</span>
        </div>
      </header>

      <div className="flex flex-wrap gap-1 border-b border-[var(--line-0)] px-3 py-2" role="tablist" aria-label="Process telemetry views">
        {(["HUMAN", "LINUX", "EDUCATIONAL", "RAW"] as const).map((item) => (
          <button key={item} role="tab" aria-selected={view === item} onClick={() => setView(item)}
            className={`rounded px-2.5 py-1 font-mono text-[10px] tracking-wide focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)] ${view === item ? "bg-[var(--accent-soft)] text-[var(--accent)]" : "text-[var(--fg-3)] hover:bg-[var(--bg-2)] hover:text-[var(--fg-1)]"}`}>
            {item === "HUMAN" ? "SUMMARY" : item}
          </button>
        ))}
        {view === "RAW" && latest ? <button onClick={() => void copyRaw()} className="ml-auto inline-flex items-center gap-1 rounded px-2 py-1 text-[10px] text-[var(--fg-2)] hover:text-[var(--accent)]"><Copy className="h-3 w-3" />{copyState}</button> : null}
      </div>

      {!latest ? (
        <div className="px-4 py-8 text-center">
          <Activity className="mx-auto h-5 w-5 text-[var(--fg-3)]" />
          <p className="mt-2 text-[12px] font-medium text-[var(--fg-1)]">Waiting for a CAPS process-start observation</p>
          <p className="mt-1 text-[11px] text-[var(--fg-3)]">Snapshots are collected only after CAPS reports the child PID. A very short process may exit before procfs can be read.</p>
        </div>
      ) : view === "RAW" ? (
        <pre className="max-h-[32rem] overflow-auto p-4 text-[10.5px] leading-relaxed text-[var(--fg-2)]">{JSON.stringify(latest.event, null, 2)}</pre>
      ) : view === "EDUCATIONAL" ? (
        <div className="grid gap-3 p-4 text-[12px] text-[var(--fg-2)] md:grid-cols-2">
          <Explanation icon={<Workflow className="h-4 w-4" />} title="What this sample means">The gateway read the tracked process's procfs files at {fmtTimestamp(latest.snapshot.timestamp)}. These are point-in-time kernel-exposed process attributes, not syscall tracing.</Explanation>
          <Explanation icon={<Cpu className="h-4 w-4" />} title="CPU time and utilization">User and system CPU times are procfs tick counters converted using the Linux clock-tick rate. CPU percent is derived from two valid samples and can exceed 100% for multithreaded processes.</Explanation>
          <Explanation icon={<MemoryStick className="h-4 w-4" />} title="Memory">RSS is resident memory reported by VmRSS; virtual size is VmSize. They measure different address-space properties and are not interchangeable.</Explanation>
          <Explanation icon={<Radio className="h-4 w-4" />} title="Process state">The one-letter state is the code read from <code>/proc/&lt;pid&gt;/stat</code>. Z means zombie; the text expansion is educational, while the letter itself is observed.</Explanation>
        </div>
      ) : (
        <div className="space-y-4 p-4">
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-[10.5px] text-[var(--fg-3)]">
            <span>CAPS EXECUTION ID · <code className="font-mono text-[var(--fg-2)]">{latest.event.sessionId}</code></span>
            <span>LINUX PID · <code className="font-mono text-[var(--fg-2)]">{show(latest.snapshot.pid)}</code></span>
            <span>SAMPLED · <code className="font-mono text-[var(--fg-2)]">{fmtTimestamp(latest.snapshot.timestamp)}</code></span>
            <span>SOURCE · <code className="font-mono text-[var(--fg-2)]">/proc/{show(latest.snapshot.pid)}/stat + status</code></span>
          </div>
          {view === "HUMAN" ? (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
              <MetricCard label="Kernel state" metric={latest.snapshot.state} format={formatState} />
              <MetricCard label="Elapsed" metric={latest.snapshot.elapsedMs} format={(v) => formatDuration(v)} />
              <MetricCard label="CPU time" metric={sumCpu(latest.snapshot)} format={formatDuration} />
              <MetricCard label="Resident memory" metric={latest.snapshot.rssBytes} format={formatBytes} />
              <MetricCard label="Threads" metric={latest.snapshot.threadCount} format={formatInteger} />
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-2 lg:grid-cols-3">
              <MetricRow label="Command name" metric={latest.snapshot.command} format={(v) => v} />
              <MetricRow label="CAPS engine PID" metric={latest.snapshot.capsEnginePid} format={formatInteger} />
              <MetricRow label="Parent PID" metric={latest.snapshot.ppid} format={formatInteger} />
              <MetricRow label="Process group ID" metric={latest.snapshot.processGroupId} format={formatInteger} />
              <MetricRow label="Linux session ID" metric={latest.snapshot.sessionId} format={formatInteger} />
              <MetricRow label="Start time" metric={latest.snapshot.startTime} format={fmtTimestamp} />
              <MetricRow label="Elapsed" metric={latest.snapshot.elapsedMs} format={formatDuration} />
              <MetricRow label="User CPU time" metric={latest.snapshot.cpuUserMs} format={formatDuration} />
              <MetricRow label="System CPU time" metric={latest.snapshot.cpuSystemMs} format={formatDuration} />
              <MetricRow label="CPU utilization" metric={latest.snapshot.cpuPercent} format={(v) => `${v.toFixed(1)}%`} />
              <MetricRow label="RSS" metric={latest.snapshot.rssBytes} format={formatBytes} />
              <MetricRow label="Virtual memory" metric={latest.snapshot.virtualMemoryBytes} format={formatBytes} />
              <MetricRow label="Threads" metric={latest.snapshot.threadCount} format={formatInteger} />
              <MetricRow label="Voluntary context switches" metric={latest.snapshot.voluntaryContextSwitches} format={formatInteger} />
              <MetricRow label="Nonvoluntary context switches" metric={latest.snapshot.nonVoluntaryContextSwitches} format={formatInteger} />
            </div>
          )}
          <div className="grid gap-3 md:grid-cols-2">
            <Sparkline title="Resident memory" unit="MiB" points={samples.map(({ snapshot }) => snapshot.rssBytes.value === null ? null : snapshot.rssBytes.value / (1024 * 1024))} />
            <Sparkline title="CPU utilization" unit="% of one core" points={samples.map(({ snapshot }) => snapshot.cpuPercent.value)} />
          </div>
          <p className="border-t border-[var(--line-0)] pt-2 text-[10px] text-[var(--fg-3)]">Sample sequence and values are persisted as <code>process.snapshot</code> events. Resource curves contain only collected samples.</p>
        </div>
      )}
    </section>
  );
}

function MetricCard<T>({ label, metric, format }: { label: string; metric: TelemetryMetric<T>; format: (value: T) => string }) {
  return <div className="min-w-0 rounded border border-[var(--line-0)] bg-[var(--bg-2)] px-3 py-2">
    <div className="text-[9px] uppercase tracking-wide text-[var(--fg-3)]">{label}</div>
    <div className="mt-1 truncate font-mono text-[13px] text-[var(--fg-0)]">{showMetric(metric, format)}</div>
    <div className="mt-1 text-[8.5px] font-mono text-[var(--fg-3)]">{metric.provenance}</div>
  </div>;
}

function MetricRow<T>({ label, metric, format }: { label: string; metric: TelemetryMetric<T>; format: (value: T) => string }) {
  return <div className="flex min-w-0 justify-between gap-2 border-b border-[var(--line-0)] py-1.5">
    <span className="text-[10.5px] text-[var(--fg-3)]">{label}</span>
    <span className="min-w-0 text-right"><span className="block break-all font-mono text-[10.5px] text-[var(--fg-1)]">{showMetric(metric, format)}</span><span className="block text-[8px] font-mono text-[var(--fg-3)]">{metric.provenance} · {metric.source}</span></span>
  </div>;
}

function Sparkline({ title, unit, points }: { title: string; unit: string; points: Array<number | null> }) {
  const valid = points.flatMap((n, i) => n === null || !Number.isFinite(n) ? [] : [{ n, i }]);
  if (valid.length < 2) return <div className="rounded border border-[var(--line-0)] px-3 py-3"><div className="text-[10px] font-semibold text-[var(--fg-2)]">{title}</div><p className="mt-2 text-[10px] text-[var(--fg-3)]">Insufficient samples for a trend{valid.length === 1 ? ` · 1 ${unit} sample observed` : ""}.</p></div>;
  const min = Math.min(...valid.map((p) => p.n));
  const max = Math.max(...valid.map((p) => p.n));
  const span = max - min || 1;
  const lastIndex = Math.max(1, points.length - 1);
  const path = valid.map(({ n, i }, j) => `${j === 0 ? "M" : "L"} ${12 + (i / lastIndex) * 276} ${68 - ((n - min) / span) * 48}`).join(" ");
  return <div className="rounded border border-[var(--line-0)] px-3 py-2"><div className="flex justify-between text-[10px]"><span className="font-semibold text-[var(--fg-2)]">{title}</span><span className="font-mono text-[var(--fg-3)]">{min === max ? formatCompact(max) : `${formatCompact(min)}–${formatCompact(max)}`} {unit}</span></div><svg viewBox="0 0 300 80" role="img" aria-label={`${title} from ${valid.length} actual samples`} className="mt-1 h-16 w-full"><path d={path} fill="none" stroke="var(--accent)" strokeWidth="2" vectorEffect="non-scaling-stroke" /><circle cx={12 + (valid.at(-1)!.i / lastIndex) * 276} cy={68 - ((valid.at(-1)!.n - min) / span) * 48} r="2.5" fill="var(--accent)" /></svg><div className="text-right font-mono text-[8px] text-[var(--fg-3)]">{valid.length} actual samples</div></div>;
}

function Explanation({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return <div className="flex gap-2 border-l-2 border-[var(--violet-soft)] pl-3"><div className="mt-0.5 text-[var(--violet)]">{icon}</div><div><p className="font-semibold text-[var(--fg-1)]">{title} <span className="font-mono text-[8px] text-[var(--violet)]">EDUCATIONAL</span></p><p className="mt-1 leading-relaxed">{children}</p></div></div>;
}

function sumCpu(snapshot: ProcessSnapshot): TelemetryMetric<number> {
  if (snapshot.cpuUserMs.value === null || snapshot.cpuSystemMs.value === null) return { value: null, provenance: "UNAVAILABLE", source: "user + system CPU time", reason: "At least one CPU time field is unavailable" };
  return { value: snapshot.cpuUserMs.value + snapshot.cpuSystemMs.value, provenance: "DERIVED", source: "user CPU time + system CPU time" };
}
function show<T>(metric: TelemetryMetric<T>): string { return metric.value === null ? "UNAVAILABLE" : String(metric.value); }
function showMetric<T>(metric: TelemetryMetric<T>, format: (value: T) => string): string { return metric.value === null ? `UNAVAILABLE${metric.reason ? ` · ${metric.reason}` : ""}` : format(metric.value); }
function formatInteger(n: number): string { return Number.isInteger(n) ? String(n) : n.toFixed(1); }
function formatBytes(n: number): string { return `${(n / (1024 * 1024)).toFixed(2)} MiB`; }
function formatDuration(ms: number): string { return ms < 1000 ? `${ms.toFixed(0)} ms` : `${(ms / 1000).toFixed(2)} s`; }
function formatCompact(n: number): string { return n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n.toFixed(2); }
function formatState(code: string): string { return code; }
