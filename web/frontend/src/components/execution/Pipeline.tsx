import { clsx } from "clsx";
import { Check, CircleDot, FileInput, GitFork, Hammer, RadioTower, Route, X } from "lucide-react";
import type { ReactNode } from "react";

import { PIPELINE_STAGES, stageStates, type StageId } from "../../lib/stages";
import type { CanonicalEvent, SessionStatus } from "../../types/observability";
import { Tooltip } from "../misc/Tooltip";

const stageIcons: Record<StageId, ReactNode> = {
  input: <FileInput className="h-4 w-4" />,
  parse: <FileInput className="h-4 w-4" />,
  argv: <FileInput className="h-4 w-4" />,
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
    case "derived":
      return "border-[color:var(--blue)] bg-[var(--bg-3)] text-[color:var(--blue)]";
    case "error":
      return "border-[color:var(--red-soft)] bg-[color:var(--red-soft)] text-[color:var(--red)]";
    case "unavailable":
      return "border-dashed border-[var(--line-1)] bg-[var(--bg-1)] text-[var(--fg-3)]";
    default:
      return "border-[var(--line-0)] bg-[var(--bg-2)] text-[var(--fg-3)]";
  }
}

export function Pipeline({ events, status }: { events: CanonicalEvent[]; status: SessionStatus }) {
  const states = stageStates(events, status);

  return (
    <div className="flex flex-col gap-2">
      {/* State changes only when the corresponding event or session state arrives. */}
      <div className="hidden items-center gap-1 overflow-x-auto py-2 md:flex">
        {PIPELINE_STAGES.map((stage, i) => {
          const state = states[stage.id];
          const nextState = i < PIPELINE_STAGES.length - 1 ? states[PIPELINE_STAGES[i + 1]!.id] : null;
          const connectorLit = nextState === "done" || nextState === "derived" || nextState === "current";
          return (
            <div key={stage.id} className="flex items-center">
              <div className="flex shrink-0 flex-col items-center gap-1.5">
                <Tooltip title={`${stage.label} — ${stage.hint}`}>
                  <div className={clsx("flex h-11 min-w-[3.25rem] items-center justify-center rounded-[var(--r-md)] border px-2.5", nodeClass(state))}>
                    {state === "done" || state === "derived" ? <Check className="h-4 w-4" /> : state === "current" ? <CircleDot className="h-4 w-4" /> : state === "error" ? <X className="h-4 w-4" /> : stageIcons[stage.id]}
                  </div>
                </Tooltip>
                <span
                  className={clsx(
                    "text-[10.5px] font-semibold tracking-wide",
                    state === "current" ? "text-[var(--accent)]" : state === "done" ? "text-[var(--green)]" : state === "derived" ? "text-[var(--blue)]" : state === "error" ? "text-[var(--red)]" : "text-[var(--fg-3)]",
                  )}
                >
                  {stage.label}{state === "derived" ? " · INFERRED" : state === "unavailable" ? " · UNAVAILABLE" : ""}
                </span>
              </div>
              {i < PIPELINE_STAGES.length - 1 ? (
                <div className={clsx("mx-1.5 h-0.5 w-7 rounded", connectorLit ? "bg-[var(--line-2)]" : "bg-[var(--line-0)]")} />
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
                  {state === "done" || state === "derived" ? <Check className="h-3.5 w-3.5" /> : state === "current" ? <CircleDot className="h-3.5 w-3.5" /> : state === "error" ? <X className="h-3.5 w-3.5" /> : stageIcons[stage.id]}
                </div>
                {i < PIPELINE_STAGES.length - 1 ? <div className={clsx("w-0.5 flex-1", state === "done" ? "bg-[var(--green)]" : "bg-[var(--line-0)]")} /> : null}
              </div>
              <div className="flex flex-1 items-center gap-2 pb-4">
                <span className={clsx("text-[12.5px] font-semibold", state === "current" ? "text-[var(--accent)]" : state === "done" ? "text-[var(--fg-1)]" : "text-[var(--fg-3)]")}>
                  {stage.label}{state === "derived" ? " · inferred" : state === "unavailable" ? " · unavailable" : ""}
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
