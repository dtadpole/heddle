---
title: The heddle-team crate
version: 0.2.0
description: The Rust port crate for durable teams, their policy, state and tool — its public API, the seams it needs from other crates, and the port plan.
grounded_in:
  - source: rust/ULTIMATE_GOAL.md
  - source: src/team/ (INDEX.md, state.ts, service.ts, tool.ts, policy.ts), src/plugins/team.ts, the /api/team branch of src/server/web.ts and the team boot edge of src/cli.ts
  - source: _verifiers_/50-agentic-loop/check-teams.mjs and _verifiers_/80-web-ui/check-team-view.mjs
---

# `rust/crates/heddle-team`

The Rust port of durable teams, their policy, state and tool.

| | |
|---|---|
| Ported from | `src/team/`, `src/plugins/team.ts`, the `/api/team` branch of `src/server/web.ts` |
| Judged by | `_verifiers_/50-agentic-loop` (check-teams), `_verifiers_/80-web-ui` (check-team-view), through the `heddle` binary |
| Sources | [`src/`](src/INDEX.md) |
| Unit tests | `cargo test --manifest-path rust/Cargo.toml -p heddle-team --all-features` |

**A team is the Lead's session**; every teammate is a session of its own; everything the team shares is a
`team/*` event in the Lead's log, folded on demand. The design decisions are the TypeScript build's, recorded
in `src/team/INDEX.md`; this crate keeps them and adds only the Rust shapes listed below.

## Public API

| Module | TypeScript source | What it offers |
|---|---|---|
| `state` | `state.ts` | `TeamState`, the snapshots (`TeamMemberSnapshot`, `TeamTaskSnapshot`, `TeamMessageSnapshot`), `TeamEvent` with `to_record`/`from_record`, `fold_team`, `assert_task_graph`, and on `TeamState`: `apply`, `add_member`, `queue_message`, `mark_delivered`, `add_task_snapshot`, `create_task`, `is_ready`, `apply_task_action`, `task_view`, `resolve_member`, `active_or_provisioning` |
| `error` | `state.ts` (`TeamError`), `tool.ts` | `TeamError { code, message }`, `TeamErrorCode` — the 22 `TEAM_*` codes plus the tool layer's `TEAM_FAILED` and `TEAM_NO_SESSION`, strings unchanged |
| `service` | `service.ts` | `TeamService::new(TeamDeps)`, then `lead_of`, `state`, `list`, `spawn`, `send` (async), `tasks`, `create_task`, `update_task`, `wait_for_change` (async), `interrupt`, `recover` / `recover_all` (async), `status_of`; the views `TeamMemberView`, `SendOutcome`, `InterruptOutcome`, `WaitResult`; `TeamLimits`; `RecoverAllReport::boot_line` |
| `tool` | `tool.ts` | `TEAM_TOOL_NAMES`, `team_tool_specs()` (descriptions and schemas verbatim), `TeamTools::call(name, args, caller) -> ToolOutcome` (`{ output, data?, error?: { code, message } }`) |
| `policy` | `policy.ts` | `TEAM_POLICY` (verbatim), `TEAM_POLICY_NOTE_ORIGIN`, `policy_note_record`, `has_policy_note` |
| `plugin` | `plugins/team.ts` | `TeamConfig` (the `team` row), `TeamPlugin::install(TeamPluginDeps)`, `recover_at_boot`, `ensure_policy`, the `TeamAgent` seam, `TEAM_CHANGED_EVENT`, `TEAM_TURN_PURPOSE` |
| `api` | `server/web.ts` | `team_api(service, session) -> ApiResponse { status, body }` for `GET /api/team`, with `body_text()` (two-space JSON and a newline) |
| `ports` | — | the seams below |
| `testing` | — | `MemoryStore`, `RecordingRunner`, `FakeLive`, `SequentialIds` (feature `test-doubles`) |

## The seams, and who implements them

The crate depends on no other heddle crate: it owns traits for what it needs, and the binary composes thin
adapters over the crates that own each capability. Until those crates land, the crate is built and tested
against the doubles in `testing`.

| Seam | Implemented over | What it must do |
|---|---|---|
| `TeamStore` | `heddle-session` | `exists`, `read` (each log line as a JSON object), `meta` (with `teamId`), `list`, `create` with a caller-chosen id and attribution (`parentSession`, `origin: 'subagent'`, `delegationDepth`, `teamId`, `title`), `fork` with the same, `append` (store adds `seq`, `at`), `user_message` with a verbatim `source`, `inherit_recorded_mode`; thread-safe |
| `TeamAgent` (→ `TeamRunner`) | `heddle-agent` | begin a turn with `purpose: 'team'`, endpoint, model and `source` — **the prompt is in the log and the turn is registered live before `begin_turn` returns**, the rest is a future; plus the profile's default endpoint |
| `TeamLive` | `heddle-agent`'s live-turn registry | `is_running`, `abort` (optional row) |
| tool registration | `heddle-tools` | wrap the nine `TeamToolSpec`s; call `TeamTools::call` with the calling session; map `ToolOutcome` to the registry's result |
| `team/changed` | `heddle-events` | an `emit_changed` callback that emits the event with the Lead's id |
| `GET /api/team` | `heddle-server` | mount the route behind the token, answer `team_api(...)` |
| boot recovery | `heddle` | in `web`, after goals resume and before the URL line, print `recover_at_boot().await.boot_line()` when `Some` |
| the `team` row | `heddle-config` | deserialize the row into `TeamConfig`; an absent row installs no team |
| `purpose: 'team'` | `heddle-llm` scripted endpoint | check-teams scripts the teammate's answer with a step whose `purpose` is `team` |

## Rust shapes beyond the TypeScript build

1. **Per-Lead transactions.** The TypeScript service was single-threaded; here every journal write folds,
   validates and appends under one per-Lead lock, so concurrent tool calls cannot journal a duplicate task id
   or member name (a log the fold would then refuse forever). The behaviour seen by one caller is unchanged.
2. **Begin, then a future.** `runTurn` appended the prompt before its first `await`; a Rust future does
   nothing until polled, so the runner seam is a synchronous `begin` (prompt written, turn live) returning the
   rest as a future the service spawns. A failed begin or future is recorded as `turn/failed`, as before.
3. **Cancellation by drop.** `waitForChange` took an `AbortSignal`; `wait_for_change` is cancelled by dropping
   its future. `spawn` takes no signal — the tool never passed one.

## Port plan

| Step | What lands | Tests (each claim can fail) |
|---|---|---|
| M0 | this contract: types, signatures, docs, `todo!()` bodies; data that is the contract (codes, policy text, tool specs, source shapes, defaults, boot line) complete | codes, policy note, tool specs, source and view shapes, config defaults, boot line |
| M1 | `state`: decode, fold, member lifecycle, board CAS, readiness, graph, views, resolution | the 12 claims of `test/team-state.test.ts` |
| M2 | `testing` doubles; `service` with the per-Lead transaction and per-target dispatch | the 14 claims of `test/team-service.test.ts`, plus a concurrency test for the transaction |
| M3 | `tool`: argument coercion, refusals as codes, the `wait_agent` sentences | the 10 claims of `test/team-tools.test.ts` |
| M4 | `plugin`, `ensure_policy`, `api`, `recover_at_boot` | policy once per session, endpoint fallback and refusal, `/api/team` statuses and body |
| M5 | adapters composed in the binary as the owning crates land; `check-teams` and `check-team-view` through `HEDDLE_BIN` | the two verifiers |

## Open questions

- **The fold's member cap.** The TypeScript fold applies the default cap of 8 members whatever `maxMembers`
  says, so a team configured above 8 journals a ninth member its own fold then refuses. Ported as is for now;
  the fix (no admission caps in the fold) would be a deliberate divergence and is the coordinator's call.
- **A member named `lead`** is not refused by the TypeScript build and is shadowed by the Lead in resolution.
  Ported as is.
- **Key order in the log.** The records are built in the TypeScript key order, but `serde_json::Value` sorts
  keys unless serde_json's `preserve_order` feature is on. Byte-compatibility of the session log is
  `heddle-session`'s concern; the workspace setting is rust/Cargo.toml's owner's.
- **`uuid`** is a crate-local dependency until it is hoisted into the workspace dependencies.

## Read next

[`../INDEX.md`](../INDEX.md) for the other crates; [`../../ULTIMATE_GOAL.md`](../../ULTIMATE_GOAL.md) for the parts.
