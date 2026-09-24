import { ArrowRight, Cpu, History, RadioTower, Timer, Zap } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import { api } from "../api/client";
import { useGlobalFeed } from "../api/sse";
import { Badge, Button, Card, EmptyState, StatusDot } from "../components/ui";
import { useUi } from "../store/ui";
import { fmtDuration, shortId } from "../lib/format";
import { STATUS_META } from "../lib/stages";
import type { AnalyticsOverview, ProcessInfo, SessionRecord } from "../types/observability";

function StatOrPlaceholder({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[var(--r-md)] border border-[var(--line-0)] bg-[var(--bg-2)] px-3 py-2.5">
      <div className="text-[10.5px] font-semibold uppercase tracking-[0.12em] text-[var(--fg-3)]">{label}</div>
      <div className="mt-0.5 font-mono text-lg font-semibold tracking-tight text-[var(--fg-0)] tabular-nums">{value}</div>
    </div>
  );
}

export default function OverviewPage() {
  const navigate = useNavigate();
  const engineState = useUi((s) => s.engineState);
  const engineDetail = useUi((s) => s.engineDetail);
  const capabilities = useUi((s) => s.capabilities);
  const [command, setCommand] = useState("echo Hello Shiva");
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [analytics, setAnalytics] = useState<AnalyticsOverview | null>(null);
  const [processes, setProcesses] = useState<{ processes: ProcessInfo[]; capacity: number } | null>(null);
  const [booted, setBooted] = useState(false);
  const { events, connected, connection } = useGlobalFeed(40);

  useEffect(() => {
    let stop = false;
    (async () => {
      const [s, a, p] = await Promise.all([
        api.listSessions({ limit: 6 }).catch(() => ({ sessions: [], total: 0 })),
        api.analytics().catch(() => null),
        api.processes().catch(() => null),
      ]);
      if (stop) return;
      setSessions(s.sessions);
      setAnalytics(a);
      setProcesses(p?.capacity ? p : null);
      setBooted(true);
    })();
    return () => {
      stop = true;
    };
  }, []);

  const running = processes?.processes.filter((p) => p.state === "RUNNING" || p.state === "STARTING").length ?? analytics?.running ?? 0;

  const quickRun = () => {
    const parts = command.trim().split(/\s+/);
    navigate("/execute", { state: { command: parts[0], args: parts.slice(1) } });
  };

  return (
    <div className="mx-auto max-w-6xl space-y-6 px-6 py-6">
      {/* Operational hero — the actual story of the product, not a banner */}
      <section className="overflow-hidden rounded-[var(--r-lg)] border border-[var(--line-1)] bg-[var(--bg-1)]">
        <div className="border-b border-[var(--line-0)] px-6 py-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-[var(--fg-3)]">CAPS Process Execution Observatory</p>
              <h1 className="mt-1 text-xl font-semibold tracking-tight text-[var(--fg-0)]">See what a command becomes.</h1>
            </div>
            <StatusDot
              tone={engineState === "online" ? "success" : engineState === "offline" ? "danger" : "neutral"}
              pulse={engineState === "online"}
              label={engineState === "online" ? "ENGINE ONLINE" : engineState === "offline" ? "ENGINE OFFLINE" : "CHECKING ENGINE"}
            />
          </div>
          <p className="mt-1.5 max-w-2xl text-[13px] leading-relaxed text-[var(--fg-2)]">
            CAPS records the argument vector, child PID, termination signal, and wait status reported by its POSIX
            monitor. The recorder distinguishes direct events from stages the current event protocol cannot observe.
          </p>

          <form
            className="mt-4 flex max-w-2xl items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              quickRun();
            }}
          >
            <div className="flex flex-1 items-center gap-2 rounded-[var(--r-sm)] border border-[var(--line-1)] bg-[var(--bg-2)] px-3 focus-within:border-[var(--accent)]">
              <Zap className="h-3.5 w-3.5 shrink-0 text-[var(--fg-3)]" />
              <input
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                placeholder="echo Hello Shiva"
                aria-label="Command to execute"
                className="h-9 flex-1 bg-transparent font-mono text-[13px] text-[var(--fg-0)] placeholder:text-[var(--fg-3)] focus:outline-none"
              />
            </div>
            <Button type="submit" variant="primary" disabled={engineState !== "online"}>
              EXECUTE <ArrowRight className="h-3.5 w-3.5" />
            </Button>
          </form>
        </div>

        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-6 py-3.5" aria-label="Observed command lifecycle stages">
          {["INPUT", "ARGV", "FORK", "EXEC", "RUN", "WAIT", "RESULT"].map((stage, i, stages) => (
            <span key={stage} className="flex items-center gap-2 font-mono text-[10px] font-bold tracking-[0.12em] text-[var(--fg-3)]">
              {stage}{i < stages.length - 1 ? <span aria-hidden="true" className="text-[var(--line-2)]">→</span> : null}
            </span>
          ))}
          <span className="ml-auto rounded-[var(--r-sm)] border border-[var(--line-1)] px-1.5 py-0.5 font-mono text-[9.5px] text-[var(--fg-3)]">
            {connection === "connected" ? "SSE · CONNECTED" : connection === "reconnecting" ? "SSE · RECONNECTING" : "SSE · CONNECTING"}
          </span>
        </div>
      </section>

      {/* Where is the engine right now */}
      <section className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatOrPlaceholder label="Executions" value={analytics ? String(analytics.totalExecutions) : booted ? "none yet" : "…"} />
        <StatOrPlaceholder label="Running now" value={String(running)} />
        <StatOrPlaceholder label="Median duration" value={analytics?.p50Ms != null ? fmtDuration(analytics.p50Ms) : "…"} />
        <StatOrPlaceholder label="Avg duration" value={analytics?.avgDurationMs != null ? fmtDuration(analytics.avgDurationMs) : "…"} />
      </section>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* Recent executions — real persisted sessions */}
        <section className="lg:col-span-2">
          <Card
            title="Recent executions"
            subtitle="Every row is a real session that ran against ./caps"
            actions={
              <Link to="/history" className="flex items-center gap-1 rounded-[var(--r-sm)] px-2 py-1 text-[11.5px] font-medium text-[var(--accent)] hover:bg-[var(--accent-soft)]">
                History <ArrowRight className="h-3 w-3" />
              </Link>
            }
          >
            {sessions.length === 0 ? (
              <EmptyState
                icon={<History className="h-5 w-5" />}
                title="No executions recorded yet"
                body="Run your first command from the box above. The flight recorder records the events CAPS reports and marks unavailable stages explicitly."
              />
            ) : (
              <div className="space-y-1">
                {sessions.map((s) => {
                  const meta = STATUS_META[s.status] ?? STATUS_META.CREATED;
                  return (
                    <Link
                      key={s.id}
                      to={`/execution/${s.id}`}
                      className="flex items-center gap-3 rounded-[var(--r-sm)] border border-transparent px-2 py-2 transition-colors hover:border-[var(--line-1)] hover:bg-[var(--bg-2)]"
                    >
                      <StatusDot tone={meta.tone} label={meta.label} />
                      <code className="flex-1 truncate font-mono text-[12.5px] text-[var(--fg-1)]">
                        {s.command}
                        {s.args.length > 0 ? ` ${s.args.join(" ")}` : ""}
                      </code>
                      {s.pid ? <span className="hidden shrink-0 font-mono text-[11px] text-[var(--fg-3)] sm:block">PID {s.pid}</span> : null}
                      <span className="hidden shrink-0 font-mono text-[11px] text-[var(--fg-3)] sm:block">{fmtDuration(s.durationMs)}</span>
                      <code className="shrink-0 rounded-[var(--r-xs)] bg-[var(--bg-3)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--fg-3)]">{shortId(s.id)}</code>
                    </Link>
                  );
                })}
              </div>
            )}
          </Card>
        </section>

        {/* Live event ticker across sessions */}
        <section>
          <Card
            title="Live event stream"
            subtitle="Real monitor events as they arrive (SSE /api/live/stream)"
            actions={<Badge tone={connected ? "success" : connection === "reconnecting" ? "warn" : "neutral"}>{connection}</Badge>}
          >
            {events.length === 0 ? (
              <EmptyState icon={<RadioTower className="h-5 w-5" />} title="No events yet" body="Fire an execution and every event it produces will appear here instantly." />
            ) : (
              <ul className="max-h-72 space-y-0.5 overflow-y-auto font-mono text-[11px]">
                {events.slice(-20).map((ev) => (
                  <li key={ev.id} className="flex items-center gap-2 text-[var(--fg-2)]">
                    <span className="w-14 shrink-0 truncate text-[var(--fg-4)]">{shortId(ev.sessionId)}</span>
                    <span className="w-8 shrink-0 tabular-nums text-[var(--fg-3)]">#{ev.sequence}</span>
                    <span className="shrink-0 font-semibold text-[var(--fg-1)]">{ev.type}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </section>
      </div>

      <section className="flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-[var(--line-0)] pt-4 text-[11px] text-[var(--fg-3)]">
        <span className="flex items-center gap-1.5"><Cpu className="h-3.5 w-3.5" /> engine: {engineDetail}</span>
        <span className="flex items-center gap-1.5"><Timer className="h-3.5 w-3.5" /> timeout: {(capabilities?.limits.defaultTimeoutMs ?? 30000) / 1000}s default · {capabilities?.limits.maxTimeoutMs ? (capabilities.limits.maxTimeoutMs / 1000) : ""}s max</span>
        <span className="flex items-center gap-1.5"><RadioTower className="h-3.5 w-3.5" /> workspace: {capabilities?.workspace ?? "—"}</span>
      </section>
    </div>
  );
}
