/**
 * The thermal guard must be ON THE EXECUTION PATH, not merely implemented.
 *
 * `thermalGuard.test.ts` proves the decision table is correct: which action
 * fires at which threshold, that an absent sensor yields UNAVAILABLE, that a
 * malformed sensor file is refused rather than interpreted. Every one of those
 * assertions would keep passing forever if nothing ever called
 * `evaluateThermalGuard` during a real execution -- and that is exactly the
 * state this repository was in. The guard module was complete, the API published
 * its configuration as though it were in force, the unit tests were green, and
 * `CAPS_THERMAL_GUARD_ENABLED=true` never read a sensor, never evaluated a
 * threshold, and never refused a workload.
 *
 * So the property under test here is the WIRING, and the sensor reading is
 * deliberately substituted for exactly that reason. The guard's own arithmetic
 * is covered elsewhere; what had no coverage at all was "does starting a
 * workload go through the guard", and only a substituted decision can answer
 * that on a machine with no thermal sensor.
 *
 * What is asserted is deliberately narrow and behavioural:
 *
 *   - a REFUSE_* decision spawns nothing;
 *   - the refusal is recorded, not merely returned, so it is auditable from the
 *     event stream and from the session row without asking the process that
 *     returned it;
 *   - an ALLOW decision spawns and runs normally, so the guard is an admission
 *     gate and not an accidental execution blocker;
 *   - the recorded decision names the sensor and the raw value, so a reader can
 *     re-check it against sysfs by hand;
 *   - UNAVAILABLE is carried through as UNAVAILABLE and never as a temperature.
 */

import { existsSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_THERMAL_GUARD, type ThermalDecisionRecord } from "../../src/execution/thermalGuard.js";
import { repoRoot } from "../../src/config/env.js";

/**
 * Substitute only the admission decision.
 *
 * `importOriginal` keeps every other export real, because `api/routes.ts` uses
 * `inspectThermalGuard` to publish the guard's state and a whole-module stub
 * would break an unrelated endpoint and hide the real behaviour.
 */
const evaluate = vi.hoisted(() => vi.fn<(options: unknown) => ThermalDecisionRecord>());
vi.mock("../../src/execution/thermalGuard.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/execution/thermalGuard.js")>();
  return { ...actual, evaluateThermalGuard: evaluate };
});

const enginePresent = process.platform === "linux" && existsSync(resolve(repoRoot, "caps"));

const SENSOR = {
  name: "x86_pkg_temp",
  path: "/sys/class/thermal/thermal_zone0/temp",
  sourceClass: "thermal_zone" as const,
  isPackage: true,
  selectionReason: "test fixture",
};

function record(overrides: Partial<ThermalDecisionRecord> & Pick<ThermalDecisionRecord, "decision">): ThermalDecisionRecord {
  const refused = overrides.decision === "REFUSE_TERM" || overrides.decision === "REFUSE_KILL";
  return {
    action: refused ? "TERM" : "WARN",
    threshold: refused ? { kind: "warning", celsius: 80 } : null,
    sensor: SENSOR,
    reading: {
      rawMilliCelsius: 91000,
      celsius: 91,
      timestamp: "2026-01-01T00:00:00.000Z",
      source: SENSOR.path,
      provenance: "OBSERVED",
    },
    timestamp: "2026-01-01T00:00:00.000Z",
    target: { kind: "CAPS_WORKLOAD", workloadId: null, sessionId: null },
    result: refused ? "TERM_SENT" : "NONE",
    reason: `91 °C on "${SENSOR.name}" (${SENSOR.path}) is at or above the warning threshold of 80 °C.`,
    ...overrides,
  };
}

describe.skipIf(!enginePresent)("the thermal guard is consulted by the real execution path", () => {
  let app: FastifyInstance;
  let root: string;

  beforeAll(async () => {
    const { buildServer } = await import("../../src/server.js");
    root = mkdtempSync(join(tmpdir(), "caps-thermal-admission-"));
    const built = await buildServer({
      dbPath: join(root, "caps.db"),
      config: {
        host: "127.0.0.1",
        port: 0,
        capsExecutable: resolve(repoRoot, "caps"),
        workspace: join(root, "work"),
        maxConcurrent: 4,
        defaultTimeoutMs: 20_000,
        maxTimeoutMs: 60_000,
        maxOutputBytes: 64 * 1024,
        // Enabled for real. The decision is substituted, but the configuration
        // is the shipped one with the flag on, so the test also fails if the
        // wiring is gated behind a flag nobody sets.
        thermalGuard: { ...DEFAULT_THERMAL_GUARD, enabled: true },
      },
    });
    app = built.app;
    await app.ready();
    // `buildServer` starts the host collector, whose first pass enumerates and
    // reads every /proc entry on the host. That is the product doing its job,
    // not a slow test, so the hook budget is stated rather than left at the
    // 20s default that a busy CI runner exceeds.
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    rmSync(root, { recursive: true, force: true });
  });

  beforeEach(() => {
    evaluate.mockReset();
  });

  async function postSession(): Promise<{ statusCode: number; body: unknown }> {
    const res = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { command: "sleep", args: ["1"], timeoutMs: 10_000 },
    });
    return { statusCode: res.statusCode, body: res.json() };
  }

/**
 * The persisted event stream, via replay.
 *
 * Replay rather than /events on purpose: /events is the SSE endpoint, so it
 * answers with a text/event-stream body. The audit question here is "what is
 * durably recorded", and replay is the read-only view of exactly that -- which
 * is also the view a user opens to find out why a workload was refused.
 */
async function eventsOf(sessionId: string): Promise<Array<{ type: string; payload: Record<string, unknown> }>> {
    const res = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/replay` });
    const body = res.json() as { events: Array<{ type: string; payload: Record<string, unknown> }> };
    return body.events;
}

  it("refuses to start a CAPS-owned workload and spawns nothing", async () => {
    evaluate.mockReturnValue(record({ decision: "REFUSE_TERM" }));

    const { statusCode, body } = await postSession();
    expect(statusCode).toBe(503);
    const error = (body as { error: { code: string; message: string } }).error;
    expect(error.code).toBe("THERMAL_REFUSED");
    expect(error.message).toMatch(/thermal guard/i);
    expect(error.message).toMatch(/91 °C/);

    /*
     * The guard was consulted for THIS request. Asserting the substitution was
     * called proves the execution path reached the guard at all, which is the
     * regression this file exists for.
     */
    expect(evaluate).toHaveBeenCalledTimes(1);
    const options = evaluate.mock.calls[0]![0] as { config: { enabled: boolean }; target: { sessionId: string } };
    expect(options.config.enabled).toBe(true);
    expect(options.target.sessionId).toMatch(/^exec_/);
  });

  it("records the refusal so it is auditable without the process that returned it", async () => {
    evaluate.mockReturnValue(record({ decision: "REFUSE_KILL", action: "TERM_THEN_KILL", result: "TERM_THEN_KILL_SENT" }));

    const { statusCode } = await postSession();
    expect(statusCode).toBe(503);

    // The refusal path deliberately returns no session id to the caller, so the
    // id is recovered from the guard's own target -- which is itself part of
    // what is being audited: the decision record names the workload it was
    // about, before any session row existed.
    const audited = evaluate.mock.calls.at(-1)![0] as { target: { sessionId: string } };
    expect(audited.target.sessionId).toMatch(/^exec_/);

    const events = await eventsOf(audited.target.sessionId);
    const created = events.find((e) => e.type === "execution.created");
    const failed = events.find((e) => e.type === "execution.failed");

    // Durable and complete: a session exists, and it has a beginning and an end.
    expect(created, "the refused execution must be recorded, not silently dropped").toBeDefined();
    expect(failed).toBeDefined();

    const guard = created!.payload.thermalGuard as Record<string, unknown>;
    expect(guard.decision).toBe("REFUSE_KILL");
    expect(guard.action).toBe("TERM_THEN_KILL");
    // The sensor and the raw value travel with the decision, so it can be
    // re-checked against sysfs by hand.
    expect(guard.sensorPath).toBe(SENSOR.path);
    expect(guard.rawMilliCelsius).toBe(91000);
    expect(guard.celsius).toBe(91);
    expect(guard.threshold).toBe("warning");
    expect(guard.thresholdCelsius).toBe(80);
    expect(guard.reason).toMatch(/91 °C/);

    // The terminal event names who refused it, so a reader replaying the stream
    // is never left to infer the cause from the failure alone.
    expect(failed!.payload.refusedBy).toBe("thermal-guard");
    expect((failed!.payload.thermalGuard as Record<string, unknown>).decision).toBe("REFUSE_KILL");

    // And no process was ever created for it.
    const live = (await app.inject({ method: "GET", url: "/api/processes" })).json() as {
      processes: Array<{ sessionId: string }>;
    };
    expect(live.processes.find((p) => p.sessionId === audited.target.sessionId)).toBeUndefined();

    // The session row is the flat record the route returns, not a wrapper.
    const row = (await app.inject({ method: "GET", url: `/api/sessions/${audited.target.sessionId}` })).json() as {
      status: string; pid: number | null; error: string | null;
    };
    expect(row.status).toBe("FAILED");
    expect(row.pid, "a refused workload must have no pid: nothing was forked").toBeNull();
    expect(row.error).toMatch(/thermal/i);
  });

  it("admits and runs the workload when the guard allows it", async () => {
    evaluate.mockReturnValue(record({ decision: "ALLOW", reason: "41 °C is below the warning threshold of 80 °C." }));

    const res = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { command: "sleep", args: ["1"], timeoutMs: 15_000 },
    });
    expect(res.statusCode).toBe(202);
    const { sessionId } = res.json() as { sessionId: string };

    // The decision is recorded on the allowed path too. "Why did this workload
    // start?" has to be answerable, not only "why did that one not".
    const created = (await eventsOf(sessionId)).find((e) => e.type === "execution.created");
    expect(created).toBeDefined();
    expect((created!.payload.thermalGuard as Record<string, unknown>).decision).toBe("ALLOW");

    // And it really ran: the guard is an admission gate, not a blocker.
    const deadline = Date.now() + 15_000;
    let status = "STARTING";
    while (Date.now() < deadline) {
      const row = (await app.inject({ method: "GET", url: `/api/sessions/${sessionId}` })).json() as { status: string };
      status = row.status;
      if (status === "COMPLETED" || status === "FAILED") break;
      await new Promise((r) => setTimeout(r, 150));
    }
    expect(status).toBe("COMPLETED");
  });

  it("carries UNAVAILABLE through as UNAVAILABLE and never as a temperature", async () => {
    /*
     * A host with no sensor. The workload runs -- refusing everything on a
     * machine without a thermal sensor would make CAPS unusable under WSL2 and
     * in most VMs, while claiming a safety property it does not have -- but the
     * admission must carry no thermal justification, and no number may appear
     * where a measurement would.
     */
    evaluate.mockReturnValue(
      record({
        decision: "UNAVAILABLE_ALLOW",
        sensor: null,
        threshold: null,
        reading: {
          rawMilliCelsius: null,
          celsius: null,
          timestamp: "2026-01-01T00:00:00.000Z",
          source: "/sys/class/thermal, /sys/class/hwmon",
          provenance: "UNAVAILABLE",
          reason: "this host exposes no readable temperature sensor",
        },
        reason:
          "The thermal guard is enabled but could not operate: this host exposes no readable temperature sensor. " +
          "The workload was admitted because an absent sensor is not evidence of a hot machine, but this admission carries NO thermal justification.",
      }),
    );

    const res = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { command: "sleep", args: ["1"], timeoutMs: 15_000 },
    });
    expect(res.statusCode).toBe(202);
    const { sessionId } = res.json() as { sessionId: string };

    const guard = ((await eventsOf(sessionId)).find((e) => e.type === "execution.created")!.payload.thermalGuard ?? {}) as Record<string, unknown>;
    expect(guard.decision).toBe("UNAVAILABLE_ALLOW");
    expect(guard.readingProvenance).toBe("UNAVAILABLE");
    // Not 0. Not null-with-a-defaulted-zero-somewhere. Null, and it stays null.
    expect(guard.celsius).toBeNull();
    expect(guard.rawMilliCelsius).toBeNull();
    expect(guard.sensor).toBeNull();
    expect(guard.sensorPath).toBeNull();
    expect(guard.threshold).toBeNull();
    expect(guard.reason).toMatch(/NO thermal justification/);
  });

  it("still admits when the guard is disabled, and says so", async () => {
    // The substitution stands in for the reading; the decision is what the
    // runner sees. DISABLED must not be mistaken for a refusal.
    evaluate.mockReturnValue(record({ decision: "DISABLED" }));
    const { statusCode } = await postSession();
    expect(statusCode).toBe(202);
  });
});
