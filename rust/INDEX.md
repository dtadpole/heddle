---
title: Rust port
version: 0.8.3
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

**Run 2026-10-22, in `~/heddle--int-backend`, on `main` at `65dae73`, judged with `_tools_/verify-runner/lane.mjs --baseline` against the previous `main`:**

```bash
_tools_/local-build/run build --release --manifest-path rust/Cargo.toml    # exit 0
HEDDLE_BIN="$PWD/rust/target/release/heddle" \
  node _tools_/verify-runner/lane.mjs 05-config-system 10-llm-backends 20-streaming 30-context-management \
    40-pluggable-tools 50-agentic-loop 60-hooks 70-workspaces-sessions 75-permission-sandbox 98-model-endpoints
```

**18 check files, 117 checks: 113 passed, 0 failed, 4 unjudged. Parts 0 and 2 to 8 pass; part 1 passes its six local checks.** Since `b72cc1a` the
binary advertises `web`, `--turn`, `--stream`, `context`, `tools`, `hooks` and `models` beside configuration, sessions,
workspaces and goal, so the checks that skipped at their capability probe are judged now: 91 checks turned from unjudged
to passing, and none of the 21 that passed before stopped passing (compared check by check against a run on the previous
`main`). Under D-048 a merge may open failing checks when it turns at least one into a pass and breaks none, provided
this table names each failing check and the code that owns it.

**Failing, with owners:** none in the backend lane since `e69f552`. Part 7's last failure — the follow-up
`POST /api/turn` on an existing session answering `400` — was the server's model adapter in `web.rs` answering the
service default with the nominated endpoint only; it now falls back to the first endpoint, as `src/llm/service.ts`
does, and `70-workspaces-sessions` passes 45 of 45.

**The ui lane's parts:** part 9 is met on `main` `33407a4` by the ui lane's gate — `80-web-ui` passes all 75 checks in
two runs (90 of 90 across the ui parts each time), and 85, 87 and 88 pass in full; part 10 passes 9 of 9. Three
checks are intermittent through the binary: `check-chat-view` #11, a scroll race between the page and the check, seen
on the TypeScript build too; `check-chat-view` #16, not yet root-caused (owned by the served web: `web.rs` and
`heddle-server`; it failed 1 in 26 alone under load, the page settling on a prefix of the answer); and `check-goal` #1,
a torn read of a session's metadata (owned by `heddle-session`, whose metadata is written in place; a fix is pending). Measured again in the
backend lane on `e69f552`'s binary, which gates no ui merge: 88 of 90, 0 regressed against `main`'s binary. Its two
failures fail on `main`'s binary as well: `80-web-ui/check.mjs`'s default-port check, because this Mac's live
deployment already listens on the documented default port, and `88-file-preview`'s html preview, which timed out
waiting for the preview to show — the ui lane read 88 in full on `33407a4`, so it is to be confirmed there (owned by
`heddle-web-files`).

**Fixed in the check:** `50-agentic-loop/check-teams.mjs`'s Lead check failed in some full lane runs and never alone.
Its poll for the teammate parsed each session's metadata while the binary could be writing it — both builds write that
file in place — and a torn read ("Unexpected end of JSON input") escaped the wait. Since the fix the poll treats an
unreadable file as not yet ready; in the loop that reproduced it, 4 of 22 runs failed before and 14 of 14 passed after.

**Fixed in the check:** `70-workspaces-sessions` — *the four session shortcuts act on the selected session, and say so
when there is none* failed in some full lane runs: it drives every chord in one in-page script whose fixed sleeps ran
it to 10.8–11.2 s under load, past the browser protocol's 10 s default for a single call. It now polls for each chord's
effect, bounded, within a budget that covers those bounds (4.4–4.8 s under the same load). The lane gate also re-runs a
file whose check regresses and names one that passes on the re-run as flaky.

**Unjudged, and why:** `10-llm-backends`'s two real-endpoint checks and `98-model-endpoints`'s two checks need a
configured endpoint on the machine, which this one does not have — the same on the TypeScript build. Every other backend
check gave a verdict.

Part 0's ten checks pass through component manifests rather than `.ts` plugins (part 0's Rust shape in
[`ULTIMATE_GOAL.md`](ULTIMATE_GOAL.md)); parts 4 and 6 load outside tools and hooks as processes (their verifiers' INDEXes).
Behind the binary every backend library crate carries its port (`git grep -c 'todo!('` finds none in them); since `9319116` the
binary has none either — the bare application and the printed tree were its last unported paths — and two remain in
`heddle-web-files`. No backend verifier imports `dist/`, and each
check's capability probe asks for every command it runs, matched as a command line in `--help`.

| Part | Verifier | On the binary, 2026-10-22 |
|---|---|---|
| 0 configuration system | `_verifiers_/05-config-system` | **passes** — 10 of 10 |
| 1 LLM backends | `_verifiers_/10-llm-backends` | 6 pass, 0 fail, 2 unjudged — the two real-endpoint checks, which need an endpoint configured on the machine |
| 2 streaming | `_verifiers_/20-streaming` | **passes** — 5 of 5 |
| 3 context management | `_verifiers_/30-context-management` | **passes** — 9 of 9 |
| 4 pluggable tools | `_verifiers_/40-pluggable-tools` | **passes** — 6 of 6; outside tools are processes under `HEDDLE_BIN` |
| 5 agentic loop | `_verifiers_/50-agentic-loop` | **passes** — 9 of 9 |
| 6 hooks | `_verifiers_/60-hooks` | **passes** — 6 of 6; hooks are processes under `HEDDLE_BIN` |
| 7 workspaces and sessions | `_verifiers_/70-workspaces-sessions` | **passes** — 45 of 45 |
| 8 permission sandbox | `_verifiers_/75-permission-sandbox` | **passes** — 17 of 17 (two consecutive runs) |
| 9 Web UI | `_verifiers_/80-web-ui`, `85`, `87`, `88` | **met** in the ui lane on `33407a4` — 80 passes 75 of 75 in two runs, 85, 87 and 88 in full; three checks intermittent (above) |
| 10 token | `_verifiers_/90-web-ui-token` | **passes** — 9 of 9 (ui lane, on `33407a4`) |
| 11 Web UI daemon | `_verifiers_/95-web-daemon` | not run in a lane gate: its stays-up check restarts the live server (D-045); the ui lane reads it |
| model endpoints (outside the goal's table) | `_verifiers_/98-model-endpoints` | 2 checks — unjudged on this machine, on either build: both need a machine-local endpoint configuration |

What is **in place** is the toolchain and the seam, not a part: rust 1.99.1 from rustup, the workspace, and the
`HEDDLE_BIN` path the checks reach the binary through — 16 of 16 `_tools_/verify-runner/_tests_/helper-rules` pass,
and the seam's own cases are among them — and the lane gate that judges every candidate against `main`'s per-check
baseline, whose 14 rules pass in `_tools_/verify-runner/_tests_/lane-rules`.

## Read next

[`crates/heddle/`](crates/heddle/INDEX.md) for the binary; [`../_verifiers_/INDEX.md`](../_verifiers_/INDEX.md)
for how a part is decided.
