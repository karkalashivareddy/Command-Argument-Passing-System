import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { BarChart3, Gauge } from "lucide-react";

import { Card, EmptyState, Spinner } from "../components/ui";
import { api } from "../api/client";
import { fmtDuration, fmtNumber } from "../lib/format";
import { useEffect, useState } from "react";
import type { AnalyticsOverview } from "../types/observability";

function MetricCell({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-[var(--r-md)] border border-[var(--line-0)] bg-[var(--bg-2)] px-3 py-2.5">
      <div className="text-[10.5px] font-semibold uppercase tracking-[0.12em] text-[var(--fg-3)]">{label}</div>
      <div className="mt-0.5 font-mono text-lg font-semibold tracking-tight text-[var(--fg-0)] tabular-nums">{value}</div>
      {sub ? <div className="text-[10.5px] text-[var(--fg-4)]">{sub}</div> : null}
    </div>
  );
}

const AXIS_TICK = { fill: "var(--fg-4)", fontSize: 11 } as const;
const TOOLTIP_STYLE = {
  background: "var(--bg-3)",
  border: "1px solid var(--line-1)",
  borderRadius: 8,
  fontSize: 12,
  color: "var(--fg-0)",
} as const;

export default function AnalyticsPage() {
  const [data, setData] = useState<AnalyticsOverview | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api
      .analytics()
      .then(setData)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  if (error) {
    return (
      <div className="mx-auto max-w-6xl px-6 py-6">
        <EmptyState icon={<BarChart3 className="h-5 w-5" />} title="Analytics unavailable" body={error} />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="mx-auto max-w-6xl px-6 py-6">
        <Spinner label="Computing analytics…" />
      </div>
    );
  }

  const successRate = data.totalExecutions > 0 ? Math.round((data.successful / data.totalExecutions) * 100) : 0;
  const byCommand = Object.entries(data.byCommand)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([command, count]) => ({ command, count }));
  const byDay = data.byDay.map((d) => ({ name: d.date.slice(5), total: d.count, ok: d.success }));
  const byExit = Object.entries(data.byExitCode)
    .map(([code, n]) => ({ code: code === "null" ? "no exit" : `exit ${code}`.replace("exit ", ""), n }))
    .slice(0, 8);
  const hasAny = data.totalExecutions > 0;

  return (
    <div className="mx-auto max-w-6xl space-y-6 px-6 py-6">
      <div>
        <div className="flex items-center gap-2 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-[var(--fg-3)]">Analytics</div>
        <h1 className="mt-1 text-xl font-semibold tracking-tight text-[var(--fg-0)]">Execution analytics</h1>
        <p className="mt-1 max-w-2xl text-[13px] text-[var(--fg-2)]">
          Computed from the persisted session store — every number here maps to a real recorded session.
        </p>
      </div>

      <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <MetricCell label="Executions" value={fmtNumber(data.totalExecutions)} />
        <MetricCell label="Success rate" value={hasAny ? `${successRate}%` : "—"} sub={`${fmtNumber(data.successful)} successful`} />
        <MetricCell label="Signalled" value={fmtNumber(data.signalled)} sub="terminated by signal" />
        <MetricCell label="Running now" value={fmtNumber(data.running)} />
        <MetricCell label="Average" value={data.avgDurationMs != null ? fmtDuration(data.avgDurationMs) : "—"} />
        <MetricCell label="P50" value={data.p50Ms != null ? fmtDuration(data.p50Ms) : "—"} />
        <MetricCell label="P95" value={data.p95Ms != null ? fmtDuration(data.p95Ms) : "—"} />
        <MetricCell label="P99" value={data.p99Ms != null ? fmtDuration(data.p99Ms) : "—"} />
      </section>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card title="Executions by day" subtitle="Successful vs total per recording day">
          {hasAny ? (
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={byDay}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--line-0)" vertical={false} />
                <XAxis dataKey="name" tick={AXIS_TICK} stroke="var(--line-1)" tickLine={false} axisLine={false} />
                <YAxis tick={AXIS_TICK} stroke="var(--line-1)" tickLine={false} axisLine={false} width={32} />
                <Tooltip contentStyle={TOOLTIP_STYLE} cursor={{ fill: "var(--bg-3)" }} />
                <Bar dataKey="total" fill="var(--line-2)" radius={[3, 3, 0, 0]} name="executions" />
                <Bar dataKey="ok" fill="var(--green)" radius={[3, 3, 0, 0]} name="successful" />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <EmptyState icon={<BarChart3 className="h-5 w-5" />} title="No executions recorded" body="Run a few commands to populate these charts with real data." />
          )}
        </Card>

        <Card title="Most used commands" subtitle="Counted from the session store">
          {hasAny ? (
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={byCommand} layout="vertical">
                <CartesianGrid strokeDasharray="3 3" stroke="var(--line-0)" horizontal={false} />
                <XAxis type="number" tick={AXIS_TICK} stroke="var(--line-1)" tickLine={false} axisLine={false} />
                <YAxis type="category" dataKey="command" width={110} tick={AXIS_TICK} stroke="var(--line-1)" tickLine={false} axisLine={false} />
                <Tooltip contentStyle={TOOLTIP_STYLE} cursor={{ fill: "var(--bg-3)" }} />
                <Bar dataKey="count" fill="var(--violet)" radius={[0, 3, 3, 0]} name="runs" />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <EmptyState icon={<Gauge className="h-5 w-5" />} title="No data yet" body="Charts appear once at least one session has been recorded." />
          )}
        </Card>

        <Card title="Exit code distribution" subtitle="How executions actually ended">
          {hasAny ? (
            <ResponsiveContainer width="100%" height={180}>
              <BarChart data={byExit}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--line-0)" vertical={false} />
                <XAxis dataKey="code" tick={AXIS_TICK} stroke="var(--line-1)" tickLine={false} axisLine={false} />
                <YAxis tick={AXIS_TICK} stroke="var(--line-1)" tickLine={false} axisLine={false} width={32} />
                <Tooltip contentStyle={TOOLTIP_STYLE} cursor={{ fill: "var(--bg-3)" }} />
                <Bar dataKey="n" radius={[3, 3, 0, 0]} name="sessions">
                  {byExit.map((row, i) => (
                    <Cell key={i} fill={row.code === "0" ? "var(--green)" : row.code === "no exit" ? "var(--amber)" : "var(--red)"} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <EmptyState icon={<Gauge className="h-5 w-5" />} title="No data yet" />
          )}
        </Card>

        <Card title="Redirection usage" subtitle="Which channels were spliced to files">
          {hasAny ? (
            <div className="grid grid-cols-3 gap-2">
              {(["in", "out", "append"] as const).map((ch) => {
                const n = data.redirectionUsage[ch] ?? 0;
                return (
                  <div key={ch} className="rounded-[var(--r-md)] border border-[var(--line-0)] bg-[var(--bg-2)] p-3">
                    <div className="font-mono text-[11px] text-[var(--fg-3)]">--{ch === "in" ? "redir-in" : ch === "out" ? "redir-out" : "redir-append"}</div>
                    <div className="mt-1 font-mono text-xl font-semibold text-[var(--amber)]">{fmtNumber(n)}</div>
                  </div>
                );
              })}
            </div>
          ) : (
            <EmptyState icon={<Gauge className="h-5 w-5" />} title="No redirection data" />
          )}
        </Card>
      </div>
    </div>
  );
}
