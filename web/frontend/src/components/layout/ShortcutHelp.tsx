import { AnimatePresence, motion } from "motion/react";
import { Keyboard } from "lucide-react";
import { useEffect, useState } from "react";

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
];

export function ShortcutHelp() {
  const [open, setOpen] = useState(false);
  const paletteOpen = useUi((s) => s.paletteOpen);
  const openPalette = useUi((s) => s.openPalette);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "?") {
        setOpen((o) => !o);
        return;
      }
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <>
      <AnimatePresence>
        {open ? (
          <motion.div className="fixed inset-0 z-50 flex items-center justify-center" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <div className="absolute inset-0 bg-black/50" onClick={() => setOpen(false)} />
            <motion.div
              className="relative w-[min(480px,92vw)]"
              initial={{ scale: 0.97, y: 8, opacity: 0 }}
              animate={{ scale: 1, y: 0, opacity: 1 }}
              exit={{ scale: 0.97, y: 8, opacity: 0 }}
            >
              <Card title="Keyboard shortcuts" subtitle="Navigate the observatory without the mouse">
                <div className="space-y-1.5">
                  {SHORTCUTS.map((s) => (
                    <div key={s.label} className="flex items-center justify-between rounded-[var(--r-sm)] px-2 py-1.5 hover:bg-[var(--bg-2)]">
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