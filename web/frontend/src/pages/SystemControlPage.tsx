/**
 * System Control Center: what this gateway can and cannot do on this host.
 *
 * The surface exists because three of the most important things CAPS reports are
 * limitations, and a reader who does not see them will assume the opposite:
 *
 *   1. whether pidfd is available, which changes what a termination guarantees
 *   2. which thermal sensor exists, if any, which decides whether the guard
 *      operates at all
 *   3. which guardrails are configured but NOT enforced
 *
 * Each is shown with the gateway's own reason string. Nothing here is inferred
 * in the client, and nothing is hidden because it is unflattering.
 */

import { useCallback, useEffect, useState } from "react";

import { catalogApi, type GuardrailsView, type ProcessIdentityView } from "../api/observability";
import { Card, Spinner, StatusDot, type Tone } from "../components/ui";

const CONFIDENCE_TONE: Record<ProcessIdentityView["confidence"], Tone> = {
  VERIFIED: "success",
  UNVERIFIED: "warn",
  UNAVAILABLE: "danger",
};

export default function SystemControlPage(): React.JSX.Element {
  const [guardrails, setGuardrails] = useState<GuardrailsView | null>(null);
  const [identity, setIdentity] = useState<ProcessIdentityView | null>(null);
  const [capabilities, setCapabilities] = useState<{ subsystems: unknown[]; notImplemented: unknown[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [caps, host] = await Promise.all([catalogApi.capabilities(), catalogApi.hostCapabilities()]);
      setGuardrails(caps.guardrails);
      setIdentity(caps.processIdentity);
      setCapabilities(host);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (error !== null) {
    return (
      <Card title="System">
        <p role="alert">Could not read the gateway's capabilities: {error}</p>
      </Card>
    );
  }
  if (guardrails === null || identity === null || capabilities === null) {
    return (
      <Card title="System">
        <Spinner label="Reading capabilities…" />
      </Card>
    );
  }

  const limits: Array<[string, GuardrailsView[keyof Omit<GuardrailsView, "thermal">], string]> = [
    ["Wall time", guardrails.wallTime, "The engine's own timeout, with an identity-verified escalation."],
    ["stdout", guardrails.stdout, "Truncation is recorded rather than silently applied."],
    ["stderr", guardrails.stderr, "Bounded separately: an unbounded stderr fills its pipe and deadlocks a healthy child."],
    ["CPU time", guardrails.cpuTime, "Kernel-reported CPU time, not wall-clock time."],
    ["Address space", guardrails.addressSpace, "Virtual address space, NOT physical memory."],
    ["Concurrency", guardrails.concurrency, "A request beyond the limit is refused rather than queued indefinitely."],
  ];

  return (
    <div className="space-y-4">
      <Card title="Process identity">
        <p>
          <StatusDot tone={CONFIDENCE_TONE[identity.confidence]} label={identity.confidence} />{" "}
          <code>{identity.model}</code>
        </p>
        <p>{identity.reason}</p>
        <p>
          <strong>Termination mechanism:</strong> {identity.terminationMechanism}
          {identity.kernel !== null && (
            <>
              {" "}
              (measured on kernel <code>{identity.kernel}</code>)
            </>
          )}
        </p>
        <p className="mt-1.5 text-[var(--fg-3)]">{identity.invariant}</p>
      </Card>

      <Card title="Guardrails">
        {/*
          Same missing wrapper as the other wide tables: the Notes column holds
          sentences, so the table compresses rather than scrolls on a narrow
          viewport and the caveats this page exists to show get squeezed into
          one word per line. `tabIndex` and `role="region"` make the scroll box
          keyboard-reachable and announced.
        */}
        <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Guardrails table">
          <table className="w-full border-collapse text-[11.5px]">
          <caption className="sr-only">Configured limits and whether each is enforced</caption>
          <thead>
            <tr>
              <th scope="col">Limit</th>
              <th scope="col">Configured</th>
              <th scope="col">Enforced</th>
              <th scope="col">Notes</th>
            </tr>
          </thead>
          <tbody>
            {limits.map(([label, view, note]) => (
              <tr key={label}>
                <th scope="row">{label}</th>
                <td>
                  {view.configuredBytesOrMs.toLocaleString("en-US")} {view.unit}
                </td>
                <td>
                  {/*
                   * Enforced and configured are separate columns because they are
                   * allowed to disagree, and a limit that is written down but not
                   * applied is the case a reader most needs to see.
                   */}
                  <StatusDot tone={view.enforced ? "success" : "warn"} label={view.enforced ? "enforced" : "not enforced"} />
                </td>
                <td>
                  {view.caveat ?? view.mechanism ?? note}
                </td>
              </tr>
            ))}
          </tbody>
          </table>
        </div>
      </Card>

      <Card title="Thermal guard">
        <p>
          <StatusDot
            tone={guardrails.thermal.enabled ? (guardrails.thermal.availability === "AVAILABLE" ? "success" : "warn") : "neutral"}
            label={guardrails.thermal.enabled ? (guardrails.thermal.availability === "AVAILABLE" ? "operating" : "cannot operate") : "disabled"}
          />
        </p>
        <p>{guardrails.thermal.reason}</p>
        <dl>
          <div>
            <dt>Sensor</dt>
            <dd>
              {guardrails.thermal.sensor ?? "none selected"} {guardrails.thermal.sensorPath !== null && <code>{guardrails.thermal.sensorPath}</code>}
            </dd>
          </div>
          <div>
            <dt>Thresholds</dt>
            <dd>
              warning {guardrails.thermal.warningC} °C, critical {guardrails.thermal.criticalC} °C
            </dd>
          </div>
          <div>
            <dt>Action</dt>
            <dd>{guardrails.thermal.action}</dd>
          </div>
          <div>
            <dt>Scope</dt>
            <dd>{guardrails.thermal.scope}</dd>
          </div>
        </dl>
        <h4>What this guard does not do</h4>
        <ul>
          {guardrails.thermal.restrictions.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      </Card>

      <Card title="Host observation">
        <h4>Implemented</h4>
        <ul>
          {(capabilities.subsystems as Array<{ id: string; label: string; source: string; note: string }>).map((s) => (
            <li key={s.id}>
              <strong>{s.label}</strong> — <code>{s.source}</code>. {s.note}
            </li>
          ))}
        </ul>
        <h4>Not implemented, and why</h4>
        <ul>
          {(capabilities.notImplemented as Array<{ id: string; label: string; reason: string }>).map((s) => (
            <li key={s.id}>
              <strong>{s.label}</strong> — {s.reason}
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
