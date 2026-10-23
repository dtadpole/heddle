---
title: Load check
version: 1.1.0
description: One plain report of what this Mac is doing during a team review — free disk, the team's load told apart from the desktop's, swap, the build slots' owners and the processes in the ~/heddle--* worktrees — with an exit code that says ok, warn or stop.
grounded_in:
  - source: _projects_/heddle/_context_/team-operations/decision-log.yaml D-020 and D-021, the resumed local setup and its three build slots
  - source: _projects_/heddle/_context_/team-operations/working-model.md, the stop conditions on disk and the single-Mac bounds
---

# `load-check`

The [hd] team shares one 10-core, 16 GB Mac. The coordinator runs this at the start of every 15-minute
review to see whether the machine is carrying the team, and whether a seat has left a slot or a build behind.

```bash
node _tools_/load-check/load-check.mjs            # from any worktree
node _tools_/load-check/load-check.mjs --slots DIR --home DIR
```

It reads the machine through `df`, `sysctl`, `lsof` and `ps`; it needs no build slot and starts no cargo.

```text
load-check 2026-10-22T20:20:04-0700 (10 cores)
disk     59.9 GB free of 228 GB on /System/Volumes/Data [ok] (warn < 26 GB, stop < 20 GB)
load     14.31 14.06 11.24 = 1.43/core [context] (system warn >= 1.5/core, stop >= 2/core; verdict follows team)
team     2.7 core(s) = 0.27/core [ok] (warn >= 1/core, stop >= 1.3/core; 46 process(es))
other    Google Chrome Helper (Renderer) 51%, WindowServer 48%, Google Chrome Helper 39%, node 37%, Muse 14%
swap     5133M used of 6144M = 84% [warn] (warn >= 75%, stop >= 95%)
slots    3 of 3: 1 busy, 1 stale, 1 free
         slot 0 busy pid=3521 cargo=3499 age=260s cwd=~/heddle--developer-six/rust
         slot 2 stale pid=14877 cargo=0 age=4s cwd=~/heddle--developer-ten
worktrees 1 with a process
         ~/heddle--developer-six 3 proc 210% cpu: cargo, rustc
builds   1 cargo, 2 rustc, 0 other [ok] (cap 9 rustc = 3 slots x 3 jobs)
verdict  warn: swap: 80% used, slots: 1 stale
```

## What each line means

- **disk** — free space on the volume holding `$HOME`. The working model removes release artifacts below
  26 GB and stops below 20 GB, so those are the warn and stop lines.
- **load** — the three load averages and the one-minute average per core, as **context**: this is the whole
  Mac, desktop included.
- **team** — the cpu share of the processes whose working directory is a `~/heddle--*` worktree, plus any
  cargo/rustc process, in cores and per core. **The verdict follows this figure**, so Spotlight or Chrome
  cannot make the coordinator throttle the team: over 1.0/core is a warn and 1.3 a stop.
- **other** — the five busiest processes that are not team work, named with their share, so a warn on the
  system line can be explained in one glance.
- **swap** — used of total. A Mac that swaps on a build is out of memory, so 75% is a warn and 95% a stop.
- **slots** — each build slot's owner file, read directly: `busy` when the owner shell or its cargo is alive,
  `stale` when neither is, `unclaimed` when the directory has no owner file yet. A stale slot is a warning
  even though the next command will reclaim it: something died.
- **worktrees** — the processes whose working directory is under `~/heddle--<seat>`, grouped by seat and
  sorted by cpu share, with their command names. These are the builds and sessions actually using the Mac.
- **builds** — `cargo`, `rustc` and linker processes. More rustc processes than `slots x jobs` means a
  build outside the runner (the cap is 9 by default).

## Exit codes

| Code | Meaning | What the coordinator does |
|---|---|---|
| `0` | ok | nothing |
| `1` | warn | one review of patience: no new heavy work, look at the stale slot or the swap line |
| `2` | stop | report to the owner; the working model's stop conditions are met |
| `3` | the check itself failed | fix the check; its message says which command it could not read |

Thresholds are the constants at the top of the script and can be overridden for a single run with
`LOAD_CHECK_DISK_WARN_GB`, `LOAD_CHECK_DISK_STOP_GB`, `LOAD_CHECK_LOAD_WARN_PER_CORE`,
`LOAD_CHECK_LOAD_STOP_PER_CORE` (the system line), `LOAD_CHECK_TEAM_WARN_PER_CORE`,
`LOAD_CHECK_TEAM_STOP_PER_CORE` (the verdict), `LOAD_CHECK_SWAP_WARN_PCT`, `LOAD_CHECK_SWAP_STOP_PCT` and
`LOAD_CHECK_SLOTS`.

## Tests

```bash
node --test _tools_/load-check/_tests_/report/unit.test.mjs
```

They judge the parsers against real macOS command output, the slot states in both owner-file formats, the
worktree grouping, the deterministic team/desktop split (a fixed process list, not the machine), every
threshold boundary, and the command's own exit codes.

## Read next

[`../local-build/INDEX.md`](../local-build/INDEX.md) for the slots this report reads, and
[`../../rust/INDEX.md`](../../rust/INDEX.md) for the port's state.
