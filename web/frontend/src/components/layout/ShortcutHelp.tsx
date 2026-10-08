import { AnimatePresence, motion } from "motion/react";
import { Keyboard } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useUi } from "../../store/ui";
import { Card } from "../ui";

const SHORTCUTS: Array<{ keys: string[]; label: string }> = [
  { keys: ["E"], label: "Go to Execute" },
  { keys: ["L"], label: "Go to Live feed" },
  { keys: ["H"], label: "Go to History" },
  { keys: ["A"], label: "Go to Analytics" },
  { keys: ["P"], label: "Go to Processes" },
  { keys: ["G"], label: "Go to Playground" },
  { keys: ["K"], label: "Command palette" },
  { keys: ["?"], label: "Show this help" },
  { keys: ["R"], label: "3D: reset camera" },
  { keys: ["F"], label: "3D: focus the selected process" },
  { keys: ["Space"], label: "3D: toggle replay playback" },
  { keys: ["←", "→"], label: "3D: step between recorded samples" },
  { keys: ["Esc"], label: "3D: clear the selection" },
  /*
    Presentation mode gets its own block because its keys mean something
    DIFFERENT while it is open, and a flat list would read as though P still
    navigated to Processes mid-talk. Both sets are always shown; the group is what
    tells the reader which one applies.
  */
  { keys: ["D"], label: "Presentation: open the guided 12-step overlay" },
  { keys: ["→", "N"], label: "Presentation: next step" },
  { keys: ["←", "P"], label: "Presentation: previous step" },
  { keys: ["Esc"], label: "Presentation: exit and return focus to the opener" },
];

/** Indices into SHORTCUTS above, so the two blocks can be marked without a second array. */
const PRESENTATION_FIRST = 13;

export function ShortcutHelp() {
  const [open, setOpen] = useState(false);
  const paletteOpen = useUi((s) => s.paletteOpen);
  const openPalette = useUi((s) => s.openPalette);
  const dialogRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  /**
   * Focus moves into the dialog on open and returns to the opener on close.
   *
   * The element that had focus when "?" was pressed is captured before the
   * dialog takes it, and re-focused on the way out. Escape and the "Open the
   * command palette instead" button both close through `setOpen(false)`, so the
   * restore lives in an effect keyed on `open` rather than in each close site:
   * there is then one path out and it cannot be forgotten.
   */
  useEffect(() => {
    if (!open) return;
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // The dialog itself is the initial target: focusing its first button would
    // read out "Open the command palette instead" before the reader hears what
    // the help panel is.
    const t = window.setTimeout(() => dialogRef.current?.focus(), 30);
    return () => {
      window.clearTimeout(t);
      returnFocusRef.current?.focus();
      returnFocusRef.current = null;
    };
  }, [open]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "?") {
        /*
          The presentation overlay is a modal and owns the keyboard while it is
          open. Letting "?" summon this panel on top of it would leave the
          presenter with two stacked dialogs, only one of which is the one they
          are presenting. The overlay does not document these keys, so nothing is
          lost by refusing it here.
        */
        if (useUi.getState().presentation.open) return;
        setOpen((o) => !o);
        return;
      }
      if (e.key === "Escape") {
        setOpen(false);
        return;
      }
      /*
       * Tab is trapped while the dialog is open. Without it the reader tabbed
       * straight out into the page behind, which stayed visible and kept
       * receiving keystrokes -- including "?", which re-opened the help under a
       * completely different focus position.
       */
      if (e.key === "Tab" && open) {
        const dialog = dialogRef.current;
        if (dialog === null) return;
        const focusable = dialog.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])');
        if (focusable.length === 0) return;
        const first = focusable[0]!;
        const last = focusable[focusable.length - 1]!;
        const active = document.activeElement;
        if (e.shiftKey && (active === first || !dialog.contains(active))) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && (active === last || !dialog.contains(active))) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <>
      <AnimatePresence>
        {open ? (
          <motion.div className="fixed inset-0 z-50 flex items-center justify-center" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <div className="absolute inset-0 bg-black/50" onClick={() => setOpen(false)} />
            <motion.div
              ref={dialogRef}
              role="dialog"
              aria-modal="true"
              aria-label="Keyboard shortcuts"
              tabIndex={-1}
              className="relative w-[min(480px,92vw)] focus:outline-none"
              initial={{ scale: 0.97, y: 8, opacity: 0 }}
              animate={{ scale: 1, y: 0, opacity: 1 }}
              exit={{ scale: 0.97, y: 8, opacity: 0 }}
            >
              <Card title="Keyboard shortcuts" subtitle="Navigate the observatory without the mouse">
                <div className="space-y-1.5">
                  {SHORTCUTS.map((s, i) => (
                    <div key={s.label}>
                      {i === PRESENTATION_FIRST ? (
                        /*
                          A rule, not a heading. The list is a scannable grid and a
                          section title would break its rhythm for one boundary; a
                          hairline plus a caption says the same thing without
                          displacing four rows.
                        */
                        <div className="mt-2 border-t border-[var(--line-0)] pt-2">
                          <div className="px-2 pb-1 font-mono text-[9.5px] font-semibold uppercase tracking-[var(--tracking-micro)] text-[var(--fg-3)]">
                            While presentation mode is open
                          </div>
                        </div>
                      ) : null}
                      <div className="flex items-center justify-between rounded-[var(--r-sm)] px-2 py-1.5 hover:bg-[var(--bg-2)]">
                        <span className="text-[13px] text-[var(--fg-1)]">{s.label}</span>
                        <span className="flex items-center gap-1">
                          {s.keys.map((k) => (
                            <kbd
                              key={k}
                              className="rounded border border-[var(--line-1)] bg-[var(--bg-3)] px-1.5 py-0.5 font-mono text-[11px] text-[var(--fg-0)]"
                            >
                              {k}
                            </kbd>
                          ))}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
                <button
                  onClick={() => {
                    setOpen(false);
                    openPalette(!paletteOpen);
                  }}
                  className="mt-3 flex items-center gap-2 text-[12px] text-[var(--accent)] hover:underline"
                >
                  <Keyboard className="h-3.5 w-3.5" /> Open the command palette instead
                </button>
              </Card>
            </motion.div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </>
  );
}
