import { useMemo } from "react";
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
import { Activity, RadioTower } from "lucide-react";

import type { CanonicalEvent } from "../../types/observability";
import { buildTimeline, deriveRuntimePeaks } from "../../lib/telemetry";
import { fmtClock } from "../../lib/format";

const AXIS_TICK = { fill: "var(--fg-4)", fontSize: 10 } as const;
const TOOLTIP_STYLE = {
  background: "var(--bg-3)",
  border: "1px solid var(--line-1)",
  borderRadius: 8,
  fontSize: 11,
  color: "var(--fg-0)",
} as const;

function fmtSeconds(s: number): string {
  if (!Number.isFinite(s) || s < 0) return "0";
  if (s < 10) return s.toFixed(2);
  return `${s.toFixed(1)}s`;
}

export function Timeline({ events, highlightMs }: { events: CanonicalEvent[]; highlightMs?: number | null }) {
  const { points, annotations, spanSeconds } = useMemo(() => buildTimeline(events), [events]);
  const peaks = useMemo(() => deriveRuntimePeaks(events), [events]);

  const highlightSec = highlightMs === undefined || highlightMs === null ? null : Math.min(highlightMs / 1000, spanSeconds);
  const peakRss = peaks.peakRssBytes;
  const peakCpu = peaks.peakCpuPercent;

  if (events.length === 0) {
    return (
      <div className="py-8 text-center">
        <Activity className="mx-auto h-5 w-5 text-[var(--fg-3)]" />
        <p className="mt-2 text-[12px] font-medium text-[var(--fg-1)]">No recorded events to chart yet</p>
        <p className="mt-1 text-[11px] text-[var(--fg-3)]">The timeline renders once real CAPS events arrive.</p>
      </div>
    );
  }

  if (points.length === 0) {
    return (
      <div className="space-y-3">
        <div className="py-6 text-center">
          <RadioTower className="mx-auto h-5 w-5 text-[var(--fg-3)]" />
          <p className="mt-2 text-[12px] font-medium text-[var(--fg-1)]">
            No procfs snapshots — resource curves need collected samples
          </p>
          <p className="mt-1 text-[11px] text-[var(--fg-3)]">
            {annotations.length} lifecycle event{annotations.length === 1 ? "" : "s"} were recorded, but the process exited too quickly for a 500&nbsp;ms sample.
          </p>
        </div>
        <StateStrip events={events} spanSeconds={spanSeconds} />
      </div>
    );
  }

  const maxRss = points.reduce((m, p) => Math.max(m, p.rssMiB ?? 0), 0);
  const rssDomain: [number, number] = [0, maxRss > 0 ? maxRss : 1];

  return (
    <div className="space-y-2">
      <div className="flex h-56 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={points} margin={{ top: 6, right: 4, bottom: 0, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--line-0)" vertical={false} />
            <XAxis
              dataKey="t"
              type="number"
              domain={[0, spanSeconds]}
              tick={AXIS_TICK}
              stroke="var(--line-1)"
              tickLine={false}
              axisLine={false}
              tickFormatter={(v: number) => fmtSeconds(v)}
            />
            <YAxis yAxisId="rss" domain={rssDomain} tick={AXIS_TICK} stroke="var(--line-1)" tickLine={false} axisLine={false} width={42} tickFormatter={(v: number) => (v >= 1 ? `${v.toFixed(0)}` : v.toFixed(2))} label={{ value: "MiB RSS", position: "insideTopLeft", fill: "var(--fg-4)", fontSize: 9 }} />
            <YAxis yAxisId="cpu" orientation="right" domain={[0, "auto"]} tick={AXIS_TICK} stroke="var(--line-1)" tickLine={false} axisLine={false} width={38} tickFormatter={(v: number) => `${v.toFixed(0)}%`} label={{ value: "CPU %", position: "insideTopRight", fill: "var(--fg-4)", fontSize: 9 }} />
            <Tooltip contentStyle={TOOLTIP_STYLE} cursor={{ fill: "var(--bg-3)" }} labelFormatter={(label: number) => `t = ${fmtSeconds(label)}`} formatter={(value, name) => [name === "rssMiB" ? (value as number).toFixed(2) : (value as number).toFixed(1), name === "rssMiB" ? "RSS (MiB) · OBSERVED" : "CPU util (%) · DERIVED"]} />
            <Line yAxisId="rss" type="monotone" dataKey="rssMiB" stroke="var(--cyan)" strokeWidth={1.5} dot={false} connectNulls={false} isAnimationActive={false} name="rssMiB" />
            <Line yAxisId="cpu" type="monotone" dataKey="cpuPct" stroke="var(--green)" strokeWidth={1.5} dot={false} connectNulls={false} isAnimationActive={false} name="cpuPct" />
            {annotations.map((a) => (
              <ReferenceLine
                key={`${a.type}-${a.t}`}
                yAxisId="cpu"
                x={a.t}
                stroke={a.tone === "start" ? "var(--accent)" : a.tone === "end" ? "var(--green)" : "var(--red)"}
                strokeDasharray={a.tone === "signal" ? "2 3" : "4 2"}
                strokeOpacity={0.45}
                ifOverflow="extendDomain"
              />
            ))}
            {peakRss !== null && peakRss.atTimeMs / 1000 <= spanSeconds ? (
              <ReferenceDot yAxisId="rss" x={peakRss.atTimeMs / 1000} y={peakRss.value / (1024 * 1024)} r={3} fill="var(--cyan)" stroke="none" />
            ) : null}
            {peakCpu !== null && peakCpu.atTimeMs / 1000 <= spanSeconds ? (
              <ReferenceDot yAxisId="cpu" x={peakCpu.atTimeMs / 1000} y={peakCpu.value} r={3} fill="var(--green)" stroke="none" />
            ) : null}
            {highlightSec !== null ? <ReferenceLine yAxisId="cpu" x={highlightSec} stroke="var(--fg-0)" strokeDasharray="1 2" strokeWidth={1} strokeOpacity={0.8} /> : null}
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[9.5px] font-mono text-[var(--fg-3)]">
        <span className="inline-flex items-center gap-1.5"><span className="h-0.5 w-4 bg-[var(--cyan)]" /> RSS curve ({peaks.sampleCount} samples · OBSERVED)</span>
        <span className="inline-flex items-center gap-1.5"><span className="h-0.5 w-4 bg-[var(--green)]" /> CPU util curve (DERIVED from tick deltas)</span>
        {annotations.length > 0 ? <span className="inline-flex items-center gap-1.5"><span className="h-0.5 w-4 border-t border-dashed border-[var(--fg-3)]" /> lifecycle markers</span> : null}
        {highlightSec !== null ? <span className="inline-flex items-center gap-1.5"><span className="h-0.5 w-4 border-t border-dotted border-[var(--fg-0)]" /> replay cursor</span> : null}
        <span className="ml-auto text-[var(--fg-4)]">only collected samples are plotted</span>
      </div>

      <StateStrip events={events} spanSeconds={spanSeconds} />
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