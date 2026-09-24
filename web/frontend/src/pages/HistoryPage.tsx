import { History as HistoryIcon, Search } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { api } from "../api/client";
import { Card, EmptyState, Spinner, StatusDot } from "../components/ui";
import { fmtDuration, fmtTimestamp, shortId } from "../lib/format";
import { STATUS_META } from "../lib/stages";
import type { SessionRecord } from "../types/observability";

const FILTERS = ["ALL", "COMPLETED", "FAILED", "TIMED_OUT", "CANCELLED", "RUNNING"] as const;

export default function HistoryPage() {
  const [rows, setRows] = useState<SessionRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<(typeof FILTERS)[number]>("ALL");
  const [limit, setLimit] = useState(25);

  const load = useCallback(async () => {
    setLoading(true);
    const data = await api
      .listSessions({ limit, status: status === "ALL" ? undefined : status, q: q.trim() || undefined })
      .catch(() => ({ sessions: [], total: 0 }));
    setRows(data.sessions);
    setTotal(data.total);
    setLoading(false);
  }, [limit, status, q]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="mx-auto max-w-6xl space-y-4 px-6 py-6">
      <div>
        <div className="flex items-center gap-2 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-[var(--fg-3)]">History</div>
        <h1 className="mt-1 text-xl font-semibold tracking-tight text-[var(--fg-0)]">Execution history</h1>
        <p className="mt-1 max-w-2xl text-[13px] text-[var(--fg-2)]">
          Every session that ran against the engine, persisted with its full event timeline for replay.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-1 items-center gap-2 rounded-[var(--r-sm)] border border-[var(--line-1)] bg-[var(--bg-2)] px-3 focus-within:border-[var(--accent)] sm:max-w-xs">
          <Search className="h-3.5 w-3.5 text-[var(--fg-3)]" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by command…" className="h-9 flex-1 bg-transparent text-sm text-[var(--fg-0)] placeholder:text-[var(--fg-3)] focus:outline-none" />
        </div>
        <div className="flex gap-1">
          {FILTERS.map((f) => (
            <button
              key={f}
              onClick={() => setStatus(f)}
              className={`rounded-[var(--r-sm)] px-2.5 py-1.5 text-[11.5px] font-semibold transition-colors ${status === f ? "bg-[var(--accent-soft)] text-[var(--accent)]" : "text-[var(--fg-3)] hover:text-[var(--fg-1)]"}`}
            >
              {f}
            </button>
          ))}
        </div>
        <span className="ml-auto text-[11.5px] text-[var(--fg-3)]">{total} sessions</span>
      </div>

      <Card pad={false} title="Sessions" subtitle="Refresh the page to re-query the gateway">
        {loading ? (
          <div className="px-4 py-8">
            <Spinner label="Loading history…" />
          </div>
        ) : rows.length === 0 ? (
          <div className="px-4">
            <EmptyState icon={<HistoryIcon className="h-5 w-5" />} title="Nothing here yet" body="Run a command and it will be recorded here with its complete event timeline." />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead>
                <tr className="border-b border-[var(--line-0)] text-[10px] uppercase tracking-[0.12em] text-[var(--fg-3)]">
                  <th className="px-4 py-2 font-semibold">Status</th>
                  <th className="px-4 py-2 font-semibold">Command</th>
                  <th className="px-4 py-2 font-semibold">PID</th>
                  <th className="px-4 py-2 font-semibold">Duration</th>
                  <th className="px-4 py-2 font-semibold">When</th>
                  <th className="px-4 py-2 font-semibold">Exit</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((s) => {
                  const meta = STATUS_META[s.status] ?? STATUS_META.CREATED;
                  return (
                    <tr key={s.id} className="border-b border-[var(--line-0)] transition-colors hover:bg-[var(--bg-2)]">
                      <td className="px-4 py-2">
                        <StatusDot tone={meta.tone} label={meta.label} />
                      </td>
                      <td className="max-w-[22rem] px-4 py-2">
                        <Link to={`/execution/${s.id}`} className="truncate font-mono text-[12.5px] text-[var(--fg-0)] hover:text-[var(--accent)]">
                          {s.command} {s.args.join(" ")}
                        </Link>
                      </td>
                      <td className="px-4 py-2 font-mono text-[11.5px] text-[var(--fg-2)]">{s.pid ?? "—"}</td>
                      <td className="px-4 py-2 font-mono text-[11.5px] text-[var(--fg-2)]">{fmtDuration(s.durationMs)}</td>
                      <td className="px-4 py-2 font-mono text-[11.5px] text-[var(--fg-3)]">{fmtTimestamp(s.startedAt)}</td>
                      <td className="px-4 py-2 font-mono text-[11.5px] text-[var(--fg-3)]">
                        {s.signal ? `sig ${s.signal}` : s.exitCode !== null ? `code ${s.exitCode}` : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <div className="flex items-center justify-between px-4 py-2 text-[11.5px] text-[var(--fg-3)]">
          <span>{rows.length} shown</span>
          {limit <= 100 ? (
            <button onClick={() => setLimit((l) => l + 25)} className="rounded-[var(--r-sm)] px-2 py-1 text-[var(--accent)] hover:bg-[var(--accent-soft)]">
              Show more
            </button>
          ) : null}
        </div>
      </Card>

      <p className="text-[11px] text-[var(--fg-3)]">
        Session <code className="font-mono">{rows.length ? shortId(rows[0]!.id) : "—"}</code> • statuses live in the gateway DB and survive restarts.
      </p>
    </div>
  );
}