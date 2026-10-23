---
title: Verifier 15 — Deployment
created: 2026-10-18T03:44:42Z
modified: 2026-10-23T05:14:51Z
version: 2.0.0
description: the page the owner sees is the deployment checkout's build, served by a process running that checkout, and that checkout contains only committed main.
grounded_in:
  - source: owner statement 2026-10-17 that a worktree may carry initial verification but the job is not done until merged to main and the deployment is verified
  - source: owner report 2026-10-17 that the composer footer was not visible while every suite was green, because port 8082 served another worktree's build
---

# `96-deployment`

**The claim:** the owner's page is the **installed service's checkout's build** — the process behind the port runs
that build, the page is that checkout's page byte for byte, and the checkout contains only committed `main`.

Beside [`95-web-daemon`](../95-web-daemon/INDEX.md), which judges that a daemon exists and recovers, this judges
**which checkout it serves**; the two failures look identical from the source tree.

**No browser, no build.** It reads the process owning the service's port and compares one HTTP response with the
built page on disk, through [`service.mjs`](../../_tools_/web-daemon/service.mjs). It never kills anything, so it runs
against the live deployment on every redeploy.

| Check | Decides |
|---|---|
| the live service runs the checkout's build | the right process serves |
| the page the owner sees is this build | the right page is served |
| the checkout contains only committed main | the right source is deployed |

```bash
sh verify.sh            # 0 holds, 1 fails, 3 unjudged; --list, --json
```

**Why it exists:** the owner twice saw an old composer footer while every suite was green, because the service had
been repointed to another worktree. It judges the
[`landed-and-deployed`](../../_conventions_/landed-and-deployed/INDEX.md) convention.

## Read next

[`checks.md`](checks.md) for each check and its rules; [`readings.md`](readings.md) for the measured verdicts.
