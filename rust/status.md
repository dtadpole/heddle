---
title: Status of the Rust port
created: 2026-10-24T05:50:00Z
modified: 2026-10-31T02:03:00Z
level: L3
version: 1.17.0
description: The per-part status of the Rust port, written only from a verifier run against the binary, with its command.
status: unverified
grounded_in:
  - source: lane gate runs in ~/heddle--int-backend on the owner's Mac, 2026-10-22 to 2026-10-23, through _tools_/verify-runner/lane.mjs
  - source: the ui lane's readings, _verifiers_/80-web-ui/readings.md at 709bee6
---

# Status

Written only from a verifier run **against the binary**, with the command and the date
([`ULTIMATE_GOAL.md`](ULTIMATE_GOAL.md), *How the state is maintained*). Unjudged (exit 3) is not passing. The checks
behind these figures are in [`status-notes.md`](status-notes.md).

**Run 2026-10-30, in `~/heddle--int-backend`, on `main` at `24d250f3` (the page's endpoint list carries no key path or gateway; a DeepSeek thinking continuation replays reasoning_content; an earlier streamed answer reaches the model whole; a session's first prompt titles it; one folder is one workspace however it is spelled; workspaces can be reordered; part 70's browser checks under the integrators' browser slot), with the machine's endpoint file validated, against the previous `main`'s per-check baseline:**

```bash
_tools_/local-build/run build --release --manifest-path rust/Cargo.toml    # exit 0
HEDDLE_BIN="$PWD/rust/target/release/heddle" node _tools_/verify-runner/lane.mjs --baseline <main's baseline> \
  05-config-system 10-llm-backends 20-streaming 30-context-management 40-pluggable-tools 50-agentic-loop \
  60-hooks 70-workspaces-sessions 75-permission-sandbox 98-model-endpoints
```

**159 checks: 158 pass, 0 fail, 1 unjudged; none that passed on the previous `main` stopped passing.** Part 1
gained `check-endpoints-page.mjs` and `check-reasoning-replay.mjs` (two checks), and part 70 four checks: a resumed
session sends an earlier streamed answer back whole, the first prompt's generated title, one workspace however its
folder is spelled, and workspace/insertBefore across a restart.

**Failing:** none in the backend lane. Part 98 reads the machine's recorded validation, so it judges the configuration:
every configured model now passes it. For the Claude models that means several text deltas, not arrival as they are
generated: the local gateway sends them in one burst at the end, which heddle does not cause (a chat-completions
turn through the same server arrives over time). Part 80 as the lane selects it, run on the same binary, passes 83 of 84; its one failure, the default-port
check, also fails on the previous `main`'s binary, because the live server holds that port ([`status-notes.md`](status-notes.md)).

**Unjudged:** part 1's publisher-route live check needs a publisher-route endpoint, which the machine's file does not
list.

| Part | Verifier, in `_verifiers_/` | On the binary |
|---|---|---|
| 0 configuration | `05-config-system` | **passes** — 14 of 14 |
| 1 LLM backends | `10-llm-backends` | 13 pass, 1 unjudged (publisher route, live) |
| 2 streaming | `20-streaming` | **passes** — 5 of 5 |
| 3 context | `30-context-management` | **passes** — 9 of 9 |
| 4 tools | `40-pluggable-tools` | **passes** — 10 of 10 |
| 5 agentic loop | `50-agentic-loop` | **passes** — 27 of 27 |
| 6 hooks | `60-hooks` | **passes** — 6 of 6 |
| 7 workspaces and sessions | `70-workspaces-sessions` | **passes** — 55 of 55 |
| 8 sandbox | `75-permission-sandbox` | **passes** — 17 of 17 |
| 9 Web UI | `80-web-ui`, `85`, `87`, `88` | **met** by the ui lane on `33407a4`: 80 passes 75 of 75 twice, 85, 87, 88 in full |
| 10 token | `90-web-ui-token` | **passes** — 9 of 9 |
| 11 daemon | `95-web-daemon` | read by the ui lane; it restarts the live server (D-045) |
| model endpoints | `98-model-endpoints` | **passes** — 2 of 2 |
