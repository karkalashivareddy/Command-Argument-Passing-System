/**
 * The command lifecycle, as a sequence of stages that light up from real state.
 *
 * THE RULE THAT MAKES THIS HONEST
 * -------------------------------
 * A stage is lit ONLY when the persisted event stream says it happened. There is
 * no animation that plays "the fork" regardless of whether a fork was observed,
 * and no idle loop that walks the stages on its own to make the page look alive.
 *
 * This matters more here than in most products, because CAPS's entire claim is
 * that it does not simulate a process. A decorative lifecycle animation would be
 * exactly the failure the rest of the interface is built to avoid: it would draw
 * a process into being that never existed. So the idle state shows a dim,
 * clearly-labelled rail with nothing lit, and a stage illuminates only when the
 * corresponding event type is in the record.
 *
 * WHY THE IDLE STATE IS NOT "AUTOPLAY"
 * ------------------------------------
 * Autoplay was the obvious alternative and it is wrong twice over. It would show
 * a user who has not run anything a lifecycle that looks observed, and it would
 * mean the page demonstrates a fictional execution on every visit. The rail is
 * more honest AND more useful: the reader can see what the stages ARE before they
 * run, so when one lights up they know what it means.
 *
 * The mapping from event type to stage is a single exported table, so the same
 * vocabulary is used by this rail, the evidence chain and the flight recorder.
 * Three views that describe a lifecycle with three different vocabularies is the
 * problem this product already solved once (the `stages.ts` module) and must not
 * reintroduce.
 */

import { clsx } from "clsx";

import type { CanonicalEvent, CanonicalEventType } from "../../types/observability";

export interface LifecycleStage {
  readonly id: string;
  readonly label: string;
  /**
   * Human explanation of what the kernel actually did at this stage. Shown on
   * hover/focus and in the presenter's view, because a label like "EXEC" is a
   * mnemonic and not an explanation.
   */
  readonly detail: string;
  /**
   * Event types that satisfy this stage.
   *
   * A stage is satisfied by the PRESENCE of any of these, never by an ordering
   * assumption, so a session that skipped a stage (a launch failure, for instance)
   * shows that stage unsatisfied rather than silently advancing.
   */
  readonly satisfiedBy: readonly CanonicalEventType[];
}

/**
 * The canonical lifecycle.
 *
 * Order is the real order: the argv exists before the fork, the fork precedes the
 * exec, nothing is observed about a process until procfs has a PID to report, and
 * the wait status can only be read after the process has exited.
 */
export const LIFECYCLE_STAGES: readonly LifecycleStage[] = [
  {
    id: "input",
    label: "INPUT",
    detail: "A request arrives at the gateway carrying a command name and an argument vector.",
    satisfiedBy: ["command.received", "execution.created"],
  },
  {
    id: "argv",
    label: "ARGV",
    detail: "The C engine's own lexer tokenises the command into a vector. There is no shell.",
    satisfiedBy: ["command.parsed"],
  },
  {
    id: "fork",
    label: "FORK",
    detail: "fork() returns a child PID. The kernel allocates the PID here, before exec.",
    satisfiedBy: ["process.started"],
  },
  {
    id: "exec",
    label: "EXEC",
    detail: "execvp() replaces the child's image. A failure here is an exec error, not an exit.",
    satisfiedBy: ["execution.started", "process.started"],
  },
  {
    id: "run",
    label: "RUN",
    detail: "The program executes and the gateway samples /proc for it while it lives.",
    satisfiedBy: ["process.snapshot"],
  },
  {
    id: "wait",
    label: "WAIT",
    detail: "waitpid() reaps the child and yields an exit code or a terminating signal.",
    satisfiedBy: ["process.exited"],
  },
  {
    id: "result",
    label: "RESULT",
    detail: "The gateway finalises the session and records its own outcome.",
    satisfiedBy: ["execution.completed", "execution.failed", "execution.timeout", "execution.cancelled"],
  },
];

export interface LifecycleRailProps {
  /** The persisted events for the session being described. Empty means idle. */
  events: readonly CanonicalEvent[];
  /** Compact mode drops the per-stage detail line; used where vertical space is tight. */
  compact?: boolean;
  className?: string;
}

/**
 * Which stages the record satisfies.
 *
 * Exported because the evidence chain and the presenter's step logic need the same
 * answer and must not re-derive it: two implementations of "did this happen" is
 * how a page ends up contradicting the stream it is reading.
 */
export function satisfiedStages(events: readonly CanonicalEvent[]): Set<string> {
  const present = new Set(events.map((e) => e.type));
  const satisfied = new Set<string>();
  for (const stage of LIFECYCLE_STAGES) {
    if (stage.satisfiedBy.some((t) => present.has(t))) satisfied.add(stage.id);
  }
  return satisfied;
}

export function LifecycleRail({ events, compact = false, className }: LifecycleRailProps) {
  const satisfied = satisfiedStages(events);
  const idle = satisfied.size === 0;

  return (
    <div className={clsx("min-w-0", className)}>
      <div
        className="flex items-stretch gap-0 overflow-x-auto"
        role="list"
        aria-label="Command lifecycle"
      >
        {LIFECYCLE_STAGES.map((stage, index) => {
          const done = satisfied.has(stage.id);
          /*
            "current" is the FIRST unsatisfied stage, which is a statement about
            the record ("everything up to here happened, this is what is expected
            next") rather than about time. A stage is never marked current merely
            because the page has been open for a while.
          */
          const current = !done && satisfied.has(LIFECYCLE_STAGES[index - 1]?.id ?? "");
          return (
            <div key={stage.id} className="flex min-w-0 flex-1 items-center" role="listitem">
              <div
                title={stage.detail}
                className={clsx(
                  "group flex min-w-0 flex-1 flex-col gap-1 rounded-[var(--r-sm)] px-2 py-1.5 transition-colors duration-[var(--motion-base)]",
                  done
                    ? "bg-[var(--accent-soft)]"
                    : current
                      ? "bg-[var(--bg-2)] caps-current"
                      : "caps-pending",
                )}
              >
                <span
                  className={clsx(
                    "truncate font-mono text-[10px] font-bold tracking-[var(--tracking-micro)]",
                    done ? "text-[var(--role-observed)]" : current ? "text-[var(--fg-1)]" : "text-[var(--fg-4)]",
                  )}
                >
                  {stage.label}
                </span>
                {!compact ? (
                  <span
                    className={clsx(
                      "truncate font-mono text-[9.5px] leading-tight",
                      done ? "text-[var(--fg-3)]" : "text-[var(--fg-4)]",
                    )}
                  >
                    {done ? "observed" : current ? "expected" : "not reached"}
                  </span>
                ) : null}
              </div>
              {index < LIFECYCLE_STAGES.length - 1 ? (
                <span
                  aria-hidden="true"
                  className={clsx(
                    "mx-0.5 h-px w-3 shrink-0",
                    satisfied.has(stage.id) && satisfied.has(LIFECYCLE_STAGES[index + 1]!.id)
                      ? "bg-[var(--accent)]/50"
                      : "bg-[var(--line-1)]",
                  )}
                />
              ) : null}
            </div>
          );
        })}
      </div>

      {/*
        The idle caption states plainly that nothing has run, rather than showing
        an empty rail that a reader might mistake for a stalled page.
      */}
      {idle ? (
        <p className="mt-1.5 px-0.5 text-[11px] text-[var(--fg-4)]">
          Idle. These stages light up from the recorded event stream as an execution happens.
        </p>
      ) : null}
    </div>
  );
}