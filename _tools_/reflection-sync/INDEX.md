---
title: Reflection sync
version: 1.0.0
description: Fast-forwards the team's shared checkout to origin and refuses rather than overwrite another session's work — the tested replacement for the coordinator's reflection_sync.py.
grounded_in:
  - source: _projects_/heddle/_context_/team-operations/decision-log.yaml D-012, the shared tree is fast-forwarded only when no other session has an in-progress edit that differs from upstream
  - source: _projects_/heddle/_context_/team-operations/working-model.md, commit from a temporary worktree at a fresh origin/main and never rebase over appended logs
---

# `reflection-sync`

Several sessions share one checkout of the team's reflection tree. Nobody commits on its branch: commits go
through a temporary worktree at a fresh `origin/main`. This tool does the other half — it moves the shared
checkout forward to `origin/main` and **refuses** when that would disturb another session.

```bash
node _tools_/reflection-sync/reflection-sync.mjs --repo ~/reflection --dry-run
node _tools_/reflection-sync/reflection-sync.mjs --repo ~/reflection
```

The default repo is `~/reflection` on branch `main`. `--branch`, `--remote`, `--backup DIR` and
`--no-union-logs` are the other flags.

## What it refuses

A fast-forward is refused, changing nothing, when:

- the checkout has a commit the remote lacks — commits belong in a temporary worktree, not here;
- the index has a staged change, or an unmerged path;
- a tracked file is modified locally **and** the remote also changes it, with content different from the
  remote's: another session is mid-edit on that file, so the coordinator retries next pass;
- an untracked file sits at a path the remote adds and differs from the remote's version.

What it does instead of refusing:

- a modified file the remote does not touch is **kept**; the fast-forward leaves it alone;
- a modified file whose local content already equals the remote's is **refreshed**;
- an untracked file byte-identical to the remote's addition is **moved aside** to the backup directory and the
  remote's copy is checked out — the content is the same, so nothing is lost;
- an append-only log (`_logs_/**.jsonl`, `execution-review-log.jsonl`) that both sides appended to is
  **unioned**: the remote's lines in their order, then the local lines the remote lacks. Every line is kept and
  the fast-forward is not blocked. `--no-union-logs` disables this and makes such a log a refusal.

It never stashes, never resets the working tree, and never uncommits anything. Backups of anything it moved
aside or unioned are under `$TMPDIR/reflection-sync-backup/<stamp>/`, or `--backup`.

## The read-back

After the merge it re-reads `HEAD` and `origin/main` and only reports success when both equal the tip it fetched;
a mismatch is an error. The report names the before and after commit, the files it touched, and the kept local
edits — never their content.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | fast-forwarded, or already up to date (with `--dry-run`: would fast-forward) |
| `1` | could not run: not a checkout, detached HEAD, fetch or merge failed |
| `2` | refused: local work differs; nothing was changed |

## Tests

```bash
node --test _tools_/reflection-sync/_tests_/fast-forward/unit.test.mjs
```

Seventeen tests against throwaway repositories: a clean fast-forward and its read-back, a local commit, a staged
change, a differing edit on a changed file, an unrelated edit kept, an edit equal to the remote's, an identical
untracked copy moved aside, a differing one refused, the log union and its off switch, a dry run, and the exit
codes.

## Read next

[`../../rust/INDEX.md`](../../rust/INDEX.md) for the port's state, and
[`../public-hygiene/INDEX.md`](../public-hygiene/INDEX.md) for the gate before main.
