---
title: Hook Process Rules
version: 1.0.0
description: The hook processes the hooks verifier writes under HEDDLE_BIN, judged directly over the part-4 protocol.
grounded_in:
  - source: _verifiers_/60-hooks/check.mjs, the HEDDLE_BIN branch
  - source: rust/crates/heddle-tools/PROTOCOL.md, the part-4 protocol the processes speak
---

# `process-hooks`

Instance of [`_tests_`](../INDEX.md). Holds [`unit.test.mjs`](unit.test.mjs) for
[`_verifiers_/60-hooks/`](../../INDEX.md): each process declares its listeners in `initialize`, answers every
`hooks/call` as its `.ts` plugin decides (replace, next, merge, refuse, or a JSON-RPC error), refuses an unknown
method with `-32601`, and ends on `shutdown` then `exit`. The generator and the hook table are read out of
`check.mjs`, so the suite tests what ships. It needs no browser and no binary.

## Run it

```bash
node --test _verifiers_/60-hooks/_tests_/process-hooks/unit.test.mjs
```
