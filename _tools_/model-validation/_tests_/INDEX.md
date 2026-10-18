---
title: Model Validation Tests
version: 1.0.0
description: Component suites for the model validation rules and the three local wire-format doubles.
grounded_in:
  - source: _tools_/model-validation/lib.mjs and its component suites
---

# `_tests_`

The model-validation tool's component test type folder. These checks need **no browser**.
They do not spend provider quota or replace the live endpoint validation matrix.

| Suite | Responsibility |
|---|---|
| [`validation-rules/`](validation-rules/INDEX.md) | target selection, configuration fingerprints, reasoning levels and result judgments |
| [`wire-formats/`](wire-formats/INDEX.md) | local HTTP doubles for Chat Completions, Responses and Anthropic Vertex streams |

Run both suites from the repository root:

```bash
node --test _tools_/model-validation/_tests_/*/unit.test.mjs
```

Read [`../INDEX.md`](../INDEX.md) for the tool and the separate real-provider contract.
