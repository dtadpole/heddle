---
title: Verifier 16 — Model endpoints
version: 1.1.0
description: every configured model endpoint, in each of the three wire formats, has been validated by real calls for streaming, declared reasoning levels and tool calls, and the record matches the configuration it judges.
grounded_in:
  - source: owner statement 2026-10-18 asking for verification of all endpoints against the three API types (Claude, Codex, DeepSeek), covering streaming, reasoning and tool calls, and for that check to run whenever a new endpoint or model type is configured
  - source: owner report 2026-10-18 that a configured reasoning level can be one the route rejects — measured on the Meta Codex gateway, whose route answered 400 for `ultra` while the machine's file declared it
---

# `98-model-endpoints`

Instance of this project's `_verifiers_`. **The claim it decides:** every model this machine has configured — in
each of the three wire formats heddle speaks — has been exercised end to end for the three interactions a person
uses, and the recorded result is for **this** configuration.

| Wire format | Endpoint kinds | What is exercised through the real adapter |
|---|---|---|
| Claude | `anthropic-vertex` | the publisher `streamRawPredict` stream, adaptive-thinking effort, `tool_use` streaming |
| Claude | `anthropic-messages` | Anthropic's `POST /v1/messages` stream, summarized thinking (adaptive effort or a token budget, as the level's value declares), `tool_use` streaming |
| Codex | `openai-responses` | the Responses stream, `reasoning.effort`, `function_call` streaming |
| DeepSeek | `openai-chat` | the Chat Completions stream, `reasoning_effort`, `tool_calls` streaming |

The endpoint **names** on a machine are local (Meta's gateways, plugboard's routes, DeepSeek's own API); the three
**formats** above are what the validation is organised by, because the format decides the request shape, the
reasoning field and the tool-call event.

## Where it runs

**No browser, and no network call in the check itself.** The validation's calls happen in
[`_tools_/model-validation/`](../../_tools_/model-validation/INDEX.md); it records its results beside a fingerprint
of the configuration it saw. This verifier judges that record: it is fast, offline and safe to run in any suite.

```bash
npm run validate:endpoints     # makes the calls; writes $HEDDLE_HOME/model-validation.json
sh verify.sh                   # judges the record against the current configuration
```

## The checks

| Check | The claim |
|---|---|
| a fresh validation record exists | a validator run exists for **this** configuration's fingerprint and covers streaming, reasoning and tool calls |
| every configured model passes | each endpoint/model carries a passing streaming, reasoning-level and tool-call result; for Claude, and for a Codex endpoint whose models reason, the summarized thinking text must also be visible (non-empty), because that is the thing the page shows |

On a machine with no local endpoint configuration both checks report **unjudged** (the project's 3): a fresh clone
or CI has nothing to validate, and passing silently would be the same mistake as calling a green branch a
deployment.

## Why this exists

The owner asked for all three formats to be validated, and asked that the check run whenever a new endpoint or
model type is configured — not once, by hand. Two real defects made the rule concrete on 2026-10-18:

- a local file declared a reasoning level the route **rejects** (Codex `ultra`: the route answered `400 Invalid
  value: 'ultra'. Supported values are: 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'`), which the
  validator now catches by exercising each declared level;
- a serving path answered turns with `500 Cannot read properties of undefined (reading 'names')` after the
  deployment chain started a checkout without its profile, which the owner-visible probes caught and this matrix
  keeps honest per endpoint;
- Claude's configured reasoning was **not visible**: the adapter asked for adaptive thinking without a summarized
  display, so the route streamed one empty `thinking_delta` (0 characters) and the Web UI's Think row had nothing
  to show. The adapter was fixed, and this verifier's reasoning claim for the Claude family now includes that the
  thinking text arrived.
- Codex's configured reasoning was invisible for the same kind of reason at the other end of the wire: the
  Responses request never asked for `reasoning.summary`, so the route streamed no summary events at all. With
  `summary: 'auto'` the same route streams ~87-104 summary deltas before the answer; the fix is in the adapter and
  the Codex row of the record now requires visible summarized thinking.

## How a new endpoint or model type is gated

Editing the machine-local configuration changes the fingerprint. The first check then fails until
`npm run validate:endpoints` runs, and the second fails until every new model passes the three interactions. The
gate is intentionally a **fail**, not a warning: an endpoint nobody called is an endpoint nobody knows works.

## What it deliberately does not judge

- **Answer quality.** The validator asks for a short counting answer, "ok", and one tool call; it judges mechanisms.
- **Quota and cost.** A `validate:endpoints` run spends one small call per declared level plus three interactions
  per model, on the owner's own credentials. The verifier does not spend anything.
- **The UI.** Streaming on the owner's page is judged by [`20-streaming`](../20-streaming/INDEX.md) and the
  delivery by [`96-deployment`](../96-deployment/INDEX.md).
