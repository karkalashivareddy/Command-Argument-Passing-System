import { AnimatePresence, motion } from "motion/react";
import { Check, ChevronDown, Copy, Crosshair, Filter, RadioTower, Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { EVENT_LABELS } from "../../lib/stages";
import { fmtClock, fmtDuration, truncate } from "../../lib/format";
import type { CanonicalEvent, CanonicalEventType, SessionStatus } from "../../types/observability";

/**
 * THE CONSOLE'S CATEGORIES ARE THE EVENT-TYPE CONTRACT, NOT A HOUSE STYLE.
 *
 * `CanonicalEventType` in types/observability.ts is the mirror of the backend's
 * own union, and every value in it is `<prefix>.<name>`. The prefix is the
 * engine's own grouping — the CAPS monitor emits process facts, the gateway
 * emits request and session facts — so grouping by it cannot contradict the
 * record the way an invented taxonomy ("system / user / error") would.
 *
 * The prefix is read off the type at runtime rather than hard-coded per type,
 * so a type added to the contract later lands in the right group instead of
 * silently falling through to "other".
 */
export type EventGroup = "command" | "redirection" | "process" | "signal" | "execution" | "pipeline" | "session";

export function groupForEvent(type: CanonicalEventType): EventGroup {
  const prefix = type.slice(0, type.indexOf("."));
  switch (prefix) {
    case "command":
      return "command";
    case "redirection":
      return "redirection";
    case "process":
      return "process";
    case "signal":
      return "signal";
    case "pipeline":
      return "pipeline";
    case "session":
      return "session";
    default:
      return "execution";
  }
}

interface GroupStyle {
  /** Short chip label. Abbreviated because the row is dense, not a card. */
  readonly label: string;
  /**
   * The glyph that carries the group when colour is unavailable. Each group has
   * a distinct one, so the category is legible in a monochrome screenshot and
   * to a reader who cannot separate the hues.
   */
  readonly glyph: string;
  /** What the colour means, stated once so the table can be read as a key. */
  readonly meaning: string;
  readonly text: string;
  readonly chip: string;
  readonly rail: string;
}

const GROUP_ORDER: readonly EventGroup[] = ["command", "redirection", "process", "signal", "execution", "pipeline", "session"];

/**
 * COLOUR ENCODES WHAT PRODUCED THE EVENT, NEVER WHICH ROW IT IS.
 *
 *   amber    fd plumbing          the record's I/O shape
 *   cyan     kernel/engine fact   OBSERVED process evidence
 *   red      asynchronous break-in  a signal arrived out of band
 *   violet   the execution envelope  gateway lifecycle transitions
 *   blue     the request itself     gateway bookkeeping about the request
 *   dim/dashed the aggregate envelope  pipeline.* describes stages as a whole
 *   white    the record's last word  session.summary is the monitor closing,
 *                                      which is emphatically NOT success
 *
 * No group is green. `session.summary` is deliberately not styled as a
 * completion: README records that a failed execvp() emits one too, so colouring
 * it like a successful outcome would assert something the record contradicts.
 */
const GROUP_STYLE: Record<EventGroup, GroupStyle> = {
  command: { label: "CMD", glyph: ">", meaning: "the request the gateway accepted", text: "text-[var(--blue)]", chip: "border-[var(--blue)]/40 bg-[var(--blue)]/10 text-[var(--blue)]", rail: "bg-[var(--blue)]" },
  redirection: { label: "FD", glyph: "fd", meaning: "file-descriptor plumbing", text: "text-[var(--amber)]", chip: "border-[var(--amber)]/40 bg-[var(--amber)]/10 text-[var(--amber)]", rail: "bg-[var(--amber)]" },
  process: { label: "PROC", glyph: "#", meaning: "kernel/engine process evidence", text: "text-[var(--accent)]", chip: "border-[var(--accent)]/40 bg-[var(--accent)]/10 text-[var(--accent)]", rail: "bg-[var(--accent)]" },
  signal: { label: "SIG", glyph: "!", meaning: "an asynchronous signal arrived", text: "text-[var(--red)]", chip: "border-[var(--red)]/40 bg-[var(--red)]/10 text-[var(--red)]", rail: "bg-[var(--red)]" },
  execution: { label: "EXEC", glyph: "◆", meaning: "the execution envelope", text: "text-[var(--violet)]", chip: "border-[var(--violet)]/40 bg-[var(--violet)]/10 text-[var(--violet)]", rail: "bg-[var(--violet)]" },
  pipeline: { label: "PIPE", glyph: "≡", meaning: "an envelope about the pipeline as a whole, not one stage", text: "text-[var(--fg-3)]", chip: "border-dashed border-[var(--line-1)] text-[var(--fg-3)]", rail: "bg-[var(--line-2)]" },
  session: { label: "SESS", glyph: "▪", meaning: "the monitor closing — not a success signal", text: "text-[var(--fg-0)]", chip: "border-[var(--fg-2)]/50 bg-[var(--bg-3)] text-[var(--fg-1)]", rail: "bg-[var(--fg-1)]" },
};

/**
 * The per-type tone used by the type chips above the list.
 *
 * It follows the group, so the chip and the rail can never disagree about which
 * category a row is in.
 */
function eventTone(type: CanonicalEventType): string {
  return GROUP_STYLE[groupForEvent(type)].text;
}

/**
 * The offset from the first recorded event, in real execution time.
 *
 * `fmtClock` alone cannot order events: several of them routinely share one
 * second, and a forensic reader needs to see the gap. This is a difference
 * between two recorded timestamps, never an interpolation, and an absent
 * origin reads as UNAVAILABLE rather than 0.
 */
function offsetOf(ev: CanonicalEvent, originMs: number | null): string {
  if (originMs === null) return "—";
  return fmtDuration(Math.max(0, new Date(ev.timestamp).getTime() - originMs));
}

interface EventRowProps {
  ev: CanonicalEvent;
  index: number;
  selected: boolean;
  onSelect: (ev: CanonicalEvent) => void;
  registerRow?: (sequence: number, element: HTMLLIElement | null) => void;
  originMs: number | null;
  /** Text-query match highlight; no highlight when the query is empty. */
  query: string;
}

function EventRow({ ev, index, selected, onSelect, registerRow, originMs, query }: EventRowProps) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const ll = open;
  const group = groupForEvent(ev.type);
  const style = GROUP_STYLE[group];
  const payload = ev.payload && Object.keys(ev.payload).length > 0 ? ev.payload : null;
  const panelId = `event-panel-${ev.sequence}`;
  const summary = payload === null ? "" : truncate(JSON.stringify(payload), 120);

  /*
   * The expander is its own focusable control rather than a click handler on the
   * whole <li>.
   *
   * The row previously expanded on mouse click alone: not focusable, no key
   * handler, so the payload was unreachable without a pointer. Wrapping the row
   * in a <button> was not an option either, because the row already contains the
   * select-event button and the copy-JSON button, and nesting interactive
   * controls inside a button is invalid and breaks their own activation. So the
   * row stays a plain list item and only the header line carries the expander
   * button, which is where a reader's pointer already was.
   */
  return (
    <motion.li
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18 }}
      className={`border-b border-[var(--line-0)] pl-1 pr-2 py-1 ${selected ? "bg-[var(--violet-soft)]" : "hover:bg-[var(--bg-2)]"}`}
      data-testid={`event-row-${index}`}
      data-event-type={ev.type}
      data-event-group={group}
      data-selected={selected ? "true" : undefined}
      aria-current={selected ? "true" : undefined}
      ref={(element: HTMLLIElement | null) => registerRow?.(ev.sequence, element)}
    >
      <div className="flex items-stretch gap-2">
        {/* The category rail: a colour the reader can scan vertically. */}
        <span aria-hidden="true" className={`w-0.5 shrink-0 rounded-full ${style.rail}`} />

        <div className="flex min-w-0 flex-1 items-center gap-2 font-mono text-[11.5px]">
          <span className="w-10 shrink-0 text-right tabular-nums text-[var(--fg-3)]">#{ev.sequence}</span>
          <span className="w-16 shrink-0 tabular-nums text-[var(--fg-3)]">{fmtClock(ev.timestamp)}</span>
          <span className="w-14 shrink-0 text-right tabular-nums text-[var(--fg-4)]" title="execution time since the first recorded event">
            {offsetOf(ev, originMs)}
          </span>
          <span
            className={`shrink-0 rounded-[var(--r-xs)] border px-1 font-mono text-[9px] font-bold uppercase tracking-[0.08em] ${style.chip}`}
            title={`${style.label} · ${style.meaning}`}
          >
            <span aria-hidden="true">{style.glyph}</span>
            <span className="sr-only">{style.label}: {style.meaning}. </span>
            {style.label}
          </span>
          <span className={`w-40 shrink-0 truncate font-semibold ${eventTone(ev.type)}`} title={ev.type}>
            {(EVENT_LABELS as Record<string, string>)[ev.type] ?? ev.type}
          </span>
          <span className="w-16 shrink-0 truncate tabular-nums text-[var(--fg-3)]" title={ev.pid === null ? "this event carries no PID in its envelope" : `PID ${ev.pid}`}>
            {ev.pid === null ? "pid —" : `pid ${ev.pid}`}
          </span>
          <span className="flex-1 truncate text-[var(--fg-2)]" title={summary || undefined}>
            {summary === "" ? "—" : <Highlighted text={summary} query={query} />}
          </span>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onSelect(ev);
            }}
            aria-pressed={selected}
            title={selected ? "This event is selected; it is highlighted in the timeline, the inspector, and the 3D view" : "Select this event: move the shared cursor here and correlate its process"}
            className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)] ${
              selected ? "bg-[var(--violet-soft)] text-[var(--violet)]" : "text-[var(--fg-4)] hover:text-[var(--violet)]"
            }`}
          >
            <Crosshair className="h-3 w-3" />
            <span className="sr-only">Select event #{ev.sequence}</span>
          </button>
          <button
            type="button"
            onClick={() => setOpen(!open)}
            aria-expanded={ll}
            aria-controls={panelId}
            aria-label={`${ll ? "Collapse" : "Expand"} event #${ev.sequence} (${ev.type})`}
            className="shrink-0 rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
          >
            <ChevronDown className={`h-3.5 w-3.5 text-[var(--fg-3)] transition-transform ${ll ? "rotate-180" : ""}`} />
          </button>
        </div>
      </div>
      <AnimatePresence>
        {ll ? (
          <motion.div
            id={panelId}
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className="ml-1 mt-2 overflow-hidden rounded-[var(--r-sm)] border border-[var(--line-1)] bg-[var(--bg-1)]"
          >
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 border-b border-[var(--line-0)] px-2.5 py-2 font-mono text-[10.5px] sm:grid-cols-4">
              <span><b className="font-medium text-[var(--fg-3)]">source</b><br />{ev.source}</span>
              <span><b className="font-medium text-[var(--fg-3)]">timestamp</b><br />{ev.timestamp}</span>
              <span><b className="font-medium text-[var(--fg-3)]">session</b><br />{ev.sessionId}</span>
              <span><b className="font-medium text-[var(--fg-3)]">PID</b><br />{ev.pid ?? "UNAVAILABLE"}</span>
              <span><b className="font-medium text-[var(--fg-3)]">monotonicMs</b><br />{ev.monotonicMs ?? "UNAVAILABLE"}</span>
              <span className="col-span-3"><b className="font-medium text-[var(--fg-3)]">group</b><br />{style.label} · {style.meaning}</span>
            </div>
            <div className="flex items-center justify-between px-2.5 pt-2 text-[10px] uppercase tracking-wide text-[var(--fg-3)]">
              <span>Normalized event envelope</span>
              <button
                type="button"
                className="inline-flex items-center gap-1 rounded px-1.5 py-1 text-[var(--fg-2)] hover:bg-[var(--bg-3)] hover:text-[var(--fg-0)]"
                aria-label="Copy event JSON"
                onClick={(e) => {
                  e.stopPropagation();
                  void navigator.clipboard.writeText(JSON.stringify(ev, null, 2)).then(() => setCopied(true));
                }}
              >
                {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}{copied ? "Copied" : "Copy JSON"}
              </button>
            </div>
            <pre className="max-h-64 overflow-auto px-2.5 pb-2.5 font-mono text-[10.5px] leading-relaxed text-[var(--fg-1)]">{JSON.stringify(ev, null, 2)}</pre>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </motion.li>
  );
}

/**
 * Marks the query's occurrences in a preview string.
 *
 * The match itself is computed over the WHOLE row (type + payload), not only
 * the visible preview, so highlighting can never claim to show a hit the reader
 * cannot see. Case-insensitive, because searching for `exitCode` and `exitcode`
 * must reach the same events.
 */
function Highlighted({ text, query }: { text: string; query: string }) {
  const needle = query.trim().toLowerCase();
  if (needle === "") return <>{text}</>;
  const parts: Array<{ value: string; hit: boolean }> = [];
  const haystack = text.toLowerCase();
  let cursor = 0;
  for (;;) {
    const at = haystack.indexOf(needle, cursor);
    if (at < 0) break;
    if (at > cursor) parts.push({ value: text.slice(cursor, at), hit: false });
    parts.push({ value: text.slice(at, at + needle.length), hit: true });
    cursor = at + needle.length;
  }
  if (parts.length === 0) return <>{text}</>;
  if (cursor < text.length) parts.push({ value: text.slice(cursor), hit: false });
  return (
    <>
      {parts.map((part, i) =>
        part.hit ? (
          <mark key={i} className="bg-[var(--accent-soft)] text-[var(--fg-0)]">{part.value}</mark>
        ) : (
          <span key={i}>{part.value}</span>
        ),
      )}
    </>
  );
}

/**
 * Chronological event console. Sequences always ascend (server-guaranteed);
 * entries animate in one at a time so motion is driven by real data.
 *
 * Each row can also be *selected*. Selection is event selection, not expansion:
 * it hands the canonical sequence to the shared store, which moves the cursor
 * to the event's own recorded timestamp and correlates the process it belongs
 * to. The selected row stays visible even while auto-follow is on, so a reader
 * can see what they selected.
 *
 * DENSITY IS THE POINT. A forensic reader scans hundreds of rows looking for one
 * type, one PID, or one payload value, so a row is a single line of monospace
 * columns with a category rail — not a card. The expanded payload is the one
 * place vertical space is spent, and it is opt-in.
 */
export function EventStream({
  events,
  status,
  live = false,
  emptyLabel = "No events for this session yet.",
  selectedSequence = null,
  onSelect,
  onClearSelection,
}: {
  events: CanonicalEvent[];
  status?: SessionStatus;
  live?: boolean;
  emptyLabel?: string;
  selectedSequence?: number | null;
  onSelect?: (ev: CanonicalEvent) => void;
  onClearSelection?: () => void;
}) {
  const stickEl = useRef<HTMLDivElement>(null);
  const [stick, setStick] = useState(true);
  const [tick, setTick] = useState(Date.now());
  const [filter, setFilter] = useState<CanonicalEventType | "ALL">("ALL");
  const [group, setGroup] = useState<EventGroup | "ALL">("ALL");
  const [query, setQuery] = useState("");
  const rows = useRef(new Map<number, HTMLLIElement>());

  /*
   * The origin is the first event's own timestamp, and it is null when there is
   * no record at all. A null origin renders as an em dash in the offset column
   * rather than "0ms": 0 ms is a real measured gap between two recorded events,
   * and using it for "we have nothing" is the substitution this file exists to
   * avoid.
   */
  const originMs = useMemo(() => (events.length > 0 ? new Date(events[0]!.timestamp).getTime() : null), [events]);

  /*
   * One searchable blob per event, built once per record.
   *
   * Serialising every payload on every keystroke is what makes a console feel
   * broken at a few thousand events, so the string is memoised on the event
   * identity rather than recomputed in the filter predicate. `id` is the
   * gateway's own event id, so a re-persisted record rebuilds the index.
   */
  const haystacks = useMemo(() => {
    const map = new Map<string, string>();
    for (const ev of events) map.set(ev.id, `${ev.type} ${JSON.stringify(ev.payload)}`.toLowerCase());
    return map;
  }, [events]);

  const filteredEvents = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return events.filter((e) => {
      if (filter !== "ALL" && e.type !== filter) return false;
      if (group !== "ALL" && groupForEvent(e.type) !== group) return false;
      if (needle === "") return true;
      return (haystacks.get(e.id) ?? "").includes(needle);
    });
  }, [events, filter, group, query, haystacks]);

  const registerRow = useMemo(
    () => (sequence: number, element: HTMLLIElement | null) => {
      if (element === null) rows.current.delete(sequence);
      else rows.current.set(sequence, element);
    },
    [],
  );

  // A selection made elsewhere (the 3D view, the timeline) is scrolled into
  // view here, so the list and the scene never disagree about what is selected.
  useEffect(() => {
    if (selectedSequence === null) return;
    const element = rows.current.get(selectedSequence);
    if (element === undefined) return;
    element.scrollIntoView({ block: "nearest", behavior: "auto" });
  }, [selectedSequence, filteredEvents]);

  // A type filter that the record no longer contains is stale, not an error.
  useEffect(() => {
    if (filter !== "ALL" && !events.some((e) => e.type === filter)) setFilter("ALL");
  }, [events, filter]);

  useEffect(() => {
    const t = window.setInterval(() => setTick(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);

  useEffect(() => {
    if (!stick) return;
    stickEl.current?.scrollIntoView({ block: "nearest", behavior: "auto" });
  }, [events.length, stick, selectedSequence]);

  const counts = useMemo(() => {
    const c = new Map<string, number>();
    for (const ev of events) c.set(ev.type, (c.get(ev.type) ?? 0) + 1);
    return c;
  }, [events]);

  const groupCounts = useMemo(() => {
    const c = new Map<EventGroup, number>();
    for (const ev of events) c.set(groupForEvent(ev.type), (c.get(groupForEvent(ev.type)) ?? 0) + 1);
    return c;
  }, [events]);

  const clearAll = () => {
    setFilter("ALL");
    setGroup("ALL");
    setQuery("");
  };
  const filtering = filter !== "ALL" || group !== "ALL" || query.trim() !== "";

  return (
    <div className="flex flex-col">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--line-0)] px-2 py-1">
        <span className="text-[10.5px] uppercase tracking-[0.12em] text-[var(--fg-3)]">
          {live ? "live sequence" : "sequence"} · {filteredEvents.length}{filtering ? ` / ${events.length} of ` : " "}{events.length} event{events.length === 1 ? "" : "s"}
          {filtering ? " · filtered" : ""}
        </span>
        <button
          onClick={() => setStick(!stick)}
          aria-pressed={stick}
          className={`rounded-[var(--r-sm)] px-1.5 py-0.5 text-[10.5px] font-semibold ${stick ? "bg-[var(--accent-soft)] text-[var(--accent)]" : "text-[var(--fg-3)] hover:text-[var(--fg-1)]"}`}
        >
          {stick ? "auto-follow ▲" : "paused ▼"}
        </button>
      </div>
      {selectedSequence !== null ? (
        <div className="flex flex-wrap items-center gap-2 border-b border-[var(--line-0)] bg-[var(--violet-soft)] px-2 py-1 text-[10.5px] text-[var(--violet)]">
          <Crosshair className="h-3 w-3" />
          <span className="font-mono">selected event #{selectedSequence}</span>
          <span className="text-[var(--fg-3)]">the shared cursor and every synchronized view follow this event</span>
          {onClearSelection ? (
            <button type="button" onClick={onClearSelection} className="ml-auto underline decoration-dotted underline-offset-2 hover:text-[var(--fg-0)]">
              clear event selection
            </button>
          ) : null}
        </div>
      ) : null}

      {/*
        Filter bar: category group first, then the exact type, then a text query.
        The category row doubles as the colour key, so the semantic meaning of
        each hue is stated where the hue is used instead of in a legend the
        reader has to hold in their head.
      */}
      {events.length > 0 ? (
        <div className="space-y-1.5 border-b border-[var(--line-0)] px-2 py-1.5">
          <div className="flex flex-wrap items-center gap-1">
            <Filter className="h-3 w-3 text-[var(--fg-4)]" aria-hidden="true" />
            <button
              onClick={() => setGroup("ALL")}
              aria-pressed={group === "ALL"}
              className={`rounded-[var(--r-xs)] px-1.5 py-0.5 font-mono text-[10.5px] transition-colors ${group === "ALL" ? "bg-[var(--accent-soft)] text-[var(--accent)]" : "bg-[var(--bg-2)] text-[var(--fg-3)] hover:text-[var(--fg-1)]"}`}
            >
              ALL CATEGORIES ×{events.length}
            </button>
            {GROUP_ORDER.filter((g) => (groupCounts.get(g) ?? 0) > 0).map((g) => {
              const style = GROUP_STYLE[g];
              return (
                <button
                  key={g}
                  onClick={() => setGroup(group === g ? "ALL" : g)}
                  aria-pressed={group === g}
                  title={style.meaning}
                  className={`rounded-[var(--r-xs)] border px-1.5 py-0.5 font-mono text-[10.5px] transition-colors ${style.chip} ${group === g ? "ring-1 ring-[var(--accent)]" : "opacity-70 hover:opacity-100"}`}
                >
                  <span aria-hidden="true">{style.glyph}</span> {style.label} ×{groupCounts.get(g) ?? 0}
                </button>
              );
            })}
          </div>

          <div className="flex flex-wrap items-center gap-1">
            <button
              onClick={() => setFilter("ALL")}
              aria-pressed={filter === "ALL"}
              className={`rounded-[var(--r-xs)] px-1.5 py-0.5 font-mono text-[10.5px] transition-colors ${filter === "ALL" ? "bg-[var(--accent-soft)] text-[var(--accent)]" : "bg-[var(--bg-2)] text-[var(--fg-3)] hover:text-[var(--fg-1)]"}`}
            >
              ALL TYPES ×{events.length}
            </button>
            {[...counts.entries()].map(([type, n]) => (
              <button
                key={type}
                onClick={() => setFilter(filter === type ? "ALL" : (type as CanonicalEventType))}
                aria-pressed={filter === type}
                title={type}
                className={`rounded-[var(--r-xs)] px-1.5 py-0.5 font-mono text-[10.5px] transition-colors ${filter === type ? "bg-[var(--accent-soft)] text-[var(--accent)]" : "bg-[var(--bg-2)] text-[var(--fg-3)] hover:text-[var(--fg-1)]"} ${eventTone(type as CanonicalEventType)}`}
              >
                {(EVENT_LABELS as Record<string, string>)[type] ?? type} ×{n}
              </button>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="flex min-w-[14rem] flex-1 items-center gap-1.5 rounded-[var(--r-sm)] border border-[var(--line-1)] bg-[var(--bg-2)] px-2 focus-within:border-[var(--accent)]">
              <Search className="h-3 w-3 shrink-0 text-[var(--fg-3)]" aria-hidden="true" />
              {/*
                `aria-label` rather than a placeholder as the name: a placeholder
                vanishes the moment the reader types, so the one control that
                searches the whole record would be announced as "edit, blank".
              */}
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                aria-label="Search event type and payload"
                placeholder="search type + payload…"
                className="h-7 flex-1 bg-transparent font-mono text-[11px] text-[var(--fg-0)] placeholder:text-[var(--fg-3)] focus:outline-none"
              />
              {query !== "" ? (
                <button type="button" onClick={() => setQuery("")} aria-label="Clear event search" className="text-[var(--fg-3)] hover:text-[var(--fg-0)]">
                  <X className="h-3 w-3" />
                </button>
              ) : null}
            </div>
            {filtering ? (
              <button type="button" onClick={clearAll} className="inline-flex items-center gap-1 rounded-[var(--r-xs)] px-1.5 py-0.5 font-mono text-[10.5px] text-[var(--fg-3)] hover:text-[var(--fg-0)]">
                <X className="h-3 w-3" /> clear filters
              </button>
            ) : null}
            <span className="font-mono text-[9.5px] text-[var(--fg-4)]">{filteredEvents.length} shown</span>
          </div>
        </div>
      ) : null}

      {events.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-10 text-[var(--fg-3)]">
          <RadioTower className="h-5 w-5" />
          <p className="text-[12.5px]">{emptyLabel}</p>
          {status && status === "RUNNING" ? <p className="text-[11px]">Waiting for the engine to start the process…</p> : null}
        </div>
      ) : filteredEvents.length === 0 ? (
        // An empty result under an active filter is a STATEMENT ABOUT THE
        // FILTER, never about the record: the gateway may well hold events, they
        // just do not match. Saying "no events" here would tell a reader that
        // nothing ran.
        <div className="flex flex-col items-center gap-2 py-8 text-[var(--fg-3)]">
          <Filter className="h-4 w-4" />
          <p className="text-[12px]">No recorded event matches this filter.</p>
          <p className="max-w-sm text-[11px]">
            The record still holds {events.length} event{events.length === 1 ? "" : "s"}; none of them match the current category, type, or search.
          </p>
          <button type="button" onClick={clearAll} className="rounded-[var(--r-xs)] px-2 py-1 font-mono text-[10.5px] text-[var(--accent)] hover:bg-[var(--accent-soft)]">
            clear filters
          </button>
        </div>
      ) : (
        <ul className="max-h-[460px] overflow-y-auto" onScroll={() => setStick(true)}>
          {filteredEvents.map((ev, i) => (
            <EventRow
              key={`${ev.sequence}-${ev.type}`}
              ev={ev}
              index={i}
              selected={ev.sequence === selectedSequence}
              onSelect={(event) => onSelect?.(event)}
              registerRow={registerRow}
              originMs={originMs}
              query={query}
            />
          ))}
          <div ref={stickEl} />
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 px-2 py-1.5 text-[10.5px] text-[var(--fg-3)]">
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--accent)]" />
          sequences re-checked at {fmtClock(new Date(tick).toISOString())} · every new event animates in
        </span>
        <span className="font-mono text-[var(--fg-4)]">
          offset column = execution time since the first recorded event (gateway receive timestamps, not kernel time)
        </span>
      </div>
    </div>
  );
}
