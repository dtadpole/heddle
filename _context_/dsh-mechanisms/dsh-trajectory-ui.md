---
title: DSH Trajectory UI — recon for porting to Heddle
version: 1.0.0
description: What the DSH Web UI's Trajectory tab renders, how it is styled, and how it is interacted with, measured in a real browser.
grounded_in:
  - source: browser
    detail: DSH session context-mgmt at http://127.0.0.1:8080/, Trajectory tab, 2026-10-17
  - source: DSH install
    detail: node_modules/@deepseek-ai/dsh-client-ui-trajectory/lib/client.js (TrajectoryTable / TrajectoryToolbar / TrajectoryTimeline CSS modules)
---

# DSH Trajectory UI — recon

Measured by driving the DSH Web UI in a browser (snapshot, screenshots, computed styles) and by reading
`@deepseek-ai/dsh-client-ui-trajectory`. This is the reference for making heddle's Trajectory area look
and behave the same.

## Layout

Two panes side by side:

- **Table pane** (flex 1, scrolls): a real `<table>` with `table-layout: fixed`, two columns —
  **event column 122px** (84px for `:lang(zh)`) and **content column auto**. Row height **30px**,
  `border-bottom: .5px` in `--dsw-alias-border-l1`, `padding: 0 8px`, one line per event, ellipsis.
  The table font is `var(--dsw-font-xxs-12)` (12px) and the text colour `--dsw-alias-label-primary`.
- **Details pane** (right), only when a row is selected: `width: clamp(320px, 38%, 440px)`,
  `border-left: .5px`, background `bg-layer-1`, resizable by dragging a 8px handle at its left edge.
  Below 760px it becomes an overlay (`position: absolute; right: 0; width: min(92%, 420px)`).

## Left event column: rail, turn label, kind tag

- A **turn rail** — a 2px vertical accent line at the very left (`--trajectory-turn-accent`, blue-500 at
  22% over layer-1) spanning the turn's rows. Rows with `[data-turn-start]` get a 2px horizontal
  separator above, so a turn reads as a block. The rail turns red-tinted on an error turn.
- A **turn label** pinned at the top-left of the first row of each turn: `Turn 23` (i18n
  `turn.label`), `font: 8px/10px var(--ds-font-family-code)`, colour `label-tertiary`,
  background `bg-module-platform`, `padding: 1px 5px`, tabular numerals. Collapses to a compact form
  when the column shrinks.
- A **request boundary control**: a 16px button with a 5.5px dot at the left gutter; hover shows a
  small label tooltip (`font: 9px/12px code`), active/error states tint it, and clicking focuses that
  request.
- The **kind tag**: a 19px-high rounded pill, `font-size: 10px`, `font-weight: 650`,
  `letter-spacing: .035em`, `padding: 0 5px`, coloured per kind (see below). Under 620px container
  width the tag collapses to a 13px icon.

## Kind tags and their colours

| kind | text colour | background |
|---|---|---|
| `USER` | `--dsw-alias-state-business-primary` (blue) | `--dsw-alias-state-business-tertiary` |
| `ASSISTANT` | brand-primary at 60% mixed with error-secondary → **violet** | that colour at 15% over `bg-layer-1` |
| `TOOL` | `--dsw-alias-state-warn-label` (amber) | `--dsw-alias-state-warn-tertiary` |
| `SUBTOOL` | amber at 62% mixed with label-tertiary | warn-tertiary at 58% over layer-1 |
| `CONTEXT` | success-primary at 68% mixed with label-secondary (green) | `--dsw-alias-state-success-tertiary` |
| `SYSTEM` | `--dsw-alias-label-secondary` | `--dsw-alias-bg-module-platform` |
| `COMPACTED` | `--dsw-alias-label-secondary` | `--dsw-alias-bg-module-platform` |

Kind vocabulary: `SYSTEM`, `USER`, `CONTEXT`, `COMPACTED`, `MESSAGE`, `ASSISTANT`, `TOOL`, `SUBTOOL`.

## Content cell: one line per event, and one row for a tool call **and** its result

- Plain kinds (`user`, `assistant`, `context`, `system`, `compacted`): a single-line, ellipsised
  preview (`.contentText`, `white-space: nowrap; text-overflow: ellipsis`). An assistant turn whose
  message holds only tool calls renders `(tool call only)` in `label-tertiary`.
- **`TOOL` rows are the merged element**: `.resultPreview` is a grid
  `grid-template-columns: clamp(180px, calc(36cqw - 56px), 480px) minmax(0, 1fr); gap: 8px`.
  - left cell = **request**: the tool name (`.toolCallNameTypeface`, `font: 400 12px/18px
    Menlo, Consolas, Liberation Mono, ...`) followed by the payload (`margin-left: 7px`) —
    e.g. `bash {"command": "…", "description": "…"}`;
  - right cell = **result preview** after a `→` arrow (`.arrow`, `color: label-caption`,
    `margin-right: 8px`), colour `label-secondary`, one line;
  - no output → a caption-coloured "no output" note;
  - the whole row is monospace (`font-family: var(--ds-font-family-code); font-size: 12px`).
- Long values are truncated with ellipsis; the **full text lives in the details pane**, not in the row.

## Details pane: how a row is examined

Clicking a row selects it (background `--dsw-alias-interactive-bg-active`) and opens the pane:

- **Header** (42px): kind tag, then `Turn 23 · Step 2`, then a 28px close button.
- **Tabs** (34px, `font: xs-13`): `Summary | Payload | Result | Schema | Timing`; active tab is
  business-primary with a 2px underline. Tabs scroll horizontally when narrow.
- **Summary** body sections:
  - **Hierarchy** — parent link (`Assistant Message ‹ ›`), `--dsw-font-xs-13`, rows
    `grid-template-columns: 94px minmax(0, 1fr)`, min-height 22px.
  - **Status** — `Completed` / `Failed` / `Pending`.
  - **Payload** — collapsible; JSON rendered in `font: 12px/19px var(--ds-font-family-code)` on
    `--dsw-alias-markdown-code-block` with 14px padding; errors are tinted error-primary.
  - **Result** — `font: 12px/19px code`, `white-space: pre-wrap`, padding 14px.
  - **Schema** — the tool's name (`500 12px/18px code`), its description, and a parameters JSON tree,
    each section collapsible (`<details>` with a rotating chevron).
  - **Timing** — Started (local time, clickable to switch to unix), Duration, TTFT, Generation,
    Throughput; also a **Usage** block: tokens input/cached/output/reasoning, this request vs session
    cumulative.
  - Markdown payloads render as markdown: h1 `600 16px/22px`, h2 `600 15px/22px`, h3-6
    `600 14px/20px`, inline code `12px/18px code`, body `xs-13`.
  - Thinking appears as a **quote**: `border-left: 2px solid`, `color: label-secondary`,
    with a `thinkingToggle` (600 12px, chevron rotates 90°) to expand it.
  - bash programs: `.programSource` (source, `12px/16px code`) + `.programOutput`
    (`12px/16px code`, `white-space: pre-wrap`), first line of an error bold red.

## Toolbar (sticky, top of the table pane)

- Height `--dsh-trajectory-toolbar-height`; inner flex with 8px gaps, 0 6px padding.
- Toggles (20px high, `font: xxs-12`, colour `label-tertiary`; hover/pressed → `label-primary` +
  `interactive-bg-hover`): **Duration** (with a 20×10 switch: actual duration vs equal-width
  operations), **Turns** (expand/collapse turns), **Calls** (expand/collapse calls).
- **Search** at the right: `flex: 0 164px`, 22px high, `.5px` border, `bg-layer-2`, 12px font,
  placeholder `Search`.
- Collapsed turns/calls become 20px summary rows (`data-collapsed-summary`) with a short text;
  clicking expands them.

## Timeline overview strip (above the table)

- A horizontally **draggable** mini-timeline ("drag horizontally to focus events") with lanes
  **Input / Model / Tools** (also Output / Think / Time in the vocabulary), each event a small
  coloured tick. Dragging sets a focus window: rows outside it get
  `[data-timeline-focus=outside]` → `opacity: .24`, so the table dims to the focused range.
- "Load earlier history" affordances at the top of the table and as a row, for paginated history
  (`data-history-load`).

## Interaction summary to mirror

1. Dense single-line table, one row per event, turn rail + turn labels in the left gutter.
2. Tool row = request (name + payload) and result preview **on one row**, arrow between.
3. Click a row → right details pane with tabs, full payload/result/schema/timing, resizable.
4. Toolbar toggles (duration mode, collapse turns, collapse calls) + search filter.
5. Timeline strip with drag-to-focus; out-of-focus rows dim.
6. Hover row → `interactive-bg-hover`; selected row → `interactive-bg-active`; focus ring
   `--dsw-focus-ring-color`; all transitions `.12s var(--ds-ease-in-out)`.
7. Virtualised rows (spacer row) and sticky header; paginated history loading.

## Read next

[`dsh-context.md`](dsh-context.md) for what the rows are made of, and heddle's
[`src/server/ledger.ts`](../../src/server/ledger.ts) + [`src/server/page.html`](../../src/server/page.html)
for the projection and the client this will replace.

## Heddle delta, measured 2026-10-17 (before this port)

Heddle's Trajectory area (`#ledger` + `#timeline` in [`src/server/page.html`](../../src/server/page.html),
fed by [`src/server/ledger.ts`](../../src/server/ledger.ts)) is a **nested** view: a turn header, a step line,
then records with small lowercase kind pills, and a coarse single-row timeline bar with no lanes and no
drag. Against DSH it is missing: the dense table, the details pane, the toolbar (duration / collapse / search),
lane-based timeline focus, the turn rail and turn labels, and the tool row that carries both halves.

## Mapping: DSH element → heddle element

| DSH | heddle source | notes |
|---|---|---|
| `TOOL` kind tag (amber) | `LedgerKind 'tool'` | one record per call, `result` on it (done) |
| `USER` (blue) | `'user'` | |
| `ASSISTANT` (violet) | `'assistant'` | `(tool call only)` when the text is empty and it only called tools |
| `CONTEXT` (green) | new `'context'` | `context/note` with origin `instructions` — the injected baseline |
| `SYSTEM` (neutral) | `'system'` | `context/note` with origin `system-prompt`, request records |
| `COMPACTED` (neutral) | `'compaction'` | |
| table rows (one per event, turn/step flags) | `projectRows(ledger)` (done) | `turnStart` / `stepStart` / `loose` |
| tool row: name + payload grid + `→` + result preview | `record.name` / `record.text` / `record.result` | one row, two grid columns |
| turn rail + `Turn N` label | `row.turnStart` | rail = 2px accent left of the event column |
| details pane tabs: Summary / Payload / Result / Schema / Timing | `record.*` + `step`/`turn` timing fields | Payload = `text`, Result = `result`, Timing = `startedAt`/`durationMs`/`ttftMs`, Usage = `usage` |
| toolbar: Duration / Turns / Calls / Search | client-only state | search filters rows by kind/label/text |
| timeline lanes Input/Model/Tools + drag focus | `projectTimeline` spans (extend with `kind` lanes) | rows outside the dragged window dim to .24 |

## Tokens to adopt in heddle

```
--tr-row-h: 30px;  --tr-event-col: 122px;  --tr-font: 12px;  --tr-font-code: ui-monospace, SFMono-Regular, Menlo, monospace;
--tr-rail: color-mix(in oklab, #4b8bf5 22%, var(--chat-surface));   /* turn rail */
--tr-hover: color-mix(in oklab, currentColor 6%, transparent);      /* row hover */
--tr-selected: color-mix(in oklab, currentColor 12%, transparent);  /* selected row */
--tr-user: #4b8bf5;  --tr-assistant: #8b5cf6;  --tr-tool: #b7791f;
--tr-context: #2fa36b;  --tr-system: color-mix(in oklab, currentColor 55%, transparent);
```

## Work order (tracked as the goal's todo list)

1. **done** — ledger: merge a call with its result, CONTEXT/SYSTEM note kinds, `projectRows`, unit tests.
2. table: 122px event column + content, 30px rows, kind tags, turn rail and labels, sticky header.
3. details pane: right side, tabs Summary/Payload/Result/Timing, close, resizable, row selection.
4. toolbar: duration mode, collapse turns, collapse calls, search.
5. timeline: lane strip with ticks and drag-to-focus dimming.
6. verifier: a part 9 check that drives a tool-calling turn and asserts the row shape, the details pane and
   the toggles; screenshots compared with the DSH reference; then fix and verify again.

## Evidence

- [`dsh-trajectory-reference.jpg`](dsh-trajectory-reference.jpg) — DSH's own Trajectory tab with the details
  pane open on a `TOOL` row (measured in the browser, 2026-10-17).
- [`heddle-trajectory.png`](heddle-trajectory.png) — heddle after the port: the toolbar, the three lane
  timeline, the turn rail with `Turn 1`/`Turn 2` labels, kind tags, one row per tool call carrying its
  result, and the details pane with Summary/Payload/Result/Timing.
