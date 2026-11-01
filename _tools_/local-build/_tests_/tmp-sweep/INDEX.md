---
title: TMPDIR sweep tests
version: 1.2.0
description: Unit tests for tmp-sweep. They cover the seven kinds it removes, the age with live children, live browser profiles, dry-run, the command, the line of what the folder still holds and the cache sizes.
grounded_in:
  - source: _tools_/local-build/tmp-sweep.mjs
created: 2026-10-29T14:25:54Z
modified: 2026-10-31T12:45:00Z
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

```bash
node --test _tools_/local-build/_tests_/tmp-sweep/unit.test.mjs
```

**Browser mode: none.**

## Read next

[`../../tmp-sweep.md`](../../tmp-sweep.md) for what it removes and keeps.
