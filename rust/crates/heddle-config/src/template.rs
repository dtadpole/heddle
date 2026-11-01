//! Profile templates: DSH's `--profile <name> --from-default-profile <template>` replaces a custom profile with a
//! fresh copy of a shipped template, then boots it. heddle ships one template, `default`: the checkout's own tree
//! (`cordis.yml` and `heddle.patch.yml`), with every relative row name made absolute so the profile boots from any
//! directory. `src/config/profile-template.ts` is the TypeScript twin and writes the same files.
//!
//! Only `$HEDDLE_HOME/profiles/<name>` is touched, and only for a plain name. The fresh copy is written beside it
//! and renamed into place, so an interrupted reset leaves either the old profile or the new one, never half of each.

use std::path::Path;

use crate::env::Env;
use crate::error::ConfigError;
use crate::home::profiles_dir;
use crate::profile::{ProfileInfo, resolve_profile};

/// The templates heddle ships.
pub const PROFILE_TEMPLATES: [&str; 1] = ["default"];

/// The files template `default` holds, from `checkout`: the base as written, the patch with absolute row names.
///
/// # Errors
///
/// A checkout file that cannot be read, named.
pub fn template_files(checkout: &Path) -> Result<Vec<(String, String)>, ConfigError> {
    let read = |file: &str| {
        std::fs::read_to_string(checkout.join(file)).map_err(|error| {
            ConfigError::one(format!(
                "the default profile template reads {}: {error}",
                checkout.join(file).display()
            ))
        })
    };
    let root = checkout.to_string_lossy();
    let patch = read("heddle.patch.yml")?
        .split_inclusive('\n')
        .map(|line| absolute_name(line, &root))
        .collect::<String>();
    Ok(vec![
        ("cordis.yml".to_owned(), read("cordis.yml")?),
        ("heddle.patch.yml".to_owned(), patch),
    ])
}

/// One line with a relative `name: ./…` made absolute under `root`; every other line as it is.
fn absolute_name(line: &str, root: &str) -> String {
    let indent = line.len() - line.trim_start().len();
    let mut rest = &line[indent..];
    let mut lead = line[..indent].to_owned();
    if let Some(after) = rest.strip_prefix('-')
        && after.starts_with(char::is_whitespace)
    {
        let spaces = after.len() - after.trim_start().len();
        lead.push('-');
        lead.push_str(&after[..spaces]);
        rest = &after[spaces..];
    }
    let Some(value) = rest.strip_prefix("name:") else {
        return line.to_owned();
    };
    let spaces = value.len() - value.trim_start().len();
    match value[spaces..].strip_prefix("./") {
        Some(path) => format!("{lead}name:{}{root}/{path}", &value[..spaces]),
        None => line.to_owned(),
    }
}

/// Replace profile `name` with a fresh copy of `template` from `checkout`, and answer the profile as
/// [`resolve_profile`] reads it.
///
/// # Errors
///
/// A name that is not a plain name, a template heddle does not ship, a checkout file that cannot be read, or a
/// directory that cannot be written; nothing is replaced in any of those cases.
pub fn reset_profile_from_template(
    name: &str,
    template: &str,
    checkout: &Path,
    env: &Env,
) -> Result<ProfileInfo, ConfigError> {
    let plain = name
        .chars()
        .next()
        .is_some_and(|c| c.is_ascii_alphanumeric())
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'));
    if !plain {
        return Err(ConfigError::one(format!(
            "--from-default-profile names a profile by a plain name, not '{name}'"
        )));
    }
    if !PROFILE_TEMPLATES.contains(&template) {
        return Err(ConfigError::one(format!(
            "unknown profile template '{template}'; heddle ships: {}",
            PROFILE_TEMPLATES.join(", ")
        )));
    }
    let files = template_files(checkout)?;
    let fail = |error: std::io::Error| {
        ConfigError::one(format!(
            "the profile '{name}' could not be written: {error}"
        ))
    };
    let root = profiles_dir(env);
    std::fs::create_dir_all(&root).map_err(fail)?;
    let dir = root.join(name);
    let staging = root.join(format!(".{name}.template-{}", std::process::id()));
    let replaced = root.join(format!(".{name}.replaced-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&staging);
    std::fs::create_dir(&staging).map_err(fail)?;
    for (file, text) in &files {
        std::fs::write(staging.join(file), text).map_err(fail)?;
    }
    if dir.exists() {
        std::fs::rename(&dir, &replaced).map_err(fail)?;
    }
    std::fs::rename(&staging, &dir).map_err(fail)?;
    let _ = std::fs::remove_dir_all(&replaced);
    resolve_profile(name, env)
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;

    fn scratch(label: &str) -> (PathBuf, PathBuf, Env) {
        let root = std::env::temp_dir().join(format!(
            "heddle-config-template-{}-{label}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        let checkout = root.join("checkout");
        std::fs::create_dir_all(&checkout).unwrap();
        std::fs::write(checkout.join("cordis.yml"), "# base\n[]\n").unwrap();
        std::fs::write(
            checkout.join("heddle.patch.yml"),
            "- insert:\n    - id: model\n      name: ./src/plugins/model.ts\n    - id: outside\n      name: /opt/tools/x.json\n",
        )
        .unwrap();
        let env = Env::default()
            .with("HEDDLE_HOME", root.join("home").to_string_lossy())
            .with("HOME", root.to_string_lossy());
        (root, checkout, env)
    }

    #[test]
    fn the_default_template_is_the_checkout_tree_with_absolute_row_names() {
        let (root, checkout, _) = scratch("files");
        let files = template_files(&checkout).unwrap();
        assert_eq!(
            files[0],
            ("cordis.yml".to_owned(), "# base\n[]\n".to_owned())
        );
        assert_eq!(
            files[1].1,
            format!(
                "- insert:\n    - id: model\n      name: {}/src/plugins/model.ts\n    - id: outside\n      name: /opt/tools/x.json\n",
                checkout.display()
            ),
            "the bytes the TypeScript build writes"
        );
        assert_eq!(absolute_name("- name: ./a.ts\n", "/r"), "- name: /r/a.ts\n");
        assert_eq!(absolute_name("  label: ./a\n", "/r"), "  label: ./a\n");
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_custom_profile_is_replaced_by_a_fresh_copy_nothing_of_the_old_one_kept() {
        let (root, checkout, env) = scratch("replace");
        let dir = root.join("home/profiles/mine");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("cordis.yml"),
            "- insert:\n    - id: custom\n      name: custom\n",
        )
        .unwrap();
        std::fs::write(dir.join("notes.txt"), "hand-made").unwrap();
        let profile = reset_profile_from_template("mine", "default", &checkout, &env).unwrap();
        assert_eq!(profile.name, "mine");
        let mut names: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        assert_eq!(names, vec!["cordis.yml", "heddle.patch.yml"]);
        assert_eq!(
            std::fs::read_to_string(dir.join("cordis.yml")).unwrap(),
            "# base\n[]\n"
        );
        let siblings: Vec<String> = std::fs::read_dir(root.join("home/profiles"))
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            siblings,
            vec!["mine"],
            "no staging directory is left behind"
        );
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn an_unknown_template_or_a_path_is_refused_before_anything_is_written() {
        let (root, checkout, env) = scratch("refuse");
        assert_eq!(
            reset_profile_from_template("fresh", "default", &checkout, &env)
                .unwrap()
                .name,
            "fresh"
        );
        let unknown = reset_profile_from_template("other", "web", &checkout, &env).unwrap_err();
        assert_eq!(
            unknown.problems(),
            ["unknown profile template 'web'; heddle ships: default"]
        );
        // The binary only turns away a directory argument; every other name rests on this rule.
        for name in ["../escape", "a/b", "", ".hidden", "..", "-flag"] {
            let refused =
                reset_profile_from_template(name, "default", &checkout, &env).unwrap_err();
            assert!(
                refused.problems()[0].contains("plain name"),
                "'{name}' is not a plain name"
            );
        }
        assert!(!root.join("home/profiles/a").exists());
        assert!(!root.join("home/profiles/other").exists());
        assert!(!root.join("home/escape").exists());
        std::fs::remove_dir_all(&root).ok();
    }
}
