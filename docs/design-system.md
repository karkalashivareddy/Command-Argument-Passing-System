# CAPS Observatory Design System

The design system lives in [`tokens.css`](../web/frontend/src/styles/tokens.css)
and [`premium.css`](../web/frontend/src/styles/premium.css). CAPS is a dark,
cinematic process observatory. The visual language uses midnight navy and
graphite structure, electric cyan for live observations, saturated blue for
actions and navigation, violet for derived analysis, and mint, amber, and coral
for terminal states.

## Visual hierarchy

The overview is the signature operational workspace: a large editorial headline
and structured command launch sit beside a live observatory inspector. Its event
counts, engine state, running process count, and workspace come from the gateway
and event stream. The lower areas organize actual recent sessions, live events,
and analytics into scannable evidence.

Other routes retain their purpose-specific compositions. Shared surfaces use
layered navy gradients, cool fine edges, and deliberate elevation. Glass is
reserved for the main observatory inspector and transient overlays. The
background's restrained radial lighting and technical grid establish depth
without competing with charts or terminal output.

## Semantic tokens

| Meaning | Tokens | Use |
| --- | --- | --- |
| Foundation | `--bg-0` through `--bg-5` | Midnight page, shell, and raised surfaces |
| Structure | `--line-0` through `--line-2` | Dividers and progressively stronger edges |
| Text | `--fg-0` through `--fg-4` | Primary reading through quiet metadata |
| Observed | `--accent` / `--role-observed` | Real process and telemetry evidence |
| Navigation/action | `--blue` | Links, active routing, and primary action gradients |
| Derived | `--violet` / `--role-derived` | Calculated values and analysis |
| Success | `--green` / `--role-success` | Completed successfully |
| Warning | `--amber` / `--role-warning` | Degraded or caution states |
| Failure | `--red` / `--role-danger` | Failed execution or termination |
| Unknown | `--role-unavailable` | Unsupported or unavailable measurements |

Color is paired with a label, icon, shape, or explicit state. Missing telemetry
remains unavailable rather than becoming zero. Machine facts such as argv, PIDs,
timestamps, event names, and counters use monospace; explanation uses the UI
font stack. Fonts remain local and do not require an external request.

## Motion and accessibility

Motion uses the shared `--motion-*` and `--ease-*` tokens. The persistent shell
keeps the ambient field mounted while a pathname change crossfades and lifts the
incoming workspace by a few pixels. Query-only changes do not restart the
transition. The shell's own scroll container drives a thin progress line; history
navigation restores the saved position for that entry, while a new workspace
starts at the top. Major cards and sections below the initial viewport reveal
once as they enter the main scroll region. The sidebar active marker and button
press state use short, stateful feedback rather than broad `transition: all`
rules.

Motion communicates state and never supplies the only indication of it.
Reduced-motion preferences remove route displacement and CSS animation, skip
the spring on the progress line, and keep immediate scroll behavior. The 3D
renderer switches to demand mode; node positions and evidence remain available
without idle movement.

Keyboard focus uses a high-contrast cyan outline and ring. The sidebar remains
available on desktop and becomes a focus-managed dialog on small screens. The
3D scene retains its accessible process list and 2D investigation view as
alternatives. Color contrast and mobile layouts should be checked in the actual
browser at the 390 px acceptance width; automated checks alone do not establish
formal WCAG conformance.

## Process Space visual semantics

The 3D surface uses a dark technical ground plane, restrained blue and violet
lighting, and a record-framed camera. The CAPS engine has a cylindrical core;
observed child processes use rounded geometry. Node lifecycle colour continues
to come from recorded lifecycle evidence. Selection and verified ancestry use
violet outlines, and the engine's cyan floor ring identifies its role without
changing its lifecycle colour. Resource lenses affect the existing observed
resource encoding only. Labels remain HTML, and process/event selection remains
available in the accessible list and table.

X, Y, and Z remain deterministic process lane, verified process depth, and
recorded execution time. Camera movement, lighting, and geometry do not add
processes or events. The renderer caps device pixel ratio at 1.5 for a more
predictable laptop workload and retains the WebGL failure and 2D/table fallback.

## Browser icon

The Vite public asset `web/frontend/public/caps-mark.svg` is referenced from the
site root as `/caps-mark.svg`, so the same URL is valid in development and the
production build. Keep the favicon's dark tile and cyan/blue/violet terminal
mark aligned with the CAPS shell identity; do not use a framework default.

## Shell and responsive layout

The persistent navigation groups execution, observation, the host lab,
architecture, and system configuration. The top bar reports platform, SSE,
engine, and version from gateway responses and provides the command palette.
Route pages keep their own data layouts rather than sharing one dashboard
template. On narrow screens, page gutters, tables, metric groups, and the
navigation drawer adapt without hiding primary actions.

The production browser harness is
[`capture-screenshots.mjs`](../web/frontend/scripts/capture-screenshots.mjs).
It uses the actual gateway and records screenshots to the configured output
directory. Capture-only visual evidence is not a substitute for inspecting the
result or testing the workflows represented in it.
