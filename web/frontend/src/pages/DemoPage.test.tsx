/**
 * The DemoPage, against a mocked gateway.
 *
 * WHY THIS PAGE EARNS A SUITE
 * ---------------------------
 * It is the surface a faculty member will click first and trust most, and it
 * makes the strongest claim in the product: eight rows of claims about what will
 * be observed. The two failure modes worth guarding are
 *
 *   1. a row rendering as though it had run when it had not, and
 *   2. a RUN button firing for a command the gateway has already said is
 *      unavailable on this host.
 *
 * Both are cheap to assert and both would be discovered on stage.
 */

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useExecution } from "../store/execution";
import { useUi } from "../store/ui";
import DemoPage from "./DemoPage";

/*
 * `vi.hoisted` because DemoPage imports `../api/client` and `../api/observability`
 * directly, and those imports run above a plain `const` would be initialised.
 */
const { apiMock, catalogApiMock } = vi.hoisted(() => ({
  apiMock: {
    createSession: vi.fn(),
    getSession: vi.fn(),
    replay: vi.fn(),
  },
  catalogApiMock: {
    catalog: vi.fn(),
  },
}));

vi.mock("../api/client", () => ({
  api: apiMock,
  ApiError: class ApiError extends Error {},
}));

vi.mock("../api/observability", () => ({
  catalogApi: catalogApiMock,
}));

/*
 * The live-event strip at the foot of the page subscribes to /api/live/stream
 * through a native EventSource, which jsdom does not implement. Stubbing it with
 * a class that does nothing keeps the component's connection state at "connecting"
 * and therefore stops the status-poll loop — which is exactly the state a real
 * gateway that is not streaming would be in, and the state every assertion here
 * about "no fabricated run" needs.
 */
class StubEventSource {
  static readonly CONNECTING = 0;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  addEventListener(): void {}
  removeEventListener(): void {}
  close(): void {}
}
globalThis.EventSource = StubEventSource as unknown as typeof EventSource;

/** The probe the gateway would return for a healthy host with `make` run. */
function catalogEntry(name: string, available: boolean) {
  return {
    name,
    category: "demonstration",
    availability: available ? ("AVAILABLE" as const) : ("UNAVAILABLE" as const),
    reason: available ? `resolved from /usr/bin/${name}` : `${name} is not built`,
    resolvedPath: available ? `/usr/bin/${name}` : null,
    readOnly: true,
  };
}

const ALL_AVAILABLE = [
  "echo",
  "sleep",
  "status_probe",
  "caps_cpu_burn",
  "caps_memory_burn",
  "caps_io_burn",
  "caps_mixed_burn",
  "caps_fork_tree",
].map((n) => catalogEntry(n, true));

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/demo"]}>
      <DemoPage />
    </MemoryRouter>,
  );
}

/** The row for one preset, found by its row header rather than by position. */
function rowFor(label: string): HTMLElement {
  const header = screen.getByRole("rowheader", { name: new RegExp(`^${label}`) });
  const row = header.closest("tr");
  if (row === null) throw new Error(`${label} row header has no row`);
  return row as HTMLElement;
}

beforeEach(() => {
  for (const fn of Object.values(apiMock)) fn.mockReset();
  for (const fn of Object.values(catalogApiMock)) fn.mockReset();

  catalogApiMock.catalog.mockResolvedValue({
    version: "1",
    summary: { total: ALL_AVAILABLE.length, available: ALL_AVAILABLE.length, unavailable: 0, blocked: 0 },
    commands: ALL_AVAILABLE,
    refusedByPolicy: [],
    trustedDirectories: ["/usr/bin"],
  });

  apiMock.createSession.mockImplementation(async (req: { command: string }) => ({
    sessionId: `exec_${req.command}`,
    status: "STARTING",
    eventsUrl: "/api/sessions/x/events",
    argvPreview: [req.command],
  }));
  apiMock.getSession.mockResolvedValue({
    id: "exec_echo",
    command: "echo",
    status: "COMPLETED",
    exitCode: 0,
    signal: null,
    durationMs: 4,
    eventCount: 5,
    stdout: "Hello from CAPS\n",
    stderr: "",
  });
  apiMock.replay.mockResolvedValue({
    sessionId: "exec_echo",
    events: [
      { type: "process.started", id: "e1" },
      { type: "process.exited", id: "e2" },
    ],
  });

  // `createSession` is the only call `begin` makes, and the execution store is
  // module state shared across tests in this file.
  useExecution.setState({ sessionId: null, events: [], connection: "idle", connectionError: null });
  useUi.setState({ engineState: "online", engineDetail: "", presentation: { open: false, index: 0, paused: false, sessionId: null } });
});

afterEach(cleanup);

describe("the demo page", () => {
  it("lists exactly eight presets, one row each", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("HELLO")).toBeTruthy());
    for (const label of ["HELLO", "CPU", "MEMORY", "I/O", "FORK TREE", "MIXED", "TIMEOUT", "FAILURE"]) {
      expect(screen.getByRole("rowheader", { name: new RegExp(`^${label}`) })).toBeTruthy();
    }
  });

  it("starts empty: no row claims a run that has not happened", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("HELLO")).toBeTruthy());
    for (const label of ["HELLO", "CPU", "TIMEOUT", "FAILURE"]) {
      expect(within(rowFor(label)).getByText("not run")).toBeTruthy();
    }
    // And nothing was executed to produce that state.
    expect(apiMock.createSession).not.toHaveBeenCalled();
  });

  it("states the exact argv and the timeout for every preset", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("HELLO")).toBeTruthy());
    // The argv is shown verbatim rather than summarised, because a presenter
    // should be able to read the command they are about to run.
    expect(within(rowFor("HELLO")).getByText("echo Hello from CAPS")).toBeTruthy();
    expect(within(rowFor("TIMEOUT")).getByText("sleep 30")).toBeTruthy();
    expect(within(rowFor("TIMEOUT")).getByText("timeout · 3000 ms")).toBeTruthy();
  });

  it("shows each preset's unavailable list with its reason", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("HELLO")).toBeTruthy());
    const hello = rowFor("HELLO");
    // The provenance badge says UNAVAILABLE and the reason is on screen, rather
    // than a metric silently missing from the row.
    expect(within(hello).getAllByText("UNAVAILABLE").length).toBeGreaterThan(0);
    expect(within(hello).getByText(/records NO process\.snapshot at all/i)).toBeTruthy();
  });

  it("runs a preset with one click and records the real session", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("HELLO")).toBeTruthy());

    fireEvent.click(within(rowFor("HELLO")).getByRole("button", { name: /RUN/i }));

    await waitFor(() => {
      expect(apiMock.createSession).toHaveBeenCalledWith({
        command: "echo",
        args: ["Hello", "from", "CAPS"],
        redirections: {},
        timeoutMs: 10_000,
      });
    });
    await waitFor(() => {
      expect(within(rowFor("HELLO")).getByRole("button", { name: /open recorder/i })).toBeTruthy();
    });
  });

  it("reports the recorded outcome rather than a fabricated one", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("HELLO")).toBeTruthy());
    fireEvent.click(within(rowFor("HELLO")).getByRole("button", { name: /RUN/i }));
    await waitFor(() => {
      expect(within(rowFor("HELLO")).getByRole("button", { name: /open recorder/i })).toBeTruthy();
    });
    // Exit code, event count and snapshot count all come from the gateway's
    // response. The snapshot count is 0 here because the mocked replay contains
    // none — and it must render as a number, not as an empty cell.
    const row = rowFor("HELLO");
    expect(within(row).getByText("exit 0")).toBeTruthy();
    expect(within(row).getByText(/snapshots/)).toBeTruthy();
  });

  it("refuses to offer RUN for a command the gateway says is unavailable", async () => {
    // `status_probe` is a repository helper: present only after `make`. A demo
    // script that offered it on a host without it would produce a 4xx on stage.
    catalogApiMock.catalog.mockResolvedValue({
      version: "1",
      summary: { total: 1, available: 0, unavailable: 1, blocked: 0 },
      commands: [
        ...ALL_AVAILABLE.filter((c) => c.name !== "status_probe"),
        catalogEntry("status_probe", false),
      ],
      refusedByPolicy: [],
      trustedDirectories: ["/usr/bin"],
    });

    renderPage();
    await waitFor(() => expect(screen.getByText("FAILURE")).toBeTruthy());

    const run = within(rowFor("FAILURE")).getByRole("button", { name: /RUN/i });
    expect(run.hasAttribute("disabled")).toBe(true);
    // And the reason is on the row, not only in a tooltip.
    expect(within(rowFor("FAILURE")).getByText(/not available here/i)).toBeTruthy();

    fireEvent.click(run);
    expect(apiMock.createSession).not.toHaveBeenCalled();
  });

  it("disables RUN when the catalog has not answered, rather than guessing", async () => {
    catalogApiMock.catalog.mockImplementation(() => new Promise(() => {}));
    renderPage();
    await waitFor(() => expect(screen.getByText("HELLO")).toBeTruthy());
    expect(within(rowFor("HELLO")).getByRole("button", { name: /RUN/i }).hasAttribute("disabled")).toBe(true);
    expect(within(rowFor("HELLO")).getByText(/availability unknown/i)).toBeTruthy();
  });

  it("disables RUN when the engine is not online", async () => {
    useUi.setState({ engineState: "offline" });
    renderPage();
    await waitFor(() => expect(screen.getByText("HELLO")).toBeTruthy());
    expect(within(rowFor("HELLO")).getByRole("button", { name: /RUN/i }).hasAttribute("disabled")).toBe(true);
    expect(apiMock.createSession).not.toHaveBeenCalled();
  });

  it("surfaces a gateway refusal as an error rather than a silent empty row", async () => {
    apiMock.createSession.mockRejectedValue(new Error("Command \"echo\" is not on the allowlist."));
    renderPage();
    await waitFor(() => expect(screen.getByText("HELLO")).toBeTruthy());
    fireEvent.click(within(rowFor("HELLO")).getByRole("button", { name: /RUN/i }));
    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toMatch(/not on the allowlist/);
    });
  });

  it("runs all eight in order rather than in parallel", async () => {
    const order: string[] = [];
    apiMock.createSession.mockImplementation(async (req: { command: string }) => {
      order.push(req.command);
      return { sessionId: `exec_${order.length}`, status: "STARTING", eventsUrl: "", argvPreview: [] };
    });

    renderPage();
    await waitFor(() => expect(screen.getByText("HELLO")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /run all eight/i }));

    await waitFor(() => expect(order.length).toBe(8));
    // Sequential: the concurrency ceiling in `capabilities.limits.maxConcurrent`
    // refuses rather than queues, so eight parallel requests would produce a row
    // of refusals rather than a demonstration.
    expect(order).toEqual([
      "echo",
      "caps_cpu_burn",
      "caps_memory_burn",
      "caps_io_burn",
      "caps_fork_tree",
      "caps_mixed_burn",
      "sleep",
      "status_probe",
    ]);
  });

  it("offers re-probing the real filesystem", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("HELLO")).toBeTruthy());
    catalogApiMock.catalog.mockClear();
    fireEvent.click(screen.getByRole("button", { name: /re-probe/i }));
    await waitFor(() => expect(catalogApiMock.catalog).toHaveBeenCalledTimes(1));
  });
});