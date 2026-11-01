---
title: What the record-commit tests cover
created: 2026-10-24T05:00:49Z
modified: 2026-11-01T23:50:00Z
level: L2
version: 1.2.0
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
a staging tree with `--base`, nothing-to-commit, a dry run that commits nothing, a simulated push race replayed with both commits landing (and four in a row against a busy remote), a race
on a given file rebuilt from a fresh origin and refused, a commit that cannot sync exiting 3, argument and path checks,
the read-back verifier's failure modes, and the validator python (the repository's `.venv` first, else a
`python3` with PyYAML, named in the report).

## A protected main

Eleven more tests use a fake origin whose update hook refuses main with GH006. They cover telling that refusal from a
race, and finding the seat in a roster. A first park creates `records/<seat>` on main and exits 0 with the line. A
second park appends and carries only its own log lines. A rerun pushes nothing new, and a branch main already contains
is fast-forwarded. They also cover the seat taken from `$DSH_SESSION_ID`, no seat refused with nothing pushed, a
rejection that is not protection never parked, and a branch moved mid-park rebuilt on. Eight mutants of the new
code were each caught. One more test checks that a refusal shows the remote's reasons and the porcelain `!` line,
not only git's last line.

## Parking by default

Five tests use an origin that accepts main and logs every pushed ref. By default the only ref pushed is
`records/<seat>`: main is never attempted. The seat comes from the roster and a second record appends; no seat, or a
bad one, refuses before the commit. A dry run names the branch, and `--main` pushes main. The earlier tests pass
`--main`, so they still judge the direct push and its fallback.

Four tests judge the validator against a main that already fails it, as reflection main did after the GHE
convergence (35 errors). Such an error is counted, not blocking, even in the file the record edits. An error the
record adds still refuses it, named apart from main's. A validator that fails without an error line still refuses.

## A dry run against the real record

A dry run against a scratch clone of the real record on 2026-10-23 ran the validator over **1839 files: 0
errors, 44 warnings** and would have committed one unioned log — the live tree and origin were untouched.
