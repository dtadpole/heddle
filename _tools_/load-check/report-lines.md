---
title: Load check report lines
created: 2026-10-24T05:01:48Z
modified: 2026-10-29T12:23:29Z
level: L2
version: 1.1.0
description: A sample load-check report and what each of its lines shows.
status: unverified
grounded_in:
  - source: _tools_/load-check/INDEX.md version 1.1.0, the entry point this was split from
---

# A sample report

```text
load-check 2026-10-22T20:20:04-0700 (10 cores)
disk     59.9 GB free of 228 GB on /System/Volumes/Data [ok] (warn < 26 GB, stop < 20 GB)
load     14.31 14.06 11.24 = 1.43/core [context] (system warn >= 1.5/core, stop >= 2/core; verdict follows team)
team     2.7 core(s) = 0.27/core [ok] (warn >= 1/core, stop >= 1.3/core; 46 process(es))
other    Google Chrome Helper (Renderer) 51%, WindowServer 48%, Google Chrome Helper 39%, node 37%, Muse 14%
swap     6900M used of 8192M = 84% [warn] (D-051: warn >= 6656M, stop >= 7168M)
slots    3 of 3: 1 busy, 1 stale, 1 free
         slot 0 busy pid=3521 cargo=3499 age=260s cwd=~/heddle--developer-six/rust
         slot 2 stale pid=14877 cargo=0 age=4s cwd=~/heddle--developer-ten
worktrees 1 with a process
         ~/heddle--developer-six 3 proc 210% cpu: cargo, rustc
builds   1 cargo, 2 rustc, 0 other [ok] (cap 9 rustc = 3 slots x 3 jobs)
verdict  warn: swap: 6900M used, under 7168M: one start at a time (D-051), slots: 1 stale
```

## What each line shows

- **disk** — free space on the volume holding `$HOME`.
- **load** — the three load averages and the one-minute average per core, as **context**: the whole Mac,
  desktop included.
- **team** — cpu share, in cores and per core, of processes whose working directory is a `~/heddle--*`
  worktree, plus any cargo/rustc process.
- **other** — the five busiest non-team processes with their share, so a warn on the system line is
  explained at a glance.
- **swap** — used of total; the verdict follows D-051's absolute line, the percent is detail.
- **slots** — each build slot's owner file, read directly: `busy` when the owner shell or its cargo is alive,
  `stale` when neither is, `unclaimed` when the directory has no owner file yet.
- **worktrees** — processes whose working directory is under `~/heddle--<seat>`, grouped by seat, sorted by
  cpu share, with command names: the builds and sessions actually using the Mac.
- **builds** — `cargo`, `rustc` and linker processes. More rustc processes than `slots x jobs` (the cap is
  9 by default) means a build outside the runner.

Thresholds and their reasons: [verdict.md](verdict.md).
