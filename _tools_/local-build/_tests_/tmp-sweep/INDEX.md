---
title: TMPDIR sweep tests
version: 1.3.0
description: Unit tests for tmp-sweep. They cover the seven kinds it removes, the age with live children, live browser profiles, dry-run, the command, the line of what the folder still holds, the cache sizes, and the scratch worktree sweep.
grounded_in:
  - source: _tools_/local-build/tmp-sweep.mjs
created: 2026-10-29T14:25:54Z
modified: 2026-11-01T17:20:00Z
---

# `tmp-sweep`

Each test sweeps a folder of its own, with a fixed clock and a given process list, never the real TMPDIR.
The tests check:
- stale entries of the seven kinds go, testers' Chrome profiles and hidden `.com.google.Chrome*` files
  included, and near-miss names stay (`hd5-live-notes`, a bare `chrome-profile`, `.com.apple.x`);
- a young entry stays, as does an old folder with a fresh file inside;
- an entry a running process names stays, and a young or live tester profile stays too;
- `--dry-run` removes nothing, the command reports by kind, and a bad age is a usage error;
- the line after the sweep gives the folder's total, its entry count and its five largest entries, largest first,
  a top-level file and a hidden file among them; a missing folder says `sizes unknown (du failed)`;
- the npm and uv cache sizes come from `npm_config_cache`, `UV_CACHE_DIR` and `XDG_CACHE_HOME` (else `HOME`), an
  absent cache says so, a month-old cache file stays, and `--no-caches` drops the line. These tests point every
  cache setting at a folder of their own.
- `--worktrees`, on a scratch repository with a fake `origin` ref and a scratch folder for `/private/tmp`: an
  old, clean, unused, pushed worktree goes, under the tmp root or as a `heddle--developer-*-*` sibling, ignored
  build output and all, and its branch stays. Kept, each with its reason: a young one, a changed file, an
  untracked file, an unpushed HEAD, an open file inside, a command line naming it, a locked one, and one holding
  a nested worktree. A seat's own worktree and one elsewhere are never touched. A folder removed by hand is
  pruned;
- a dry run removes and prunes nothing, a missing process list removes nothing, and a longer age keeps it;
- the candidates rule, and that a holder must name the whole path (`d1-80s16` does not hold `d1-80s1`);
- the command with the real process list, its summary and per-worktree lines, `--worktrees` alone turning it on,
  and a usage error.

```bash
node --test _tools_/local-build/_tests_/tmp-sweep/unit.test.mjs
```

**Browser mode: none.**

## Read next

[`../../tmp-sweep.md`](../../tmp-sweep.md) for what it removes and keeps.
