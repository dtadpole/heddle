---
title: Build output sweep tests
version: 1.1.0
description: Unit tests for deps-sweep. They cover what is superseded, what is kept, the target lookup, the slot runner's hook after a successful build, and --floor.
grounded_in:
  - source: _tools_/local-build/deps-sweep.mjs
created: 2026-10-29T15:11:15Z
modified: 2026-11-01T17:20:00Z
---

# `deps-sweep`

Each test builds a fake target of its own. The tests check:
- the name grouping, and that third-party crates and unhashed files are not ours;
- an old superseded artifact goes, while the newest stays even when it is old, as do young ones and third-party
  crates;
- an in-use folder is skipped, and dry-run removes nothing;
- the target lookup: `CARGO_TARGET_DIR`, `--manifest-path` in both forms, `./Cargo.toml`, or nothing;
- the runner sweeps after cargo exits 0, not after it fails, and keeps cargo's status.
- `--floor`, on fake worktrees with aged `rust/target/debug` folders: the two-level last write; the roster's
  owners for a seat's own, extra, nested and `/private/tmp` worktrees, and the folder name without one; under the
  floor the idle folders go oldest first with their sizes, only `debug`, while a young one, one with an open
  file, one a command line names, one a build took meanwhile (the second process list) and a link stay;
- at or above the floor, in a dry run, or without the free space or either process list, nothing goes, and a
  longer age keeps it;
- the command on a real repository and roster: nothing at a floor of 0, the owner and removal at a huge floor,
  and a usage error.

```bash
node --test _tools_/local-build/_tests_/deps-sweep/unit.test.mjs
```

**Browser mode: none.**
