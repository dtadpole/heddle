---
title: The heddle-config crate
created: 2026-10-23T00:55:27Z
modified: 2026-10-23T05:42:20Z
version: 0.4.0
description: The Rust port crate for the configuration tree — profiles, patch layers, includes, environment references, validation and provenance — with its public API, the crates that read it, the config-boot contract callers follow, and its port plan.
grounded_in:
  - source: rust/ULTIMATE_GOAL.md
  - source: src/config/schema.ts, src/config/validate.ts, src/local-config.ts, src/paths.ts, src/endpoints.ts, src/llm/types.ts, src/cli.ts and src/boot.ts, read 2026-10-22
  - source: _verifiers_/05-config-system/check.mjs, read 2026-10-22
  - source: rust/crates/heddle/src/cli.rs, boot.rs, builtins.rs and main.rs on lane abdf20c, and src/server/web.ts and runWeb in src/cli.ts, read 2026-10-22 for the config-boot contract
  - source: src/server/uploads.ts and src/server/token.ts, read 2026-10-22 for what the server takes from configuration
---

# `rust/crates/heddle-config`

The Rust port of the configuration tree — profiles, patch layers, includes, environment references, validation
and provenance — and of the vocabulary every other crate reads configuration with: the environment, `$HEDDLE_HOME`,
the path rules, the machine's local file, and endpoint configuration.

| | |
|---|---|
| Ported from | `src/config/`, `src/local-config.ts`, `src/paths.ts`, `src/endpoints.ts`; the configuration half of `src/llm/types.ts`; `runConfigCommand` and `baseLayer` of `src/cli.ts` |
| Judged by | `_verifiers_/05-config-system`, through the `heddle` binary |
| Sources | [`src/`](src/INDEX.md) |
| State | **implemented and judged**: every public item is implemented with unit tests (steps 1–8), including the outside-component manifest catalog; `05-config-system` passes 10/10 through the binary (step 9; runs recorded under [the config-boot contract](#keeping-05-config-system-judged)) |

## The public API

`cargo doc -p heddle-config` is the full statement; this is the map. Everything is re-exported at the crate root
except `paths::resolve`, `paths::resolve_from_cwd` and the `command` module, which are reached by their paths.

| Module | Items | Ported from |
|---|---|---|
| `env` | `Env` — an explicit environment snapshot (`from_process`, `from_pairs`, `get`, `non_empty`, `with`, `home_dir`) | the `env = process.env` parameters |
| `error` | `ConfigError` — every problem found, `Display` joined by newlines | `ConfigError` |
| `home` | `heddle_home`, `profiles_dir`, `expand_home` | `schema.ts` |
| `paths` | `resolve` (Node's `path.resolve`), `resolve_from_cwd`, `canonical_path`, `is_under`, `depth_of` | `src/paths.ts` |
| `value` | `LayerValue` (YAML data plus `Env` and `Include` markers), `plain_json` | the `!env` / `!include` types |
| `layer` | `Layer`, `NamedLayer` (`read`, `inline`), `read_layer`, `anchor_dir`, `INLINE_FILE` | `readLayer`, `NamedLayer` |
| `references` | `references_in`, `resolve_env`, `parse_scalar` | `referencesIn`, `resolveEnv`, `parseScalar` |
| `compose` | `EntryRow` (`label`, `component`), `ComponentName`, `Provenance`, `ComposedRow` (`to_report`), `compose`, `origin_of` | `compose`, `provenanceOf`, `originOf` |
| `profile` | `ProfileInfo`, `list_profiles`, `resolve_profile`, `profile_argument`, `LayerOptions` (`for_run`, `for_inspection`), `default_layers` | `listProfiles`, `resolveProfile`, `defaultLayers`, cli `baseLayer` |
| `schema` | `Schema` (a JSON Schema subset), `SchemaType`, `TypeSet`, `Additional`, `SchemaProblem` | Schemastery, as the validator used it |
| `validate` | `ComponentCatalog` (trait), `SchemaLookup`, `StaticCatalog`, `ComponentManifest`, `ManifestCatalog`, `read_component_manifest`, `ValidationResult`, `validate_rows` | `validate.ts`; the manifest catalog is the part-0 shape for outside components |
| `local` | `LocalConfig` (`endpoint_patches`), `LocalConfigLocation`, `local_config_candidates`, `read_local_config` | `src/local-config.ts` |
| `endpoints` | `EndpointConfig` (catalogue methods), `EndpointPatch`, `EndpointKind`, `ModelEntry`, `ModelOption`, `ReasoningLevel(s)`, `ReasoningValue`, `default_endpoints`, `environment_override`, `merge_endpoint`, `read_key_file`, `materialize_key`, `resolve_endpoints`, `describe_endpoint(s)`, `EndpointsView`, `selection_problem`, `config_paths` | `src/endpoints.ts`, `src/llm/types.ts` |
| `command` | `ConfigCommand`, `ConfigArgs`, `CommandContext`, `run` — `heddle profiles` and `heddle config [--json] [--origins] [--validate]`, output and exit codes | `runConfigCommand` |

### Who reads what

| Crate | Reads | Because the TypeScript build did, in |
|---|---|---|
| `heddle` (the binary) | `command::run`, `LayerOptions::for_run`, `default_layers`, `compose`, `anchor_dir`, `EntryRow::component`, `NamedLayer::inline`, `Layer::patching`, `profile_argument`, `ManifestCatalog`, `Env`; implements `ComponentCatalog` | `cli.ts`, `boot.ts` |
| `heddle-llm` | `EndpointConfig` and its catalogue methods, `EndpointPatch`, `resolve_endpoints`, `describe_endpoint`, `read_local_config`, `local_config_candidates` | `plugins/model.ts`, the adapters |
| `heddle-server`, `heddle-web-composer` | `describe_endpoints`, `selection_problem`, `expand_home`, `canonical_path`, `is_under` | `server/web.ts` |
| `heddle-web-files` | `heddle_home`, `is_under` | `server/uploads.ts`, `server/attachments.ts` |
| `heddle-session`, `heddle-workspace` | `canonical_path`, `is_under`, `depth_of` | `session/*.ts`, `workspace/service.ts` |
| `heddle-context`, `heddle-sandbox` | `heddle_home`, `Env` | `context/service.ts`, `sandbox/service.ts` |

## The config-boot contract

What a caller does to turn command-line flags into rows, and what it may rely on afterwards. The binary follows it
today: every command that boots, `web` included, goes through `rust/crates/heddle/src/commands.rs` `boot_tree`, which
builds `cli::layer_options` and `cli::root_overrides` and calls `boot::boot`; `boot_then` answers a booted command from
it, and `web` hands it to `crate::web::web`. `profiles` and `config` pass `cli::config_args` to `command::run`.
**`web` boots exactly as a run does**, as the TypeScript `runWeb` calls `bootFromArgs`. As of main `e3f9d91` it is
routed but not yet listed in `--help`; it takes the launch secret's directory from `heddle_home(&invocation.env)`
(step 7), and an unknown `--profile` or a missing `--config` reaches the user as this crate's sentence with exit 1.

### 1. One environment, built once

`let env = Env::from_process();` at startup; pass `&env` to every call below and to every crate that reads
configuration. Read `std::env` nowhere else: a check points the child at a fixture with `HOME` and `HEDDLE_HOME`,
and only the `Env` carries them. `HEDDLE_HOME=""` is honoured as given, as the TypeScript `??` honoured it.

### 2. Flags to layer options

| Flag | Pass | Rule |
|---|---|---|
| `--profile V` | `profile_argument(V, &cwd, &env)` | starting with `.`, `/` or `~`: a directory, made absolute against `cwd` with `~` expanded; otherwise a name, kept as written |
| `-c`, `--config P` | `PathBuf::from(P)`, unresolved | the base layer |
| `--patch P`, repeatable | in the order given | the last write wins |

Then `LayerOptions::for_run(profile, config, patches, &cwd)` for everything that boots: a turn, `web`, and the
one-shot commands that start the tree. `LayerOptions::for_inspection` is used only inside `command::run`; the binary
never calls it. What `for_run` chooses:

| Given | Base layer | Project patch beside the base |
|---|---|---|
| `--profile` | none: the profile's own `cordis.yml` / `heddle.patch.yml`, nothing from `cwd` | no |
| `--config X`, no `--patch` | `X` | yes, when `heddle.patch.yml` exists in `X`'s directory |
| `--config X` with `--patch` | `X` | no |
| neither, `cwd/cordis.yml` exists | that file | yes when no `--patch`, beside it |
| neither, no `cwd/cordis.yml` | none | no |

Every `--patch` follows, in order. **Pass the process working directory as `cwd`.** `profile_argument` and the
`cordis.yml` lookup use the `cwd` argument, but a relative `--config` or `--patch` is made absolute against the
*process* working directory when the layer is read, as Node's `path.resolve` did. A caller whose idea of the working
directory differs from the process's must pass absolute paths.

### 3. Read the layers, then append the in-memory ones

`default_layers(&options, &env)?` reads every file layer with its includes expanded, and names each one:

| Layer | `NamedLayer::layer` (what provenance prints) | `NamedLayer::file` |
|---|---|---|
| a profile's file | `{profile}/{file}`, e.g. `dev/heddle.patch.yml`; a directory profile's name is its absolute path | absolute |
| the base, the project patch, each `--patch` | the absolute path | the absolute path |

It stops at the first layer it cannot read and returns one `ConfigError`: an unknown profile (the sentence lists the
profiles that exist), an include cycle (naming every file in it), a file that is not YAML, or a layer of the wrong
shape. Then append the in-memory layers **after** every file layer:
`layers.push(NamedLayer::inline(1, Layer::patching([json!({ "id": "session", "config": { "root": root } })])))`.
An inline layer is named `override N` with the file `(inline)`. Like every patch, it **replaces** the row's whole
`config`. `command::run` reads the file layers only, so `heddle --session-root X config` does not show the override,
as `runConfigCommand` did not.

### 4. Compose

`compose(&layers, &env)?` returns `Vec<ComposedRow>` and guarantees:

- **References are resolved.** `!env NAME` keeps the type the variable spells (`7` is a number); `${NAME}` is textual
  and always yields a string, so a value a schema checks as a number must use `!env`. A missing variable is an error
  naming it, never an empty string.
- **Order is insertion order**, recorded in `position`; no later layer moves a row.
- **The last write wins per top-level field**, and a patch replaces that field whole: a restated `config` is the
  entire `config`.
- **A removed row stays**, with `disabled: Some(true)`; the binary's loader gives it no entry.
- **No config is `None`.** A row that writes no `config`, or writes `config: null`, composes to `config: None`, and
  a patch writing `config: null` clears it. Validation checks `None` as `{}`; a caller starting a component hands it
  `{}`, as a Cordis plugin received, so its schema's defaults apply — never `null`, which every typed config refuses.
- **Provenance** is one entry per leaf field, naming only the layer that won; `origin_of` answers a parent field
  (`config`) with the first leaf beneath it.
- **Every problem is collected** before it fails (a duplicate insert, a patch or remove naming a row no earlier layer
  inserted, a missing reference). `Display` joins them with newlines; print `heddle: {error}` and exit 1.

### 5. Anchor and component names

`anchor_dir(&layers)` is the directory of the first layer read from a file. Inline layers are skipped, so appending
overrides never moves it; it is `None` only when every layer is inline, where the binary uses `.`. It is the profile
directory for `--profile`, `X`'s directory for `--config X`, and the first patch's directory when only patches were
given — never the working directory while any file layer exists. `row.component(&anchor)` is
`ComponentName::Path(resolve(anchor, name))` for a name starting with `.` or `/` (lexical, nothing read from disk) and
`ComponentName::Bare(name)`, a built-in, otherwise.

### 6. The schema hand-off: how `--validate` names the row and the field

`command::run` with `validate: true` calls `validate_rows(&layers, env, catalog)`, the catalog being the one the
caller put in `CommandContext`. It composes first; a composition error is the error (stderr, exit 1), never softened
into a validation problem. Then, for each row that is not disabled, it asks `catalog.lookup(row, anchor_dir)`:

| `lookup` returns | Effect |
|---|---|
| `SchemaLookup::Schema(s)` | counted as checked; `row.config` (absent means `{}`) is checked, and each problem is printed `{label}: {path} {message}` |
| `SchemaLookup::NoSchema` | skipped: not counted, not a problem |
| `SchemaLookup::Unresolvable(why)` | `{label}: cannot resolve the component '{name}' — {why}` |

The label is the row's `id`, else its `name`. A non-number where a number belongs reads
`{field} is not a number, which means the value in the layer could not be read as one`; that sentence is what
`05-config-system` matches for row `alpha` and field `count`. A value of the wrong type is reported once, and no other
keyword is checked against it. The exit code is 1 when there is any problem.

The binary's `BuiltinCatalog` answers a built-in with its adapter's schema, or `NoSchema` when the adapter declares none;
answers a path with `ManifestCatalog::new().lookup(row, anchor)`, which reads `<name>.component.yml` (`program`,
optional `args`, an inline `config` JSON Schema) without starting anything; and answers anything else as
`Unresolvable`. **Keep the path arm delegating to `ManifestCatalog`**: answering `Unresolvable` there makes check 7 of
`05-config-system` fail, with the row named but not the field.

To answer a built-in, the catalog constructs that built-in's component and asks `schema()`; it never calls `start`.
`--validate` therefore starts nothing only while **a component's constructor merely stores its inputs and its
`schema()` is a pure value** — no file, directory, process or network touched. A new adapter keeps both, or
`config --validate` begins doing work on a tree it was only asked to describe. As of lane `40906af` every built-in has
an adapter; each constructor stores `env`, `cwd` or nothing, and none of the 20 `schema()` bodies does I/O.

### 7. What the server reads after boot

| Call | What to know |
|---|---|
| `describe_endpoints(&endpoints, nominated)` | `default` is `null` unless the nominated endpoint is in the list; no key value ever appears, only `credential: "set"` and a key file's path |
| `selection_problem(&endpoint, model, effort)` | the caller finds the endpoint by name first; an unknown endpoint name is the caller's sentence, not this one |
| `expand_home(path, &env)` | the folder route's `~` (`web.ts`: `statSync(expandHome(path))`); takes the boot's `Env`, unlike the TypeScript `homedir()`; `~user/x` is returned unchanged |
| `heddle_home(&env)` | the uploads directory, `$HEDDLE_HOME/uploads` (`uploads.ts`: `uploadDirectory(heddleHome())`), and the launch secret's directory; `HEDDLE_HOME=""` is honoured as given, as the TypeScript `??` honoured it |
| `canonical_path(path)` | `realpath` when the path exists, lexical otherwise; a relative path resolves against the process working directory |
| `is_under(parent, child)` | segment-wise, so `/a/b-sibling` is not under `/a/b`; pass canonical paths |

These six are everything the TypeScript server took from what this crate ports: `web.ts` imports `describeEndpoints`
and `selectionProblem` from `src/endpoints.ts`, `expandHome` from `config/schema.ts` and `canonicalPath` and `isUnder`
from `src/paths.ts`, and `uploads.ts` imports `heddleHome` from `config/schema.ts`. Its `token.ts` kept a private copy
of both rules (`HEDDLE_HOME ?? ~/.heddle`, and a `~` expansion that looks only at the first character). A port that
copies `token.ts` faithfully therefore answers `~user/x` as `<home>user/x` where `expand_home` leaves it unchanged —
the one place this crate's deliberate difference (see *Where it differs on purpose*) shows inside one binary. Call
`heddle_home` and `expand_home` there too, and the server has one rule for each.

### 8. Starting an outside component

How the binary turns an outside row into a process, as of main `67c2587` (`rust/crates/heddle/src/adapters.rs`,
`OutsideRow`). `--validate` and the start read the manifest through the same `read_component_manifest`, so a manifest
that validates is one that starts.

| Part | Where it comes from |
|---|---|
| the manifest file | the row's name through step 5: `./x.component.yml` resolves against `anchor_dir`, the **first** file layer's directory, not the directory of the layer that wrote the row |
| the program | `program` starting with `.` resolves lexically against the manifest's folder; anything else is used as written — an absolute path, or a bare name the system finds on `PATH`. `~` is not expanded |
| the arguments | `args` as written, none when absent |
| the working directory | the manifest's folder, because a manifest writes its `args` relative to itself (`args: [./shout-tool.mjs]`); only that folder keeps a manifest portable wherever it is referenced from, a later layer included |
| the configuration | the row's composed `config`, handed over in `initialize`; `{}` when the row writes none or `null` (step 4) |
| the name in `initialize`, errors and logs | **the row's `id`**, the same name `config --validate` and the boot's `N row(s) failed to load: <id>` use, so one broken row has one name everywhere |

The two last rows are agreed with developer-five, who owns the process protocol (2026-10-22). **Where the binary still
differs:** as of main `43fd346` it names the running component by the manifest's file name without `.component.yml`,
so `id: alpha` naming `./shout.component.yml` says `shout` once running. `Catalog::component(&ComponentRef)` does not
carry the row, so the row's `id` has to be threaded to `OutsideRow` where the row starts; that change is developer-two's.

### Keeping `05-config-system` judged

Re-run it against every lane candidate. The verifier's entry point runs the same runner, check for check, as
`node _tools_/verify-runner/run.mjs _verifiers_/05-config-system/check*.mjs --json`:

```bash
HEDDLE_BIN=~/heddle--int-backend/rust/target/release/heddle sh _verifiers_/05-config-system/verify.sh --json
```

The result must be `"verdict":0` with all ten passing. A binary built before the candidate commit does not judge the
candidate: when the lane's release build predates it, build the candidate itself (a debug build in a throwaway
worktree is enough) and judge that. A drop from ten is a regression, reported to integrator-one and the coordinator
before any other work. Each check leans on the steps above:

| Check | Contract step |
|---|---|
| a named profile composes the tree a run loads | 2, 3, 4 (order) |
| a later layer restates one row and leaves the rest alone | 2 (patches), 4 (last write wins) |
| a layer includes another layer file | 3 |
| an include cycle is refused by path, not by depth | 3 |
| a value can come from the environment without being written into the tree | 4 (references) |
| a missing environment reference fails and names the variable | 4 |
| a bad value fails naming the row and the field | 6 |
| a patch against a row no layer inserted is refused where it is written | 4 |
| the composition can say which layer supplied a value | 4 (provenance), `config --origins --json` |
| a profile that does not exist says which ones do | 3 |

One line per run, oldest first: the candidate, the command as run (with the binary it judged), and the result.
**Measured and inferred are kept apart** (constitution C5): a row whose command column says *the … run above stands*
is an **inference** — no Rust source, lockfile version, 05 verifier or runner differed, so the earlier binary was the
candidate's — not a fresh run. From main `8072846` on, every row is a fresh run with a binary built from the commit
it judges.

| Date | Candidate | Command, and the binary it judged | Result |
|---|---|---|---|
| 2026-10-22 | lane `abdf20c` (the binary's commands and boot) | `HEDDLE_BIN=<binary> node _tools_/verify-runner/run.mjs _verifiers_/05-config-system/check*.mjs --json`, with the lane release build and with a debug build of exactly `abdf20c` | 10/10 passed, verdict 0, both binaries |
| 2026-10-22 | main `0a10ceb` (the binary on main) | the same command, with a debug build of main and with the lane release build | 10/10 passed, verdict 0, both binaries |
| 2026-10-22 | main `480d9b8` (a served command routes through the boot) | the same command, with a debug build of main and with the lane release build of `480d9b8` | 10/10 passed, verdict 0, both binaries |
| 2026-10-22 | main `cc09a59`, lane `a819f5f` (a context-verifier fix and status docs; no Rust source, 05 verifier or runner changed since `480d9b8`) | the same command, with the `480d9b8` builds, source-identical | 10/10 passed, verdict 0, both binaries |
| 2026-10-22 | lane `a66e662` (eleven merges: the binary's `boot.rs`, `float_roundtrip` workspace-wide, and this crate's null-config tests) | `HEDDLE_BIN=<debug build of exactly a66e662> sh _verifiers_/05-config-system/verify.sh --json`; the lane release build predated the candidate and was not counted | 10/10 passed, verdict 0; this crate's 118 unit tests passed on the same tree under `float_roundtrip` |
| 2026-10-22 | main `d28625d` (UI-verifier fixes only; no Rust source, 05 verifier or runner changed since `a819f5f`) | `HEDDLE_BIN=<lane release build of the 480d9b8 sources, identical here> sh _verifiers_/05-config-system/verify.sh --json` | 10/10 passed, verdict 0 |
| 2026-10-22 | main `b0ef8ab` (the lane's merges re-made on main: the binary's `boot.rs`, `float_roundtrip`, a `heddle-tools` that differs from `a66e662`) | `HEDDLE_BIN=<debug build of exactly b0ef8ab> sh _verifiers_/05-config-system/verify.sh --json`; this crate's code and the workspace manifest are identical to `a66e662`, where its 118 unit tests passed | 10/10 passed, verdict 0 |
| 2026-10-22 | lane `1221b3e` (the binary composes the session, workspace, tools, todo, goal and turn rows; built-in adapters now supply schemas) | `HEDDLE_BIN=<debug build of exactly 1221b3e> sh _verifiers_/05-config-system/verify.sh --json`; the lane release build predated the candidate and was not counted | 10/10 passed, verdict 0; `heddle config --validate` on the repository's own profile: 16 rows checked, 0 problems |
| 2026-10-22 | main `b89ad37` (`1221b3e` plus a regenerated `Cargo.lock` and status docs; sources, 05 verifier and runner identical) | the `1221b3e` run above stands: `HEDDLE_BIN=<debug build of exactly 1221b3e> sh _verifiers_/05-config-system/verify.sh --json`, whose regenerated lockfile is byte-identical to main's | 10/10 passed, verdict 0, same binary |
| 2026-10-22 | main `c4c9292` (one UI-verifier fix, `80-web-ui/check-team-view.mjs`; no Rust source, lockfile, 05 verifier or runner changed since `b89ad37`) | the `1221b3e` run above stands: `HEDDLE_BIN=<debug build of exactly 1221b3e> sh _verifiers_/05-config-system/verify.sh --json` | 10/10 passed, verdict 0, same binary |
| 2026-10-22 | lane `b548426` (binary increment: a new `runtime.rs`) | not run: the candidate does not compile — a build of exactly `b548426` fails with 6 errors in `runtime.rs`, which builds `heddle_tools::SessionHandle` with `PathBuf` fields that are `String` on main (a stale-base conflict, not a config change) | not judged; reported to integrator-one, developer-two and the coordinator; main `c4c9292` unaffected |
| 2026-10-22 | main `5c87849` (the candidate re-made without the failing `runtime.rs`: bus, team, context, LLM, session and workspace merges) | `HEDDLE_BIN=<debug build of exactly 5c87849> sh _verifiers_/05-config-system/verify.sh --json` | 10/10 passed, verdict 0 |
| 2026-10-22 | lane `5615f07` (`--turn` starts the stream view; hook ports over the bus; sandbox shell seam) | `HEDDLE_BIN=<debug build of exactly 5615f07> sh _verifiers_/05-config-system/verify.sh --json`; the lane release build predated the candidate and was not counted | 10/10 passed, verdict 0 |
| 2026-10-22 | main `29cec5b` (`5615f07` plus status docs and three lockfile lines filling in `heddle-events`' path dependencies, which its manifest already declared; no external version moved) | the `5615f07` run above stands: `HEDDLE_BIN=<debug build of exactly 5615f07> sh _verifiers_/05-config-system/verify.sh --json` | 10/10 passed, verdict 0, same binary |
| 2026-10-22 | main `c572061` (the tools verifier writes each outside tool as a process; no Rust source, lockfile, 05 verifier or runner changed since `29cec5b`) | the `5615f07` run above stands: `HEDDLE_BIN=<debug build of exactly 5615f07> sh _verifiers_/05-config-system/verify.sh --json` | 10/10 passed, verdict 0, same binary |
| 2026-10-22 | main `7ee5f90` (two public-hygiene gate fixes; no Rust source, lockfile, 05 verifier or runner changed since `c572061`) | the `5615f07` run above stands: `HEDDLE_BIN=<debug build of exactly 5615f07> sh _verifiers_/05-config-system/verify.sh --json` | 10/10 passed, verdict 0, same binary |
| 2026-10-22 | main `a2d4ae4` (the UI lane: `heddle-server` and three `heddle-web-*` crates, all outside the binary's dependency tree; the lockfile only adds their packages and qualifies `r-efi` as `r-efi 6.0.0`, no existing version moved) | the `5615f07` run above stands: `HEDDLE_BIN=<debug build of exactly 5615f07> sh _verifiers_/05-config-system/verify.sh --json` | 10/10 passed, verdict 0, same binary |
| 2026-10-22 | lane `6bfcc5f` (the binary dispatches the owners' entry points and the turn: `commands.rs` largely rewritten, a new `runtime.rs`) | `HEDDLE_BIN=<debug build of exactly 6bfcc5f> sh _verifiers_/05-config-system/verify.sh --json`; the lane release build predated the candidate and was not counted | 10/10 passed, verdict 0; `heddle config --validate` on the repository's own profile: 16 rows checked, 0 problems |
| 2026-10-22 | main `5d1d8f3` (`6bfcc5f` plus status docs and two lockfile lines filling in the binary's declared `heddle-events` and `tokio` dependencies) | the `6bfcc5f` run above stands: `HEDDLE_BIN=<debug build of exactly 6bfcc5f> sh _verifiers_/05-config-system/verify.sh --json` | 10/10 passed, verdict 0, same binary |
| 2026-10-22 | lane `a36a4c0` (the binary starts an outside component a row declares by manifest, through `read_component_manifest`) | `HEDDLE_BIN=<debug build of exactly a36a4c0> sh _verifiers_/05-config-system/verify.sh --json`, and the same with the lane release build, built after the candidate on a clean lane | 10/10 passed, verdict 0, both binaries |
| 2026-10-22 | main `67c2587` (`a36a4c0` plus the lane gate and status docs; no Rust changed, so the lane release build is main's binary) | `HEDDLE_BIN=<lane release build> sh _verifiers_/05-config-system/verify.sh --json` from a worktree at main, and `HEDDLE_BIN=<lane release build> node _tools_/verify-runner/lane.mjs 05-config-system` | 10/10 passed, verdict 0; lane gate green, 0 unjudged |
| 2026-10-22 | lane `4e504df` (agent increment: each goal round answered with a real agent turn; `heddle-agent` and `heddle-goal` changed) | `HEDDLE_BIN=<debug build of exactly 4e504df> sh _verifiers_/05-config-system/verify.sh --json`, and the lane gate with the same binary; the lane release build predated the candidate and was not counted | 10/10 passed, verdict 0; lane gate green, 0 unjudged |
| 2026-10-22 | main `8072846` (`4e504df` plus four lockfile lines filling in `heddle-goal`'s declared path dependencies; the lane release build was made after `4e504df`, so it is main's binary) | `HEDDLE_BIN=<lane release build> sh _verifiers_/05-config-system/verify.sh --json` from a worktree at main, and the lane gate with the same binary | 10/10 passed, verdict 0; lane gate green, 0 unjudged |
| 2026-10-22 | lane `40906af` (every built-in has an adapter: the subagent-tool, goal-driver and team rows; `--validate` now asks 20 schemas) | `HEDDLE_BIN=<debug build of exactly 40906af> sh _verifiers_/05-config-system/verify.sh --json`, and the lane gate with the same binary; the lane release build predated the candidate and was not counted | 10/10 passed, verdict 0; lane gate green; the repository's own profile validates, 16 rows checked, 0 problems |
| 2026-10-22 | main `6a809e3` (the lane's `40906af` re-made as `b2ee1f6`, a verify-runner fix so a check returns once its harness exits, and the lockfile; `6a809e3` itself only adds a status doc to `8ec2a71`) | `HEDDLE_BIN=<debug build of exactly 8ec2a71> sh _verifiers_/05-config-system/verify.sh --json` from that tree, with main's new runner, and the lane gate with the same binary | 10/10 passed, verdict 0; lane gate green, 0 unjudged |
| 2026-10-22 | lane `c94d6b1` (the binary advertises the session, workspace and goal commands: `usage.rs` and `main.rs` changed; `--help` still lists `--profile`, `profiles` and `config`) | `HEDDLE_BIN=<debug build of exactly c94d6b1> sh _verifiers_/05-config-system/verify.sh --json`, and the lane gate with the same binary; the lane tree held a modified lockfile when its release build was made, so I built the commit myself | 10/10 passed, verdict 0; lane gate green; the repository's own profile validates, 16 rows checked, 0 problems |
| 2026-10-22 | lane `cdea647` (`c94d6b1` plus hook and tool process tests in the 40 and 60 verifiers, and six lockfile lines with no version moved; 05 and the runner untouched) | `HEDDLE_BIN=<debug build of exactly cdea647> sh _verifiers_/05-config-system/verify.sh --json`, and the lane gate with the same binary | 10/10 passed, verdict 0; lane gate green, 0 unjudged |
| 2026-10-22 | main `0e7ffea` (`12b21d1`, one event bus per run and the hook points over it, plus a status doc) | `HEDDLE_BIN=<debug build of exactly 12b21d1> sh _verifiers_/05-config-system/verify.sh --json`, and the lane gate with the same binary | 10/10 passed, verdict 0; lane gate green, 0 unjudged |
| 2026-10-22 | lane `95708c4` (the turn's hooks chain the overflow recovery after the bus; the binary changed) | `HEDDLE_BIN=<debug build of exactly 95708c4> sh _verifiers_/05-config-system/verify.sh --json`, and the lane gate with the same binary | 10/10 passed, verdict 0; lane gate green, 0 unjudged |
| 2026-10-22 | main `43fd346` (`3f8f744`: agent, team and events increments, a real outside component driven through the listeners, and the lockfile; `43fd346` adds a status doc) | `HEDDLE_BIN=<debug build of exactly 3f8f744> sh _verifiers_/05-config-system/verify.sh --json`, and the lane gate with the same binary; the lane release build predated `3f8f744` and was not counted | 10/10 passed, verdict 0; lane gate green; the repository's own profile validates, 16 rows checked, 0 problems |
| 2026-10-22 | lane `325cb67` (`ContextReport` has a `Default`; `heddle-context` changed) | `HEDDLE_BIN=<debug build of exactly 325cb67> sh _verifiers_/05-config-system/verify.sh --json`, and the same with the lane release build, made after the candidate on a clean lane; the lane gate with each | 10/10 passed, verdict 0, both binaries; lane gate green |
| 2026-10-22 | lane `ee5fa0d` (the LLM crate's adapter-call entry point for the endpoint validator, and the shell's confinement on the real Seatbelt backend; `heddle-llm` and `heddle-tools` changed, no new `heddle-config` calls) | `HEDDLE_BIN=<debug build of exactly ee5fa0d> sh _verifiers_/05-config-system/verify.sh --json`, and the lane gate with the same binary; the lane release build predated the candidate and was not counted | 10/10 passed, verdict 0; lane gate green, 0 unjudged |
| 2026-10-22 | lane `5612131` (the agent's `ContextReport` is `heddle-context`'s own; `heddle-agent`, `heddle-events` and `heddle-team` changed) | `HEDDLE_BIN=<debug build of exactly 5612131> sh _verifiers_/05-config-system/verify.sh --json`, and the lane gate with the same binary; the lane release build predated the candidate and was not counted | 10/10 passed, verdict 0; lane gate green, 0 unjudged |
| 2026-10-22 | lane `e1d2fc0` (an unanswered escalated retry tested through the real services; `heddle-tools/src/adapters.rs` changed) | `HEDDLE_BIN=<debug build of exactly e1d2fc0> sh _verifiers_/05-config-system/verify.sh --json`, and the lane gate with the same binary; the lane release build predated the candidate and was not counted | 10/10 passed, verdict 0; lane gate green, 0 unjudged |
| 2026-10-22 | lane `b61b4e8` (goal chains run on a pinned runtime so the trigger works from any thread; `heddle-goal` changed) | `HEDDLE_BIN=<debug build of exactly b61b4e8> sh _verifiers_/05-config-system/verify.sh --json`, and the lane gate with the same binary; the lane release build predated the candidate and was not counted | 10/10 passed, verdict 0; lane gate green, 0 unjudged |
| 2026-10-22 | main `6be6ccd` (UI-verifier fixes and readings over `db3d76d`; no Rust changed, so the lane release build, made at 22:37:53 on a clean `db3d76d`, is main's binary) | `HEDDLE_BIN=<lane release build> sh _verifiers_/05-config-system/verify.sh --json` from a worktree at main, and the lane gate with the same binary | 10/10 passed, verdict 0; lane gate green, 0 unjudged |
| 2026-10-22 | lane `6aee707` (`heddle web` over `heddle-server`, routed and not yet advertised; seven binary files) | `HEDDLE_BIN=<debug build of exactly 6aee707> sh _verifiers_/05-config-system/verify.sh --json`, and the lane gate with the same binary; the lane release build predated the candidate and was not counted | 10/10 passed, verdict 0; lane gate green; `web --dry-run` boots the repository's own profile, and an unknown `--profile` or a missing `--config` through `web` gives this crate's sentence and exit 1 |

## Decisions the contract makes

- **The environment is a parameter.** Edition 2024 makes `std::env::set_var` `unsafe` and the workspace forbids
  `unsafe`, so no test can set a variable for the code under test. Every reader takes `&Env`; the binary builds
  one with `Env::from_process()` at startup. `HOME` is read from it too, so a check's fixture home reaches every
  crate.
- **Endpoint configuration lives here, not in `heddle-llm`.** `endpoints.ts` needs `EndpointConfig` and the
  catalogue functions, and the dependency runs `heddle-llm → heddle-config`, so the configuration half of
  `llm/types.ts` moves here. Keys stay camelCase on the wire; one `heddle.json` serves both builds.
- **A component's schema is data, behind a trait.** The TypeScript validator imported each row's module to find
  its Schemastery schema. The Rust binary has none (`rust/ULTIMATE_GOAL.md`, part 0: *a row names a built-in or
  an outside component, not a module path*), so `validate_rows` asks a `ComponentCatalog`, which the binary
  implements over its built-ins and outside components. A schema is a JSON Schema subset, not a new language.
- **The configuration commands live here.** `command::run` writes every sentence `05-config-system` reads; the
  binary parses flags and delegates. `--help` must still mention `--profile`, or every check reports unjudged.
- **Values stay JSON.** A composed row's `config` is a `serde_json::Value`; a component deserializes its own type
  from it. Layer values keep written order (`LayerValue::Mapping`), so provenance lists fields as written.

### Where it differs from the TypeScript build, on purpose

| Case | TypeScript | Here |
|---|---|---|
| `expand_home("~user/x")` | `<home>user/x` | unchanged |
| `--profile ~/p` | resolved against the working directory, `~` not expanded | `~` expanded |
| `insert:` written as a mapping or string | a `TypeError`, or one problem per character | `{file}: layer {n}: insert must be a list` |
| a row `id` that is not a string | accepted, never addressable | a problem naming the file and field |
| `heddle.json` `endpoints` as a mapping | a `TypeError` in the model plugin | a sentence naming the file |
| a row written with `config: null`, in `config --json` | prints `"config": null` | prints no `config` key, as for an absent config; no verifier reads the difference |

Kept as the TypeScript build has it, though inconsistent: `heddle --config X config` does not apply the project
patch beside `X`, while `heddle --config X --turn …` does (`LayerOptions::for_inspection` vs `for_run`).

## The port plan

Each step lands with its unit tests (`cargo test --manifest-path rust/Cargo.toml -p heddle-config`), in this order,
because each later step is checked through the earlier ones.

| Step | Bodies | Tests that can fail |
|---|---|---|
| 1 | done: `Env`, `ConfigError`, home, paths, `LayerValue`, serde shapes | 27 |
| 2 | done: `references_in`, `parse_scalar`, `resolve_env` | 11 |
| 3 | done: `read_layer`, `NamedLayer::read` on saphyr 0.0.6; `anchor_dir` landed early in step 6 | 12 new |
| 4 | done: `compose`, `origin_of`, `ComposedRow::to_report`, `EntryRow::component` | 11 new |
| 5 | done: `list_profiles`, `resolve_profile`, `profile_argument`, `LayerOptions`, `default_layers` | 13 new |
| 6 | done: `Schema::check`, `validate_rows`; `anchor_dir` landed early because validation anchors through it | 13 new |
| 7 | done: `command::run` | 5 new |
| 8 | done: `local`, `endpoints` | 17 new |
| 9 | done: `05-config-system` through `HEDDLE_BIN` — the binary delegates to `command::run` and its catalog to `ManifestCatalog`, and the verifier's HEDDLE_BIN branch writes component manifests | the verifier, 10 of 10 |

### Open questions

1. **The `--validate` check's fixture names `./alpha.ts`**, a TypeScript module with a Schemastery schema. Under
   `HEDDLE_BIN` no Rust catalog can read it. Agreed with integrator-one and acked by developer-five, 2026-10-22: an outside component is named by a
   manifest beside the profile (`./alpha.component.yml`: a `program` string, an optional `args` list, and an inline
   `config` JSON Schema — the same shape `OutsideComponentSpec` spells, so one manifest can later serve both
   `--validate` and the spec source). `--validate` reads the manifest without starting anything, and the verifier's
   `HEDDLE_BIN` branch writes manifests instead of `.ts` files. `ManifestCatalog` and `read_component_manifest`
   implement the heddle-config side; the verifier branch is integrator-one's, and the process protocol stays
   heddle-tools's.
2. **YAML reader.** *Resolved*: `saphyr` 0.0.6 (MIT OR Apache-2.0, YAML 1.2, exposes tagged nodes as
   `Yaml::Tagged(Tag, Box<Yaml>)`), added to `[workspace.dependencies]` by integrator-one (7ea2a3e).
3. **`serde_json`'s `preserve_order`.** Off here. Features unify across the workspace, so turning it on changes
   every crate's map order; whichever crate needs byte-compatible JSON (the session log) asks for it workspace-wide.

## Read next

[`../INDEX.md`](../INDEX.md) for the other crates; [`../../ULTIMATE_GOAL.md`](../../ULTIMATE_GOAL.md) for the parts;
[`../../../_verifiers_/05-config-system/INDEX.md`](../../../_verifiers_/05-config-system/INDEX.md) for the claim.
