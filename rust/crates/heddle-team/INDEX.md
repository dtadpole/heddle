---
title: The heddle-team crate
version: 0.3.0
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
| Integration tests | [`tests/session_store.rs`](tests/session_store.rs): the team layer over the real `heddle-session` store (dev-dependency only) — check-teams' recorded store recovered byte for byte; its first check's journal driven through the nine tools and read back from disk, restart included; and check-team-view's fixture served through `team_view` with the panel text derived as `page.html` derives it (roster, `1 teammate(s)`, `task-1 write the thing`, `0 queued`, `1 delivered`, no panel without a team) |
| State | **ported and on `main`** (merged as `d5956c5`, 2026-10-22): `state`, `service`, `tool`, `plugin` and `api` behind the declared API; 84 unit and 3 integration tests pass, and `fmt`, `clippy -D warnings` and `rustdoc -D warnings` are clean. M5 — the binary composing the `team` row and `heddle-server`'s route — is the binary's and the server's |

**A team is the Lead's session**; every teammate is a session of its own; everything the team shares is a
`team/*` event in the Lead's log, folded on demand. The design decisions are the TypeScript build's, recorded
in `src/team/INDEX.md`; this crate keeps them and adds only the Rust shapes listed below.

## Public API

| Module | TypeScript source | What it offers |
|---|---|---|
| `state` | `state.ts` | `TeamState`, the snapshots (`TeamMemberSnapshot`, `TeamTaskSnapshot`, `TeamMessageSnapshot`), `TeamEvent` with `to_record`/`from_record`, `fold_team`, `assert_task_graph`, and on `TeamState`: `apply`, `add_member`, `queue_message`, `mark_delivered`, `add_task_snapshot`, `create_task`, `is_ready`, `apply_task_action`, `task_view`, `resolve_member`, `active_or_provisioning` |
| `error` | `state.ts` (`TeamError`), `tool.ts` | `TeamError { code, message }`, `TeamErrorCode` — the 22 `TEAM_*` codes plus the tool layer's `TEAM_FAILED` and `TEAM_NO_SESSION`, strings unchanged |
| `service` | `service.ts` | `TeamService::new(TeamDeps)`, then `lead_of`, `state`, `list`, `members_of`, `spawn`, `send` (async), `tasks`, `create_task`, `update_task`, `wait_for_change` (async), `interrupt`, `recover` / `recover_all` / `recover_store` (async), `status_of`; the views `TeamMemberView`, `SendOutcome`, `InterruptOutcome`, `WaitResult`; `TeamLimits`; `RecoverAllReport::boot_note` / `boot_line` |
| `tool` | `tool.ts` | `TEAM_TOOL_NAMES`, `team_tool_specs()` (descriptions and schemas verbatim), `TeamTools::call(name, args, caller) -> ToolOutcome` (`{ output, data?, error?: { code, message } }`) |
| `policy` | `policy.ts` | `TEAM_POLICY` (verbatim), `TEAM_POLICY_NOTE_ORIGIN`, `policy_note_record`, `has_policy_note` |
| `plugin` | `plugins/team.ts` | `TeamConfig` (the `team` row), `TeamPlugin::install(TeamPluginDeps)`, `recover_at_boot`, `ensure_policy`, the `TeamAgent` seam, `TEAM_CHANGED_EVENT`, `TEAM_TURN_PURPOSE` |
| `api` | `server/web.ts` | `team_api(service, session) -> ApiResponse { status, body }` for `GET /api/team`, with `body_text()` (two-space JSON and a newline); `team_view(service, session) -> TeamResult<TeamApiView>`, the 200 body from one fold, for a server that owns its route |
| `command` | `src/cli.ts` (the `app.ctx.team` block of `web`) | the D-043 entry point: `Command::RecoverAtWebStart`, `Args` (no flags), `Context { cwd, team: &TeamService }`, `async run(command, &args, &context, out, err) -> i32` and `async web_start_note(&TeamService) -> Option<String>` (the same recovery, answered as the server's boot note) — recovers every team in the store and writes `heddle web: recovered N team(s) (S settled, D delivered[, F failed])` when there was one; exit 0, or 1 with `heddle: <sentence>` when the line cannot be written |
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
| `GET /api/team` | `heddle-server` | mount the route behind the token; `heddle-server` owns its route and asks a `TeamService::view(session)` port, which the binary implements as `team_view(...)` with each part `serde_json::to_value`d. A refused fold is a 500 in the oracle (its generic `internal error: <message>` catch), so that port needs an error path — raised with the route owner 2026-10-22 |
| boot recovery | `heddle` | in `web`, only when the `team` row loaded: push `command::web_start_note(&team).await` into `heddle_server::command::Context::notes` after the goal-resumption note, so the lines read goals, teams, then the URL as in the oracle. `command::run(Command::RecoverAtWebStart, …)` is the same recovery writing the whole line, for a caller that prints it itself (the D-043 convention, `rust/crates/heddle/INDEX.md`) |
| the `team` row | `heddle-config` | deserialize the row into `TeamConfig`; an absent row installs no team |
| `purpose: 'team'` | `heddle-llm` scripted endpoint | check-teams scripts the teammate's answer with a step whose `purpose` is `team` |

**Runner ordering.** The service reads the target's log immediately after a turn is begun, so `TeamRunner::begin`
must put the prompt in that log and register the turn live *before* it returns; the same is required of
`TeamAgent::begin_turn`. The TypeScript build got this from `runTurn` appending before its first await. `heddle-agent`
now provides the split the adapter needs: `begin_turn(&AgentRuntime, RunTurnOptions) -> BegunTurn` writes the prompt
and registers the live turn before returning, and `BegunTurn::run` is the rest (`hd/developer-five` at `a0032f9`;
`run_turn` is the same turn unsplit). The binary composes `TeamRunner::begin` from it: build the options with the
member's endpoint and model (else the profile's default endpoint), `purpose: "team"` and the [`TeamSource`] as
`source`, call `begin_turn`, and return `Box::pin(begun.run())` mapped to `Result<(), String>`.

## Rust shapes beyond the TypeScript build

1. **Per-Lead transactions.** The TypeScript service was single-threaded; here every journal write folds,
   validates and appends under one per-Lead lock, so concurrent tool calls cannot journal a duplicate task id
   or member name (a log the fold would then refuse forever). The behaviour seen by one caller is unchanged.
2. **Begin, then a future.** `runTurn` appended the prompt before its first `await`; a Rust future does
   nothing until polled, so the runner seam is a synchronous `begin` (prompt written, turn live) returning the
   rest as a future the service spawns. A failed begin or future is recorded as `turn/failed`, as before.
3. **Cancellation by drop.** `waitForChange` took an `AbortSignal`; `wait_for_change` is cancelled by dropping
   its future. `spawn` takes no signal — the tool never passed one.
4. **Reassigning to the Lead.** `reassign` accepts the Lead's own session id as an owner (the task then renders
   as owned by `lead`), which is what this contract's wording asks for and what the tool's `owner: 'lead'` passes;
   the TypeScript `applyTaskAction` only looked up member snapshots and so refused that one case.

## Port plan

| Step | What lands | Tests (each claim can fail) |
|---|---|---|
| M0 | this contract: types, signatures, docs, `todo!()` bodies; data that is the contract (codes, policy text, tool specs, source shapes, defaults, boot line) complete | codes, policy note, tool specs, source and view shapes, config defaults, boot line |
| M1 | `state`: decode, fold, member lifecycle, board CAS, readiness, graph, views, resolution | the 12 claims of `test/team-state.test.ts` |
| M2 | `testing` doubles; `service` with the per-Lead transaction and per-target dispatch | the 14 claims of `test/team-service.test.ts`, plus a concurrency test for the transaction |
| M3 | `tool`: argument coercion, refusals as codes, the `wait_agent` sentences | the 10 claims of `test/team-tools.test.ts` |
| M4 | `plugin`, `ensure_policy`, `api`, `recover_at_boot` | policy once per session, endpoint fallback and refusal, `/api/team` statuses and body |
| M5 | adapters composed in the binary as the owning crates land; `check-teams` and `check-team-view` through `HEDDLE_BIN` | the two verifiers |

M1–M4 landed on 2026-10-22; M5 is composition in the binary (`heddle`) and the route in `heddle-server`, so it
lands with those owners rather than in this crate. What the crate can rehearse of M5 without them it does in
`tests/session_store.rs`, whose `SessionTeamStore` is the `TeamStore` adapter the binary needs, written against
`heddle-session`'s public API.

## Open questions

- **The fold's member cap.** The TypeScript fold applies the default cap of 8 members whatever `maxMembers`
  says, so a team configured above 8 journals a ninth member its own fold then refuses. Ported as is for now;
  the fix (no admission caps in the fold) would be a deliberate divergence and is the coordinator's call.
- **A member named `lead`** is not refused by the TypeScript build and is shadowed by the Lead in resolution.
  Ported as is.
- **Key order in the log** — settled. The records are built in the TypeScript key order, and `heddle-session` and
  `heddle-llm` turn on serde_json's `preserve_order`, which Cargo unifies across any build that holds them — the
  binary's included. `tests/session_store.rs` asserts the journaled lines on disk keep the TypeScript order
  (`type`, payload, `version`, `teamId`; a member as `id, name, description, context, phase`).
- **`uuid`** is a crate-local dependency until it is hoisted into the workspace dependencies.

## Read next

[`../INDEX.md`](../INDEX.md) for the other crates; [`../../ULTIMATE_GOAL.md`](../../ULTIMATE_GOAL.md) for the parts.
