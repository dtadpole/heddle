---
title: Public hygiene
version: 1.0.0
description: The gate an integrator runs before pushing main — it reads a private list of identifiers and refuses a push that would publish one, in a file, a path, a commit message or a commit identity.
grounded_in:
  - source: _projects_/heddle/_team_members_/tool-developer/responsibilities.md, the public-hygiene gate before main
  - source: _projects_/heddle/_context_/team-operations/working-model.md, no internal names because the repository is public
  - source: _projects_/heddle/_context_/team-operations/decision-log.yaml D-018, every commit uses D.Tadpole <gsk390@gmail.com>
---

# `public-hygiene`

The heddle repository is public. The team's context is not: it carries host names, private paths, session ids
and addresses that must never reach `main`. This gate reads the private identifier list, judges exactly what a
push would add, and exits non-zero when it finds a term.

```bash
# in the lane worktree, after the merges, before git push origin HEAD:main
node _tools_/public-hygiene/gate.mjs

# judge a branch, an already-merged tree, or a single commit's range
node _tools_/public-hygiene/gate.mjs --range origin/main..hd/developer-one
node _tools_/public-hygiene/gate.mjs --tree HEAD
```

## What it judges

`--range` (default `origin/main..HEAD`), in one pass over the range:

- every **added line** of the diff, with the new file's line number;
- every new **path name** in the diff, because a file can be named after an internal thing;
- every **commit message** in the range;
- every **commit identity** — both author and committer must be `D.Tadpole <gsk390@gmail.com>` (D-018);
  `--author "Name <email>"` changes the expectation, `--no-identity` waives the check.

`--tree [REV]` judges every text file and every path at `REV` (default `HEAD`), for a sweep of what is already
published. Binary files are judged by name only. A push is judged by `--range`; `--tree` is for finding what
got in before the gate existed.

## The identifier list

The list is **private** and lives outside the repository. Its path is `--identifiers FILE`, else
`$HEDDLE_PUBLIC_HYGIENE_FILE`, else `~/.config/heddle/public-hygiene.txt`. The gate refuses to run when the
list is missing, empty, unreadable, entirely comments, or inside the repository — an empty gate is not a gate.

```
# one rule per line; a literal (matched case-insensitively) or re:<regex>
host-01
host-02
re:\bhost-[0-9]+\b
team-private/notes
re:token-[0-9a-f]{8}-
```

Those are placeholders, not the team's terms: the real list names the devservers, the owner's home directory,
the private tree paths, session ids and internal model aliases, and it is never committed. The owner or the
coordinator owns the file; the tool developer seeded it with the names already known to the team. The gate never prints the list and never echoes a term: a finding shows the file and line with the match
replaced by `[redacted]`, and names the rule by its number in the list (`private 12 literal`), so the reader can
find it without the terminal history carrying it.

Two built-in rules hold whatever the list says: a **private IPv4 address** (10/8, 172.16/12, 192.168/16). A
generic `/Users/<name>` rule is not built in, because a fixture or a placeholder legitimately carries one; the
name belongs in the private list. `--no-builtin` removes the built-in rule for a deliberate exception.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | clean — main can take the range |
| `1` | findings — do not push; the lines above say what and where |
| `2` | the gate cannot run — no list, bad rule, not a repository, unknown revision |

## Tests

```bash
node --test _tools_/public-hygiene/_tests_/gate/unit.test.mjs
```

They judge the list format, literal and regex matching, redaction, the diff and log parsers, the identity
check, the built-in rule, and the three exit codes against a throwaway git repository.

## Read next

[`../../rust/INDEX.md`](../../rust/INDEX.md) for the port's state and [`../../AGENTS.md`](../../AGENTS.md) for the
conventions the repository follows.
