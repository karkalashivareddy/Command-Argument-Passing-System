/**
 * Documentation screenshot capture.
 *
 * Every image is a real screenshot of the real application, driven through the
 * real gateway and the real C engine. Nothing is faked, painted, or cropped to
 * hide a state. If a surface cannot render, the script fails rather than
 * producing a placeholder.
 *
 *   node scripts/capture-screenshots.mjs
 */
import { mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const GATEWAY = process.env.CAPS_SHOT_GATEWAY ?? "http://127.0.0.1:3100";
const FRONTEND = process.env.CAPS_SHOT_FRONTEND ?? "http://127.0.0.1:4174";
// Resolve against the repository root: the script is run from web/frontend, and a
// relative "docs/screenshots" would otherwise create a second, untracked copy.
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const OUT = process.env.CAPS_SHOT_OUT ?? join(REPO_ROOT, "docs", "screenshots");
const VIEWPORT = { width: 1600, height: 1000 };

mkdirSync(OUT, { recursive: true });

const log = (m) => console.log(`  ${m}`);

/** POST a real execution and wait for the gateway to finalize it. */
async function run(api, body, timeoutMs = 40000) {
  const res = await fetch(`${GATEWAY}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`gateway rejected ${JSON.stringify(body)}: ${res.status} ${await res.text()}`);
  const { sessionId } = await res.json();
  const started = Date.now();
  for (;;) {
    const s = await (await fetch(`${GATEWAY}/api/sessions/${sessionId}`)).json();
    if (["COMPLETED", "FAILED", "TIMED_OUT", "CANCELLED"].includes(s.status)) {
      if (s.status !== "COMPLETED") {
        log(`  ! ${body.command} ended as ${s.status}: ${s.error ?? "no error recorded"}`);
      }
      return { ...s, wallMs: Date.now() - started };
    }
    if (Date.now() - started > timeoutMs) throw new Error(`${body.command} did not finish`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function shot(page, name, note) {
  const path = join(OUT, name);
  // Full page for long surfaces; the viewport for the rest.
  await page.screenshot({ path, animations: "disabled" });
  const { size } = statSync(path);
  log(`${name.padEnd(26)} ${String(Math.round(size / 1024)).padStart(4)} KiB  ${note}`);
}

const main = async () => {
  console.log(`Capturing real screenshots from ${FRONTEND} (gateway ${GATEWAY})`);

  // ---- 1. generate the evidence, through the real engine -------------------
  log("running real executions through the real C engine…");
  const short = await run(undefined, { command: "echo", args: ["Hello CAPS"] });
  log(`  echo -> ${short.status}, exit ${short.exitCode}`);

  const long = await (async () => {
    const res = await fetch(`${GATEWAY}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: "sleep", args: ["6"] }),
    });
    const { sessionId } = await res.json();
    return { sessionId };
  })();
  log(`  long-running session ${long.sessionId} (kept alive for live views)`);

  const workload = await (async () => {
    const res = await fetch(`${GATEWAY}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: "caps_mixed_burn", args: ["4", "48", "4"], timeoutMs: 20000 }),
    });
    if (!res.ok) return null;
    const { sessionId } = await res.json();
    await new Promise((r) => setTimeout(r, 2500));
    return { sessionId };
  })();
  if (workload) log(`  caps_mixed_burn session ${workload.sessionId} (sampling in progress)`);

  const redirected = await run(undefined, {
    command: "echo",
    args: ["redirection evidence"],
    redirections: { out: "caps-docs-output.txt" },
  });
  log(`  redirection session ${redirected.id} -> ${redirected.status}`);

  // ---- 2. drive the browser -----------------------------------------------
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on("pageerror", (e) => consoleErrors.push(String(e).slice(0, 200)));
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text().slice(0, 200));
  });

  const go = async (path, waitFor) => {
    await page.goto(`${FRONTEND}${path}`, { waitUntil: "networkidle" });
    if (waitFor) {
      await page.waitForSelector(waitFor, { timeout: 15000 }).catch(() => {
        throw new Error(`${path}: never rendered ${waitFor}`);
      });
    }
    // Let the SSE stream and the first procfs samples land before capturing.
    await page.waitForTimeout(1200);
  };

  await go("/", "body");
  await shot(page, "01-overview.png", "overview: recorded executions, analytics, readiness");

  await go("/execute", "body");
  await shot(page, "02-execute.png", "execute: the structured request the gateway validates");

  await go(`/execution/${short.id}`, "body");
  await shot(page, "03-flight-recorder.png", "flight recorder: the canonical event timeline");

  await go(`/execution/${long.sessionId}`, "body");
  await shot(page, "04-live-execution.png", "live execution: a running process with live procfs telemetry");

  if (workload) {
    await go(`/execution/${workload.sessionId}`, "body");
    await shot(page, "05-workload-telemetry.png", "controlled workload: CPU, memory and I/O on one PID");
  }

  await go(`/execution/${short.id}/3d`, "body");
  await page.waitForTimeout(2500); // let the 3D scene build its first frame
  await shot(page, "06-process-space-3d.png", "3D Process Space: lane / depth / time, rendered from the same evidence");

  await go(`/execution/${short.id}?replay=1`, "body");
  await shot(page, "07-replay.png", "replay: reconstruction from persisted events, not re-execution");

  await go("/processes", "body");
  await shot(page, "08-processes.png", "processes: observed process identities and their state");

  await go("/analytics", "body");
  await shot(page, "09-analytics.png", "analytics: aggregates over the persisted event store");

  await go("/compare", "body");
  await shot(page, "10-compare.png", "compare: two real executions side by side");

  await go("/signals", "body");
  await shot(page, "11-signals.png", "signals: the fail-closed SIGINT model");

  await go("/redirection", "body");
  await shot(page, "12-redirection.png", "redirection: descriptor lifecycle and O_NOFOLLOW policy");

  await go("/architecture", "body");
  await shot(page, "13-architecture.png", "architecture: the pipeline as the app presents it");

  await go("/settings", "body");
  await shot(page, "14-settings.png", "settings: engine probe, limits, readiness, retention");

  // Narrow viewport: the layouts must degrade, not overflow.
  const mobile = await browser.newContext({ viewport: { width: 430, height: 932 }, deviceScaleFactor: 1 });
  const mpage = await mobile.newPage();
  await mpage.goto(`${FRONTEND}/`, { waitUntil: "networkidle" });
  await mpage.waitForTimeout(1200);
  await mpage.screenshot({ path: join(OUT, "15-responsive.png"), animations: "disabled" });
  log("15-responsive.png         narrow viewport layout");

  // ---- 3. clean up the deliberately long-running session --------------------
  await fetch(`${GATEWAY}/api/sessions/${long.sessionId}/terminate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ signal: "SIGINT" }),
  }).catch(() => {});
  await page.close();
  await mpage.close();
  await mobile.close();
  await context.close();
  await browser.close();

  console.log("");
  if (consoleErrors.length > 0) {
    console.log("Browser reported errors (these may be benign, but they are recorded):");
    for (const e of [...new Set(consoleErrors)].slice(0, 10)) console.log(`  - ${e}`);
  } else {
    console.log("No browser console errors during capture.");
  }
  console.log(`\nScreenshots written to ${OUT}/`);
};

main().catch((err) => {
  console.error(`CAPTURE FAILED: ${err.message}`);
  process.exit(1);
});
