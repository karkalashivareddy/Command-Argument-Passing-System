import { Link, useParams, useSearchParams } from "react-router-dom";
import { Activity, ClipboardList, Download, ExternalLink, FileText, RefreshCw, Square, Timer, XCircle } from "lucide-react";
import { useEffect, useState } from "react";

import { api, ApiError } from "../api/client";
import { ArgvView } from "../components/execution/ArgvView";
import { EventStream } from "../components/execution/EventStream";
import { OutputPanel } from "../components/execution/OutputPanel";
import { PeaksPanel } from "../components/execution/PeaksPanel";
import { Pipeline } from "../components/execution/Pipeline";
import { ProcessGraph } from "../components/execution/ProcessGraph";
import { ProcessTelemetry } from "../components/execution/ProcessTelemetry";
import { RedirectionDiagram } from "../components/execution/RedirectionDiagram";
import { ReplayPanel } from "../components/execution/ReplayPanel";
import { ResultPanel } from "../components/execution/ResultPanel";
import { SequenceBadge } from "../components/execution/SequenceBadge";
import { SignalDiagram } from "../components/execution/SignalDiagram";
import { Timeline } from "../components/execution/Timeline";
import { Badge, Button, Card, CopyButton, EmptyState, LiveBadge, Spinner, StatusDot } from "../components/ui";
import { fmtClock, fmtDuration, shortId } from "../lib/format";
import type { ProcessSnapshot } from "../types/observability";
import { STATUS_META } from "../lib/stages";
import { useSession } from "../lib/useSession";
import { useUi } from "../store/ui";

function download(filename: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1500);
}

export default function ExecutionPage() {
  const { id = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const replayMode = params.get("replay") === "1";
  const { session, events, loading, error, ended, connected } = useSession(id, { live: !replayMode });
  const pushToast = useUi((s) => s.pushToast);

  const [visibleEvents, setVisibleEvents] = useState<null | typeof events>(null);
  const [terminating, setTerminating] = useState(false);
  const [clockNow, setClockNow] = useState(() => Date.now());
  const [cursorMs, setCursorMs] = useState(0);
  const [reportOpen, setReportOpen] = useState(false);
  const [reportText, setReportText] = useState<string | null>(null);
  const [reportError, setReportError] = useState<string | null>(null);

  const activeEvents = replayMode ? (visibleEvents ?? []) : events;
  const activeStatus = session?.status ?? "CREATED";

  useEffect(() => {
    if (!replayMode) setVisibleEvents(null);
  }, [replayMode]);

  useEffect(() => {
    if (!session || ended || replayMode) return;
    const timer = window.setInterval(() => setClockNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, [session?.id, ended, replayMode]);

  const terminate = async () => {
    if (!session || terminating) return;
    setTerminating(true);
    try {
      await api.terminate(session.id, "SIGINT");
      pushToast("SIGINT sent — the child will be interrupted and stopped.", "success");
    } catch (err) {
      pushToast(err instanceof ApiError ? err.message : String(err), "error");
    } finally {
      setTerminating(false);
    }
  };

  const exportFlight = async (format: "json" | "csv") => {
    if (!session) return;
    try {
      const content = format === "json" ? await api.exportJson(session.id) : await api.exportCsv(session.id);
      download(`${session.id}.${format}`, content, format === "json" ? "application/json" : "text/csv");
      pushToast(`Exported ${content.split("\n").length}${format === "csv" ? "" : " event envelope(s) "} as ${format.toUpperCase()}.`, "success");
    } catch (err) {
      pushToast(err instanceof ApiError ? err.message : String(err), "error");
    }
  };

  const toggleReport = async () => {
    if (!session) return;
    if (reportOpen) {
      setReportOpen(false);
      return;
    }
    setReportOpen(true);
    if (reportText !== null || reportError !== null) return;
    try {
      setReportText(await api.report(session.id));
    } catch (err) {
      setReportError(err instanceof ApiError ? err.message : String(err));
    }
  };

  const exportReport = () => {
    if (!session || reportText === null) return;
    download(`${session.id}-report.md`, reportText, "text/markdown");
  };

  if (error) {
    return (
      <div className="mx-auto max-w-6xl px-6 py-6">
        <EmptyState icon={<XCircle className="h-5 w-5" />} title="Flight recorder unavailable" body={error} />
      </div>
    );
  }

  if (loading || !session) {
    return (
      <div className="mx-auto max-w-6xl px-6 py-6">
        <Spinner label="Opening the flight recorder…" />
      </div>
    );
  }

  const canTerminate = !ended && (session.status === "RUNNING" || session.status === "STARTING");
  const liveElapsedMs = session.durationMs ?? Math.max(0, clockNow - Date.parse(session.startedAt));
  const processStarted = activeEvents.find((e) => e.type === "process.started");
  const latestProcSnapshotEvent = [...activeEvents].reverse().find((e) => e.type === "process.snapshot");
  const latestProcSnapshot = latestProcSnapshotEvent?.payload as unknown as ProcessSnapshot | undefined;
  const redirsPresent = Boolean(session.redirections.in || session.redirections.out || session.redirections.append);
  const signalEvent = activeEvents.find((e) => e.type === "signal.received");
  const signalVal = (signalEvent?.payload?.signal as number | undefined) ?? session.signal;
  const execErrorObserved = activeEvents.some((e) => e.type === "process.exec_error");
  const processExit = activeEvents.find((e) => e.type === "process.exited");
  const execSuccessInferred = Boolean(processExit) && !activeEvents.some((e) => e.type === "signal.received");
  const engineDuration = activeEvents.find((e) => e.type === "process.exited" || e.type === "process.exec_error")?.payload?.durationMs;
  const elapsedDisplay = typeof engineDuration === "number"
    ? `${fmtDuration(engineDuration)} · CAPS CLOCK_MONOTONIC`
    : `${fmtDuration(session.durationMs ?? liveElapsedMs)} · DERIVED FROM GATEWAY CLOCK`;

  return (
    <div className="mx-auto max-w-6xl space-y-6 px-6 py-6">
      {/* Header — session identity */}
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <Link to="/history" className="flex items-center gap-1 rounded-r-md px-1 text-[11px] uppercase tracking-wide text-[var(--fg-3)] hover:text-[var(--fg-1)]">
            History
          </Link>
          <span className="text-[var(--fg-4)]">/</span>
          <code className="font-mono text-[11px] text-[var(--fg-3)]">{shortId(session.id)}</code>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-3">
          <h1 className="truncate font-mono text-xl font-semibold tracking-tight text-[var(--fg-0)]">
            {session.command} <span className="text-[var(--fg-2)]">{session.args.join(" ")}</span>
          </h1>
          <span className="flex items-center gap-2">
            {replayMode ? <Badge tone="violet">REPLAY</Badge> : <LiveBadge live={connected && !ended && session.status === "RUNNING"} />}
            <StatusDot tone={STATUS_META[activeStatus].tone} label={STATUS_META[activeStatus].label} />
          </span>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11.5px] text-[var(--fg-3)]">
          <span className="font-mono">CAPS EXECUTION ID · {session.id}</span>
          <span className="font-mono">LINUX PID · {session.pid ?? "UNAVAILABLE"}</span>
          <span className="font-mono">PROCESS START EVENT RECEIVED · {processStarted ? fmtClock(processStarted.timestamp) : "UNAVAILABLE"}</span>
          <span className="flex items-center gap-1"><Timer className="h-3 w-3" /> ELAPSED · {elapsedDisplay}</span>
          <span className="font-mono">{activeEvents.length} events</span>
          {replayMode ? (
            <Button size="sm" variant="ghost" onClick={() => setParams({})}>
              <RefreshCw className="h-3 w-3" /> Live view
            </Button>
          ) : (
            <Button size="sm" variant="ghost" onClick={() => setParams({ replay: "1" })}>
              <ClipboardList className="h-3 w-3" /> Replay
            </Button>
          )}
          {canTerminate ? (
            <Button size="sm" variant="danger" onClick={terminate} disabled={terminating}>
              <Square className="h-3 w-3" /> {terminating ? "Sending SIGINT…" : "Terminate (SIGINT)"}
            </Button>
          ) : null}
          {session ? (
            <>
              <Button size="sm" variant="outline" onClick={() => void exportFlight("json")} title="Download this execution as a JSON event payload">
                <Download className="h-3 w-3" /> JSON
              </Button>
              <Button size="sm" variant="outline" onClick={() => void exportFlight("csv")} title="Download this execution as CSV">
                <Download className="h-3 w-3" /> CSV
              </Button>
              <Button size="sm" variant="outline" onClick={() => void toggleReport()} aria-expanded={reportOpen} title="Human-readable observation report of this execution">
                <FileText className="h-3 w-3" /> {reportOpen ? "Hide report" : "Report"}
              </Button>
            </>
          ) : null}
          <Link to={`/arguments/${session.id}`}>
            <Button size="sm" variant="ghost">
              <Activity className="h-3 w-3" /> Argument inspector <ExternalLink className="h-3 w-3 text-[var(--fg-3)]" />
            </Button>
          </Link>
        </div>
      </div>

      {/* Replay scrubber at the top when in replay mode */}
      {replayMode ? (
        <Card
          title="Flight recorder replay"
          subtitle="Scrubbing through the real recorded event timeline — nothing regenerated"
          pad={false}
        >
          <div className="px-4 py-3">
            <ReplayPanel
              events={events}
              status={session.status}
              onVisible={(evs) => {
                setVisibleEvents(evs);
              }}
              onCursorMs={(ms) => setCursorMs(ms)}
            />
          </div>
        </Card>
      ) : null}

      {/* Observation report */}
      {reportOpen ? (
        <Card title="Observation report" subtitle="Generated from the persisted event store; it never re-runs the command" actions={<span className="flex items-center gap-2">{reportText !== null ? <><CopyButton value={reportText} label="Copy markdown" /><Button size="sm" variant="ghost" onClick={() => void exportReport() }><Download className="h-3 w-3" /> Download .md</Button></> : null}</span>}>
          {reportError !== null ? (
            <EmptyState icon={<XCircle className="h-5 w-5" />} title="Report unavailable" body={reportError} />
          ) : reportText === null ? (
            <Spinner label="Building the observation report…" />
          ) : (
            <pre className="max-h-[28rem] overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-[var(--fg-1)]">{reportText}</pre>
          )}
        </Card>
      ) : null}

      {/* Result / status bar once over */}
      {activeStatus === "COMPLETED" || activeStatus === "FAILED" || activeStatus === "TIMED_OUT" || activeStatus === "CANCELLED" ? (
        <ResultPanel status={activeStatus} exitCode={session.exitCode} signal={session.signal} durationMs={session.durationMs} isSuccess={session.isSuccess} error={session.error} />
      ) : null}

      {/* Execution pipeline — driven live by the event stream */}
      <Card title="Execution pipeline" subtitle={replayMode ? "showing the replayed snapshot of the real timeline" : "updates as real CAPS events arrive"} actions={<PipelineLegendInline />} pad={false}>
        <div className="px-4 py-3">
          <Pipeline events={activeEvents} status={activeStatus} />
        </div>
      </Card>

      {/* Process topology + argument vector */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card title="Observed process lineage" subtitle="A Linux parent/child link appears only when procfs PPID matches the gateway-spawned CAPS PID" pad={false}>
          <div className="px-4 py-2">
            <ProcessGraph events={activeEvents} />
          </div>
        </Card>
        <Card title="Argument vector" subtitle={`argv[${session.argv.length}] with required NULL terminator`}>
          <ArgvView argv={session.argv} eventCount={activeEvents.length} />
        </Card>
      </div>

      <ProcessTelemetry events={activeEvents} replay={replayMode || ended} />

      {/* Flight recorder timeline — resource curves, lifecycle markers, replay cursor */}
      <Card
        title="Flight recorder"
        subtitle={replayMode ? "Resource curves and lifecycle markers follow the replay cursor" : "Resource curves plot only collected procfs samples; lifecycle markers come from real events"}
        actions={<Badge tone={replayMode ? "violet" : "active"}>{replayMode ? "REPLAY SYNCED" : "LIVE"}</Badge>}
        pad={false}
      >
        <div className="space-y-3 px-4 py-3">
          <Timeline events={events} highlightMs={replayMode ? cursorMs : null} />
          <PeaksPanel events={events} />
        </div>
      </Card>

      {/* Output */}
      <Card title="Output" subtitle="Exact bytes captured from the child's stdout and stderr">
        <OutputPanel stdout={session.stdout} stderr={session.stderr} />
      </Card>

      {/* Redirection + signals (only when they actually happened) */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {redirsPresent ? (
          <Card title="Redirection" subtitle="fd 0 / fd 1 / fd 2 plumbing, from the real redirection spec">
            <RedirectionDiagram redirections={session.redirections} events={activeEvents} />
          </Card>
        ) : null}
        {signalVal !== null && signalVal > 0 ? (
          <Card title="Signal" subtitle="How the termination actually arrived">
            <SignalDiagram events={activeEvents} signal={signalVal} exitCode={session.exitCode} />
          </Card>
        ) : null}
      </div>

      {/* Event stream — the raw chronological record */}
      <Card
        title="Event stream"
        subtitle="Sequence, timestamp, type, payload — every event that reached the gateway"
        actions={<span className="flex flex-wrap items-center justify-end gap-2"><SequenceBadge events={activeEvents} /><span className="font-mono text-[10.5px] text-[var(--fg-3)]">source: caps events · gateway envelope</span></span>}
        pad={false}
      >
        <EventStream events={activeEvents} status={activeStatus} live={!replayMode && !ended} />
      </Card>

      <Card title="Data lineage" subtitle="Where each displayed fact comes from; inferred values are labeled">
        <dl className="grid grid-cols-1 gap-x-8 gap-y-3 text-[12px] sm:grid-cols-2">
          <LineageRow label="Command + argv" source="REAL · validated gateway request" detail={`${session.argv.length} entries; browser request supplies an array, so command-string tokenization is unavailable.`} />
          <LineageRow label="Child PID" source={session.pid === null ? "UNAVAILABLE" : "REAL · CAPS PROCESS_STARTED"} detail={session.pid === null ? "No process-start event supplied a PID." : `PID ${session.pid}; this is the child created by fork().`} />
          <LineageRow label="CAPS engine PID" source={typeof latestProcSnapshot?.capsEnginePid?.value === "number" ? "OBSERVED · gateway child_process.spawn" : "UNAVAILABLE"} detail={typeof latestProcSnapshot?.capsEnginePid?.value === "number" ? `Linux PID ${latestProcSnapshot.capsEnginePid.value} for the CAPS engine process spawned by the gateway.` : "The CAPS process PID is unavailable until a procfs snapshot is collected."} />
          <LineageRow label="PPID / process group / Linux session" source={typeof processStarted?.pid === "number" ? "OBSERVED · /proc/<pid>/stat and status" : "UNAVAILABLE"} detail="Read from the tracked child’s procfs snapshot. The process graph links CAPS to the child only when observed PPID equals the gateway-spawned CAPS PID." />
          <LineageRow label="Exec outcome" source={execErrorObserved ? "REAL · CAPS EXEC_ERROR" : execSuccessInferred ? "DERIVED · ordinary process exit" : "UNAVAILABLE · no exec-success event"} detail="CAPS distinguishes execvp() failure from an application exit code with a close-on-exec status pipe. An ordinary process exit supports successful exec; termination by signal may have occurred before exec." />
          <LineageRow label="Engine process duration" source={typeof engineDuration === "number" ? "REAL · CAPS CLOCK_MONOTONIC" : "UNAVAILABLE · no engine duration event"} detail={typeof engineDuration === "number" ? `${fmtDuration(engineDuration)} measured by CAPS from fork through reap.` : "The engine has not reported a completed process duration."} />
          <LineageRow label="Session elapsed display" source={session.durationMs === null ? "UNAVAILABLE" : "DERIVED · gateway wall clock"} detail={session.durationMs === null ? "No finalized session duration is available." : `${fmtDuration(session.durationMs)} calculated by the gateway; it is distinct from the engine's monotonic duration.`} />
          <LineageRow label="Exit status / signal" source={session.exitCode !== null || session.signal !== null ? "REAL · CAPS waitpid status" : "UNAVAILABLE · process has not reported a result"} detail={session.signal !== null ? `Terminated by signal ${session.signal}; status ${session.exitCode ?? "UNAVAILABLE"} uses shell-style 128 + signal interpretation.` : session.exitCode !== null ? `wait status interpreted as exit code ${session.exitCode}.` : ""} />
          <LineageRow label="Resources" source="OBSERVED · /proc/<pid>/status; DERIVED · CPU delta" detail="RSS, virtual memory, thread count, and context switches come from procfs. CPU utilization is derived only when two valid samples are available." />
          <LineageRow label="Start time / elapsed" source="DERIVED · /proc/<pid>/stat + /proc/uptime" detail="Derived from kernel start ticks and uptime using the Linux clock-tick rate. The gateway receive timestamp is not presented as a kernel timestamp." />
          <LineageRow label="Working directory / argv" source="UNAVAILABLE / OBSERVED REQUEST" detail="Working directory is not sampled. argv is the gateway-validated structured request, not cmdline read from procfs." />
          <LineageRow label="Event timestamp" source="REAL · gateway receive time" detail="The timestamp records when the gateway received each monitor line, not a kernel timestamp." />
        </dl>
      </Card>
    </div>
  );
}

function LineageRow({ label, source, detail }: { label: string; source: string; detail: string }) {
  return (
    <div className="min-w-0 border-l-2 border-[var(--line-1)] pl-3">
      <dt className="font-semibold text-[var(--fg-1)]">{label}</dt>
      <dd className="mt-0.5 font-mono text-[10px] uppercase tracking-wide text-[var(--accent)]">{source}</dd>
      {detail ? <dd className="mt-1 text-[11px] leading-relaxed text-[var(--fg-3)]">{detail}</dd> : null}
    </div>
  );
}

function PipelineLegendInline() {
  return <span className="hidden font-mono text-[9.5px] text-[var(--fg-3)] md:inline">REAL EVENT · INFERRED STATE · UNAVAILABLE</span>;
}
