import { useCallback, useMemo, useRef } from "react";
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

function fmtSeconds(s: number): string {
  if (!Number.isFinite(s) || s < 0) return "0";
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

  /** Click anywhere on a track to move the shared cursor. */
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

      <div
        ref={wrapRef}
        className="w-full cursor-crosshair"
        role="group"
        aria-label="Resource tracks; click or drag to move the shared execution-time cursor"
        onClick={(e) => seekFromPointer(e.clientX)}
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
