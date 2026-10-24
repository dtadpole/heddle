---
title: Record commit
version: 1.1.0
description: Commits edits to the shared reflection record from a temporary worktree at a fresh origin/main, refusing a stale base and unioning append-only logs, so a record edit cannot silently drop another writer's entries.
grounded_in:
  - source: _projects_/heddle/_context_/team-operations/working-model.md, commit from a temporary worktree at a fresh origin/main and count a landing only after reading it back
  - source: _projects_/heddle/_context_/team-operations/decision-log.yaml D-012, never stash or override another session's work in the shared tree
created: 2026-10-23T03:43:51Z
modified: 2026-10-24T05:06:33Z
---

# `record-commit`

## What this folder is

The tool that commits edits to the shared reflection record. It never commits in the live checkout, so an edit
made on a lagging checkout cannot silently drop another writer's entries.

## What belongs here

The tool `record-commit.mjs`, its suites under [`_tests_/`](_tests_/INDEX.md), and the articles listed under
Read next.

## Use

```bash
# a live-checkout edit, the common case
node _tools_/record-commit/record-commit.mjs --repo ~/reflection \
  --message "docs(hd): record the decision" --file _projects_/<team>/_context_/<record>.yaml

# a commit that only appends to logs is log(<scope>)
node _tools_/record-commit/record-commit.mjs --repo ~/reflection \
  --message "log(hd): two step lines" --file _logs_/repo-actions/action-log.jsonl

# an edit kept in a staging tree, with the pre-edit original beside it
node _tools_/record-commit/record-commit.mjs --repo ~/reflection \
  --message "docs(hd): ..." --staged /tmp/record-edits --base /tmp/record-base
```

## Tests

```bash
node --test _tools_/record-commit/_tests_/record/unit.test.mjs
```

Last run 2026-10-23 22:05 PDT, on hd/tool-developer with main 445ea43 merged: `node --test _tools_/record-commit/_tests_/record/unit.test.mjs`, 24 passed, 0 failed.

## Read next

- [how-it-works.md](how-it-works.md) — why the tool exists, the seven steps of a run, and the push-race rebuild.
- [every-file-or-none.md](every-file-or-none.md) — a run carries every given file or none.
- [usage.md](usage.md) — the commit message, the options and the exit codes.
- [test-coverage.md](test-coverage.md) — what the suite covers, and a dry run against the real record.
- [`../reflection-sync/INDEX.md`](../reflection-sync/INDEX.md) — the fast-forward a run ends with.
- [`../../rust/INDEX.md`](../../rust/INDEX.md) — the port's state.
