import type { CanonicalEventType, SessionStatus } from "../types/observability";

export type StageId = "input" | "parse" | "fork" | "exec" | "run" | "wait" | "result";

export type StageState = "done" | "current" | "pending" | "error" | "skipped";

export interface StageDef {
  id: StageId;
  label: string;
  hint: string;
}

export const PIPELINE_STAGES: StageDef[] = [
  { id: "input", label: "INPUT", hint: "CAPS received the command line as (argc, argv)." },
  { id: "parse", label: "PARSE", hint: "The command and its arguments were parsed into a token vector." },
  { id: "fork", label: "FORK", hint: "fork() created a child process that will run the program." },
  { id: "exec", label: "EXEC", hint: "execvp() replaced the child's image with the target program (same PID)." },
  { id: "run", label: "RUN", hint: "The program runs to completion; the parent is blocked in waitpid()." },
  { id: "wait", label: "WAIT", hint: "The parent waits for this specific child and reaps its termination status." },
  { id: "result", label: "RESULT", hint: "The exit status (or terminating signal) is reported and recorded." },
];

const COMPLETES_ON: Record<StageId, CanonicalEventType[]> = {
  input: ["command.received"],
  parse: ["command.parsed"],
  fork: ["process.started"],
  exec: ["process.started"],
  run: ["process.exited"],
  wait: ["session.summary"],
  result: ["session.summary"],
};

const ERRORS_ON: Record<StageId, CanonicalEventType[]> = {
  input: [],
  parse: ["command.parse_error"],
  fork: ["redirection.failed"],
  exec: ["process.exec_error"],
  run: [],
  wait: ["signal.received"],
  result: ["process.exec_error", "execution.failed"],
};

const TERMINAL = new Set<SessionStatus>(["COMPLETED", "FAILED", "TIMED_OUT", "CANCELLED"]);

export function isTerminalStatus(s: SessionStatus): boolean {
  return TERMINAL.has(s);
}

export function stageStates(events: Array<{ type: CanonicalEventType }>, status: SessionStatus): Record<StageId, StageState> {
  const types = new Set(events.map((e) => e.type));
  const out = {} as Record<StageId, StageState>;
  const terminal = TERMINAL.has(status);

  for (const stage of PIPELINE_STAGES) {
    const errored = ERRORS_ON[stage.id].some((t) => types.has(t));
    const done = COMPLETES_ON[stage.id].some((t) => types.has(t));

    if (errored) out[stage.id] = "error";
    else if (done) out[stage.id] = "done";
    else if (terminal) out[stage.id] = "skipped";
    else out[stage.id] = "pending";
  }

  if (!terminal) {
    // The "current" stage is the first one that has not yet completed.
    for (const stage of PIPELINE_STAGES) {
      if (out[stage.id] === "pending") {
        out[stage.id] = "current";
        break;
      }
    }
  }
  return out;
}

export function stageForEvent(t: CanonicalEventType): StageId | null {
  switch (t) {
    case "command.received":
      return "input";
    case "command.parsed":
      return "parse";
    case "command.parse_error":
      return "parse";
    case "redirection.failed":
      return "fork";
    case "process.started":
      return "fork";
    case "process.exec_error":
      return "exec";
    case "process.exited":
      return "run";
    case "session.summary":
      return "result";
    case "signal.received":
      return "wait";
    default:
      return null;
  }
}

export const EVENT_LABELS: Record<CanonicalEventType, string> = {
  "execution.created": "EXECUTION CREATED",
  "execution.started": "EXECUTION STARTED",
  "execution.completed": "EXECUTION COMPLETED",
  "execution.failed": "EXECUTION FAILED",
  "execution.timeout": "EXECUTION TIMED OUT",
  "command.received": "COMMAND RECEIVED",
  "command.parsed": "PARSED",
  "command.parse_error": "PARSE ERROR",
  "redirection.opened": "REDIRECTION OPENED",
  "redirection.failed": "REDIRECTION FAILED",
  "process.started": "PROCESS STARTED",
  "process.exited": "PROCESS EXITED",
  "process.exec_error": "EXEC ERROR",
  "signal.received": "SIGNAL RECEIVED",
  "session.summary": "SESSION SUMMARY",
};

export const STATUS_META: Record<SessionStatus, { label: string; tone: "neutral" | "active" | "success" | "danger" | "warn" }> = {
  CREATED: { label: "Created", tone: "neutral" },
  STARTING: { label: "Starting", tone: "active" },
  RUNNING: { label: "Running", tone: "active" },
  COMPLETED: { label: "Completed", tone: "success" },
  FAILED: { label: "Failed", tone: "danger" },
  TIMED_OUT: { label: "Timed out", tone: "warn" },
  CANCELLED: { label: "Cancelled", tone: "danger" },
};
