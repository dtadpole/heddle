---
title: Web daemon redeploy rules
version: 1.1.0
description: Component tests for redeploy.sh — the one order of a redeploy (fetch, move, build, install with the new checkout's installer, probe, judge), and what it refuses.
grounded_in:
  - source: _tools_/web-daemon/redeploy.sh
  - source: the two outages of 2026-10-23, both from running the redeploy steps in a different order
---

# `redeploy-rules`

[`redeploy.sh`](../../redeploy.sh) is the deployment's redeploy, written once. The tests run it for real against
throwaway git repositories — a bare origin and a deployment clone one commit behind — with the deployment's own
`install.sh` and `96-deployment`, `npm` and `curl` replaced by stand-ins that record their calls, so the order of the
steps is read from the calls. The second commit also changes `redeploy.sh` itself, which is what a `git checkout` does
to a script the shell is still reading; the script runs from a private copy and removes it.

| Case | Expected |
|---|---|
| behind origin/main | `npm ci`, `npm run build`, `install.sh --restart` from the **new** checkout, a port probe, `96-deployment`; exit 0; clean at the tip |
| `--check` while behind | exit 10, nothing changed, nothing called |
| already current | only the probe and `96-deployment`: no build, no restart |
| a move of only inert paths (`rust/`, `_verifiers_/`, records, other tools, docs) with a build present | the checkout moves, then the probe and 96: no build, no restart |
| the same with no build, `--force`, or `HEDDLE_BIN`; or any change under `src/` | the full path |
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
