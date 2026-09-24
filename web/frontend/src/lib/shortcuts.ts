import { useEffect } from "react";
import { useNavigate } from "react-router-dom";

/**
 * Global keyboard shortcuts. E→Execute, L→Live, H→History, A→Analytics,
 * P→Processes, G→Playground, ?→help modal, Ctrl/Cmd+K→palette (handled by
 * Topbar). Only fires when not typing in an input/textarea/select.
 */
export function useShortcuts(openHelp?: () => void): void {
  const navigate = useNavigate();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === "k" || e.key === "K")) return; // palette
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;

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