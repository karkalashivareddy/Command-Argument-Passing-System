import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import { ArrowRight, Plus, Redo2, X } from "lucide-react";
import { Badge, Button, Card, Field, inputCls } from "../components/ui";
import { useExecution } from "../store/execution";
import { useUi } from "../store/ui";
import type { RedirectionSpec } from "../types/observability";

interface LocationState {
  command?: string;
  args?: string[];
}

const PRESETS: Array<{ label: string; command: string; args: string[]; redir?: boolean }> = [
  { label: "echo Hello Shiva", command: "echo", args: ["Hello", "Shiva"] },
  { label: "sleep 4", command: "sleep", args: ["4"] },
  { label: "uname -a", command: "uname", args: ["-a"] },
  { label: "false", command: "false", args: [] },
  { label: "echo > out.txt", command: "echo", args: ["redirected", "output"], redir: true },
];

function PresetButton({ preset }: { preset: (typeof PRESETS)[number] }) {
  return <span className="rounded-[var(--r-sm)] border border-[var(--line-1)] bg-[var(--bg-2)] px-2 py-1 text-[11px] text-[var(--fg-1)]">{preset.command}</span>;
}

export default function ExecutePage() {
  const navigate = useNavigate();
  const location = useLocation();
  const state = (location.state ?? {}) as LocationState;

  const capabilities = useUi((s) => s.capabilities);
  const engineState = useUi((s) => s.engineState);
  const pushToast = useUi((s) => s.pushToast);
  const begin = useExecution((s) => s.begin);

  const [command, setCommand] = useState("echo");
  const [args, setArgs] = useState<string[]>(["Hello", "Shiva"]);
  const [redirIn, setRedirIn] = useState("");
  const [redirOut, setRedirOut] = useState("");
  const [redirAppend, setRedirAppend] = useState("");
  const [timeoutMs, setTimeoutMs] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (state.command) {
      setCommand(state.command);
      setArgs(state.args ?? []);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location]);

  const presets = PRESETS as Array<{ label: string; command: string; args: string[]; redir?: boolean }>;

  const applyPreset = (p: (typeof PRESETS)[number]) => {
    setCommand(p.command);
    setArgs(p.args);
    if (p.redir) {
      setRedirOut("out.txt");
      setRedirAppend("");
    } else {
      setRedirOut("");
      setRedirAppend("");
    }
    setRedirIn("");
  };

  const exec = async () => {
    if (!command.trim() || busy) return;
    const redirections: RedirectionSpec = {};
    if (redirIn.trim()) redirections.in = redirIn.trim();
    if (redirOut.trim()) redirections.out = redirOut.trim();
    if (redirAppend.trim()) redirections.append = redirAppend.trim();

    setBusy(true);
    const res = await begin({ command: command.trim(), args: args.filter((a) => a !== ""), redirections, timeoutMs: timeoutMs ?? undefined });
    setBusy(false);
    if (res.ok) {
      pushToast(`Execution ${res.sessionId.slice(0, 8)}… launched — opening the flight recorder.`, "success");
      navigate(`/execution/${res.sessionId}`);
    } else {
      pushToast(res.message, "error");
    }
  };

  const onArgChange = (i: number, v: string) => setArgs((a) => a.map((x, j) => (j === i ? v : x)));
  const addArg = () => setArgs((a) => [...a, ""]);

  const disabled = engineState !== "online" || busy;

  return (
    <div className="mx-auto max-w-4xl space-y-6 px-6 py-6">
      <div>
        <div className="flex items-center gap-2 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-[var(--fg-3)]">Execute</div>
        <h1 className="mt-1 text-xl font-semibold tracking-tight text-[var(--fg-0)]">Compose a command</h1>
        <p className="mt-1 max-w-2xl text-[13px] text-[var(--fg-2)]">
          Type a command and its arguments. CAPS will parse it, build argv, fork a child, execvp the program, and report
          every step live on the flight recorder.
        </p>
      </div>

      <div className="space-y-3">
        <div className="flex flex-wrap gap-1.5">
          <span className="pt-0.5 text-[11px] text-[var(--fg-3)]">Templates:</span>
          {presets.map((p) => (
            <button key={p.label} onClick={() => applyPreset(p)} className="rounded-[var(--r-sm)] border border-[var(--line-1)] bg-[var(--bg-2)] px-2 py-1 text-[11.5px] text-[var(--fg-1)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)]">
              <PresetButton preset={p} />
            </button>
          ))}
        </div>
      </div>

      <Card
        title="Execution request"
        subtitle={<>Sent verbatim to <code className="font-mono text-[11px] text-[var(--fg-2)]">./caps --monitor --json …</code> — no shell involved</>}
      >
        <div className="grid grid-cols-1 gap-4">
          <Field label="Program" hint={`Must be on the engine allowlist: ${(capabilities?.allowlist ?? []).slice(0, 6).join(", ")}${(capabilities?.allowlist.length ?? 0) > 6 ? ", …" : ""}`}>
            <input value={command} onChange={(e) => setCommand(e.target.value)} className={inputCls} placeholder="echo" disabled={disabled} />
          </Field>

          <Field label={`Arguments (argv[1…argc-1]) — ${args.length}`}>
            <div className="space-y-1.5">
              {args.map((a, i) => (
                <div key={i} className="flex items-center gap-1.5">
                  <span className="w-16 shrink-0 font-mono text-[11px] text-[var(--fg-3)]">argv[{i + 1}]</span>
                  <input value={a} onChange={(e) => onArgChange(i, e.target.value)} className={inputCls} placeholder={`argument ${i + 1}`} disabled={disabled} />
                  <button onClick={() => setArgs((x) => x.filter((_, j) => j !== i))} className="rounded p-1 text-[var(--fg-3)] hover:bg-[var(--bg-3)] hover:text-[var(--red)]" aria-label="Remove argument" disabled={disabled}>
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
              <button onClick={addArg} className="flex items-center gap-1.5 text-[12px] text-[var(--accent)] hover:underline" disabled={disabled}>
                <Plus className="h-3.5 w-3.5" /> Add argument
              </button>
            </div>
          </Field>

          <Field label="Redirections">
            <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-3">
              <input value={redirIn} onChange={(e) => setRedirIn(e.target.value)} className={inputCls} placeholder="stdin file (no space)" disabled={disabled} />
              <input value={redirOut} onChange={(e) => setRedirOut(e.target.value)} className={inputCls} placeholder="stdout file" disabled={disabled} />
              <input value={redirAppend} onChange={(e) => setRedirAppend(e.target.value)} className={inputCls} placeholder="append file" disabled={disabled} />
            </div>
            <p className="mt-1 text-[11.5px] text-[var(--fg-3)]">Plain relative paths only — absolute paths, <code className="font-mono">..</code>, and <code className="font-mono">~</code> are rejected by policy.</p>
          </Field>

          <Field label="Timeout">
            <select value={timeoutMs ?? ""} onChange={(e) => setTimeoutMs(e.target.value ? Number(e.target.value) : null)} className={inputCls} disabled={disabled}>
              <option value="">Default ({(capabilities?.limits.defaultTimeoutMs ?? 30000) / 1000}s)</option>
              <option value="5000">5s</option>
              <option value="15000">15s</option>
              <option value={String(capabilities?.limits.maxTimeoutMs ?? 120000)}>Max ({(capabilities?.limits.maxTimeoutMs ?? 120000) / 1000}s)</option>
            </select>
          </Field>

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--line-0)] pt-4">
            <div className="flex gap-2">
              <Badge tone="neutral">max concurrent {capabilities?.limits.maxConcurrent ?? 4}</Badge>
              <Badge tone="neutral">{engineState === "online" ? "engine ready" : engineState}</Badge>
            </div>
            <Button variant="primary" onClick={exec} disabled={disabled} className="min-w-[10rem]">
              {busy ? (<><Redo2 className="h-4 w-4 animate-spin" /> Launching…</>) : (<><ArrowRight className="h-4 w-4" /> EXECUTE</>)}
            </Button>
          </div>
        </div>
      </Card>

      <Card title="What will happen" subtitle="The observable lifecycle of one command">
        <ol className="grid grid-cols-1 gap-2 text-[12.5px] text-[var(--fg-2)] sm:grid-cols-3">
          {[
            "CAPS receives (argc, argv) directly — no shell parsing.",
            "Arguments are stored, not re-joined — argv is preserved cell by cell.",
            "fork() clones the monitor as the child.",
            "execvp() replaces the child's image with your program (same PID).",
            "CAPS blocks in waitpid() until the child exits.",
            "Every step is captured as a sequence-numbered event.",
          ].map((s) => (
            <li key={s} className="flex items-start gap-2 rounded-[var(--r-sm)] bg-[var(--bg-2)] p-2.5"><span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--violet)]" />{s}</li>
          ))}
        </ol>
        <p className="mt-3 text-[11px] text-[var(--fg-3)]">This request is validated against the engine allowlist and the workspace policy before it is ever forked.</p>
      </Card>
    </div>
  );
}