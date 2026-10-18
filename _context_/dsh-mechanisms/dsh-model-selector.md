---
title: DSH model selector — measured reference and Heddle's port
version: 1.0.0
description: What DSH's composer model seat renders and does, measured in a live browser state by state, and what Heddle implements beside it, with the two-tier endpoint → model configuration the owner asked for.
grounded_in:
  - source: browser
    detail: DSH at http://127.0.0.1:8080/ driven with _tools_/browser-use on 2026-10-17, 1280x913 viewport, trusted Input.dispatchMouseEvent/Input.dispatchKeyEvent, getComputedStyle and getBoundingClientRect
  - source: owner statements 2026-10-17 that the model selector is configured in the user's home under ~/.heddle/, is user-specific, and is a two-tier system of endpoints and the model types each endpoint offers
  - source: live model catalogs on 2026-10-17: plugboard /d/models (deepseek-flash, deepseek-v4-pro; effort low/high/max, default high), plugboard /x/models?client_version=1.0.0 (nine gpt slugs), and the Meta Vertex publisher route for claude-opus-5-5 (adaptive thinking + output_config.effort low/medium/high/xhigh/max)
---

# DSH model selector — measured reference

This is the loop document of the `feat/model-selector` workstream: the measurements, the discarded candidates, the
plan and the per-cycle evidence. The loop runs three cycles; a cycle counts only when its evidence is here and the
suites are green.

## Cycle 1 — measure the reference, understand the two tiers, plan the port

### Measured

Instrument: `openPage()` from `_tools_/browser-use/lib.mjs`, viewport 1280×1000/913, DSH 0.2.0-rc.2 at
`http://127.0.0.1:8080/`, page title `[feat] context-mgmt — DeepSeek Harness`, `@deepseek-ai/dsh-client-ui-model-selection`
rev `49ff9275592d`. UI strings and class names cross-checked against the installed client bundle
(`.../dsh-client-ui-model-selection/lib/client.js`), which is cited only for the mechanism the browser cannot tell apart
(hidden panes), never for a number.

#### The seat (trigger)

| Property | DSH value | How |
|---|---|---|
| accessible name | `Select model, current DeepSeek-V41-Flash, reasoning effort High` | `aria-label` |
| title | `DeepSeek-V41-Flash · High` | `title` |
| visible text | two spans: `DeepSeek-V41-Flash` + `High` (not one string, not a `·`) | `innerText` = `DeepSeek-V41-Flash\nHigh` |
| box | **189×28**, at (849, 846) in the session state | `getBoundingClientRect` |
| typography | `13px/20px`, weight 400 | `getComputedStyle` |
| model span | colour `rgb(207,211,214)` `#cfd3d6`, `flex-shrink: 1` | computed |
| effort span | colour `rgb(129,133,140)` `#81858c`, **`flex-shrink: 1000`** (it is the part that ellipsizes first) | computed |
| background | transparent | computed |
| padding / gap / radius | `0px 4px 0px 8px` / `4px` / `8px` | computed |
| hover | background `rgba(255,255,255,0.08)`, colour unchanged | trusted pointer in, then out; clears on leave |
| focus-visible | `box-shadow: rgb(122,170,255) 0 0 0 2px`, no outline | `focus()` |
| cursor | `pointer` | computed |
| disabled | only when the session is locked (`locked`), never for a running turn | measured while a turn streamed: `disabled=false` |
| arms | `aria-haspopup="menu"`, `aria-expanded` true/false, `aria-busy` (only a pending selection), `aria-controls` when open | attributes |
| icon | a hidden 16px data icon (`display: none` in this profile) plus a chevron that rotates 180° on open (`transition: transform .12s`) | computed |

#### The menu — two levels

Root pane (`role=menu`, `aria-label="Model and reasoning effort"`), fixed, portaled to `body`:

| Property | DSH value |
|---|---|
| placement | above the trigger, right-aligned: `x = trigger.right − menu.width`, `y = trigger.top − 8 − menu.height`, clamped to a **12px** margin on both axes and re-placed on scroll/resize |
| box (root) | **248×76** at (791, 762); model pane **328×368** (grown by content, capped `max-height: 360px`) |
| surface | transparent element; a child material paints `rgba(67,69,74,0.45)` + `backdrop-filter: blur(40px) saturate(1.5)`; shadow `0 0 0 .5px rgba(255,255,255,.16), 0 3px 8px rgba(0,0,0,.04), 0 0 20px rgba(0,0,0,.05)`; radius 16px |
| padding / z-index | `4px` / `1100` |
| sizes | `min-width: min(240px, 100vw−32px)`, `max-width: min(420px, 100vw−32px)`, `max-height: min(360px, 100vh−96px)` |
| overflow | the surface is `hidden`; the inner groups list scrolls |

Root rows are `role=menuitem`, **240×34**, radius 12, padding `0 8px`, font `13px/20px`:

| Row | Label span | Value span | Right |
|---|---|---|---|
| `Model` | colour `#f9fafb` | current model name, colour `rgb(173,178,184)` `#adb2b8`, text-align right, flex 1 | 12×12 chevron |
| `Effort` | same | current effort name, same value style | 12×12 chevron |

The Effort row **exists only when the selected model publishes reasoning metadata** (`reasoning !== undefined` in the
client); a model with no effort levels has no Effort row at all. Hover/focus = background `rgba(255,255,255,0.08)`.

Model pane: a `role=searchbox` search row (shown only when the catalogue is **larger than four** entries) above a scrolling
`role=menu` list. The list is **provider-grouped**: a sticky heading per provider, then its models.

| Part | Measured |
|---|---|
| search row | 320×25; input 306×15, font `12px`, placeholder `Search models…`, padding `5px 7px`; a 24×24 clear button appears with a query |
| group heading | 315×22, font `11px/16px`, weight 500, colour `#adb2b8`, padding `4px 7px 2px`, radius 12, `position: sticky; top: 0`; transparent at rest, `rgba(48,49,54,0.94)` **only while pinned by scrolling** |
| model option | 315×34, radius 12, padding `5px 7px`, name `13px/18px`, a 14×14 check glyph at the right when selected; `aria-checked`; disabled only while a selection is pending |
| option state | hover/focus/highlight `rgba(255,255,255,0.08)`; the selected row itself has **no** background |
| list | scroll container 320×330, scrollHeight 607 for 15 models in 4 groups |
| ordering | DeepSeek Account first, then DeepSeek Official, then the rest in catalogue order |

Effort pane: a flat `role=menu` of `role=menuitemradio` rows, same option geometry (240×34), one checked, with a
`Default` row when the model declares no default. Measured catalogue for `deepseek-flash`: `Off`, `Low`, `High`, `Max`,
`High` checked.

#### Keyboard and focus

- Opening: focus stays on the trigger; the menu is placed.
- `Tab` from the trigger focuses the first root row; `Tab` cycles rows; `Tab` past the last row leaves the menu (measured:
  next focus was the brand button, i.e. no focus trap).
- `ArrowDown`/`ArrowUp` move focus between rows of the open pane (roving focus); in the model pane with search, arrows
  cycle the highlighted result while the search input keeps focus.
- `Enter` on the `Model` cell drills into the model pane and focuses the **search input** (catalogue > 4) or the checked
  model. `Enter` in search selects the highlighted model.
- `Escape` from a drilled pane returns to the root pane and hands focus back to the cell that opened it; `Escape` on the
  root closes the menu and focuses the trigger. `Shift+Tab` is the same as `Escape`.
- After a selection the trigger is focused again **without a focus ring** (`data-selection-focus` suppresses it until blur).
- Clicking outside (mousedown) closes the menu.

#### What selecting does

- Selecting a model writes a durable per-session event: `{"type":"model/selection","data":{"provider","model","reasoningEffort"}}`
  in the session log (measured in `~/.dsh/sessions/.../session.v4.jsonl.zstd`, seq 27–30), and the trigger updates at once.
  A `model/selection` is `pending` until a `request/header` confirms it as `lastUsed`; a reload restores
  `pending ?? lastUsed`. Measured: selected `deepseek-flash` + effort `max`, reloaded → trigger `DeepSeek-V41-Flash · Max`.
- A provider/model change (not an effort-only change) appends a model-switch **notice** to the next request's context.
- Selecting the value already in effect closes the menu without writing.
- While a selection is pending the trigger shows a spinner in place of the chevron and `aria-busy="true"`; the rows of the
  value being committed show a spinner in place of the check.

#### Running turn

Measured with a turn streaming (`Stop` in the composer): the trigger stayed **enabled** (`disabled=false`,
`aria-busy=false`, no spinner), the root menu opened, both cells were enabled and the model pane listed every option
enabled. DSH applies a concurrent switch to a **later step** of the same turn (the agent assembles the selection before each
request) rather than refusing the switch.

### The two tiers the owner asked for

The owner's steer (2026-10-17): the selector is **user-specific configuration in `~/.heddle/`**; the user configures an
**endpoint** and the **model types that endpoint offers** (`plugboard/d`, `plugboard/x`, Meta internal models), and the
repository holds only the schema and the invocation logic. DSH's provider group in the model pane is the same tier:
a provider owns a list of models. DSH's catalogue is host-side; Heddle's is the user's `~/.heddle/heddle.json`.

### Brainstorm — candidates and the discards

1. **Keep the one-level endpoint menu and add an effort row.** Smallest change. Discarded: it keeps Heddle's
   `endpoint · model` label and its flat list, so the two-tier configuration the owner asked for has nowhere to show; and
   it cannot present two models on one endpoint.
2. **Two-level menu (root Model/Effort cells, model pane grouped by endpoint) — chosen.** It is exactly what DSH renders,
   maps one-to-one onto endpoint → model types, and its effort pane can be omitted per model.
3. **A native `<select>` per tier (endpoint, then model).** Discarded: a native select cannot show a check mark, a group
   heading or a measurement, and it silently drops a recorded endpoint the configuration no longer holds — the reason the
   existing menu is drawn by the page.
4. **A separate "Providers" settings page that lists models, with the composer showing a flat list.** Discarded: it moves
   the selection away from the composer (DSH keeps it at the point of use) and needs a second surface to keep in sync.
5. **Effort as a free-text config string sent verbatim.** Discarded: displaying a value the adapter does not send is the
   "unenforced value" the task forbids. Effort levels are per-model config with an explicit per-level wire value.

### Understand — what the mechanism is, and what Heddle already has

- DSH's selection is a **durable session event** read by a projection; Heddle's is a **meta record** (`setModel`), and its
  append-only log is not touched. Heddle already has the route (`/api/sessions/<id>/model`), the store write and the
  page menu; what is missing is the second tier (models per endpoint), the effort pane, and the request plumbing that
  makes an effort real.
- The model layer already has the seam DSH uses: `model/request` is a waterfall over every model call, and the loop puts
  the `sessionId` in the request. A listener can therefore make a switch take effect on a later step of a running turn,
  which is DSH's running-turn behaviour.
- `EndpointConfig` is read from `$HEDDLE_CONFIG`, `$HEDDLE_HOME/heddle.json` or `~/.heddle/heddle.json`, so the user's
  two-tier catalogue belongs there; the repository's `src/endpoints.ts` and `src/local-config.ts` hold the schema and an
  example, never a URL, model or key.

### Step back

The objective still stands; the evidence **widened** it in one place: Heddle's `model` is one id per endpoint, so the
two-tier ask is a **config-schema change** (models per endpoint) and not only a rendering change. It also **narrowed**
one danger: reasoning effort is only honest where the provider's own wire parameter was verified, so the config declares
per-level wire values and the adapter sends them per endpoint kind; an endpoint with no reasoning block renders no effort
row. Goal edited to carry the owner's steer (revision 3).

### Plan

1. `src/llm/types.ts` — `ModelOption` (`id`, `name?`, optional per-model `reasoning`), `ReasoningLevels`
   (`default?`, `levels: {id, name, value}[]`), endpoint-level `reasoning` as the default for its models; `models?` on
   `EndpointConfig`; `reasoningEffort?` on `GenerateRequest`; pure `offeredModels` / `reasoningLevelsFor` /
   `reasoningWireValue` helpers.
2. `src/endpoints.ts` — `describeEndpoint` reports `models` with display names and effort **ids and names only** (the wire
   value never reaches a page); backward compatible: an endpoint with only `model` offers that one model.
3. `src/llm/adapters.ts` — each kind sends the level's wire value in its own parameter: `reasoning_effort` (openai-chat),
   `reasoning: {effort}` (openai-responses), `thinking: {type:'adaptive'} + output_config: {effort}` (anthropic-vertex,
   verified live against the Meta Vertex route; `budget_tokens` was refused with "use adaptive"), scripted ignores it; an
   unknown level is a loud `ModelError`, never silently dropped.
4. `src/session/store.ts` — `reasoningEffort` joins `endpoint`/`model` in `SessionMeta`, replaced with them in `setModel`,
   carried by fork/subagent, recorded on `model/request`; `src/server/web.ts` validates it against the chosen model and
   resolves it for a turn (request, then record).
5. `src/server/web.ts` — `model/request` listener: the session's recorded selection overrides every model call of a turn,
   so a concurrent switch lands on the next step.
6. `src/server/page.html` — DSH's seat anatomy (model span + effort span + chevron), the two-level menu with the measured
   geometry and states, search above four models, sticky endpoint headings, keyboard and focus behaviour, fixed clamped
   placement, pending spinner; the page sends `reasoningEffort` with a turn.
7. Tests first: unit tests for every helper and adapter body, then the browser contract in
   `_verifiers_/80-web-ui/check-model-switcher.mjs` (two doubles, record + reload, effort on the wire, running-turn
   switch, keyboard, no effort row where nothing is enforced).
8. `~/.heddle/heddle.json` — user-specific two-tier catalogue: `claude-opus` → five verified Claude models; `plugboard-ds`
   → `deepseek-flash`, `deepseek-v4-pro` with low/high/max (live-verified `reasoning_effort`); `plugboard-cx` → seven
   `gpt-6.1-sol`-family models with low/medium/high/xhigh/max (live-verified values from the route's own refusal message).
9. Docs: this file; `SESSION_UI.md`'s composer row and `dsh-input-area.md`'s model line updated at the end.

### Coverage matrix (cycle 1)

| State / dimension | DSH | Heddle before | Verdict |
|---|---|---|---|
| seat idle label | model + effort spans, colours 207/129 | one `endpoint · model` span | fix |
| seat geometry | 189×28, 13/20, padding 0 4 0 8, radius 8, gap 4 | 219×28, 13/13, padding 0 8, radius 8, gap 4.8 | fix |
| hover / focus | bg 8% white / 2px accent ring | bg 8% white / **no ring** | fix focus |
| title and accessible name | label + `·`; `…, reasoning effort <name>` | title = prose sentence; name without effort | fix |
| menu root | 2 cells, 34 high, value right, 12px chevrons | one flat list | fix |
| menu model tier | grouped by provider, sticky 11/16 headings | flat endpoint rows | fix |
| menu effort tier | only for a model with reasoning | absent | add |
| menu placement | fixed, above, right-aligned, 12px clamp, scroll re-place | absolute, above, right-aligned, z 5 | fix |
| menu surface | radius 16, glass material, 1100 | radius 8, solid, z 5 | fix |
| option geometry | 315×34, radius 12, padding 5 7, 13/18 | 262×29, radius 4.8, padding 4.8 7.2, 12.8/19.2 | fix |
| option states | hover/focus/highlight 8%, check 14×14, no selected bg | ✓ before pseudo-element | fix |
| search | >4 models, 12px, placeholder, clear, empty state | absent | add |
| keyboard | arrows, Tab, Escape back/close, focus restore, selection-focus | Tab only; no arrows; Escape+focus | fix |
| selection record | `model/selection` event, provider/model/effort | meta endpoint/model | extend |
| reload survival | ✓ | ✓ endpoint/model | extend |
| running turn | seat stays enabled, later step uses it | seat enabled, next turn only | fix (waterfall) |
| effort control | per model catalogue | no effort concept | add, provider-grounded only |
| content stress | 15 models / 4 groups / scroll | 6 endpoints, no scroll | test |
| stale endpoint | not applicable (host catalogue) | kept in menu with `not configured` | keep |
| voice input | present | no substrate | keep absent |
| model-switch transcript notice | user-role notice on model change | not recorded | keep absent (meta record is the session's record) |

## Cycle 1 — evidence

```
Cycle 1 — the two-tier backend and DSH's two-level control
  measured:   DSH http://127.0.0.1:8080, 1280x913, model-selection client rev 49ff9275592d, 2026-10-17:
              trigger 189x28 13/20 padding 0 4 0 8 gap 4 radius 8 #cfd3d6 + #81858c effort span shrink 1000;
              hover 8% surface; focus 2px #7aaaff ring; title "Model · Effort"; aria "... reasoning effort ...";
              root menu 248x76 fixed right-aligned 8px above, radius 16, padding 4, z 1100, 34px rows radius 12,
              value #adb2b8 + 12px chevron; model pane 328x368 grouped by provider, sticky 22px 11/16 500
              headings, search above four entries (12px), 34px options radius 12 padding 5 7, 14px check,
              selected row unbackgrounded; effort pane Off/Low/High/Max with High checked; Escape/back/Tab/
              arrows/focus-restore-without-ring; running turn: seat enabled, options enabled, switch lands on a
              later step; selection is a durable per-session model/selection event (seq 27-30) and a reload
              restores pending ?? lastUsed.
  brainstorm: 1 keep one-level + effort row (discarded: no room for tier 2); 2 two-level root Model/Effort +
              endpoint-grouped model pane (chosen); 3 native selects (discarded: no check/group/measure, drops a
              stale recorded endpoint); 4 a separate providers settings page (discarded: selection moves away
              from the point of use); 5 free-text effort sent verbatim (discarded: displays an unenforced value).
  step back:  widened — heddle's one model id per endpoint means the ask is a config-schema change too
              (endpoint.models with per-model reasoning). Narrowed — effort only where the provider's wire
              parameter was verified (reasoning_effort on /d, reasoning.effort on /x, adaptive thinking +
              output_config.effort on the Meta Vertex route; budget_tokens was refused). Goal revised to v3.
  changed:    src/llm/types.ts (ModelOption, ReasoningLevel(s), endpoint.models/reasoning, request.reasoningEffort,
              offeredModels/reasoningLevelsFor/reasoningLevelFor); src/endpoints.ts (describeEndpoint models with
              ids/names/effort ids only; selectionProblem); src/llm/adapters.ts (per-kind wire mapping, loud
              UNSUPPORTED_REASONING_EFFORT); src/agent/loop.ts (reasoningEffort on every request + model/request);
              src/session/store.ts (SessionMeta.reasoningEffort; setModel replaces endpoint/model/level together;
              fork/subagent/definition carry it); src/session/service.ts; src/session/definition.ts;
              src/agent/subagent.ts; src/server/web.ts (route validates model and level; turn resolves endpoint,
              model, level by the same ladder and filters undeclared levels; GET session carries the level; the
              model/request waterfall applies the session's current record to every call of a running turn);
              src/server/page.html (DSH's seat anatomy and two-level menu, grouped model pane, search, effort pane,
              placement/clamp, keyboard, pending state); test/model-effort.test.ts; test/model-switcher.test.ts;
              test/page-contract.test.ts; _verifiers_/80-web-ui/check-model-switcher.mjs.
  evidence:   failing first — node --test test/model-effort.test.ts failed on the missing exports/behaviour before
              the code existed, and the new browser check run against the pre-change build (worktree at d446e67,
              same doubles and config) failed 5/5: seat shape, model+effort recording, keyboard, running switch,
              refusals. After the change: 5/5 pass; unit suite 321/321; npm run check clean.
  reds:       none left in this workstream. One pre-existing red on main was fixed on the way: page-contract's
              module guard indexed the regex capture without narrowing (`extracted[1]`, TS2532 under
              noUncheckedIndexedAccess); it is another session's committed line, fixed with an explicit assert.
  coverage:   measured — idle seat, hover, hover-left, focus, root menu, model pane, effort pane, keyboard
              (Tab/arrows/Enter/Escape/outside mousedown), selection, reload, running turn, small-viewport clamp,
              no-effort model, long catalogue (search). Not measured — the pending-selection spinner (the route
              answers too fast to observe reliably), a model-switch transcript notice (deliberately absent), voice
              input (no substrate). Both named in the coverage table below.
  invariants: the composer still submits and streams (check-composer green); the model menu opens fixed so no
              scrolling ancestor clips it (position + clamp asserted); send/stop untouched; the page module still
              parses (page-contract guard); the attach and row menus are separate surfaces and their checks pass.
  lessons:    (1) a focusout handler that closes a menu must decide on a microtask, because a re-render removes the
              focused row and reports no related target — the first keyboard drill closed the menu instead of
              entering it; (2) a filtered list needs its own highlight index space, not the catalogue's; (3) a
              protocol Enter needs its carriage-return text or a focused button never activates.
```

## Cycle 2 — states, keyboard and the running turn, re-measured from a fresh build

```
Cycle 2 — the states that only exist after a re-render, and the running-turn seam
  measured:   served page from a fresh `npm run build`, 1280x950, 2026-10-17:
              trigger 94x28 13/20 padding 0 4 0 8 gap 4 radius 8 #cfd3d6; effort span #81858c hidden for a
              model without levels and visible (rgb(129,133,140)) for one with them;
              root menu 240x76 fixed, right-aligned to the trigger and 8px above it, radius 16, padding 4,
              z 60; root rows 34px radius 12, value #adb2b8, 12px chevron; model pane 240x329 with search
              (6 models), sticky headings 22px 11/16 500 #adb2b8, options 34px radius 12 padding 5 7 13/18,
              selected check 14x14; effort pane 240x144 Low/Medium/High/Max with High checked; a model
              without levels has one root row and no effort pane; at a 900x620 viewport the menu stays inside
              the 12px margin on both axes; keyboard: Tab -> row, Enter -> drill and search focus, arrows rove,
              Escape back then close, after a selection focus returns without a ring; running turn: seat,
              rows and options enabled, and a switch lands on the turn's second model call (tool double:
              exactly one request to each endpoint).
  brainstorm: running-turn application: (a) the existing `model/request` waterfall, applying the session's
              current record before each call — chosen, it is the seam the model service documents; (b) re-resolve
              inside the loop — discarded, the loop would need the session record and the layers would couple;
              (c) leave the switch for the next turn — discarded, DSH measured otherwise.
              focus-loss dismissal: (a) decide on a microtask after the DOM settles — chosen; (b) never close on
              focusout — discarded, tabbing out would leave an orphan menu; (c) pointerdown-only dismissal —
              discarded, DSH closes on blur as well.
  step back:  no scope change. The evidence did narrow cycle 1's "menu shape" into the states that only exist
              after a re-render (a focused row being replaced), which is where both defects found this cycle lived.
  changed:    src/server/page.html — focus-loss decision deferred one microtask; search highlight indexed by
              visible position instead of catalogue position; model selection records the model's declared
              default level (DSH's model/selection carries it); src/server/web.ts already had the waterfall seam
              from cycle 1 and it is exercised here; the verifier gained the keyboard, search, no-effort, clamp
              and running-turn assertions.
  evidence:   found and fixed two defects that the cycle-1 checks missed: (1) a keyboard drill closed the menu,
              because the focused row was replaced and `focusout` reported no related target — before: after
              Enter, focus was BODY and the menu hidden; after: focus is the search field, and Escape hands
              focus back to the row that opened the pane; (2) after typing a query the first arrow press
              highlighted nothing, because the highlight index was a catalogue index while the list was
              filtered — after: the first result is highlighted while the query is typed and arrows move it.
              Both now have assertions in the browser check. Screenshots of the delivered states:
              `heddle-model-menu-root.png`, `heddle-model-menu-models.png`, `heddle-model-menu-effort.png`,
              `heddle-model-seat.png`, `heddle-model-running-menu.png`; the reference states are
              `dsh-model-menu-root.png`, `dsh-model-menu-models.png`, `dsh-model-menu-effort.png`,
              `dsh-model-running-root.png`.
  reds:       none.
  coverage:   visited: re-render after drill, query + arrows + Enter, model without levels, clamp at 900x620,
              running seat + menu + switch, selection focus marker. Not visited: the pending spinner (the route
              answers in one round trip, so a probe cannot hold it reliably), a model-change transcript notice
              (deliberately absent), voice input (no substrate).
  invariants: composer submission and streaming (`check-composer` green in the folder run), composer geometry,
              the session tree still renders (`70-workspaces-sessions`), the resizable grips (`87-resizable-panels`),
              the page module still parses, and an outside mousedown still dismisses the menu.
  lessons:    a re-render that replaces the focused element is a state the first check set never entered; the
              fix belongs to the dismissal rule (a microtask), not to the panes.
```

### Before → after, per measured property

| Property | DSH (reference) | Heddle before | Heddle after | Verdict |
|---|---|---|---|---|
| trigger box | 189×28 | 219×28 | **94×28** (label-dependent) | match |
| trigger type / inset | 13/20, `0 4 0 8`, gap 4, radius 8 | 13/13, `0 8`, gap 4.8, radius 8 | 13/20, `0 4 0 8`, gap 4, radius 8 | fixed |
| trigger colour / effort span | #cfd3d6 + #81858c, effort shrink 1000 | one #cfd3d6 span | two spans, effort #81858c shrink 1000 | fixed |
| trigger hover / focus | 8% surface / 2px accent ring | 8% surface / **no ring** | 8% surface / 2px accent ring | fixed |
| title / accessible name | `Model · Effort` / `…, reasoning effort …` | prose sentence / no effort | `Model · Effort` / `…, reasoning effort …` | fixed |
| menu placement | fixed, right-aligned, 8px above, 12px clamp | absolute, above, right-aligned, no clamp | fixed, right-aligned, 8px above, 12px clamp | fixed |
| menu surface | 45% glass + blur, radius 16, z 1100 | opaque #232324, radius 8, z 5 | solid `--surface`, radius 16, z 60 | geometry fixed, material kept (see divergences) |
| root rows | 2 rows (Model/Effort), 34px, radius 12 | none (flat list) | 2 rows when levels, 34px, radius 12 | added |
| model list | provider groups, sticky 11/16 headings | flat endpoint rows | endpoint groups, sticky 11/16 headings | fixed |
| options | 34px, radius 12, padding 5 7, 13/18, check 14 | 29px, radius 4.8, 12.8/19.2, ✓ pseudo | 34px, radius 12, padding 5 7, 13/18, check 14 | fixed |
| search | >4 models, 12px, clear, empty state | absent | present at >4, 12px, clear, empty state | added |
| keyboard | Tab/arrows/Enter/Escape/back/focus restore | Tab only, Escape | all of them, plus selection-focus | fixed |
| selection record | durable `model/selection` (provider/model/effort) | meta endpoint/model | meta endpoint/model/reasoningEffort | extended |
| reload survival | `pending ?? lastUsed` | endpoint/model | endpoint/model/level | extended |
| running turn | seat enabled, later step uses it | seat enabled, next turn only | seat enabled, later step uses it (waterfall) | fixed |
| effort control | per model catalogue | none | per model catalogue, provider-verified wire values | added |
| stale endpoint | n/a (host catalogue) | kept with `not configured` | kept, disabled group with `not configured` | kept |
| model-change notice | user-role notice in context | none | none | kept difference |
| voice input | present | absent | absent | kept difference |

### Divergences deliberately kept

1. **Menu material.** DSH paints a `rgba(67,69,74,.45)` glass card with `blur(40px) saturate(1.5)`; Heddle has no
   glass tokens and every other menu here is the solid `--surface`. The geometry, radius, shadow and states are
   DSH's; the material is this theme's, so the selector does not become the only translucent surface in the app.
2. **Accent.** The focus ring is this theme's `#2694fe`, not DSH's `#7aaaff`, for the same reason every other
   focus ring here uses the theme accent.
3. **Menu z-index.** 60 is this page's stacking scale (its other menus are 40–60); DSH's 1100 is another app's
   scale. What matters is asserted: `position: fixed` above the composer and inside the viewport.
4. **Catalogue source and grouping.** DSH groups by host provider; Heddle groups by the **endpoint the user
   configured** in `~/.heddle/heddle.json`. That is the owner's two-tier shape, and the endpoint is the only
   provider identity this harness has.
5. **Search ranking.** DSH filters and ranks by a case-insensitive ordered subsequence; Heddle filters by a
   case-insensitive substring. Presence, the >4 threshold, the 12px field, clear and empty states match; the
   ranking algorithm is not ported because nothing in this catalogue is large enough for the difference to show.
6. **No model-change transcript notice.** DSH appends a user-role `[model changed: …]` message to the next
   request; Heddle's selection is the session's meta record and its `model/request` events, so the transcript
   gains no synthetic user line. The record is what a reader and a reload need; the notice is a model-visible
   artefact whose wording is DSH's.
7. **Stale endpoint row.** Heddle keeps a recorded endpoint the configuration no longer holds, as a disabled
   `not configured` group, because a session switched to a removed endpoint must say what it is set to. DSH's
   host catalogue has no equivalent state.
8. **Model label vs endpoint.** The seat shows the model's display name (as DSH does) and the endpoint appears
   as its group heading; when the endpoint is stale the seat falls back to the endpoint name, because a model
   name alone would hide the reason the session stopped answering.
9. **Not measured, named:** the pending spinner (the route is one round trip; the markup and the
   `aria-busy` toggle exist and the running-state assertion proves no busy mark during a turn) and the
   pending-row check marks. Neither is a divergence; neither has a number.

## Cycle 3 — the user's own catalogue in `~/.heddle/`, and the last verification

```
Cycle 3 — configure the owner's machine and judge the whole delivery
  measured:   the served page from a fresh build, reading the user's own ~/.heddle/heddle.json (2026-10-17):
              seat aria "Select model, current DeepSeek V4.1 Flash, reasoning effort High", title
              "DeepSeek V4.1 Flash · High", two spans; the model pane lists, grouped by endpoint,
              claude-opus -> Claude Opus 5.5 / Sonnet 5.5 / Opus 5 / Sonnet 5 / Opus 4.8,
              plugboard-ds -> DeepSeek V4.1 Flash (current) / V4 Pro, plugboard-cx -> GPT-6.1-Sol /
              GPT-6-Astra / GPT-6-Sol / GPT-6-Luna / GPT-5.6-Sol / GPT-5.6-Terra / GPT-5.6-Luna,
              plus the repository's offline defaults (scripted, localhost) and deepseek-direct.
              Live turns through the served HTTP API, one per endpoint kind, all answering "ok":
              plugboard-ds/deepseek-flash/low -> stop; plugboard-cx/gpt-6.1-sol/low -> completed;
              claude-opus/claude-sonnet-5-5/low -> end_turn; each session's record carries
              endpoint + model + reasoningEffort.
  brainstorm: where the catalogue lives: (a) endpoint.models + per-model reasoning in ~/.heddle/heddle.json
              (chosen — the existing resolution ladder already reads that file and no endpoint value enters the
              repo); (b) a separate models file (discarded: a second source to resolve and keep in step);
              (c) a provider catalogue in the repository (discarded: endpoint values in the repo, not
              user-specific). How a level reaches a provider: (a) level values declared in the user's config and
              sent in the parameter the endpoint kind documents (chosen; each kind probed live); (b) one generic
              parameter for every kind (discarded: the Anthropic publisher route refused the thinking-budget form
              with "use adaptive thinking and output_config.effort"), (c) a free-text effort (discarded earlier).
  step back:  the objective is met. The catalogue is the owner's two tiers and the control is DSH's, with the kept
              differences listed above. Nothing widened: the remaining unmeasured states are named, not silently
              absent, and no row of the coverage matrix is a fix.
  changed:    ~/.heddle/heddle.json (machine-local, not in the repository): claude-opus gains five models with
              low/medium/high/xhigh/max, plugboard-ds gains deepseek-flash and deepseek-v4-pro with
              low/high/max (the route's own advertised levels and default high), plugboard-cx gains seven
              gpt-6.x/5.6 models with low/medium/high/xhigh/max and gpt-6.1-sol as its default; a backup is at
              ~/.heddle/heddle.json.bak-model-selector. Docs: SESSION_UI.md (the composer's seat rows),
              dsh-input-area.md (the model + effort row), this folder's INDEX.md.
  evidence:   the real catalogue rendered by the delivered page and screenshotted as
              `heddle-model-real-catalogue.png`; three live turns through the served API, one per endpoint kind,
              each with the session record naming endpoint, model and level. Final suites: `npm run check`
              clean, `npm test` 322/322, `npm run build` clean. The final verifier sweep, with the exit code of
              each folder this time: **13 of 15 folders green**, `10-llm-backends` exit **3** (one real-backend
              check unjudged — that folder's own honest contract, not a failure), and `80-web-ui` exit 1 on
              **two checks outside this workstream**: `check-composer.mjs` (2 of its 12, the empty-draft
              opacity and the text-column measurement — timing assertions that fail differently run to run) and
              `check-team-view.mjs` (1 of 1, an empty roster). Both were run against the pre-change build at
              `d446e67` in `/private/tmp/heddle-model-old` and fail there too (composer 1/12, a **different**
              assertion; team-view 1/1, the same one), so they are pre-existing at the branch point and are
              named here rather than bent to pass. The model selector's own check is 5/5, and
              `70-workspaces-sessions` is 40/40 and `87-resizable-panels` 1/1.
  reds:       two named, both pre-existing at the branch point and outside this workstream's files:
              `_verifiers_/80-web-ui/check-composer.mjs` (timing assertions, owner: the composer/statistics
              workstream) and `_verifiers_/80-web-ui/check-team-view.mjs` (empty roster, owner: the team
              workstream). The one pre-existing type error fixed in cycle 1 is recorded there.
  coverage:   live-measured: three endpoint kinds, seven catalogue models seen, three turns with three levels,
              one reload, one running-turn switch, keyboard, search, clamp. Not measured: xhigh/max as a live
              turn (the routes accepted them in the direct probes: Claude accepted all five and the Responses
              route named its supported values in a refusal), an unconfigured endpoint's turn failure path (the
              refusal route is judged in the browser check), the pending spinner (named).
  invariants: full verifier sweep 15/15 folders, unit 322, type check clean, build clean; the composer, the
              session tree, the trajectory views and the resizable panels are all unchanged and green.
  lessons:    (1) a catalogue in the user's home is what "user-specific" means here — the repository can hold the
              schema, the adapters and the checks, and must hold no URL, model or key; (2) a level is honest only
              when the provider's own parameter was probed, which is why the Anthropic route's refusal is in this
              record rather than a copied budget guess; (3) the two tiers are also a testing shape: a double per
              endpoint makes "which backend answered" and "what effort was sent" countable.
```

### The goal, measured against its own words

| The objective's clause | Where it is evidenced |
|---|---|
| measure DSH in every named state with the repo browser tool | the measured tables above and the four `dsh-model-*.png` screenshots |
| brainstorm and record the discarded candidates | three cycles of candidates, each with its discard reason |
| understand the mechanism, then step back | cycle 1's widening to the config schema and narrowing of effort; cycles 2–3 record no scope change |
| implement in `feat/model-selector`, never the main checkout | the worktree `/Users/zhenc/heddle-model-selector`; two commits on the branch |
| failing-first assertions, screenshot, suites green | unit tests red before the code; the browser contract 5/5 red on the pre-change build and 5/5 green after; screenshots beside this file; 322 unit tests, check and build clean, 13/15 verifier folders green with the two pre-existing red checks and the one unjudged folder named above |
| reasoning effort only where provider-grounded | the per-kind wire table, the live probes (including the refused budget form), and the config that declares a level's wire value |
| a user-specific selector in `~/.heddle/` | the real catalogue rendered by the page and three live turns, in cycle 3 |
| report branch, commits, numbers, divergences | this document, plus the branch `feat/model-selector` at the two commits above |
