import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useUi } from "../../store/ui";
import { useSpaceKeys } from "./useSpaceKeys";

/**
 * Cursor shortcuts must only ever move to a time the record contains, and must
 * stay out of the way of the app-wide single-letter shortcuts and of typing.
 */
function setup(options: Partial<Parameters<typeof useSpaceKeys>[0]> = {}) {
  const onSeek = vi.fn();
  const onClear = vi.fn();
  const onTogglePlay = vi.fn();
  const sampleTimes = [0, 500, 1000];
  const view = renderHook(() =>
    useSpaceKeys({
      playing: true,
      onTogglePlay,
      cursorMs: 500,
      sampleTimes,
      onSeek,
      onClear,
      live: false,
      ...options,
    }),
  );
  const press = (key: string, init: KeyboardEventInit = {}) => {
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...init }));
    });
  };
  return { onSeek, onClear, onTogglePlay, sampleTimes, view, press };
}

beforeEach(() => {
  /*
    The presentation overlay is a modal and claims the arrow keys, Escape and the
    single-letter navigation keys while it is open. Step 09 of its script lands on
    this very route, so the default here is "closed" — and it is set explicitly
    rather than left to module state, so one test cannot leak a presentation into
    the next one's Escape handling.
  */
  useUi.setState({ presentation: { open: false, index: 0, paused: false, sessionId: null } });
});

afterEach(() => {
  useUi.setState({ presentation: { open: false, index: 0, paused: false, sessionId: null } });
});

describe("process space cursor shortcuts", () => {
  it("steps forward to the next recorded sample", () => {
    const { onSeek, press } = setup();
    press("ArrowRight");
    expect(onSeek).toHaveBeenCalledWith(1000);
  });

  it("steps backward to the previous recorded sample", () => {
    const { onSeek, press } = setup({ cursorMs: 1000 });
    press("ArrowLeft");
    expect(onSeek).toHaveBeenCalledWith(500);
  });

  it("never steps past the ends of the record", () => {
    const atEnd = setup({ cursorMs: 1000 });
    atEnd.press("ArrowRight");
    expect(atEnd.onSeek).not.toHaveBeenCalled();

    const atStart = setup({ cursorMs: 0 });
    atStart.press("ArrowLeft");
    expect(atStart.onSeek).not.toHaveBeenCalled();
  });

  it("does not step in live mode, where the cursor follows the newest evidence", () => {
    const { onSeek, press } = setup({ live: true });
    press("ArrowRight");
    press("ArrowLeft");
    expect(onSeek).not.toHaveBeenCalled();
  });

  it("toggles playback with Space and releases the cursor with Escape", () => {
    const { onClear, onTogglePlay, press } = setup();
    press(" ");
    press("Escape");
    expect(onTogglePlay).toHaveBeenCalledTimes(1);
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it("leaves the app-wide single-letter shortcuts alone", () => {
    const { onClear, onSeek, onTogglePlay, press } = setup();
    for (const key of ["e", "l", "h", "a", "p", "g", "k", "?"]) press(key);
    expect(onSeek).not.toHaveBeenCalled();
    expect(onClear).not.toHaveBeenCalled();
    expect(onTogglePlay).not.toHaveBeenCalled();
  });

  it("ignores modified keystrokes", () => {
    const { onTogglePlay, press } = setup();
    press(" ", { ctrlKey: true });
    press(" ", { metaKey: true });
    expect(onTogglePlay).not.toHaveBeenCalled();
  });

  it("ignores keystrokes aimed at a form field", () => {
    const { onTogglePlay } = setup();
    const input = document.createElement("input");
    document.body.append(input);
    act(() => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
    });
    expect(onTogglePlay).not.toHaveBeenCalled();
    input.remove();
  });

  it("stands down entirely while a presentation is open", () => {
    /*
      The overlap is real, not hypothetical: presentation step 09 navigates to
      /execution/<id>/3d, so a presenter's Right arrow would both advance the deck
      and move the replay cursor, and Escape would clear the selection instead of
      exiting. The overlay is the modal here and owns these keys outright.
    */
    const { onClear, onSeek, onTogglePlay, press } = setup();
    useUi.setState({ presentation: { open: true, index: 8, paused: false, sessionId: "exec_1" } });

    press("ArrowRight");
    press("ArrowLeft");
    press(" ");
    press("Escape");

    expect(onSeek).not.toHaveBeenCalled();
    expect(onTogglePlay).not.toHaveBeenCalled();
    expect(onClear).not.toHaveBeenCalled();
    // And the deck is where it was: the 3D view did not step the presentation.
    expect(useUi.getState().presentation.index).toBe(8);
  });

it("resumes taking keys once the presentation closes", () => {
    const { onClear, press } = setup();
    useUi.setState({ presentation: { open: true, index: 8, paused: false, sessionId: "exec_1" } });
    press("Escape");
    expect(onClear).not.toHaveBeenCalled();

    useUi.setState({ presentation: { open: false, index: 8, paused: false, sessionId: "exec_1" } });
    press("Escape");
    expect(onClear).toHaveBeenCalledTimes(1);
  });

it("unregisters its listener on unmount", () => {
    const { onSeek, view, press } = setup();
    view.unmount();
    press("ArrowRight");
    expect(onSeek).not.toHaveBeenCalled();
  });
});
