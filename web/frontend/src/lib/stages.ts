import type { CanonicalEventType, SessionStatus } from "../types/observability";

export type StageId = "input" | "parse" | "argv" | "fork" | "exec" | "run" | "wait" | "result";

export type StageState = "done" | "derived" | "current" | "pending" | "error" | "skipped" | "unavailable";

export interface StageDef {
  id: StageId;
  label: string;
  hint: string;
}

export const PIPELINE_STAGES: StageDef[] = [
  { id: "input", label: "INPUT", hint: "The gateway accepted the structured execution request." },
  { id: "parse", label: "PARSE", hint: "Unavailable in web execution: the gateway receives argv as an array, not a command string." },
  { id: "argv", label: "ARGV", hint: "The accepted command and arguments are passed as a structured argv vector." },
  { id: "fork", label: "FORK", hint: "fork() created a child process that will run the program." },
  { id: "exec", label: "EXEC", hint: "execvp() replaced the child's image with the target program (same PID)." },
  { id: "run", label: "RUN", hint: "The program runs to completion; the parent is blocked in waitpid()." },
  { id: "wait", label: "WAIT", hint: "The parent waits for this specific child and reaps its termination status." },
  { id: "result", label: "RESULT", hint: "The exit status (or terminating signal) is reported and recorded." },
];

const COMPLETES_ON: Record<StageId, CanonicalEventType[]> = {
  input: ["command.received"],
  parse: [],
  argv: ["command.parsed"],
  fork: ["process.started"],
  exec: [],
  run: [],
  wait: ["process.exited"],
  result: ["process.exited", "session.summary", "execution.completed", "execution.failed", "execution.timeout"],
};

const ERRORS_ON: Record<StageId, CanonicalEventType[]> = {
  input: [],
  parse: ["command.parse_error"],
  argv: [],
  fork: ["redirection.failed"],
  exec: ["process.exec_error"],
  run: [],
  wait: [],
  result: ["process.exec_error", "execution.failed"],
};

const TERMINAL = new Set<SessionStatus>(["COMPLETED", "FAILED", "TIMED_OUT", "CANCELLED"]);

export function isTerminalStatus(s: SessionStatus): boolean {
  return TERMINAL.has(s);
}

export function stageStates(events: Array<{ type: CanonicalEventType }>, status: SessionStatus): Record<StageId, StageState> {
  const types = new Set(events.map((e) => e.type));
  const exited = events.some((e) => e.type === "process.exited");
  const signalled = events.some((e) => e.type === "signal.received");
  const started = events.some((e) => e.type === "process.started");
  const out = {} as Record<StageId, StageState>;
  const terminal = TERMINAL.has(status);

  for (const stage of PIPELINE_STAGES) {
    const errored = ERRORS_ON[stage.id].some((t) => types.has(t));
    const done = COMPLETES_ON[stage.id].some((t) => types.has(t));

    // The monitor reports fork and reap, but has no successful-exec event.
    // A normal exit supports this inference; a signal could have ended the
    // child before execvp() completed.
    if (stage.id === "exec" && exited && !signalled) {
      out[stage.id] = "derived";
      continue;
    }

    if (errored) out[stage.id] = "error";
    else if (done) out[stage.id] = "done";
    else if (stage.id === "parse") out[stage.id] = "unavailable";
    else if (stage.id === "exec") out[stage.id] = "unavailable";
    else if (stage.id === "run" && exited) out[stage.id] = "done";
    else if ((stage.id === "run" || stage.id === "wait") && status === "RUNNING" && started) out[stage.id] = "derived";
    else if (terminal) out[stage.id] = "skipped";
    else out[stage.id] = "pending";
  }

  if (!terminal && events.length === 0 && (status === "CREATED" || status === "STARTING")) {
    out.input = "current";
  }
  return out;
}

export function stageForEvent(t: CanonicalEventType): StageId | null {
  switch (t) {
    case "command.received":
      return "input";
    case "command.parse_error":
      return "parse";
    case "command.parsed":
      return "argv";
    case "redirection.failed":
      return "fork";
    case "process.started":
      return "fork";
    case "process.snapshot":
      return "run";
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
  "process.snapshot": "PROCFS SNAPSHOT",
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
