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

pub mod command;
mod compose;
mod endpoints;
mod env;
mod error;
mod home;
mod layer;
mod local;
mod model_row;
pub mod paths;
mod profile;
mod references;
mod schema;
mod validate;
mod value;

pub use compose::{ComponentName, ComposedRow, EntryRow, Provenance, compose, origin_of};
pub use endpoints::{
    EndpointConfig, EndpointKind, EndpointPatch, EndpointsView, ModelEntry, ModelOption,
    ReasoningLevel, ReasoningLevels, ReasoningValue, config_paths, default_endpoints,
    describe_endpoint, describe_endpoints, environment_override, materialize_key, merge_endpoint,
    read_key_file, resolve_endpoints, selection_problem,
};
pub use env::Env;
pub use error::ConfigError;
pub use home::{expand_home, heddle_home, profiles_dir};
pub use layer::{INLINE_FILE, Layer, NamedLayer, anchor_dir, read_layer};
pub use local::{LocalConfig, LocalConfigLocation, local_config_candidates, read_local_config};
pub use model_row::{ModelRowEndpoints, model_row_endpoints, nominated_default};
pub use paths::{canonical_path, depth_of, is_under};
pub use profile::{
    LAYER_FILES, LayerOptions, PROJECT_BASE, PROJECT_PATCH, ProfileInfo, default_layers,
    list_profiles, profile_argument, resolve_profile,
};
pub use references::{parse_scalar, references_in, resolve_env};
pub use schema::{Additional, Schema, SchemaProblem, SchemaType, TypeSet};
pub use validate::{
    ComponentCatalog, ComponentManifest, ManifestCatalog, SchemaLookup, StaticCatalog,
    ValidationResult, read_component_manifest, validate_rows,
};
pub use value::{LayerValue, plain_json};
