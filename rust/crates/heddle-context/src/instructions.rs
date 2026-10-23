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
    let _ = (cwd, markers);
    todo!("find_project_root")
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
    let _ = (cwd, options);
    todo!("find_instruction_files")
}

/// A digest of `text` with surrounding whitespace ignored: SHA-1, lowercase hex.
pub fn instruction_digest(text: &str) -> String {
    let _ = text;
    todo!("instruction_digest")
}

/// Render `files` into one baseline within `max_bytes`, with paths under `$HOME` shown as `~/…`.
pub fn render_instruction_baseline(
    files: &[InstructionFile],
    max_bytes: usize,
) -> InstructionBaseline {
    let _ = (files, max_bytes);
    todo!("render_instruction_baseline")
}

/// [`render_instruction_baseline`] with the home directory given, for a caller (or a test) that
/// must not read the environment. `None` shows every path absolute.
pub fn render_instruction_baseline_with_home(
    files: &[InstructionFile],
    max_bytes: usize,
    os_home: Option<&Path>,
) -> InstructionBaseline {
    let _ = (files, max_bytes, os_home);
    todo!("render_instruction_baseline_with_home")
}
