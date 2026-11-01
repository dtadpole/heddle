---
title: 80-web-ui — what decides it
created: 2026-10-23T05:06:41Z
modified: 2026-11-01T08:30:00Z
level: L3
version: 1.8.0
description: The check files of 80-web-ui, what each decides, and what the part deliberately leaves to others.
status: unverified
grounded_in:
  - source: moved verbatim from _verifiers_/80-web-ui/INDEX.md@1.2.0
---

# 80-web-ui — what decides it

## What decides it

- [`check.mjs`](check.mjs) — the port, the page, the API and the live stream.
- [`check-session-id.mjs`](check-session-id.mjs) — Copy Session ID at DSH parity (row C20): the session row's menu
  ends with it, pressing it closes the menu and gives the clipboard the complete id with the Toast "Session ID
  copied", and a refused clipboard shows "Copy failed. Try again." instead.
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
- [`check-blank-page-stream.mjs`](check-blank-page-stream.mjs) — a page with nothing open follows no other session's
  turn (#142, developer-ten's finding on first-visit-2): two pages on one server, B fresh with no session while A sends
  a message whose answer the provider double streams and holds open until the check releases it; sampled every 100 ms,
  B's conversation stays empty and its dock hidden, while B's tree marks A's session running and, once released, not
  (only the drawing half is held); then B's own first message shows its own turn only, in a session of its own.
- [`check-chat-view.mjs`](check-chat-view.mjs) — the chat's shape: a tool call and its result folded into
  one turn, and one element drawn for it, with the person and the model keeping their own. Its minimap
  freshness check compares the served page marker with the SHA256 prefix of the fixture's built HTML,
  not a historical rail-specific label.
- [`check-user-secret-mask.mjs`](check-user-secret-mask.mjs) — issue #84's sent human bubble, driven through the
  delivered TypeScript CLI or `HEDDLE_BIN` Rust CLI with a private fixture home/workspace and a port-zero local
  provider double. Two deterministic, non-provider-issued `FAKE` credentials use installed literal `sk-` and
  `ghp_` prefixes, valid numeric suffix minimums and a digit for the `sk-` shape. Actual textarea/Send gestures
  judge actual asterisks by default, two independent SVG icon toggles, reveal-one-not-the-other, hide, a real
  session-switch remount and page reload returning masked. A second ordinary UI message makes the minimap
  reachable; its first-user preview is judged masked when accessible, otherwise explicitly diagnosed as unavailable.
  The provider's real request must contain the exact original prompt, and the real user Copy handler must give
  a browser-local `writeText` recorder that same raw original. No OS/global clipboard is read. No newly introduced
  raw attribute, title or aria value is allowed; the existing user-row raw Copy snapshot is explicitly excluded.
  Named sessions avoid automatic title calls and a 1,000,000-token window avoids provider compaction calls.
  Startup, fetch plus body consumption, provider request bodies and browser/CLI/provider cleanup have bounds;
  `HEDDLE_VERIFY_UI=0` uses the standard labelled skip, not an environment assertion. Author-only product-source
  pin is `659588`, with identical product source at `422c7d2a` as confirmed by the parent. This entry records no
  executed result; source-owner-ten exact review and both actual TypeScript/Rust execution gates belong to the
  parent. Queue/steering buffers, goal/automatic messages and assistant rendering are outside this check, as are
  real keys and any claim that server logs, storage or provider transport redact secrets.
- [`check-user-text-surfaces.mjs`](check-user-text-surfaces.mjs) — issue #84 part 2, authored against product source
  `60c67da5`, not an executed result. Actual `heddleCommand` honours both the TypeScript CLI and `HEDDLE_BIN`;
  a private home/workspace and port-zero offline provider double hold the first real turn while Enter queues
  deterministic valid `FAKE` `sk-`/`ghp_` values. The `sk-` key straddles the 200-character display boundary:
  `#queue .preview` (the actual queue-preview surface) must mask before truncation, and its full `title` must mask
  both keys, including the second wholly beyond the preview. Preview text is noninteractive with no eye/reveal
  buttons; existing Edit opens the exact raw value, Cancel retains it, Save restores the masked preview/title,
  and the actual second provider request receives the exact saved raw text with no cancelled edit.
  Actual composer input/Enter submits `/goal <FAKE objective>`; the Command input bubble and `.hc-args` must
  mask both keys, including after history reload, while `GET /api/goal` returns the exact raw objective.
  **Goal result `.hc-text` and goal bar are intentionally OUT; this is not whole-screen privacy or backend,
  log or transport redaction.** A private final profile patch removes `goal-driver`, no automatic goal round is
  planned, `--max-rounds 1` caps explicit turns, and the double refuses calls beyond the two queue turns.
  Named sessions avoid title calls; the private child environment inherits no provider/proxy/HEDDLE overrides.
  Startup, hold response, request/body consumption and browser/CLI/provider cleanup are bounded; standard
  `HEDDLE_VERIFY_UI=0` skips before fixtures. Existing part 1/provider/Copy checks are not duplicated.
  No real keys, live Settings/auth files or host/private key data are read. Source/menu-owner review and both
  delivered-build execution gates belong to the parent; this entry records authored intent, not runtime proof.
- [`check-context-view.mjs`](check-context-view.mjs) — how a session's context was composed: the report
  per session, its provenance, and the span a compaction stands in for.
- [`check-file-view.mjs`](check-file-view.mjs) — a source file drawn as source with a language from its
  extension, and a file's own script tags shown rather than obeyed.
- [`check-runtime-context.mjs`](check-runtime-context.mjs) — a mode change as a **trajectory fact**: the
  Trajectory view names the runtime-context snapshots (with each policy text in its details pane) while the Chat
  view does not draw them as turns, so a reader after the fact can see the expectation changed and what it became.
- [`check-approval.mjs`](check-approval.mjs) — the approval card as a control: it appears when a call asks for a
  wider mode, carries the model's justification verbatim, Allow once runs the one denied call, Reject leaves it
  undone, and the session's own mode never moves; and the session rows: a waiting session says `Approval` with a
  warning dot, a turn that ends off screen leaves a done dot until the session is opened, and a session below the
  fold of a long workspace comes into view while it waits and stays there after its turn ends (DSH's Show more
  watermark, raised by an attention-bearing row and never lowered on its own).
- [`check-access.mjs`](check-access.mjs) — the access-mode chip as a control: its reference anatomy (shield,
  label, chevron), the menu with a checked current entry, the pending state of a change, the full-access risk
  gate, a reload coming back to the session's mode, and the server refusing an unconfirmed escalation.
- [`check-workspaces.mjs`](check-workspaces.mjs) — the left column's workspace controls, add, rename and delete, at
  DSH parity: registering a folder over the API the dialog posts to, the refusals that keep the controls honest
  (a rename to another workspace's name is `409 workspace/name-conflict`), delete removing the registration while its
  sessions move to Ungrouped, the split between a chosen root and one adopted because a session ran in it, the
  folder chooser's `/api/directories` routes, and a browser driving the *Select Workspace Directory*, *Rename
  workspace* and *Delete workspace* dialogs end to end; with the server gone, *Add workspace* and *New session* say
  that they failed (the dialog's alert line, `New session failed: …`) instead of leaving an unhandled rejection; and
  *Rename* or *Delete workspace* on a row another client already removed says *This workspace was already removed.*
  (never the server's `no workspace <absolute path>`), leaves nothing to confirm and redraws the tree without the row.
- [`check-subagents.mjs`](check-subagents.mjs) — a subagent's session at DSH parity (R-developer-eight-26, -1, -28,
  -2): a delegated one-shot child, the newest session in the store, is never what a first start opens (it opens and
  creates none, #17, #142), the search and the one-column list leave it out as the tree does, a reload reopens the
  session that was open, and the child, opened, shows DSH's read-only record (*One-shot subagent record*) in place of
  the composer, which an ordinary session gets back.
- [`check-workspace-tree.mjs`](check-workspace-tree.mjs) — the left column as DSH's workspace tree: `GET
  /api/workspaces` naming each workspace's parent and the sessions whose nearest root it is, then a browser seeing a
  nested workspace before its parent's sessions, five sessions newest first with `Show {n} more sessions` / `Show
  less` (the open New session drawn on top of the five), Ungrouped last for a session no registered workspace owns,
  the open session's row selected and its workspace tinted, a workspace's `+` starting a session there, New session
  starting in the workspace row the person opened rather than the open session's, an open session another client
  archives let go as DSH's `clearArchivedCurrent` lets it go, with New session then starting where it lived, not in
  the last remembered folder (#119, #139 B1), the
  `Workspace` grouping drawing sibling sections, and a new session reading DSH's `New Session` in the tree with no id
  and no title in the header, then the row, the header and the window title (`<title> — Heddle`) following its title
  as it is written;
  and the Session Intent hero's workspace picker (C36): over a blank session a `Choose workspace` chip naming its
  workspace, a menu with the current one checked and `Add workspace…` last, DSH's menu keys, and a pick that moves the
  new session and its draft so the first prompt runs in the picked workspace; and a first visit (#17, #142) opening no
  session and creating none, counted by `/api/sessions`, never the newest session another person is in, and with two
  workspaces and another client's newer activity in one of them the composer reading *Choose a workspace to start*;
  after a person opened a session in A, a reload with the saved entry cleared aiming the hero, the note and the first
  message at A (`heddle.workspace.last`), not at B where the server was active last; with one workspace, aiming at it;
  a New session pressed the moment the reloaded page draws its row opening a blank, the one selected row, that offers
  no menu, no Archive or Pin and no double-click rename, whose fork chord says DSH's *This session has no completed
  turn* (#79); and a session row whose session can no longer be read (its log and metadata moved out of the
  store under an open page) opening to DSH's one line *Failed to load history: {message} (404)*, the header and the
  disabled composer reading *Session unavailable*, no request sent by a draft, Enter, submit or Send, the stale row let
  go, and a reload opening and creating nothing rather than showing the failure again (#56, ported from
  developer-six's 4cd4cafb); and first use on an empty home (#134): the hero chip and the note naming *Default
  workspace* on the first load and again after a reload before anything is sent, and the first message running in
  `<home>/default-workspace` with a row under Default workspace and the header naming it, never in the server's start
  folder; with no workspace at all (the Default workspace made and deleted), the composer reading DSH's *Choose a
  workspace to start*, Send disabled, Enter refused with *Choose a workspace first.* and opening Add workspace, and no
  session started; and *Archived only* with nothing archived, in the tree and in one list, showing DSH's
  placeholder *No archived sessions yet* with its *View other sessions* action (not the no-roots note), the action
  setting *Hide archived* back and drawing the rows again (#107); a session in the nested workspace named after
  that workspace, not the root above it, in a search hit and in an `In one list` row (#57); its search matching a
  title or a workspace name, never a New session placeholder, twenty at most, revealing a chosen hit, and, while
  `/api/sessions` fails, listing the rows the tree holds rather than "No matching sessions", then reading again on the
  next search (#58); and a folder the server may not read (`chmod 000`) opening to DSH's one line *Read failed: cannot
  list "locked": permission denied* with no rows, never *nothing inside*, a readable sibling still listing its file,
  and a workspace whose own folder it may not read keeping its session and its *Files* heading over the same line
  (#106); and a reload into a session in a nested workspace opening its ancestor and its own workspace, only the
  latter saved open, while a fold the person made of the ancestor, and then of the session's own workspace, each
  survive a reload, tinted, with the row hidden (C33, DSH's groupExpansion). The page opens no session on its own, so a
  check that reads a seeded session opens it by name
  (`gotoSession`, [`browser.mjs`](../../_tools_/verify-runner/browser.mjs)).
- [`check-content-search.mjs`](check-content-search.mjs) — the sidebar's content search (R-developer-eight-19): a
  name match shown at once under DSH's "Searching session history…" status, one host query 250 ms after the last of
  four keystrokes, the session found only inside its answer joining the hits with its snippet, "No matching
  sessions" only once the host has answered, and a content hit opening like any hit; a failed host request leaving
  the name matches with no warning of their own, and the same query asking the host again (#58).
- [`check-hover-cards.mjs`](check-hover-cards.mjs) — the sidebar's row hover cards at DSH parity (C22, C41), with a
  real pointer: a session row's card only after the 800 ms dwell, 8px right of the row, with the full title, the
  relative time, the session's own scheduled task (a scripted `schedule_create`) and its status; the workspace row's
  card opening at once in the warm list with its title, home-abbreviated folder and creation time; both copyable;
  none for Ungrouped; the card closing when the pointer leaves the list. And no tree row's title or description
  names a `_sessions_` definition folder or the home directory: the session row's tooltip is its display title (#109).
  And a session card's statuses in DSH's words and order (C22): *Waiting for answer* for a question that really waits,
  *Plan awaiting review* for a plan review, *1 subagent running* on a parent whose child's turn is held running, and
  *Completed* for a turn that ended unseen, each state confirmed through the API before its card is read.
- [`check-workspace-drag.mjs`](check-workspace-drag.mjs) — reordering workspaces by drag (DSH's
  `workspace/insertBefore`, C37): a workspace header dragged onto a sibling's section lands before or after it with
  the drop line drawn, the host stores the order (`GET /api/workspaces`) and a reload keeps it, while a nested
  workspace or Ungrouped is not a place a top-level workspace can land.
- [`check-session-archive.mjs`](check-session-archive.mjs) — unarchive and stop-and-archive at DSH parity
  (R-developer-eight-14, -13): an archived session restored from **Archived only** through its row menu, every item of
  which can be pressed across its whole width (nothing lies over the menu), and from **search**, where the archived
  result carries `Unarchive session` and choosing it says it cannot be opened without clearing the query; a quiet
  archive's undo notice; and a running session's archive asking first in DSH's dialog, listing the work the server
  named, Cancel leaving it running, Stop and archive stopping and archiving it, and undo restoring it; and the open
  session, archived from its own row or by another client, let go (nothing open, nothing kept to reopen) as DSH's
  `archiveSession` and `clearArchivedCurrent` let it go, the next message running as a new conversation in its
  workspace rather than vanishing into the archived session (#139 B1).
- [`check-archived-session.mjs`](check-archived-session.mjs) — an archived session row, drawn under *All
  conversations*, carries DSH's "Archived sessions cannot be opened. Unarchive it to view." as its accessible
  description, and clicking it says so and opens nothing, while a live row still opens (`dsh-client-ui-workspace`
  `guardedOpen`).
- [`check-tree-keyboard.mjs`](check-tree-keyboard.mjs) — the session tree from the keyboard, with the browser's own key
  events: Enter or Space on a row's `Pin session`, `Archive session`, `…` or `New session in` acts on that control and
  never opens the row (#98); a row is one Tab stop (a session row's `…`, Archive and Pin, then the next row, which
  Enter opens; a workspace row's `…` and New session in, then its first row), and `Show {n} more sessions` is a
  `<button>` whose `aria-expanded` follows Enter and Space with focus kept on it, and focus stays on a row's pin control
  through the tree redraws its pin and unpin cause (#92); and a session row's menu, a
  workspace row's menu and View options have DSH's `Menu` keyboard: ArrowDown enters at the first item, the arrows rove
  and wrap, Home and End jump, Tab enters and Shift+Tab closes onto the trigger, Escape closes and gives focus back to
  the trigger, and a choice made with Enter does the same (#95).
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
  DSH's Web chords drive it (S38, S42): Mod+Shift+B shows and hides it, the same tab coming back, and Mod+Alt+T opens
  another tab, from the composer and not behind a dialog; the keyboard reference lists both last; a default server
  takes neither key and lists neither.
- [`check-reconnect.mjs`](check-reconnect.mjs) — a change that reached the server just before the connection dropped
  shows once it is back, as DSH's re-acquired baselines show it (#91): a session rename and a nested workspace's
  *Delete workspace* whose answers arrive only after the browser went offline (DevTools' Offline, through the
  protocol) are drawn once it is back online — the new title, the workspace gone and its session under its parent —
  and a rename answered just before the server went away is drawn once the page's stream reconnects to it on the same
  port. Each time the tree's "could not read the workspaces" note goes, the Deleting… line is not left set, and no
  unhandled rejection reaches the console.
- [`check-shortcut-keys.mjs`](check-shortcut-keys.mjs) — the session shortcuts pressed through
  `Input.dispatchKeyEvent` with the `key` values Chrome delivers (on a Mac, ⌥⌘A arrives as `å` and ⌥⌘N as a dead
  key), matched on the physical key with DSH's `Mod`, Command on a Mac and Control elsewhere (R-developer-seven-7):
  search, sidebar, settings, new session, rename, fork and archive each act (⌥⌘O, add workspace, is pressed in
  `check-workspaces.mjs`); a held repeat runs once; an extra Shift, or Control in place of Command on a Mac, does
  nothing. Mod+/ opens DSH's keyboard reference and its search narrows it (S40); a binding recorded there replaces
  the default, survives a reload, and Restore default brings the default back (S41); a taken or refused chord leaves the
  keyboard on the recording row, so the next chord is recorded, and Remove and Restore default leave it on their row,
  or on the search field when a search for the old keys no longer matches the row (another tab's change too);
  two Escape presses within 500 ms stop the running turn, one press does not, and a queued message stays queued (S43).

**Isolation.** Every check starts its server with the fixture's own `HEDDLE_HOME`, never the operator's: the workspace
registry, the schedule store and the instructions are read from there. `check-model-switcher.mjs` set none, so every
run read and wrote the real `~/.heddle/workspaces.json` (a leak older than #17); while a first visit started a fresh
session in the most recently active workspace (#17, until #142), that session's definition landed in a real folder. It
now has its own, and the checks that isolated only `HOME` name `HEDDLE_HOME` too, so an exported one cannot reach the
real store.

## What it deliberately does not judge

- **How well a model reasons.** Nothing here scores an answer's quality; the checks
  ask whether the mechanism works.
- **Anything it has to spend to see.** Except where a check is named for the real
  backend, every fixture is local and the run is free.

## Page marker regression evidence

[`page-marker-evidence.md`](page-marker-evidence.md) records why the historical rail label was wrong
and the browser check that retains exact built-page identity alongside the minimap behaviour.
