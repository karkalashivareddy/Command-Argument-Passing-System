import { Cpu, Database, Globe, Radio, Server, Workflow } from "lucide-react";
import { useState } from "react";

import { Card, Badge } from "../components/ui";

interface Layer {
  id: string;
  label: string;
  tech: string;
  icon: React.ReactNode;
  blurb: string;
  syscalls?: Array<{ name: string; what: string }>;
}

const LAYERS: Layer[] = [
  {
    id: "browser",
    label: "Browser",
    tech: "React · Motion · SSE (EventSource)",
    icon: <Globe className="h-4 w-4" />,
    blurb: "Renders the observatory and holds the live event sequence. Reconnects with Last-Event-ID so no event is lost on a drop.",
  },
  {
    id: "gateway",
    label: "Node gateway",
    tech: "Fastify · node:sqlite",
    icon: <Server className="h-4 w-4" />,
    blurb: "Validates the request against the allowlist + workspace policy, spawns ./caps, normalizes monitor events into canonical envelopes, and streams them over SSE.",
  },
  {
    id: "engine",
    label: "CAPS engine",
    tech: "C · POSIX",
    icon: <Cpu className="h-4 w-4" />,
    blurb: "The real thing: parses the command line, forks a child, execvp's the program, blocks in waitpid, and reports every step as structured events.",
    syscalls: [
      { name: "fork()", what: "Clones the monitor process — the only way POSIX creates a child." },
      { name: "execvp()", what: "Replaces the child's memory image with the requested program. Same PID, new program." },
      { name: "waitpid()", what: "Parent blocks until THIS child exits, then reaps its termination status." },
      { name: "open()/dup2()", what: "Opens redirection targets and splices them onto fd 0/1." },
      { name: "kill()", what: "Delivers a terminate signal (SIGINT/SIGTERM/…) to the child." },
    ],
  },
  {
    id: "db",
    label: "SQLite store",
    tech: "node:sqlite · WAL",
    icon: <Database className="h-4 w-4" />,
    blurb: "Persists every session and every event (executions, events, redirections) so history, analytics, and replay all read from the real record.",
  },
];

const EDGES = [
  { from: "browser", to: "gateway", label: "HTTPS · /api/sessions", via: "fetch ✓ / SSE ✓" },
  { from: "gateway", to: "engine", label: "spawn ./caps --monitor --json", via: "stdio" },
  { from: "engine", to: "gateway", label: "monitor events → JSON lines", via: "stderr channel" },
  { from: "gateway", to: "browser", label: "canonical events → SSE", via: "text/event-stream" },
  { from: "gateway", to: "db", label: "persist on finalize", via: "node:sqlite" },
] as const;

export default function ArchitecturePage() {
  const [selected, setSelected] = useState<string | null>("engine");
  const layer = LAYERS.find((l) => l.id === selected) ?? null;

  return (
    <div className="mx-auto max-w-5xl space-y-6 px-6 py-6">
      <div>
        <div className="flex items-center gap-2 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-[var(--fg-3)]">Architecture</div>
        <h1 className="mt-1 text-xl font-semibold tracking-tight text-[var(--fg-0)]">How a command travels to the kernel</h1>
        <p className="mt-1 max-w-2xl text-[13px] text-[var(--fg-2)]">
          This is the actual implementation, rendered as layers. Select a layer — or the syscalls inside the engine — to see what really happens.
        </p>
      </div>

      <Card title="Data flow" subtitle="Click a layer to inspect it">
        <div className="flex flex-col items-stretch gap-1">
          {LAYERS.map((l, i) => {
            const active = selected === l.id;
            return (
              <div key={l.id} className="flex flex-col">
                <button
                  onClick={() => setSelected(l.id)}
                  className={`flex items-center gap-3 rounded-[var(--r-md)] border px-4 py-3 text-left transition-colors ${
                    active ? "border-[var(--accent-soft)] bg-[var(--accent-soft)]" : "border-[var(--line-0)] bg-[var(--bg-2)] hover:border-[var(--line-1)]"
                  }`}
                >
                  <span className={`flex h-9 w-9 items-center justify-center rounded-[var(--r-sm)] ${active ? "bg-[var(--bg-3)] text-[var(--accent)]" : "bg-[var(--bg-3)] text-[var(--fg-2)]"}`}>{l.icon}</span>
                  <span className="flex-1">
                    <span className={`block text-[13.5px] font-semibold ${active ? "text-[var(--fg-0)]" : "text-[var(--fg-1)]"}`}>{l.label}</span>
                    <span className="block font-mono text-[10.5px] text-[var(--fg-3)]">{l.tech}</span>
                  </span>
                  {active ? <Badge tone="active">inspecting</Badge> : null}
                </button>
                {i < LAYERS.length - 1 ? (
                  <div className="flex items-center gap-2 self-center py-0.5">
                    <span className="h-2 w-2 rotate-45 border-b border-r border-[var(--line-2)]" />
                    <span className="font-mono text-[9.5px] uppercase tracking-wide text-[var(--fg-4)]">{EDGES[i]?.label}</span>
                    <span className="h-2 w-2 rotate-45 border-l border-t border-[var(--line-2)]" />
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </Card>

      <Card title={layer ? `${layer.label} — inspector` : "Inspector"} subtitle={layer ? layer.tech : undefined}>
        {layer ? (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <div>
              <p className="text-[13px] leading-relaxed text-[var(--fg-1)]">{layer.blurb}</p>
              {layer.syscalls ? (
                <div className="mt-4 space-y-1.5">
                  <div className="text-[10.5px] font-semibold uppercase tracking-[0.12em] text-[var(--fg-3)]">POSIX syscalls in the engine</div>
                  {layer.syscalls.map((s) => (
                    <div key={s.name} className="rounded-[var(--r-sm)] bg-[var(--bg-2)] px-2.5 py-2">
                      <code className="font-mono text-[12px] font-semibold text-[var(--violet)]">{s.name}</code>
                      <p className="mt-0.5 text-[11.5px] leading-snug text-[var(--fg-2)]">{s.what}</p>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
            <div className="rounded-[var(--r-md)] border border-[var(--line-0)] bg-[var(--bg-1)] p-3">
              <div className="mb-1.5 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-[var(--fg-3)]">Edges involving this layer</div>
              {EDGES.filter((e) => e.from === layer.id || e.to === layer.id).map((e) => (
                <div key={`${e.from}-${e.to}`} className="mb-1 flex items-center gap-2 font-mono text-[11px] text-[var(--fg-2)]">
                  <span className="text-[var(--fg-1)]">{e.from}</span>
                  <span className="text-[var(--accent)]">→</span>
                  <span className="text-[var(--fg-1)]">{e.to}</span>
                  <span className="ml-auto text-[var(--fg-3)]">{e.via}</span>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <Workflow className="h-6 w-6 text-[var(--fg-3)]" />
        )}
      </Card>

      <p className="flex items-center gap-2 text-[11px] text-[var(--fg-3)]">
        <Radio className="h-3.5 w-3.5" /> The SSE hop is where real-time happens: every <code className="font-mono">execution.received</code> frame carries one canonical event with a unique ascending <code className="font-mono">sequence</code>.
      </p>
    </div>
  );
}
