# The 3D Process Observatory

`/execution/:id/3d` renders one recorded execution as a three-dimensional process
space. It is a **visualization of the existing evidence**, not a second telemetry
source. Every node, edge, size, colour and activity in the scene is a mapping of
state that the CAPS engine, the procfs collector and the canonical event store
already produced and persisted.

## The one rule

There is exactly one data path, and the 3D view sits at the end of it:

```
CAPS engine events -> gateway canonical events -> node:sqlite store
        -> REST/SSE -> lib/telemetry.ts view-model -> lib/processSpace.ts -> 3D scene
```

Consequences that the code is written to enforce:

- The browser **never** reads `/proc`, never resolves a PID, and never polls the
  operating system for the 3D view.
- No second telemetry collector, no duplicate inspector model. The 3D shell
  reuses `ProcessTelemetry` and `ProcessGraph` from the 2D observatory, and
  `buildVisualState` from the shared view-model.
- Replay renders persisted events only. It never re-executes the command.
- Nothing is interpolated between samples and nothing is extrapolated past the
  newest sample. A value the record does not contain is shown as `UNAVAILABLE`,
  never as `0` or a guess.

## What the scene contains, and what it deliberately does not

The gateway observes exactly two PIDs per execution: the CAPS engine it spawns,
and the one direct child that `caps_fork_tree` creates. `execvp()` replaces that
child's image in place, so the PID never changes and there is no second process
node for an exec.

| Evidence | 3D representation |
| --- | --- |
| Observed PID | One node. One node per `process.started`, keyed by PID. |
| Observed PPID matching an observed parent | A verified edge. Nothing else draws an edge. |
| `process.started` → `process.exited` | The node's lifetime bar along the time axis. |
| `process.exec` (image replacement) | A marker at that execution time on the same node. |
| `process.snapshot` RSS | Bounded node radius. |
| `process.snapshot` CPU | A ring around the node while running. |
| Lifecycle events | Discrete markers on the time axis. |

Because descendants are not sampled, the scene shows one child. It does not
synthesize a fan-out, and the limits of the record are printed under the legend,
so a reader who runs `caps_fork_tree` can see exactly why there are two nodes
rather than a tree. See [process telemetry](telemetry.md) for why the sample set
is what it is.

## What is derived, and what is only presentation

`position`, `size`, `colour` and `activity` are each a **pure function of the
record**: the same execution draws the same geometry every time, for every
reader. Nothing is interpolated between samples and nothing is wall-clock.

The one thing that moves on a clock is the slow idle turn and emissive pulse of a
node that is still running. It is deliberately on channels that encode nothing:
**rotation** and **emissive intensity**, both bounded by fixed ceilings, never
**size** (size is RSS) and never position. It is switched off entirely when the
process is terminal, when the active lens recorded nothing, and when
`prefers-reduced-motion` is set. It once displaced `position` by a wall-clock
sine, which made two readers of the same record see different geometry and made
the page's own "every position is a mapping of recorded state" claim false.

Node **colour** is the lifecycle state and nothing else, using the product's
semantic tokens — cyan active/observed, violet execution transition, emerald
successful completion, amber signal or timeout, red failure, and neutral greys
for "the record cannot place this process in a state at this cursor". That
includes the CAPS engine node, which used to be painted a fixed grey: colour
meant "unsampled" there instead of "this process is running, or has been
reaped". Its missing sample is stated by its minimum size, its absent activity
ring, and the note in the tooltip and the table — the channels that can state an
absence without misstating a lifecycle.

## Coordinate system

One deterministic mapping, used by every camera preset:

| Axis | Meaning |
| --- | --- |
| **X** | Deterministic sibling lane, assigned by creation time, then event sequence, then PID — never by PID order alone, so the same record always lays out identically. |
| **Y** | Process-tree depth. Engine at `0`, the observed child at `1`. |
| **Z** | Execution time. `0` is the first event in the record; the whole span is normalized to a fixed axis length, so the same record always fills the same depth. |

Time is normalized to a fixed world length rather than to the record's wall-clock
duration, so a 40 ms command and a 40 s command are both legible. The ruler above
the axis always states the real span.

## Topology mode and timeline mode

They are the **same data** with different camera positions and emphasis — not two
datasets:

- **Topology** looks down the time axis at lanes and depth. This is the view that
  makes parent/child structure readable.
- **Timeline** looks along the time axis, so the run reads like a flight-recorder
  strip: lifetime bars, exec markers and gaps in the record are what you see.

## Camera presets, and what a camera move is allowed to do

The preset set is **Orbit**, **Process tree**, **Timeline**, **Top**, **Side**
and **Fit**. A preset is a *direction*, never a coordinate: the camera's distance
from its target is derived from the bounding sphere of what the record actually
draws (`sceneBounds`, from the same `nodePosition` mapping, the largest radius a
node can reach, each node's recorded lifetime along Z, and the grid's own
extent), divided by the camera's real field of view and aspect ratio. A 40 ms run
and a 40 s run therefore both land framed, and a narrow window does not clip the
record.

| Control | Effect |
| --- | --- |
| Reset view (`R`) | Reframe the whole record from the current preset direction. |
| Focus selected (`F`) | Frame the selected process. A **no-op when nothing is selected** — there is nothing to frame, and it is never a reset. |
| Fit process tree | The `tree` direction, refitted to the whole observed record, looking down the time axis. |

Focus has its own request counter, separate from Reset. Both used to bump one
shared counter that only the reset path read, so `F` on an already-selected node
re-ran nothing and silently reset the camera — the opposite of what the button
title and the shortcut help promised.

Every one of these moves is expressed as a goal and consumed by the **same
exponential lerp** (`1 - exp(-7·dt)`). No path assigns the camera position
outright, so a preset is never an abrupt cut. The single exception is
`prefers-reduced-motion`, where the lerp factor is 1 and the move is instant
*by design*: that is the accessibility contract, not a shortcut.

A framing is requested, not tracked. The rig's effect keys on the request and on
the scene's extent, so a fresh procfs snapshot for a process that already exists
cannot re-centre the view behind a reader who is orbiting it. `Follow cursor`
remains the only automatic camera motion, and it is opt-in.

## The shared cursor

The 3D view does not own a clock. The page owns one execution-time cursor and
passes it down, exactly as the 2D observatory does:

- In **live** mode the cursor is `null`, which means "the newest recorded
  evidence" — including lifecycle events that came after the last snapshot. A
  finished execution therefore reads as finished rather than still running.
- The moment a reader seeks — the replay scrubber, or the arrow keys — the
  cursor holds that position.
- A node's state at the cursor is the **latest recorded sample at or before that
  time**. Never the next one, never an average.

Arrow keys step between recorded sample times, so the cursor only ever lands on a
time the record actually contains. In live mode stepping is disabled, because a
manual step there would place the cursor at a position the evidence does not
support.

## The three selection concepts

The observatory never collapses "what is selected" into one identifier. Three
concepts are tracked separately, because they mean different things and one of
them is not a substitute for another:

| Concept | Field | Meaning |
| --- | --- | --- |
| Time selection | `cursorMs` | An execution-time cursor in milliseconds since the record's first event. `null` means "follow the newest recorded evidence" (live), never "time zero". |
| Process selection | `identity` | A verified process identity: `sessionId` + `pid` + `processStartTime`. |
| Event selection | `eventSeq` | The canonical sequence number of one event. |

The rules that follow from keeping them separate:

- Selecting a **process** does not move the cursor. Choosing which process you
  are reading is not choosing when.
- Selecting an **event** moves the cursor to *that event's own recorded
  timestamp*. An event has an exact time; the cursor never interpolates toward it.
- Selecting a **process** with no event places the cursor at that process's
  *first observed evidence*: its first procfs sample, or the event that
  established it when it is never sampled.
- Clearing a process selection leaves an event selection alone, and clearing an
  event selection leaves a process selection alone. Only `clearAll` drops both.
- `Escape` clears the evidence selection; the cursor returns to live following.
  Arrow keys move the cursor only.

## Process identity, and why a PID is not enough

A process is identified by the execution it belongs to **plus** its Linux PID
**plus** the kernel start time the collector derived from
`/proc/<pid>/stat` field 22.

```
sessionId + pid + processStartTime
```

- When both sides of a comparison carry a start time, they must be **equal**. A
  recycled PID is therefore a different process, and is refused rather than
  silently matched.
- When a start time is genuinely unavailable, the match degrades to
  `session + pid` and the UI **says so** through `Identity match =
  session+pid`. It never implies a full match.
- Correlation never crosses executions. A selection made for one session is not
  applied to another; the store clears on session change and the resolution layer
  refuses a foreign `sessionId`.
- The derived start time is anchored to `/proc/stat` `btime` plus the kernel's own
  start ticks and clock-tick rate. It is a pure function of kernel values, so it
  is the *same string* for every sample of one process. Deriving it from the wall
  clock instead would drift by a millisecond between samples, and the
  start-time guard would then reject the process's own samples.

The gateway-spawned CAPS engine is never procfs-sampled, so it has **no** derived
start time and no samples. That is a truthful `UNAVAILABLE`, not a gap: it is
drawn as a structural node, its identity degrades to `session+pid`, and the UI
states why.

## Correlation: what one selection resolves to

`lib/evidenceCorrelation.ts` is the single pure decision function shared by every
surface, so the 2D and 3D views cannot drift apart.

| Direction | Rule |
| --- | --- |
| event → process | `process.*`/`signal.*` events with a verified envelope PID map to that observed process; a `process.snapshot` maps to the PID it sampled; `execution.*`, `command.*`, `session.summary` map to **no** process, and none is invented. |
| event → cursor | The event's own recorded timestamp, relative to the record origin. Never interpolated, never nearest-guess. |
| process → cursor | First observed evidence: first sample, or the establishing event when unsampled. |
| process → 3D | The process-space node for that identity; one node per observed identity. |
| cursor → 3D | The latest recorded sample at or before that time. Never the next one, never an average. |
| 3D ↔ inspector | The same identity and cursor drive both; the 3D shell reuses the 2D `ProcessTelemetry`. |
| 3D ↔ timeline | Selecting a node or a marker selects the canonical event sequence, and the timeline highlights it. |
| event → 3D | An event marker or an `execvp()` transition selects sequence, verified identity and exact time atomically. |

Selecting an event that belongs to a *different* process than the one already
selected does not overwrite the reader's choice; the UI reports the mismatch and
leaves the selection where it was.

## Verified hierarchy only

A parent/child edge is drawn, and highlighted on selection, only when the child's
**observed** procfs PPID equals an **observed** parent's PID. There is no
inference from arrival order, timing, command name, layout position or similar
telemetry. An observed PPID that is not an observed process yields no edge at all.

Selecting either end of a verified edge keeps the other end prominent; unrelated
verified topology recedes rather than disappearing, so the reader keeps the shape
of the record.

## Resource lenses

Node size is a **visualization mapping** of exactly one canonical metric, chosen
by the reader. It is not a score, a health rating, or a composite: no lens mixes
metrics, and no lens invents one.

| Lens | Reads | Mapping |
| --- | --- | --- |
| Normal · RSS | `rssBytes` (OBSERVED) | `radius = clamp(RMIN + span * log1p(rss / 1 MiB) / log1p(4096), RMIN, RMAX)`; 4 GiB maps to `RMAX`. |
| CPU | `cpuPercent` (DERIVED rate) | `radius = clamp(RMIN + span * min(1, cpuPercent / 100), RMIN, RMAX)`; the ring shows the same value. |
| Memory · RSS | `rssBytes` (OBSERVED) | As Normal; resident memory only, never virtual size. |
| I/O | the largest of `rcharBytesPerSec`, `wcharBytesPerSec`, `readBytesPerSec`, `writeBytesPerSec` | `radius = clamp(RMIN + span * maxOfThose / peakOfThoseSameCounters, RMIN, RMAX)`. |
| Faults | `max(minorFaultsPerSec, majorFaultsPerSec)` | `radius = clamp(RMIN + span * maxOfThoseRates / peakOfThoseSameRates, RMIN, RMAX)`. |

Two consequences worth stating plainly:

- The **faults** lens reads per-second *rates*. The cumulative counters
  `minorFaults`/`majorFaults` are never displayed as an activity level, because
  they only ever grow.
- A metric the record does not contain stays `UNAVAILABLE`. It never becomes `0`.
  A process the collector never sampled is drawn at the minimum radius and is
  labelled as such, not shown as an empty process.

The active lens, its unit and its exact mapping are always published on screen,
so no visual channel is ambiguous.

## Replay in the 3D view

Replay is a **reconstruction of persisted canonical evidence**, not a live
collection. Entering `/execution/:id/3d?replay=1`:

- does not execute anything and does not launch CAPS;
- does not poll live procfs and does not start a telemetry sampler;
- creates no new events and no new snapshots, and mutates no persisted evidence;
- reconstructs the scene from the events visible at the cursor, so the scene is
  genuinely partial while replaying rather than showing the future;
- owns the shared cursor, and reaches the terminal event's own timestamp on
  "jump to end".

The replay panel's cursor echoes are tagged `replay` in the store, so they are
not fed back into the panel as a seek. Only a cursor moved by another surface — a
peak card, the 2D timeline — is followed, which is what stops the seek/cursor
loop from oscillating. Changing the camera mode preserves replay rather than
dropping the reader out of it.

## Degradation, in order

1. **No WebGL** — `detectWebGL()` runs before any three.js code. The reader gets
   an explanation, the existing 2D `ProcessGraph`, and a link to the 2D
   observatory. No blank canvas, no thrown error. The observed processes stay
   reachable as an ordinary DOM list and an ordinary table.
2. **A component throws** — `SpaceErrorBoundary` catches it, keeps the rest of
   the page alive, and offers a retry.
3. **The GPU context is lost** — a native `webglcontextlost` listener (React's
   synthetic events do not cover this one) reports the loss so the page can swap
   in the same fallback instead of leaving a dead rectangle on screen.
4. **Table view** — the same evidence as an ordinary `<table>` with a caption:
   PID, role, image, state, the active lens value, and the verified parent.
5. **Reduced motion** — `prefers-reduced-motion` makes camera moves instant
   instead of eased, disables orbit damping, and stops the node and
   selection-ring pulses. Evidence access never depends on an animation: selection,
   hover, replay and every control remain fully usable.


## Accessibility

- The scene is an enhancement. The **Table** view exposes every observed process
  as an ordinary `<table>` with a caption, including PID, role, command, state,
  depth, verified parent, CPU, RSS and lifetime.
- The inspector under the scene is the same `ProcessTelemetry` component the 2D
  observatory uses, driven by the same cursor.
- Control groups (Mode, Resource lens, View) are labelled `role="group"` regions,
  so the mode switch is distinguishable from the camera preset of the same name.
  Each group's label is a single DOM id token, because `aria-labelledby` treats
  spaces as a list of ids.
- Observed processes are also a keyboard-reachable list: each row is a real
  `<button>` with `aria-pressed`, reachable by Tab, and the group handles arrow
  keys to move the selection. Selection, hover and clearing all work without a
  pointer.
- Every value in the scene has a textual equivalent; the encoding legend is
  always visible so no visual channel is ambiguous.
- The legend is **below** the scene, not over it, and it is generated from the
  view-model: the lifecycle colours come from `statePalette`/`spaceStateLegend`,
  the lens list and each lens's unit from `LENS_SPECS`, and the three provenance
  classes from the shared `ProvenanceBadge`. A legend written out by hand beside
  the model is a legend that eventually describes a state the scene cannot
  produce.
- Shortcuts: `R` reset view, `F` focus selection, `Space` toggle replay,
  `←`/`→` step between samples, `Esc` clear selection. The app-wide single-letter
  shortcuts are untouched, and typing in a field triggers nothing.

## Performance and GPU hygiene

- The 3D bundle is code-split. It is fetched only when a reader opens
  `/execution/:id/3d`; the rest of the app never downloads three.js.
- Geometry, materials and the WebGL context are created by React and released on
  unmount. The camera rig stops its frame loop when the canvas unmounts.
- `useFrame` is used only for camera easing and idle motion. It is never a data
  poller: new data arrives as React props, and a re-render updates the scene.
- Individual meshes are used rather than instancing. At the design ceiling of
  about 100 nodes that is well within budget, and it keeps per-node colour,
  radius and selection state explicit.
- No postprocessing, bloom or custom shader pipeline. Standard materials only.

## Dependencies

`three`, `@react-three/fiber`, `@react-three/drei` and `@types/three`. Recharts,
Motion and Zustand are unchanged; the 2D views still own 2D rendering.

## Known limitations

- The CAPS engine itself has no procfs sample and no derived start time, so the
  engine node carries no resource values and its identity matches on session and
  PID only. It is shown as a structural node, not a measured one.
- Descendants of the observed child are not sampled, so the topology is a chain,
  not a tree.
- `CANCELLED` is a session status in this system, not a canonical event type, so
  no event can produce it and the scene never invents one.
- The Z axis is normalized, not linear in wall-clock seconds. The ruler states the
  real span.
- There is no pixel-baseline or visual-diff harness in this project, so "the scene
  looks right" is not something this repository can assert automatically. What is
  asserted is functional: a live WebGL context, a painted canvas, a real observed
  process list, working selection and synchronisation, and the documented
  fallbacks.
