---
title: The heddle-sandbox sources
version: 0.2.0
description: The sources of the heddle-sandbox crate, one module per TypeScript file, with unit tests beside the code.
grounded_in:
  - source: rust/ULTIMATE_GOAL.md
  - source: src/sandbox/*.ts and src/approvals/service.ts, read 2026-10-22
---

# `rust/crates/heddle-sandbox/src`

The sources of the crate, with unit tests in `#[cfg(test)]` modules beside the code.

| File | What it is | Ported from |
|---|---|---|
| [`lib.rs`](lib.rs) | the crate root, its module table and the re-exports | — |
| [`mode.rs`](mode.rs) | the three modes, the resolved policy, the writable-root set, the model-visible policy sentence | `src/sandbox/policy.ts` |
| [`paths.rs`](paths.rs) | lexical resolve, canonicalisation through the deepest existing ancestor, component-wise containment | `src/sandbox/paths.ts` |
| [`backend.rs`](backend.rs) | the backend trait, platform selection, the fail-closed error, outcome classification and the shell's sentences | `src/sandbox/backend.ts` |
| [`seatbelt.rs`](seatbelt.rs) | the macOS rung: the SBPL profile and its functional probe | `src/sandbox/seatbelt.ts` |
| [`linux.rs`](linux.rs) | the bubblewrap and Landlock rungs and their chain | `src/sandbox/linux.ts` |
| [`escalation.rs`](escalation.rs) | the one-call wider-retry ladder and its approval ask | `src/sandbox/escalation.ts` |
| [`transition.rs`](transition.rs) | the owner's session-mode change rule | `permissionTransition` in `src/sandbox/service.ts` |
| [`service.rs`](service.rs) | the sandbox service: the file fence and the shell seam | `SandboxService` in `src/sandbox/service.ts` |
| [`approvals.rs`](approvals.rs) | the approval policy and the question channel | `src/approvals/service.ts` |
| [`fixture.rs`](fixture.rs) | the recorded approval question, its SSE frame and its answers, with tests that pin the serialiser to them | `src/approvals/service.ts`, `src/server/page.html` |

## Read next

[`../INDEX.md`](../INDEX.md) for the public API, what the other crates must do with it, and the port plan.
