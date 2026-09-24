import { ArrowDown, BadgeCheck, XCircle } from "lucide-react";

import { signalDescription, signalName } from "../../lib/format";
import type { CanonicalEvent } from "../../types/observability";

/**
 * Signal flow: USER → gateway → CAPS → child, then the child's termination
 * propagates back as exit status. Signal number and outcome are real; only
 * the flow itself is drawn.
 */
export function SignalDiagram({ events, signal, exitCode }: { events: CanonicalEvent[]; signal: number | null; exitCode: number | null }) {
  const received = events.some((e) => e.type === "signal.received" || e.type === "execution.timeout");
  const anySignal = signal !== null && signal >= 0;

  return (
    <div className="space-y-4 py-2">
      {signal !== null && signal > 0 ? (
        <div className="flex items-center justify-center gap-4">
          {[
            { label: "USER", sub: "keyboard · client" },
            { label: "gateway", sub: "terminate route" },
            { label: "CAPS", sub: "kill(pid, sig)" },
            { label: "child", sub: signalName(signal) },
          ].map((box, i, arr) => (
            <div key={box.label} className="flex items-center gap-4">
              <div className="flex flex-col items-center gap-1">
                <div
                  className={
                    box.label === "child"
                      ? "flex h-9 items-center rounded-[var(--r-sm)] border border-[var(--red-soft)] bg-[var(--red-soft)] px-3 text-[var(--red)]"
                      : "flex h-9 items-center rounded-[var(--r-sm)] border border-[var(--line-1)] bg-[var(--bg-2)] px-3 text-[var(--fg-1)]"
                  }
                >
                  <span className="text-[12px] font-semibold">{box.label}</span>
                </div>
                <span className="text-[10px] text-[var(--fg-3)]">{box.sub}</span>
              </div>
              {i < arr.length - 1 ? (
                <div className="flex h-8 flex-col items-center justify-center">
                  <div className={`h-0.5 w-8 ${received ? "bg-[var(--red)]" : "bg-[var(--line-1)]"}`} />
                  <ArrowDown className={`mt-0.5 h-3.5 w-3.5 ${received ? "text-[var(--red)]" : "text-[var(--fg-3)]"}`} />
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ) : (
        <div className="flex items-center justify-center gap-2 rounded-[var(--r-md)] border border-dashed border-[var(--line-1)] py-6 text-[12.5px] text-[var(--fg-3)]">
          <BadgeCheck className="h-4 w-4 text-[var(--green)]" />
          This execution finished without a signal — the process was never interrupted.
        </div>
      )}

      {anySignal && received ? (
        <div className="rounded-[var(--r-md)] border border-[var(--red-soft)] bg-[var(--bg-2)] px-3.5 py-2.5">
          <p className="flex items-center gap-1.5 text-[12.5px] font-medium text-[var(--fg-0)]">
            <XCircle className="h-4 w-4 text-[var(--red)]" />
            The child was terminated by <span className="font-mono text-[var(--red)]">{signalName(signal)} ({signal})</span>
            {exitCode !== null && exitCode > 128 ? <span className="text-[var(--fg-2)]"> · exit status {exitCode}</span> : null}
          </p>
          <p className="mt-1 text-[11.5px] leading-relaxed text-[var(--fg-2)]">{signalDescription(signal)}</p>
        </div>
      ) : null}
    </div>
  );
}