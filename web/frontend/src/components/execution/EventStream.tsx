import { AnimatePresence, motion } from "motion/react";
import { ChevronDown, RadioTower } from "lucide-react";
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
        {payload ? <ChevronDown className={`h-3.5 w-3.5 shrink-0 text-[var(--fg-3)] transition-transform ${ll ? "rotate-180" : ""}`} /> : null}
      </div>
      <AnimatePresence>
        {ll && payload ? (
          <motion.pre
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className="mt-1.5 overflow-x-auto rounded-[var(--r-sm)] bg-[var(--bg-3)] p-2 font-mono text-[11px] leading-relaxed text-[var(--fg-1)]"
          >
            {JSON.stringify(payload, null, 2)}
          </motion.pre>
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
          {live ? "live sequence" : "sequence"} · {events.length} events
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
          {[...counts.entries()].map(([type, n]) => (
            <span key={type} className={`rounded-[var(--r-xs)] bg-[var(--bg-2)] px-1.5 py-0.5 font-mono text-[10.5px] ${eventTone(type as CanonicalEvent["type"])}`}>
              {(EVENT_LABELS as Record<string, string>)[type] ?? type} ×{n}
            </span>
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
          {events.map((ev, i) => (
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
