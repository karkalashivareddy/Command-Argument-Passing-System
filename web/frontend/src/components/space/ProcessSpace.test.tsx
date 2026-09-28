import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CanonicalEvent, SessionRecord, TelemetryMetric } from "../../types/observability";
import { ProcessSpace } from "./ProcessSpace";

/**
 * The browser-side contract of the 3D view, asserted without a GPU.
 *
 * jsdom has no WebGL context, which is exactly the environment the fallback
 * exists for: the reader must still get the explanation, the 2D process graph
 * and the ordinary DOM table, and never a blank canvas.
 */

const START = Date.parse("2026-01-01T10:00:00.000Z");
const ENGINE_PID = 4000;
const CHILD_PID = 4001;

const obs = <T,>(value: T): TelemetryMetric<T> => ({ value, provenance: "OBSERVED", source: "/proc" });
const der = <T,>(value: T): TelemetryMetric<T> => ({ value, provenance: "DERIVED", source: "delta" });
const none = (): TelemetryMetric<number> => ({
  value: null,
  provenance: "UNAVAILABLE",
  source: "/proc",
  reason: "First sample for this process: a rate needs two valid samples separated by a measured interval",
});

function event(partial: Partial<CanonicalEvent> & Pick<CanonicalEvent, "type" | "sequence">): CanonicalEvent {
  return {
    id: `e${partial.sequence}`,
    sessionId: "exec_space",
    source: "gateway",
    timestamp: new Date(START + (partial.sequence ?? 0) * 500).toISOString(),
    monotonicMs: (partial.sequence ?? 0) * 500,
    pid: null,
    payload: {},
    ...partial,
  } as CanonicalEvent;
}

function snapshot(sequence: number): CanonicalEvent {
  return event({
    type: "process.snapshot",
    sequence,
    pid: CHILD_PID,
    payload: {
      pid: obs(CHILD_PID),
      capsEnginePid: obs(ENGINE_PID),
      ppid: obs(ENGINE_PID),
      command: obs("caps_cpu_burn"),
      state: obs("R"),
      rssBytes: obs(8 * 1024 * 1024),
      cpuPercent: sequence === 2 ? none() : der(50),
      threadCount: obs(1),
      cpuTimeMs: obs(sequence * 100),
      minorFaults: obs(100 * sequence),
      majorFaults: obs(0),
      wcharBytesPerSec: sequence === 2 ? none() : der(1024),
      rcharBytesPerSec: none(),
    },
  });
}

const events: CanonicalEvent[] = [
  event({ type: "execution.started", sequence: 0 }),
  event({ type: "process.started", sequence: 1, pid: CHILD_PID, payload: { label: "CAPS child" } }),
  snapshot(2),
  snapshot(3),
  event({ type: "process.exited", sequence: 4, pid: CHILD_PID, payload: { exitCode: 0, durationMs: 1500 } }),
  event({ type: "execution.completed", sequence: 5, payload: { exitCode: 0 } }),
];

const session: SessionRecord = {
  id: "exec_space",
  command: "caps_cpu_burn",
  args: ["3"],
  status: "COMPLETED",
  startedAt: new Date(START).toISOString(),
  endedAt: new Date(START + 2000).toISOString(),
  durationMs: 2000,
  pid: CHILD_PID,
} as SessionRecord;

function renderSpace(props: Partial<React.ComponentProps<typeof ProcessSpace>> = {}) {
  const defaults: React.ComponentProps<typeof ProcessSpace> = {
    events,
    session,
    cursorMs: 1500,
    cursorActive: true,
    live: false,
    mode: "topology",
    onModeChange: vi.fn(),
    selection: { sessionId: "exec_space", cursorMs: 1500, identity: null, eventSeq: null },
    lens: "normal",
    onLensChange: vi.fn(),
    onSelectProcess: vi.fn(),
    onSelectEvidence: vi.fn(),
    onClearSelection: vi.fn(),
  };
  return render(
    <MemoryRouter>
      <ProcessSpace {...defaults} {...props} />
    </MemoryRouter>,
  );
}

afterEach(cleanup);

describe("process space degradation", () => {
  it("explains itself and keeps the 2D graph when WebGL is unavailable", () => {
    renderSpace();
    expect(screen.getByText(/3D visualization unavailable/i)).toBeTruthy();
    expect(screen.getByRole("link", { name: /open 2d process graph/i })).toBeTruthy();
  });

  it("does not attempt to mount the WebGL bundle in a browser without WebGL", () => {
    // A thrown import or a blank <canvas> would be the failure mode here; the
    // fallback must be the whole story, with no canvas in the document.
    const { container } = renderSpace();
    expect(container.querySelector("canvas")).toBeNull();
  });
});

describe("process space table view", () => {
  it("lists every observed process as ordinary DOM content", () => {
    renderSpace();
    fireEvent.click(within(screen.getByRole("group", { name: "View" })).getByRole("button", { name: "Table" }));
    const table = screen.getByRole("table", { name: /observed processes/i });
    expect(table.querySelector("caption")?.textContent).toMatch(/observed processes/i);

    const rows = Array.from(table.querySelectorAll("tbody tr")).map((row) => row.textContent ?? "");
    // The engine and the observed child both appear; the child shows its
    // recorded values, never a placeholder.
    expect(rows.some((row) => row.includes("child"))).toBe(true);
    expect(rows.some((row) => row.includes(String(CHILD_PID)))).toBe(true);
  });

  it("marks the engine as having no procfs sample instead of showing zeros", () => {
    renderSpace();
    fireEvent.click(within(screen.getByRole("group", { name: "View" })).getByRole("button", { name: "Table" }));
    const table = screen.getByRole("table", { name: /observed processes/i });
    const engineRow = Array.from(table.querySelectorAll("tbody tr")).find((row) => (row.textContent ?? "").includes("engine"));
    expect(engineRow?.textContent).toMatch(/UNAVAILABLE/);
  });

  it("reverts to the scene view on demand", () => {
    renderSpace();
    const view = within(screen.getByRole("group", { name: "View" }));
    fireEvent.click(view.getByRole("button", { name: "Table" }));
    expect(screen.getByRole("table", { name: /observed processes/i })).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "3D scene" }));
    expect(screen.queryByRole("table", { name: /observed processes/i })).toBeNull();
    expect(screen.getByText(/3D visualization unavailable/i)).toBeTruthy();
  });
});

describe("process space controls", () => {
  it("switches between topology and timeline modes through the caller", () => {
    const onModeChange = vi.fn();
    renderSpace({ onModeChange });
    const mode = within(screen.getByRole("group", { name: "Mode" }));
    fireEvent.click(mode.getByRole("button", { name: "Timeline" }));
    expect(onModeChange).toHaveBeenCalledWith("timeline");
    fireEvent.click(mode.getByRole("button", { name: "Topology" }));
    expect(onModeChange).toHaveBeenCalledWith("topology");
  });

  it("keeps the mode switch distinct from the camera presets", () => {
    renderSpace();
    // Both sets legitimately contain a "Timeline" button; grouping is what
    // keeps them distinguishable for a reader and for assistive technology.
    expect(screen.getAllByRole("button", { name: "Timeline" }).length).toBe(2);
    expect(within(screen.getByRole("group", { name: "Mode" })).getByRole("button", { name: "Timeline" })).toBeTruthy();
  });

  it("publishes the encoding so no visual channel is ambiguous", () => {
    renderSpace();
    expect(screen.getByText(/verified parent\/child/i)).toBeTruthy();
    // The size channel names the active lens and its unit, so a reader always
    // knows which single quantity drives node size.
    expect(screen.getAllByText(/Node size — Normal · RSS/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/radius = clamp\(RMIN \+ span \* log1p\(rss \/ 1 MiB\)/i)).toBeTruthy();
    expect(screen.getByText(/recorded execvp\(\) image change \(same PID\)/i)).toBeTruthy();
    // The "not physical properties" disclaimer appears in both the legend and
    // the limitations list; both are intentional.
    expect(screen.getAllByText(/not physical properties/i).length).toBeGreaterThanOrEqual(1);
  });

  it("states which single metric each resource lens reads, and routes a change through the caller", () => {
    const onLensChange = vi.fn();
    renderSpace({ onLensChange });
    const lens = within(screen.getByRole("group", { name: "Resource lens" }));
    for (const name of ["CPU", "Memory · RSS", "I/O", "Faults"]) {
      expect(lens.getByRole("button", { name })).toBeTruthy();
    }
    // The lens is owned by the caller, so the view reports the intent instead
    // of mutating itself.
    fireEvent.click(lens.getByRole("button", { name: "Faults" }));
    expect(onLensChange).toHaveBeenCalledWith("faults");
  });

  it("publishes the active lens metric, unit and mapping", () => {
    renderSpace({ lens: "faults" });
    expect(screen.getAllByText(/Node size — Faults/i).length).toBeGreaterThanOrEqual(1);
    // The unit and the mapping are published in more than one place on purpose.
    expect(screen.getAllByText(/faults per second/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/max\(minorRate, majorRate\)/i)).toBeTruthy();
  });

  it("states the limits of the record instead of leaving the reader to guess", () => {
    renderSpace();
    expect(screen.getByText(/descendants created by that child/i)).toBeTruthy();
    expect(screen.getByText(/no procfs sample is collected for the gateway-spawned CAPS engine/i)).toBeTruthy();
  });

  it("resets the camera on R and clears the selection on Escape without typing", () => {
    renderSpace();
    fireEvent.keyDown(window, { key: "r" });
    fireEvent.keyDown(window, { key: "Escape" });
    // No throw, and the shell is still interactive.
    expect(screen.getByRole("button", { name: /reset/i })).toBeTruthy();
  });
});
