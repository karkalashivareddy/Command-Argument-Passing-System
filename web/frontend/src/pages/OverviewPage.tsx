import { ArrowRight, Cpu, History, RadioTower, Timer } from "lucide-react";
import { clsx } from "clsx";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import { api } from "../api/client";
import { useGlobalFeed } from "../api/sse";
import { LifecycleRail } from "../components/evidence/LifecycleRail";
import { LiveExecution } from "../components/evidence/LiveExecution";
import { StructuredCommand } from "../components/execution/StructuredCommand";
import { Badge, Button, Card, EmptyState, StatusDot } from "../components/ui";
import { useUi } from "../store/ui";
import { fmtDuration, shortId } from "../lib/format";
import { STATUS_META } from "../lib/stages";
import type { AnalyticsOverview, ProcessInfo, SessionRecord } from "../types/observability";

function StatOrPlaceholder({ label, value, detail }: { label: string; value: string; detail?: string }) {
  const unavailable = value === "unavailable";
  return (
    <div
      className={clsx(
        "rounded-[var(--r-md)] border px-3 py-2.5 transition-colors duration-[var(--motion-quick)]",
        unavailable
          ? "border-[var(--line-0)] bg-[var(--bg-1)]/40"
          : "border-[var(--line-0)] bg-[var(--bg-2)]/70 hover:border-[var(--line-1)]",
      )}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[9.5px] font-semibold uppercase tracking-[var(--tracking-micro)] text-[var(--fg-3)]">
          {label}
        </span>
        {detail !== undefined ? (
          <span className="text-[9.5px] text-[var(--fg-4)]">{detail}</span>
        ) : null}
      </div>
      <div
        className={clsx(
          "mt-1 font-mono text-[17px] font-semibold tabular-nums tracking-tight",
          unavailable ? "text-[var(--fg-4)]" : "text-[var(--fg-0)]",
        )}
      >
        {value}
      </div>
    </div>
  );
}

/**
 * The honest answer for a statistic that could not be read.
 *
 * Distinguishes "the gateway did not answer" from "there is no data yet", because
 * those are different facts and a reader acting on "0" would be wrong about one of
 * them. Never returns 0: a percentile of no samples is not zero milliseconds.
 */
function unavailableOr(booted: boolean, error: string | undefined): string {
  if (error !== undefined) return "unavailable";
  return booted ? "none yet" : "…";
}

export default function OverviewPage() {
  const navigate = useNavigate();
  const engineState = useUi((s) => s.engineState);
  const engineDetail = useUi((s) => s.engineDetail);
  const capabilities = useUi((s) => s.capabilities);
  /*
   * argv, held as a vector.
   *
   * This used to be one string, split on whitespace at submit time, which
   * silently discarded every quoting rule the engine implements and then had the
   * flight recorder certify the result as a validated gateway request. See
   * components/execution/StructuredCommand.tsx for the full account.
   */
  const [program, setProgram] = useState("echo");
  const [args, setArgs] = useState<string[]>(["Hello CAPS"]);
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [analytics, setAnalytics] = useState<AnalyticsOverview | null>(null);
  const [processes, setProcesses] = useState<{ processes: ProcessInfo[]; capacity: number } | null>(null);
  const [booted, setBooted] = useState(false);
  /*
   * Which of the three reads failed, kept apart from "there is nothing to show".
   *
   * Each `.catch(() => ({ sessions: [], total: 0 })` / `.catch(() => null)` made a
   * failed request indistinguishable from an empty installation, and this page
   * renders those empties as statements: "none yet", "No executions recorded yet",
   * a running count of 0. An unreachable gateway therefore produced a dashboard
   * confidently describing a machine that had never run anything.
   *
   * The honest rendering is "unavailable", so each failure is recorded and shown.
   */
  const [loadError, setLoadError] = useState<{ sessions?: string; analytics?: string; processes?: string }>({});
  const { events, connected, connection } = useGlobalFeed(40);

  useEffect(() => {
    let stop = false;
    (async () => {
      const [s, a, p] = await Promise.allSettled([
        api.listSessions({ limit: 6 }),
        api.analytics(),
        api.processes(),
      ]);
      if (stop) return;
      const why = (r: PromiseRejectedResult): string =>
        r.reason instanceof Error ? r.reason.message : String(r.reason);
      const failed: { sessions?: string; analytics?: string; processes?: string } = {};
      if (s.status === "fulfilled") setSessions(s.value.sessions);
      else failed.sessions = why(s);
      if (a.status === "fulfilled") setAnalytics(a.value);
      else failed.analytics = why(a);
      if (p.status === "fulfilled") setProcesses(p.value);
      else failed.processes = why(p);
      setLoadError(failed);
      setBooted(true);
    })();
    return () => {
      stop = true;
    };
  }, []);

  const running =
    processes?.processes.filter((p) => p.state === "RUNNING" || p.state === "STARTING").length ??
    (loadError.analytics !== undefined && loadError.processes !== undefined ? null : (analytics?.running ?? 0));

  /*
   * The most recently touched session, reconstructed from the global feed.
   *
   * The feed is the ONLY source here on purpose: subscribing to one session's SSE
   * stream would open a second connection for a page that is meant to be a summary
   * of everything, and the two connections would then disagree about what is
   * running. From the feed we already have every event, grouped by session.
   */
  const recentSessionId = events.at(0)?.sessionId ?? null;
  const recentSessionEvents = useMemo(() => {
    if (recentSessionId === null) return [];
    return events.filter((e) => e.sessionId === recentSessionId);
  }, [events, recentSessionId]);

  const recentSession = useMemo<SessionRecord | null>(() => {
    if (recentSessionId === null) return null;
    return sessions.find((s) => s.id === recentSessionId) ?? null;
  }, [sessions, recentSessionId]);

  /*
   * A live elapsed clock, and only while the session is actually live.
   *
   * Two things this deliberately does not do. It does not keep ticking after the
   * session is terminal, which would show a duration that is still growing on a
   * process that has already exited. And it does not derive elapsed time from the
   * gateway clock by subtracting timestamps, which would include the time between
   * the previous poll and this one -- a number that grows whether or not anything
   * is happening.
   */
  const recentStatus = recentSession?.status ?? null;
  const recentLive = recentStatus !== null && !["COMPLETED", "FAILED", "TIMED_OUT", "CANCELLED"].includes(recentStatus);
  const [tick, setTick] = useState(() => Date.now());
  useEffect(() => {
    if (!recentLive) return;
    const t = window.setInterval(() => setTick(Date.now()), 100);
    return () => window.clearInterval(t);
  }, [recentLive]);
  const elapsedMs =
    recentSession !== null && recentLive
      ? Math.max(0, tick - Date.parse(recentSession.startedAt))
      : null;

  /*
   * The argv goes to /execute verbatim.
   *
   * No tokenisation happens here, because there is nothing to tokenise: the
   * vector is already split, one element per box. Anything that trimmed or
   * joined these back into a string and re-split it would reintroduce the defect
   * this control exists to remove.
   */
  const quickRun = () => {
    const name = program.trim();
    if (name.length === 0) return;
    navigate("/execute", { state: { command: name, args: args.slice() } });
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
            className="mt-4 max-w-3xl"
            onSubmit={(e) => {
              e.preventDefault();
              quickRun();
            }}
          >
            <StructuredCommand
              program={program}
              args={args}
              onProgramChange={setProgram}
              onArgsChange={setArgs}
              onGoToTerminal={() => navigate("/terminal")}
              engineOnline={engineState === "online"}
            />
            <div className="mt-3 flex items-center gap-2">
              <Button type="submit" variant="primary" disabled={engineState !== "online" || program.trim().length === 0}>
                EXECUTE <ArrowRight className="h-3.5 w-3.5" />
              </Button>
              <span className="text-[11px] text-[var(--fg-3)]">
                Opens Execute with this argv prefilled. Nothing runs until you press Run.
              </span>
            </div>
          </form>
        </div>

        {/*
          The lifecycle rail.

          This replaces a fixed strip of seven stage NAMES. A strip of names asserts
          nothing, which makes it decoration; the rail lights each stage from the
          recorded event stream and marks the first un-reached one as the expected
          next step. With nothing running it stays dim and says so, because
          animating it would draw a process into existence that never happened.
        */}
        <div className="border-t border-[var(--line-0)] px-6 py-3.5">
          <div className="mb-2.5 flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="text-[9.5px] font-semibold uppercase tracking-[var(--tracking-micro)] text-[var(--fg-4)]">
              Lifecycle
            </span>
            <span
              className="rounded-[var(--r-xs)] border border-[var(--line-1)] px-1.5 py-0.5 font-mono text-[9.5px] text-[var(--fg-3)]"
              title="Event stream connection state"
            >
              SSE · {connection === "connected" ? "CONNECTED" : connection === "reconnecting" ? "RECONNECTING" : "CONNECTING"}
            </span>
          </div>
          <LifecycleRail events={events} />
        </div>
      </section>

      {/*
        The most recent execution, live.

        Driven by the global feed rather than by a session started on this page, so
        the panel reflects whatever is actually running anywhere in the observatory
        -- which is what makes it useful during a demonstration where the presenter
        starts work on another tab.
      */}
      <LiveExecution
        session={recentSession}
        events={recentSessionEvents}
        elapsedMs={elapsedMs}
      />

      {/*
        Percentiles, not a mean.

        A mean is the one statistic that cannot be read: on this workload mix it
        is dominated by whichever execution happened to be slowest, so it moves for
        reasons a reader cannot see. P50 and P95 are reported instead, and MAX is
        included because a tail is the thing worth looking at on an execution
        recorder. The mean is still available on the Analytics page, where it sits
        beside the distribution it summarises.
      */}
      <section className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <StatOrPlaceholder label="Executions" value={analytics ? String(analytics.totalExecutions) : loadError.analytics !== undefined ? "unavailable" : booted ? "none yet" : "…"} />
        <StatOrPlaceholder label="Running now" value={running === null ? "unavailable" : String(running)} />
        <StatOrPlaceholder label="P50" value={analytics?.p50Ms != null ? fmtDuration(analytics.p50Ms) : unavailableOr(booted, loadError.analytics)} detail="median" />
        <StatOrPlaceholder label="P95" value={analytics?.p95Ms != null ? fmtDuration(analytics.p95Ms) : unavailableOr(booted, loadError.analytics)} detail="tail" />
        <StatOrPlaceholder label="Failed" value={analytics ? String(analytics.failed) : unavailableOr(booted, loadError.analytics)} />
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
            {loadError.sessions !== undefined ? (
              <EmptyState
                icon={<History className="h-5 w-5" />}
                title="Recent executions could not be read"
                body={`The gateway did not answer, so this list is unknown rather than empty. ${loadError.sessions}`}
              />
            ) : sessions.length === 0 ? (
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
