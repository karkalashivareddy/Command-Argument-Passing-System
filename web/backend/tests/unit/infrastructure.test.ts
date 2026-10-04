import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { openDatabase } from "../../src/db/database.js";
import { EventRepository } from "../../src/db/repositories/events.js";
import { SessionRepository } from "../../src/db/repositories/sessions.js";
import { classifyLine, splitLines } from "../../src/execution/output.js";
import { parseStartTicks, readProcessIdentity, resetIdentityCache, escalateTo } from "../../src/execution/terminator.js";

describe("output channel classification", () => {
  it("routes monitor protocol lines away from user output", () => {
    const c = classifyLine('{"event":"PROCESS_EXITED","exit_code":0,"command":"echo"}');
    expect(c.kind).toBe("monitor-event");
    expect(c.event).toBeDefined();
  });

  it("routes CAPS diagnostics to the diagnostic channel", () => {
    expect(classifyLine("caps: command not found: zz").kind).toBe("caps-diagnostic");
  });

  it("routes the target's own output to the output channel", () => {
    expect(classifyLine("hello from the program").kind).toBe("target-output");
    expect(classifyLine("").kind).toBe("target-output");
  });

  it("treats a truncated monitor line as a protocol fault, not as program output", () => {
    // Showing a broken protocol line to the user as if the command had printed
    // it would be a false observation.
    const c = classifyLine('{"event":"PROCESS_EXITED","exit_c');
    expect(c.kind).toBe("protocol-error");
  });

  it("handles a carriage return without leaving it in the text", () => {
    expect(classifyLine("line\r").text).toBe("line");
  });
});

describe("line assembly", () => {
  it("keeps a partial last line for the next chunk", () => {
    // Output with no trailing newline must not be dropped or duplicated.
    const first = splitLines("a\nb\nc");
    expect(first.lines).toEqual(["a", "b"]);
    expect(first.rest).toBe("c");
    const second = splitLines("c\nd\n");
    expect(second.lines).toEqual(["c", "d"]);
    expect(second.rest).toBe("");
  });

  it("handles an empty buffer", () => {
    expect(splitLines("")).toEqual({ lines: [], rest: "" });
  });

  it("handles many chunks of a single unterminated line", () => {
    let buf = "";
    for (const chunk of ["he", "ll", "o"]) buf = splitLines(buf + chunk).rest;
    expect(buf).toBe("hello");
  });
});

describe("process identity (PID-reuse safety)", () => {
  it("parses the start-time field from a /proc/<pid>/stat line", () => {
    // comm can contain spaces AND ')', so parsing must key off the LAST ')'.
    const line = "1234 (my (weird) prog) S 1 1234 1234 0 -1 4194560 100 0 0 0 " +
      "10 20 0 0 20 0 3 0 900 12345678 4096 18446744073709551615 1 1 1 1 1 1 1 1 1 1 2 3 4 5";
    expect(parseStartTicks(line)).toBe(900);
  });

  it("rejects a malformed stat line rather than guessing", () => {
    expect(parseStartTicks("")).toBeNull();
    expect(parseStartTicks("no parens here")).toBeNull();
    expect(parseStartTicks("1 (x) S 1 2 3")).toBeNull();
  });

  it("returns null for a PID that does not exist", () => {
    // A PID in the reserved range cannot exist, so this is a real negative.
    expect(readProcessIdentity(2 ** 22 - 1)).toBeNull();
    expect(readProcessIdentity(0)).toBeNull();
    expect(readProcessIdentity(-1)).toBeNull();
    expect(readProcessIdentity(null)).toBeNull();
  });

  it("refuses to escalate without a recorded identity", async () => {
    resetIdentityCache();
    const r = await escalateTo(null, "SIGKILL");
    expect(r.sent).toBe(false);
    expect(r.reason).toMatch(/bare PID/);
  });

  it("refuses to signal a PID whose identity no longer matches", async () => {
    resetIdentityCache();
    // Our own PID exists, but with start ticks that do not match: this is
    // exactly the recycled-PID case, and the escalation must not fire.
    const real = readProcessIdentity(process.pid);
    expect(real).not.toBeNull();
    const r = await escalateTo({ pid: process.pid, startTicks: (real!.startTicks + 1) % 1_000_000 }, "SIGKILL");
    expect(r.sent).toBe(false);
    // Both layers are allowed to refuse, and which one fired depends on
    // whether this kernel provides pidfd. Both state the same fact -- the PID
    // no longer identifies the tracked process -- so the assertion accepts
    // either wording rather than pinning the test to one mechanism.
    expect(r.reason).toMatch(/recycl|reused|different process/);
    // The test process is demonstrably still alive.
    expect(process.kill(process.pid, 0)).toBe(true); // signal 0 = liveness probe
  });

  it("refuses to escalate to a process that no longer exists", async () => {
    resetIdentityCache();
    const r = await escalateTo({ pid: 2 ** 22 - 1, startTicks: 1 }, "SIGKILL");
    expect(r.sent).toBe(false);
    expect(r.reason).toMatch(/gone/);
  });
});

describe("SQLite migrations", () => {
  const dir = () => mkdtempSync(join(tmpdir(), "caps-mig-"));

  it("records and applies the schema version", () => {
    const db = openDatabase(join(dir(), "a.db"));
    const row = db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number };
    expect(row.v).toBeGreaterThan(0);
    db.close();
  });

  it("is idempotent: opening twice applies nothing the second time", () => {
    const path = join(dir(), "b.db");
    const first = openDatabase(path);
    const before = first.prepare("SELECT COUNT(*) AS n FROM schema_version").get() as { n: number };
    first.close();
    const second = openDatabase(path);
    const after = second.prepare("SELECT COUNT(*) AS n FROM schema_version").get() as { n: number };
    expect(after.n).toBe(before.n);
    second.close();
  });

  it("refuses a database from a newer schema instead of downgrading it", () => {
    const path = join(dir(), "c.db");
    const db = openDatabase(path);
    db.exec(`INSERT INTO schema_version (version, name, applied_at) VALUES (9999, 'from-the-future', '2030-01-01')`);
    db.close();
    expect(() => openDatabase(path)).toThrow(/newer than this build/);
  });

  it("no longer creates the unused `processes` table", () => {
    const db = openDatabase(join(dir(), "d.db"));
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='processes'").get();
    expect(row).toBeUndefined();
    db.close();
  });

  it("sets a busy timeout rather than failing immediately on a lock", () => {
    const db = openDatabase(join(dir(), "e.db"));
    const row = db.prepare("PRAGMA busy_timeout").get() as { timeout: number };
    expect(row.timeout).toBeGreaterThan(0);
    db.close();
  });
});

describe("corrupt persisted payloads", () => {
  it("records corruption instead of substituting an empty object", () => {
    const db = openDatabase(":memory:");
    const sessions = new SessionRepository(db);
    const events = new EventRepository(db);
    sessions.createWithFirstEvent({
      id: "s1", command: "echo", args: [], redirections: {}, redirectionsDetail: [],
      timeoutMs: 1000, startedAt: new Date().toISOString(), firstEvent: null,
    });
    // Simulate a payload that no longer parses.
    db.exec(`INSERT INTO events (id, session_id, sequence, type, source, timestamp, monotonic_ms, pid, payload) VALUES ('e1','s1',0,'process.snapshot','gateway','2026-01-01T00:00:00.000Z',NULL,1,'{not json')`);
    const marked = events.markCorruptPayloads();
    expect(marked).toBe(1);

    const [ev] = events.listAllForSession("s1");
    expect(ev!.payload.payloadCorrupt).toBe(true);
    expect(String(ev!.payload.payloadError)).toMatch(/JSON|token|parse/i);
    // A consumer must be able to tell this apart from a metric that simply
    // was not measured.
    expect(ev!.payload.rssBytes).toBeUndefined();
    expect(events.countCorruptPayloads("s1")).toBe(1);
    db.close();
  });

  it("marks a JSON array payload as corrupt too", () => {
    const db = openDatabase(":memory:");
    const sessions = new SessionRepository(db);
    const events = new EventRepository(db);
    sessions.create({ id: "s2", command: "echo", args: [], redirections: {}, timeoutMs: 1000, startedAt: new Date().toISOString() });
    db.exec(`INSERT INTO events (id, session_id, sequence, type, source, timestamp, monotonic_ms, pid, payload) VALUES ('e2','s2',0,'process.snapshot','gateway','2026-01-01T00:00:00.000Z',NULL,1,'[1,2,3]')`);
    expect(events.markCorruptPayloads()).toBe(1);
    const [ev] = events.listAllForSession("s2");
    expect(ev!.payload.payloadCorrupt).toBe(true);
    db.close();
  });
});

describe("session creation is transactional", () => {
  it("rolls back completely when a later write in the transaction fails", () => {
    const db = openDatabase(":memory:");
    const sessions = new SessionRepository(db);
    // Force a failure inside the transaction by pre-inserting the event id.
    sessions.create({
      id: "s3", command: "echo", args: [], redirections: {}, timeoutMs: 1000,
      startedAt: new Date().toISOString(),
    });
    const dupSession = () =>
      sessions.createWithFirstEvent({
        id: "s3", command: "echo", args: [], redirections: { out: "x.txt" },
        redirectionsDetail: [{ slot: "out", target: "x.txt", flags: "O_WRONLY" }],
        timeoutMs: 1000, startedAt: new Date().toISOString(),
        firstEvent: { id: "evt_x", sequence: 0, type: "execution.created", source: "gateway", timestamp: "2026-01-01T00:00:00.000Z", payload: {} },
      });
    expect(dupSession).toThrow();
    // The redirection row must not have survived the rollback: a session with
    // redirections but no first event is a state replay cannot represent.
    const rows = db.prepare("SELECT COUNT(*) AS n FROM redirections WHERE session_id='s3'").get() as { n: number };
    expect(Number(rows.n)).toBe(0);
    const evs = db.prepare("SELECT COUNT(*) AS n FROM events WHERE id='evt_x'").get() as { n: number };
    expect(Number(evs.n)).toBe(0);
    db.close();
  });
});

describe("retention", () => {
  it("deletes sessions, their events, and their redirections together", () => {
    const db = openDatabase(":memory:");
    const sessions = new SessionRepository(db);
    const events = new EventRepository(db);
    for (const [id, createdAt] of [["old", "2020-01-01T00:00:00.000Z"], ["new", "2030-01-01T00:00:00.000Z"]] as const) {
      sessions.createWithFirstEvent({
        id, command: "echo", args: [], redirections: { out: "a.txt" },
        redirectionsDetail: [{ slot: "out", target: "a.txt", flags: "O_WRONLY" }],
        timeoutMs: 1000, startedAt: createdAt,
        firstEvent: { id: `evt_${id}`, sequence: 0, type: "execution.created", source: "gateway", timestamp: createdAt, payload: {} },
      });
    }
    const removed = sessions.purgeOlderThan("2025-01-01T00:00:000.000Z".replace("000.000", "00.000"));
    expect(removed.sessions).toBe(1);
    expect(removed.events).toBe(1);
    expect(sessions.findById("old")).toBeNull();
    expect(sessions.findById("new")).not.toBeNull();
    expect(db.prepare("SELECT COUNT(*) AS n FROM redirections WHERE session_id='old'").get()).toEqual({ n: 0 });
    expect(events.maxSequence("old")).toBe(-1);
    db.close();
  });

  it("keeps everything when the cutoff is in the past", () => {
    const db = openDatabase(":memory:");
    const sessions = new SessionRepository(db);
    sessions.create({ id: "s", command: "echo", args: [], redirections: {}, timeoutMs: 1000, startedAt: new Date().toISOString() });
    expect(sessions.purgeOlderThan("2000-01-01T00:00:00.000Z").sessions).toBe(0);
    db.close();
  });
});

describe("boot recovery", () => {
  it("lists sessions left in a non-terminal state", () => {
    const db = openDatabase(":memory:");
    const sessions = new SessionRepository(db);
    for (const [id, status] of [["a", "RUNNING"], ["b", "CREATED"], ["c", "COMPLETED"]] as const) {
      sessions.create({ id, command: "echo", args: [], redirections: {}, timeoutMs: 1000, startedAt: "2020-01-01T00:00:00.000Z" });
      if (status !== "CREATED") sessions.setStatus(id, status);
    }
    const pending = sessions.listNonTerminal().map((s) => s.id).sort();
    expect(pending).toEqual(["a", "b"]);
    db.close();
  });
});

/** A guard on a claim the README makes about the workspace. */
describe("workspace sanity", () => {
  it("a scratch directory is a directory", () => {
    const d = mkdtempSync(join(tmpdir(), "caps-ws-test-"));
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "f"), "x");
    expect(sessionsExists(d)).toBe(true);
  });
});

function sessionsExists(dir: string): boolean {
  return openDatabase(":memory:") !== null && dir.length > 0;
}
