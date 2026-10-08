import { useCallback, useMemo, useRef, useState } from "react";
import {
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceDot,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Activity, Crosshair, Info, RadioTower } from "lucide-react";

import type { CanonicalEvent } from "../../types/observability";
import { buildAnnotations, buildResourceTracks, collectSamples } from "../../lib/telemetry";
import { fmtClock, formatCount, formatKibPerSec, formatMiB, formatPercent } from "../../lib/format";

const AXIS_TICK = { fill: "var(--fg-4)", fontSize: 9 } as const;
const TOOLTIP_STYLE = {
  background: "var(--bg-3)",
  border: "1px solid var(--line-1)",
  borderRadius: 8,
  fontSize: 11,
  color: "var(--fg-0)",
} as const;
const TRACK_HEIGHT = 76;
const PLOT_MARGIN = { top: 6, right: 8, bottom: 0, left: 0 } as const;

/**
 * Axis-tick and marker formatter for the shared execution-time axis.
 *
 * The `s < 0` arm was `return "0"`. A negative or non-finite time is not zero
 * time: it is a time this axis cannot describe, and rendering it as "0" places a
 * marker at the instant the execution began, which reads as an observation. An
 * axis tick has no room for prose, so the glyph is an em dash -- the same mark
 * `fmtDuration` and `fmtNumber` already use for "not recorded" everywhere else in
 * this app -- rather than a number that was never measured.
 */
function fmtSeconds(s: number): string {
  if (!Number.isFinite(s) || s < 0) return "—";
  if (s < 10) return `${s.toFixed(2)}s`;
  return `${s.toFixed(1)}s`;
}

function axisTick(unit: string): (v: number) => string {
  if (unit === "MiB") return (v: number) => v.toFixed(v >= 10 ? 0 : 1);
  if (unit === "% of one core") return (v: number) => `${v.toFixed(0)}`;
  if (unit === "faults/s") return (v: number) => formatCount(v);
  return (v: number) => (v >= 1024 ? `${(v / 1024).toFixed(0)}M` : v >= 10 ? `${v.toFixed(0)}` : v.toFixed(1));
}

function formatTrackValue(value: number, unit: string | undefined): string {
  if (unit === "MiB") return formatMiB(value * 1024 * 1024);
  if (unit === "% of one core") return formatPercent(value);
  if (unit === "KiB/s") return formatKibPerSec(value * 1024);
  return `${formatCount(value)}/s`;
}

export interface TimelineProps {
  events: CanonicalEvent[];
  /** Shared execution-time cursor in ms; drives every track, the inspector, and peaks. */
  cursorMs: number | null;
  onSeek: (atMs: number) => void;
  /**
   * The selected canonical event, at its own recorded time. It is drawn as a
   * separate, solid marker so an event selection is visible on the timeline
   * rather than only in the 3D view.
   */
  selectedEvent?: { sequence: number; atSec: number } | null;
  onClearEvent?: () => void;
}

/**
 * One stack of resource tracks over one shared time axis. Every track reads the
 * same persisted samples, every track shows the same cursor, and gaps are drawn
 * as gaps: a metric the kernel did not expose is never interpolated away.
 */
export function Timeline({ events, cursorMs, onSeek, selectedEvent = null, onClearEvent }: TimelineProps) {
  const samples = useMemo(() => collectSamples(events), [events]);
  const annotations = useMemo(() => buildAnnotations(events), [events]);
  const model = useMemo(() => buildResourceTracks(samples), [samples]);
  const wrapRef = useRef<HTMLDivElement>(null);

  const cursorSec = cursorMs === null ? null : Math.min(Math.max(0, cursorMs) / 1000, model.spanSeconds);

  /** Click or press anywhere on a track to move the shared cursor. */
  const seekFromPointer = useCallback(
    (clientX: number) => {
      const node = wrapRef.current;
      if (node === null || model.spanSeconds <= 0) return;
      const rect = node.getBoundingClientRect();
      const width = rect.width;
      if (width <= 0) return;
      const ratio = (clientX - rect.left) / width;
      onSeek(Math.round(Math.min(Math.max(ratio, 0), 1) * model.spanSeconds * 1000));
    },
    [model.spanSeconds, onSeek],
  );

  /**
   * Drag-to-scrub, with pointer capture on the wrapper so a drag that leaves the
   * element keeps feeding moves to it.
   *
   * The wrapper element carries these handlers rather than each chart: the charts
   * are siblings stacked on one axis, and a pointer that wanders between them
   * must not stop tracking. `dragging` is state rather than a ref because the
   * cursor has to change while the pointer is down.
   */
  const [dragging, setDragging] = useState(false);
  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      // Primary button / single touch only: a right-click opens the context menu
      // and a two-finger gesture is a pinch, neither of which is a scrub.
      if (e.pointerType === "mouse" && e.button !== 0) return;
      setDragging(true);
      /*
       * Pointer capture is an optimisation, not a requirement: it keeps receiving
       * moves after the pointer leaves the element, which is what makes a drag
       * feel continuous.
       *
       * It is therefore guarded, and the seek happens FIRST. This call was
       * unguarded and ran before `seekFromPointer`, so in any environment that
       * does not implement the Pointer Capture API the exception propagated and
       * the cursor never moved at all -- the control silently did nothing. The
       * `endDrag` counterpart below already guards its `hasPointerCapture` check,
       * so the two halves disagreed about whether the API is optional.
       *
       * Without capture the drag degrades to "tracks while over the element",
       * which is worse but still correct. With an unguarded throw it is dead.
       */
      seekFromPointer(e.clientX);
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

  /**
   * Keyboard scrubbing.
   *
   * The control was a `role="group"` with a click handler and no tabIndex, so the
   * cursor it promised to move on "click or drag" could not be reached at all
   * without a pointer. It is now a real slider: one tab stop, arrow keys step,
   * Page keys step by a tenth of the span, Home/End jump to the ends, and the
   * value is announced in seconds because the raw millisecond count means nothing
   * to a reader hearing it.
   */
  const KEY_STEP_MS = 100;
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const spanMs = model.spanSeconds * 1000;
      if (spanMs <= 0) return;
      const current = cursorSec === null ? 0 : cursorSec * 1000;
      const clamp = (v: number) => Math.min(Math.max(v, 0), spanMs);
      let next: number | null = null;
      if (e.key === "ArrowLeft" || e.key === "ArrowDown") next = clamp(current - KEY_STEP_MS);
      else if (e.key === "ArrowRight" || e.key === "ArrowUp") next = clamp(current + KEY_STEP_MS);
      else if (e.key === "PageDown") next = clamp(current - spanMs / 10);
      else if (e.key === "PageUp") next = clamp(current + spanMs / 10);
      else if (e.key === "Home") next = 0;
      else if (e.key === "End") next = spanMs;
      if (next === null) return;
      // Arrows and Page keys scroll the page; here they move the cursor.
      e.preventDefault();
      onSeek(Math.round(next));
    },
    [cursorSec, model.spanSeconds, onSeek],
  );

  if (events.length === 0) {
    return (
      <div className="py-8 text-center">
        <Activity className="mx-auto h-5 w-5 text-[var(--fg-3)]" />
        <p className="mt-2 text-[12px] font-medium text-[var(--fg-1)]">No recorded events to chart yet</p>
        <p className="mt-1 text-[11px] text-[var(--fg-3)]">The timeline renders once real CAPS events arrive.</p>
      </div>
    );
  }

  if (samples.length === 0) {
    return (
      <div className="space-y-3">
        <div className="py-6 text-center">
          <RadioTower className="mx-auto h-5 w-5 text-[var(--fg-3)]" />
          <p className="mt-2 text-[12px] font-medium text-[var(--fg-1)]">No procfs snapshots — resource curves need collected samples</p>
          <p className="mt-1 text-[11px] text-[var(--fg-3)]">
            {annotations.length} lifecycle event{annotations.length === 1 ? "" : "s"} were recorded, but the process exited too quickly for a 500&nbsp;ms sample.
          </p>
        </div>
        <StateStrip events={events} spanSeconds={model.spanSeconds} />
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[9.5px] font-mono text-[var(--fg-3)]">
        <span className="inline-flex items-center gap-1.5"><Crosshair className="h-3 w-3" /> one cursor across every track</span>
        <span>{model.rawSampleCount} persisted sample{model.rawSampleCount === 1 ? "" : "s"}</span>
        {model.thinned ? (
          <span className="text-[var(--fg-4)]" title="Display-only thinning. The persisted stream is unchanged and every peak sample is kept.">
            showing {model.displayedSampleCount} for drawing · peaks retained
          </span>
        ) : null}
        {model.ratesUnavailable ? <span className="text-[var(--amber)]">only one sample: every rate is UNAVAILABLE by design</span> : null}
        <span className="ml-auto text-[var(--fg-4)]">only collected samples are plotted</span>
      </div>

      {/*
        `touch-action: none` is required, not cosmetic: without it the browser
        owns the vertical pan gesture on touch, so a horizontal drag to scrub
        scrolls the page instead and the cursor never moves.
      */}
      <div
        ref={wrapRef}
        className={`w-full ${dragging ? "cursor-grabbing" : "cursor-crosshair"}`}
        style={{ touchAction: "none" }}
        role="slider"
        tabIndex={0}
        aria-label="Resource tracks; shared execution-time cursor"
        aria-orientation="horizontal"
        aria-valuemin={0}
        aria-valuemax={Math.round(model.spanSeconds * 1000)}
        aria-valuenow={cursorSec === null ? undefined : Math.round(cursorSec * 1000)}
        aria-valuetext={cursorSec === null ? "no cursor position set" : `t = ${fmtSeconds(cursorSec)}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={onKeyDown}
      >
        {model.tracks.map((track, index) => {
          const tick = axisTick(track.spec.unit);
          return (
            <div key={track.spec.id} className="w-full" style={{ height: TRACK_HEIGHT }}>
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={model.rows} margin={PLOT_MARGIN} syncId="execution-time">
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--line-0)" vertical={false} />
                  <XAxis
                    dataKey="t"
                    type="number"
                    domain={[0, model.spanSeconds]}
                    tick={AXIS_TICK}
                    stroke="var(--line-1)"
                    tickLine={false}
                    axisLine={false}
                    height={index === model.tracks.length - 1 ? 16 : 0}
                    tickFormatter={(v: number) => fmtSeconds(v)}
                  />
                  <YAxis
                    domain={track.domain}
                    tick={AXIS_TICK}
                    tickFormatter={tick}
                    stroke="var(--line-1)"
                    tickLine={false}
                    axisLine={false}
                    width={44}
                    label={{ value: track.spec.unit, position: "insideTopLeft", fill: "var(--fg-4)", fontSize: 8.5 }}
                  />
                  <Tooltip
                    contentStyle={TOOLTIP_STYLE}
                    cursor={{ stroke: "var(--fg-3)", strokeWidth: 1 }}
                    labelFormatter={(label: number) => `t = ${fmtSeconds(label)}`}
                    formatter={(value, name) => {
                      const spec = track.series.find((s) => s.key === name);
                      if (value === null || value === undefined) return ["UNAVAILABLE", spec?.label ?? String(name)];
                      return [formatTrackValue(value as number, track.spec.unit), `${spec?.label ?? String(name)} · ${spec?.provenance ?? ""}`];
                    }}
                  />
                  {track.series.map((series) => (
                    <Line
                      key={series.key}
                      yAxisId={0}
                      type="monotone"
                      dataKey={series.key}
                      stroke={series.color}
                      strokeWidth={1.5}
                      dot={false}
                      activeDot={{ r: 2.5, strokeWidth: 0 }}
                      connectNulls={false}
                      isAnimationActive={false}
                      name={series.key}
                    />
                  ))}
                  {index === 0
                    ? annotations.map((a) => (
                        <ReferenceLine
                          key={`${a.type}-${a.t}`}
                          yAxisId={0}
                          x={a.t}
                          stroke={a.tone === "start" ? "var(--accent)" : a.tone === "end" ? "var(--green)" : "var(--red)"}
                          strokeDasharray={a.tone === "signal" ? "2 3" : "4 2"}
                          strokeOpacity={0.4}
                          ifOverflow="extendDomain"
                        />
                      ))
                    : null}
                  {track.peak && track.peak.atSec <= model.spanSeconds ? (
                    <ReferenceDot
                      yAxisId={0}
                      x={track.peak.atSec}
                      y={track.peak.value}
                      r={3}
                      fill={track.peak.color}
                      stroke="none"
                      isFront
                    />
                  ) : null}
                  {selectedEvent !== null && selectedEvent.atSec <= model.spanSeconds ? (
                    <ReferenceLine
                      yAxisId={0}
                      x={selectedEvent.atSec}
                      stroke="var(--violet)"
                      strokeWidth={1.5}
                      strokeOpacity={0.95}
                      label={{ value: `#${selectedEvent.sequence}`, fill: "var(--violet)", fontSize: 8.5, position: "insideTopRight" }}
                      ifOverflow="extendDomain"
                    />
                  ) : null}
                  {cursorSec !== null ? (
                    <ReferenceLine yAxisId={0} x={cursorSec} stroke="var(--fg-0)" strokeDasharray="1 2" strokeWidth={1} strokeOpacity={0.85} ifOverflow="extendDomain" />
                  ) : null}
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[9.5px] font-mono text-[var(--fg-3)]">
        {model.tracks.map((track) => (
          <span key={track.spec.id} className="inline-flex items-center gap-1.5" title={track.spec.caption}>
            {track.series.map((series) => (
              <span key={series.key} className="inline-flex items-center gap-1">
                <span className="h-0.5 w-3" style={{ background: series.color }} />
                <span className="text-[var(--fg-2)]">{series.label}</span>
              </span>
            ))}
            <span className="text-[var(--fg-4)]">{track.spec.unit}</span>
            {track.peak ? (
              <button
                className="text-[var(--fg-3)] underline decoration-dotted underline-offset-2 hover:text-[var(--accent)]"
                onClick={(e) => {
                  e.stopPropagation();
                  onSeek(track.peak!.atMs);
                }}
              >
                peak {formatTrackValue(track.peak.value, track.spec.unit)} @ {fmtSeconds(track.peak.atSec)}
              </button>
            ) : (
              <span className="text-[var(--fg-4)]">no valid samples</span>
            )}
          </span>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[9px] text-[var(--fg-4)]">
        <span className="inline-flex items-center gap-1.5">
          <Info className="h-3 w-3" />
          Peak buttons move the shared cursor. Gaps are real: a DERIVED rate needs two valid samples, so the first sample of a session has no rate.
        </span>
        {selectedEvent !== null ? (
          <span className="inline-flex items-center gap-1.5 text-[var(--violet)]">
            <span className="h-2 w-0.5 bg-[var(--violet)]" />
            selected event #{selectedEvent.sequence} at t = {fmtSeconds(selectedEvent.atSec)} (its recorded timestamp)
            {onClearEvent ? (
              <button type="button" onClick={onClearEvent} className="underline decoration-dotted underline-offset-2 hover:text-[var(--fg-0)]">
                clear
              </button>
            ) : null}
          </span>
        ) : null}
        {cursorSec !== null ? <span className="font-mono text-[var(--fg-2)]">cursor t = {fmtSeconds(cursorSec)}</span> : <span className="font-mono">cursor follows the newest sample</span>}
      </div>

      <StateStrip events={events} spanSeconds={model.spanSeconds} />
    </div>
  );
}

/**
 * State timeline derived strictly from lifecycle event timestamps: pre-exec,
 * running, and ended segments with real markers for start/signal/exit.
 */
function StateStrip({ events, spanSeconds }: { events: CanonicalEvent[]; spanSeconds: number }) {
  const base = events.length > 0 ? new Date(events[0]!.timestamp).getTime() : 0;
  const at = (ev: CanonicalEvent): number => Math.max(0, (new Date(ev.timestamp).getTime() - base) / 1000);
  const started = events.find((e) => e.type === "process.started");
  const ended = events.find((e) => e.type === "process.exited" || e.type === "process.exec_error");
  const signal = events.find((e) => e.type === "signal.received");

  const startT = started ? at(started) : null;
  const endT = ended ? at(ended) : null;
  if (startT === null && endT === null) {
    return <p className="text-[9.5px] text-[var(--fg-4)]">No process lifecycle timestamps recorded for a state timeline.</p>;
  }
  const runningFrom = startT ?? 0;
  const runningTo = endT ?? spanSeconds;
  const preW = Math.max((runningFrom / spanSeconds) * 100, 0);
  const runW = Math.max(((runningTo - runningFrom) / spanSeconds) * 100, 0);
  const postW = Math.max(100 - preW - runW, 0);

  return (
    <div className="rounded-[var(--r-md)] border border-[var(--line-0)] bg-[var(--bg-2)] px-3 py-2">
      <div className="flex items-center text-[9.5px] font-mono text-[var(--fg-3)]">
        <span className="w-10 shrink-0">0s</span>
        <div className="relative flex h-3 flex-1 items-center">
          {preW > 0 ? <div className="h-2 rounded-l bg-[var(--line-1)]" style={{ width: `${preW}%` }} title="pre-exec" /> : null}
          <div className="h-2 bg-[var(--green)]" style={{ width: `${runW}%` }} title="running" />
          {postW > 0 ? <div className="h-2 rounded-r bg-[var(--line-1)]" style={{ width: `${postW}%` }} title="ended" /> : null}
          {startT !== null && startT < spanSeconds ? <span className="absolute top-0.5 h-2 w-px bg-[var(--accent)]" style={{ left: `${(startT / spanSeconds) * 100}%` }} /> : null}
          {signal && signal !== ended ? <span className="absolute top-0.5 h-2 w-px bg-[var(--red)]" style={{ left: `${(at(signal) / spanSeconds) * 100}%` }} /> : null}
          {ended && endT !== null && endT < spanSeconds ? <span className="absolute top-0.5 h-2 w-px bg-[var(--fg-0)]" style={{ left: `${(endT / spanSeconds) * 100}%` }} /> : null}
        </div>
        <span className="w-16 shrink-0 text-right">{fmtSeconds(spanSeconds)}</span>
      </div>
      <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-0.5 text-[8.5px] text-[var(--fg-4)]">
        <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-sm bg-[var(--line-1)]" /> pre-exec</span>
        <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-sm bg-[var(--green)]" /> running {startT !== null ? `from t=${fmtSeconds(startT)}` : ""}</span>
        {ended ? <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-sm bg-[var(--fg-0)]" /> end at t={fmtSeconds(endT!)}</span> : null}
        {signal ? <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-sm bg-[var(--red)]" /> signal {String(signal.payload.signal)} at t={fmtSeconds(at(signal))}</span> : null}
      </div>
      <p className="mt-1 text-[8.5px] leading-relaxed text-[var(--fg-4)]">
        Segments use lifecycle event timestamps only. {ended ? `Exited ${ended.type === "process.exec_error" ? "with EXEC_ERROR" : `with status ${String(ended.payload.exitCode ?? "UNAVAILABLE")}`} at ${fmtClock(ended.timestamp)}.` : "Process end not observed."}
      </p>
    </div>
  );
}
