---
title: Live health - the checks
level: L2
version: 1.3.0
description: What each check of a live-health pass claims - the deployment and the Rust preview - how it decides, and what its verdicts and exit codes mean.
status: unverified
grounded_in:
  - source: the live-monitor seat's responsibilities, 2026-10-22
  - source: the 96-deployment and 90-web-ui-token verifiers, whose claims the process, marker and door checks reuse
created: 2026-10-23T05:10:55Z
modified: 2026-10-24T06:03:08Z
---

# The checks

A pass judges the owner's address, `8082`, and the server behind it, `3082` (topology in
[`outages.md`](outages.md)), then the Rust preview on `3097`. Each judgment is a tested function in
[`rules.mjs`](rules.mjs).

| Check | The claim | Rule |
|---|---|---|
| `gate` | `8082/` serves the app shell; a gate error means the gate's own 5xx sentence | `gateVerdict`, `looksLikeProxyError` |
| `process` | the server's port runs the checkout's `dist/cli.js`; a `heddle` binary is unjudged, another checkout fails | `processVerdict` |
| `door` | a bare request gets `401`; the launch token from `~/.heddle/web.log` gets a `303` and an `HttpOnly`, `SameSite=Strict` cookie | `doorVerdict` |
| `load` | the shell renders: log, composer, Send | `shellVerdict` |
| `marker` | the served page is `dist/server/page.html` byte for byte, its `meta[name=heddle-page]` that file's sha256 prefix | `markerVerdict`, `expectedPage` |
| `turn` | a prompt streams (two or more chunks) and settles in the monitor's own session, as the server's session list proves | `turnVerdict`, `turnLanding` |
| `console` | no error-level message on load or after the turn; an unread console is unjudged | `consoleVerdict` |
| `dsh` | the DSH reference on `8080` answers; counts recorded beside heddle's | evidence only |
| `preview` | its own session store, token link `303`, `/api/endpoints` and `/api/tree` `200`, a fixture turn, a two-message conversation | `previewVerdict`, `previewTurnVerdict` |

**The preview is read-only and separate:** its own launch link, only statuses, sizes and counts pinned,
a verdict that never changes the deployment's. A turn goes only when `/api/endpoints`
lists just the offline fixture (`fixtureOnly`) and no session id is shared with `3082`
(`sharedSessions`). The conversation counts only once the preview's build contains the follow-up-turn fix
`4da44cf` (`conversationVerdict`).

**Verdicts.** Staleness against a fresh `origin/main` (`dirty`, `behind`, `ahead`) is recorded,
not failed. `passVerdict` fails the pass on any failed check and leaves it unjudged on any unjudged one: exit `0`
pass, `1` fail (a dead address included), `3` unjudged, never pinned as healthy.

**Privacy.** Paths are written `~`, tokens redacted (`redactRecord`), session ids never pinned.

