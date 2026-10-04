import { useMemo } from "react";
import { ArrowDownToLine, Cpu, DatabaseZap, Droplets, HardDrive, Radio } from "lucide-react";

import type { CanonicalEvent } from "../../types/observability";
import { deriveRuntimePeaks } from "../../lib/telemetry";
import { fmtClock, fmtDuration, formatCount, formatKibPerSec, formatMiB, formatPercent } from "../../lib/format";

type Tone = "cyan" | "green" | "blue" | "amber" | "violet" | "neutral";

function peakLabel(peak: { value: number; atTimeMs: number; atTimestamp: string } | null, format: (value: number) => string, unavailable: string): { value: string; detail: string } {
  if (peak === null) return { value: "UNAVAILABLE", detail: unavailable };
  return { value: format(peak.value), detail: `at t=${(peak.atTimeMs / 1000).toFixed(2)}s · ${fmtClock(peak.atTimestamp)}` };
}

/**
 * Peaks and moments derived strictly from persisted process.snapshot events.
 * Every card is null-negated: missing data renders "UNAVAILABLE", never zero,
 * and every card can move the shared execution-time cursor to its peak.
 */
export function PeaksPanel({ events, cursorMs, onSeek }: { events: CanonicalEvent[]; cursorMs: number | null; onSeek: (atMs: number) => void }) {
  const peaks = useMemo(() => deriveRuntimePeaks(events), [events]);
  const span = peaks.firstSampleAt && peaks.lastSampleAt
    ? fmtDuration(new Date(peaks.lastSampleAt).getTime() - new Date(peaks.firstSampleAt).getTime())
    : null;

  const rss = peakLabel(peaks.peakRssBytes, formatMiB, "No valid VmRSS sample");
  const cpu = peakLabel(peaks.peakCpuPercent, formatPercent, "Needs ≥2 valid samples");
  const rchar = peakLabel(peaks.peakRcharBytesPerSec, formatKibPerSec, "First sample has no rate");
  const wchar = peakLabel(peaks.peakWcharBytesPerSec, formatKibPerSec, "First sample has no rate");
  const minor = peakLabel(peaks.peakMinorFaults, formatCount, "No valid fault sample");
  const major = peakLabel(peaks.peakMajorFaults, formatCount, "No valid fault sample");

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <PeakCard
          icon={<Droplets className="h-3.5 w-3.5" />}
          label="Peak RSS"
          value={rss.value}
          detail={rss.detail}
          note="OBSERVED · /proc/<pid>/status"
          tone="cyan"
          atMs={peaks.peakRssBytes?.atTimeMs ?? null}
          cursorMs={cursorMs}
          onSeek={onSeek}
        />
        <PeakCard
          icon={<Cpu className="h-3.5 w-3.5" />}
          label="Peak CPU util"
          value={cpu.value}
          detail={cpu.detail}
          note="DERIVED · one core, ≥2 samples"
          tone="green"
          atMs={peaks.peakCpuPercent?.atTimeMs ?? null}
          cursorMs={cursorMs}
          onSeek={onSeek}
        />
        <PeakCard
          icon={<HardDrive className="h-3.5 w-3.5" />}
          label="Peak syscall I/O"
          value={peaks.peakRcharBytesPerSec === null && peaks.peakWcharBytesPerSec === null ? "UNAVAILABLE" : `r ${rchar.value} · w ${wchar.value}`}
          detail={peaks.peakRcharBytesPerSec === null && peaks.peakWcharBytesPerSec === null ? "Rates need two valid samples" : `${rchar.detail} (read) · ${wchar.detail} (write)`}
          note="DERIVED · rchar/wchar, not disk"
          tone="blue"
          atMs={peaks.peakRcharBytesPerSec === null ? null : peaks.peakRcharBytesPerSec.atTimeMs}
          cursorMs={cursorMs}
          onSeek={onSeek}
        />
        <PeakCard
          icon={<Radio className="h-3.5 w-3.5" />}
          label="Peak page faults"
          value={peaks.peakMinorFaults === null && peaks.peakMajorFaults === null ? "UNAVAILABLE" : `min ${minor.value} · maj ${major.value}`}
          detail={peaks.peakMinorFaults === null && peaks.peakMajorFaults === null ? "No valid fault counters" : `cumulative; ${minor.detail}`}
          note="OBSERVED · /proc/<pid>/stat"
          tone="amber"
          atMs={peaks.peakMajorFaults?.atTimeMs ?? peaks.peakMinorFaults?.atTimeMs ?? null}
          cursorMs={cursorMs}
          onSeek={onSeek}
        />
        <PeakCard
          icon={<DatabaseZap className="h-3.5 w-3.5" />}
          label="Sample count"
          value={String(peaks.sampleCount)}
          detail={span === null ? "no persisted samples" : `sampling span ${span}`}
          note="persisted process.snapshot events"
          tone="violet"
        />
        <PeakCard
          icon={<ArrowDownToLine className="h-3.5 w-3.5" />}
          label="CPU time (u+s)"
          value={peaks.cpuTimeMs === null ? "UNAVAILABLE" : fmtDuration(peaks.cpuTimeMs)}
          detail={peaks.cpuTimeMs === null ? "No valid CPU tick sample" : "final sample · OBSERVED cpuTimeMs"}
          note="plus elapsed range below"
          tone="neutral"
          atMs={null}
          cursorMs={cursorMs}
          onSeek={onSeek}
        />
        <PeakCard
          icon={<HardDrive className="h-3.5 w-3.5" />}
          label="Block I/O totals"
          // Read and write are tracked independently, so `?? 0` was reachable:
          // with a read peak but no write peak the card printed "1.20 MiB /
          // 0.00 MiB" while the detail line claimed "last valid observation".
          // Each half now renders its own unavailable state.
          value={
            peaks.totalReadBytes === null && peaks.totalWriteBytes === null
              ? "UNAVAILABLE"
              : `r ${peaks.totalReadBytes === null ? "—" : formatMiB(peaks.totalReadBytes)} · w ${peaks.totalWriteBytes === null ? "—" : formatMiB(peaks.totalWriteBytes)}`
          }
          detail={
            peaks.totalReadBytes === null && peaks.totalWriteBytes === null
              ? "No valid block counters"
              : `read / write · last valid observation${peaks.totalReadBytes === null ? " (no read counter)" : ""}${peaks.totalWriteBytes === null ? " (no write counter)" : ""}`
          }
          note="OBSERVED · read_bytes/write_bytes"
          tone="neutral"
        />
        <PeakCard
          icon={<Droplets className="h-3.5 w-3.5" />}
          label="Median RSS"
          value={peaks.medianRssBytes === null ? "UNAVAILABLE" : formatMiB(peaks.medianRssBytes)}
          detail={peaks.medianRssBytes === null ? "Needs ≥2 valid RSS samples" : "median of the persisted VmRSS samples"}
          note="OBSERVED · /proc/<pid>/status"
          tone="neutral"
        />
      </div>

      <div className="flex flex-wrap gap-x-5 gap-y-1 text-[9.5px] font-mono text-[var(--fg-3)]">
        <span>ELAPSED RANGE · {peaks.minElapsedMs === null || peaks.maxElapsedMs === null ? "UNAVAILABLE (no derived elapsed samples)" : `${fmtDuration(peaks.minElapsedMs)} – ${fmtDuration(peaks.maxElapsedMs)} from kernel start ticks`}</span>
        <span>FIRST SAMPLE · {peaks.firstSampleAt === null ? "—" : fmtClock(peaks.firstSampleAt)}</span>
        <span>LAST SAMPLE · {peaks.lastSampleAt === null ? "—" : fmtClock(peaks.lastSampleAt)}</span>
        <span>CHARACTER I/O TOTALS · rchar {peaks.totalRcharBytes === null ? "UNAVAILABLE" : formatMiB(peaks.totalRcharBytes)} · wchar {peaks.totalWcharBytes === null ? "UNAVAILABLE" : formatMiB(peaks.totalWcharBytes)}</span>
      </div>
    </div>
  );
}

function PeakCard({ icon, label, value, detail, note, tone, atMs, cursorMs, onSeek }: {
  icon: React.ReactNode;
  label: string;
  value: string;
  detail: string;
  note: string;
  tone: Tone;
  atMs?: number | null;
  cursorMs?: number | null;
  onSeek?: (atMs: number) => void;
}) {
  const accent = tone === "cyan" ? "text-[var(--cyan)]" : tone === "green" ? "text-[var(--green)]" : tone === "blue" ? "text-[var(--blue)]" : tone === "amber" ? "text-[var(--amber)]" : tone === "violet" ? "text-[var(--violet)]" : "text-[var(--fg-3)]";
  const seekable = atMs !== null && atMs !== undefined && onSeek !== undefined;
  const atCursor = seekable && cursorMs !== null && cursorMs !== undefined && Math.abs(cursorMs - atMs) <= 750;
  return (
    <div
      className={`rounded-[var(--r-md)] border bg-[var(--bg-2)] p-3 ${atCursor ? "border-[var(--accent)]" : "border-[var(--line-0)]"}`}
    >
      <div className="flex items-center gap-1.5 text-[9.5px] font-semibold uppercase tracking-wide text-[var(--fg-3)]">
        <span className={accent}>{icon}</span>
        {label}
      </div>
      <div className="mt-1 font-mono text-[13px] font-semibold text-[var(--fg-0)] tabular-nums">{value}</div>
      <div className="mt-0.5 text-[9.5px] text-[var(--fg-3)]">{detail}</div>
      <div className="mt-1 flex items-center justify-between gap-2 border-t border-[var(--line-0)] pt-1">
        <span className="font-mono text-[7.5px] text-[var(--fg-4)]">{note}</span>
        {seekable ? (
          <button
            className="font-mono text-[8.5px] text-[var(--fg-3)] underline decoration-dotted underline-offset-2 hover:text-[var(--accent)]"
            onClick={() => onSeek!(atMs!)}
            title="Move the shared cursor to this moment"
          >
            {atCursor ? "cursor here" : "seek"}
          </button>
        ) : null}
      </div>
    </div>
  );
}
