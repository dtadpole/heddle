//! The tools this harness ships: `write_file`, `read_file`, `list_dir`, `bash`.
//!
//! Ported from `src/tools/builtin.ts`. Four tools, because the claim is that the extension point works,
//! not that the catalogue is large. Every spec description is copied verbatim from the TypeScript build:
//! it is what the model is told, so the two binaries must tell it the same thing.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use futures::future::BoxFuture;
use serde_json::json;

use crate::gates::SandboxGate;
use crate::tool::{Tool, ToolArgs, ToolFailure, ToolResult, ToolRunContext, codes, tool_fn};
use crate::upstream::{SandboxMode, SandboxOutcome, ToolSpec};

/// What the built-ins are built with.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BuiltinOptions {
    /// Default wall time of a `bash` call, in milliseconds; a call may name its own `timeoutMs`.
    pub bash_timeout_ms: u64,
}

impl Default for BuiltinOptions {
    fn default() -> Self {
        Self {
            bash_timeout_ms: 30_000,
        }
    }
}

/// The most combined output a `bash` result carries before it is cut, in characters.
pub const BASH_OUTPUT_LIMIT: usize = 20_000;

/// Build the four standard tools around one sandbox, in the order `heddle tools` lists them:
/// `write_file`, `read_file`, `list_dir`, `bash`.
///
/// Each goes through the registry's gates like any other tool; inside `run`, the file tools resolve their
/// path with the sandbox under the call's mode (a refusal is `SANDBOX`), and `bash` confines its exact argv
/// or refuses with `SANDBOX_UNAVAILABLE` — never runs unconfined in a confined mode.
pub fn builtin_tools(sandbox: Arc<dyn SandboxGate>, options: BuiltinOptions) -> Vec<Arc<dyn Tool>> {
    let escalation = escalation_fields(sandbox.as_ref());
    vec![
        write_file_tool(Arc::clone(&sandbox)),
        read_file_tool(Arc::clone(&sandbox)),
        list_dir_tool(Arc::clone(&sandbox)),
        bash_tool(sandbox, options.bash_timeout_ms, escalation),
    ]
}

/// The two schema fields a mutating tool advertises when the sandbox can confine: `sandbox_permissions`
/// (an enum of [`SandboxGate::escalation_targets`]) and `justification`. Empty when nothing can confine,
/// because an offered escalation a host cannot enforce is a prompt whose grant could not run.
pub fn escalation_fields(sandbox: &dyn SandboxGate) -> serde_json::Map<String, serde_json::Value> {
    let targets = sandbox.escalation_targets();
    if targets.is_empty() {
        return serde_json::Map::new();
    }
    let modes: Vec<&str> = targets.iter().map(|mode| mode.as_str()).collect();
    serde_json::Map::from_iter([
        (
            "sandbox_permissions".to_owned(),
            json!({
                "type": "string",
                "enum": modes,
                "description":
                    "The narrowest wider sandbox mode for a one-shot retry of the exact operation the sandbox just denied; the retry asks the user for approval.",
            }),
        ),
        (
            "justification".to_owned(),
            json!({
                "type": "string",
                "description":
                    "Required with sandbox_permissions: one sentence for the user explaining why this exact operation needs the wider access. Use the language of the user’s current request.",
            }),
        ),
    ])
}

/// Cut a command's combined output at [`BASH_OUTPUT_LIMIT`] characters, marking the cut with
/// `"\n… truncated"`.
///
/// The TypeScript build counts UTF-16 code units; this counts `char`s, so a cut never splits a character.
/// The two agree on every ASCII output, which is what the verifiers produce.
pub fn truncate_output(combined: &str) -> String {
    if combined.chars().count() <= BASH_OUTPUT_LIMIT {
        return combined.to_owned();
    }
    let mut cut: String = combined.chars().take(BASH_OUTPUT_LIMIT).collect();
    cut.push_str("\n… truncated");
    cut
}

/// The argument a tool requires as a string; empty when absent, which is what makes the refusal sentence.
fn string_arg(args: &ToolArgs, name: &str) -> String {
    args.get(name)
        .and_then(serde_json::Value::as_str)
        .unwrap_or("")
        .to_owned()
}

fn spec(name: &str, description: &str, parameters: serde_json::Value) -> ToolSpec {
    ToolSpec {
        name: name.to_owned(),
        description: description.to_owned(),
        parameters,
    }
}

/// The parent directory a file write must create, `.` for a bare name (the TypeScript `dirname`).
fn parent_of(target: &Path) -> PathBuf {
    match target.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => parent.to_path_buf(),
        _ => PathBuf::from("."),
    }
}

/// The path a person reads: relative to the workspace when it is inside it, absolute otherwise.
fn display_path(target: &Path, workspace_root: &Path) -> String {
    target
        .strip_prefix(workspace_root)
        .map(|relative| relative.display().to_string())
        .unwrap_or_else(|_| target.display().to_string())
}

fn sandbox_facts(mode: SandboxMode, denied: bool) -> serde_json::Value {
    json!({ "mode": mode, "denied": denied })
}

fn write_file_tool(sandbox: Arc<dyn SandboxGate>) -> Arc<dyn Tool> {
    let parameters = {
        let mut properties = serde_json::Map::from_iter([
            (
                "path".to_owned(),
                json!({ "type": "string", "description": "File to write, relative to the workspace or absolute inside it." }),
            ),
            (
                "content".to_owned(),
                json!({ "type": "string", "description": "Exact text to write." }),
            ),
        ]);
        properties.extend(escalation_fields(sandbox.as_ref()));
        json!({
            "type": "object",
            "properties": properties,
            "required": ["path", "content"],
            "additionalProperties": false,
        })
    };
    let write = Arc::clone(&sandbox);
    tool_fn(
        spec(
            "write_file",
            "Write text to a file, creating parent directories as needed. The path is resolved against the workspace and the sandbox refuses anything outside it.",
            parameters,
        ),
        move |args,
              context: ToolRunContext|
              -> BoxFuture<'static, Result<ToolResult, ToolFailure>> {
            let sandbox = Arc::clone(&write);
            Box::pin(async move {
                let path = string_arg(&args, "path");
                if path.is_empty() {
                    return Ok(ToolResult::refused(
                        codes::BAD_ARGS,
                        "write_file needs a path",
                    ));
                }
                let target = sandbox.assert_writable(&path, context.mode())?;
                tokio::fs::create_dir_all(parent_of(&target)).await?;
                let content = string_arg(&args, "content");
                tokio::fs::write(&target, &content).await?;
                let bytes = content.len();
                context.log(&format!("wrote {} ({bytes} bytes)", target.display()));
                let shown = display_path(&target, sandbox.workspace_root());
                let data = serde_json::Map::from_iter([
                    ("path".to_owned(), json!(target)),
                    ("bytes".to_owned(), json!(bytes)),
                ]);
                Ok(ToolResult::ok(format!("wrote {bytes} bytes to {shown}")).with_data(data))
            })
        },
    )
}

fn read_file_tool(sandbox: Arc<dyn SandboxGate>) -> Arc<dyn Tool> {
    let read = Arc::clone(&sandbox);
    tool_fn(
        spec(
            "read_file",
            "Read a text file and return its contents. Refused for a path outside the sandbox in confined modes.",
            json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "File to read, relative to the workspace or absolute inside it." }
                },
                "required": ["path"],
                "additionalProperties": false,
            }),
        ),
        move |args,
              context: ToolRunContext|
              -> BoxFuture<'static, Result<ToolResult, ToolFailure>> {
            let sandbox = Arc::clone(&read);
            Box::pin(async move {
                let path = string_arg(&args, "path");
                if path.is_empty() {
                    return Ok(ToolResult::refused(
                        codes::BAD_ARGS,
                        "read_file needs a path",
                    ));
                }
                let target = sandbox.assert_readable(&path, context.mode())?;
                let text = tokio::fs::read_to_string(&target).await?;
                let data = serde_json::Map::from_iter([
                    ("path".to_owned(), json!(target)),
                    ("bytes".to_owned(), json!(text.len())),
                ]);
                Ok(ToolResult::ok(text).with_data(data))
            })
        },
    )
}

fn list_dir_tool(sandbox: Arc<dyn SandboxGate>) -> Arc<dyn Tool> {
    let list = Arc::clone(&sandbox);
    tool_fn(
        spec(
            "list_dir",
            "List the entries of a directory inside the workspace, one per line, directories marked with a trailing slash.",
            json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Directory to list; defaults to the workspace root." }
                },
                "additionalProperties": false,
            }),
        ),
        move |args,
              context: ToolRunContext|
              -> BoxFuture<'static, Result<ToolResult, ToolFailure>> {
            let sandbox = Arc::clone(&list);
            Box::pin(async move {
                let path = {
                    let requested = string_arg(&args, "path");
                    if requested.is_empty() {
                        ".".to_owned()
                    } else {
                        requested
                    }
                };
                let target = sandbox.assert_readable(&path, context.mode())?;
                let mut entries = Vec::new();
                let mut dir = tokio::fs::read_dir(&target).await?;
                while let Some(entry) = dir.next_entry().await? {
                    entries.push(entry);
                }
                entries.sort_by_key(|entry| entry.file_name());
                let mut lines = Vec::with_capacity(entries.len());
                for entry in &entries {
                    let name = entry.file_name().to_string_lossy().into_owned();
                    let kind = entry.file_type().await?;
                    if kind.is_dir() {
                        lines.push(format!("{name}/"));
                    } else {
                        let bytes = entry.metadata().await?.len();
                        lines.push(format!("{name} ({bytes}B)"));
                    }
                }
                let data = serde_json::Map::from_iter([
                    ("path".to_owned(), json!(target)),
                    ("entries".to_owned(), json!(lines.len())),
                ]);
                Ok(ToolResult::ok(lines.join("\n")).with_data(data))
            })
        },
    )
}

fn bash_tool(
    sandbox: Arc<dyn SandboxGate>,
    default_timeout_ms: u64,
    escalation: serde_json::Map<String, serde_json::Value>,
) -> Arc<dyn Tool> {
    let parameters = {
        let mut properties = serde_json::Map::from_iter([
            (
                "command".to_owned(),
                json!({ "type": "string", "description": "Command line, run through sh -c." }),
            ),
            (
                "timeoutMs".to_owned(),
                json!({ "type": "number", "description": format!("Wall time before the command is killed; default {default_timeout_ms}.") }),
            ),
        ]);
        properties.extend(escalation);
        json!({
            "type": "object",
            "properties": properties,
            "required": ["command"],
            "additionalProperties": false,
        })
    };
    let run = Arc::clone(&sandbox);
    tool_fn(
        spec(
            "bash",
            "Run a shell command in the workspace and return its combined output. The command runs under the session’s sandbox mode: read-only and workspace-write confine the whole process tree at the kernel (writes denied, or allowed only under the workspace and host temp areas), and danger-full-access runs unconfined. A blocked file operation is reported as [sandbox: file access denied under <mode> mode]; if no sandbox backend is usable the command is refused rather than run unconfined.",
            parameters,
        ),
        move |args,
              context: ToolRunContext|
              -> BoxFuture<'static, Result<ToolResult, ToolFailure>> {
            let sandbox = Arc::clone(&run);
            Box::pin(async move {
                let command = string_arg(&args, "command");
                if command.is_empty() {
                    return Ok(ToolResult::refused(codes::BAD_ARGS, "bash needs a command"));
                }
                let mode = context.mode();
                let confined = if mode == SandboxMode::DangerFullAccess {
                    None
                } else {
                    match sandbox.confine(
                        &["/bin/sh".to_owned(), "-c".to_owned(), command.clone()],
                        mode,
                    ) {
                        Ok(confined) => Some(confined),
                        Err(unavailable) => {
                            context.log(&format!(
                                "refused a '{mode}' shell: {}",
                                unavailable.message
                            ));
                            let data = serde_json::Map::from_iter([(
                                "sandbox".to_owned(),
                                json!({ "mode": mode, "denied": false, "unavailable": true }),
                            )]);
                            return Ok(ToolResult::refused(
                                codes::SANDBOX_UNAVAILABLE,
                                unavailable.message,
                            )
                            .with_data(data));
                        }
                    }
                };
                let argv = confined.as_ref().map_or_else(
                    || vec!["/bin/sh".to_owned(), "-c".to_owned(), command],
                    |confined| confined.argv.clone(),
                );
                let limit = args
                    .get("timeoutMs")
                    .and_then(serde_json::Value::as_u64)
                    .unwrap_or(default_timeout_ms);
                run_command(
                    sandbox.as_ref(),
                    &argv,
                    mode,
                    confined.as_ref(),
                    limit,
                    &context,
                )
                .await
            })
        },
    )
}

/// Spawn one argv, enforce its wall time and the call's Stop, and classify what it did.
///
/// The working directory is the workspace; the confinement, when there is one, is the wrapped argv's: the
/// whole process tree is under the kernel profile, not only the process this tool spawns.
async fn run_command(
    sandbox: &dyn SandboxGate,
    argv: &[String],
    mode: SandboxMode,
    confined: Option<&crate::upstream::ConfinedArgv>,
    limit_ms: u64,
    context: &ToolRunContext,
) -> Result<ToolResult, ToolFailure> {
    let mut process = tokio::process::Command::new(&argv[0]);
    process
        .args(&argv[1..])
        .current_dir(sandbox.workspace_root())
        .env("NO_COLOR", "1")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let child = process.spawn()?;

    let facts = || match confined {
        None => sandbox_facts(mode, false),
        Some(confined) => {
            json!({ "mode": mode, "enforcement": confined.enforcement, "denied": false })
        }
    };

    let limit = Duration::from_millis(limit_ms);
    let cancel = context.cancel.clone();
    let output = {
        let wait = child.wait_with_output();
        tokio::pin!(wait);
        let timer = tokio::time::sleep(limit);
        tokio::pin!(timer);
        let stopped = async {
            match &cancel {
                Some(token) => token.cancelled().await,
                None => std::future::pending::<()>().await,
            }
        };
        tokio::pin!(stopped);
        tokio::select! {
            settled = &mut wait => Some(settled?),
            () = &mut timer => None,
            () = &mut stopped => None,
        }
    };

    match output {
        None => {
            // The child was killed for its wall time or by the caller's Stop. It is dropped here, which
            // kills it (`kill_on_drop`); whatever it printed before that is still worth reporting.
            let stopped = context.is_cancelled();
            let message = if stopped {
                "the command was stopped before it finished".to_owned()
            } else {
                format!("the command exceeded {limit_ms}ms and was killed")
            };
            let code = if stopped {
                codes::INTERRUPTED
            } else {
                codes::TIMEOUT
            };
            let data = serde_json::Map::from_iter([("sandbox".to_owned(), facts())]);
            Ok(ToolResult::refused(code, message).with_data(data))
        }
        Some(output) => {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let stderr = String::from_utf8_lossy(&output.stderr);
            let trimmed = truncate_output(&format!("{stdout}{stderr}"));
            let code = output.status.code().unwrap_or(1);
            let outcome = match confined {
                None => SandboxOutcome::Exited,
                Some(confined) => sandbox.classify_outcome(code, &stderr, Some(confined)),
            };
            let kept = || ToolResult::ok(trimmed.clone());
            match outcome {
                SandboxOutcome::RunnerFailure { detail } => Ok(kept()
                    .with_error(
                        codes::SANDBOX_UNAVAILABLE,
                        format!("the sandbox runner failed under '{mode}' mode — the command did not run: {detail}"),
                    )
                    .with_data(serde_json::Map::from_iter([(
                        "sandbox".to_owned(),
                        json!({ "mode": mode, "enforcement": confined.map(|c| c.enforcement), "denied": false, "runnerFailed": true }),
                    )]))),
                SandboxOutcome::Denied => Ok(kept()
                    .with_error(
                        codes::SANDBOX,
                        format!("[sandbox: file access denied under {mode} mode]"),
                    )
                    .with_data(serde_json::Map::from_iter([(
                        "sandbox".to_owned(),
                        json!({ "mode": mode, "enforcement": confined.map(|c| c.enforcement), "denied": true }),
                    )]))),
                SandboxOutcome::Exited if code != 0 => Ok(kept()
                    .with_error(codes::EXIT, format!("the command exited {code}"))
                    .with_data(serde_json::Map::from_iter([("sandbox".to_owned(), facts())]))),
                SandboxOutcome::Exited => Ok(ToolResult::ok(trimmed).with_data(
                    serde_json::Map::from_iter([
                        ("exitCode".to_owned(), json!(code)),
                        ("sandbox".to_owned(), facts()),
                    ]),
                )),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use serde_json::json;

    use super::*;
    use crate::upstream::{
        ConfinedArgv, RunnerFailureRule, SandboxDenial, SandboxEnforcement, SandboxUnavailable,
    };

    /// A sandbox double: admits everything under `root` unless `denial` is set, confines by returning the
    /// argv unchanged unless `unavailable` is set, and classifies every settled command as `outcome`.
    struct FakeSandbox {
        root: PathBuf,
        mode: SandboxMode,
        targets: Vec<SandboxMode>,
        unavailable: Option<String>,
        outcome: SandboxOutcome,
        denial: Option<SandboxDenial>,
    }

    impl FakeSandbox {
        fn new(root: PathBuf) -> Self {
            Self {
                root,
                mode: SandboxMode::WorkspaceWrite,
                targets: Vec::new(),
                unavailable: None,
                outcome: SandboxOutcome::Exited,
                denial: None,
            }
        }

        fn refusing(root: PathBuf) -> Self {
            let mut sandbox = Self::new(root);
            sandbox.denial = Some(SandboxDenial {
                message: "outside the workspace".into(),
                path: "/etc/passwd".into(),
                mode: SandboxMode::ReadOnly,
                workspace_root: "/w".into(),
            });
            sandbox
        }
    }

    impl SandboxGate for FakeSandbox {
        fn workspace_root(&self) -> &Path {
            &self.root
        }
        fn default_mode(&self) -> SandboxMode {
            self.mode
        }
        fn escalation_targets(&self) -> Vec<SandboxMode> {
            self.targets.clone()
        }
        fn policy(&self, mode: SandboxMode) -> serde_json::Value {
            json!({ "mode": mode })
        }
        fn policy_statement(&self, mode: SandboxMode) -> String {
            format!("sandbox: {mode}")
        }
        fn assert_writable(&self, path: &str, _: SandboxMode) -> Result<PathBuf, SandboxDenial> {
            match &self.denial {
                Some(denial) => Err(denial.clone()),
                None => Ok(self.root.join(path)),
            }
        }
        fn assert_readable(&self, path: &str, _: SandboxMode) -> Result<PathBuf, SandboxDenial> {
            match &self.denial {
                Some(denial) => Err(denial.clone()),
                None => Ok(self.root.join(path)),
            }
        }
        fn confine(
            &self,
            argv: &[String],
            mode: SandboxMode,
        ) -> Result<ConfinedArgv, SandboxUnavailable> {
            match &self.unavailable {
                Some(message) => Err(SandboxUnavailable {
                    mode,
                    message: message.clone(),
                }),
                None => Ok(ConfinedArgv {
                    argv: argv.to_vec(),
                    enforcement: SandboxEnforcement::Full,
                    denial_signatures: vec!["operation not permitted".into()],
                    runner_failure_rules: Vec::<RunnerFailureRule>::new(),
                }),
            }
        }
        fn classify_outcome(&self, _: i32, _: &str, _: Option<&ConfinedArgv>) -> SandboxOutcome {
            self.outcome.clone()
        }
    }

    fn sandbox(root: PathBuf) -> Arc<dyn SandboxGate> {
        Arc::new(FakeSandbox::new(root))
    }

    fn tool(name: &str, sandbox: Arc<dyn SandboxGate>) -> Arc<dyn Tool> {
        builtin_tools(sandbox, BuiltinOptions::default())
            .into_iter()
            .find(|tool| tool.spec().name == name)
            .expect("a built-in by that name")
    }

    fn args(value: serde_json::Value) -> ToolArgs {
        value.as_object().cloned().unwrap_or_default()
    }

    fn context(mode: SandboxMode) -> ToolRunContext {
        ToolRunContext::new(crate::ToolContext::new("/w"), mode)
    }

    /// A unique temporary workspace, removed when it is dropped.
    struct TempDir(PathBuf);

    impl TempDir {
        fn path(&self) -> PathBuf {
            self.0.clone()
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn tempdir() -> TempDir {
        use std::sync::atomic::{AtomicU64, Ordering};
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let n = NEXT.fetch_add(1, Ordering::SeqCst);
        let path =
            std::env::temp_dir().join(format!("heddle-tools-test-{}-{n}", std::process::id()));
        std::fs::create_dir_all(&path).unwrap();
        TempDir(path)
    }

    #[test]
    fn the_four_tools_are_named_and_described_in_the_typescript_order() {
        let root = tempdir();
        let tools = builtin_tools(sandbox(root.path()), BuiltinOptions::default());
        assert_eq!(
            tools
                .iter()
                .map(|tool| tool.spec().name.as_str())
                .collect::<Vec<_>>(),
            ["write_file", "read_file", "list_dir", "bash"]
        );
        assert!(tools.iter().all(|tool| tool.spec().description.len() > 10));
        // The descriptions are what the model is told; a copy that loses them tells it nothing.
        assert!(
            tools[0]
                .spec()
                .description
                .starts_with("Write text to a file")
        );
        assert!(tools[3].spec().description.contains("danger-full-access"));
    }

    #[tokio::test]
    async fn a_write_then_read_round_trips_in_the_workspace() {
        let root = tempdir();
        let write = tool("write_file", sandbox(root.path()));
        let read = tool("read_file", sandbox(root.path()));
        let result = write
            .run(
                args(json!({ "path": "notes/a.txt", "content": "first" })),
                context(SandboxMode::WorkspaceWrite),
            )
            .await
            .unwrap();
        assert_eq!(result.error, None);
        assert!(result.output.contains("notes/a.txt"), "{}", result.output);
        assert_eq!(
            std::fs::read_to_string(root.path().join("notes/a.txt")).unwrap(),
            "first"
        );

        let result = read
            .run(
                args(json!({ "path": "notes/a.txt" })),
                context(SandboxMode::WorkspaceWrite),
            )
            .await
            .unwrap();
        assert_eq!(result.output, "first");
    }

    #[tokio::test]
    async fn a_sandbox_denial_is_the_sandbox_refusal_and_never_a_write() {
        let root = tempdir();
        let write = tool("write_file", Arc::new(FakeSandbox::refusing(root.path())));
        let failure = write
            .run(
                args(json!({ "path": "/etc/passwd", "content": "no" })),
                context(SandboxMode::ReadOnly),
            )
            .await
            .unwrap_err();
        assert!(matches!(failure, ToolFailure::Sandbox(_)));
    }

    #[tokio::test]
    async fn a_blank_path_is_refused_as_bad_arguments() {
        let root = tempdir();
        let write = tool("write_file", sandbox(root.path()));
        let result = write
            .run(args(json!({})), context(SandboxMode::WorkspaceWrite))
            .await
            .unwrap();
        assert_eq!(result.error.unwrap().code, codes::BAD_ARGS);
    }

    #[tokio::test]
    async fn list_dir_marks_directories_with_a_slash_and_names_file_sizes() {
        let root = tempdir();
        std::fs::create_dir(root.path().join("sub")).unwrap();
        std::fs::write(root.path().join("a.txt"), "12345").unwrap();
        let list = tool("list_dir", sandbox(root.path()));
        let result = list
            .run(args(json!({})), context(SandboxMode::WorkspaceWrite))
            .await
            .unwrap();
        assert_eq!(result.output, "a.txt (5B)\nsub/");
    }

    #[tokio::test]
    async fn a_command_that_exits_non_zero_is_reported_as_an_exit_with_its_output() {
        let root = tempdir();
        let bash = tool("bash", sandbox(root.path()));
        let result = bash
            .run(
                args(json!({ "command": "echo out; echo err >&2; exit 3" })),
                context(SandboxMode::DangerFullAccess),
            )
            .await
            .unwrap();
        assert_eq!(result.error.as_ref().unwrap().code, codes::EXIT);
        assert!(result.output.contains("out") && result.output.contains("err"));
    }

    #[tokio::test]
    async fn a_command_that_times_out_is_killed_and_reports_timeout() {
        let root = tempdir();
        let bash = tool("bash", sandbox(root.path()));
        let started = std::time::Instant::now();
        let result = bash
            .run(
                args(json!({ "command": "sleep 5", "timeoutMs": 100 })),
                context(SandboxMode::DangerFullAccess),
            )
            .await
            .unwrap();
        assert_eq!(result.error.as_ref().unwrap().code, codes::TIMEOUT);
        assert!(started.elapsed() < Duration::from_secs(4));
    }

    #[tokio::test]
    async fn a_stopped_command_is_killed_and_reports_interrupted() {
        let root = tempdir();
        let token = crate::CancellationToken::new();
        let bash = tool("bash", sandbox(root.path()));
        let run = bash.run(
            args(json!({ "command": "sleep 5" })),
            ToolRunContext::new(
                crate::ToolContext::new("/w").with_cancel(token.clone()),
                SandboxMode::DangerFullAccess,
            ),
        );
        let stopper = async move {
            tokio::time::sleep(Duration::from_millis(100)).await;
            token.cancel();
        };
        let (result, ()) = tokio::join!(run, stopper);
        assert_eq!(result.unwrap().error.unwrap().code, codes::INTERRUPTED);
    }

    #[tokio::test]
    async fn a_confined_mode_with_no_backend_is_refused_and_never_run() {
        let root = tempdir();
        let marker = root.path().join("ran");
        let mut fake = FakeSandbox::new(root.path());
        fake.unavailable = Some("no sandbox backend on this host".into());
        let bash = tool("bash", Arc::new(fake));
        let result = bash
            .run(
                args(json!({ "command": format!("touch {}", marker.display()) })),
                context(SandboxMode::WorkspaceWrite),
            )
            .await
            .unwrap();
        assert_eq!(
            result.error.as_ref().unwrap().code,
            codes::SANDBOX_UNAVAILABLE
        );
        assert!(!marker.exists(), "the command never ran");
    }

    #[tokio::test]
    async fn a_confined_command_is_classified_by_the_sandbox_not_by_its_exit_code() {
        let root = tempdir();
        let mut fake = FakeSandbox::new(root.path());
        fake.outcome = SandboxOutcome::Denied;
        let bash = tool("bash", Arc::new(fake));
        let result = bash
            .run(
                args(json!({ "command": "echo blocked" })),
                context(SandboxMode::WorkspaceWrite),
            )
            .await
            .unwrap();
        assert_eq!(result.error.as_ref().unwrap().code, codes::SANDBOX);
        assert!(
            result
                .error
                .as_ref()
                .unwrap()
                .message
                .contains("workspace-write")
        );
    }

    #[test]
    fn a_long_output_is_cut_at_the_limit_and_marked() {
        let inside = "a".repeat(BASH_OUTPUT_LIMIT);
        assert_eq!(truncate_output(&inside), inside, "no cut at the limit");
        let outside = "a".repeat(BASH_OUTPUT_LIMIT + 10);
        let cut = truncate_output(&outside);
        assert_eq!(
            cut.chars().count(),
            BASH_OUTPUT_LIMIT + "\n… truncated".chars().count()
        );
        assert!(cut.ends_with("\n… truncated"));
    }

    #[test]
    fn the_escalation_fields_exist_only_when_the_sandbox_can_confine() {
        let root = tempdir();
        let mut wide = FakeSandbox::new(root.path());
        wide.targets = vec![SandboxMode::WorkspaceWrite, SandboxMode::DangerFullAccess];
        let fields = escalation_fields(&wide);
        assert_eq!(
            fields["sandbox_permissions"]["enum"],
            json!(["workspace-write", "danger-full-access"])
        );
        assert!(
            fields["justification"]["description"]
                .as_str()
                .unwrap()
                .contains("Required")
        );
        assert!(escalation_fields(&FakeSandbox::new(root.path())).is_empty());
    }
}
