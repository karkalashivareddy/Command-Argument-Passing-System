/**
 * A program operand is code, and CAPS must refuse the ones that escape the model.
 *
 * WHY THIS SUITE IS AN API SUITE AND NOT A UNIT SUITE
 * ---------------------------------------------------
 * catalog/programPolicy.test.ts proves the scanner recognises the constructs.
 * It cannot prove the scanner is *reached* on the path a real request takes. The
 * hole this pins was real and total: the gateway validated, accepted and EXECUTED
 *
 *   awk 'BEGIN{system("id > /tmp/x")}'
 *
 * through the documented `/api/terminal/execute` route, writing a file outside the
 * workspace in a product whose whole security story is "no shell, allowlisted argv,
 * workspace confinement" -- while the same catalog refuses python, perl, node, ruby,
 * php, gcc and make for being "arbitrary code execution by another name".
 *
 * So the assertion that matters is the end-to-end one: the request is refused at
 * the API boundary, and the file is not written. A scanner regression that is not
 * wired in, or is wired in behind a flag, is invisible to a unit test and would
 * restore the hole silently.
 */

import { existsSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  TERMINAL,
  engineAvailable,
  startTestServer,
  stopTestServer,
  type StartedServer,
} from "./harness.js";

/** Paths that must not exist after the suite: every one is outside the workspace. */
const ESCAPE_TARGETS = [
  "/tmp/caps-escape-system.txt",
  "/tmp/caps-escape-redir.txt",
  "/tmp/caps-escape-pipe.txt",
  "/tmp/caps-escape-sedw.txt",
] as const;

describe.skipIf(!engineAvailable)("program operands may not escape the model", () => {
  let started: StartedServer;

  beforeAll(async () => {
    started = await startTestServer();
  });
  afterAll(() => {
    stopTestServer(started);
    for (const p of ESCAPE_TARGETS) {
      if (existsSync(p)) throw new Error(`escape artifact survived the suite: ${p}`);
    }
  });

  async function validate(commandLine: string) {
    const res = await started.app.inject({
      method: "POST",
      url: TERMINAL.validate,
      payload: { commandLine },
    });
    return { status: res.statusCode, body: res.json() as { valid?: boolean; error?: { message?: string } } };
  }

  /**
   * Each line is a real escape from the workspace or from "no shell". They are
   * asserted one at a time so a failure names the construct, not "the policy".
   */
  const ESCAPES: ReadonlyArray<readonly [string, string]> = [
    ["awk system() is a shell", `awk 'BEGIN{system("id > /tmp/caps-escape-system.txt")}'`],
    ["awk print redirection writes a file", `awk 'BEGIN{print "pwned" > "/tmp/caps-escape-redir.txt"}'`],
    ["awk print pipe runs a command", `awk 'BEGIN{print "id" | "sh -c id > /tmp/caps-escape-pipe.txt"}'`],
    ["awk getline reads any file", `awk 'BEGIN{while((getline l < "/etc/passwd")>0) print l}'`],
    ["sed w writes a file", `sed 'w /tmp/caps-escape-sedw.txt' data.txt`],
    ["sed e flag runs a shell", `sed 's/a/b/e' data.txt`],
  ];

  for (const [what, commandLine] of ESCAPES) {
    it(`refuses ${what}`, async () => {
      const { status, body } = await validate(commandLine);
      expect(status).toBe(403);
      expect(body.valid).toBeFalsy();
      // The refusal must name the construct, or the user cannot act on it.
      expect(body.error?.message ?? "").toMatch(/may not/i);
    });
  }

  it("refuses at execute time too, not only at validate time", async () => {
    // Validation and execution are two entry points into the same runner. A
    // policy that only guarded the first would still be a hole.
    const res = await started.app.inject({
      method: "POST",
      url: TERMINAL.execute,
      payload: { commandLine: `awk 'BEGIN{system("id > /tmp/caps-escape-system.txt")}'` },
    });
    expect(res.statusCode).toBe(403);
  });

  it("executes nothing, so no escape artifact is written", async () => {
    // Belt and braces on the afterAll check: if any of the above had run, the
    // artifact would exist right now.
    for (const p of ESCAPE_TARGETS) expect(existsSync(p)).toBe(false);
  });

  /*
   * A policy that refuses everything would pass every assertion above. These
   * two prove the rules did not simply forbid the tools, because the aggregate
   * and substitution forms are the reason awk and sed are in the catalog at all.
   */
  it("still accepts the catalog's own awk aggregate example", async () => {
    const { status, body } = await validate(`seq 1 10 | awk '{s+=$1} END {print s}'`);
    expect(status).toBe(200);
    expect(body.valid).toBe(true);
  });

  it("still accepts a plain sed substitution", async () => {
    const { status, body } = await validate(`printf 'a\\nb\\n' | sed 's/a/A/'`);
    expect(status).toBe(200);
    expect(body.valid).toBe(true);
  });

  it("still accepts an awk program containing a comparison", async () => {
    // `>` inside parentheses is a comparison, not a redirection. A policy that
    // matched the character instead of parsing it would refuse this.
    const { status, body } = await validate(`seq 1 10 | awk '{n += ($1 > 5)} END {print n}'`);
    expect(status).toBe(200);
    expect(body.valid).toBe(true);
  });
});
