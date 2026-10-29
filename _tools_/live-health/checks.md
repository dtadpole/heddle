---
title: Live health - the checks
level: L2
version: 1.5.0
description: What each check of a live-health pass claims - the deployment and the Rust preview - how it decides, and what its verdicts and exit codes mean.
status: unverified
grounded_in:
  - source: the live-monitor seat's responsibilities, 2026-10-22
  - source: the 96-deployment and 90-web-ui-token verifiers, whose claims the process, marker and door checks reuse
created: 2026-10-23T05:10:55Z
modified: 2026-10-29T10:00:00Z
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
| `turn` | a prompt streams (two or more chunks) and settles in the monitor's own session, per the server's session list; with `--deployment-conversation` a same-page follow-up must too | `turnVerdict`, `turnLanding`, `sameHealthSession`, `deploymentTurnWithConversation` |
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

**Verdicts.** Staleness against a fresh `origin/main` (`dirty`, `behind`, `ahead`) is recorded,
not failed. `passVerdict` fails on any failed check and is unjudged on any unjudged one: exit `0`
pass, `1` fail (a dead address included), `3` unjudged, never pinned as healthy.

**Privacy.** Paths are written `~`, tokens redacted (`redactRecord`), session ids never pinned.

