---
title: Where the heddle-workspace port stands
created: 2026-10-23T00:55:27Z
modified: 2026-10-23T08:24:41Z
level: L1
version: 1.0.0
description: What is merged and tested, what answers through the binary, what waits on whom, and the next step.
status: unverified
grounded_in:
  - source: rust/ULTIMATE_GOAL.md
  - source: src/workspace/service.ts and src/session/tree.ts, the TypeScript sources it ports
  - source: _verifiers_/70-workspaces-sessions/check.mjs and _verifiers_/80-web-ui/check-workspaces.mjs, the checks that judge it
---

# Where it stands, 2026-10-22 (evening)


**Merged.** Steps 1–5 are on `main` (integrator-one, through `b0ef8ab`). `b51e3a1` (the command entry
point) waits for the next candidate on `hd/developer-eight`.

**Tested.** `cargo test --manifest-path rust/Cargo.toml -p heddle-workspace`: **48 unit tests** and **4
cross-crate tests** in [`tests/verifier_shape.rs`](tests/verifier_shape.rs) that hold
`70-workspaces-sessions`'s claims at the seam the command line calls; `rustfmt` and `clippy -D warnings`
clean. The tree's fixture is the verifier's own shape: classification and badges, folders before files,
plumbing and generated folders, instance-only sessions, hoisted `_sessions_` rows, the captured-session
suppression, the archived filter and the virtual root's `adHoc` group.

**Answers.** [`src/command.rs`](src/command.rs) answers `workspaces`, `workspace add|list|remove|rename`,
`tree`, `file` and `session new` (here, not in `heddle-session`, because it needs both services) in the
D-043 convention, with `describe_tree` ported from the CLI. Text and sentences are `src/cli.ts`'s byte for
byte — including a rename without a positional being refused with the add sentence — and path arguments
resolve against `Context::cwd`, never the process's directory. Sixteen tests across the two command
modules are built from the verifier's expectations; a padding mutation in `describe_tree` fails two.

**Waits on.** developer-two's dispatch lines and the workspace row's adapter, then every other row of
`heddle.patch.yml` starting (see [`../heddle-session/INDEX.md`](../heddle-session/INDEX.md)). `80-web-ui
check-workspaces` also needs developer-ten's routes.

**Done** with `heddle-session`: when `70-workspaces-sessions` and `80-web-ui check-workspaces` pass through
`HEDDLE_BIN` and the backend lane's integrator has merged the branch.
