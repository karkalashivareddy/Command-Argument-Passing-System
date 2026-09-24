import { GitFork, Radio, Timer } from "lucide-react";

import type { CanonicalEvent, ProcessSnapshot } from "../../types/observability";

export function ProcessGraph({ events }: { events: CanonicalEvent[] }) {
  const started = events.find((event) => event.type === "process.started");
  const exited = events.find((event) => event.type === "process.exited");
  const execError = events.find((event) => event.type === "process.exec_error");
  const signal = events.find((event) => event.type === "signal.received");
  const latestSnapshotEvent = [...events].reverse().find((event) => event.type === "process.snapshot");
  const snapshot = latestSnapshotEvent?.payload as unknown as ProcessSnapshot | undefined;
  const pid = typeof started?.pid === "number" ? started.pid : null;
  const capsPid = snapshot?.capsEnginePid?.value ?? null;
  const ppid = snapshot?.ppid?.value ?? null;
  const verifiedParent = capsPid !== null && ppid === capsPid;
  const label = typeof started?.payload.label === "string" ? started.payload.label : "UNAVAILABLE";
  const snapshotEvents = events.filter((event) => event.type === "process.snapshot");

  return (
    <div className="space-y-3 py-2">
      <div className="flex flex-col items-stretch gap-2 md:flex-row md:items-center">
        {verifiedParent ? <>
          <IdentityNode title="CAPS ENGINE" value={String(capsPid)} tag="LINUX PID" detail="Gateway-spawned CAPS process · OBSERVED" />
          <Connector label="fork() · PPID matches" />
        </> : null}
        <IdentityNode title={label} value={pid === null ? "UNAVAILABLE" : String(pid)} tag="LINUX PID" detail={pid === null ? "Awaiting CAPS PROCESS_STARTED" : "Child PID from CAPS PROCESS_STARTED · OBSERVED"} active={Boolean(started && !exited && !execError)} />
      </div>

      <div className="grid gap-2 border-t border-[var(--line-0)] pt-3 text-[10.5px] sm:grid-cols-2 lg:grid-cols-4">
        <Fact label="PPID" value={ppid === null ? "UNAVAILABLE" : String(ppid)} provenance={snapshot?.ppid?.provenance ?? "UNAVAILABLE"} />
        <Fact label="Parent relationship" value={verifiedParent ? "CAPS PID confirmed by procfs PPID" : capsPid !== null && ppid !== null ? "Mismatch · link withheld" : "UNAVAILABLE"} provenance={verifiedParent ? "DERIVED FROM TWO OBSERVATIONS" : "UNAVAILABLE"} />
        <Fact label="execvp()" value={execError ? "EXEC_ERROR observed" : exited && !signal ? "success inferred from normal exit" : "UNAVAILABLE"} provenance={execError ? "OBSERVED" : exited && !signal ? "DERIVED" : "UNAVAILABLE"} />
        <Fact label="waitpid result" value={exited ? `PROCESS_EXITED · ${String(exited.payload.exitCode ?? "signal")}` : "WAITING / UNAVAILABLE"} provenance={exited ? "OBSERVED FROM CAPS" : "NOT REACHED"} />
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-[var(--line-0)] pt-2 font-mono text-[9.5px] text-[var(--fg-3)]">
        <span className="inline-flex items-center gap-1"><GitFork className="h-3 w-3" /> PROCESS LINEAGE</span>
        {started ? <span>START seq {started.sequence}</span> : null}
        <span>{snapshotEvents.length} procfs samples</span>
        {signal ? <span className="inline-flex items-center gap-1 text-[var(--red)]"><Radio className="h-3 w-3" /> SIGNAL seq {signal.sequence} · {String(signal.payload.signal)}</span> : null}
        {exited ? <span className="inline-flex items-center gap-1 text-[var(--green)]"><Timer className="h-3 w-3" /> EXIT seq {exited.sequence}</span> : null}
        {!exited && started ? <span className="text-[var(--accent)]">RUNNING · updates from real events</span> : null}
      </div>
      <p className="text-[9.5px] leading-relaxed text-[var(--fg-3)]">CAPS engine and target are separate Linux processes only when their PIDs are observed. execvp() replaces the child image without changing its PID; that mechanism is educational, not an additional process node.</p>
    </div>
  );
}

function IdentityNode({ title, value, tag, detail, active = false }: { title: string; value: string; tag: string; detail: string; active?: boolean }) {
  return <div className={`min-w-0 flex-1 rounded border px-3 py-2 ${active ? "border-[var(--accent-soft)] bg-[var(--bg-2)]" : "border-[var(--line-0)] bg-[var(--bg-2)]"}`}>
    <div className="flex items-center justify-between gap-2"><span className="truncate font-mono text-[11px] font-semibold text-[var(--fg-1)]">{title}</span><span className="font-mono text-[8px] text-[var(--fg-3)]">{tag}</span></div>
    <div className={`mt-1 font-mono text-lg ${active ? "text-[var(--accent)]" : "text-[var(--fg-0)]"}`}>{value}</div>
    <div className="mt-1 text-[9px] text-[var(--fg-3)]">{detail}</div>
  </div>;
}

function Connector({ label }: { label: string }) {
  return <div className="flex shrink-0 flex-col items-center justify-center gap-1 px-2 text-[9px] text-[var(--fg-3)]"><span className="hidden h-px w-8 bg-[var(--line-1)] md:block" /><GitFork className="h-3 w-3 md:hidden" /><span className="whitespace-nowrap font-mono">{label}</span></div>;
}

function Fact({ label, value, provenance }: { label: string; value: string; provenance: string }) {
  return <div className="min-w-0"><div className="text-[8px] uppercase tracking-wide text-[var(--fg-3)]">{label}</div><div className="mt-0.5 break-words font-mono text-[10px] text-[var(--fg-1)]">{value}</div><div className="mt-0.5 font-mono text-[8px] text-[var(--fg-3)]">{provenance}</div></div>;
}
