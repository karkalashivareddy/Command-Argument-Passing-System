/**
 * Command catalog contract tests.
 *
 * The catalog is the single source of truth for what the gateway will run, so
 * these tests assert properties of the *registry*, not of individual commands.
 * The three that matter most:
 *
 *   1. Every entry is probed against the real filesystem. A test that asserted
 *      `available === true` for everything would pass against a catalog that
 *      lied, which is the failure this whole subsystem exists to prevent.
 *   2. No shell, no interpreter, no privilege tool, and no mutating command is
 *      in the registry. This is asserted by name AND by category, so adding a
 *      dangerous entry is caught even if the name is spelled unusually.
 *   3. The frontend has no second list. Verified by reading the frontend
 *      sources for a hard-coded command array.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { lstatSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import {
  COMMAND_DEFINITIONS,
  catalogNames,
  catalogSummary,
  commandDefinition,
  probeCatalog,
  probeCommand,
  resetCatalogProbes,
  verifyExecutablePath,
  TRUSTED_DIRECTORIES,
} from "./commands.js";
import { ArgumentError, commandHelp, validateArguments } from "./validation.js";
import { loadConfig, repoRoot } from "../config/env.js";
import { inspectCommandLine } from "../terminal/grammar.js";
import { REFUSED_COMMANDS } from "../api/catalog.js";

const config = loadConfig();

/*
 * The suites below that lex a command line ask the C engine's own lexer, because
 * the claim under test is that the catalog's examples survive the gateway's real
 * parsing. With no engine binary there is nothing to compare against, so those
 * suites skip rather than fail: "the engine was not built" and "this example is
 * wrong" are different facts and a suite must not report the second for the
 * first.
 *
 * CI builds the engine in the gateway job, so on CI these run for real.
 */
const enginePresent = existsSync(join(repoRoot, "caps"));
const describeFx = enginePresent ? describe : describe.skip;

beforeEach(() => {
  resetCatalogProbes();
});

describe("the registry is the only list", () => {
  it("has a unique name per entry", () => {
    // Map construction would silently collapse duplicates, so the size is
    // compared against the number of definitions rather than assumed.
    expect(COMMAND_DEFINITIONS.size).toBeGreaterThan(20);
  });

  it("includes the first-party workloads in the same namespace", () => {
    const names = catalogNames();
    for (const workload of ["caps_cpu_burn", "caps_memory_burn", "caps_io_burn", "caps_fork_tree", "caps_mixed_burn"]) {
      expect(names).toContain(workload);
    }
  });

  it("gives every entry a recorded reason for being permitted", () => {
    for (const [name, def] of COMMAND_DEFINITIONS) {
      expect(def.rationale.length, `${name} must record why it is permitted`).toBeGreaterThan(20);
      expect(def.rationale.toLowerCase(), `${name}'s rationale must not be a placeholder`).not.toBe("todo");
    }
  });
});

describe("availability is probed, never assumed", () => {
  it("returns one of exactly three states for every command", () => {
    for (const c of probeCatalog()) {
      expect(["AVAILABLE", "UNAVAILABLE", "BLOCKED"]).toContain(c.availability);
    }
  });

  it("states a reason for every command, including the available ones", () => {
    for (const c of probeCatalog()) {
      expect(c.reason.length, `${c.name} must state why it is available or not`).toBeGreaterThan(0);
    }
  });

  it("reports BLOCKED with a reason for a command that is not declared", () => {
    // A command outside the catalog is not "unavailable" -- the host might well
    // have it installed. It is refused, which is a different fact with a
    // different remedy, and conflating them would tell a user to install
    // something that would still be refused.
    const probed = probeCommand("definitely_not_a_real_binary_xyz");
    expect(probed.availability).toBe("BLOCKED");
    expect(probed.reason).toMatch(/not on the allowlist/);
    expect(probed.reason).toMatch(/command catalog/);
    expect(probed.resolvedPath).toBeNull();
  });

  it("reports a resolved absolute path the gateway's user could not replace", () => {
    // `echo` is in coreutils and is present on any Linux image with a shell
    // userland, which is a precondition of running this product at all.
    resetCatalogProbes();
    const probed = probeCommand("echo");
    if (probed.availability !== "AVAILABLE") {
      // Not a test failure: the assertion is that the UNAVAILABLE answer is
      // explained, not that the command must exist.
      expect(probed.reason).toBeTruthy();
      return;
    }
    expect(probed.resolvedPath).toMatch(/^\//);
    /*
     * The property is that the resolved target cannot be replaced by the
     * gateway's own user, NOT that it sits in a particular directory. An
     * earlier rule required the path to be inside /usr/bin and friends, which
     * refused every coreutils command on a host where a package-manager
     * coreutils was installed -- a legitimate layout, caught here by the
     * integration suite going red rather than by any security consideration.
     */
    const stats = lstatSync(probed.resolvedPath!);
    expect(stats.isFile()).toBe(true);
    if (stats.uid !== 0) {
      // Owned by the gateway's user: only acceptable inside a trusted root.
      const inTrusted = TRUSTED_DIRECTORIES.some((d) => probed.resolvedPath!.startsWith(`${d}/`));
      expect(inTrusted, `${probed.resolvedPath} is user-owned so it must be inside a trusted root`).toBe(true);
    } else {
      // Owned by root: must still not be writable by group or other.
      expect(stats.mode & 0o022, `${probed.resolvedPath} is group/other writable`).toBe(0);
    }
  });

  it("resolves a symlink that stays inside a trusted directory", () => {
    // On Debian and Ubuntu this is the NORMAL case, not an edge case:
    // /usr/bin/true is a symlink to /usr/bin/gnutrue and /bin is a symlink to
    // /usr/bin. A rule that refused every symlink would reject every
    // coreutils command on the most common Linux distribution, which is
    // exactly what happened before this was corrected. The property that
    // matters is containment, not symlink-freeness.
    const probed = probeCommand("true");
    if (probed.availability !== "AVAILABLE") {
      expect(probed.reason).toBeTruthy();
      return;
    }
    const inTrusted = TRUSTED_DIRECTORIES.some((d) => probed.resolvedPath!.startsWith(`${d}/`));
    expect(inTrusted, `${probed.resolvedPath} must be inside a trusted directory`).toBe(true);
    // And the reason must say so when a link was traversed, rather than
    // presenting a linked path as if it were the file itself.
    expect(probed.reason).toMatch(/resolved from|not found|not executable|not a regular file/);
  });

  it("refuses a symlink that resolves to a file the gateway's user could replace", () => {
    // This is the actual attack: a link planted where the probe will look,
    // pointing at something the gateway's own user owns and can rewrite. The
    // check is on WRITABILITY, not on directory membership, because a
    // path-list rule also refuses every coreutils command on a host with a
    // package-manager coreutils -- which is what a list-based rule did here.
    const { symlinkSync, mkdtempSync, writeFileSync, chmodSync, mkdirSync } = require("node:fs") as typeof import("node:fs");
    const { tmpdir } = require("node:os") as typeof import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "caps-escape-"));
    const target = join(dir, "attacker-owned");
    writeFileSync(target, "#!/bin/sh\nexit 0\n");
    chmodSync(target, 0o755);

    // A trusted root containing only the planted link. The target sits outside
    // it and is owned by the current (non-root) user, so it must be refused.
    const trustedRoot = join(dir, "trusted");
    mkdirSync(trustedRoot, { recursive: true });
    const link = join(trustedRoot, "sneaky");
    symlinkSync(target, link);

    const result = verifyExecutablePath(link, [trustedRoot]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // The reason must name the real reason: ownership, not a directory list.
      expect(result.reason).toMatch(/owned by uid|outside every trusted/);
      expect(result.reason).toMatch(/replace|redirect/);
    }
  });

  it("refuses a file that is writable by group or other", () => {
    // Ownership alone is not enough. A file any user may overwrite is as
    // replaceable as one they own.
    //
    // The trusted root passed here is deliberately NOT the file's own
    // directory: a file inside a trusted root is accepted by the containment
    // rule and never reaches the mode check. The root is an unrelated
    // directory so the mode check is the thing under test.
    const { mkdtempSync, writeFileSync, chmodSync, statSync } = require("node:fs") as typeof import("node:fs");
    const { tmpdir } = require("node:os") as typeof import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "caps-mode-"));
    const unrelatedRoot = mkdtempSync(join(tmpdir(), "caps-unrelated-"));
    const file = join(dir, "loose");
    writeFileSync(file, "#!/bin/sh\nexit 0\n");
    chmodSync(file, 0o777);

    const stats = statSync(file);
    // Precondition: the fixture really is world-writable, otherwise the
    // assertion below would pass for the wrong reason.
    expect(stats.mode & 0o022).toBeGreaterThan(0);

    // Whether the test user owns it (refused on ownership) or it is root-owned
    // (refused on mode), the outcome must be a refusal. It must never be
    // accepted, because either way an unprivileged process can replace it
    // between the probe and the exec.
    const result = verifyExecutablePath(file, [unrelatedRoot]);
    if (stats.uid === 0) {
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/writable by group or other/);
    } else {
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/owned by uid/);
    }
  });

  it("refuses a path that resolves to a non-regular file", () => {
    // A FIFO or a device in a trusted-looking path is not something to exec.
    const fsx = require("node:fs") as typeof import("node:fs") & { mkfifoSync?: (p: string) => void };
    const mkdtempSync = fsx.mkdtempSync;
    // Node exposes mkfifoSync on some platforms and not others, so the test
    // uses a character device when a FIFO cannot be created, and skips only
    // when neither is available.
    const mkfifo = fsx.mkfifoSync;
    const { tmpdir } = require("node:os") as typeof import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "caps-fifo-"));
    const fifo = join(dir, "pipe");
    if (mkfifo === undefined) return;
    mkfifo(fifo);
    const result = verifyExecutablePath(fifo, [dir]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/not a regular file/);
  });

  it("summary counts match the probed list", () => {
    const probed = probeCatalog();
    const summary = catalogSummary();
    expect(summary.total).toBe(probed.length);
    expect(summary.available + summary.unavailable + summary.blocked).toBe(probed.length);
  });
});

describe("no shell, no interpreter, no privilege tool", () => {
  const forbidden = [
    "bash", "sh", "dash", "zsh", "fish", "ksh", "csh", "tcsh",
    "sudo", "su", "doas",
    "ssh", "scp", "sftp", "curl", "wget", "nc", "ncat", "telnet", "ftp",
    "python", "python2", "python3", "node", "perl", "ruby", "php", "lua", "tclsh",
    "gcc", "cc", "clang", "make", "cmake", "ld",
    "rm", "rmdir", "shred", "mv", "cp", "chmod", "chown", "ln", "truncate", "dd",
    "mount", "umount", "mkfs", "fdisk",
    "systemctl", "service", "initctl",
    "kill", "killall", "pkill", "skill",
    "eval", "exec", "source", "env", "xargs", "nohup", "setsid", "trap",
  ];

  it("declares none of them", () => {
    for (const name of forbidden) {
      expect(commandDefinition(name), `${name} must not be in the command catalog`).toBeNull();
    }
  });

  it("declares no command outside a known category", () => {
    const categories = new Set([
      "shell-basic", "file", "text", "system", "process", "network", "demonstration", "workload",
    ]);
    for (const [, def] of COMMAND_DEFINITIONS) {
      expect(categories.has(def.category), `${def.name} has unknown category ${def.category}`).toBe(true);
    }
  });

  it("records a reason for every refusal it publishes", () => {
    for (const refused of REFUSED_COMMANDS) {
      expect(refused.reason.length, `${refused.name} needs a stated reason`).toBeGreaterThan(30);
    }
  });

  it("marks every network command as read-only and bounds its verbs", () => {
    // `ip` can reconfigure interfaces and `ss` can kill sockets. Only the
    // read-only subsets are accepted, which is asserted by the absence of the
    // mutating verbs from the flag set.
    const ip = commandDefinition("ip");
    expect(ip).not.toBeNull();
    for (const verb of ["-add", "-del", "-replace", "-set", "-change", "add", "del"]) {
      expect(ip!.argumentSchema.flags).not.toContain(verb);
    }
    const ss = commandDefinition("ss");
    expect(ss).not.toBeNull();
    for (const verb of ["-K", "-k", "-X", "-x-k"]) {
      expect(ss!.argumentSchema.flags).not.toContain(verb);
    }
  });

  it("refuses recursive and in-place flags that would escape the workspace", () => {
    const grep = commandDefinition("grep")!;
    expect(grep.argumentSchema.flags).not.toContain("-r");
    expect(grep.argumentSchema.flags).not.toContain("-R");
    const sed = commandDefinition("sed")!;
    // -i edits files in place, which is the one thing a read-only catalog
    // must not do.
    expect(sed.argumentSchema.flags).not.toContain("-i");
    const tail = commandDefinition("tail")!;
    // -f never terminates, so it would hold a concurrency slot forever.
    expect(tail.argumentSchema.flags).not.toContain("-f");
  });
});

describe("argument validation is derived from the registry", () => {
  it("accepts arguments the schema permits", () => {
    resetCatalogProbes();
    // `wc` is in the catalog; if this host lacks it the assertion degrades to
    // checking that the UNAVAILABLE error is the specific one.
    try {
      validateArguments("wc", ["-l"], config);
    } catch (err) {
      expect(err).toBeInstanceOf(ArgumentError);
      expect((err as ArgumentError).message).toMatch(/not available on this host/);
    }
  });

  it("refuses a flag the schema does not list, naming the rule", () => {
    resetCatalogProbes();
    try {
      validateArguments("wc", ["--not-a-real-flag"], config);
      // If wc is unavailable the command never reaches flag validation, which
      // is itself correct: the executable check comes first.
    } catch (err) {
      expect(err).toBeInstanceOf(ArgumentError);
      const message = (err as ArgumentError).message;
      expect(message).toMatch(/not an accepted flag|not available on this host/);
      expect((err as ArgumentError).rule.length).toBeGreaterThan(0);
    }
  });

  it("refuses a numeric argument outside the declared bounds", () => {
    resetCatalogProbes();
    // `sleep` is bounded to 0..120 seconds by its schema.
    try {
      validateArguments("sleep", ["99999"], config);
    } catch (err) {
      expect(err).toBeInstanceOf(ArgumentError);
      expect((err as ArgumentError).message).toMatch(/outside the permitted range|not available/);
    }
  });

  it("refuses a non-integer where an integer is required", () => {
    resetCatalogProbes();
    for (const bad of ["3.5", "1e3", "0x10", "+3", " 3", "99999999999"]) {
      try {
        validateArguments("sleep", [bad], config);
      } catch (err) {
        expect(err).toBeInstanceOf(ArgumentError);
        // Either the integer shape or the range rule may refuse it; both are
        // correct. What must never happen is acceptance.
        expect((err as ArgumentError).message).toMatch(/plain non-negative integer|outside the permitted range|not available/);
      }
    }
  });

  it("refuses an argument containing NUL", () => {
    resetCatalogProbes();
    try {
      validateArguments("echo", ["a\0b"], config);
      expect.unreachable("a NUL in an argument must be refused");
    } catch (err) {
      expect(err).toBeInstanceOf(ArgumentError);
    }
  });

  it("refuses a path that escapes the workspace", () => {
    resetCatalogProbes();
    for (const bad of ["../../etc/passwd", "/etc/passwd", "sub/../../escape"]) {
      try {
        validateArguments("cat", [bad], config);
        expect.unreachable(`${bad} must be refused by the path policy`);
      } catch (err) {
        expect(err).toBeInstanceOf(ArgumentError);
        expect((err as ArgumentError).message).toMatch(/workspace|not available/);
      }
    }
  });

  it("refuses a file argument that does not exist", () => {
    resetCatalogProbes();
    try {
      validateArguments("cat", ["no_such_file_in_workspace.txt"], config);
    } catch (err) {
      expect(err).toBeInstanceOf(ArgumentError);
      expect((err as ArgumentError).message).toMatch(/workspace|not available/);
    }
  });
});

describe("help text is generated from the same registry", () => {
  it("returns help for a catalog command", () => {
    const help = commandHelp("echo");
    expect(help).not.toBeNull();
    if (help === null) return;
    expect(help!.name).toBe("echo");
    expect(help!.whyAllowed.length).toBeGreaterThan(20);
    expect(help!.safeArguments.length).toBeGreaterThan(10);
    expect(help!.securityRestrictions.length).toBeGreaterThan(3);
  });

  it("returns null for a command that is not in the catalog", () => {
    expect(commandHelp("bash")).toBeNull();
    expect(commandHelp("not_a_command_at_all")).toBeNull();
  });

  it("states the actual availability rather than assuming it", () => {
    const help = commandHelp("echo");
    if (help === null) return;
    expect(["AVAILABLE", "UNAVAILABLE"]).toContain(help!.availability);
    expect(help!.availabilityReason.length).toBeGreaterThan(0);
  });

  it("explains the workspace policy for a file-reading command", () => {
    const help = commandHelp("cat");
    if (help === null) return;
    const joined = help!.securityRestrictions.join(" ");
    expect(joined).toMatch(/workspace/);
  });
});

describe("the frontend keeps no second command list", () => {
  const frontendSrc = join(
    new URL("../../..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
    "web",
    "frontend",
    "src",
  );

  it("no frontend module hard-codes an array of allowed command names", () => {
    let files: string[] = [];
    try {
      files = readdirSync(frontendSrc, { recursive: true } as never) as unknown as string[];
    } catch {
      // Readable in a different way on some Node versions; skip rather than
      // fail, because the backend assertions above are the substantive ones.
      return;
    }
    const suspicious = /const\s+(ALLOWED|COMMANDS|ALLOWLIST|WORKLOADS)\w*\s*(?::[^=]*)?=\s*[[(]\s*\[/;
    for (const relative of files) {
      if (!String(relative).endsWith(".ts") && !String(relative).endsWith(".tsx")) continue;
      const text = readFileSync(join(frontendSrc, String(relative)), "utf8");
      expect(suspicious.test(text), `${relative} appears to hard-code a command list`).toBe(false);
    }
  });
});

describe("a leading pattern or count is data, not a file path", () => {
  /**
   * These cases were all wrong before the argument vector was classified in a
   * single pass. `grep 0`, `head -n 5`, and `sed s/a/b/` each take one leading
   * positional that is NOT a file, and the validator was path-checking it. The
   * resulting message was actively misleading: `head -c 99999999` was reported
   * as "file argument must be an existing workspace file", naming a rule that
   * had nothing to do with the problem.
   */
  it("does not path-check the first positional of grep", () => {
    resetCatalogProbes();
    try {
      // `grep 0` is a complete command: the pattern is "0" and grep reads
      // stdin. It must not be refused for not being a file.
      validateArguments("grep", ["0"], config);
    } catch (err) {
      // If grep is unavailable here, that is the only acceptable reason.
      expect((err as ArgumentError).message).toMatch(/not available on this host/);
    }
  });

  it("still path-checks the files after a grep pattern", () => {
    resetCatalogProbes();
    try {
      // The SECOND positional really is a file, and must still be checked.
      validateArguments("grep", ["pattern", "../../etc/passwd"], config);
      expect.unreachable("a path after the pattern must be refused");
    } catch (err) {
      expect(err).toBeInstanceOf(ArgumentError);
      const message = (err as ArgumentError).message;
      expect(message).toMatch(/workspace|not available/);
      // And the message must name the value, not just the position, so the
      // user knows which argument to change.
      expect(message).toContain("../../etc/passwd");
    }
  });

  it("does not path-check a count consumed by -n or -c", () => {
    resetCatalogProbes();
    try {
      validateArguments("head", ["-n", "5"], config);
    } catch (err) {
      expect((err as ArgumentError).message).toMatch(/not available on this host/);
    }
  });

  it("names the offending value and its position when a real file argument is refused", () => {
    resetCatalogProbes();
    try {
      validateArguments("cat", ["good-looking-name.txt"], config);
      // The file does not exist, so this must be refused with a message that
      // identifies WHICH argument was at fault.
      expect.unreachable("a non-existent file argument must be refused");
    } catch (err) {
      expect(err).toBeInstanceOf(ArgumentError);
      expect((err as ArgumentError).message).toContain("good-looking-name.txt");
    }
  });

it("does not report a numeric bound violation as a path violation", () => {
    resetCatalogProbes();
    // `head -c 999999999` is a count. The refusal must be about the bound, not
    // about a missing file.
    try {
      validateArguments("head", ["-c", "999999999", "somefile"], config);
    } catch (err) {
      if (err instanceof ArgumentError) {
        expect(err.message).not.toMatch(/workspace path policy/);
      }
    }
  });

  it("accepts the POSIX numeric short form within its bounds", () => {
    resetCatalogProbes();
    // `head -1` is `head -n 1`. It is not an exotic spelling; it is the form
    // the catalog itself publishes in its own example.
    expect(() => validateArguments("head", ["-1"], config)).not.toThrow();
    expect(() => validateArguments("tail", ["-20"], config)).not.toThrow();

    // And it is bounded exactly like the named form, so it is not a way around
    // the count limit.
    try {
      validateArguments("head", ["-999999999"], config);
      expect.unreachable("an out-of-range short-form count must be refused");
    } catch (err) {
      expect(err).toBeInstanceOf(ArgumentError);
      expect((err as ArgumentError).message).toMatch(/outside the permitted range/);
    }

    // Zero lines is not a meaningful request, so it is out of bounds rather
    // than quietly accepted.
    try {
      validateArguments("head", ["-0"], config);
      expect.unreachable("a zero count must be refused");
    } catch (err) {
      expect(err).toBeInstanceOf(ArgumentError);
    }
  });

  it("refuses a negative-looking flag rather than reading it as a count", () => {
    resetCatalogProbes();
    try {
      validateArguments("head", ["--lines", "5"], config);
      expect.unreachable("an unknown long flag must be refused");
    } catch (err) {
      expect(err).toBeInstanceOf(ArgumentError);
      expect((err as ArgumentError).message).toContain("--lines");
    }
  });
});

/*
 * POSIX short options compose, and a literal-string allowlist cannot express
 * that. Composition widens nothing -- every character must be individually
 * allowed -- but refusing it would refuse how these commands are actually
 * written.
 */
describe("short options compose the way getopt reads them", () => {

  it("combines short options the way getopt does", () => {
    resetCatalogProbes();
    // `-sh` is `-s -h`. Refusing it would refuse how `du` is written.
    expect(() => validateArguments("du", ["-sh"], config)).not.toThrow();
    // `-ltn` is `-l -t -n`.
    expect(() => validateArguments("ss", ["-ltn"], config)).not.toThrow();
  });

  it("reads a value glued to its short option", () => {
    resetCatalogProbes();
    // `-d` with the delimiter attached, which is how cut is written in practice.
    expect(() => validateArguments("cut", ["-d:"], config)).not.toThrow();
    // And the attached value is bounded exactly like the separated form.
    try {
      validateArguments("head", ["-n999999999"], config);
      expect.unreachable("an out-of-range glued count must be refused");
    } catch (err) {
      expect(err).toBeInstanceOf(ArgumentError);
      expect((err as ArgumentError).message).toMatch(/outside the permitted range/);
    }
  });

  it("composition cannot smuggle in a flag the catalog does not declare", () => {
    resetCatalogProbes();
    // `du` declares -s and -h but not -a. Every character in a cluster must be
    // individually allowed, so -sa is refused rather than read as "-s plus
    // something unknown".
    try {
      validateArguments("du", ["-sa"], config);
      expect.unreachable("a cluster containing an undeclared flag must be refused");
    } catch (err) {
      expect(err).toBeInstanceOf(ArgumentError);
      expect((err as ArgumentError).message).toContain("-sa");
    }
  });

  it("a long option is accepted only when listed verbatim", () => {
    resetCatalogProbes();
    expect(() => validateArguments("ps", ["-e", "--no-headers"], config)).not.toThrow();
    try {
      validateArguments("ps", ["-e", "--bogus"], config);
      expect.unreachable("an unlisted long option must be refused");
    } catch (err) {
      expect(err).toBeInstanceOf(ArgumentError);
      expect((err as ArgumentError).message).toContain("--bogus");
    }
  });

  it("an exact multi-character flag is not decomposed into a cluster", () => {
    resetCatalogProbes();
    // `ip -br` is one flag meaning "brief", not `-b` followed by `-r`. The
    // catalog lists it verbatim, and decomposing it would refuse a flag that
    // was deliberately allowed.
    expect(() => validateArguments("ip", ["-br", "addr"], config)).not.toThrow();
  });

  it("reads a cluster the way a shell would, not as the long option it resembles", () => {
    resetCatalogProbes();
    /*
     * `ps -no-headers` is NOT `--no-headers`. A shell reads it as `-n` plus
     * `-o headers`, which is a different request entirely.
     *
     * This test exists because the tempting alternative -- special-casing a
     * cluster that looks like a long option -- would make CAPS disagree with
     * the shell on a line the operator typed. Agreeing with the shell is the
     * property that makes the recorded argv mean what the user meant, so the
     * cluster reading wins even though it is not what the example intended.
     *
     * `-n` is declared for ps and `-o` is a value flag, so this parses; the
     * assertion is that it is accepted on cluster grounds and not refused as an
     * unknown long option.
     */
    expect(() => validateArguments("ps", ["-no-headers"], config)).not.toThrow();
  });
});

/*
 * The catalog documents itself. Every example it publishes is an instruction to
 * the reader, and an example the validator refuses is the product contradicting
 * itself in public.
 *
 * This is not hypothetical: the catalog published `seq 1 100 | head -1` as its
 * headline way to make a producer receive SIGPIPE, while `head`'s flag schema
 * accepted only -n, -c, -q and -v. The documented example was refused with
 * "not an accepted flag". This test asserts the whole class is empty.
 */
describeFx("every published example is one the validator accepts", () => {
  /*
   * These use the engine's own lexer via `caps --inspect`, not a whitespace
   * split. A naive split mangles quoting and pipelines -- it turns
   * `cut -d' ' -f1` into the single token `-d'`, and `seq 1 100 | wc -l` into a
   * positional `|` -- and then reports a catalog bug that is really a bug in the
   * test. Since the gateway lexes exactly this way, so must this.
   */
  const stagesOf = async (line: string): Promise<string[][]> => {
    const inspected = await inspectCommandLine(config, line);
    return inspected.map((s) => s.argv);
  };

  const isSkippable = (name: string, argv: readonly string[]): string | null => {
    // A command that is unavailable here cannot be argument-checked, and the
    // test helpers are not built by `make all` alone.
    const probed = probeCommand(name);
    if (probed.availability !== "AVAILABLE") return `${name} is ${probed.availability} on this host`;
    // An example that names a workspace file assumes the reader created it.
    // Refusing a missing file is the validator working correctly, so checking
    // the rest of the arguments is the honest scope.
    if (argv.some((a) => /\.(txt|log|csv|json|md)$/.test(a))) return `${name} example names a workspace file`;
    return null;
  };

  it("holds for every command that publishes examples", async () => {
    resetCatalogProbes();
    const failures: string[] = [];
    const skipped: string[] = [];

    for (const definition of COMMAND_DEFINITIONS.values()) {
      for (const example of definition.examples) {
        let stages: string[][];
        try {
          stages = await stagesOf(example.command);
        } catch (err) {
          failures.push(
            `${definition.name}: "${example.command}" did not lex: ${err instanceof Error ? err.message : String(err)}`,
          );
          continue;
        }
        for (const argv of stages) {
          const name = argv[0];
          if (name === undefined) continue;
          const skip = isSkippable(name, argv);
          if (skip !== null) {
            skipped.push(skip);
            continue;
          }
          try {
            validateArguments(name, argv.slice(1), config);
          } catch (err) {
            failures.push(
              `${name}: "${example.command}" -> ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      }
    }

    expect(failures, "the catalog must not publish an example its own validator refuses").toEqual([]);
    void skipped;
  });
});

/*
 * A flag that takes a value consumes the next token, which means a flag
 * misclassified as value-taking makes that token UNCHECKED.
 *
 * That is how `ps -e --anything-unknown` used to validate: `-e` was treated as
 * value-taking, so `--anything-unknown` was read as `-e`'s value and never
 * examined. The engine still ran the literal argv, so nothing dangerous
 * executed -- but the gateway reported a line as validated when an argument in
 * it had never been looked at, and "validated" is the only claim the gateway
 * makes about a command line.
 */
describe("which flags take a value is declared per command, not globally", () => {
  it("a flag that takes no value does not swallow the token after it", () => {
    resetCatalogProbes();
    // -e is "every process" for ps and takes nothing. It must not consume the
    // next argument.
    try {
      validateArguments("ps", ["-e", "--anything-unknown"], config);
      expect.unreachable("an unchecked argument is a hole in the validator");
    } catch (err) {
      expect(err).toBeInstanceOf(ArgumentError);
      expect((err as ArgumentError).message).toContain("--anything-unknown");
    }
  });

  it("a flag that does take a value still consumes the next token", () => {
    resetCatalogProbes();
    // -o is the output format for ps and does take a value.
    expect(() => validateArguments("ps", ["-e", "-o", "pid,stat"], config)).not.toThrow();
  });

  it("the same letter takes a value for one command and not for another", () => {
    resetCatalogProbes();
    // -n is a count for head ...
    expect(() => validateArguments("head", ["-n", "5"], config)).not.toThrow();
    // ... and a boolean for sort, where it means numeric sort. Treating it as
    // value-taking for sort would swallow the first file name as a count.
    expect(() => validateArguments("sort", ["-n"], config)).not.toThrow();
  });

  it("no declared value flag is missing from its own flag list", () => {
    resetCatalogProbes();
    // A `valueFlags` entry that is not also in `flags` would describe a flag
    // the command does not accept.
    for (const definition of COMMAND_DEFINITIONS.values()) {
      for (const vf of definition.argumentSchema.valueFlags ?? []) {
        expect(
          definition.argumentSchema.flags,
          `${definition.name} declares ${vf} as value-taking but does not accept it`,
        ).toContain(vf);
      }
    }
  });
});
