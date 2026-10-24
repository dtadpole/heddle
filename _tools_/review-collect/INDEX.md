---
title: Review collect
version: 1.1.0
description: One read-only command that prints the raw evidence for a member review — the seat's tip against origin/main, its commits and files judged against its write scope, its uncommitted paths, its last report, its recorded test and verifier runs, and its action-log lines since the last review.
grounded_in:
  - source: _projects_/heddle/TEAM.yaml, coordination.member_review — one member per 15-minute review pass, verdicts appended to execution-review-log.jsonl
  - source: the coordinator's request 2026-10-22, a member review from raw evidence took ten minutes of git and log reading
created: 2026-10-23T04:01:55Z
modified: 2026-10-24T05:06:33Z
---

# `review-collect`

The coordinator reviews one member every pass, from raw evidence. This tool gathers that evidence into one page in
about two seconds, so the review time goes to judging rather than to `git log` and log reading.

The folder holds the tool, `review-collect.mjs`, its component tests in [`_tests_/`](_tests_/INDEX.md), and the
articles below.

```bash
node _tools_/review-collect/review-collect.mjs --team <TEAM.yaml> --seat developer-ten
HEDDLE_TEAM_FILE=<TEAM.yaml> node _tools_/review-collect/review-collect.mjs --seat developer-ten
```

## Tests

```bash
node --test _tools_/review-collect/_tests_/page/unit.test.mjs
```

Last run 2026-10-23 22:05 PDT, on hd/tool-developer with main 445ea43 merged: `node --test _tools_/review-collect/_tests_/page/unit.test.mjs`, 22 passed, 0 failed.

## Read next

- [usage.md](usage.md) for the team record, the reviewer's clone, the options, the exit codes and what the tool
  never writes.
- [page.md](page.md) for an example page, and [evidence-sources.md](evidence-sources.md) for where each section
  comes from, recorded runs included.
- [scope-rules.md](scope-rules.md) for how a path is judged against a seat's write scope.
- [test-coverage.md](test-coverage.md) for what the page suite checks.
- [`../load-check/INDEX.md`](../load-check/INDEX.md) for the machine half of a review pass, and
  [`../public-hygiene/INDEX.md`](../public-hygiene/INDEX.md) for the gate a merge passes.
