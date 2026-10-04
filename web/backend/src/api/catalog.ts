/**
 * Command catalog API.
 *
 * ONE SOURCE OF TRUTH
 * --------------------
 * The frontend holds no command list.  It fetches this endpoint and renders
 * exactly what the backend will accept, which is the only way to prevent the
 * two from disagreeing.  A duplicated list in the UI would drift, and the drift
 * would show a user a command marked "available" that the gateway then refuses
 * -- the most disorienting failure a product like this can have.
 *
 * Availability is computed by probing the real filesystem on every request,
 * memoised per process.  It is NOT a hard-coded `available: true`, because a
 * command being declared says nothing about whether this machine has it.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { catalogNames, catalogSummary, probeCatalog, probeCommand, TRUSTED_DIRECTORIES } from "../catalog/commands.js";
import { commandHelp } from "../catalog/validation.js";
import { logger } from "../utils/logger.js";

export interface CatalogRouteDeps {
  version: string;
}

const NAME_PARAM = z.object({
  name: z.string().min(1).max(64).regex(/^[A-Za-z0-9_.-]+$/),
});

function sendError(reply: FastifyReply, status: number, code: string, message: string): FastifyReply {
  return reply.code(status).send({ error: { code, message } });
}

export function registerCatalogRoutes(app: FastifyInstance, deps: CatalogRouteDeps): void {
  /**
   * The whole catalog with probed availability.
   *
   * Also returns the policies that are NOT in the catalog and why.  A user who
   * types `bash -c 'rm -rf /'` deserves to be told that CAPS is not a shell,
   * and that refusal is a design decision rather than a missing feature.
   */
  app.get("/api/catalog", async () => {
    const commands = probeCatalog();
    return {
      version: deps.version,
      summary: catalogSummary(),
      /**
       * Where a system command may be resolved from, in order.  Published so
       * the resolved path in each entry can be checked against a known list.
       */
      trustedDirectories: TRUSTED_DIRECTORIES,
      commands,
      grammar: {
        summary:
          "A command line is lexed by the C engine, not by a shell. Quoting and backslash escapes are honoured; nothing else is interpreted.",
        supported: [
          { syntax: "'literal'", meaning: "Single-quoted argument. Every byte is literal, backslash included." },
          { syntax: '"literal"', meaning: "Double-quoted argument. Backslash escapes only \" \\ $ ` and newline." },
          { syntax: "\\x", meaning: "Outside quotes, escapes the next byte." },
          { syntax: "|", meaning: "Connects two stages with a real OS pipe. Each stage is its own forked process." },
          { syntax: ">", meaning: "Stage stdout to a workspace file, truncated." },
          { syntax: ">>", meaning: "Stage stdout to a workspace file, appended." },
          { syntax: "<", meaning: "Stage stdin from a workspace file." },
          { syntax: "2>", meaning: "Stage stderr to a workspace file, truncated." },
          { syntax: "2>>", meaning: "Stage stderr to a workspace file, appended." },
          { syntax: "#", meaning: "At the start of a token, begins a comment to end of line." },
        ],
        notSupported: [
          { syntax: "&& || ;", reason: "Command lists and conditional chaining are not implemented. Run the stages separately; the evidence is per-run anyway." },
          { syntax: "$(...) `...`", reason: "Command substitution is not implemented. These are ordinary literal characters, not syntax." },
          { syntax: "$VAR ${VAR}", reason: "Variable expansion is not implemented. The child's environment is a fixed four-variable allowlist." },
          { syntax: "* ? [ ] { }", reason: "Globbing and brace expansion are not implemented by CAPS. These characters reach the program unchanged; if the program globs, that is the program's own behaviour and is visible in its recorded argv." },
          { syntax: "&", reason: "Background jobs are not implemented. A stage runs in the foreground and is reaped before CAPS reports the result." },
          { syntax: "subshell ( )", reason: "Not implemented. Parentheses reach the program as literal arguments." },
        ],
        limits: {
          maxStages: 16,
          maxArgumentsPerStage: 4096,
          maxTokenBytes: 20000,
          maxLineBytes: 65536,
        },
      },
      refusedByPolicy: REFUSED_COMMANDS,
    };
  });

  /** One command's probed state, for a terminal autocomplete or a status line. */
  app.get("/api/catalog/:name", async (req, reply) => {
    const params = NAME_PARAM.safeParse(req.params ?? {});
    if (!params.success) {
      return sendError(reply, 400, "INVALID_ARGUMENT", "A command name may contain only letters, digits, underscore, dot, and hyphen.");
    }
    const { name } = params.data;
    const help = commandHelp(name);
    if (help === null) {
      return sendError(
        reply,
        404,
        "NOT_IN_CATALOG",
        `"${name}" is not a CAPS command. ${describeRefusal(name)}`,
      );
    }
    return { ...probeCommand(name), help };
  });

  /** Explicit per-command help, as the terminal's `help <command>` renders it. */
  app.get("/api/catalog/:name/help", async (req, reply) => {
    const params = NAME_PARAM.safeParse(req.params ?? {});
    if (!params.success) {
      return sendError(reply, 400, "INVALID_ARGUMENT", "A command name may contain only letters, digits, underscore, dot, and hyphen.");
    }
    const help = commandHelp(params.data.name);
    if (help === null) {
      return sendError(reply, 404, "NOT_IN_CATALOG", `"${params.data.name}" is not a CAPS command. ${describeRefusal(params.data.name)}`);
    }
    return help;
  });

  /** Help for every command, so a client can render the whole reference at once. */
  app.get("/api/catalog/help", async () => {
    return catalogNames()
      .map((name) => commandHelp(name))
      .filter((h): h is NonNullable<typeof h> => h !== null);
  });

  app.get("/api/catalog/categories", async () => {
    const commands = probeCatalog();
    const byCategory = new Map<string, { category: string; commands: string[]; available: number }>();
    for (const c of commands) {
      const entry = byCategory.get(c.category) ?? { category: c.category, commands: [], available: 0 };
      entry.commands.push(c.name);
      if (c.availability === "AVAILABLE") entry.available += 1;
      byCategory.set(c.category, entry);
    }
    return { categories: [...byCategory.values()].sort((a, b) => a.category.localeCompare(b.category)) };
  });

  app.addHook("onClose", async () => {
    logger.debug("SERVER", "catalog routes closed");
  });
}

/**
 * Commands a reader might reasonably try, and why CAPS refuses them.
 *
 * Publishing the refusals with their reasons is more useful than an opaque
 * 403.  Each entry names the specific property that makes the command unsafe
 * here, rather than asserting that it is "dangerous" in general: `cat` is
 * perfectly safe with a confined path and `uname` is harmless, so a blanket
 * "dangerous" claim would not be true and would not be useful.
 */
const REFUSED_COMMANDS: ReadonlyArray<{ name: string; reason: string }> = [
  { name: "bash", reason: "A shell would turn a catalog entry into arbitrary command execution. CAPS execs each stage directly and never spawns a shell." },
  { name: "sh", reason: "Same as bash. `sh -c` is the single most common way an argv allowlist is defeated." },
  { name: "dash", reason: "A shell, same as bash. dash -c would turn one catalog entry into arbitrary command execution, which is the whole thing the catalog exists to prevent." },
  { name: "zsh", reason: "A shell, same as bash. Any shell gives -c arbitrary command execution and would bypass every argument schema in the catalog." },
  { name: "fish", reason: "A shell, same as bash. fish -c is arbitrary command execution and would bypass every argument schema in the catalog." },
  { name: "sudo", reason: "Privilege escalation. Every command in this catalog runs as the gateway's own user by design." },
  { name: "su", reason: "Privilege escalation, same as sudo. Every catalog command runs as the gateway user by design; none may become another user." },
  { name: "ssh", reason: "Network egress to an arbitrary host. Nothing in an observability product needs it." },
  { name: "scp", reason: "Network egress plus a filesystem write to an arbitrary remote host, same as ssh. Nothing in an observability product needs it." },
  { name: "curl", reason: "Network egress with arbitrary URL and header control." },
  { name: "wget", reason: "Network egress with arbitrary URL control, same as curl." },
  { name: "nc", reason: "Opens a raw socket to any host and port." },
  { name: "ncat", reason: "Opens a raw socket to any host and port, same as nc. It is a network client with no observational purpose here." },
  { name: "python", reason: "An interpreter is arbitrary code execution by another name. It would also defeat every argument schema in this catalog." },
  { name: "python3", reason: "An interpreter, same as python. It is arbitrary code execution by another name and would defeat every argument schema in the catalog." },
  { name: "node", reason: "An interpreter, same as python. It is arbitrary code execution by another name and would defeat every argument schema in the catalog." },
  { name: "perl", reason: "An interpreter, same as python. Arbitrary code execution, and it would defeat every argument schema in the catalog." },
  { name: "ruby", reason: "An interpreter, same as python. Arbitrary code execution, and it would defeat every argument schema in the catalog." },
  { name: "php", reason: "An interpreter, same as python. Arbitrary code execution, and it would defeat every argument schema in the catalog." },
  { name: "gcc", reason: "Compiles and writes executables, which is a code-execution primitive." },
  { name: "clang", reason: "A compiler, same as gcc. It writes executables, which is a code-execution primitive rather than an observation." },
  { name: "make", reason: "Runs arbitrary build recipes, which is arbitrary code execution by another name. Every shell command in a Makefile is attacker-influenced input." },
  { name: "rm", reason: "Deletes files. The workspace confinement limits the damage, but no read-only catalog entry should be able to remove evidence." },
  { name: "mv", reason: "Same as rm: it removes a name from a directory. Workspace confinement limits the damage, but no read-only catalog entry should be able to remove evidence." },
  { name: "chmod", reason: "Changes permissions, including making a workspace file executable or world-writable." },
  { name: "chown", reason: "Changes ownership, which is a privilege-relevant write." },
  { name: "mount", reason: "Changes the host's mount table." },
  { name: "umount", reason: "Changes the host mount table, same as mount. No observation requires altering what is mounted." },
  { name: "systemctl", reason: "Controls system services, which is host state management rather than observation." },
  { name: "kill", reason: "Signals an arbitrary PID. CAPS signals only the processes it owns, and it verifies their identity first." },
  { name: "pkill", reason: "Signals processes by pattern, so it can reach processes CAPS does not own. CAPS signals only processes it started, and verifies their identity first." },
  { name: "killall", reason: "Signals processes by name, same as pkill. It can reach processes CAPS does not own and has no identity verification at all." },
  { name: "dd", reason: "Writes a chosen number of bytes to a chosen target, which is destructive by construction. With oflag=direct a device path becomes a raw write." },
];

/** The refusal reason for a name, or a generic statement. */
export function describeRefusal(name: string): string {
  const hit = REFUSED_COMMANDS.find((c) => c.name === name);
  if (hit !== undefined) return hit.reason;
  return `CAPS executes only the commands declared in its catalog. ${catalogNames().length} are declared; run GET /api/catalog for the list and each one's availability on this host.`;
}

export { REFUSED_COMMANDS };
