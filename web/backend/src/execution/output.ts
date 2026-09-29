/**
 * Output-channel separation.
 *
 * Three streams share one file descriptor:
 *
 *   1. the CAPS monitor protocol  -- one JSON object per line on stderr;
 *   2. CAPS diagnostics           -- "caps: ..." lines on stderr;
 *   3. the executed program's own stdout and stderr.
 *
 * (1) and (2) are CAPS's own output and must never reach the user as command
 * output.  The previous runner appended the entire raw stderr chunk to the
 * session's stderr buffer *and then* appended each diagnostic line again, so
 * every diagnostic appeared twice and the protocol JSON was interleaved into
 * user-visible output.
 *
 * Honest limitation: (2) and (3) cannot be separated at descriptor
 * granularity, because the executed program inherits the same stderr.  What is
 * implemented is a line-based classification, which is exact for CAPS's own
 * lines (they are unambiguous by construction) and a best effort for the
 * target's.  This is stated in the API response and in the docs rather than
 * papered over.
 */

export type StreamClass = "monitor-event" | "caps-diagnostic" | "target-output" | "protocol-error";

export interface ClassifiedLine {
  text: string;
  kind: StreamClass;
  /** Present when kind is "monitor-event". */
  event?: Record<string, unknown>;
}

const EVENT_PREFIX = '{"event":"';

/**
 * A CAPS diagnostic always starts with the engine's own error prefix.  This is
 * produced by caps_error() in the C engine and is the only way CAPS writes a
 * non-protocol line, so it is a reliable discriminator.
 */
const DIAGNOSTIC_PREFIX = "caps: ";

/**
 * Classify one line of CAPS stderr.
 *
 * A line that begins a JSON object but fails to parse is reported as
 * `protocol-error` rather than being passed through as user output: a
 * truncated monitor line is a fault in the protocol, and silently showing it to
 * the user as if the command had printed it would be a false observation.
 */
export function classifyLine(rawLine: string): ClassifiedLine {
  const text = rawLine.replace(/\r$/, "");
  const trimmed = text.trimStart();

  if (trimmed.startsWith(EVENT_PREFIX)) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        return { text, kind: "monitor-event", event: parsed as Record<string, unknown> };
      }
    } catch {
      return { text, kind: "protocol-error" };
    }
    return { text, kind: "protocol-error" };
  }

  // A bare JSON object without the event key is still protocol, not output.
  if (trimmed.startsWith("{") && trimmed.includes("\"event\"")) {
    try {
      JSON.parse(trimmed);
      return { text, kind: "protocol-error" };
    } catch {
      return { text, kind: "protocol-error" };
    }
  }

  if (text.startsWith(DIAGNOSTIC_PREFIX)) {
    return { text, kind: "caps-diagnostic" };
  }

  return { text, kind: "target-output" };
}

/**
 * Split a chunk into complete lines, returning the unterminated remainder.
 *
 * The executed program's output has no guarantee of ever containing a newline,
 * so the remainder must be carried forward rather than dropped or emitted as a
 * partial line that would later be duplicated.
 */
export function splitLines(buffer: string): { lines: string[]; rest: string } {
  if (buffer.length === 0) return { lines: [], rest: "" };
  const parts = buffer.split("\n");
  const rest = parts.pop() ?? "";
  return { lines: parts, rest };
}
