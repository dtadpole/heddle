---
title: heddle-web-trajectory integration tests
created: 2026-10-23T05:09:00Z
modified: 2026-10-31T16:03:56Z
version: 1.1.0
description: Integration tests that judge the Trajectory verifiers' API expectations on session logs the TypeScript build recorded, and the projections both builds share on hand-written fixtures.
grounded_in:
  - source: _verifiers_/85-trajectory-view/check.mjs; _verifiers_/80-web-ui/check-trajectory-view.mjs, check-runtime-context.mjs, check-composer.mjs
---

# `tests`

Cargo's integration tests for this crate. They use only its public API.

| Path | What it is |
|---|---|
| [`verifier_expectations.rs`](verifier_expectations.rs) | each verifier's assertions about `?view=ledger` and the chat route's `stats`, each naming the check line it stands in for |
| [`timeline_records.rs`](timeline_records.rs) | an answer's TTFT measured from its step request (#124) and the overview's per-record timeline, on the shared fixture `test/ledger.test.ts` also reads |
| [`between_turns.rs`](between_turns.rs) | records outside every turn placed where they happened, in Between turns sections (S151), on the shared fixture `test/ledger.test.ts` also reads |
| [`fixtures/`](fixtures/INDEX.md) | the logs those tests read, with their provenance |

Unit tests live beside the code in [`../src/`](../src/INDEX.md).

## Read next

[`fixtures/`](fixtures/INDEX.md); [`../VERIFICATION.md`](../VERIFICATION.md).
