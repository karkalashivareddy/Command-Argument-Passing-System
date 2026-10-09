import { useEffect } from "react";
import { useNavigate } from "react-router-dom";

import { useUi } from "../store/ui";

/**
 * Global keyboard shortcuts. E→Execute, L→Live, H→History, A→Analytics,
 * P→Processes, G→Playground, D→Presentation, ?→help modal, Ctrl/Cmd+K→palette
 * Single-letter routes only fire when not typing in an input/textarea/select.
 *
 * WHY THE PRESENTATION SHORTCUT IS HANDLED HERE AND NOT IN THE OVERLAY
 * ---------------------------------------------------------------------
 * Opening is a global concern — the presenter is on some arbitrary page when they
 * decide to start — so the "D" key must be bound once, at the shell, rather than
 * by each surface that happens to be mounted. Closing is different: the overlay
 * owns its own keys, because it has to, since it is a modal that must consume
 * arrows before the page behind can see them.
 */
export function useShortcuts(openHelp?: () => void): void {
  const navigate = useNavigate();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        const { paletteOpen, openPalette } = useUi.getState();
        openPalette(!paletteOpen);
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;

      /*
       * While a presentation is open, the single-letter navigation keys belong to
       * the overlay.
       *
       * This is a collision, not an oversight: "P" is both "go to Processes" and
       * "previous step". Without this guard, a presenter pressing P to step back
       * would silently navigate the product to the Process Explorer, which is the
       * worst possible outcome — the audience would be shown an unrelated page
       * with no explanation. The overlay consumes these keys, and this guard
       * stops the shell from competing for the same press.
       */
      if (useUi.getState().presentation.open) return;

      switch (e.key.toLowerCase()) {
        case "e":
          navigate("/execute");
          break;
        case "l":
          navigate("/live");
          break;
        case "h":
          navigate("/history");
          break;
        case "a":
          navigate("/analytics");
          break;
        case "p":
          navigate("/processes");
          break;
        case "g":
          navigate("/playground");
          break;
        case "d":
          useUi.getState().openPresentation(true);
          break;
        case "?":
          openHelp?.();
          break;
        default:
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate, openHelp]);
}
