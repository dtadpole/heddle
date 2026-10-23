---
title: 'The live deployment''s measurements, 2026-10-22'
created: 2026-10-23T04:42:38Z
modified: 2026-10-23T04:57:13Z
level: L3
version: 1.0.0
description: The readings behind the deployment record — the bring-up proof, restart windows, the scratch rehearsals, the Rust branch and the gate.
status: unverified
grounded_in:
  - source: commands run on the owner's Mac, 2026-10-22, and _tools_/web-daemon/rehearse.sh output
---

# Measurements, 2026-10-22 (PDT)

**Bring-up, 20:12, `a5b0c66`.** `3082/healthz` 200; `8082/` 200; `8082/api/sessions` 200. The served page was
533,283 bytes against `dist/server/page.html` at 533,280; the difference is the marker filled with `dd6d45d28567`.
Without a token the page is 401; `?token=` answers 303 with an `HttpOnly` cookie, and the cookie opens page and API.
96 was 2 of 3 with main's checks (the checkout is not on branch `main`) and 3 of 3 with the branch's.

| Restart window at 3082 | Longest silence |
|---|---|
| a SIGKILL with the supervisor installed | about 1 s to a new pid |
| `install.sh --restart` on a job older than 10 s | 288–364 ms |
| `redeploy.sh` end to end (3.8 s) | 300 ms |
| `kickstart -k` on a job younger than 10 s | about 10 s (launchd's throttle) |
| a SIGKILL before the supervisor, nothing guarding | not back after 12 s |

One 3-of-3 pass of main's 95 at 20:32 came from the interim guard probing in the same second as the kill, not from
launchd: a real pass, not a repeatable one.

**Rehearsals** on the scratch agent (port 3096, own state and log). In every run the live server kept its pid and
token, and 8082 answered 200.

| Run | started | kill → new pid | guard during it | reinstall | agent gone → guard | 95 |
|---|---|---|---|---|---|---|
| 21:09 | 463 ms | 443 ms | no action | 635 ms | 1251 ms | — |
| 21:11 | 339 ms | 260 ms | no action | 349 ms | 1163 ms | — |
| 21:19 | 320 ms | 357 ms | no action | 426 ms | 1170 ms | 4/4 |
| 21:34 | 379 ms | 256 ms | no action | 477 ms | 1137 ms | 4/4 |

The first run, before the bootstrap fix, failed the reinstall claim (`5: Input/output error`).

**The Rust branch, about 21:20.** The lanes' release binary (sha256 `a355a0aa1fc4…`) through `HEDDLE_BIN`: started
failed after 20 s — `heddle: not ported to Rust yet: web`, exit 2 after 4 ms — and the other claims were unjudged.
At 21:43 main's own binary, built at `a2d4ae4` after the heddle-server merge, answered the same.

**The Rust preview, 21:52–21:56**, `b6995b6` on 3097: page and token flow work, a SIGKILL is restarted in 48 ms;
`/api/endpoints` 404 and `/api/tree` 503, and sessions and turns refuse, because only the model, sandbox and approvals
components have adapters on that branch.

**The gate, about 21:29**, its unchanged code on 8096 in front of a scratch heddle on 3096: killed under launchd
alone it stayed down at 2, 5, 10 and 15 s; under `supervisor.mjs` it was back in 400 ms and answered
`/api/sessions` through a fresh token handshake.
