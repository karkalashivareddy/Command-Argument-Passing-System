import { useMemo } from "react";
import { ArrowDownToLine, Cpu, DatabaseZap, Droplets } from "lucide-react";

import type { CanonicalEvent } from "../../types/observability";
import { deriveRuntimePeaks } from "../../lib/telemetry";
import { fmtClock, fmtDuration } from "../../lib/format";

function formatMiB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

/**
 * Peaks & moments derived strictly from persisted process.snapshot events.
 * Every card is null-negated: missing data renders "UNAVAILABLE", never zero.
 */
export function PeaksPanel({ events }: { events: CanonicalEvent[] }) {
  const peaks = useMemo(() => deriveRuntimePeaks(events), [events]);
  const span = peaks.firstSampleAt && peaks.lastSampleAt
    ? fmtDuration(new Date(peaks.lastSampleAt).getTime() - new Date(peaks.firstSampleAt).getTime())
    : null;

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <PeakCard
          icon={<Droplets className="h-3.5 w-3.5" />}
          label="Peak RSS"
          value={peaks.peakRssBytes === null ? "UNAVAILABLE" : formatMiB(peaks.peakRssBytes.value)}
          detail={peaks.peakRssBytes === null ? "No valid VmRSS sample" : `at t=${(peaks.peakRssBytes.atTimeMs / 1000).toFixed(2)}s · ${fmtClock(peaks.peakRssBytes.atTimestamp)}`}
          note="OBSERVED · /proc/<pid>/status"
          tone="cyan"
        />
        <PeakCard
          icon={<Cpu className="h-3.5 w-3.5" />}
          label="Peak CPU util"
          value={peaks.peakCpuPercent === null ? "UNAVAILABLE" : `${peaks.peakCpuPercent.value.toFixed(1)}%`}
          detail={peaks.peakCpuPercent === null ? "Needs ≥2 valid samples" : `at t=${(peaks.peakCpuPercent.atTimeMs / 1000).toFixed(2)}s · ${fmtClock(peaks.peakCpuPercent.atTimestamp)}`}
          note="DERIVED · tick deltas"
          tone="green"
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
          detail={peaks.cpuTimeMs === null ? "No valid CPU tick sample" : "final sample · DERIVED from procfs ticks"}
          note="plus elapsed range below"
          tone="neutral"
        />
      </div>

      <div className="flex flex-wrap gap-x-5 gap-y-1 text-[9.5px] font-mono text-[var(--fg-3)]">
        <span>ELAPSED RANGE · {peaks.minElapsedMs === null || peaks.maxElapsedMs === null ? "UNAVAILABLE (no derived elapsed samples)" : `${fmtDuration(peaks.minElapsedMs)} – ${fmtDuration(peaks.maxElapsedMs)} from kernel start ticks`}</span>
        <span>MEDIAN RSS · {peaks.medianRssBytes === null ? "UNAVAILABLE (needs ≥2 samples)" : formatMiB(peaks.medianRssBytes)}</span>
        <span>FIRST SAMPLE · {peaks.firstSampleAt === null ? "—" : fmtClock(peaks.firstSampleAt)}</span>
        <span>LAST SAMPLE · {peaks.lastSampleAt === null ? "—" : fmtClock(peaks.lastSampleAt)}</span>
      </div>
    </div>
  );
}

function PeakCard({ icon, label, value, detail, note, tone }: { icon: React.ReactNode; label: string; value: string; detail: string; note: string; tone: "cyan" | "green" | "violet" | "neutral" }) {
  const accent = tone === "cyan" ? "text-[var(--cyan)]" : tone === "green" ? "text-[var(--green)]" : tone === "violet" ? "text-[var(--violet)]" : "text-[var(--fg-3)]";
  return (
    <div className="rounded-[var(--r-md)] border border-[var(--line-0)] bg-[var(--bg-2)] p-3">
      <div className="flex items-center gap-1.5 text-[9.5px] font-semibold uppercase tracking-wide text-[var(--fg-3)]">
        <span className={accent}>{icon}</span>
        {label}
      </div>
      <div className="mt-1 font-mono text-[13px] font-semibold text-[var(--fg-0)] tabular-nums">{value}</div>
      <div className="mt-0.5 text-[9.5px] text-[var(--fg-3)]">{detail}</div>
      <div className="mt-1 border-t border-[var(--line-0)] pt-1 font-mono text-[7.5px] text-[var(--fg-4)]">{note}</div>
    </div>
  );
}
