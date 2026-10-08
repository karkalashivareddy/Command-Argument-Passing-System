/**
 * The presentation overlay, as a component under test.
 *
 * WHAT THESE CHECK, AND WHY THEY ARE WORTH THE LINES
 * --------------------------------------------------
 * Three properties, each of which has a specific silent failure mode:
 *
 *   1. It does not navigate to a session that does not exist. The component's
 *      honesty claim rests entirely on this, and it is the one thing a reviewer
 *      cannot verify by reading the JSX — the refusal happens in
 *      `destinationFor`, and this test proves the component actually honours that
 *      refusal rather than navigating anyway.
 *   2. PAUSE genuinely stops the auto-advance. A pause that only relabelled a
 *      button would pass every visual review and be useless on stage.
 *   3. It is a real modal: focus moves in, is trapped, Escape exits, and focus
 *      returns to whatever opened it.
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AUTO_ADVANCE_MS, PresentationOverlay } from "./PresentationOverlay";
import { useUi } from "../../store/ui";

/**
 * The clock is faked so the auto-advance timer can be driven deterministically.
 *
 * Real timers would make this a five-second test that is either flaky or slow,
 * and the property under test — that the timer is cleared when paused — is
 * precisely a property of the timer, not of wall-clock time.
 */
const SESSION_ID = "exec_real_1";

/*
 * Declared with `vi.hoisted` because the `vi.mock` factory below is hoisted to
 * the top of the file, above every other statement. A plain `const apiMock` is
 * therefore still in its temporal dead zone when the factory runs, and the module
 * mock fails with "Cannot access 'apiMock' before initialization" — a confusing
 * error that looks like a problem with the component under test.
 */
const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    listSessions: vi.fn(),
    getSession: vi.fn(),
  },
}));

vi.mock("../../api/client", () => ({
  api: apiMock,
  ApiError: class ApiError extends Error {},
}));

function Subject({ initial = "/demo" }: { initial?: string }) {
  return (
    <MemoryRouter initialEntries={[initial]}>
      <Routes>
        <Route path="/" element={<p>overview</p>} />
        <Route path="/execute" element={<p>execute</p>} />
        <Route path="/system" element={<p>system</p>} />
        <Route path="/live" element={<p>live</p>} />
        <Route path="/signals" element={<p>signals</p>} />
        <Route path="/architecture" element={<p>architecture</p>} />
        <Route path="/demo" element={<p>demo</p>} />
        <Route path="/arguments/:id" element={<p>arguments</p>} />
        <Route path="/execution/:id" element={<p>recorder</p>} />
        <Route path="/execution/:id/3d" element={<p>space</p>} />
      </Routes>
      <PresentationOverlay />
      <p>navigation sink</p>
    </MemoryRouter>
  );
}

beforeEach(() => {
  for (const fn of Object.values(apiMock)) fn.mockReset();
  apiMock.listSessions.mockResolvedValue({ sessions: [{ id: SESSION_ID }], total: 1, limit: 1, offset: 0 });
  apiMock.getSession.mockResolvedValue({ id: SESSION_ID, status: "COMPLETED" });
  useUi.setState({
    presentation: { open: false, index: 0, paused: false, sessionId: null },
    paletteOpen: false,
    /*
      `online` by default so the overlay's real-execution button reads "Run …"
      rather than "Engine checking — cannot run". The disabled case is asserted
      explicitly in its own test below, where the engine is forced offline.
    */
    engineState: "online",
  });
  /*
    The overlay's own auto-advance window is 18 seconds of real time. The tests
    below do not wait for it — they assert that it is not scheduled while paused
    and that it IS scheduled while running, by advancing the fake clock.
  */
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function open() {
  act(() => {
    useUi.getState().openPresentation(true);
  });
}

describe("the presentation overlay", () => {
  it("is a labelled modal dialog", () => {
    render(<Subject />);
    open();
    const dialog = screen.getByRole("dialog", { name: "Presentation mode" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
  });

  it("moves focus into the panel on open and restores it on close", async () => {
    render(<Subject />);
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    expect(document.activeElement).toBe(opener);

    open();
    // `Node.contains` rather than a jest-dom matcher: this suite does not load
    // @testing-library/jest-dom, and no dependency may be added for one assertion.
    await waitFor(() => {
      const dialog = screen.getByRole("dialog", { name: "Presentation mode" });
      expect(dialog.contains(document.activeElement)).toBe(true);
    });

    act(() => {
      useUi.getState().openPresentation(false);
    });
    await waitFor(() => {
      expect(document.activeElement).toBe(opener);
    });
    opener.remove();
  });

  it("navigates a host step to its own route with no session at all", async () => {
    apiMock.listSessions.mockResolvedValue({ sessions: [], total: 0, limit: 1, offset: 0 });
    render(<Subject />);
    open();
    // Step 01 is the Overview, a host step.
    await waitFor(() => expect(screen.getByText("overview")).toBeTruthy());
    expect(screen.getByRole("dialog", { name: "Presentation mode" })).toBeTruthy();
  });

  it("refuses to navigate a session step and says why when no session exists", async () => {
    apiMock.listSessions.mockResolvedValue({ sessions: [], total: 0, limit: 1, offset: 0 });
    render(<Subject />);
    open();
    // Step 01 is a host step, so opening the overlay has already navigated to the
    // Overview. The refusal under test is what happens when the deck moves on to a
    // session-scoped step with nothing recorded.
    await waitFor(() => expect(screen.getByText("overview")).toBeTruthy());

    act(() => {
      useUi.getState().setPresentationIndex(2);
    });

    await waitFor(() => expect(screen.getByText(/argument inspector needs a recorded execution/i)).toBeTruthy());
    // The refusal names the command that would create a real session rather than
    // pretending one exists.
    expect(screen.getByRole("button", { name: /run echo presentation session for real/i })).toBeTruthy();
    // Still on the Overview: the session-scoped route was never requested, so
    // there is no recorder rendering a page of UNAVAILABLE under a heading
    // claiming an execution.
    expect(screen.getByText("overview")).toBeTruthy();
    expect(screen.queryByText("arguments")).toBeNull();
  });

  it("resolves a real session and navigates the session step to it", async () => {
    render(<Subject />);
    open();
    await waitFor(() => expect(useUi.getState().presentation.sessionId).toBe(SESSION_ID));

    act(() => {
      useUi.getState().setPresentationIndex(2);
    });
    await waitFor(() => expect(screen.getByText("arguments")).toBeTruthy());
  });

  it("takes the session from the URL when the presenter is already on a recorder", async () => {
    render(<Subject initial={`/execution/${SESSION_ID}/3d`} />);
    open();
    await waitFor(() => expect(useUi.getState().presentation.sessionId).toBe(SESSION_ID));
    // No list call was needed: the session in the address bar demonstrably exists.
    expect(apiMock.listSessions).not.toHaveBeenCalled();
  });

  it("treats a failed session lookup as no session rather than as an empty history", async () => {
    apiMock.listSessions.mockRejectedValue(new Error("gateway unreachable"));
    render(<Subject />);
    open();
    await waitFor(() => expect(useUi.getState().presentation.sessionId).toBeNull());
    act(() => {
      useUi.getState().setPresentationIndex(2);
    });
    // Same refusal as the empty case, because both mean "I have no session".
    expect(screen.getByText(/argument inspector needs a recorded execution/i)).toBeTruthy();
  });

  it("advances and goes back with the keyboard", async () => {
    render(<Subject />);
    open();
    expect(screen.getByText(/01 · WHAT IS CAPS\?/)).toBeTruthy();

    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(useUi.getState().presentation.index).toBe(1);

    fireEvent.keyDown(window, { key: "p" });
    expect(useUi.getState().presentation.index).toBe(0);

    // N and P work as well as the arrows, because a presenter at a lectern types.
    fireEvent.keyDown(window, { key: "n" });
    expect(useUi.getState().presentation.index).toBe(1);
  });

  it("does not move on a modified keystroke", () => {
    render(<Subject />);
    open();
    // Ctrl+N is the browser's new window. It must not be a step.
    fireEvent.keyDown(window, { key: "n", ctrlKey: true });
    fireEvent.keyDown(window, { key: "ArrowRight", metaKey: true });
    expect(useUi.getState().presentation.index).toBe(0);
  });

  it("exits on Escape", () => {
    render(<Subject />);
    open();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(useUi.getState().presentation.open).toBe(false);
  });

  it("traps Tab inside the panel", () => {
    render(<Subject />);
    open();
    const panel = screen.getByRole("dialog", { name: "Presentation mode" });
    const focusable = [...panel.querySelectorAll<HTMLElement>('button:not([disabled])')];
    expect(focusable.length).toBeGreaterThan(1);
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;

    last.focus();
    // Tab from the last focusable wraps to the first, rather than escaping into the
    // visible page behind a dialog the screen reader calls modal.
    fireEvent.keyDown(window, { key: "Tab" });
    expect(document.activeElement).toBe(first);

    first.focus();
    // And Shift+Tab from the first wraps to the last.
    fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it("exits from the panel's own EXIT control", () => {
    render(<Subject />);
    open();
    fireEvent.click(screen.getByRole("button", { name: /exit presentation/i }));
    expect(useUi.getState().presentation.open).toBe(false);
  });

  it("announces the step so a screen reader follows the deck", async () => {
    render(<Subject />);
    open();
    // `aria-live="polite"` on the heading/sentence block: the step changes
    // without focus moving, so without it the change is silent for a reader.
    const title = await screen.findByText(/01 · WHAT IS CAPS\?/);
    const region = title.closest("[aria-live]");
    expect(region?.getAttribute("aria-live")).toBe("polite");
  });

  it("keeps the step-progress bar out of the accessibility tree", () => {
    render(<Subject />);
    open();
    // It measures the presenter's timer, not the product. Announcing it would
    // invite a reader to interpret a timing value as a lifecycle stage, which is
    // the exact confusion this product cannot afford.
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("clamps BACK at the first step and NEXT at the last", () => {
    render(<Subject />);
    open();
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    expect(useUi.getState().presentation.index).toBe(0);

    act(() => {
      useUi.getState().setPresentationIndex(11);
    });
    // The Next button is disabled at step 12, and BACK still works.
    expect(screen.getByRole("button", { name: /^next$/i }).hasAttribute("disabled")).toBe(true);
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    expect(useUi.getState().presentation.index).toBe(10);
  });

  it("really stops auto-advancing while paused, and resumes on demand", () => {
    // requestAnimationFrame is stubbed so the timer can be driven by hand. If the
    // overlay ever stopped using a frame loop for its progress this test would
    // fail loudly rather than pass vacuously, because the stub is asserted on.
    /*
      The frame queue, plus the set of ids that were cancelled.

      Cancelling has to actually REMOVE the callback, not merely record that it was
      requested: a stub whose cancelAnimationFrame is a no-op leaves cancelled
      frames runnable, and then a test that pumps the queue is testing its own stub
      rather than the overlay. `cancel` deletes from `frames`, so a paused overlay
      has nothing left to run — which is the real browser semantics.
    */
    const frames = new Map<number, (t: number) => void>();
    let nextId = 1;
    const rafSpy = vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation((cb: FrameRequestCallback) => {
      const id = nextId++;
      frames.set(id, cb);
      return id;
    });
    const cafSpy = vi.spyOn(globalThis, "cancelAnimationFrame").mockImplementation((id: number) => {
      frames.delete(id);
    });

    /**
     * Run every queued frame once, clearing each as it is consumed.
     *
     * Deleting on consumption matters: the browser will not hand back a frame it
     * has already run, so a harness that does would let a stale callback advance
     * the deck a second time and the failure would be the harness's, not the
     * component's.
     */
    const pump = (): number => {
      act(() => {
        for (const [id, cb] of [...frames]) {
          frames.delete(id);
          cb(performance.now());
        }
      });
      return frames.size;
    };

    render(<Subject />);
    open();
    expect(rafSpy, "the overlay must drive its progress from a frame loop").toHaveBeenCalled();
    expect(frames.size, "a running overlay has a live frame queued").toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: /^pause$/i }));
    expect(useUi.getState().presentation.paused).toBe(true);
    // Re-queried rather than holding the node: React replaced the button when the
    // label flipped to "Resume", so the old reference is detached.
    expect(screen.getByRole("button", { name: /^resume$/i }).getAttribute("aria-pressed")).toBe("true");

    /*
      This is the assertion that distinguishes a real pause from a relabelled
      button. The pause tore the frame loop down, so there is nothing left for the
      pump to run, no matter how far the clock would have moved.
    */
    expect(frames.size, "pausing must cancel the progress frame loop").toBe(0);
    expect(pump(), "a paused overlay must not schedule another frame").toBe(0);
    // And the step is unmoved: with no live loop there is no path that reaches the
    // advance, so the timer really is stopped rather than merely hidden.
    expect(useUi.getState().presentation.index).toBe(0);

    // The caption states what pause did, rather than just flipping a label.
    expect(screen.getByText(/paused: the step timer and its progress animation are stopped/i)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /^resume$/i }));
    expect(useUi.getState().presentation.paused).toBe(false);
    expect(frames.size, "resuming must restart the progress frame loop").toBeGreaterThan(0);

    rafSpy.mockRestore();
    cafSpy.mockRestore();
  });

  it("advances by itself once the whole step window has elapsed", () => {
    /*
      The complement of the pause test: without this one, "paused stops the timer"
      would also be satisfied by a timer that never fires at all.
    */
const frames = new Map<number, (t: number) => void>();
    let nextId = 1;
    let clock = 1_000;
    vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation((cb: FrameRequestCallback) => {
      const id = nextId++;
      frames.set(id, cb);
      return id;
    });
    vi.spyOn(globalThis, "cancelAnimationFrame").mockImplementation((id: number) => {
      frames.delete(id);
    });
    vi.spyOn(performance, "now").mockImplementation(() => clock);

    /*
      Run exactly one frame, and clear it from the queue as it is consumed.
      Leaving a consumed callback in the map would let a later pump invoke a frame
      that has already run — the browser does not do that, so the harness must not
      either, or the second pump advances the deck twice and the test fails for a
      reason that has nothing to do with the component.
    */
    const stepOnce = (): void => {
      act(() => {
        for (const [id, cb] of [...frames]) {
          frames.delete(id);
          cb(clock);
        }
      });
    };

    render(<Subject />);
    open();
    expect(useUi.getState().presentation.index).toBe(0);

    // Not quite a full window: still on step 1.
    clock += AUTO_ADVANCE_MS - 1;
    stepOnce();
    expect(useUi.getState().presentation.index).toBe(0);

    // Past the window: the deck moves on its own.
    clock += 2;
    stepOnce();
    expect(useUi.getState().presentation.index).toBe(1);

    vi.useRealTimers();
  });

  it("clears a pause whenever the presenter steps manually", () => {
    render(<Subject />);
    open();
    fireEvent.click(screen.getByRole("button", { name: /^pause$/i }));
    expect(useUi.getState().presentation.paused).toBe(true);
    fireEvent.keyDown(window, { key: "ArrowRight" });
    // Stepping is an explicit instruction, so the timer restarts with the new
    // step's full duration rather than staying frozen at an arbitrary point.
    expect(useUi.getState().presentation.paused).toBe(false);
  });

  it("jumps straight to a step from the rail", async () => {
    render(<Subject />);
    open();
    fireEvent.click(screen.getByRole("button", { name: "07" }));
    expect(useUi.getState().presentation.index).toBe(6);
    expect(screen.getByText(/07 · PROCFS/)).toBeTruthy();
    // Step 07 is PROCFS, a host step, so it resolves without any session.
    await waitFor(() => expect(screen.getByText("system")).toBeTruthy());
  });

  it("disables RUN when the engine is not online rather than firing a doomed request", async () => {
    useUi.setState({ engineState: "offline" });
    apiMock.listSessions.mockResolvedValue({ sessions: [], total: 0, limit: 1, offset: 0 });
    render(<Subject />);
    open();
    act(() => {
      useUi.getState().setPresentationIndex(2);
    });
    const run = screen.getByRole("button", { name: /engine offline — cannot run/i });
    expect(run.hasAttribute("disabled")).toBe(true);
  });
});
