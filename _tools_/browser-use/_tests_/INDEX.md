---
title: Browser Use Tests
version: 1.0.0
description: The browser tool's own _tests_ type folder, holding its component suites beside the code they judge.
grounded_in:
  - source: owner statement in the dsh session, 2026-10-17, keeping the browser tool's tests under the tool rather than in a global tree
---

# `_tests_`

Instance-level `_tests_` type folder: the browser tool's component suites, kept **inside the tool it
judges** rather than in a repository-global tests tree. A type may repeat at any depth in a branch, and
this is the depth that keeps a suite next to its subject: a test's imports are two levels up, and a
change to the tool and its tests is one folder's worth of diff.

## What belongs in it

One instance folder per suite, kebab-case and named for what it judges:

| Instance | The suite |
|---|---|
| [`component-rules/`](component-rules/INDEX.md) | the rules the helpers implement — frame codec, keys, viewport syntax, snapshot text, pagination, the tool table |

## Running them

```bash
node --test _tools_/browser-use/_tests_/component-rules/unit.test.mjs
```

No browser, no server and no build. The repository keeps three kinds of check apart: `test/` for the
framework's shipped source, `_tests_/` inside a tool for that tool's components, and `_verifiers_/` for
delivered capabilities.
