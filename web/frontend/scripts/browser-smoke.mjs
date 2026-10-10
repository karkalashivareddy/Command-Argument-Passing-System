import { chromium } from "playwright";

const frontend = process.env.CAPS_BROWSER_FRONTEND ?? "http://127.0.0.1:4173";
const gateway = process.env.CAPS_BROWSER_GATEWAY ?? "http://127.0.0.1:3000";
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CAPS_BROWSER_EXECUTABLE ? { executablePath: process.env.CAPS_BROWSER_EXECUTABLE } : {}),
});

function check(condition, message) {
  if (!condition) throw new Error(message);
  console.log(`PASS: ${message}`);
}

try {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  const response = await page.goto(frontend, { waitUntil: "networkidle" });
  check(response?.ok(), "the production frontend opened in Chromium");
  await page.getByRole("button", { name: "Toggle sidebar" }).waitFor();

  await page.keyboard.press("Tab");
  const visibleFocus = await page.evaluate(() => {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement)) return false;
    const style = getComputedStyle(active);
    return style.outlineStyle !== "none" && Number.parseFloat(style.outlineWidth) > 0;
  });
  check(visibleFocus, "keyboard navigation exposes a visible focus ring");

  await page.setViewportSize({ width: 390, height: 844 });
  const menu = page.getByRole("button", { name: "Toggle sidebar" });
  await menu.click();
  const dialog = page.getByRole("dialog", { name: "Navigation" });
  await dialog.waitFor();
  check(await dialog.isVisible(), "the mobile navigation opens as a dialog");
  check(await dialog.evaluate((element) => element === document.activeElement), "opening mobile navigation moves focus into the dialog");
  const reducedMotionAnimating = await dialog.evaluate((element) =>
    element.getAnimations().some((animation) =>
      animation.playState === "running" && (animation.effect?.getComputedTiming().duration ?? 0) > 0,
    ),
  );
  check(!reducedMotionAnimating, "reduced motion suppresses the mobile navigation transition");

  const links = dialog.locator("a[href]");
  const firstLink = links.first();
  const lastLink = links.last();
  await page.keyboard.press("Tab");
  check(await firstLink.evaluate((element) => element === document.activeElement), "Tab enters the mobile navigation at its first link");
  await page.keyboard.press("Shift+Tab");
  check(await lastLink.evaluate((element) => element === document.activeElement), "Shift+Tab wraps within the mobile navigation");
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  check(await menu.evaluate((element) => element === document.activeElement), "closing mobile navigation restores focus to its opener");
  check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "the mobile page has no horizontal overflow");

  await menu.click();
  await dialog.getByRole("link", { name: "Architecture" }).click();
  await page.waitForURL("**/architecture");
  try {
    await page.getByRole("heading", { name: "How a command travels to the kernel" }).waitFor();
  } catch (error) {
    throw new Error(
      `architecture route did not render its heading (url=${page.url()}, pageErrors=${JSON.stringify(pageErrors)}, body=${JSON.stringify((await page.locator("body").innerText()).slice(0, 1000))})`,
      { cause: error },
    );
  }
  await page.goBack();
  await page.waitForURL("**/");
  check(await page.getByRole("button", { name: "Toggle sidebar" }).count() === 1, "browser Back restores the prior route");

  const created = await fetch(`${gateway}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ command: "echo", args: ["browser-smoke"] }),
  });
  check(created.status === 202, "the browser smoke created a real execution through the gateway");
  const { sessionId } = await created.json();
  let ended = false;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const record = await fetch(`${gateway}/api/sessions/${sessionId}`);
    if (!record.ok) throw new Error(`session lookup failed: ${record.status}`);
    const session = await record.json();
    if (["COMPLETED", "FAILED", "TIMED_OUT", "CANCELLED"].includes(session.status)) {
      ended = session.status === "COMPLETED";
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  check(ended, "the real CAPS execution completed successfully");

  await context.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (kind, ...args) {
      if (kind === "webgl" || kind === "webgl2" || kind === "experimental-webgl") return null;
      return original.call(this, kind, ...args);
    };
  });
  await page.goto(`${frontend}/execution/${sessionId}/3d`, { waitUntil: "networkidle" });
  await page.getByText("3D visualization unavailable", { exact: true }).waitFor();
  check(await page.getByRole("link", { name: /open 2d process graph/i }).isVisible(), "WebGL failure leaves a usable 2D process graph link");
  check(await page.getByText("PROCESS LINEAGE", { exact: true }).isVisible(), "WebGL failure renders the same recorded process evidence in 2D");
  await page.getByRole("link", { name: /open 2d process graph/i }).click();
  await page.waitForURL(`**/execution/${sessionId}`);
  check(await page.getByText("PROCESS LINEAGE", { exact: true }).isVisible(), "the 2D route opens from the WebGL fallback");

  check(pageErrors.length === 0, `the browser reported no uncaught page errors${pageErrors.length ? `: ${pageErrors.join("; ")}` : ""}`);
  console.log("BROWSER SMOKE SUITE PASSED");
} finally {
  await browser.close();
}
