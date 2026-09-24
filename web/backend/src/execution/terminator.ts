import { kill } from "node:process";

import { logger } from "../utils/logger.js";

/**
 * Send a real signal to the child PID that CAPS reported in
 * PROCESS_STARTED. Node's process.kill maps straight to kill(2); the
 * target is the actual OS process created by CAPS's fork().
 */
export function signalChild(pid: number | null, signal: NodeJS.Signals | number): { sent: boolean; reason: string | null } {
  if (pid === null || pid <= 0) return { sent: false, reason: "no child pid observed" };
  try {
    kill(pid, signal as number);
    return { sent: true, reason: null };
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ESRCH") return { sent: false, reason: "process already gone (ESRCH)" };
    logger.warn("EXECUTION", "signalChild failed", { pid, signal, code: e.code });
    return { sent: false, reason: e.message };
  }
}

/**
 * Escalate: SIGTERM first, then SIGKILL shortly after if the target is
 * still alive. CAPS's parent is blocked in waitpid(), so killing the child
 * lets caps reap it, emit its events, and exit on its own.
 */
export function terminateHard(pid: number | null, gracefulMs = 2000): void {
  if (pid === null || pid <= 0) return;
  signalChild(pid, "SIGTERM");
  setTimeout(() => {
    signalChild(pid, "SIGKILL");
  }, gracefulMs).unref?.();
}

/**
 * Kill the child and, as a fallback, the CAPS process itself so no orphan
 * can outlive the gateway's intent.
 */
export function forceKillProcessAndCaps(childPid: number | null, capsPid: number | undefined): void {
  terminateHard(childPid, 500);
  if (capsPid !== undefined) {
    setTimeout(() => {
      try {
        process.kill(capsPid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }, 1200).unref?.();
  }
}