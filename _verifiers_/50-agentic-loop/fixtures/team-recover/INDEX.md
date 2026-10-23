---
title: Recorded team-recover store
version: 1.0.0
description: A session store recorded from the TypeScript build at heddle commit a5b0c66, with two provisioning members and one queued message, replayed by check-teams.
grounded_in:
  - source: heddle commit a5b0c66, 2026-10-22, the TypeScript build that wrote these bytes
---

# `team-recover`

The input to the second check in [`../check-teams.mjs`](../check-teams.mjs): a store a previous process left behind —
a lead session with two members still `provisioning`, one of them with a resumable prompt, and one queued message.

| File | What it is |
|---|---|
| `session-recover-lead.*` | the team's lead: its meta and its log, holding the two `team/member` events and the `team/message/queued` event |
| `session-recover-active.*` | the member that can resume, with its own prompt in its own log |
| `session-recover-ghost.*` | the member that never got a child |

Recorded once from the TypeScript build at heddle commit `a5b0c66` (2026-10-22) by
`node _verifiers_/50-agentic-loop/fixtures/record-team-recover-store.mjs`. The check copies these logs **byte for
byte** and files the store under the workspace key of its own fixture folder, replacing only each meta's `cwd`. So the
harness under test boots on a store in the format a process wrote, without the check needing `dist/` in the lane.

Re-running the recorder changes the recorded `created` timestamps and the session ids it writes; it is not part of the
suite and should not be re-run to "refresh" the fixture.
