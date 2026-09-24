import { GitCompareArrows, Link2Off, CheckCircle2, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { api, ApiError } from "../api/client";
import { Button, Card, EmptyState, StatusDot } from "../components/ui";
import { fmtDuration, shortId } from "../lib/format";
import { STATUS_META } from "../lib/stages";
import type { SessionComparison, SessionRecord } from "../types/observability";

function fmtBytes(bytes: number | null): string {
  if (bytes === null) return "UNAVAILABLE";
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

function deltaLabel(delta: number | null, kind: "duration" | "count" | "percent" | "bytes"): string {
  if (delta === null) return "UNAVAILABLE";
  if (delta === 0) return "identical";
  const sign = delta > 0 ? "+" : "−";
  const abs = Math.abs(delta);
  if (kind === "duration") return `${sign}${fmtDuration(abs)} vs left`;
  if (kind === "count") return `${sign}${abs}`;
  if (kind === "percent") return `${sign}${abs.toFixed(1)} pts`;
  return `${sign}${fmtBytes(abs)}`;
}

export default function ComparePage() {
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [leftId, setLeftId] = useState<string>("");
  const [rightId, setRightId] = useState<string>("");
  const [comparison, setComparison] = useState<SessionComparison | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    void api
      .listSessions({ limit: 50 })
      .then((d) => {
        setSessions(d.sessions);
        if (d.sessions.length >= 1) setLeftId((prev) => prev || d.sessions[0]!.id);
        if (d.sessions.length >= 2) setRightId((prev) => prev || d.sessions[1]!.id);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  const runCompare = useCallback(async () => {
    if (!leftId || !rightId || leftId === rightId) return;
    setLoading(true);
    setError(null);
    try {
      setComparison(await api.compare(leftId, rightId));
    } catch (e) {
      setComparison(null);
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [leftId, rightId]);

  const canCompare = leftId !== "" && rightId !== "" && leftId !== rightId;

  const pick = (value: string, onChange: (id: string) => void, label: string) => (
    <div className="flex-1">
      <label className="mb-1 block text-[10.5px] font-semibold uppercase tracking-[0.12em] text-[var(--fg-3)]">{label}</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-9 w-full rounded-[var(--r-sm)] border border-[var(--line-1)] bg-[var(--bg-2)] px-2 font-mono text-[12.5px] text-[var(--fg-0)] focus:border-[var(--accent)] focus:outline-none"
      >
        <option value="">— select a session —</option>
        {sessions.map((s) => (
          <option key={s.id} value={s.id}>
            {shortId(s.id)} · {s.command} {s.args.join(" ")} · {s.status}
          </option>
        ))}
      </select>
    </div>
  );

  return (
    <div className="mx-auto max-w-6xl space-y-4 px-6 py-6">
      <div>
        <div className="flex items-center gap-2 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-[var(--fg-3)]">Compare</div>
        <h1 className="mt-1 text-xl font-semibold tracking-tight text-[var(--fg-0)]">Execution comparison</h1>
        <p className="mt-1 max-w-2xl text-[13px] text-[var(--fg-2)]">
          Two recorded sessions, side by side. Metrics come from the gateway's stored event timelines — never re-executed.
        </p>
      </div>

      <Card title="Pick two sessions" subtitle="Both must exist in the session store; a session cannot be compared with itself">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          {pick(leftId, setLeftId, "Left (baseline)")}
          <div className="hidden shrink-0 pb-2 sm:block"><GitCompareArrows className="h-4 w-4 text-[var(--fg-3)]" /></div>
          {pick(rightId, setRightId, "Right (candidate)")}
          <div className="shrink-0 pb-0.5">
            <Button size="sm" onClick={() => void runCompare()} disabled={!canCompare || loading}>
              {loading ? "Comparing…" : "Compare"}
            </Button>
          </div>
        </div>
        {leftId !== "" && leftId === rightId ? (
          <p className="mt-2 flex items-center gap-1 text-[11.5px] text-[var(--amber)]">
            <TriangleAlert className="h-3.5 w-3.5" /> Pick two different sessions to compare.
          </p>
        ) : null}
        {sessions.length < 2 ? (
          <p className="mt-2 text-[11.5px] text-[var(--fg-3)]">At least two recorded sessions are needed — run a couple of commands first.</p>
        ) : null}
      </Card>

      {error ? (
        <EmptyState icon={<TriangleAlert className="h-5 w-5" />} title="Comparison failed" body={error} />
      ) : null}

      {comparison ? <ComparisonView cmp={comparison} /> : !loading && !error ? (
        <EmptyState
          icon={<GitCompareArrows className="h-5 w-5" />}
          title="No comparison yet"
          body="Select a baseline and a candidate session, then press Compare."
        />
      ) : null}
    </div>
  );

  function ComparisonView({ cmp }: { cmp: SessionComparison }) {
    const rows: Array<{ label: string; left: string; right: string; delta: string; warn?: boolean }> = [
      { label: "Status", left: cmp.left.status, right: cmp.right.status, delta: cmp.shared.sameStatus ? "identical" : "differs", warn: !cmp.shared.sameStatus },
      { label: "Exit", left: cmp.left.exitCode === null ? (cmp.left.signal !== null ? `signal ${cmp.left.signal}` : "none") : `${cmp.left.exitCode}`, right: cmp.right.exitCode === null ? (cmp.right.signal !== null ? `signal ${cmp.right.signal}` : "none") : `${cmp.right.exitCode}`, delta: cmp.shared.sameExit ? "identical" : "differs", warn: !cmp.shared.sameExit },
      { label: "Duration", left: cmp.left.durationMs === null ? "UNAVAILABLE" : fmtDuration(cmp.left.durationMs), right: cmp.right.durationMs === null ? "UNAVAILABLE" : fmtDuration(cmp.right.durationMs), delta: deltaLabel(cmp.deltas.durationMs, "duration") },
      { label: "Peak RSS", left: fmtBytes(cmp.left.peakRssBytes), right: fmtBytes(cmp.right.peakRssBytes), delta: deltaLabel(cmp.deltas.peakRssDeltaBytes, "bytes") },
      { label: "CPU time", left: cmp.left.cpuTimeMs === null ? "UNAVAILABLE" : fmtDuration(cmp.left.cpuTimeMs), right: cmp.right.cpuTimeMs === null ? "UNAVAILABLE" : fmtDuration(cmp.right.cpuTimeMs), delta: deltaLabel(cmp.deltas.cpuTimeDeltaMs, "duration") },
      { label: "Events", left: String(cmp.left.eventCount), right: String(cmp.right.eventCount), delta: deltaLabel(cmp.deltas.eventDelta, "count") },
      { label: "Snapshots", left: String(cmp.left.snapshotCount), right: String(cmp.right.snapshotCount), delta: deltaLabel(cmp.deltas.snapshotDelta, "count") },
    ];

    return (
      <div className="space-y-4">
        <Card title="Side-by-side" subtitle="Metric values are DERIVED from persisted events; the delta is right minus left">
          <div className="grid grid-cols-2 gap-3">
            {([["left", cmp.left], ["right", cmp.right]] as const).map(([side, s]) => (
              <div key={side} className="rounded-[var(--r-md)] border border-[var(--line-0)] bg-[var(--bg-2)] p-3">
                <div className="flex items-center gap-2">
                  <StatusDot tone={(STATUS_META[s.status] ?? STATUS_META.CREATED).tone} label={(STATUS_META[s.status] ?? STATUS_META.CREATED).label} />
                  <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--fg-3)]">{side}</span>
                </div>
                <div className="mt-1.5 truncate font-mono text-[13px] text-[var(--fg-0)]">{s.command} {s.args.join(" ")}</div>
                <div className="mt-1 flex items-center gap-3 font-mono text-[11px] text-[var(--fg-3)]">
                  <Link to={`/execution/${s.sessionId}`} className="text-[var(--accent)] hover:underline">{shortId(s.sessionId)}</Link>
                  <span>{s.eventCount} events · {s.snapshotCount} snapshots</span>
                </div>
              </div>
            ))}
          </div>

          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-left">
              <thead>
                <tr className="border-b border-[var(--line-0)] text-[10px] uppercase tracking-[0.12em] text-[var(--fg-3)]">
                  <th className="px-3 py-2 font-semibold">Metric</th>
                  <th className="px-3 py-2 font-semibold">Left</th>
                  <th className="px-3 py-2 font-semibold">Right</th>
                  <th className="px-3 py-2 font-semibold">Delta</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.label} className="border-b border-[var(--line-0)] hover:bg-[var(--bg-2)]">
                    <td className="px-3 py-2 text-[12.5px] text-[var(--fg-2)]">{r.label}</td>
                    <td className="px-3 py-2 font-mono text-[12.5px] text-[var(--fg-0)] tabular-nums">{r.left}</td>
                    <td className="px-3 py-2 font-mono text-[12.5px] text-[var(--fg-0)] tabular-nums">{r.right}</td>
                    <td className={`px-3 py-2 font-mono text-[12.5px] tabular-nums ${r.warn ? "text-[var(--amber)]" : "text-[var(--fg-3)]"}`}>{r.delta}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <Card title="Shared context" subtitle="What these two runs have in common">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <SharedRow ok={cmp.shared.sameCommand} label="Same command" value={cmp.shared.sameCommand ? cmp.shared.command ?? "—" : "different commands"} />
            <SharedRow ok={cmp.shared.sameExit} label="Same exit code" value={cmp.shared.sameExit ? "yes" : "no"} />
            <SharedRow ok={cmp.shared.sameSignal} label="Same terminating signal" value={cmp.shared.sameSignal ? "yes" : "no"} />
            <SharedRow ok={cmp.shared.sameStatus} label="Same final status" value={cmp.shared.sameStatus ? "yes" : "no"} />
          </div>
        </Card>
      </div>
    );
  }

  function SharedRow({ ok, label, value }: { ok: boolean; label: string; value: string }) {
    return (
      <div className={`flex items-center justify-between rounded-[var(--r-md)] border px-3 py-2 ${ok ? "border-[var(--line-0)] bg-[var(--bg-2)]" : "border-[var(--amber)]/40 bg-[var(--amber)]/5"}`}>
        <span className="text-[12.5px] text-[var(--fg-2)]">{label}</span>
        <span className={`flex items-center gap-1.5 font-mono text-[12px] ${ok ? "text-[var(--green)]" : "text-[var(--amber)]"}`}>
          {ok ? <CheckCircle2 className="h-3.5 w-3.5" /> : <Link2Off className="h-3.5 w-3.5" />}
          {value}
        </span>
      </div>
    );
  }
}