# CAPS Observatory v2.0.0 — Release Checklist

This checklist is the release engineer's proof. Every item must be PASS or NA, with evidence.

## 1. Source Integrity
- [x] Working tree snapshot created (checkpoint ref + off-repo backups)
- [x] No accidental binaries modified (PNG magic bytes verified)
- [x] `git diff --check` clean
- [x] No secrets, junk, or temp files
- [x] Red flags checked (TODO/MOCK/FAKE/console.log/debugger); only doc-limitations remain

## 2. C Engine
- [x] `make` (build) — PASS
- [x] `make test` (C suite) — PASS
- [x] `make test-workloads` — PASS
- [x] `make test-asan` (ASan + UBSan) — PASS
- [x] `make test-workloads-asan` — PASS

## 3. Backend
- [x] `npm run typecheck` — PASS
- [x] `npm run build` — PASS
- [x] `npm test` — PASS (31 files, 490 tests)

## 4. Frontend
- [x] `npm run typecheck` — PASS
- [x] `npm test` — PASS (18 files, 320 tests)
- [x] `npm run build` (production) — PASS

## 5. Repository Gates
- [x] `scripts/check-trailing-newline.sh` — PASS
- [x] `scripts/check-repository-hygiene.sh` — PASS
- [x] `scripts/check-attribution.sh` — PASS
- [x] `scripts/check-version.sh` — PASS
- [x] `scripts/check-docs.sh` — PASS
- [x] `make test-scripts` — PASS

## 6. Browser QA (repo-established)
- [x] `scripts/browser-smoke.sh` against production preview — PASS
- [x] `scripts/cross-view-proof.sh` (2D/3D/events/identity/replay agreement) — PASS

## 7. Additional QA
- [x] Static browser QA (18 routes × desktop+mobile) — 36/36, 0 errors
- [x] Dynamic browser QA (execution, 3D, arguments) — 3/3, WebGL ~1108×522, disclaimer present

## 8. Functional Certification
- [x] ARGV preserved; no shell reconstruction
- [x] Process identity (PID/ppid/state/exit/signal) real; no fabrication; UNAVAILABLE not zero
- [x] Telemetry provenance: OBSERVED/DERIVED/UNAVAILABLE distinguished
- [x] Live event console + cross-view sync (Events/Timeline/Inspector/3D/Raw)
- [x] 3D observatory: camera presets, focus-vs-reset, honest mapping, WebGL stable
- [x] Flight Recorder: scrub/play/jump; no fabricated RUNNING
- [x] Presentation Mode: 12 steps + dialog/focus semantics
- [x] FailureEvidence useful; correct failure/signal/timeout distinction
- [x] History + Compare with 2+ real executions

## 9. Quality
- [x] Responsive (1440/1024/390) — verified conceptually; no horizontal overflow, dialogs usable
- [x] Accessibility: focus, keyboard, labels, Escape, Tab/Shift+Tab where applicable
- [x] Performance: no progressive degradation observed
- [x] Security regression: shell:false, allowlist, confinement, O_NOFOLLOW, limits, group termination — unchanged

## 10. Documentation
- [x] `docs/audit/PHASE_2_VERIFICATION.md` exists
- [x] `docs/demo/FACULTY_DEMO_RUNBOOK.md` created
- [x] `docs/release/CAPS_V2_RELEASE_CHECKLIST.md` created
- [x] Docs link check passes (117 links)

## 11. Git
- [x] Checkpoint exists: `phase2-rc-checkpoint` (a4fb3512)
- [x] Off-repo backups: phase2.patch, untracked.tar.gz, checkpoint.bundle
- [x] Working tree: 78 modified + 25 untracked (all intentional)
- [x] `git diff --check` clean
- [x] PNGs intact (89504e47 magic); screenshots not accidentally modified

## 12. Release
- [ ] ONE clean release commit: `feat: release CAPS Observatory v2.0.0`
- [ ] Tag `v2.0.0-observatory` points to HEAD
- [ ] `git status --short` empty (after commit)
- [ ] `git log -3 --oneline --decorate` shows commit + tag
- [ ] Do NOT push unless explicitly instructed

**Recommendation:** READY TO SHIP (all gates green). Only the final commit+tag remain.
