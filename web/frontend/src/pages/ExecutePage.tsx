import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import { AlertTriangle, ArrowRight, Check, Cpu, HardDrive, Layers, Network, Plus, Redo2, X } from "lucide-react";
import { Badge, Button, Card, Field, inputCls } from "../components/ui";
import { useExecution } from "../store/execution";
import { useUi } from "../store/ui";
import type { RedirectionSpec, WorkloadProfileCapability } from "../types/observability";

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

const WORKLOAD_ICONS: Record<string, typeof Cpu> = {
  caps_cpu_burn: Cpu,
  caps_memory_burn: Layers,
  caps_io_burn: HardDrive,
  caps_mixed_burn: Network,
  caps_fork_tree: Network,
};

/**
 * Mirror of the server-side bound check. The gateway remains the authority;
 * this only avoids a pointless round trip and shows the same message the
 * server would return.
 */
function checkWorkloadArgv(profile: WorkloadProfileCapability, args: string[]): string | null {
  if (args.length > profile.args.length) {
    return `This workload accepts at most ${profile.args.length} argument${profile.args.length === 1 ? "" : "s"} (${profile.args
      .map((a) => a.name)
      .join(", ")}). Unknown arguments are rejected.`;
  }
  for (let i = 0; i < args.length; i++) {
    const spec = profile.args[i]!;
    const raw = args[i]!.trim();
    if (!/^-?\d{1,9}$/.test(raw)) {
      return `${spec.name} must be a plain whole number (got ${JSON.stringify(args[i])}).`;
    }
    const value = Number.parseInt(raw, 10);
    if (value < spec.min || value > spec.max) {
      return `${spec.name} must be ${spec.min}..${spec.max} ${spec.unit} (got ${value}).`;
    }
  }
  return null;
}

/** The transport timeout must outlast the workload's own budget. */
function requiredTimeoutMs(profile: WorkloadProfileCapability): number {
  const first = profile.args[0];
  if (first === undefined || first.name !== "seconds") return 0;
  const budget = argsToDefaults(profile)[0];
  return budget === undefined ? 0 : budget * 1000 + 2000;
}

function argsToDefaults(profile: WorkloadProfileCapability): number[] {
  return profile.args.map((a) => a.default);
}

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

  // Availability and bounds come from the server probe, never from a guess
  // baked into the client.
  const workloadProfiles: WorkloadProfileCapability[] = capabilities?.workloads?.profiles ?? [];
  const activeProfile = workloadProfiles.find((p) => p.id === command.trim()) ?? null;
  const activeArgError = activeProfile === null ? null : checkWorkloadArgv(activeProfile, args.filter((a) => a !== ""));
  const requiredTimeout = activeProfile === null ? 0 : requiredTimeoutMs(activeProfile);
  const timeoutTooShort = requiredTimeout > 0 && timeoutMs !== null && timeoutMs < requiredTimeout;

  const selectWorkload = (p: WorkloadProfileCapability) => {
    setCommand(p.id);
    setArgs(p.args.map((a) => String(a.default)));
    // Give the run enough headroom that the workload ends on its own rather
    // than being cut off by the transport timeout.
    const needed = requiredTimeoutMs(p);
    if (needed > 0) setTimeoutMs(needed);
    setRedirIn("");
    setRedirOut("");
    setRedirAppend("");
  };

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
  const submitBlocked = disabled || activeArgError !== null || timeoutTooShort;

  return (
    <div className="mx-auto max-w-4xl space-y-6 px-6 py-6">
      <div>
        <div className="flex items-center gap-2 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-[var(--fg-3)]">Execute</div>
        <h1 className="mt-1 text-xl font-semibold tracking-tight text-[var(--fg-0)]">Compose a command</h1>
        <p className="mt-1 max-w-2xl text-[13px] text-[var(--fg-2)]">
          Supply a program name and structured arguments. The browser sends an argv array, so shell-style command-line
          tokenization is unavailable here. CAPS forks the child, calls execvp, and reports the events its monitor observes.
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

      {workloadProfiles.length > 0 && (
        <Card
          title="Controlled workloads"
          subtitle={
            <>
              First-party binaries built from <code className="font-mono text-[11px]">workloads/*.c</code> by{" "}
              <code className="font-mono text-[11px]">make workloads</code>. Every metric below is read from the
              kernel for the PID CAPS actually forked — nothing is simulated.
            </>
          }
        >
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {workloadProfiles.map((p) => {
              const Icon = WORKLOAD_ICONS[p.id] ?? Cpu;
              const selected = activeProfile?.id === p.id;
              return (
                <button
                  key={p.id}
                  onClick={() => selectWorkload(p)}
                  disabled={disabled || !p.available}
                  title={p.available ? p.description : (p.unavailableReason ?? "unavailable")}
                  className={`flex flex-col gap-1.5 rounded-[var(--r-sm)] border p-2.5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-55 ${
                    selected
                      ? "border-[var(--accent)] bg-[var(--bg-3)]"
                      : "border-[var(--line-1)] bg-[var(--bg-2)] hover:border-[var(--accent)]"
                  }`}
                >
                  <div className="flex items-center gap-1.5">
                    <Icon className="h-3.5 w-3.5 shrink-0 text-[var(--accent)]" />
                    <span className="font-mono text-[11.5px] text-[var(--fg-0)]">{p.id}</span>
                    {selected && <Check className="ml-auto h-3.5 w-3.5 text-[var(--accent)]" />}
                    {!p.available && <AlertTriangle className="ml-auto h-3.5 w-3.5 text-[var(--amber)]" />}
                  </div>
                  <p className="text-[11.5px] leading-snug text-[var(--fg-2)]">
                    {p.available ? p.description : (p.unavailableReason ?? "unavailable")}
                  </p>
                  <div className="flex flex-wrap gap-1">
                    {p.observes.map((o) => (
                      <span key={o} className="rounded-[var(--r-sm)] bg-[var(--bg-3)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--fg-3)]">
                        {o}
                      </span>
                    ))}
                  </div>
                </button>
              );
            })}
          </div>
          <p className="mt-2.5 text-[11px] text-[var(--fg-3)]">
            Availability is probed by the gateway on disk (
            <code className="font-mono">{capabilities?.workloads?.available ?? 0}</code> of{" "}
            <code className="font-mono">{capabilities?.workloads?.count ?? 0}</code> built). eBPF, cgroup accounting,
            syscall tracing, and network I/O are not collected.
          </p>
        </Card>
      )}

      <Card
        title="Execution request"
        subtitle={<>Sent verbatim to <code className="font-mono text-[11px] text-[var(--fg-2)]">./caps --monitor --json …</code> — no shell involved</>}
      >
        <div className="grid grid-cols-1 gap-4">
          <Field label="Program" controlId="exec-program" hint={`Must be on the engine allowlist: ${(capabilities?.allowlist ?? []).slice(0, 6).join(", ")}${(capabilities?.allowlist.length ?? 0) > 6 ? ", …" : ""}`}>
            <input id="exec-program" value={command} onChange={(e) => setCommand(e.target.value)} className={inputCls} placeholder="echo" disabled={disabled} />
          </Field>

          {activeProfile !== null && (
            <div className="rounded-[var(--r-sm)] border border-[var(--line-1)] bg-[var(--bg-2)] p-2.5">
              <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--fg-3)]">
                {activeProfile.id} contract
              </div>
              <ul className="mt-1.5 space-y-1">
                {activeProfile.args.map((spec, i) => (
                  <li key={spec.name} className="text-[11.5px] text-[var(--fg-2)]">
                    <span className="font-mono text-[var(--fg-1)]">{spec.name}</span>{" "}
                    <span className="text-[var(--fg-3)]">
                      {spec.min}..{spec.max} {spec.unit}, default {spec.default} — {spec.description}
                    </span>
                    {args[i] !== undefined && (
                      <span className="ml-1 font-mono text-[var(--fg-3)]">(argv[{i + 1}])</span>
                    )}
                  </li>
                ))}
              </ul>
              <p className="mt-1.5 text-[11px] text-[var(--fg-3)]">
                Values must be plain whole numbers. Anything else is rejected by the gateway before a process is forked.
              </p>
            </div>
          )}

          <Field label={`Arguments (argv[1…argc-1]) — ${args.length}`} groupId="exec-arguments">
            <div className="space-y-1.5">
              {args.map((a, i) => (
                <div key={i} className="flex items-center gap-1.5">
                  {/*
                    The visible `argv[n]` text is not a <label>: it is a caption
                    for one input inside a row that also holds a remove button, so
                    making it a label element would put two labelable controls
                    under one name again. `aria-label` on the input gives that
                    input a unique name that includes its argv index, which is what
                    a screen reader announces when the reader tabs through the
                    rows and has no way to see the neighbouring text.
                  */}
                  <span className="w-16 shrink-0 font-mono text-[11px] text-[var(--fg-3)]">argv[{i + 1}]</span>
                  <input
                    value={a}
                    onChange={(e) => onArgChange(i, e.target.value)}
                    className={inputCls}
                    placeholder={`argument ${i + 1}`}
                    aria-label={`Argument argv[${i + 1}]`}
                    disabled={disabled}
                  />
                  <button onClick={() => setArgs((x) => x.filter((_, j) => j !== i))} className="rounded p-1 text-[var(--fg-3)] hover:bg-[var(--bg-3)] hover:text-[var(--red)]" aria-label={`Remove argument argv[${i + 1}]`} disabled={disabled}>
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
              <button onClick={addArg} disabled={disabled || (activeProfile !== null && args.length >= activeProfile.args.length)} className="flex items-center gap-1.5 text-[12px] text-[var(--accent)] hover:underline disabled:text-[var(--fg-3)] disabled:no-underline">
                <Plus className="h-3.5 w-3.5" /> Add argument
              </button>
            </div>
            {activeArgError !== null && (
              <p className="flex items-start gap-1.5 text-[11.5px] text-[var(--red)]">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {activeArgError}
              </p>
            )}
          </Field>

          {/*
            Three inputs behind one caption, so the caption names the group and
            each input names itself. A shared name of "Redirections" on all three
            is what the old <label> wrapper produced.
          */}
          <Field label="Redirections" groupId="exec-redirections">
            <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-3">
              <input value={redirIn} onChange={(e) => setRedirIn(e.target.value)} className={inputCls} placeholder="stdin file (no space)" aria-label="Redirect stdin from file" disabled={disabled} />
              <input value={redirOut} onChange={(e) => setRedirOut(e.target.value)} className={inputCls} placeholder="stdout file" aria-label="Redirect stdout to file" disabled={disabled} />
              <input value={redirAppend} onChange={(e) => setRedirAppend(e.target.value)} className={inputCls} placeholder="append file" aria-label="Append stdout to file" disabled={disabled} />
            </div>
            <p className="mt-1 text-[11.5px] text-[var(--fg-3)]">Plain relative paths only — absolute paths, <code className="font-mono">..</code>, and <code className="font-mono">~</code> are rejected by policy.</p>
          </Field>

          <Field label="Timeout" controlId="exec-timeout">
            <select id="exec-timeout" value={timeoutMs ?? ""} onChange={(e) => setTimeoutMs(e.target.value ? Number(e.target.value) : null)} className={inputCls} disabled={disabled}>
              <option value="">Default ({capabilities === null ? "…" : `${capabilities.limits.defaultTimeoutMs / 1000}s`})</option>
              {requiredTimeout > 0 && <option value={String(requiredTimeout)}>Workload budget + margin ({requiredTimeout / 1000}s)</option>}
              <option value="5000">5s</option>
              <option value="15000">15s</option>
              <option value={String(capabilities?.limits.maxTimeoutMs)}>Max ({capabilities === null ? "…" : `${capabilities.limits.maxTimeoutMs / 1000}s`})</option>
            </select>
            {timeoutTooShort && (
              <p className="mt-1 flex items-start gap-1.5 text-[11.5px] text-[var(--red)]">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                The timeout must be at least {requiredTimeout} ms for this workload, or the sample series would be cut
                off before the workload ends on its own.
              </p>
            )}
          </Field>

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--line-0)] pt-4">
            <div className="flex gap-2">
              {/*
              The gateway's configured concurrency, or nothing at all. A baked-in
              `?? 4` would put a number on screen and label it as the operator's
              setting while `/api/capabilities` had not answered yet -- and this
              page states elsewhere that its limits are never guessed client-side.
            */}
            {capabilities !== null && <Badge tone="neutral">max concurrent {capabilities.limits.maxConcurrent}</Badge>}
              {activeProfile !== null && <Badge tone={activeProfile.available ? "neutral" : "warn"}>{activeProfile.available ? activeProfile.executableRelativePath : "unavailable"}</Badge>}
              <Badge tone="neutral">{engineState === "online" ? "engine ready" : engineState}</Badge>
            </div>
            <Button variant="primary" onClick={exec} disabled={submitBlocked} className="min-w-[10rem]">
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
