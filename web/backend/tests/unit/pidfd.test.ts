/**
 * Process identity: pidfd, start-ticks fallback, and confidence classification.
 *
 * The property under test is narrow and absolute: a signal must never reach a
 * process this gateway did not observe. Everything else here exists to make
 * that claim testable -- the confidence classes, the capability probe's
 * honesty, and the refusal paths.
 *
 * Every case runs against the real kernel through the real helper. A mocked
 * pidfd would prove only that the mock returns what the mock returns.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { repoRoot } from "../../src/config/env.js";
import {
  pidfdCapability,
  pidfdHelperPath,
  pidfdSignal,
  resetPidfdCapability,
  type IdentityConfidence,
} from "../../src/execution/pidfd.js";
import { escalateTo, readProcessIdentity, resetIdentityCache, signalNumber } from "../../src/execution/terminator.js";
import { processIdentityCapability } from "../../src/telemetry/capabilities.js";

const helperBuilt = existsSync(resolve(repoRoot, "build", "caps_pidfd"));

afterEach(() => {
  resetPidfdCapability();
  resetIdentityCache();
});

/** A real, long-lived child of this test process. */
interface Child {
  pid: number;
  startTicks: number;
  cleanup: () => void;
}

/** Pause long enough for the kernel to act on a signal. */
async function settle(ms = 60): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

/**
 * A real, long-lived child.
 *
 * The identity is read in a poll loop rather than once, because the pid exists
 * from fork while start ticks only settle once the exec of `sleep` has
 * happened. Reading too early yields the pre-exec identity, which is a
 * different number and would make every subsequent check compare against the
 * wrong process -- a failure that looks like a kernel bug.
 */
async function spawnChild(): Promise<Child> {
  const child = spawn("sleep", ["300"], { stdio: "ignore" });
  const pid = child.pid ?? -1;
  const deadline = Date.now() + 5_000;
  let identity = readProcessIdentity(pid);
  while (identity === null && Date.now() < deadline) {
    await settle(20);
    identity = readProcessIdentity(pid);
  }
  return {
    pid,
    startTicks: identity?.startTicks ?? -1,
    cleanup: () => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    },
  };
}
describe("the pidfd capability probe answers truthfully", () => {
  it("always reports a reason, whether or not pidfd works", async () => {
    const cap = await pidfdCapability();
    expect(cap.reason.length).toBeGreaterThan(0);
  });

  it("never claims VERIFIED when the helper is absent", async () => {
    // The helper is absent from a clean checkout until `make` runs, which is
    // exactly the case where a fabricated VERIFIED would be most damaging.
    if (helperBuilt) {
      const cap = await pidfdCapability();
      expect(["VERIFIED", "UNVERIFIED"]).toContain(cap.confidence);
    } else {
      const cap = await pidfdCapability();
      expect(cap.available).toBe(false);
      expect(cap.confidence).toBe("UNAVAILABLE");
      expect(cap.helperPath).toBeNull();
      expect(cap.reason).toMatch(/make/);
    }
  });

  it("reports the kernel it measured on, when it could", async () => {
    const cap = await pidfdCapability();
    if (cap.available) {
      expect(cap.kernel, "an available pidfd must name its kernel").toMatch(/\d+\.\d+/);
    }
  });

  it("resolves a stable helper path", () => {
    expect(pidfdHelperPath()).toMatch(/build[/\\]caps_pidfd$/);
  });
});

describe("identity confidence is classified, not assumed", () => {
  it("states the identity tuple and never leaves a reason empty", async () => {
    const capability = await processIdentityCapability();
    expect(capability.model).toBe("(pid, startTicks, bootId)");
    expect(capability.reason.length).toBeGreaterThan(0);
    expect(capability.invariant).toMatch(/bare PID/);
  });

  it("pairs VERIFIED only with the pidfd mechanism", async () => {
    const capability = await processIdentityCapability();
    if (capability.confidence === "VERIFIED") {
      expect(capability.terminationMechanism).toBe("pidfd");
    } else {
      // UNVERIFIED still terminates, using the gateway's own start-ticks check.
      expect(["start-ticks", "unavailable"]).toContain(capability.terminationMechanism);
    }
  });

  it("uses only the three documented confidence values", async () => {
    const cap = await pidfdCapability();
    const allowed: IdentityConfidence[] = ["VERIFIED", "UNVERIFIED", "UNAVAILABLE"];
    expect(allowed).toContain(cap.confidence);
  });
});

describe("a signal is never delivered to a bare PID", () => {
  it("refuses when no identity was recorded", async () => {
    const outcome = await escalateTo(null, "SIGKILL");
    expect(outcome.sent).toBe(false);
    expect(outcome.reason).toMatch(/bare PID/);
    expect(outcome.mechanism).toBe("none");
  });

  it("refuses a PID whose start ticks do not match, and the victim survives", async () => {
    const child = await spawnChild();
    try {
      expect(child.startTicks).toBeGreaterThan(0);
      const outcome = await escalateTo(
        { pid: child.pid, startTicks: (child.startTicks + 1) % 1_000_000 },
        "SIGKILL",
      );
      expect(outcome.sent, "a mismatched identity must never be signalled").toBe(false);
      // This is the assertion that matters: not merely that the call was
      // refused, but that the process is demonstrably still alive afterwards.
      expect(process.kill(child.pid, 0), "the victim must survive a refused signal").toBe(true);
    } finally {
      child.cleanup();
    }
  });

  it("refuses a PID that has already exited", async () => {
    const child = await spawnChild();
    child.cleanup();
    // Wait for the kernel to remove the /proc entry, so the refusal is
    // asserted against a genuinely absent process rather than a race.
    const deadline = Date.now() + 5_000;
    while (readProcessIdentity(child.pid) !== null && Date.now() < deadline) {
      await settle(50);
    }
    const outcome = await escalateTo({ pid: child.pid, startTicks: child.startTicks }, "SIGKILL");
    expect(outcome.sent).toBe(false);
    expect(outcome.reason).toMatch(/gone|no \/proc/);
  });

  it("refuses a PID outside the addressable range", async () => {
    const outcome = await escalateTo({ pid: 0, startTicks: 1 }, "SIGKILL");
    expect(outcome.sent).toBe(false);
  });
});

describe("signal delivery reports the mechanism that carried it", () => {
  it("delivers through the pidfd when the kernel provides one", async () => {
    if (!helperBuilt) return;
    const cap = await pidfdCapability();
    if (!cap.available) return; // platform property, not a defect

    const child = await spawnChild();
    try {
      // Signal 0, not SIGKILL: it proves the pidfd bound the right process without
    // killing it, so the same process can then be terminated for real and both
    // halves of the mechanism are observed on one target.
    const probeOutcome = await pidfdSignal(child.pid, child.startTicks, 0);
      expect(probeOutcome.mechanism).toBe("pidfd");
      expect(probeOutcome.delivered, `pidfd bind failed: ${probeOutcome.reason}`).toBe(true);
      // Signal 0 delivers nothing, so the process must survive it.
      expect(readProcessIdentity(child.pid), "signal 0 must not terminate the target").not.toBeNull();

    const killOutcome = await pidfdSignal(child.pid, child.startTicks, signalNumber("SIGKILL"));
      expect(killOutcome.mechanism).toBe("pidfd");
      expect(killOutcome.delivered, `pidfd SIGKILL failed: ${killOutcome.reason}`).toBe(true);
      // A real SIGKILL through the handle must actually terminate the process.
      const deadline = Date.now() + 5_000;
      while (readProcessIdentity(child.pid) !== null && Date.now() < deadline) {
        await settle(50);
      }
      expect(readProcessIdentity(child.pid), "SIGKILL through the pidfd must terminate").toBeNull();
    } finally {
      child.cleanup();
    }
  });

  it("reports UNAVAILABLE rather than pretending when the helper is missing", async () => {
    if (helperBuilt) return;
    const outcome = await pidfdSignal(1, 1, 9);
    expect(outcome.mechanism).toBe("unavailable");
    expect(outcome.delivered).toBe(false);
    expect(outcome.reason.length).toBeGreaterThan(0);
  });

  it("a pidfd refusal is not retried as a bare kill", async () => {
    if (!helperBuilt) return;
    const cap = await pidfdCapability();
    if (!cap.available) return;

    const child = await spawnChild();
    try {
      // Deliberately wrong identity: the helper must decline.
      const outcome = await pidfdSignal(child.pid, (child.startTicks + 999) % 1_000_000, signalNumber("SIGKILL"));
      expect(outcome.delivered).toBe(false);
      expect(outcome.mechanism).toBe("pidfd");
      expect(outcome.reason).toMatch(/recycl|identity|verif/i);
      expect(process.kill(child.pid, 0), "the victim survives a pidfd refusal").toBe(true);
    } finally {
      child.cleanup();
    }
  });
});

describe("signal numbers are resolved explicitly", () => {
  it("maps the signals the terminator actually sends", () => {
    expect(signalNumber("SIGKILL")).toBe(9);
    expect(signalNumber("SIGTERM")).toBe(15);
    expect(signalNumber("SIGINT")).toBe(2);
  });

  it("passes a numeric signal through unchanged", () => {
    expect(signalNumber(9)).toBe(9);
  });

  it("refuses an unknown signal name rather than guessing", () => {
    expect(() => signalNumber("SIGBANANA" as NodeJS.Signals)).toThrow(/unsupported/);
  });
});
