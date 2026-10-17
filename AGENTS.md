---
title: AGENTS.md
version: 1.0.0
description: The entry point for whoever works in this repository, and the conventions it borrows from reflection.
grounded_in:
  - source: human-authored
---

# AGENTS.md

This file exists because the harness loads it automatically when a session runs in this
directory. It says what this repository is, which conventions it follows, and how to
check that a change is finished.

## What this repository is

`heddle` is a harness and agent framework built on Cordis, in TypeScript. It connects to
backend model servers, runs an agent loop over them, records sessions as append-only
event logs, gates its tools behind a permission sandbox and an approval policy, and
serves a local Web UI.

What completes it is stated in [`ULTIMATE_GOAL.md`](ULTIMATE_GOAL.md) — twelve parts, each
with its own verifier under [`_verifiers_/`](_verifiers_/INDEX.md). That file and those
verifiers are the contract: read them before deciding what to work on next.

## Entry points

Every content folder carries an `INDEX.md` stating what it is, what belongs in it, and
what to read next. This file is the repository root's entry point, because the harness
loads `AGENTS.md` and nothing else.

| Where | What |
|---|---|
| [`ULTIMATE_GOAL.md`](ULTIMATE_GOAL.md) | what completes this project, part by part |
| [`_verifiers_/`](_verifiers_/INDEX.md) | the verifications that decide those parts, and the owner-requested views beside them |
| [`_tools_/`](_tools_/INDEX.md) | the runner, the shared check helpers, and the Web UI daemon |
| [`_skills_/`](_skills_/INDEX.md) | the procedures a repeated job follows, one per procedure |
| [`src/`](src/INDEX.md) | the harness itself |
| [`test/`](test/INDEX.md) | the framework's own unit suite |
| [`README.md`](README.md) | what the project is, for a reader arriving cold |

## The conventions this repository follows

`heddle` is not the `reflection` repository, but it follows the same conventions, because
one person works in both and a rule that applies in only one of them is a rule that gets
forgotten. The governing text lives in
[`reflection/shared/_conventions_/core-conventions/`](../reflection/shared/_conventions_/core-conventions/INDEX.md),
and these are the articles that bind here.

- **[Working agreements](../reflection/shared/_conventions_/core-conventions/working-agreements.md)**
  — replies to the owner are **Chinese**; the append-only logs are **English**.
- **[Entry points](../reflection/shared/_conventions_/core-conventions/entry-points.md)**
  — every content folder carries an `INDEX.md`, and a generated folder's entry point is
  the `INDEX.md` of the folder that owns its generator. `dist/` is that case here.
- **[Type and instance trees](../reflection/shared/_conventions_/core-conventions/type-instance-trees.md)**
  — `_tools_/`, `_tests_/` and `_verifiers_/` are registered type folders whose children are kebab-case
  instances; `src/` and `test/` are source folders and carry no instances.
- **[Frontmatter](../reflection/shared/_conventions_/core-conventions/frontmatter.md)**
  — every authored artifact carries YAML frontmatter, and a value never contains a colon.
- **[Commit messages](../reflection/shared/_conventions_/core-conventions/commit-messages.md)**
  — Conventional Commits, with the decision trailers when a change involved a real one.
- **[Change tracking](../reflection/shared/_conventions_/core-conventions/change-tracking.md)**
  — a change to tracked content lands as a commit **and is pushed**, with one entry in the
  reflection repository's action log, and every user input recorded in its input log.
- **[DRY and patching](../reflection/shared/_conventions_/core-conventions/dry-and-patching.md)**
  — one fact in one place, and a document found wrong is fixed on the spot.
- **[Durable work](../reflection/shared/_conventions_/core-conventions/durable-work.md)**
  — anything worth citing goes in the instance it belongs to, never in `/tmp`.
- **[Browser modes](../reflection/shared/_conventions_/core-conventions/browser-modes.md)**
  — headed is for exploration and human-assisted debugging, headless for automation, and every artifact
  that needs a browser states in its `INDEX.md` whether it runs headless, headed or needs none.

Heddle's **own** conventions live in [`_conventions_/`](_conventions_/INDEX.md) — rules that are specific to
this repository rather than borrowed from `reflection`, one folder per convention, each with the instance
that made it necessary and the test that judges it. The first is
[goal reentrancy](_conventions_/goal-reentrant/INDEX.md).

## The rules that are local to this repository

- **A renderer is a library, not a rewrite.** Markdown and code rendering use maintained, low-dependency
  packages: `marked` for markdown, with the output reduced by an allow-list in `src/server/sanitize.ts` because
  no markdown library sanitizes by default. A written renderer is a fallback, not a first choice.
- **Endpoint configuration is never committed.** A URL, a model name or a credential
  belongs to the machine, and it is read from `$HEDDLE_CONFIG`,
  `$HEDDLE_HOME/heddle.json` or `~/.heddle/heddle.json`, with `HEDDLE_<ENDPOINT>_*`
  environment overrides. The defaults committed here point at a scripted fixture and at
  loopback, so a fresh clone runs its checks with no setup and no key.
- **A verifier is the contract.** When a check fails, the first question is whether the
  code is wrong or the claim is. Fix whichever it is in the same pass; a check bent to
  pass is worse than no check.
- **Unjudged is not passing.** A part whose mechanism does not exist yet reports exit
  `3`, and that is the honest answer until it is built.
- **`npm test`, `npm run check` and the verifiers are separate duties.** The unit suite
  pins the framework's primitives; the verifiers judge the delivered harness; the type
  check has to pass for either to mean anything.

## How to check a change is finished

```bash
npm run check                      # types, source and tests
npm test                           # the framework's unit suite
npm run build                      # emit dist/, which the verifiers judge
node --test _tools_/*/_tests_/*/unit.test.mjs   # each tool's component suites, no browser and no build
for d in _verifiers_/*/; do sh "$d/verify.sh"; done
```

Then the repository's own shape, using the reflection linter rather than a copy of it:

```bash
python3 ~/reflection/shared/_tools_/convention-linter/lint-conventions.py \
  --root ~/heddle \
  --vocabulary ~/reflection/shared/_conventions_/core-conventions/type-vocabulary.md \
  --generated dist
```

`--generated dist` names the one folder here whose contents a tool writes, which is the
exception the entry-points article states. It has to be said out loud because generated
and authored folders look identical on disk.

## Read next

[`ULTIMATE_GOAL.md`](ULTIMATE_GOAL.md) for what is being built and how far it has got;
[`_verifiers_/INDEX.md`](_verifiers_/INDEX.md) for how that is decided;
[`README.md`](README.md) for the short version.
