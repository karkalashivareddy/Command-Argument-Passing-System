import { describe, expect, it } from "vitest";

import { computeAnalytics } from "../../src/analytics/service.js";
import { openDatabase } from "../../src/db/database.js";
import { SessionRepository } from "../../src/db/repositories/sessions.js";

function makeRepo(): SessionRepository {
  const db = openDatabase(":memory:");
  return new SessionRepository(db);
}

describe("computeAnalytics", () => {
  it("is empty-neutered (nulls), never fabricated, with no data", () => {
    const out = computeAnalytics(makeRepo());
    expect(out.totalExecutions).toBe(0);
    expect(out.avgDurationMs).toBeNull();
    expect(out.p50Ms).toBeNull();
    expect(out.byExitCode).toEqual({});
    expect(out.byDay).toEqual([]);
  });

  it("aggregates real terminal sessions", () => {
    const repo = makeRepo();
    const mk = (id: string, command: string, status: "COMPLETED" | "FAILED" | "TIMED_OUT", exitCode: number | null, signal: number | null, redir = false) => {
      repo.create({ id, command, args: [], redirections: {}, timeoutMs: 30000, startedAt: "2026-01-01T10:00:00.000Z" });
      if (redir) repo.recordRedirection(id, "out", "o.txt", "O_WRONLY");
      repo.finalize(id, { status, exitCode, signal, isSuccess: status === "COMPLETED" && exitCode === 0, durationMs: exitCode === 0 ? 100 : 200, pid: 1, error: null });
    };
    mk("a", "echo", "COMPLETED", 0, null, true);
    mk("b", "echo", "COMPLETED", 0, null);
    mk("c", "false", "FAILED", 1, null);
    mk("d", "sleep", "TIMED_OUT", null, 15);
    mk("e", "sleep", "FAILED", 130, 2);

    const out = computeAnalytics(repo);
    expect(out.totalExecutions).toBe(5);
    expect(out.successful).toBe(2);
    expect(out.failed).toBe(3); // status != COMPLETED or exit != 0
    expect(out.signalled).toBe(2);
    expect(out.byExitCode).toEqual({ "0": 2, "1": 1, "130": 1 });
    expect(out.bySignal).toEqual({ "2": 1, "15": 1 });
    expect(out.byCommand).toEqual({ sleep: 2, echo: 2, false: 1 });
    expect(out.redirectionUsage.out).toBe(1);
    expect(out.avgDurationMs).not.toBeNull();
    expect(out.p50Ms).not.toBeNull();
    expect(out.byDay[0]?.count).toBe(5);
    expect(out.byDay[0]?.success).toBe(2);
  });
});
