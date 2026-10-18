---
title: Context
version: 1.2.0
description: How a model call's context is derived from a surface, priced, pruned and compacted.
grounded_in:
  - source: owner statement in the dsh session, 2026-10-11, that context and prompt composition must follow DSH
  - source: _context_/dsh-mechanisms/dsh-context.md, corrected against the installed DSH 0.2.0-rc.2
---

# `context`

Six modules that decide what a model is actually sent, each following the mechanism of the same name
in `@deepseek-ai/dsh-*`:

| File | What it is |
|---|---|
| [`meter.ts`](meter.ts) | the deterministic token estimate, per node, with a provider-usage anchor |
| [`budget.ts`](budget.ts) | the trigger and the retained tail, resolved from the routed endpoint |
| [`prune.ts`](prune.ts) | oversized tool results, rewritten as surface replacements |
| [`compaction.ts`](compaction.ts) | range selection, summarisation, and the one replacement that shadows it |
| [`instructions.ts`](instructions.ts) | the project's rule files, rendered as one baseline inside a byte budget |
| [`service.ts`](service.ts) | the seam the loop talks to; the only place that knows all five, plus the runtime-context snapshot (the standing facts a model is told, appended as a sourced user message when they change) |

## What belongs here

- **The surface is upstream of this folder.** The positional view of the log lives in
  [`../session/store.ts`](../session/store.ts) because it is a property of the log; what lives here
  is what a request is *made* of once that view exists.
- **The token meter** — four characters per token with fixed per-message and per-block overhead,
  priced per node so a shadow price is exact. A provider's usage anchors a measurement only when it
  is for the same envelope and is no lower than the estimate.
- **The budget** — `threshold = 0.8 × window` and `retain = 0.16 × window`, with the window taken
  from the routed endpoint first and per-endpoint overrides available. A retained tail at or above
  the trigger is refused, because it could never make progress.
- **Pruning before summarising** — a tool result over the threshold becomes head, marker and tail as
  a **durable replacement** with a `compaction/prune` shadow price before it, and the session is
  measured again: if that cleared the pressure, no summary is paid for.
- **Compaction** — the oldest balanced span is summarised and **shadowed**, not deleted: four events
  and one replacement, the shadowed events stay readable, `heddle transcript` still shows everything,
  a cut never separates a tool call from its result, the system prompt is never shadowed, and a
  summary that does not shrink is refused and recorded.
- **The instruction baseline** — one durable user-role message, `<system-reminder>` framed, with
  broader files dropped whole before the nearest one is truncated and the omissions named. It is
  re-sent only when its digest changes.

## The numbers, and where each came from

| Constant | Value | Source |
|---|---|---|
| `CHARS_PER_TOKEN` | 4 | DSH's local heuristic |
| `ROLE_OVERHEAD`, `BLOCK_OVERHEAD` | 4, 4 | DSH |
| `THRESHOLD_RATIO` | 0.8 | DSH's compaction threshold |
| `RETAIN_RATIO` | 0.16 | DSH's retained tail, required to be below the threshold |
| `PRUNE_THRESHOLD_CHARS` | 8192 | DSH's pruner |
| `PRUNE_HEAD_CHARS`, `PRUNE_TAIL_CHARS` | 4096, 1024 | DSH's pruner |
| `INSTRUCTIONS_MAX_BYTES` | 65536 | DSH's instruction budget |

## What the harness writes is not what a person said

The system prompt, the instruction baseline and a compaction checkpoint are all model-visible
messages, and all three are written as **`context/note`** events rather than `message` ones. That is
a claim about authorship, and it is load-bearing: a view of the conversation renders `message` and
chunk events, so a note cannot appear in one by accident. Measured the other way — with the
checkpoint and the baseline written as user messages, the Web UI showed a project's instructions and
a compaction to the reader as though they had typed them.

## Not implemented, deliberately

- **The surface's `project` plan kind** — DSH lets a plugin substitute the message an event derives
  to, which is how an image reference becomes a file id. heddle has no images.
- **A runtime-context snapshot** — DSH inserts one sourced user message per step; heddle's
  equivalent is the instruction baseline plus the tool descriptions.
- **Cache-token buckets in the usage anchor** — the anchor adds input and output tokens; DSH also
  adds cache reads and writes, which this harness does not parse yet.

## Read next

[`../session/INDEX.md`](../session/INDEX.md) for the log and the surface this reads,
[`../llm/INDEX.md`](../llm/INDEX.md) for the request it produces, and
[`../../_verifiers_/30-context-management/INDEX.md`](../../_verifiers_/30-context-management/INDEX.md)
for the claim it decides.
