/**
 * The API client for the terminal, catalog, and host-observability surfaces.
 *
 * WHY THIS IS SEPARATE FROM api/client.ts
 * ---------------------------------------
 * The existing client covers sessions and analytics, which predate the catalog
 * and the host collector. Those three subsystems answer different questions and
 * were added at different times, so they get their own typed boundary here
 * rather than growing a single file that mixes two generations of contract.
 *
 * The rule that shapes this module: nothing here interprets a capability.
 *
 * The gateway knows which commands exist on THIS host, whether each one is
 * available, why it is unavailable, and exactly which grammar it accepts. The
 * frontend's job is to render that and to refuse to offer anything the gateway
 * has not declared. A client-side list of "commands CAPS supports" would be a
 * second source of truth, and the two would drift the first time a command was
 * added or a kernel lost a sensor.
 */

/** Availability as the gateway classifies it after probing the real filesystem. */
export type Availability = "AVAILABLE" | "UNAVAILABLE" | "BLOCKED";

/**
 * How the gateway established a process's identity.
 *
 * `VERIFIED` means a pidfd is bound to the process and the kernel addresses it
 * directly. `UNVERIFIED` means the start-ticks comparison succeeded but no pidfd
 * exists on this kernel. `UNAVAILABLE` means identity could not be established
 * and the process must not be signalled.
 *
 * Rendered in the UI because it changes what a reader should believe: a
 * termination under `UNVERIFIED` rests on CAPS's own check rather than on the
 * kernel's guarantee.
 */
export type IdentityConfidence = "VERIFIED" | "UNVERIFIED" | "UNAVAILABLE";

/** The lifecycle state a host process row can be in. */
export type ProcessState = "LIVE" | "EXITED" | "DISAPPEARED" | "PERMISSION_DENIED" | "UNAVAILABLE";

/**
 * How far a parent/child claim can be trusted.
 *
 * The same three words as `IdentityConfidence` but a different question:
 * `IdentityConfidence` is about whether CAPS can prove *which* process it is
 * signalling, while this is about whether a row's PPID value resolves to a
 * process that was itself observed.
 */
export type RelationshipConfidence = "VERIFIED" | "UNVERIFIED" | "UNAVAILABLE";

/**
 * A metric that carries its own unit, source, timestamp, and provenance.
 *
 * `value: null` is NEVER interchangeable with 0. On a host with no thermal
 * sensor, 0 degrees is a fabrication and 0% CPU is a lie, which is why the type
 * makes the absent case explicit and requires a reason for it.
 */
export interface SystemMetric<T> {
  value: T | null;
  unit: string;
  source: string;
  timestamp: string;
  provenance: "OBSERVED" | "DERIVED" | "UNAVAILABLE";
  /** The kernel documents this value as an approximation. */
  estimate?: boolean;
  /** Why it is missing, or how a derived value was derived. Never empty when UNAVAILABLE. */
  reason?: string;
}

export interface CommandSummary {
  name: string;
  category: string;
  availability: Availability;
  /** Always present and never empty, including for AVAILABLE commands. */
  reason: string;
  /** Absolute verified path, or null when unavailable. */
  resolvedPath: string | null;
  readOnly: boolean;
}

export interface ArgumentSchemaView {
  flags: string[];
  /** Which of those flags take a value. Absent means none do. */
  valueFlags?: string[];
  maxPositional: number;
  maxArgumentBytes: number;
  positionalArePaths: boolean;
  leadingPatternPositionals?: number;
  positionalIntegers?: { min: number; max: number };
  numericCountFlag?: { flag: string; min: number; max: number };
  detail: string;
}

/**
 * The per-command help document, exactly as the gateway builds it.
 *
 * This is the shape `commandHelp` in `catalog/validation.ts` returns, mirrored
 * field for field. The gateway generates it from the same registry that enforces
 * the rules, so the documented constraints cannot drift from the enforced ones
 * -- which is why the client renders these strings rather than writing its own.
 *
 * `description` and `whyAllowed` are currently the same string, because the
 * catalog carries one rationale per command. Both are kept: they answer
 * different questions for a reader, and a future entry with a distinct short
 * description does not require a client change.
 */
export interface CommandHelp {
  name: string;
  availability: Availability;
  availabilityReason: string;
  /** Absolute verified path, or null when unavailable. */
  executable: string | null;
  category: string;
  description: string;
  whyAllowed: string;
  /** Prose statement of what the arguments mean, from the catalog's `detail`. */
  safeArguments: string;
  telemetryRelevance: string;
  securityRestrictions: string[];
  examples: Array<{ command: string; note: string }>;
}

export interface CatalogResponse {
  version: string;
  summary: { total: number; available: number; unavailable: number; blocked: number };
  commands: CommandSummary[];
  /** Commands a reader might reasonably try, with the reason each is refused. */
  refusedByPolicy: Array<{ name: string; reason: string }>;
  trustedDirectories: string[];
}

export interface GrammarOperator {
  syntax: string;
  meaning: string;
}

export interface GrammarResponse {
  summary: string;
  quoting: Array<{ syntax: string; meaning: string }>;
  operators: GrammarOperator[];
  /**
   * Forms a user may type that CAPS does NOT interpret.
   *
   * Rendered verbatim. A terminal that silently treats `&&` as a literal
   * character is not what the operator meant, and the honest response is to say
   * so before execution rather than after a confusing result.
   */
  notImplemented: Array<{ syntax: string; reason: string }>;
  limits: { maxStages: number; maxArgumentsPerStage: number; maxTokenBytes: number; maxLineBytes: number };
  pipelineSemantics: { exitStatus: string; signal: string; processGroup: string };
}

/**
 * One stage of a validated pipeline.
 *
 * Mirrors the gateway's `ValidatedStage` field for field. In particular
 * `redirections` carries the OPERATOR and the file descriptor the engine will
 * dup2, not a simplified "output goes to a file" summary: a reader debugging
 * `2>` needs to know which descriptor was redirected, and collapsing `2>` and
 * `>` into one row would hide exactly the thing that went wrong.
 */
export interface ValidatedStage {
  index: number;
  /** The catalog name, which is what argv[0] must equal. */
  command: string;
  /** The exact argv the engine will exec. Never a re-lexing by the client. */
  argv: string[];
  redirections: Array<{ op: string; fd: number; target: string }>;
  stdinSource: string;
  stdoutDest: string;
  /**
   * The absolute verified path the engine will exec, from a trusted directory.
   *
   * Named `resolvedExecutable`, not `executablePath`: that is the field the
   * gateway sends. The earlier name was a plausible invention, and because the
   * test fixture used the same invented name the whole suite stayed green while
   * the terminal rendered an empty cell where this value belongs.
   */
  resolvedExecutable: string;
  /** Why the resolution is trustworthy. */
  resolutionNote: string;
}

/**
 * The gateway's answer to "is this command line runnable, and how".
 *
 * A transcription of the `/api/terminal/validate` response: `valid`,
 * `stageCount`, `stages`, and `limits`. The timeout and output bounds are INSIDE
 * `limits`, not at the top level, and the echo of the command line is not
 * returned at all -- the client already has it.
 */
export interface TerminalValidation {
  valid: boolean;
  stageCount: number;
  stages: ValidatedStage[];
  limits: {
    timeoutMs: number;
    maxOutputBytes: number;
  };
}

export interface TerminalExecuteAccepted {
  sessionId: string;
  stageCount: number;
  commands: string[];
  /** One resolved absolute path per stage, in stage order. */
  resolvedExecutables: string[];
  timeoutMs: number;
  eventsUrl: string;
}

export interface ThermalGuardView {
  enabled: boolean;
  availability: "AVAILABLE" | "UNAVAILABLE";
  reason: string;
  sensor: string | null;
  sensorPath: string | null;
  warningC: number;
  criticalC: number;
  action: "WARN" | "TERM" | "TERM_THEN_KILL";
  scope: string;
  /** The hardware operations the guard does not perform. */
  restrictions: string[];
}

/**
 * One guardrail, separating what was configured from whether it is enforced.
 *
 * The two are allowed to disagree. A limit that is written down but not applied
 * must be visible as such, because a reader who believes they are protected when
 * nothing is enforcing anything is worse off than one who knows.
 */
export interface GuardrailView {
  configuredBytesOrMs: number;
  unit: string;
  enforced: boolean;
  mechanism?: string;
  caveat?: string;
}

export interface GuardrailsView {
  wallTime: GuardrailView;
  stdout: GuardrailView;
  stderr: GuardrailView;
  cpuTime: GuardrailView;
  addressSpace: GuardrailView;
  concurrency: GuardrailView;
  thermal: ThermalGuardView;
}

export interface ProcessIdentityView {
  model: string;
  confidence: IdentityConfidence;
  reason: string;
  kernel: string | null;
  terminationMechanism: "pidfd" | "start-ticks" | "unavailable";
  invariant: string;
}

/**
 * One host process, exactly as the gateway sends it.
 *
 * Every measurement is a `SystemMetric`, because every one of them can be
 * UNAVAILABLE for a specific reason -- permission, a field the kernel does not
 * publish, a budget that was spent -- and a reader has to be able to tell those
 * apart from a zero. This type is a transcription of
 * `HostProcess` in `web/backend/src/telemetry/system/processes.ts`; the two are
 * checked against the real endpoint rather than against each other's comments.
 */
export interface HostProcessRow {
  pid: SystemMetric<number>;
  ppid: SystemMetric<number>;
  identity: {
    pid: number;
    startTicks: number | null;
    bootId: string | null;
    key: string;
  };
  /** Whether CAPS spawned this process, matched on identity and never on name. */
  capsOwned: boolean;
  /** How far the kernel's PPID value can be trusted as a parent link. */
  relationshipConfidence: SystemMetric<RelationshipConfidence>;
  name: SystemMetric<string>;
  cmdline: SystemMetric<string[]>;
  state: SystemMetric<string>;
  stateName: SystemMetric<string>;
  uid: SystemMetric<number>;
  gid: SystemMetric<number>;
  threads: SystemMetric<number>;
  cpuTimeMs: SystemMetric<number>;
  cpuPercent: SystemMetric<number>;
  rssBytes: SystemMetric<number>;
  pssBytes: SystemMetric<number>;
  anonymousBytes: SystemMetric<number>;
  fileBackedBytes: SystemMetric<number>;
  sharedBytes: SystemMetric<number>;
  swapBytes: SystemMetric<number>;
  virtualMemoryBytes: SystemMetric<number>;
  voluntaryContextSwitches: SystemMetric<number>;
  nonVoluntaryContextSwitches: SystemMetric<number>;
  minorFaults: SystemMetric<number>;
  majorFaults: SystemMetric<number>;
  readBytes: SystemMetric<number>;
  writeBytes: SystemMetric<number>;
  processGroupId: SystemMetric<number>;
  sessionId: SystemMetric<number>;
  cpuAffinity: SystemMetric<string>;
  schedulerRuntimeNs: SystemMetric<number>;
  schedulerWaitNs: SystemMetric<number>;
  schedulerTimeslices: SystemMetric<number>;
  rowState: ProcessState;
  /** Why the row is in this state, or null when it is plainly LIVE. */
  stateReason: string | null;
  /** False when the sample budget excluded this row's full field read. */
  sampled: boolean;
}

export interface HostProcessesResponse {
  processes: HostProcessRow[];
  total: number;
  returned: number;
  /**
   * Whether this kernel can produce PSS at all, as a full metric.
   *
   * NOT a plain boolean. The gateway reports it through the same metric wrapper
   * as every other host reading, so it arrives as `null` before the probe has
   * run and as `{ value: false, ... }` on a kernel without smaps_rollup. Typing
   * it as `boolean` made `pssSupported === false` unreachable -- the notice that
   * PSS was never observed could never be rendered -- while looking perfectly
   * correct to the type checker.
   */
  pssSupported: SystemMetric<boolean> | null;
  pssNote: string;
  cadence: { fastMs: number; discoveryMs: number; pssMs: number; pssMaxProcesses: number };
}

/**
 * The `/api/capabilities` document, as far as this client uses it.
 *
 * Deliberately NOT `extends CatalogResponse`. `/api/capabilities` and
 * `/api/catalog` are different documents: the catalog carries the probed command
 * list and its summary, and the capabilities document carries the guardrails,
 * the process-identity claim, and the bind/security policy. Extending one with
 * the other produced a type that claimed four fields the endpoint never sends,
 * and would have broken the first line of code that actually read them.
 */
export interface CapabilitiesResponseFull {
  guardrails: GuardrailsView;
  processIdentity: ProcessIdentityView;
  version: string;
}

/**
 * A catalog entry after probing, with the argument schema the validator uses.
 *
 * `availability`, `reason` and `resolvedPath` come from the gateway's own probe
 * of the real filesystem. The client never re-probes: a browser cannot stat
 * `/usr/bin/seq` the way the gateway does, and a client-side guess would be a
 * second answer to the question "can this command run here".
 */
export interface ProbedCommandDetail extends CommandSummary {
  argumentSchema: ArgumentSchemaView;
  /** The wall-clock ceiling the gateway will apply to this command. */
  timeoutMs: number;
  maxOutputBytes: number;
  workspacePolicy: string;
  rationale: string;
  telemetryRelevance: string;
  examples: Array<{ command: string; note: string }>;
}

const BASE = import.meta.env.VITE_CAPS_API ?? "";

export class TerminalApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    /** Which pipeline stage failed validation, when the gateway says. */
    public readonly stageIndex: number | null,
    public readonly hint: string | null,
  ) {
    super(message);
    this.name = "TerminalApiError";
  }
}

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    });
  } catch (err) {
    throw new TerminalApiError(0, "NETWORK_ERROR", err instanceof Error ? err.message : "Request failed", null, null);
  }
  const body = (await res.json().catch(() => null)) as
    | { error?: { code?: string; message?: string; stageIndex?: number; hint?: string } }
    | T
    | null;
  if (!res.ok) {
    const e = (body as { error?: { code?: string; message?: string; stageIndex?: number; hint?: string } } | null)?.error;
    throw new TerminalApiError(
      res.status,
      e?.code ?? "HTTP_ERROR",
      e?.message ?? `Request failed (${res.status})`,
      e?.stageIndex ?? null,
      e?.hint ?? null,
    );
  }
  return body as T;
}

/**
 * The process detail response, exactly as the gateway sends it.
 *
 * `timestamp` used to be declared here and was never present in the response. A
 * declared-but-absent field is worse than an undeclared one: it type-checks, it
 * looks authoritative, and it renders as `undefined` in the one place a reader
 * would take a measurement time from.
 */
export interface ProcessDetailResponse {
  process: HostProcessRow;
  /** null when smaps_rollup could not be read for this process. */
  pss: { pss: number; anonymous: number; fileBacked: number; shared: number } | null;
  pssNote: string;
  hostContext: {
    cpuBusyPercent: number | null;
    memoryUsedPercent: number | null;
    pressure: unknown[];
    thermalHighestCelsius: number | null;
    load1: number | null;
  };
  /** Persisted snapshots for this identity. `process` is null on a corrupt row. */
  history: Array<{ timestamp: string; process: unknown }>;
}

/**
 * The catalog, grammar, terminal, and host-observer surface.
 *
 * Every response is returned as the gateway sent it. No field is defaulted,
 * widened, or filled in, because a client that manufactures a value the gateway
 * did not send is indistinguishable from one that is lying about it.
 */
export const catalogApi = {
  catalog: (): Promise<CatalogResponse> => json<CatalogResponse>("/api/catalog"),
  /**
   * The probed catalog entry, carrying the live argument schema.
   *
   * This is what a structured editor needs: the flags each command accepts and
   * which of them take a value, so it can offer completion without guessing.
   */
  command: (name: string): Promise<ProbedCommandDetail> => json<ProbedCommandDetail>(`/api/catalog/${encodeURIComponent(name)}`),
  /** The generated help document, generated from the same registry. */
  help: (name: string): Promise<CommandHelp> => json<CommandHelp>(`/api/catalog/${encodeURIComponent(name)}/help`),
  grammar: (): Promise<GrammarResponse> => json<GrammarResponse>("/api/terminal/grammar"),

  validate: (commandLine: string): Promise<TerminalValidation> =>
    json<TerminalValidation>("/api/terminal/validate", {
      method: "POST",
      body: JSON.stringify({ commandLine }),
    }),

  execute: (commandLine: string, timeoutMs?: number): Promise<TerminalExecuteAccepted> =>
    json<TerminalExecuteAccepted>("/api/terminal/execute", {
      method: "POST",
      body: JSON.stringify(timeoutMs === undefined ? { commandLine } : { commandLine, timeoutMs }),
    }),

  hostProcesses: (opts: { limit?: number; live?: boolean; withPss?: boolean } = {}): Promise<HostProcessesResponse> => {
    const p = new URLSearchParams();
    if (opts.limit !== undefined) p.set("limit", String(opts.limit));
    if (opts.live) p.set("live", "true");
    if (opts.withPss) p.set("withPss", "true");
    const qs = p.toString();
    return json<HostProcessesResponse>(`/api/system/processes${qs === "" ? "" : `?${qs}`}`);
  },

  /**
   * The process detail response.
   *
   * Field-for-field as the gateway sends it. See `ProcessDetailResponse`.
   */
  process: (identity: string): Promise<ProcessDetailResponse> =>
    json(`/api/system/processes/${encodeURIComponent(identity)}`),

  hostCapabilities: (): Promise<{ version: string; subsystems: unknown[]; notImplemented: unknown[] }> =>
    json("/api/system/capabilities"),

  guardrails: async (): Promise<GuardrailsView> => {
    const caps = await json<CapabilitiesResponseFull>("/api/capabilities");
    return caps.guardrails;
  },

  /**
   * The full capabilities document: guardrails, process identity, and the
   * catalog, in one response.
   *
   * Preferred over calling `guardrails()` separately, because the process
   * identity half of that document is produced by a real pidfd probe and the
   * caller almost always wants both facts together: what CAPS will run, and how
   * firmly it can address what it started.
   */
  capabilities: (): Promise<CapabilitiesResponseFull> => json<CapabilitiesResponseFull>("/api/capabilities"),
} as const;
