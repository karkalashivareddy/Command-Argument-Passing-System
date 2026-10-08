import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CanonicalEvent, SessionRecord, TelemetryMetric } from "../types/observability";
import { useInvestigation } from "../store/investigation";
import ProcessSpacePage from "./ProcessSpacePage";

/**
 * The 3D route as a whole, in jsdom, with no GPU and no network.
 *
 * The point of these checks is the *integrity* of the 3D view: replay is a
 * reconstruction of persisted evidence and must not execute anything or inspect
 * a live PID, and the selection it writes must be the same shared selection the
 * 2D observatory reads.
 */

const SESSION_ID = "exec_replay_3d";
const START = Date.parse("2026-05-01T09:00:00.000Z");
const ENGINE_PID = 7000;
const CHILD_PID = 7001;
const CHILD_START = "2026-05-01T09:00:00.500000Z";

const obs = <T,>(value: T): TelemetryMetric<T> => ({ value, provenance: "OBSERVED", source: "/proc" });
const der = <T,>(value: T): TelemetryMetric<T> => ({ value, provenance: "DERIVED", source: "delta" });
const unavail = <T,>(reason: string): TelemetryMetric<T> => ({ value: null, provenance: "UNAVAILABLE", source: "/proc", reason });

function event(partial: Partial<CanonicalEvent> & Pick<CanonicalEvent, "type" | "sequence">): CanonicalEvent {
  return {
    id: `e${partial.sequence}`,
    sessionId: SESSION_ID,
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
      startTime: obs(CHILD_START),
      rssBytes: obs(6 * 1024 * 1024 * (1 + sequence)),
      cpuPercent: sequence === 2 ? unavail("first sample: a rate needs two samples") : der(20 + sequence),
      minorFaults: obs(100 * sequence),
      majorFaults: obs(0),
      minorFaultsPerSec: sequence === 2 ? unavail("first sample") : der(4 + sequence),
      majorFaultsPerSec: sequence === 2 ? unavail("first sample") : der(0),
      threadCount: obs(1),
    },
  });
}

const events: CanonicalEvent[] = [
  event({ type: "execution.started", sequence: 0 }),
  event({ type: "process.started", sequence: 1, pid: CHILD_PID, payload: { label: "CAPS child" } }),
  snapshot(2),
  snapshot(3),
  snapshot(4),
  event({ type: "process.exited", sequence: 5, pid: CHILD_PID, payload: { exitCode: 0, durationMs: 2500 } }),
  event({ type: "execution.completed", sequence: 6, payload: { exitCode: 0 } }),
];

const session: SessionRecord = {
  id: SESSION_ID,
  command: "caps_cpu_burn",
  args: ["2"],
  status: "COMPLETED",
  startedAt: new Date(START).toISOString(),
  endedAt: new Date(START + 3000).toISOString(),
  durationMs: 3000,
  pid: CHILD_PID,
} as SessionRecord;

const useSessionMock = vi.fn();

vi.mock("../lib/useSession", () => ({
  useSession: (sessionId: string | undefined, opts?: { live?: boolean }) => useSessionMock(sessionId, opts),
}));

/*
 * `vi.hoisted`, not a plain const.
 *
 * This page reaches the keyboard through `useSpaceKeys`, which now reads the
 * presentation state from `store/ui`, which imports `api/client`. So the module
 * graph pulls in `api/client` while it is still being built — above the point a
 * plain `const` would be initialised — and the mock factory below fails with
 * "Cannot access 'apiMock' before initialization". The hoist lifts the
 * declaration above the factory, which is what the factory actually needs.
 */
const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    getSession: vi.fn(),
    replay: vi.fn(),
    execute: vi.fn(),
    terminate: vi.fn(),
    exportJson: vi.fn(),
    exportCsv: vi.fn(),
    report: vi.fn(),
  },
}));

vi.mock("../api/client", () => ({
  api: apiMock,
  ApiError: class ApiError extends Error {},
}));

function renderPage(search: string) {
  return render(
    <MemoryRouter initialEntries={[`/execution/${SESSION_ID}/3d${search}`]}>
      <Routes>
        <Route path="/execution/:id/3d" element={<ProcessSpacePage />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  useSessionMock.mockReturnValue({ session, events, loading: false, error: null, connected: false, ended: true });
  for (const fn of Object.values(apiMock)) fn.mockReset();
  useInvestigation.setState({
    sessionId: null,
    cursorMs: null,
    cursorPinned: false,
    cursorSource: "live",
    identity: null,
    eventSeq: null,
    lens: "normal",
    revision: 0,
  });
});

afterEach(cleanup);

describe("replay integrity on the 3D route", () => {
  it("reconstructs the record without executing anything or inspecting a live PID", () => {
    renderPage("?replay=1");
    expect(screen.getAllByText("REPLAY").length).toBeGreaterThanOrEqual(1);
    // The record is the only input. A replay must not start a process, take a
    // sample, or read /proc, and none of the client calls are made.
    expect(apiMock.execute).not.toHaveBeenCalled();
    for (const call of Object.values(apiMock)) expect(call).not.toHaveBeenCalled();
    expect(screen.getByText(/no process is executed and no PIDs are inspected/i)).toBeTruthy();
  });

  it("does not attach to the live stream while replaying", () => {
    renderPage("?replay=1");
    // Live updates would leak present-time state into a reconstruction of the past.
    expect(useSessionMock).toHaveBeenCalledWith(SESSION_ID, { live: false });
  });

  it("drives the shared cursor, not a private one", () => {
    renderPage("?replay=1");
    const state = useInvestigation.getState();
    // Replay owns the shared cursor from the first frame, and it is attributed
    // to the replay so a page switch does not mistake it for a user seek.
    expect(typeof state.cursorMs).toBe("number");
    expect(state.cursorPinned).toBe(true);
    expect(state.cursorSource).toBe("replay");
  });

  it("moves the shared cursor to the end of the record on jump-to-end", async () => {
    renderPage("?replay=1");
    fireEvent.click(screen.getByRole("button", { name: /jump to end/i }));
    await waitFor(() => {
      // The last event's own recorded offset, plus the panel's inclusive step.
      expect(useInvestigation.getState().cursorMs).toBe(3001);
    });
    expect(useInvestigation.getState().cursorSource).toBe("replay");
    // The scene then holds every event, because they are all inside the cursor.
    const list = within(screen.getByRole("group", { name: "Observed processes; arrow keys move the selection" }));
    expect(list.getAllByRole("button").length).toBeGreaterThanOrEqual(2);
  });

  it("keeps the reader in replay when the camera mode changes", () => {
    renderPage("?replay=1");
    fireEvent.click(within(screen.getByRole("group", { name: "Mode" })).getByRole("button", { name: "Timeline" }));
    // A camera change is not a navigation: the REPLAY badge must survive it.
    expect(screen.getAllByText("REPLAY").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/execution time runs into the screen along the Z axis/i)).toBeTruthy();
  });

  it("toggles the same playback from Space that the on-screen button toggles", () => {
    renderPage("?replay=1");
    expect(screen.getByRole("button", { name: /pause replay/i })).toBeTruthy();
    fireEvent.keyDown(window, { key: " " });
    expect(screen.getByRole("button", { name: /play replay/i })).toBeTruthy();
    fireEvent.keyDown(window, { key: " " });
    expect(screen.getByRole("button", { name: /pause replay/i })).toBeTruthy();
  });
});

describe("the 3D view writes the shared selection", () => {
  it("opens the store session from the route", () => {
    renderPage("");
    expect(useInvestigation.getState().sessionId).toBe(SESSION_ID);
  });

  it("writes a process selection from the ordinary DOM list", () => {
    renderPage("");
    const list = within(screen.getByRole("group", { name: "Observed processes; arrow keys move the selection" }));
    fireEvent.click(list.getByRole("button", { name: new RegExp(String(CHILD_PID)) }));
    const state = useInvestigation.getState();
    // A guarded identity, never a bare PID, and no event invented by the click.
    expect(state.identity).toEqual({ sessionId: SESSION_ID, pid: CHILD_PID, processStartTime: CHILD_START, role: "child" });
    expect(state.eventSeq).toBeNull();
  });

  it("keeps the store lens as the 3D view's only lens", () => {
    renderPage("");
    fireEvent.click(within(screen.getByRole("group", { name: "Resource lens" })).getByRole("button", { name: "CPU" }));
    expect(useInvestigation.getState().lens).toBe("cpu");
  });

  it("clears the evidence selection on Escape without inventing a cursor", () => {
    renderPage("");
    const list = within(screen.getByRole("group", { name: "Observed processes; arrow keys move the selection" }));
    fireEvent.click(list.getByRole("button", { name: new RegExp(String(CHILD_PID)) }));
    expect(useInvestigation.getState().identity).not.toBeNull();

    fireEvent.keyDown(window, { key: "Escape" });
    // Both halves of Escape: the evidence selection and the pinned cursor.
    expect(useInvestigation.getState().identity).toBeNull();
    expect(useInvestigation.getState().eventSeq).toBeNull();
    expect(useInvestigation.getState().cursorMs).toBeNull();
    expect(useInvestigation.getState().cursorPinned).toBe(false);
  });
});
