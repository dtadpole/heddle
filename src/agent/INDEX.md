---
title: Agent
version: 1.0.0
description: The agent loop, which turns a prompt into model rounds and tool calls, and the **subagent delegation** that lets
a running turn hand a scoped task to a child agent and receive its final answer.

| File | What it is |
|---|---|
| [`loop.ts`](loop.ts) | one turn: record the prompt, ask the model, run the tools it asks for, repeat until it stops |
| [`subagent.ts`](subagent.ts) | a child agent as its own session, attributed by `parentSession`/`origin`/`delegationDepth`, with depth and active limits and its answer folded from its own log |

The DSH reading that grounds the delegation model is
[`_context_/dsh-mechanisms/dsh-agent-teams.md`](../../_context_/dsh-mechanisms/dsh-agent-teams.md).
grounded_in:
  - source: human-authored
---

# `agent`

The agent loop, which turns a prompt into model rounds and tool calls.

This is a source folder rather than a type folder: it carries code, not instances of a
registered content type. Its entry point exists so that a reader who opens it learns
what belongs here and what to read next, which is the same duty every `INDEX.md` in
this tree carries.

## Read next

[`../../README.md`](../../README.md) for how the layout fits together, and
[`../../_verifiers_/INDEX.md`](../../_verifiers_/INDEX.md) for the claims that decide
whether what lives here works.
