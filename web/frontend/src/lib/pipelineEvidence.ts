/**
 * Pipeline and stage evidence, derived from the canonical event stream.
 *
 * WHY THIS EXISTS
 * ---------------
 * The gateway already persists a complete, validated event record for a
 * pipeline execution. The 3D view, the flight recorder, and the replay view all
 * have to reconstruct "what happened to stage 2" from it. Doing that
 * reconstruction three times is how three views start disagreeing about the same
 * execution.
 *
 * So it is done once, here, over the canonical events. The live view and the
 * replay view consume the SAME function, which is what makes them incapable of
 * disagreeing: a divergence would have to be a bug in the reducer, not in two
 * separate reconstructions.
 *
 * THE REDUCTION IS LOSSY IN ONE DIRECTION ON PURPOSE
 * --------------------------------------------------
 * A stage that never started -- because an earlier stage failed to launch -- has
 * no PROCESS_STARTED and therefore no duration. It is kept, with a stated
 * lifecycle, rather than dropped. Dropping it would make a three-stage pipeline
 * render as two stages, which is exactly the misrepresentation this product is
 * supposed to avoid.
 */

import type { CanonicalEvent } from "../types/observability";

/** What the record says happened to one stage. */
export type StageLifecycle =
  /** PROCESS_STARTED and a terminal event are both present. */
  | "COMPLETED"
  /** Started, then terminated by a signal. */
  | "SIGNALED"
  /** Started, but no terminal event was recorded. */
  | "INCOMPLETE"
  /** No PROCESS_STARTED: the stage never ran. */
  | "NOT_STARTED";

export interface StageEvidence {
  /** Index in the pipeline, from the engine's own event field. */
  index: number;
  /** The PID the kernel assigned. Null when the stage never ran. */
  pid: number | null;
  /** The process group. Every stage of one pipeline shares it. */
  pgid: number | null;
  /** argv as the engine recorded it. Empty when the stage never ran. */
  argv: string[];
  /**
   * True when the engine bounded the argv before it reached the record.
   *
   * A shortened argv is not the same as a short one: the elements after the cut
   * are unknown, not absent. A reader must be able to tell "this stage really
   * had two arguments" from "this stage had more arguments than the record kept".
   */
  argvTruncated: boolean;
  /** How many elements the engine dropped, when it dropped any. */
  argvElementsDropped: number;
  /** The command label the engine attached. */
  command: string | null;
  /** Monotonic milliseconds from the engine, when it reported one. */
  startedAtMs: number | null;
  endedAtMs: number | null;
  durationMs: number | null;
  /** Exit code. Null for a signalled or unstarted stage, which is not the same as 0. */
  exitCode: number | null;
  /** Terminating signal number, when the stage was killed. */
  signal: number | null;
  /** The kernel's outcome word, verbatim from the engine. */
  outcome: string | null;
  lifecycle: StageLifecycle;
  /** True when the stage's stdin came from the previous stage's stdout. */
  readsFromPipe: boolean;
  /** True when this stage's stdout is piped onward. */
  writesToPipe: boolean;
  /**
   * A sentence explaining the lifecycle.
   *
   * Present for every non-COMPLETED stage, so a reader is never left to infer
   * why a stage has no exit code.
   */
  note: string | null;
}

export interface PipelineEvidence {
  sessionId: string | null;
  /** How many stages the engine declared. Not the number of events. */
  declaredStages: number;
  stages: StageEvidence[];
  /**
   * The identity the gateway recorded for this execution, when the stream
   * carried one. Null is a real answer: most sessions record no identity, and
   * inventing one to fill the field would be worse than leaving it empty.
   */
  identity: string | null;
  /** A sentence about the pipeline as a whole. */
  summary: string;
}

function str(payload: Record<string, unknown>, key: string): string | null {
  const v = payload[key];
  return typeof v === "string" ? v : null;
}

function num(payload: Record<string, unknown>, key: string): number | null {
  const v = payload[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Reduce canonical events to per-stage evidence.
 *
 * `declaredStages` comes from the engine's own `stages` field rather than from
 * how many stages happened to emit events. A pipeline whose third stage never
 * launched still declared three, and the difference is the fact a reader needs.
 */
export function reducePipelineEvidence(events: readonly CanonicalEvent[]): PipelineEvidence {
  const byIndex = new Map<number, StageEvidence>();

  const stageFor = (index: number): StageEvidence => {
    const existing = byIndex.get(index);
    if (existing !== undefined) return existing;
    const created: StageEvidence = {
      index,
      pid: null,
      pgid: null,
      argv: [],
      argvTruncated: false,
      argvElementsDropped: 0,
      command: null,
      startedAtMs: null,
      endedAtMs: null,
      durationMs: null,
      exitCode: null,
      signal: null,
      outcome: null,
      lifecycle: "NOT_STARTED",
      readsFromPipe: false,
      writesToPipe: false,
      note: null,
    };
    byIndex.set(index, created);
    return created;
  };

  let declaredStages = 0;
  let identity: string | null = null;
  /*
   * Record integrity is deliberately NOT reconstructed here.
   *
   * The gateway's invariant layer (I11 lifecycle pairing, I14 stage accounting)
   * judges the record server-side and publishes the verdict on the replay
   * endpoint, which the replay surface already renders. Re-deriving validity in
   * this reducer would be a second implementation of those invariants, and the
   * two would eventually disagree about the same execution -- with the client's
   * answer on screen. A field that is always null, and displayed as
   * "not recorded", would be worse than no field at all.
   */

  for (const e of events) {
    const p = e.payload as Record<string, unknown>;

    const declared = num(p, "stages");
    if (declared !== null && declared > declaredStages) declaredStages = declared;

    const idx = num(p, "stage");
    // Stage-scoped events always carry an index. An absent one is a malformed
    // record, and the invariant layer reports that; here it simply does not
    // contribute a stage rather than inventing one at index 0.
    if (idx === null || idx < 0) continue;

    const stage = stageFor(idx);

    switch (e.type) {
      case "command.parsed": {
        /*
         * Where the engine wired this stage's stdin and stdout.
         *
         * Read from the parse record rather than inferred from the stage index.
         * "Stage 1 of 3 writes to a pipe" is arithmetic, and it is also wrong the
         * moment a stage is added to the end of a pipeline whose earlier stages
         * write to files -- which is exactly what the parse record knows and this
         * reducer cannot.
         *
         * `readsFromPipe` still falls back to `index > 0`, because that fallback
         * only fires when the engine said nothing at all, and a stage with an
         * upstream stage is reading that stage's output either way.
         */
        const stdinSource = str(p, "stdinSource");
        if (stdinSource !== null) stage.readsFromPipe = stdinSource === "pipe" || stage.index > 0;
        else if (stage.index > 0) stage.readsFromPipe = true;
        const stdoutDest = str(p, "stdoutDest");
        if (stdoutDest !== null) stage.writesToPipe = stdoutDest === "pipe";
        else if (declaredStages > 0) stage.writesToPipe = stage.index < declaredStages - 1;
        break;
      }
      case "process.started": {
        stage.pid = typeof e.pid === "number" ? e.pid : stage.pid;
        const pgid = num(p, "pgid");
        if (pgid !== null) stage.pgid = pgid;
        const argv = p["argv"];
        if (Array.isArray(argv)) stage.argv = argv.map((a) => String(a));
        // The engine bounds argv before it reaches the record, and says so.
        // Carrying that through is what stops a reader treating a truncated
        // argv as the complete one.
        stage.argvTruncated = p["argv_truncated"] === true;
        stage.argvElementsDropped =
          typeof p["argv_elements_dropped"] === "number" ? (p["argv_elements_dropped"] as number) : 0;
        stage.command = str(p, "label") ?? stage.command;
        stage.startedAtMs = e.monotonicMs;
        stage.lifecycle = "INCOMPLETE";
        stage.note = "Started; no exit has been recorded yet.";
        break;
      }
      case "process.exited": {
        stage.pid = typeof e.pid === "number" ? e.pid : stage.pid;
        const pgid = num(p, "pgid");
        if (pgid !== null) stage.pgid = pgid;
        stage.endedAtMs = e.monotonicMs;
        stage.durationMs = num(p, "durationMs");
        stage.exitCode = num(p, "exitCode");
        stage.outcome = str(p, "outcome");
        const signal = num(p, "signal");
        stage.signal = signal;
        if (signal !== null && signal > 0) {
          stage.lifecycle = "SIGNALED";
          stage.note = `Terminated by signal ${signal}.`;
        } else {
          stage.lifecycle = "COMPLETED";
          stage.note = `Exited with code ${stage.exitCode}.`;
        }
        break;
      }
      case "signal.received": {
        stage.signal = num(p, "signal") ?? stage.signal;
        stage.outcome = str(p, "outcome") ?? stage.outcome;
        stage.lifecycle = "SIGNALED";
        stage.note = `Received signal ${stage.signal}.`;
        break;
      }
      case "process.exec_error":
      case "process.wait_failed": {
        stage.outcome = str(p, "outcome") ?? str(p, "reason");
        stage.lifecycle = "SIGNALED";
        stage.note =
          str(p, "reason") ?? `The stage failed with ${str(p, "errnoName") ?? "an unreported error"}.`;
        break;
      }
      default:
        break;
    }
  }

  // A stage the engine declared but which never announced itself.
  for (let i = 0; i < declaredStages; i += 1) {
    const stage = byIndex.get(i);
    if (stage === undefined) {
      const created = stageFor(i);
      created.note = "The engine declared this stage but it never started.";
    }
  }

  const stages = [...byIndex.values()].sort((a, b) => a.index - b.index);

  return {
    sessionId: events[0]?.sessionId ?? null,
    declaredStages,
    stages,
    identity,
    summary: summarisePipeline(stages, declaredStages),
  };
}

/** How many stages produced actual evidence, as opposed to being declared only. */
export function countStagesWithEvidence(stages: readonly StageEvidence[]): number {
  return stages.filter((s) => s.pid !== null || s.argv.length > 0 || s.lifecycle !== "NOT_STARTED").length;
}

/** A one-line description of the pipeline, built from the stage outcomes. */
export function summarisePipeline(stages: readonly StageEvidence[], declaredStages: number): string {
  if (stages.length === 0) return "No stage outcome was recorded.";

  const completed = stages.filter((s) => s.lifecycle === "COMPLETED").length;
  const signalled = stages.filter((s) => s.lifecycle === "SIGNALED").length;
  const notStarted = stages.filter((s) => s.lifecycle === "NOT_STARTED").length;
  const incomplete = stages.filter((s) => s.lifecycle === "INCOMPLETE").length;

  const parts: string[] = [];
  if (completed > 0) parts.push(`${completed} completed`);
  if (signalled > 0) parts.push(`${signalled} terminated by a signal`);
  if (notStarted > 0) parts.push(`${notStarted} never started`);
  if (incomplete > 0) parts.push(`${incomplete} started but never finished`);

  const head = parts.length === 0 ? "No stage outcome was recorded" : parts.join(", ");

  /*
   * The declared count is compared with the stages that produced EVIDENCE, not
   * with the length of the stage list. The list always contains every declared
   * index -- that is what keeps an unstarted stage visible -- so comparing
   * against its length would compare a number with itself and never fire.
   */
  const withEvidence = countStagesWithEvidence(stages);
  if (declaredStages > 0 && withEvidence < declaredStages) {
    return `${head}. The engine declared ${declaredStages} stage(s); ${withEvidence} produced process evidence.`;
  }
  return `${head}.`;
}

/**
 * True when every stage shares one process group.
 *
 * This is the property that makes a timeout or a signal reach the whole pipeline
 * instead of orphaning an early stage, so it is worth stating rather than
 * assuming.
 */
export function sharesOneProcessGroup(stages: readonly StageEvidence[]): boolean {
  const groups = new Set(stages.map((s) => s.pgid).filter((g): g is number => g !== null));
  return groups.size <= 1;
}

/** The pipeline's exit status: the last stage's, matching shell convention. */
export function pipelineExitStatus(stages: readonly StageEvidence[]): { code: number | null; signal: number | null } {
  if (stages.length === 0) return { code: null, signal: null };
  const last = stages[stages.length - 1]!;
  return { code: last.exitCode, signal: last.signal };
}
