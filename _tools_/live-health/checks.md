---
title: Live health - the checks
level: L2
version: 1.0.0
description: What each check of a live-health pass claims, how it decides, and what its verdicts and exit codes mean.
status: unverified
grounded_in:
  - source: the live-monitor seat's responsibilities, 2026-10-22
  - source: the 96-deployment and 90-web-ui-token verifiers, whose claims the process, marker and door checks reuse
created: 2026-10-23T05:10:55Z
modified: 2026-10-23T05:10:55Z
---

# The checks

A pass judges the address the owner uses, `8082`, and the server behind it, `3082`; the topology is in
[`outages.md`](outages.md). Each judgment is a function in [`rules.mjs`](rules.mjs) with a unit test.

| Check | The claim | Rule |
|---|---|---|
| `gate` | `8082/` serves the app shell; a gate error counts only as the gate's own 5xx sentence | `gateVerdict`, `looksLikeProxyError` |
| `process` | the process on the server's port runs the deployment checkout's `dist/cli.js` (`lsof`, `ps`); a `heddle` binary is unjudged, another checkout fails | `processVerdict` |
| `door` | a bare request gets `401` and the token form, and the current launch token (from `~/.heddle/web.log`) exchanges for a `303` with an `HttpOnly`, `SameSite=Strict` cookie | `doorVerdict` |
| `load` | the shell renders in the browser: log, composer and Send | `shellVerdict` |
| `marker` | the served `meta[name=heddle-page]` is the first twelve hex of the sha256 of the checkout's `dist/server/page.html`, and the served page is that file byte for byte | `markerVerdict`, `expectedPage` |
| `turn` | one prompt, typed with trusted input into the reused health session, gets an answer that streamed (two or more recorded chunks) and settled, against a baseline taken before the prompt | `turnVerdict` |
| `console` | no error-level message on load or after the turn; a reading that cannot be taken stays unjudged | `consoleVerdict` |
| `dsh` | the DSH reference on `8080` answers; its control counts are recorded beside heddle's | evidence only |

The deployment block records `head`, `branch`, `dirty`, `behind` and `ahead` against a freshly fetched
`origin/main`. Staleness is recorded, not failed.

**Verdicts.** `passVerdict` fails the pass on any verdict that is neither `pass` nor `unjudged`, leaves it
unjudged on any `unjudged`, and passes it only when every check passes. Exit `0` is pass, `1` fail (a dead
address included), `3` unjudged; an unjudged pass is never pinned as healthy.

**What the record carries.** Home paths are written as `~` and launch tokens are redacted at the boundary
(`redactRecord`); no session id is pinned.

## Read next

[`outages.md`](outages.md).
