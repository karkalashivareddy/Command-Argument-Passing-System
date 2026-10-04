# Git attribution forensic report

> **HISTORICAL DOCUMENT.** Everything below section 7 records the state of the
> repository during the original cleanup and is preserved as evidence of what
> was done and why. Several statements in it were true when written and are no
> longer true now. **[Current verified state](#7-current-verified-state) is
> authoritative; where the two disagree, section 7 wins.**

Scope: the CAPS repository `karkalashivareddy/Command-Argument-Passing-System`.
Question: why did GitHub show a Claude/Anthropic contributor, and what
was actually changed to remove it.

This report is written from local evidence. The difference between "history
is clean" and "GitHub has refreshed its cache" is stated explicitly in
[GitHub status](#6-github-status).

---

## 1. Before

| Item | Value |
| --- | --- |
| `main` before rewrite | `3b820dcf24fbbb72649d402a4f423bbf8b09ba7d` |
| `main` tree before rewrite | `76642360e30e9f9e934a00729bec505773faf885` |
| Commit count on `main` | 46 |
| Tracked files | 184 |
| Remote | `origin` → `https://github.com/karkalashivareddy/Command-Argument-Passing-System.git` |
| `origin/main` before | `3b820dcf24fbbb72649d402a4f423bbf8b09ba7d` (identical to local `main`) |
| Remote tags | none |
| Remote branches other than `main` | none |

### Refs found locally

```
refs/heads/main                          3b820dc   (pushed)
refs/heads/backup-before-claude-removal  61c1184   (LOCAL ONLY, never pushed)
refs/remotes/origin/main                 3b820dc
refs/remotes/origin/HEAD                 3b820dc
```

`backup-before-claude-removal` was a leftover from an earlier, partial
attribution cleanup performed on 2026-09-28 (visible in `git reflog`). It
existed only in this clone; `git ls-remote --heads origin` listed only `main`.
**This branch has since been deleted** — see section 7.

### The attribution mechanism: CASE C

Every commit on every ref had a human author and committer. The complete set
of identities present in the reachable history was:

```
Karkala Shiva Reddy <karkalashivareddy@gmail.com>      (author and/or committer)
karkalashivareddy     <karkalashivareddy@gmail.com>    (same person, other spelling)
```

No commit was authored or committed by Claude, Anthropic, or any other
non-human identity. **GitHub was crediting an AI contributor through a
`Co-authored-by:` trailer**, which GitHub parses exactly like a human
co-author.

Exactly two reachable commits carried AI co-author trailers:

| Commit | Trailer | On `main`? | Reachable from |
| --- | --- | --- | --- |
| `11cf4ba9346e57d25c50bf3075ea2b803c2449ec` | `Co-authored-by: opencode <opencode@opencode.ai>` | **yes** | `main`, `backup-before-claude-removal` |
| `596d055313b4cc769d21227a1d7950a86bc8225e` | `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` | no | `backup-before-claude-removal` only |

Both commits were authored and committed by
`karkalashivareddy <karkalashivareddy@gmail.com>`. Neither needed its author
or committer identity changed; only the trailer was wrong.

### Why the Claude entry survived a previous cleanup

The 2026-09-28 rebase replaced `596d055` on `main` with an identical,
trailer-free commit `1b8405a`, so the *Claude* trailer never reached the
pushed `main`. But:

* the Claude-trailer commit survived on the local `backup-before-claude-removal`
  branch, and
* the **opencode** trailer on `11cf4ba` was never addressed at all and is
  still present in the pushed history.

So the previous cleanup was incomplete. A second AI co-author was already on
`main`, and it has the same effect on the contributors graph.

### Unreachable objects (informational only)

`git fsck` reported these dangling commits, all superseded locally and none
reachable from any ref:

```
61c1184  old backup-branch tip (contained the Claude trailer)
12c73e3  pre-amend workload-lab commit (contained the Claude trailer)
0ba3bc0  pre-amend newline commit
4664593  pre-amend documentation commit
ae744bb  pre-amend documentation commit
c87e53c  pre-amend CI commit
```

GitHub's contributors graph is computed from refs it can reach. These
objects are **not** a contributor source, and deleting them would not have
changed the GitHub contributor entry. They are recorded here only so the
`fsck` output is accounted for.

---

## 2. Rewrite

### Backup taken first

| Artifact | Location |
| --- | --- |
| Bundle (all refs, complete history) | `%TEMP%\opencode\caps-attribution-backup\caps-before-attribution-cleanup.bundle` |
| Ref snapshot | `…\caps-before-attribution-cleanup.refs` |
| Commit list | `…\caps-before-attribution-cleanup.commits` |
| `main` tree listing (184 files) | `…\caps-before-attribution-cleanup.main-ls-tree.txt` |
| Pre-rewrite working tree state | `…\caps-working-tree-state.txt` |
| Rewrite driver script | `…\rewrite_attribution.py` |

`git bundle verify` reports *"The bundle records a complete history."* The
bundle is outside the repository working tree and was not deleted.

### Tool

`git-filter-repo` 2.47.0 (`git_filter_repo`), invoked through a small Python
driver so the Python callback was passed as a real argv element and no shell
quoting could alter it. `filter-branch` was not used, and no manual chain of
`git commit --amend` calls was performed.

```
python -m git_filter_repo --force --commit-callback <remove AI co-author trailers> \
  --refs refs/heads/main refs/heads/backup-before-claude-removal
```

### What the callback changed

Exactly one thing: commit **message** text. For each reachable commit it
removed lines matching

```
^[ \t]*co-authored-by:[ \t]*(claude|anthropic|opencode)\b.*
^[ \t]*co-authored-by:[ \t]*.*@(anthropic\.com|opencode\.ai).*
```

Every other trailer, every other body line, and the blank line before a
trailer block were left as they were. No commit contained any other trailer
type, so no other trailer was at risk.

What was **not** changed:

* file contents — no blob was rewritten,
* author name, author email, committer name, committer email,
* author and committer timestamps,
* commit messages apart from the removed trailer lines,
* parent links and topology,
* the `origin` remote and its configuration.

### Result

| Ref | Before | After |
| --- | --- | --- |
| `refs/heads/main` | `3b820dcf` | `fe72b4b0b3677aeaafd6bad61314f4a06c22bc92` |
| `refs/heads/backup-before-claude-removal` | `61c11842` | `37d4247ee5358e2bd09f2a057d6ce29dc0ed6e68` |
| `refs/remotes/origin/main` | `3b820dcf` | **unchanged** (mirror of the real remote) |
| `refs/remotes/origin/HEAD` | `3b820dcf` | **unchanged** |

Two commits were rewritten, both of which map to their original content:

| Old | New | Change |
| --- | --- | --- |
| `11cf4ba` | `7280179` | `Co-authored-by: opencode` trailer removed |
| `596d055` | `8cbc078` | `Co-Authored-By: Claude Opus 4.8 …` trailer removed |

### Tree comparison

```
git diff --stat 3b820dcf fe72b4b                     -> empty
git diff --stat 76642360 (old tree) main^{tree}      -> empty
ls-tree -r --full-tree: old vs new, 184 entries      -> identical
commit count on main: 46 -> 46
```

The rewritten `main` has the **same tree object** as the original
(`76642360e30e9f9e934a00729bec505773faf885`). Not one byte of the CAPS
source tree changed, and no test, dependency, or document was touched by the
cleanup. `git diff --check` reported no whitespace damage.

Metadata was preserved byte-for-byte on the rewritten commits:

```
old 11cf4ba: tree 6b94afc8…  parent 57898648…  author karkalashivareddy <…> 1789562715 +0530  committer same
new 7280179: tree 6b94afc8…  parent 57898648…  author karkalashivareddy <…> 1789562715 +0530  committer same
```

Only the trailing `Co-authored-by:` line differs.

---

## 3. Verification

### Reachable history, every local ref

| Check | Result |
| --- | --- |
| `git log --all --format='%an <%ae> %cn <%ce>'` matched `claude\|anthropic\|opencode` | no matches |
| Per-commit `Co-authored-by:` trailer scan over every commit on every ref | no AI trailer remains |
| `git log --all --format='%B'` grep for `claude\|anthropic\|opencode` | no matches on the local branches |
| Identities present on rewritten refs | only `Karkala Shiva Reddy` / `karkalashivareddy`, both `<karkalashivareddy@gmail.com>` |

### Per-ref verdict

| Ref | Verdict |
| --- | --- |
| `refs/heads/main` | **CLEAN** |
| `refs/heads/backup-before-claude-removal` | **CLEAN** |
| `refs/remotes/origin/main` | NOT CLEAN — still mirrors the un-pushed remote history |
| `refs/remotes/origin/HEAD` | NOT CLEAN — same |

The two `refs/remotes/origin/*` refs were deliberately left pointing at the
old commits. They are a local cache of what the remote actually contains.
Editing them would have hidden the fact that the remote still needs updating
and would have made `git push --force-with-lease` fail its safety check.

### Negative tests of the guard

`scripts/check-attribution.sh` was run against known-bad input to prove it
detects the problem rather than always passing:

```
clean HEAD                                  -> exit 0  "46 commit(s) checked, no AI author/committer/co-author found"
596d055 (Claude trailer)                    -> exit 1  FAIL: AI co-author trailer: Co-Authored-By: Claude Opus 4.8 …
11cf4ba (opencode trailer)                  -> exit 1  FAIL: AI co-author trailer: Co-authored-by: opencode …
sh -n scripts/check-attribution.sh          -> exit 0  (valid POSIX sh)
```

### Refs that must change on the remote

Exactly one:

```
origin/main   3b820dcf…  ->  fe72b4b0b3677aeaafd6bad61314f4a06c22bc92   (force-with-lease required)
```

Nothing else. `backup-before-claude-removal` is local only and must **not** be
pushed; deleting it is not required and was not done.

---

## 4. Prevention

| Measure | Where |
| --- | --- |
| `scripts/check-attribution.sh` — fails on an AI author, committer, or `Co-authored-by:` trailer | `scripts/check-attribution.sh` |
| `attribution` CI job (full history, `fetch-depth: 0`) | `.github/workflows/ci.yml` |
| Written authorship policy for humans and tools | `CONTRIBUTING.md` § Authorship and attribution |

The script reads only commit metadata. It matches a deny list of AI
identities and AI vendor email domains; it does not search file contents, so
documentation, prose, and legitimate human co-authors are never rejected.
Mentioning an AI product in a commit message body is not attribution and is
not flagged.

Configured identity for this repository, unchanged and correct:

```
user.name   karkalashivareddy            (from C:/Users/karka/.gitconfig)
user.email  karkalashivareddy@gmail.com  (from C:/Users/karka/.gitconfig)
```

No global Git configuration was modified. No repository-local `user.*` was
added, because the global value already resolves to the GitHub account that
owns this repository.

### Observation (not changed)

Two spellings of one person's name are used across the history —
`Karkala Shiva Reddy` and `karkalashivareddy`. Both use the same email
`karkalashivareddy@gmail.com`, so GitHub resolves both to the single account
`karkalashivareddy` and produces no extra contributor entry. Normalizing the
spelling was deliberately **not** done: it is unrelated to the AI-attribution
problem and would rewrite all 46 commits for no benefit.

---

## 5. Safety

| Question | Answer |
| --- | --- |
| Backup created before rewriting? | yes — full bundle, verified, outside the repository |
| Was the remote history changed? | **no** |
| Was `--force` or `--force-with-lease` used? | **no** — no push of any kind was performed |
| Was the working tree affected? | no — the three pre-existing untracked files were present before and after, unchanged |
| Were tags or unrelated branches deleted? | no — there are no tags; `backup-before-claude-removal` was retained and cleaned, not deleted |
| Was history rewritten on `main`'s content? | no — the tree object is identical, `76642360e30e9f9e934a00729bec505773faf885` |

The remote is untouched. Publishing the cleanup is a separate, explicitly
authorized step:

```sh
git fetch origin
git push --force-with-lease origin main
```

`--force-with-lease` is the correct mechanism here: it will refuse the push if
someone else has committed to `origin/main` in the meantime, which a blind
`--force` would silently discard.

---

## 6. GitHub status (AS WRITTEN AT THE TIME — SUPERSEDED BY SECTION 7)

> The table below was accurate when this report was written and is **no longer
> accurate**. The rewrite was subsequently pushed, the local backup branch was
> deleted, and GitHub's contributor API was observed directly. Read
> [section 7](#7-current-verified-state) for the current facts.

| Question | Answer |
| --- | --- |
| Local `main` history clean? | **YES** |
| Local `backup-before-claude-removal` clean? | **YES** |
| Remote `origin/main` clean? | **NO —" not yet.** The push has not been performed and requires explicit authorization. |
| GitHub contributor cache refreshed? | **UNKNOWN.** Cannot be observed from this environment. |

Two states must not be conflated:

* **GIT HISTORY STATE —** the rewritten local branches are clean. This is
  verified by the evidence above.
* **GITHUB CONTRIBUTOR UI STATE —** unknown, and out of reach until the push
  happens. GitHub documents that contributor statistics can stay stale for up
  to roughly 24 hours after a history rewrite.

The Claude contributor entry **could not** disappear from GitHub until
`origin/main` was force-updated, and would not necessarily disappear
immediately afterwards.

---

## 7. Current verified state

Verified directly against the live repository and the GitHub API after the
cleanup was pushed. This section supersedes section 6.

### Git history

| Check | Command | Result |
| --- | --- | --- |
| Claude in commit messages | `git log --all -i --grep=claude` | **no matches** |
| Anthropic in commit messages | `git log --all -i --grep=anthropic` | **no matches** |
| Any co-author trailer | `git log --all -i --grep=co-authored-by` | **no matches** |
| AI-generated phrasing | `--grep='generated with\|AI-assisted\|claude code'` | **no matches** |
| Author identities | `git log --all --format='%an <%ae>' \| sort -u` | only `Karkala Shiva Reddy` and `karkalashivareddy`, both `<karkalashivareddy@gmail.com>` |
| Committer identities | `git log --all --format='%cn <%ce>' \| sort -u` | same two forms, same single address |
| Commit objects examined | reachable + `git fsck --unreachable` | **53** |
| Objects with an AI vendor identity | raw `git cat-file commit` scan | **0** |
| Objects with a co-author or generated-by trailer | raw scan | **0** |

Two commit messages contain the substring `cursor` ("execution-time cursor",
"replay cursor sync"). These are the flight recorder's playback cursor and are
unrelated to the AI editor named Cursor.

### Local object database

The original rewrite left 56 unreachable commit objects in this clone,
including the two pre-rewrite commits that carried the AI trailers
(`Co-Authored-By: Claude Opus 4.8 …` and `Co-authored-by: opencode …`). They were
unreachable, so they could never have been pushed and never contributed to
GitHub, but they remained recoverable from this clone.

They have been removed:

```
git reflog expire --expire=now --expire-unreachable=now --all
git gc --prune=now
```

Before pruning, a full bundle was written outside the repository and verified
with `git bundle verify`, so the pre-prune state remains recoverable locally.
Reachable history was unaffected: the same 53 commits and the same `main` tip
before and after.

### Refs

```
refs/heads/main            8ae265c
refs/remotes/origin/main   8ae265c
refs/remotes/origin/HEAD   8ae265c
```

`main` is the only branch, locally and on the remote. `backup-before-claude-removal`
was deleted after confirming `git diff backup-before-claude-removal main` showed
`main` to be a strict content superset. A Dependabot branch
(`dependabot/github_actions/actions-0e3d324e1b`) and its pull request #15 were
also removed. There are no tags, and no open pull requests.

### GitHub, observed directly

The GitHub contributors API returns exactly one entry:

```
karkalashivareddy   53 contributions   type=User
```

53 is the full commit count of `main`, so the published history is entirely
attributed to the repository owner. There is no Claude, Anthropic, or other AI
entry in GitHub's contributor data — this is an observation, not an inference
from a cache.

No history rewrite was required for this second pass, and none was performed:
the reachable history was already free of AI attribution, so rewriting 53
commits would have changed every SHA, invalidated the passing CI run, and
broken the SHA citations in the audit documents, all to remove nothing.
