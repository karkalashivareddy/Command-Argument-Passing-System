import { TerminalSquare } from "lucide-react";
import { Link } from "react-router-dom";

import { Card, Code } from "../components/ui";
import { useUi } from "../store/ui";

export default function AboutPage() {
  const engine = useUi((s) => s.engine);
  const capabilities = useUi((s) => s.capabilities);

  return (
    <div className="mx-auto max-w-3xl space-y-6 px-6 py-6">
      <div className="flex items-center gap-2 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-[var(--fg-3)]">About</div>
      <h1 className="text-xl font-semibold tracking-tight text-[var(--fg-0)]">CAPS — Process Execution Observatory</h1>

      <Card title="What this is" subtitle="A real system, not a simulation">
        <p className="text-[13.5px] leading-relaxed text-[var(--fg-1)]">
          The Observatory is an end-to-end pipeline: a real C engine (<Code>./caps</Code>) executes POSIX programs with a
          monitor that emits structured events; a Node gateway validates, spawns, normalizes and persists them; SSE pushes
          them to a React frontend that visualizes the whole fork → exec → wait → exit story.
        </p>
        <p className="mt-3 text-[13.5px] leading-relaxed text-[var(--fg-1)]">
          Every pipeline stage, process node, argv cell, signal and exit status you see is derived from the actual telemetry
          the engine reported. Nothing is mocked; empty states are honest.
        </p>
      </Card>

      <Card title="Stack" subtitle="Exactly what is running under the hood">
        <dl className="space-y-2 text-[13px]">
          <div className="flex justify-between"><dt className="text-[var(--fg-3)]">Engine</dt><dd className="font-mono">{engine ? `${engine.platform} · ${engine.version}` : "—"}</dd></div>
          <div className="flex justify-between"><dt className="text-[var(--fg-3)]">Gateway</dt><dd className="font-mono">Node · Fastify · node:sqlite</dd></div>
          <div className="flex justify-between"><dt className="text-[var(--fg-3)]">Transport</dt><dd className="font-mono">REST + SSE (Last-Event-ID)</dd></div>
          <div className="flex justify-between"><dt className="text-[var(--fg-3)]">Frontend</dt><dd className="font-mono">React 19 · Vite · Tailwind v4 · Motion · Recharts</dd></div>
          <div className="flex justify-between"><dt className="text-[var(--fg-3)]">Workspace</dt><dd className="font-mono">{capabilities?.workspace ?? "—"}</dd></div>
        </dl>
      </Card>

      <Card title="Guide" subtitle="Where to look first">
        <ul className="space-y-1.5 text-[13px]">
          <li><Link to="/" className="text-[var(--accent)] hover:underline">Overview</Link><span className="text-[var(--fg-3)]"> — one-command starting point</span></li>
          <li><Link to="/execute" className="text-[var(--accent)] hover:underline">Execute</Link><span className="text-[var(--fg-3)]"> — compose and launch a command</span></li>
          <li><Link to="/signals" className="text-[var(--accent)] hover:underline">Signals</Link><span className="text-[var(--fg-3)]"> — deliver a real signal</span></li>
          <li><Link to="/architecture" className="text-[var(--accent)] hover:underline">Architecture</Link><span className="text-[var(--fg-3)]"> — the whole pipeline explained</span></li>
          <li><Link to="/demo" className="text-[var(--accent)] hover:underline">Demo</Link><span className="text-[var(--fg-3)]"> — four real runs at once</span></li>
        </ul>
      </Card>

      <p className="flex items-center gap-2 text-[11px] text-[var(--fg-3)]">
        <TerminalSquare className="h-3.5 w-3.5" />
        Press <kbd className="rounded border border-[var(--line-1)] px-1 font-mono text-[10px]">?</kbd> for keyboard shortcuts,
        <kbd className="ml-1 rounded border border-[var(--line-1)] px-1 font-mono text-[10px]">⌘K</kbd> for the command palette.
      </p>
    </div>
  );
}