import { History as HistoryIcon, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";

import { api } from "../api/client";
import { Card, EmptyState, Spinner, StatusDot } from "../components/ui";
import { exitStatusLabel, fmtDuration, fmtTimestamp, shortId } from "../lib/format";
import { STATUS_META } from "../lib/stages";
import type { SessionRecord } from "../types/observability";

const FILTERS = ["ALL", "COMPLETED", "FAILED", "TIMED_OUT", "CANCELLED", "RUNNING"] as const;

/**
 * History as an execution archive.
 *
 * WHY ROWS, NOT CARDS
 * -------------------
 * This is the index you scan when you want to answer "which run was that?" A
 * card per session spends most of its height on padding and borders, which caps
 * the list at a handful of visible runs before the reader has to scroll. So a
 * row is a single dense line of monospace columns carrying the six facts an
 * archive is indexed by — command, PID, status, duration, EVENT COUNT, start
 * time — and the row height stops being the limiting factor.
 *
 * EVENT COUNT IS THE COLUMN THAT EARNS THE "ARCHIVE" FRAMING
 * ----------------------------------------------------------
 * Every other column is a summary the gateway computed; the event count is the
 * size of the evidence behind the row, so a reader can tell a five-event launch
 * failure from a five-thousand-sample run before opening it. It is shown as a
 * link because it is a fact about the replay, not decoration.
 *
 * Nothing here is derived client-side. Duration and exit status are the
 * gateway's own fields; a session that has not reported one renders UNAVAILABLE
 * rather than 0, because 0 ms is a real measured duration of a real process and
 * conflating the two would invent an observation.
 */
export default function HistoryPage() {
  const [rows, setRows] = useState<SessionRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<(typeof FILTERS)[number]>("ALL");
  const [limit, setLimit] = useState(25);
  /*
   * A failed query is a state, not an empty result.
   *
   * `.catch(() => ({ sessions: [], total: 0 }))` rendered an empty table
   * captioned "0 sessions" whenever the gateway was unreachable. That is a
   * specific false claim: it says this installation has never run anything,
   * which is indistinguishable from a real answer and is exactly the claim a
   * history page must never make on the gateway's behalf.
   */
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.listSessions({
        limit,
        status: status === "ALL" ? undefined : status,
        q: q.trim() || undefined,
      });
      setRows(data.sessions);
      setTotal(data.total);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
    setLoading(false);
  }, [limit, status, q]);

  useEffect(() => {
    void load();
  }, [load]);

  /*
   * Counts are summed from the rows ON SCREEN, never divided into an average.
   * A mean over the visible page would be a number about the page, not about the
   * archive, and it would change every time the reader asked for more rows.
   */
  const totals = useMemo(() => {
    let events = 0;
    for (const row of rows) events += row.eventCount;
    return { events, sessions: rows.length };
  }, [rows]);

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
          <Search className="h-3.5 w-3.5 text-[var(--fg-3)]" aria-hidden="true" />
          {/*
            The placeholder was the only name this input had. A placeholder
            disappears the moment the reader types a character and is not a
            reliable accessible name, so a screen reader announced "edit, blank"
            for the one control that filters the whole page.
          */}
          <input value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter sessions by command" placeholder="Filter by command…" className="h-9 flex-1 bg-transparent text-sm text-[var(--fg-0)] placeholder:text-[var(--fg-3)] focus:outline-none" />
        </div>
        <div className="flex gap-1">
          {FILTERS.map((f) => (
            <button
              key={f}
              onClick={() => setStatus(f)}
              aria-pressed={status === f}
              className={`rounded-[var(--r-sm)] px-2.5 py-1.5 text-[11.5px] font-semibold transition-colors ${status === f ? "bg-[var(--accent-soft)] text-[var(--accent)]" : "text-[var(--fg-3)] hover:text-[var(--fg-1)]"}`}
            >
              {f}
            </button>
          ))}
        </div>
        <span className="ml-auto text-[11.5px] text-[var(--fg-3)]">
          {loadError !== null ? "total unavailable" : `${total} sessions`}
        </span>
      </div>

      <Card pad={false} title="Sessions" subtitle="An index of runs, not a gallery of them — every row links to the full flight recorder">
        {loading ? (
          <div className="px-4 py-8">
            <Spinner label="Loading history…" />
          </div>
        ) : loadError !== null ? (
          <div className="px-4">
            <EmptyState
              icon={<HistoryIcon className="h-5 w-5" />}
              title="History could not be read"
              body={`The gateway did not answer, so this list is unknown rather than empty. ${loadError}`}
            />
          </div>
        ) : rows.length === 0 ? (
          <div className="px-4">
            <EmptyState icon={<HistoryIcon className="h-5 w-5" />} title="Nothing here yet" body="Run a command and it will be recorded here with its complete event timeline." />
          </div>
        ) : (
          <div className="overflow-x-auto">
            {/*
              A table, not a card list. `table-fixed` with explicit widths is what
              makes the columns align down the page; without it the browser sizes
              each cell to its content and the archive loses its grid, which is
              the only reason to make it a table in the first place.
            */}
            <table className="w-full table-fixed text-left">
              <caption className="sr-only">
                Recorded executions, newest first. Each row carries the command, Linux PID, status, duration, persisted event count and start time.
              </caption>
              <thead>
                <tr className="border-b border-[var(--line-0)] text-[9.5px] uppercase tracking-[0.12em] text-[var(--fg-3)]">
                  <th scope="col" className="w-[6.5rem] px-3 py-1.5 font-semibold">Status</th>
                  <th scope="col" className="px-3 py-1.5 font-semibold">Command</th>
                  <th scope="col" className="w-[5rem] px-3 py-1.5 font-semibold">PID</th>
                  <th scope="col" className="w-[6rem] px-3 py-1.5 font-semibold">Events</th>
                  <th scope="col" className="w-[6.5rem] px-3 py-1.5 font-semibold">Duration</th>
                  <th scope="col" className="w-[10rem] px-3 py-1.5 font-semibold">Started</th>
                  <th scope="col" className="w-[11rem] px-3 py-1.5 font-semibold">Exit</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((s) => {
                  const meta = STATUS_META[s.status] ?? STATUS_META.CREATED;
                  const hasStatus = s.exitCode !== null || (s.signal !== null && s.signal > 0);
                  return (
                    <tr key={s.id} className="border-b border-[var(--line-0)] transition-colors hover:bg-[var(--bg-2)]">
                      <td className="px-3 py-1">
                        <StatusDot tone={meta.tone} label={meta.label} />
                      </td>
                      <td className="px-3 py-1">
                        <div className="flex min-w-0 items-baseline gap-2">
                          <Link
                            to={`/execution/${s.id}`}
                            className="truncate font-mono text-[12px] text-[var(--fg-0)] hover:text-[var(--accent)]"
                            title={`${s.command} ${s.args.join(" ")}`}
                          >
                            {s.command} <span className="text-[var(--fg-2)]">{s.args.join(" ")}</span>
                          </Link>
                          <span className="shrink-0 font-mono text-[9px] text-[var(--fg-4)]" title={s.id}>{shortId(s.id)}</span>
                        </div>
                      </td>
                      <td className="px-3 py-1 font-mono text-[11px] tabular-nums text-[var(--fg-2)]">{s.pid ?? <span className="text-[var(--fg-4)]">—</span>}</td>
                      {/*
                        The event count links straight into replay, because the
                        count is a claim about how much evidence exists and replay
                        is where that claim is checkable.
                      */}
                      <td className="px-3 py-1 font-mono text-[11px] tabular-nums">
                        <Link
                          to={`/execution/${s.id}?replay=1`}
                          title={`Replay ${s.eventCount} persisted events`}
                          className="text-[var(--accent)] underline decoration-dotted underline-offset-2 hover:text-[var(--fg-0)]"
                        >
                          {s.eventCount}
                        </Link>
                      </td>
                      <td className="px-3 py-1 font-mono text-[11px] tabular-nums text-[var(--fg-2)]">{fmtDuration(s.durationMs)}</td>
                      <td className="px-3 py-1 font-mono text-[10.5px] tabular-nums text-[var(--fg-3)]">{fmtTimestamp(s.startedAt)}</td>
                      <td className="px-3 py-1 font-mono text-[10.5px] text-[var(--fg-3)]">
                        {hasStatus ? exitStatusLabel(s.exitCode, s.signal) : <span className="text-[var(--fg-4)]">—</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 text-[11.5px] text-[var(--fg-3)]">
          <span>
            {rows.length} shown
            {loadError === null && totals.sessions > 0 ? (
              <>
                {" · "}
                <span className="font-mono tabular-nums" title="Summed over the rows on screen, not the whole archive">
                  {totals.events} events on this page
                </span>
              </>
            ) : null}
          </span>
          {limit <= 100 ? (
            <button onClick={() => setLimit((l) => l + 25)} className="rounded-[var(--r-sm)] px-2 py-1 text-[var(--accent)] hover:bg-[var(--accent-soft)]">
              Show more
            </button>
          ) : null}
        </div>
      </Card>

      <p className="text-[11px] text-[var(--fg-3)]">
        Session <code className="font-mono">{rows.length ? shortId(rows[0]!.id) : "—"}</code> • statuses live in the gateway DB and survive restarts. Duration and exit status are the gateway's own readings; a dash means the record carries none, not zero.
      </p>
    </div>
  );
}
