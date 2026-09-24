export type RawCapsEvent = Record<string, unknown>;

export interface ParseLineResult {
  kind: "event" | "diagnostic";
  event?: RawCapsEvent;
  text?: string;
}

/**
 * Interpret one stderr line from `caps --monitor --json`.
 *
 * CAPS guarantees "one JSON object per line" on its monitor stream, but a
 * failed exec also writes `caps: ...` diagnostics to the same stderr.
 * Parsing is intentionally liberal: any line that starts with `{` and is
 * valid JSON is treated as an event; everything else is a diagnostic.
 * A malformed JSON-looking line is a diagnostic, never a crash.
 */
export function parseCapsLine(line: string): ParseLineResult {
  const trimmed = line.trimEnd();
  if (trimmed.startsWith("{")) {
    try {
      return { kind: "event", event: JSON.parse(trimmed) as RawCapsEvent };
    } catch {
      return { kind: "diagnostic", text: trimmed };
    }
  }
  if (trimmed.length === 0) return { kind: "diagnostic", text: "" };
  return { kind: "diagnostic", text: trimmed };
}

export function repairLineChunks(buffer: string): { lines: string[]; rest: string } {
  const lines = buffer.split("\n");
  const rest = lines.pop() ?? "";
  return { lines, rest };
}