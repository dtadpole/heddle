---
title: Commands
created: 2026-10-29T12:05:41Z
modified: 2026-10-29T12:05:41Z
version: 0.1.0
description: The host's slash commands — the registry, the line parser, the built-in commands and the two routes the composer's menu uses.
grounded_in:
  - source: the DSH package's dsh-commands, dsh-command-compact, dsh-command-goal, dsh-command-feedback, dsh-permission-presets, dsh-session-log-export and dsh-client-ui-commands, read 2026-10-29
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

## The built-in commands

| Command | Input | Section | What it does |
|---|---|---|---|
| `/compact` | none | Commands | the context service's forced reduction; "Compacted N history items (~T tokens)." or "No compactable history yet." |
| `/goal` | `[<objective>\|clear\|edit <objective>\|pause\|resume]` | Add | the goal service's create, show, edit, pause, resume and clear |
| `/feedback` | `<text>` | Add | a `feedback/record` event signed with an anonymous id; the text is kept out of `command/run` |
| `/permission` | `<preset>` | Commands | the session's sandbox mode; widening to `danger-full-access` is left to the access chip's risk gate |
| `/export` | none | Commands | asks the page to download the session log, the same bytes as Download log |

`/plan` (plan mode) and the page's menu (`/model`, `/file` and the menu itself) are later pieces.

## Wiring

- The profile row `commands` in `heddle.patch.yml` loads the plugin; only the session store is required.
- `src/server/web.ts` hands over in one place, behind its door:
  `if (commands !== undefined && (await handleCommandRequest(commands.routes, request, response, url))) return`.

Judged by `_verifiers_/80-web-ui/check-slash-commands.mjs`; unit tests in `test/commands.test.ts`.
