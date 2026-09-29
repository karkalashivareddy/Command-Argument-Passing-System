import { readFileSync } from "node:fs";
import { kill } from "node:process";

import { logger } from "../utils/logger.js";

/**
 * PID-reuse-safe process identity.
 *
 * A bare PID is not an identity.  Linux recycles PIDs, and the escalation path
 * for a timeout is, by design, delayed: SIGTERM now, SIGKILL in a couple of
 * seconds.  If the tracked child exits inside that window and the kernel hands
 * its PID to an unrelated process, `kill(pid, SIGKILL)` destroys something the
 * gateway never observed and never intended to touch.
 *
 * The fix is the same identity the telemetry collector already trusts: the
 * process's start time in clock ticks, read from field 22 of
 * /proc/<pid>/stat.  It is a pure kernel value, stable for the life of the
 * process, and different for every later process that reuses the PID.  A PID
 * plus its start ticks is therefore a handle that survives recycling.
 *
 * When /proc is unavailable (a non-Linux host, or a PID that has already
 * vanished) the identity cannot be established, and the escalation refuses to
 * fire rather than guessing.
 */
export interface ProcessIdentity {
  pid: number;
  /** Field 22 of /proc/<pid>/stat: start time in clock ticks since boot. */
  startTicks: number;
}

const tickCache = new Map<number, number>();

/**
 * Parse the start-time field out of a /proc/<pid>/stat line.
 *
 * Exported for tests.  The `comm` field can contain spaces *and* closing
 * parentheses, so the fields after it are located from the LAST ')' rather
 * than by counting from the first.
 */
export function parseStartTicks(text: string): number | null {
  const close = text.lastIndexOf(")");
  if (close < 0) return null;
  const rest = text.slice(close + 1).trim().split(/\s+/);
  // rest[0] is field 3 (state), so field 22 is rest[19].
  const raw = rest[19];
  if (raw === undefined || !/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}

/** Read the current identity of a PID, or null when it cannot be established. */
export function readProcessIdentity(pid: number | null): ProcessIdentity | null {
  if (pid === null || !Number.isInteger(pid) || pid <= 0) return null;
  let text: string;
  try {
    text = readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch {
    return null;
  }
  const startTicks = parseStartTicks(text);
  if (startTicks === null) return null;
  return { pid, startTicks };
}

/**
 * Remember a PID's identity the first time it is signalled.
 *
 * Caching matters for the reverse direction too: a caller that wants to
 * escalate about "the process I signalled two seconds ago" must be holding the
 * identity captured *then*, not one re-read now (which would describe whatever
 * process currently owns the PID).
 */
export function rememberIdentity(pid: number | null): ProcessIdentity | null {
  if (pid === null) return null;
  const id = readProcessIdentity(pid);
  if (id !== null) tickCache.set(pid, id.startTicks);
  return id;
}

/** The remembered identity for a PID, if one was captured. */
export function recalledIdentity(pid: number | null): ProcessIdentity | null {
  if (pid === null) return null;
  const ticks = tickCache.get(pid);
  return ticks === undefined ? null : { pid, startTicks: ticks };
}

/** Forget a PID. Called when an execution finalizes. */
export function forgetIdentity(pid: number | null): void {
  if (pid !== null) tickCache.delete(pid);
}

/** Test seam. */
export function resetIdentityCache(): void {
  tickCache.clear();
}

export type SignalResult =
  | { sent: true; reason: null; identity: ProcessIdentity | null }
  | { sent: false; reason: string; identity: ProcessIdentity | null };

/**
 * Send a signal to the CAPS-owned child, recording its identity.
 *
 * The first signal to a process establishes the identity; later signals reuse
 * it.  Signalling is allowed to proceed on a first contact (there is nothing
 * to compare against yet), which is the same trust the engine places in the
 * PID it was told about by its own monitor.
 */
export function signalChild(pid: number | null, signal: NodeJS.Signals | number): SignalResult {
  if (pid === null || pid <= 0) return { sent: false, reason: "no child pid observed", identity: null };
  const identity = rememberIdentity(pid);
  try {
    kill(pid, signal as number);
    return { sent: true, reason: null, identity };
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ESRCH") return { sent: false, reason: "process already gone (ESRCH)", identity };
    logger.warn("EXECUTION", "signalChild failed", { pid, signal, code: e.code });
    return { sent: false, reason: e.message, identity };
  }
}

/**
 * Escalate, but only to the process that was actually signalled.
 *
 * `expected` is the identity captured when the graceful signal was sent.  If
 * the PID is gone, or the start ticks no longer match, the target is not the
 * process this gateway was tracking and the escalation is refused.  Refusing
 * is always the safe choice: an un-killed workload leaks a process, whereas a
 * wrong kill destroys an unrelated one.
 */
export function escalateTo(
  expected: ProcessIdentity | null,
  signal: NodeJS.Signals = "SIGKILL",
): { sent: boolean; reason: string; identity: ProcessIdentity | null } {
  if (expected === null) {
    return { sent: false, reason: "no recorded identity; refusing to signal a bare PID", identity: null };
  }
  const current = readProcessIdentity(expected.pid);
  if (current === null) {
    return { sent: false, reason: "process is gone (no /proc entry); nothing to escalate to", identity: null };
  }
  if (current.startTicks !== expected.startTicks) {
    logger.warn(
      "SECURITY",
      "refusing to signal a recycled PID",
      { pid: expected.pid, expectedStartTicks: expected.startTicks, actualStartTicks: current.startTicks },
    );
    return {
      sent: false,
      reason:
        `PID ${expected.pid} was reused by a different process (start ticks ${expected.startTicks} -> ${current.startTicks}); refusing to signal it`,
      identity: current,
    };
  }
  try {
    kill(expected.pid, signal as unknown as number);
    return { sent: true, reason: "identity verified", identity: current };
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    return { sent: false, reason: e.code === "ESRCH" ? "process already gone (ESRCH)" : e.message, identity: current };
  }
}

/**
 * Graceful termination with a verified escalation.
 *
 * SIGTERM first, then SIGKILL after `gracefulMs` -- but the SIGKILL is sent
 * only if the identity still matches.  Returns a handle the caller can await,
 * which is what lets shutdown be a sequence rather than a race.
 */
export function terminateGracefully(
  pid: number | null,
  gracefulMs: number,
): { identity: ProcessIdentity | null; waitForEscalation: () => Promise<{ sent: boolean; reason: string }> } {
  const result = signalChild(pid, "SIGTERM");
  const identity = result.identity;

  if (!result.sent) {
    return { identity, waitForEscalation: async () => ({ sent: false, reason: result.reason ?? "not signalled" }) };
  }

  return {
    identity,
    waitForEscalation: () =>
      new Promise((resolve) => {
        const timer = setTimeout(() => {
          const outcome = escalateTo(identity, "SIGKILL");
          if (!outcome.sent) {
            logger.info("EXECUTION", "escalation skipped", { pid, reason: outcome.reason });
          }
          resolve({ sent: outcome.sent, reason: outcome.reason });
        }, Math.max(0, gracefulMs));
        timer.unref?.();
      }),
  };
}
