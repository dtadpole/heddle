---
title: What the record-commit tests cover
created: 2026-10-24T05:00:49Z
modified: 2026-10-24T05:06:46Z
level: L2
version: 1.0.0
description: The cases the record-commit unit suite exercises, and one dry run against a scratch clone of the real record.
status: unverified
grounded_in:
  - source: the record-commit INDEX.md version 1.0.0 this was split from
---

# What the `record-commit` tests cover

Twenty-four tests against a scratch bare origin and clones: the happy path landing and syncing the live tree, three
given files with two unchanged refused together, a log whose lines another writer already landed, one of three
staged files added by another writer between fetch and push with the same bytes and with different bytes (exit 2
both, none committed), the read-back counting given files, the message warnings against the convention's types, a
stale base refused with origin untouched, two writers' log lines both kept, a log edit that deletes an origin
line unable to delete it from the commit, the validator seeing the whole tree and a failing validator refusing,
a staging tree with `--base`, nothing-to-commit, a dry run that commits nothing, a simulated push race rebuilt
from a fresh origin with both commits landing, a commit that cannot sync exiting 3, argument and path checks,
the read-back verifier's failure modes, and the validator python (the repository's `.venv` first, else a
`python3` with PyYAML, named in the report).

## A dry run against the real record

A dry run against a scratch clone of the real record on 2026-10-23 ran the validator over **1839 files: 0
errors, 44 warnings** and would have committed one unioned log — the live tree and origin were untouched.
