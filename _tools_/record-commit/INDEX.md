---
title: Record commit
version: 1.0.0
description: Commits edits to the shared reflection record from a temporary worktree at a fresh origin/main, refusing a stale base and unioning append-only logs, so a record edit cannot silently drop another writer's entries.
grounded_in:
  - source: _projects_/heddle/_context_/team-operations/working-model.md, commit from a temporary worktree at a fresh origin/main and count a landing only after reading it back
  - source: _projects_/heddle/_context_/team-operations/decision-log.yaml D-012, never stash or override another session's work in the shared tree
---

# `record-commit`

The reflection tree is written by several sessions at once. Three decision entries and one seat log line were
lost under this tree's nose because an edit made on a lagging checkout replaced content that had landed
meanwhile. This tool makes that mistake impossible for the files it is given: it never commits in the live
checkout.

```bash
# a live-checkout edit, the common case
node _tools_/record-commit/record-commit.mjs --repo ~/reflection \
  --message "docs(<team>): record the decision" --file _projects_/<team>/_context_/<record>.yaml

# a commit that only appends to logs is log(<scope>)
node _tools_/record-commit/record-commit.mjs --repo ~/reflection \
  --message "log(<team>): two step lines" --file _logs_/repo-actions/action-log.jsonl

# an edit kept in a staging tree, with the pre-edit original beside it
node _tools_/record-commit/record-commit.mjs --repo ~/reflection \
  --message "docs(<team>): ..." --staged /tmp/record-edits --base /tmp/record-base
```

## What it does, in order

1. **Fetch**, then create a temporary worktree of the live checkout at the fetched `origin/main`.
2. **Copy only the given files** there; nothing else in the live tree is read or written.
3. **Check each file's base** against `origin/main`. A normal file whose base differs is refused — that edit
   was made on a version origin no longer has. `--file` uses the live checkout's `HEAD:path` as the base;
   `--staged DIR` uses `--base DIR/path` when given, else the live checkout's `HEAD:path`.
4. **Union append-only logs** (`_logs_/**.jsonl`, `execution-review-log.jsonl`, plus any `--append PATH`):
   origin's lines in their order, then the staged lines origin lacks. A log is never replaced, and the tool
   verifies every line of both sides is present.
5. **Run the frontmatter validator on the whole tree** in the temporary worktree. Errors refuse the commit;
   warnings are counted and only listed with `--verbose`.
6. **Commit with explicit paths** as `D.Tadpole <gsk390@gmail.com>` (D-018), **push `main`**, then **read back**
   that `origin/main` is that commit and that it carries every staged byte (and, for a log, every line).
7. **Fast-forward the live tree** with [`reflection-sync`](../reflection-sync/INDEX.md), so the next edit starts
   from the new origin.

A push rejected because another session landed first is **rebuilt from a fresh origin** — fetch, new worktree,
re-union, re-check — up to `--retries` times (default 2). It never rebases and never force-pushes. If the record
commits but the live tree cannot be fast-forwarded, that is exit 3: the record is safe and the live tree is
retried next pass.

## Every file or none

A record commit carries every file it is given, or none. A given file that would not change `origin/main` — its
content already equal, or every one of its log lines already there — refuses the whole run before anything is
committed, naming the file (`UNCHANGED path: ... was the edit saved in <repo>, or did another writer land it?`).
Behind that, git's own staged list must name every given path, and the read-back checks that the pushed commit's
file list contains every given path, not only that each file's bytes match. A run that once committed one of
three files with exit 0 now stops at the first of those three checks, and each check alone is enough.

## The message

The subject should be `<type>(<scope>): <subject>` with a type from the shared convention (`feat`, `fix`, `docs`,
`test`, `refactor`, `perf`, `ci`, `chore`, `revert`, `log`). A record edit is `docs(<scope>)`; a commit that only
appends to `_logs_/` is `log(<scope>)`; `record:` is not a type. The tool warns on stderr and still commits, since no
gate reads messages.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | committed, read back, live tree synced (or `--no-sync`) |
| `1` | refused before the commit: stale base, validator error, bad arguments |
| `2` | the record would not carry every given file (refused, nothing committed), or the pushed commit does not carry it as expected |
| `3` | committed and read back, but the live tree was not fast-forwarded |

## Options that matter

- `--dry-run` — fetch, base-check, union and run the validator, then stop before the commit. It is the safe way
  to see whether a pass would land.
- `--no-sync` — leave the live tree alone. After it, the live checkout is behind `origin/main`; the next edit
  from it will fail the base check until it is synced.
- `--validator PATH` — a runnable frontmatter validator; the default is the tree's own
  `shared/_tools_/frontmatter-validator/validate-frontmatter.py`, run with a python that imports PyYAML
  (`--python` overrides; `/opt/homebrew/bin/python3` is found first on this Mac).
- `--message-file FILE`, `--author "Name <email>"`, `--repo DIR`, `--remote`, `--branch`.

## Tests

```bash
node --test _tools_/record-commit/_tests_/record/unit.test.mjs
```

Twenty-two tests against a scratch bare origin and clones: the happy path landing and syncing the live tree, three
given files with two unchanged refused together, a log whose lines another writer already landed, a staged file
another writer lands mid-run with the same bytes (exit 2) and with different bytes (exit 1), the read-back counting
given files, the message warnings, a
stale base refused with origin untouched, two writers' log lines both kept, a log edit that deletes an origin
line unable to delete it from the commit, the validator seeing the whole tree and a failing validator refusing,
a staging tree with `--base`, nothing-to-commit, a dry run that commits nothing, a simulated push race rebuilt
from a fresh origin with both commits landing, a commit that cannot sync exiting 3, argument and path checks,
and the read-back verifier's failure modes.

A dry run against a scratch clone of the real record on 2026-10-23 ran the validator over **1839 files: 0
errors, 44 warnings** and would have committed one unioned log — the live tree and origin were untouched.

## Read next

[`../reflection-sync/INDEX.md`](../reflection-sync/INDEX.md) for the fast-forward it ends with, and
[`../../rust/INDEX.md`](../../rust/INDEX.md) for the port's state.
