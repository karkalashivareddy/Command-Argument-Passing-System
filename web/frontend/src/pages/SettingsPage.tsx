import { CircuitBoard, Cog, Database, Shield, Timer } from "lucide-react";
import { useEffect, useState } from "react";

import { api } from "../api/client";
import { Card, EmptyState, Spinner } from "../components/ui";
import { useUi } from "../store/ui";
import type { CapabilitiesResponse } from "../types/observability";

export default function SettingsPage() {
  const engine = useUi((s) => s.engine);
  const readiness = useUi((s) => s.readiness);
  const capabilities = useUi((s) => s.capabilities);
  const [sessions, setSessions] = useState<{ total: number } | null>(null);

  useEffect(() => {
    void api.listSessions({ limit: 1 }).then((r) => setSessions({ total: r.total })).catch(() => {});
  }, []);

  const caps: CapabilitiesResponse | null = capabilities;

  /*
   * What to say about the engine binary.
   *
   * Three states, because "not probed" is not "not available" and this page used
   * to say it was. `/api/ready` is fetched with `.catch(() => null)`, so an
   * absent `readiness` means the readiness probe did not answer -- it does not
   * mean the engine is down. The capability probe answers the same question
   * independently, and the sidebar and top bar already render ITS answer, so the
   * fallback has to agree with them or the screen contradicts itself.
   */
  const engineStatus = (() => {
    if (readiness !== null && readiness !== undefined) {
      return readiness.checks.engine.available
        ? { label: "available", tone: "text-[var(--green)]", reason: readiness.checks.engine.detail }
        : { label: "unavailable", tone: "text-[var(--danger)]", reason: readiness.checks.engine.detail };
    }
    if (capabilities !== null) {
      return {
        label: capabilities.engineAvailable ? "available (readiness not probed)" : "unavailable",
        tone: capabilities.engineAvailable ? "text-[var(--green)]" : "text-[var(--danger)]",
        reason: "The readiness probe did not answer, so this is the capability probe's own verdict.",
      };
    }
    return {
      label: "not probed",
      tone: "text-[var(--fg-3)]",
      reason: "Neither the readiness nor the capability probe has answered yet.",
    };
  })();
  const engineStatusLabel = engineStatus.label;
  const engineStatusTone = engineStatus.tone;
  const engineStatusReason = engineStatus.reason;

  return (
    <div className="mx-auto max-w-4xl space-y-6 px-6 py-6">
      <div className="flex items-center gap-2 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-[var(--fg-3)]">Settings</div>
      <h1 className="text-xl font-semibold tracking-tight text-[var(--fg-0)]">Gateway &amp; engine configuration</h1>
      <p className="max-w-2xl text-[13px] text-[var(--fg-2)]">Everything here is read live from the running gateway — there is no fake configuration.</p>

      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        <Card title="Engine" subtitle="The real ./caps binary">
          {!engine ? (
            <EmptyState icon={<Cog className="h-5 w-5" />} title="No engine info" body="The gateway did not report health." />
          ) : (
            <dl className="space-y-2 text-[13px]">
              {/*
                Three states, not two.

                This read `readiness?.checks.engine.available ? "available" : "unavailable"`,
                and `readiness` is fetched with `.catch(() => null)`. So a failed
                `/api/ready` -- while `/api/health` and `/api/capabilities` both
                succeed, which is entirely possible since readiness also probes the
                database and the host collector -- rendered "unavailable" in GREEN
                type, at the same moment as the sidebar and top bar said "ENGINE
                ONLINE" from `/api/capabilities`. Two contradictory statements about
                one fact, both on screen.

                It also conflated "not probed" with "not available", which is the
                distinction this product is otherwise careful about everywhere else.

                So an absent readiness probe reports that it was not probed, and
                falls back to the capability probe's own answer.
                */}
              <div className="flex justify-between gap-3">
                <dt className="text-[var(--fg-3)]">Status</dt>
                <dd
                  className={`font-mono ${engineStatusTone}`}
                  title={engineStatusReason}
                >
                  {engineStatusLabel}
                </dd>
              </div>
              <div className="flex justify-between gap-3"><dt className="text-[var(--fg-3)]">Version</dt><dd className="font-mono">{engine.version}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-[var(--fg-3)]">Platform</dt><dd className="font-mono">{engine.platform}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-[var(--fg-3)]">Binary</dt><dd className="truncate font-mono">{capabilities?.enginePath ?? "UNAVAILABLE"}</dd></div>
            </dl>
          )}
        </Card>

        <Card title="Limits" subtitle="Enforced by the gateway before spawn">
          {!caps ? (
            <EmptyState icon={<Timer className="h-5 w-5" />} title="No capability data" />
          ) : (
            <dl className="space-y-2 text-[13px]">
              <div className="flex justify-between gap-3"><dt className="text-[var(--fg-3)]">Max concurrent</dt><dd className="font-mono">{caps.limits.maxConcurrent}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-[var(--fg-3)]">Default timeout</dt><dd className="font-mono">{(caps.limits.defaultTimeoutMs / 1000)}s</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-[var(--fg-3)]">Max timeout</dt><dd className="font-mono">{(caps.limits.maxTimeoutMs / 1000)}s</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-[var(--fg-3)]">Output cap</dt><dd className="font-mono">{caps.limits.maxOutputBytes} bytes</dd></div>
            </dl>
          )}
        </Card>

        <Card title="Security policy" subtitle="Why arbitrary shells can't be run">
          {!caps ? (
            <EmptyState icon={<Shield className="h-5 w-5" />} title="No policy data" />
          ) : (
            <div className="space-y-2 text-[13px]">
              <div className="flex items-center gap-2">
                <CircuitBoard className="h-3.5 w-3.5 text-[var(--fg-3)]" />
                <span className="text-[var(--fg-2)]">Allowlist</span>
                <span className="ml-auto flex flex-wrap justify-end gap-1">
                  {caps.allowlist.map((c) => <code key={c} className="rounded-[var(--r-xs)] bg-[var(--bg-3)] px-1.5 py-0.5 font-mono text-[10.5px] text-[var(--fg-1)]">{c}</code>)}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <Shield className="h-3.5 w-3.5 text-[var(--fg-3)]" />
                <span className="text-[var(--fg-2)]">Workspace</span>
                <code className="ml-auto font-mono text-[11px]">{caps.workspace}</code>
              </div>
              <div className="flex items-center gap-2">
                <Shield className="h-3.5 w-3.5 text-[var(--fg-3)]" />
                <span className="text-[var(--fg-2)]">Bind</span>
                <code className="ml-auto font-mono text-[11px]">{`${caps.bind.mode} · ${caps.bind.host}:${caps.bind.port}`}</code>
              </div>
              <div className="flex items-center gap-2">
                <Shield className="h-3.5 w-3.5 text-[var(--fg-3)]" />
                <span className="text-[var(--fg-2)]">Redirection modes</span>
                <span className="ml-auto font-mono text-[11px]">{caps.redirection.modes.join(", ")}{caps.redirection.supported ? "" : " · unsupported"}</span>
              </div>
            </div>
          )}
        </Card>

        <Card title="Store" subtitle="Persisted on the gateway">
          <dl className="space-y-2 text-[13px]">
            <div className="flex justify-between gap-3"><dt className="text-[var(--fg-3)]">Persisted sessions</dt><dd className="font-mono">{sessions ? sessions.total : <Spinner />}</dd></div>
            <div className="flex justify-between gap-3"><dt className="text-[var(--fg-3)]">Backend</dt><dd className="font-mono">node:sqlite (WAL)</dd></div>
          </dl>
        </Card>
      </div>

      <p className="flex items-center gap-1.5 text-[11px] text-[var(--fg-3)]">
        <Database className="h-3.5 w-3.5" /> Sessions are kept after the registry sweep; history and replay always read from the store.
      </p>
    </div>
  );
}
