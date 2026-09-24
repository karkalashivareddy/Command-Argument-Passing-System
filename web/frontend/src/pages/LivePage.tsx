import { Activity, Radio } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { api } from "../api/client";
import { Card, Badge, EmptyState, LiveBadge, Spinner } from "../components/ui";
import { useGlobalFeed } from "../api/sse";
import { fmtClock, fmtTimestamp, shortId, truncate } from "../lib/format";
import type { ProcessInfo } from "../types/observability";

export default function LivePage() {
  const { events, connected } = useGlobalFeed(300);
  const [processes, setProcesses] = useState<{ processes: ProcessInfo[]; capacity: number } | null>(null);

  useEffect(() => {
    const t = window.setInterval(() => {
      void api.processes().then(setProcesses).catch(() => {});
    }, 1500);
    void api.processes().then(setProcesses).catch(() => {});
    return () => window.clearInterval(t);
  }, []);

  const running = processes?.processes.filter((p) => p.state === "RUNNING" || p.state === "STARTING") ?? [];

  return (
    <div className="mx-auto max-w-6xl space-y-6 px-6 py-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-[var(--fg-3)]">Live</div>
          <h1 className="mt-1 text-xl font-semibold tracking-tight text-[var(--fg-0)]">Live observatory feed</h1>
          <p className="mt-1 max-w-2xl text-[13px] text-[var(--fg-2)]">
            Every event produced by CAPS, streamed over SSE the moment the engine writes it.
          </p>
        </div>
        <LiveBadge live={connected} />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* Running processes */}
        <section>
          <Card
            title={`Processes ${processes ? `· ${processes.capacity} capacity` : ""}`}
            subtitle="Polled from the gateway registry"
            actions={<Badge tone={running.length > 0 ? "active" : "neutral"}>{running.length} running</Badge>}
          >
            {!processes ? (
              <div className="py-6"><Spinner label="Reading process table…" /></div>
            ) : running.length === 0 ? (
              <EmptyState icon={<Activity className="h-5 w-5" />} title="Nothing running right now" body="Running sessions appear here with their live PID and elapsed time." />
            ) : (
              <ul className="space-y-1">
                {running.map((p) => (
                  <li key={p.sessionId} className="flex items-center gap-2 rounded-[var(--r-sm)] bg-[var(--bg-2)] px-2 py-1.5">
                    <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-[var(--accent)]" />
                    <code className="flex-1 truncate font-mono text-[12px] text-[var(--fg-1)]">{p.command} {p.argv.slice(1).join(" ")}</code>
                    {p.pid ? <span className="font-mono text-[11px] text-[var(--fg-3)]">PID {p.pid}</span> : null}
                    <Link to={`/execution/${p.sessionId}`} className="text-[11px] text-[var(--accent)] hover:underline">open</Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </section>

        {/* Global event stream */}
        <section className="lg:col-span-2">
          <Card
            title="Global event stream"
            subtitle="All sessions, single chronological sequence"
            actions={<Badge tone={connected ? "success" : "danger"}>{connected ? "streaming" : "reconnecting"}</Badge>}
            pad={false}
          >
            {events.length === 0 ? (
              <div className="px-4">
                <EmptyState
                  icon={<Radio className="h-5 w-5" />}
                  title="Stream is live, no events yet"
                  body="Launch an execution and its events will stream here in real time. "
                />
              </div>
            ) : (
              <ul className="max-h-[520px] overflow-y-auto px-1 font-mono text-[11.5px]">
                {events.map((ev) => (
                  <li key={ev.id} className="flex items-center gap-2 border-b border-[var(--line-0)] px-1.5 py-1">
                    <span className="w-12 shrink-0 tabular-nums text-[var(--fg-4)]">{fmtClock(ev.timestamp)}</span>
                    <span className="w-14 shrink-0 truncate text-[var(--fg-4)]">{shortId(ev.sessionId)}</span>
                    <span className="w-8 shrink-0 tabular-nums text-[var(--fg-3)]">#{ev.sequence}</span>
                    <span className="shrink-0 font-semibold text-[var(--fg-1)]">{ev.type}</span>
                    <span className="flex-1 truncate text-[var(--fg-3)]">{Object.keys(ev.payload ?? {}).length > 0 ? truncate(JSON.stringify(ev.payload), 72) : "—"}</span>
                    <Link to={`/execution/${ev.sessionId}`} className="shrink-0 text-[10px] text-[var(--accent)] hover:underline">open</Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </section>
      </div>

      <p className="border-t border-[var(--line-0)] pt-3 text-[11px] text-[var(--fg-3)]">
        Event envelope: <code className="font-mono">sequence</code> is unique per session and strictly ascending; timestamps are gateway receive time. Last event at {events.length ? fmtTimestamp(events[events.length - 1]!.timestamp) : "—"}.
      </p>
    </div>
  );
}
