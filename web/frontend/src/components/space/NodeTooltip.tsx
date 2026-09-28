import { useEffect, useRef } from "react";

import { formatMiB, formatPercent } from "../../lib/format";
import { LENS_SPECS, lensRawValue, type MetricMode, type SpaceNodeState } from "../../lib/processSpace";

/**
 * The hover evidence tooltip.
 *
 * It shows only what the record actually contains for the node at the current
 * cursor: identity, the observed parent, the lifecycle state, the sample that
 * the state was read from, and the observed CPU and RSS. Anything the kernel did
 * not report is written as "Unavailable" — never as zero, because "0 % CPU" and
 * "no CPU reading" are different claims.
 *
 * Position updates are written straight to the element through a ref. Pointer
 * movement therefore never re-renders React, and no state is updated per frame.
 */
export interface NodeTooltipProps {
  state: SpaceNodeState | null;
  /** Client coordinates of the pointer, or null when the node is not hovered. */
  point: { x: number; y: number } | null;
  lens: MetricMode;
  selected: boolean;
}

interface TooltipRow {
  label: string;
  value: string;
  unavailable?: boolean;
}

const UNAVAILABLE = "Unavailable";

/** The evidence a tooltip may show, derived from one node state. Pure. */
export function hoverEvidence(state: SpaceNodeState, lens: MetricMode): { heading: string; rows: TooltipRow[] } {
  const node = state.node;
  const cpu = state.visual?.raw.cpuPercent ?? null;
  const rss = state.visual?.raw.rssBytes ?? null;
  const lensRaw = lensRawValue(state, lens);
  const spec = LENS_SPECS[lens];

  const rows: TooltipRow[] = [
    {
      label: "command",
      value: node.imageAfter ?? node.imageBefore ?? node.label,
    },
    { label: "PID", value: node.pid === null ? UNAVAILABLE : String(node.pid), unavailable: node.pid === null },
    {
      label: "PPID",
      value: node.parentVerified ? String(node.parentPid) : UNAVAILABLE,
      unavailable: !node.parentVerified,
    },
    { label: "lifecycle", value: state.present ? state.state : "not started at this cursor" },
    {
      label: "sample at",
      value:
        state.visual === null
          ? UNAVAILABLE
          : `${(state.visual.atMs / 1000).toFixed(2)} s${state.stateAgeMs === null ? "" : ` (${(state.stateAgeMs / 1000).toFixed(2)} s before the cursor)`}`,
      unavailable: state.visual === null,
    },
    { label: "CPU", value: cpu === null ? UNAVAILABLE : formatPercent(cpu), unavailable: cpu === null },
    { label: "RSS", value: rss === null ? UNAVAILABLE : formatMiB(rss), unavailable: rss === null },
  ];

  // The lens is named so a reader knows which quantity the geometry encodes,
  // and its own value is shown with the same unavailable discipline.
  if (lens !== "normal") {
    rows.push({
      label: `${spec.label} lens`,
      value: lensRaw === null ? UNAVAILABLE : `${spec.metric === "rss" ? formatMiB(lensRaw) : lensRaw.toFixed(1)} ${spec.unit}`,
      unavailable: lensRaw === null,
    });
  }
  if (node.telemetryNote !== null) {
    rows.push({ label: "note", value: node.telemetryNote, unavailable: true });
  }

  return { heading: `${node.pid === null ? "PID UNAVAILABLE" : `PID ${node.pid}`} · ${node.label}`, rows };
}

export function NodeTooltip({ state, point, lens, selected }: NodeTooltipProps) {
  const ref = useRef<HTMLDivElement | null>(null);

  // Direct style writes: the tooltip follows the pointer without a render.
  useEffect(() => {
    const element = ref.current;
    if (element === null || point === null) return;
    // Keep the tooltip inside the viewport, deterministically: flip to the left
    // or above when the pointer is close to an edge.
    const width = 232;
    const height = 210;
    const x = point.x + width + 18 > window.innerWidth ? Math.max(8, point.x - width - 14) : point.x + 14;
    const y = point.y + height + 18 > window.innerHeight ? Math.max(8, point.y - height - 14) : point.y + 14;
    element.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;
  }, [point]);

  if (state === null || point === null) return null;
  const evidence = hoverEvidence(state, lens);

  return (
    <div
      ref={ref}
      role="tooltip"
      className="pointer-events-none fixed left-0 top-0 z-20 w-[14.5rem] rounded border border-[var(--line-1)] bg-[var(--bg-1)]/95 px-2.5 py-2 font-mono text-[10px] leading-snug text-[var(--fg-1)] shadow-lg"
    >
      <div className="flex items-center gap-1.5 text-[var(--fg-0)]">
        {selected ? <span className="text-[var(--violet)]" aria-label="selected">◆</span> : null}
        <span className="font-semibold">{evidence.heading}</span>
      </div>
      <dl className="mt-1.5 space-y-0.5">
        {evidence.rows.map((row) => (
          <div key={row.label} className="flex items-baseline justify-between gap-2">
            <dt className="shrink-0 text-[var(--fg-4)]">{row.label}</dt>
            <dd className={`min-w-0 text-right ${row.unavailable ? "text-[var(--fg-3)] italic" : "text-[var(--fg-0)]"}`}>{row.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
