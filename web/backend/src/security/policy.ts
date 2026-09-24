import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";

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
const PATH_CMDS: string[] = ["echo", "printf", "sleep", "true", "false", "pwd", "cat", "uname", "sh"];
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
  // The file does not exist yet, so compare normalized strings rather than
  // realpath()-ing a candidate that would throw ENOENT. isSafeRedirTarget
  // already forbids ".."/absolute/empty segments, so resolution is provably
  // contained; this is defense in depth.
  const base = realpathSync(config.workspace);
  const baseNorm = base.toLowerCase();
  const candidate = resolve(config.workspace, target);
  const candNorm = candidate.toLowerCase();
  if (candNorm !== baseNorm && !candNorm.startsWith(baseNorm + sep)) {
    throw new RedirectionPolicyError("redirection target escapes the workspace");
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
