---
title: Public hygiene usage
created: 2026-10-24T05:00:36Z
modified: 2026-10-24T05:00:36Z
level: L2
version: 1.0.0
description: What the public-hygiene gate judges in range and tree mode, how it reads a range, and what each exit code means.
status: unverified
grounded_in:
  - source: the public-hygiene INDEX.md this was split from
---

# Using the gate

## Range mode

`--range` (default `origin/main..HEAD`) judges, in one pass over the range:

- every **added line** of the diff, with the new file's line number;
- every new **path name** in the diff, because a file can be named after an internal thing;
- every **commit message** in the range;
- every **commit identity** — both author and committer must be `D.Tadpole <gsk390@gmail.com>` (D-018);
  `--author "Name <email>"` changes the expectation, `--no-identity` waives the check.

### What a range brings in

`--range A..B` judges the commits in `B` that `A` lacks, and the content change **since their merge base**
(`A...B`): what a merge would bring in. A tree diff would also show, reversed, everything `A` changed after `B`
forked, and read main's own fixes back as lines a behind branch adds.

## Tree mode

`--tree [REV]` judges every text file and every path at `REV` (default `HEAD`), for a sweep of what is already
published. Binary files are judged by name only. A push is judged by `--range`; `--tree` is for finding what got
in before the gate existed.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | clean — main can take the range |
| `1` | findings — do not push; the lines above say what and where |
| `2` | the gate cannot run — no list, bad rule, not a repository, unknown revision |

## Read next

[identifier-list.md](identifier-list.md) for the list the gate matches against, and [INDEX.md](INDEX.md) for the
commands.
