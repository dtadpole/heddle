---
title: Web daemon — liveness, the request fence, the token, and restarts after a build
created: 2026-10-23T04:42:38Z
modified: 2026-10-23T04:42:38Z
level: L3
version: 1.0.0
description: How the service's liveness is decided, why cross-site reads pass the request fence, how the per-process launch token behaves under a supervisor, and why a build is invisible until a restart.
status: unverified
grounded_in:
  - source: src/server/web.ts and src/server/token.ts
  - source: owner reports and measurements of 2026-10-11 and 2026-10-17
---

# Liveness, the request fence, the token, and restarts after a build

**Liveness is port ownership**, never a process-name search: `pgrep -f` matches the searcher's own command line and
was measured calling a dead service up. A bound port cannot be satisfied by our own argv or twice. `GET /healthz`
answers the service's name and port and **nothing else**, because it is the one route reachable without a token.

**The request fence.** heddle refuses a request whose `Host` is not loopback or whose `Origin` names another
authority. A cross-site request may read (`GET`, `HEAD`) and may not change anything. That split is a correction: a
viewer embedding the page in a sandboxed iframe has an opaque origin, so the browser marks its requests cross-site,
and the first fence left heddle unreachable from the sidebar it was meant to be watched in. Reads are safe because
the credential cannot travel: the session cookie is `SameSite=Strict`, and the same read without it is a `401`. A
write must name this authority; an opaque origin's `null` matches nothing. The gate forwards the caller's
`Sec-Fetch-Site` untouched, so it is not a workaround for the fence.

**The token.** The launch token is minted per process and never stored; each supervised restart prints a new one into
the log, and the installer prints the command that reads the newest one.

**A build is visible only after a restart.** The page and every module are read when the process starts. After
`npm run build` or a new binary, restart the service (`install.sh --restart`, or [`redeploy.sh`](redeploy.sh) for the
deployment). On 2026-10-17 the owner saw rounded panes and a duplicated assistant row after the fixes were committed;
the process predated the build, and a restart showed the fixed page with no code change. A stale process looks
exactly like a broken fix.
