---
title: The lane gate
created: 2026-10-24T05:55:00Z
modified: 2026-10-24T05:55:00Z
level: L3
version: 1.0.0
description: How lane.mjs decides whether a merge candidate breaks anything, alone (D-042) or against main's per-check baseline (D-048).
status: unverified
grounded_in:
  - source: decisions D-042 and D-048 in the heddle team's decision log
  - source: lane gate runs in ~/heddle--int-backend, 2026-10-22 to 2026-10-23
---

# The lane gate, `lane.mjs`

An integrator asks a different question from "does every part hold": **does this merge candidate break anything?**
`lane.mjs` answers it over the parts a lane owns, with the binary under test named by `HEDDLE_BIN`:

```bash
HEDDLE_BIN="$PWD/rust/target/release/heddle" node _tools_/verify-runner/lane.mjs 05-config-system 10-llm-backends ...
node _tools_/verify-runner/lane.mjs --json --timeout 400 <part> ...
```

It is **green** when no check failed and every check file gave a verdict, however many checks were unjudged, and
**red** when a check fails, a file's verdict is `1`, or a file times out or crashes. A file with no verdict is never
read as unjudged: a half-wired binary that stalls every turn would otherwise pass the gate. `all.mjs` keeps the
stricter question — an unjudged part is a failure there — because that is what "the port is complete" means.

**Against a baseline (D-048).** Once `main` carries a known failure, "nothing fails" stops being the merge rule;
D-048's is "no check that passes on `main` stops passing". `--write-baseline <file>` records every check of a run by
part, file and name; `--baseline <file>` judges a candidate against it: **red** when a check that passed in the
baseline does not pass now (a check that disappeared counts — a rename must not hide a lost pass) or a file gives no
verdict, **green** otherwise, with the newly passing count and every failing check listed so the status table can name
each with its owner. A regression must reproduce: the gate re-runs each file that holds one, once, and a check that
passes on the re-run is reported as **flaky** — named, so its owner can fix it — instead of blocking. A deterministic
regression fails again.

```bash
HEDDLE_BIN=<main's binary>      node _tools_/verify-runner/lane.mjs --write-baseline base.json <part> ...
HEDDLE_BIN=<candidate's binary> node _tools_/verify-runner/lane.mjs --baseline base.json <part> ...
```

Its rules are component-tested in [`_tests_/lane-rules/`](_tests_/lane-rules/INDEX.md).
