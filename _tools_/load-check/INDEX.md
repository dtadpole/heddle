---
title: Load check
version: 1.2.0
description: One plain report of what this Mac is doing during a team review — free disk, the team's load told apart from the desktop's, swap, the build slots' owners and the processes in the ~/heddle--* worktrees — with an exit code that says ok, warn or stop.
grounded_in:
  - source: _projects_/heddle/_context_/team-operations/decision-log.yaml D-020 and D-021, the resumed local setup and its three build slots
  - source: _projects_/heddle/_context_/team-operations/working-model.md, the stop conditions on disk and the single-Mac bounds
created: 2026-10-23T03:21:31Z
modified: 2026-10-24T05:06:33Z
---

# `load-check`

The [hd] team shares one 10-core, 16 GB Mac. The coordinator runs this at the start of every 15-minute
review to see whether the machine is carrying the team, and whether a seat has left a slot or a build behind.
It reads the machine through `df`, `sysctl`, `lsof` and `ps`; it needs no build slot and starts no cargo.

This folder holds the script, its component tests in [`_tests_/`](_tests_/INDEX.md), and the articles below
that explain its report.

```bash
node _tools_/load-check/load-check.mjs            # from any worktree
node _tools_/load-check/load-check.mjs --slots DIR --home DIR
```

## Tests

```bash
node --test _tools_/load-check/_tests_/report/unit.test.mjs
```

Last run 2026-10-23 22:05 PDT, on hd/tool-developer with main 445ea43 merged: `node --test _tools_/load-check/_tests_/report/unit.test.mjs`, 11 passed, 0 failed.

They judge the parsers against real macOS command output, the slot states in both owner-file formats, the
worktree grouping, the deterministic team/desktop split (a fixed process list, not the machine), every
threshold boundary, and the command's own exit codes.

## Read next

- [report-lines.md](report-lines.md) — a sample report and what each line shows.
- [verdict.md](verdict.md) — which lines warn or stop and why, the threshold overrides, and the exit codes.
- [`../local-build/INDEX.md`](../local-build/INDEX.md) — the slots this report reads.
- [`../../rust/INDEX.md`](../../rust/INDEX.md) — the port's state.
