import { accessSync, constants, statSync } from "node:fs";
import { relative, resolve } from "node:path";

import { repoRoot } from "../config/env.js";

/**
 * First-party controlled workload catalog.
 *
 * Every entry describes a real binary built from `workloads/*.c` by
 * `make workloads`. The gateway resolves each one to an explicit,
 * repository-relative path — the browser can never supply a path.
 *
 * Two rules govern this file:
 *
 *  1. No guessed capability. `available` is the result of an actual
 *     access(X_OK) + isFile() probe, and it is reported with an explicit
 *     provenance. If a binary is missing the catalog says so instead of
 *     optimistically claiming the workload works.
 *
 *  2. The schema is the contract. Bounds here mirror the C
 *     `CAPS_WL_*` constants in `workloads/workload_common.h` exactly.
 *     The C program validates again at runtime; this layer exists so a
 *     bad request is rejected before a process is ever spawned.
 */

/** Must match CAPS_WL_MIN_DURATION_S / CAPS_WL_MAX_DURATION_S. */
const DURATION = { min: 1, max: 30, def: 10, unit: "s" } as const;
/** Must match CAPS_WL_MAX_MEMORY_MIB. */
const MEMORY = { min: 1, max: 256, def: 64, unit: "MiB" } as const;
/** Must match CAPS_WL_MAX_IO_MIB. */
const IO = { min: 1, max: 64, def: 8, unit: "MiB" } as const;
/** Must match CAPS_WL_MAX_FORK_CHILDREN. */
const CHILDREN = { min: 1, max: 4, def: 2, unit: "processes" } as const;

export interface WorkloadArgSpec {
  /** Positional name, e.g. "seconds". */
  readonly name: string;
  readonly min: number;
  readonly max: number;
  readonly default: number;
  readonly unit: string;
  readonly description: string;
}

export interface WorkloadProfile {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  /** Signals this workload is designed to make observable. */
  readonly observes: readonly string[];
  /**
   * What the gateway actually samples while this workload runs.  Present
   * because "what the workload does" and "what the observatory sees" are
   * different questions, and only the second one may be advertised.
   */
  readonly observationScope: {
    readonly sampled: string;
    readonly notSampled: string;
  };
  readonly args: readonly WorkloadArgSpec[];
  /**
   * Built argv (excluding argv[0]) for a given set of user values.
   * Omitted values fall back to the profile defaults.
   */
  readonly buildArgv: (values: readonly (number | undefined)[]) => string[];
}

const duration = (def: number = DURATION.def): WorkloadArgSpec => ({
  name: "seconds",
  min: DURATION.min,
  max: DURATION.max,
  default: def,
  unit: DURATION.unit,
  description: "Wall-clock budget. The process stops itself when the budget expires.",
});
const memory = (): WorkloadArgSpec => ({
  name: "mib",
  min: MEMORY.min,
  max: MEMORY.max,
  default: MEMORY.def,
  unit: MEMORY.unit,
  description: "Anonymous mapping that is fully touched, so VmRSS reports this target.",
});
const io = (): WorkloadArgSpec => ({
  name: "mib",
  min: IO.min,
  max: IO.max,
  default: IO.def,
  unit: IO.unit,
  description: "Total bytes written to a private mkdtemp workspace, then read back.",
});
const children = (): WorkloadArgSpec => ({
  name: "children",
  min: CHILDREN.min,
  max: CHILDREN.max,
  default: CHILDREN.def,
  unit: CHILDREN.unit,
  description: "Direct child processes to fork. Worker 1 forks one grandchild.",
});

const num = (v: number | undefined, spec: WorkloadArgSpec): number =>
  v === undefined ? spec.default : v;

export const WORKLOAD_PROFILES: readonly WorkloadProfile[] = [
  {
    id: "caps_cpu_burn",
    label: "CPU burn",
    description: "Sustained arithmetic mixing on one core for a bounded budget.",
    observes: ["cpuUserMs", "cpuSystemMs", "cpuPercent", "elapsedMs"],
    observationScope: { sampled: "the single CAPS-reported child PID via /proc/<pid>/{stat,status,io}", notSampled: "system-wide CPU, cgroup accounting, and any process the child forks" },
    args: [duration()],
    buildArgv: (v) => [String(num(v[0], duration()))],
  },
  {
    id: "caps_memory_burn",
    label: "Memory pressure",
    description: "Touches every page of a private anonymous mapping, then holds it resident.",
    observes: ["rssBytes", "virtualMemoryBytes", "minorFaults"],
    observationScope: { sampled: "the single CAPS-reported child PID via /proc/<pid>/{stat,status,io}", notSampled: "system-wide memory, swap, and any process the child forks" },
    args: [duration(), memory()],
    buildArgv: (v) => [String(num(v[0], duration())), String(num(v[1], memory()))],
  },
  {
    id: "caps_io_burn",
    label: "File I/O burn",
    description: "Writes and reads back a bounded file inside a private workspace it creates and removes.",
    observes: ["readBytes", "writeBytes", "rcharBytes", "wcharBytes"],
    observationScope: { sampled: "the single CAPS-reported child PID via /proc/<pid>/io", notSampled: "per-device I/O, network I/O, and any process the child forks" },
    args: [duration(), io()],
    buildArgv: (v) => [String(num(v[0], duration())), String(num(v[1], io()))],
  },
  {
    id: "caps_mixed_burn",
    label: "Mixed CPU + memory + I/O",
    description: "Interleaves all three phases in one process so every /proc signal shares one PID on one timeline.",
    observes: ["cpuPercent", "rssBytes", "readBytes", "writeBytes"],
    observationScope: { sampled: "the single CAPS-reported child PID via /proc/<pid>/{stat,status,io}", notSampled: "system-wide CPU or memory, and any process the child forks" },
    args: [duration(), memory(), io()],
    buildArgv: (v) => [
      String(num(v[0], duration())),
      String(num(v[1], memory())),
      String(num(v[2], io())),
    ],
  },
  {
    id: "caps_fork_tree",
    label: "Process tree (fork activity of one tracked process)",
    description:
      "Forks a bounded, deterministic parent -> children -> grandchild topology and reaps every child before exiting. The observatory samples the direct process CAPS reports (and every reported stage when used in a pipeline), so this workload demonstrates fork activity without making its descendants observable in gateway telemetry.",
    // Stated as fork *activity* rather than descendant observation, because
    // the sampler follows CAPS-reported direct PIDs. Claiming "descendants"
    // here would be a capability the gateway does not have.
    observes: ["forkActivity", "processGroupId", "elapsedMs"],
    observationScope: {
      sampled: "the direct process reported by CAPS",
      notSampled: "descendants created by that child; the gateway discovers no process tree",
    },
    args: [duration(8), children()],
    buildArgv: (v) => [String(num(v[0], duration(8))), String(num(v[1], children()))],
  },
];

const BY_ID = new Map(WORKLOAD_PROFILES.map((p) => [p.id, p]));

export function isWorkloadId(command: string): boolean {
  return BY_ID.has(command);
}

export function getWorkloadProfile(command: string): WorkloadProfile | null {
  return BY_ID.get(command) ?? null;
}

export function workloadIds(): string[] {
  return WORKLOAD_PROFILES.map((p) => p.id);
}

/** Absolute path of a workload binary. Never derived from user input. */
export function workloadExecutablePath(id: string): string {
  return resolve(repoRoot, "build", "workloads", id);
}

export type WorkloadAvailability = {
  readonly available: boolean;
  readonly provenance: "OBSERVED";
  readonly reason: string | null;
};

/** Real probe. No defaults, no optimism. */
export function probeWorkload(id: string): WorkloadAvailability {
  const path = workloadExecutablePath(id);
  try {
    accessSync(path, constants.X_OK);
  } catch {
    return {
      available: false,
      provenance: "OBSERVED",
      reason: "binary not found or not executable (run: make workloads)",
    };
  }
  try {
    if (!statSync(path).isFile()) {
      return { available: false, provenance: "OBSERVED", reason: "path is not a regular file" };
    }
  } catch (err) {
    return {
      available: false,
      provenance: "OBSERVED",
      reason: `stat failed: ${(err as NodeJS.ErrnoException).code ?? "unknown"}`,
    };
  }
  return { available: true, provenance: "OBSERVED", reason: null };
}

export type WorkloadCapability = {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly observes: readonly string[];
  readonly observationScope: { readonly sampled: string; readonly notSampled: string };
  readonly args: readonly WorkloadArgSpec[];
  readonly executablePath: string;  /** Repository-relative, for display only. */
  readonly executableRelativePath: string;
  readonly available: boolean;
  readonly availabilityProvenance: "OBSERVED";
  readonly unavailableReason: string | null;
};

export function workloadCapabilities(): WorkloadCapability[] {
  return WORKLOAD_PROFILES.map((p) => {
    const probe = probeWorkload(p.id);
    const abs = workloadExecutablePath(p.id);
    return {
      id: p.id,
      label: p.label,
      description: p.description,
      observes: p.observes,
      observationScope: p.observationScope,
      args: p.args,
      executablePath: abs,
      executableRelativePath: relative(repoRoot, abs),
      available: probe.available,
      availabilityProvenance: probe.provenance,
      unavailableReason: probe.reason,
    };
  });
}

// ---------------------------------------------------------------------------
// Strict request validation
// ---------------------------------------------------------------------------

export class WorkloadArgumentError extends Error {
  override name = "WorkloadArgumentError";
  readonly code = "WORKLOAD_ARGUMENT_REJECTED";
}

const INTEGER = /^-?\d{1,9}$/;

function parseOne(raw: string, spec: WorkloadArgSpec, id: string): number {
  // Reject "3.5", "1e3", "0x10", "+3", " 3", "3 " and "3s" up front so the
  // gateway and the C strtol-based parser can never disagree.
  if (!INTEGER.test(raw)) {
    throw new WorkloadArgumentError(
      `${id}: argument ${spec.name} must be a plain base-10 integer (got ${JSON.stringify(raw)})`,
    );
  }
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value)) {
    throw new WorkloadArgumentError(`${id}: argument ${spec.name} is out of range`);
  }
  if (value < spec.min || value > spec.max) {
    throw new WorkloadArgumentError(
      `${id}: argument ${spec.name} must be ${spec.min}..${spec.max} ${spec.unit} (got ${value})`,
    );
  }
  return value;
}

export type ValidatedWorkload = {
  readonly profile: WorkloadProfile;
  /** Values the user supplied; omitted positions are undefined. */
  readonly values: ReadonlyArray<number | undefined>;
  /** Fully materialized argv, defaults included. */
  readonly argv: readonly string[];
};

/**
 * Validate a user-supplied argv for a workload.
 *
 * Trailing arguments may be omitted (the binary then applies its own
 * default), but a supplied argument must be positional, integral, and
 * inside the documented bound. No flags, no unknown extras.
 */
export function validateWorkloadArgv(command: string, args: readonly string[]): ValidatedWorkload {
  const profile = getWorkloadProfile(command);
  if (profile === null) {
    throw new WorkloadArgumentError(`${command} is not a controlled workload`);
  }
  if (args.length > profile.args.length) {
    throw new WorkloadArgumentError(
      `${command} accepts at most ${profile.args.length} argument(s) (${profile.args
        .map((a) => a.name)
        .join(", ")}); got ${args.length}. Unknown arguments are rejected.`,
    );
  }
  const values: Array<number | undefined> = [];
  for (let i = 0; i < args.length; i++) {
    values.push(parseOne(args[i]!, profile.args[i]!, command));
  }
  for (let i = args.length; i < profile.args.length; i++) values.push(undefined);

  return {
    profile,
    values,
    argv: profile.buildArgv(values),
  };
}

/** Convenience for the execute route: validated argv or a thrown error. */
export function materializeWorkloadArgv(command: string, args: readonly string[]): string[] {
  return [...validateWorkloadArgv(command, args).argv];
}

export const WORKLOAD_LIMITS = {
  maxDurationS: DURATION.max,
  maxMemoryMib: MEMORY.max,
  maxIoMib: IO.max,
  maxForkChildren: CHILDREN.max,
} as const;
