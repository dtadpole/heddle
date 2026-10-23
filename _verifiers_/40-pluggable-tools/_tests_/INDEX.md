---
title: Pluggable Tools Verifier Tests
version: 1.0.0
description: The component tests of the 40-pluggable-tools verifier's own fixtures, judged without a binary or a browser.
grounded_in:
  - source: rust/crates/heddle-tools/PROTOCOL.md, the part-4 protocol the fixture processes speak
---

# `_tests_`

Instance-level `_tests_` type folder for [`40-pluggable-tools`](../INDEX.md). `verify.sh` runs `check*.mjs` only, so
nothing here runs as part of the verifier.

| Instance | The suite |
|---|---|
| [`process-tools/`](process-tools/INDEX.md) | the tool processes the check writes under `HEDDLE_BIN`, driven over the part-4 protocol |
