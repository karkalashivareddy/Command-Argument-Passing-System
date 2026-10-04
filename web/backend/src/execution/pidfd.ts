import { execFile } from "node:child_process";
import { existsSync, lstatSync } from "node:fs";
import { resolve } from "node:path";

import { repoRoot } from "../config/env.js";
import { logger } from "../utils/logger.js";

/**
 * pidfd integration.
 *
 * WHY A HELPER BINARY
 * -------------------
 * The gateway needs pidfd_open(2) and pidfd_send_signal(2). Node exposes
 * neither, and the tempting substitute -- `process.kill(pid)` -- reintroduces
 * exactly the race this exists to remove. So the syscalls live in
 * `src/pidfd.c`, and this module execs the built helper.
 *
 * An exec per signal sounds expensive and is not: signals here mean a timeout
 * escalation or a shutdown, measured in single digits over a gateway's
 * lifetime. Addressing the correct process is worth far more than the ~2ms.
 *
 * WHY THIS IS SAFE
 * ----------------
 * A pidfd is a kernel handle bound to one specific process. The kernel never
 * re-points it, even if the PID is recycled, so pidfd_send_signal() through
 * the handle cannot reach an unrelated process -- if the original exited, the
 * call fails with ESRCH.
 *
 * `pidfd.ts` therefore provides the PRIMARY guarantee. Start-ticks validation
 * in `terminator.ts` is a SECOND, independent check that also works where pidfd
 * is unavailable. Where both are available, both are applied; the recorded
 * evidence says which mechanism actually carried the signal, because a
 * termination whose mechanism is unrecorded is exactly the kind of claim this
 * product exists to avoid.
 *
 * TRUTHFUL UNAVAILABILITY
 * -----------------------
 * If the helper is not built, or the kernel lacks pidfd, this reports
 * UNAVAILABLE with the reason. It never reports VERIFIED on the strength of an
 * assumption, and the fallback path is not a degraded fiction -- it is the same
 * start-ticks check that has always run.
 */

/** How a process's identity was established. */
export type IdentityConfidence =
  /** A pidfd is bound to this exact process and the kernel addresses it directly. */
  | "VERIFIED"
  /** Start-ticks validated only; no pidfd, because the kernel or sandbox lacks it. */
  | "UNVERIFIED"
  /** Identity could not be established at all; the process must not be signalled. */
  | "UNAVAILABLE";

export interface PidfdCapability {
  available: boolean;
  confidence: IdentityConfidence;
  /** Exact reason, always present. Never empty. */
  reason: string;
  /** Kernel release as reported by /proc/sys/kernel/osrelease, when read. */
  kernel: string | null;
  /** Absolute path to the helper, or null when it is not built. */
  helperPath: string | null;
}

let cached: PidfdCapability | null = null;

/** Test seam: forget the cached capability so a test can re-probe. */
export function resetPidfdCapability(): void {
  cached = null;
}

/** Absolute path to the helper, whether or not it is built. */
export function pidfdHelperPath(): string {
  return resolve(repoRoot, "build", "caps_pidfd");
}

interface ProbeResult {
  ok: boolean;
  reason: string;
  kernel: string | null;
}

/**
 * Run the capability probe once and cache the answer.
 *
 * Cached because the answer is a property of the kernel and the sandbox, not
 * of the current process, and a probe costs a fork. `resetPidfdCapability`
 * exists so a test can force a re-probe rather than assert against whatever
 * an earlier test happened to establish.
 */
export async function pidfdCapability(): Promise<PidfdCapability> {
  if (cached !== null) return cached;

  const helperPath = pidfdHelperPath();
  if (!existsSync(helperPath)) {
    cached = {
      available: false,
      confidence: "UNAVAILABLE",
      reason:
        `the pidfd helper is not built at ${helperPath}. Run "make" (or "make test-helpers"). ` +
        `Until then, termination uses start-ticks identity validation only.`,
      kernel: null,
      helperPath: null,
    };
    return cached;
  }

  // A helper that is present but not a regular executable file is a different
  // failure from one that is missing, and saying "not built" would be wrong.
  try {
    const st = lstatSync(helperPath);
    if (!st.isFile() || (st.mode & 0o111) === 0) {
      cached = {
        available: false,
        confidence: "UNAVAILABLE",
        reason: `${helperPath} exists but is not an executable regular file, so it cannot be used`,
        kernel: null,
        helperPath: null,
      };
      return cached;
    }
  } catch (err) {
    cached = {
      available: false,
      confidence: "UNAVAILABLE",
      reason: `${helperPath} could not be inspected: ${(err as Error).message}`,
      kernel: null,
      helperPath: null,
    };
    return cached;
  }

  // Captured into a local so the closure below sees a `string`, not a
  // `string | null` that TypeScript cannot narrow across the existsSync
  // boundary.
  const helper: string = helperPath;

  const probe = await new Promise<ProbeResult>((resolve) => {
    execFile(
      helper,
      ["--probe"],
      { timeout: 5_000, windowsHide: true },
      (err: Error | null, stdout: string, stderr: string) => {
        const text = String(stdout ?? "").trim();
        const firstLine = text.split("\n").find((l) => l.includes('"ok"')) ?? "";
        const kernelLine = String(stderr ?? "")
          .split("\n")
          .find((l) => l.startsWith("kernel="));
        const ok = /"ok":true/.test(firstLine);
        const reasonMatch = /"reason":"([^"]*)"/.exec(firstLine);
        resolve({
          ok,
          reason: ok
            ? "pidfd_open succeeded on this kernel"
            : (reasonMatch?.[1] ?? (err instanceof Error ? err.message : "probe produced no reason")),
          kernel: kernelLine === undefined ? null : kernelLine.slice("kernel=".length),
        });
      },
    );
  });

  cached = {
    available: probe.ok,
    // "UNVERIFIED" rather than "UNAVAILABLE" when the helper works but the
    // kernel lacks the syscall: identity can still be validated by start ticks,
    // so the gateway is functional, just not kernel-bound.
    confidence: probe.ok ? "VERIFIED" : "UNVERIFIED",
    reason: probe.reason,
    kernel: probe.kernel,
    helperPath,
  };
  if (!probe.ok) {
    logger.warn("SYSTEM", "pidfd unavailable; using start-ticks identity validation", {
      reason: probe.reason,
      kernel: probe.kernel,
    });
  }
  return cached;
}

/** Synchronous-ish helper for callers that already know the capability. */
export function cachedPidfdCapability(): PidfdCapability | null {
  return cached;
}

export interface PidfdSignalOutcome {
  delivered: boolean;
  /** Which mechanism actually carried (or declined to carry) the signal. */
  mechanism: "pidfd" | "unavailable" | "rejected";
  /** Human-readable reason, always present. */
  reason: string;
  errno: number | null;
}

/**
 * Signal a process through a pidfd, binding by (pid, startTicks).
 *
 * Returns `mechanism: "rejected"` when the helper ran and declined -- a
 * recycled PID, a vanished process, a permission failure. That is a decision,
 * not a failure of this module, and the caller must treat it as final: falling
 * back to a bare `kill(pid)` after the kernel refused would discard the exact
 * guarantee that made the refusal safe.
 */
export async function pidfdSignal(pid: number, startTicks: number, signal: number): Promise<PidfdSignalOutcome> {
  const capability = await pidfdCapability();
  if (!capability.available || capability.helperPath === null) {
    return { delivered: false, mechanism: "unavailable", reason: capability.reason, errno: null };
  }

  // Narrowed into a local for the same reason as in the probe above.
  const helper: string = capability.helperPath;

  return await new Promise<PidfdSignalOutcome>((resolve) => {
    execFile(
      helper,
      ["--signal", String(pid), String(startTicks), String(signal)],
      { timeout: 5_000, windowsHide: true },
      (err: Error | null, stdout: string) => {
        const line = String(stdout ?? "").trim();
        const ok = /"ok":true/.test(line);
        const reasonMatch = /"reason":"([^"]*)"/.exec(line);
        const errnoMatch = /"value":(-?\d+)/.exec(line);
        const errno = errnoMatch === null ? null : Number(errnoMatch[1]);
        resolve({
          delivered: ok,
          mechanism: "pidfd",
          reason: ok
            ? (reasonMatch?.[1] ?? "signalled through pidfd")
            : (reasonMatch?.[1] ?? (err instanceof Error ? err.message : "the helper produced no reason")),
          errno: ok ? null : errno,
        });
      },
    );
  });
}
