//! The instruction baseline: the project's own rules, delivered as one durable message.
//!
//! A port of `src/context/instructions.ts`, modelled on DSH's `dsh-agent-instructions`:
//!
//! - **One message, not one per file**, framed in `<system-reminder>`.
//! - **The byte budget drops whole files before it truncates one** — broadest first; only the file
//!   nearest the working directory is ever cut, and the omissions are named in the message.
//! - **A file is found by climbing until a marker is present**: the user-global file, then every
//!   file from the repository root down to the working directory.
//! - **An unchanged baseline is not re-sent**: the caller compares the rendered digest.

use std::path::{Path, PathBuf};

use serde::Serialize;
use sha1::{Digest, Sha1};

use crate::text::js_trim;

/// The largest rendered baseline, in UTF-8 bytes. DSH's standard preset.
pub const INSTRUCTIONS_MAX_BYTES: usize = 65536;
/// The files a project's rules may live in, most common first.
pub const INSTRUCTION_FILE_NAMES: [&str; 2] = ["AGENTS.md", "CLAUDE.md"];
/// A local overlay of a file above, which wins for the directory it sits in.
pub const LOCAL_INSTRUCTION_FILE_NAMES: [&str; 2] = ["AGENTS.local.md", "CLAUDE.local.md"];
/// Opens the baseline's frame.
pub const REMINDER_OPEN: &str = "<system-reminder>";
/// Closes the baseline's frame.
pub const REMINDER_CLOSE: &str = "</system-reminder>";
/// The repository marker the climb stops at by default.
pub const DEFAULT_PROJECT_MARKERS: [&str; 1] = [".git"];

/// One instruction file, read whole.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InstructionFile {
    /// Where it was read from.
    pub path: PathBuf,
    /// Its text.
    pub text: String,
}

/// A rendered baseline: the text, what went in, and what the budget left out.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct InstructionBaseline {
    /// The message text, `<system-reminder>`-framed.
    pub text: String,
    /// The files it carries, broadest first.
    pub included: Vec<PathBuf>,
    /// The files dropped whole to fit the budget.
    pub omitted: Vec<PathBuf>,
    /// Whether the nearest file was cut.
    pub truncated: bool,
    /// The digest of `text`, which a caller compares to decide whether to re-send.
    pub identity: String,
}

/// The nearest ancestor of `cwd` (or `cwd` itself) holding one of `markers`, or `None`.
///
/// A marker that cannot be read means "not the root here", and the climb continues.
pub fn find_project_root(cwd: &Path, markers: &[&str]) -> Option<PathBuf> {
    let mut current = absolute(cwd);
    loop {
        for marker in markers {
            // A marker is usually a directory, which `read` refuses; a `.git` file is the case
            // the first probe catches.
            if std::fs::read(current.join(marker)).is_ok() {
                return Some(current);
            }
            let head = current.join(marker).join("HEAD");
            if let Ok(bytes) = std::fs::read(&head) {
                if !bytes.is_empty() {
                    return Some(current);
                }
            }
        }
        let parent = current.parent()?;
        if parent == current {
            return None;
        }
        current = parent.to_path_buf();
    }
}

/// `path` as an absolute path, using the process's working directory for a relative one.
fn absolute(path: &Path) -> PathBuf {
    if path.is_absolute() {
        return path.to_path_buf();
    }
    std::env::current_dir()
        .map(|cwd| cwd.join(path))
        .unwrap_or_else(|_| path.to_path_buf())
}

/// Where the instruction files are looked for.
#[derive(Clone, Copy, Debug)]
pub struct FindOptions<'a> {
    /// The heddle home (`HEDDLE_HOME`, else `~/.heddle`), whose `AGENTS.md` is the user-global file.
    pub home: &'a Path,
    /// The repository markers; [`DEFAULT_PROJECT_MARKERS`] normally.
    pub markers: &'a [&'a str],
}

/// The instruction files that apply to `cwd`, broadest first.
///
/// The user-global `AGENTS.md`, then in each directory from the repository root down to `cwd` the
/// files [`INSTRUCTION_FILE_NAMES`] and then [`LOCAL_INSTRUCTION_FILE_NAMES`] that exist. Without a
/// marker the walk is `cwd` alone.
pub fn find_instruction_files(cwd: &Path, options: &FindOptions<'_>) -> Vec<InstructionFile> {
    let mut found = Vec::new();

    // The user-global file applies everywhere, so it comes first.
    let global = options.home.join("AGENTS.md");
    if let Ok(text) = std::fs::read_to_string(&global) {
        found.push(InstructionFile { path: global, text });
    }

    let resolved = absolute(cwd);
    let root = find_project_root(&resolved, options.markers).unwrap_or_else(|| resolved.clone());
    let mut chain = Vec::new();
    let mut current = resolved;
    loop {
        chain.push(current.clone());
        if current == root {
            break;
        }
        match current.parent() {
            Some(parent) => current = parent.to_path_buf(),
            None => break,
        }
    }

    // Broadest first: the repository root's files, then each directory down to `cwd`.
    for directory in chain.iter().rev() {
        for name in INSTRUCTION_FILE_NAMES
            .into_iter()
            .chain(LOCAL_INSTRUCTION_FILE_NAMES)
        {
            let path = directory.join(name);
            if let Ok(text) = std::fs::read_to_string(&path) {
                found.push(InstructionFile { path, text });
            }
        }
    }
    found
}

/// A digest of `text` with surrounding whitespace ignored: SHA-1, lowercase hex.
pub fn instruction_digest(text: &str) -> String {
    let digest = Sha1::digest(js_trim(text).as_bytes());
    let mut hex = String::with_capacity(digest.len() * 2);
    for byte in digest {
        hex.push_str(&format!("{byte:02x}"));
    }
    hex
}

/// Render `files` into one baseline within `max_bytes`, with paths under `$HOME` shown as `~/…`.
pub fn render_instruction_baseline(
    files: &[InstructionFile],
    max_bytes: usize,
) -> InstructionBaseline {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    render_instruction_baseline_with_home(files, max_bytes, home.as_deref())
}

/// [`render_instruction_baseline`] with the home directory given, for a caller (or a test) that
/// must not read the environment. `None` shows every path absolute.
pub fn render_instruction_baseline_with_home(
    files: &[InstructionFile],
    max_bytes: usize,
    os_home: Option<&Path>,
) -> InstructionBaseline {
    let mut included: Vec<InstructionFile> = files.to_vec();
    let mut omitted: Vec<PathBuf> = Vec::new();
    let mut truncated = false;

    let size = |entries: &[InstructionFile]| -> usize {
        entries.iter().map(|entry| entry.text.len()).sum()
    };
    // DSH reserves a fixed 200 bytes for the notice the budget may have to write.
    const NOTICE_BYTES: usize = 200;
    while included.len() > 1 && size(&included) + NOTICE_BYTES > max_bytes {
        let dropped = included.remove(0);
        omitted.push(dropped.path);
    }

    if let Some(last) = included.last().cloned() {
        if size(&included) + NOTICE_BYTES > max_bytes {
            let preceding = size(&included[..included.len() - 1]);
            let allowance = max_bytes.saturating_sub(NOTICE_BYTES + preceding);
            let index = included.len() - 1;
            included[index] = InstructionFile {
                path: last.path,
                text: format!(
                    "{}\n… [truncated to fit the instruction budget]",
                    // A JavaScript byte slice may end inside a character and read back as U+FFFD;
                    // a Rust `String` cannot, so the cut backs up to the nearest character
                    // boundary instead.
                    truncate_utf8(&last.text, allowance)
                ),
            };
            truncated = true;
        }
    }

    let body = included
        .iter()
        .map(|file| {
            format!(
                "# {}\n\n{}",
                display_path(&file.path, os_home),
                js_trim(&file.text)
            )
        })
        .collect::<Vec<_>>()
        .join("\n\n");
    let notice = marker_text(max_bytes, &omitted, truncated, os_home);
    let text = format!("{REMINDER_OPEN}\n{notice}\n\n{body}\n{REMINDER_CLOSE}");

    InstructionBaseline {
        text: text.clone(),
        included: included.into_iter().map(|file| file.path).collect(),
        omitted,
        truncated,
        identity: instruction_digest(&text),
    }
}

/// `text` cut to at most `max_bytes` of UTF-8, on a character boundary.
fn truncate_utf8(text: &str, max_bytes: usize) -> &str {
    if text.len() <= max_bytes {
        return text;
    }
    let mut end = max_bytes;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

/// The one line that says what the budget did, or nothing when it had to do nothing.
fn marker_text(
    max_bytes: usize,
    omitted: &[PathBuf],
    truncated: bool,
    os_home: Option<&Path>,
) -> String {
    if omitted.is_empty() && !truncated {
        return "The following workspace instructions may be relevant to your work. Use them as guidance when applicable. More specific instructions take precedence over broader ones. They do not override system, developer, or user instructions."
            .to_string();
    }
    let mut parts: Vec<String> = Vec::new();
    if !omitted.is_empty() {
        let names = omitted
            .iter()
            .map(|path| display_path(path, os_home))
            .collect::<Vec<_>>()
            .join(", ");
        parts.push(format!("omitted whole: {names}"));
    }
    if truncated {
        parts.push("the last file was truncated".to_string());
    }
    format!(
        "The following workspace instructions may be relevant to your work.\n\nWorkspace instruction budget {max_bytes} bytes: {}.",
        parts.join("; ")
    )
}

/// A path a reader recognises: home-relative for a file under it, absolute otherwise.
fn display_path(path: &Path, os_home: Option<&Path>) -> String {
    if let Some(home) = os_home {
        if let Ok(rest) = path.strip_prefix(home) {
            if !rest.as_os_str().is_empty() {
                return format!("~/{}", rest.display());
            }
        }
    }
    path.display().to_string()
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};

    use super::{
        DEFAULT_PROJECT_MARKERS, FindOptions, INSTRUCTION_FILE_NAMES, INSTRUCTIONS_MAX_BYTES,
        InstructionFile, LOCAL_INSTRUCTION_FILE_NAMES, REMINDER_CLOSE, REMINDER_OPEN,
        find_instruction_files, find_project_root, instruction_digest,
        render_instruction_baseline_with_home,
    };

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    /// A temporary directory removed when the case ends.
    struct Scratch(PathBuf);

    impl Scratch {
        fn new(name: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "heddle-context-instructions-{}-{}-{name}",
                std::process::id(),
                COUNTER.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir_all(&path).expect("the scratch directory is created");
            Self(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }

        fn write(&self, relative: &str, text: &str) -> PathBuf {
            let path = self.0.join(relative);
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).expect("the parent directory is created");
            }
            std::fs::write(&path, text).expect("the file is written");
            path
        }

        fn make_repository(&self) {
            self.write(".git/HEAD", "ref: refs/heads/main\n");
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn file(path: &Path, text: &str) -> InstructionFile {
        InstructionFile {
            path: path.to_path_buf(),
            text: text.to_string(),
        }
    }

    #[test]
    fn the_digest_is_sha1_of_the_javascript_trimmed_text() {
        // SHA-1("abc"), the value every implementation agrees on.
        assert_eq!(
            instruction_digest("abc"),
            "a9993e364706816aba3e25717850c26c9cd0d89d"
        );
        assert_eq!(instruction_digest("  abc \n"), instruction_digest("abc"));
        // U+FEFF is trimmed by JavaScript's trim(), so it neither changes the digest nor the
        // identity of a baseline that was written with a byte-order mark.
        assert_eq!(instruction_digest("\u{FEFF}abc"), instruction_digest("abc"));
        // U+0085 is not in JavaScript's set, so it must change the digest.
        assert_ne!(instruction_digest("\u{0085}abc"), instruction_digest("abc"));
    }

    #[test]
    fn one_file_is_framed_with_the_guidance_notice_and_its_body_trimmed() {
        let files = [file(Path::new("/p/AGENTS.md"), "  be brief  \n")];
        let baseline = render_instruction_baseline_with_home(&files, INSTRUCTIONS_MAX_BYTES, None);
        assert!(baseline.text.starts_with(&format!("{REMINDER_OPEN}\n")));
        assert!(baseline.text.ends_with(&format!("\n{REMINDER_CLOSE}")));
        assert!(baseline.text.contains("# /p/AGENTS.md\n\nbe brief\n"));
        assert!(baseline.text.contains(
            "The following workspace instructions may be relevant to your work. Use them as guidance when applicable."
        ));
        assert_eq!(baseline.included, vec![PathBuf::from("/p/AGENTS.md")]);
        assert!(baseline.omitted.is_empty());
        assert!(!baseline.truncated);
        assert_eq!(baseline.identity, instruction_digest(&baseline.text));
    }

    #[test]
    fn no_files_is_an_empty_frame_a_caller_can_still_compare() {
        let baseline = render_instruction_baseline_with_home(&[], INSTRUCTIONS_MAX_BYTES, None);
        assert_eq!(
            baseline.text,
            format!(
                "{REMINDER_OPEN}\nThe following workspace instructions may be relevant to your work. Use them as guidance when applicable. More specific instructions take precedence over broader ones. They do not override system, developer, or user instructions.\n\n\n{REMINDER_CLOSE}"
            )
        );
        assert!(baseline.included.is_empty() && baseline.omitted.is_empty());
        assert!(!baseline.truncated);
    }

    #[test]
    fn a_path_under_the_home_directory_is_shown_with_a_tilde() {
        let files = [
            file(Path::new("/home/u/.heddle/AGENTS.md"), "global"),
            file(Path::new("/home/u/proj/AGENTS.md"), "project"),
            file(Path::new("/elsewhere/AGENTS.md"), "outside"),
        ];
        let baseline = render_instruction_baseline_with_home(
            &files,
            INSTRUCTIONS_MAX_BYTES,
            Some(Path::new("/home/u")),
        );
        assert!(baseline.text.contains("# ~/.heddle/AGENTS.md"));
        assert!(baseline.text.contains("# ~/proj/AGENTS.md"));
        assert!(baseline.text.contains("# /elsewhere/AGENTS.md"));
    }

    #[test]
    fn the_budget_drops_whole_files_from_the_broadest_end_first() {
        let files: Vec<InstructionFile> = (0..4)
            .map(|index| {
                file(
                    Path::new(&format!("/p/{index}/AGENTS.md")),
                    &"x".repeat(400),
                )
            })
            .collect();
        let baseline = render_instruction_baseline_with_home(&files, 1000, None);
        // 4 x 400 + the 200-byte notice is over the budget; two files fit exactly.
        assert_eq!(baseline.included.len(), 2);
        assert_eq!(
            baseline.omitted,
            vec![
                PathBuf::from("/p/0/AGENTS.md"),
                PathBuf::from("/p/1/AGENTS.md")
            ]
        );
        assert!(!baseline.truncated);
        assert!(
            baseline
                .text
                .contains("omitted whole: /p/0/AGENTS.md, /p/1/AGENTS.md")
        );
    }

    #[test]
    fn the_nearest_file_is_truncated_only_after_the_budget_has_dropped_the_rest() {
        let files = [
            file(Path::new("/p/root/AGENTS.md"), &"a".repeat(100)),
            file(Path::new("/p/root/sub/AGENTS.md"), &"b".repeat(500)),
        ];
        // 600 bytes + the 200-byte notice is over 500, so the broad file is dropped whole and
        // the nearest one is cut to the 100 bytes the budget has left.
        let baseline = render_instruction_baseline_with_home(&files, 500, None);
        assert_eq!(
            baseline.included,
            vec![PathBuf::from("/p/root/sub/AGENTS.md")]
        );
        assert_eq!(baseline.omitted, vec![PathBuf::from("/p/root/AGENTS.md")]);
        assert!(baseline.truncated);
        assert!(baseline.text.contains(&format!(
            "{}\n… [truncated to fit the instruction budget]",
            "b".repeat(100)
        )));
        assert!(baseline.text.contains("the last file was truncated"));
    }

    #[test]
    fn a_cut_never_splits_a_character_even_when_the_budget_lands_mid_character() {
        let files = [file(Path::new("/p/AGENTS.md"), &"é".repeat(300))];
        // Allowance is 201 bytes; the 101st character needs two, so 100 whole characters stay.
        let baseline = render_instruction_baseline_with_home(&files, 401, None);
        assert!(baseline.truncated);
        assert!(baseline.text.contains(&"é".repeat(100)));
        assert!(!baseline.text.contains(&"é".repeat(101)));
    }

    #[test]
    fn the_project_root_is_the_nearest_directory_holding_a_marker() {
        let scratch = Scratch::new("root");
        scratch.make_repository();
        scratch.write("sub/deeper/note.txt", "x");
        assert_eq!(
            find_project_root(&scratch.path().join("sub/deeper"), &DEFAULT_PROJECT_MARKERS),
            Some(scratch.path().to_path_buf())
        );
        // A `.git` file, which a worktree has, is a marker too.
        let worktree = Scratch::new("gitfile");
        worktree.write(".git", "gitdir: /elsewhere/.git/worktrees/x\n");
        assert_eq!(
            find_project_root(worktree.path(), &DEFAULT_PROJECT_MARKERS),
            Some(worktree.path().to_path_buf())
        );
        // A `.git` directory with no readable HEAD is not the root here, and the climb continues.
        let empty = Scratch::new("empty");
        std::fs::create_dir_all(empty.path().join(".git")).expect("an empty .git directory");
        assert_eq!(
            find_project_root(empty.path(), &DEFAULT_PROJECT_MARKERS),
            None
        );
    }

    #[test]
    fn the_global_file_comes_first_then_the_chain_from_the_root_to_cwd() {
        let scratch = Scratch::new("files");
        scratch.make_repository();
        let home = scratch.path().join("heddle-home");
        std::fs::create_dir_all(&home).expect("the home directory");
        std::fs::write(home.join("AGENTS.md"), "global").expect("the global file");
        scratch.write("AGENTS.md", "root");
        scratch.write("sub/AGENTS.local.md", "local");
        std::fs::create_dir_all(scratch.path().join("sub/deeper")).expect("a deeper directory");

        let found = find_instruction_files(
            &scratch.path().join("sub"),
            &FindOptions {
                home: &home,
                markers: &DEFAULT_PROJECT_MARKERS,
            },
        );
        let paths: Vec<PathBuf> = found.iter().map(|entry| entry.path.clone()).collect();
        assert_eq!(
            paths,
            vec![
                home.join("AGENTS.md"),
                scratch.path().join("AGENTS.md"),
                scratch.path().join("sub/AGENTS.local.md"),
            ]
        );
        assert_eq!(found[2].text, "local");
    }

    #[test]
    fn without_a_marker_the_walk_is_the_working_directory_alone_and_names_are_in_order() {
        let scratch = Scratch::new("nomarker");
        let home = scratch.path().join("heddle-home");
        std::fs::create_dir_all(&home).expect("the home directory");
        scratch.write("AGENTS.md", "agents");
        scratch.write("CLAUDE.md", "claude");
        scratch.write("AGENTS.local.md", "agents local");
        scratch.write("CLAUDE.local.md", "claude local");

        let found = find_instruction_files(
            scratch.path(),
            &FindOptions {
                home: &home,
                markers: &DEFAULT_PROJECT_MARKERS,
            },
        );
        let names: Vec<String> = found
            .iter()
            .map(|entry| {
                entry
                    .path
                    .file_name()
                    .map(|name| name.to_string_lossy().into_owned())
                    .unwrap_or_default()
            })
            .collect();
        assert_eq!(
            names,
            vec![
                INSTRUCTION_FILE_NAMES[0],
                INSTRUCTION_FILE_NAMES[1],
                LOCAL_INSTRUCTION_FILE_NAMES[0],
                LOCAL_INSTRUCTION_FILE_NAMES[1],
            ]
        );
    }

    #[test]
    fn the_constants_are_dshs() {
        assert_eq!(INSTRUCTIONS_MAX_BYTES, 65536);
        assert_eq!(INSTRUCTION_FILE_NAMES, ["AGENTS.md", "CLAUDE.md"]);
        assert_eq!(
            LOCAL_INSTRUCTION_FILE_NAMES,
            ["AGENTS.local.md", "CLAUDE.local.md"]
        );
        assert_eq!(DEFAULT_PROJECT_MARKERS, [".git"]);
    }
}
