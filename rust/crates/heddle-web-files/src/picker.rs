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
            let mut process = tokio::process::Command::new(command);
            process
                .args(args)
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                // A dialog nobody answers must not outlive the request: on timeout the future is dropped and the
                // child with it.
                .kill_on_drop(true);
            let child = match process.spawn() {
                Ok(child) => child,
                Err(error) => {
                    return CommandResult {
                        stdout: String::new(),
                        stderr: error.to_string(),
                        code: 127,
                    };
                }
            };
            match tokio::time::timeout(self.timeout, child.wait_with_output()).await {
                Ok(Ok(output)) => CommandResult {
                    stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
                    stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
                    code: output.status.code().unwrap_or(1),
                },
                Ok(Err(error)) => CommandResult {
                    stdout: String::new(),
                    stderr: error.to_string(),
                    code: 1,
                },
                Err(_) => CommandResult {
                    stdout: String::new(),
                    stderr: "the directory picker did not answer before the timeout".to_string(),
                    code: 1,
                },
            }
        })
    }
}

/// Ask the platform for a folder.
///
/// A cancel on any platform is [`PickerOutcome::Cancelled`] (exit 1, or `User canceled`/`-128` in stderr); a host
/// with no usable dialog is [`PickerOutcome::Unavailable`] with the sentence that says what to install, so the page
/// can offer to type a path instead. A picked path has its trailing separators removed.
pub async fn pick_folder(platform: &Platform, runner: &dyn CommandRunner) -> PickerOutcome {
    match platform {
        Platform::MacOs => {
            let result = runner
                .run(
                    "osascript",
                    &[
                        "-e".to_string(),
                        format!("set selectedFolder to choose folder with prompt \"{PROMPT}\""),
                        "-e".to_string(),
                        "POSIX path of selectedFolder".to_string(),
                    ],
                )
                .await;
            if result.code != 0 {
                return if looks_cancelled(&result) {
                    PickerOutcome::Cancelled
                } else {
                    unavailable(&result)
                };
            }
            match as_path(&result.stdout) {
                Some(path) => PickerOutcome::Picked { path },
                None => PickerOutcome::Cancelled,
            }
        }
        Platform::Linux => {
            let zenity = runner
                .run(
                    "zenity",
                    &[
                        "--file-selection".to_string(),
                        "--directory".to_string(),
                        format!("--title={PROMPT}"),
                    ],
                )
                .await;
            if zenity.code == 0 {
                if let Some(path) = as_path(&zenity.stdout) {
                    return PickerOutcome::Picked { path };
                }
            } else if !missing_command(&zenity) {
                return if looks_cancelled(&zenity) {
                    PickerOutcome::Cancelled
                } else {
                    unavailable(&zenity)
                };
            }
            let kdialog = runner
                .run(
                    "kdialog",
                    &[
                        "--getexistingdirectory".to_string(),
                        ".".to_string(),
                        "--title".to_string(),
                        PROMPT.to_string(),
                    ],
                )
                .await;
            if kdialog.code == 0 {
                if let Some(path) = as_path(&kdialog.stdout) {
                    return PickerOutcome::Picked { path };
                }
            }
            if missing_command(&kdialog) {
                return PickerOutcome::Unavailable {
                    reason: "no supported native directory picker found; install zenity or kdialog, or type the path"
                        .to_string(),
                };
            }
            if looks_cancelled(&kdialog) {
                PickerOutcome::Cancelled
            } else {
                unavailable(&kdialog)
            }
        }
        Platform::Windows => {
            let script = [
                "Add-Type -AssemblyName System.Windows.Forms",
                "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
                "$dialog.Description = 'Select Workspace Directory'",
                "if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $dialog.SelectedPath }",
            ]
            .join("; ");
            let result = runner
                .run(
                    "powershell",
                    &[
                        "-NoProfile".to_string(),
                        "-STA".to_string(),
                        "-WindowStyle".to_string(),
                        "Hidden".to_string(),
                        "-Command".to_string(),
                        script,
                    ],
                )
                .await;
            if result.code != 0 {
                return if !missing_command(&result) && looks_cancelled(&result) {
                    PickerOutcome::Cancelled
                } else {
                    unavailable(&result)
                };
            }
            match as_path(&result.stdout) {
                Some(path) => PickerOutcome::Picked { path },
                None => PickerOutcome::Cancelled,
            }
        }
        Platform::Other(name) => PickerOutcome::Unavailable {
            reason: format!(
                "no native directory picker is known for {name}; type the path instead"
            ),
        },
    }
}

/// One absolute path, with the trailing separators macOS returns removed.
fn as_path(stdout: &str) -> Option<String> {
    let trimmed = stdout.trim();
    let absolute = trimmed.starts_with('/')
        || (trimmed.len() >= 3
            && trimmed.as_bytes()[0].is_ascii_alphabetic()
            && trimmed.as_bytes()[1] == b':'
            && matches!(trimmed.as_bytes()[2], b'/' | b'\\'));
    if !absolute {
        return None;
    }
    if trimmed.chars().count() > 1 {
        let stripped = trimmed.trim_end_matches(['/', '\\']);
        return Some(if stripped.is_empty() {
            trimmed.to_string()
        } else {
            stripped.to_string()
        });
    }
    Some(trimmed.to_string())
}

/// Whether a failed command is the person saying no rather than the host saying it cannot.
fn looks_cancelled(result: &CommandResult) -> bool {
    result.code == 1 || {
        let stderr = result.stderr.to_lowercase();
        stderr.contains("user cancel")
            || stderr.contains("user canceled")
            || stderr.contains("-128")
    }
}

/// Whether the command itself is missing, which is what `unavailable` is for.
fn missing_command(result: &CommandResult) -> bool {
    let stderr = result.stderr.to_lowercase();
    result.code == 127
        || stderr.contains("enoent")
        || stderr.contains("not found")
        || stderr.contains("no such file")
}

/// The last line the command wrote, as the sentence a person can act on.
fn unavailable(result: &CommandResult) -> PickerOutcome {
    let reason = result
        .stderr
        .trim()
        .lines()
        .next_back()
        .unwrap_or("")
        .trim()
        .to_string();
    PickerOutcome::Unavailable {
        reason: if reason.is_empty() {
            "the directory picker failed".to_string()
        } else {
            format!("the directory picker failed: {reason}")
        },
    }
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

    /// A runner that answers from a script, so every platform's branch is judged without a dialog.
    struct FakeRunner {
        answers: std::collections::HashMap<&'static str, CommandResult>,
        calls: std::sync::Mutex<Vec<String>>,
    }

    impl FakeRunner {
        fn new(answers: &[(&'static str, CommandResult)]) -> Self {
            Self {
                answers: answers.iter().cloned().collect(),
                calls: std::sync::Mutex::new(Vec::new()),
            }
        }

        fn calls(&self) -> Vec<String> {
            self.calls.lock().unwrap().clone()
        }
    }

    impl CommandRunner for FakeRunner {
        fn run<'a>(
            &'a self,
            command: &'a str,
            _args: &'a [String],
        ) -> BoxFuture<'a, CommandResult> {
            self.calls.lock().unwrap().push(command.to_string());
            let answer = self.answers.get(command).cloned().unwrap_or(CommandResult {
                stdout: String::new(),
                stderr: format!("{command}: command not found"),
                code: 127,
            });
            Box::pin(async move { answer })
        }
    }

    fn ok(stdout: &str) -> CommandResult {
        CommandResult {
            stdout: stdout.to_string(),
            stderr: String::new(),
            code: 0,
        }
    }

    fn failed(code: i32, stderr: &str) -> CommandResult {
        CommandResult {
            stdout: String::new(),
            stderr: stderr.to_string(),
            code,
        }
    }

    #[tokio::test]
    async fn a_chosen_folder_is_returned_with_its_trailing_separator_removed() {
        let runner = FakeRunner::new(&[("osascript", ok("/Users/me/project/\n"))]);
        assert_eq!(
            pick_folder(&Platform::MacOs, &runner).await,
            PickerOutcome::Picked {
                path: "/Users/me/project".into()
            }
        );
    }

    #[tokio::test]
    async fn a_person_saying_no_is_cancelled_on_every_platform() {
        for (platform, answer) in [
            (
                Platform::MacOs,
                failed(1, "execution error: User canceled. (-128)"),
            ),
            (Platform::Windows, failed(1, "User canceled")),
        ] {
            let runner = FakeRunner::new(&[("osascript", answer.clone()), ("powershell", answer)]);
            assert_eq!(
                pick_folder(&platform, &runner).await,
                PickerOutcome::Cancelled
            );
        }
        // Linux: zenity says no, which is an answer rather than a reason to try kdialog.
        let runner = FakeRunner::new(&[("zenity", failed(1, "User canceled"))]);
        assert_eq!(
            pick_folder(&Platform::Linux, &runner).await,
            PickerOutcome::Cancelled
        );
        assert_eq!(
            runner.calls(),
            ["zenity"],
            "kdialog is not asked after a cancel"
        );
    }

    #[tokio::test]
    async fn a_missing_dialog_says_what_to_install() {
        let runner = FakeRunner::new(&[]);
        let outcome = pick_folder(&Platform::MacOs, &runner).await;
        match outcome {
            PickerOutcome::Unavailable { reason } => {
                assert!(
                    reason.starts_with("the directory picker failed: "),
                    "{reason}"
                );
                assert!(reason.contains("command not found"), "{reason}");
            }
            other => panic!("expected unavailable, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn linux_falls_back_to_kdialog_and_says_so_when_neither_is_installed() {
        let runner = FakeRunner::new(&[
            ("zenity", failed(127, "zenity: command not found")),
            ("kdialog", ok("/home/me/work/")),
        ]);
        assert_eq!(
            pick_folder(&Platform::Linux, &runner).await,
            PickerOutcome::Picked {
                path: "/home/me/work".into()
            }
        );
        assert_eq!(runner.calls(), ["zenity", "kdialog"]);

        let runner = FakeRunner::new(&[
            ("zenity", failed(127, "zenity: command not found")),
            ("kdialog", failed(127, "kdialog: command not found")),
        ]);
        match pick_folder(&Platform::Linux, &runner).await {
            PickerOutcome::Unavailable { reason } => {
                assert!(reason.contains("install zenity or kdialog"), "{reason}");
            }
            other => panic!("expected unavailable, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn a_failed_dialog_that_is_not_a_cancel_carries_the_last_line() {
        let runner = FakeRunner::new(&[("osascript", failed(2, "line one\nline two\n"))]);
        match pick_folder(&Platform::MacOs, &runner).await {
            PickerOutcome::Unavailable { reason } => {
                assert_eq!(reason, "the directory picker failed: line two");
            }
            other => panic!("expected unavailable, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn a_platform_with_no_known_dialog_is_named_in_the_reason() {
        let runner = FakeRunner::new(&[]);
        match pick_folder(&Platform::Other("freebsd".into()), &runner).await {
            PickerOutcome::Unavailable { reason } => {
                assert!(reason.contains("freebsd"), "{reason}");
                assert!(reason.contains("type the path"), "{reason}");
            }
            other => panic!("expected unavailable, got {other:?}"),
        }
        assert!(
            runner.calls().is_empty(),
            "nothing is run on a platform with no dialog"
        );
    }

    #[tokio::test]
    async fn output_that_is_not_an_absolute_path_is_not_handed_back() {
        let runner = FakeRunner::new(&[("osascript", ok("~/project\n"))]);
        assert_eq!(
            pick_folder(&Platform::MacOs, &runner).await,
            PickerOutcome::Cancelled
        );
        assert_eq!(as_path("C:\\Users\\me"), Some("C:\\Users\\me".to_string()));
        assert_eq!(as_path("/"), Some("/".to_string()));
    }

    #[tokio::test]
    async fn a_command_that_cannot_start_is_a_missing_command() {
        let runner = SystemRunner {
            timeout: Duration::from_millis(50),
        };
        let result = runner.run("definitely-not-a-real-command-hd", &[]).await;
        assert_eq!(result.code, 127, "{result:?}");
        assert!(!result.stderr.is_empty());
    }
}
