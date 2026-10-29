---
title: Verifier 1 — LLM Backends
version: 1.1.0
description: heddle connects to backend model servers and runs agent loops over them.
grounded_in:
  - source: owner statement in the dsh session, 2026-10-11, listing the ten verifiers
---

# `10-llm-backends`

Instance of this project's `_verifiers_`. **The claim it decides:** heddle connects to backend model servers and runs agent loops over them.

One endpoint is not a backend tier. This part judges that more than one wire shape is spoken (four HTTP shapes: Chat Completions, Responses, Anthropic's Messages API and Anthropic's publisher route), that the endpoint list is configuration rather than code, and that a real configured backend answers — the last of those spending one short request, and reporting unjudged rather than passing when nothing is configured.

## Where it runs

**No browser.** The checks drive the CLI, a scripted endpoint or a local HTTP double; nothing here needs
a display or a window.

## What decides it

- `check-backends.mjs` — the endpoint list is configuration, turns run over the Chat Completions and Responses
  shapes against local doubles, the configured default is honoured, listing costs nothing, and a configured
  `openai-chat` backend answers one short request (or is unjudged).
- `check-publisher-route.mjs` — a turn over Anthropic's cloud publisher route (`anthropic-vertex`) against a double,
  and a configured publisher endpoint answering one short turn (or unjudged).
- `check-messages-route.mjs` — a turn over Anthropic's own Messages API (`anthropic-messages`, `POST
  {baseUrl}/messages`, `x-api-key` and `anthropic-version` headers) against a double, and a configured Messages
  endpoint answering one short turn (or unjudged).

## Running it

```bash
sh verify.sh            # every check, with the verdict
sh verify.sh --list     # the check names, and why any was unjudged
sh verify.sh --json     # one parseable object
```

Exit `0` when the claim holds, `1` when it fails, `3` when it could not be judged. A
claim that could not be judged is never reported as holding, which is the runner's
whole reason for existing — see [`_tools_/verify-runner/`](../../_tools_/verify-runner/INDEX.md).

## What it deliberately does not judge

- **How well a model reasons.** Nothing here scores an answer's quality; the checks
  ask whether the mechanism works.
- **Anything it has to spend to see.** Except where a check is named for the real
  backend, every fixture is local and the run is free.

## Read next

[`../INDEX.md`](../INDEX.md) for the verifications, and
[`../../ULTIMATE_GOAL.md`](../../ULTIMATE_GOAL.md) for the part this one decides.
