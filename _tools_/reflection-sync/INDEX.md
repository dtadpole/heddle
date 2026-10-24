---
title: Reflection sync
version: 1.1.0
description: Fast-forwards the team's shared checkout to origin and refuses rather than overwrite another session's work — the tested replacement for the coordinator's reflection_sync.py.
grounded_in:
  - source: _projects_/heddle/_context_/team-operations/decision-log.yaml D-012, the shared tree is fast-forwarded only when no other session has an in-progress edit that differs from upstream
  - source: _projects_/heddle/_context_/team-operations/working-model.md, commit from a temporary worktree at a fresh origin/main and never rebase over appended logs
created: 2026-10-23T03:33:27Z
modified: 2026-10-24T05:06:33Z
---

# `reflection-sync`

Several sessions share one checkout of the team's reflection tree. Nobody commits on its branch: commits go
through a temporary worktree at a fresh `origin/main`. This tool does the other half — it moves the shared
checkout forward to `origin/main` and **refuses** when that would disturb another session.

This folder holds the tool (`reflection-sync.mjs`), the articles below, and its tests in
[`_tests_/`](_tests_/INDEX.md).

```bash
node _tools_/reflection-sync/reflection-sync.mjs --repo ~/reflection --dry-run
node _tools_/reflection-sync/reflection-sync.mjs --repo ~/reflection
```

The default repo is `~/reflection` on branch `main`. `--branch`, `--remote`, `--backup DIR` and
`--no-union-logs` are the other flags.

## Tests

```bash
node --test _tools_/reflection-sync/_tests_/fast-forward/unit.test.mjs
```

Last run 2026-10-23 22:05 PDT, on hd/tool-developer with main 445ea43 merged: `node --test _tools_/reflection-sync/_tests_/fast-forward/unit.test.mjs`, 19 passed, 0 failed.

Nineteen tests against throwaway repositories: a clean fast-forward and its read-back, a local commit, a staged
change, a differing edit on a changed file, an unrelated edit kept, an edit equal to the remote's, an identical
untracked copy moved aside, a differing one refused, the log union and its off switch, a dry run, and the exit
codes.

## Read next

- [rules.md](rules.md) — what it refuses, what it does instead, what it never does, and where backups go.
- [results.md](results.md) — the read-back, the report, and the exit codes.
- [`../../rust/INDEX.md`](../../rust/INDEX.md) for the port's state.
- [`../public-hygiene/INDEX.md`](../public-hygiene/INDEX.md) for the gate before main.
