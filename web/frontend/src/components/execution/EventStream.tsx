import { AnimatePresence, motion } from "motion/react";
import { Check, ChevronDown, Copy, Crosshair, RadioTower } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { EVENT_LABELS } from "../../lib/stages";
import { fmtClock, truncate } from "../../lib/format";
import type { CanonicalEvent, SessionStatus } from "../../types/observability";

function eventTone(type: CanonicalEvent["type"]): string {
  if (type.startsWith("redirection.")) return "text-[var(--amber)]";
  if (type.startsWith("signal.") || type.startsWith("terminate.")) return "text-[var(--red)]";
  if (type.startsWith("process.") || type.startsWith("fork.")) return "text-[var(--cyan)]";
  if (type.startsWith("caps.") || type.startsWith("execution.") || type.startsWith("session.")) return "text-[var(--violet)]";
  return "text-[var(--fg-2)]";
}

interface EventRowProps {
  ev: CanonicalEvent;
  index: number;
  selected: boolean;
  onSelect: (ev: CanonicalEvent) => void;
  registerRow?: (sequence: number, element: HTMLLIElement | null) => void;
}

function EventRow({ ev, index, selected, onSelect, registerRow }: EventRowProps) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const ll = open;
  const payload = ev.payload && Object.keys(ev.payload).length > 0 ? ev.payload : null;

  return (
    <motion.li
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18 }}
      className={`cursor-pointer border-b border-[var(--line-0)] px-2 py-1.5 ${selected ? "bg-[var(--violet-soft)]" : "hover:bg-[var(--bg-2)]"}`}
      onClick={() => setOpen(!open)}
      data-testid={`event-row-${index}`}
      data-selected={selected ? "true" : undefined}
      aria-current={selected ? "true" : undefined}
      ref={(element: HTMLLIElement | null) => registerRow?.(ev.sequence, element)}
    >
      <div className="flex items-center gap-2.5 font-mono text-[11.5px]">
        <span className="w-10 shrink-0 text-right tabular-nums text-[var(--fg-3)]">#{ev.sequence}</span>
        <span className="w-20 shrink-0 tabular-nums text-[var(--fg-3)]">{fmtClock(ev.timestamp)}</span>
        <span className={`shrink-0 font-semibold ${eventTone(ev.type)}`}>{ev.type}</span>
        {payload ? (
          <span className="flex-1 truncate text-[var(--fg-2)]">
            {truncate(JSON.stringify(payload), 96)}
          </span>
        ) : (
          <span className="flex-1 text-[var(--fg-4)]">—</span>
        )}
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
        <ChevronDown className={`h-3.5 w-3.5 shrink-0 text-[var(--fg-3)] transition-transform ${ll ? "rotate-180" : ""}`} />
      </div>
      <AnimatePresence>
        {ll ? (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className="mt-2 overflow-hidden rounded-[var(--r-sm)] border border-[var(--line-1)] bg-[var(--bg-1)]"
          >
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 border-b border-[var(--line-0)] px-2.5 py-2 font-mono text-[10.5px] sm:grid-cols-4">
              <span><b className="font-medium text-[var(--fg-3)]">source</b><br />{ev.source}</span>
              <span><b className="font-medium text-[var(--fg-3)]">timestamp</b><br />{ev.timestamp}</span>
              <span><b className="font-medium text-[var(--fg-3)]">session</b><br />{ev.sessionId}</span>
              <span><b className="font-medium text-[var(--fg-3)]">PID</b><br />{ev.pid ?? "UNAVAILABLE"}</span>
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
 * Chronological event stream. Sequences always ascend (server-guaranteed);
 * entries animate in one at a time so motion is driven by real data.
 *
 * Each row can also be *selected*. Selection is event selection, not expansion:
 * it hands the canonical sequence to the shared store, which moves the cursor
 * to the event's own recorded timestamp and correlates the process it belongs
 * to. The selected row stays visible even while auto-follow is on, so a reader
 * can see what they selected.
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
  const [filter, setFilter] = useState<CanonicalEvent["type"] | "ALL">("ALL");
  const rows = useRef(new Map<number, HTMLLIElement>());

  const filteredEvents = useMemo(() => (filter === "ALL" ? events : events.filter((e) => e.type === filter)), [events, filter]);

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

  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between border-b border-[var(--line-0)] px-2 py-1">
        <span className="text-[10.5px] uppercase tracking-[0.12em] text-[var(--fg-3)]">
          {live ? "live sequence" : "sequence"} · {filteredEvents.length}{filter !== "ALL" ? ` / ${events.length} of ` : " "}{events.length} event{events.length === 1 ? "" : "s"}{filter !== "ALL" ? ` · filtered to ${filter}` : ""}
        </span>
        <button
          onClick={() => setStick(!stick)}
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
      {Object.keys(counts).length > 0 ? (
        <div className="flex flex-wrap gap-1 border-b border-[var(--line-0)] px-2 py-1.5">
          <button
            onClick={() => setFilter("ALL")}
            className={`rounded-[var(--r-xs)] px-1.5 py-0.5 font-mono text-[10.5px] transition-colors ${filter === "ALL" ? "bg-[var(--accent-soft)] text-[var(--accent)]" : "bg-[var(--bg-2)] text-[var(--fg-3)] hover:text-[var(--fg-1)]"}`}
            aria-pressed={filter === "ALL"}
          >
            ALL ×{events.length}
          </button>
          {[...counts.entries()].map(([type, n]) => (
            <button
              key={type}
              onClick={() => setFilter(filter === type ? "ALL" : (type as CanonicalEvent["type"]))}
              aria-pressed={filter === type}
              className={`rounded-[var(--r-xs)] px-1.5 py-0.5 font-mono text-[10.5px] transition-colors ${filter === type ? "bg-[var(--accent-soft)] text-[var(--accent)]" : "bg-[var(--bg-2)] text-[var(--fg-3)] hover:text-[var(--fg-1)]"} ${eventTone(type as CanonicalEvent["type"])}`}
            >
              {(EVENT_LABELS as Record<string, string>)[type] ?? type} ×{n}
            </button>
          ))}
        </div>
      ) : null}
      {events.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-10 text-[var(--fg-3)]">
          <RadioTower className="h-5 w-5" />
          <p className="text-[12.5px]">{emptyLabel}</p>
          {status && status === "RUNNING" ? <p className="text-[11px]">Waiting for the engine to start the process…</p> : null}
        </div>
      ) : (
        <ul className="max-h-[420px] overflow-y-auto" onScroll={() => setStick(true)}>
          {filteredEvents.map((ev, i) => (
            <EventRow
              key={`${ev.sequence}-${ev.type}`}
              ev={ev}
              index={i}
              selected={ev.sequence === selectedSequence}
              onSelect={(event) => onSelect?.(event)}
              registerRow={registerRow}
            />
          ))}
          <div ref={stickEl} />
        </ul>
      )}
      <div className="flex items-center gap-1.5 px-2 py-1.5 text-[10.5px] text-[var(--fg-3)]">
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--accent)]" />
        sequences re-checked at {fmtClock(new Date(tick).toISOString())} · every new event animates in
      </div>
    </div>
  );
}
