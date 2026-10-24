---
title: Using record-commit
created: 2026-10-24T05:00:49Z
modified: 2026-10-24T05:06:33Z
level: L2
version: 1.0.0
description: The commit message convention, the options that matter, and the exit codes of record-commit.
status: unverified
grounded_in:
  - source: the record-commit INDEX.md version 1.0.0 this was split from
---

# Using `record-commit`

## The message

The subject should be `<type>(<scope>): <subject>` with a type from the shared convention (`feat`, `fix`, `docs`,
`test`, `refactor`, `perf`, `ci`, `chore`, `revert`, `log`). For this team a record edit is `docs(hd)`, and a commit
that only appends to `_logs_/` is `log(hd)`; `record:` is not a type. The tool warns on stderr and still commits, since no
gate reads messages.

## Options that matter

- `--dry-run` — fetch, base-check, union and run the validator, then stop before the commit. It is the safe way
  to see whether a pass would land.
- `--no-sync` — leave the live tree alone. After it, the live checkout is behind `origin/main`; the next edit
  from it will fail the base check until it is synced.
- `--validator PATH` — a runnable frontmatter validator; the default is the tree's own
  `shared/_tools_/frontmatter-validator/validate-frontmatter.py`, run with a python that imports PyYAML
  (`--python` or `$PYTHON` overrides; otherwise the record repository's `.venv/bin/python`, then a `python3` with PyYAML, and the report names the one used and why, e.g. `python: /opt/homebrew/bin/python3 (no .venv; a python3 with PyYAML)`).
- `--message-file FILE`, `--author "Name <email>"`, `--repo DIR`, `--remote`, `--branch`.

`--file`, `--staged`, `--base`, `--append`, `--verbose` and `--retries` are explained with the steps in
[how-it-works.md](how-it-works.md).

## Exit codes

| Code | Meaning |
|---|---|
| `0` | committed, read back, live tree synced (or `--no-sync`) |
| `1` | refused before the commit: a stale base on the first attempt (the caller's own old edit), validator error, bad arguments |
| `2` | the record would not carry every given file — refused, nothing committed: a file unchanged, or a file another writer changed while this run was pushing — or the pushed commit does not carry it as expected |
| `3` | committed and read back, but the live tree was not fast-forwarded: the record is safe and the live tree is retried next pass |
