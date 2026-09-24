import { AnimatePresence, motion } from "motion/react";
import { CornerDownLeft, FileQuestion, Play, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

import { useUi } from "../../store/ui";

interface Action {
  id: string;
  kind: "navigate" | "execute";
  label: string;
  hint: string;
  to?: string;
  command?: { command: string; args: string[] };
  category: string;
}

const NAV_ACTIONS: Action[] = [
  { id: "ov", kind: "navigate", label: "Overview", hint: "/", to: "/", category: "Navigate" },
  { id: "ex", kind: "navigate", label: "Execute a command", hint: "/execute", to: "/execute", category: "Navigate" },
  { id: "lv", kind: "navigate", label: "Live feed", hint: "/live", to: "/live", category: "Navigate" },
  { id: "pr", kind: "navigate", label: "Running processes", hint: "/processes", to: "/processes", category: "Navigate" },
  { id: "hi", kind: "navigate", label: "History", hint: "/history", to: "/history", category: "Navigate" },
  { id: "an", kind: "navigate", label: "Analytics", hint: "/analytics", to: "/analytics", category: "Navigate" },
  { id: "ar", kind: "navigate", label: "Architecture", hint: "/architecture", to: "/architecture", category: "Navigate" },
  { id: "pg", kind: "navigate", label: "Playground", hint: "/playground", to: "/playground", category: "Navigate" },
  { id: "sg", kind: "navigate", label: "Signals", hint: "/signals", to: "/signals", category: "Navigate" },
  { id: "rd", kind: "navigate", label: "Redirection", hint: "/redirection", to: "/redirection", category: "Navigate" },
  { id: "st", kind: "navigate", label: "Settings", hint: "/settings", to: "/settings", category: "Navigate" },
];

const EXEC_ACTIONS: Action[] = [
  { id: "e-argv", kind: "execute", label: "echo Hello Shiva", hint: "argument passing", command: { command: "echo", args: ["Hello", "Shiva"] }, category: "Run" },
  { id: "e-sleep", kind: "execute", label: "sleep 4", hint: "running process lifecycle", command: { command: "sleep", args: ["4"] }, category: "Run" },
  { id: "e-true", kind: "execute", label: "true", hint: "exit code 0", command: { command: "true", args: [] }, category: "Run" },
  { id: "e-false", kind: "execute", label: "false", hint: "exit code 1", command: { command: "false", args: [] }, category: "Run" },
  { id: "e-uname", kind: "execute", label: "uname -a", hint: "system info", command: { command: "uname", args: ["-a"] }, category: "Run" },
  {
    id: "e-pwd",
    kind: "execute",
    label: "pwd",
    hint: "current workspace",
    command: { command: "pwd", args: [] },
    category: "Run",
  },
];

export function CommandPalette() {
  const open = useUi((s) => s.paletteOpen);
  const setOpen = useUi((s) => s.openPalette);
  const pushToast = useUi((s) => s.pushToast);
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const actions = useMemo(() => {
    const all = [...EXEC_ACTIONS, ...NAV_ACTIONS];
    const needle = q.trim().toLowerCase();
    if (!needle) return all;
    return all.filter((a) => `${a.label} ${a.hint} ${a.category}`.toLowerCase().includes(needle));
  }, [q]);

  useEffect(() => {
    if (open) {
      setQ("");
      setIdx(0);
      window.setTimeout(() => inputRef.current?.focus(), 30);
    }
  }, [open]);

  function run(action: Action) {
    setOpen(false);
    if (action.kind === "navigate" && action.to) {
      navigate(action.to);
      return;
    }
    if (action.kind === "execute" && action.command) {
      navigate("/execute", { state: { command: action.command.command, args: action.command.args } });
      pushToast(`Prepared: ${action.command.command} ${action.command.args.join(" ")}`.trim(), "info");
    }
  }

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setIdx((i) => Math.min(i + 1, actions.length - 1));
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setIdx((i) => Math.max(i - 1, 0));
      }
      if (e.key === "Enter" && actions[idx]) run(actions[idx]!);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, actions, idx]);

  return (
    <AnimatePresence>
      {open ? (
        <motion.div
          className="fixed inset-0 z-[var(--z-palette)] flex items-start justify-center pt-[12vh]"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.12 }}
        >
          <div className="absolute inset-0 bg-black/50" onClick={() => setOpen(false)} />
          <motion.div
            className="relative w-[min(560px,92vw)] overflow-hidden rounded-[var(--r-lg)] border border-[var(--line-1)] bg-[var(--bg-1)] shadow-[var(--shadow-pop)]"
            initial={{ scale: 0.98, y: -6, opacity: 0 }}
            animate={{ scale: 1, y: 0, opacity: 1 }}
            exit={{ scale: 0.98, y: -6, opacity: 0 }}
            transition={{ duration: 0.15, ease: [0.16, 1, 0.3, 1] }}
          >
            <div className="flex items-center gap-2 border-b border-[var(--line-0)] px-3.5">
              <Search className="h-4 w-4 text-[var(--fg-3)]" />
              <input
                ref={inputRef}
                value={q}
                onChange={(e) => {
                  setQ(e.target.value);
                  setIdx(0);
                }}
                placeholder="Type a command or go to a page…"
                className="h-12 flex-1 bg-transparent text-sm text-[var(--fg-0)] placeholder:text-[var(--fg-3)] focus:outline-none"
              />
            </div>
            <div className="max-h-[46vh] overflow-y-auto py-1.5">
              {actions.length === 0 ? (
                <div className="flex flex-col items-center gap-2 py-8 text-[var(--fg-3)]">
                  <FileQuestion className="h-5 w-5" />
                  <p className="text-[12.5px]">No actions match “{q}”.</p>
                </div>
              ) : (
                actions.map((a, i) => (
                  <button
                    key={a.id}
                    onMouseEnter={() => setIdx(i)}
                    onClick={() => run(a)}
                    className={`flex w-full items-center gap-3 px-3.5 py-2.5 text-left text-[13px] transition-colors ${
                      i === idx ? "bg-[var(--bg-3)] text-[var(--fg-0)]" : "text-[var(--fg-1)]"
                    }`}
                  >
                    <span
                      className={`flex h-6 w-6 items-center justify-center rounded-[var(--r-sm)] ${
                        a.kind === "execute" ? "bg-[var(--accent-soft)] text-[var(--accent)]" : "bg-[var(--bg-3)] text-[var(--fg-2)]"
                      }`}
                    >
                      {a.kind === "execute" ? <Play className="h-3.5 w-3.5" /> : <Search className="h-3.5 w-3.5" />}
                    </span>
                    <span className="flex-1">{a.label}</span>
                    <span className="text-[11px] text-[var(--fg-3)]">{a.hint}</span>
                    {i === idx ? <CornerDownLeft className="h-3.5 w-3.5 text-[var(--fg-3)]" /> : null}
                  </button>
                ))
              )}
            </div>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
