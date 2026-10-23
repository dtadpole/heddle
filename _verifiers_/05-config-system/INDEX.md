---
title: Verifier 0 — Configuration System
version: 1.0.0
description: a run composes its tree from named profiles and patch layers, and fails loudly.
grounded_in:
  - source: owner statement in the dsh session, 2026-10-11, asking for a properly designed config system
---

# `05-config-system`

Instance of this project's `_verifiers_`. **The claim it decides:** a run composes its tree from
named profiles and patch layers, a layer may include another, a value may come from the environment
without being written into the tree, a bad row fails where it is written, and the composition can say
which layer supplied every value.

The whole harness sits on this. It is numbered `05` because it is checked before the ten capabilities
rather than beside them: every one of them is configured through it, and a configuration system that
silently ignores a layer would make the other ten report on a tree nobody asked for.

## Where it runs

**No browser.** The checks drive the CLI, a scripted endpoint or a local HTTP double; nothing here needs
a display or a window.

## What decides it

`check.mjs` drives the CLI against fixture profiles under `.heddle-tmp/`, each carrying its own plugin
files so the check states exactly what a tree is. It covers composition and order, the last write
winning, includes, include cycles, both environment reference shapes, a missing reference, a bad value,
a patch against a missing row, provenance, and an unknown profile.

## Running it

```bash
sh verify.sh            # every check, with the verdict
sh verify.sh --list     # the check names, and why any was unjudged
sh verify.sh --json     # one parseable object
```

Exit `0` when the claim holds, `1` when it fails, `3` when it could not be judged.

## The fixture under `HEDDLE_BIN`

The TypeScript build's rows name a `.ts` plugin. The Rust binary cannot load one, so when `HEDDLE_BIN` names the
harness under test this check writes a **component manifest** beside the profile instead and the row names that
manifest — the port's part-0 shape, where a row names a built-in or an outside component rather than a module path:

```yaml
# alpha.component.yml, beside the profile; the row is `name: ./alpha.component.yml`
command: ./alpha.ts          # what would start it; --validate never starts or connects to it
config:                      # the same schema the .ts plugin declares, as JSON Schema
  type: object
  properties:
    label: { type: string }
    count: { type: number }
```

The manifest's `config` is the schema validation reads, so the bad-value check still asks the same question — the
failure names the row and the field — and the `.ts` fixtures and their verdicts on the TypeScript build are
unchanged. A manifest is read, never started, which is what makes `--validate` judgeable through the seam.

## What it deliberately does not judge

- **Whether a plugin's own defaults are sensible.** Validation checks what a layer wrote against the
  plugin's schema; it does not have an opinion about the schema.
- **Secrets.** A check asserts that a value can come from the environment and never that a value is
  written into a tree, because the repository rule is that none is.

## Read next

[`../INDEX.md`](../INDEX.md) for the verifications, and
[`../../src/config/INDEX.md`](../../src/config/INDEX.md) for the mechanism.
