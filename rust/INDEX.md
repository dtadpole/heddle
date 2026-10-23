---
title: Rust port
version: 0.4.1
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

**Run 2026-10-22, in `~/heddle--int-backend`, on `main` at `cc09a59`:**

```bash
_tools_/local-build/run build --release --manifest-path rust/Cargo.toml    # exit 0
HEDDLE_BIN="$PWD/rust/target/release/heddle" \
  node _tools_/verify-runner/run.mjs _verifiers_/<part>/check*.mjs --json
```

**18 check files, 117 checks: 10 passed, 0 failed, 107 unjudged. Part 0 passes.** `05-config-system` exits `0`
through the binary: profiles, layers, includes and their cycles, both environment-reference shapes, a missing
reference, a bad value refused naming the row and the field, a patch against a missing row, provenance and an
unknown profile. Under `HEDDLE_BIN` its rows name component manifests rather than `.ts` plugins — part 0's Rust shape in
[`ULTIMATE_GOAL.md`](ULTIMATE_GOAL.md), stated in that verifier's INDEX — and the same ten checks pass on the
TypeScript build at the same revision. Every other backend check skipped at its capability probe, because the binary advertises `--profile`,
`profiles` and `config` and nothing else yet: every other command still exits 2 with
`heddle: not ported to Rust yet: <command>`.

Behind the binary, every backend crate on `main` carries its port, not only its contract — `heddle-config`,
`heddle-session`, `heddle-workspace`, `heddle-context`, `heddle-tools`, `heddle-agent`, `heddle-events`,
`heddle-goal`, `heddle-todo` and `heddle-team` have no `todo!()` left, and `heddle-llm` and `heddle-sandbox` have one
each (their newer tips are on the lane's branches). `heddle-server` is still its contract. What turns a ported crate
into a passing part is the binary composing it, and that is the next work for parts 1 to 8.

| Part | Verifier | On the binary, 2026-10-22 |
|---|---|---|
| 0 configuration system | `_verifiers_/05-config-system` | **passes** — 10 of 10 |
| 1 LLM backends | `_verifiers_/10-llm-backends` | 8 checks — unjudged |
| 2 streaming | `_verifiers_/20-streaming` | 5 checks — unjudged |
| 3 context management | `_verifiers_/30-context-management` | 9 checks — unjudged; one still reads `dist/` for the reader's view (that verifier's INDEX) |
| 4 pluggable tools | `_verifiers_/40-pluggable-tools` | 6 checks — unjudged |
| 5 agentic loop | `_verifiers_/50-agentic-loop` | 9 checks — unjudged |
| 6 hooks | `_verifiers_/60-hooks` | 6 checks — unjudged |
| 7 workspaces and sessions | `_verifiers_/70-workspaces-sessions` | 45 checks — unjudged |
| 8 permission sandbox | `_verifiers_/75-permission-sandbox` | 17 checks — unjudged |
| 9 Web UI | `_verifiers_/80-web-ui`, `85`, `87`, `88` | not judged in the backend lane (the ui lane owns it); the binary exits 2 for `web`, so none can pass yet |
| 10 token | `_verifiers_/90-web-ui-token` | not judged in the backend lane; `web` exits 2 |
| 11 Web UI daemon | `_verifiers_/95-web-daemon` | not judged in the backend lane; `web` exits 2 |
| model endpoints (outside the goal's table) | `_verifiers_/98-model-endpoints` | 2 checks — unjudged |

What is **in place** is the toolchain and the seam, not a part: rust 1.99.1 from rustup, the workspace, and the
`HEDDLE_BIN` path the checks reach the binary through — 13 of 13 `_tools_/verify-runner/_tests_/helper-rules` pass,
and the seam's own cases are among them.

## Read next

[`crates/heddle/`](crates/heddle/INDEX.md) for the binary; [`../_verifiers_/INDEX.md`](../_verifiers_/INDEX.md)
for how a part is decided.
