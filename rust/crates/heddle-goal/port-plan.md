---
title: The heddle-goal port plan
created: 2026-10-23T00:55:27Z
modified: 2026-10-24T06:19:40Z
level: L1
version: 1.0.0
description: The steps of the port and what each landed.
status: unverified
grounded_in:
  - source: rust/ULTIMATE_GOAL.md
  - source: src/goal/service.ts, src/goal/tool.ts, src/goal/driver.ts, src/plugins/goal-tool.ts, src/plugins/goal-driver.ts, the /api/goal branches of src/server/web.ts and the goal command of src/cli.ts, read 2026-10-22
  - source: _verifiers_/80-web-ui/check-goal.mjs
---

# The heddle-goal port plan

| Step | What | State |
|---|---|---|
| 1 | Public API, docs | landed |
| 2 | Decode, fold, event body, the service and its activation rule — every case of `test/goal.test.ts` | landed |
| 3 | The driver, the trigger and the boot sweep on Tokio — every case of `test/goal-driver.test.ts`, including the reentrant pass and the yield between rounds | landed |
| 4 | The tools, the routes and the command renderings, byte for byte with the TypeScript build | landed |
| 5 | Swap the doubles for `heddle-session`'s store (`SessionLog` is implemented for `SessionStore`), `heddle-agent`'s turn and `heddle-tools`' types | the store and the turn (`AgentRoundRunner`): landed; the tool types are wrapped by the boot |
| 6 | `check-goal` through `HEDDLE_BIN`, the restart case included | with the server and the binary |

## Read next

[`INDEX.md`](INDEX.md) for the crate.
