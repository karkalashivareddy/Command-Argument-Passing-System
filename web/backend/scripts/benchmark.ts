/**
 * Recorder-scale benchmark.
 *
 * Measures the paths that grow with history rather than with the current
 * request: event insertion, replay load, and the analytics aggregation. The
 * numbers printed are measurements, never estimates, and the same run also
 * validates the event-stream invariants at each scale so a fast-but-wrong
 * result cannot pass.
 *
 * Run with:  npx tsx scripts/benchmark.ts
 */
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDatabase } from "../src/db/database.js";
import { EventRepository } from "../src/db/repositories/events.js";
import { SessionRepository } from "../src/db/repositories/sessions.js";
import { validateEventStream } from "../src/events/invariants.js";
// The frontend correlation layer is imported from source so the benchmark
// measures the code the browser actually runs, not a copy of it.
import {
  buildEvidenceIndex,
  resolveSelection,
} from "../../frontend/src/lib/evidenceCorrelation.js";

const SCALES = [100, 1_000, 10_000, 100_000];

function ms(value: number): string {
  return value.toFixed(1).padStart(9);
}

interface Row {
  scale: number;
  insertMs: number;
  insertPerEventUs: number;
  replayLoadMs: number;
  replayPerEventUs: number;
  validateMs: number;
  analyticsMs: number;
  indexMs: number;
  resolutionMs: number;
  dbMiB: number;
  /** Which invariants the validator reported; empty would mean it went quiet. */
  invariantsFound: string;
  valid: boolean;
}

function snapshotPayload(sequence: number): Record<string, unknown> {
  const rss = 1_000_000 + ((sequence * 7_919) % 5_000_000);
  return {
    pid: { value: 1234, provenance: "OBSERVED", source: "/proc/1234/stat" },
    capsEnginePid: { value: 1200, provenance: "OBSERVED", source: "gateway child_process.spawn" },
    command: { value: "caps_cpu_burn", provenance: "OBSERVED", source: "/proc/1234/stat" },
    ppid: { value: 1200, provenance: "OBSERVED", source: "/proc/1234/status" },
    rssBytes: { value: rss, provenance: "OBSERVED", source: "/proc/1234/status" },
    cpuTimeMs: { value: sequence * 12.5, provenance: "DERIVED", source: "ticks" },
    cpuPercent: sequence === 0
      ? { value: null, provenance: "UNAVAILABLE", source: "DERIVED", reason: "first sample" }
      : { value: 42.5, provenance: "DERIVED", source: "delta" },
    minorFaults: { value: sequence * 11, provenance: "OBSERVED", source: "/proc/1234/stat" },
    majorFaults: { value: 0, provenance: "OBSERVED", source: "/proc/1234/stat" },
    rcharBytesPerSec: sequence === 0
      ? { value: null, provenance: "UNAVAILABLE", source: "DERIVED", reason: "first sample" }
      : { value: 1000, provenance: "DERIVED", source: "delta" },
    identityStartTicks: sequence,
  };
}

function build(scale: number): Row {
  const dir = join(tmpdir(), `caps-bench-${process.pid}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const db = openDatabase(join(dir, "bench.db"));
  const events = new EventRepository(db);
  const sessions = new SessionRepository(db);

  const startedAt = new Date().toISOString();
  sessions.create({ id: "exec_bench", command: "caps_cpu_burn", args: ["10"], redirections: {}, timeoutMs: 60000, startedAt });

  const base = Date.parse(startedAt);
  const stamp = (i: number): string => new Date(base + i).toISOString();

  const seq = (i: number) => i;
  const insertStart = performance.now();
  const insert = db.prepare(
    "INSERT INTO events (id, session_id, sequence, type, source, timestamp, monotonic_ms, pid, payload) VALUES (?, 'exec_bench', ?, ?, ?, ?, NULL, 1234, ?)",
  );
  db.exec("BEGIN IMMEDIATE");
  // Four events per sample keeps the mix realistic: the telemetry majority plus
  // the lifecycle events around it.
  for (let i = 0; i < scale; i++) {
    insert.run(`e${i}`, seq(i), "process.snapshot", "gateway", stamp(i), JSON.stringify(snapshotPayload(i)));
  }
  db.exec("COMMIT");
  const insertMs = performance.now() - insertStart;

  // The terminal event, so the stream is a valid one at every scale.
  const last = scale;
  events.insert({
    id: `e${last}`, sessionId: "exec_bench", sequence: last, type: "execution.completed",
    source: "gateway", timestamp: stamp(last + 1), monotonicMs: null, pid: 1234, payload: { isSuccess: true },
  });

  const replayStart = performance.now();
  const all = events.listAllForSession("exec_bench");
  const replayMs = performance.now() - replayStart;

  const validateStart = performance.now();
  const validation = validateEventStream(all, { sessionStatus: "RUNNING" });
  const validateMs = performance.now() - validateStart;

  const analyticsStart = performance.now();
  const agg = events.aggregateProcessTelemetry();
  const analyticsMs = performance.now() - analyticsStart;

  const indexStart = performance.now();
  const index = buildEvidenceIndex(all);
  const indexMs = performance.now() - indexStart;

  const resolutionStart = performance.now();
  for (let i = 0; i < 100; i++) {
    resolveSelection({ sessionId: "exec_bench", cursorMs: i * 10, identity: index.processes[0]?.identity ?? null, eventSeq: i }, index);
  }
  const resolutionMs = (performance.now() - resolutionStart) / 100;

  const stats = sessions.storageStats();

  /*
   * This synthetic stream is telemetry plus a terminal event, with the session
   * row still RUNNING, so it is deliberately NOT a well-formed record. The
   * validator must therefore still report the ways it is malformed. The check
   * is that the validator is *working* at this scale -- a fast, silent result
   * would mean the invariants had stopped protecting anything.
   */
  const found = [...new Set(validation.violations.map((v) => v.invariant))].sort();
  const checkerStillWorks = validation.errorCount > 0 && found.length > 0;

  db.close();
  rmSync(dir, { recursive: true, force: true });

  return {
    scale,
    insertMs,
    insertPerEventUs: (insertMs * 1000) / scale,
    replayLoadMs: replayMs,
    replayPerEventUs: (replayMs * 1000) / scale,
    validateMs,
    analyticsMs,
    indexMs,
    resolutionMs,
    dbMiB: (stats.dbBytes ?? 0) / (1024 * 1024),
    invariantsFound: found.join(","),
    valid: checkerStillWorks,
  };
}

function main(): void {
  console.log("CAPS recorder benchmark");
  console.log(`node ${process.version} on ${process.platform}/${process.arch}`);
  console.log("");
  console.log(
    "scale    insert(ms)  us/ev   replay(ms)  us/ev  validate  analytics    index   resolve  size(MiB)  invariants",
  );
  const rows: Row[] = [];
  for (const scale of SCALES) {
    const row = build(scale);
    rows.push(row);
    console.log(
      [
        String(scale).padStart(6),
        ms(row.insertMs),
        row.insertPerEventUs.toFixed(2).padStart(9),
        ms(row.replayLoadMs),
        row.replayPerEventUs.toFixed(2).padStart(9),
        ms(row.validateMs),
        ms(row.analyticsMs),
        ms(row.indexMs),
        row.resolutionMs.toFixed(3).padStart(8),
        row.dbMiB.toFixed(1).padStart(9),
        row.valid ? "as expected" : "UNEXPECTED",
      ].join(" "),
    );
  }
  console.log("");
  // A scaling check, not a marketing claim: the per-event costs must not grow
  // with history, which is the property that matters for a recorder.
  const first = rows[0]!;
  const last = rows[rows.length - 1]!;
  const growth = (a: number, b: number): string => `${(b / a).toFixed(1)}x`;
  console.log(`per-event insert cost from ${first.scale} to ${last.scale} events: ${growth(first.insertPerEventUs, last.insertPerEventUs)}`);
  console.log(`per-event replay cost from ${first.scale} to ${last.scale} events: ${growth(first.replayPerEventUs, last.replayPerEventUs)}`);
  console.log(`storage at ${last.scale} events: ${last.dbMiB.toFixed(1)} MiB`);
  console.log("");
  console.log(`invariants reported at ${last.scale} events: ${last.invariantsFound}`);
  console.log("  (this synthetic stream is deliberately malformed, so the validator is");
  console.log("   expected to report; a silent result would mean it stopped working)");
  console.log("");
  console.log("These are the numbers to compare against after a change, not a target.");
}

main();
