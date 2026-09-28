import { useMemo } from "react";
import { Link } from "react-router-dom";
import { Box, ChevronRight, TriangleAlert } from "lucide-react";

import { Badge } from "../ui";
import { formatMiB, formatPercent } from "../../lib/format";
import { LENS_SPECS, lensRawValue, lensValue, type MetricMode, type SpaceNodeState } from "../../lib/processSpace";
import type { EvidenceIndex, EvidenceResolution, EvidenceSelection, EvidenceValue, ObservedProcess } from "../../lib/evidenceCorrelation";
import { describeSelection } from "../../lib/evidenceCorrelation";

/**
 * The process list: the investigation surface that does not need a GPU.
 *
 * The 3D canvas must never be the only way to select evidence, so every process
 * in the record appears here as an ordinary focusable button. Selecting a row
 * does exactly what clicking the node does, because both call the same handler.
 * Arrow keys move between rows, Home/End jump to the ends, and Escape clears.
 */
export interface ProcessListProps {
  states: SpaceNodeState[];
  index: EvidenceIndex;
  resolution: EvidenceResolution;
  lens: MetricMode;
  selectedNodeKey: string | null;
  onSelect: (nodeKey: string) => void;
  onHover: (nodeKey: string | null) => void;
  onClear: () => void;
}

export function ProcessList({ states, index, resolution, lens, selectedNodeKey, onSelect, onHover, onClear }: ProcessListProps) {
  const spec = LENS_SPECS[lens];

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const keys = states.map((state) => state.key);
    if (keys.length === 0) return;
    const current = keys.indexOf(selectedNodeKey ?? keys[0]!);
    let next = current;
    if (event.key === "ArrowDown" || event.key === "ArrowRight") next = Math.min(keys.length - 1, current + 1);
    else if (event.key === "ArrowUp" || event.key === "ArrowLeft") next = Math.max(0, current - 1);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = keys.length - 1;
    else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (selectedNodeKey !== null) onSelect(selectedNodeKey);
      return;
    } else return;
    event.preventDefault();
    onSelect(keys[next]!);
  };

  return (
    <div className="rounded-[var(--r-md)] border border-[var(--line-0)] bg-[var(--bg-1)]">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-[var(--line-0)] px-3 py-1.5 font-mono text-[9.5px] text-[var(--fg-3)]">
        <span className="inline-flex items-center gap-1.5">
          <Box className="h-3 w-3" />
          Observed processes
        </span>
        <span>{states.length} node{states.length === 1 ? "" : "s"}</span>
        <span className="text-[var(--fg-4)]">{spec.label} lens · {spec.unit}</span>
        {selectedNodeKey !== null ? (
          <button
            type="button"
            onClick={onClear}
            className="ml-auto rounded px-1.5 py-0.5 text-[9.5px] text-[var(--fg-3)] underline decoration-dotted underline-offset-2 hover:text-[var(--fg-0)]"
          >
            clear selection (Esc)
          </button>
        ) : null}
      </div>

      {states.length === 0 ? (
        <p className="px-3 py-3 text-[11px] text-[var(--fg-3)]">No process was observed in this record, so nothing can be selected.</p>
      ) : (
        <div role="group" aria-label="Observed processes; arrow keys move the selection" onKeyDown={onKeyDown} className="divide-y divide-[var(--line-0)]">
          {states.map((state) => {
            const key = state.key;
            const selected = key === selectedNodeKey;
            const related = resolution.relatedNodeKeys.includes(key) && !selected;
            const record: ObservedProcess | undefined = index.byNodeKey.get(key);
            const lensVal = lensValue(state, lens);
            const lensRaw = lensRawValue(state, lens);
            const samples = record?.sampleCount ?? 0;
            return (
              <button
                key={key}
                type="button"
                onClick={() => onSelect(key)}
                onMouseEnter={() => onHover(key)}
                onMouseLeave={() => onHover(null)}
                onFocus={() => onHover(key)}
                onBlur={() => onHover(null)}
                aria-pressed={selected}
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-left font-mono text-[10.5px] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--accent)] ${
                  selected
                    ? "bg-[var(--violet-soft)] text-[var(--fg-0)]"
                    : related
                      ? "bg-[var(--bg-2)] text-[var(--fg-1)]"
                      : "text-[var(--fg-2)] hover:bg-[var(--bg-2)]"
                }`}
              >
                <span className="w-9 shrink-0 text-[var(--fg-4)]">{state.node.pid ?? "—"}</span>
                <span className="min-w-0 flex-1 truncate">
                  <span className="text-[var(--fg-0)]">{state.node.imageAfter ?? state.node.label}</span>
                  <span className="ml-1.5 text-[var(--fg-4)]">{state.node.role}</span>
                </span>
                <span className="hidden shrink-0 text-[var(--fg-3)] sm:inline">{state.present ? state.state : "not started"}</span>
                <span className="hidden shrink-0 text-[var(--fg-3)] md:inline">
                  {lensRaw === null ? <span className="italic text-[var(--fg-4)]">{spec.metric} n/a</span> : formatLensValue(spec.metric, lensRaw)}
                </span>
                <span className="hidden shrink-0 text-[var(--fg-4)] lg:inline">
                  {lensVal === null ? "unavailable for this lens" : `bounded ${(lensVal * 100).toFixed(0)}%`}
                </span>
                <span className="hidden shrink-0 text-[var(--fg-4)] lg:inline" title="Persisted procfs samples for this process in this execution">
                  {samples === 0 ? "0 samples" : `${samples} samples`}
                </span>
                {state.node.parentVerified ? (
                  <span className="shrink-0 text-[var(--fg-4)]" title="Verified parent: the observed PPID equals an observed parent PID">
                    ←{state.node.parentPid}
                  </span>
                ) : null}
                {selected ? <span className="shrink-0 text-[var(--violet)]">◆</span> : <ChevronRight className="h-3 w-3 shrink-0 text-[var(--fg-4)]" />}
              </button>
            );
          })}
        </div>
      )}

      {states.some((state) => state.node.telemetryNote !== null) ? (
        <p className="flex items-start gap-1.5 border-t border-[var(--line-0)] px-3 py-1.5 text-[9.5px] leading-relaxed text-[var(--fg-3)]">
          <TriangleAlert className="mt-px h-3 w-3 shrink-0 text-[var(--amber)]" />
          <span>
            A node marked without resource values is real: the collector follows the CAPS-reported child, so the gateway-spawned CAPS engine has
            no procfs sample at all. It is listed rather than hidden.
          </span>
        </p>
      ) : null}
    </div>
  );
}

function formatLensValue(metric: "rss" | "cpu" | "io" | "faults", value: number): string {
  if (metric === "rss") return formatMiB(value);
  if (metric === "cpu") return formatPercent(value);
  return `${value.toFixed(0)}`;
}

export interface EvidencePanelProps {
  resolution: EvidenceResolution;
  /** The raw selection, so the panel describes it with the shared rules. */
  selection: EvidenceSelection;
  index: EvidenceIndex;
  selectedNodeKey: string | null;
  sessionId: string;
  onClear: () => void;
}

/**
 * The evidence panel: what exactly is selected, in recorded values.
 *
 * It reports the canonical sequence, the event timestamp, the verified process
 * identity and how strongly that identity was matched, and the observed values
 * with their provenance. It deliberately does not copy the whole event payload:
 * the existing raw event view in the 2D observatory is linked below it.
 */
export function EvidencePanel({ resolution, selection, index, selectedNodeKey, sessionId, onClear }: EvidencePanelProps) {
  const hasSelection = resolution.eventSeq !== null || resolution.identity !== null || selectedNodeKey !== null;
  // The evidence text is built by the pure correlation layer, so the panel
  // cannot drift from the rules the timeline and the scene follow.
  const descriptor = useMemo(() => describeSelection(selection, index), [selection, index]);
  if (!hasSelection) return null;

  return (
    <section aria-label="Selected evidence" className="rounded-[var(--r-md)] border border-[var(--line-0)] bg-[var(--bg-1)]">
      <header className="flex flex-wrap items-center gap-2 border-b border-[var(--line-0)] px-3 py-1.5">
        <span className="font-mono text-[9.5px] uppercase tracking-[0.14em] text-[var(--fg-3)]">Selected evidence</span>
        {descriptor.sequence !== null ? <Badge tone="violet">event #{descriptor.sequence}</Badge> : null}
        {descriptor.identity !== null ? <Badge tone="active">PID {descriptor.identity.pid}</Badge> : null}
        {descriptor.identityConfidence !== null ? (
          <span className="font-mono text-[9px] text-[var(--fg-4)]" title="How much identity evidence backed this match">
            identity: {descriptor.identityConfidence}
          </span>
        ) : null}
        {descriptor.atMs !== null ? (
          <span className="font-mono text-[9.5px] text-[var(--fg-2)]">t = {(descriptor.atMs / 1000).toFixed(2)} s</span>
        ) : null}
        <button
          type="button"
          onClick={onClear}
          className="ml-auto rounded px-1.5 py-0.5 text-[9.5px] text-[var(--fg-3)] underline decoration-dotted underline-offset-2 hover:text-[var(--fg-0)]"
        >
          clear
        </button>
      </header>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 px-3 py-2 font-mono text-[10.5px] sm:grid-cols-3 lg:grid-cols-4">
        {descriptor.values.map((value) => (
          <Value
            key={value.label}
            label={value.label}
            value={value.display}
            muted={value.provenance === "UNAVAILABLE"}
            provenance={value.provenance}
            reason={value.reason}
          />
        ))}
      </dl>

      {descriptor.unresolved.length > 0 ? (
        <ul className="space-y-1 border-t border-[var(--line-0)] px-3 py-2 text-[10px] text-[var(--amber)]">
          {descriptor.unresolved.map((note) => (
            <li key={note} className="flex gap-1.5">
              <span aria-hidden="true">▲</span>
              <span>{note}</span>
            </li>
          ))}
        </ul>
      ) : null}

      <footer className="flex flex-wrap items-center gap-2 border-t border-[var(--line-0)] px-3 py-1.5 text-[9.5px] text-[var(--fg-3)]">
        <Link to={`/execution/${sessionId}#event-stream`} className="underline decoration-dotted underline-offset-2 hover:text-[var(--accent)]">
          Open the raw event detail
        </Link>
        <Link to={`/execution/${sessionId}#flight-recorder`} className="underline decoration-dotted underline-offset-2 hover:text-[var(--accent)]">
          Open the resource tracks
        </Link>
        <span className="text-[var(--fg-4)]">The full event envelope is not duplicated here.</span>
      </footer>
    </section>
  );
}

function Value({
  label,
  value,
  muted,
  provenance,
  reason,
}: {
  label: string;
  value: string;
  muted?: boolean;
  provenance: EvidenceValue["provenance"];
  reason?: string;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-[8.5px] uppercase tracking-wide text-[var(--fg-4)]">{label}</dt>
      <dd
        className={`truncate font-mono text-[10.5px] ${muted ? "italic text-[var(--fg-3)]" : "text-[var(--fg-0)]"}`}
        title={reason ?? value}
      >
        {value}
        {muted && reason ? <span className="ml-1 text-[8.5px] not-italic text-[var(--fg-3)]">· {reason}</span> : null}
      </dd>
      <dd className="text-[8px] font-mono text-[var(--fg-4)]">{provenance}</dd>
    </div>
  );
}
