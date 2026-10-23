---
title: The heddle-config crate
version: 0.3.0
description: The Rust port crate for the configuration tree — profiles, patch layers, includes, environment references, validation and provenance — with its public API, the crates that read it, the config-boot contract callers follow, and its port plan.
grounded_in:
  - source: rust/ULTIMATE_GOAL.md
  - source: src/config/schema.ts, src/config/validate.ts, src/local-config.ts, src/paths.ts, src/endpoints.ts, src/llm/types.ts, src/cli.ts and src/boot.ts, read 2026-10-22
  - source: _verifiers_/05-config-system/check.mjs, read 2026-10-22
  - source: rust/crates/heddle/src/cli.rs, boot.rs, builtins.rs and main.rs on lane abdf20c, and src/server/web.ts and runWeb in src/cli.ts, read 2026-10-22 for the config-boot contract
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
today: every command that boots goes through `rust/crates/heddle/src/commands.rs` `boot_then`, which builds
`cli::layer_options` and `cli::root_overrides` and calls `boot::boot`; `profiles` and `config` pass
`cli::config_args` to `command::run`. **`web` boots exactly as a run does** — the TypeScript `runWeb` calls
`bootFromArgs` — so wiring it needs nothing new from this crate: boot through the same path as `boot_then` (steps 1–5
below), then hand the server what step 7 lists. As of main `480d9b8`, the binary's `web` is still `todo!()`.

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

The binary's `BuiltinCatalog` answers a built-in with its adapter's schema, or `NoSchema` until the adapter exists;
answers a path with `ManifestCatalog::new().lookup(row, anchor)`, which reads `<name>.component.yml` (`program`,
optional `args`, an inline `config` JSON Schema) without starting anything; and answers anything else as
`Unresolvable`. **Keep the path arm delegating to `ManifestCatalog`**: answering `Unresolvable` there makes check 7 of
`05-config-system` fail, with the row named but not the field.

### 7. What the server reads after boot

| Call | What to know |
|---|---|
| `describe_endpoints(&endpoints, nominated)` | `default` is `null` unless the nominated endpoint is in the list; no key value ever appears, only `credential: "set"` and a key file's path |
| `selection_problem(&endpoint, model, effort)` | the caller finds the endpoint by name first; an unknown endpoint name is the caller's sentence, not this one |
| `expand_home(path, &env)` | takes the boot's `Env`, unlike the TypeScript `homedir()`; `~user/x` is returned unchanged |
| `canonical_path(path)` | `realpath` when the path exists, lexical otherwise; a relative path resolves against the process working directory |
| `is_under(parent, child)` | segment-wise, so `/a/b-sibling` is not under `/a/b`; pass canonical paths |

### Keeping `05-config-system` judged

Re-run it against every lane candidate, with the lane's release binary:

```bash
HEDDLE_BIN=~/heddle--int-backend/rust/target/release/heddle \
  node _tools_/verify-runner/run.mjs _verifiers_/05-config-system/check*.mjs --json
```

The result must be `"verdict":0` with 10 passing. A drop from 10 is a regression, reported to integrator-one and the
coordinator before any other work. Each check leans on the steps above:

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

| Date | Candidate | Binary | Result |
|---|---|---|---|
| 2026-10-22 | lane `abdf20c` (the binary's commands and boot) | lane release build, and a debug build of exactly `abdf20c` | 10 pass, verdict 0, both |
| 2026-10-22 | main `0a10ceb` (the binary on main) | a debug build of main, and the lane release build | 10 pass, verdict 0, both |
| 2026-10-22 | main `480d9b8` (a served command routes through the boot) | a debug build of main, and the lane release build of `480d9b8` | 10 pass, verdict 0, both |
| 2026-10-22 | main `cc09a59`, lane `a819f5f` (a context-verifier fix and status docs; no Rust source, 05 verifier or runner changed since `480d9b8`) | the `480d9b8` builds above, source-identical | 10 pass, verdict 0, both |

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
