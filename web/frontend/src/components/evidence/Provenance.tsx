/**
 * The provenance vocabulary, as visible components.
 *
 * WHY THIS IS A SHARED MODULE AND NOT SEVEN INLINE SPANS
 * -------------------------------------------------------
 * Provenance was already displayed in seven places before this existed, and it
 * was implemented seven different ways: an uppercase chip on the process graph,
 * a `title` attribute in the inspector, an `aria-label` on a host-explorer cell,
 * a prose sentence under a metric card, and so on. That is why the 3D scene and
 * the resource charts could drop provenance entirely without anything looking
 * broken: no single place was the canonical one to fix.
 *
 * These components are the canonical ones. A metric that goes through
 * `MetricProvenance` cannot be presented as a plain number by accident, because
 * the badge is a required prop rather than something a caller remembers to add.
 *
 * THE THREE CLASSES, AND WHAT EACH ONE CLAIMS
 * -------------------------------------------
 *   OBSERVED     read directly from a kernel file. `source` says which.
 *   DERIVED      computed. `formula` says how, and `source` says the inputs.
 *   UNAVAILABLE  not measurable here. `reason` says why, and there is no number.
 *
 * UNAVAILABLE is the one that matters most. It is the only class where the
 * honest response to a missing metric is to say so rather than render a zero,
 * and it is the one this project has most often got wrong: an axis tick
 * formatter that returned "0" for a negative time, a first-sample CPU rate, and
 * a stderr line buffer that grew without bound.
 */

import type { ReactNode } from "react";

import type { RawMetric, TelemetryProvenance } from "../../types/observability";

/**
 * The three tones, named for what they mean rather than how they look.
 *
 * Cyan is reserved for OBSERVED and violet for DERIVED on purpose: those two
 * colours are already the product's telemetry and execution-transition colours,
 * so a derived rate and an execution event read as members of the same visual
 * language, while a warm tone means "this is not a measurement" everywhere it
 * appears. An UNAVAILABLE badge must never look like a value.
 */
const TONE: Record<TelemetryProvenance, { chip: string; dot: string }> = {
  OBSERVED: {
    chip: "border-[var(--accent)]/40 bg-[var(--accent)]/10 text-[var(--accent)]",
    dot: "bg-[var(--accent)]",
  },
  DERIVED: {
    chip: "border-[var(--violet)]/40 bg-[var(--violet)]/10 text-[var(--violet)]",
    dot: "bg-[var(--violet)]",
  },
  UNAVAILABLE: {
    chip: "border-[var(--warn)]/40 bg-[var(--warn)]/10 text-[var(--warn)]",
    dot: "bg-[var(--warn)]",
  },
};

/** The word shown, always uppercase and always the class name. */
export const PROVENANCE_WORD: Record<TelemetryProvenance, string> = {
  OBSERVED: "OBSERVED",
  DERIVED: "DERIVED",
  UNAVAILABLE: "UNAVAILABLE",
};

/**
 * A bare provenance marker.
 *
 * `title` carries the source, formula or reason as a native tooltip, and the
 * same text is also exposed through `aria-label`, because a `title` is not
 * reliably announced by a screen reader and this badge is frequently the ONLY
 * statement that a number is derived.
 */
export function ProvenanceBadge({
  provenance,
  source,
  formula,
  reason,
  className = "",
}: {
  provenance: TelemetryProvenance;
  /** The kernel file or backend field the value came from. */
  source?: string;
  /** How a DERIVED value was computed. */
  formula?: string;
  /** Why a value is UNAVAILABLE. Required when provenance is UNAVAILABLE. */
  reason?: string;
  className?: string;
}) {
  const detail =
    provenance === "UNAVAILABLE"
      ? (reason ?? "not measurable in this environment")
      : [source, formula].filter(Boolean).join(" · ");

  return (
    <span
      className={`inline-flex items-center gap-1 rounded-[var(--r-xs)] border px-1 py-px font-mono text-[9px] font-bold uppercase tracking-[0.1em] ${TONE[provenance].chip} ${className}`}
      title={detail}
      aria-label={detail.length > 0 ? `${PROVENANCE_WORD[provenance]}: ${detail}` : PROVENANCE_WORD[provenance]}
    >
      <span aria-hidden="true" className={`h-1 w-1 rounded-full ${TONE[provenance].dot}`} />
      {PROVENANCE_WORD[provenance]}
    </span>
  );
}

/**
 * A metric rendered with its provenance attached, and nothing else.
 *
 * This is deliberately not a general-purpose card. It is the smallest unit that
 * cannot be misused: the number and the class that describes it are rendered by
 * one function, so a consumer that wants to show a metric cannot accidentally
 * show it without its badge.
 *
 * `format` receives the value only, so a formatter cannot read provenance and
 * infer anything about it. `unit` is rendered verbatim, which means a caller
 * supplying a wrong unit is visible in review rather than hidden in a helper.
 */
export function MetricProvenance({
  label,
  metric,
  format,
  unit,
  source,
  formula,
  unavailableLabel = "UNAVAILABLE",
}: {
  label: string;
  metric: RawMetric | null;
  format: (value: number) => string;
  unit?: string;
  source?: string;
  formula?: string;
  unavailableLabel?: string;
}) {
  const unavailable = metric === null || metric.value === null;
  return (
    <div className="min-w-0">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate font-mono text-[9.5px] font-semibold uppercase tracking-[0.1em] text-[var(--fg-3)]">
          {label}
        </span>
        {metric === null ? (
          <ProvenanceBadge provenance="UNAVAILABLE" reason="no telemetry sample was recorded for this process at this point in time" />
        ) : (
          <ProvenanceBadge
            provenance={metric.provenance}
            source={source}
            formula={formula}
            reason={metric.reason}
          />
        )}
      </div>
      <div
        className={`mt-0.5 font-mono text-[12.5px] tabular-nums ${unavailable ? "text-[var(--fg-4)]" : "text-[var(--fg-0)]"}`}
      >
        {unavailable ? (
          <span title={metric?.reason ?? undefined}>{unavailableLabel}</span>
        ) : (
          <>
            {format(metric.value as number)}
            {unit !== undefined ? <span className="ml-1 text-[var(--fg-4)]">{unit}</span> : null}
          </>
        )}
      </div>
      {metric?.unitNote !== undefined && !unavailable ? (
        <p className="mt-0.5 text-[10px] leading-snug text-[var(--fg-4)]">{metric.unitNote}</p>
      ) : null}
      {unavailable && metric?.reason !== undefined ? (
        <p className="mt-0.5 text-[10px] leading-snug text-[var(--fg-4)]">{metric.reason}</p>
      ) : null}
    </div>
  );
}

/**
 * The explanation panel, for a metric the reader is about to trust.
 *
 * The spec this answers: "CPU UTILIZATION 18.4% DERIVED. Source: two
 * consecutive process samples. Formula: Δ CPU / Δ wall time." It is a
 * disclosure rather than a hover, because the difference between an observed
 * gauge and a derived rate is the whole basis on which the numbers can be
 * compared, and a reader should not have to hover to learn which one they have.
 */
export function EvidenceTooltip({
  metric,
  children,
}: {
  metric: RawMetric | null;
  children?: ReactNode;
}) {
  if (metric === null) return <>{children}</>;
  return (
    <details className="group">
      <summary className="cursor-pointer list-none text-[10.5px] text-[var(--fg-3)] hover:text-[var(--fg-2)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]">
        {children ?? "How this was measured"}
      </summary>
      <div className="mt-1.5 space-y-1 rounded-[var(--r-sm)] border border-[var(--line-0)] bg-[var(--bg-2)] px-2.5 py-2 text-[11px] leading-relaxed">
        <div className="flex items-center gap-2">
          <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-[var(--fg-3)]">Class</span>
          <ProvenanceBadge
            provenance={metric.provenance}
            source={metric.source as string | undefined}
            formula={metric.formula as string | undefined}
            reason={metric.reason}
          />
        </div>
        {metric.source !== undefined ? (
          <p className="text-[var(--fg-2)]">
            <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-[var(--fg-3)]">Source </span>
            <code className="font-mono">{metric.source}</code>
          </p>
        ) : null}
        {metric.formula !== undefined ? (
          <p className="text-[var(--fg-2)]">
            <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-[var(--fg-3)]">Formula </span>
            <code className="font-mono">{metric.formula}</code>
          </p>
        ) : null}
        {metric.reason !== undefined ? (
          <p className="text-[var(--warn)]">
            <span className="font-mono text-[10px] uppercase tracking-[0.1em]">Reason </span>
            {metric.reason}
          </p>
        ) : null}
        {metric.confidence !== undefined ? (
          <p className="text-[var(--fg-2)]">
            <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-[var(--fg-3)]">Confidence </span>
            {metric.confidence}
          </p>
        ) : null}
      </div>
    </details>
  );
}