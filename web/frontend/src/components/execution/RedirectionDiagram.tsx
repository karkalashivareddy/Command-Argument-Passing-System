import { motion } from "motion/react";
import { ArrowRight, FileX2 } from "lucide-react";

import type { CanonicalEvent, RedirectionSpec } from "../../types/observability";

interface FdRowProps {
  fd: "0" | "1";
  label: string;
  target: string | undefined;
  note: string;
  events: CanonicalEvent[];
  index: number;
}

function FdRow({ fd, label, target, note, events, index }: FdRowProps) {
  const opened = events.some((e) => e.type === "redirection.opened");
  const failed = events.some((e) => e.type === "redirection.failed");

  return (
    <div className="flex items-center justify-between rounded-[var(--r-md)] border border-[var(--line-0)] bg-[var(--bg-1)] px-3.5 py-2.5">
      <span className="flex items-center gap-3 font-mono text-[12.5px] text-[var(--fg-1)]">
        <span className="flex h-7 w-7 items-center justify-center rounded-[var(--r-sm)] border border-[var(--line-1)] bg-[var(--bg-3)] text-[var(--fg-0)]">
          {fd}
        </span>
        {label}
        <span className="hidden text-[10.5px] text-[var(--fg-3)] sm:inline">{note}</span>
      </span>
      <div className="flex items-center gap-2">
        <ArrowRight className="h-4 w-4 text-[var(--fg-3)]" />
        {target ? (
          <motion.div
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.3 + index * 0.15, duration: 0.2 }}
            className="flex items-center gap-2 rounded-[var(--r-sm)] border border-[var(--line-1)] bg-[var(--bg-2)] px-2.5 py-1.5"
          >
            <span className="font-mono text-[12.5px] text-[var(--amber)]">{target}</span>
            <span
              className={
                failed
                  ? "rounded-[var(--r-xs)] bg-[var(--red-soft)] px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-wide text-[var(--red)]"
                  : "rounded-[var(--r-xs)] bg-[var(--amber-soft)] px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-wide text-[var(--amber)]"
              }
            >
              {failed ? "OPEN FAILED" : opened ? "OPENED" : "requested"}
            </span>
          </motion.div>
        ) : (
          <span className="flex items-center gap-1.5 text-[12px] text-[var(--fg-3)]">
            <FileX2 className="h-3.5 w-3.5" />
            inherited
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * Standard io plumbing — stdin (fd 0) and stdout (fd 1) may be spliced to
 * plain relative workspace files; stderr (fd 2) is always the monitor
 * stream. The request target and aggregate setup result come from the real
 * spec and redirection.opened / redirection.failed events; individual
 * open()/dup2()/close() calls are not separately observed.
 */
export function RedirectionDiagram({ redirections, events }: { redirections: RedirectionSpec; events: CanonicalEvent[] }) {
  const opened = events.filter((e) => e.type === "redirection.opened").length;
  const failed = events.filter((e) => e.type === "redirection.failed").length;
  const anyRedirects = Boolean(redirections.in || redirections.out || redirections.append);

  return (
    <div className="space-y-2 py-1">
      <div className="flex flex-wrap gap-1 text-[10.5px] text-[var(--fg-3)]">
        <span className="rounded-[var(--r-xs)] bg-[var(--bg-2)] px-1.5 py-0.5 font-mono">stdin = fd 0</span>
        <span className="rounded-[var(--r-xs)] bg-[var(--bg-2)] px-1.5 py-0.5 font-mono">stdout = fd 1</span>
        <span className="rounded-[var(--r-xs)] bg-[var(--bg-2)] px-1.5 py-0.5 font-mono">stderr = fd 2 (monitor stream)</span>
        <span className="rounded-[var(--r-xs)] bg-[var(--bg-2)] px-1.5 py-0.5 font-mono">
          {opened} opened{failed > 0 ? ` · ${failed} failed` : ""}
        </span>
      </div>

      {anyRedirects ? (
        <>
          {redirections.in ? <FdRow fd="0" label="stdin" target={redirections.in} note="· O_RDONLY" events={events} index={0} /> : null}
          <FdRow fd="1" label="stdout" target={redirections.out} note="· O_CREAT | O_TRUNC" events={events} index={1} />
          {redirections.append ? (
            <div className="flex items-center justify-between rounded-[var(--r-md)] border border-[var(--line-0)] bg-[var(--bg-1)] px-3.5 py-2.5">
              <span className="flex items-center gap-3 font-mono text-[12.5px] text-[var(--fg-1)]">
                <span className="flex h-7 w-7 items-center justify-center rounded-[var(--r-sm)] border border-[var(--line-1)] bg-[var(--bg-3)] text-[var(--fg-0)]">1</span>
                stdout <span className="hidden text-[10.5px] text-[var(--fg-3)] sm:inline">· O_CREAT | O_APPEND</span>
              </span>
              <div className="flex items-center gap-2">
                <ArrowRight className="h-4 w-4 text-[var(--fg-3)]" />
                <motion.div
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.6, duration: 0.2 }}
                  className="flex items-center gap-2 rounded-[var(--r-sm)] border border-[var(--line-1)] bg-[var(--bg-2)] px-2.5 py-1.5"
                >
                  <span className="font-mono text-[12.5px] text-[var(--amber)]">{redirections.append}</span>
                  <span className="rounded-[var(--r-xs)] bg-[var(--amber-soft)] px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-wide text-[var(--amber)]">
                    APPEND
                  </span>
                </motion.div>
              </div>
            </div>
          ) : null}
        </>
      ) : (
        <div className="flex items-center justify-center rounded-[var(--r-md)] border border-dashed border-[var(--line-1)] py-6 text-[12.5px] text-[var(--fg-3)]">
          No redirections were requested — all descriptors were inherited.
        </div>
      )}
    </div>
  );
}
