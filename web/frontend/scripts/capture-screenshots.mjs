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
//
// THREE levels up, not two. The file lives at web/frontend/scripts/, so "../.."
// resolves to web/ -- which is how the first run of this script wrote nineteen
// real screenshots into web/docs/screenshots/, a directory nothing else in the
// repository knows about and no document links to. The screenshots were correct
// and completely undiscoverable.
const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
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
  return await waitForEnd(sessionId, timeoutMs);
}

async function waitForEnd(sessionId, timeoutMs = 40000) {
  const started = Date.now();
  for (;;) {
    const s = await (await fetch(`${GATEWAY}/api/sessions/${sessionId}`)).json();
    if (["COMPLETED", "FAILED", "TIMED_OUT", "CANCELLED"].includes(s.status)) {
      if (s.status !== "COMPLETED") {
        log(`  ! ${sessionId} ended as ${s.status}: ${s.error ?? "no error recorded"}`);
      }
      return { ...s, wallMs: Date.now() - started };
    }
    if (Date.now() - started > timeoutMs) throw new Error(`${sessionId} did not finish`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

/**
 * Start something without waiting for it.
 *
 * Used for the sessions that must still be running when the browser arrives: a
 * finished process has no live telemetry left to photograph.
 */
async function start(body) {
  const res = await fetch(`${GATEWAY}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) return null;
  return (await res.json()).sessionId;
}

/**
 * Run a real command LINE through the terminal's own lexer.
 *
 * This is the only route that exercises the pipeline, so the pipeline evidence
 * has to be captured this way. Posting a structured single-command request would
 * produce one stage, and the evidence surface would look correct while proving
 * nothing about stages.
 */
async function runLine(commandLine) {
  const res = await fetch(`${GATEWAY}/api/terminal/execute`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ commandLine }),
  });
  if (!res.ok) {
    throw new Error(`terminal rejected ${JSON.stringify(commandLine)}: ${res.status} ${await res.text()}`);
  }
  const accepted = await res.json();
  log(`  ${commandLine} -> ${accepted.stageCount} stage(s): ${accepted.commands.join(" | ")}`);
  if (accepted.stageCount < 2) {
    throw new Error(`expected a multi-stage pipeline, the lexer reported ${accepted.stageCount} stage(s)`);
  }
  return await waitForEnd(accepted.sessionId);
}

/**
 * Capture one screenshot.
 *
 * `scrollTo` names a substring of text to bring into view first. The viewport is
 * 1600x1000 and this page is far taller than that, so a shot taken at the top of
 * the document photographs the telemetry summary and the output panel while the
 * card the file is named for sits somewhere below the fold. Scrolling to the
 * subject is what makes the image evidence of the thing it claims to be.
 */
async function shot(page, name, note, scrollTo) {
  const path = join(OUT, name);
  if (scrollTo !== undefined) {
    const found = await page
      .locator(`text=${scrollTo}`)
      .first()
      .scrollIntoViewIfNeeded({ timeout: 10_000 })
      .then(() => true)
      .catch(() => false);
    if (!found) throw new Error(`${name}: nothing on this page says "${scrollTo}", so the shot would not show its own subject`);
    // Let the scroll settle and any reveal animation finish, or the card is
    // captured mid-transition and looks like a rendering fault.
    await page.waitForTimeout(600);
  }
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

  // A real three-stage pipeline: the lexer, the engine's pipes, the per-stage
  // evidence, and the replay all have to agree or this screenshot is fiction.
  const pipeline = await runLine("echo caps pipeline | tr a-z A-Z | wc -c");
  log(`  pipeline -> ${pipeline.status}, exit ${pipeline.exitCode}`);

  const long = await (async () => {
    const sessionId = await start({ command: "sleep", args: ["30"] });
    return { sessionId };
  })();
  if (!long.sessionId) throw new Error("gateway did not accept the long-running session");
  log(`  long-running session ${long.sessionId} (kept alive for live views)`);

  const workload = await (async () => {
    const sessionId = await start({
      command: "caps_mixed_burn",
      args: ["4", "48", "4"],
      timeoutMs: 20000,
    });
    if (!sessionId) return null;
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
    // A surface that failed to render still satisfies `waitForSelector("body")`,
    // and the resulting screenshot would look like an empty application. A real
    // view carries a heading and several hundred characters of content, so a
    // nearly blank page is treated as the failure it is.
    const text = await page.evaluate(() => document.body.innerText.replace(/\s+/g, " ").trim());
    if (text.length < 200) {
      throw new Error(`${path}: rendered only ${text.length} characters, which is not a view (${JSON.stringify(text.slice(0, 80))})`);
    }
  };

  await go("/", "body");
  await shot(page, "01-overview.png", "overview: recorded executions, analytics, readiness");

  await go("/terminal", "body");
  await shot(page, "02-terminal.png", "terminal: a real command line, lexed by the engine, validated before it runs");

  await go("/execute", "body");
  await shot(page, "03-execute.png", "execute: the structured request the gateway validates");

  await go(`/execution/${short.id}`, "body");
  await shot(page, "04-flight-recorder.png", "flight recorder: the canonical event timeline");

  await go(`/execution/${pipeline.id}`, "body");
  await shot(page, "05-pipeline-evidence.png", "pipeline evidence: per-stage pids, argv, and accounting from a real pipeline", "Pipeline evidence");

  await go(`/execution/${long.sessionId}`, "body");
  await shot(page, "06-live-execution.png", "live execution: a running process with live procfs telemetry", "Observed process lineage");

  if (workload) {
    await go(`/execution/${workload.sessionId}`, "body");
    await shot(page, "07-workload-telemetry.png", "controlled workload: CPU, memory and I/O on one PID");
  }

  await go(`/execution/${short.id}/3d`, "body");
  await page.waitForTimeout(2500); // let the 3D scene build its first frame
  await shot(page, "08-process-space-3d.png", "3D Process Space: lane / depth / time, rendered from the same evidence");

  await go(`/execution/${short.id}?replay=1`, "body");
  await shot(page, "09-replay.png", "replay: reconstruction from persisted events, not re-execution");

  await go("/processes", "body");
  await shot(page, "10-processes.png", "processes: observed process identities and their state");

  await go("/processes/explorer", "body");
  await shot(page, "11-process-explorer.png", "process explorer: the host tree with CAPS-owned work distinguished", "Host processes");

  await go("/system", "body");
  await shot(page, "12-system-control.png", "system control center: host telemetry, guardrails, and thermal availability");

  await go("/analytics", "body");
  await shot(page, "13-analytics.png", "analytics: aggregates over the persisted event store");

  await go("/compare", "body");
  await shot(page, "14-compare.png", "compare: two real executions side by side");

  await go("/signals", "body");
  await shot(page, "15-signals.png", "signals: the fail-closed SIGINT model");

  await go("/redirection", "body");
  await shot(page, "16-redirection.png", "redirection: descriptor lifecycle and O_NOFOLLOW policy");

  await go("/architecture", "body");
  await shot(page, "17-architecture.png", "architecture: the pipeline as the app presents it");

  await go("/settings", "body");
  await shot(page, "18-settings.png", "settings: engine probe, limits, readiness, retention");

  // Narrow viewport: the layouts must degrade, not overflow.
  const mobile = await browser.newContext({ viewport: { width: 430, height: 932 }, deviceScaleFactor: 1 });
  const mpage = await mobile.newPage();
  await mpage.goto(`${FRONTEND}/`, { waitUntil: "networkidle" });
  await mpage.waitForTimeout(1200);
  await mpage.screenshot({ path: join(OUT, "19-responsive.png"), animations: "disabled" });
  log("19-responsive.png         narrow viewport layout");

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
