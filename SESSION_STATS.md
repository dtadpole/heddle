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

### Cycle 2 — the backend half (in progress)

- **measured:** reference numbers re-used from cycle 1; this half is the facts behind them.
- **brainstorm:** (a) compute the totals only on the page from the live stream — discarded: a reload would
  forget a session's history, and the reference's numbers are durable; (b) add a single fold
  (`projectSessionStats`) over the session's own events and expose it on `GET /api/sessions/<id>` —
  **chosen**; (c) a second projection store on the server — discarded: the events already hold every fact, and
  a second store would be a second truth; (d) keep the narrow two-field usage and guess the cache share —
  discarded: invented numbers are forbidden by this goal.
- **understand:** the missing numbers are a **mechanism**: the adapters never carried cache buckets, so no
  downstream consumer could print `Cache hit`. The step count had a mechanism already (`turn/completed.rounds`)
  that the page simply did not read.
- **step back:** the objective's backend half is now precise and smaller than it looked: normalise each
  provider frame into three prompt-side buckets plus output, merge per round, and fold the log once.
- **plan / changed:**
  - `src/llm/usage.ts` (new): `TokenUsage` with `inputTokens` (uncached), `outputTokens`,
    `cacheReadTokens`, `cacheWriteTokens`; `openaiChatUsage`, `openaiResponsesUsage`, `anthropicUsage`
    (OpenAI's cached count is a subset of prompt tokens, Anthropic's buckets are disjoint),
    `mergeTokenUsage`, `billedInputTokens`.
  - `src/llm/adapters.ts`: every provider frame now goes through those normalisers.
  - `src/agent/loop.ts`: `TurnResult.usage` is the shared type and `mergeUsage` delegates to
    `mergeTokenUsage`, so a turn with tools sums per round.
  - `src/server/ledger.ts`: totals carry `cacheRead`/`cacheWrite`; new `projectSessionStats(events)` folds
    turns (user messages), steps (`turn/completed.rounds`) and the usage buckets in one pass.
  - `src/server/web.ts`: `GET /api/sessions/<id>` carries `stats`, from the same events as the transcript.
  - `test/usage.test.ts` (new) and `test/ledger.test.ts`: the normalisers, the merge and the fold, written
    before the implementation (the usage module did not exist and the test failed on the import).
- **evidence:** `npm run check` 0 errors; `npm test` 319 passing; the usage tests failed first with
  `ERR_MODULE_NOT_FOUND` before `src/llm/usage.ts` existed, then passed; the ledger stats tests pass.
- **reds:** `test/page-contract.test.ts` carried a type error from a concurrent commit (`extracted[1]` nullable)
  and blocked the whole check; narrowed to `extracted[1] ?? ''` in the same pass.
- **remaining for this cycle:** the page's dock (two pills + context gauge, the reference's formatting) and a
  failing-first browser contract in `check-composer.mjs`; then the suites and a screenshot.
- **lessons:** normalising provider usage into DSH's bucket shape is a *mechanism* and belongs in one module
  with its own tests; a consumer-side fix (formatting) would have been three guesses repeated per provider.

### Cycle 2 — the dock, from the fold to the page (complete)

- **changed (frontend):** `src/server/page.html`: the single status line became DSH's dock — two 12px/20px
  pills (16px gauge and database icons, `·` separators at 6px margins, radius 999, `padding: 1px 8px`) and a
  13px/20px context item with a 14px two-circle ring, in one 12px-gap row flush at the card's bottom edge (the
  dock's own 4px top padding) and centred on the card. The page draws it from `GET /api/sessions/<id>`'s
  `stats` (turns, agent steps, usage buckets, last prompt size) merged with the live stream: `model/request`
  frames count the running turn's steps, `assistant/chunk` usage frames move the token figures, and a turn's
  end re-reads the durable fold. The label formats are DSH's own rules (K/M compaction, rate at 10+, cache
  share as integer unless that would claim 100%, context clamped to 100); the hero prints no dock.
- **step back:** the dialogs behind DSH's pills stay **deferred**: they need `llmMs`, `toolMs` and `ttft`,
  which heddle does not record yet, so a dialog would be invented numbers. The rate divides the turn's wall
  time rather than decode time for the same reason — recorded as a divergence. Steps are counted from
  `turn/completed.rounds` (agent steps), not tool rows, which is the reference's meaning.
- **verify:** a failing-first browser contract in `_verifiers_/80-web-ui/check-composer.mjs` — it failed on
  the hero dock (`hidden` was false) and then on the rate before the page's live wiring was complete, and now
  passes: one turn prints `1 turns` / `1 steps` / `N tok/s` / `1.1K tok` / `Cache hit 80%` / `50%` with the
  reference's `12px/20px` pills, `#adb2b8`, `999px` radius, `1px 8px` padding, `12px` dock gap and a dock top
  flush with the card's bottom edge; a second turn proves the total is cumulative (`2.1K tok`); a provider
  that reports no usage leaves the rate, total, cache phrase and context share blank and hides their items.
  The whole composer suite is 12/12 green. The screenshot of the built page with a scripted provider (`prompt_tokens 1000, cached 800, output 50`, window 2000) is [heddle-stats-dock.png](_context_/dsh-mechanisms/heddle-stats-dock.png): the dock prints the reference's three figures in one row under the card.
- **reds / divergences kept:** the dialogs; the wall-time rate; and the reference's `pill` hover affordance
  (its pills are buttons). Each is recorded rather than half-built.
- **lessons:** a stats dock is judged by its **blank state** as much as by its numbers — the first contract
  failure was the hero, not a figure; and a live figure needs both the durable fold and the stream, or a
  page that watched the turn shows one number and a reload shows another.

### Cycle 3 — both UIs re-measured, three differences fixed, no fix row left

- **measured:** the same property set on both docks, this time with the reference live in a running session
  and heddle's page served from the built tree with the scripted provider. Reference: `41 turns 2484 steps ·
  252 tok/s`, `954M tok · Cache hit 99.6%`, `34%`; dock box **510×26** (its own width hugs its items, centred
  on the card), `padding-top 4`, `gap 12`, pills `12px/20px #adb2b8 radius 999 padding 1px 8px gap 6`, the
  separator at `margin 0 6px` in the **label colour**, the context item `64×22 13px/20px radius 8 padding 1px
  8px gap 6`, and a ring of **11px** (`r 5.5`, `stroke-width 2`). Heddle at first measurement: dock box
  **956** (stretched across the column, items centred inside), separator in `--border-strong` (darker than its
  label), ring **10px** (`r 5`) — three property differences a person could see, and one (the box) that the
  ui-comparison skill names explicitly as "alignment is two claims".
- **brainstorm:** (a) accept the stretched dock — discarded: the reference's own box hugs its content and the
  hover/emphasis region differs even when the text is centred; (b) `width: fit-content` with the same max-width
  — **chosen**; (c) absolutely position the dock — discarded: a second layout mechanism for one row, and it
  would break the narrow-window clamp; (d) leave the darker separator as a theme choice — discarded: it is the
  same tertiary grey in the reference, and the darker tone is a different claim about hierarchy; (e) keep the
  10px ring — discarded: 1px on a 14px icon is the kind of difference this loop exists to remove.
- **understand / step back:** all three are values inside the dock's own stylesheet; no mechanism is missing.
  The re-measurement after the fix produced **no further fix row**: every measured property now matches the
  reference within a pixel (dock 466 hugging its content against the reference's 510; ring 11px; separator the
  label colour; pills, type, gaps, radius and the card-flush edge identical). The divergences that remain are
  the recorded ones — the wall-time rate, the absent dialogs — not defects.
- **changed:** `src/server/page.html` (dock width, separator colour, ring radius and its circumference);
  `_verifiers_/80-web-ui/check-composer.mjs` (the three new claims, written before the CSS: the first run
  failed with `actual 796 vs expected 466` for the box, and the separator/ring claims followed).
- **evidence:** the dock contract is green; the dock probe reports `ownWidth 466`, cell values
  `1 turns / 1 steps / … tok/s / 1.1K tok / Cache hit 80% / 50%`, ring `11×11` with `17.28 34.56` at 50%; the
  composer suite is 12/12; the screenshot from cycle 2 was taken before these corrections and the built page
  was re-measured after them.
- **reds:** none in the input area. The full sweep's one red, when present, is the concurrent session's
  `70-workspaces-sessions` tree work and is named in the round report.
- **lessons:** "the dock is centred" and "the dock hugs its content" are two claims — a flex row with `margin:
  auto` centres its text while stretching its own box, and only measuring the element's own width against its
  children catches it. Separator and ring sizes are properties like any other: measured at 1px, they are
  worth fixing rather than explaining.
