//! The in-page folder chooser's two host primitives — a port of `src/server/directories.ts`.
//!
//! DSH picks a workspace directory one of two ways: the native backend opens the operating system's dialog **on the
//! machine the harness runs on**, and the browse backend (`dsh-host-directory-picker-browse`) lists the host's folders
//! to an in-app *Select Workspace Directory* dialog that works from any browser. heddle is reached through a gate and
//! a public edge, so the page is usually remote and only the second can be seen. Both servers serve the same answers:
//!
//! | Method and path | Answers |
//! |---|---|
//! | `GET /api/directories?path=` | `200` pretty [`DirectoryListing`] · `400 {error, code: "directory-picker/unreadable"}` relative, missing, not a folder or unreadable |
//! | `POST /api/directories` | body `{"parent", "name"}` · `400 text "the body must be JSON\n"` · `200` pretty `{"path"}` · `409 {error, code: "directory-picker/exists"}` · `400 {error, code: "directory-picker/create-failed"}` |
//!
//! A listing names directories only, name-sorted, following symlinks to directories and skipping broken ones, with a
//! `hidden` flag for dot-names, the account's `home` and the root-to-target `crumbs`; no path lists the home
//! directory; at most [`MAX_DIRECTORY_ENTRIES`] rows, `truncated` when cut. Creation is non-recursive and takes one
//! path segment. Paths go out canonical (`realpath`), the form a workspace is registered under.

use std::path::{Path, PathBuf};

use serde::Serialize;

/// The largest number of rows one listing returns; DSH's `maxEntries` default.
pub const MAX_DIRECTORY_ENTRIES: usize = 1000;

const UNREADABLE: &str = "directory-picker/unreadable";
const CREATE_FAILED: &str = "directory-picker/create-failed";
const EXISTS: &str = "directory-picker/exists";

/// One child folder.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DirectoryEntry {
    pub name: String,
    pub path: String,
    pub hidden: bool,
}

/// One step of the root-to-target chain; the root is labelled `/`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DirectoryCrumb {
    pub name: String,
    pub path: String,
}

/// One directory level, as the page's chooser draws it. Field order is `listDirectory`'s.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DirectoryListing {
    pub path: String,
    pub home: String,
    pub parent: Option<String>,
    pub crumbs: Vec<DirectoryCrumb>,
    pub entries: Vec<DirectoryEntry>,
    pub truncated: bool,
}

/// A refusal: the status the route answers, the sentence, and DSH's stable code.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DirectoryError {
    pub status: u16,
    pub message: String,
    pub code: &'static str,
}

impl DirectoryError {
    fn new(status: u16, message: impl Into<String>, code: &'static str) -> Self {
        Self {
            status,
            message: message.into(),
            code,
        }
    }
}

/// The account's home, as `os.homedir()` reads it.
pub fn home_dir() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/"))
}

fn text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

/// `~` and `~/…` against the home; anything else as given.
fn expand_tilde(raw: &str, home: &Path) -> PathBuf {
    if raw == "~" {
        return home.to_path_buf();
    }
    if let Some(rest) = raw.strip_prefix("~/") {
        return home.join(rest);
    }
    PathBuf::from(raw)
}

/// An existing directory, canonical, or the refusal saying which of the three it is not.
fn existing_directory(
    raw: &str,
    home: &Path,
    code: &'static str,
) -> Result<PathBuf, DirectoryError> {
    let path = expand_tilde(raw, home);
    if !path.to_string_lossy().starts_with('/') {
        return Err(DirectoryError::new(400, "the path must be absolute", code));
    }
    let real = std::fs::canonicalize(&path)
        .map_err(|_| DirectoryError::new(400, format!("{raw} does not exist"), code))?;
    if !real.is_dir() {
        return Err(DirectoryError::new(
            400,
            format!("{raw} is not a folder"),
            code,
        ));
    }
    Ok(real)
}

fn crumbs_of(path: &str) -> Vec<DirectoryCrumb> {
    let mut crumbs = vec![DirectoryCrumb {
        name: "/".to_string(),
        path: "/".to_string(),
    }];
    let mut at = String::new();
    for segment in path.split('/').filter(|part| !part.is_empty()) {
        at.push('/');
        at.push_str(segment);
        crumbs.push(DirectoryCrumb {
            name: segment.to_string(),
            path: at.clone(),
        });
    }
    crumbs
}

fn child(base: &str, name: &str) -> String {
    if base == "/" {
        format!("/{name}")
    } else {
        format!("{base}/{name}")
    }
}

/// The node `io::ErrorKind` name `listDirectory` reports (`EACCES`, `ENOENT`, …), else the error's text.
fn errno_name(error: &std::io::Error) -> String {
    match error.kind() {
        std::io::ErrorKind::PermissionDenied => "EACCES".to_string(),
        std::io::ErrorKind::NotFound => "ENOENT".to_string(),
        std::io::ErrorKind::AlreadyExists => "EEXIST".to_string(),
        _ => error.to_string(),
    }
}

/// One directory level; `raw` absent or blank lists `home`.
pub fn list_directory(raw: Option<&str>, home: &Path) -> Result<DirectoryListing, DirectoryError> {
    let requested = match raw.map(str::trim) {
        Some(value) if !value.is_empty() => value.to_string(),
        _ => text(home),
    };
    let path = existing_directory(&requested, home, UNREADABLE)?;
    let reader = std::fs::read_dir(&path).map_err(|error| {
        DirectoryError::new(
            400,
            format!("cannot read {requested}: {}", errno_name(&error)),
            UNREADABLE,
        )
    })?;
    let mut names: Vec<String> = Vec::new();
    for entry in reader.flatten() {
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        let enterable = if kind.is_dir() {
            true
        } else if kind.is_symlink() {
            // A broken or cyclic link is not a folder anyone can enter.
            std::fs::metadata(entry.path()).is_ok_and(|metadata| metadata.is_dir())
        } else {
            false
        };
        if enterable {
            names.push(entry.file_name().to_string_lossy().into_owned());
        }
    }
    // Code-unit order, as `listDirectory`'s comparison sorts.
    names.sort_by(|left, right| left.encode_utf16().cmp(right.encode_utf16()));
    let truncated = names.len() > MAX_DIRECTORY_ENTRIES;
    names.truncate(MAX_DIRECTORY_ENTRIES);
    let base = text(&path);
    let real_home = std::fs::canonicalize(home).unwrap_or_else(|_| home.to_path_buf());
    Ok(DirectoryListing {
        parent: if base == "/" {
            None
        } else {
            Some(path.parent().map(text).unwrap_or_else(|| "/".to_string()))
        },
        crumbs: crumbs_of(&base),
        entries: names
            .into_iter()
            .map(|name| DirectoryEntry {
                path: child(&base, &name),
                hidden: name.starts_with('.'),
                name,
            })
            .collect(),
        truncated,
        home: text(&real_home),
        path: base,
    })
}

/// Create one child folder under an existing parent; answers the new folder's canonical path.
pub fn create_directory(
    parent: Option<&str>,
    name: Option<&str>,
    home: &Path,
) -> Result<String, DirectoryError> {
    let Some(parent) = parent.map(str::trim).filter(|value| !value.is_empty()) else {
        return Err(DirectoryError::new(
            400,
            "a parent folder is required",
            CREATE_FAILED,
        ));
    };
    let leaf = name.map(str::trim).unwrap_or("");
    if leaf.is_empty() || leaf == "." || leaf == ".." || leaf.contains(['/', '\\', '\0']) {
        return Err(DirectoryError::new(
            400,
            "a folder name must be one path segment",
            CREATE_FAILED,
        ));
    }
    let base = text(&existing_directory(parent, home, CREATE_FAILED)?);
    let target = child(&base, leaf);
    match std::fs::create_dir(&target) {
        Ok(()) => Ok(target),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Err(
            DirectoryError::new(409, format!("{target} already exists"), EXISTS),
        ),
        Err(error) => Err(DirectoryError::new(
            400,
            format!("could not create {target}: {}", errno_name(&error)),
            CREATE_FAILED,
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch() -> (PathBuf, PathBuf) {
        let base = std::env::temp_dir().join(format!(
            "heddle-directories-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&base).unwrap();
        let real = std::fs::canonicalize(&base).unwrap();
        (base, real)
    }

    #[test]
    fn a_listing_names_folders_only_sorted_with_hidden_marks_crumbs_and_links() {
        let (base, real) = scratch();
        for name in ["beta", "Alpha", ".hidden", "gamma"] {
            std::fs::create_dir(base.join(name)).unwrap();
        }
        std::fs::write(base.join("a-file.txt"), "x").unwrap();
        std::os::unix::fs::symlink(base.join("gamma"), base.join("link")).unwrap();
        std::os::unix::fs::symlink(base.join("nowhere"), base.join("broken")).unwrap();
        let listing = list_directory(Some(base.to_str().unwrap()), &base).unwrap();
        let names: Vec<&str> = listing.entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec![".hidden", "Alpha", "beta", "gamma", "link"]);
        assert!(listing.entries[0].hidden);
        assert!(!listing.entries[1].hidden);
        assert_eq!(listing.path, text(&real));
        assert_eq!(listing.entries[1].path, format!("{}/Alpha", text(&real)));
        assert_eq!(listing.parent, real.parent().map(text));
        assert_eq!(listing.crumbs.first().unwrap().path, "/");
        assert_eq!(listing.crumbs.last().unwrap().path, text(&real));
        assert!(!listing.truncated);
        // No path lists the home; `~` is the home too.
        assert_eq!(list_directory(None, &base).unwrap().path, text(&real));
        assert_eq!(list_directory(Some("~"), &base).unwrap().path, text(&real));
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn a_listing_refuses_relative_missing_and_file_paths() {
        let (base, _) = scratch();
        std::fs::write(base.join("a-file.txt"), "x").unwrap();
        let relative = list_directory(Some("not/absolute"), &base).unwrap_err();
        assert_eq!((relative.status, relative.code), (400, UNREADABLE));
        assert_eq!(relative.message, "the path must be absolute");
        let missing = base.join("nope");
        let error = list_directory(Some(missing.to_str().unwrap()), &base).unwrap_err();
        assert_eq!(error.message, format!("{} does not exist", text(&missing)));
        let file = base.join("a-file.txt");
        let error = list_directory(Some(file.to_str().unwrap()), &base).unwrap_err();
        assert_eq!(error.message, format!("{} is not a folder", text(&file)));
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn creation_takes_one_segment_under_an_existing_parent_and_refuses_a_duplicate() {
        let (base, real) = scratch();
        let parent = base.to_str().unwrap();
        let made = create_directory(Some(parent), Some(" fresh "), &base).unwrap();
        assert_eq!(made, format!("{}/fresh", text(&real)));
        assert!(Path::new(&made).is_dir());
        let again = create_directory(Some(parent), Some("fresh"), &base).unwrap_err();
        assert_eq!((again.status, again.code), (409, EXISTS));
        for bad in ["", "..", ".", "a/b"] {
            let error = create_directory(Some(parent), Some(bad), &base).unwrap_err();
            assert_eq!((error.status, error.code), (400, CREATE_FAILED), "{bad:?}");
        }
        let error = create_directory(None, Some("x"), &base).unwrap_err();
        assert_eq!(error.message, "a parent folder is required");
        let missing = base.join("missing");
        let error =
            create_directory(Some(missing.to_str().unwrap()), Some("x"), &base).unwrap_err();
        assert_eq!(error.status, 400);
        std::fs::remove_dir_all(&base).unwrap();
    }
}
