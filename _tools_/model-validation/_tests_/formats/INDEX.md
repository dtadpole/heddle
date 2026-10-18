---
title: Model Validation Wire Format Tests
version: 1.0.0
description: Local HTTP doubles verify text, reasoning, tool-call assembly and completion across all three adapters.
grounded_in:
  - source: unit.test.mjs and the three model adapters
---

# `formats`

[`unit.test.mjs`](unit.test.mjs) exercises Chat Completions, Responses and Anthropic Vertex adapters
against local HTTP doubles. It judges separate text and reasoning deltas, assembled tool calls and
completion. It needs **no browser**, credentials or remote provider, and is not live validation.

```bash
node --test _tools_/model-validation/_tests_/formats/unit.test.mjs
```

Read [`../INDEX.md`](../INDEX.md) for the validation-rule suite and the tool's live contract.
