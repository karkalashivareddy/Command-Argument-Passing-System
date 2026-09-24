import { existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

import type { CapsConfig } from "../config/env.js";
import { repoRoot } from "../config/env.js";

/**
 * Web-facing command allowlist.
 *
 * Every entry is a real binary that CAPS will execvp(). "PATH" entries are
 * resolved by execvp() from the gateway's environment; repo-relative
 * entries (the test status_probe helper) are resolved to their absolute
 * path at startup. The gateway NEVER interpolates anything into a shell.
 */
// Do not allow shells here: `sh -c` would turn an argv allowlist into an
// arbitrary command execution interface even though spawn() uses shell:false.
const PATH_CMDS: string[] = ["echo", "printf", "sleep", "true", "false", "pwd", "cat", "uname"];
const REPO_HELPERS: Record<string, string> = {
  status_probe: resolve(repoRoot, "build", "status_probe"),
};

export function resolveAllowedExecutable(command: string): string | null {
  if (PATH_CMDS.includes(command)) return command;
  if (command in REPO_HELPERS) {
    const p = REPO_HELPERS[command]!;
    return existsSync(p) ? p : null;
  }
  return null;
}

export function isCommandAllowed(command: string): boolean {
  return resolveAllowedExecutable(command) !== null;
}

export function allowedCommands(): string[] {
  return [...PATH_CMDS, ...Object.keys(REPO_HELPERS)];
}

/**
 * Redirection target path policy.
 *
 * Targets must be plain relative file names (no slash-heavy structure) and
 * must not escape the safe workspace. Absolute paths, "..", ".", "~",
 * NULs, and empty strings are rejected. The gateway chdir()s CAPS into the
 * workspace, so a valid name resolves to workspace/name.
 */
export function isSafeRedirTarget(name: string): boolean {
  if (name.length === 0 || name.length > 512) return false;
  if (name.includes("\0")) return false;
  if (name.includes("~")) return false;
  if (isAbsolute(name)) return false;
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
 * would land inside it (defense in depth; the chdir approach above is the
 * primary control).
 */
export function assertTargetInWorkspace(config: CapsConfig, target: string): void {
  if (!isSafeRedirTarget(target)) {
    throw new RedirectionPolicyError("redirection target rejected by path policy");
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
    const base = realpathSync(config.workspace).toLowerCase();
    const resolved = realpathSync(resolve(config.workspace, target));
    const normalized = resolved.toLowerCase();
    if (normalized !== base && !normalized.startsWith(base + sep)) {
      throw new RedirectionPolicyError("file argument escapes the workspace");
    }
    if (!statSync(resolved).isFile()) {
      throw new RedirectionPolicyError("file argument must name a regular file");
    }
  } catch (err) {
    if (err instanceof RedirectionPolicyError) throw err;
    throw new RedirectionPolicyError("file argument must be an existing workspace file");
  }
}

/**
 * Argument sanity limits (defense in depth against obviously absurd input).
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
