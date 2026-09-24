import { Signal, Square } from "lucide-react";
import { useState } from "react";

import { api, ApiError } from "../api/client";
import { SignalDiagram } from "../components/execution/SignalDiagram";
import { EventStream } from "../components/execution/EventStream";
import { Button, Card, EmptyState, Spinner } from "../components/ui";
import { signalName } from "../lib/format";
import { useSession } from "../lib/useSession";

const SIGNALS = [
  { sig: 2, name: "SIGINT", desc: "Ctrl+C — polite interrupt; default action terminates the process." },
  { sig: 15, name: "SIGTERM", desc: "Termination request — the polite way to ask a process to stop." },
  { sig: 9, name: "SIGKILL", desc: "Kill — cannot be caught, blocked, or ignored." },
  { sig: 3, name: "SIGQUIT", desc: "Quit + core dump — Ctrl+\\ at the terminal." },
] as const;

export default function SignalsPage() {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const { session, events, loading, error } = useSession(sessionId ?? undefined, { live: true });
  const [busy, setBusy] = useState(false);
  const [delivering, setDelivering] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const spawn = async () => {
    if (busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const res = await api.createSession({ command: "sleep", args: ["30"] });
      setSessionId(res.sessionId);
    } catch (e) {
      setNotice(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const deliver = async (sig: number) => {
    if (!sessionId || delivering !== null) return;
    setDelivering(sig);
    try {
      await api.terminate(sessionId, signalName(sig));
      setNotice(`${signalName(sig)} delivered to PID ${session?.pid ?? "?"} — watch the diagram react to real events.`);
    } catch (e) {
      setNotice(e instanceof ApiError ? e.message : String(e));
    } finally {
      setDelivering(null);
    }
  };

  const active = session?.status === "RUNNING" || session?.status === "STARTING";
  const signalEv = events.find((e) => e.type === "signal.received");
  const signalVal = (signalEv?.payload?.signal as number | undefined) ?? session?.signal ?? null;

  return (
    <div className="mx-auto max-w-5xl space-y-6 px-6 py-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-[var(--fg-3)]">Signals</div>
          <h1 className="mt-1 text-xl font-semibold tracking-tight text-[var(--fg-0)]">Signal the process, watch it react</h1>
          <p className="mt-1 max-w-2xl text-[13px] text-[var(--fg-2)]">
            CAPS spawns a real <code className="font-mono">sleep 30</code> child. Pick a signal and deliver it to the real PID —
            the flow diagram animates from the actual <code className="font-mono">signal.received</code> event, not a simulation.
          </p>
        </div>
        <Button variant="primary" onClick={spawn} disabled={busy || Boolean(sessionId)}>
          <Signal className="h-4 w-4" /> {sessionId ? "spawned" : busy ? "spawning…" : "Spawn sleep 30"}
        </Button>
      </div>

      {notice ? <Card title="Notice"><p className="text-[13px] text-[var(--fg-1)]">{notice}</p></Card> : null}

      {!sessionId ? (
        <Card title="No live session yet" subtitle="Everything here is driven by a real child process">
          <EmptyState
            icon={<Signal className="h-6 w-6" />}
            title="Press “Spawn sleep 30” to begin"
            body="A genuine PID is forked by the engine; only the signals you deliver will appear in this diagram."
            action={<Button variant="secondary" onClick={spawn} disabled={busy}>Begin experiment</Button>}
          />
        </Card>
      ) : loading ? (
        <div className="py-6"><Spinner label="Wiring the live session…" /></div>
      ) : error ? (
        <Card title="Session error"><p className="text-[13px] text-[var(--red)]">{error}</p></Card>
      ) : (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <Card title={`Live signal flow · ${session?.argv[0] ?? "child"} PID ${session?.pid ?? "?"}`} subtitle={active ? "child is running — signals will be delivered to it" : "child is no longer running"}>
            <SignalDiagram events={events} signal={signalVal} exitCode={session?.exitCode ?? null} />
            <div className="mt-4 border-t border-[var(--line-0)] pt-3">
              <div className="mb-2 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-[var(--fg-3)]">Deliver to the live child</div>
              <div className="flex flex-wrap gap-2">
                {SIGNALS.map((s) => (
                  <Button key={s.sig} variant={active ? "secondary" : "ghost"} disabled={!active || delivering !== null} onClick={() => deliver(s.sig)} title={s.desc}>
                    {delivering === s.sig ? <Square className="h-3.5 w-3.5 animate-pulse" /> : null}
                    {s.name}
                  </Button>
                ))}
              </div>
              <p className="mt-2 text-[11px] text-[var(--fg-3)]">Once delivered, the child terminates and the result is recorded in the session.</p>
            </div>
          </Card>

          <Card title="Reference" subtitle="Signal numbers are fixed by the kernel">
            <div className="space-y-1.5">
              {SIGNALS.map((s) => (
                <div key={s.sig} className="flex items-start gap-3 rounded-[var(--r-sm)] bg-[var(--bg-2)] px-2.5 py-2">
                  <span className="rounded-[var(--r-sm)] border border-[var(--line-1)] px-1.5 py-0.5 font-mono text-[11px] text-[var(--red)]">{s.sig}</span>
                  <div>
                    <div className="font-mono text-[12px] font-semibold text-[var(--fg-0)]">{s.name}</div>
                    <div className="text-[11.5px] leading-snug text-[var(--fg-2)]">{s.desc}</div>
                  </div>
                </div>
              ))}
            </div>
          </Card>

          <Card title="Events for this experiment" subtitle="The real telemetry behind the diagram" className="lg:col-span-2" pad={false}>
            <EventStream events={events} status={session?.status} live={active} emptyLabel="Waiting for the engine to start the child…" />
          </Card>
        </div>
      )}
    </div>
  );
}