import { ArrowRight, Rows3 } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";

import { api, ApiError } from "../api/client";
import { RedirectionDiagram } from "../components/execution/RedirectionDiagram";
import { OutputPanel } from "../components/execution/OutputPanel";
import { Button, Card, Code } from "../components/ui";
import { useSession } from "../lib/useSession";
import { useUi } from "../store/ui";

export default function RedirectionPage() {
  const capabilities = useUi((s) => s.capabilities);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [file, setFile] = useState("observatory.txt");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { session, events } = useSession(sessionId ?? undefined, { live: true });

  const run = async (mode: "out" | "append") => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.createSession({
        command: "echo",
        args: ["captured", "by", "CAPS", mode === "append" ? "(append)" : ""].filter(Boolean),
        redirections: mode === "out" ? { out: file.trim() || "observatory.txt" } : { append: file.trim() || "observatory.txt" },
      });
      setSessionId(res.sessionId);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const latestRedir = session?.redirections ?? {};

  return (
    <div className="mx-auto max-w-4xl space-y-6 px-6 py-6">
      <div>
        <div className="flex items-center gap-2 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-[var(--fg-3)]">Redirection</div>
        <h1 className="mt-1 text-xl font-semibold tracking-tight text-[var(--fg-0)]">Where the descriptors go</h1>
        <p className="mt-1 max-w-2xl text-[13px] text-[var(--fg-2)]">
          <Code>echo … &gt; file</Code> opens the workspace file with <Code>O_CREAT | O_TRUNC</Code> and <Code>dup2</Code>s it onto
          fd&nbsp;1. The diagrams below are generated from the real redirection events CAPS reports.
        </p>
      </div>

      <Card title="Try it" subtitle="Run a real redirection against ./caps">
        <div className="flex flex-wrap items-end gap-3">
          <label className="block">
            <span className="mb-1 block text-[10.5px] font-semibold uppercase tracking-wide text-[var(--fg-3)]">Target file (relative, workspace)</span>
            <input value={file} onChange={(e) => setFile(e.target.value)} className="h-9 w-64 rounded-[var(--r-sm)] border border-[var(--line-1)] bg-[var(--bg-2)] px-3 font-mono text-[13px] text-[var(--fg-0)] focus:border-[var(--accent)] focus:outline-none" placeholder="observatory.txt" />
          </label>
          <Button variant="secondary" disabled={busy} onClick={() => run("out")}>Run <Code>echo → {file.trim() || "observatory.txt"}</Code></Button>
          <Button variant="secondary" disabled={busy} onClick={() => run("append")}>Run append → {file.trim() || "observatory.txt"}</Button>
        </div>
        {error ? <p className="mt-2 text-[12px] text-[var(--red)]">{error}</p> : null}
        {!capabilities?.redirection.supported ? (
          <p className="mt-2 text-[12px] text-[var(--amber)]">The engine reports redirection as unsupported — no redirection events will appear.</p>
        ) : null}
      </Card>

      {session && sessionId ? (
        <div className="grid grid-cols-1 gap-6">
          <Card title="Descriptor plumbing" subtitle={`Session ${sessionId.slice(0, 8)}… · real redirection spec + events`}>
            <RedirectionDiagram redirections={latestRedir} events={events} />
          </Card>
          <Card title="Output" subtitle="What the child wrote to its redirected descriptor">
            <OutputPanel stdout={session.stdout} stderr={session.stderr} />
          </Card>
          <p className="flex items-center gap-2 text-[12px] text-[var(--fg-2)]">
            <Rows3 className="h-4 w-4" />
            The target file was written on the gateway's workspace disk by the real child.
            {session.status ? <Link to={`/execution/${session.id}`} className="inline-flex items-center gap-1 text-[var(--accent)] hover:underline">Open flight recorder <ArrowRight className="h-3 w-3" /></Link> : null}
          </p>
        </div>
      ) : (
        <Card title="digram area" subtitle="empty until you run a redirection">
          <div className="flex items-center justify-center rounded-[var(--r-md)] border border-dashed border-[var(--line-1)] py-10 text-[12.5px] text-[var(--fg-3)]">
            <Rows3 className="mr-2 h-4 w-4" />
            Run a redirection above to see the fd diagram.
          </div>
        </Card>
      )}
    </div>
  );
}