import { useEffect } from "react";

import { useUi } from "../../store/ui";

interface SpaceKeyOptions {
  /** True while a replay is playing; Space then toggles playback. */
  playing: boolean;
  onTogglePlay: () => void;
  /** The current shared execution-time cursor. */
  cursorMs: number | null;
  /** Every recorded sample time, ascending. Steps land on real samples. */
  sampleTimes: number[];
  onSeek: (atMs: number) => void;
  onClear: () => void;
  /** In live mode the cursor follows the newest sample, so stepping is off. */
  live: boolean;
}

/**
 * Cursor shortcuts for the process space.
 *
 * Space toggles replay, Left/Right step between recorded samples, and Escape
 * releases the cursor so it follows the newest evidence again. Steps always
 * land on a time the record actually contains. The app-wide single-letter
 * shortcuts (E, L, H, A, P, G) are untouched, and typing in a field never
 * triggers these.
 *
 * WHY THE WHOLE HOOK STANDS DOWN DURING A PRESENTATION
 * ---------------------------------------------------
 * Step 09 of the presentation script lands on this very route, so the collision
 * is not hypothetical: a presenter pressing Right to advance would otherwise both
 * step the replay cursor and advance the deck, and Escape would clear the
 * selection instead of exiting. The overlay is a modal and owns those keys
 * outright, so this hook checks the shared store and returns. Reading it from
 * `getState()` rather than subscribing keeps the listener from re-registering on
 * every pause/resume, which would drop keystrokes during the transition.
 */
export function useSpaceKeys({ playing, onTogglePlay, cursorMs, sampleTimes, onSeek, onClear, live }: SpaceKeyOptions): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;
      if (useUi.getState().presentation.open) return;

      if (event.key === " ") {
        event.preventDefault();
        onTogglePlay();
        return;
      }
      if (event.key === "Escape") {
        onClear();
        return;
      }
      if (live || sampleTimes.length === 0) return; // never invent a position
      if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
      event.preventDefault();
      const at = cursorMs ?? sampleTimes[0]!;
      const forward = event.key === "ArrowRight";
      const next = forward
        ? sampleTimes.find((time) => time > at)
        : [...sampleTimes].reverse().find((time) => time < at);
      if (next !== undefined) onSeek(next);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [playing, onTogglePlay, cursorMs, sampleTimes, onSeek, onClear, live]);
}
