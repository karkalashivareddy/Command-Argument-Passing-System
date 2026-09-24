import { Link, useParams, useSearchParams } from "react-router-dom";
import { Activity, ClipboardList, ExternalLink, RefreshCw, Square, Timer, XCircle } from "lucide-react";
import { useEffect, useState } from "react";

import { api, ApiError } from "../api/client";
import { ArgvView } from "../components/execution/ArgvView";
import { EventStream } from "../components/execution/EventStream";
import { OutputPanel } from "../components/execution/OutputPanel";
import { Pipeline } from "../components/execution/Pipeline";
import { ProcessGraph } from "../components/execution/ProcessGraph";
import { RedirectionDiagram } from "../components/execution/RedirectionDiagram";
import { ReplayPanel } from "../components/execution/ReplayPanel";
import { ResultPanel } from "../components/execution/ResultPanel";
import { SignalDiagram } from "../components/execution/SignalDiagram";
import { Badge, Button, Card, EmptyState, LiveBadge, Spinner, StatusDot } from "../components/ui";
import { fmtDuration, shortId } from "../lib/format";
import { STATUS_META } from "../lib/stages";
import { useSession } from "../lib/useSession";
import { useUi } from "../store/ui";

export default function ExecutionPage() {
  const { id = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const replayMode = params.get("replay") === "1";
  const { session, events, loading, error, ended } = useSession(id, { live: !replayMode });
  const pushToast = useUi((s) => s.pushToast);

  const [visibleEvents, setVisibleEvents] = useState<null | typeof events>(null);
  const [terminating, setTerminating] = useState(false);

  const activeEvents = replayMode ? (visibleEvents ?? []) : events;
  const activeStatus = session?.status ?? "CREATED";

  useEffect(() => {
    if (!replayMode) setVisibleEvents(null);
  }, [replayMode]);

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

  const canTerminate = !ended && session.status === "RUNNING" || session.status === "STARTING";
  const redirsPresent = Boolean(session.redirections.in || session.redirections.out || session.redirections.append);
  const signalEvent = activeEvents.find((e) => e.type === "signal.received");
  const signalVal = (signalEvent?.payload?.signal as number | undefined) ?? session.signal;

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
            {replayMode ? <Badge tone="violet">REPLAY</Badge> : <LiveBadge live={!ended && session.status === "RUNNING"} />}
            <StatusDot tone={STATUS_META[activeStatus].tone} label={STATUS_META[activeStatus].label} />
          </span>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11.5px] text-[var(--fg-3)]">
          {session.pid ? <span className="font-mono">PID {session.pid}</span> : null}
          <span className="flex items-center gap-1"><Timer className="h-3 w-3" /> {fmtDuration(session.durationMs)}</span>
          <span className="font-mono">{events.length} events</span>
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
            />
          </div>
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
        <Card title="Process topology" subtitle="fork → exec → wait — one real child, one real PID" pad={false}>
          <div className="px-4 py-2">
            <ProcessGraph events={activeEvents} />
          </div>
        </Card>
        <Card title="Argument vector" subtitle={`argv[${session.argv.length}] with required NULL terminator`}>
          <ArgvView argv={session.argv} eventCount={activeEvents.length} />
        </Card>
      </div>

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
        actions={<span className="font-mono text-[10.5px] text-[var(--fg-3)]">source: caps events · gateway envelope</span>}
        pad={false}
      >
        <EventStream events={activeEvents} status={activeStatus} live={!replayMode && !ended} />
      </Card>
    </div>
  );
}

function PipelineLegendInline() {
  return <span className="hidden font-mono text-[10px] text-[var(--fg-3)] md:inline">INPUT → PARSE → ARGV → FORK → EXEC → RUN → WAIT → RESULT</span>;
}
