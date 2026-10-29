---
title: Status of the Rust port
created: 2026-10-24T05:50:00Z
modified: 2026-10-29T09:34:00Z
level: L3
version: 1.1.0
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

**Run 2026-10-29, in `~/heddle--int-backend`, on `main` at `19fc4d4` (its code is `0199453`'s), with the machine's
endpoint file configured, against the previous `main`'s per-check baseline:**

```bash
_tools_/local-build/run build --release --manifest-path rust/Cargo.toml    # exit 0
HEDDLE_BIN="$PWD/rust/target/release/heddle" node _tools_/verify-runner/lane.mjs --baseline <main's baseline> \
  05-config-system 10-llm-backends 20-streaming 30-context-management 40-pluggable-tools 50-agentic-loop \
  60-hooks 70-workspaces-sessions 75-permission-sandbox 98-model-endpoints
```

**117 checks: 115 pass, 1 fail, 1 unjudged; none that passed on the previous `main` stopped passing.**

**Failing:** part 98's "every configured model passes streaming, reasoning and tool-call validation". The check reads
the machine's recorded validation (`npm run validate:endpoints`), so it judges the configuration, not the binary: the
Claude models and a fusion model, reached through the `openai-chat` kind, answer as one text delta and fail its
streaming criterion. Heddle has no `anthropic-messages` endpoint kind (`heddle-llm`; `src/llm` on the TypeScript
build). The ui parts, run on the same binary, pass 88 of 90; their two failures also
fail on the previous `main`'s binary ([`status-notes.md`](status-notes.md)).

**Unjudged:** part 1's publisher-route check needs a publisher-route endpoint, which the machine's file does not list.

| Part | Verifier, in `_verifiers_/` | On the binary |
|---|---|---|
| 0 configuration | `05-config-system` | **passes** — 10 of 10 |
| 1 LLM backends | `10-llm-backends` | 7 pass, 1 unjudged (publisher route) |
| 2 streaming | `20-streaming` | **passes** — 5 of 5 |
| 3 context | `30-context-management` | **passes** — 9 of 9 |
| 4 tools | `40-pluggable-tools` | **passes** — 6 of 6 |
| 5 agentic loop | `50-agentic-loop` | **passes** — 9 of 9 |
| 6 hooks | `60-hooks` | **passes** — 6 of 6 |
| 7 workspaces and sessions | `70-workspaces-sessions` | **passes** — 45 of 45 |
| 8 sandbox | `75-permission-sandbox` | **passes** — 17 of 17 |
| 9 Web UI | `80-web-ui`, `85`, `87`, `88` | **met** by the ui lane on `33407a4`: 80 passes 75 of 75 twice, 85, 87, 88 in full |
| 10 token | `90-web-ui-token` | **passes** — 9 of 9 |
| 11 daemon | `95-web-daemon` | read by the ui lane; it restarts the live server (D-045) |
| model endpoints | `98-model-endpoints` | 1 pass, **1 fail** (streaming of the Claude and fusion models) |
