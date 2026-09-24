# CAPS Observatory — Design System

Source of truth for every visual decision in the frontend. All values are
centralized in `web/frontend/src/styles/tokens.css`; components reference
semantic tokens, never raw hex.

## 1. Visual direction

Technical, precise, cinematic, calm, developer-focused, information-dense.
Reference principles: modern observability dashboards (live metrics,
status semantics), developer workspaces (dense readable tables, search),
and IDE/debugger clarity. **Not** a generic admin dashboard; no neon
overload, no gradient walls, no 3D decoration, no glassy cards everywhere.

Color is communication: cyan = system activity, green = success,
amber = warning, red = failure/signal/danger, violet = selected/active,
neutral = structure.

## 2. Color tokens

### Base / surfaces

| Token                    | Value     | Use                               |
| ------------------------ | --------- | --------------------------------- |
| `--background`           | `#070A0F` | page background                   |
| `--background-elevated`  | `#0B1017` | elevated page regions             |
| `--surface`              | `#0F1620` | panels, sidebar                   |
| `--surface-elevated`     | `#121B26` | raised cards                      |
| `--surface-hover`        | `#17222E` | hover fill                        |
| `--surface-active`       | `#1B2836` | pressed / selected fill           |
| `--border`               | `rgba(148,163,184,0.14)` | default borders      |
| `--border-strong`        | `rgba(148,163,184,0.26)` | focus, emphasized     |
| `--scrim`                | `rgba(4,6,10,0.6)` | drawer/modal overlay    |

### Text

| Token            | Value     | Use                        |
| ---------------- | --------- | -------------------------- |
| `--text`         | `#E6EDF3` | primary text               |
| `--text-secondary` | `#A8B4C2` | secondary text           |
| `--text-muted`   | `#6B7A89` | labels, metadata           |
| `--text-faint`   | `#4B5866` | placeholders, disabled     |
| `--text-inverse` | `#0B1017` | text on accent fills       |

### Semantic

| Token                | Value     | Meaning                              |
| -------------------- | --------- | ------------------------------------ |
| `--accent`           | `#3FD0E0` | electric cyan/aqua — system activity |
| `--accent-secondary` | `#8B8CF8` | violet/indigo — selection, interactive |
| `--success`          | `#41D29B` | green — completed OK                 |
| `--warning`          | `#EDB35A` | amber — caution                      |
| `--danger`           | `#F16A7C` | red — failure/signal/termination     |
| `--info`             | `#5FC6F0` | blue-cyan — informational state      |

### Status → token map

| Status                | Token     |
| --------------------- | --------- |
| CREATED / QUEUED      | `--text-muted` |
| STARTING / RUNNING    | `--accent` |
| WAITING               | `--accent-secondary` |
| COMPLETED / SUCCESS   | `--success` |
| FAILED / EXEC_ERROR   | `--danger` |
| SIGNALED              | `--danger` |
| TIMED_OUT / CANCELLED | `--warning` |
| DISCONNECTED          | `--text-faint` |

Accent colors cover < 15% of any screen. Structure dominates.

## 3. Typography

- UI: **Inter** (bundled via `@fontsource/inter`), stack
  `Inter, system-ui, sans-serif`.
- Mono: **JetBrains Mono** (bundled via `@fontsource/jetbrains-mono`),
  stack `'JetBrains Mono', ui-monospace, monospace`. Mono for: commands,
  argv, PIDs, timestamps, exit codes, signals, JSON, event names, file
  descriptors, duration, session ids.

Scale (px): `12 / 13 / 14 / 16 / 20 / 28`. No gigantic hero headings;
headings stay compact for information density.

| Role    | Size | Weight  |
| ------- | ---- | ------- |
| Page title | 20 | 600 |
| Section title | 14 | 600 |
| Body | 13/14 | 400 |
| Mono value | 13 | 400 |
| Micro labels | 11/12 | 500, spacing 0.06em, uppercase on request |

## 4. Spacing, radii, borders

- 4px base grid: `4 8 12 16 20 24 32 40 48 64`.
- Radii: small `6px` (controls), medium `8px` (panels/cards), large
  `12px` (drawers/dialogs). Pills `999px`.
- Borders: 1px `--border`, 1px `--border-strong` for focus.
- Shadows: restrained. One elevation token:
  `--shadow: 0 1px 0 rgba(0,0,0,.4), 0 8px 24px rgba(0,0,0,.35)` for
  overlays/drawers; cards rely on border, not shadow.

## 5. Motion

Motion for React (`motion`). Purpose over decoration. Respect
`prefers-reduced-motion` globally (`useReducedMotion`); when reduced,
transitions collapse to 0ms/instant state changes.

| Category | Duration | Ease | Trigger |
| -------- | -------- | ---- | ------- |
| Micro       | 120ms | ease-out | hover/focus/active |
| State swap  | 200ms | ease-out | status changes, icon swaps |
| Panel       | 240ms | ease-out | drawer, expand/collapse |
| Page enter  | 260ms | ease-out | route fade/slide 8px |
| Data arrival| 300ms | ease-out | timeline row insert |
| Replay step | per-event | – | flight recorder playback |
| Process pulse| 1.6s loop, soft | — | running process node only |

Animated only: node activation, timeline insert, status transitions,
drawers, replay, hover lift, chart transitions. Never: constant
background motion, spinning decals, glow storms.

## 6. Interactive states

- Buttons: `hover` (border→strong, bg→hover), `focus-visible`
  (2px ring `--accent`/`--accent-secondary`, offset 2px), `active`
  (bg→active, translateY 1px), `disabled` (text-faint, no pointer).
- Cards: `hover` lifts 1px, border warms to `--border-strong`, optional
  accent left-edge; no scale(1.15), no glow everywhere.
- Timeline rows: hover = surface-hover + left accent; selected =
  surface-active + accent border.
- Process nodes: hover = surface-hover + border-strong; selected = accent
  ring. Tooltip on hover/focus.

Icons (lucide-react): 16–18px in menus; 14px inline micro.

## 7. Components

- **StatusBadge** — dot + label + token color; text present (never color-only).
- **MetricCard** — label, mono value, optional sparkline; restrained.
- **ExecutionPipeline** — INPUT → PARSE → ARGV → FORK → EXEC → WAIT →
  RESULT; vertical/horizontal; active node = accent pulse + connector fill.
- **ProcessGraph** — parent/child topology from real events.
- **ArgvTable** — indexed `[i]`, value, mono; `[argc] = NULL` emphasized.
- **EventTimeline** — seq, time, type, pid, payload; click → inspector.
- **JsonViewer** — monospace syntax-highlighted raw event.
- **Drawer** — right-side 480px panel, scrim, ESC/overlay close, focus trap.
- **Empty/Error/Loading** — explicit component states (see tokens below).

## 8. Empty / error / loading tokens

- Loading: skeleton shimmer (surface-hover pulse) or compact spinner +
  label; never spinner-only.
- Empty: centered icon + message + action when applicable.
  Analytics empty: “No executions recorded yet.”
- Error: `--danger` left-edge card, code + message + retry.
- Disconnected: amber/`--text-faint` “RECONNECTING…”, never fake online.

## 9. Responsive behavior

| Width        | Layout                                   |
| ------------ | ---------------------------------------- |
| ≥ 1280px     | sidebar expanded, 12-col grid, dense tables |
| 1024px       | sidebar icons only, 8-col grid           |
| 768px        | sidebar collapsed to overlay, stacked metrics |
| ≤ 390px      | single column, tables become accessible stacks/cards, drawers full-width |

No horizontal overflow anywhere. Command execution input stays reachable
on every viewport.