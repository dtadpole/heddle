---
title: Model validation
version: 1.0.0
description: drives every model this machine has configured through the real adapter and records whether streaming, its declared reasoning levels and tool calls work, beside a fingerprint of the configuration, so a new endpoint or model type is gated on a validation that exercised it.
grounded_in:
  - source: owner statement 2026-10-18 asking for verification of all endpoints against the three API types (Claude, Codex, DeepSeek), covering streaming, reasoning and tool calls, and for that check whenever a new endpoint or model type is configured
  - source: measured 2026-10-18 that the Meta Codex route rejects `reasoning.effort: ultra` with a 400 while a local configuration declared it, so a declared level must be exercised, not trusted
---

# `model-validation`

A tool, not a shipped part: it exists because this machine's endpoint list is machine-local and grows, and an
endpoint nobody called is an endpoint nobody knows works.

## The three wire formats, and what is exercised

| Format | Kinds | Streaming | Reasoning | Tool call |
|---|---|---|---|---|
| claude | `anthropic-vertex` | publisher `streamRawPredict` SSE → ≥2 text deltas and a `done` chunk | every declared level sent as adaptive thinking + `output_config.effort`; the route must accept it, **and the summarized thinking must actually arrive** (measured: adaptive thinking without a summarized display streams one empty delta, so the page has nothing to show) | a streamed `tool_use` call to `probe_echo` |
| codex | `openai-responses` | Responses SSE (`response.output_text.delta`) → ≥2 deltas and completion | every declared level sent as `reasoning.effort`, **and the summarized reasoning requested with `reasoning.summary: 'auto'` must arrive** for a reasoning-configured endpoint (three attempts, because a route may not summarize every response) | a streamed `function_call` to `probe_echo` |
| deepseek | `openai-chat` | Chat Completions SSE → ≥2 deltas and a `done` chunk | every declared level sent as `reasoning_effort` | a streamed `tool_calls` entry to `probe_echo` |

Offline fixtures (`scripted`) and unknown kinds are skipped by design: a deterministic fixture streaming is not a
network claim, and the validation must not spend a call to prove it.

## Running it

```bash
npm run validate:endpoints                    # every configured model, concurrency 3
node _tools_/model-validation/validate.mjs --endpoint meta-codex --model gpt-6-luna
node _tools_/model-validation/validate.mjs --json
```

Options: `--endpoint NAME`, `--model ID`, `--concurrency N` (default 3), `--timeout-ms N` (default 120000),
`--out PATH` (default `$HEDDLE_HOME/model-validation.json`), `--json`.

Exit `0` when every configured model passed; `1` when an interaction failed; `3` when nothing could be judged (no
machine-local configuration, no eligible endpoint, or no built `dist/`). A failure names the endpoint, the model
and the interaction, because the reader's next act is to fix that pair.

## What it writes

`$HEDDLE_HOME/model-validation.json` — beside the configuration it validated:

- `configFingerprint` — a hash of the endpoint names, kinds, addresses and model ids + declared level values. It
  deliberately **excludes credentials**, so the record can sit next to results without leaking a key.
- `results` — per endpoint/model: the streaming numbers (delta count, characters, first/last/span), one reasoning
  result per declared level, and the tool-call result.
- `summary` — models passed/failed, split by wire format.

[`_verifiers_/98-model-endpoints`](../../_verifiers_/98-model-endpoints/INDEX.md) judges the record: a configuration
edit changes the fingerprint, so it goes stale and the verifier fails until this tool is run again. That is the
"whenever a new endpoint or model type is configured" mechanism.

## Defects the matrix has found

- **A declared level the route rejects.** `meta-codex`'s `gpt-6.1-sol-ptu` listed `ultra`; the route answers `400
  Invalid value: 'ultra'. Supported values are: 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'`. The
  level was removed from the machine's configuration, and the per-level acceptance check is what found it.
- **Reasoning that is configured but invisible.** `meta-claude`'s adaptive thinking without
  `thinking.display: 'summarized'` opened a thinking block and streamed one empty `thinking_delta` — 0 characters
  for the transcript and the page. The adapter now asks for the summarized display, and the Claude row of this
  matrix fails if a configured model streams no visible thinking text.
- **Reasoning that is configured but invisible, again — Codex.** The Responses adapter sent `reasoning: { effort }`
  and never asked for `reasoning.summary`, so the Meta Codex route streamed **zero** reasoning events (measured:
  0 without the summary, 87 deltas / 393 characters with `summary: 'auto'`, and the no-level `gpt-5.6-sol-ptu`
  streamed 99 when asked). The adapter now asks when the endpoint's models reason, and the Codex row of this matrix
  fails if a configured reasoning model streams no summarized thinking. The claim is given three attempts because
  the route decides per response whether to summarize: the same model produced 95-104 deltas on one call and none
  on the next.
- **Budgets that judged the budget instead of the claim.** A reasoning call asked for 8 output tokens (the Codex
  route's minimum is 16), and the streaming call asked for 128 — a DeepSeek reasoning turn spent all 128 on
  `reasoning_content` and produced 0-1 text deltas. The tiny call now asks for the route minimum, and the streaming
  call budgets reasoning plus the answer.
- **A transient provider second.** One run failed a model on a plugboard 5xx; a gate that flakes on a provider's
  bad second is a gate people learn to ignore, so every call is retried once and the recording keeps the attempt
  count.

## What it costs

One short call per declared reasoning level, plus three calls per model, on the owner's own credentials — a full
run on this machine is ~130 small calls. Prompts are one counting line, "ok", and one tool request; the defaults
keep output tiny. The verifier spends nothing.

## What it deliberately does not judge

- **Answer quality.** It asks for a short counting answer; the claim is that the mechanism works.
- **The Web UI.** Streaming on the owner's page belongs to [`20-streaming`](../../_verifiers_/20-streaming/INDEX.md)
  and [`80-web-ui`](../../_verifiers_/80-web-ui/INDEX.md); the delivery belongs to
  [`96-deployment`](../../_verifiers_/96-deployment/INDEX.md).
- **A model that genuinely lacks tools.** That is reported as a failure of this matrix on purpose: either the
  configuration declares a capability the route does not have, or the model belongs behind an endpoint that does
  not claim `tools` — both are configuration defects a person should see.

## Where the tests live

[`_tests_/lib/unit.test.mjs`](_tests_/lib/unit.test.mjs) — the pure half: format mapping, target extraction,
fingerprint sensitivity (including "a credential is not in the fingerprint"), the route's minimum output tokens,
and the judgement the verifier applies.
[`_tests_/formats/unit.test.mjs`](_tests_/formats/unit.test.mjs) — one local double per wire format (Chat
Completions, Responses, Anthropic publisher) answering with reasoning, text and a tool call, driving the real
adapter. That is the offline counterpart of the live matrix and runs in any checkout. Neither suite uses a network
or a browser.
