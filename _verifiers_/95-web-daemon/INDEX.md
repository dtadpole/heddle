---
title: Verifier 11 — Web Daemon
created: 2026-10-11T20:54:23Z
modified: 2026-10-23T05:14:51Z
version: 2.0.0
description: a supervised user service keeps the Web UI running at the documented port, survives a kill, and does not weaken the token — judged on the deployment or on a scratch service.
grounded_in:
  - source: owner statement in the dsh session, 2026-10-11, asking for a daemon on 3082
  - source: rust/ULTIMATE_GOAL.md part 11, the same daemon pointed at the binary
---

# `95-web-daemon`

**The claim:** the harness is arranged to be running at the documented port without anyone starting it, and the
arrangement holds on any machine that installs it. Beside [`80-web-ui`](../80-web-ui/INDEX.md), which judges the
server, this judges the **daemon**: definition, installer, restart, and port-based liveness.

**No browser.** It reads the repository, the platform's supervisor and the port through
[`service.mjs`](../../_tools_/web-daemon/service.mjs).

| Check | Decides |
|---|---|
| agent definition | the macOS agent and installer are complete |
| Linux unit | the systemd unit and installer are complete |
| this machine runs it | the installed service owns the documented port and still requires a session |
| it stays up | a killed port owner is replaced by a new pid within 20 s |

The last check kills the server, so it runs on a scratch service (`HEDDLE_WEB_LABEL`, via
[`rehearse.sh`](../../_tools_/web-daemon/rehearse.sh)), never on the owner's page.

```bash
sh verify.sh            # 0 holds, 1 fails, 3 unjudged; --list, --json
```

Not judged here: a browser rendering, which checkout is served ([`96-deployment`](../96-deployment/INDEX.md)), and
the token ([`90-web-ui-token`](../90-web-ui-token/INDEX.md)).

## Read next

[`checks.md`](checks.md) for each check, the scratch service and the Rust branch; [`readings.md`](readings.md) for the
measured verdicts.
