---
title: Rust port
version: 0.5.10
description: The Cargo workspace of the Rust port of Heddle — what it holds, where it builds and runs, and the per-part status.
grounded_in:
  - source: owner statement in the dsh session, 2026-10-22, asking to build or port Heddle with Rust
  - source: owner statement in the same session, suggesting a Linux devserver as the build environment and an SSH forward to reach its UI
  - source: measurement on the owner's Mac, 2026-10-22, recorded below
---

# `rust`

The Rust port as one Cargo workspace; what completes it is [`ULTIMATE_GOAL.md`](ULTIMATE_GOAL.md). A source
folder, not a type folder. `target/` is cargo's output and is ignored.

| Path | What it is |
|---|---|
| [`ULTIMATE_GOAL.md`](ULTIMATE_GOAL.md) | what completes the port |
| [`Cargo.toml`](Cargo.toml) | the workspace: edition 2024, shared dependency versions, `unsafe_code` forbidden |
| [`crates/`](crates/INDEX.md) | one folder per crate |

## Where it builds and runs

**On the owner's Mac, locally** (D-020, 2026-10-22). The earlier measurement that this Mac kills every binary
it builds on exec (exit 137) did not reproduce: a compiled C probe and this workspace both ran, and
`cargo check --workspace` completed here. Rust 1.99.1 with rustfmt and clippy comes from rustup, pinned by
[`rust-toolchain.toml`](rust-toolchain.toml); there are no devservers in this setup, no SSH and no
`HEDDLE_BUILD_HOST`.

**One worktree per team member**, `~/heddle--<seat>` on branch `hd/<seat>`, where its owner writes its crates
**and their unit tests** and runs them; `~/heddle--int-backend` and `~/heddle--int-ui`, where each integrator merges
its lane's branches and runs every verifier through `HEDDLE_BIN`; `~/heddle-live`, the deployment, whose page the
owner reaches at `http://127.0.0.1:8082/`. One crate is one owner's write scope, so parallel work never shares a
file. Cargo runs in one of three build slots ([`_tools_/local-build`](../_tools_/local-build/INDEX.md)) because the
team shares ten cores and one disk.

## Status

Written only from a verifier run **against the binary**, with the command and the date
([`ULTIMATE_GOAL.md`](ULTIMATE_GOAL.md), *How the state is maintained*). Unjudged (exit 3) is not passing: a part
whose checks skip has not been judged, and a part that failed has not been met.

**Run 2026-10-22, in `~/heddle--int-backend`, on `main` at `b61b4e8`, judged with `_tools_/verify-runner/lane.mjs`:**

```bash
_tools_/local-build/run build --release --manifest-path rust/Cargo.toml    # exit 0
HEDDLE_BIN="$PWD/rust/target/release/heddle" \
  node _tools_/verify-runner/lane.mjs 05-config-system 10-llm-backends 20-streaming 30-context-management \
    40-pluggable-tools 50-agentic-loop 60-hooks 70-workspaces-sessions 75-permission-sandbox 98-model-endpoints
```

**18 check files, 117 checks: 21 passed, 0 failed, 96 unjudged. Part 0 passes; part 7 has 11 of 45 passing.** `05-config-system` exits `0`
through the binary: profiles, layers, includes and their cycles, both environment-reference shapes, a missing
reference, a bad value refused naming the row and the field, a patch against a missing row, provenance and an
unknown profile. Under `HEDDLE_BIN` its rows name component manifests rather than `.ts` plugins — part 0's Rust shape in
[`ULTIMATE_GOAL.md`](ULTIMATE_GOAL.md), stated in that verifier's INDEX — and the same ten checks pass on the
TypeScript build at the same revision.

Since `cdea647` the binary also advertises `sessions`, `workspaces`, `workspace`, `session`, `tree`, `file`, `goal` and
`transcript`, and part 7's checks of those commands pass through it: the folder tree one level at a time, type and
instance classification and badges, hidden plumbing and declared generated folders, the file reader and its refusals,
`session new` at a workspace and a new session filed under it. Part 7's other 34 checks drive `--turn` or start `web`,
which the binary does not advertise yet, so they are unjudged — not failed. Every other backend check skipped at its
capability probe for the same reason.

Behind the binary, every backend library crate on `main` carries its port: `git grep -c 'todo!('` finds none in
`heddle-config`, `heddle-session`, `heddle-workspace`, `heddle-llm`, `heddle-context`, `heddle-tools`, `heddle-agent`,
`heddle-sandbox`, `heddle-events`, `heddle-goal`, `heddle-todo` or `heddle-team`. The ui-lane crates arrived through
the ui lane at `a2d4ae4` — `heddle-server`, `heddle-web-files`, `heddle-web-composer` and `heddle-web-trajectory` carry
their implementations (407 unit tests between them; `heddle-web-files` has two `todo!(` left). The binary dispatches
the owners' entry points and the turn and composes an adapter for every built-in row; it advertises a command once
that command's checks pass (configuration, sessions, workspaces and goal so far), and two `todo!(` remain in it: the
bare boot and `web`. No backend verifier imports `dist/`, so a lane
with no TypeScript build judges every one of them. Each check's capability probe asks for every command the check
runs, matched as a command line in `--help`, so a binary that advertises one command before another leaves the
dependent checks unjudged instead of failing them.

| Part | Verifier | On the binary, 2026-10-22 |
|---|---|---|
| 0 configuration system | `_verifiers_/05-config-system` | **passes** — 10 of 10 |
| 1 LLM backends | `_verifiers_/10-llm-backends` | 8 checks — unjudged; two of them call a real configured endpoint and stay unjudged on a machine without one, on either build |
| 2 streaming | `_verifiers_/20-streaming` | 5 checks — unjudged |
| 3 context management | `_verifiers_/30-context-management` | 9 checks — unjudged |
| 4 pluggable tools | `_verifiers_/40-pluggable-tools` | 6 checks — unjudged; under `HEDDLE_BIN` each outside tool is a process (that verifier's INDEX) |
| 5 agentic loop | `_verifiers_/50-agentic-loop` | 9 checks — unjudged |
| 6 hooks | `_verifiers_/60-hooks` | 6 checks — unjudged; under `HEDDLE_BIN` each hook is a process (that verifier's INDEX) |
| 7 workspaces and sessions | `_verifiers_/70-workspaces-sessions` | 45 checks — **11 pass**, 0 fail, 34 unjudged (they need `--turn` or `web`) |
| 8 permission sandbox | `_verifiers_/75-permission-sandbox` | 17 checks — unjudged |
| 9 Web UI | `_verifiers_/80-web-ui`, `85`, `87`, `88` | not judged in the backend lane (the ui lane owns it); the binary exits 2 for `web`, so none can pass yet |
| 10 token | `_verifiers_/90-web-ui-token` | not judged in the backend lane; `web` exits 2 |
| 11 Web UI daemon | `_verifiers_/95-web-daemon` | not judged in the backend lane; `web` exits 2 |
| model endpoints (outside the goal's table) | `_verifiers_/98-model-endpoints` | 2 checks — unjudged on this machine, on either build: both need a machine-local endpoint configuration, which it does not have |

What is **in place** is the toolchain and the seam, not a part: rust 1.99.1 from rustup, the workspace, and the
`HEDDLE_BIN` path the checks reach the binary through — 13 of 13 `_tools_/verify-runner/_tests_/helper-rules` pass,
and the seam's own cases are among them.

## Read next

[`crates/heddle/`](crates/heddle/INDEX.md) for the binary; [`../_verifiers_/INDEX.md`](../_verifiers_/INDEX.md)
for how a part is decided.
