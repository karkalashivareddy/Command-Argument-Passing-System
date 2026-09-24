import { CheckCircle2, TriangleAlert } from "lucide-react";

import type { CanonicalEvent } from "../../types/observability";
import { sequenceIntegrity } from "../../lib/telemetry";

/**
 * Renders the event-sequence integrity check: the server numbers sequences
 * contiguously, so any gap means events were lost between write and read.
 */
export function SequenceBadge({ events }: { events: CanonicalEvent[] }) {
  const integrity = sequenceIntegrity(events);
  if (events.length === 0) {
    return <span className="font-mono text-[9.5px] text-[var(--fg-4)]">sequence · no events yet</span>;
  }
  if (integrity.contiguous) {
    return (
      <span className="inline-flex items-center gap-1 font-mono text-[9.5px] text-[var(--green)]" title="Every event arrived with its expected sequence number">
        <CheckCircle2 className="h-3 w-3" /> contiguous · no gaps
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 font-mono text-[9.5px] text-[var(--amber)]" title={`${integrity.missingSequences} sequence number(s) absent between ${integrity.gaps} gap(s)`}>
      <TriangleAlert className="h-3 w-3" /> {integrity.missingSequences} missing sequence{integrity.missingSequences === 1 ? "" : "s"} in {integrity.gaps} gap{integrity.gaps === 1 ? "" : "s"}
    </span>
  );
}
