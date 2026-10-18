---
title: Session statistics, as DSH does it
version: 1.0.0
description: The bottom-stats parity loop — the reference's dock measured per element and per state, the formula behind each number, the backend facts heddle lacks, and one evidence block per cycle.
level: L2
status: draft
grounded_in:
  - source: DSH 0.2.0-rc.2 at http://127.0.0.1:8080 driven with the repo browser tool on 2026-10-17, stats dock measured with getComputedStyle and per-element rects
  - source: DSH's own client bundle read for the formulas (dsh-client-ui-chat, dsh-client-ui-conversation, dsh-token-meter)
  - source: heddle's own source read the same day (src/server/page.html, src/agent/loop.ts, src/llm/adapters.ts)
---

# Session statistics, as DSH does it

The owner asked for DSH's three bottom statistics under the composer to be implemented in heddle,
UI and backend, via the full-loop procedure. The reference, measured in a running session:

```
32 turns 977 steps · 223 tok/s
403M tok · Cache hit 99%
22%
```

This file is the loop's memory: what the reference actually renders, what each number means, what
heddle has today, and one evidence block per cycle.

## The reference, measured

### The dock

One row under the composer card, flush at its bottom edge (`gap 0`, the dock's own `padding: 4px 0 0`),
centred on the card (card centre 777, dock centre 776.5 at the measured window). `display: flex`,
`gap: 12px`, height 26px.

| Part | Measurement |
|---|---|
| Pill 1 (time) | button, 214×22, `padding: 1px 8px`, radius `999px`, `display:flex`, `gap:6px` |
| Pill 2 (usage) | button, 189×22, same shape |
| Labels | `font: 12px/20px`, colour `rgb(173,178,184)`, `font-variant-numeric: tabular-nums` |
| Icons | 16×16 SVG, `stroke: currentColor`, stroke-width 1: a gauge (clock-like) for the time pill, a database for the usage pill |
| Separator | a `span.sep` reading `·`, same 12px label, `aria-hidden` |
| Context gauge | a third item, 64×22: button `padding: 1px 8px`, radius 8px, `font: 13px/20px`, colour `rgb(173,178,184)`; its icon is a 14×14 two-circle ring (`stroke-width: 2`, track = border-l3, fill = label-tertiary) followed by `22%` |
| Order | time pill, usage pill, gauge — left to right, with the gauge last and offset by the root's 12px gap |
| Interaction | both pills are `button[aria-haspopup=dialog]` and open a dialog ("Session statistics", "Token usage"); the gauge opens a context panel |

### The numbers, and their formulas (read from DSH's own bundle)

- **Turns and steps** come from the session's statistics projection: `turns`, `steps`, plus timings
  (`llmMs`, `toolMs`, `ttftMs`, `ttftSteps`, `decodeMs`, `decodeTokens`).
- **`{tps} tok/s`** = `decodeTokens / (decodeMs / 1000)`, shown only when `decodeMs > 0`;
  formatted by `formatTokensPerSecond`: at least 10 → integer, below 10 → one decimal.
- **`{total} tok`** = `uncachedInputTokens + cacheReadTokens + cacheWriteTokens + outputTokens`,
  summed over the **whole durable session log**; formatted by `formatTokens`: below 1000 exact,
  below 1e6 → `K` (integer at ≥100, else one decimal), else `M`.
- **`Cache hit {percent}%`** = `cacheReadTokens / (uncachedInputTokens + cacheReadTokens +
  cacheWriteTokens)`, integer text; `null` (and the phrase omitted) when the denominator is 0; `100`
  when every billed input token was a cache read, with extra decimal places only when integer
  rounding would reach 100 without a full hit.
- **`{percent}%` context** = `min(100, round(usedTokens / contextWindow * 100))`, from the context
  pressure projection and the endpoint's window; the gauge's aria text is "`{percent} of context used`".
- The usage projection adds each reported frame's `inputTokens` as **uncached**, with
  `cacheReadTokens` / `cacheWriteTokens` kept as separate buckets — which is the shape the formulas
  above assume.

### State matrix

| State | Observation |
|---|---|
| new session (hero) | no dock at all — nothing is printed before a session exists |
| running turn | dock present and **live**: the same session read `976 steps` then `977 steps` a second apart |
| idle after a turn | dock persists, inputs untouched |
| provider reports no usage | not observable on this reference's provider; the formulas make the number vanish, and heddle must keep its blanks |
| dialog open | not measured this cycle — recorded as an unknown (the pills' dialogs need `llmMs`/`toolMs`/`ttft` data heddle does not record yet) |

## Heddle today, measured against it

- `#composer-status`: **one** row of four text spans (turns, steps, tokens, context), 12px on the
  status line's own colour, `·` between non-empty cells; no pills, no icons, no gauge, no rows.
- **turns** counts user rows in the transcript; **steps** counts tool rows. DSH's `steps` is the
  agent's step count. Heddle's `turn/completed` event already carries `rounds` — the honest step
  number, and the plan is to use it instead of counting tool rows.
- **tok/s** = last turn's `outputTokens / duration`; DSH's is decode-time based (`decodeTokens /
  decodeMs`). Heddle has no decode timing, so the same visible number is computed from the turn's
  wall time; that divergence stays, recorded.
- **tokens** in heddle = the last turn's rate only; there is no session-cumulative token total to
  print, and no cache buckets at all: the adapters map only `inputTokens`/`outputTokens`.
- **context** = last turn's `inputTokens / endpoint.contextWindow`; DSH's used tokens are the same
  prompt-side fact, so this one is already right in kind.
- **backend gap**: `TokenUsage` has no `cacheReadTokens`/`cacheWriteTokens`; no cumulative session
  usage is exposed; `rounds` is logged but not read by the page.

## Cycle log

### Cycle 1 — measure the reference, name the facts, plan both sides

- **measured:** the dock's parts and properties in the table above (one row, two 12px/20px pills with
  16px icons and `·` separators, a 13px/20px context gauge with a 14px two-circle ring, flush under
  the card with 4px of dock padding and 12px gaps, centred on the card). Text sample from a running
  session: `32 turns 977 steps · 223 tok/s`, `403M tok · Cache hit 99%`, `22%`, with steps observed
  incrementing between two probes.
- **brainstorm:** (a) extend the existing four-span row with two more cells — discarded: the reference
  is two pills plus a gauge, and a fifth inline cell keeps the wrong shape; (b) port the dock as
  measured, with the backend facts it needs — **chosen**; (c) render the three lines stacked, as the
  owner's message quotes them — discarded: the quote's line breaks are its formatting; the reference
  renders one row; (d) also port the two dialogs in this cycle — **deferred, not discarded**: they
  need `llmMs`/`toolMs`/`ttft` that heddle does not record, and half-built dialogs would be invented
  numbers; recorded as the follow-up subject; (e) compute totals on the page from the last turn —
  discarded: invented cumulative numbers, which the objective forbids.
- **understand:** the visible layout is arrangement (value-level), but the two numbers that are
  missing — cumulative tokens and cache-hit share — are **mechanism**, not values: the adapters must
  carry cache buckets and the page must sum a session's durable usage. Tokens/steps already exist in
  the log (`turn/completed.rounds`), so the plan keeps the page as the aggregator of the session's own
  events rather than adding a second projection.
- **step back:** still the right objective, and its scope is now precise: backend = usage buckets and
  the cumulative sum; frontend = the dock as measured. The dialogs, decode-time rate and agent-step
  semantics are divergences; each is recorded above with its reason rather than half-built.
- **plan:** (1) extend the usage type in `src/llm/types.ts` with `cacheReadTokens`/`cacheWriteTokens`
  and map them in the three adapters (openai-chat: `prompt_tokens_details.cached_tokens`; responses:
  `input_tokens_details.cached_tokens`; anthropic: `cache_read_input_tokens` /
  `cache_creation_input_tokens`), with `inputTokens` normalised to the **uncached** prompt side; (2)
  extend `mergeUsage` and its unit tests to add the buckets; (3) the page sums each session's `done`
  usage and `turn/completed.rounds` from the durable events it already loads, and renders the dock;
  (4) verify with a failing-first browser contract (two turns, cache usage, a window) plus unit tests,
  a screenshot, and the suites.
- **changed:** this document (research block). Implementation follows in cycle 2.
- **reds:** none at this point; suites are run at the end of each implementation cycle.
- **lessons:** the number a dock prints is the *last* thing to copy — the formula and the bucket shape
  behind it decide whether the UI can even be built; and a quoted reference with line breaks is a
  formatting artefact, not a layout.
