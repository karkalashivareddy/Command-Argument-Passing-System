import { ScanLine } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { api } from "../api/client";
import { Badge, Card, EmptyState, StatusDot, Spinner } from "../components/ui";
import { fmtDuration } from "../lib/format";
import type { ProcessInfo } from "../types/observability";

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
          if (!cancelled) setData(d);
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

  const running = data
    ? data.processes.filter((p) => p.state === "RUNNING" || p.state === "STARTING").length
    : 0;

  return (
    <div className="mx-auto max-w-5xl space-y-6 px-6 py-6">
      <div>
        <div className="flex items-center gap-2 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-[var(--fg-3)]">Processes</div>
        <h1 className="mt-1 text-xl font-semibold tracking-tight text-[var(--fg-0)]">Process table</h1>
        <p className="mt-1 max-w-2xl text-[13px] text-[var(--fg-2)]">
          The gateway tracks one child per session. This table is polled from the live registry every two seconds.
        </p>
      </div>

      <Card
        title="Registry"
        subtitle={data ? `capacity ${data.capacity} concurrent sessions` : "reading…"}
        actions={<Badge tone={running > 0 ? "active" : "neutral"}>{running} running</Badge>}
        pad={false}
      >
        {error ? (
          <div className="px-4">
            <EmptyState icon={<ScanLine className="h-5 w-5" />} title="Registry unreachable" body={error} />
          </div>
        ) : !data ? (
          <div className="px-4 py-6">
            <Spinner label="Scanning process table…" />
          </div>
        ) : data.processes.length === 0 ? (
          <div className="px-4">
            <EmptyState icon={<ScanLine className="h-5 w-5" />} title="The process table is empty" body="Every session the engine has ever run — current and finished — collects here until the registry is swept." />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left font-mono text-[12px]">
              <thead>
                <tr className="border-b border-[var(--line-0)] text-[10px] uppercase tracking-[0.12em] text-[var(--fg-3)]">
                  <th className="px-4 py-2 font-semibold">State</th>
                  <th className="px-4 py-2 font-semibold">Session</th>
                  <th className="px-4 py-2 font-semibold">Command</th>
                  <th className="px-4 py-2 font-semibold">PID</th>
                  <th className="hidden px-4 py-2 font-semibold md:table-cell">Duration</th>
                  <th className="hidden px-4 py-2 font-semibold lg:table-cell">Exit</th>
                </tr>
              </thead>
              <tbody>
                {data.processes.map((p) => (
                  <tr key={p.sessionId} className="border-b border-[var(--line-0)] transition-colors hover:bg-[var(--bg-2)]">
                    <td className="px-4 py-2">
                      <StatusDot tone={STATE_TONE[p.state]} label={p.state} />
                    </td>
                    <td className="px-4 py-2">
                      <Link to={`/execution/${p.sessionId}`} className="text-[var(--accent)] hover:underline">
                        {p.sessionId.slice(0, 8)}…
                      </Link>
                    </td>
                    <td className="max-w-[16rem] truncate px-4 py-2 text-[var(--fg-1)]">
                      {p.command} {p.argv.slice(1).join(" ")}
                    </td>
                    <td className="px-4 py-2 text-[var(--fg-2)]">{p.pid ?? "—"}</td>
                    <td className="hidden px-4 py-2 text-[var(--fg-2)] md:table-cell">{fmtDuration(p.durationMs)}</td>
                    <td className="hidden px-4 py-2 text-[var(--fg-3)] lg:table-cell">
                      {p.exitCode !== null ? `code ${p.exitCode}` : p.signal !== null ? `sig ${p.signal}` : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <p className="text-[11px] text-[var(--fg-3)]">
        Sweep: finished sessions are evicted from the registry after the gateway's 30s sweep while their records remain in history.
      </p>
    </div>
  );
}
