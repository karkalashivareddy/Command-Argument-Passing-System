import { accessSync, constants, existsSync, lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import type { CapsConfig } from "../config/env.js";
import { probeCommand, catalogNames, resetCatalogProbes, verifyExecutableFile } from "../catalog/commands.js";
import { logger } from "../utils/logger.js";

/*
 * THE TRUST BOUNDARY
 * ------------------
 * The browser may name a command.  It may never name a path, and it may never
 * influence which file is executed.  Every approved command is resolved, once,
 * to an absolute path that this process has verified, and that absolute path is
 * what the engine is asked to exec.
 *
 * The previous behaviour passed the bare allowlist *name* through to
 * `execvp()`, which re-resolved it against `PATH` at exec time.  That made the
 * gateway's own `access(X_OK)` probe meaningless: a different file at the
 * front of `PATH` would be executed while the gateway reported the probed
 * path.  `PATH` is no longer consulted for any allowlisted command.
 *
 * WHERE THE ALLOWLIST LIVES
 * -------------------------
 * The set of permitted commands, their argument rules, and their workspace
 * policy are stated in exactly one place: `src/catalog/commands.ts`.  This
 * module owns the *path* policy and delegates the command decision to the
 * catalog.  Two lists would inevitably disagree, and that disagreement would be
 * a security bug rather than a cosmetic one.
 */

export type Resolution =
  | { ok: true; path: string }
  | { ok: false; reason: string };

export function validateArgVector(command: string, args: string[]): void {
  if (command.length === 0 || command.length > 256) throw new RedirectionPolicyError("invalid command name");
  if (args.length > 512) throw new RedirectionPolicyError("too many arguments");
  const burst = args.reduce((acc, a) => acc + a.length, 0);
  if (burst > 128 * 1024) throw new RedirectionPolicyError("argument vector too large");
  for (const a of [command, ...args]) {
    if (a.includes("\0")) throw new RedirectionPolicyError("NUL byte in argument");
  }
}

/**
 * Verify that a path is a regular, executable file.
 *
 * Deliberately does NOT enforce containment in the trusted directories:
 * containment is a policy decision that belongs to the catalog's probe, which
 * knows which roots it is allowed to search. This helper answers only "is this
 * a safe executable file?", so it remains usable for a file the caller has
 * already bounded by other means.
 */
export function verifyExecutable(candidate: string): Resolution {
  return verifyExecutableFile(candidate);
}

/**
 * The absolute path that will actually be executed for `command`, or a failure
 * with the reason.
 *
 * This is the only function the execution path uses, so a command cannot reach
 * `execvp()` without passing through the catalog here.  The failure shapes are
 * deliberately distinguishable, because they mean different things:
 *
 *   - not in the catalog  -> the browser named something undeclared;
 *   - BLOCKED             -> policy refuses it;
 *   - UNAVAILABLE         -> declared and permitted, but not installed here.
 */
export function resolveAllowedExecutable(command: string): Resolution {
  const probed = probeCommand(command);
  if (probed.availability === "AVAILABLE" && probed.resolvedPath !== null) {
    return { ok: true, path: probed.resolvedPath };
  }
  if (probed.availability === "BLOCKED") {
    return { ok: false, reason: probed.reason };
  }
  logger.warn("SECURITY", "allowlisted command unavailable", { command, reason: probed.reason });
  return { ok: false, reason: probed.reason };
}

/** Every catalog command name, for the capability response. */
export function allowedCommands(): string[] {
  return catalogNames();
}

/** Test seam: forget every memoised executable probe. */
export function resetExecutableCache(): void {
  // The catalog owns the probe cache; there is deliberately no second copy here.
  resetCatalogProbes();
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
 * control). This is a pre-flight check, not a lock: the engine opens each
 * component relative to its already-open parent with openat() and O_NOFOLLOW,
 * so a symlink planted between this check and the open is refused rather than
 * followed.
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
