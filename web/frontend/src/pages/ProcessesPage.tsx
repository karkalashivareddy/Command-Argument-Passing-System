import { ScanLine } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { api } from "../api/client";
import { Badge, Card, EmptyState, StatusDot, Spinner } from "../components/ui";
import { fmtClock, fmtDuration } from "../lib/format";
import type { ProcessInfo, TelemetryMetric } from "../types/observability";

const STATE_TONE: Record<ProcessInfo["state"], "neutral" | "active" | "violet" | "success" | "danger" | "warn"> = {
  STARTING: "active",
  RUNNING: "active",
  WAITING: "violet",
  EXITED: "success",
  SIGNALED: "danger",
  FAILED: "danger",
};

export default function ProcessesPage() {
  const [data, setData] = useState<{ processes: ProcessInfo[]; capacity: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      void api
        .processes()
        .then((d) => {
          if (!cancelled) {
            setData(d);
            setError(null);
          }
        })
        .catch((e: unknown) => {
          if (!cancelled) setError(e instanceof Error ? e.message : String(e));
        });
    load();
    const t = window.setInterval(load, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
  }, []);

  const running = data?.processes.filter((p) => p.state === "RUNNING" || p.state === "STARTING").length ?? 0;

  return (
    <div className="mx-auto max-w-6xl space-y-6 px-6 py-6">
      <div>
        <div className="flex items-center gap-2 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-[var(--fg-3)]">Processes</div>
        <h1 className="mt-1 text-xl font-semibold tracking-tight text-[var(--fg-0)]">Process microscope</h1>
        <p className="mt-1 max-w-2xl text-[13px] text-[var(--fg-2)]">
          Active CAPS children only, refreshed every two seconds. Kernel attributes come from procfs snapshots for that execution's CAPS-reported PID.
        </p>
      </div>

      <Card
        title="Active process registry"
        subtitle={data ? `capacity ${data.capacity} concurrent sessions` : "reading…"}
        actions={<Badge tone={running > 0 ? "active" : "neutral"}>{running} running</Badge>}
        pad={false}
      >
        {error ? (
          <div className="px-4">
            <EmptyState icon={<ScanLine className="h-5 w-5" />} title="Registry unreachable" body={error} />
          </div>
        ) : !data ? (
          <div className="px-4 py-6"><Spinner label="Reading active process registry…" /></div>
        ) : data.processes.length === 0 ? (
          <div className="px-4">
            <EmptyState icon={<ScanLine className="h-5 w-5" />} title="No active child process" body="Completed executions remain in History. This registry contains only sessions still running in the gateway." />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1250px] text-left font-mono text-[11.5px]">
              <thead>
                <tr className="border-b border-[var(--line-0)] text-[10px] uppercase tracking-[0.12em] text-[var(--fg-3)]">
                  <th className="px-3 py-2 font-semibold">PID</th>
                  <th className="px-3 py-2 font-semibold">PPID</th>
                  <th className="px-3 py-2 font-semibold">Command</th>
                  <th className="px-3 py-2 font-semibold">Gateway state</th>
                  <th className="px-3 py-2 font-semibold">Linux state</th>
                  <th className="px-3 py-2 font-semibold">Start</th>
                  <th className="px-3 py-2 font-semibold">Duration</th>
                  <th className="px-3 py-2 font-semibold">Execution</th>
                  <th className="px-3 py-2 font-semibold">SID</th>
                  <th className="px-3 py-2 font-semibold">RSS</th>
                  <th className="px-3 py-2 font-semibold">Threads</th>
                  <th className="px-3 py-2 font-semibold">Exit</th>
                  <th className="px-3 py-2 font-semibold">Signal</th>
                </tr>
              </thead>
              <tbody>
                {data.processes.map((p) => (
                  <tr key={p.sessionId} className="border-b border-[var(--line-0)] hover:bg-[var(--bg-2)]">
                    <td className="px-3 py-2 text-[var(--fg-1)]">{p.pid ?? "UNAVAILABLE"}</td>
                    <td className="px-3 py-2 text-[var(--fg-3)]">{metricValue(p.telemetry?.ppid, String)}</td>
                    <td className="max-w-[18rem] truncate px-3 py-2 text-[var(--fg-1)]">{p.command} {p.argv.slice(1).join(" ")}</td>
                    <td className="px-3 py-2"><StatusDot tone={STATE_TONE[p.state]} label={p.state} /></td>
                    <td className="px-3 py-2 text-[var(--fg-2)]">{metricValue(p.telemetry?.state, String)}</td>
                    <td className="px-3 py-2 text-[var(--fg-2)]">{fmtClock(p.startedAt)}</td>
                    <td className="px-3 py-2 text-[var(--fg-2)]">{fmtDuration(p.durationMs)}</td>
                    <td className="px-3 py-2"><Link to={`/execution/${p.sessionId}`} className="text-[var(--accent)] hover:underline">{p.sessionId.slice(0, 8)}…</Link></td>
                    <td className="px-3 py-2 text-[var(--fg-3)]">{metricValue(p.telemetry?.sessionId, String)}</td>
                    <td className="px-3 py-2 text-[var(--fg-2)]">{metricValue(p.telemetry?.rssBytes, (n) => `${(n / (1024 * 1024)).toFixed(2)} MiB`)}</td>
                    <td className="px-3 py-2 text-[var(--fg-2)]">{metricValue(p.telemetry?.threadCount, String)}</td>
                    <td className="px-3 py-2 text-[var(--fg-3)]">{p.exitCode ?? "UNAVAILABLE"}</td>
                    <td className="px-3 py-2 text-[var(--fg-3)]">{p.signal ?? "UNAVAILABLE"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <p className="text-[11px] text-[var(--fg-3)]">
        Execution ID is the CAPS gateway session key; it is not Linux SID. Kernel fields are labeled with their telemetry provenance. Finished processes leave this live registry and remain in History.
      </p>
    </div>
  );
}

function metricValue<T>(metric: TelemetryMetric<T> | null | undefined, format: (value: T) => string): string {
  if (!metric || metric.value === null) return "UNAVAILABLE";
  return `${format(metric.value)} · ${metric.provenance}`;
}
