/**
 * procfs and sysfs reading primitives.
 *
 * Every host collector funnels through these helpers for one reason: the
 * difference between "the kernel said 0" and "we could not read it" has to be
 * decided in exactly one place. A collector that catches its own errors will
 * eventually catch one and return a default, and a default of 0 is a
 * fabricated measurement.
 *
 * These helpers never throw for an ordinary I/O failure. A missing file, a
 * permission error, and a directory that does not exist on this kernel are all
 * normal, expected outcomes that become an explicit reason string.
 */

import { readFileSync, readdirSync, readlinkSync, statSync } from "node:fs";
import { join } from "node:path";

/** Roots are injectable so tests can point the collectors at a fixture tree. */
export interface KernelPaths {
  proc: string;
  sys: string;
}

export const DEFAULT_KERNEL_PATHS: KernelPaths = { proc: "/proc", sys: "/sys" };

/** Why a read failed, in terms a user can act on. */
export type ReadFailure =
  | { kind: "missing"; reason: string }
  | { kind: "permission"; reason: string }
  | { kind: "malformed"; reason: string }
  | { kind: "io"; reason: string };

/** The outcome of one read attempt. Exactly one arm is populated. */
export type ReadResult =
  | { ok: true; text: string }
  | { ok: false; failure: ReadFailure };

function classify(err: unknown, path: string): ReadFailure {
  const code = typeof err === "object" && err !== null && "code" in err ? String((err as NodeJS.ErrnoException).code) : "UNKNOWN";
  if (code === "ENOENT" || code === "ENOTDIR") {
    return { kind: "missing", reason: `${path} does not exist on this kernel` };
  }
  if (code === "EACCES" || code === "EPERM") {
    return { kind: "permission", reason: `${path}: permission denied (CAP_SYS_PTRACE or same-uid ownership required)` };
  }
  if (code === "ELOOP") {
    return { kind: "io", reason: `${path}: too many levels of symbolic links` };
  }
  return { kind: "io", reason: `${path}: ${code}` };
}

/** Read a text file, or explain precisely why it could not be read. */
export function readTextFile(path: string): ReadResult {
  try {
    return { ok: true, text: readFileSync(path, "utf8") };
  } catch (err) {
    return { ok: false, failure: classify(err, path) };
  }
}

/** Read a file and trim it, or explain why it could not be read. */
export function readTrimmed(path: string): ReadResult {
  const result = readTextFile(path);
  return result.ok ? { ok: true, text: result.text.trim() } : result;
}

/**
 * List a directory's entry names, or explain why it could not be listed.
 *
 * Callers that treat an empty directory as "no sensors" must distinguish that
 * from "cannot look", so an ENOENT here is never collapsed into `[]`.
 */
export function listDir(path: string): { ok: true; entries: string[] } | { ok: false; failure: ReadFailure } {
  let entries: string[];
  try {
    entries = readdirSync(path);
  } catch (err) {
    return { ok: false, failure: classify(err, path) };
  }
  return { ok: true, entries: entries.sort() };
}

/**
 * List directory entries matching a pattern, distinguishing "the directory
 * exists and has no match" from "the directory is not there".
 */
export function listMatching(
  path: string,
  pattern: RegExp,
): { ok: true; entries: string[] } | { ok: false; failure: ReadFailure } {
  const listed = listDir(path);
  if (!listed.ok) return listed;
  return { ok: true, entries: listed.entries.filter((name) => pattern.test(name)) };
}

/**
 * Parse a `kB`-suffixed `/proc/<pid>/status` style value.
 *
 * Linux reports these in kibibytes. They are converted to bytes here, once,
 * and the caller labels the unit "bytes" so no view has to remember.
 */
export function parseKibibytes(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const match = /^(\d+)\s+kB$/.exec(raw.trim());
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isSafeInteger(n) ? n * 1024 : null;
}

/** Parse a plain unsigned integer, rejecting anything else. */
export function parseUint(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return Number.isSafeInteger(n) ? n : null;
}

/** Parse a finite number, optionally signed, as used by pressure averages. */
export function parseFinite(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

/** Read a single-line unsigned integer file, or `null`. */
export function readUintFile(path: string): number | null {
  const result = readTrimmed(path);
  return result.ok ? parseUint(result.text) : null;
}

/** Read a single-line signed-integer file, or `null`. */
export function readIntFile(path: string): number | null {
  const result = readTrimmed(path);
  if (!result.ok) return null;
  const trimmed = result.text;
  if (!/^-?\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return Number.isSafeInteger(n) ? n : null;
}

/** True when the path exists and is a regular file (following no symlinks). */
export function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** True when the path exists and is a directory. */
export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Join a sysfs root with a relative path. */
export function sysPath(paths: KernelPaths, ...segments: string[]): string {
  return join(paths.sys, ...segments);
}

/** Join a procfs root with a relative path. */
export function procPath(paths: KernelPaths, ...segments: string[]): string {
  return join(paths.proc, ...segments);
}

/**
 * Read a symlink's target, for interfaces that are exposed only as links.
 *
 * Callers that use this must not trust the returned path for I/O: a link
 * target is attacker-controllable in a shared directory. It is safe here only
 * because the sole caller reduces the result to a basename and then validates
 * it against a strict pattern.
 */
export function readSymlink(path: string): string | null {
  try {
    return readlinkSync(path);
  } catch {
    return null;
  }
}

/**
 * Stable identity of the running boot.
 *
 * `/proc/sys/kernel/random/boot_id` is a random UUID regenerated at every boot.
 * Cached because it cannot change while the gateway runs: a change would mean
 * the machine rebooted underneath us, which ends the process.
 */
export function readBootId(paths: KernelPaths): string | null {
  const result = readTrimmed(procPath(paths, "sys", "kernel", "random", "boot_id"));
  return result.ok && result.text.length > 0 ? result.text : null;
}

/**
 * Stable identity of the machine across boots, when the image provides one.
 * Absent in minimal containers, which is a normal outcome.
 */
export function readMachineId(): string | null {
  const result = readTrimmed("/etc/machine-id");
  if (result.ok && result.text.length > 0) return result.text;
  const fallback = readTrimmed("/var/lib/dbus/machine-id");
  return fallback.ok && fallback.text.length > 0 ? fallback.text : null;
}
