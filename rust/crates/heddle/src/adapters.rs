//! One adapter per built-in: the composition root's half of each crate.
//!
//! The binary does not re-implement a plugin. For each built-in it reads the row's `config` into the
//! owning crate's typed config, takes whatever the module injects from [`Services`], constructs the
//! crate's service, and registers it twice under the service name: the crate's own handle, which
//! another built-in's adapter takes to construct itself, and the narrow [`ports`](crate::ports) view
//! the commands read.
//!
//! An adapter is built by [`BuiltinCatalog`](crate::builtins::BuiltinCatalog) with the run's [`Env`],
//! because a row's configuration may name an environment reference and the machine's own endpoint file
//! lives outside the checkout. Each one lands as its crate's API does; the catalog returns `None` for a
//! built-in whose adapter is not written yet, which leaves that row failed rather than silently absent.

use std::sync::Arc;

use heddle_config::{
    EndpointPatch, Env, local_config_candidates, read_local_config, resolve_endpoints,
};
use serde::Deserialize;
use serde_json::Value;

use crate::builtins::Component;
use crate::ports::{ModelPort, Record};
use crate::services::Services;

/// `src/plugins/model.ts`: one model service over the endpoints the layers and the machine declare.
pub struct ModelComponent {
    env: Env,
}

impl ModelComponent {
    /// The adapter for a run whose environment is this one.
    pub fn new(env: Env) -> Self {
        Self { env }
    }
}

/// The model row's config, as `plugins/model.ts` declares it: endpoints, the nominated default, and
/// whether the machine's own file is read.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct ModelConfig {
    endpoints: Vec<EndpointPatch>,
    default: Option<String>,
    read_local_config: bool,
}

impl Default for ModelConfig {
    fn default() -> Self {
        Self {
            endpoints: Vec::new(),
            default: None,
            // `readLocalConfig` defaults to true: the machine's file is where a real endpoint lives.
            read_local_config: true,
        }
    }
}

/// The model row's schema, the subset of `plugins/model.ts`'s Schemastery that `--validate` can check
/// without starting anything.
fn model_schema() -> Option<heddle_config::Schema> {
    heddle_config::Schema::from_json(serde_json::json!({
        "type": "object",
        "properties": {
            "endpoints": { "type": "array" },
            "default": { "type": "string" },
            "readLocalConfig": { "type": "boolean" },
        },
    }))
    .ok()
}

impl Component for ModelComponent {
    fn requires(&self) -> Vec<String> {
        // `plugins/model.ts` injects nothing.
        Vec::new()
    }

    fn schema(&self) -> Option<heddle_config::Schema> {
        model_schema()
    }

    fn start(&self, config: &Value, services: &mut Services) -> Result<(), String> {
        let config: ModelConfig =
            serde_json::from_value(config.clone()).map_err(|error| format!("model: {error}"))?;
        let mut local_endpoints = Vec::new();
        let mut excluded = Vec::new();
        if config.read_local_config {
            let candidates = local_config_candidates(&self.env);
            match read_local_config(&candidates) {
                Ok(Some(location)) => {
                    local_endpoints = location
                        .config
                        .endpoint_patches(&location.path)
                        .map_err(|error| error.to_string())?;
                    excluded = location.config.exclude.clone().unwrap_or_default();
                }
                Ok(None) => {}
                Err(error) => return Err(error.to_string()),
            }
        }
        // The layering rule is the configuration crate's: defaults, then the layers, then the machine's
        // file, with the environment's overrides and the exclusions applied last.
        let endpoints =
            resolve_endpoints(&config.endpoints, &local_endpoints, &self.env, &excluded)
                .map_err(|error| error.to_string())?;
        let service =
            heddle_llm::ModelService::from_configuration(endpoints, config.default.as_deref())
                .map_err(|error| error.to_string())?;
        let service = Arc::new(service);
        services.provide("model", Arc::clone(&service));
        services.provide(
            "model",
            Arc::new(ModelView {
                service: Arc::clone(&service),
            }) as Arc<dyn ModelPort>,
        );
        Ok(())
    }
}

/// `ctx.model` over `heddle-llm`'s service: the commands' narrow view.
struct ModelView {
    service: Arc<heddle_llm::ModelService>,
}

impl ModelPort for ModelView {
    fn describe(&self) -> Vec<Record> {
        self.service
            .list()
            .iter()
            .map(heddle_config::describe_endpoint)
            .collect()
    }

    fn names(&self) -> Vec<String> {
        self.service.names()
    }

    fn default_endpoint(&self) -> Option<String> {
        self.service.default_endpoint(None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn scratch(label: &str) -> std::path::PathBuf {
        use std::sync::atomic::{AtomicUsize, Ordering};
        static COUNTER: AtomicUsize = AtomicUsize::new(0);
        let unique = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "heddle-adapters-{label}-{}-{unique}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("a scratch directory");
        dir
    }

    fn env_at(home: &std::path::Path) -> Env {
        Env::from_pairs([
            ("HEDDLE_HOME", home.to_string_lossy().into_owned()),
            ("HOME", home.to_string_lossy().into_owned()),
        ])
    }

    /// A scripted endpoint's file, which its configuration names as `baseUrl`.
    fn script(home: &std::path::Path) -> String {
        let path = home.join("script.json");
        std::fs::write(&path, json!({ "steps": [] }).to_string()).expect("the script file");
        path.to_string_lossy().into_owned()
    }

    #[test]
    fn the_model_row_composes_the_endpoints_and_answers_as_a_port() {
        let home = scratch("model");
        let script = script(&home);
        let component = ModelComponent::new(env_at(&home));
        let mut services = Services::new();
        component
            .start(
                &json!({
                    "endpoints": [{
                        "name": "double",
                        "kind": "scripted",
                        "baseUrl": script,
                        "model": "scripted",
                    }],
                    "default": "double",
                    "readLocalConfig": false,
                }),
                &mut services,
            )
            .expect("the model row starts");
        let model = services.model().expect("ctx.model is provided");
        let described = model.describe();
        let double = described
            .iter()
            .find(|endpoint| endpoint["name"] == "double")
            .expect("the declared endpoint is described");
        assert_eq!(double["kind"], "scripted");
        let mut names = model.names();
        names.sort();
        assert_eq!(
            names,
            vec!["double".to_owned(), "scripted".to_owned()],
            "the declared endpoint joins the offline default the configuration always offers"
        );
        assert_eq!(
            model.default_endpoint(),
            Some("double".to_owned()),
            "the row's nominated default wins over the first endpoint"
        );
        assert!(
            services
                .get::<Arc<heddle_llm::ModelService>>("model")
                .is_some(),
            "the crate's own handle is registered for another adapter to construct itself with"
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn the_machines_own_file_is_read_when_the_row_asks() {
        let home = scratch("model-local");
        let script = script(&home);
        std::fs::write(
            home.join("heddle.json"),
            json!({
                "endpoints": [{
                    "name": "local",
                    "kind": "scripted",
                    "baseUrl": script,
                    "model": "scripted",
                }],
            })
            .to_string(),
        )
        .expect("the machine's file");
        let component = ModelComponent::new(env_at(&home));
        let mut services = Services::new();
        component
            .start(&json!({ "endpoints": [] }), &mut services)
            .expect("the model row starts");
        let model = services.model().expect("ctx.model is provided");
        assert!(
            model.names().contains(&"local".to_owned()),
            "the machine's endpoint is offered: {:?}",
            model.names()
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn a_row_that_asks_not_to_read_it_ignores_the_machines_file() {
        let home = scratch("model-no-local");
        let script = script(&home);
        std::fs::write(
            home.join("heddle.json"),
            json!({
                "endpoints": [{
                    "name": "local",
                    "kind": "scripted",
                    "baseUrl": script,
                }],
            })
            .to_string(),
        )
        .expect("the machine's file");
        let component = ModelComponent::new(env_at(&home));
        let mut services = Services::new();
        component
            .start(
                &json!({
                    "endpoints": [{
                        "name": "declared",
                        "kind": "scripted",
                        "baseUrl": script,
                        "model": "scripted",
                    }],
                    "readLocalConfig": false,
                }),
                &mut services,
            )
            .expect("the model row starts");
        let model = services.model().expect("ctx.model is provided");
        assert!(model.names().contains(&"declared".to_owned()));
        assert!(
            !model.names().contains(&"local".to_owned()),
            "the machine's file was not read: {:?}",
            model.names()
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn a_config_the_row_cannot_hold_fails_naming_the_plugin() {
        let home = scratch("model-bad");
        let component = ModelComponent::new(env_at(&home));
        let mut services = Services::new();
        let error = component
            .start(
                &json!({ "endpoints": "not a list", "readLocalConfig": false }),
                &mut services,
            )
            .expect_err("a bad config is refused");
        assert!(error.starts_with("model:"), "{error}");
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn an_unknown_endpoint_kind_is_the_configuration_crates_sentence() {
        let home = scratch("model-kind");
        let script = script(&home);
        let component = ModelComponent::new(env_at(&home));
        let mut services = Services::new();
        let error = component
            .start(
                &json!({
                    "endpoints": [{
                        "name": "odd",
                        "kind": "no-such-kind",
                        "baseUrl": script,
                    }],
                    "readLocalConfig": false,
                }),
                &mut services,
            )
            .expect_err("an unknown kind is refused");
        assert!(error.to_lowercase().contains("no-such-kind"), "{error}");
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn the_model_row_declares_the_schema_validate_checks_it_against() {
        let schema = model_schema().expect("the model schema parses");
        assert!(
            schema
                .check(&json!({ "endpoints": [], "default": "x" }))
                .is_empty(),
            "a config the row may hold is accepted"
        );
        assert_eq!(
            schema.check(&json!({ "endpoints": "nope" })).len(),
            1,
            "an endpoint list that is not a list is what --validate reports"
        );
    }
}
