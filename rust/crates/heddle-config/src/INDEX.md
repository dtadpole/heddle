---
title: The heddle-config sources
created: 2026-10-23T00:55:27Z
modified: 2026-10-23T05:03:00Z
version: 0.2.0
description: The sources of the heddle-config crate, one file per TypeScript concern, with unit tests beside the code.
grounded_in:
  - source: rust/ULTIMATE_GOAL.md
  - source: rust/crates/heddle-config/INDEX.md, the port plan
---

# `rust/crates/heddle-config/src`

The sources of the crate, with unit tests in `#[cfg(test)]` modules beside the code.

| File | What it is |
|---|---|
| [`lib.rs`](lib.rs) | the crate root, its documentation and its re-exports |
| [`env.rs`](env.rs) | `Env`, the environment passed explicitly |
| [`error.rs`](error.rs) | `ConfigError`, every problem found |
| [`home.rs`](home.rs) | `$HEDDLE_HOME`, the profiles directory, `~` expansion |
| [`paths.rs`](paths.rs) | lexical resolve, canonical paths, segment-wise containment, depth |
| [`value.rs`](value.rs) | `LayerValue`, a layer's values with the `!env` and `!include` markers |
| [`layer.rs`](layer.rs) | layers, reading a layer file with its includes |
| [`references.rs`](references.rs) | `!env NAME` and `${NAME}` resolution |
| [`compose.rs`](compose.rs) | rows, composition with the last write winning, provenance |
| [`profile.rs`](profile.rs) | profiles, and the layers a run or a configuration command uses |
| [`schema.rs`](schema.rs) | the JSON Schema subset a component's configuration is checked against |
| [`validate.rs`](validate.rs) | the component catalog seam, the validation pass, and the outside-component manifest catalog (`ManifestCatalog`, `read_component_manifest`) |
| [`local.rs`](local.rs) | the machine's `heddle.json` |
| [`endpoints.rs`](endpoints.rs) | endpoint configuration, its model catalogue and the resolution ladder |
| [`command.rs`](command.rs) | `heddle profiles` and `heddle config`, output and exit codes |

## Read next

[`../INDEX.md`](../INDEX.md) for what the crate ports, its public API and its port plan.
