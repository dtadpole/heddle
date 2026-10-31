---
title: Live health - the checks
level: L2
version: 1.9.0
description: What each check of a live-health pass claims - the deployment and the Rust preview - how it decides, and what its verdicts and exit codes mean.
status: unverified
grounded_in:
  - source: the live-monitor seat's responsibilities, 2026-10-22
  - source: the 96-deployment and 90-web-ui-token verifiers, whose claims the process, marker and door checks reuse
created: 2026-10-23T05:10:55Z
modified: 2026-10-31T01:30:00Z
---

# The checks

A pass judges `8082`, the server behind it on `3082` (topology in
[`outages.md`](outages.md)) and the Rust preview on `3097`; each judgment is a tested function in
[`rules.mjs`](rules.mjs).

| Check | The claim | Rule |
|---|---|---|
| `gate` | `8082/` serves the app shell; a gate error means the gate's own 5xx sentence | `gateVerdict`, `looksLikeProxyError` |
| `process` | the server's port runs the checkout's `dist/cli.js`; a `heddle` binary is unjudged, another checkout fails | `processVerdict` |
| `door` | a bare request gets `401`; the launch token from `~/.heddle/web.log` gets a `303` and an `HttpOnly`, `SameSite=Strict` cookie | `doorVerdict` |
| `load` | the shell renders: log, composer, Send | `shellVerdict` |
| `marker` | the served page is `dist/server/page.html` byte for byte, its `meta[name=heddle-page]` that file's sha256 prefix | `markerVerdict`, `expectedPage` |
| `turn` | a prompt streams (two or more chunks) and settles in the monitor's own session, which the server lists in the monitor's own workspace; with `--deployment-conversation` a same-page follow-up must too | `turnVerdict`, `turnLanding`, `sameHealthSession`, `deploymentTurnWithConversation` |
| `console` | no error-level message on load or after the turn; an unread console is unjudged | `consoleVerdict` |
| `dsh` | the DSH reference on `8080` answers; counts recorded beside heddle's | evidence only |
| `preview` | its own session store, token link `303`, `/api/endpoints` and `/api/tree` `200`, a fixture turn and a two-message conversation, or one real turn (D-052) | `previewVerdict`, `previewTurnVerdict` |

**The preview is read-only and separate:** its own launch link, only statuses, sizes and counts pinned,
a verdict that never changes the deployment's. Endpoints are pinned by kind only, never by name,
because a machine's endpoint names can carry private literals (public-hygiene gate). A turn goes only when
no session id is shared with `3082` (`sharedSessions`). Its conversation counts once its build contains the
follow-up fix `4da44cf` (`conversationVerdict`), and only for fixture turns.

**Fixture turn or real turn (D-052, 2026-10-29).** Each target's turn reads that target's own
`/api/endpoints`. When it lists only the offline fixture (`fixtureOnly`), the turn is the fixture
turn, as before. Otherwise the machine has a real configuration. The coordinator decided that each
target then gets **one minimal real turn per pass**:

- **Model:** `deepseek-official/deepseek-flash` (`REAL_MODEL`, overridable with `--real-model=e/m`),
  at the lowest effort it declares (`lowestEffort`, `realModelChoice`).
- **How it is selected:** recorded on the monitor's own session through the model seat's own menu,
  as a person chooses (`expectedSeatLabel` proves the seat reads it). Then a one-line prompt asks for
  a one-word reply.
- **What is judged:** completion and latency (first delta, settle, the stream's completion where the
  server records it), never the wording.
- **No fallback:** if that model cannot be selected or answered, the turn fails with the reason; no
  other model is tried.
- **No follow-up:** the preview sends no follow-up. Its conversation is recorded `not-sent`, never
  judged.
- **A fresh session each UTC day:** a real model is sent the whole session as context, and the reused
  8082 session held about 478 fixture turns by 2026-10-29. That day a real turn's first delta rose from
  about 2 s to 24 s. So a real-model pass retires a health session created before the current UTC day
  and starts a new one with the page's New session control (`healthSessionExpired`, recorded as
  `session.retired`). That is at most one new session per target per day. The retired session is left
  as it is. Only a session the server newly lists after New session is the monitor's own. On
  2026-10-29 at 11:35Z, 8082's New session opened an existing empty session someone else had created.
  It listed no new id, and a turn written there landed `other`. So a New session that lists nothing new
  sends no turn. `--no-deployment-turn` pauses the deployment's turn alone until the coordinator
  answers.
- **8082's real turn has its own workspace and session** (the coordinator's option b, 2026-10-29). The
  monitor's own folder `~/.heddle-live-monitor/health`, under no user workspace, is registered on the
  deployment (`POST /api/workspaces`, idempotent). The session is created there with `POST /api/sessions`
  and titled `live health check <UTC date>`; its id comes from the reply. The model is recorded with
  `POST /api/sessions/<id>/model`, and exactly that id's tree row is opened in the page.
  - The day's id is kept in `~/.heddle-live-monitor/state.json` and used again only while it is the
    same UTC day and the server still lists it (`--health-session=pass` makes one every pass).
  - Nothing on 8082 is chosen by title, so no session someone else made can be adopted.
  - When the day rolls over, the previous day's id from the state file is archived once the new
    session exists (`POST /api/sessions/<id>/flags {archived: true}`, recorded as
    `session.previous`). Archiving hides it from the tree and deletes nothing. Only an id the monitor
    created is ever archived.
- **The preview's real turn has its own workspace and session too** (hd-coordinator, 2026-10-31).
  The page's New session takes the open session's workspace, and the page opens the newest session
  of any workspace. On 2026-10-30 and 2026-10-31 that put the preview's health session in two
  testers' workspaces. So the preview now uses the 8082 path above on `3097`'s own API: the same
  folder is registered there, and the session is created by that path and recorded under its own
  key in the state file (`preview`, beside `deployment`). The page's New session is used only for a
  fixture turn.
- **Placement is checked before every real turn, on both targets** (`ownSessionPlaced`). The
  server's own session list must show the id with `cwd` equal to the health folder. Otherwise no
  turn is sent, and the turn is unjudged with the reason. A created id is recorded at once, so a
  failing check never makes a new session each pass. The previous day's id is archived only after
  the new one is confirmed in place.

**Verdicts.** Staleness against a fresh `origin/main` (`dirty`, `behind`, `ahead`) is recorded,
not failed. `passVerdict` fails on any failed check and is unjudged on any unjudged one: exit `0`
pass, `1` fail (a dead address included), `3` unjudged, never pinned as healthy. The checkout is read
again at the end of a pass. When its head or built page moved since the start (a redeploy inside the
pass, as on 2026-10-29 at 11:08Z), the move is recorded in `deploymentMoved` and every failure becomes
unjudged with the move named (`deploymentMove`, `acrossMove`). The next pass judges the new build in full.

**Privacy.** Paths are written `~`, tokens redacted (`redactRecord`), session ids never pinned.

