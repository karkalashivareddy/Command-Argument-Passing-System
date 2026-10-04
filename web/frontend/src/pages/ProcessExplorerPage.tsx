/**
 * Process Explorer: the host's real processes, CAPS-owned work separated from
 * everything else.
 *
 * THE ONE RULE
 * ------------
 * Every cell is either a measured value with its unit and source, or the
 * gateway's reason it could not be measured. A blank is never a zero, and a
 * process CAPS did not start is never presented as though it did.
 *
 * That distinction is carried by the component below rather than by convention,
 * because the two are easy to conflate and the consequence of conflating them is
 * a reader believing they can signal a host process.
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import { catalogApi, type HostProcessRow, type ProcessState } from "../api/observability";
import { Card, EmptyState, Spinner, StatusDot, type Tone } from "../components/ui";
import { ProcessDetail } from "../components/execution/ProcessDetail";
import { formatBytes, formatCount, formatCpuTime, hasValue, renderMetric } from "../lib/hostTelemetry";
import {
  buildTree,
  commandLabel,
  countByState,
  filterByQuery,
  filterByState,
  flattenTree,
  partitionByOwnership,
  sortRows,
  type SortDirection,
  type SortKey,
} from "../lib/processExplorer";

/** How often the explorer re-reads the host. */
const REFRESH_MS = 2_000;

const SORTABLE: Array<{ key: SortKey; label: string }> = [
  { key: "pid", label: "PID" },
  { key: "command", label: "Command" },
  { key: "state", label: "State" },
  { key: "cpuMs", label: "CPU" },
  { key: "rssBytes", label: "RSS" },
  { key: "pssBytes", label: "PSS" },
  { key: "threads", label: "Threads" },
  { key: "readBytes", label: "Read" },
  { key: "writeBytes", label: "Write" },
];

const LIFECYCLE_STATES: readonly ProcessState[] = [
  "LIVE",
  "EXITED",
  "DISAPPEARED",
  "PERMISSION_DENIED",
  "UNAVAILABLE",
];

/**
 * Row state to a tone.
 *
 * A dedicated map rather than an inline ternary so that a NEW state added to the
 * gateway's vocabulary cannot silently inherit the "healthy" colour.
 */
const STATE_TONE: Record<ProcessState, Tone> = {
  LIVE: "success",
  EXITED: "neutral",
  DISAPPEARED: "warn",
  PERMISSION_DENIED: "warn",
  UNAVAILABLE: "danger",
};

export default function ProcessExplorerPage(): React.JSX.Element {
  const [rows, setRows] = useState<HostProcessRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("pid");
  const [sortDir, setSortDir] = useState<SortDirection>("asc");
  const [states, setStates] = useState<ProcessState[]>([]);
  const [capsOnly, setCapsOnly] = useState(false);
  const [asTree, setAsTree] = useState(false);
  const [detail, setDetail] = useState<HostProcessRow | null>(null);
  const [pssSupported, setPssSupported] = useState<boolean | null>(null);
  const [pssNote, setPssNote] = useState<string>("");
  // The gateway's own count of discovered processes, which is NOT the number
  // returned. `rows.length` is capped by the request limit, so on a host with
  // more processes than that, the header would claim a smaller host than the
  // kernel reported.
  const [total, setTotal] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await catalogApi.hostProcesses({ limit: 500, withPss: true });
      setRows(res.processes);
      setTotal(res.total);
      setPssSupported(res.pssSupported);
      setPssNote(res.pssNote);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  const visible = useMemo(() => {
    if (rows === null) return null;
    const searched = filterByQuery(rows, query);
    const stateFiltered = filterByState(searched, states);
    const scoped = capsOnly ? partitionByOwnership(stateFiltered).capsOwned : stateFiltered;
    /*
     * Sorting happens AFTER filtering, on the rows actually shown.
     *
     * The reverse is also correct in principle, but doing it in this order means
     * the list the reader sees is the list they sorted, with no hidden rows
     * affecting the comparison.
     */
    return sortRows(scoped, sortKey, sortDir);
  }, [rows, query, states, capsOnly, sortKey, sortDir]);

  const ownership = useMemo(() => (rows === null ? null : partitionByOwnership(rows)), [rows]);
  const counts = useMemo(() => (rows === null ? null : countByState(rows)), [rows]);

  const tree = useMemo(() => {
    if (!asTree || visible === null) return null;
    return buildTree(visible);
  }, [asTree, visible]);

  const toggleSort = useCallback(
    (key: SortKey) => {
      if (key === sortKey) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
      else {
        setSortKey(key);
        // Text sorts read naturally ascending; magnitudes read naturally
        // descending, because the largest process is the one a reader is
        // looking for.
        setSortDir(key === "pid" || key === "command" || key === "state" ? "asc" : "desc");
      }
    },
    [sortKey],
  );

  if (error !== null) {
    return (
      <Card title="Process Explorer">
        <p role="alert">Could not read the host process list: {error}</p>
      </Card>
    );
  }

  if (rows === null) {
    return (
      <Card title="Process Explorer">
        <Spinner label="Reading /proc…" />
      </Card>
    );
  }

  const shown = visible ?? [];

  return (
    <div className="space-y-4">
      <Card title="Process Explorer">
        <p>
          {/*
            The gateway's discovered total, with the returned count called out
            separately when they differ. Rendering `rows.length` here would claim
            a smaller host than the kernel reported whenever the request limit bit,
            and the ownership split that follows is computed from the returned rows
            -- so the reader needs to see that it describes a subset.
          */}
          {total === null ? "…" : total} process{total === 1 ? "" : "es"} observed on this host
          {total !== null && total > rows.length && <> · showing the first {rows.length}. </>}
          {ownership !== null && (
            <>
              {ownership.capsOwned.length} {ownership.capsOwned.length === 1 ? "is" : "are"} owned by CAPS;{" "}
              {ownership.host.length} {ownership.host.length === 1 ? "is" : "are"} host processes CAPS did not start
              and cannot signal.
            </>
          )}
        </p>

        <div className="mt-3 flex flex-wrap items-end gap-x-5 gap-y-2">
          <label className="flex items-center gap-2">
            <span className="text-[10.5px] font-semibold uppercase tracking-[0.12em] text-[var(--fg-3)]">Search</span>
            <input
              type="search"
              value={query}
              placeholder="pid, command, or state"
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>

          <label className="flex items-center gap-1.5 text-[11.5px]">
            <input type="checkbox" checked={capsOnly} onChange={(e) => setCapsOnly(e.target.checked)} />
            <span>CAPS-owned only</span>
          </label>

          <label className="flex items-center gap-1.5 text-[11.5px]">
            <input type="checkbox" checked={asTree} onChange={(e) => setAsTree(e.target.checked)} />
            <span>Show as a tree</span>
          </label>

          <fieldset className="flex flex-wrap items-center gap-x-3">
            <legend className="text-[10.5px] font-semibold uppercase tracking-[0.12em] text-[var(--fg-3)]">Lifecycle state</legend>
            {LIFECYCLE_STATES.map((s) => (
              <label key={s} className="flex items-center gap-1 text-[11px]">
                <input
                  type="checkbox"
                  checked={states.includes(s)}
                  onChange={(e) =>
                    setStates((prev) => (e.target.checked ? [...prev, s] : prev.filter((x) => x !== s)))
                  }
                />
                <span>
                  {s} {counts !== null ? `(${counts[s]})` : ""}
                </span>
              </label>
            ))}
          </fieldset>
        </div>

        {pssSupported === false && <p className="mt-2 text-[var(--fg-3)]">{pssNote}</p>}

        {shown.length === 0 ? (
          <EmptyState title="No processes match" body="Clear the search or the state filters." />
        ) : (
          <table className="mt-3 w-full table-fixed border-collapse text-[11.5px]">
            <caption className="sr-only">Host processes with per-metric provenance</caption>
            <thead className="text-left">
              <tr>
                <th scope="col" className="border-b border-[var(--line-0)] pb-1.5 pr-4 font-semibold uppercase tracking-[0.1em] text-[var(--fg-3)]">Owner</th>
                {SORTABLE.map((s) => (
                  <th key={s.key} scope="col">
                    <button type="button" onClick={() => toggleSort(s.key)} aria-sort={sortKey === s.key ? (sortDir === "asc" ? "ascending" : "descending") : "none"}>
                      {s.label}
                      {sortKey === s.key ? (sortDir === "asc" ? " ↑" : " ↓") : ""}
                    </button>
                  </th>
                ))}
                <th scope="col" className="border-b border-[var(--line-0)] pb-1.5 pr-4 font-semibold uppercase tracking-[0.1em] text-[var(--fg-3)]">Lifecycle</th>
              </tr>
            </thead>
            <tbody>
              {asTree && tree !== null
                ? flattenTree(tree).map((row) => (
                    <tr key={row.identity.key} style={{ paddingLeft: `${depthOf(tree, row) * 1.25}rem` }}>
                      <OwnerCell row={row} />
                      <Cells row={row} onSelect={setDetail} />
                    </tr>
                  ))
                : shown.map((row) => (
                    <tr key={row.identity.key}>
                      <OwnerCell row={row} />
                      <Cells row={row} onSelect={setDetail} />
                    </tr>
                  ))}
            </tbody>
          </table>
        )}
      </Card>

      {detail !== null && <ProcessDetail row={detail} onClose={() => setDetail(null)} />}
    </div>
  );
}

function depthOf(nodes: ReturnType<typeof buildTree>, target: HostProcessRow): number {
  const walk = (list: ReturnType<typeof buildTree>, depth: number): number => {
    for (const n of list) {
      if (n.row.identity.key === target.identity.key) return depth;
      const found = walk(n.children, depth + 1);
      if (found >= 0) return found;
    }
    return -1;
  };
  const found = walk(nodes, 0);
  return found < 0 ? 0 : found;
}

function OwnerCell({ row }: { row: HostProcessRow }): React.JSX.Element {
  return (
    <td className="py-1 pr-2">
      {/*
       * The owner distinction is stated, not implied by colour. A reader must be
       * able to tell at a glance which processes this gateway could terminate
       * and which it merely watches.
       */}
      <StatusDot
        tone={row.capsOwned ? "active" : "neutral"}
        label={row.capsOwned ? "CAPS" : "host"}
      />
    </td>
  );
}

function Cells({ row, onSelect }: { row: HostProcessRow; onSelect: (r: HostProcessRow) => void }): React.JSX.Element {
  return (
    <>
      <td className="py-1 pr-4 font-mono tabular-nums">{row.identity.pid}</td>
      {/*
       * The command cell is capped and truncated.
       *
       * Without a cap, a `w-full` table hands every spare pixel to the widest
       * column, and a long argv path pushed the eight metric columns off the
       * right edge of a 1600px viewport -- the table still said "CPU", "RSS",
       * "PSS" in its header, none of it was on screen, and the screenshot showed
       * an empty half-page. The full value stays in `title`, so nothing is lost.
       */}
      <td className="max-w-[20rem] py-1 pr-4">
        <button
          type="button"
          className="block max-w-full truncate text-left hover:text-[var(--accent)]"
          title={(row.cmdline.value ?? []).join(" ") || row.name.value || "unreadable"}
          onClick={() => onSelect(row)}
        >
          <code>{commandLabel(row) || "name unreadable"}</code>
        </button>
      </td>
      <td className="py-1 pr-4 font-mono">{row.state.value ?? "unavailable"}</td>
      <MetricCell metric={row.cpuTimeMs} format={(v) => formatCpuTime(v)} />
      <MetricCell metric={row.rssBytes} format={formatBytes} />
      <MetricCell metric={row.pssBytes} format={formatBytes} />
      <MetricCell metric={row.threads} format={formatCount} />
      <MetricCell metric={row.readBytes} format={formatBytes} />
      <MetricCell metric={row.writeBytes} format={formatBytes} />
      <td className="py-1"><StatusDot tone={STATE_TONE[row.rowState]} label={row.rowState} /></td>
    </>
  );
}

/**
 * One metric cell.
 *
 * Renders the reason when there is no value, and a tooltip naming the source
 * file when there is. A bare "0" here would be indistinguishable from a real
 * reading of zero, which is the entire failure this component exists to avoid.
 */
function MetricCell({
  metric,
  format,
}: {
  metric: Parameters<typeof renderMetric>[0];
  format: (v: never) => string;
}): React.JSX.Element {
  const rendered = renderMetric(metric as never, format as never);
  if (!hasValue(rendered)) {
    return (
      <td className="py-1 pr-4 text-[var(--fg-3)]">
        <span title={rendered.reason ?? undefined} aria-label={rendered.reason ?? "unavailable"}>
          —
        </span>
      </td>
    );
  }
  return (
    <td className="py-1 pr-4 font-mono tabular-nums">
      <span title={`${rendered.provenance} from ${rendered.source}`}>{rendered.text}</span>
    </td>
  );
}
