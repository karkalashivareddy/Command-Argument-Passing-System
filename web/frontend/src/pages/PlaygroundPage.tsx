import { FlaskConical, Play } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

import { api } from "../api/client";
import { Button, Card, EmptyState, Spinner } from "../components/ui";
import { useExecution } from "../store/execution";
import { useUi } from "../store/ui";
import type { RedirectionSpec } from "../types/observability";

interface Example {
  id: string;
  title: string;
  category: string;
  command: string;
  args: string[];
  redirections?: Record<string, string>;
  explanation: string;
}

export default function PlaygroundPage() {
  const navigate = useNavigate();
  const begin = useExecution((s) => s.begin);
  const pushToast = useUi((s) => s.pushToast);
  const engineState = useUi((s) => s.engineState);
  const [examples, setExamples] = useState<Example[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [runningId, setRunningId] = useState<string | null>(null);

  useEffect(() => {
    void api
      .examples()
      .then((response) => setExamples(response.examples))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, []);

  const categories = [...new Set(examples.map((e) => e.category))];

  const run = async (ex: Example) => {
    if (engineState !== "online" || runningId !== null) return;
    setRunningId(ex.id);
    try {
      const redirections = ex.redirections as RedirectionSpec | undefined;
      const res = await begin({
        command: ex.command,
        args: ex.args,
        redirections: redirections ?? {},
      });
      if (res.ok) {
        pushToast(`Playground example “${ex.title}” launched.`, "success");
        navigate(`/execution/${res.sessionId}`);
      } else {
        pushToast(res.message, "error");
      }
    } finally {
      setRunningId(null);
    }
  };

  return (
    <div className="mx-auto max-w-5xl space-y-6 px-6 py-6">
      <div>
        <div className="flex items-center gap-2 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-[var(--fg-3)]">Playground</div>
        <h1 className="mt-1 text-xl font-semibold tracking-tight text-[var(--fg-0)]">Curated experiments</h1>
        <p className="mt-1 max-w-2xl text-[13px] text-[var(--fg-2)]">
          Each example runs through the real engine and opens its flight recorder. Ideas, not mockups — every script executes.
        </p>
      </div>

      {loading ? (
        <Spinner label="Loading examples…" />
      ) : error ? (
        <EmptyState icon={<FlaskConical className="h-5 w-5" />} title="Playground unavailable" body={error} />
      ) : categories.length === 0 ? (
        <EmptyState icon={<FlaskConical className="h-5 w-5" />} title="No examples configured" body="The gateway returned an empty example list." />
      ) : (
        categories.map((cat) => (
          <section key={cat}>
            <h2 className="mb-2 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-[var(--fg-3)]">{cat}</h2>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              {examples
                .filter((e) => e.category === cat)
                .map((ex) => (
                  <Card key={ex.id} title={ex.title} actions={<span className="font-mono text-[10.5px] text-[var(--fg-3)]">{ex.command} {ex.args.join(" ")}</span>}>
                    <p className="mb-3 text-[12.5px] leading-relaxed text-[var(--fg-2)]">{ex.explanation}</p>
                    <Button
                      variant="secondary"
                      disabled={engineState !== "online" || runningId !== null}
                      onClick={() => run(ex)}
                      className="w-full"
                    >
                      {runningId === ex.id ? <><Play className="h-3.5 w-3.5 animate-pulse" /> Launching…</> : <><Play className="h-3.5 w-3.5" /> Run + open flight recorder</>}
                    </Button>
                  </Card>
                ))}
            </div>
          </section>
        ))
      )}

      <p className="text-[11px] text-[var(--fg-3)]">Every run is recorded in history and available for replay — nothing here is fake.</p>
    </div>
  );
}
