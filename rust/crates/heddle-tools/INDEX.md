---
title: The heddle-tools crate
version: 0.4.0
description: The Rust port crate for the tool registry, the built-in tools, and outside tools as processes — its public API, what it asks of other crates, and its port plan.
grounded_in:
  - source: rust/ULTIMATE_GOAL.md
  - source: src/tools/service.ts, src/tools/builtin.ts, src/plugins/tools.ts — the TypeScript sources this crate ports
  - source: _verifiers_/40-pluggable-tools/check-tools.mjs — the checks that judge it
---

# `rust/crates/heddle-tools`

The Rust port of the tool registry, the built-in tools, and outside tools as processes.

| | |
|---|---|
| Ported from | `src/tools/service.ts`, `src/tools/builtin.ts`, `src/plugins/tools.ts` |
| Judged by | `_verifiers_/40-pluggable-tools`, through the `heddle` binary, plus a branch for the outside process |
| Sources | [`src/`](src/INDEX.md) |
| Outside protocol | [`PROTOCOL.md`](PROTOCOL.md) — line-delimited JSON-RPC 2.0 on stdio, shared with part 6 |
| Unit tests | `cargo test --manifest-path rust/Cargo.toml -p heddle-tools` |

## Public API

| Item | What it is | Used by |
|---|---|---|
| `Tool` (`spec`, `run`), `tool_fn` | one tool; `run` gets the args and a `ToolRunContext` | every crate that ships a tool: `heddle-goal`, `heddle-todo`, `heddle-team`, `heddle-agent` (`delegate`) |
| `ToolContext`, `ToolRunContext` | what a caller passes (`cwd`, `session`, `cancel`, `log`); the same plus the call's `mode`, set only by the registry | tools, the loop |
| `ToolResult`, `ToolError`, `codes`, `ToolFailure` | `{ output, error?, data? }` in the TypeScript JSON shape; stable codes; how a tool's `run` fails unexpectedly | everyone |
| `ToolRegistry` | `register` (refuses a blank name or description), `filter_to`, `allow_list`, `missing`, `names`, `describe`, `has`, `get`, `call`, `run_command`, `effective_mode`, `sandbox`, `sandbox_policy`, `summary_line`, `from_config` | `heddle` (CLI), `heddle-agent`, `heddle-server`, `heddle-web-composer` |
| `ToolGates`: `ApprovalGate`, `SandboxGate`, `ModeResolver`, `ToolHooks` | what the registry asks of approvals/escalation, the sandbox, the per-session mode and the hook bus | implemented over `heddle-sandbox`, `heddle-session`, `heddle-events` |
| `ToolsConfig` | the `tools` row: `allow`, `includeBuiltins` (true), `bashTimeoutMs` (30000) | `heddle` (boot) |
| `builtin_tools`, `escalation_fields` | `write_file`, `read_file`, `list_dir`, `bash`, with descriptions copied verbatim | `ToolRegistry::from_config` |
| `OutsideComponentSpec`, `OutsideComponent`, `ProcessTool` | start a declared process, register its tools, forward their calls | `heddle` (boot); `heddle-events` for part-6 listeners |
| `protocol` | the wire types of [`PROTOCOL.md`](PROTOCOL.md) | integrator-one's verifier fixture, `heddle-events` |
| `CancellationToken` | the Stop every call carries (`AbortSignal` in TypeScript), re-exported from `tokio-util` | everyone |
| `upstream` | `heddle-sandbox`'s **own** types, re-exported (`SandboxMode`, `SandboxDenial`, `SandboxUnavailable`, `ConfinedArgv`, `SandboxOutcome`, `ApprovalDecision`, `ApprovalMode`, the escalation types); `heddle-llm`'s own `ToolSpec` and `heddle-session`'s own `SessionHandle`. **No mirror is left** | everyone |
| `adapters` | `Sandbox` and `SandboxApprovals`: the gate ports over `heddle-sandbox`'s `SandboxService` and `ApprovalService`; `SessionModes`: the `ModeResolver` over `heddle-session`'s `SessionService`; `gates_over(sandbox, approvals, sessions)`: the `tools` row's gates in one call | the binary (boot) |
| `command` (`Command::{Tools, Commands}`, `Args`, `Context`, `run`) | the `tools` and `commands` commands in the owning crate (D-043): the allow list applied, then the TypeScript text or `--json` byte for byte | the binary's dispatch |

The registry's gate order, which the port keeps exactly: unknown (`UNKNOWN_TOOL`, naming the known tools) →
approval (`DENIED`) → `tools/pre-execute` (`HOOKED`) → escalation (`BAD_ARGS`, `ESCALATION_REFUSED`) → the mode,
resolved once from the session's record or the deployment default and never from the arguments → `run` →
`tools/post-execute`; a sandbox denial thrown by a tool is `SANDBOX`, any other failure `TOOL_FAILED`. `call`
never fails: every refusal is a result the model reads.

## Where the port stands

As of 2026-10-22, branch `hd/developer-five`. Every body is ported; no `todo!()` and no mirror type is left (the
sandbox, LLM and session types are the owners' own, re-exported). Unit tests: 76, green, with the workspace gate
(`fmt --all --check`, `clippy --workspace --all-targets -D warnings`, `test --workspace`).

- **Done:** the registry and its gate order, the four built-ins, outside components over JSON-RPC 2.0 on stdio
  (including `notify`), the gate ports over the real `heddle-sandbox` and `heddle-session` services
  (`adapters::{Sandbox, SandboxApprovals, SessionModes, gates_over}`), and the D-043 `tools`/`commands` entry point
  (`command::run`).
- **Open, not in this crate:** `40-pluggable-tools` answers through `HEDDLE_BIN` once the binary dispatches
  `tools`/`--turn` to the entry points and composes the tools row with `gates_over`; its malformed-spec check also
  needs the boot to print an outside component's `OutsideError::Registration` with the failed row.
- **Hooks are not this crate's to adapt:** `heddle-events` depends on this crate and implements `ToolHooks` over the
  bus itself (`BusHooks`, with this crate's mapping: a refusal is `PreExecute::Refused`, a failure `ToolHookError`,
  a failing post-execute `TOOL_FAILED`) and attaches an outside component's listeners over its connection
  (`OutsideComponent::request`/`notify`). Adding `heddle-events` as a dependency here would be a cycle.
- **Verify:** `_tools_/local-build/run test -p heddle-tools` from `rust/`; the verifier from the lane worktree,
  `HEDDLE_BIN="$PWD/rust/target/release/heddle" sh _verifiers_/40-pluggable-tools/verify.sh`.

## Port plan

Each step lands with its unit tests in the worktree and is pushed to `hd/developer-five` for integrator-one.

| # | Step | State | Tests that can fail |
|---|---|---|---|
| 1 | Public API, mirrors, protocol framing; registration rule, displacement in place, allow list and `missing`, the config row | **landed** | 15 unit tests: blank name/description refused with the TypeScript sentences; a later registration displaces in place; filter and `missing`; config defaults and a misspelled key refused; protocol round trip and line classification |
| 2 | `ToolRegistry::call`, `run_command`, `from_config` | **landed** | 24 unit tests with doubles: the unknown-tool sentence names the known tools; approval before the hook and the hook before escalation; each refusal code (`DENIED`, `HOOKED`, `BAD_ARGS`, `ESCALATION_REFUSED`); the mode from the session and never from `args`; a grant is that call's only; `post_execute` replaces a result; a failure as `TOOL_FAILED` and a denial as `SANDBOX`; the config row registers the built-ins and keeps the allow list as a check; a command is gated as `command:<name>`; the listing serializes as the `tools --json` shape the part-4 fixture reads |
| 3 | The four built-ins | **landed** | 13 unit tests in a temporary workspace: write/read round trip, a denial reported as `SANDBOX`, a blank path as `BAD_ARGS`, `list_dir` sorted with `/` and sizes, `bash` exit/timeout/cancel with output kept, the 20 000-character cut, a confined mode with no backend refused as `SANDBOX_UNAVAILABLE` and never run, a denial classified by the sandbox and not by the exit code, and a symlink followed as a directory |
| 4 | Outside components: spawn, `initialize` with timeout, the line reader, pending table, sandbox back-channel, log, cancel, exit, shutdown | **landed** | 7 unit tests: the test binary re-executes itself as a component — registration and a call, a blank spec failing the row, a back-channel denial becoming `SANDBOX`, a dead process failing calls, cancel reporting `INTERRUPTED`, an unanswered `initialize` failing as `InitTimeout` |
| 5 | Adapters over the real crates | **sandbox, session landed**; hooks next | 8 unit tests against the real `SandboxService`/`ApprovalService`: the deployment's mode and policy JSON, the fence admitting a workspace path and refusing an absolute outside one, confinement failing closed with no backend, the standing policy allowing and denying by name, the escalation pairing as `BAD_ARGS`, and a wider mode with nobody to ask refused as `ESCALATION_REFUSED` while a repeat of the mode needs no ask. The sandbox types became the owner's `pub use`s. `ToolSpec` is `heddle-llm`'s own (an outside component's declared tool reads as `DeclaredTool`, whose `parameters` default to `{}`, so a missing schema is a registration the registry names, not a wire error). `SessionHandle` is `heddle-session`'s own, and `SessionModes` (2 tests against a real session store: no record runs under the deployment mode; a session's own `permission/mode` record outranks it) resolves the per-session mode. Still to come: the hooks adapter over `heddle-events` |
| 5b | The `tools`/`commands` entry point (D-043) | **landed** | 5 unit tests from the verifier's own expectations: the allow list leaves exactly `read_file` with a description over ten characters; the JSON is `JSON.stringify(v, null, 2)` with only `name` and `description`; the text pads the name to 14 and cuts the description at its first period; a replacement under a taken name is the one listed; `commands` with its em dash and as JSON. Plus a registry over the three real services writing inside the workspace and refusing outside |
| 6 | `40-pluggable-tools` through `HEDDLE_BIN` | with `heddle` (boot, `tools --json`, `--turn`) and integrator-one's process branch | the verifier, exit 0 |

**Not ported: background jobs.** The crate description names them, but the TypeScript build has no source and no
verifier for them (its `background-jobs` session read DSH's mechanism and recorded it in
`_context_/dsh-mechanisms/dsh-jobs.md`; nothing landed in `src/`). They join this API when the oracle has them.

## Read next

[`../INDEX.md`](../INDEX.md) for the other crates; [`../heddle-agent/INDEX.md`](../heddle-agent/INDEX.md) for the
loop that calls this registry; [`../../ULTIMATE_GOAL.md`](../../ULTIMATE_GOAL.md) for the parts.
