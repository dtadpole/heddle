---
title: Live health - the record
level: L2
version: 2.0.0
description: The pinned record of the live heddle deployment's health - what each entry holds, how to read it, how often it grows, and where its incidents are told.
status: unverified
grounded_in:
  - source: the live-monitor seat's responsibilities, 2026-10-22
  - source: the passes pinned in live-health.jsonl since 2026-10-22
created: 2026-10-23T03:19:02Z
modified: 2026-10-23T05:10:55Z
---

# Live health - the record

**The record is [`live-health.jsonl`](live-health.jsonl)**: one JSON object per pass of
[`_tools_/live-health`](../../_tools_/live-health/INDEX.md), appended every 20 minutes by the monitor's
schedule and committed by the pass that wrote it. It is append-only; a correction is a new entry or a note
here, never an edit of a published line.

```bash
node _tools_/live-health/summary.mjs --last=12   # the newest passes as a table
```

**An entry holds** the time, the deployment block (commit, branch, dirty, behind and ahead against a
freshly fetched main), each check's verdict and detail, the outage record when the address was down, the
DSH reference counts and the pass verdict. What each check claims is in
[`checks.md`](../../_tools_/live-health/checks.md); how a down reading is classified is in
[`outages.md`](../../_tools_/live-health/outages.md).

**Reports.** The schedule reports only on change: a new failure or a recovery to live-deploy, integrator-two
and the coordinator; an outage to live-deploy at once; staleness after two consecutive entries.

**Two fields in early entries are historical.** Entries before `2c8168e` record `gate.proxyError: true`
and `turn.samples` from the previous answer, both from instrument holes since fixed. Their verdicts were
unaffected, and published entries are not rewritten.

**Not in the record:** home paths (written as `~`), launch tokens, session ids and screenshots - a capture
would carry the owner's workspace and session names into a public repository.

**DSH reference counts**, numbers only, move with content. At equal content heddle shows 46 interactive and
18 enabled controls, DSH 139 and 17, with one hit-test miss and one clip on DSH's own gated surfaces; a move
at equal content is a finding for the ui lane.

The first evening is told in
[`live-health-incidents-2026-10-22.md`](live-health-incidents-2026-10-22.md).
