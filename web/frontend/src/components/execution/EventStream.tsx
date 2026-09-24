import { AnimatePresence, motion } from "motion/react";
import { Check, ChevronDown, Copy, RadioTower } from "lucide-react";
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
}

function EventRow({ ev, index }: EventRowProps) {
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
      className="cursor-pointer border-b border-[var(--line-0)] px-2 py-1.5 hover:bg-[var(--bg-2)]"
      onClick={() => setOpen(!open)}
      data-testid={`event-row-${index}`}
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
 */
export function EventStream({
  events,
  status,
  live = false,
  emptyLabel = "No events for this session yet.",
}: {
  events: CanonicalEvent[];
  status?: SessionStatus;
  live?: boolean;
  emptyLabel?: string;
}) {
  const stickEl = useRef<HTMLDivElement>(null);
  const [stick, setStick] = useState(true);
  const [tick, setTick] = useState(Date.now());
  const [filter, setFilter] = useState<CanonicalEvent["type"] | "ALL">("ALL");

  const filteredEvents = useMemo(() => (filter === "ALL" ? events : events.filter((e) => e.type === filter)), [events, filter]);

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
  }, [events.length, stick]);

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
            <EventRow key={`${ev.sequence}-${ev.type}`} ev={ev} index={i} />
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
