---
title: DSH's todo list, measured
version: 1.0.0
description: How DSH's todo_write tool, todo/write event, todos projection and rendered TodoPanel work, and the mapping this project's todo list will follow.
grounded_in:
  - the installed DSH at @deepseek-ai/dsh-tool-todo/lib/index.js, read on 2026-10-18
  - the installed DSH's conversation client, TodoPanel and TodoDock, read on 2026-10-18
  - the todo list of this session, written through the tool while researching it
---

# DSH's todo list

The reference implementation is one package, `@deepseek-ai/dsh-tool-todo`, plus a panel in the conversation's
input dock. The model-facing name is **`todo_write`**; the durable record is one session event,
**`todo/write`**, carrying the **whole list**; every client renders from a projection of that event.

## The model-facing tool

- `todo_write({ todos: [{ content: string, status: 'pending' | 'in_progress' | 'completed' }] })` —
  a **whole-list replacement**, not a patch. The description tells the model to add one todo per concrete
  step before starting, keep the active ones `in_progress`, and mark each `completed` as soon as it is done.
  A deployment config (`allowParallelInProgress`) chooses between "exactly one in_progress" (default) and
  "several while work runs in parallel"; the description's middle clause is the only thing that varies.
- **Validation** at the boundary, before anything is logged: `content` trimmed non-empty, no duplicate
  content, at most one `in_progress` unless parallel is allowed, item keys closed (`additionalProperties:
  false` — the logged snapshot must equal what the model believes it wrote).
- **Output**: `{ todos, counts: { pending, inProgress, completed } }`, rendered to the model as
  "Updated todo list: N pending, N in progress, N completed."
- The tool row is presented as a **generic card titled "Update todo list"** with the raw list as its input;
  the conversation renders a one-line plan summary from it (`done/total`, the first `in_progress` content,
  and the number of further active items beside it, so parallel work is not hidden).

## The durable record and the projection

- `exec.agent.session.append('todo/write', { todos })` — **last write wins**; replay takes the last
  `todo/write`. A non-agent caller is rejected (no owning list).
- The `todos` projection registers `init: () => null`, `apply: (state, event) => event.type === 'todo/write'
  ? event.data.todos : event.type === 'turn/start' ? null : state`. The **`turn/start` reset** is the
  semantic that matters: the list is a **per-turn plan**, cleared when a new turn begins, so a stale plan
  never outlives the work it described. It is exposed through the session-projection wire.

## The rendered panel (source anatomy)

`TodoPanel` mounts through `ctx.slots` into **`conversation.input.dock`** (id `todo`, order 0 — the same dock
the goal bar uses, so a session with both stacks them above the composer). Its structure:

- `<section class=root data-testid="todo-panel" aria-label="Todo list">`, returning `null` when the list is
  empty (so the panel's presence is itself the "has a list" signal).
- A **header button** (`aria-expanded`), collapsed by default: a checklist outline glyph, the title
  ("Todo list"), a progress label, and a chevron. The progress label is the per-status counts, **zero-count
  segments omitted** and joined by ` · ` (e.g. "2 done · 1 active · 3 pending"), so a non-empty list always
  shows at least one segment.
- When expanded, a `<ul>` of `<li data-status>` items: a status glyph (`role="img"` with the status's
  accessible label) and the content.
- The generic input-dock panel CSS was measured from the live page: a menu surface on `::before`
  (`var(--dsw-specific-menu)` + backdrop filter) with a hairline `::after` border and a large top radius, a
  36px header, a list capped at 180px with scrolling, 36px rows separated by an inset hairline.
- **Named gap, to close before the UI cycle's first fix:** the `TodoPanel` module's own CSS (its root, header,
  title, progress, list and item rules) has not been measured as rendered yet — the panel could not be opened
  in the reference instance during this round. The committed instrument
  [`measure-todo-ui.mjs`](measure-todo-ui.mjs) is what closes it: it looks for
  `[data-testid="todo-panel"], #todo-panel`, fails loudly when absent, and returns one fixed schema for both
  sides. The UI cycle starts by running it against a DSH session with a non-empty list.

## Mapping into this project

| DSH | Heddle |
|---|---|
| `todo/write` snapshot event | the same event name and shape, versioned and strictly decoded like `goal/change` |
| `todos` projection, last write wins | the same fold; **kept per session rather than reset on turn start**, because this project's durable unit is the session (goal rounds and restarts), and a task list that disappears between turns is not a list a person can read. The cost is recorded: a stale list can linger until the model replaces it (or writes an empty list, which the UI hides). Recorded as a divergence, not an omission. |
| `todo_write` tool | the same tool and description; **plus `todo_read`**, which the session-persistent choice makes meaningful for a model that resumes after a restart |
| panel in `conversation.input.dock` | a `#todo-panel` in the input dock below the goal bar, same anatomy (header with checklist glyph, title, zero-omitted counts, chevron; collapsible list with status dots) |
| `turn/start` reset | not copied; the list is durable and replaced wholesale by the next `todo_write` |
| projection wire to clients | `GET /api/todo?session=` plus a live refresh on `todo/write` over the session stream |

## The state matrix (to fill before the first fix)

| Cell | Reference | This project | Verdict |
|---|---|---|---|
| no list (`null`) | panel absent | — | to measure |
| empty list (`[]`) | panel absent (`todos.length === 0` returns null) | — | to measure |
| one pending item | header shows "Todo list · 1 pending" | — | to measure |
| mixed statuses | counts omit zero segments, joined ` · ` | — | to measure |
| many items | list scrolls at 180px | — | to measure |
| long item content | truncation behaviour of the item row | — | to measure |
| collapsed / expanded | collapsed by default; chevron; `aria-expanded` | — | to measure |
| liveness | panel appears/updates without a reload | — | to judge in the browser check |
| turn end | list persists in DSH until next turn starts | intentional divergence: persists | recorded |
| restart | durable in DSH's log | durable in this project's log | to judge |

The tool semantics are researched and cited; the rendered values are the gap the instrument closes, and no UI
code is written before that.
