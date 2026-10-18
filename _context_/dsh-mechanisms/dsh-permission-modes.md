---
title: DSH permission modes and heddle's session-scoped access mode
version: 1.0.0
description: What DSH's access-mode control renders and does, measured in a browser in every state, and the session-scoped access mode heddle now implements beside it, with the designs discarded and why.
grounded_in:
  - source: browser
    detail: DSH at http://127.0.0.1:8080 measured 2026-10-17 with getComputedStyle and the accessibility snapshot through _tools_/browser-use/, at a 1400x900 viewport
  - source: source
    detail: the installed DSH packages read 2026-10-17 — dsh-sandbox, dsh-sandbox-policy, dsh-permission-presets and dsh-client-ui-permission-presets
  - source: owner statement 2026-10-17 naming the session-scoped access mode, the explicit-owner escalation and the three-cycle loop
---

# DSH permission modes, and heddle's session-scoped access mode

This is the loop document for the session-scoped permission-mode work: what the reference does,
what heddle did before, the designs considered and discarded, and one evidence block per cycle.
It is written so a fresh session can resume from it.

## What DSH does, measured

The chips, menu, dialog and refusal below were measured on DSH's own page, not remembered. The
screenshots are beside this file — [`dsh-permission-menu.png`](dsh-permission-menu.png),
[`dsh-permission-full-access-dialog.png`](dsh-permission-full-access-dialog.png),
[`dsh-permission-refusal.png`](dsh-permission-refusal.png).

### The chip

| Property | Measured value |
|---|---|
| box | 153.25 x 28 px, in the composer's control row |
| label | `Read Only` / `Workspace Write` / `Full access` (13px, weight 500, line-height 20) |
| colour, surface | `rgb(207, 211, 214)` on a transparent background, radius 8px |
| padding, gap | `0 4px 0 8px`, gap 4px |
| anatomy | shield glyph 14x14 (declared 16) + label + chevron 14x14 |
| accessible name | `Access mode, current: Workspace Write` |
| semantics it **lacks** | no `aria-haspopup`, no `aria-expanded`, no `title` (a miss heddle does not copy) |
| cursor | pointer |

### The menu

| Property | Measured value |
|---|---|
| surface | `position: fixed`, 166.93 x 144 px, radius 16px, padding 4px, z-index 1100, shadow `0 0 0 .5px rgba(255,255,255,.16), 0 3px 8px rgba(0,0,0,.04), 0 0 20px rgba(0,0,0,.05)` |
| placement | opens **above** the chip, every edge clamped to the viewport (the chip is at the bottom) |
| item | 158.93 x 34 px, radius 12px, 13px, icon 14x14, gap between icon and label |
| hover | background `rgba(255,255,255,.08)`; no change to the text colour |
| current item | a `_selected_` class plus a check glyph drawn **after** the label; no `aria-checked` on the item |
| options | `Read Only`, `Workspace Write`, `Full access`, and (only while the experimental integration is live) `Auto review EXP` with `EXP` superscript and no icon |
| semantics | `role="menu"` and `role="menuitem"`; Escape closes it and returns focus to the chip |

### Changing the mode

- Choosing an item closes the menu and updates the chip **immediately**; the write is one
  `POST /api/commands/execute` carrying `/permission <preset>` for the session's agent id.
- **No confirmation** for a downgrade or for `Read Only` / `Workspace Write` — measured, `Full
  access` to `Workspace Write` and `Workspace Write` to `Read Only` both change on one click.
- **Escalation to `Full access` has a risk gate**: a `role="dialog"` with `aria-modal="true"`
  and `aria-label="Enable Full access?"` (440 x 292 px), the sentence "Full access reduces
  confirmation steps and lets the agent perform more actions directly, including sensitive
  operations, file changes, or external commands. Only use it when you trust the current task.",
  a checkbox "I understand the risks and want to continue", and a primary "Enable Full access"
  button that is **disabled until the checkbox is checked**; Cancel leaves the mode unchanged.
- The mode is **per session**: a running session showed `Full access` while a new-session draft
  in the same tab showed `Read Only`, and neither affected the other.
- It **survives reload**: after a fresh page load the same session came back with its mode. It is
  written as the session's `sandbox/mode` event, folded over the deployment default, not stored in
  `localStorage` (no permission key was in either web storage).
- The chip **works while a turn is running**: with Stop visible and a turn streaming, the control
  stays focusable and its menu opens. The switch takes effect on the session's next confined call;
  the in-flight call keeps the mode it resolved.

### How a refusal looks

Measured with a `read-only` session asked to write outside the workspace:

1. The tool row ends `Error: [sandbox: file access denied under read-only mode]` in red.
2. The next round retries the same call with `sandbox_permissions: "workspace-write"` and a
   plain-sentence `justification`.
3. An **approval card** appears: amber border, "Waiting for approval", the body "Allow this
   operation with workspace-write permissions: <the justification>", and two buttons, `Reject`
   (ghost) and `Allow once` (light primary, 98 x 36 px).
4. Reject leaves the operation refused and the turn ends saying so; a granted escalation applies
   to that one call only and the session mode is unchanged.

The escalation ladder is closed — `read-only` to `workspace-write` or `danger-full-access`,
`workspace-write` to `danger-full-access` — and it is checked at execution, never baked into a
tool schema.

## What heddle did before

`src/sandbox/service.ts` resolved its mode when the service was constructed. `GET /api/status`
reported it and the page's `#access` chip was `data-inert="true"`: it named the mode and could not
change it. `_verifiers_/75-permission-sandbox/` judged the three modes by writing under three
profiles, and `_verifiers_/80-web-ui/check-composer.mjs` asserted only that the chip's text matched
one of the three names.

So the difference to remove is a **mechanism**, not a value: the mode has to become a fact of the
session that the owner can change, that every tool call is gated by, that a reload comes back to,
and that a UI cannot widen silently.

## Cycle 1 — measure DSH, choose the mechanism

### measured

Everything in "What DSH does" above, from the browser at `http://127.0.0.1:8080` with
`_tools_/browser-use/`, plus the package reading that named the mechanism behind it:
`dsh-sandbox-policy` keeps a per-session `sandbox/mode` event, resolves
`effective = explicit grant ?? fold(events) ?? deployment default`, and every enforcing capability
resolves that policy **per call**; `dsh-permission-presets` bundles the sandbox mode with an
approval policy and records a `permission/preset` selection; the client UI gates only the
`danger-full-access` preset behind the risk dialog.

### brainstorm

| # | Candidate | Verdict |
|---|---|---|
| 1 | Keep the mode fixed at construction and keep the chip read-only | **Discarded** — it is the before-state; the task is to remove exactly this difference, and DSH's mode is per session |
| 2 | Record the mode as a mutable field in the session's **meta file** (`session.json` beside the log) | **Discarded** — the meta file describes how a session is run (endpoint, model) and is rewritten in place; a permission change is an **action** with a time and an order, the sort of fact the append-only log exists for. It also would not reach the Web UI's `session/event` stream, so a change made in another window or by the CLI would need polling |
| 3 | A global server default changed by the API | **Discarded** — not session-scoped. One conversation widening its access would widen every other session's, which is the silent widening the task forbids |
| 4 | An in-memory map on the sandbox service | **Discarded** — forgotten on restart, so the reload claim fails; a mode that forgets is worse than one that refuses |
| 5 | OS-level confinement per call (DSH's real backend) | **Discarded for this job** — heddle's sandbox is deliberately not an OS boundary; adding seatbelt/bwrap confinement is a much larger feature and would be half-built. The mode keeps governing the harness's own file tools, and `read-only` refuses the shell because an unconfined shell could write outside them |
| 6 | Bundle the sandbox mode with the approval policy, as DSH's presets do | **Discarded** — heddle's approval policy is deployment configuration and the goal's part 8 judges file effects; the extra dimension has no verifier and would multiply the states a person has to reason about |
| 7 | A per-call `sandbox_permissions` escalation argument, as DSH's tools expose | **Discarded for this cycle** — it is a model-requested path that needs an approval prompt a headless run cannot answer (heddle's `ask` is a denial with a reason), and the task requires an escalation to be an explicit owner action. Keep it as future work beside the approval service |
| 8 | Optimistic local mode in the page, recorded nowhere | **Discarded** — reload loses it, the CLI disagrees, and enforcement could not trust it; also the definition of silently widening |
| 9 | **Session log event `permission/mode`; effective mode = last event ?? deployment default; every tool call resolves it once at the single registry gate** | **Chosen** — the smallest honest mechanism. It reuses the append-only log (per session by construction, replayed on open, trimmed only by compaction's shadowing), it streams through the existing `session/event` SSE to every window, and it puts the resolution at the one place every tool call passes through |

### understand

DSH separates **selection** from **enforcement**: `dsh-permission-presets` owns the chip's value and
writes a session event, `dsh-sandbox-policy` folds that event into a per-call policy, and the tool
families consume the policy per call. That split is why the mode can change mid-turn without
rewriting history and why two sessions cannot see each other's state.

Heddle already has the three pieces this maps onto: an append-only per-session log with a fold and
an `onEvent` stream (`src/session/store.ts`), one registry every tool call passes through
(`src/tools/service.ts`, which already owns the approval-then-sandbox gate order), and a page with
one session selected and an `EventSource` (`src/server/page.html`). What it lacks is a per-session
override and a per-call policy argument; the sandbox's `mode` field is process-wide.

### step back

- **Still the right job?** Yes, and the reference widened it in two places the before-state hid:
  the chip is a real menu with a selected state and keyboard handling, and the escalation to full
  access has a **risk gate** in the reference. Both are part of "the same mechanism", so the scope
  takes them in; the approval-policy bundling and the per-call escalation ladder stay out (named
  above, deferred).
- **Did the evidence narrow it?** It sharpened one point: heddle cannot confine a shell, so
  `read-only` that still allowed `bash` would be a lie. `read-only` must refuse the shell — a gate
  rule, not a UI rule, and it belongs to this cycle.
- **Is the target right for this project?** DSH's `Auto review EXP` option has no substrate here
  (no auto-review integration), so heddle offers three options and keeps that difference with its
  reason. DSH's chip also lacks `aria-haspopup`/`aria-expanded` and its menu items lack
  `aria-checked`; heddle deliberately does better, and the browser contract asserts the better
  semantics.

### plan (one sentence per change)

1. `src/sandbox/service.ts` — export the closed mode vocabulary and rank, and let
   `assertWritable`/`assertReadable` take the per-call mode, defaulting to the deployment mode.
2. `src/session/service.ts` — `recordedMode(handle)` folds the last `permission/mode` event and
   `setMode(handle, mode, fallback)` appends one only when the effective value changes.
3. `src/tools/service.ts` — resolve the session's effective mode once in `call()` and pass it to
   the tool as `context.mode`; the run context type carries it, so no tool can run without one.
4. `src/tools/builtin.ts` — the fs tools pass `context.mode` to the sandbox; `bash` is refused
   under `read-only` with a message that names the reason.
5. `src/server/web.ts` — `GET /api/sessions/<id>` carries `permission.mode`; a new
   `POST /api/sessions/<id>/permission` accepts `{ mode, confirm? }`, validates it and refuses an
   escalation to `danger-full-access` without `confirm: "full-access"`.
6. `src/server/page.html` — the chip becomes a menu control with the reference's anatomy, a risk
   dialog for full access, a pending state, SSE updates and reload persistence.
7. Tests first: unit tests for the gate and persistence, `_verifiers_/75-permission-sandbox/`
   enforcement through the new API, `_verifiers_/80-web-ui/check-access.mjs` as the chip contract.

### Refused transitions (the security rule of this cycle)

- A **tool call cannot change the mode**: no tool takes `sandbox_permissions`, no argument names a
  mode, and no hook can write the event. The only writer is the owner's `POST .../permission`.
- An **escalation to `danger-full-access` without `confirm: "full-access"` is refused by the
  server**, not only by the dialog — a script or a stale page cannot widen access by accident, and
  the UI sends the token only after the checkbox and the Enable button. This is stronger than the
  reference, whose gate is client-side only.
- An unknown mode is refused; selecting the mode already in effect appends nothing.
- A mode change **never touches an in-flight call**: the policy is resolved once per call, so a
  widening cannot retroactively permit the call that is already running, and a narrowing cannot
  break one that started under the wider mode.
- `read-only` refuses `bash`, because heddle's sandbox cannot confine a shell's file effects.

### evidence

Filled in by cycles 1-3 below.

### coverage

Visited cells: chip anatomy, idle/hover/focus, menu inventory and selected state, keyboard
(Escape), downgrade, escalation and its risk gate, reload persistence, running-turn availability,
per-session independence, refusal rendering and escalation rejection. Not visited: a real
provider turn under every mode (the scripted endpoint is used instead), mobile viewports, and the
reference's `Auto review EXP` behaviour (no substrate here).

## Cycle 2 — pending

## Cycle 3 — pending
