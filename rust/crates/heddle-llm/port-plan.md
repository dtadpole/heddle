---
title: The heddle-llm port plan
created: 2026-10-23T05:08:19Z
modified: 2026-10-23T05:21:53Z
level: L1
version: 1.1.0
description: The steps of the heddle-llm port, the TypeScript tests each one ported, what the verifiers measured through the binary, and what remains outside the crate.
status: unverified
grounded_in:
  - source: _verifiers_/10-llm-backends, _verifiers_/20-streaming, _verifiers_/98-model-endpoints and _tools_/model-validation, read 2026-10-22
  - source: the TypeScript unit tests under test/, read 2026-10-22
---

# The heddle-llm port plan

The TypeScript unit tests under `test/` are the oracle: each step ports the ones named, as Rust tests that can fail.

| Step | What | Oracle tests ported | State |
|---|---|---|---|
| 1 | The contract: types, traits, signatures; JSON shapes final and tested | — | done |
| 2 | Pure vocabulary: finish reasons, usage, request messages, the SSE parser, attachments, failure codes | `finish-reasons`, `usage`, `request-messages`, `attachments` | done |
| 3 | Request builders and folds for chat, Responses and Anthropic; `reasoning_value`; the scripted adapter | `anthropic-vertex`, `responses-input`, `responses-finish`, `tool-call-delta`, `scripted-purpose`, `model-effort`, `model-gateways` | done |
| 4 | Transport on reqwest: body sniffing, proxy form, failure codes, `fold_sse`, each adapter's stream against local doubles | `stream-arrival` | done |
| 5 | `ModelService`, `ModelListCache`, `StreamPrinter`, the `command` entry point | `model-info`, `model-info-per-model`, `model-discovery` | done |
| 6 | `10-llm-backends` and `20-streaming` through the binary | the verifiers | rehearsed, below |
| 7 | `98-model-endpoints` through the binary | the verifier | entry point done, below |

## Step 6, measured

Rehearsed 2026-10-22 through `HEDDLE_BIN` on a scratch build advertising `Models`, `Streaming` and `Turn`:

- `10-llm-backends` — 6 pass, 0 fail, 2 unjudged: those two need a real configured backend or gateway, and a file with
  a skipped check reports verdict `3`.
- `20-streaming` — 0 of 5 until the binary feeds the view: the session service's listener calls
  `StreamHub::observe(session, &event.to_value())` for each appended event, and the turn's starter calls
  `StreamHub::start`. Without it no delta is printed and `--json` has no `stream` key.

Both gate on `--help` advertising `--endpoint` or `--stream` and `--turn`.

## Step 7, the adapter call

`_tools_/model-validation/validate.mjs` imports `dist/llm/adapters.js` directly, so `98-model-endpoints` judges the
TypeScript adapters even under `HEDDLE_BIN`. `command::adapter_call` is the Rust side of a hidden `adapter-call`: it
reads `{"endpoint": …, "request": …}`, streams each `Chunk` as one flushed JSON line in the shape the validator reads,
and a failure as `{"type":"error","code":…,"message":…}` with exit `1`. Remaining: the binary's dispatch line, and
the validator spawning `$HEDDLE_BIN adapter-call` when `HEDDLE_BIN` is set.
