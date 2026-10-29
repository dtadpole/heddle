//! The model row's composition: the endpoint list a run offers, and the endpoint a caller gets when it
//! names none.
//!
//! Ported from `src/plugins/model.ts`. The row's own `endpoints` are applied over the defaults, then the
//! machine's file (`~/.heddle/heddle.json`, see [`crate::read_local_config`]) unless the row says
//! `readLocalConfig: false`; the file's `exclude` drops names after every layer. The **nominated default** is
//! `config.default ?? local?.config.default`: the row's `default` when it writes one, else the machine
//! file's, kept only when it names an endpoint the resolved list holds. The row wins for `default` even
//! though the machine's file wins for an endpoint's fields; that is the TypeScript build's rule, kept as is.

use std::path::PathBuf;

use crate::endpoints::{EndpointConfig, EndpointPatch, resolve_endpoints};
use crate::env::Env;
use crate::error::ConfigError;
use crate::local::{local_config_candidates, read_local_config};

/// What the model row composes to.
#[derive(Clone, Debug, PartialEq)]
pub struct ModelRowEndpoints {
    /// The endpoints, as [`resolve_endpoints`] returns them: sorted by name.
    pub endpoints: Vec<EndpointConfig>,
    /// The endpoint a caller means when it names none, if the configuration nominated one that exists.
    /// `None` leaves the caller to its own fallback (the model service takes the first endpoint).
    pub nominated: Option<String>,
    /// The machine file that was read, if any.
    pub local: Option<PathBuf>,
}

/// The nominated default (`config.default ?? local?.config.default`, then `service.endpoint(nominated)`).
///
/// The row's `default` is taken whenever it is written, even when it names no endpoint; the machine
/// file's is consulted only when the row writes none. Either is kept only when an endpoint of that name is
/// in `endpoints`, so an excluded or misspelled name is no default rather than a broken one.
pub fn nominated_default(
    row_default: Option<&str>,
    local_default: Option<&str>,
    endpoints: &[EndpointConfig],
) -> Option<String> {
    let candidate = row_default.or(local_default)?;
    endpoints
        .iter()
        .any(|endpoint| endpoint.name == candidate)
        .then(|| candidate.to_string())
}

/// Compose the model row as `plugins/model.ts` does: read the machine file when `read_local` (the row's
/// `readLocalConfig`, true unless written false), resolve the row's and the file's endpoints with the file's
/// exclusions, and nominate the default.
///
/// Fails as [`read_local_config`], [`crate::LocalConfig::endpoint_patches`] and [`resolve_endpoints`] fail.
pub fn model_row_endpoints(
    row_endpoints: &[EndpointPatch],
    row_default: Option<&str>,
    read_local: bool,
    env: &Env,
) -> Result<ModelRowEndpoints, ConfigError> {
    let location = if read_local {
        read_local_config(&local_config_candidates(env))?
    } else {
        None
    };
    let (local_endpoints, excluded, local_default) = match &location {
        Some(location) => (
            location.config.endpoint_patches(&location.path)?,
            location.config.exclude.clone().unwrap_or_default(),
            location.config.default.clone(),
        ),
        None => (Vec::new(), Vec::new(), None),
    };
    let endpoints = resolve_endpoints(row_endpoints, &local_endpoints, env, &excluded)?;
    let nominated = nominated_default(row_default, local_default.as_deref(), &endpoints);
    Ok(ModelRowEndpoints {
        endpoints,
        nominated,
        local: location.map(|location| location.path),
    })
}

/// The model row's composition kept current, as `plugins/model.ts` keeps it: [`ModelRowSource::changed`]
/// answers the recomposed endpoints when a machine-file candidate changed since it last looked (its path,
/// modification time and size), so an edit applies to the next request without a restart — DSH's provider
/// settings apply that way. A run with `readLocalConfig: false` never reads the file, now or later.
#[derive(Debug)]
pub struct ModelRowSource {
    row_endpoints: Vec<EndpointPatch>,
    row_default: Option<String>,
    read_local: bool,
    env: Env,
    candidates: Vec<PathBuf>,
    stamp: std::sync::Mutex<String>,
}

impl ModelRowSource {
    /// The row's composition inputs, with the candidates' stamp taken now.
    pub fn new(
        row_endpoints: Vec<EndpointPatch>,
        row_default: Option<String>,
        read_local: bool,
        env: Env,
    ) -> Self {
        let candidates = local_config_candidates(&env);
        let stamp = std::sync::Mutex::new(stamp_of(&candidates));
        Self {
            row_endpoints,
            row_default,
            read_local,
            env,
            candidates,
            stamp,
        }
    }

    /// The composition as the files stand now ([`model_row_endpoints`]).
    pub fn compose(&self) -> Result<ModelRowEndpoints, ConfigError> {
        model_row_endpoints(
            &self.row_endpoints,
            self.row_default.as_deref(),
            self.read_local,
            &self.env,
        )
    }

    /// `None` when nothing changed since the last look (or the row does not read the file); otherwise the
    /// recomposition, which fails as [`model_row_endpoints`] fails — a caller keeps its previous endpoints
    /// then. Either way the new stamp is kept, so one bad edit is reported once, not on every request.
    pub fn changed(&self) -> Option<Result<ModelRowEndpoints, ConfigError>> {
        if !self.read_local {
            return None;
        }
        let now = stamp_of(&self.candidates);
        {
            let mut stamp = self
                .stamp
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if *stamp == now {
                return None;
            }
            *stamp = now;
        }
        Some(self.compose())
    }
}

/// What identifies the candidate files' contents without reading them: path, modification time and size.
fn stamp_of(candidates: &[PathBuf]) -> String {
    candidates
        .iter()
        .map(|path| match std::fs::metadata(path) {
            Ok(metadata) => {
                let modified = metadata
                    .modified()
                    .ok()
                    .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|duration| duration.as_nanos())
                    .unwrap_or_default();
                format!("{}:{modified}:{}", path.display(), metadata.len())
            }
            Err(_) => format!("{}:absent", path.display()),
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::*;

    fn scratch(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "heddle-config-model-row-{}-{label}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A machine whose `~/.heddle/heddle.json` holds `text`, and nothing else in its environment.
    fn machine(root: &Path, text: &str) -> Env {
        let home = root.join("home");
        std::fs::create_dir_all(home.join(".heddle")).unwrap();
        std::fs::write(home.join(".heddle/heddle.json"), text).unwrap();
        Env::default().with("HOME", home.to_string_lossy())
    }

    /// A machine file shaped like the one D-052 wrote: four endpoints of its own, `default` naming one that
    /// sorts third, and the offline fixture excluded. The names are neutral; the shape is what matters.
    const MACHINE: &str = r#"{
        "default": "router-a",
        "exclude": ["scripted"],
        "endpoints": [
            {"name": "router-a", "kind": "openai-chat", "baseUrl": "http://127.0.0.1:9/v1", "model": "model-a"},
            {"name": "router-b", "kind": "openai-chat", "baseUrl": "http://127.0.0.1:9/v1", "model": "model-b"},
            {"name": "fusion", "kind": "openai-chat", "baseUrl": "http://127.0.0.1:9/v1", "model": "model-c"},
            {"name": "official", "kind": "openai-chat", "baseUrl": "http://127.0.0.1:9/v1", "model": "model-d"}
        ]
    }"#;

    fn names(composed: &ModelRowEndpoints) -> Vec<&str> {
        composed
            .endpoints
            .iter()
            .map(|endpoint| endpoint.name.as_str())
            .collect()
    }

    #[test]
    fn the_machine_files_default_is_the_nominated_endpoint() {
        // 05's claim, that the composition never silently ignores a layer, applied to the machine file: the
        // Rust preview listed a file like this one but reported `default: null`, and an unnamed turn went to
        // the first endpoint by name (`fusion` here) instead of the one the file names.
        let root = scratch("machine");
        let env = machine(&root, MACHINE);
        let composed = model_row_endpoints(&[], None, true, &env).unwrap();
        assert_eq!(
            names(&composed),
            ["fusion", "official", "router-a", "router-b"],
            "sorted by name, the offline fixture excluded"
        );
        assert_eq!(composed.nominated.as_deref(), Some("router-a"));
        assert_eq!(
            composed.local,
            Some(root.join("home/.heddle/heddle.json")),
            "the file that was read is reported"
        );
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn the_rows_default_wins_over_the_machine_files() {
        let root = scratch("row-wins");
        let env = machine(&root, MACHINE);
        let composed = model_row_endpoints(&[], Some("router-b"), true, &env).unwrap();
        assert_eq!(composed.nominated.as_deref(), Some("router-b"));
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn a_rows_default_naming_no_endpoint_does_not_fall_back_to_the_machines() {
        // `config.default ?? local?.config.default`: a written row default is taken even when it names nothing,
        // so the machine's `router-a` is not consulted and there is no nominated default at all.
        let root = scratch("no-fallback");
        let env = machine(&root, MACHINE);
        let composed = model_row_endpoints(&[], Some("nowhere"), true, &env).unwrap();
        assert_eq!(composed.nominated, None);
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn a_default_naming_an_excluded_endpoint_is_no_default() {
        let root = scratch("excluded");
        let env = machine(
            &root,
            r#"{"default": "scripted", "exclude": ["scripted"], "endpoints": [
                {"name": "a", "kind": "openai-chat", "baseUrl": "http://127.0.0.1:9/v1", "model": "m"}]}"#,
        );
        let composed = model_row_endpoints(&[], None, true, &env).unwrap();
        assert_eq!(names(&composed), ["a"]);
        assert_eq!(composed.nominated, None);
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn read_local_config_false_ignores_the_machine_file_and_its_default() {
        let root = scratch("no-local");
        let env = machine(&root, MACHINE);
        let composed = model_row_endpoints(&[], None, false, &env).unwrap();
        assert_eq!(
            names(&composed),
            ["scripted"],
            "only the repository's offline default"
        );
        assert_eq!(composed.nominated, None);
        assert_eq!(composed.local, None);

        let composed = model_row_endpoints(&[], Some("scripted"), false, &env).unwrap();
        assert_eq!(composed.nominated.as_deref(), Some("scripted"));
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn no_machine_file_leaves_only_the_rows_default() {
        let root = scratch("no-file");
        let env = Env::default().with("HOME", root.join("empty-home").to_string_lossy());
        let composed = model_row_endpoints(&[], None, true, &env).unwrap();
        assert_eq!(composed.nominated, None);
        assert_eq!(composed.local, None);
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn a_default_or_exclude_of_the_wrong_type_is_ignored_as_the_typescript_build_ignores_it() {
        // `typeof nominated === 'string'` and `Array.isArray(local.config.exclude)`: the TypeScript build reads
        // the file as plain JSON and skips a field of the wrong shape rather than refusing the whole file.
        let root = scratch("wrong-types");
        let env = machine(
            &root,
            r#"{"default": 7, "exclude": "scripted", "endpoints": [
                {"name": "a", "kind": "openai-chat", "baseUrl": "http://127.0.0.1:9/v1", "model": "m"}]}"#,
        );
        let composed = model_row_endpoints(&[], None, true, &env).unwrap();
        assert_eq!(
            names(&composed),
            ["a", "scripted"],
            "a non-list exclude excludes nothing"
        );
        assert_eq!(
            composed.nominated, None,
            "a non-string default nominates nothing"
        );
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn nominated_default_follows_the_typescript_rule() {
        let endpoints: Vec<EndpointConfig> = crate::default_endpoints();
        let scripted = Some("scripted");
        assert_eq!(nominated_default(None, None, &endpoints), None);
        assert_eq!(
            nominated_default(None, scripted, &endpoints).as_deref(),
            scripted
        );
        assert_eq!(
            nominated_default(scripted, Some("other"), &endpoints).as_deref(),
            scripted
        );
        assert_eq!(nominated_default(Some("other"), scripted, &endpoints), None);
        assert_eq!(
            nominated_default(Some(""), scripted, &endpoints),
            None,
            "an empty row default is still written"
        );
    }

    #[test]
    fn a_source_answers_the_recomposition_once_per_edit_of_the_machine_file() {
        let root = scratch("source");
        let env = machine(&root, MACHINE);
        let file = root.join("home/.heddle/heddle.json");
        let source = ModelRowSource::new(Vec::new(), None, true, env.clone());
        assert!(
            source.changed().is_none(),
            "nothing changed since it was built"
        );
        assert_eq!(
            source.compose().unwrap().nominated.as_deref(),
            Some("router-a")
        );

        std::fs::write(
            &file,
            MACHINE.replace("\"default\": \"router-a\"", "\"default\": \"router-b\""),
        )
        .unwrap();
        let changed = source.changed().expect("an edit is noticed").unwrap();
        assert_eq!(
            changed.nominated.as_deref(),
            Some("router-b"),
            "the next request reads the edit"
        );
        assert!(source.changed().is_none(), "and only once");

        std::fs::write(&file, "{ not json").unwrap();
        assert!(
            source.changed().expect("noticed").is_err(),
            "an unreadable edit is reported"
        );
        assert!(source.changed().is_none(), "once, not on every request");

        let fixed = MACHINE.replace("\"default\": \"router-a\"", "\"default\": \"fusion\"");
        std::fs::write(&file, fixed).unwrap();
        assert_eq!(
            source.changed().unwrap().unwrap().nominated.as_deref(),
            Some("fusion"),
            "the next good edit applies"
        );

        let silent = ModelRowSource::new(Vec::new(), None, false, env);
        std::fs::write(&file, MACHINE).unwrap();
        assert!(
            silent.changed().is_none(),
            "readLocalConfig false never reads the file"
        );
        std::fs::remove_dir_all(&root).unwrap();
    }
}
