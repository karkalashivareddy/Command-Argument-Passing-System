import { AlertTriangle, Crosshair, XCircle } from "lucide-react";

import { ProvenanceBadge } from "../evidence/Provenance";
import { exitStatusLabel, fmtClock, fmtDuration } from "../../lib/format";
import { EVENT_LABELS } from "../../lib/stages";
import type { CanonicalEvent, SessionRecord } from "../../types/observability";

/**
 * WHY A FAILURE IS AN EVIDENCE PANEL AND NOT A RED LINE
 * ---------------------------------------------------
 * A failure is the one thing a reader most needs to check and least can afford to
 * take on trust, so it gets the same treatment as a measurement: the reason
 * verbatim from the record, the exit status, and the sequence number of the event
 * that recorded it, with a control that moves the shared cursor to that exact
 * event.
 *
 * There is deliberately NO fallback wording. `session.error` is the gateway's own
 * message and is shown as-is; when it is absent the panel says the record does
 * not carry one and names the events it did find. A generic "Something went
 * wrong" would be a sentence the frontend invented about a backend it never
 * asked, and it would be indistinguishable from a real reason in a screenshot.
 */

/** Failure events, most specific first: the first match is the record's root cause. */
const FAILURE_TYPES: readonly CanonicalEvent["type"][] = [
  "process.launch_failed",
  "process.exec_error",
  "process.wait_failed",
  "command.parse_error",
  "redirection.failed",
  "execution.timeout",
  "execution.cancelled",
  "execution.failed",
];

interface FailureRecord {
  event: CanonicalEvent;
  /** The engine's own words, when it supplied any. Never paraphrased. */
  reason: string | null;
  /** The specific claim this event makes, stated from its payload. */
  claim: string;
}

function str(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function describeFailure(event: CanonicalEvent): FailureRecord {
  const payload = event.payload;
  switch (event.type) {
    case "process.launch_failed":
      return { event, reason: str(payload, "reason"), claim: "the engine never created the child process" };
    case "process.exec_error": {
      const errno = typeof payload.errno === "number" ? payload.errno : null;
      const errnoName = str(payload, "errnoName");
      return {
        event,
        reason: str(payload, "reason"),
        claim: `execvp() failed${errno === null ? "" : ` with errno ${errno}${errnoName === null ? "" : ` (${errnoName})`}`} — no program image was ever installed, so this is not an exit code`,
      };
    }
    case "process.wait_failed":
      return { event, reason: str(payload, "reason"), claim: "waitpid() did not return a status, so the process outcome is unknown rather than successful" };
    case "command.parse_error":
      return { event, reason: str(payload, "reason") ?? str(payload, "message"), claim: "the command could not be turned into an argument vector" };
    case "redirection.failed":
      return { event, reason: str(payload, "reason") ?? str(payload, "path"), claim: "a redirection target could not be opened, so the child was never started" };
    case "execution.timeout":
      return { event, reason: str(payload, "reason"), claim: "the gateway stopped the execution because it passed its timeout threshold" };
    case "execution.cancelled":
      return { event, reason: str(payload, "reason"), claim: "the execution was cancelled before it finished" };
    default:
      return { event, reason: str(payload, "reason") ?? str(payload, "message") ?? str(payload, "error"), claim: "the gateway recorded the execution as failed" };
  }
}

/** The failure this record supports, or null when it holds none. */
export function findFailure(events: CanonicalEvent[]): FailureRecord | null {
  for (const type of FAILURE_TYPES) {
    const event = events.find((e) => e.type === type);
    if (event !== undefined) return describeFailure(event);
  }
  return null;
}

export function FailureEvidence({
  session,
  events,
  selectedSequence = null,
  onSelectEvent,
}: {
  session: SessionRecord;
  events: CanonicalEvent[];
  /** The store's current event selection, so the panel can show when it is open. */
  selectedSequence?: number | null;
  /** Moves the shared cursor to the failure event. */
  onSelectEvent?: (sequence: number) => void;
}) {
  const failure = findFailure(events);
  const sessionError = session.error;
  // The exit status is a real observation or it is absent. A signalled process
  // has no exit code, and `?? 0` would say it succeeded.
  const hasStatus = session.exitCode !== null || (session.signal !== null && session.signal > 0);
  const open = failure !== null && onSelectEvent !== undefined;
  const isOpen = open && selectedSequence !== null && selectedSequence !== undefined && selectedSequence === failure.event.sequence;

  return (
    <section
      className="rounded-[var(--r-lg)] border border-[var(--red-soft)] bg-[var(--bg-1)]"
      aria-label="Execution failure evidence"
    >
      <header className="flex flex-wrap items-center gap-2 border-b border-[var(--red-soft)] px-4 py-2.5">
        <AlertTriangle className="h-3.5 w-3.5 text-[var(--red)]" />
        <h2 className="text-[13px] font-semibold text-[var(--fg-0)]">Execution failure</h2>
        <span className="font-mono text-[9.5px] uppercase tracking-[0.12em] text-[var(--fg-3)]">
          from the persisted record, not a UI verdict
        </span>
        {failure === null ? (
          <span className="ml-auto font-mono text-[10.5px] text-[var(--fg-3)]">
            {sessionError === null ? "no failure event in this record" : "gateway message only — no failure event recorded"}
          </span>
        ) : (
          <span className="ml-auto font-mono text-[10.5px] text-[var(--red)]">
            {EVENT_LABELS[failure.event.type]} · #{failure.event.sequence} · {fmtClock(failure.event.timestamp)}
          </span>
        )}
      </header>

      <dl className="grid grid-cols-1 gap-x-6 gap-y-2 px-4 py-3 sm:grid-cols-2">
        <div className="min-w-0">
          <dt className="font-mono text-[9px] uppercase tracking-[0.12em] text-[var(--fg-3)]">Reason (gateway message)</dt>
          <dd className="mt-0.5 font-mono text-[12px] leading-relaxed text-[var(--fg-0)]">
            {/*
              `session.error` first: it is the gateway's own final word on why the
              session is FAILED, and it can carry detail the event payload does
              not. The event's `reason` is the fallback, not a replacement.
            */}
            {sessionError !== null ? (
              sessionError
            ) : failure?.reason != null ? (
              failure.reason
            ) : (
              <span className="text-[var(--fg-4)]">
                UNAVAILABLE — {failure === null ? "the record holds no failure event and the gateway recorded no error message" : `event #${failure.event.sequence} carries no reason field`}
              </span>
            )}
          </dd>
        </div>

        <div className="min-w-0">
          <dt className="font-mono text-[9px] uppercase tracking-[0.12em] text-[var(--fg-3)]">Exit status</dt>
          <dd className="mt-0.5 font-mono text-[12px] text-[var(--fg-0)]">
            {hasStatus ? exitStatusLabel(session.exitCode, session.signal) : <span className="text-[var(--fg-4)]">UNAVAILABLE — the record carries no termination status</span>}
          </dd>
          {/*
            Duration is the gateway's own figure and is labelled as such. It is
            never derived from the browser's clock here: that number would be a
            measurement of this page, not of the execution.
          */}
          <dd className="mt-0.5 font-mono text-[10px] text-[var(--fg-3)]">
            duration {session.durationMs === null ? "UNAVAILABLE" : `${fmtDuration(session.durationMs)} · DERIVED FROM GATEWAY CLOCK`}
          </dd>
        </div>

        <div className="min-w-0">
          <dt className="font-mono text-[9px] uppercase tracking-[0.12em] text-[var(--fg-3)]">What the record shows</dt>
          <dd className="mt-0.5 text-[11.5px] leading-relaxed text-[var(--fg-2)]">
            {failure === null ? (
              session.status === "FAILED" || session.status === "TIMED_OUT" || session.status === "CANCELLED"
                ? `The session is ${session.status}, but no failure event of any kind (${FAILURE_TYPES.join(", ")}) is present in this record. The status comes from the gateway's session row; the event stream does not corroborate it.`
                : `The session status is ${session.status} and no failure event is recorded, so there is nothing here to explain.`
            ) : (
              <>
                <ProvenanceBadge provenance="OBSERVED" source={`${failure.event.source} event stream`} />
                <span className="mt-1 block">{failure.claim}</span>
              </>
            )}
          </dd>
        </div>

        <div className="min-w-0">
          <dt className="font-mono text-[9px] uppercase tracking-[0.12em] text-[var(--fg-3)]">Event that recorded it</dt>
          <dd className="mt-0.5 font-mono text-[12px] text-[var(--fg-0)]">
            {failure === null ? (
              <span className="text-[var(--fg-4)]">UNAVAILABLE</span>
            ) : (
              <>
                <span>#{failure.event.sequence}</span>{" "}
                <span className="text-[var(--fg-3)]">{failure.event.type}</span>
              </>
            )}
          </dd>
          {open && failure !== null ? (
            <dd className="mt-1">
              <button
                type="button"
                onClick={() => onSelectEvent!(failure.event.sequence)}
                aria-pressed={isOpen}
                title="Move the shared cursor to this event; the timeline, the 3D view and the console follow it"
                className={`inline-flex items-center gap-1.5 rounded-[var(--r-sm)] border px-2 py-1 font-mono text-[10.5px] transition-colors ${
                  isOpen ? "border-[var(--violet-soft)] bg-[var(--violet-soft)] text-[var(--violet)]" : "border-[var(--line-1)] text-[var(--fg-1)] hover:border-[var(--accent)] hover:text-[var(--accent)]"
                }`}
              >
                <Crosshair className="h-3 w-3" />
                {isOpen ? "open in the console" : `open event #${failure.event.sequence}`}
              </button>
            </dd>
          ) : failure !== null ? (
            <dd className="mt-0.5 font-mono text-[9.5px] text-[var(--fg-4)]">
              sequence #{failure.event.sequence} is readable in the event console below
            </dd>
          ) : null}
        </div>
      </dl>

      {session.stdout.trim() === "" && session.stderr.trim() === "" ? null : (
        <div className="border-t border-[var(--red-soft)] px-4 py-2.5">
          <p className="inline-flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-[0.12em] text-[var(--fg-3)]">
            <XCircle className="h-3 w-3 text-[var(--amber)]" />
            what the program wrote before it ended
          </p>
          {session.stderr.trim() !== "" ? (
            <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-[10.5px] leading-relaxed text-[var(--amber)]">{session.stderr}</pre>
          ) : null}
        </div>
      )}
    </section>
  );
}