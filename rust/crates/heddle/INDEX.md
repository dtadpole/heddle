---
title: The heddle binary crate
version: 0.4.0
description: The Rust port's binary and composition root — the command line the verifiers run through HEDDLE_BIN, the boot that starts every crate behind its API, its public API and its port plan.
grounded_in:
  - source: rust/ULTIMATE_GOAL.md
  - source: src/cli.ts, src/boot.ts and src/app.ts of the TypeScript build, read 2026-10-22
  - source: outputs of node dist/cli.js measured on the build host, 2026-10-22
---

# `rust/crates/heddle`

The binary every verifier runs when `HEDDLE_BIN` points at `rust/target/release/heddle`, and the
**composition root** of the port: it parses the TypeScript build's command line, composes the tree through
`heddle-config`, starts each row as a built-in from another crate (or as an outside process), and answers
every command through narrow views of those crates. Until a part is ported the binary says so on stderr and
exits 2, so a verifier run fails honestly rather than passing on an empty answer.

| | |
|---|---|
| Ported from | `src/cli.ts`, `src/boot.ts`, `src/app.ts`, `src/plugins/console-exporter.ts`, `src/plugins/greeting.ts`, `src/plugins/announce.ts` |
| Judged by | `_verifiers_/05-config-system` (through the binary), `_verifiers_/95-web-daemon` (the `web` command); every other verifier reaches its crate through this boot |
| Sources | [`src/`](src/INDEX.md) |
| Merged by | the backend integration lane |

## What belongs in it

| Path | What it is |
|---|---|
| [`Cargo.toml`](Cargo.toml) | a library (`src/lib.rs`) and a thin binary (`src/main.rs`), inheriting the workspace's version and lints |
| [`src/`](src/INDEX.md) | the sources and their unit tests |

## Public API

A library so every command is unit-tested in-process; `main.rs` hands it the process's arguments,
environment and streams. Bodies marked `todo!()` are the port plan below; everything else is implemented and
tested.

| Module | What it declares |
|---|---|
| `heddle` (`lib.rs`) | `Invocation { argv, env, cwd }`, `Exit { Success = 0, Failure = 1, Unported = 2 }`, `run(&Invocation, &mut Output) -> Exit` |
| `cli` | `Args` (one field per TypeScript `Args` field, quirks kept), `CommandWord`, `Subcommand`, `UsageError`, `parse_args(argv)`, `layer_options` (→ `heddle_config::LayerOptions`), `config_args` (→ `heddle_config::command::ConfigArgs`), `root_overrides` (→ an inline `NamedLayer`), `names_a_tree` |
| `usage` | `Capability`, `SERVED`, `GATE_WORDS`, `LINES`, `usage(served)` — the help, gated by what is wired |
| `boot` | `FiberState` (Cordis's numbering and names), `Entry`, `BootOptions { layers, overrides, target, env }`, `BootError`, `Boot { rows: Vec<ComposedRow>, entries, services, anchor }`, `boot`, `load` (which makes the run's one `heddle-events` bus first), `settle`, `failed_entries`, `failure_lines`, `describe_entries` |
| `builtins` | `Builtin`, `BuiltinSpec`, `BUILTINS`, `ComponentRef { Builtin, Outside, Unresolved }`, `resolve_component(&ComponentName)`, `Component { requires, schema, start }`, `Catalog`, `BuiltinCatalog::new(env)` (also `heddle_config::ComponentCatalog`, for `--validate`) |
| `adapters` | one adapter per built-in over the owning crate's own types — `ModelComponent`, `SandboxComponent`, `ApprovalsComponent`, `SessionComponent`, `WorkspaceComponent`, `ToolsComponent`, `TodoComponent`, `TodoToolComponent`, `GoalComponent`, `GoalToolComponent`, `GoalDriverComponent`, `TurnsComponent`, `ContextComponent` (`Context = ContextService<SessionStore>`), `SubagentToolComponent`, `TeamComponent`, `InCrateComponent` (console, greeting, announce) — plus `OutsideRow` for a `./x.component.yml` row, `StoreLog`, `bus_hooks` |
| `runtime` | `tokio()` (the process's one multi-thread runtime), `agent_runtime(&Services)`, `shared_runtime(&mut Services)` — `heddle-agent`'s `AgentRuntime` from its own adapters over the booted services |
| `services` | `Services`: a service is a name with typed views — `provide`, `get`, `provides`, `withdraw`, and one accessor per port (`session()`, `model()`, …) |
| `ports` | the consumer contract: one trait per service the commands read (below), `SessionHandle`, `Record = serde_json::Value`, `PortError`, `DEFAULT_WEB_PORT = 3082` |
| `commands` | `dispatch`, `config_command`, `booted_command` (each word → its owner's `command::run`), `turn` (→ `heddle_agent::command::run`), `web`, `bare_application` |
| `output` | `Output` (both streams), `Captured` (for tests), `stringify` (`JSON.stringify(value, null, 2)`) |

### How a row becomes a running crate

A row keeps its TypeScript `name`; `heddle-config` resolves it against the base layer's directory
(`EntryRow::component` → `ComponentName::{Path, Bare}`) and the binary **recognises** it: a path ending in
`src/<module>.ts` or `dist/<module>.js`, for a module in `BUILTINS`, starts that built-in wherever the
checkout is (the repository's `./src/plugins/session.ts` and a verifier's `<repo>/src/plugins/session.ts`
are the same built-in), and a bare name that is a built-in's row id in the default profile (`session`,
`model`, …) names it directly. Any other path is an **outside component**, a process spoken to as
line-delimited JSON on stdio (part 4), hosted by `heddle-tools`; any other bare name is unresolved, and its
row fails naming it.

| Module the row names | Built-in | Provides | Injects (module's own) | Crate |
|---|---|---|---|---|
| `plugins/console-exporter` | `Console` | — | — | `heddle` |
| `plugins/greeting`, `plugins/announce` | `Greeting`, `Announce` | `greeting`, — | —, `greeting` | `heddle` |
| `plugins/session` | `Session` | `session` | — | `heddle-session` |
| `plugins/model` | `Model` | `model` | — | `heddle-llm` |
| `context/service` | `Context` | `context` | `model`, `session` | `heddle-context` |
| `workspace/service` | `Workspace` | `workspace` | `session` | `heddle-workspace` |
| `sandbox/service`, `approvals/service` | `Sandbox`, `Approvals` | `sandbox`, `approvals` | — | `heddle-sandbox` |
| `goal/service`, `plugins/goal-driver`, `plugins/goal-tool` | `Goal`, `GoalDriver`, `GoalTool` | `goal`, `goalDriver`, — | `session`; the turn's services; `goal`, `tools` | `heddle-goal` |
| `todo/service`, `plugins/todo-tool` | `Todo`, `TodoTool` | `todo`, — | `session`; `todo`, `tools` | `heddle-todo` |
| `plugins/turns`, `plugins/subagent-tool` | `Turns`, `SubagentTool` | `turns`, — | —; `tools`, `session`, `model`, `sandbox`, `context` | `heddle-agent` |
| `plugins/team` | `Team` | `team` | `session`, `model`, `tools`, `context`, `sandbox` | `heddle-team` |
| `plugins/tools` | `Tools` | `tools` | `approvals`, `sandbox`, `session` | `heddle-tools` |

An entry starts once every service it requires (the module's own plus the row's `inject`) is provided,
and stays `pending` otherwise; a refused start leaves it `failed`. `settle` and `failed_entries` report
both, as the TypeScript build does.

### What the binary asks of each crate

The traits in [`src/ports.rs`](src/ports.rs) are read off the call sites in `src/cli.ts`. They are the
narrowest views the commands need, not a second API: an adapter maps each onto the crate's own public types,
and **where a crate's shape differs, the crate's shape wins**. Records printed whole with `--json` cross as
the crate's own serialization (the TypeScript shape), so the crate stays the single source of each shape.

| Trait | Crate | Methods |
|---|---|---|
| `SessionPort` | `heddle-session` | `root`, `list`, `open`, `resume`, `current`, `open_at`, `create_at`, `events`, `folder`, `tree`, `read_file_text` |
| `WorkspacePort` | `heddle-workspace` | `file`, `list`, `sessions`, `add`, `rename`, `remove`, `owner`, `ensure_owner`, `generated` |
| `ModelPort`, `StreamPort` | `heddle-llm` | `describe`, `names`, `default_endpoint`; `print_stream` → `dispose`, `summary` |
| `ToolsPort` | `heddle-tools` | `describe`, `describe_commands`, `allow_list`, `filter_to`, `missing` |
| `AgentPort` | `heddle-agent` | `run_turn(TurnRequest) -> TurnOutcome` |
| `ContextPort` | `heddle-context` | `assemble(handle, AssembleOptions)` |
| `SandboxPort` | `heddle-sandbox` | `workspace_root` |
| `GoalPort`, `GoalDriverPort` | `heddle-goal` | `get`; `advance`, `resume_at_start` |
| `TeamPort` | `heddle-team` | `recover_all` |
| `ServerPort` | `heddle-server` | `start(WebOptions) -> WebServer { info, close }` |

Beyond the traits, every service crate is asked for three things the boot needs:

1. **A config and its schema**: a `Config: serde::Deserialize` the adapter reads from the row's `config`
   (`serde_json::Value`), and the same shape as a `heddle_config::Schema` (the Schemastery schema of the
   TypeScript module, defaults included), which `config --validate` checks rows against.
2. **A constructor from config and injected services** (`new(config, deps…)`), returning the crate's
   handle; the adapter registers it under the service name above.
3. **Logs through `tracing`**, with the plugin's name as the target; the `console` row prints them to the
   terminal (errors to stderr), which is what `src/plugins/console-exporter.ts` does.

From `heddle-config`, whose API has landed, the binary calls `command::run` (which owns every sentence of
`profiles` and `config`), `LayerOptions::for_run`, `profile_argument`, `default_layers`, `NamedLayer::inline`
with `Layer::patching` (the `--session-root` / `--sandbox-root` layer), `compose`, `anchor_dir`,
`EntryRow::component`, `canonical_path` and `Env`, and it implements `ComponentCatalog` over its built-ins.

### The help tells the verifiers what exists

The verifiers decide whether a part exists by reading `--help` (`--profile`, `--endpoint`, `--stream`,
`context`, `tools`, `--turn`, `hooks`, `workspaces`, `sessions`, `web`). The help is assembled from
`usage::LINES`, each tagged with the capability that serves it, and a line prints only when its capability
and every gate word in it are served. A half-ported binary is therefore **unjudged** where a crate is not
wired and **judged** where it is; with every capability served the text is the TypeScript build's byte for
byte, which a unit test checks against `src/cli.ts` itself.

## Where the port stands

The library shape is complete and every module below compiles with its unit tests; which parts
*answer* is a separate question, because the help only advertises what is wired.

| Piece | State |
|---|---|
| `cli::parse_args` and the layer helpers | implemented, tested against `parseArgs`'s quirks and sentences |
| `usage` (the gated help) and `main` | implemented: `--help` prints `usage(SERVED)`, a usage error exits 1, an unported request exits 2 naming itself |
| `boot::boot`, `load`, `settle`, `failed_entries`, `dispose` | implemented; `load` makes one `heddle-events` bus per run and exposes its catalog before any row starts |
| every command word | dispatched to its owner's D-043 entry point: `profiles`/`config` (`heddle-config`), `models` (`heddle-llm`), `tools`/`commands` (`heddle-tools`), `hooks` (`heddle-events`), `goal` (`heddle-goal`), `context` (`heddle-context`), `sessions`/`transcript` (`heddle-session`), `workspaces`, `workspace …`, `tree`, `file`, `session new` (`heddle-workspace`) |
| `--turn` | dispatched to `heddle_agent::command::run` on `runtime::tokio()`, after the pending check and the allow list; `--stream` through `heddle-llm`'s `StreamHub`, fed by the session store's listener; a goal's chain joined through `GoalAdvance` |
| `adapter-call` | hidden (no help line, no capability): `heddle_llm::command::adapter_call` over standard input, for `_tools_/model-validation` and 98 |
| every built-in row of the repository profile | composes through `adapters.rs`; the hook points (`model/request`, `tools/pre-execute`/`post-execute`, `agent/pre-step`, `session/event`) reach the bus |
| an outside component (`./x.component.yml`) | starts through `heddle_tools::OutsideComponent`; its tools join the registry, its listeners attach to the bus |
| `web` | `commands::web` boots the tree and calls `web.rs` (developer-ten's file under D-047): `heddle_server::command::run` over a harness from the boot; the boot makes the server's `EventHub` and the `StreamHub` before any row, and the session store's listener feeds both and the bus |
| a bare `heddle`, and a run that only names a tree | the three-plugin application of `src/app.ts` (its tree, then `announce hello, <target><punctuation>`), and the configured tree printed by row id — the same lines as `node dist/cli.js`; nothing in the crate is unported |

`usage::SERVED` is the one line that says which capabilities the help advertises: `Always`, `Config`,
`Sessions`, `Workspaces`, `Goal`, `Web`, `Turn`, `Context`, `Tools`, `Hooks`, `Models` and `Streaming`.
A command that answers is routed whether or not it is advertised. Under D-048 a capability is advertised
once its command answers, provided at least one check turns into a pass and no passing check turns into a
failure; the failing ones are listed with their owners in `rust/INDEX.md`. Measured through this tree's
binary (every verifier but 95, which kills the installed service's port and is read on live-deploy's
scratch agent): 196 pass, 10 fail, 4 unjudged — 05, 20, 30, 40, 50, 60, 75, 85, 87, 90 and 96 all
green, 10 with its two real-endpoint checks unjudged; 95 4 of 4 on the scratch agent.

## Command entry points in the owning crate (D-043)

The binary keeps the command line, the gated help, the boot and the dispatch table. **The behaviour of a
command lives in the crate that owns it**, behind one entry point of this shape, so seven crates can land
their commands in parallel and the binary adds one dispatch line each. The precedent is
`heddle_config::command::run`, which answers `profiles` and `config` today.

```rust
// rust/crates/<crate>/src/command.rs, exported as `pub mod command`
pub enum Command { /* the command words this crate answers, e.g. Sessions, Transcript */ }

/// Only the flags this crate reads, as plain std types, named after the TypeScript `Args` field.
#[derive(Clone, Debug, Default)]
pub struct Args { pub target: Option<String>, pub json: bool /* , name, force, generated, ... */ }

/// What the command runs against: the crate's own composed service(s), as the crate's own types, plus
/// the process facts the binary resolved (the working directory, a home directory) as values.
pub struct Context<'a> { pub cwd: std::path::PathBuf /* , pub store: &'a SessionStore, ... */ }

/// Write the answer to `out` and any failure to `err`; return the process exit code.
pub fn run(command: Command, args: &Args, context: &Context<'_>,
           out: &mut dyn std::io::Write, err: &mut dyn std::io::Write) -> i32
// a command that awaits (the turn) is `pub async fn run(...) -> i32`; the binary owns the runtime
```

| Rule | Why |
|---|---|
| No dependency on `rust/crates/heddle`; std, serde_json and the crate's existing dependencies only | the binary depends on the crate, never the reverse |
| No process-global reads or effects: no `std::env`, `current_dir`, `process::exit`, `println!` | the binary passes them in, so a unit test is a `Vec<u8>` and a literal context |
| Exit `0` done; `1` with `heddle: <sentence>` on `err`, the TypeScript build's `process.exitCode = 1`; never `2` | `2` is the binary's own "not ported yet" |
| Text output is the TypeScript build's, byte for byte (`src/cli.ts`); `--json` is `JSON.stringify(value, null, 2)` plus a newline, compact one-line where the TypeScript build wrote `JSON.stringify(value)` | verifiers parse the JSON and match the text |
| The crate's service is built from its row: a `Config: Deserialize` (camelCase, defaults, an absent `config` arrives as `{}`) and a constructor from config and the services it injects | the binary's adapter builds it once at boot and registers the handle under the service name |
| Unit tests in the crate, built from its verifier's expectations | the owner owns the test with the code |

**How it lands.** The owner pushes `command.rs` with its tests and tells me the commit. I add the
adapter that builds the service from its row (if not already there), one dispatch line from the binary's
`Args` to the crate's `Args`, and the capability to `usage::SERVED` only when the command's verifier checks
pass, so an advertised command never turns a gate red.

| Command words | Crate, owner |
|---|---|
| `models` | `heddle-llm`, developer-three |
| `--turn`, with `--endpoint`, `--model`, `--system`, `--max-rounds`, `--max-output-tokens`, `--resume`, `--new` | `heddle-agent`, developer-five (`--stream`'s printer: `heddle-llm`, developer-three) |
| `tools`, `commands` | `heddle-tools`, developer-five |
| `context` | `heddle-context`, developer-four |
| `hooks`, `goal` | `heddle-events` and `heddle-goal`, developer-six |
| `sessions`, `transcript`, `session new` | `heddle-session`, developer-eight |
| `workspaces`, `workspace add\|list\|remove\|rename`, `tree`, `file` | `heddle-workspace`, developer-eight |
| team recovery at `web` start | `heddle-team`, developer-nine |
| `web` | `heddle-server`, developer-ten (the binary composes its `Harness`) |

The binary already prints every non-turn command above against its `ports` views, tested with doubles
(`src/commands.rs`). Those implementations are the reference for the text and the sentences: an owner's
entry point replaces the binary's version for its words, and the binary's copy is then deleted.

## Port plan

Each step is pushed on this crate's branch with its unit tests, and the integrator is told.

| # | Step | Done when |
|---|---|---|
| 1 | This public API and plan | pushed; summary sent to the integrator and the crates it composes |
| 2 | `parse_args`, `layer_options`, `config_args`, `root_overrides`, `names_a_tree`; `main.rs` onto `run`, with `--help` from `usage(SERVED)` and every unwired command exiting 2 | unit tests for every flag, positional rule and error sentence of `parseArgs`; the help test |
| 3 | `profiles` and `config` delegated to `heddle_config::command::run`, `BuiltinCatalog` as its `ComponentCatalog`; `Capability::Config` served | `05-config-system` through `HEDDLE_BIN` once `heddle-config` implements `command::run`, all but the `--validate` fixture (see open questions) |
| 4 | The loader (`load`, `dispose`), the bare application (`console`, `Greeting`, `announce`), `hooks` | the tree and the announce line match the TypeScript build's output in unit tests |
| 5 | One adapter per built-in as each crate's API lands, and the `booted_command`s it unlocks; each adds its capability to `SERVED` | each command's text and `--json` match the TypeScript build against doubles, then against the crate |
| 6 | `web`: `--dry-run`, then the server over `heddle-server`, goal and team recovery at start, SIGINT/SIGTERM | `heddle web --port 3082 --host 127.0.0.1 --config <repo>/cordis.yml` serves `/healthz`; `95-web-daemon`'s web part with the deployment seat |
| 7 | `--turn` over `heddle-agent`, with `--stream` and the goal driver | the turn verifiers through the binary, with their crates |

## Open questions

- **`05-config-system`'s `config --validate` fixture** names `./alpha.ts`, a Cordis plugin whose Schemastery
  schema only Node can read, so under `HEDDLE_BIN` that one check needs a branch. `heddle-config` proposes an
  outside component declared by a manifest beside the profile (`command`, and `config` as a JSON Schema),
  which `--validate` reads without starting anything; the binary's catalog would read the same manifest, and
  the boot would start the `command` through `heddle-tools`. To be agreed with `heddle-tools` and the
  backend integrator.
- **JSON key order.** `JSON.stringify` keeps insertion order; `serde_json` sorts keys unless its
  `preserve_order` feature is on, and features unify across the workspace. Verifiers parse JSON, so order
  is not judged, but byte-compatible session logs may need it. A workspace decision for the integrator.
- **`95-web-daemon`** judges a launchd agent, which a Linux host does not have, so it reports unjudged
  there. The binary's share is the `web` command; the plist and installer belong to the deployment seat.
- **Numeric flags** that are not numbers are a usage error here, where the TypeScript build carries `NaN`.

## Read next

[`../../INDEX.md`](../../INDEX.md) for the build and the status table; [`../INDEX.md`](../INDEX.md) for the
crates this one composes.
