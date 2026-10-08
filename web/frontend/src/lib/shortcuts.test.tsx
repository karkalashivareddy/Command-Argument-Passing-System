/**
 * The global shortcut layer, with the presentation's key claims in it.
 *
 * The one assertion that matters here is the collision guard: "P" means "go to
 * Processes" for the whole application and "previous step" inside a presentation.
 * Without the guard a presenter pressing P to step back silently navigates the
 * product out from under the audience, and nothing on screen says why.
 */

import { renderHook } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useUi } from "../store/ui";
import { useShortcuts } from "./shortcuts";

/**
 * `navigate` is captured rather than rendered, so the assertion is "did this
 * keypress ask to navigate anywhere" — which is the whole question — without
 * standing up twenty routes to observe it.
 */
const { navigateMock } = vi.hoisted(() => ({ navigateMock: vi.fn() }));

vi.mock("react-router-dom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router-dom")>();
  return { ...actual, useNavigate: () => navigateMock };
});

function setup() {
  const openHelp = vi.fn();
  renderHook(() => useShortcuts(openHelp), {
    wrapper: ({ children }) => <MemoryRouter>{children}</MemoryRouter>,
  });
  const press = (key: string, init: KeyboardEventInit = {}) => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...init }));
  };
  return { navigateMock, openHelp, press };
}

beforeEach(() => {
  navigateMock.mockClear();
  useUi.setState({ presentation: { open: false, index: 0, paused: false, sessionId: null } });
});

describe("global shortcuts", () => {
  it("navigates the single-letter routes", () => {
    const { navigateMock: nav, press } = setup();
    press("e");
    expect(nav).toHaveBeenCalledWith("/execute");
    press("l");
    expect(nav).toHaveBeenCalledWith("/live");
    press("h");
    expect(nav).toHaveBeenCalledWith("/history");
    press("a");
    expect(nav).toHaveBeenCalledWith("/analytics");
    press("p");
    expect(nav).toHaveBeenCalledWith("/processes");
    press("g");
    expect(nav).toHaveBeenCalledWith("/playground");
  });

  it("opens presentation mode on D", () => {
    const { navigateMock: nav, press } = setup();
    press("d");
    expect(useUi.getState().presentation.open).toBe(true);
    // Opening a presentation is not a navigation, so nothing moved underneath it.
    expect(nav).not.toHaveBeenCalled();
  });

  it("leaves the navigation keys alone while a presentation is open", () => {
    const { navigateMock: nav, press } = setup();
    useUi.getState().openPresentation(true);

    // P is the collision that matters: it is both "Processes" and "previous step".
    press("p");
    press("e");
    press("l");
    press("a");
    press("g");

    expect(nav).not.toHaveBeenCalled();
  });

  it("does not re-toggle the presentation from D while it is already open", () => {
    const { press } = setup();
    useUi.getState().openPresentation(true);
    press("d");
    // Still open: the overlay owns the keyboard, and a stray D mid-presentation
    // must not close the deck the presenter is in the middle of.
    expect(useUi.getState().presentation.open).toBe(true);
  });

  it("still opens help with ? when no presentation is running", () => {
    const { openHelp, press } = setup();
    press("?");
    expect(openHelp).toHaveBeenCalledTimes(1);
  });

  it("does not answer help or navigation while typing in a field", () => {
    const { navigateMock: nav, openHelp } = setup();
    const input = document.createElement("input");
    document.body.append(input);
    input.focus();

    /*
      Dispatched ON THE FIELD, not on window. The real listener sits on window and
      reads `event.target`, so a keystroke must travel through the input to arrive
      with the right target — dispatching straight at window would target window
      and the test would pass for the wrong reason.
    */
    for (const key of ["e", "l", "h", "a", "p", "g", "d", "?"]) {
      input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    }
    expect(nav).not.toHaveBeenCalled();
    expect(openHelp).not.toHaveBeenCalled();
    expect(useUi.getState().presentation.open).toBe(false);
    input.remove();
  });

  it("leaves Ctrl/Cmd+K to the palette", () => {
    const { navigateMock: nav, press } = setup();
    press("k", { ctrlKey: true });
    press("k", { metaKey: true });
    expect(nav).not.toHaveBeenCalled();
    expect(useUi.getState().presentation.open).toBe(false);
  });
});
