/**
 * The faculty demo presets.
 *
 * WHY THESE ARE DATA AND NOT A UI COMPONENT
 * -----------------------------------------
 * Every field here is a claim about what CAPS will actually observe, and a claim
 * is testable. The command and argv are checked against the real catalog
 * (see `presetValidation.test.ts`), so a preset cannot drift into naming a
 * command that does not exist or an argument outside its declared bounds. The
 * prose fields are the part a faculty member reads, and they are written to be
 * read on a projector: one line per fact, no hedging, and every "unavailable"
 * entry carries the reason it is unavailable.
 *
 * WHY EVERY PRESET CARRIES ITS OWN "MAY BE UNAVAILABLE" LIST
 * ---------------------------------------------------------
 * Because a demo preset that lists only what will move teaches the wrong lesson
 * even when every number it shows is true. The most interesting thing this
 * product reports is that a sub-sample-interval run records NO procfs sample at
 * all -- and a preset row that only says "RSS will rise" would let a presenter
 * point at an empty chart and call it a broken demo, when it is in fact the
 * single-sample rule (the first sample reports every rate as UNAVAILABLE) doing
 * exactly what it is designed to do.
 *
 * VERIFICATION
 * ------------
 * Commands, argument shapes and bounds were read from the backend catalog:
 *   - `web/backend/src/catalog/commands.ts` for the system commands;
 *   - `web/backend/src/execution/workloadCatalog.ts` for the bounded workloads;
 *   - `web/backend/src/api/routes.ts` for the workload timeout floor, which is
 *     budget + 2000ms and is enforced with a 400, so a preset that got it wrong
 *     would be refused rather than silently truncated.
 *   - `tests/helpers/status_probe.c` for the first-party status probe.
 */

import type { RedirectionSpec } from "../types/observability";

/** One metric the preset expects to move, and in which direction. */
export interface ExpectedMovement {
  readonly metric: string;
  /** A direction in words, not a number: the magnitude is the host's business. */
  readonly direction: string;
}

export interface PresetUnavailable {
  readonly metric: string;
  /** Why it may be absent. Never left empty, because an unexplained blank is the failure this product is about. */
  readonly why: string;
}

export interface FacultyPreset {
  readonly id: string;
  readonly label: string;
  /** The exact program name CAPS will exec. Must be a catalog name. */
  readonly command: string;
  /** The exact argument vector, argv[1…argc-1]. Must satisfy the catalog schema. */
  readonly args: readonly string[];
  /**
   * Engine timeout for this run, in ms. Required, not optional.
   *
   * Every preset states its own ceiling rather than inheriting
   * `CAPS_DEFAULT_TIMEOUT_MS`. That default is a server-side environment value
   * that an operator may have set to anything, so a preset that leaned on it
   * would be bounded by a number the frontend cannot see — and the page's whole
   * claim is that its bounds are stated, not assumed. For a command that returns
   * immediately the ceiling is a backstop that should never be reached, and it is
   * still worth writing down: it is what makes "this cannot hang the demo" a
   * property of the request rather than a promise in prose.
   */
  readonly timeoutMs: number;
  /** Redirections, always explicit: a preset with an implicit redirection set is not reproducible. */
  readonly redirections: RedirectionSpec;
  /** One line, presenter's words. */
  readonly blurb: string;
  /** Canonical event types this run should produce. Names come from `lib/stages.ts`. */
  readonly observes: readonly string[];
  readonly moves: readonly ExpectedMovement[];
  readonly unavailable: readonly PresetUnavailable[];
  /** Why the run is bounded. Every preset must terminate on its own or on a timer that fires. */
  readonly bounded: string;
  /** What the recorded outcome will be, stated so nobody has to guess COMPLETED vs FAILED. */
  readonly outcome: string;
}

/**
 * How long a preset's own workload runs.
 *
 * Eight seconds is chosen against two real numbers rather than by taste:
 * the telemetry sampler ticks every 500ms (`TELEMETRY_SAMPLE_INTERVAL_MS`), so
 * eight seconds buys roughly sixteen samples -- enough for every DERIVED rate to
 * exist -- while a faculty session does not spend a minute watching a chart.
 */
const BUDGET_S = 8;

/**
 * The engine timeout for a workload preset.
 *
 * The gateway refuses a shorter one: `POST /api/sessions` computes
 * `budgetS * 1000 + 2000` from argv[1] and returns 400 TIMEOUT_TOO_SHORT
 * otherwise, because a transport timeout shorter than the workload's own budget
 * would cut the sample series off before the workload ended on its own. The
 * margin is the 2000ms of cleanup the backend already budgets for; matching it
 * exactly is deliberate, because a smaller number here is a request the gateway
 * will refuse.
 */
function workloadTimeout(budgetS: number): number {
  return budgetS * 1000 + 2000;
}

export const FACULTY_PRESETS: readonly FacultyPreset[] = [
  {
    id: "hello",
    label: "HELLO",
    command: "echo",
    args: ["Hello", "from", "CAPS"],
    // The catalog's own ceiling for `echo` is 10s. Nothing should come near it;
    // it is stated so the run is bounded by the request rather than by whatever
    // `CAPS_DEFAULT_TIMEOUT_MS` happens to be on the machine.
    timeoutMs: 10_000,
    redirections: {},
    blurb: "The smallest proof that argv reached a real exec'd process.",
    observes: ["command.received", "command.parsed", "process.started", "process.exited", "session.summary", "execution.completed"],
    moves: [
      { metric: "stdout", direction: "exactly `Hello from CAPS` plus one newline" },
      { metric: "exitCode", direction: "0" },
    ],
    unavailable: [
      {
        metric: "every procfs metric (RSS, CPU, I/O, faults)",
        why: "`echo` exits in well under one 500ms sample interval, so the run most likely records NO process.snapshot at all. That is the sampler being honest about a process it never got to see, not a missing feature.",
      },
      {
        metric: "every DERIVED rate",
        why: "A rate needs two samples. With zero or one snapshot there is no delta to difference, and the backend reports UNAVAILABLE rather than 0.",
      },
    ],
    bounded: "Exits immediately on its own; no timeout is involved.",
    outcome: "COMPLETED, exit code 0.",
  },
  {
    id: "cpu",
    label: "CPU",
    command: "caps_cpu_burn",
    args: [String(BUDGET_S)],
    timeoutMs: workloadTimeout(BUDGET_S),
    redirections: {},
    blurb: "Sustained arithmetic on one core, so utime/stime accumulate in /proc/<pid>/stat.",
    observes: ["command.received", "process.started", "process.snapshot", "process.exited", "session.summary", "execution.completed"],
    moves: [
      { metric: "cpuUserMs / cpuSystemMs", direction: "rising steadily for the whole run" },
      { metric: "cpuPercent (DERIVED)", direction: "near 100% of one logical core" },
      { metric: "elapsedMs", direction: "climbing to the budget" },
    ],
    unavailable: [
      {
        metric: "cpuPercent on the FIRST snapshot",
        why: "The first sample reports every rate as UNAVAILABLE by design — a percentage with no previous sample to divide by would be a guess.",
      },
      {
        metric: "rcharBytes / wcharBytes (I/O)",
        why: "The workload performs no file I/O, so these stay at whatever the process did at exec time. A flat line here is the observation.",
      },
      {
        metric: "majorFaults",
        why: "Expect 0 unless the host is under memory pressure. A zero is a real reading here, and is shown as 0 rather than as UNAVAILABLE.",
      },
    ],
    bounded: `The process stops itself at ${BUDGET_S}s; the transport timeout is budget + 2000ms so the sample series survives to the end.`,
    outcome: "COMPLETED, exit code 0.",
  },
  {
    id: "memory",
    label: "MEMORY",
    command: "caps_memory_burn",
    args: [String(BUDGET_S), "64"],
    timeoutMs: workloadTimeout(BUDGET_S),
    redirections: {},
    blurb: "Every page of a 64 MiB anonymous mapping is touched once, so VmRSS actually moves.",
    observes: ["command.received", "process.started", "process.snapshot", "process.exited", "session.summary", "execution.completed"],
    moves: [
      { metric: "rssBytes", direction: "climbing quickly towards 64 MiB at start, then flat" },
      { metric: "virtualMemoryBytes", direction: "rising with the mapping" },
      { metric: "minorFaults", direction: "a step up as pages are faulted in" },
    ],
    unavailable: [
      {
        metric: "cpuPercent",
        why: "The steady-state pass sleeps 50ms between page touches, so CPU is genuinely low. Low is a measurement; UNAVAILABLE is a different thing and this row does not claim it.",
      },
      {
        metric: "readBytes / writeBytes (block-layer I/O)",
        why: "An anonymous mapping is not a file, so the block-layer counters stay flat while the CHARACTER counters would move. Confusing the two is the classic misreading this catalog entry exists to prevent.",
      },
      {
        metric: "majorFaults",
        why: "Expect 0: no page needs to be fetched from disk unless the host swaps. The distinction between a minor and a major fault is exactly what makes this pair interesting.",
      },
    ],
    bounded: `Stops itself at ${BUDGET_S}s and unmaps its region before exiting, so the memory is genuinely released, not merely forgotten.`,
    outcome: "COMPLETED, exit code 0.",
  },
  {
    id: "io",
    label: "I/O",
    command: "caps_io_burn",
    args: [String(BUDGET_S), "8"],
    timeoutMs: workloadTimeout(BUDGET_S),
    redirections: {},
    blurb: "Writes and reads back a bounded file in a private workspace it creates and removes.",
    observes: ["command.received", "process.started", "process.snapshot", "process.exited", "session.summary", "execution.completed"],
    moves: [
      { metric: "rcharBytes / wcharBytes", direction: "rising — characters through read()/write(), page cache included" },
      { metric: "readBytes / writeBytes", direction: "rising, and usually MUCH lower than the character counters" },
      { metric: "rcharBytesPerSec / wcharBytesPerSec (DERIVED)", direction: "a visible plateau once the file is fully written" },
    ],
    unavailable: [
      {
        metric: "readBytes / writeBytes may stay near zero",
        why: "These count only what reached the block layer. An 8 MiB write into page cache on a host with free memory and no fsync can legitimately record almost nothing at the storage layer — and that is a true reading of /proc/<pid>/io, not a broken counter.",
      },
      {
        metric: "per-second rates on the first snapshot",
        why: "A rate needs two samples. UNAVAILABLE on the first, real numbers from the second.",
      },
    ],
    bounded: `Stops itself at ${BUDGET_S}s and removes its mkdtemp workspace on every exit path, including the signal path.`,
    outcome: "COMPLETED, exit code 0.",
  },
  {
    id: "fork-tree",
    label: "FORK TREE",
    command: "caps_fork_tree",
    args: [String(BUDGET_S), "3"],
    timeoutMs: workloadTimeout(BUDGET_S),
    redirections: {},
    blurb: "A bounded parent → 3 children → 1 grandchild topology, reaped before it exits.",
    observes: ["command.received", "process.started", "process.snapshot", "process.exited", "session.summary", "execution.completed"],
    moves: [
      { metric: "elapsedMs", direction: "climbing to the budget" },
      { metric: "fork activity", direction: "the workload performs 4 forks and reaps all of them" },
      { metric: "processGroupId", direction: "observed and stable for the tracked PID" },
    ],
    unavailable: [
      {
        metric: "ANY telemetry for the descendants",
        why: "THE IMPORTANT ONE. The sampler follows the single CAPS-reported child PID, so the workers and the grandchild are never discovered. The 3D scene shows one node, not a tree, and this preset's own copy says so rather than letting a presenter imply a capability the gateway does not have.",
      },
      {
        metric: "cpuPercent on the descendants",
        why: "Follows from the above. There is no sample series for a PID CAPS never tracked, so this is UNAVAILABLE rather than zero.",
      },
    ],
    bounded: `Stops itself at ${BUDGET_S}s and waits for every worker before exiting, so no zombie is left behind.`,
    outcome: "COMPLETED, exit code 0.",
  },
  {
    id: "mixed",
    label: "MIXED",
    command: "caps_mixed_burn",
    args: [String(BUDGET_S), "48", "8"],
    timeoutMs: workloadTimeout(BUDGET_S),
    redirections: {},
    blurb: "CPU, memory and I/O interleaved in ONE process, so every signal shares a PID on one timeline.",
    observes: ["command.received", "process.started", "process.snapshot", "process.exited", "session.summary", "execution.completed"],
    moves: [
      { metric: "cpuPercent (DERIVED)", direction: "visible, but lower than the CPU-only preset because the phases interleave" },
      { metric: "rssBytes", direction: "rising to roughly the 48 MiB target" },
      { metric: "rcharBytes / wcharBytes", direction: "rising through the I/O phases" },
      { metric: "elapsedMs", direction: "climbing to the budget" },
    ],
    unavailable: [
      {
        metric: "readBytes / writeBytes (block layer)",
        why: "Same page-cache caveat as the I/O preset, and it is worth saying twice: the character counters and the storage counters are different measurements of the same run.",
      },
      {
        metric: "any per-phase breakdown",
        why: "There is no phase marker in the event stream. The three phases are interleaved inside one process, so the record shows the union, and this row does not claim the record can separate them.",
      },
    ],
    bounded: `Stops itself at ${BUDGET_S}s and cleans up its mapping and workspace on the way out.`,
    outcome: "COMPLETED, exit code 0.",
  },
  {
    id: "timeout",
    label: "TIMEOUT",
    // `sleep 30` against a 3s engine timeout. Both halves are real: the command
    // is allowlisted (catalog `sleep`, one integer 0..120) and the timeout is a
    // request field the gateway honours, not a UI fiction.
    command: "sleep",
    args: ["30"],
    timeoutMs: 3000,
    redirections: {},
    blurb: "A real sleep 30 cut off by the engine's own wall-clock guard after 3 seconds.",
    observes: ["command.received", "process.started", "process.snapshot", "signal.received", "process.exited", "session.summary", "execution.timeout"],
    moves: [
      { metric: "elapsedMs", direction: "climbing to the 3000ms ceiling and stopping there" },
      { metric: "cpuTimeMs", direction: "almost flat — a sleeping process burns no processor time" },
      { metric: "rssBytes", direction: "small and stable, as expected of sleep" },
    ],
    unavailable: [
      {
        metric: "the rate series after the timeout",
        why: "Sampling stops before the terminal event is emitted, so the last snapshot precedes the escalation. A snapshot after execution.timeout would violate the invariant the backend enforces.",
      },
      {
        metric: "exitCode",
        why: "There is no exit code: the child was terminated by a signal. The result panel shows the signal, and reading a missing exit code as 0 would be the single worst misreading on this page.",
      },
    ],
    bounded:
      "Bounded twice: 30s if the guard failed, 3s if it works. The escalation is SIGTERM then an identity-verified SIGKILL, so this cannot hang the demo.",
    outcome: "TIMED_OUT — and only one terminal event is recorded for it, by design.",
  },
  {
    id: "failure",
    label: "FAILURE",
    /*
     * `status_probe exit 42` is allowlisted and genuinely exits non-zero.
     *
     * Why not a nonexistent executable: the catalog refuses it before a session
     * is created (403 COMMAND_NOT_ALLOWED), so it produces an error toast and no
     * flight recorder at all. Nothing to demonstrate.
     *
     * Why not `false`: it works, but exit 1 is the least legible possible
     * failure and `false` exits so fast it records no procfs sample either.
     * status_probe takes a chosen code, so the recorded status is unambiguous
     * and the run is long enough to produce telemetry.
     *
     * Verified against tests/helpers/status_probe.c: `status_probe exit N`
     * returns N via atoi(), and the catalog schema requires positional 1 to be
     * one of exit/signal/print with N in 0..255.
     */
    command: "status_probe",
    args: ["exit", "42"],
    // The catalog's own ceiling for `status_probe` is 10s, used here as a
    // backstop for a run that returns in microseconds.
    timeoutMs: 10_000,
    redirections: {},
    blurb: "A first-party helper that exits with a chosen status, so the recorded failure is unambiguous.",
    observes: ["command.received", "command.parsed", "process.started", "process.exited", "session.summary", "execution.completed"],
    moves: [
      { metric: "exitCode", direction: "42, exactly" },
      { metric: "isSuccess", direction: "false" },
    ],
    unavailable: [
      {
        metric: "procfs resource metrics",
        why: "The probe exits immediately, so it is very likely to record no snapshot at all — the same honest absence as the HELLO preset.",
      },
      {
        metric: "the session STATUS, which is COMPLETED and not FAILED",
        why: "Worth stating plainly because it surprises people: a non-zero exit with a full lifecycle is a real COMPLETED run that reports an error. A FAILED status means the run never finished — an exec error, a wait failure, or a signal.",
      },
    ],
    bounded: "Returns 42 immediately; no timeout is involved.",
    outcome: "COMPLETED with isSuccess=false and exit code 42 — not FAILED. The distinction is the point of the preset.",
  },
];

/**
 * Resolve a preset to a real execution request.
 *
 * Returns a fresh object every call because `RedirectionSpec` is mutable and a
 * shared literal handed to a form that edits it would leak one preset's
 * redirection into the next.
 */
export function presetRequest(preset: FacultyPreset): {
  command: string;
  args: string[];
  redirections: RedirectionSpec;
  timeoutMs: number;
} {
  return {
    command: preset.command,
    args: [...preset.args],
    redirections: { ...preset.redirections },
    timeoutMs: preset.timeoutMs,
  };
}

/** The command line as it will appear in the flight-recorder heading. */
export function presetCommandLine(preset: FacultyPreset): string {
  return [preset.command, ...preset.args].join(" ");
}
