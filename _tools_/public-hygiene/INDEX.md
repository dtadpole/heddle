---
title: Public hygiene
version: 1.1.0
description: The gate an integrator runs before pushing main — it reads a private list of identifiers and refuses a push that would publish one, in a file, a path, a commit message or a commit identity.
grounded_in:
  - source: _projects_/heddle/_team_members_/tool-developer/responsibilities.md, the public-hygiene gate before main
  - source: _projects_/heddle/_context_/team-operations/working-model.md, no internal names because the repository is public
  - source: _projects_/heddle/_context_/team-operations/decision-log.yaml D-018, every commit uses D.Tadpole <gsk390@gmail.com>
created: 2026-10-23T03:25:25Z
modified: 2026-10-24T05:06:33Z
---

# `public-hygiene`

The heddle repository is public. The team's context is not: it carries host names, private paths, session ids
and addresses that must never reach `main`. This gate reads the private identifier list, judges exactly what a
push would add, and exits non-zero when it finds a term.

The folder holds the gate (`gate.mjs`), its component tests ([`_tests_/`](_tests_/INDEX.md)) and the articles
below.

```bash
# in the lane worktree, after the merges, before git push origin HEAD:main
node _tools_/public-hygiene/gate.mjs

# judge a branch, an already-merged tree, or a single commit's range
node _tools_/public-hygiene/gate.mjs --range origin/main..hd/developer-one
node _tools_/public-hygiene/gate.mjs --tree HEAD
```

## Tests

```bash
node --test _tools_/public-hygiene/_tests_/gate/unit.test.mjs
```

Last run 2026-10-23 22:05 PDT, on hd/tool-developer with main 445ea43 merged: `node --test _tools_/public-hygiene/_tests_/gate/unit.test.mjs`, 17 passed, 0 failed.

## Read next

- [usage.md](usage.md) — what range and tree mode judge, the identity check, and the exit codes.
- [identifier-list.md](identifier-list.md) — where the private list lives, its format, redaction, the built-in rule.
- [placeholder-uuids.md](placeholder-uuids.md) — which UUIDs and near-UUIDs count as placeholders.
- [verification.md](verification.md) — a pinned run, and what the unit tests judge.
- [`../../rust/INDEX.md`](../../rust/INDEX.md) for the port's state, and [`../../AGENTS.md`](../../AGENTS.md) for
  the conventions the repository follows.
