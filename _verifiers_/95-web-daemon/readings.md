---
title: 95-web-daemon — readings
created: 2026-10-23T04:42:38Z
modified: 2026-10-23T06:54:50Z
level: L3
version: 1.2.0
description: The measured verdicts of 95-web-daemon on the Linux host and on the owner's Mac, against the deployment, an absent service, a scratch service and the Rust binary.
status: unverified
grounded_in:
  - source: runs of _verifiers_/95-web-daemon/verify.sh and _tools_/web-daemon/rehearse.sh, 2026-10-22
---

# Readings

| When (PDT, 2026-10-22) | Against | Verdict |
|---|---|---|
| before the move to the Mac | Linux deployment host, the unit `install.sh` renders, TypeScript build on 8082 | 4 of 4 |
| 20:4x | the Mac's deployment at `51f198b`, the agent running `supervisor.mjs` | 4 of 4; a SIGKILL of the port's process left a new pid answering within 1 s |
| about 20:51 | the deployment at `1bcff7e` with the agent booted out | verdict 3: the two definition checks pass, the live and stays-up checks are unjudged |
| 21:19 and 21:34 | a scratch service installed by `rehearse.sh` | 4 of 4, the live server's pid unchanged |
| about 21:20 | the lanes' release binary through `HEDDLE_BIN`, by `rehearse.sh` | not judged: the service never started (`heddle: not ported to Rust yet: web`, exit 2), so all four checks were unjudged |
| 21:43 | main's own binary (`a2d4ae4`, heddle-server merged; sha256 `b9decd764dba…`) | the same: `web` exits 2 after 6 ms, all four checks unjudged |
| 22:42 | main's binary after `heddle web` merged (`e3f9d91`, built in integrator-one's lane at `452c02b`; sha256 `934f4604699c…`) | **4 of 4 on the scratch service**; the rehearsal's eight claims all held, the hung binary replaced in 7,952 ms |
| 23:54 | developer-two's `09a3f14` (debug, every capability advertised; sha256 `c4f5f67c6ab6…`), at its request | **4 of 4 on the scratch service**; the rehearsal's eight claims all held |

**Part 11 through `HEDDLE_BIN` holds since 22:42**, judged on a scratch service with
`HEDDLE_BIN=<binary> sh _tools_/web-daemon/rehearse.sh`. Serving the binary on the owner's page, which is what
`96-deployment` would then judge, switches with `HEDDLE_BIN=… sh _tools_/web-daemon/install.sh --restart` from
`~/heddle-live`.

Before the supervisor, 95 could not pass reliably on the Mac: launchd did not restart a killed agent, and one 3-of-3
pass came from an interim guard's probe landing in the same second as the kill. That history and the measurements
behind it are in [`../../_tools_/web-daemon/launchd-on-this-mac.md`](../../_tools_/web-daemon/launchd-on-this-mac.md).
