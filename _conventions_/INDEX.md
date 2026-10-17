---
title: Conventions
version: 1.1.0
description: Heddle's own conventions — one instance per convention, each naming the rule, the instance that made it necessary, and the test that judges it.
grounded_in:
  - source: human-authored
---

# `_conventions_`

Instance of this project's `_conventions_` type: **convention articles — agent-maintainable**. The rules are
kept here so they can be cited, diffed and judged; a rule that lives only in one session's memory is a rule
that gets forgotten.

The conventions borrowed from the wider `reflection` repository — entry points, frontmatter, commit messages,
change tracking, DSH-and-DRY, durable work, browser modes — are stated there and linked from
[`../AGENTS.md`](../AGENTS.md); they are not copied here, because one fact in one place is itself one of them.

## Shape: one instance per convention

Each child folder is **one convention**, named for the pattern it establishes, and its `INDEX.md` *is* the
article. A convention that needs several articles gets them beside its `INDEX.md`; one that needs a test
harness, a script, or evidence gets those beside it too. A new convention is a new folder and a new row here —
not a new file in someone else's folder.

| Instance | The rule |
|---|---|
| [`reentrant-components/`](reentrant-components/INDEX.md) | every major component is reentrant — re-evaluable, restartable, replaceable and fault-tolerant — deriving state and progress from durable records, never from event delivery or one process lifetime |

## What a convention must carry

1. **The rule**, stated so that a violation is recognisable.
2. **The instance that made it necessary** — the defect or decision, named, so a reader sees the cost of not
   having had it.
3. **The inverse** — the anti-pattern it replaces, so it is not mistaken for a preference.
4. **A judge** — the unit test or verifier that would fail if the system regressed. A rule without one is a
   preference, not a convention.
5. **Where it applies** — including where it is only partial today, so the next instance has a starting point.

A convention here is **agent-maintainable**: an agent may propose and land one, with its reasoning and its
judge. (The mirror-image type, `_constitutions_`, is human-only to amend — nothing here carries that weight.)

## Read next

[`./reentrant-components/`](reentrant-components/INDEX.md) for the first convention, and
[`../AGENTS.md`](../AGENTS.md) for the repository's entry point.
