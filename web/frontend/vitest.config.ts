import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    // Both locations, deliberately.
    //
    // Co-located `src/**/*.test.ts` files sit next to the module they cover,
    // which is where a reader looks first. A separate `tests/` tree keeps
    // cross-cutting suites -- the terminal's rendering rules, the process
    // explorer's state model -- visibly separate from unit tests of one file.
    //
    // Only `src` was included before, so a test written under `tests/` was
    // silently never run: a green suite that proved less than it appeared to.
    include: ["src/**/*.test.{ts,tsx}", "tests/**/*.test.{ts,tsx}"],
    setupFiles: ["src/test/setup.ts"],
    globals: false,
  },
});
