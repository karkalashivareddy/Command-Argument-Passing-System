# Phase 2 Verification Report

Base commit: `6177f7c` · Working tree, uncommitted
Scope: Phase 2 product/UI/3D/demo work, verified against the Phase 1 guarantees.

---

## 1. Verification result

Every gate passes. Nothing in this report is a claim about intent; each line is a
command that was run after the final edit.

| Gate | Command | Result |
|---|---|---|
| Engine + workloads build | `make build` | PASS |
| C test suite | `make test` | PASS |
| Workload suite | `make test-workloads` | PASS |
| ASan + UBSan engine | `make test-asan` | PASS |
| ASan + UBSan workloads | `make test-workloads-asan` | PASS |
| Repository hygiene | `scripts/check-repository-hygiene.sh` | PASS |
| Trailing newline | `scripts/check-trailing-newline.sh` | PASS |
| Attribution | `scripts/check-attribution.sh` | PASS |
| Version consistency | `scripts/check-version.sh` | PASS |
| Docs link check | `scripts/check-docs.sh` | PASS |
| Backend typecheck | `tsc --noEmit` | PASS |
| Backend build | backend build | PASS |
| Backend tests | Vitest | PASS — 31 files |
| Frontend typecheck | `tsc --noEmit` | PASS |
| Frontend tests | Vitest | PASS — 18 files, 320 tests |
| Frontend production build | `vite build` | PASS |
| Static browser QA | 18 routes × desktop + mobile | PASS — 36/36, 0 errors |
| Dynamic browser QA | execution, 3D, arguments | PASS — 3/3 |

Static QA reports zero console errors, zero page errors, zero HTTP ≥ 400, zero
failed requests, and zero overflow across all 36 combinations.

Dynamic QA ran a real workload (`seq 1 40000`, session `exec_muyc8w4f3a2e4e96c0`),
which reported `COMPLETED exit=0`, then verified the execution page, the 3D page
(WebGL canvas `1108x522`, disclaimer present), and the arguments page.

---

## 2. Phase 1 guarantees still hold

The Phase 2 work was explicitly forbidden from touching these. Each was re-tested.

**Security**
- `shell: false` spawn, catalog allowlist, workspace confinement, `O_NOFOLLOW` — unchanged.
- `awk`/`sed` scanned by `programPolicy.ts`; `programOperand` enforced in `validation.ts`.
- Live RLIMIT proof: 16 MiB workload under 64 MiB `RLIMIT_AS` → exit `0`; 128 MiB workload → bounded exit `3`.

**Telemetry**
- `RawMetric` `{ value, provenance, reason?, unitNote? }` is the only path to a displayed number.
- `UNAVAILABLE` means no counter was recorded. It is never rendered as `0`.
- DERIVED rates keep the caveat that produced them; the I/O lens tooltip names which of the four counters the value came from.

**Events and identity**
- Only persisted events are published. Timeout produces exactly one terminal event.
- Identity is `pid` + kernel start time, guarded against PID reuse.
- Process-group termination is verified after signalling, not assumed.

**Replay**
- Replay reads persisted events and never re-executes.
- Replay status is derived from stored events; it does not display a fabricated `RUNNING`.

---

## 3. What Phase 2 delivered

**Design system** — `styles/tokens.css` centralises glass, elevation, motion and type scales; `styles/field.css` adds the ambient field and motion utilities; `AmbientField.tsx` renders it.

**Shell** — `Sidebar.tsx` reorganised into five groups (Core / Observe / Lab / Explain / System); `Topbar.tsx` carries engine, SSE, platform and version status; `AppShell.tsx` owns the glass layer stack.

**Overview** — hero, `LifecycleRail.tsx` driven by real canonical event types, `LiveExecution.tsx` for the live panel, and P50/P95 from actual samples.

**3D observatory** — fixed the Focus-vs-Reset camera bug; replaced implicit position mapping with explicit node → world coordinates; added camera presets; `SpaceLegend.tsx` generates its state list from `spaceStateLegend()` so the legend cannot drift from the model.

**Presentation mode** — 12 steps in `presentationSteps.ts`, dialog semantics and focus handling in `PresentationOverlay.tsx`, keyboard bindings in `shortcuts.ts`, help in `ShortcutHelp.tsx`.

**Demo** — 8 real presets in `facultyPresets.ts`, each verified against the catalog, surfaced in `DemoPage.tsx`.

**Flight recorder** — accessible scrubber in `ReplayPanel.tsx` over persisted events; the fabricated `RUNNING` status is gone.

**Event console** — `EventStream.tsx` with categories, filtering, search, and selection shared through the store so the 3D view and the console cannot disagree.

**Failure evidence** — `FailureEvidence.tsx` and `evidenceChain.ts`; `ExecutionPage.tsx` and `HistoryPage.tsx` upgraded to archive rows.

**Dead code** — 10 exports removed after proving each had no remaining reference: `useNow`, `stageLimit`, `firstToken`'s redundant path, `stageForEvent`, `nextSampleMs`, `previousSampleMs`, `lensUnavailable`, `nodeForIdentity`, `cursorPosition`, `emptySelection`, `isSelectionEmpty`.

---

## 4. Two mistakes made during this phase, and what they cost

Recording these because the same two failure modes would otherwise be repeated.

**A `git checkout` destroyed uncommitted work.** While removing dead code I reverted
`processSpace.ts`, `evidenceCorrelation.ts` and `stages.ts` to HEAD, which discarded the
Phase 1 provenance integration and the 3D legend work in the same breath. It was
recovered by re-deriving the code, and verified by typecheck plus the full suite — but the
correct tool was to have used `git stash`, which preserves uncommitted work by
construction. There was no backup; recovery depended on knowing what the change was.

**A blanket newline fix corrupted 19 PNGs.** The repository's trailing-newline gate
flagged 7 source files; the fix iterated over *all* tracked files with
`tail -c 1` and appended a byte to every binary it found, adding a stray byte to 19
screenshots. Reverted with `git checkout -- docs/screenshots/`, verified by checking
the PNG magic bytes (`89504e47`) and confirming the directory is clean. The correct
scope was the 7 files the gate named.

Both were caught by verification rather than by review, which is the argument for
running the gates after every edit rather than batching them at the end.

---

## 5. Changed surface

```
80 tracked files changed, 5198 insertions(+), 1188 deletions(-)
```

Plus 57 new source files across backend, frontend components, libs and styles.

---

## 6. Known limitations

- The frontend must be run from WSL Ubuntu. Linux-native `node_modules` and the ELF
  `caps` binary make native Windows execution unreliable.
- Vite CSS HMR is unreliable on `/mnt/c`; restart the dev server after CSS edits.
- `vite preview` can serve a stale `dist/`; rebuild before any screenshot or browser QA.
- Dynamic browser QA requires the gateway on `127.0.0.1:3100`
  (`CAPS_PROXY_TARGET` in `web/frontend/.env.local`).

---

## 7. Release decision

**Ready to ship.** All correctness, security, telemetry, event and identity guarantees
from Phase 1 are intact and re-verified. All Phase 2 gates pass. No known defect
outstanding.
