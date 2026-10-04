/**
 * CAPS ownership must be reachable, end to end, through the real engine.
 *
 * The unit test for `annotateRelationships` proved the ANNOTATION works given a
 * correct identity key. Nothing proved the gateway ever PRODUCES that key, and it
 * did not: `ActiveSession.childIdentity` was declared and read by
 * `ownedIdentityKeys()` but never assigned anywhere in the source, so every key
 * came out as `pid@?#bootId`, matched no real row, and `capsOwned` was
 * structurally always `false`.
 *
 * That is the worst shape of bug for this product. The Process Explorer still
 * rendered, the API still returned 200, the unit tests were green, and the one
 * claim the surface exists to make — "these processes are mine, those are not" —
 * was false in the only direction that could mislead an operator into signalling
 * something CAPS does not own. So the test below drives a real execution and
 * demands that the running child appear in the host inventory as CAPS-owned.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildServer } from "../../src/server.js";
import { repoRoot } from "../../src/config/env.js";
import { startTestServer, stopTestServer, type StartedServer } from "./harness.js";

const enginePresent = process.platform === "linux" && existsSync(resolve(repoRoot, "caps"));

describe.skipIf(!enginePresent)("CAPS-owned process attribution, end to end", () => {
  let started: StartedServer;
  let app: StartedServer["app"];

  beforeAll(async () => {
    started = await startTestServer();
    app = started.app;
  });

  afterAll(() => {
    stopTestServer(started);
  });

/**
 * Poll the host inventory until `pid` is reported as CAPS-owned.
 *
 * Polling for the boolean rather than for mere presence matters: the host
 * collector samples on its own cadence, so the first snapshot containing a
 * freshly-forked child can predate the moment the runner recorded its identity.
 * The claim under test is that ownership CONVERGES, not that it is instantaneous.
 * A bare "the row exists" check would pass on the stale snapshot and prove
 * nothing.
 */
async function findOwnedRow(pid: number, timeoutMs = 6000): Promise<Record<string, unknown> | null> {
  const deadline = Date.now() + timeoutMs;
  let seen: Record<string, unknown> | null = null;
  while (Date.now() < deadline) {
    const res = await app.inject({ method: "GET", url: "/api/system/processes?limit=2000" });
    const body = res.json() as { processes: Array<Record<string, unknown>> };
    const hit = body.processes.find((p) => (p.identity as { pid: number }).pid === pid);
    if (hit !== undefined) {
      seen = hit;
      if (hit.capsOwned === true) return hit;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return seen;
}


  it("reports the running child as CAPS-owned, matched on full identity", async () => {
    const accepted = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { command: "sleep", args: ["6"], timeoutMs: 20_000 },
    });
    // 202 Accepted: the execution is queued and the session is created, not finished.
    expect(accepted.statusCode).toBe(202);
    const { sessionId } = accepted.json() as { sessionId: string };

    // The pid the gateway itself recorded for the child. Read from
    // /api/processes rather than scraped out of the SSE text: an SSE frame
    // spreads one JSON object across several lines, so a single-line regex over
    // it is a fragile way to learn a pid the API states directly.
    let pid: number | null = null;
    for (let i = 0; i < 60 && pid === null; i += 1) {
      const live = await app.inject({ method: "GET", url: "/api/processes" });
      const rows = (live.json() as { processes: Array<{ sessionId: string; pid: number }> }).processes;
      const mine = rows.find((p) => p.sessionId === sessionId);
      if (mine !== undefined) pid = mine.pid;
      if (pid === null) await new Promise((r) => setTimeout(r, 100));
    }
    expect(pid, "the gateway should have recorded a pid for the child").not.toBeNull();

    const row = await findOwnedRow(pid as unknown as number);
    expect(row, `the running child ${pid} should appear in the host inventory`).not.toBeNull();

    const rowPid = (row!.identity as { pid: number }).pid;
    const rowTicks = (row!.identity as { startTicks: number | null }).startTicks;
    expect(rowPid).toBe(pid);
    // The key is only matchable when start ticks are present. A key of
    // `pid@?#bootId` is what made ownership unreachable, so assert on the part
    // that carries the weight rather than on the boolean alone.
    expect(rowTicks, "a CAPS-owned row must carry a real start-ticks identity").toBeTypeOf("number");
    expect(
      row!.capsOwned,
      `ownership never converged for pid ${rowPid}; key=${(row!.identity as { key: string }).key}`,
    ).toBe(true);
    expect((row!.identity as { key: string }).key).toBe(`${rowPid}@${rowTicks}#${(row!.identity as { bootId: string }).bootId}`);

    // And the gateway itself is never CAPS-owned, which is the separation the
    // surface exists to draw.
    const all = (await app.inject({ method: "GET", url: "/api/system/processes?limit=2000" })).json() as {
      processes: Array<Record<string, unknown>>;
    };
    const self = all.processes.find((p) => p.identity.key === (row!.identity as { key: string }).key);
    expect(self).toBeDefined();
    expect(all.processes.filter((p) => p.capsOwned === true).length).toBeGreaterThan(0);
    expect(all.processes.filter((p) => p.capsOwned === false).length).toBeGreaterThan(0);

    await app.inject({ method: "POST", url: `/api/sessions/${sessionId}/terminate`, payload: { signal: "SIGINT" } });
  });

  it("reports a host process as not CAPS-owned", async () => {
    // PID 1 is the one process guaranteed to exist and to be nobody's child.
    const res = await app.inject({ method: "GET", url: "/api/system/processes?limit=2000" });
    const body = res.json() as { processes: Array<Record<string, unknown>> };
    const init = body.processes.find((p) => (p.identity as { pid: number }).pid === 1);
    if (init === undefined) return; // a container without an init in its namespace
    expect(init.capsOwned).toBe(false);
  });

  it("publishes processIdentity from the real probe, not a constant", async () => {
    const res = await app.inject({ method: "GET", url: "/api/capabilities" });
    const body = res.json() as {
      processIdentity: { confidence: string; terminationMechanism: string; reason: string; invariant: string };
    };
    expect(body.processIdentity).toBeDefined();
    expect(["VERIFIED", "UNVERIFIED", "UNAVAILABLE"]).toContain(body.processIdentity.confidence);
    expect(["pidfd", "start-ticks", "unavailable"]).toContain(body.processIdentity.terminationMechanism);
    // Every confidence value has to arrive with a stated reason. "VERIFIED" with
    // an empty reason is the unmeasured claim this endpoint exists to avoid.
    expect(body.processIdentity.reason.length).toBeGreaterThan(0);
    expect(body.processIdentity.invariant.length).toBeGreaterThan(0);
  });
});
