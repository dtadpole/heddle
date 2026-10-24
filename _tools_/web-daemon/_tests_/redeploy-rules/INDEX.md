---
title: Web daemon redeploy rules
created: 2026-10-23T04:27:33Z
modified: 2026-10-24T05:55:00Z
version: 1.2.0
description: Component tests for redeploy.sh — the one order of a redeploy (fetch, move, build, install with the new checkout's installer, probe, judge), and what it refuses.
grounded_in:
  - source: _tools_/web-daemon/redeploy.sh
  - source: the two outages of 2026-10-23, both from running the redeploy steps in a different order
---

# `redeploy-rules`

The tests run [`redeploy.sh`](../../redeploy.sh) for real against a bare origin and a clone one commit behind;
`install.sh`, `96-deployment`, `npm` and `curl` are recording stand-ins, so the step order is read from their calls.
The second commit also edits `redeploy.sh`, so the script must run from a private copy.

| Case | Expected |
|---|---|
| behind origin/main | `npm ci`, `npm run build`, `install.sh --restart` from the **new** checkout, a port probe, `96-deployment`; exit 0; clean at the tip |
| `--check` while behind | exit 10, nothing changed, nothing called |
| already current | probe and 96 only |
| a move of only inert paths (`rust/`, `_verifiers_/`, records, other tools, docs), a build present | the checkout moves; probe and 96 only |
| the same with no build, `--force` or `HEDDLE_BIN`, or any change under `src/` | the full path |
| an edited deployment | exit 2 before anything runs, and the edit is kept |
| the build fails | exit 1 before the installer, so the service keeps its previous build |
| the installer refuses, or 96 fails | exit 1 |
| `HEDDLE_BIN`, `--repo DIR` | no npm build; the named checkout moves, with its own installer |

```bash
node --test _tools_/web-daemon/_tests_/redeploy-rules/unit.test.mjs
```

**Browser mode: none.**

## Read next

[`../../INDEX.md`](../../INDEX.md) for the tool these rules belong to.
