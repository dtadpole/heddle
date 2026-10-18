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
- **reds:** none in the input area. The full sweep at the cycle's close is 14/15: `70-workspaces-sessions`
  has two reds, from another session's in-flight pin/archive/fork work (its `check.mjs` is modified in the
  shared tree); every other suite — including `80-web-ui` and the 12-check composer contract — is green.
- **close:** `npm run check` 0 errors, `npm test` 322 passing, `npm run build` succeeded; the goal's three
  cycles are done and the last full measurement produced no further fix row, so the loop stops here.
- **lessons:** "the dock is centred" and "the dock hugs its content" are two claims — a flex row with `margin:
  auto` centres its text while stretching its own box, and only measuring the element's own width against its
  children catches it. Separator and ring sizes are properties like any other: measured at 1px, they are
  worth fixing rather than explaining.

## Deployment (after the loop closed)

The loop's cycles built `dist/` but did not deploy it, and the gap was real: the launchd service
`com.dtadpole.heddle-web` was pointing at `/Users/zhenc/heddle-model-selector/dist/cli.js` — another session's
worktree, repointed for its own UI work — so the owner's page at `127.0.0.1:8082` served that worktree's build
and never showed the new dock.

Fixed: the plist was backed up, its `ProgramArguments` and `WorkingDirectory` restored to
`/Users/zhenc/heddle`, `npm run build` re-run in the main checkout (the page is read per request, so a rebuild
alone updates the served page), the service booted out and bootstrapped again, and the served HTML checked:
`data-stat-pill` markers present, the gate at 8082 answers 200. The live screenshot with the owner's real
session — [heddle-stats-dock-live.png](_context_/dsh-mechanisms/heddle-stats-dock-live.png) — shows the dock
reading `8 turns 17 steps`, `267K tok · Cache hit 63%`, `2%`.

Lesson for the skill: a loop that ends at "the suites are green" can still leave the owner looking at a
different build; **deployment is the last assertion**, and it is a question of *which checkout the service
runs*, not only whether `dist/` is fresh.

### Deployment, second incident — the service was repointed again

The first fix was overwritten within a minute: `com.dtadpole.heddle-web` was repointed back to
`/Users/zhenc/heddle-model-selector` at 19:42 by another session that used the shared daemon for its own UI
checks, so `8082` (a supervisord-managed transparent proxy fixed to `3082`) kept serving the worktree's build.
A 3084 side-daemon experiment was tried and dropped: the documented architecture in
`nexus/_projects_/dsh-web-ops/_tools_/heddle-web-gate/LOOP.md` is *one* heddle on 3082 behind a guarded 8082,
and adding a second daemon behind a private proxy was a second truth.

Restored again: the plist's `ProgramArguments` and `WorkingDirectory` point at `/Users/zhenc/heddle`, the
service was booted out and bootstrapped (the running process now is `.../heddle/dist/cli.js`), and the served
pages were checked at both ports — `3082` and `8082` each carry `data-stat-pill`. The owner's URL was verified
directly: [heddle-stats-dock-8082.png](_context_/dsh-mechanisms/heddle-stats-dock-8082.png) is
`http://localhost:8082/` with the dock reading `8 turns 17 steps · 267K tok · Cache hit 63%` (the context
percent is honestly blank there because that session's endpoint declares no window; the claude-opus session at
`3082` showed `2%`). The model-selector session was steered to run its own server on another port and to leave
`3082`/`8082` alone.

## Completeness loop — cycle 1: the context gauge was hidden, not missing

**The report.** The owner saw the dock's first two items but no context-used part. Measured on the live page:
the dock's third item was absent while `13 turns 31 steps` and `692K tok · Cache hit 80%` rendered.

**Measured (both sides).** The element exists in the page and is hidden by design when no context window is
declared; the session's own stats do carry the numerator — `GET /api/sessions/<id>` returned
`stats.lastPromptTokens: 37796` for the live `plugboard-d` session. `/api/endpoints` showed both
`plugboard-d` (`deepseek-flash`) and `plugboard-x` (`gpt-6.1-sol`) **without** `contextWindow`, while
`claude-opus` declares 1,000,000 — which is why only some sessions had the gauge. So the missing thing was a
**value**, not a mechanism.

**Where an honest value comes from (measured, not guessed).** Both providers' model lists report it, reached
through the signing helper: `GET /d/models` → `data[].context_window` = **1,048,576** for `deepseek-flash`;
`GET /x/models` → `models[].context_window` = **500,000** for `gpt-6.1-sol` (plus `max_context_window`
872,000). No local catalogue in DSH held these numbers, so a hardcoded table would have been a guess with a
helpful shape.

**Brainstorm:** (a) leave the gauge blank — rejected: the fact is available; (b) hardcode a model→window table
in the repo — rejected: guessed numbers for private models and stale the day a route changes; (c) declare the
windows in the machine-local config, values taken from the providers' own metadata — **done now** as the
immediate fix; (d) teach the harness to discover the window from the endpoint's model list (kind-aware:
`data[].context_window` for openai-chat, `models[].context_window` for openai-responses), config declaration
winning, unknown staying blank — **chosen as the cycle-2 mechanism**, because it keeps future models honest
without editing config by hand.

**Step back.** The objective widens slightly and correctly: the dock's UI was complete, but the harness lacked
a way to learn a real window for a provider that reports one. The audit is therefore *every figure's data
path*, not only the gauge.

**Changed now (immediate fix, machine-local only).** `~/.heddle/heddle.json` declares
`contextWindow: 1048576` for `plugboard-d` and `500000` for `plugboard-x`, each with a
`$contextWindowSource` naming the provider field and date; backup kept beside the file. The main daemon was
restarted and the live page checked at `http://localhost:8082/`:
[heddle-stats-dock-context.png](_context_/dsh-mechanisms/heddle-stats-dock-context.png) shows
`13 turns 31 steps · 692K tok · Cache hit 80% · 4%` — the gauge with its ring at 4% (37,796 / 1,048,576).

**Next cycle (planned):** a kind-aware window resolver in the harness (config wins; provider model list
second; cache; failure leaves it absent), failing-first unit tests for each wire shape, a browser contract
where an endpoint declares no window but its model list reports one and the gauge appears, then the live
8082 check and the suites.

### Completeness cycle 2 — the window is discovered from the provider, not configured by hand

- **measured (cycle 1's finding, restated):** the gauge was hidden because `plugboard-d`/`plugboard-x`
  declared no window, while both providers' model lists report it (`data[].context_window` 1,048,576;
  `models[].context_window` 500,000).
- **understand / step back:** the value is the provider's own fact, so asking the provider is a mechanism the
  harness should have — a configured number would be a second, staler copy and a hardcoded table would be a
  guess.
- **brainstorm:** (a) leave it to machine configuration — kept only as the declared path, because a person who
  declares a window should not be overridden; (b) hardcode a model→window table — rejected: guesses for private
  models and stale on the next route change; (c) query the endpoint's model list, kind-aware, cache it, and
  leave the answer absent when the provider cannot answer — **chosen**; (d) fetch it in the page — rejected: the
  browser would need the provider's credentials and the signing path.
- **plan / changed:**
  - `src/llm/model-info.ts` (new): `contextWindowFromModelList(endpoint)` — openai-chat reads
    `data[].context_window`, openai-responses reads `models[].context_window`, matched to the endpoint's model;
    a 1.5s timeout, a failed or missing answer yields `undefined`, and answers are cached per endpoint+model
    (concurrent callers share one promise). Kinds with no list route (Anthropic) return `undefined` without a
    request.
  - `src/server/web.ts`: `GET /api/endpoints` now awaits that resolver for endpoints that declare no window and
    merges the result with `contextWindowSource: 'provider-models'`; `src/endpoints.ts` marks a declared window
    `contextWindowSource: 'config'`.
  - `test/model-info.test.ts` (new) and the verifier double: five unit tests (both wire shapes, an unlisted
    model, a failed request, caching, a kind with no route); `chatDouble` serves (or refuses) `/models` without
    counting it as one of a turn's completion requests.
- **verify:** the new browser contract, "the context gauge uses a window the provider reports, and stays blank
  when it reports none", was written before the wiring and failed on the missing gauge, then passed: an endpoint
  that declares nothing and whose provider reports 500,000 renders `50%`, and an endpoint whose provider reports
  nothing prints no percentage with the item hidden.
- **live, end to end:** the manual declarations were removed again to force the mechanism and the daemon
  restarted. `GET /api/endpoints` then reported `plugboard-d · deepseek-flash · 1048576 · provider-models`,
  `plugboard-x · gpt-6.1-sol · 500000 · provider-models`, `claude-opus · 1000000 · config`; at
  `http://localhost:8082/` the dock read `692K tok · Cache hit 80% · 4%`
  ([heddle-stats-dock-context-discovered.png](_context_/dsh-mechanisms/heddle-stats-dock-context-discovered.png)).
  The machine config now declares only the window Anthropic cannot report (`claude-opus`, via configuration),
  and the two plugboard routes are discovered.
- **suites at the cycle's close:** composer **13/13**, `npm run check` **0 errors**, `npm test` **331
  passing**, `npm run build` succeeded, and the full verifier sweep is **15/15** — including
  `70-workspaces-sessions` at 43 checks, which the concurrent session finished in the same window.
- **found for cycle 3:** the turns figure is counted from rendered user rows, so a page that has not finished
  drawing history can show `0 turns` beside `31 steps` (seen in the live probe). The durable `stats.turns` is
  the right source, with the live turn added — cycle 3's fix row.

### Completeness cycle 3 — the turns figure is the fold's, and the final audit

- **found (live probe, cycle 2's close):** the dock showed `0 turns` beside `31 steps` while the transcript was
  still arriving. The turns figure was counted from rendered user rows; a page whose history has not been drawn
  yet prints zero, and a page that watched only part of the session prints too few. DSH's count moves when a
  prompt is sent and never depends on painting.
- **measured / understand:** the durable `stats.turns` is the right count and arrives in the same answer as the
  transcript; the only thing it cannot know is a turn this page just sent and the fold has not recorded yet. So
  the figure is `stats.turns + liveTurns`, where `liveTurns` is incremented when this page starts a turn and
  reset whenever the durable answer is re-read — the two sources cannot double-count because the reset and the
  re-read are the same step.
- **brainstorm:** (a) render `stats.turns` alone — discarded: a just-sent turn shows nothing until the fold
  catches up; (b) keep the row count — discarded: it is the defect; (c) `stats.turns + liveTurns` — **chosen**;
  (d) re-read the session on every frame — discarded: a request per chunk for a number that changes twice a
  turn.
- **changed:** `src/server/page.html`: `liveTurns` state, reset beside `liveRounds`, incremented at the start of
  `runTurn`, and the renderer uses `(sessionStats?.turns ?? 0) + liveTurns` instead of a DOM query. The browser
  contract gained the invariant: after a reload, the dock's turns equals the backend fold's `stats.turns`
  (fetched from the page itself), and the cumulative total and context share survive the reload.
- **verify / final audit:** the contract is green; live at `http://localhost:8082/` the dock reads
  `13 turns 31 steps · 692K tok · Cache hit 80% · 4%`
  ([heddle-stats-dock-final.png](_context_/dsh-mechanisms/heddle-stats-dock-final.png)) with the turns figure
  durable from the first paint; `/api/endpoints` reports the three windows with their sources
  (`claude-opus 1000000 config`, `plugboard-d 1048576 provider-models`, `plugboard-x 500000 provider-models`);
  the service behind 8082 runs the main checkout's `dist/cli.js` (deployment asserted, not assumed).
- **all six elements, end to end:** turns and steps from `projectSessionStats` (`turn/completed.rounds`); tok/s
  from the turn's reported output over its wall duration (decode-time is a recorded divergence); cumulative
  tokens and cache share from the four usage buckets; the context gauge from `lastPromptTokens` over a window
  that is declared or provider-discovered, and blank where neither exists. No figure is estimated.
- **stop:** the full measurement now produces no fix row beyond the recorded divergences (the dialogs, the
  decode-time rate, the wall-time blank after a reload). The loop stops here with that evidence.

## tok/s durability loop — cycle 1: the rate lives only in the page's memory

**The report.** The composer footer has no `tok/s`. Measured on the live page: after a reload the rate cell
is empty (`tokens: ''`) while turns, steps, total, cache share and context share all render.

**The reference, measured.** DSH's dock at `127.0.0.1:8080` printed `44 turns 2654 steps · 253 tok/s`; after a
**reload** it printed `44 turns 2655 steps · 253 tok/s` — the rate survives because it is a projection of the
session's own log. Its bundle states the same fold this session's `dsh-session-stats` projection uses: per
round, `decodeMs += messageTime − firstTokenTime` and `decodeTokens += usage.outputTokens`, and the pill divides
one by the other. The conditions are exact: the round must have streamed a first token **and** reported output
tokens; otherwise neither end is counted.

**Why heddle is blank.** The page derives the rate from `lastTurnUsage / lastTurnSeconds`, both page state set
only when the page itself sent the turn and both reset on `showSession`. A reload has neither, so the phrase
disappears — a missing **mechanism**, not a missing value: nothing in the folded stats carries decode timing.

**The data is in the log (measured).** A real session's `session.jsonl` carries `model/request` and
`assistant/chunk` events with `at` timestamps, and providers' done frames carry `usage.outputTokens` (samples
found in two sessions, e.g. `{"inputTokens": 2134, "outputTokens": 1}` and a tool round with
`outputTokens: 230`). So first-token → done gaps and reported tokens are both derivable from the durable record.

**Brainstorm:** (a) keep the page's turn memory and also store it in `localStorage` — rejected: a second,
non-durable copy that disagrees across windows; (b) approximate the rate from the turn's wall time — rejected:
that is the current approximation, and it is exactly what cannot survive a reload; (c) fold
`decodeMs`/`decodeTokens` per round from the event log and let the page divide — **chosen**, matching DSH's
formula and conditions; (d) ask providers for decode time — no provider reports it on these routes; (e) reuse
the ledger's per-record `durationMs − ttftMs` — considered, but the stats fold is the natural home and the
ledger's record shape is for display, not for the projection; the ledger is the instrument that proved the
timestamps exist.

**Step back.** The objective holds and narrows usefully: no provider change, no new event — the projection
gained a fold and the page will divide what it already receives. The landing rule applies: the rate must be
visible on the deployed page, not only in a scripted check.

### tok/s loop — cycle 2: the durable rate, and the denominator step back

- **understand:** the reference folds `decodeMs` from **first streamed token to the closing message** and
  divides the reported output tokens by it. Implemented literally, heddle printed `38,702 tok/s` on a live
  session — because these providers buffer an answer and flush it in a burst. Measured in the session's own
  log: a round opened at `03:44:08.855`, the first delta arrived at `03:44:11.415` (2.56s later), and the
  tool-call and done frames followed within `10–40ms`. The DSH formula, applied to that record, measures the
  socket, not the generation.
- **step back (re-cut):** the denominator this harness can honestly provide is the **round's whole span**,
  request → done: the time the harness actually waited for those tokens. The rate becomes
  `decodeTokens / generationMs`, still only from rounds that reported output tokens, and still blank
  otherwise. The divergence from DSH's decode-only denominator is recorded here, with its measurement, rather
  than hidden in a heuristic.
- **changed:** `src/server/ledger.ts` — the stats fold now sums `generationMs` (round span) beside
  `decodeTokens`; `src/server/page.html` — the dock divides the durable fold plus the live round (the live
  clock opens on `model/request` and closes on the done frame with its tokens), and the old
  `lastTurnUsage`/`lastTurnSeconds` rate path is gone; `_verifiers_/80-web-ui/check-composer.mjs` — the dock
  contract demands the rate **after a reload** and requires it to equal the backend fold's own
  `decodeTokens / generationMs` formatted by the reference's rule.
- **verify:** the contract failed before the wiring (`actual ''` against `'971 tok/s'`) and passes after; the
  live page at `http://localhost:8082/` now prints `2 turns 12 steps · 123 tok/s · 154K tok · Cache hit 85% ·
  2%` after a reload — a number in the reference's order of magnitude, from observed timestamps and tokens.
  The rate is the ring's sibling, not a page memory.

### tok/s loop — cycle 3: final audit and landing

- **audit:** every figure's data path was re-checked after the change — turns/steps from the fold, rate from
  `decodeTokens / generationMs`, total and cache share from the four usage buckets, context from
  `lastPromptTokens` over a declared or discovered window. The rate's blank cases were re-measured: a round
  with no reported tokens contributes to neither half, and a provider that reports nothing leaves the phrase
  empty (asserted in the contract's bare-server case).
- **landing:** the change was committed to `main` and pushed (`2e9e7dc`), and landed the way the committed
  convention now requires: the **deployment checkout** `/Users/zhenc/heddle-deploy` — a clone that contains only
  committed `main` — was fast-forwarded to that commit, built, and the launchd agent repointed to run its
  `dist/cli.js` (the shared working checkout is never the deployment; another session's deploy work had already
  moved the agent there, which `96-deployment` caught while this loop was still on the shared tree).
  `_verifiers_/96-deployment` now passes **3/3**: the service runs the deployment checkout's cli, the page at
  8082 is that build byte for byte, and the checkout is clean `main` at its tip. Live at
  `http://localhost:8082/` the dock reads `7 turns 17 steps · 111 tok/s · 269K tok · Cache hit 75% · 2%`
  after a reload.
- **stop:** the full measurement yields no further fix row; the remaining difference (DSH's decode-only
  denominator) is recorded above with the measurement that forced the re-cut.

## Footer-dialog loop — cycle 1: the three surfaces measured

**The report.** Every element of DSH's dock opens a detail surface; heddle's three elements are inert.

**Measured, live at `127.0.0.1:8080`** (one session, three clicks):

| Trigger | Surface | Content measured | Box / style |
|---|---|---|---|
| time pill | **Session statistics** | `LLM time 210m27s` · `Tool time 665m53s` · `Avg time to first token (TTFT) 2.3s` · `Tokens per second (TPS) 252 tok/s` | 300×159, `rgba(67,69,74,.45)`, radius 16, padding 16, `12px/18px`, #cfd3d6, hairline ring + soft shadow |
| usage pill | **Token usage** | title carries the exact total (`1,079,960,760 tok`); rows `Cache hit 99.6%` · `Uncached input 4,325,662 tok` · `Cached input 1,074,084,608 tok` · `Output 1,550,490 tok` | same 300×159 surface |
| context gauge | context panel | `61%` · `of context used` · `~612K / 1M` · `System prompt ~2K` · `Tool definitions ~10.3K` · `Messages ~516K` | 264×142, padding 12, `12px/20px`; the summary is a segmented bar above the rows |

Rows are the reference's own formulas: LLM time = per-step request→message; tool time = dispatch→result;
average TTFT = ttftMs / ttftSteps; TPS = decodeTokens / decodeMs; the usage rows are the exact buckets; the
context panel is the pressure projection's used/window plus a three-segment breakdown.

**Heddle today.** The dock's elements are spans, not buttons; no popover/dialog primitive exists in the page;
`projectSessionStats` carries turns, steps, usage buckets, last prompt size and generation spans, but **not**
LLM/tool time or TTFT; the usage buckets and exact totals are available; the context breakdown is **not** in
the API (the page only receives the last prompt size and the window). So the work is one shared detail surface
plus two new folds (llm/tool/TTFT) and, where a breakdown is unavailable, honest blanks.

**Brainstorm:** (a) one dialog primitive + three content renderers — **chosen** (the reference uses one panel
style for all three); (b) three bespoke inline panels — rejected: three placements and three close behaviours to
drift; (c) `<dialog>` element with the native modal — rejected for now: the reference is a non-modal popover
that closes on a second click/outside and must not trap focus; (d) port DSH's exact backdrop blur/tints —
deferred to the cycle that measures them precisely. Backend: fold `llmMs` (round request→done), `toolMs`
(call→result) and `ttftMs`/`ttftSteps` (request→first token) in the same pass that folds usage; expose the
context breakdown only if the context service has one, otherwise omit those rows rather than invent them.

**Plan (next cycles):** extend `projectSessionStats` with the three timing folds + unit tests; add the shared
popover to the page with the measured content for all three triggers, closing on outside/trigger click and
Escape; add a browser contract that clicks each element, asserts every row and its formatting (durations, exact
token grouping, percentages) and that it closes; live-check at 8082; then land on main via the deployment
checkout and run `96-deployment`.

**Stop note:** this cycle is measurement and planning only — the implementation cycles follow.

### Footer-dialog loop — cycle 2, backend half: the three timing folds

`projectSessionStats` now folds what the reference's "Session statistics" surface prints, from event pairs that
actually measured it: `llmMs` (round request → done), `toolMs` (tool call → its result, matched by call id; an
unmatched result contributes nothing), and `ttftMs`/`ttftSteps` (round request → its first streamed chunk,
counted once per round). Each field is absent until at least one pair exists — a row with a missing end is not
invented. The failing-first tests failed on `undefined` against the expected totals and then pinned the doubles:
LLM 500+600ms, TTFT 100+250ms over two steps, tool 600ms, and an unmatched result that must not move the total;
a log with only a request keeps every row absent. The usage dialog's rows need no new fold — the four buckets are
already in the stats — and the context panel's breakdown is still not exposed by the context service, so those
rows will be omitted rather than guessed. The shared popover and its three content renderers are the frontend
half of this cycle.

### Footer-dialog loop — cycle 2/3: the shared popover and its three surfaces

- **changed:** `src/server/page.html` gained one fixed popover and three content renderers, in the reference's
  measured surface (`rgba(67,69,74,.45)`, radius 16, padding 16, `12px/18px`, hairline ring + soft shadow):
  the time pill prints LLM time, tool time, average TTFT (ttftMs/ttftSteps) and TPS (decodeTokens/generationMs);
  the usage pill prints the exact total on its title and the four exact buckets, with the reference's rounded
  cache share; the context panel prints the percent, "of context used", and `~used / window` — its three
  breakdown rows are absent because the context service does not expose a breakdown, and a row whose fact was
  not observed is omitted. Triggers are buttons (`role`, `tabindex`, `aria-haspopup`, `aria-expanded`) that
  toggle on click/Enter/Space; the surface closes on a second click, outside pressure or Escape, and re-renders
  while open as the figures move.
- **verify:** the new browser contract clicks each of the three elements and asserts the surface's text: LLM
  time and TPS present with the reference's formats, **Tool time absent** (no tool call was observed in that
  session), the usage title carrying the exact `620 tok`, `Cache hit 67%`, the exact buckets, the context panel's
  `30%` + `~600 / 2K`, `aria-expanded` on the trigger, closing on a second click and on Escape. The composer
  suite is 14/14 green; `npm test` 395 passing.
- **landing / live:** committed to main, the deployment checkout fast-forwarded and rebuilt, the launchd agent
  serving it, and `96-deployment` green (process, byte-identical page, clean committed main); the surfaces were
  opened on the live page at 8082.
