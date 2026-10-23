---
title: The heddle-team integration tests
version: 0.1.0
description: The heddle-team crate's integration tests, which run the team layer over the real crates rather than its own doubles.
grounded_in:
  - source: _verifiers_/50-agentic-loop/check-teams.mjs@d649349 with its fixtures/team-recover@81c5915
  - source: _verifiers_/80-web-ui/check-team-view.mjs@5ed8deb
---

# `rust/crates/heddle-team/tests`

The crate's integration tests. Unit tests sit beside the code in `src/`; these run the team layer over the real
crates, each judged against the verifier claim it rehearses.

## What belongs here

| File | Runs over | What it judges |
|---|---|---|
| [`session_store.rs`](session_store.rs) | the real `heddle-session` store | check-teams' recorded store recovered byte for byte; its first check's journal through the nine tools, restart included; check-team-view's fixture served through `team_view`; the policy note's place in the Lead's request, pinned as the TypeScript build writes it |
| [`compose.rs`](compose.rs) (feature `compose`) | the runtime the binary builds — model, session, context, sandbox, approvals and the gated tool registry | the `team` row started through `compose::start_row`, and a real Lead turn running check-teams' first script |

A new file here runs over at least one real crate and names the verifier claim it rehearses. A test that needs
only the crate's ports belongs beside the code instead.

## Read next

[`../INDEX.md`](../INDEX.md) for the crate's API, seams and port plan; [`../src/INDEX.md`](../src/INDEX.md) for the
sources.
