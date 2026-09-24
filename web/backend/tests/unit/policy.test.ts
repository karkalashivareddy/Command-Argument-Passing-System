import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { repoRoot } from "../../src/config/env.js";
import {
  assertTargetInWorkspace,
  assertReadableFileInWorkspace,
  isCommandAllowed,
  isSafeRedirTarget,
  RedirectionPolicyError,
  resolveAllowedExecutable,
  validateArgVector,
} from "../../src/security/policy.js";

describe("allowlist", () => {
  it("allows known commands", () => {
    for (const c of ["echo", "sleep", "true", "false", "pwd", "cat", "uname", "printf"]) {
      expect(isCommandAllowed(c)).toBe(true);
    }
  });

  it("rejects arbitrary commands", () => {
    for (const c of ["rm", "curl", "bash", "sh", "python3", "node", "systemctl", "sudo"]) {
      expect(isCommandAllowed(c)).toBe(false);
    }
  });

  it("rejects shell metacharacters in the position of a new command", () => {
    // These contain shell syntax. Even though we never invoke a shell, the
    // allowlist is name-based and the char literals cannot slip through.
    for (const c of ["echo;rm -rf /", "sh -c evil", "$(ls)", "a|b"]) {
      expect(isCommandAllowed(c)).toBe(false);
    }
  });

  it("resolves the status_probe helper to the repo build dir", () => {
    const resolved = resolveAllowedExecutable("status_probe");
    if (resolved !== null) {
      expect(resolved).toBe(join(repoRoot, "build", "status_probe"));
    }
  });
});

describe("isSafeRedirTarget", () => {
  it("accepts plain relative file names", () => {
    for (const t of ["out.txt", "logs/run.log", "a-b_c.d"]) {
      expect(isSafeRedirTarget(t)).toBe(true);
    }
  });

  it("rejects dangerous targets", () => {
    for (const t of ["", "/etc/passwd", "../etc/passwd", "..", "..\\win", ".", "~/x", "a\0b", "x/"]) {
      expect(isSafeRedirTarget(t), `target=${JSON.stringify(t)}`).toBe(false);
    }
  });
});

describe("assertTargetInWorkspace", () => {
  it("passes for a safe name (file need not exist yet)", () => {
    const ws = "/tmp/caps-policy-work";
    mkdirSync(ws, { recursive: true });
    const config = {
      capsExecutable: "caps",
      databasePath: "/tmp/caps-test/c.db",
      workspace: ws,
    };
    expect(() => assertTargetInWorkspace(config as Parameters<typeof assertTargetInWorkspace>[0], "out.txt")).not.toThrow();
  });
});

describe("assertReadableFileInWorkspace", () => {
  it("allows an existing regular file inside the workspace", () => {
    const ws = mkdtempSync(join(tmpdir(), "caps-cat-work-"));
    writeFileSync(join(ws, "read.txt"), "CAPS\n");
    const config = { capsExecutable: "caps", databasePath: "db", workspace: ws };
    expect(() => assertReadableFileInWorkspace(config as Parameters<typeof assertReadableFileInWorkspace>[0], "read.txt")).not.toThrow();
  });

  it("rejects traversal, options, and missing files", () => {
    const ws = mkdtempSync(join(tmpdir(), "caps-cat-work-"));
    const config = { capsExecutable: "caps", databasePath: "db", workspace: ws };
    for (const path of ["../outside.txt", "-n", "missing.txt"]) {
      expect(() => assertReadableFileInWorkspace(config as Parameters<typeof assertReadableFileInWorkspace>[0], path)).toThrow(RedirectionPolicyError);
    }
  });
});

describe("validateArgVector", () => {
  it("accepts a normal vector", () => {
    expect(() => validateArgVector("echo", ["hello", "world"])).not.toThrow();
  });

  it("rejects NUL bytes", () => {
    expect(() => validateArgVector("echo", ["a\0b"])).toThrow(RedirectionPolicyError);
  });

  it("rejects absurd sizes", () => {
    expect(() => validateArgVector("", [])).toThrow();
    expect(() => validateArgVector("echo", Array.from({ length: 600 }, () => "x"))).toThrow();
    expect(() => validateArgVector("echo", ["x".repeat(200_000)])).toThrow();
  });
});
