import { clsx } from "clsx";
import { motion } from "motion/react";
import { Check, FileInput, GitFork, Hammer, LoaderCircle, RadioTower, Route, X } from "lucide-react";
import type { ReactNode } from "react";

import { PIPELINE_STAGES, stageStates, type StageId } from "../../lib/stages";
import type { CanonicalEvent, SessionStatus } from "../../types/observability";
import { Tooltip } from "../misc/Tooltip";

const stageIcons: Record<StageId, ReactNode> = {
  input: <FileInput className="h-4 w-4" />,
  parse: <FileInput className="h-4 w-4" />,
  fork: <GitFork className="h-4 w-4" />,
  exec: <Hammer className="h-4 w-4" />,
  run: <RadioTower className="h-4 w-4" />,
  wait: <RadioTower className="h-4 w-4" />,
  result: <Route className="h-4 w-4" />,
};

function nodeClass(state: string): string {
  switch (state) {
    case "done":
      return "border-[color:var(--green-soft)] bg-[color:var(--green-soft)] text-[color:var(--green)]";
    case "current":
      return "border-[color:var(--accent-soft)] bg-[var(--bg-3)] text-[color:var(--accent)]";
    case "error":
      return "border-[color:var(--red-soft)] bg-[color:var(--red-soft)] text-[color:var(--red)]";
    default:
      return "border-[var(--line-0)] bg-[var(--bg-2)] text-[var(--fg-3)]";
  }
}

export function Pipeline({ events, status }: { events: CanonicalEvent[]; status: SessionStatus }) {
  const states = stageStates(events, status);

  return (
    <div className="flex flex-col gap-2">
      {/* desktop: horizontal pipeline with animated connectors */}
      <div className="hidden items-center gap-1 overflow-x-auto py-2 md:flex">
        {PIPELINE_STAGES.map((stage, i) => {
          const state = states[stage.id];
          const nextState = i < PIPELINE_STAGES.length - 1 ? states[PIPELINE_STAGES[i + 1]!.id] : null;
          const connectorLit = nextState === "done" || nextState === "current";
          return (
            <div key={stage.id} className="flex items-center">
              <div className="flex shrink-0 flex-col items-center gap-1.5">
                <Tooltip title={`${stage.label} — ${stage.hint}`}>
                  <motion.div
                    layout
                    initial={false}
                    animate={state === "current" ? { scale: [1, 1.1, 1] } : { scale: 1 }}
                    transition={state === "current" ? { duration: 1.3, repeat: Infinity, ease: "easeInOut" } : { duration: 0.2 }}
                    className={clsx("flex h-11 min-w-[3.25rem] items-center justify-center rounded-[var(--r-md)] border px-2.5", nodeClass(state))}
                  >
                    {state === "current" ? <LoaderCircle className="h-4 w-4 animate-spin" /> : state === "done" ? <Check className="h-4 w-4" /> : state === "error" ? <X className="h-4 w-4" /> : stageIcons[stage.id]}
                  </motion.div>
                </Tooltip>
                <span
                  className={clsx(
                    "text-[10.5px] font-semibold tracking-wide",
                    state === "current" ? "text-[var(--accent)]" : state === "done" ? "text-[var(--green)]" : state === "error" ? "text-[var(--red)]" : "text-[var(--fg-3)]",
                  )}
                >
                  {stage.label}
                </span>
              </div>
              {i < PIPELINE_STAGES.length - 1 ? (
                <div className={clsx("relative mx-1.5 h-0.5 w-7 overflow-hidden rounded", connectorLit ? "bg-[color:var(--line-2)]" : "bg-[var(--line-0)]")}>
                  {connectorLit ? (
                    <motion.div
                      className="absolute inset-0 bg-[var(--accent)]"
                      key={`sig-${i}`}
                      initial={{ x: -34, opacity: 0 }}
                      animate={{ x: 34, opacity: [0, 1, 1, 0] }}
                      transition={{ duration: 0.55, ease: "easeOut" }}
                    />
                  ) : null}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      {/* mobile / narrow: vertical timeline */}
      <div className="flex flex-col gap-0 py-1 md:hidden">
        {PIPELINE_STAGES.map((stage, i) => {
          const state = states[stage.id];
          return (
            <div key={stage.id} className="flex gap-3">
              <div className="flex flex-col items-center">
                <div className={clsx("flex h-7 w-7 shrink-0 items-center justify-center rounded-full border", nodeClass(state))}>
                  {state === "done" ? <Check className="h-3.5 w-3.5" /> : state === "current" ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : state === "error" ? <X className="h-3.5 w-3.5" /> : stageIcons[stage.id]}
                </div>
                {i < PIPELINE_STAGES.length - 1 ? <div className={clsx("w-0.5 flex-1", state === "done" ? "bg-[var(--green)]" : "bg-[var(--line-0)]")} /> : null}
              </div>
              <div className="flex flex-1 items-center gap-2 pb-4">
                <span className={clsx("text-[12.5px] font-semibold", state === "current" ? "text-[var(--accent)]" : state === "done" ? "text-[var(--fg-1)]" : "text-[var(--fg-3)]")}>
                  {stage.label}
                </span>
                <span className="truncate text-[11px] text-[var(--fg-3)]">{stage.hint}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
