import { accessSync, constants, existsSync, lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import type { CapsConfig } from "../config/env.js";
import { repoRoot } from "../config/env.js";
import { isWorkloadId, probeWorkload, workloadExecutablePath, workloadIds } from "../execution/workloadCatalog.js";
import { logger } from "../utils/logger.js";

/**
 * Web-facing command allowlist and executable resolution.
 *
 * THE TRUST BOUNDARY
 * ------------------
 * The browser may name a command.  It may never name a path, and it may
 * never influence which file is executed.  Every approved command is
 * therefore resolved, once, to an absolute path that this process has
 * verified, and that absolute path is what the engine is asked to exec.
 *
 * The previous behaviour passed the bare allowlist *name* through to
 * `execvp()`, which re-resolved it against `PATH` at exec time.  That made
 * the gateway's own `access(X_OK)` probe meaningless: a different file at the
 * front of `PATH` would be executed while the gateway reported the probed
 * path.  `PATH` is no longer consulted for any allowlisted command.
 */

/**
 * Commands that are not repository artefacts, so they are resolved once at
 * startup from a controlled search path and then frozen.
 *
 * Shells are deliberately absent: `sh -c` would turn an argv allowlist into
 * arbitrary command execution even though spawn() uses shell:false.
 */
const SYSTEM_CMDS: readonly string[] = ["echo", "printf", "sleep", "true", "false", "pwd", "cat", "uname"];

/**
 * Directories searched exactly once, in order, when pinning a system command.
 * Each candidate is verified with the same rules as a repository helper, so
 * the only thing this list changes is *where* the trust is taken from.
 */
const TRUSTED_BIN_DIRS: readonly string[] = [
  "/usr/bin",
  "/bin",
  "/usr/local/bin",
];

/** Repository-relative helpers built by `make`. */
const REPO_HELPERS: Record<string, string> = {
  status_probe: resolve(repoRoot, "build", "status_probe"),
};

export type Resolution =
  | { ok: true; path: string }
  | { ok: false; reason: string };

/**
 * Verify one candidate path and return its canonical form.
 *
 * `realpath` first so the returned path cannot be re-pointed through a
 * symlinked parent; then `lstat` on the *resolved* path so the final
 * component is known to be a regular file rather than a device, FIFO, or
 * directory.  A symlinked binary is refused rather than followed: the whole
 * point of pinning is that the bytes at the path cannot change underneath
 * the recorded evidence.
 */
export function validateArgVector(command: string, args: string[]): void {
  if (command.length === 0 || command.length > 256) throw new RedirectionPolicyError("invalid command name");
  if (args.length > 512) throw new RedirectionPolicyError("too many arguments");
  const burst = args.reduce((acc, a) => acc + a.length, 0);
  if (burst > 128 * 1024) throw new RedirectionPolicyError("argument vector too large");
  for (const a of [command, ...args]) {
    if (a.includes("\0")) throw new RedirectionPolicyError("NUL byte in argument");
  }
}

export function verifyExecutable(candidate: string): Resolution {
  let real: string;
  try {
    real = realpathSync(candidate);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? "UNKNOWN";
    if (code === "ENOENT") return { ok: false, reason: "not found (run: make)" };
    if (code === "EACCES") return { ok: false, reason: "permission denied" };
    return { ok: false, reason: `cannot resolve (${code})` };
  }

  let info;
  try {
    info = lstatSync(real);
  } catch (err) {
    return { ok: false, reason: `cannot stat (${(err as NodeJS.ErrnoException).code ?? "UNKNOWN"})` };
  }
  if (info.isSymbolicLink()) {
    return { ok: false, reason: "resolves to a symbolic link" };
  }
  if (!info.isFile()) {
    return { ok: false, reason: "not a regular file" };
  }
  try {
    accessSync(real, constants.X_OK);
  } catch {
    return { ok: false, reason: "not executable" };
  }
  return { ok: true, path: real };
}

const accessCache = new Map<string, Resolution>();

/** Verify and memoise, so a missing helper is not re-probed on every request. */
function resolveOnce(name: string, candidate: string): Resolution {
  const cached = accessCache.get(name);
  if (cached !== undefined) return cached;
  const result = verifyExecutable(candidate);
  accessCache.set(name, result);
  return result;
}

/**
 * Resolve a system command to a pinned absolute path.
 *
 * The search order is a fixed list of directories, never `PATH`.  Resolution
 * happens once and is memoised, so a later change to the process environment
 * cannot change which binary a later request executes.
 */
function resolveSystemCommand(command: string): Resolution {
  for (const dir of TRUSTED_BIN_DIRS) {
    const candidate = resolve(dir, command);
    if (!existsSync(candidate)) continue;
    const result = resolveOnce(`${dir}/${command}`, candidate);
    if (result.ok) return result;
  }
  return {
    ok: false,
    reason: `not found in any trusted directory (${TRUSTED_BIN_DIRS.join(", ")})`,
  };
}

/**
 * The absolute path that will actually be executed for `command`, or null
 * with the reason logged.  This is the only function the execution path uses,
 * so a command cannot reach `execvp()` without passing through here.
 */
export function resolveAllowedExecutable(command: string): Resolution {
  if (SYSTEM_CMDS.includes(command)) {
    const r = resolveSystemCommand(command);
    if (!r.ok) logger.warn("SECURITY", "allowlisted command unavailable", { command, reason: r.reason });
    return r;
  }
  if (command in REPO_HELPERS) {
    return resolveOnce(command, REPO_HELPERS[command]!);
  }
  if (isWorkloadId(command)) {
    if (!probeWorkload(command).available) {
      return { ok: false, reason: "workload binary not built (run: make workloads)" };
    }
    // The path derives from the fixed profile id, never from client input.
    return resolveOnce(command, workloadExecutablePath(command));
  }
  return { ok: false, reason: "not on the allowlist" };
}

/** Allowlist names, for the capability response. */
export function allowedCommands(): string[] {
  return [...SYSTEM_CMDS, ...Object.keys(REPO_HELPERS), ...workloadIds()];
}

/** Test seam: forget memoised probes. */
export function resetExecutableCache(): void {
  accessCache.clear();
}

/**
 * Redirection target path policy.
 *
 * Targets must be plain relative file names (no slash-heavy structure) and
 * must not escape the safe workspace. Absolute paths, "..", ".", "~",
 * NULs, and empty strings are rejected. The gateway chdir()s CAPS into the
 * workspace, so a valid name resolves to workspace/name.
 *
 * An empty or whitespace-only target is a *rejection*, never a silent no-op:
 * accepting `{"out": ""}` and ignoring it would report a redirection the
 * user asked for as if it had been applied.
 */
export function isSafeRedirTarget(name: string): boolean {
  if (name.length === 0 || name.length > 255) return false;
  if (name.trim().length === 0) return false;
  if (name.includes("\0")) return false;
  if (name.includes("~")) return false;
  if (isAbsolute(name)) return false;
  // Control characters would make the executed argv and the recorded argv
  // disagree once a terminal renders them.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(name)) return false;
  const parts = name.split(/[\\/]/);
  for (const part of parts) {
    if (part === ".." || part === "." || part === "") return false;
  }
  return true;
}

export class RedirectionPolicyError extends Error {
  override name = "RedirectionPolicyError";
}

/**
 * Safety link: verify the workspace exists and that a redirection target
 * would land inside it (defense in depth; the chdir approach is the primary
 * control).  This is a pre-flight check, not a lock: the engine re-verifies
 * with O_NOFOLLOW at the moment of open(), so a symlink planted between this
 * check and the open is refused rather than followed.
 */
export function assertTargetInWorkspace(config: CapsConfig, target: string): void {
  if (!isSafeRedirTarget(target)) {
    throw new RedirectionPolicyError(
      target.length === 0 || target.trim().length === 0
        ? "redirection target must not be empty"
        : "redirection target rejected by path policy",
    );
  }
  if (!existsSync(config.workspace)) {
    throw new RedirectionPolicyError("workspace does not exist");
  }
  // Walk every existing component. A lexically safe name can still escape
  // through a workspace symlink (including a symlink in a parent directory).
  const base = realpathSync(config.workspace);
  const contained = (candidate: string): boolean => {
    const rel = relative(base, candidate);
    return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
  };
  let current = base;
  for (const part of target.split(/[\\/]/)) {
    current = resolve(current, part);
    try {
      const info = lstatSync(current);
      if (info.isSymbolicLink()) {
        throw new RedirectionPolicyError("redirection target may not traverse a symbolic link");
      }
      const actual = realpathSync(current);
      if (!contained(actual)) {
        throw new RedirectionPolicyError("redirection target escapes the workspace");
      }
      current = actual;
    } catch (err) {
      if (err instanceof RedirectionPolicyError) throw err;
      if ((err as NodeJS.ErrnoException).code === "ENOENT") break;
      throw new RedirectionPolicyError("redirection target could not be verified");
    }
  }
  if (!contained(current)) {
    throw new RedirectionPolicyError("redirection target escapes the workspace");
  }
}

/** Allow the web-facing `cat` helper to read only regular files in workspace. */
export function assertReadableFileInWorkspace(config: CapsConfig, target: string): void {
  if (!isSafeRedirTarget(target) || target.startsWith("-")) {
    throw new RedirectionPolicyError("file argument rejected by workspace policy");
  }
  try {
    const base = realpathSync(config.workspace);
    const resolved = realpathSync(resolve(config.workspace, target));
    if (resolved !== base && !resolved.startsWith(base + sep)) {
      throw new RedirectionPolicyError("file argument escapes the workspace");
    }
    if (!lstatSync(resolved).isFile()) {
      throw new RedirectionPolicyError("file argument must name a regular file");
    }
  } catch (err) {
    if (err instanceof RedirectionPolicyError) throw err;
    throw new RedirectionPolicyError("file argument must be an existing workspace file");
  }
}

/** The directory a resolved executable lives in; used for display only. */
export function executableDir(path: string): string {
  return dirname(path);
}
