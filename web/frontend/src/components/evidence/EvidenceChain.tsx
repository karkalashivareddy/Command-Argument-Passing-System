import { useMemo } from "react";
import { Link } from "react-router-dom";

import { ProvenanceBadge } from "./Provenance";
import { Card } from "../ui";
import { buildEvidenceChain, type ChainStage } from "../../lib/evidenceChain";
import type { CanonicalEvent } from "../../types/observability";

/**
 * The execution evidence chain.
 *
 * WHAT THIS IS NOT
 * ----------------
 * It is not a lifecycle animation and not a progress bar. Every node states what
 * the record contains about that step, with the provenance class attached, and
 * a step with no evidence reads UNAVAILABLE together with the event it was
 * waiting for. A reader who sees ten nodes and three UNAVAILABLE ones learns that
 * three steps are unaccounted for, which is the whole point of a chain.
 *
 * WHY EVERY NODE IS A BUTTON
 * --------------------------
 * Selecting a node moves the SHARED cursor to the first event that satisfies it,
 * through the shared store — never through local state. That is what keeps the
 * 2D page, the 3D space, the timeline and the event console showing the same
 * moment; a second, private cursor here would be the exact defect this surface
 * is supposed to eliminate. A node with no evidence is disabled rather than
 * clickable, because there is no event to move to and inventing one is forbidden.
 */
export function EvidenceChain({
  events,
  sessionId,
  selectedSequence,
  onSelectEvent,
}: {
  events: CanonicalEvent[];
  sessionId: string;
  /** The store's event selection, so the reader can see which node is active. */
  selectedSequence?: number | null;
  /** Moves the shared selection. Supplied by the page, which owns the session id. */
  onSelectEvent?: (sequence: number) => void;
}) {
  // Memoised because buildEvidenceChain rebuilds the whole correlation index, and
  // this panel re-renders on every cursor move while the reader scrubs.
  const chain = useMemo(() => buildEvidenceChain(events), [events]);

  return (
    <Card
      title="Execution evidence chain"
      subtitle="Every stage of one execution, with the record's own verdict about each — a stage the record cannot support reads UNAVAILABLE, never as if it happened"
      actions={
        <span className="font-mono text-[9.5px] text-[var(--fg-3)]">
          {chain.supported} of {chain.total} stages supported by {events.length} recorded event{events.length === 1 ? "" : "s"}
        </span>
      }
      pad={false}
    >
      <ol className="flex flex-wrap items-stretch gap-0 overflow-x-auto px-4 py-3" aria-label="Execution evidence chain">
        {chain.stages.map((stage, i) => (
          <li key={stage.id} className="flex min-w-0 flex-1 items-center">
            <StageNode
              stage={stage}
              active={selectedSequence !== null && selectedSequence !== undefined && stage.sequence === selectedSequence}
              onSelect={onSelectEvent}
            />
            {i < chain.stages.length - 1 ? <Connector satisfied={stage.state !== "unavailable"} /> : null}
          </li>
        ))}
      </ol>

      {/*
        The table is the readable form of the same data. The rail above is for
        scanning; this is for checking a claim, so every stage states its
        provenance, its source, and — when it is UNAVAILABLE — the reason the
        record gives for not having it.
      */}
      <div className="overflow-x-auto border-t border-[var(--line-0)] px-4 py-3">
        <table className="w-full text-left">
          <thead>
            <tr className="border-b border-[var(--line-0)] text-[9.5px] uppercase tracking-[0.12em] text-[var(--fg-3)]">
              <th className="py-1.5 pr-4 font-semibold">Stage</th>
              <th className="py-1.5 pr-4 font-semibold">Class</th>
              <th className="py-1.5 pr-4 font-semibold">What the record shows</th>
              <th className="py-1.5 pr-4 font-semibold">Source</th>
              <th className="py-1.5 pr-4 font-semibold">Event</th>
              <th className="py-1.5 font-semibold">Detail</th>
            </tr>
          </thead>
          <tbody>
            {chain.stages.map((stage) => (
              <tr key={stage.id} className="border-b border-[var(--line-0)] align-top last:border-b-0">
                <td className="py-1.5 pr-4 font-mono text-[11px] font-semibold text-[var(--fg-1)]">{stage.label}</td>
                <td className="py-1.5 pr-4">
                  <ProvenanceBadge
                    provenance={stage.provenance}
                    source={stage.source}
                    reason={stage.reason}
                  />
                </td>
                <td className="py-1.5 pr-4 font-mono text-[10.5px] text-[var(--fg-1)]">
                  {stage.state === "failed" ? <span className="text-[var(--red)]">{stage.value}</span> : stage.value}
                </td>
                <td className="py-1.5 pr-4 font-mono text-[10px] text-[var(--fg-3)]">{stage.source}</td>
                <td className="py-1.5 pr-4 font-mono text-[10px] text-[var(--fg-3)]">
                  {stage.sequence === null ? (
                    <span className="text-[var(--fg-4)]">—</span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => onSelectEvent?.(stage.sequence!)}
                      disabled={onSelectEvent === undefined}
                      title="Move the shared cursor to this event"
                      className="text-[var(--accent)] underline decoration-dotted underline-offset-2 hover:text-[var(--fg-0)] disabled:no-underline"
                    >
                      #{stage.sequence}
                    </button>
                  )}
                </td>
                <td className="py-1.5 text-[10.5px] leading-relaxed text-[var(--fg-3)]">
                  {stage.detail}
                  {stage.reason !== undefined ? <span className="block text-[var(--warn)]">{stage.reason}</span> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-[var(--line-0)] px-4 py-2 text-[9.5px] font-mono text-[var(--fg-4)]">
        <span className="text-[var(--fg-3)]">EXEC carries no success event in CAPS — it shows that exec was attempted and no failure was recorded, which is a different and weaker claim.</span>
        <Link to={`/execution/${sessionId}#event-stream`} className="ml-auto underline decoration-dotted underline-offset-2 hover:text-[var(--accent)]">
          open the full event console
        </Link>
      </div>
    </Card>
  );
}

function nodeTone(stage: ChainStage): { box: string; label: string } {
  switch (stage.state) {
    case "observed":
      return { box: "border-[var(--green-soft)] bg-[var(--bg-2)]", label: "text-[var(--green)]" };
    case "derived":
      // Derived is not a weaker observation, it is a DIFFERENT claim, and it is
      // tinted with the violet the app already reserves for derived values.
      return { box: "border-[var(--violet-soft)] bg-[var(--bg-2)]", label: "text-[var(--violet)]" };
    case "failed":
      return { box: "border-[var(--red-soft)] bg-[var(--bg-2)]", label: "text-[var(--red)]" };
    default:
      // Dashed, because this is the absence of evidence rather than evidence of
      // absence: a dashed box must never be mistaken for a stage that happened.
      return { box: "border-dashed border-[var(--line-1)] bg-[var(--bg-1)]", label: "text-[var(--fg-4)]" };
  }
}

function StageNode({ stage, active, onSelect }: { stage: ChainStage; active: boolean; onSelect?: (sequence: number) => void }) {
  const tone = nodeTone(stage);
  const clickable = stage.sequence !== null && onSelect !== undefined;
  const short = stage.state === "unavailable" ? "UNAVAILABLE" : stage.state === "derived" ? "DERIVED" : stage.state === "failed" ? "FAILED" : stage.sequence === null ? "UNAVAILABLE" : `#${stage.sequence}`;

  const body = (
    <>
      <span className={`truncate font-mono text-[10px] font-bold tracking-[var(--tracking-micro)] ${tone.label}`}>{stage.label}</span>
      <span className="truncate font-mono text-[9px] text-[var(--fg-4)]">{short}</span>
    </>
  );

  const shell = `flex min-w-0 flex-1 flex-col gap-1 rounded-[var(--r-sm)] px-2 py-1.5 text-left transition-colors ${tone.box} ${
    active ? "ring-1 ring-[var(--violet)]" : clickable ? "cursor-pointer hover:border-[var(--accent)]" : ""
  }`;

  if (!clickable) {
    return (
      <div className={shell} title={stage.reason ?? stage.detail} aria-disabled="true">
        {body}
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={() => onSelect!(stage.sequence!)}
      title={`${stage.label}: ${stage.value}. Move the shared cursor to event #${stage.sequence}.`}
      aria-label={`${stage.label}: ${stage.value}. Move the shared cursor to event #${stage.sequence}.`}
      className={`${shell} focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]`}
    >
      {body}
    </button>
  );
}

function Connector({ satisfied }: { satisfied: boolean }) {
  return <span aria-hidden="true" className={`mx-0.5 h-px w-3 shrink-0 ${satisfied ? "bg-[var(--line-2)]" : "bg-[var(--line-0)]"}`} />;
}