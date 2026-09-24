import { Play, RotateCcw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

import { api } from "../api/client";
import { useGlobalFeed } from "../api/sse";
import { Badge, Button, Card, EmptyState, LiveBadge, StatusDot } from "../components/ui";
import { useExecution } from "../store/execution";
import { useUi } from "../store/ui";
import type { CanonicalEvent, RedirectionSpec } from "../types/observability";

const SCRIPTS: Array<{ label: string; command: string; args: string[]; redirections?: { out: string } }> = [
  { label: "arg passing", command: "echo", args: ["Hello", "from", "CAPS"] },
  { label: "timing", command: "sleep", args: ["3"] },
  { label: "exit status", command: "false", args: [] },
  { label: "redirection", command: "echo", args: ["written", "by", "demo"], redirections: { out: "demo.txt" } },
];

interface Run {
  id: string;
  label: string;
  events: CanonicalEvent[];
  done: boolean;
  status?: string;
}

export default function DemoPage() {
  const navigate = useNavigate();
  const begin = useExecution((s) => s.begin);
  const pushToast = useUi((s) => s.pushToast);
  const engineState = useUi((s) => s.engineState);
  const { events: feed, connected } = useGlobalFeed(200);
  const [runs, setRuns] = useState<Run[]>([]);
  const [active, setActive] = useState(false);
  const intervalRef = useRef<number | null>(null);

  const runScripts = async () => {
    if (engineState !== "online" || active) return;
    setActive(true);
    setRuns([]);
    for (let i = 0; i < SCRIPTS.length; i++) {
      const s = SCRIPTS[i]!;
      const res = await begin({
        command: s.command,
        args: s.args,
        redirections: (s.redirections ?? {}) as RedirectionSpec,
      });
      if (!res.ok) {
        pushToast(`Demo script failed at step ${i + 1}.`, "error");
        break;
      }
      setRuns((r) => [...r, { id: res.sessionId, label: `${s.label} · ${s.command} ${s.args.join(" ")}`, events: [], done: false }]);
    }
    setActive(false);
  };

  // Poll each demo run until it finalizes (real status, real events via global feed).
  useEffect(() => {
    if (!connected || runs.length === 0) return;
    if (intervalRef.current !== null) return;
    intervalRef.current = window.setInterval(() => {
      void (async () => {
        for (const r of runs) {
          const s = await api.getSession(r.id).catch(() => null);
          if (s && s.status !== "CREATED" && s.status !== "STARTING" && s.status !== "RUNNING") {
            const repl = await api.replay(r.id).catch(() => null);
            setRuns((prev) => prev.map((p) => (p.id === r.id ? { ...p, done: true, events: repl?.events ?? feed.filter((e) => e.sessionId === r.id), status: s.status } : p)));
          }
        }
      })();
    }, 1200);
    return () => {
      if (intervalRef.current !== null) {
        window.clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [connected, runs, feed]);

  const finished = runs.filter((r) => r.done).length;

  return (
    <div className="mx-auto max-w-5xl space-y-6 px-6 py-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-[var(--fg-3)]">Demo</div>
          <h1 className="mt-1 text-xl font-semibold tracking-tight text-[var(--fg-0)]">Run the whole story at once</h1>
          <p className="mt-1 max-w-2xl text-[13px] text-[var(--fg-2)]">
            Four real executions, automatically scripted: argument passing, timing, a failing exit status, and a file
            redirection. Every number updates from the engine — nothing is pre-recorded.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <LiveBadge live={connected} />
          <Button variant="primary" onClick={runScripts} disabled={engineState !== "online" || active}>
            <Play className="h-4 w-4" /> {active ? "Running…" : "Run the demo"}
          </Button>
        </div>
      </div>

      {runs.length === 0 ? (
        <Card title="Nothing run yet">
          <EmptyState icon={<RotateCcw className="h-5 w-5" />} title="Press “Run the demo”" body="The scripts execute for real against ./caps and stream live here." />
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {runs.map((r, i) => (
            <Card key={r.id} title={`${i + 1}. ${r.label}`} actions={<Badge tone={r.done ? "success" : "active"}>{r.done ? (r.status ?? "done") : "live"}</Badge>}>
              <div className="flex items-center justify-between gap-3">
                {r.done ? (
                  <>
                    <span className="font-mono text-[11px] text-[var(--fg-3)]">{r.events.length} events · status {r.status}</span>
                    <StatusDot tone={r.status === "COMPLETED" ? "success" : r.status === "FAILED" ? "danger" : "neutral"} label={r.status ?? "done"} />
                  </>
                ) : (
                  <span className="font-mono text-[11px] text-[var(--fg-3)]">fetching final status…</span>
                )}
                {r.done ? (
                  <Button size="sm" variant="ghost" onClick={() => navigate(`/execution/${r.id}`)}>
                    Open flight recorder
                  </Button>
                ) : null}
              </div>
            </Card>
          ))}
        </div>
      )}

      <Card title="Live trace" subtitle="Global event feed while the demo runs — real SSE frames">
        {feed.length === 0 ? (
          <EmptyState title="No events yet" body="Start the demo to see the event stream populate in real time." />
        ) : (
          <ul className="max-h-56 space-y-0.5 overflow-y-auto font-mono text-[11px]">
            {feed.slice(-24).map((ev) => (
              <li key={ev.id} className="flex items-center gap-2 text-[var(--fg-2)]">
                <span className="w-8 shrink-0 tabular-nums text-[var(--fg-3)]">#{ev.sequence}</span>
                <span className="font-semibold text-[var(--fg-1)]">{ev.type}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-2 text-[10.5px] text-[var(--fg-3)]">{finished} / {runs.length} scripts finished.</p>
      </Card>
    </div>
  );
}
