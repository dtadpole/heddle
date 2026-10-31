//! `heddle-config` — the configuration tree: profiles, patch layers, includes, environment references,
//! validation and provenance; and the shared vocabulary every other crate reads configuration with —
//! [`Env`], `$HEDDLE_HOME`, the path rules, the machine's local file and endpoint configuration.
//!
//! Ported from the TypeScript build: `src/config/schema.ts`, `src/config/validate.ts`,
//! `src/local-config.ts`, `src/paths.ts`, `src/endpoints.ts`, the configuration half of
//! `src/llm/types.ts`, and the configuration commands of `src/cli.ts`. Judged through the `heddle`
//! binary (`HEDDLE_BIN`) by `_verifiers_/05-config-system`.
//!
//! # The model
//!
//! | Concept | What it is |
//! |---|---|
//! | layer | a YAML array of `insert`, `patch`, `remove` and `include` entries ([`read_layer`]) |
//! | profile | a named directory under `$HEDDLE_HOME/profiles/` holding a profile's layers ([`resolve_profile`]) |
//! | insert | adds a row, which later layers address by `id` |
//! | patch | restates a row's fields; **the last write wins**, and a patch replaces rather than merges |
//! | remove | disables a row, leaving it visible in the composition |
//! | include | another layer file, relative to the file naming it; a cycle is refused by path |
//! | `!env NAME` | a whole value from the environment, read so a number stays a number |
//! | `${NAME}` | textual substitution inside a string |
//!
//! # Use
//!
//! ```no_run
//! use heddle_config::{compose, default_layers, Env, LayerOptions};
//!
//! let env = Env::from_process();
//! let cwd = std::env::current_dir().unwrap();
//! let options = LayerOptions::for_run(Some("dev".into()), None, vec![], &cwd);
//! let layers = default_layers(&options, &env)?;
//! for composed in compose(&layers, &env)? {
//!     println!("{} from {:?}", composed.row.label(), composed.fields);
//! }
//! # Ok::<(), heddle_config::ConfigError>(())
//! ```
//!
//! # State
//!
//! Contract first, then the implementation: every public item is declared, documented and implemented,
//! with unit tests — [`Env`], [`ConfigError`], home, the [`paths`] rules, [`LayerValue`], the serde
//! shapes, environment references ([`references_in`], [`resolve_env`]), layers ([`read_layer`]),
//! composition with provenance ([`compose`], [`origin_of`]), profiles and layer options
//! ([`list_profiles`], [`LayerOptions`], [`default_layers`]), validation ([`Schema::check`],
//! [`validate_rows`]), the machine's local file and endpoints ([`read_local_config`],
//! [`resolve_endpoints`], [`describe_endpoint`]), and the configuration commands
//! ([`command::run`]). The port plan and what remains (step 9, the verifier) are in the crate's
//! `INDEX.md`.

mod builtin_forms;
pub mod command;
mod component_schemas;
mod compose;
mod endpoints;
mod env;
mod error;
mod home;
mod layer;
mod local;
mod locale;
mod model_row;
pub mod paths;
mod plugin_inventory;
mod presets;
mod profile;
mod references;
mod retry;
mod schema;
mod settings;
mod template;
mod validate;
mod value;

pub use builtin_forms::{
    HEDDLE_HOME_PLACEHOLDER, builtin_form, builtin_form_modules, form_problem,
};
pub use component_schemas::{
    context_schema, goal_schema, jobs_schema, schedule_schema, subagent_tool_schema, team_schema,
};
pub use compose::{ComponentName, ComposedRow, EntryRow, Provenance, compose, origin_of};
pub use endpoints::{
    EndpointConfig, EndpointKind, EndpointPatch, EndpointsView, ModelEntry, ModelOption,
    PAGE_ENDPOINT_FIELDS, ReasoningLevel, ReasoningLevels, ReasoningValue, config_paths,
    default_endpoints, describe_endpoint, describe_endpoints, describe_page_endpoint,
    environment_override, is_shipped_fixture, materialize_key, merge_endpoint, read_key_file,
    resolve_endpoints, selection_problem, unscripted_fixture_message,
};
pub use env::Env;
pub use error::ConfigError;
pub use home::{expand_home, heddle_home, profiles_dir};
pub use layer::{INLINE_FILE, Layer, NamedLayer, anchor_dir, read_layer};
pub use local::{LocalConfig, LocalConfigLocation, local_config_candidates, read_local_config};
pub use locale::{
    FALLBACK_LOCALE, LiveLocale, LocalePreference, SUPPORTED_LOCALES, accepted_languages,
    document_language, locale_label, locale_preference, locale_schema, negotiate_locale,
};
pub use model_row::{ModelRowEndpoints, ModelRowSource, model_row_endpoints, nominated_default};
pub use paths::{canonical_path, depth_of, is_under};
pub use plugin_inventory::{
    PluginFiberPhase, PluginInventoryEntry, PluginInventorySnapshot, plugin_inventory,
};
pub use presets::{
    PresetDefinition, PresetResolution, PresetRoster, missing_preset_message, preset_roster,
    standard_preset,
};
pub use profile::{
    LAYER_FILES, LayerOptions, PROJECT_BASE, PROJECT_PATCH, ProfileInfo, default_layers,
    list_profiles, profile_argument, resolve_profile,
};
pub use references::{parse_scalar, references_in, resolve_env};
pub use retry::{
    DEFAULT_INITIAL_DELAY_MS, DEFAULT_JITTER_RATIO, DEFAULT_MAX_DELAY_MS, DEFAULT_MAX_RETRIES,
    DEFAULT_RETRYABLE_CODES, MAX_TIMER_DELAY_MS, RetryFailure, RetryMode, RetryPlan, RetryPolicy,
    parse_retry_after, resolve_retry_policy, retry_failure_code,
};
pub use schema::{Additional, Schema, SchemaProblem, SchemaType, TypeSet};
pub use settings::{
    PlannedWrite, SETTINGS_BEGIN, SETTINGS_END, SecretSlot, SettingsApplier, SettingsError,
    SettingsNamespace, SettingsPathOp, SettingsResponse, SettingsRevisions, SettingsService,
    SettingsTarget, SettingsView, SettingsWrite, commit_settings_write, describe_settings,
    handle_settings_request, is_secret_key, plan_settings_write, settings_target,
};
pub use template::{PROFILE_TEMPLATES, reset_profile_from_template, template_files};
pub use validate::{
    ComponentCatalog, ComponentManifest, ManifestCatalog, SchemaLookup, StaticCatalog,
    ValidationResult, read_component_manifest, validate_rows,
};
pub use value::{LayerValue, plain_json};
