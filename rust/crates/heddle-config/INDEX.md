---
title: The heddle-config crate
version: 0.2.0
description: The Rust port crate for the configuration tree — profiles, patch layers, includes, environment references, validation and provenance — with its public API, the crates that read it, and its port plan.
grounded_in:
  - source: rust/ULTIMATE_GOAL.md
  - source: src/config/schema.ts, src/config/validate.ts, src/local-config.ts, src/paths.ts, src/endpoints.ts, src/llm/types.ts, src/cli.ts and src/boot.ts, read 2026-10-22
  - source: _verifiers_/05-config-system/check.mjs, read 2026-10-22
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
| State | **contract landed**: every public item declared and documented; `Env`, `ConfigError`, home, paths, `LayerValue` and the serde shapes implemented with tests; the rest `todo!()` |

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
| `validate` | `ComponentCatalog` (trait), `SchemaLookup`, `StaticCatalog`, `ValidationResult`, `validate_rows` | `validate.ts` |
| `local` | `LocalConfig` (`endpoint_patches`), `LocalConfigLocation`, `local_config_candidates`, `read_local_config` | `src/local-config.ts` |
| `endpoints` | `EndpointConfig` (catalogue methods), `EndpointPatch`, `EndpointKind`, `ModelEntry`, `ModelOption`, `ReasoningLevel(s)`, `ReasoningValue`, `default_endpoints`, `environment_override`, `merge_endpoint`, `read_key_file`, `materialize_key`, `resolve_endpoints`, `describe_endpoint(s)`, `EndpointsView`, `selection_problem`, `config_paths` | `src/endpoints.ts`, `src/llm/types.ts` |
| `command` | `ConfigCommand`, `ConfigArgs`, `CommandContext`, `run` — `heddle profiles` and `heddle config [--json] [--origins] [--validate]`, output and exit codes | `runConfigCommand` |

### Who reads what

| Crate | Reads | Because the TypeScript build did, in |
|---|---|---|
| `heddle` (the binary) | `command::run`, `LayerOptions::for_run`, `default_layers`, `compose`, `anchor_dir`, `EntryRow::component`, `NamedLayer::inline`, `Layer::patching`, `profile_argument`, `Env`; implements `ComponentCatalog` | `cli.ts`, `boot.ts` |
| `heddle-llm` | `EndpointConfig` and its catalogue methods, `EndpointPatch`, `resolve_endpoints`, `describe_endpoint`, `read_local_config`, `local_config_candidates` | `plugins/model.ts`, the adapters |
| `heddle-server`, `heddle-web-composer` | `describe_endpoints`, `selection_problem`, `expand_home`, `canonical_path`, `is_under` | `server/web.ts` |
| `heddle-web-files` | `heddle_home`, `is_under` | `server/uploads.ts`, `server/attachments.ts` |
| `heddle-session`, `heddle-workspace` | `canonical_path`, `is_under`, `depth_of` | `session/*.ts`, `workspace/service.ts` |
| `heddle-context`, `heddle-sandbox` | `heddle_home`, `Env` | `context/service.ts`, `sandbox/service.ts` |

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

Kept as the TypeScript build has it, though inconsistent: `heddle --config X config` does not apply the project
patch beside `X`, while `heddle --config X --turn …` does (`LayerOptions::for_inspection` vs `for_run`).

## The port plan

Each step lands with its unit tests (`cargo test --manifest-path rust/Cargo.toml -p heddle-config`), in this order,
because each later step is checked through the earlier ones.

| Step | Bodies | Tests that can fail |
|---|---|---|
| 1 | done: `Env`, `ConfigError`, home, paths, `LayerValue`, serde shapes | 27 |
| 2 | `references_in`, `parse_scalar`, `resolve_env` | `!env` keeps a number's type; `${A}${A}` substitutes both; a missing name is an error naming it; `!include` in a value is refused |
| 3 | `read_layer`, `NamedLayer::read`, `anchor_dir` — a YAML reader that keeps `!env` / `!include` tags | include order; list includes; a cycle names every file; non-array, bad key, non-path include, empty file |
| 4 | `compose`, `origin_of`, `ComposedRow::to_report`, `EntryRow::component` | last write wins; patch replaces `config` whole; provenance drops only restated fields; remove keeps the row; duplicate insert; patch/remove of a missing row; every problem collected |
| 5 | `list_profiles`, `resolve_profile`, `profile_argument`, `LayerOptions`, `default_layers` | a symlinked profile is listed; unknown profile lists the known ones; absolute directory accepted; project patch beside the base, not the cwd |
| 6 | `Schema::check`, `validate_rows` | the number sentence; required, `additionalProperties: false`, `enum`, `anyOf`; disabled rows skipped; no-schema not counted |
| 7 | `command::run` | each text and JSON shape against the TypeScript output; exit codes |
| 8 | `local`, `endpoints` | candidate order; malformed file fails; env override only on a merge; new endpoint needs kind and baseUrl; exclude after merge; sort by name; no secret in `describe_endpoint`; each `selection_problem` sentence |
| 9 | `05-config-system` through `HEDDLE_BIN`, once the binary delegates to `command::run` | the verifier |

### Open questions

1. **The `--validate` check's fixture names `./alpha.ts`**, a TypeScript module with a Schemastery schema. Under
   `HEDDLE_BIN` no Rust catalog can read it, so that one check cannot pass unchanged; the other nine do not read
   the name. Proposed, as part 0's sanctioned shape: an outside component is named by a manifest beside the
   profile (`./alpha.component.yml`: `command`, and `config` as a JSON Schema), `--validate` reads the manifest
   without starting anything, and the verifier's `HEDDLE_BIN` branch writes manifests instead of `.ts` files. It
   touches part 4's outside-process protocol, so it is agreed with `heddle-tools` before it is built.
2. **YAML reader.** Step 3 needs one that exposes tags; the candidates are a maintained `serde_yaml` fork and
   `saphyr`. It goes into `[workspace.dependencies]` through the workspace's owner.
3. **`serde_json`'s `preserve_order`.** Off here. Features unify across the workspace, so turning it on changes
   every crate's map order; whichever crate needs byte-compatible JSON (the session log) asks for it workspace-wide.

## Read next

[`../INDEX.md`](../INDEX.md) for the other crates; [`../../ULTIMATE_GOAL.md`](../../ULTIMATE_GOAL.md) for the parts;
[`../../../_verifiers_/05-config-system/INDEX.md`](../../../_verifiers_/05-config-system/INDEX.md) for the claim.
