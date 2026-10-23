---
title: Hooks Verifier Tests
version: 1.0.0
description: The hooks verifier's own _tests_ type folder, holding the suite for the hook processes it writes under HEDDLE_BIN.
grounded_in:
  - source: owner statement in the dsh session, 2026-10-17, keeping a tool's tests under the tool
---

# `_tests_`

Instance-level `_tests_` type folder for [`_verifiers_/60-hooks/`](../INDEX.md).

| Instance | The suite |
|---|---|
| [`process-hooks/`](process-hooks/INDEX.md) | the five hook processes `check.mjs` writes under `HEDDLE_BIN`, each driven over the part-4 protocol and compared with its plugin's decision |
