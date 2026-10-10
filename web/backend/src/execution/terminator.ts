import { readFileSync } from "node:fs";
import { kill } from "node:process";

import { pidfdSignal } from "./pidfd.js";
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

/**
 * Forget a captured identity only if it is still the identity cached for that
 * PID. A completed pipeline stage may have released its PID for reuse while
 * another stage keeps the session active; stale session cleanup must not erase
 * the new owner's identity.
 */
export function forgetIdentity(identity: ProcessIdentity | null): void {
  if (identity !== null && tickCache.get(identity.pid) === identity.startTicks) {
    tickCache.delete(identity.pid);
  }
}

interface ProcessGroupIdentity {
  identity: ProcessIdentity;
  processGroupId: number;
}

/** Read the PID identity and process-group ID from the same procfs record. */
function readProcessGroupIdentity(pid: number): ProcessGroupIdentity | null {
  let stat: string;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch {
    return null;
  }
  const close = stat.lastIndexOf(")");
  if (close < 0) return null;
  const fields = stat.slice(close + 1).trim().split(/\s+/);
  const startTicks = parseStartTicks(stat);
  const processGroupId = Number(fields[2]);
  if (startTicks === null || !Number.isSafeInteger(processGroupId)) return null;
  return { identity: { pid, startTicks }, processGroupId };
}

/** Test seam. */
export function resetIdentityCache(): void {
  tickCache.clear();
}

/**
 * Which mechanism delivered (or declined to deliver) a signal.
 *
 * Recorded rather than inferred. "We sent SIGKILL" is a claim about the world;
 * "we sent SIGKILL through a kernel-bound pidfd, after the start-ticks check
 * passed" is a claim a reader can check. When the two differ -- a bare kill
 * because pidfd is unavailable, versus a pidfd refusal because the PID was
 * recycled -- collapsing them into a boolean loses the only part an operator
 * needs in order to trust the record.
 */
export type SignalMechanism = "pidfd" | "kill" | "kill-group" | "none";

/** POSIX signal numbers, so a name can be handed to the C helper. */
const SIGNAL_NUMBERS: Readonly<Record<string, number>> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGKILL: 9,
  SIGTERM: 15,
};

export function signalNumber(signal: NodeJS.Signals | number): number {
  if (typeof signal === "number") return signal;
  const n = SIGNAL_NUMBERS[signal];
  if (n === undefined) throw new Error(`unsupported signal ${signal}`);
  return n;
}

export type SignalResult =
  | { sent: true; reason: null; identity: ProcessIdentity | null; mechanism: SignalMechanism }
  | { sent: false; reason: string; identity: ProcessIdentity | null; mechanism: SignalMechanism };

/**
 * Send the FIRST, graceful signal to a CAPS-owned child and capture its
 * identity.
 *
 * Deliberately still a bare kill. This runs on the path where the gateway has
 * just forked and holds an unreaped child, so the PID provably cannot have been
 * recycled -- an unreaped child keeps its number reserved -- and a fork+exec
 * here would add latency to the common path for no additional safety.
 *
 * The identity it records is what `escalateTo` later validates and binds a
 * pidfd against, so the safety-critical signal is the one that goes through the
 * kernel handle.
 */
export function signalChild(pid: number | null, signal: NodeJS.Signals | number): SignalResult {
  if (pid === null || pid <= 0) {
    return { sent: false, reason: "no child pid observed", identity: null, mechanism: "none" };
  }
  const identity = rememberIdentity(pid);
  try {
    kill(pid, signal as number);
    return { sent: true, reason: null, identity, mechanism: "kill" };
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ESRCH") {
      return { sent: false, reason: "process already gone (ESRCH)", identity, mechanism: "none" };
    }
    logger.warn("EXECUTION", "signalChild failed", { pid, signal, code: e.code });
    return { sent: false, reason: e.message, identity, mechanism: "none" };
  }
}

/** First-signal fallback for a child whose identity was captured at start. */
function signalCapturedIdentity(expected: ProcessIdentity | null, signal: NodeJS.Signals | number): SignalResult {
  if (expected === null) {
    return { sent: false, reason: "no captured process identity", identity: null, mechanism: "none" };
  }
  const current = readProcessIdentity(expected.pid);
  if (current === null || current.startTicks !== expected.startTicks) {
    return {
      sent: false,
      reason: `PID ${expected.pid} is gone or no longer has its captured identity; refusing to signal it`,
      identity: current,
      mechanism: "none",
    };
  }
  try {
    kill(expected.pid, signal as number);
    return { sent: true, reason: null, identity: expected, mechanism: "kill" };
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    return {
      sent: false,
      reason: e.code === "ESRCH" ? "process already gone (ESRCH)" : e.message,
      identity: expected,
      mechanism: "none",
    };
  }
}

async function escalateTrackedIdentities(
  identities: readonly ProcessIdentity[],
  signal: NodeJS.Signals,
): Promise<{ sent: boolean; reason: string; mechanism: SignalMechanism }> {
  let lastReason = "no tracked process identity was available for escalation";
  for (const identity of identities) {
    const outcome = await escalateTo(identity, signal);
    if (outcome.sent) return { sent: true, reason: outcome.reason, mechanism: outcome.mechanism };
    lastReason = outcome.reason;
  }
  return { sent: false, reason: lastReason, mechanism: "none" };
}

/**
 * Escalate, binding the target with a pidfd where the kernel provides one.
 *
 * Two independent guards, applied in this order, and the order is the point:
 *
 *   1. pidfd_open(pid) binds a kernel handle to whoever holds the PID now.
 *   2. start ticks are compared against the identity captured at SIGTERM time.
 *   3. only then is the signal sent, through the handle.
 *
 * A pidfd is a kernel reference to one process. The kernel never re-points it,
 * even if the PID is recycled, so a signal sent through it cannot reach an
 * unrelated process; if the original exited, the call fails with ESRCH. That
 * is the primary guarantee. The start-ticks comparison in step 2 is a second,
 * independent check that also works where pidfd does not exist.
 *
 * When pidfd is unavailable the validated `kill` path runs instead, and the
 * returned mechanism says so. When pidfd IS available and declines, there is
 * deliberately no fallback: the kernel has just told us the target is not the
 * process we tracked, and a bare kill would discard exactly the information
 * that made the refusal safe.
 *
 * Refusing is always the safe direction. An un-killed workload leaks a process,
 * which is visible and recoverable; a wrong kill destroys something the gateway
 * never observed, which is neither.
 */
export async function escalateTo(
  expected: ProcessIdentity | null,
  signal: NodeJS.Signals = "SIGKILL",
): Promise<{ sent: boolean; reason: string; identity: ProcessIdentity | null; mechanism: SignalMechanism }> {
  if (expected === null) {
    return {
      sent: false,
      reason: "no recorded identity; refusing to signal a bare PID",
      identity: null,
      mechanism: "none",
    };
  }

  // Cheap pre-check, so the common "already gone" case never forks a helper.
  const current = readProcessIdentity(expected.pid);
  if (current === null) {
    return {
      sent: false,
      reason: "process is gone (no /proc entry); nothing to escalate to",
      identity: null,
      mechanism: "none",
    };
  }

  const viaPidfd = await pidfdSignal(expected.pid, expected.startTicks, signalNumber(signal));

  if (viaPidfd.mechanism === "pidfd") {
    if (viaPidfd.delivered) {
      return { sent: true, reason: viaPidfd.reason, identity: current, mechanism: "pidfd" };
    }
    logger.warn("SECURITY", "pidfd refused a signal; not falling back to a bare kill", {
      pid: expected.pid,
      reason: viaPidfd.reason,
      errno: viaPidfd.errno,
    });
    return { sent: false, reason: viaPidfd.reason, identity: current, mechanism: "pidfd" };
  }

  logger.info("EXECUTION", "escalating without pidfd; start-ticks identity was verified", {
    pid: expected.pid,
    reason: viaPidfd.reason,
  });
  if (current.startTicks !== expected.startTicks) {
    logger.warn("SECURITY", "refusing to signal a recycled PID", {
      pid: expected.pid,
      expectedStartTicks: expected.startTicks,
      actualStartTicks: current.startTicks,
    });
    return {
      sent: false,
      reason:
        `PID ${expected.pid} was reused by a different process (start ticks ${expected.startTicks} -> ${current.startTicks}); refusing to signal it`,
      identity: current,
      mechanism: "none",
    };
  }
  try {
    kill(expected.pid, signal as unknown as number);
    return { sent: true, reason: "identity verified by start ticks", identity: current, mechanism: "kill" };
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    return {
      sent: false,
      reason: e.code === "ESRCH" ? "process already gone (ESRCH)" : e.message,
      identity: current,
      mechanism: "none",
    };
  }
}
/**
 * Signal an entire process group after verifying a live tracked member.
 *
 * WHY THIS EXISTS
 * ---------------
 * The engine already puts every stage of a pipeline into one process group
 * (src/process.c: stage 0 calls setpgid(0,0) and the rest join it), and records
 * that pgid on every per-stage event. The group was then used as EVIDENCE only:
 * both the timeout path and the terminate path called kill() on a single PID.
 * Two things followed from that, and both were wrong in a way a reviewer notices:
 *
 *   1. `runner.observe` sets `childPid` on every `process.started`, so for an
 *      N-stage pipeline the gateway's kill handle was the LAST stage's PID.
 *      A timeout could leave stages 0..N-2 running, and the session would be
 *      finalised as TIMED_OUT while they were still executing.
 *   2. The documented claim -- published verbatim by GET /api/terminal/grammar --
 *      was "a timeout or a signal reaches the whole pipeline". It did not.
 *
 * WHY IT IS SAFE TO SIGNAL A NEGATIVE PID
 * ---------------------------------------
 * `kill(-pgid, sig)` has no identity check of its own. This function checks the
 * single procfs record for each CAPS-reported stage until it finds a still-live
 * PID whose start ticks match the captured identity and whose pgrp is `pgid`.
 * Requiring a live tracked member also handles the ordinary pipeline case where
 * stage zero exited before a later timeout. A procfs check and kill(2) cannot be
 * atomic; group signaling retains that narrow Linux process-group reuse race.
 *
 *   - the member's start ticks must equal ticks CAPS recorded for that stage;
 *   - its own pgrp field must equal the group being addressed;
 *   - the group id must be strictly greater than 1, so a bug can never produce
 *     `kill(-1)` (which would signal every process the gateway may signal).
 *
 * If no member verifies, nothing is signalled and the caller is told why, so
 * the captured-identity single-process fallback can be considered.
 *
 * pidfd cannot address a process group -- the kernel handle is per-process -- so
 * this path is necessarily a kill(2). It is recorded as such: `mechanism` says
 * `kill-group`, never `pidfd`, so the audit record never claims a kernel-bound
 * verification it did not get. A live reported member's identity was checked
 * first.
 */
export function signalProcessGroup(
  pgid: number | null,
  members: readonly ProcessIdentity[],
  signal: NodeJS.Signals | number,
): SignalResult {
  if (pgid === null || pgid <= 1) {
    return { sent: false, reason: "no verified process group", identity: null, mechanism: "none" };
  }
  if (members.length === 0) {
    return {
      sent: false,
      reason: "process group observed but no member identities were recorded",
      identity: null,
      mechanism: "none",
    };
  }

  const member = members.find((expected) => {
    const current = readProcessGroupIdentity(expected.pid);
    return current !== null && current.identity.startTicks === expected.startTicks && current.processGroupId === pgid;
  });
  if (member === undefined) {
    return {
      sent: false,
      reason: `no live CAPS-reported process remains in process group ${pgid}`,
      identity: null,
      mechanism: "none",
    };
  }

  try {
    kill(-pgid, signal as number);
    return { sent: true, reason: null, identity: member, mechanism: "kill-group" };
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    return {
      sent: false,
      reason: e.code === "ESRCH" ? "process group is empty (ESRCH)" : e.message,
      identity: member,
      mechanism: "none",
    };
  }
}

/**
 * Graceful termination with a verified escalation.
 *
 * SIGTERM first, then SIGKILL after `gracefulMs` -- but the SIGKILL is sent
 * only if the identity still matches.  Returns a handle the caller can await,
 * which is what lets shutdown be a sequence rather than a race.
 *
 * `group` is optional and preferred when present and provable. Both the initial
 * signal and delayed escalation address the group, validating a live tracked
 * stage each time. This prevents an exited first stage from reducing timeout
 * handling to the last PID alone.
 */
export function terminateGracefully(
  pid: number | null,
  gracefulMs: number,
  options: { signal?: NodeJS.Signals; group?: { pgid: number | null; members: readonly ProcessIdentity[] } | null } = {},
): {
  identity: ProcessIdentity | null;
  first: SignalResult;
  waitForEscalation: () => Promise<{ sent: boolean; reason: string; mechanism: SignalMechanism }>;
} {
  /*
   * The first signal is the caller's, not SIGTERM.
   *
   * This function used to take no signal at all and always sent SIGTERM, which
   * was correct only because it had exactly one caller and that caller wanted
   * SIGTERM. When the group path was added, the terminate API's own signal --
   * SIGINT, as the tests and the UI request -- was being replaced by SIGTERM on
   * the way through. A user asking for SIGINT got SIGTERM, and the session was
   * recorded as `exit_code 143` instead of `130`, which is the shell convention
   * for a signal the caller never asked to send. The escalation is always
   * SIGKILL and stays hardcoded below.
   */
  const signal: NodeJS.Signals = options.signal ?? "SIGTERM";
  const asGroup = options.group ? signalProcessGroup(options.group.pgid, options.group.members, signal) : null;
  const capturedTarget = options.group?.members.find((member) => member.pid === pid) ?? null;
  const result = asGroup !== null && asGroup.sent
    ? asGroup
    : options.group
      ? signalCapturedIdentity(capturedTarget, signal)
      : signalChild(pid, signal);
  const identity = result.identity;

  if (!result.sent) {
    return {
      identity,
      first: result,
      waitForEscalation: async () => ({
        sent: false,
        reason: result.reason ?? "not signalled",
        mechanism: result.mechanism,
      }),
    };
  }

  // Escalation targets the recorded PID: it is the one whose identity exists to
  // be checked, and pidfd cannot address a group.
  const escalationTarget = pid ?? identity?.pid ?? null;

  return {
    identity,
    first: result,
    waitForEscalation: () =>
      new Promise((resolve) => {
        const timer = setTimeout(() => {
          const escalation = options.group
            ? signalProcessGroup(options.group.pgid, options.group.members, "SIGKILL").sent
              ? Promise.resolve({ sent: true, reason: "SIGKILL delivered to the verified process group", mechanism: "kill-group" as const })
              : escalateTrackedIdentities(options.group.members, "SIGKILL")
            : escalateTo(escalationTarget !== null && identity !== null
              ? { pid: escalationTarget, startTicks: identity.startTicks }
              : null, "SIGKILL");
          void escalation.then(
            (outcome) => {
              if (!outcome.sent) {
                logger.info("EXECUTION", "escalation skipped", {
                  pid: escalationTarget,
                  reason: outcome.reason,
                  mechanism: outcome.mechanism,
                });
              } else {
                logger.info("EXECUTION", "escalation delivered", {
                  pid: escalationTarget,
                  mechanism: outcome.mechanism,
                });
              }
              // The mechanism travels with the outcome, so a caller recording
              // "terminated" also records HOW it was terminated.
              resolve({ sent: outcome.sent, reason: outcome.reason, mechanism: outcome.mechanism });
            },
          );
        }, Math.max(0, gracefulMs));
        timer.unref?.();
      }),
  };
}
