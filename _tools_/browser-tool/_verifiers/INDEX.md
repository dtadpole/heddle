---
title: Browser Tool Verifiers
version: 1.0.0
description: The claims the browser tool must keep, one folder each, kept beside the tool they judge rather than in the repository's top-level verifiers.
grounded_in:
  - source: owner statement in the dsh session, 2026-10-17, asking for the browser tool's verifiers to live beside it
---

# `_verifiers_`

Instance-level type folder: the tool's own `_verifiers_`, holding one folder per claim. A **type may
repeat at any depth in a branch**, and these belong beside the tool they judge rather than in the
repository's top-level `_verifiers_` — that tree answers what completes *heddle*, and this one answers
whether the tool this repository runs actually works.

## What belongs in it

An instance folder per claim, kebab-case, each a thin `verify.sh` over one or more check files beside
it. It keeps the project's verdict contract — `0` holds, `1` fails, `3` could not be judged — by running
its checks through [`_tools_/verify-runner/`](../../../verify-runner/INDEX.md).

| # | Folder | The claim | Surface |
|---|---|---|---|
| 1 | [`browser-surface/`](browser-surface/INDEX.md) | every page tool acts on the element a snapshot named, and a dialog or a navigation does not silently change what that means | **headless by default**; `HEDDLE_BROWSER_HEADED=1` runs it headed and then also judges the window |
| 2 | [`browser-session/`](browser-session/INDEX.md) | one session survives between commands, and `status` and `stop` tell the truth about it | **headless** |

## Why the surface is stated

A verifier that needs a window cannot run unattended, and one that does not need it should not take the
machine's focus. That is a fact a reader needs *before* running a verifier, so each index states it and
the check's own header repeats it.

## Read next

[`browser-surface/INDEX.md`](browser-surface/INDEX.md) for the page-level claims,
[`browser-session/INDEX.md`](browser-session/INDEX.md) for the command-line ones, and
[`../../INDEX.md`](../../INDEX.md) for the tool they judge.
