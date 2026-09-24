import { AnimatePresence, motion } from "motion/react";
import { ArrowDown, Check, LoaderCircle, TerminalSquare, X } from "lucide-react";
import { clsx } from "clsx";

import { fmtDuration } from "../../lib/format";
import type { CanonicalEvent } from "../../types/observability";
import { Tooltip } from "../misc/Tooltip";

interface ProcessNodeProps {
  label: string;
  pid?: number;
  tone: "violet" | "cyan" | "accent" | "muted";
  icon: React.ReactNode;
  active: boolean;
  exited: boolean;
  durationMs?: number;
  caption?: string;
}

const TONES = {
  violet: { ring: "border-[var(--violet-soft)] text-[var(--violet)]", label: "text-[var(--violet)]" },
  cyan: { ring: "border-[var(--cyan-soft)] text-[var(--cyan)]", label: "text-[var(--cyan)]" },
  accent: { ring: "border-[var(--accent-soft)] text-[var(--accent)]", label: "text-[var(--accent)]" },
  muted: { ring: "border-[var(--line-1)] text-[var(--fg-3)]", label: "text-[var(--fg-3)]" },
} as const;

function ProcessNode({ label, pid, tone, icon, active, exited, durationMs, caption }: ProcessNodeProps) {
  const t = TONES[tone];
  return (
    <Tooltip
      title={
        pid !== undefined
          ? `${label} — PID ${pid}${exited ? " (reaped)" : ""}${durationMs !== undefined && durationMs !== null ? ` · ran ${fmtDuration(durationMs)}` : ""}`
          : caption ?? label
      }
    >
      <div className="flex flex-col items-center gap-1">
        <motion.div
          animate={active ? { scale: [1, 1.07, 1] } : { scale: 1 }}
          transition={active ? { duration: 1.2, repeat: Infinity, ease: "easeInOut" } : { duration: 0.2 }}
          className={clsx(
            "flex h-12 w-12 items-center justify-center rounded-[var(--r-md)] border",
            t.ring,
            exited ? "opacity-60 grayscale" : active ? "bg-[var(--bg-3)]" : "bg-[var(--bg-2)]",
          )}
        >
          {active ? <LoaderCircle className="h-[1.15rem] w-[1.15rem] animate-spin" /> : exited ? <Check className="h-[1.15rem] w-[1.15rem]" /> : icon}
        </motion.div>
        <span className={clsx("font-mono text-[10.5px] font-semibold", t.label)}>
          {label}
          {pid !== undefined ? <span className="text-[var(--fg-3)]"> · {pid}</span> : null}
        </span>
        {caption ? <span className="mt-[-0.4rem] text-[9.5px] text-[var(--fg-3)]">{caption}</span> : null}
      </div>
    </Tooltip>
  );
}

function Edge({ lit, exited, label }: { lit: boolean; exited: boolean; label: string }) {
  return (
    <div className="flex min-w-[4.5rem] flex-1 flex-col items-center gap-1 px-1">
      <div className="relative flex w-full items-center">
        <div className={clsx("h-px w-full", exited ? "bg-[var(--line-1)]" : lit ? "bg-[var(--accent)]" : "bg-[var(--line-0)]")} />
        <AnimatePresence>
          {lit && !exited ? (
            <motion.div
              className="absolute h-1.5 w-1.5 rounded-full bg-[var(--accent)]"
              initial={{ left: "0%", opacity: 0 }}
              animate={{ left: "100%", opacity: [0, 1, 1, 0] }}
              transition={{ duration: 0.9, repeat: Infinity, ease: "linear" }}
            />
          ) : null}
        </AnimatePresence>
      </div>
      <span className="whitespace-nowrap text-[10px] text-[var(--fg-3)]">{label}</span>
    </div>
  );
}

/**
 * Fork → exec → run → reap. Facts come from real events: pid + label from
 * process.started, exit status from process.exited, exec error from
 * process.exec_error. execvp semantics (same PID, image replaced) are drawn
 * as nomenclature, never fabricated telemetry.
 */
export function ProcessGraph({ events }: { events: CanonicalEvent[] }) {
  const started = events.find((e) => e.type === "process.started");
  const exited = events.find((e) => e.type === "process.exited");
  const execError = events.find((e) => e.type === "process.exec_error");

  const pid = typeof started?.payload?.pid === "number" ? started.payload.pid : undefined;
  const label = typeof started?.payload?.label === "string" ? (started.payload.label as string) : "program";
  const exitCode = typeof exited?.payload?.exitCode === "number" ? exited.payload.exitCode : undefined;
  const durationMs = typeof exited?.payload?.durationMs === "number" ? exited.payload.durationMs : undefined;

  const reaped = Boolean(exited) || Boolean(execError);
  const isRunning = Boolean(started) && !reaped;
  const success = reaped && !execError;

  return (
    <div className="flex flex-col gap-1.5 py-1">
      <div className="overflow-x-auto">
        <div className="flex min-w-[600px] items-center">
          <ProcessNode label="CAPS" tone="violet" icon={<TerminalSquare className="h-[1.15rem] w-[1.15rem]" />} active={false} exited={false} caption="monitor parent" />
          <Edge lit={Boolean(started)} exited={reaped} label="fork()" />
          <ProcessNode
            label="child"
            pid={pid}
            tone="cyan"
            icon={<ArrowDown className="h-[1.15rem] w-[1.15rem]" />}
            active={false}
            exited={reaped}
            caption={started ? "duplicated image" : undefined}
          />
          <Edge lit={Boolean(started)} exited={reaped} label="execvp" />
          <ProcessNode label={label.length > 10 ? `${label.slice(0, 10)}…` : label} pid={pid} tone="accent" icon={<TerminalSquare className="h-[1.15rem] w-[1.15rem]" />} active={isRunning} exited={reaped} durationMs={durationMs} caption={reaped ? (execError ? "exec failed" : `exit ${exitCode ?? 0}`) : "running"} />
          <Edge lit={reaped} exited={reaped} label="reap" />
          <ProcessNode label="wait" tone="muted" icon={success ? <Check className="h-[1.15rem] w-[1.15rem]" /> : <X className="h-[1.15rem] w-[1.15rem]" />} active={false} exited={reaped} caption="waitpid()" />
        </div>
      </div>
    </div>
  );
}
