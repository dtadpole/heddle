---
title: LLM
version: 1.1.0
description: The model service, its wire adapters and the HTTP client they share.
grounded_in:
  - source: human-authored
---

# `llm`

The model service, its wire adapters and the HTTP client they share.

This is a source folder rather than a type folder: it carries code, not instances of a
registered content type. Its entry point exists so that a reader who opens it learns
what belongs here and what to read next, which is the same duty every `INDEX.md` in
this tree carries.

## Where a request goes

An endpoint is one provider: a `kind` (the wire shape), a `baseUrl`, and the models it offers under `models`.
Three facts about **where** a request is sent are resolved here rather than by each adapter:

- **The address.** A model may carry its own `baseUrl`, for a gateway that puts each deployment on its own host;
  `baseUrlFor` returns it, or the endpoint's when the model declares none. Every adapter asks it.
- **The window.** A model may carry its own `contextWindow`; `contextWindowFor` returns it, or the endpoint's.
  The context budget is priced from the model a call names, not from the endpoint alone.
- **The hop.** `proxy` names an HTTP forwarding agent on loopback, for a gateway reachable only through one.
  Every adapter passes it, because where an endpoint is reachable from is not a fact about a wire shape.

Each adapter also translates its provider's way of ending into the loop's words — `stop` for a finished answer,
`tool_calls` for a round that asks for tools, anything else an abnormal end the answer reports. The Responses
shape says `completed` and has a separate `response.incomplete` event, and `responsesFinishReason` is that
translation. The endpoint list itself is sorted by name where it is composed, in `../endpoints.ts`.

## Read next

[`../../README.md`](../../README.md) for how the layout fits together, and
[`../../_verifiers_/INDEX.md`](../../_verifiers_/INDEX.md) for the claims that decide
whether what lives here works.
