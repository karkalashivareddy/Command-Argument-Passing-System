import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, loadEnv } from "vite";

/**
 * The gateway this frontend talks to.
 *
 * The browser always calls relative `/api/...` paths, so the gateway is
 * reached through a dev/preview proxy rather than a cross-origin absolute URL.
 * That keeps one origin for REST and for the SSE `EventSource`, which is what
 * lets a reconnect send `Last-Event-ID` without any CORS handling.
 *
 * Resolution order:
 *   1. `CAPS_PROXY_TARGET` in the process environment
 *   2. `CAPS_PROXY_TARGET` in `.env`, `.env.local`, or `.env.<mode>`
 *   3. `http://127.0.0.1:3000`
 *
 * `.env` support matters more than it looks: on a developer machine where
 * 3000 is already taken, the shell variable is easy to lose, and a proxy that
 * silently falls back to the wrong port produces a UI that talks to whatever
 * else is listening there. Reading the same variable through Vite's own
 * env loader makes the value explicit and durable.
 */
function apiProxy(mode: string) {
  const fileEnv = loadEnv(mode, process.cwd(), "CAPS_");
  const target = process.env.CAPS_PROXY_TARGET ?? fileEnv.CAPS_PROXY_TARGET ?? "http://127.0.0.1:3000";
  return {
    target,
    changeOrigin: true,
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: { "/api": apiProxy(mode) },
  },
  // The production build needs the same proxy as the dev server. Without it,
  // `vite preview` serves the bundle with no API route at all, so verifying the
  // built artifact -- what CI and the documentation screenshots both depend on
  // -- is not possible.
  preview: {
    host: "127.0.0.1",
    port: 4173,
    proxy: { "/api": apiProxy(mode) },
  },
  build: {
    // The 3D route is lazy-loaded; its ~994 KiB chunk is only fetched when a
    // reader opens Process Space. Keep a warning on that route-specific budget
    // without treating the shared chart chunk as the same issue.
    chunkSizeWarningLimit: 900,
  },
}));
