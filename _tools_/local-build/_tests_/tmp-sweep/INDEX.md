---
title: TMPDIR sweep tests
version: 1.1.0
description: Unit tests for tmp-sweep. They cover the four kinds it removes, the age with live children, live browser profiles, dry-run, the command and the cache sizes.
grounded_in:
  - source: _tools_/local-build/tmp-sweep.mjs
created: 2026-10-29T14:25:54Z
modified: 2026-10-31T04:20:00Z
---

# `tmp-sweep`

Each test sweeps a folder of its own, with a fixed clock and a given process list, never the real TMPDIR.
The tests check:
- stale entries of the four kinds go, and other names stay;
- a young entry stays, as does an old folder with a fresh file inside;
- an entry a running process names stays;
- `--dry-run` removes nothing, the command reports by kind, and a bad age is a usage error;
- the npm and uv cache sizes come from `npm_config_cache`, `UV_CACHE_DIR` and `XDG_CACHE_HOME` (else `HOME`), an
  absent cache says so, a month-old cache file stays, and `--no-caches` drops the line. These tests point every
  cache setting at a folder of their own.

```bash
node --test _tools_/local-build/_tests_/tmp-sweep/unit.test.mjs
```

**Browser mode: none.**

## Read next

[`../../tmp-sweep.md`](../../tmp-sweep.md) for what it removes and keeps.
