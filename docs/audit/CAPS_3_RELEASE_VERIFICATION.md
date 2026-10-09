# CAPS 3.0 release verification

**Status: prepublication candidate evidence; not a release certification.**
This record keeps observed checks separate from checks that require a Linux
build environment or a published candidate. It was prepared against the local
worktree rebased onto `b6f9347cff115c2ca15ffebffc8610eb7d148976` on
2026-10-09. GitHub's `main` was that same SHA when checked. Candidate Linux CI
results are reported separately after publication; the baseline CI run below is
not evidence for the candidate.

## Environment

- Host: Windows 11, PowerShell, Node.js 24.19.0, npm 11, GCC MinGW available;
  Clang unavailable.
- WSL reports Ubuntu under WSL 1; its status states WSL 1 is unsupported with
  this machine configuration. No Docker daemon or Linux shell was available.
- A separately running local Linux CAPS 2.0.0 gateway answered at
  `127.0.0.1:3100`, with `platform: linux/posix`. Its uptime did not reset when
  the candidate source changed. It is valid evidence of real Linux behavior for
  the recorded scenarios, but it did **not** load the candidate backend patch.
- Production frontend preview: `http://127.0.0.1:4174`, with Vite proxying API
  calls to that Linux gateway. Screenshots are browser captures, not mockups.

## Observed checks

| Check | Command / procedure | Result |
| --- | --- | --- |
| Frontend dependencies | `npm.cmd ci --no-audit --no-fund` in `web/frontend` | Passed on the rebased candidate; 257 packages installed from the lockfile. npm warned that esbuild's postinstall script needs approval. |
| Frontend typecheck and production build | `npm.cmd run build` in `web/frontend` | Passed after clean install. Vite warned that lazy `ProcessSpacePage` is 993.50 kB minified (269.32 kB gzip); warning remains. |
| Frontend tests | `npm.cmd test -- --reporter=dot` in `web/frontend` | 18 files, 320 tests passed after clean install. |
| Backend dependencies | `npm.cmd ci --no-audit --no-fund` in `web/backend` | Passed; 91 packages installed from the lockfile. npm warned that esbuild's postinstall script needs approval. |
| Backend typecheck and production build | `npm.cmd run typecheck`; `npm.cmd run build` in `web/backend` | Passed after clean install and the nonzero-exit correction. |
| Dependency audit | `npm.cmd audit --audit-level=moderate` in both frontend and backend | Both reported 0 vulnerabilities against the npm advisory database. |
| Browser route and visual capture | `node scripts/capture-screenshots.mjs` against production preview and Linux gateway | 19 screenshots captured for overview, terminal, execute, recorder, pipeline, live telemetry, mixed workload, 3D, replay, processes, system, analytics, comparison, signals, redirection, architecture, settings, and mobile. The script also checks command palette, real hover transform, reduced-motion scroll/transition behavior, and mobile dialog close. No browser page errors. |
| Light OS theme behavior | Browser context emulated `colorScheme: light`; inspected computed CSS | Product remained graphite (`rgb(7, 9, 13)`) with dark color scheme. |
| Command palette | Ctrl+K, then Escape in browser; shortcut regression test | Opens and closes; targeted test passed. |
| Mobile layout | 390x844, `prefers-reduced-motion: reduce`; lifecycle label widths, drawer dialog and Escape | Labels retained their full scrollable width; reduced motion disabled smooth scrolling and transitions; navigation opened as a dialog and closed with Escape; no horizontal document overflow observed. |
| 3D route | Browser opened real session's Process Space, then navigated away | Canvas rendered; no browser page error observed. Repeated mount/unmount and WebGL-unavailable behavior were not independently stress-tested in this pass. |
| Backend test suite on Windows | `npm.cmd test -- --reporter=dot` in `web/backend` | Failed as expected for the unsupported host: 46 failures, 345 passes, 102 skips, plus 2 unhandled errors across 32 files. Failures include unavailable `/proc`, Linux `sleep`/`caps` process helpers and sandboxed temp cleanup (`EPERM`). This is not a candidate Linux test result. |
| Candidate backend integration | Linux-backed API regression in `web/backend/tests/api/server.test.ts` | Candidate Linux integration tests have not run locally; the active gateway did not reload candidate source. |
| C engine and sanitizers | `make` targets | Not run locally: no supported Linux shell; MinGW is not a POSIX substitute. |
| Repository gates | Makefile `test-scripts` | Not run locally because GNU make/POSIX shell are unavailable on this host. |
| Git whitespace | `git diff --check` | One trailing blank line was found and corrected; rerun before commit. |

## Real Linux workflow evidence (gateway v2.0.0)

The browser drove the actual Linux gateway; commands were first-party allowlisted
commands and bounded repository workloads.

| Scenario | Observed result |
| --- | --- |
| `echo` with one argument containing a space (`CAPS browser smoke`) | `COMPLETED`, exit 0; exact output preserved. |
| `false` | Process PID `206573`, exit 1, no signal. The running v2.0.0 gateway incorrectly persisted `COMPLETED` and replay integrity flagged `I12-success-has-process-exit`. This confirmed defect is fixed in candidate source and covered by an integration regression, but candidate runtime verification remains pending. |
| `sleep 8` with a 5 second timeout | `TIMED_OUT`, exit 143, signal 15; timeout event, process exit, and summary replayed in contiguous sequence with no integrity violation. |
| `echo caps pipeline | tr a-z A-Z | wc -c` | Three stages, `COMPLETED`, exit 0. |
| `seq 1 100000 | head -n 1` | Consumer exited 0; producer received SIGPIPE (13); session `FAILED`, replay integrity valid. |
| Non-allowlisted command | Policy rejection before session/PID creation; no execution request was made by the rejected form. |
| Replay and JSON export | Reopened a recorded session in read-only replay with no POST/re-execution; downloaded canonical JSON export. |
| Bounded workload | `caps_mixed_burn` ran for 4 seconds with a 48 MiB bound; real session and telemetry displayed. |
| Redirection workload | First-party redirection command completed and was recorded. |

The live gateway was not rebuilt from the candidate. In particular, it cannot
verify the candidate's corrected terminal status for `false`.

## Route inventory

No route was removed in this pass. Parameterized routes remain the detail
surfaces for a session selected from history.

| Route | Decision | Responsibility |
| --- | --- | --- |
| `/` | Keep, redesign | Operational overview, structured quick-start, live evidence, recent sessions |
| `/terminal` | Keep | Engine grammar, pipeline, and redirection workflow |
| `/execute` | Keep | Structured argv execution workbench |
| `/live` | Keep | Current session telemetry and lifecycle |
| `/history` | Keep | Persisted sessions, replay entry, export |
| `/execution/:id` | Keep | Session event timeline and evidence inspection |
| `/execution/:id/3d` | Keep | Process Space for the selected session |
| `/demo` | Keep | Session selection / Process Space entry point |
| `/arguments/:id` | Keep | Exact recorded argv inspection |
| `/processes` | Keep | Session process evidence |
| `/processes/explorer` | Keep | Host process explorer and ownership distinction |
| `/analytics` | Keep | Persisted execution aggregates |
| `/compare` | Keep | Side-by-side recorded session comparison |
| `/system` | Keep | Host capabilities and guardrails |
| `/playground` | Keep | Bounded first-party workload lab |
| `/architecture` | Keep | Architecture explanation |
| `/signals` | Keep | Signal behavior explanation |
| `/redirection` | Keep | Descriptor lifecycle explanation |
| `/settings` | Keep | Supported runtime settings and retention |
| `/raw` | Keep | Raw persisted event inspection |
| `/about` | Keep | Product and support information |
| Fallback | Keep | Unknown paths return to the overview |

The sidebar currently groups these capabilities as Core, Observe, Lab, Explain,
and System. The recorder and 3D view are available through history/session
selection because they need a real session ID; they are not duplicate standalone
empty routes.

## Candidate changes covered by this pass

- Dark graphite palette now remains dark even when the operating system prefers
  light mode; dim text tokens and local font fallbacks were corrected.
- Mobile lifecycle rail retains all stage labels in a horizontally scrollable
  region.
- Shared panels now use a subtle layered surface, buttons provide restrained
  hover/press feedback, focused forms gain a visible ring, and workspace
  overscroll and smooth scrolling honor reduced-motion settings.
- Ctrl/Cmd+K now toggles the command palette as documented.
- Real process exits with nonzero codes now map to `FAILED`, retain their exit
  code, and emit the failure terminal event. This separates a process that ran
  and returned failure from an `exec` failure. The API regression test asserts
  replay integrity and the event classification.
- Historical and final screenshots are kept separately at the same desktop
  viewport. The final visual treatment differs substantially in surface palette,
  contrast, focus and status hierarchy; the route structure and major page
  layouts remain based on the existing product architecture.

## Security and trust boundary

The application remains a **local, single-user process observatory**, not an
arbitrary-code execution sandbox. The command allowlist, structured argv,
workspace checks, timeouts and resource limits reduce risk; they do not provide
OS-level isolation from a hostile user. The gateway and execution service should
remain loopback-bound unless a separately reviewed authentication and isolation
model is implemented. Replay reads persisted events and does not intentionally
execute the recorded command.

The React Router advisory affecting the prior 6.x range was addressed upstream
on the fetched `b6f9347` baseline; that baseline uses Router 7.18.4. The two
current lockfile audits reported no advisories. This is not a claim that GitHub
Dependabot has no alerts: the alerts endpoint timed out in this pass. Five
dependency-update pull requests were open initially and were closed at the user's
request; none of their changes were merged.

### Current engineering references reviewed

These references informed the review; this is not a declaration of compliance
with any complete standard or certification.

- [OWASP ASVS 5.0.0](https://github.com/OWASP/ASVS/releases/tag/v5.0.0) for a
  structured web-service verification checklist.
- [OWASP OS Command Injection Defense](https://cheatsheetseries.owasp.org/cheatsheets/OS_Command_Injection_Defense_Cheat_Sheet.html)
  for the distinction between structured parameter passing and validating
  command/argument authority.
- [WCAG 2.2](https://www.w3.org/TR/WCAG22/) as the accessibility target; the
  checks above are partial and do not establish AA conformance.
- [OpenTelemetry system and process semantic conventions](https://opentelemetry.io/docs/specs/semconv/system/)
  for process-vs-host metric scope and provenance vocabulary.
- [GitHub Actions secure use reference](https://docs.github.com/en/actions/reference/security/secure-use)
  for least privilege, immutable action references, and untrusted workflow input.
- [React Router advisory GHSA-wrjc-x8rr-h8h6](https://github.com/remix-run/react-router/security/advisories/GHSA-wrjc-x8rr-h8h6)
  for the prior 6.x open-redirect range; the fetched baseline locks 7.18.4.

## Outstanding verification and limitations

1. Run `make test-scripts`, strict GCC and Clang builds, C unit/integration and
   sanitizer suites, workload suites, backend tests, and browser smoke in Linux.
   GitHub Actions on the candidate is the available Linux runner.
2. Have candidate integration CI prove the nonzero-exit fix against the C engine
   and SQLite replay.
3. Run accessibility automation and a complete keyboard-only review; this pass
   checked the command palette shortcut, mobile dialog focus behavior and
   reduced-motion capture, not formal WCAG conformance.
4. Stress repeated WebGL mount/unmount and the WebGL-unavailable 3D fallback.
5. Five open Dependabot PRs were closed on the user's request. GitHub then listed
   only remote `main`; `git ls-remote --heads origin` confirmed the same. No
   package changes from those PRs were merged.
6. The 3D route remains a large lazy chunk. A manual chunk experiment increased
   total gzip output and was reverted; the 993.50 kB minified warning remains.
7. Publish after the final diff/hygiene review, then confirm the remote branch
   points to the candidate and every required job passes on that exact SHA.

## Historical CI baseline

Before this candidate, GitHub Actions run
[37927078927](https://github.com/karkalashivareddy/Command-Argument-Passing-System/actions/runs/37927078927)
passed on `b6f9347cff115c2ca15ffebffc8610eb7d148976`, including repository gates,
GCC and Clang C builds with sanitizer/workload suites, backend and frontend
checks, real gateway integration, browser smoke, dependency audit, hygiene, and
CodeQL. This is historical baseline evidence, not verification of this candidate.
