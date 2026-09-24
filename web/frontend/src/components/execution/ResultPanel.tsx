import { AlertTriangle, CheckCircle2, Clock4, XCircle } from "lucide-react";

import { exitStatusLabel, fmtDuration } from "../../lib/format";
import { STATUS_META } from "../../lib/stages";
import type { SessionStatus } from "../../types/observability";
import { StatusDot } from "../ui";

/**
 * Honest execution outcome. Non-zero exit code with a session summary is a
 * real completion (isSuccess=false), not a failure — the process ran to the
 * end and reported a status; failures are the runs that never even finished.
 */
export function ResultPanel({
  status,
  exitCode,
  signal,
  durationMs,
  isSuccess,
  error,
}: {
  status: SessionStatus;
  exitCode: number | null;
  signal: number | null;
  durationMs: number | null;
  isSuccess: boolean | null;
  error: string | null;
}) {
  const meta = STATUS_META[status] ?? STATUS_META.CREATED;
  const hasStatus = exitCode !== null || (signal !== null && signal > 0);

  return (
    <div className="rounded-[var(--r-md)] border border-[var(--line-0)] bg-[var(--bg-2)] px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
        <StatusDot tone={meta.tone} label={meta.label} />
        {hasStatus ? (
          <span className="flex items-center gap-1.5 font-mono text-[12px] text-[var(--fg-1)]">
            {exitStatusLabel(exitCode, signal)}
          </span>
        ) : (
          <span className="flex items-center gap-1.5 font-mono text-[12px] text-[var(--fg-3)]">{error ?? "no termination status recorded"}</span>
        )}
        <span className="flex items-center gap-1.5 font-mono text-[12px] text-[var(--fg-2)]">
          <Clock4 className="h-3.5 w-3.5" />
          {fmtDuration(durationMs)}
        </span>
        {isSuccess !== null ? (
          isSuccess ? (
            <span className="flex items-center gap-1 text-[11.5px] font-semibold text-[var(--green)]">
              <CheckCircle2 className="h-3.5 w-3.5" /> success
            </span>
          ) : (
            <span className="flex items-center gap-1 text-[11.5px] font-semibold text-[var(--fg-2)]">
              <AlertTriangle className="h-3.5 w-3.5 text-[var(--amber)]" /> completed with error
            </span>
          )
        ) : null}
        {error ? (
          <span className="ml-auto max-w-[24rem] truncate font-mono text-[11px] text-[var(--red)]" title={error}>
            <XCircle className="mr-1 inline h-3 w-3" />
            {error}
          </span>
        ) : null}
      </div>
    </div>
  );
}