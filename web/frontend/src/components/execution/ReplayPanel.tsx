import { motion } from "motion/react";
import { ChevronLeft, ChevronRight, Pause, Play, RotateCcw, Square, Undo2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { fmtDuration } from "../../lib/format";
import type { CanonicalEvent, SessionStatus } from "../../types/observability";

/**
 * Replays a session's recorded events against wall-clock speed. The UI shows
 * exactly the events that actually happened — nothing interpolated —
 * scrubbed through a speed-controlled clock. The cursor is shared: the parent
 * can move it from a chart or a peak card through seekMs.
 *
 * REPLAY IS NOT LIVE. Every value here comes from events the gateway already
 * persisted. This component opens no stream, executes nothing, and reads no
 * PID; it walks a list that is already in memory. The `status` prop is the
 * session's own recorded status and is displayed as such — the replay position
 * is never allowed to masquerade as one (see `replayPositionLabel`).
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
  const [dragging, setDragging] = useState(false);
  const trackRef = useRef<HTMLDivElement>(null);
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

  /*
   * A span needs two timestamps to exist.
   *
   * With fewer than two events there is no measured interval at all, so the
   * scrubber cannot show a duration. `Math.max(1, totalMs / 1000)` was used to
   * give the animation loop something non-zero to run against; that is a
   * playback convenience, and it must not leak into the label as though the
   * record had one second of runtime.
   */
  const spanKnown = events.length >= 2;
  const spanMs = spanKnown ? Math.max(0, totalMs) : 0;

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

  const progressValue = stepCount === null ? (totalMs > 0 ? Math.min(cursorSec / (totalMs / 1000), 1) : totalEvents > 0 ? 1 : 0) : totalEvents > 1 ? Math.max(0, stepCount - 1) / (totalEvents - 1) : stepCount > 0 ? 1 : 0;
  const atEnd = stepCount === null ? totalMs > 0 && cursorSec >= totalMs / 1000 : stepCount >= totalEvents;

  /*
   * THE LABEL DESCRIBES THE REPLAY POSITION, NOT THE SESSION.
   *
   * This used to be:
   *   events.length > 0 && !atEnd ? "RUNNING" : status
   * which rendered a persisted, FINISHED session as "RUNNING" next to the
   * header's own "Completed" badge, because the replay had not reached the end
   * of the record. That is a replay POSITION being presented as a session
   * STATUS, and it is exactly the kind of claim this app must not make: the
   * record says the run finished, and the transport of that fact through the
   * scrubber does not change it. `status` is still shown, but only ever under
   * the words "recorded session status", which is what it is.
   */
  const replayPositionLabel = atEnd
    ? "replay at end of record"
    : totalEvents === 0
      ? "no recorded events to replay"
      : `replaying to #${visible.length} of ${totalEvents}`;

  const currentIndex = stepCount ?? visible.length;

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

  /** Move to a position on the real elapsed span. No clamping to a fake span. */
  const seekToMs = useCallback(
    (ms: number) => {
      if (totalEvents === 0) return;
      setPlaying(false);
      setStepCount(null);
      setCursorSec(Math.min(Math.max(ms, 0), spanMs) / 1000);
    },
    [setPlaying, spanMs, totalEvents],
  );

  /**
   * Seek to the PRESS position, then follow the pointer while it is down.
   *
   * The seek happens before the capture request, and the capture is guarded.
   * Both halves come from Timeline: a click-based seek fires at the END of a
   * drag, so a drag that ended outside the element still landed on the release
   * position, and an unguarded `setPointerCapture` throws in any environment
   * that does not implement the Pointer Capture API — which killed the whole
   * interaction, because the exception propagated out of the handler. Without
   * capture this degrades to "tracks while over the element", which is worse
   * but still correct.
   */
  const seekFromPointer = useCallback(
    (clientX: number) => {
      const node = trackRef.current;
      if (node === null || spanMs <= 0) return;
      const rect = node.getBoundingClientRect();
      if (rect.width <= 0) return;
      const ratio = (clientX - rect.left) / rect.width;
      seekToMs(Math.round(Math.min(Math.max(ratio, 0), 1) * spanMs));
    },
    [seekToMs, spanMs],
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      // Primary button / single touch only: a right-click opens the context menu
      // and a two-finger gesture is a pinch, neither of which is a scrub.
      if (e.pointerType === "mouse" && e.button !== 0) return;
      seekFromPointer(e.clientX);
      setDragging(true);
      if (typeof e.currentTarget.setPointerCapture === "function") {
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
          // A refused capture is not a failure of the interaction.
        }
      }
    },
    [seekFromPointer],
  );
  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!dragging) return;
      seekFromPointer(e.clientX);
    },
    [dragging, seekFromPointer],
  );
  const endDrag = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    // Guarded for the same reason as the capture in onPointerDown: this API is
    // optional and its absence must not throw out of a pointer-up handler.
    try {
      if (e.currentTarget.hasPointerCapture?.(e.pointerId) === true) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
    } catch {
      // Nothing to release.
    }
    setDragging(false);
  }, []);

  /*
   * Keyboard scrubbing.
   *
   * Two different units, deliberately. An arrow key moves ONE EVENT, because
   * the events are the thing a forensic reader steps through; PageUp/PageDown
   * move a tenth of the real span, because a coarse key should not land on an
   * event boundary and should work even when the events are sparse. Home/End go
   * to the ends of the record.
   *
   * Up/Right increase the value and Down/Left decrease it, per the slider
   * convention. All of them preventDefault, because the arrow keys would
   * otherwise scroll the page instead of moving the replay.
   */
  const cursorMsValue = Math.min(Math.max(0, Math.round(cursorSec * 1000)), spanMs);
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (totalEvents === 0) return;
      if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
        e.preventDefault();
        stepTo(currentIndex - 1);
        return;
      }
      if (e.key === "ArrowRight" || e.key === "ArrowUp") {
        e.preventDefault();
        stepTo(currentIndex + 1);
        return;
      }
      if (e.key === "Home") {
        e.preventDefault();
        stepTo(0);
        return;
      }
      if (e.key === "End") {
        e.preventDefault();
        stepTo(totalEvents);
        return;
      }
      // Coarse motion needs a span to be coarse over. Without one there is no
      // tenth of anything to move by, so the key is deliberately inert rather
      // than silently mapped onto a made-up duration.
      if (spanMs <= 0) return;
      if (e.key === "PageDown") {
        e.preventDefault();
        seekToMs(cursorMsValue - spanMs / 10);
      } else if (e.key === "PageUp") {
        e.preventDefault();
        seekToMs(cursorMsValue + spanMs / 10);
      }
    },
    // `stepTo` reads the current render's events through `currentIndex` and
    // `totalEvents`, both of which are listed, so a handler built from this
    // memo never steps against a stale record.
    [currentIndex, cursorMsValue, seekToMs, spanMs, totalEvents],
  );

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
            onClick={() => stepTo(currentIndex - 1)}
            disabled={currentIndex === 0}
            className="flex h-8 w-8 items-center justify-center rounded-[var(--r-sm)] border border-[var(--line-1)] bg-[var(--bg-2)] text-[var(--fg-1)] transition-colors hover:text-[var(--fg-0)] disabled:opacity-40"
            aria-label="Previous event"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => stepTo(currentIndex + 1)}
            disabled={currentIndex >= totalEvents}
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
          <span>{replayPositionLabel}</span>
        </span>
      </div>

      {/*
        A real slider. Both page copy strings ("Scrubbing through the real
        recorded event timeline", "Scrubbable reconstruction") promise a
        scrubber, and this control was two divs with no pointer handler, no role
        and no keyboard — so nothing it claimed was operable.

        The value is the elapsed span in milliseconds when a span exists, and the
        event INDEX when it does not, with `aria-valuetext` stating which unit
        is in play and why. Mixing the two silently would let a reader hear a
        number that looked like a timestamp and was not one.
      */}
      <div
        ref={trackRef}
        className={`relative h-3 ${spanMs > 0 ? (dragging ? "cursor-grabbing" : "cursor-crosshair") : "cursor-default"}`}
        style={{ touchAction: "none" }}
        role="slider"
        tabIndex={0}
        aria-label="Replay position through the recorded event timeline"
        aria-orientation="horizontal"
        aria-valuemin={0}
        aria-valuemax={spanKnown ? spanMs : totalEvents}
        aria-valuenow={spanKnown ? cursorMsValue : currentIndex}
        aria-valuetext={
          totalEvents === 0
            ? "no recorded events"
            : spanKnown
              ? `event ${currentIndex} of ${totalEvents} · t = ${fmtDuration(cursorMsValue)} of ${fmtDuration(spanMs)} recorded span`
              : `event ${currentIndex} of ${totalEvents} · recorded span UNAVAILABLE, only ${totalEvents === 1 ? "one timestamp" : "no events"} in this record`
        }
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={onKeyDown}
      >
        <div className="absolute inset-x-0 top-1 h-1.5 overflow-hidden rounded-full bg-[var(--line-0)]">
          <motion.div className="absolute inset-y-0 left-0 bg-[var(--accent)]" animate={{ width: `${progressValue * 100}%` }} transition={{ duration: 0.1 }} />
        </div>
        {dragging ? (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute top-0 -translate-x-1/2 whitespace-nowrap rounded-[var(--r-xs)] border border-[var(--line-1)] bg-[var(--bg-3)] px-1 py-px font-mono text-[9.5px] tabular-nums text-[var(--fg-0)]"
            style={{ left: `${Math.round(progressValue * 100)}%` }}
          >
            t={fmtDuration(cursorMsValue)}
          </span>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[9.5px] text-[var(--fg-4)]">
        <span>{totalEvents} recorded event{totalEvents === 1 ? "" : "s"}</span>
        <span>
          recorded span {spanKnown ? fmtDuration(spanMs) : "UNAVAILABLE — fewer than two timestamps"}
        </span>
        {dragging ? <span className="text-[var(--accent)]">cursor t = {fmtDuration(cursorMsValue)}</span> : null}
        <span className="ml-auto">recorded session status: {status}</span>
        <span>arrows = one event · PageUp/Down = 10% of span · Home/End = ends</span>
      </div>
    </div>
  );
}
