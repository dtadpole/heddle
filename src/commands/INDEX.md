---
title: Commands
created: 2026-10-29T12:05:41Z
modified: 2026-10-29T15:45:00Z
version: 0.3.0
description: The host's slash commands — the registry, the line parser, the built-in commands and the two routes the composer's menu uses.
grounded_in:
  - source: the DSH package's dsh-commands, dsh-command-compact, dsh-command-goal, dsh-command-feedback, dsh-permission-presets, dsh-session-log-export, dsh-client-ui-commands and dsh-client-ui-goal (its goal-command-input projection and GoalCommandInputView), read 2026-10-29
  - source: _projects_/heddle/_designs_/dsh-parity results-developer-twelve.md (C78-C89) and results-developer-six.md (R-developer-six-5)
---

# `commands`

The slash-command layer, modelled on DSH's `dsh-commands`. Owner: developer-three (D-057).

A line that opens with `/name` and names a registered command runs **on the host**: it never becomes a prompt, and
the session log records a `command/run` before the handler and a `command/done` after it, both log-only (no place on
the model's surface). A line that names no command is left alone and the page sends it as an ordinary prompt —
DSH's rule, and how `/skillname` reaches the model.

| File | What it holds |
|---|---|
| [`registry.ts`](registry.ts) | `CommandRegistry`, `parseCommandLine`, the two event names, the result shapes |
| [`builtins.ts`](builtins.ts) | `/compact`, `/goal`, `/feedback`, `/permission`, `/export`, each over the smallest host it needs |
| [`http.ts`](http.ts) | `handleCommandRequest`: `GET /api/commands` and `POST /api/sessions/{id}/commands` |
| [`service.ts`](service.ts) | the `commands` plugin: the registry with the built-ins wired to the session, goal, context, model and sandbox services |
| [`menu.js`](menu.js) | the composer's slash menu, a browser module the page imports from `GET /commands/menu.js`: the trigger rule, DSH's sections and ranking, the keys, `/name ` with its hint, the command row |

## The built-in commands

| Command | Input | Section | What it does |
|---|---|---|---|
| `/compact` | none | Commands | the context service's forced reduction; "Compacted N history items (~T tokens)." or "No compactable history yet." |
| `/goal` | `[<objective>\|clear\|edit <objective>\|pause\|resume]` | Add | the goal service's create, show, edit, pause, resume and clear |
| `/feedback` | `<text>` | Add | a `feedback/record` event signed with an anonymous id; the text is kept out of `command/run` |
| `/permission` | `<preset>` | Commands | the session's sandbox mode; widening to `danger-full-access` is left to the access chip's risk gate |
| `/export` | none | Commands | asks the page to download the session log, the same bytes as Download log |

`/model` and `/file` are page entries the menu adds when the page lends them (`openModelMenu`, `openFilePicker`);
they are never logged as commands, as in DSH. `/plan` (plan mode) is a later piece.

## The menu

`/` at the caret opens it — at the start of the draft, or after whitespace or punctuation, never inside a word, a
path or a URL. An empty query shows DSH's sections, **Add** (file, goal, plan, feedback) and **Commands** (compact,
permission, model, export); a typed one ranks prefixes first, then ordered subsequences; an inline token hides every
command that takes input. ↑/↓ wrap, Enter or Tab pick, Escape or Shift+Tab close and leave that token alone. A command
that takes input becomes `/name ` with DSH's hint; one that takes none runs at once. A run's row is drawn from the
`command/run` and `command/done` events, live and — through the transcript's `command` turns — after a reload.
A `/goal` run also shows the person's line just before its row, as DSH's dsh-client-ui-goal does: a right-aligned
`Command input` bubble (`div[data-command-input][role=group][aria-label="Command input"]`) reading `/goal` plus the
recorded remainder with trailing whitespace removed, the `/goal` token a command chip that does nothing when clicked,
no time, copy or branch actions — built from `command/run`, so a reload rebuilds it.

One deliberate difference from DSH's web client: a registered command's name always reaches the host, so
`/compact now` gets the host's usage sentence instead of being sent to the model as a prompt.

## Wiring

- The profile row `commands` in `heddle.patch.yml` loads the plugin; only the session store is required.
- `src/server/web.ts` hands over in one place, behind its door:
  `if (commands !== undefined && (await handleCommandRequest(commands.routes, request, response, url))) return`;
  its `transcriptTurns` folds `command/run` and `command/done` into `command` turns.
- `src/server/page.html` imports the menu after the composer exists and hands over at three points: `submitDraft`
  (a claimed line runs, anything else is a message), the session-event handler (a live row), and the history render
  (a row's placeholder, drawn once the module has loaded).

Judged by `_verifiers_/80-web-ui/check-slash-commands.mjs`; unit tests in `test/commands.test.ts`.
