---
title: Context
version: 1.2.0
description: Gathered source material that grounds this project's design decisions.
grounded_in:
  - source: human-authored
---

# `_context_`

Type folder. Holds gathered source material that grounds this project — readings of the systems it
mirrors, and the measurements taken while reading them.

## What belongs in it

Instances of `_context_`, one per body of gathered material, named kebab-case:
`_context_/<instance>/`. Each carries its own `INDEX.md` entry point and the material itself.

A report here is **gathered rather than authored**: it says what another system does, with the paths
and names that make the claim checkable, and it does not state this project's conclusions. The
conclusions live in the code and in [`_verifiers_/`](../_verifiers_/INDEX.md); a reading that
disagrees with them is evidence that one of the two is wrong, which is the point of keeping it.

Two rules an instance follows:

- **Record the version it read.** A report about an installed dependency is only as good as the
  version it was taken from, so the source and the date are in its `grounded_in`.
- **Keep the material whole.** A summary of a reading is a second copy of it; the reading itself is
  what can be checked against the package.

## Contents

- [`dsh-mechanisms/`](dsh-mechanisms/INDEX.md) — how DeepSeek Harness implements streaming, context
  management, hooks, its Web UI and its token, and workspaces and sessions.
- [`streaming-delivery/`](streaming-delivery/INDEX.md) — screenshots taken at the owner's address while judging whether
  a DeepSeek answer reaches the Web UI as it is written, cited by `SESSION_STREAMING.md`.
- [`rust-port/`](rust-port/INDEX.md) — Rust port baselines.

Material that grounds the UI port but names internal systems is kept out of this public repository: it
lives in the reflection repository's `_context_`
([`../../reflection/_context_/INDEX.md`](../../reflection/_context_/INDEX.md)) instead.

## Read next

[`../AGENTS.md`](../AGENTS.md) names the conventions this repository follows and links to their
governing text, which lives in the `reflection` repository rather than here: *type and instance
trees* for the naming and nesting rules, and *durable work* for why material worth citing does not
stay in scratch space.
