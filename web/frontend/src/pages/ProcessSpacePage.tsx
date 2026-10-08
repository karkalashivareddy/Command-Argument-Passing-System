import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { ArrowLeft, ClipboardList, ExternalLink, GitCompareArrows, LineChart } from "lucide-react";

import { Badge, Button, Card, EmptyState, LiveBadge, Spinner, StatusDot } from "../components/ui";
import { ProcessSpace, type SpaceMode } from "../components/space/ProcessSpace";
import { ReplayPanel as ReplayBridge } from "../components/execution/ReplayPanel";
import { fmtClock, fmtDuration, shortId } from "../lib/format";
import { collectSamples } from "../lib/telemetry";
import type { ProcessIdentity } from "../lib/evidenceCorrelation";
import { STATUS_META } from "../lib/stages";
import { useSession } from "../lib/useSession";
import { cursorForView, useInvestigation } from "../store/investigation";
import { useSpaceKeys } from "../components/space/useSpaceKeys";

/**
 * Process Space — the 3D view of one execution.
 *
 * It is a route of its own so the WebGL bundle is only fetched when a reader
 * asks for it, and so the 2D page keeps working when WebGL does not. The
 * execution header, the event stream, and the shared execution-time cursor are
 * exactly the ones the 2D observatory uses.
 *
 * The selection is not local state. Time, process and event selection live in
 * the shared investigation store, so navigating to the 2D observatory keeps the
 * same selection, and evidence selected in one view is highlighted in the other.
 */
export default function ProcessSpacePage() {
  const { id = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const replayMode = params.get("replay") === "1";
  const mode: SpaceMode = params.get("mode") === "timeline" ? "timeline" : "topology";
  const { session, events, loading, error, ended, connected } = useSession(id, { live: !replayMode });

  const [visibleEvents, setVisibleEvents] = useState<null | typeof events>(null);
  const [playing, setPlaying] = useState(true);
  const [clockNow, setClockNow] = useState(() => Date.now());

  // One selection model, shared with the 2D observatory.
  const openSession = useInvestigation((s) => s.openSession);
  const storeSessionId = useInvestigation((s) => s.sessionId);
  const cursorMs = useInvestigation((s) => s.cursorMs);
  const cursorPinned = useInvestigation((s) => s.cursorPinned);
  const cursorSource = useInvestigation((s) => s.cursorSource);
  const identity = useInvestigation((s) => s.identity);
  const eventSeq = useInvestigation((s) => s.eventSeq);
  const lens = useInvestigation((s) => s.lens);
  const selectProcess = useInvestigation((s) => s.selectProcess);
  const selectEvidence = useInvestigation((s) => s.selectEvidence);
  const moveCursor = useInvestigation((s) => s.moveCursor);
  const releaseCursor = useInvestigation((s) => s.releaseCursor);
  const setLens = useInvestigation((s) => s.setLens);
  const clearAll = useInvestigation((s) => s.clearAll);

  const activeEvents = replayMode ? (visibleEvents ?? []) : events;
  const activeStatus = session?.status ?? "CREATED";

  useEffect(() => {
    if (id) openSession(id);
  }, [id, openSession]);

  /** One global execution time. Live follows the newest evidence until sought. */
  const liveSamples = useMemo(() => collectSamples(events), [events]);
  const sampleTimes = useMemo(() => liveSamples.map((sample) => sample.atMs), [liveSamples]);
  /**
   * Live passes `null`, which the view-model reads as "the newest recorded
   * evidence". Pinning it to the last sample time instead would hide the
   * lifecycle events that came after that sample, and a finished execution
   * would still look like it was running.
   */
  const sharedCursorMs = cursorForView({ cursorMs, cursorPinned, cursorSource }, !replayMode);
  const cursorActive = replayMode || cursorPinned;

  useEffect(() => {
    if (!replayMode) setVisibleEvents(null);
  }, [replayMode]);

  useEffect(() => {
    if (!session || ended || replayMode) return;
    const timer = window.setInterval(() => setClockNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, [session?.id, ended, replayMode]);

  // Replay playback is controlled here, and the panel renders that state, so
  // Space toggles the same playback the on-screen button toggles.
  const onReplayCursor = useCallback(
    (ms: number) => {
      if (!id) return;
      moveCursor(id, ms, "replay");
    },
    [id, moveCursor],
  );

  // Space, arrows and Escape operate on the shared cursor for this view.
  useSpaceKeys({
    playing: replayMode && playing,
    onTogglePlay: () => setPlaying((value) => !value),
    cursorMs: sharedCursorMs,
    sampleTimes,
    onSeek: (ms) => {
      if (!id) return;
      moveCursor(id, ms, replayMode ? "replay" : "user");
    },
    onClear: () => {
      if (!id) return;
      releaseCursor(id);
    },
    live: !replayMode,
  });

  // The selection is resolved against the same events the scene is built from,
  // so a stale identity from another session can never resolve to a node here.
  const selection = useMemo(
    () => ({ sessionId: storeSessionId ?? id, cursorMs, identity, eventSeq }),
    [storeSessionId, id, cursorMs, identity, eventSeq],
  );

  const onSelectProcess = useCallback((next: ProcessIdentity | null) => {
    if (!id) return;
    selectProcess(id, next);
  }, [id, selectProcess]);

  const onSelectEvidence = useCallback(
    (sequence: number | null, nextIdentity: ProcessIdentity | null, atMs: number | null) => {
      if (!id) return;
      selectEvidence(id, sequence, nextIdentity, atMs);
    },
    [id, selectEvidence],
  );

  const onClearSelection = useCallback(() => {
    if (!id) return;
    clearAll(id);
  }, [id, clearAll]);

  if (error) {
    return (
      <div className="mx-auto max-w-6xl px-6 py-6">
        <EmptyState icon={<ArrowLeft className="h-5 w-5" />} title="Flight recorder unavailable" body={error} action={<Link to="/history"><Button size="sm" variant="outline">Back to history</Button></Link>} />
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

  const liveElapsedMs = session.durationMs ?? Math.max(0, clockNow - Date.parse(session.startedAt));
  const processStarted = activeEvents.find((event) => event.type === "process.started");

  return (
    <div className="mx-auto max-w-[110rem] space-y-6 px-6 py-6">
      {/* The same execution header as the 2D view: no context switching. */}
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <Link to="/history" className="flex items-center gap-1 rounded-r-md px-1 text-[11px] uppercase tracking-wide text-[var(--fg-3)] hover:text-[var(--fg-1)]">
            History
          </Link>
          <span className="text-[var(--fg-4)]">/</span>
          <Link to={`/execution/${session.id}`} className="flex items-center gap-1 rounded-r-md px-1 font-mono text-[11px] text-[var(--fg-3)] hover:text-[var(--fg-1)]" title="Back to the 2D observatory">
            {shortId(session.id)} <ArrowLeft className="h-3 w-3" /> 2D
          </Link>
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
          <span className="font-mono">PROCESS START EVENT · {processStarted ? fmtClock(processStarted.timestamp) : "UNAVAILABLE"}</span>
          <span className="font-mono">ELAPSED · {fmtDuration(session.durationMs ?? liveElapsedMs)}</span>
          <span className="font-mono">{activeEvents.length} events</span>
          <Button size="sm" variant="ghost" onClick={() => setParams(replayMode ? {} : { replay: "1", ...(mode === "timeline" ? { mode } : {}) })}>
            <ClipboardList className="h-3 w-3" /> {replayMode ? "Live view" : "Replay"}
          </Button>
          <Link to={`/arguments/${session.id}`}>
            <Button size="sm" variant="ghost">Argument inspector <ExternalLink className="h-3 w-3 text-[var(--fg-3)]" /></Button>
          </Link>
        </div>
      </div>

      {replayMode ? (
        <Card title="Flight recorder replay" subtitle="The 3D scene is reconstructed from persisted events only — no process is executed and no PIDs are inspected" pad={false}>
          <div className="px-4 py-3">
            <ReplayBridge
              events={events}
              status={session.status}
              onVisible={setVisibleEvents}
              onCursorMs={onReplayCursor}
              // The panel's own cursor echoes come back as "replay" sourced, so
              // they are not fed back in as a seek: only a cursor another
              // surface moved (a peak card, the 2D timeline) is followed here.
              seekMs={cursorSource === "replay" ? undefined : (cursorActive ? (cursorMs ?? undefined) : undefined)}
              playing={playing}
              onPlayingChange={setPlaying}
            />
            <p className="mt-2 font-mono text-[9.5px] text-[var(--fg-3)]">
              Space toggles playback. Arrow keys step between recorded samples; the cursor is the same one the 3D scene, inspector, and 2D
              observatory read.
            </p>
          </div>
        </Card>
      ) : null}

      <Card
        title="Process space (3D)"
        subtitle={
          mode === "topology"
            ? "Topology mode: looking down the time axis at process-tree depth and verified parent/child links"
            : "Timeline mode: execution time runs into the screen along the Z axis"
        }
        actions={<Badge tone="violet">3D SPACE</Badge>}
        pad={false}
      >
        <div className="px-4 py-4">
          <ProcessSpace
            events={activeEvents}
            session={session}
            cursorMs={sharedCursorMs}
            cursorActive={cursorActive}
            live={!replayMode}
            mode={mode}
            onModeChange={(next) =>
              // The mode is a camera choice, not a different dataset, so it must
              // not silently drop the reader out of replay.
              setParams({ ...(replayMode ? { replay: "1" } : {}), ...(next === "timeline" ? { mode: next } : {}) })
            }
            selection={selection}
            lens={lens}
            onLensChange={setLens}
            onSelectProcess={onSelectProcess}
            onSelectEvidence={onSelectEvidence}
            onClearSelection={onClearSelection}
          />
        </div>
      </Card>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Link to={`/execution/${session.id}`}>
          <Button size="sm" variant="outline" className="w-full justify-start">
            <LineChart className="h-3 w-3" /> View timeline
          </Button>
        </Link>
        <Link to={`/execution/${session.id}#flight-recorder`}>
          <Button size="sm" variant="outline" className="w-full justify-start">
            <ClipboardList className="h-3 w-3" /> View resource details
          </Button>
        </Link>
        <Link to="/compare">
          <Button size="sm" variant="outline" className="w-full justify-start">
            <GitCompareArrows className="h-3 w-3" /> Compare executions
          </Button>
        </Link>
      </div>

      <p className="text-[10.5px] leading-relaxed text-[var(--fg-3)]">
        The 3D scene is a visualization of evidence, not a source of evidence. Every position, size, colour and activity is a mapping of
        recorded process state and telemetry that the CAPS engine, the procfs collector, and the canonical event store produced, and each of those
        channels is a pure function of the record, so the same execution always draws the same geometry. The slow idle turn of a running node is
        presentation only: it encodes no quantity, never moves a node's position, and is switched off by <code className="font-mono">prefers-reduced-motion</code>.
        The browser never reads <code className="font-mono">/proc</code>, and the scene never polls the operating system.
      </p>
    </div>
  );
}
