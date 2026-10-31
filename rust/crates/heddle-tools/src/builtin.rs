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
    /// Characters of a `bash` call's combined output kept for the model ([`BASH_OUTPUT_LIMIT`] by default).
    pub bash_output_limit: usize,
}

impl Default for BuiltinOptions {
    fn default() -> Self {
        Self {
            bash_timeout_ms: 30_000,
            bash_output_limit: BASH_OUTPUT_LIMIT,
        }
    }
}

/// The default for `bashOutputLimit`: the most combined output a `bash` result carries before it is cut, in
/// characters.
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
        // Reads only, so two reads of one step run together (DSH's fs read tools are concurrency-safe).
        crate::tool::parallel_safe(read_file_tool(Arc::clone(&sandbox))),
        crate::tool::parallel_safe(list_dir_tool(Arc::clone(&sandbox))),
        bash_tool(
            sandbox,
            options.bash_timeout_ms,
            options.bash_output_limit,
            escalation,
        ),
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
    truncate_output_at(combined, BASH_OUTPUT_LIMIT)
}

/// [`truncate_output`] at `limit` characters, the row's `bashOutputLimit`.
pub fn truncate_output_at(combined: &str, limit: usize) -> String {
    if combined.chars().count() <= limit {
        return combined.to_owned();
    }
    let mut cut: String = combined.chars().take(limit).collect();
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

/// The sandbox one call runs under: the gate rooted at the call's folder (`context.cwd`, the session's own
/// workspace as the loop resolved it), or the gate itself when it cannot be re-rooted. A relative path, the
/// shell's directory and the `workspace-write` boundary are that folder, not the launch directory.
fn rooted(sandbox: &Arc<dyn SandboxGate>, context: &ToolRunContext) -> Arc<dyn SandboxGate> {
    sandbox
        .rooted_at(&context.cwd)
        .unwrap_or_else(|| Arc::clone(sandbox))
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
            let sandbox = rooted(&write, &context);
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
            let sandbox = rooted(&read, &context);
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
            let sandbox = rooted(&list, &context);
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
                    // Follow the entry like the TypeScript `statSync` does: a symlink to a directory is a
                    // directory in the listing. A broken link falls back to the entry's own type.
                    let metadata = match tokio::fs::metadata(entry.path()).await {
                        Ok(metadata) => metadata,
                        Err(_) => {
                            let kind = entry.file_type().await?;
                            if kind.is_dir() {
                                lines.push(format!("{name}/"));
                            } else if kind.is_symlink() {
                                lines.push(name);
                            } else {
                                lines.push(format!("{name} (0B)"));
                            }
                            continue;
                        }
                    };
                    if metadata.is_dir() {
                        lines.push(format!("{name}/"));
                    } else {
                        lines.push(format!("{name} ({}B)", metadata.len()));
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
    output_limit: usize,
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
            let sandbox = rooted(&run, &context);
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
                            let message = unavailable.to_string();
                            context.log(&format!("refused a '{mode}' shell: {message}"));
                            let data = serde_json::Map::from_iter([(
                                "sandbox".to_owned(),
                                json!({ "mode": mode, "denied": false, "unavailable": true }),
                            )]);
                            return Ok(ToolResult::refused(codes::SANDBOX_UNAVAILABLE, message)
                                .with_data(data));
                        }
                    }
                };
                let argv: Vec<std::ffi::OsString> = confined.as_ref().map_or_else(
                    || {
                        vec![
                            std::ffi::OsString::from("/bin/sh"),
                            std::ffi::OsString::from("-c"),
                            std::ffi::OsString::from(command),
                        ]
                    },
                    |confined| confined.argv.clone(),
                );
                // The TypeScript build takes `Number(args.timeoutMs)`, so a fractional millisecond counts.
                let limit = args
                    .get("timeoutMs")
                    .and_then(serde_json::Value::as_f64)
                    .filter(|milliseconds| *milliseconds > 0.0)
                    .map(|milliseconds| milliseconds.round() as u64)
                    .unwrap_or(default_timeout_ms);
                run_command(
                    sandbox.as_ref(),
                    &argv,
                    mode,
                    confined.as_ref(),
                    limit,
                    output_limit,
                    &context,
                )
                .await
            })
        },
    )
}

/// Spawn one argv, enforce its wall time and the call's Stop, and classify what it did.
///
/// The working directory is the call's folder (`context.cwd`), not the launch directory; the confinement,
/// when there is one, is the wrapped argv's: the whole process tree is under the kernel profile, not only the
/// process this tool spawns.
async fn run_command(
    sandbox: &dyn SandboxGate,
    argv: &[std::ffi::OsString],
    mode: SandboxMode,
    confined: Option<&crate::upstream::ConfinedArgv>,
    limit_ms: u64,
    output_limit: usize,
    context: &ToolRunContext,
) -> Result<ToolResult, ToolFailure> {
    let mut process = tokio::process::Command::new(&argv[0]);
    process
        .args(&argv[1..])
        .current_dir(&context.cwd)
        .env("NO_COLOR", "1")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    // The command leads its own process group, so a Stop or the wall time reaches everything it started, as DSH's
    // launcher does (`detached`, then a signal to `-pid`). `kill_on_drop` alone stops only the shell, and the
    // shell's children kept running orphaned (live-testing draft developer-five-5).
    #[cfg(unix)]
    process.process_group(0);
    let child = process.spawn()?;
    let leader = child.id();

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
            // The child was killed for its wall time or by the caller's Stop: dropping it killed the shell
            // (`kill_on_drop`), and the group signal stops whatever the shell had started, which outlives the
            // shell as long as one member of the group is left.
            if let Some(leader) = leader {
                if let Err(error) = heddle_sandbox::kill_process_group(leader) {
                    tracing::warn!(%error, leader, "the command's process group could not be stopped");
                }
            }
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
            let trimmed = truncate_output_at(&format!("{stdout}{stderr}"), output_limit);
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
                        // The sandbox crate's sentence, which 75's shell-confinement checks match.
                        heddle_sandbox::runner_failure_message(mode, &detail),
                    )
                    .with_data(serde_json::Map::from_iter([(
                        "sandbox".to_owned(),
                        json!({ "mode": mode, "enforcement": confined.map(|c| c.enforcement), "denied": false, "runnerFailed": true }),
                    )]))),
                SandboxOutcome::Denied => Ok(kept()
                    .with_error(
                        codes::SANDBOX,
                        heddle_sandbox::shell_denial_message(mode),
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
                Some(detail) => Err(SandboxUnavailable {
                    mode,
                    detail: Some(detail.clone()),
                }),
                None => Ok(ConfinedArgv {
                    argv: argv.iter().map(std::ffi::OsString::from).collect(),
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

    /// A context whose folder is `cwd`, which a shell needs: it is the directory the command runs in.
    fn context_in(cwd: PathBuf, mode: SandboxMode) -> ToolRunContext {
        ToolRunContext::new(crate::ToolContext::new(cwd), mode)
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

    #[cfg(unix)]
    #[tokio::test]
    async fn list_dir_follows_a_symlink_to_a_directory() {
        let root = tempdir();
        std::fs::create_dir(root.path().join("real")).unwrap();
        std::os::unix::fs::symlink("real", root.path().join("link")).unwrap();
        let list = tool("list_dir", sandbox(root.path()));
        let result = list
            .run(args(json!({})), context(SandboxMode::WorkspaceWrite))
            .await
            .unwrap();
        assert_eq!(result.output, "link/\nreal/");
    }

    #[tokio::test]
    async fn a_command_that_exits_non_zero_is_reported_as_an_exit_with_its_output() {
        let root = tempdir();
        let bash = tool("bash", sandbox(root.path()));
        let result = bash
            .run(
                args(json!({ "command": "echo out; echo err >&2; exit 3" })),
                context_in(root.path(), SandboxMode::DangerFullAccess),
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
                context_in(root.path(), SandboxMode::DangerFullAccess),
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
                crate::ToolContext::new(root.path()).with_cancel(token.clone()),
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
                context_in(root.path(), SandboxMode::WorkspaceWrite),
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

    /// R-developer-eight-10: a turn's shell ran in the sandbox's root — the directory the server was launched
    /// in — instead of the call's folder, the session's workspace. DSH runs it in the session's directory.
    #[tokio::test]
    async fn a_shell_runs_in_the_calls_folder_not_the_sandboxs_root() {
        let launch = tempdir();
        let folder = tempdir();
        let bash = tool("bash", sandbox(launch.path()));
        let result = bash
            .run(
                args(json!({ "command": "pwd" })),
                context_in(folder.path(), SandboxMode::DangerFullAccess),
            )
            .await
            .unwrap();
        assert_eq!(result.error, None, "{}", result.output);
        assert_eq!(
            result.output,
            format!("{}\n", folder.path().canonicalize().unwrap().display()),
            "pwd printed the call's folder"
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
    fn a_configured_output_limit_cuts_there() {
        assert_eq!(
            truncate_output_at(&"a".repeat(500), 50),
            format!("{}\n… truncated", "a".repeat(50))
        );
        assert_eq!(
            truncate_output_at(&"b".repeat(500), 500),
            "b".repeat(500),
            "no cut at the limit"
        );
        assert_eq!(
            BuiltinOptions::default().bash_output_limit,
            BASH_OUTPUT_LIMIT
        );
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
