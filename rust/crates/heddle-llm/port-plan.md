---
title: The heddle-llm port plan
created: 2026-10-23T05:08:19Z
modified: 2026-10-23T15:04:22Z
level: L1
version: 1.2.0
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
| 6 | `10-llm-backends` and `20-streaming` through the binary | the verifiers | done, below |
| 7 | `98-model-endpoints` through the binary | the verifier | the validator remains, below |

## Step 6, measured

Run 2026-10-23 from the lane through `HEDDLE_BIN` with `_tools_/verify-runner/lane.mjs`, once the binary advertised
`Models`, `Streaming` and `Turn` and fed the `--stream` view through `StreamHub`:

- `20-streaming` — 5 of 5, verdict `0`.
- `10-llm-backends` — 6 pass, 0 fail, 2 unjudged. The two need a real configured backend or gateway, which only the
  machine's owner can provide; a file with a skipped check reports verdict `3`.

## Step 7, the adapter call

`_tools_/model-validation/validate.mjs` imports `dist/llm/adapters.js` directly, so `98-model-endpoints` judges the
TypeScript adapters even under `HEDDLE_BIN`. `command::adapter_call` is the Rust side of a hidden `adapter-call`: it
reads `{"endpoint": …, "request": …}`, streams each `Chunk` as one flushed JSON line in the shape the validator reads,
and a failure as `{"type":"error","code":…,"message":…}` with exit `1`. The binary dispatches it; remaining is the
validator spawning `$HEDDLE_BIN adapter-call` when `HEDDLE_BIN` is set.
