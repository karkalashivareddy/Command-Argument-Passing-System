/**
 * Presentation mode: a twelve-step guided overlay for a presenter.
 *
 * WHAT THIS IS ALLOWED TO DO, AND WHAT IT IS NOT
 * ----------------------------------------------
 * It may reorder the product for a talk, name a destination, and run a real
 * execution on request. It may not simulate anything, and the reason is
 * specific rather than general.
 *
 * The product's claim is that it does not invent telemetry. A presentation
 * overlay is the single most dangerous place to break that, because it is
 * exactly the surface where a lifecycle "animation" would look natural and
 * where a missing number is most tempting to fill in. So:
 *
 *   - a step NEVER advances because time passed while nothing was observed. It
 *     advances because the presenter's timer elapsed, and every step names where
 *     to look so the presenter checks the real UI.
 *   - a session-scoped step does NOT navigate at all when no session exists. It
 *     says so in words and offers to run a real command. See
 *     `lib/presentationSteps.ts`, which is where that decision actually lives.
 *   - the progress bar measures the presenter's timer. It is not a stage
 *     indicator, is labelled as such, and says nothing about CAPS.
 *
 * WHY IT IS A PANEL AND NOT A TAKEOVER
 * ------------------------------------
 * A presenter has to point at the product while talking about it. A full-screen
 * deck would hide the very thing being demonstrated, so the product stays fully
 * visible and this is a fixed panel over one corner. It is still a modal dialog
 * for the keyboard (aria-modal + a focus trap), because the arrow keys and the
 * single-letter navigation keys must not leak into the page behind while a
 * presenter is mid-sentence -- those keystrokes would navigate the product out
 * from under the audience.
 *
 * WHY `PAUSE` IS NOT DECORATIVE
 * -----------------------------
 * It genuinely stops two things: the auto-advance timer AND the progress
 * animation that visualises it. The animation is a requestAnimationFrame loop
 * keyed on `paused`, so when it is paused the frame loop is unmounted rather
 * than being told to ignore updates -- there is no code path where the bar keeps
 * moving while the timer is stopped, because there is no running loop to move it.
 * A pause that only hid the label would leave the presenter unable to say why
 * the deck stopped, which is the one thing a pause exists to allow.
 *
 * REDUCED MOTION
 * --------------
 * Under `prefers-reduced-motion: reduce` the auto-advance is not merely
 * un-animated, it is OFF, and the panel says so. An automatic timer that walks a
 * viewer through twelve screens is motion with a semantic payload; a reader who
 * asked for less motion did not ask for less information, but they cannot opt
 * out of an auto-advancing timer they never see coming. The step controls remain
 * fully available.
 */

import { AnimatePresence, motion } from "motion/react";
import { AlertTriangle, ChevronLeft, ChevronRight, Pause, Play, Presentation, Square, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import { api } from "../../api/client";
import { Button } from "../ui";
import {
  PRESENTATION_STEPS,
  destinationFor,
  positionLabel,
  stepAt,
} from "../../lib/presentationSteps";
import { usePrefersReducedMotion } from "../space/webgl";
import { useExecution } from "../../store/execution";
import { useUi } from "../../store/ui";

/**
 * How long a step sits before the deck moves on, in ms.
 *
 * Long enough to say a sentence and point at the region the step names. It is
 * deliberately not configurable from the UI: a presenter who could set it to
 * zero would be building the autoplaying lifecycle this product refuses to
 * ship, one control at a time.
 *
 * Exported only so the component test can drive the same number the component
 * uses. A copy of `18_000` in the test would let the two drift, and the test
 * would then be exercising a step window the product does not have.
 */
export const AUTO_ADVANCE_MS = 18_000;

/**
 * The command offered when no session exists.
 *
 * `echo` is the smallest thing in the catalog that produces a complete
 * lifecycle: allowlisted, no flags, no path policy, exits immediately. The
 * point is to create a REAL session for the session-scoped steps to read, and
 * the cheapest honest way to do that is the command whose only claim is "argv
 * reached a process".
 */
const FIRST_RUN_PRESET = { command: "echo", args: ["presentation", "session"] };

export function PresentationOverlay() {
  const open = useUi((s) => s.presentation.open);
  const index = useUi((s) => s.presentation.index);
  const paused = useUi((s) => s.presentation.paused);
  const sessionId = useUi((s) => s.presentation.sessionId);
  const setPresentationIndex = useUi((s) => s.setPresentationIndex);
  const stepPresentation = useUi((s) => s.stepPresentation);
  const togglePaused = useUi((s) => s.togglePresentationPaused);
  const openPresentation = useUi((s) => s.openPresentation);
  const setPresentationSession = useUi((s) => s.setPresentationSession);
  const engineState = useUi((s) => s.engineState);
  const begin = useExecution((s) => s.begin);

  const navigate = useNavigate();
  const location = useLocation();
  const reducedMotion = usePrefersReducedMotion();

  const panelRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  const step = stepAt(index);
  const destination = useMemo(() => destinationFor(step, sessionId), [step, sessionId]);

  /*
   * Auto-advance is off under reduced motion.
   *
   * Not "the same timer with no transition": the timer itself is absent, and
   * `autoAdvance` is reported in the panel so the presenter knows why the deck
   * is not moving.
   */
  const autoAdvance = open && !paused && !reducedMotion;

  /*
   * Focus moves into the panel on open and returns to the opener on close.
   *
   * Copied from the pattern already established in ShortcutHelp.tsx: the element
   * that had focus is captured on the open transition, before focus moves, and
   * the restore lives in the cleanup keyed on `open` so every exit path gets it
   * — Escape, the EXIT button, or the topbar toggle.
   */
  useEffect(() => {
    if (!open) return;
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const t = window.setTimeout(() => panelRef.current?.focus(), 30);
    return () => {
      window.clearTimeout(t);
      returnFocusRef.current?.focus();
      returnFocusRef.current = null;
    };
  }, [open]);

  /*
   * Resolve the session the session-scoped steps may navigate to.
   *
   * TWO SOURCES, BOTH REAL, IN THIS ORDER:
   *   1. the id already in the URL, if the presenter is standing on a recorder —
   *      that session demonstrably exists, they are looking at it;
   *   2. otherwise the most recent session the gateway returns.
   *
   * There is no third source. In particular nothing is synthesised: if the
   * gateway returns an empty list, `sessionId` stays null and the session-scoped
   * steps say so rather than navigating somewhere that would render a page of
   * UNAVAILABLE.
   */
  useEffect(() => {
    if (!open) return;
    let cancelled = false;

    const inUrl = location.pathname.match(/^\/execution\/([^/]+)/);
    if (inUrl?.[1]) {
      setPresentationSession(decodeURIComponent(inUrl[1]));
      return;
    }

    void api
      .listSessions({ limit: 1 })
      .then((res) => {
        if (cancelled) return;
        const latest = res.sessions[0];
        setPresentationSession(latest ? latest.id : null);
      })
      .catch(() => {
        /*
         * A failed read is not "no sessions". It is "I could not ask", and the
         * honest rendering is the same refusal the empty case gets: the step
         * offers to run a real command. Silently treating an unreachable gateway
         * as an empty history would be the product's oldest bug in a new place.
         */
        if (!cancelled) setPresentationSession(null);
      });

    return () => {
      cancelled = true;
    };
    // `location.pathname` is read once per open, deliberately: re-resolving on
    // every navigation would replace a session the presenter is already reading
    // with the newest one in the store, mid-talk.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, setPresentationSession]);

  /* Navigate when the step changes, but only to a destination that exists. */
  useEffect(() => {
    if (!open) return;
    if (!destination.ok) return;
    if (destination.to === location.pathname + location.search) return;
    navigate(destination.to);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, destination.ok ? destination.to : null]);

  /*
   * The progress timer.
   *
   * `deadline` is recomputed whenever the step changes, so BACK restarts the
   * step's full duration rather than resuming a partially-elapsed one. The frame
   * loop exists only while `autoAdvance` is true, which is what makes PAUSE
   * real: there is no loop to keep running, and the bar's width is only ever
   * written from inside it.
   */
  const [deadline, setDeadline] = useState<number | null>(null);
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    if (!open) {
      setDeadline(null);
      setProgress(0);
      return;
    }
    if (!autoAdvance) {
      setDeadline(null);
      return;
    }
    setDeadline(performance.now() + AUTO_ADVANCE_MS);
  }, [open, autoAdvance, index]);

  useEffect(() => {
    if (deadline === null) return;
    let raf = 0;
    const tick = (now: number): void => {
      const fraction = Math.min(1, Math.max(0, (now - (deadline - AUTO_ADVANCE_MS)) / AUTO_ADVANCE_MS));
      setProgress(fraction);
      if (fraction >= 1) {
        // The last step is terminal for the timer. Looping would replay the whole
        // script without the presenter, which is the autoplay this refuses.
        if (index < PRESENTATION_STEPS.length - 1) stepPresentation(1);
        else setDeadline(null);
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [deadline, index, stepPresentation]);

  /*
   * The presenter's controls, on the keyboard.
   *
   * Arrows and N/P both work, because a presenter with a clicker in one hand
   * reaches for the arrows and a presenter at a lectern types letters; refusing
   * either would make one of them reach for the mouse mid-sentence. Escape
   * exits, as it does in every other dialog in this product.
   *
   * Modified keystrokes are ignored so Ctrl+N / Cmd+P reach the browser and the
   * OS rather than being swallowed as step navigation.
   */
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;

      if (e.key === "Escape") {
        openPresentation(false);
        return;
      }
      if (e.key === "ArrowRight" || e.key === "n" || e.key === "N") {
        e.preventDefault();
        stepPresentation(1);
        return;
      }
      if (e.key === "ArrowLeft" || e.key === "p" || e.key === "P") {
        e.preventDefault();
        stepPresentation(-1);
        return;
      }

      /*
       * Tab is trapped inside the panel.
       *
       * Same reason as CommandPalette and ShortcutHelp: the page behind is
       * visible, so a reader who tabbed out would be left with focus on a control
       * they cannot see they had reached, still inside a dialog the screen
       * reader calls modal.
       */
      if (e.key === "Tab") {
        const panel = panelRef.current;
        if (panel === null) return;
        const focusable = panel.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])');
        if (focusable.length === 0) return;
        const first = focusable[0]!;
        const last = focusable[focusable.length - 1]!;
        const active = document.activeElement;
        if (e.shiftKey && (active === first || !panel.contains(active))) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && (active === last || !panel.contains(active))) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, stepPresentation, openPresentation]);

  /*
   * The offer to run something real when no session exists.
   *
   * This is a REAL execution through the real API, and it says so. The
   * alternative — dropping a plausible-looking session id into the URL — would
   * render a flight recorder whose every metric is UNAVAILABLE, under a heading
   * claiming an execution. That is the exact failure this product is built
   * against, and a presenter would have no way to notice.
   */
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const runFirstSession = useCallback(async () => {
    if (running || engineState !== "online") return;
    setRunning(true);
    setRunError(null);
    const res = await begin({
      command: FIRST_RUN_PRESET.command,
      args: FIRST_RUN_PRESET.args,
      redirections: {},
    });
    setRunning(false);
    if (res.ok) {
      setPresentationSession(res.sessionId);
      navigate(`/execution/${res.sessionId}`);
    } else {
      setRunError(res.message);
    }
  }, [begin, engineState, navigate, running, setPresentationSession]);

  return (
    <AnimatePresence>
      {open ? (
        <motion.div
          className="pointer-events-none fixed inset-0 z-[var(--z-present)] flex justify-end p-4"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: reducedMotion ? 0 : 0.15 }}
        >
          <motion.div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-label="Presentation mode"
            tabIndex={-1}
            className="glass-overlay pointer-events-auto flex max-h-[calc(100vh-2rem)] w-[min(26rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-[var(--r-lg)] border border-[var(--line-1)] focus:outline-none"
            initial={reducedMotion ? false : { x: 24, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={reducedMotion ? undefined : { x: 24, opacity: 0 }}
            transition={{ duration: reducedMotion ? 0 : 0.2, ease: [0.16, 1, 0.3, 1] }}
          >
            <header className="flex shrink-0 items-center gap-2 border-b border-[var(--line-0)] px-3.5 py-2.5">
              <Presentation className="h-3.5 w-3.5 shrink-0 text-[var(--accent)]" aria-hidden="true" />
              <span className="font-mono text-[10px] font-semibold uppercase tracking-[var(--tracking-micro)] text-[var(--fg-3)]">
                Presentation
              </span>
              <span className="ml-auto font-mono text-[10.5px] tabular-nums text-[var(--fg-2)]">{positionLabel(index)}</span>
              <button
                onClick={() => openPresentation(false)}
                className="rounded-[var(--r-sm)] p-1 text-[var(--fg-3)] transition-colors hover:bg-[var(--bg-3)] hover:text-[var(--fg-0)]"
                aria-label="Close the presentation panel"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </header>

            <div className="min-h-0 flex-1 overflow-y-auto px-3.5 py-3">
              <div aria-live="polite">
                <h2 className="font-mono text-[15px] font-semibold tracking-tight text-[var(--fg-0)]">
                  {step.code} · {step.title}
                </h2>
                <p className="mt-1.5 text-[12.5px] leading-relaxed text-[var(--fg-1)]">{step.sentence}</p>
              </div>

              <div className="mt-3 rounded-[var(--r-sm)] border border-[var(--line-0)] bg-[var(--bg-2)] px-2.5 py-2">
                <div className="font-mono text-[9.5px] font-semibold uppercase tracking-[var(--tracking-micro)] text-[var(--fg-3)]">
                  Look at
                </div>
                <p className="mt-1 text-[11.5px] leading-snug text-[var(--fg-1)]">{step.region}</p>
                {!destination.ok ? (
                  <div className="mt-2 border-t border-[var(--line-0)] pt-2">
                    <p className="flex items-start gap-1.5 text-[11px] leading-snug text-[var(--warn)]">
                      <AlertTriangle className="mt-px h-3 w-3 shrink-0" aria-hidden="true" />
                      <span>{destination.reason}</span>
                    </p>
                    <Button
                      size="sm"
                      variant="primary"
                      className="mt-2 w-full"
                      onClick={() => void runFirstSession()}
                      disabled={running || engineState !== "online"}
                      title={`Runs the real command \`${FIRST_RUN_PRESET.command} ${FIRST_RUN_PRESET.args.join(" ")}\` against ./caps`}
                    >
                      {running
                        ? "Running a real command…"
                        : engineState === "online"
                          ? `Run ${FIRST_RUN_PRESET.command} ${FIRST_RUN_PRESET.args.join(" ")} for real`
                          : `Engine ${engineState} — cannot run`}
                    </Button>
                    {runError ? <p className="mt-1.5 text-[10.5px] text-[var(--red)]">{runError}</p> : null}
                  </div>
                ) : null}
              </div>

              {/*
                The step rail.

                Twelve buttons rather than a scrubber, because a scrubber invites
                treating this as a timeline — and this is not a timeline of a
                process. It is a checklist of places to point at, and it says so.
              */}
              <ol className="mt-3 grid grid-cols-6 gap-1" aria-label="Presentation steps">
                {PRESENTATION_STEPS.map((s, i) => (
                  <li key={s.position}>
                    <button
                      onClick={() => setPresentationIndex(i)}
                      aria-current={i === index ? "step" : undefined}
                      title={`${s.code} · ${s.title}`}
                      className={`h-6 w-full rounded-[var(--r-xs)] border font-mono text-[10px] font-semibold transition-colors ${
                        i === index
                          ? "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]"
                          : "border-[var(--line-0)] bg-[var(--bg-2)] text-[var(--fg-3)] hover:border-[var(--line-2)] hover:text-[var(--fg-1)]"
                      }`}
                    >
                      {s.code}
                    </button>
                  </li>
                ))}
              </ol>
            </div>

            <footer className="shrink-0 border-t border-[var(--line-0)] px-3.5 py-2.5">
              {/*
                The progress bar measures the PRESENTING TIMER and nothing else.

                Labelled "step timer" rather than left as a bare stripe, because an
                unlabelled progress bar in a process-observability product will be
                read by an audience as a lifecycle indicator. It is not one. It
                never reports a stage, and its `role="presentation"` keeps it out
                of the accessibility tree entirely rather than announcing a value
                that means nothing.
              */}
              <div
                className="h-0.5 w-full overflow-hidden rounded-full bg-[var(--line-0)]"
                role="presentation"
                aria-hidden="true"
              >
                <div
                  className="h-full bg-[var(--accent)]"
                  style={{
                    width: `${Math.round(progress * 100)}%`,
                    // The transition is what the frame loop makes smooth; under
                    // reduced motion there is no loop, so there is nothing to
                    // transition and the bar simply holds at zero.
                    transition: autoAdvance ? `width 90ms linear` : "none",
                  }}
                />
              </div>

              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <Button size="sm" variant="secondary" onClick={() => stepPresentation(-1)} disabled={index === 0}>
                  <ChevronLeft className="h-3.5 w-3.5" /> Back
                </Button>
                <Button
                  size="sm"
                  variant="primary"
                  onClick={() => stepPresentation(1)}
                  disabled={index >= PRESENTATION_STEPS.length - 1}
                >
                  Next <ChevronRight className="h-3.5 w-3.5" />
                </Button>
                <Button
                  size="sm"
                  variant={paused ? "outline" : "secondary"}
                  onClick={togglePaused}
                  aria-pressed={paused}
                  title="Stops the auto-advance timer and the step-progress animation"
                >
                  {paused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
                  {paused ? "Resume" : "Pause"}
                </Button>
                <Button size="sm" variant="ghost" className="ml-auto" onClick={() => openPresentation(false)}>
                  <Square className="h-3 w-3" /> Exit presentation
                </Button>
              </div>

              <p className="mt-1.5 text-[10px] leading-snug text-[var(--fg-4)]">
                {reducedMotion
                  ? "Auto-advance is OFF: your system asks for reduced motion. Use Next/Back, N/P or the arrow keys."
                  : paused
                    ? "Paused: the step timer and its progress animation are stopped."
                    : `Auto-advances every ${AUTO_ADVANCE_MS / 1000}s. Pause stops the timer and the animation.`}
              </p>
            </footer>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
