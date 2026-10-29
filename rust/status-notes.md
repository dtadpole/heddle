---
title: Notes behind the Rust port's status
created: 2026-10-24T05:50:00Z
modified: 2026-10-29T05:45:00Z
level: L3
version: 1.0.1
description: The rule that admits failing checks, the intermittent and fixed checks with the code that owns them, and the seam the figures rest on.
status: unverified
grounded_in:
  - source: lane gate runs and reproduction loops in ~/heddle--int-backend on the owner's Mac, 2026-10-22 to 2026-10-23
  - source: the ui lane's readings, _verifiers_/80-web-ui/readings.md at 709bee6
---

# Notes behind the status

**The rule.** Since `b72cc1a` the binary advertises `web`, `--turn`, `--stream`, `context`, `tools`, `hooks` and
`models`, so checks that skipped at their capability probe are judged: 91 turned into passes, and none of the 21
passing before stopped passing. Under D-048 a merge may open failing checks if it turns one into a pass, breaks none,
and [`status.md`](status.md) names each failure with the code that owns it.

**The ui parts on `42c6b3f`'s binary**, 88 of 90: the default-port check fails because this Mac's live deployment holds
that port; `88-file-preview`'s html preview times out waiting for the preview (owned by `heddle-web-files`; the ui lane
read 88 in full on `33407a4`, so it is to be confirmed there).

**Intermittent, through the binary:** `50/check-teams`' restart check failed once under load in the gate of `0199453`
and passes alone on both builds (and in the run on `0199453`).

**Intermittent in the ui parts:** `check-chat-view` #11, a scroll race between page and check, seen on the
TypeScript build too; #16, not yet root-caused (owned by `web.rs` and `heddle-server`;
[readings](../_verifiers_/80-web-ui/readings.md)). `check-goal` #1 was a torn read
of session metadata: since `42c6b3f` `heddle-session` and `heddle-workspace` replace those files atomically, and a
probe measured missing reads fall from 377 in 8658 to 0 in 25486.

**Fixed:** part 7's last failure, at `e69f552` — `web.rs` now falls back to the first endpoint, as
`src/llm/service.ts` does. In the checks: `check-teams` parsed metadata mid-write (`456ca5c`: 4 of 22 runs failed before,
14 of 14 passed after); the session-shortcuts script outran the browser protocol's 10 s call limit, and now polls within
a budget (`227a600`). The lane gate re-runs a file that regresses and names a check passing on the re-run flaky.

**In place:** rust 1.99.1, the workspace, and `HEDDLE_BIN`, the seam the checks reach the binary through
(`_tools_/verify-runner`: helper rules 16 of 16, lane rules 14 of 14). Part 0 passes through component manifests;
parts 4 and 6 load tools and hooks as processes. No backend crate or the binary has a `todo!(`; `heddle-web-files`
has two. No backend verifier imports `dist/`, and each probe asks for every command its check runs.
