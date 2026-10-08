/**
 * The faculty demo page: eight presets, one click each.
 *
 * WHY THIS PAGE IS A TABLE AND NOT A GRID OF CARDS
 * ------------------------------------------------
 * A faculty member comparing two presets is comparing four things per preset —
 * the argv, the events, what moves, and what stays unavailable — and doing that
 * across eight large cards means scrolling eight times and re-reading. Dense
 * rows put all four in one horizontal band and all eight in a single screen, so
 * the comparison is the visible act rather than something the reader assembles.
 *
 * WHY EVERY ROW SHOWS ITS UNAVAILABLE LIST
 * ----------------------------------------
 * Because a row that only lists what will move teaches the wrong lesson. The
 * most valuable thing this product reports is often an absence — a run shorter
 * than one sample interval records no procfs data at all, and the first sample
 * reports every rate as UNAVAILABLE — and a demo script that hid those absences
 * would leave a presenter pointing at an empty chart and calling it a bug. The
 * absence is the content; it belongs on the same row as the number.
 *
 * NOTHING HERE IS PRE-SEEDED
 * --------------------------
 * The page opens empty. There is no sample session, no placeholder "recent
 * preset", no chart with plausible values. What appears is what the eight
 * buttons actually executed, and a row with no run reads "not run" rather than
 * showing a zero.
 */

import { AlertTriangle, ArrowRight, Play, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

import { api, ApiError } from "../api/client";
import { useGlobalFeed } from "../api/sse";
import { catalogApi, type CommandSummary } from "../api/observability";
import { Badge, Button, Card, EmptyState, LiveBadge, StatusDot, type Tone } from "../components/ui";
import { ProvenanceBadge } from "../components/evidence/Provenance";
import {
  FACULTY_PRESETS,
  presetCommandLine,
  presetRequest,
  type FacultyPreset,
} from "../lib/facultyPresets";
import { STATUS_META } from "../lib/stages";
import { useExecution } from "../store/execution";
import { useUi } from "../store/ui";
import type { CanonicalEvent, SessionStatus } from "../types/observability";

/**
 * What actually happened to one preset's run, as read back from the gateway.
 *
 * `status` is null rather than a synthetic "PENDING" enum member on purpose: a
 * run whose status has not been read yet is not in any state, and inventing a
 * state for it would mean `STATUS_META` and `isTerminalStatus` had to know about
 * a value the gateway never sends.
 */
interface RunRecord {
  presetId: string;
  sessionId: string;
  commandLine: string;
  status: SessionStatus | null;
  exitCode: number | null;
  signal: number | null;
  durationMs: number | null;
  eventCount: number;
  /**
   * How many `process.snapshot` events the run actually recorded.
   *
   * Tracked separately from `eventCount` because it is the fact a presenter most
   * often needs and least often has: zero snapshots is a true and interesting
   * outcome for a sub-interval run, and it must be shown as "0" with that
   * explanation rather than as an absent row.
   */
  snapshotCount: number;
  stdout: string;
  stderr: string;
}

const TERMINAL: ReadonlySet<SessionStatus> = new Set(["COMPLETED", "FAILED", "TIMED_OUT", "CANCELLED"]);

export default function DemoPage() {
  const navigate = useNavigate();
  const begin = useExecution((s) => s.begin);
  const pushToast = useUi((s) => s.pushToast);
  const engineState = useUi((s) => s.engineState);
  const { events: feed, connected } = useGlobalFeed(200);

  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  /*
   * Availability comes from the gateway's own probe of the real filesystem.
   *
   * A client-side list of "commands that work here" would be a second source of
   * truth, and the two would disagree the first time a binary moved or a kernel
   * lost a sensor. `false` and `status_probe` in particular are not guaranteed:
   * the former is coreutils, the latter is a repository helper that exists only
   * after `make`, and neither fact can be known from a browser.
   */
  const [catalog, setCatalog] = useState<Map<string, CommandSummary> | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);

  const refreshCatalog = useCallback(() => {
    void catalogApi
      .catalog()
      .then((res) => {
        setCatalog(new Map(res.commands.map((c) => [c.name, c])));
        setCatalogError(null);
      })
      .catch((err: unknown) => {
        setCatalogError(err instanceof ApiError ? err.message : err instanceof Error ? err.message : String(err));
      });
  }, []);

  useEffect(refreshCatalog, [refreshCatalog]);

  const runOne = useCallback(
    async (preset: FacultyPreset) => {
      if (busy !== null) return;
      setBusy(preset.id);
      setError(null);
      const res = await begin(presetRequest(preset));
      setBusy(null);
      if (!res.ok) {
        setError(`${preset.label}: ${res.message}`);
        pushToast(`${preset.label} was refused by the gateway.`, "error");
        return;
      }
      const rec = await api.getSession(res.sessionId).catch(() => null);
      setRuns((prev) => [
        ...prev.filter((r) => r.presetId !== preset.id),
        {
          presetId: preset.id,
          sessionId: res.sessionId,
          commandLine: presetCommandLine(preset),
          status: rec?.status ?? null,
          exitCode: rec?.exitCode ?? null,
          signal: rec?.signal ?? null,
          durationMs: rec?.durationMs ?? null,
          eventCount: rec?.eventCount ?? 0,
          snapshotCount: 0,
          stdout: rec?.stdout ?? "",
          stderr: rec?.stderr ?? "",
        },
      ]);
    },
    [begin, busy, pushToast],
  );

  /*
   * Run all eight, one at a time.
   *
   * Sequential on purpose. `POST /api/sessions` enforces a concurrency ceiling
   * (`capabilities.limits.maxConcurrent`) and refuses rather than queues, so
   * firing eight at once would produce a burst of 429s and a page showing seven
   * refusals — which is not a demonstration of anything. Sequential also means
   * each row's telemetry is the only load on the host while it is sampled.
   */
  const [runningAll, setRunningAll] = useState(false);
  const runAll = useCallback(async () => {
    if (runningAll || busy !== null) return;
    setRunningAll(true);
    for (const preset of FACULTY_PRESETS) {
      setBusy(preset.id);
      const res = await begin(presetRequest(preset));
      if (!res.ok) {
        setError(`${preset.label}: ${res.message}`);
        continue;
      }
      const rec = await api.getSession(res.sessionId).catch(() => null);
      setRuns((prev) => [
        ...prev.filter((r) => r.presetId !== preset.id),
        {
          presetId: preset.id,
          sessionId: res.sessionId,
          commandLine: presetCommandLine(preset),
          status: rec?.status ?? null,
          exitCode: rec?.exitCode ?? null,
          signal: rec?.signal ?? null,
          durationMs: rec?.durationMs ?? null,
          eventCount: rec?.eventCount ?? 0,
          snapshotCount: 0,
          stdout: rec?.stdout ?? "",
          stderr: rec?.stderr ?? "",
        },
      ]);
    }
    setBusy(null);
    setRunningAll(false);
  }, [begin, busy, runningAll]);

  /*
   * Read each run back until it finalises.
   *
   * The replay is what turns `eventCount` into a real snapshot count: the session
   * row says how many events exist but not how many of them were procfs samples,
   * and that number is the one this page most needs to state honestly.
   */
  const pollingRef = useRef<number | null>(null);
  useEffect(() => {
    if (!connected) return;
    // A null status is "not read yet", which is also not terminal, so it stays in
    // the poll set. `isTerminal` is written as a null check for that reason.
    const pending = runs.filter((r) => r.status === null || !TERMINAL.has(r.status));
    if (pending.length === 0) return;
    if (pollingRef.current !== null) return;

    pollingRef.current = window.setInterval(() => {
      void (async () => {
        for (const run of pending) {
          const rec = await api.getSession(run.sessionId).catch(() => null);
          const stillRunning = rec !== null && !TERMINAL.has(rec.status);
          const replay = stillRunning ? null : await api.replay(run.sessionId).catch(() => null);
          const snapshots =
            replay?.events.filter((e: CanonicalEvent) => e.type === "process.snapshot").length ??
            feed.filter((e) => e.sessionId === run.sessionId && e.type === "process.snapshot").length;
          setRuns((prev) =>
            prev.map((p) =>
              p.sessionId !== run.sessionId
                ? p
                : {
                    ...p,
                    status: rec?.status ?? p.status,
                    exitCode: rec?.exitCode ?? p.exitCode,
                    signal: rec?.signal ?? p.signal,
                    durationMs: rec?.durationMs ?? p.durationMs,
                    eventCount: rec?.eventCount ?? replay?.events.length ?? p.eventCount,
                    snapshotCount: snapshots,
                    stdout: rec?.stdout ?? p.stdout,
                    stderr: rec?.stderr ?? p.stderr,
                  },
            ),
          );
        }
      })();
    }, 1200);

    return () => {
      if (pollingRef.current !== null) {
        window.clearInterval(pollingRef.current);
        pollingRef.current = null;
      }
    };
  }, [connected, runs, feed]);

  const runFor = (presetId: string): RunRecord | undefined => runs.find((r) => r.presetId === presetId);
  const finished = runs.filter((r) => r.status !== null && TERMINAL.has(r.status)).length;
  /*
   * Status tone, from the shared map, with the unread case given its own tone.
   *
   * A run whose status has not been read yet gets `neutral` rather than a
   * fabricated RUNNING: "active" would pulse and imply a process is alive, which
   * on a row whose session may already have finished is a claim about a process
   * nobody has checked.
   */
  const toneFor = (status: SessionStatus | null): Tone =>
    status === null ? "neutral" : (STATUS_META[status]?.tone ?? "neutral");

  return (
    <div className="mx-auto max-w-6xl space-y-5 px-6 py-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-[var(--fg-3)]">Demo</div>
          <h1 className="mt-1 text-xl font-semibold tracking-tight text-[var(--fg-0)]">Faculty demo presets</h1>
          <p className="mt-1 max-w-3xl text-[13px] text-[var(--fg-2)]">
            Eight bounded, allowlisted runs, each one click. Every row states the exact argv CAPS will exec, the events it
            should produce, which metrics move, and which stay UNAVAILABLE and why. Nothing on this page is pre-recorded:
            a row is empty until you run it.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <LiveBadge live={connected} />
          <Button
            variant="primary"
            onClick={() => void runAll()}
            disabled={engineState !== "online" || runningAll || busy !== null}
            title="Runs all eight in order, one at a time, so the concurrency ceiling is never hit"
          >
            <Play className="h-4 w-4" /> {runningAll ? "Running…" : "Run all eight"}
          </Button>
        </div>
      </div>

      {/*
        Availability and engine state, both read from the gateway.

        A refused preset is reported here rather than discovered when a click
        fails: a demo script that hides which rows cannot run on this host is
        worse than one that says so before the talk starts.
      */}
      <div className="flex flex-wrap items-center gap-2 border-y border-[var(--line-0)] py-2">
        <Badge tone={engineState === "online" ? "success" : engineState === "degraded" ? "warn" : "danger"}>
          engine {engineState}
        </Badge>
        {catalogError !== null ? (
          <span className="flex items-center gap-1.5 text-[11.5px] text-[var(--warn)]">
            <AlertTriangle className="h-3.5 w-3.5" />
            The command catalog could not be read ({catalogError}). Preset availability is unknown and every RUN button is
            disabled rather than guessed.
          </span>
        ) : catalog === null ? (
          <span className="text-[11.5px] text-[var(--fg-3)]">Probing the command catalog on the real filesystem…</span>
        ) : (
          FACULTY_PRESETS.map((preset) => {
            const entry = catalog.get(preset.command);
            const ok = entry !== undefined && entry.availability === "AVAILABLE";
            /*
              `Badge` renders a bare span with no title prop, and adding one for a
              single call site would put a `title` on one badge and not the other
              forty. The gateway's own reason string — which names the trusted
              directory searched, the resolved path, and every symbolic link
              traversed — is worth carrying verbatim, so it goes on a wrapping span
              where it is available to hover and to assistive tech as a tooltip.
            */
            return (
              <span key={preset.id} title={entry?.reason ?? "not declared in the catalog"}>
                <Badge tone={ok ? "neutral" : "warn"}>
                  {preset.label}
                  {entry === undefined ? " · unprobed" : ok ? " · available" : " · unavailable"}
                </Badge>
              </span>
            );
          })
        )}
        <Button size="sm" variant="ghost" className="ml-auto" onClick={refreshCatalog} title="Re-probe the real filesystem">
          <RotateCcw className="h-3.5 w-3.5" /> Re-probe
        </Button>
      </div>

      {error !== null ? (
        <p role="alert" className="flex items-start gap-1.5 rounded-[var(--r-sm)] border border-[var(--red)]/40 bg-[var(--red-soft)] px-3 py-2 text-[12px] text-[var(--red)]">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {error}
        </p>
      ) : null}

      {/*
        The presets, as dense rows.

        A table rather than a div-grid because the four facts per row are
        genuinely tabular — they line up across rows, and `scope` on the headers
        keeps that true for a screen reader as well as for the eye. The table
        scrolls horizontally on a narrow viewport rather than compressing, because
        the `why` column holds sentences and a squeezed column hides exactly the
        caveat this page exists to surface.
      */}
      <Card
        title="Presets"
        subtitle="Every command below is on the engine allowlist and every argument is inside its catalog bounds"
        pad={false}
        actions={<span className="font-mono text-[10.5px] text-[var(--fg-3)]">{finished} / {FACULTY_PRESETS.length} finished</span>}
      >
        <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Faculty demo presets">
          <table className="w-full min-w-[64rem] border-collapse text-left text-[12px]">
            <caption className="sr-only">
              Eight faculty demo presets: the exact command, the events it should produce, the metrics that should move,
              and the metrics that may stay unavailable
            </caption>
            <thead>
              <tr className="border-b border-[var(--line-0)]">
                <th scope="col" className="px-3 py-2 font-mono text-[9.5px] font-semibold uppercase tracking-[var(--tracking-micro)] text-[var(--fg-3)]">
                  Preset
                </th>
                <th scope="col" className="px-3 py-2 font-mono text-[9.5px] font-semibold uppercase tracking-[var(--tracking-micro)] text-[var(--fg-3)]">
                  Executes (real argv)
                </th>
                <th scope="col" className="px-3 py-2 font-mono text-[9.5px] font-semibold uppercase tracking-[var(--tracking-micro)] text-[var(--fg-3)]">
                  Observes
                </th>
                <th scope="col" className="px-3 py-2 font-mono text-[9.5px] font-semibold uppercase tracking-[var(--tracking-micro)] text-[var(--fg-3)]">
                  Should move
                </th>
                <th scope="col" className="px-3 py-2 font-mono text-[9.5px] font-semibold uppercase tracking-[var(--tracking-micro)] text-[var(--fg-3)]">
                  May be UNAVAILABLE
                </th>
                <th scope="col" className="px-3 py-2 font-mono text-[9.5px] font-semibold uppercase tracking-[var(--tracking-micro)] text-[var(--fg-3)]">
                  Run
                </th>
              </tr>
            </thead>
            <tbody>
              {FACULTY_PRESETS.map((preset) => {
                const entry = catalog?.get(preset.command);
                /*
                  Three states, not two.

                  `availability === null` means the catalog has not answered yet or
                  could not be reached, which is NOT the same as "unavailable" — but
                  it blocks the run just the same, because sending a request whose
                  outcome is unknown in order to find out is how a demo page ends up
                  with a row of gateway refusals instead of a demonstration. The row
                  says which of the two it is.
                */
                const unprobed = catalog === null;
                const unavailable = entry !== undefined && entry.availability !== "AVAILABLE";
                const reason = entry === undefined ? null : entry.reason;
                const blocked = busy !== null || runningAll || engineState !== "online" || unprobed || unavailable;
                const run = runFor(preset.id);
                const tone = toneFor(run?.status ?? null);

                return (
                  <tr key={preset.id} className="border-b border-[var(--line-0)] align-top last:border-0">
                    <th scope="row" className="px-3 py-2.5">
                      <div className="font-mono text-[12.5px] font-semibold text-[var(--fg-0)]">{preset.label}</div>
                      <p className="mt-0.5 max-w-[16rem] text-[11px] leading-snug text-[var(--fg-3)]">{preset.blurb}</p>
                      <p className="mt-1 font-mono text-[9.5px] leading-snug text-[var(--fg-4)]">
                        {preset.bounded}
                      </p>
                      <p className="mt-0.5 font-mono text-[9.5px] leading-snug text-[var(--fg-3)]">outcome · {preset.outcome}</p>
                    </th>

                    <td className="px-3 py-2.5">
                      <code className="block font-mono text-[11.5px] text-[var(--accent)]">{presetCommandLine(preset)}</code>
                      <span className="mt-1 block font-mono text-[9.5px] text-[var(--fg-4)]">
                        {preset.timeoutMs === undefined ? "timeout · gateway default" : `timeout · ${preset.timeoutMs} ms`}
                      </span>
                      {entry !== undefined ? (
                        <span className="mt-1 block font-mono text-[9.5px] leading-snug text-[var(--fg-4)]" title={entry.reason}>
                          {entry.resolvedPath ?? entry.reason}
                        </span>
                      ) : null}
                      {unavailable ? (
                        <span className="mt-1 block text-[10px] leading-snug text-[var(--warn)]">
                          Not available here: {reason}. A repository helper such as <code className="font-mono">status_probe</code>{" "}
                          exists only after <code className="font-mono">make</code> has built it.
                        </span>
                      ) : null}
                      {unprobed ? (
                        <span className="mt-1 block text-[10px] leading-snug text-[var(--fg-3)]">
                          Availability unknown: the catalog has not been read, so this row will not run rather than guess.
                        </span>
                      ) : null}
                    </td>

                    <td className="px-3 py-2.5">
                      <ul className="space-y-0.5">
                        {preset.observes.map((e) => (
                          <li key={e} className="font-mono text-[10.5px] text-[var(--fg-2)]">
                            {e}
                          </li>
                        ))}
                      </ul>
                    </td>

                    <td className="px-3 py-2.5">
                      <ul className="space-y-0.5">
                        {preset.moves.map((m) => (
                          <li key={m.metric} className="text-[11px] leading-snug text-[var(--fg-1)]">
                            <span className="font-mono text-[var(--fg-2)]">{m.metric}</span> — {m.direction}
                          </li>
                        ))}
                      </ul>
                    </td>

                    <td className="px-3 py-2.5">
                      <ul className="space-y-1">
                        {preset.unavailable.map((u) => (
                          <li key={u.metric} className="text-[11px] leading-snug">
                            <ProvenanceBadge provenance="UNAVAILABLE" reason={u.why} />
                            <span className="mt-0.5 block font-mono text-[10px] text-[var(--fg-2)]">{u.metric}</span>
                            <span className="block text-[10.5px] text-[var(--fg-4)]">{u.why}</span>
                          </li>
                        ))}
                      </ul>
                    </td>

                    <td className="px-3 py-2.5">
                      <div className="flex flex-col items-start gap-1.5">
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={blocked}
                          onClick={() => void runOne(preset)}
                          title={
                            unavailable
                              ? `Unavailable on this host: ${reason}`
                              : unprobed
                                ? "Availability has not been probed yet."
                                : `Run ${presetCommandLine(preset)} for real`
                          }
                        >
                          <Play className="h-3 w-3" /> {busy === preset.id ? "Running…" : "RUN"}
                        </Button>
                        {run === undefined ? (
                          <span className="font-mono text-[10px] text-[var(--fg-4)]">not run</span>
                        ) : (
                          <>
                            {/*
                              The status label falls back to "reading" rather than
                              to a status name. `STATUS_META[null]` does not exist
                              and rendering the raw null would put the word "null"
                              in a spot where the audience will read it as a status.
                            */}
                            <StatusDot tone={tone} label={run.status === null ? "reading" : STATUS_META[run.status]?.label ?? run.status} />
                            {run.status !== null && TERMINAL.has(run.status) ? (
                              <>
                                <span className="font-mono text-[10px] text-[var(--fg-3)]">
                                  exit {run.exitCode === null ? "—" : run.exitCode}
                                  {run.signal !== null && run.signal > 0 ? ` · signal ${run.signal}` : ""}
                                </span>
                                <span className="font-mono text-[10px] text-[var(--fg-3)]">
                                  {run.eventCount} events
                                </span>
                                {/*
                                  The snapshot count is rendered even at zero, and
                                  with a reason when it is zero. "no procfs sample
                                  was recorded" is the single most instructive
                                  outcome on this page for the HELLO, FAILURE and
                                  sub-interval rows, and an empty cell would read
                                  as a loading state instead.
                                */}
                                <span
                                  className={`font-mono text-[10px] ${run.snapshotCount === 0 ? "text-[var(--warn)]" : "text-[var(--fg-3)]"}`}
                                  title={
                                    run.snapshotCount === 0
                                      ? "The process finished inside one 500ms sample interval, so no procfs sample was recorded. That is a true reading of the run."
                                      : "process.snapshot events recorded for this run"
                                  }
                                >
                                  {run.snapshotCount} snapshots
                                </span>
                              </>
                            ) : (
                              <span className="font-mono text-[10px] text-[var(--fg-4)]">reading final status…</span>
                            )}
                            <Button size="sm" variant="ghost" onClick={() => navigate(`/execution/${run.sessionId}`)}>
                              Open recorder <ArrowRight className="h-3 w-3" />
                            </Button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      <Card title="Live trace" subtitle="The global SSE feed while the presets run — real frames, no replay">
        {feed.length === 0 ? (
          <EmptyState title="No events yet" body="Run a preset and every canonical event it produces streams here as the gateway writes it." />
        ) : (
          <ul className="max-h-56 space-y-0.5 overflow-y-auto font-mono text-[11px]">
            {feed.slice(-24).map((ev) => (
              <li key={ev.id} className="flex items-center gap-2 text-[var(--fg-2)]">
                <span className="w-8 shrink-0 tabular-nums text-[var(--fg-3)]">#{ev.sequence}</span>
                <span className="font-semibold text-[var(--fg-1)]">{ev.type}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-2 text-[10.5px] text-[var(--fg-3)]">
          {finished} of {FACULTY_PRESETS.length} presets finished. Every run is persisted and replayable from History; nothing
          on this page is simulated or restored from a fixture.
        </p>
      </Card>
    </div>
  );
}
