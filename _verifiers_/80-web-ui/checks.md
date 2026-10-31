---
title: 80-web-ui — what decides it
created: 2026-10-23T05:06:41Z
modified: 2026-10-31T14:45:00Z
level: L3
version: 1.3.0
description: The check files of 80-web-ui, what each decides, and what the part deliberately leaves to others.
status: unverified
grounded_in:
  - source: moved verbatim from _verifiers_/80-web-ui/INDEX.md@1.2.0
---

# 80-web-ui — what decides it

## What decides it

- [`check.mjs`](check.mjs) — the port, the page, the API and the live stream.
- [`check-team-view.mjs`](check-team-view.mjs) — a Lead's team as the Web UI shows it: the roster with live status,
  the shared board with its revisions and the mailbox ledger, read from the same `/api/team` projection the
  tools use; and no panel at all for a session with no team.
- [`check-stream.mjs`](check-stream.mjs) — the live event stream against DSH's `$events` stream: it opens with
  `{ type: 'ready', clientId, host: { home } }` after its listeners are attached, so a baseline read on `ready`
  misses no increment; an idle stream gets a heartbeat every interval and a peer that stops reading is cut after
  two; a reconnect is given every frame it missed after its cursor (`Last-Event-ID` or `?cursor=`) and a cursor
  from another start gets `reset`; the page shows it is reconnecting while the server is down and, once back,
  draws a session made meanwhile without a reload; renames, workspace edits and settled approvals are pushed to
  every stream, numbered, and a page redraws a rename and a new workspace made elsewhere without a reload; an
  approval answered on one page closes on every page; a failed turn reaches every client and the log, and the
  transcript carries it as the stop reason (DSH parity phase B, developer-ten; R-developer-six-2).
- [`check-chat-view.mjs`](check-chat-view.mjs) — the chat's shape: a tool call and its result folded into
  one turn, and one element drawn for it, with the person and the model keeping their own. Its minimap
  freshness check compares the served page marker with the SHA256 prefix of the fixture's built HTML,
  not a historical rail-specific label.
- [`check-context-view.mjs`](check-context-view.mjs) — how a session's context was composed: the report
  per session, its provenance, and the span a compaction stands in for.
- [`check-file-view.mjs`](check-file-view.mjs) — a source file drawn as source with a language from its
  extension, and a file's own script tags shown rather than obeyed.
- [`check-runtime-context.mjs`](check-runtime-context.mjs) — a mode change as a **trajectory fact**: the
  Trajectory view names the runtime-context snapshots (with each policy text in its details pane) while the Chat
  view does not draw them as turns, so a reader after the fact can see the expectation changed and what it became.
- [`check-approval.mjs`](check-approval.mjs) — the approval card as a control: it appears when a call asks for a
  wider mode, carries the model's justification verbatim, Allow once runs the one denied call, Reject leaves it
  undone, and the session's own mode never moves.
- [`check-access.mjs`](check-access.mjs) — the access-mode chip as a control: its reference anatomy (shield,
  label, chevron), the menu with a checked current entry, the pending state of a change, the full-access risk
  gate, a reload coming back to the session's mode, and the server refusing an unconfirmed escalation.
- [`check-workspaces.mjs`](check-workspaces.mjs) — the left column's workspace controls, add, rename and delete, at
  DSH parity: registering a folder over the API the dialog posts to, the refusals that keep the controls honest
  (a rename to another workspace's name is `409 workspace/name-conflict`), delete removing the registration while its
  sessions move to Ungrouped, the split between a chosen root and one adopted because a session ran in it, the
  folder chooser's `/api/directories` routes, and a browser driving the *Select Workspace Directory*, *Rename
  workspace* and *Delete workspace* dialogs end to end; with the server gone, *Add workspace* and *New session* say
  that they failed (the dialog's alert line, `New session failed: …`) instead of leaving an unhandled rejection.
- [`check-workspace-tree.mjs`](check-workspace-tree.mjs) — the left column as DSH's workspace tree: `GET
  /api/workspaces` naming each workspace's parent and the sessions whose nearest root it is, then a browser seeing a
  nested workspace before its parent's sessions, five sessions newest first with `Show {n} more sessions` / `Show
  less` (the open New session drawn on top of the five), Ungrouped last for a session no registered workspace owns,
  the open session's row selected and its workspace tinted, a workspace's `+` starting a session there, New session
  starting in the workspace row the person opened rather than the open session's, and the `Workspace` grouping
  drawing sibling sections; and the Session Intent hero's workspace picker (C36): over a blank session a `Choose
  workspace` chip naming its workspace, a menu with the current one checked and `Add workspace…` last, DSH's menu
  keys, and a pick that moves the new session and its draft so the first prompt runs in the picked workspace.
- [`check-hover-cards.mjs`](check-hover-cards.mjs) — the sidebar's row hover cards at DSH parity (C22, C41), with a
  real pointer: a session row's card only after the 800 ms dwell, 8px right of the row, with the full title, the
  relative time, the session's own scheduled task (a scripted `schedule_create`) and its status; the workspace row's
  card opening at once in the warm list with its title, home-abbreviated folder and creation time; both copyable;
  none for Ungrouped; the card closing when the pointer leaves the list.
- [`check-workspace-drag.mjs`](check-workspace-drag.mjs) — reordering workspaces by drag (DSH's
  `workspace/insertBefore`, C37): a workspace header dragged onto a sibling's section lands before or after it with
  the drop line drawn, the host stores the order (`GET /api/workspaces`) and a reload keeps it, while a nested
  workspace or Ungrouped is not a place a top-level workspace can land.
- [`check-narrow-layout.mjs`](check-narrow-layout.mjs) — a narrow window at DSH parity: below 1024 pixels the
  sidebar is the 56-pixel rail (`dsh-client-ui-layout`, `SIDEBAR_AUTO_COLLAPSE`), so at phone width (390 x 844, the
  protocol's device metrics) the conversation keeps a readable width and the composer and its send button stay on
  screen with nothing overflowing sideways; the toggle opens the panel there and closes it again, crossing the
  breakpoint forgets that opening and leaves the wide preference alone, and a desktop visit still opens wide
  (live-testing draft developer-ten-9).
- [`check-phone-composer.mjs`](check-phone-composer.mjs) — at phone width (390 x 844) the composer's control row and
  the status line stay readable (#117): a long model name ends before the send button and after the access chip and is
  shortened with an ellipsis, as DSH's block-level model trigger does, and every status-line item stays inside the
  composer column, as DSH's shrinkable pills do; a desktop window still shows the whole name.
- [`check-browser-tab.mjs`](check-browser-tab.mjs) — the right sidebar's Browser tab (#86), opt-in as DSH's Web
  profile ships it: a default server reports no `browser` on `/api/status` and shows no entry point; with
  `HEDDLE_WEB_BROWSER=1` the tab refuses `javascript:`, `file:`, `data:` and `blob:` input, credentials and the
  application's own origin before anything reaches the network, frames a loopback page in DSH's default sandbox with
  no referrer, keeps its own Back and Forward, marks a page that moved itself unknown, and covers the window at phone
  width. On a desktop it keeps DSH's column budget whatever the left sidebar's stored or dragged width and the
  window's: beside a track the conversation keeps 400 pixels and the track 300, a pane with no room for that covers the
  conversation column, and opening it below 1024 pixels returns a narrow opening of the left sidebar to its rail.

## What it deliberately does not judge

- **How well a model reasons.** Nothing here scores an answer's quality; the checks
  ask whether the mechanism works.
- **Anything it has to spend to see.** Except where a check is named for the real
  backend, every fixture is local and the run is free.

## Page marker regression evidence

[`page-marker-evidence.md`](page-marker-evidence.md) records why the historical rail label was wrong
and the browser check that retains exact built-page identity alongside the minimap behaviour.
