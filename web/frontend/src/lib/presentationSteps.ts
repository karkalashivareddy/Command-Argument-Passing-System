/**
 * The presentation script: twelve steps, in the order a presenter walks them.
 *
 * WHY THE STEPS LIVE IN A MODULE AND NOT IN THE COMPONENT
 * -------------------------------------------------------
 * The overlay is a view; this is the content. Splitting them means the step list
 * can be asserted without rendering a dialog, and it means the one rule that
 * matters -- a session-scoped step must resolve to a session id that actually
 * exists -- is enforced in a single pure function rather than being re-derived
 * inside a JSX branch.
 *
 * THE RULE THIS FILE EXISTS TO KEEP
 * ---------------------------------
 * CAPS never presents a lifecycle it did not observe. Applied to a presenter:
 *
 *   - a HOST step names a page that exists in this build. There is no
 *     "about the philosophy" destination for a product that must not overclaim;
 *     step 01 goes to the Overview, where the real engine state is on screen.
 *   - a SESSION step resolves against a REAL session id, or it does not
 *     navigate at all. It says so and offers to run a real command first.
 *
 * There is no third behaviour, and specifically no fabricated session id. A
 * presenter who lands on `/execution/exec_0000` because a slide wanted a URL
 * would be showing a page whose every number is UNAVAILABLE, which is the exact
 * failure this product exists to avoid -- just with the badge saying
 * "not found" instead of "simulated".
 *
 * WHY STEP 05 AND STEP 12 SHARE A ROUTE
 * -------------------------------------
 * Because they are different REGIONS of one surface, and the region is named in
 * the panel. The flight recorder is the single page where fork, exec, PID and
 * provenance are all observable at once; splitting them across invented pages
 * would mean inventing pages. The panel tells the presenter where to point
 * ("Execution pipeline — EXEC column" versus "Data lineage, bottom of page"),
 * which is the thing a URL cannot express.
 */

export type StepScope = "host" | "session";

export interface PresentationStep {
  /** 1-based position, shown as the two-digit badge. */
  readonly position: number;
  /** Two-digit code, e.g. "04". Derived from position; kept for clarity in JSX. */
  readonly code: string;
  readonly title: string;
  /**
   * Exactly one sentence. A presenter's panel is read at a glance from two
   * metres away, so this is a claim, not a paragraph -- and because every one of
   * them is about what CAPS actually recorded, one sentence is enough.
   */
  readonly sentence: string;
  readonly scope: StepScope;
  /** The route to be on. A literal path for a host step, a prefix for a session step. */
  readonly route: string;
  /** What to look at once there. Named so the presenter is never guessing. */
  readonly region: string;
  /** Extra note shown only when the step's precondition is unmet. */
  readonly unmet: string;
}

const STEPS_RAW: readonly Omit<PresentationStep, "code">[] = [
  {
    position: 1,
    title: "WHAT IS CAPS?",
    sentence:
      "CAPS is a Linux process observability system: it forks a real program, execs it, and records only what the kernel then reports.",
    scope: "host",
    route: "/",
    region: "Engine and platform chips in the topbar, then the lifecycle rail in the hero",
    unmet: "",
  },
  {
    position: 2,
    title: "COMMAND",
    sentence:
      "A request arrives as a program name plus a structured argv array, never a string for a shell to parse.",
    scope: "host",
    route: "/execute",
    region: "Execution request card — the Program field and its allowlist hint",
    unmet: "",
  },
  {
    position: 3,
    title: "ARGV",
    sentence:
      "The argument vector is stored cell by cell, so quoting and re-splitting can never quietly change what the child received.",
    scope: "session",
    route: "/arguments/",
    region: "Argument vector card — argv[0] through the NULL terminator",
    unmet:
      "The argument inspector needs a recorded execution to read an argv vector from, because the vector it shows is the one the gateway validated.",
  },
  {
    position: 4,
    title: "FORK",
    sentence:
      "fork() is the only way POSIX creates a child, and the kernel allocates that child's PID here, before anything is exec'd.",
    scope: "host",
    route: "/architecture",
    region: "CAPS engine layer → the fork() row in the POSIX syscall list",
    unmet: "",
  },
  {
    position: 5,
    title: "EXEC",
    sentence:
      "execvp() replaces the child's memory image in the same PID, and a failure at this point is an exec error rather than an exit code.",
    scope: "session",
    route: "/execution/",
    region: "Execution pipeline — the EXEC column, with per-stage evidence underneath it",
    unmet:
      "This step reads the recorded EXEC column, so it needs an execution on the record rather than a description of one.",
  },
  {
    position: 6,
    title: "REAL PID",
    sentence:
      "The number in the header is a Linux PID read for a process that exists, which is why the explorer can show its PPID and state from /proc.",
    scope: "host",
    route: "/processes/explorer",
    region: "The PID column and the CAPS-owned / host-process split in the summary line",
    unmet: "",
  },
  {
    position: 7,
    title: "PROCFS",
    sentence:
      "Every resource figure comes from a named file under /proc, and the system page states which subsystems are implemented and which are not.",
    scope: "host",
    route: "/system",
    region: "Host observation — the Implemented and Not implemented lists with their sources",
    unmet: "",
  },
  {
    position: 8,
    title: "LIVE EVENTS",
    sentence:
      "Each event is pushed over SSE the moment the gateway writes it, carrying a per-session sequence number so nothing can be reordered or dropped.",
    scope: "host",
    route: "/live",
    region: "Global event stream — one row per canonical event, newest at the bottom",
    unmet: "",
  },
  {
    position: 9,
    title: "3D PROCESS SPACE",
    sentence:
      "The scene is a visualisation of the recorded samples, not a source of them: the browser never reads /proc and no process is executed here.",
    scope: "session",
    route: "/execution/",
    region: "Process space (3D) card — topology or timeline mode",
    unmet:
      "The 3D space is built from one execution's samples, so it needs an execution on the record. It is not a host-wide view.",
  },
  {
    position: 10,
    title: "TERMINATION",
    sentence:
      "A signal is delivered to a verified identity and never to a bare PID, so a recycled PID cannot be signalled by mistake.",
    scope: "host",
    route: "/signals",
    region: "Spawn a real sleep 30, then deliver a signal and watch the flow diagram follow the events",
    unmet: "",
  },
  {
    position: 11,
    title: "FLIGHT RECORDER",
    sentence:
      "Every track, inspector and peak follows one cursor over the persisted event timeline, so a replay cannot show anything that did not happen.",
    scope: "session",
    route: "/execution/",
    region: "Flight recorder replay — the scrubber at the top of the recorder",
    unmet:
      "Replay reconstructs one persisted record, so it needs an execution on the record to reconstruct.",
  },
  {
    position: 12,
    title: "EVIDENCE / PROVENANCE",
    sentence:
      "Each displayed fact is labelled OBSERVED, DERIVED or UNAVAILABLE, and an unavailable one is shown with its reason rather than as a zero.",
    scope: "session",
    route: "/execution/",
    region: "Data lineage — the provenance table at the foot of the flight recorder",
    unmet:
      "The data-lineage table describes one execution's evidence, so it needs an execution on the record to describe.",
  },
];

/**
 * Step 09 and step 11 need different routes on the same session: the space is
 * `/execution/<id>/3d`, and the recorder's replay view is `/execution/<id>` with
 * an explicit query. Both are decided here rather than in the component so the
 * rule "which surface does this step mean" is one table.
 */
const SESSION_VARIANTS: Record<number, (sessionId: string) => string> = {
  9: (id) => `/execution/${id}/3d`,
  11: (id) => `/execution/${id}?replay=1`,
};

export const PRESENTATION_STEPS: readonly PresentationStep[] = STEPS_RAW.map((s) => ({
  ...s,
  code: s.position < 10 ? `0${s.position}` : String(s.position),
}));

export type PresentationDestination =
  | { readonly ok: true; readonly to: string; readonly region: string }
  | { readonly ok: false; readonly reason: string };

/**
 * Where a step goes, given the session the overlay has actually resolved.
 *
 * Returns `ok: false` rather than a best-effort URL when a session-scoped step
 * has no session. The caller must then say so in words. Returning a plausible
 * route here would be the single most damaging thing this module could do,
 * because the failure would not look like a failure: the flight recorder would
 * open and simply report every metric as UNAVAILABLE.
 */
export function destinationFor(
  step: PresentationStep,
  sessionId: string | null,
): PresentationDestination {
  if (step.scope === "host") {
    return { ok: true, to: step.route, region: step.region };
  }
  if (sessionId === null || sessionId.trim() === "") {
    return { ok: false, reason: step.unmet };
  }
  const build = SESSION_VARIANTS[step.position];
  const to = build ? build(sessionId) : `${step.route}${sessionId}`;
  return { ok: true, to, region: step.region };
}

/** Clamp any index into the script, so a stale counter cannot blank the panel. */
export function stepAt(index: number): PresentationStep {
  const bounded = Math.min(Math.max(index, 0), PRESENTATION_STEPS.length - 1);
  return PRESENTATION_STEPS[bounded]!;
}

/** Human label for the position counter, e.g. "03 / 12". */
export function positionLabel(index: number): string {
  const step = stepAt(index);
  return `${step.code} / ${PRESENTATION_STEPS.length}`;
}