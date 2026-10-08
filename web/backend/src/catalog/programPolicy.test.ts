import { describe, expect, it } from "vitest";
import { findAwkProgramViolations, findSedScriptViolations } from "./programPolicy.js";

const kinds = (v: readonly { kind: string }[]): string[] => v.map((x) => x.kind);

describe("awk program policy", () => {
  it("accepts the catalog's own headline aggregate example", () => {
    expect(findAwkProgramViolations("{s+=$1} END {print s}")).toEqual([]);
  });

  it("refuses system(), which is a shell", () => {
    expect(kinds(findAwkProgramViolations('BEGIN{system("id > /tmp/x")}'))).toContain("shell-escape");
    expect(kinds(findAwkProgramViolations('BEGIN{ system ( "id" ) }'))).toContain("shell-escape");
    expect(kinds(findAwkProgramViolations("BEGIN{system()}"))).toContain("shell-escape");
  });

  it("refuses getline, which reads a file the path policy never approved", () => {
    expect(kinds(findAwkProgramViolations('BEGIN{while((getline l < "/etc/passwd")>0) print l}'))).toContain(
      "file-read",
    );
    expect(kinds(findAwkProgramViolations("NR>1{getline}"))).toContain("file-read");
  });

  it("refuses print redirection to a file outside the workspace", () => {
    expect(kinds(findAwkProgramViolations('BEGIN{print "pwned" > "/tmp/x"}'))).toContain("file-write");
    expect(kinds(findAwkProgramViolations('BEGIN{print "pwned" >> "/tmp/x"}'))).toContain("file-write");
    // The target may be a variable, so the operator is what matters, not the literal.
    expect(kinds(findAwkProgramViolations("BEGIN{print $1 > out}"))).toContain("file-write");
  });

  it("refuses piping print/printf to a command", () => {
    expect(kinds(findAwkProgramViolations('BEGIN{print "id" | "sh -c id"}'))).toContain("shell-escape");
  });

  it("refuses @load and @include", () => {
    expect(kinds(findAwkProgramViolations("@load \"evil.awk\"\n{print}"))).toContain("script-load");
    expect(kinds(findAwkProgramViolations("@include \"evil\"\n{print}"))).toContain("script-load");
  });

  it("keeps an ordinary comparison legal, including inside parentheses", () => {
    // The character after `print` is the same in all of these; only a parser
    // that tracks paren depth can tell the redirection from the comparison.
    expect(findAwkProgramViolations("{s += ($1 > 5)}")).toEqual([]);
    expect(findAwkProgramViolations("{n = ($1 > 5)}")).toEqual([]);
    expect(findAwkProgramViolations("{print ($1 > 5 ? \"big\" : \"small\")}")).toEqual([]);
  });

  it("still refuses a redirection whose target is a variable, not a literal", () => {
    // `print $1 > $2` IS a redirection in awk (to the file named by $2), so
    // refusing it is correct even though no path ever appears in the program.
    expect(kinds(findAwkProgramViolations("{print $1 > $2}"))).toContain("file-write");
  });

  it("does not mistake the word system inside a string literal for a call", () => {
    expect(findAwkProgramViolations('{print "system is not called here"}')).toEqual([]);
    expect(findAwkProgramViolations('{print "a > b"}')).toEqual([]);
  });
});

describe("sed script policy", () => {
  it("accepts the catalog's substitution example", () => {
    expect(findSedScriptViolations("s/a/A/")).toEqual([]);
    expect(findSedScriptViolations("-e s/a/A/")).toEqual([]);
    expect(findSedScriptViolations("s/a/A/g;s/b/B/")).toEqual([]);
  });

  it("refuses the w command, which writes a file", () => {
    expect(kinds(findSedScriptViolations("w /tmp/x"))).toContain("file-write");
    expect(kinds(findSedScriptViolations("s/a/b/;w /tmp/x"))).toContain("file-write");
    expect(kinds(findSedScriptViolations("s/a/b/w /tmp/x"))).toContain("file-write");
  });

  it("refuses the r command, which reads a file into the output", () => {
    expect(kinds(findSedScriptViolations("r /etc/passwd"))).toContain("file-read");
  });

  it("refuses GNU sed's e flag, which runs a shell", () => {
    expect(kinds(findSedScriptViolations("s/a/b/e"))).toContain("shell-escape");
  });

  it("does not mistake a substitution containing w or r for the file command", () => {
    expect(findSedScriptViolations("s/w/x/")).toEqual([]);
    expect(findSedScriptViolations("s/r/x/")).toEqual([]);
    expect(findSedScriptViolations("s/a/b/")).toEqual([]);
  });
});