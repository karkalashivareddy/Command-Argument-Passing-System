import { motion } from "motion/react";
import { ChevronLeft, ChevronRight, Pause, Play, RotateCcw, Square, Undo2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { CanonicalEvent, SessionStatus } from "../../types/observability";

/**
 * Replays a session's recorded events against wall-clock speed. The UI shows
 * exactly the events that actually happened — nothing interpolated —
 * scrubbed through a speed-controlled clock. The cursor is shared: the parent
 * can move it from a chart or a peak card through seekMs.
 */
export interface ReplayPanelProps {
  events: CanonicalEvent[];
  status: SessionStatus;
  onVisible?: (evs: CanonicalEvent[]) => void;
  onCursorMs?: (ms: number) => void;
  seekMs?: number | null;
  /**
   * When supplied, playback is controlled by the parent. The 3D view passes the
   * keyboard state here, so Space toggles the same playback the button toggles
   * instead of showing a toast that says playback lives somewhere else.
   */
  playing?: boolean;
  onPlayingChange?: (playing: boolean) => void;
}

export function ReplayPanel({ events, status, onVisible, onCursorMs, seekMs, playing: playingProp, onPlayingChange }: ReplayPanelProps) {
  const [rate, setRate] = useState(2);
  const [selfPlaying, setSelfPlaying] = useState(true);
  const [cursorSec, setCursorSec] = useState(0);
  const [stepCount, setStepCount] = useState<number | null>(null);
  const raf = useRef<number>(0);
  const last = useRef<number>(0);
  const lastSeek = useRef<number | null>(null);

  const playing = playingProp ?? selfPlaying;
  const setPlaying = useCallback(
    (next: boolean) => {
      setSelfPlaying(next);
      onPlayingChange?.(next);
    },
    [onPlayingChange],
  );

  const totalEvents = events.length;
  const totalMs = useMemo(() => {
    if (events.length < 2) return 0;
    return new Date(events[events.length - 1]!.timestamp).getTime() - new Date(events[0]!.timestamp).getTime();
  }, [events]);

  useEffect(() => {
    setCursorSec(0);
    setStepCount(null);
  }, [totalEvents]);

  // A chart or peak card moved the shared cursor: follow it here and pause.
  useEffect(() => {
    if (seekMs === null || seekMs === undefined) return;
    if (lastSeek.current === seekMs) return;
    lastSeek.current = seekMs;
    setPlaying(false);
    setStepCount(null);
    setCursorSec(Math.max(0, seekMs / 1000));
  }, [seekMs]);

  useEffect(() => {
    onCursorMs?.(Math.round(cursorSec * 1000));
  }, [cursorSec, onCursorMs]);

  useEffect(() => {
    if (!playing) return;
    last.current = performance.now();
    const loop = (t: number) => {
      const dt = (t - last.current) / 1000;
      last.current = t;
      setCursorSec((c) => Math.min(c + dt * rate, Math.max(1, totalMs / 1000)));
      raf.current = requestAnimationFrame(loop);
    };
    raf.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf.current);
  }, [playing, rate, totalMs]);

  // Which events fall inside the current cursor (wall-clock, rate-scaled)?
  const visible = useMemo(() => {
    if (totalEvents === 0) return [] as CanonicalEvent[];
    if (stepCount !== null) return events.slice(0, stepCount);
    if (events.length === 1) return cursorSec > 0 ? events : [];
    const start = new Date(events[0]!.timestamp).getTime();
    const cutoff = start + cursorSec * 1000;
    return events.filter((e) => new Date(e.timestamp).getTime() <= cutoff);
  }, [events, cursorSec, totalEvents, stepCount]);

  useEffect(() => {
    onVisible?.(visible);
  }, [visible, onVisible]);

  const progress = totalMs > 0 ? Math.min(cursorSec / (totalMs / 1000), 1) : events.length > 0 ? 1 : 0;
  const progressValue = stepCount === null ? progress : totalEvents > 1 ? Math.max(0, stepCount - 1) / (totalEvents - 1) : stepCount > 0 ? 1 : 0;
  const atEnd = stepCount === null ? progress >= 1 && events.length > 1 : stepCount >= totalEvents;
  const displayStatus: SessionStatus = events.length > 0 && !atEnd ? "RUNNING" : status;

  const stepTo = (count: number) => {
    const next = Math.max(0, Math.min(totalEvents, count));
    setPlaying(false);
    setStepCount(next);
    // The shared cursor follows the step, so "jump to end" leaves the reader at
    // the end of the record instead of showing every event at t=0.
    if (next === 0 || events.length === 0) {
      setCursorSec(0);
    } else {
      const start = new Date(events[0]!.timestamp).getTime();
      const current = new Date(events[next - 1]!.timestamp).getTime();
      setCursorSec(Math.max(0, (current - start + 1) / 1000));
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1">
          <button
            onClick={() => {
              setStepCount(null);
              setPlaying(!playing);
            }}
            className="flex h-8 w-8 items-center justify-center rounded-[var(--r-sm)] border border-[var(--line-1)] bg-[var(--bg-2)] text-[var(--fg-1)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)]"
            aria-label={playing ? "Pause replay" : "Play replay"}
          >
            {playing ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
          </button>
          <button
            onClick={() => {
              lastSeek.current = null;
              setCursorSec(0);
              setStepCount(null);
              setPlaying(true);
            }}
            className="flex h-8 w-8 items-center justify-center rounded-[var(--r-sm)] border border-[var(--line-1)] bg-[var(--bg-2)] text-[var(--fg-1)] transition-colors hover:text-[var(--fg-0)]"
            aria-label="Restart replay"
          >
            <RotateCcw className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => stepTo((stepCount ?? visible.length) - 1)}
            disabled={visible.length === 0}
            className="flex h-8 w-8 items-center justify-center rounded-[var(--r-sm)] border border-[var(--line-1)] bg-[var(--bg-2)] text-[var(--fg-1)] transition-colors hover:text-[var(--fg-0)] disabled:opacity-40"
            aria-label="Previous event"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => stepTo((stepCount ?? visible.length) + 1)}
            disabled={visible.length >= totalEvents}
            className="flex h-8 w-8 items-center justify-center rounded-[var(--r-sm)] border border-[var(--line-1)] bg-[var(--bg-2)] text-[var(--fg-1)] transition-colors hover:text-[var(--fg-0)] disabled:opacity-40"
            aria-label="Next event"
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => stepTo(totalEvents)}
            className="flex h-8 items-center gap-1.5 rounded-[var(--r-sm)] border border-[var(--line-1)] bg-[var(--bg-2)] px-2.5 text-[11.5px] text-[var(--fg-1)] transition-colors hover:border-[var(--accent)]"
          >
            <Square className="h-3 w-3" /> jump to end
          </button>
        </div>

        <div className="flex items-center gap-1.5 rounded-[var(--r-sm)] border border-[var(--line-1)] bg-[var(--bg-2)] px-2 py-1">
          {[0.5, 1, 2, 4, 8].map((r) => (
            <button
              key={r}
              onClick={() => setRate(r)}
              className={`rounded-[var(--r-xs)] px-1.5 py-0.5 font-mono text-[10.5px] transition-colors ${rate === r ? "bg-[var(--accent-soft)] text-[var(--accent)]" : "text-[var(--fg-3)] hover:text-[var(--fg-1)]"}`}
            >
              {r}×
            </button>
          ))}
        </div>

        <span className="ml-auto flex items-center gap-1.5 font-mono text-[11px] text-[var(--fg-3)]">
          <Undo2 className="h-3 w-3" />
          {visible.length} / {totalEvents} events · {atEnd ? "ended" : displayStatus}
        </span>
      </div>

      <div className="relative h-1.5 overflow-hidden rounded-full bg-[var(--line-0)]">
          <motion.div className="absolute inset-y-0 left-0 bg-[var(--accent)]" animate={{ width: `${progressValue * 100}%` }} transition={{ duration: 0.1 }} />
      </div>
    </div>
  );
}
