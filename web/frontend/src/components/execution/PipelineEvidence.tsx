/**
 * Pipeline evidence view: the recorded lifecycle of each stage.
 *
 * Consumes the SAME reducer the replay view uses, so the live and replayed
 * renderings of an execution are incapable of disagreeing. A divergence would
 * have to be a bug in the reducer rather than in two separate reconstructions.
 *
 * What it deliberately does not do: infer anything the record does not state. A
 * stage that never started is shown as a stage that never started, with its
 * absence of an exit code visible, because a reader who sees three stages and
 * two exit codes needs to be told that the third produced no evidence rather
 * than left to wonder whether it succeeded.
 */

import { useMemo } from "react";

import { Card } from "../ui";
import { formatMilliseconds } from "../../lib/hostTelemetry";
import {
  pipelineExitStatus,
  reducePipelineEvidence,
  sharesOneProcessGroup,
  type StageEvidence,
  type StageLifecycle,
} from "../../lib/pipelineEvidence";
import { formatArgv } from "../../lib/terminal";
import type { CanonicalEvent } from "../../types/observability";

/** One stage's row, with every field the record carries and none it does not. */
function StageRow({ stage, isLast }: { stage: StageEvidence; isLast: boolean }): React.JSX.Element {
  return (
    <li className="rounded-[var(--r-md)] border border-[var(--line-1)] bg-[var(--bg-2)] px-3 py-2.5">
      {isLast ? "└──" : "├──"} stage {stage.index}
      <dl className="mt-2 grid grid-cols-[minmax(6rem,auto)_1fr] gap-x-4 gap-y-1 text-[11.5px]">
        <div className="contents">
          <dt className="font-semibold uppercase tracking-[0.1em] text-[var(--fg-3)]">Status</dt>
          <dd>
            <span aria-label={stage.lifecycle}>{stage.lifecycle}</span>
            {stage.note !== null && <span className="text-[var(--fg-3)]"> — {stage.note}</span>}
          </dd>
        </div>
        <div className="contents">
          <dt className="font-semibold uppercase tracking-[0.1em] text-[var(--fg-3)]">PID</dt>
          <dd>{stage.pid ?? "never assigned: the stage did not start"}</dd>
        </div>
        <div className="contents">
          <dt className="font-semibold uppercase tracking-[0.1em] text-[var(--fg-3)]">PGID</dt>
          <dd>{stage.pgid ?? "unknown"}</dd>
        </div>
        <div className="contents">
          <dt className="font-semibold uppercase tracking-[0.1em] text-[var(--fg-3)]">argv</dt>
          <dd>
            {stage.argv.length === 0 ? (
              "not recorded: the stage produced no start event"
            ) : (
              <>
                <code>{formatArgv(stage.argv)}</code>
                {stage.argvTruncated && (
                  <span className="text-[var(--amber)]">
                    {" "}
                    — {stage.argvElementsDropped} further element(s) were bounded out of the record by the engine
                  </span>
                )}
              </>
            )}
          </dd>
        </div>
        <div className="contents">
          <dt className="font-semibold uppercase tracking-[0.1em] text-[var(--fg-3)]">stdin</dt>
          <dd>{stage.readsFromPipe ? "from the previous stage's stdout" : "inherited"}</dd>
        </div>
        <div className="contents">
          <dt className="font-semibold uppercase tracking-[0.1em] text-[var(--fg-3)]">stdout</dt>
          <dd>{stage.writesToPipe ? "into the next stage's stdin" : "collected by the gateway"}</dd>
        </div>
        <div className="contents">
          <dt className="font-semibold uppercase tracking-[0.1em] text-[var(--fg-3)]">Duration</dt>
          <dd>
            {stage.durationMs === null
              ? stage.lifecycle === "NOT_STARTED"
                ? "none: the stage never ran"
                : "not recorded: the stage has not been reaped"
              : formatMilliseconds(stage.durationMs)}
          </dd>
        </div>
        <div className="contents">
          <dt className="font-semibold uppercase tracking-[0.1em] text-[var(--fg-3)]">Exit</dt>
          <dd>
            {/*
             * Three distinct states, never collapsed. A signalled process has no
             * exit code, and rendering that as 0 would say it succeeded.
             */}
            {stage.signal !== null && stage.signal > 0
              ? `killed by signal ${stage.signal}`
              : stage.exitCode === null
                ? stage.lifecycle === "NOT_STARTED"
                  ? "none: the stage never ran"
                  : "not yet recorded"
                : `exit code ${stage.exitCode}`}
          </dd>
        </div>
      </dl>
    </li>
  );
}

export function PipelineEvidenceView({ events }: { events: readonly CanonicalEvent[] }): React.JSX.Element {
  const evidence = useMemo(() => reducePipelineEvidence(events), [events]);
  const status = useMemo(() => pipelineExitStatus(evidence.stages), [evidence.stages]);
  const oneGroup = useMemo(() => sharesOneProcessGroup(evidence.stages), [evidence.stages]);

  if (evidence.stages.length === 0) {
    return (
      <Card title="Pipeline evidence">
        <p>{evidence.summary}</p>
      </Card>
    );
  }

  return (
    <Card title="Pipeline evidence">
      <p>{evidence.summary}</p>
      <p>
        <strong>Pipeline exit status:</strong>{" "}
        {status.signal !== null ? `signal ${status.signal}` : status.code === null ? "not recorded" : `code ${status.code}`}
        {" — "}
        {/*
         * Shell convention makes this the LAST stage's status, which is exactly
         * why every stage's own status has to stay visible beside it. Without
         * that, a pipeline that silently lost its producer reads as a clean run.
         */}
        the last stage's, matching shell convention.
      </p>
      {!oneGroup && (
        <p role="alert" className="rounded-[var(--r-md)] border border-[var(--amber)]/40 bg-[var(--amber)]/5 px-3 py-2 text-[var(--amber)]">
          The stages do not share one process group. A timeout or a signal would reach only part of the pipeline, which
          is not the behaviour the engine promises.
        </p>
      )}
      <ul className="space-y-2">
        {evidence.stages.map((stage, i) => (
          <StageRow key={stage.index} stage={stage} isLast={i === evidence.stages.length - 1} />
        ))}
      </ul>
    </Card>
  );
}

export type { StageLifecycle };
