---
title: Build output sweep tests
version: 1.0.0
description: Unit tests for deps-sweep. They cover what is superseded, what is kept, the target lookup, and the slot runner's hook after a successful build.
grounded_in:
  - source: _tools_/local-build/deps-sweep.mjs
created: 2026-10-29T15:11:15Z
modified: 2026-10-29T15:11:15Z
---

# `deps-sweep`

Each test builds a fake target of its own. The tests check:
- the name grouping, and that third-party crates and unhashed files are not ours;
- an old superseded artifact goes, while the newest stays even when it is old, as do young ones and third-party
  crates;
- an in-use folder is skipped, and dry-run removes nothing;
- the target lookup: `CARGO_TARGET_DIR`, `--manifest-path` in both forms, `./Cargo.toml`, or nothing;
- the runner sweeps after cargo exits 0, not after it fails, and keeps cargo's status.

```bash
node --test _tools_/local-build/_tests_/deps-sweep/unit.test.mjs
```

**Browser mode: none.**
