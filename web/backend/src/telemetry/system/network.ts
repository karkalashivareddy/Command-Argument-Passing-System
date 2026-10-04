/**
 * Network interface counters from `/proc/net/dev`.
 *
 * WHAT THESE NUMBERS ARE NOT
 * --------------------------
 * Interface counters describe the *host's* traffic on that interface. They
 * cannot be attributed to a process, and this product does not attempt it.
 * Linux publishes no per-process byte counters in procfs; producing one would
 * require an eBPF probe on the socket layer or a netfilter accounting hook,
 * neither of which CAPS installs. `perProcessBytes` in the snapshot is
 * therefore permanently UNAVAILABLE with that explanation, so no view has to
 * guess.
 *
 * A second consequence, easy to get wrong: the same bytes appear on more than
 * one interface. A packet arriving on `eth0` and leaving on `docker0` is
 * counted once in each direction on each interface, so summing all interfaces
 * measures the fabric, not the data. Totals are therefore never accumulated
 * across interfaces; each is reported on its own.
 *
 * The loopback interface is included because it is where all host-local traffic
 * appears, and excluding it would make a database server's own traffic
 * invisible. It is clearly labelled rather than filtered out.
 */

import { readTextFile, readTrimmed, readUintFile, procPath, sysPath, type KernelPaths } from "./read.js";
import { derived, observed, unavailable, type NetworkInterface, type NetworkSnapshot, type SystemMetric } from "./types.js";

export const NETWORK_REASONS = {
  firstSample: "First sample for this interface: a rate needs two samples separated by a measured interval",
  rollback: "A /proc/net/dev counter decreased between samples, which does not happen within one boot unless the interface was reset or renamed; the interval is not trustworthy",
  zeroInterval: "Interval between the two samples was zero; no rate is defined",
} as const;

/** Cumulative counters, carried between samples. */
export interface NetPrevious {
  interfaces: Map<string, NetCounters>;
  atMs: number;
}

export interface NetCounters {
  rxBytes: number;
  txBytes: number;
  rxPackets: number;
  txPackets: number;
}

/** One parsed interface row. */
export interface RawNetLine {
  name: string;
  rxBytes: number;
  rxPackets: number;
  rxErrors: number;
  rxDropped: number;
  txBytes: number;
  txPackets: number;
  txErrors: number;
  txDropped: number;
}

/**
 * Parse `/proc/net/dev`.
 *
 * Format: a two-line header, then one row per interface, space-aligned, with
 * the name in the first column and the counters in the remaining sixteen.
 * Six of the eight counters this module reports are all that procfs publishes;
 * FIFO, frame, compressed, multicast, and colliding counts are read and
 * discarded rather than indexed wrongly.
 */
export function parseNetDev(text: string): RawNetLine[] {
  const lines = text.split("\n");
  // Skip both header lines. Anything before the second colon line is header.
  const out: RawNetLine[] = [];
  for (const line of lines) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim();
    if (name === "" || name.includes("Inter-") || name.includes("face")) continue;
    const f = line.slice(colon + 1).trim().split(/\s+/).map((v) => (/^\d+$/.test(v) ? Number(v) : Number.NaN));
    if (f.length < 16 || f.some((n) => !Number.isSafeInteger(n))) continue;
    out.push({
      name,
      rxBytes: f[0]!, rxPackets: f[1]!, rxErrors: f[2]!, rxDropped: f[3]!,
      txBytes: f[8]!, txPackets: f[9]!, txErrors: f[10]!, txDropped: f[11]!,
    });
  }
  return out;
}

function count(raw: number, path: string, timestamp: string, what: string): SystemMetric<number> {
  return observed(raw, "1", path, timestamp, what);
}

function byteRate(
  current: number,
  previous: number,
  intervalMs: number,
  source: string,
  timestamp: string,
  direction: "receive" | "transmit",
): SystemMetric<number> {
  const delta = current - previous;
  if (delta < 0) return unavailable<number>("bytes/s", source, timestamp, NETWORK_REASONS.rollback);
  if (intervalMs <= 0) return unavailable<number>("bytes/s", source, timestamp, NETWORK_REASONS.zeroInterval);
  return derived((delta / intervalMs) * 1000, "bytes/s", source, timestamp, `delta(${direction} bytes) / interval_seconds, from two consecutive reads of ${source}`);
}

function sysText(path: string, timestamp: string, what: string): SystemMetric<string> {
  const result = readTrimmed(path);
  if (!result.ok) return unavailable<string>("1", path, timestamp, `${what}: ${result.failure.reason}`);
  if (result.text === "") return unavailable<string>("1", path, timestamp, `${what}: the file is present but empty`);
  return observed(result.text, "1", path, timestamp, `${what}, as published by sysfs`);
}

/** Build the network block by diffing two reads of `/proc/net/dev`. */
export function buildNetworkSnapshot(
  paths: KernelPaths,
  previous: NetPrevious | null,
  nowMs: number,
  timestamp: string,
): { snapshot: NetworkSnapshot; previous: NetPrevious } {
  const path = procPath(paths, "net", "dev");
  const result = readTextFile(path);

  if (!result.ok) {
    return {
      snapshot: { interfaces: [], perProcessBytes: perProcessUnavailable(path, timestamp, result.failure.reason) },
      previous: previous ?? { interfaces: new Map(), atMs: nowMs },
    };
  }

  const lines = parseNetDev(result.text);
  const next = new Map<string, NetCounters>();
  const interfaces: NetworkInterface[] = [];
  const intervalMs = previous === null ? 0 : nowMs - previous.atMs;

  for (const line of lines) {
    const counters: NetCounters = {
      rxBytes: line.rxBytes,
      txBytes: line.txBytes,
      rxPackets: line.rxPackets,
      txPackets: line.txPackets,
    };
    next.set(line.name, counters);

    const netPath = `${path} (${line.name})`;
    const netBase = sysPath(paths, "class", "net", line.name);
    const before = previous?.interfaces.get(line.name);
    const deltaSource = `${netPath}, delta of two samples`;

    let rxBytesPerSec: SystemMetric<number>;
    let txBytesPerSec: SystemMetric<number>;
    if (before === undefined) {
      rxBytesPerSec = unavailable<number>("bytes/s", deltaSource, timestamp, NETWORK_REASONS.firstSample);
      txBytesPerSec = unavailable<number>("bytes/s", deltaSource, timestamp, NETWORK_REASONS.firstSample);
    } else if (intervalMs <= 0) {
      rxBytesPerSec = unavailable<number>("bytes/s", deltaSource, timestamp, NETWORK_REASONS.zeroInterval);
      txBytesPerSec = unavailable<number>("bytes/s", deltaSource, timestamp, NETWORK_REASONS.zeroInterval);
    } else {
      rxBytesPerSec = byteRate(line.rxBytes, before.rxBytes, intervalMs, netPath, timestamp, "receive");
      txBytesPerSec = byteRate(line.txBytes, before.txBytes, intervalMs, netPath, timestamp, "transmit");
    }

    interfaces.push({
      name: line.name,
      rxBytes: count(line.rxBytes, netPath, timestamp, "Bytes received on this interface, cumulative since it was created"),
      rxPackets: count(line.rxPackets, netPath, timestamp, "Packets received, cumulative"),
      rxErrors: count(line.rxErrors, netPath, timestamp, "Receive errors reported by the driver, cumulative"),
      rxDropped: count(line.rxDropped, netPath, timestamp, "Packets dropped on receive, cumulative. Non-zero usually means a receive buffer overflow: the NIC outran the CPU."),
      rxBytesPerSec,
      txBytes: count(line.txBytes, netPath, timestamp, "Bytes transmitted on this interface, cumulative"),
      txPackets: count(line.txPackets, netPath, timestamp, "Packets transmitted, cumulative"),
      txErrors: count(line.txErrors, netPath, timestamp, "Transmit errors reported by the driver, cumulative"),
      txDropped: count(line.txDropped, netPath, timestamp, "Packets dropped on transmit, cumulative"),
      txBytesPerSec,
      operState: sysText(`${netBase}/operstate`, timestamp, "Link state as the driver reports it"),
      linkSpeedMbps: (() => {
        const raw = readUintFile(`${netBase}/speed`);
        return raw === null
          ? unavailable<number>("Mb/s", `${netBase}/speed`, timestamp, "The driver publishes no link speed. Common on virtual and loopback interfaces, where there is no physical link to measure.")
          : observed(raw, "Mb/s", `${netBase}/speed`, timestamp, "Nominal link speed as the driver reports it. This is the link's rated capability, NOT measured throughput: actual traffic is governed by the rate of the endpoints.");
      })(),
      mtu: (() => {
        const raw = readUintFile(`${netBase}/mtu`);
        return raw === null
          ? unavailable<number>("bytes", `${netBase}/mtu`, timestamp, "MTU could not be read from sysfs")
          : observed(raw, "bytes", `${netBase}/mtu`, timestamp, "Maximum transmission unit, as configured for this interface");
      })(),
      operStateSource: sysText(`${netBase}/operstate`, timestamp, "Source of the link state above"),
    });
  }

  interfaces.sort((a, b) => a.name.localeCompare(b.name));

  return {
    snapshot: { interfaces, perProcessBytes: perProcessUnavailable(path, timestamp, perProcessReason) },
    previous: { interfaces: next, atMs: nowMs },
  };
}

const perProcessReason =
  "Linux exposes no per-process network byte counters in procfs. Attributing traffic to a process requires an eBPF probe on the socket layer or a netfilter accounting hook, neither of which CAPS installs. The interface counters in this snapshot are host-wide totals and cannot be split per process. Reporting 0 here would be a fabrication, so this field is UNAVAILABLE.";

function perProcessUnavailable(path: string, timestamp: string, reason: string): SystemMetric<number> {
  return unavailable<number>("bytes", `${path} (no per-process source exists)`, timestamp, reason);
}
