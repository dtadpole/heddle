//! The platform's own folder chooser, opened by the **server** — the port of `src/server/picker.ts`.
//!
//! A page cannot do this job: a file input gives relative paths and `showDirectoryPicker` an opaque handle, and a
//! workspace needs an absolute path. The harness runs on the machine the folder is on, so the dialog belongs here,
//! with DSH's contract: a chosen path, `cancelled`, or `unavailable` with a reason a person can act on.
//!
//! Nothing here is a shell string: every command is a fixed argv, and the dialog's output is data, validated as an
//! absolute path before it is handed back. The commands are, by platform: `osascript` (macOS); `zenity`, then
//! `kdialog` (Linux); `powershell` with `FolderBrowserDialog` (Windows).

use std::future::Future;
use std::pin::Pin;
use std::time::Duration;

use serde::Serialize;

/// A boxed, sendable future — what a [`CommandRunner`] returns, so a runner can be a trait object in router state.
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// A picker that never answers would pin the request forever; this is the bound, after which the dialog is killed.
pub const PICK_TIMEOUT: Duration = Duration::from_secs(10 * 60);

/// The dialog's title on every platform.
pub(crate) const PROMPT: &str = "Select Workspace Directory";

/// What the picker concluded. A cancel is an answer, not a failure.
///
/// Serialized as `{"kind":"picked","path":…}`, `{"kind":"cancelled"}` or `{"kind":"unavailable","reason":…}`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum PickerOutcome {
    Picked { path: String },
    Cancelled,
    Unavailable { reason: String },
}

/// One command's result, as the picker reads it. A command that could not be started is `code: 127` with the
/// error in `stderr`, which is how the picker tells "not installed" from "the person said no".
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CommandResult {
    pub stdout: String,
    pub stderr: String,
    pub code: i32,
}

/// The platform whose dialog to open.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Platform {
    MacOs,
    Linux,
    Windows,
    /// Any other platform, by its `std::env::consts::OS` name; answered `unavailable`.
    Other(String),
}

impl Platform {
    /// The platform this binary runs on.
    pub fn current() -> Self {
        match std::env::consts::OS {
            "macos" => Self::MacOs,
            "linux" => Self::Linux,
            "windows" => Self::Windows,
            other => Self::Other(other.to_string()),
        }
    }
}

/// How the picker reaches the platform — injectable, so every decision can be judged without a dialog.
pub trait CommandRunner: Send + Sync {
    /// Run `command` with `args` (no shell), stdin closed, and answer when it exits.
    fn run<'a>(&'a self, command: &'a str, args: &'a [String]) -> BoxFuture<'a, CommandResult>;
}

/// The runner the server uses: a child process, killed after `timeout`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SystemRunner {
    pub timeout: Duration,
}

impl Default for SystemRunner {
    fn default() -> Self {
        Self {
            timeout: PICK_TIMEOUT,
        }
    }
}

impl CommandRunner for SystemRunner {
    fn run<'a>(&'a self, command: &'a str, args: &'a [String]) -> BoxFuture<'a, CommandResult> {
        Box::pin(async move {
            todo!("spawn with tokio::process, kill after self.timeout, 127 when it cannot start")
        })
    }
}

/// Ask the platform for a folder.
///
/// A cancel on any platform is [`PickerOutcome::Cancelled`] (exit 1, or `User canceled`/`-128` in stderr); a host
/// with no usable dialog is [`PickerOutcome::Unavailable`] with the sentence that says what to install, so the page
/// can offer to type a path instead. A picked path has its trailing separators removed.
pub async fn pick_folder(platform: &Platform, runner: &dyn CommandRunner) -> PickerOutcome {
    todo!("port pickFolder from src/server/picker.ts")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn outcomes_serialize_as_the_page_reads_them() {
        let json = |outcome: &PickerOutcome| serde_json::to_string(outcome).unwrap();
        assert_eq!(
            json(&PickerOutcome::Picked { path: "/w".into() }),
            r#"{"kind":"picked","path":"/w"}"#
        );
        assert_eq!(json(&PickerOutcome::Cancelled), r#"{"kind":"cancelled"}"#);
        assert_eq!(
            json(&PickerOutcome::Unavailable { reason: "r".into() }),
            r#"{"kind":"unavailable","reason":"r"}"#
        );
    }

    #[test]
    fn the_route_answer_is_pretty_printed_like_json_stringify_with_two_spaces() {
        let pretty =
            serde_json::to_string_pretty(&PickerOutcome::Picked { path: "/w".into() }).unwrap();
        assert_eq!(pretty, "{\n  \"kind\": \"picked\",\n  \"path\": \"/w\"\n}");
    }
}
