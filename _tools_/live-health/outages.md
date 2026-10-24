---
title: Live health - outages and restarts
level: L2
version: 1.1.0
description: How a live-health pass tells a restart from an outage, names the hop that failed, and why it reports instead of restoring.
status: unverified
grounded_in:
  - source: live-deploy's measurements of the supervisor and the gate on this Mac, 2026-10-22
  - source: decision D-045 in the team's decision log, 2026-10-22
created: 2026-10-23T05:10:55Z
modified: 2026-10-24T06:17:06Z
---

# Outages and restarts

**Topology.** `8082` is the heddle web gate, its own launchd agent (`ai.reflection.heddle-web-gate`). It
reads the deployment's launch token from `~/.heddle/web.log`, exchanges it for the server's cookie and
forwards to `3082`. `3082` is the deployed server (`com.dtadpole.heddle-web`); a supervisor inside that
agent puts a killed server back in about a second.

**A restart is not an outage.** A pass that reads the address down watches it for 20 s, read-only, until
both the server's health route and the gate's page answer (`classifyOutage`). Recovery inside the window
is pinned as `outage.kind = restart`, and the gate, process and door are re-read with the new launch token;
the lane gate's `95-web-daemon` kill test produces exactly this. Only a reading that stays down is an
outage. Three restarts in consecutive passes are a crash loop.

**Which hop failed.** `outageHop` names it: `gate` when 8082 refuses connections while 3082 answers - the
gate process is gone, and nothing on this Mac restarts it; `server` when 3082 is silent (the gate's 502 is
the same fact); `both` when neither answers. The launchd state of both agents is recorded with it, read
with `launchctl print`.

**It never restores.** Under D-045 the live page has one restore chain: the supervisor, then live-deploy's
guard. An outage is alerted at once to live-deploy and the coordinator, with its hop and both agents'
states. The kickstart this tool once had was removed, not disabled, after two of
its restores ran inside live-deploy's installs; that history is in
[`live-health-incidents-2026-10-22.md`](../../_context_/rust-port/live-health-incidents-2026-10-22.md).

## Read next

[`checks.md`](checks.md); the record in
[`../../_context_/rust-port/live-health.md`](../../_context_/rust-port/live-health.md).
