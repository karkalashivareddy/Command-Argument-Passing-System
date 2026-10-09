# CAPS Observatory Design System

The implementation source of truth is [`tokens.css`](../web/frontend/src/styles/tokens.css).
The application uses a dark graphite palette regardless of the operating
system's light or dark preference. This is an intentional product identity, not
a user setting. `color-scheme: dark` also keeps native controls consistent.

## Visual direction

CAPS is a Linux process execution observatory. The interface separates observed
machine facts from derived analysis and unavailable values:

| Meaning | Token | Use |
| --- | --- | --- |
| Page and shell | `--bg-0` through `--bg-2` | Graphite layers from `#07090d` to `#11161d` |
| Raised surfaces | `--bg-3` through `--bg-5` | Selected and interactive surfaces |
| Structure | `--line-0` through `--line-2` | Dividers, borders, and emphasis |
| Text | `--fg-0` through `--fg-4` | Primary text through secondary metadata |
| Observed activity | `--accent` / `--role-observed` | Cyan process and telemetry evidence |
| Derived analysis | `--violet` / `--role-derived` | Calculated or selected information |
| Success | `--green` / `--role-success` | Successful completion |
| Warning | `--amber` / `--role-warning` | Degraded or caution states |
| Failure | `--red` / `--role-danger` | Failed execution or termination |
| Unavailable | `--role-unavailable` | Unknown or unsupported measurements |

Color always accompanies a label, icon, or explicit state. Missing telemetry is
shown as unavailable, never zero. The ambient grid is a low-contrast backdrop;
data panels use mostly opaque surfaces and borders rather than uniform glass.

## Typography and spacing

The UI prefers Inter and JetBrains Mono when installed, then uses the platform's
system UI and monospace fonts. Fonts are not downloaded from a third-party CDN,
so the interface renders without network access and makes no font request to an
external service. Machine facts such as argv, PIDs, timestamps, event names,
and counters use monospace; explanatory text uses the system UI face.

The spacing scale is 4, 8, 12, 16, 20, 24, 32, 40, and 48 px. The token type
scale runs from 11 px micro labels to a 28 px display heading. Radii are 3, 6,
10, 14, and 20 px. Shared panels use a fine top highlight, a restrained vertical
surface wash, and one elevation step. Focus inside a panel raises its edge in the
observed cyan; static data panels do not lift on hover and therefore do not imply
that they are clickable. Translucent blur is reserved for live inspectors and
overlays.

## Motion and interaction

Motion tokens are `--motion-instant`, `--motion-quick`, `--motion-base`, and
`--motion-slow`, with the shared `--ease-standard` curve. Motion communicates
selection, event arrival, panel movement, and process state. It does not carry
meaning on its own. Global `prefers-reduced-motion: reduce` rules suppress CSS
animation and transition; the 3D scene also disables its idle movement.

`:focus-visible` uses a 2 px cyan outline with a 2 px offset. Dialogs and the
mobile navigation expose names, keyboard dismissal, and focus management. A
graph or 3D view must have a textual or tabular alternative.

Buttons lift by one pixel on hover and compress slightly on press, with color,
shadow, and transform transitions using the shared motion token. Inputs get a
soft focus ring and a small surface shift. Sidebar items move only a fraction on
hover. The workspace scroll region contains overscroll and uses smooth
programmatic scrolling; reduced-motion preferences switch scrolling and
transitions back to immediate behavior. Status pulses appear only for active
evidence.

## Product shell and page roles

The sidebar groups pages into Core, Observe, Lab, Explain, and System. The top
bar reports platform, SSE state, gateway/engine state, and version from API
responses. The command palette and shortcut help are global. Page contents use
their own layouts for execution, telemetry, history, analytics, and diagnostics;
they are not forced into one repeated card grid.

## Responsive behavior

The sidebar is persistent at desktop widths and becomes a focus-managed drawer
on narrow screens. Dense metric groups wrap, and long records can use their
table/list alternative. The 390 px acceptance viewport must not have horizontal
document overflow; browser zoom and keyboard access remain available.

Real desktop and narrow-viewport screenshots are captured by
[`capture-screenshots.mjs`](../web/frontend/scripts/capture-screenshots.mjs).
That script emulates a light OS preference to guard the fixed dark palette and
uses the real gateway evidence rather than fixture data.
