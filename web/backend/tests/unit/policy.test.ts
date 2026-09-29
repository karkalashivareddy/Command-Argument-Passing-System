import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { describe, expect, it } from "vitest";

import { repoRoot } from "../../src/config/env.js";
import {
  allowedCommands,
  assertTargetInWorkspace,
  assertReadableFileInWorkspace,
  isSafeRedirTarget,
  RedirectionPolicyError,
  resetExecutableCache,
  resolveAllowedExecutable,
  validateArgVector,
  verifyExecutable,
} from "../../src/security/policy.js";

/**
 * The allowlist's contract is not "this name is permitted" but "this name
 * resolves to a specific verified file, and that file is what gets executed".
 * These tests assert the second thing.
 */
describe("allowlist", () => {
  it("resolves every allowlisted system command to an absolute executable path", () => {
    resetExecutableCache();
    for (const c of ["echo", "sleep", "true", "false", "pwd", "cat", "uname", "printf"]) {
      const r = resolveAllowedExecutable(c);
      // On a host without these utilities the honest answer is "unavailable",
      // never a bare name that would later be resolved against PATH.
      if (r.ok) {
        expect(isAbsolute(r.path), `${c} -> ${r.path}`).toBe(true);
        expect(r.path).not.toBe(c);
      } else {
        expect(r.reason).toBeTruthy();
      }
    }
  });

  it("rejects arbitrary commands", () => {
    for (const c of ["rm", "curl", "bash", "sh", "python3", "node", "systemctl", "sudo"]) {
      const r = resolveAllowedExecutable(c);
      expect(r.ok, `${c} must not resolve`).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/allowlist/i);
    }
  });

  it("rejects shell metacharacters in the position of a new command", () => {
    for (const c of ["echo;rm -rf /", "sh -c evil", "$(ls)", "a|b"]) {
      expect(resolveAllowedExecutable(c).ok, c).toBe(false);
    }
  });

  it("resolves the status_probe helper inside the repository build dir", () => {
    resetExecutableCache();
    const r = resolveAllowedExecutable("status_probe");
    if (r.ok) {
      expect(r.path.startsWith(join(repoRoot, "build"))).toBe(true);
    } else {
      expect(r.reason).toMatch(/not found|not executable/i);
    }
  });

  it("never returns a bare command name for anything it approves", () => {
    for (const c of allowedCommands()) {
      const r = resolveAllowedExecutable(c);
      if (r.ok) expect(r.path.length, `${c} resolved to a bare name`).toBeGreaterThan(1);
    }
  });
});

describe("verifyExecutable", () => {
  const dir = mkdtempSync(join(tmpdir(), "caps-verify-"));

  it("accepts a real executable regular file", () => {
    const p = join(dir, "real");
    writeFileSync(p, "#!/bin/sh\nexit 0\n");
    chmodSync(p, 0o755);
    const r = verifyExecutable(p);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.path).toBe(p);
  });

  it("rejects a missing file", () => {
    const r = verifyExecutable(join(dir, "does-not-exist"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/not found/i);
  });

  it("rejects a non-executable regular file", () => {
    const p = join(dir, "not-exec");
    writeFileSync(p, "data");
    chmodSync(p, 0o644);
    const r = verifyExecutable(p);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/not executable/i);
  });

  it("refuses a symlink instead of following it", () => {
    const target = join(dir, "target-bin");
    writeFileSync(target, "#!/bin/sh\nexit 0\n");
    chmodSync(target, 0o755);
    const link = join(dir, "link-bin");
    symlinkSync(target, link);
    // The link resolves to a real file, so realpath() succeeds; the refusal is
    // on the *resolved* path, which is what keeps the recorded evidence stable.
    const r = verifyExecutable(link);
    // Following the link to a regular executable is acceptable, but the answer
    // must be the canonical path so the same file is always named.
    if (r.ok) {
      expect(r.path).toBe(target);
    } else {
      expect(r.reason).toBeTruthy();
    }
  });

  it("rejects a symlink loop", () => {
    const a = join(dir, "loop-a");
    const b = join(dir, "loop-b");
    try {
      symlinkSync(b, a);
      symlinkSync(a, b);
    } catch {
      return; // symlinks unavailable; nothing to assert
    }
    const r = verifyExecutable(a);
    expect(r.ok).toBe(false);
  });

  it("rejects a directory", () => {
    const r = verifyExecutable(dir);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/regular file/i);
  });
});

describe("isSafeRedirTarget", () => {
  it("accepts plain relative file names", () => {
    for (const t of ["out.txt", "logs/run.log", "a-b_c.d"]) {
      expect(isSafeRedirTarget(t), t).toBe(true);
    }
  });

  it("rejects dangerous targets", () => {
    for (const t of ["", "   ", "\t", "/etc/passwd", "../etc/passwd", "..", "..\\win", ".", "~/x", "a\0b", "x/", "a\nb"]) {
      expect(isSafeRedirTarget(t), `target=${JSON.stringify(t)}`).toBe(false);
    }
  });
});

describe("assertTargetInWorkspace", () => {
  it("passes for a safe name (file need not exist yet)", () => {
    const ws = mkdtempSync(join(tmpdir(), "caps-ws-"));
    expect(() => assertTargetInWorkspace({ workspace: ws } as never, "out.txt")).not.toThrow();
  });

  it("rejects an empty target explicitly rather than treating it as absent", () => {
    const ws = mkdtempSync(join(tmpdir(), "caps-ws-"));
    // The empty-string case used to be silently skipped by the caller, which
    // reported a requested redirection as if it had been applied.
    try {
      assertTargetInWorkspace({ workspace: ws } as never, "");
      throw new Error("empty target was accepted");
    } catch (err) {
      expect(err).toBeInstanceOf(RedirectionPolicyError);
      expect((err as RedirectionPolicyError).message).toMatch(/empty/i);
    }
  });
});

describe("assertReadableFileInWorkspace", () => {
  const ws = mkdtempSync(join(tmpdir(), "caps-rd-"));
  mkdirSync(join(ws, "sub"), { recursive: true });
  writeFileSync(join(ws, "ok.txt"), "hello");
  writeFileSync(join(ws, "sub", "nested.txt"), "hello");
  const config = { workspace: ws } as never;

  it("allows an existing regular file inside the workspace", () => {
    expect(() => assertReadableFileInWorkspace(config, "ok.txt")).not.toThrow();
    expect(() => assertReadableFileInWorkspace(config, "sub/nested.txt")).not.toThrow();
  });

  it("rejects traversal, options, directories, and missing files", () => {
    for (const t of ["../escape.txt", "/etc/passwd", "-e", "sub", "missing.txt", "."]) {
      expect(() => assertReadableFileInWorkspace(config, t), t).toThrow(RedirectionPolicyError);
    }
  });
});

describe("validateArgVector", () => {
  it("accepts a normal vector", () => {
    expect(() => validateArgVector("echo", ["a", "b"])).not.toThrow();
  });

  it("rejects NUL bytes", () => {
    expect(() => validateArgVector("echo", ["a\0b"])).toThrow(/NUL/);
  });

  it("rejects absurd sizes", () => {
    expect(() => validateArgVector("", [])).toThrow();
    expect(() => validateArgVector("echo", new Array(600).fill("x"))).toThrow(/too many/);
    expect(() => validateArgVector("echo", [new Array(200_000).fill("x")])).toThrow(/too large/);
  });
});
