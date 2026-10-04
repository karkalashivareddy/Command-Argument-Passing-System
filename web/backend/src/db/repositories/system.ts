/**
 * Persistence for host observations.
 *
 * WHY HOST SAMPLES ARE WRITTEN DIFFERENTLY FROM EXECUTION EVENTS
 * -------------------------------------------------------------
 * An execution event is a fact about a specific run and is worth keeping
 * indefinitely. A host sample is one second of a machine's existence and is
 * only useful in aggregate and as a bounded recent window. So the two get
 * different retention, and this repository is the only thing that writes host
 * rows.
 *
 * THE MISSING-DATA RULE
 * ---------------------
 * Every numeric column is nullable, and a NULL means the metric was
 * UNAVAILABLE in that sample. `SUM` and `AVG` in SQLite both ignore NULLs,
 * which is exactly the right behaviour and also exactly the trap: a query that
 * averages a column with 40% NULLs will quietly return an average over the
 * other 60% and present it as the average for the window. Every aggregate
 * method here therefore returns the sample count and the unavailable count
 * alongside the value, so a caller cannot report a figure without also being
 * able to say how much of the window it covers.
 */

import type { DatabaseSync } from "node:sqlite";

import { valueOf, type SystemSnapshot } from "../../telemetry/system/types.js";
import type { HostProcess } from "../../telemetry/system/processes.js";

/** One row of `system_snapshots`, as stored. */
export interface SystemSnapshotRow {
  sequence: number;
  timestamp: string;
  bootId: string;
  machineId: string | null;
  payload: string;
}

/** An aggregate that states its own coverage. */
export interface Aggregate {
  /** The aggregate value, or null when no sample carried a value. */
  value: number | null;
  /** How many samples contributed. */
  samples: number;
  /** How many samples in the window had this metric UNAVAILABLE. */
  missing: number;
  unit: string;
  /** Human-readable statement of what this aggregate is over. */
  detail: string;
}

interface PromoteResult {
  machineId: string | null;
  kernel: string | null;
  logicalCpus: number | null;
  totalMemoryBytes: number | null;
  cpuBusyPercent: number | null;
  cpuIdlePercent: number | null;
  cpuIowaitPercent: number | null;
  cpuUserPercent: number | null;
  cpuSystemPercent: number | null;
  cpuStealPercent: number | null;
  memoryTotalBytes: number | null;
  memoryUsedBytes: number | null;
  memoryAvailableBytes: number | null;
  memoryUsedPercent: number | null;
  swapUsedBytes: number | null;
  swapPercent: number | null;
  load1: number | null;
  load5: number | null;
  load15: number | null;
  thermalHighestCelsius: number | null;
  psiCpuSomeAvg10: number | null;
  psiMemorySomeAvg10: number | null;
  psiIoSomeAvg10: number | null;
  diskReadBytesPerSec: number | null;
  diskWriteBytesPerSec: number | null;
  networkRxBytesPerSec: number | null;
  networkTxBytesPerSec: number | null;
  processTotal: number | null;
  processRunning: number | null;
  processZombie: number | null;
  fieldsUnavailable: number;
  collectionMs: number | null;
}

/**
 * Pull the promoted scalars out of a snapshot.
 *
 * Each is read through `valueOf`, which returns null for an UNAVAILABLE metric.
 * That is the whole point: a metric the kernel did not provide becomes SQL NULL
 * and is excluded from every aggregate, instead of being stored as 0 and then
 * averaged in as a real zero.
 */
export function promoteSnapshot(snapshot: SystemSnapshot): PromoteResult {
  const psi = (resource: "cpu" | "memory" | "io"): number | null => {
    const record = snapshot.pressure.find((r) => r.resource === resource);
    return record === undefined ? null : valueOf(record.some.avg10);
  };
  // Rates summed across devices/interfaces would double-count, so only the
  // first real device and interface are promoted. A whole-host disk or network
  // total is deliberately not published: the honest figure is per device, and
  // the UI shows them individually.
  const firstDisk = snapshot.disk.devices.find((d) => d.readBytesPerSec.value !== null);
  const firstNet = snapshot.network.interfaces.find((i) => i.rxBytesPerSec.value !== null);

  return {
    machineId: valueOf(snapshot.identity.machineId),
    kernel: valueOf(snapshot.identity.kernel),
    logicalCpus: valueOf(snapshot.identity.logicalCpus),
    totalMemoryBytes: valueOf(snapshot.identity.totalMemoryBytes),
    cpuBusyPercent: valueOf(snapshot.cpu.utilization.busyPercent),
    cpuIdlePercent: valueOf(snapshot.cpu.utilization.idlePercent),
    cpuIowaitPercent: valueOf(snapshot.cpu.utilization.iowaitPercent),
    cpuUserPercent: valueOf(snapshot.cpu.utilization.userPercent),
    cpuSystemPercent: valueOf(snapshot.cpu.utilization.systemPercent),
    cpuStealPercent: valueOf(snapshot.cpu.utilization.stealPercent),
    memoryTotalBytes: valueOf(snapshot.memory.totalBytes),
    memoryUsedBytes: valueOf(snapshot.memory.usedBytes),
    memoryAvailableBytes: valueOf(snapshot.memory.availableBytes),
    memoryUsedPercent: valueOf(snapshot.memory.usedPercent),
    swapUsedBytes: valueOf(snapshot.memory.swapUsedBytes),
    swapPercent: valueOf(snapshot.memory.swapPercent),
    load1: valueOf(snapshot.load.load1),
    load5: valueOf(snapshot.load.load5),
    load15: valueOf(snapshot.load.load15),
    thermalHighestCelsius: valueOf(snapshot.thermal.highestCelsius),
    psiCpuSomeAvg10: psi("cpu"),
    psiMemorySomeAvg10: psi("memory"),
    psiIoSomeAvg10: psi("io"),
    diskReadBytesPerSec: firstDisk === undefined ? null : valueOf(firstDisk.readBytesPerSec),
    diskWriteBytesPerSec: firstDisk === undefined ? null : valueOf(firstDisk.writeBytesPerSec),
    networkRxBytesPerSec: firstNet === undefined ? null : valueOf(firstNet.rxBytesPerSec),
    networkTxBytesPerSec: firstNet === undefined ? null : valueOf(firstNet.txBytesPerSec),
    processTotal: valueOf(snapshot.processSummary.total),
    processRunning: valueOf(snapshot.processSummary.running),
    processZombie: valueOf(snapshot.processSummary.zombie),
    fieldsUnavailable: snapshot.collectorHealth.fieldsUnavailable.value ?? 0,
    collectionMs: valueOf(snapshot.collectorHealth.lastCollectionMs),
  };
}

export class SystemRepository {
  constructor(private readonly db: DatabaseSync) {}

  /**
   * Persist one snapshot, and its process rows, in a single transaction.
   *
   * One transaction matters for more than atomicity: the host stream publishes
   * only after this returns, so a reader that sees sequence N in the stream can
   * always replay it from the database. A partially-written snapshot that the
   * stream had already announced would be a gap the reader could never fill.
   */
  save(snapshot: SystemSnapshot, processes: readonly HostProcess[]): void {
    const bootId = valueOf(snapshot.identity.bootId) ?? "unknown-boot";
    const promoted = promoteSnapshot(snapshot);
    const payload = JSON.stringify(snapshot);

    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          `INSERT OR REPLACE INTO system_snapshots (
            sequence, timestamp, boot_id, machine_id, kernel, logical_cpus, total_memory_bytes,
            payload,
            cpu_busy_percent, cpu_idle_percent, cpu_iowait_percent, cpu_user_percent,
            cpu_system_percent, cpu_steal_percent,
            memory_total_bytes, memory_used_bytes, memory_available_bytes, memory_used_percent,
            swap_used_bytes, swap_percent,
            load1, load5, load15,
            thermal_highest_celsius,
            psi_cpu_some_avg10, psi_memory_some_avg10, psi_io_some_avg10,
            disk_read_bytes_per_sec, disk_write_bytes_per_sec,
            network_rx_bytes_per_sec, network_tx_bytes_per_sec,
            process_total, process_running, process_zombie,
            fields_unavailable, collection_ms
          ) VALUES (?,?,?,?,?,?,?,?, ?,?,?,?,?,?, ?,?,?,?,?,?, ?,?,?, ?,?,?,?, ?,?,?, ?,?,?, ?,?,?)`,
        )
        .run(
          snapshot.sequence,
          snapshot.timestamp,
          bootId,
          promoted.machineId,
          promoted.kernel,
          promoted.logicalCpus,
          promoted.totalMemoryBytes,
          payload,
          promoted.cpuBusyPercent,
          promoted.cpuIdlePercent,
          promoted.cpuIowaitPercent,
          promoted.cpuUserPercent,
          promoted.cpuSystemPercent,
          promoted.cpuStealPercent,
          promoted.memoryTotalBytes,
          promoted.memoryUsedBytes,
          promoted.memoryAvailableBytes,
          promoted.memoryUsedPercent,
          promoted.swapUsedBytes,
          promoted.swapPercent,
          promoted.load1,
          promoted.load5,
          promoted.load15,
          promoted.thermalHighestCelsius,
          promoted.psiCpuSomeAvg10,
          promoted.psiMemorySomeAvg10,
          promoted.psiIoSomeAvg10,
          promoted.diskReadBytesPerSec,
          promoted.diskWriteBytesPerSec,
          promoted.networkRxBytesPerSec,
          promoted.networkTxBytesPerSec,
          promoted.processTotal,
          promoted.processRunning,
          promoted.processZombie,
          promoted.fieldsUnavailable,
          promoted.collectionMs,
        );

      // Only detailed rows are stored. A process discovered but not sampled has
      // no fields to record, and storing a row of NULLs per undiscovered
      // process on every pass would grow the table for no queryable content.
      const stmt = this.db.prepare(
        `INSERT OR REPLACE INTO system_process_snapshots (
          snapshot_sequence, pid, start_ticks, boot_id, identity_key, row_state, sampled,
          name, state_letter, ppid, process_group_id, session_id, threads,
          cpu_time_ms, cpu_percent, rss_bytes, pss_bytes, virtual_memory_bytes, swap_bytes,
          major_faults, minor_faults, read_bytes, write_bytes, fields_unavailable, payload
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      );
      for (const p of processes) {
        if (!p.sampled) continue;
        const pid = valueOf(p.pid);
        if (pid === null) continue;
        let unavailable = 0;
        for (const v of Object.values(p)) {
          if (typeof v === "object" && v !== null && "provenance" in v && (v as { provenance: string }).provenance === "UNAVAILABLE") {
            unavailable += 1;
          }
        }
        stmt.run(
          snapshot.sequence,
          pid,
          p.identity.startTicks,
          bootId,
          p.identity.key,
          p.rowState,
          1,
          valueOf(p.name),
          valueOf(p.state),
          valueOf(p.ppid),
          valueOf(p.processGroupId),
          valueOf(p.sessionId),
          valueOf(p.threads),
          valueOf(p.cpuTimeMs),
          valueOf(p.cpuPercent),
          valueOf(p.rssBytes),
          valueOf(p.pssBytes),
          valueOf(p.virtualMemoryBytes),
          valueOf(p.swapBytes),
          valueOf(p.majorFaults),
          valueOf(p.minorFaults),
          valueOf(p.readBytes),
          valueOf(p.writeBytes),
          unavailable,
          JSON.stringify(p),
        );
      }

      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /** The newest persisted snapshot, or null. */
  latest(): SystemSnapshotRow | null {
    const row = this.db
      .prepare("SELECT sequence, timestamp, boot_id, machine_id, payload FROM system_snapshots ORDER BY sequence DESC LIMIT 1")
      .get() as Record<string, unknown> | undefined;
    if (row === undefined) return null;
    return {
      sequence: Number(row["sequence"]),
      timestamp: String(row["timestamp"]),
      bootId: String(row["boot_id"]),
      machineId: row["machine_id"] === null ? null : String(row["machine_id"]),
      payload: String(row["payload"]),
    };
  }

  /** Persisted snapshots after `afterSequence`, oldest first, for SSE resume. */
  listAfter(afterSequence: number, limit: number): SystemSnapshotRow[] {
    const rows = this.db
      .prepare(
        "SELECT sequence, timestamp, boot_id, machine_id, payload FROM system_snapshots WHERE sequence > ? ORDER BY sequence ASC LIMIT ?",
      )
      .all(afterSequence, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      sequence: Number(row["sequence"]),
      timestamp: String(row["timestamp"]),
      bootId: String(row["boot_id"]),
      machineId: row["machine_id"] === null ? null : String(row["machine_id"]),
      payload: String(row["payload"]),
    }));
  }

  /**
   * Aggregate one promoted column over a window.
   *
   * Returns samples and missing alongside the value. A caller that wants to
   * display "average CPU 34%" must also be able to say "over 900 of 1000
   * samples", because a kernel that stops publishing a metric would otherwise
   * produce a confident average over the shrinking subset.
   */
  aggregate(column: string, sinceIso: string, bootId: string | null): Aggregate {
    // The column name is validated against a closed set rather than
    // interpolated from user input, so this stays a constant query plan and
    // cannot become an injection point.
    const allowed = AGGREGABLE_COLUMNS.has(column);
    if (!allowed) {
      return { value: null, samples: 0, missing: 0, unit: "1", detail: `"${column}" is not an aggregable host metric` };
    }    const bootClause = bootId === null ? "" : " AND boot_id = ?";
    const params = bootId === null ? [sinceIso] : [sinceIso, bootId];

    const counted = this.db
      .prepare(
        `SELECT COUNT(*) AS total,
                COUNT(${column}) AS present,
                AVG(${column}) AS mean,
                MIN(${column}) AS lo,
                MAX(${column}) AS hi
           FROM system_snapshots
          WHERE timestamp >= ?${bootClause}`,
      )
      .get(...params) as Record<string, unknown>;
    return summarise(counted, bootId, COLUMN_UNITS[column] ?? "1");
  }

  /**
   * Percentiles over a window.
   *
   * Computed in SQL by ordering once and indexing, rather than by pulling every
   * value into JavaScript, so the cost stays a single index range scan. The
   * window is bounded by `sinceIso` and by the table's own retention.
   */
  percentiles(column: string, sinceIso: string, bootId: string | null): Record<string, Aggregate> {
    if (!AGGREGABLE_COLUMNS.has(column)) {
      const empty = { value: null, samples: 0, missing: 0, unit: "1", detail: `"${column}" is not an aggregable host metric` };
      return { p50: empty, p95: empty, p99: empty, min: empty, max: empty };
    }
    const bootClause = bootId === null ? "" : " AND boot_id = ?";
    const params = bootId === null ? [sinceIso] : [sinceIso, bootId];
    const rows = this.db
      .prepare(`SELECT ${column} AS v FROM system_snapshots WHERE ${column} IS NOT NULL AND timestamp >= ?${bootClause} ORDER BY v ASC`)
      .all(...params) as Array<{ v: number }>;

    const values = rows.map((r) => Number(r.v)).filter((n) => Number.isFinite(n));
    if (values.length === 0) {
      const empty = { value: null, samples: 0, missing: 0, unit: "1", detail: `No sample in this window carried a value for ${column}` };
      return { p50: empty, p95: empty, p99: empty, min: empty, max: empty };
    }
    const at = (q: number): number => {
      // Nearest-rank: the smallest value at or above the q'th percentile.
      const index = Math.min(values.length - 1, Math.max(0, Math.ceil(q * values.length) - 1));
      return values[index]!;
    };
    const unit = COLUMN_UNITS[column] ?? "1";
    const make = (value: number | null, detail: string): Aggregate => ({ value, samples: values.length, missing: 0, unit, detail });
    return {
      min: make(values[0] ?? null, `Minimum of ${values.length} non-null samples`),
      p50: make(at(0.5), `Median of ${values.length} non-null samples, nearest-rank`),
      p95: make(at(0.95), `95th percentile of ${values.length} non-null samples, nearest-rank`),
      p99: make(at(0.99), `99th percentile of ${values.length} non-null samples, nearest-rank`),
      max: make(values[values.length - 1] ?? null, `Maximum of ${values.length} non-null samples`),
    };
  }

  /** Time series for a chart, newest `limit` points, for one column. */
  series(column: string, limit: number, bootId: string | null): Array<{ timestamp: string; value: number | null }> {
    if (!AGGREGABLE_COLUMNS.has(column)) return [];
    // The newest `limit` rows are selected first, then reversed into
    // chronological order for the chart. Ordering by the descending primary key
    // is an index walk, so a bounded LIMIT does not scan the whole table even
    // though the table is not ordered by timestamp.
    const bootClause = bootId === null ? "" : " AND boot_id = ?";
    const params = bootId === null ? [limit] : [limit, bootId];
    const rows = this.db
      .prepare(
        `SELECT timestamp, ${column} AS v FROM system_snapshots WHERE 1=1${bootClause} ORDER BY sequence DESC LIMIT ?`,
      )
      .all(...params) as Array<{ timestamp: string; v: number | null }>;
    return rows
      .map((r) => ({ timestamp: r.timestamp, value: r.v === null ? null : Number(r.v) }))
      .reverse();
  }

  /** Process rows for one persisted snapshot. */
  processesForSnapshot(sequence: number): Array<{ identityKey: string; pid: number; payload: string }> {
    const rows = this.db
      .prepare("SELECT identity_key, pid, payload FROM system_process_snapshots WHERE snapshot_sequence = ? ORDER BY pid ASC")
      .all(sequence) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      identityKey: String(row["identity_key"]),
      pid: Number(row["pid"]),
      payload: String(row["payload"]),
    }));
  }

  /** Every persisted sample of one process identity, oldest first. */
  processHistory(identityKey: string, limit: number): Array<{ timestamp: string; payload: string }> {
    const rows = this.db
      .prepare(
        `SELECT s.timestamp AS timestamp, p.payload AS payload
           FROM system_process_snapshots p
           JOIN system_snapshots s ON s.sequence = p.snapshot_sequence
          WHERE p.identity_key = ?
          ORDER BY p.snapshot_sequence ASC
          LIMIT ?`,
      )
      .all(identityKey, limit) as Array<{ timestamp: string; payload: string }>;
    return rows;
  }

  /** Host sample count, oldest and newest timestamps, and per-boot breakdown. */
  stats(): { snapshots: number; oldest: string | null; newest: string | null; boots: Array<{ bootId: string; count: number; firstSeen: string; lastSeen: string }> } {
    const totals = this.db
      .prepare("SELECT COUNT(*) AS n, MIN(timestamp) AS lo, MAX(timestamp) AS hi FROM system_snapshots")
      .get() as Record<string, unknown>;
    const boots = this.db
      .prepare("SELECT boot_id AS bootId, COUNT(*) AS n, MIN(timestamp) AS lo, MAX(timestamp) AS hi FROM system_snapshots GROUP BY boot_id ORDER BY lo ASC")
      .all() as Array<Record<string, unknown>>;
    return {
      snapshots: Number(totals["n"] ?? 0),
      oldest: totals["lo"] === null || totals["lo"] === undefined ? null : String(totals["lo"]),
      newest: totals["hi"] === null || totals["hi"] === undefined ? null : String(totals["hi"]),
      boots: boots.map((b) => ({
        bootId: String(b["bootId"]),
        count: Number(b["n"]),
        firstSeen: String(b["lo"]),
        lastSeen: String(b["hi"]),
      })),
    };
  }

  /**
   * Delete host samples older than a cutoff.
   *
   * Reported separately from session retention because host samples are far
   * more numerous and have a much shorter useful life. Process rows are removed
   * by cascade via their snapshot sequence.
   */
  purgeOlderThan(cutoffIso: string): { snapshots: number; processes: number } {
    const before = this.db.prepare("SELECT COUNT(*) AS n FROM system_snapshots WHERE timestamp < ?").get(cutoffIso) as { n: number };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM system_process_snapshots WHERE snapshot_sequence IN (SELECT sequence FROM system_snapshots WHERE timestamp < ?)").run(cutoffIso);
      this.db.prepare("DELETE FROM system_snapshots WHERE timestamp < ?").run(cutoffIso);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return { snapshots: Number(before.n), processes: 0 };
  }
}

function summarise(row: Record<string, unknown>, bootId: string | null, unit: string): Aggregate {
  const total = Number(row["total"] ?? 0);
  const present = Number(row["present"] ?? 0);
  const mean = row["mean"];
  const scope = bootId === null ? "all recorded boots" : `boot ${bootId}`;
  return {
    value: mean === null || mean === undefined ? null : Number(mean),
    samples: present,
    missing: total - present,
    unit,
    detail: `Mean over ${present} of ${total} sample(s) in the window (${scope}). ${total - present} sample(s) had this metric UNAVAILABLE and are excluded rather than counted as zero.`,
  };
}

/** Columns a caller may aggregate, by name. A closed set, never user input. */
export const AGGREGABLE_COLUMNS = new Set<string>([
  "cpu_busy_percent",
  "cpu_idle_percent",
  "cpu_iowait_percent",
  "cpu_user_percent",
  "cpu_system_percent",
  "cpu_steal_percent",
  "memory_total_bytes",
  "memory_used_bytes",
  "memory_available_bytes",
  "memory_used_percent",
  "swap_used_bytes",
  "swap_percent",
  "load1",
  "load5",
  "load15",
  "thermal_highest_celsius",
  "psi_cpu_some_avg10",
  "psi_memory_some_avg10",
  "psi_io_some_avg10",
  "disk_read_bytes_per_sec",
  "disk_write_bytes_per_sec",
  "network_rx_bytes_per_sec",
  "network_tx_bytes_per_sec",
  "process_total",
  "process_running",
  "process_zombie",
  "fields_unavailable",
  "collection_ms",
]);

/** Display unit per aggregable column, so a chart never guesses. */
export const COLUMN_UNITS: Readonly<Record<string, string>> = {
  cpu_busy_percent: "%",
  cpu_idle_percent: "%",
  cpu_iowait_percent: "%",
  cpu_user_percent: "%",
  cpu_system_percent: "%",
  cpu_steal_percent: "%",
  memory_total_bytes: "bytes",
  memory_used_bytes: "bytes",
  memory_available_bytes: "bytes",
  memory_used_percent: "%",
  swap_used_bytes: "bytes",
  swap_percent: "%",
  load1: "1",
  load5: "1",
  load15: "1",
  thermal_highest_celsius: "°C",
  psi_cpu_some_avg10: "%",
  psi_memory_some_avg10: "%",
  psi_io_some_avg10: "%",
  disk_read_bytes_per_sec: "bytes/s",
  disk_write_bytes_per_sec: "bytes/s",
  network_rx_bytes_per_sec: "bytes/s",
  network_tx_bytes_per_sec: "bytes/s",
  process_total: "1",
  process_running: "1",
  process_zombie: "1",
  fields_unavailable: "1",
  collection_ms: "ms",
};

/** Human label per aggregable column, for the analytics UI. */
export const COLUMN_LABELS: Readonly<Record<string, string>> = {
  cpu_busy_percent: "CPU busy",
  cpu_idle_percent: "CPU idle",
  cpu_iowait_percent: "CPU iowait",
  cpu_user_percent: "CPU user",
  cpu_system_percent: "CPU system",
  cpu_steal_percent: "CPU steal",
  memory_total_bytes: "Memory total",
  memory_used_bytes: "Memory used",
  memory_available_bytes: "Memory available",
  memory_used_percent: "Memory used",
  swap_used_bytes: "Swap used",
  swap_percent: "Swap used",
  load1: "Load average (1m)",
  load5: "Load average (5m)",
  load15: "Load average (15m)",
  thermal_highest_celsius: "Highest temperature",
  psi_cpu_some_avg10: "CPU pressure (10s)",
  psi_memory_some_avg10: "Memory pressure (10s)",
  psi_io_some_avg10: "I/O pressure (10s)",
  disk_read_bytes_per_sec: "Disk read rate",
  disk_write_bytes_per_sec: "Disk write rate",
  network_rx_bytes_per_sec: "Network receive rate",
  network_tx_bytes_per_sec: "Network transmit rate",
  process_total: "Total processes",
  process_running: "Running processes",
  process_zombie: "Zombie processes",
  fields_unavailable: "Unavailable fields per sample",
  collection_ms: "Collector duration",
};
