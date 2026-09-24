import { describe, expect, it } from "vitest";

import { parseCapsLine, repairLineChunks } from "../../src/execution/parser.js";

describe("parseCapsLine", () => {
  it("recognizes a valid monitor event line", () => {
    const r = parseCapsLine('{"event":"PROCESS_STARTED","command":"sleep","pid":42}');
    expect(r.kind).toBe("event");
    if (r.kind === "event") {
      expect(r.event?.event).toBe("PROCESS_STARTED");
      expect(r.event?.pid).toBe(42);
    }
  });

  it("treats a caps diagnostic (non-JSON) as a diagnostic", () => {
    const r = parseCapsLine("caps: command not found: nope");
    expect(r.kind).toBe("diagnostic");
    if (r.kind === "diagnostic") expect(r.text).toContain("nope");
  });

  it("treats a malformed JSON-looking line as a diagnostic, never a crash", () => {
    const r = parseCapsLine('{"event": BROKEN');
    expect(r.kind).toBe("diagnostic");
  });

  it("treats an empty line as an empty diagnostic", () => {
    expect(parseCapsLine("").kind).toBe("diagnostic");
  });
});

describe("repairLineChunks", () => {
  it("splits complete lines and keeps the trailing partial chunk", () => {
    const r = repairLineChunks('{"a":1}\n{"b":2}\n{"c":');
    expect(r.lines).toHaveLength(2);
    expect(r.rest).toBe('{"c":');
  });

  it("holds a line without a trailing newline in rest (flushed on close)", () => {
    const r = repairLineChunks("caps: diagnostic");
    expect(r.lines).toHaveLength(0);
    expect(r.rest).toBe("caps: diagnostic");
  });

  it("emits a line as complete only when terminated by a newline", () => {
    const r = repairLineChunks("caps: diagnostic\n");
    expect(r.lines).toEqual(["caps: diagnostic"]);
    expect(r.rest).toBe("");
  });
});