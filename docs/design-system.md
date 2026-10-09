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

Motion uses the shared `--motion-*` and `--ease-*` tokens. Route arrival,
navigation, command palette, and evidence selection transitions remain short.
Motion communicates state and never supplies the only indication of it. The
global reduced-motion rule suppresses CSS transitions and animation, and the 3D
renderer switches to demand mode when reduced motion is requested.

Keyboard focus uses a high-contrast cyan outline and ring. The sidebar remains
available on desktop and becomes a focus-managed dialog on small screens. The
3D scene retains its accessible process list and 2D investigation view as
alternatives. Color contrast and mobile layouts should be checked in the actual
browser at the 390 px acceptance width; automated checks alone do not establish
formal WCAG conformance.

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
