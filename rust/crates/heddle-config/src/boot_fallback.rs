//! A row the profile patch has broken does not stop the server (issue #213).
//!
//! A row whose configuration its schema or rule refuses fails when it starts, and every row that requires
//! its service waits forever: a patch holding `contextWindow: -5` left five rows pending and the binary
//! exited with "5 entr(y/ies) are still pending: …", naming neither the row, the value nor the file. Such a
//! patch comes from a hand edit, from a build that accepted the value, or from before a rule tightened.
//!
//! DSH keeps the running configuration when a written value is bad and refuses only Save, and #165 settled
//! the same for an unreadable patch. So before the tree starts, each enabled row is judged as
//! `config --validate` judges it ([`crate::judge_row`]). A refused row whose configuration the settings
//! target (the profile patch Settings writes) contributes to runs on its configuration composed without
//! Settings' block in that patch — the value Reset restores — when that one passes; Settings still shows
//! the block's value, a Save validates the whole candidate, and Reset removes it. Every refused row gets
//! one note naming it, the problem and the file, whether or not it could fall back.
//! `src/config/boot-fallback.ts` is the twin, word for word.

use std::path::Path;

use crate::compose::ComposedRow;
use crate::env::Env;
use crate::layer::{NamedLayer, anchor_dir};
use crate::validate::{ComponentCatalog, judge_row};

/// What boot starts: the rows, some of them on the value beneath the patch, and one note per refused row.
#[derive(Debug, Default)]
pub struct BootFallback {
    /// The rows to start, in their composed order.
    pub rows: Vec<ComposedRow>,
    /// One line per refused row, for stderr, each starting `heddle: `.
    pub notes: Vec<String>,
}

/// The file a refused row's configuration came from: the target when it wrote any of the row's config,
/// else the last writer.
fn config_file(row: &ComposedRow, target: Option<&str>) -> Option<String> {
    let config: Vec<&str> = row
        .fields
        .iter()
        .filter(|field| field.field == "config" || field.field.starts_with("config."))
        .map(|field| field.file.as_str())
        .collect();
    if let Some(target) = target
        && config.contains(&target)
    {
        return Some(target.to_owned());
    }
    config.last().map(|file| (*file).to_owned())
}

/// Judge `rows` (composed from `layers`) and fall back where Settings' block broke a row.
///
/// `beneath` is `layers` with the settings target's block taken out ([`crate::layers_beneath_settings`]),
/// and `target_file` that target's path; with either absent no row falls back, and each refused row is
/// only named.
pub fn boot_fallback(
    layers: &[NamedLayer],
    rows: Vec<ComposedRow>,
    beneath: Option<&[NamedLayer]>,
    target_file: Option<&Path>,
    env: &Env,
    catalog: &dyn ComponentCatalog,
) -> BootFallback {
    let anchor = anchor_dir(layers);
    let target = target_file.map(|path| path.to_string_lossy().into_owned());
    let mut under: Option<Option<Vec<ComposedRow>>> = None;
    let mut out = BootFallback::default();
    for composed in rows {
        let judged = judge_row(&composed.row, anchor.as_deref(), catalog);
        // A row that could not be judged (a component that does not resolve) fails as it always has, and
        // the loader says why.
        if !judged.checked || judged.problems.is_empty() {
            out.rows.push(composed);
            continue;
        }
        let file = config_file(&composed, target.as_deref());
        let said = judged.problems.join("; ");
        if let (Some(beneath), Some(target)) = (beneath, target.as_deref())
            && file.as_deref() == Some(target)
        {
            let fallen = under
                .get_or_insert_with(|| crate::compose::compose(beneath, env).ok())
                .as_ref()
                .and_then(|rows| {
                    rows.iter()
                        .find(|candidate| candidate.row.label() == composed.row.label())
                })
                .cloned();
            if let Some(fallen) = fallen {
                // Only the config is taken from beneath; the row that runs keeps its own component, enablement
                // and injections, so it is that row, with that config, that must pass — a hand-edited block can
                // change more than the config. Its config fields take the provenance of the layers they now come
                // from.
                let mut row = composed.row.clone();
                row.config = fallen.row.config.clone();
                let judged = judge_row(&row, anchor.as_deref(), catalog);
                if judged.checked && judged.problems.is_empty() {
                    let is_config = |field: &crate::compose::Provenance| {
                        field.field == "config" || field.field.starts_with("config.")
                    };
                    let mut fields: Vec<_> = composed
                        .fields
                        .iter()
                        .filter(|field| !is_config(field))
                        .cloned()
                        .collect();
                    fields.extend(
                        fallen
                            .fields
                            .iter()
                            .filter(|field| is_config(field))
                            .cloned(),
                    );
                    out.notes.push(format!(
                        "heddle: {said} (in {target}); this run uses the value beneath it until Settings saves or resets it"
                    ));
                    out.rows.push(ComposedRow {
                        row,
                        fields,
                        ..composed
                    });
                    continue;
                }
            }
        }
        out.notes.push(match &file {
            Some(file) => format!(
                "heddle: {said} (in {file}); fix it in the file or run `heddle config --validate`"
            ),
            None => format!("heddle: {said}; fix it in the file or run `heddle config --validate`"),
        });
        out.rows.push(composed);
    }
    out
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use serde_json::json;

    use super::*;
    use crate::{Schema, StaticCatalog};

    fn layer(name: &str, file: &str, text: &str) -> NamedLayer {
        NamedLayer::from_text(name, Path::new(file), text, &Env::default())
            .expect("the layer parses")
    }

    fn catalog() -> StaticCatalog {
        StaticCatalog::new().with(
            "alpha",
            Some(
                Schema::from_json(
                    json!({ "type": "object", "properties": { "count": { "type": "number" } } }),
                )
                .expect("the schema reads"),
            ),
        )
    }

    const TREE: &str =
        "- insert:\n    - id: alpha\n      name: alpha\n      config:\n        count: 1\n";
    const BROKEN: &str = "- patch:\n    - id: alpha\n      config:\n        count: many\n";

    #[test]
    fn a_row_the_target_broke_runs_on_the_value_beneath_with_one_note() {
        let tree = layer("base", "/p/cordis.yml", TREE);
        let layers = vec![
            tree.clone(),
            layer("p/heddle.patch.yml", "/p/heddle.patch.yml", BROKEN),
        ];
        let rows = crate::compose::compose(&layers, &Env::default()).expect("composes");
        let fallback = boot_fallback(
            &layers,
            rows,
            Some(&[tree]),
            Some(Path::new("/p/heddle.patch.yml")),
            &Env::default(),
            &catalog(),
        );
        assert_eq!(fallback.rows[0].row.config, Some(json!({ "count": 1 })));
        assert_eq!(fallback.notes.len(), 1);
        assert!(
            fallback.notes[0].starts_with("heddle: alpha: count ")
                && fallback.notes[0].ends_with(
                    "(in /p/heddle.patch.yml); this run uses the value beneath it until Settings saves or resets it"
                ),
            "{}",
            fallback.notes[0]
        );
    }

    #[test]
    fn the_running_row_with_the_config_from_beneath_must_pass_and_its_config_provenance_follows() {
        // developer-two's case: beneath, the row is disabled and holds a bad value; a hand-edited block enables
        // it with another bad value. The row that would run (enabled, with the value from beneath) fails, so
        // nothing falls back and the row is named.
        let tree = layer(
            "base",
            "/p/cordis.yml",
            "- insert:\n    - id: alpha\n      name: alpha\n      disabled: true\n      config:\n        count: many\n",
        );
        let block = "- patch:\n    - id: alpha\n      disabled: false\n      config:\n        count: also-invalid\n";
        let layers = vec![
            tree.clone(),
            layer("p/heddle.patch.yml", "/p/heddle.patch.yml", block),
        ];
        let rows = crate::compose::compose(&layers, &Env::default()).expect("composes");
        assert_eq!(
            rows[0].row.disabled,
            Some(false),
            "the block enables the row"
        );
        let fallback = boot_fallback(
            &layers,
            rows,
            Some(&[tree]),
            Some(Path::new("/p/heddle.patch.yml")),
            &Env::default(),
            &catalog(),
        );
        assert_eq!(
            fallback.rows[0].row.config,
            Some(json!({ "count": "also-invalid" }))
        );
        assert!(
            fallback.notes[0].ends_with("fix it in the file or run `heddle config --validate`"),
            "{}",
            fallback.notes[0]
        );

        // A fallback's config fields are reported from the layer the config now comes from.
        let tree = layer("base", "/p/cordis.yml", TREE);
        let layers = vec![
            tree.clone(),
            layer("p/heddle.patch.yml", "/p/heddle.patch.yml", BROKEN),
        ];
        let rows = crate::compose::compose(&layers, &Env::default()).expect("composes");
        let fallback = boot_fallback(
            &layers,
            rows,
            Some(&[tree]),
            Some(Path::new("/p/heddle.patch.yml")),
            &Env::default(),
            &catalog(),
        );
        let config_files: Vec<&str> = fallback.rows[0]
            .fields
            .iter()
            .filter(|field| field.field.starts_with("config"))
            .map(|field| field.file.as_str())
            .collect();
        assert_eq!(config_files, vec!["/p/cordis.yml"]);
    }

    #[test]
    fn with_nothing_beneath_the_row_is_kept_and_named() {
        let layers = vec![
            layer("base", "/p/cordis.yml", TREE),
            layer("overlay", "/elsewhere/overlay.yml", BROKEN),
        ];
        let rows = crate::compose::compose(&layers, &Env::default()).expect("composes");
        let fallback = boot_fallback(&layers, rows, None, None, &Env::default(), &catalog());
        assert_eq!(
            fallback.rows[0].row.config,
            Some(json!({ "count": "many" }))
        );
        assert_eq!(fallback.notes.len(), 1);
        assert!(
            fallback.notes[0].ends_with(
                "(in /elsewhere/overlay.yml); fix it in the file or run `heddle config --validate`"
            ),
            "{}",
            fallback.notes[0]
        );
    }

    #[test]
    fn a_valid_tree_is_started_as_composed_and_says_nothing() {
        let layers = vec![layer("base", "/p/cordis.yml", TREE)];
        let rows = crate::compose::compose(&layers, &Env::default()).expect("composes");
        let fallback = boot_fallback(&layers, rows, None, None, &Env::default(), &catalog());
        assert_eq!(fallback.rows.len(), 1);
        assert!(fallback.notes.is_empty());
    }
}
