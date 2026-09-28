import { useEffect, useState } from "react";

/**
 * WebGL capability probe. Runs once, before any three.js code, so an
 * unsupported browser gets an explanation and a 2D fallback instead of a blank
 * canvas or a thrown error.
 */
export function detectWebGL(): { supported: boolean; reason: string | null } {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return { supported: false, reason: "No browser environment is available to create a WebGL context." };
  }
  try {
    const canvas = document.createElement("canvas");
    const context =
      canvas.getContext("webgl2") ??
      canvas.getContext("webgl") ??
      canvas.getContext("experimental-webgl");
    if (context === null) {
      return {
        supported: false,
        reason: "This browser could not create a WebGL context. Hardware acceleration may be disabled, or the device may not support WebGL.",
      };
    }
    // Release the probe context immediately: browsers cap live contexts.
    const lose = (context as WebGLRenderingContext).getExtension("WEBGL_lose_context");
    lose?.loseContext();
    return { supported: true, reason: null };
  } catch (error) {
    return { supported: false, reason: `The WebGL capability probe threw: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** Respects the operating-system reduced-motion preference. */
export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(prefersReducedMotion);
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = (event: MediaQueryListEvent) => setReduced(event.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return reduced;
}
