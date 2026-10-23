//! `heddle context [<session>] [--json]` — the command's entry point, in the crate that owns it (D-043).
//!
//! A port of the `context` branch of `src/cli.ts`. The binary parses the command line, builds the
//! services at boot and dispatches here with the flags this command reads; everything the command
//! does and prints is decided below:
//!
//! 1. The session is the one named, or a fresh one in the working directory when none is
//!    (`session.start({ resume })` / `session.start({ cwd })`, as the TypeScript build does).
//! 2. The context is assembled with **the session's own folder** as the instruction root, the
//!    sandbox root only as the fallback for a record with no folder, every tool's schema, and
//!    `--endpoint`/`--model` for the budget. Assembling may write the system prompt and the
//!    instruction baseline the first time, exactly as a turn would.
//! 3. `--json` prints [`ContextView`](crate::service::ContextView) as `JSON.stringify(view, null, 2)`
//!    plus a newline; otherwise the text lines of
//!    [`ContextView::render_text`](crate::service::ContextView::render_text).
//!
//! A failure prints `heddle: <message>` on `err` and exits 1, the TypeScript build's top-level catch.
//! Nothing here reads the process: the working directory and every service arrive in [`Context`].

use std::io::Write;
use std::path::PathBuf;

use heddle_session::{SessionHandle, SessionService, SessionStore, StartOptions};

use crate::service::{AssembleOptions, ContextService};
use crate::store::ContextStore;
use crate::types::ToolSpec;

/// The command words this crate answers.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Command {
    /// `heddle context [<session>] [--json]`.
    Context,
}

/// The flags `context` reads, named after the TypeScript `Args` fields.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Args {
    /// The session to read (`args.target`); a fresh one in the working directory when absent or empty.
    pub target: Option<String>,
    /// `--json`.
    pub json: bool,
    /// `--endpoint`: the endpoint whose window the budget is priced against.
    pub endpoint: Option<String>,
    /// `--model`: the model the request would name.
    pub model: Option<String>,
}

/// What the command runs against: the composed services and the process facts the binary resolved.
///
/// The context service is generic over its store so a composition may hand over any store whose
/// sessions are `heddle-session`'s; the store this crate binds, `heddle_session::SessionStore`, is the
/// default and the one a composition should use.
pub struct Context<'a, S: ContextStore<Handle = SessionHandle> = SessionStore> {
    /// The process's working directory: where a fresh session is filed when no target is named.
    pub cwd: PathBuf,
    /// The session service (`ctx.session`).
    pub sessions: &'a SessionService,
    /// The context service over the same store (`ctx.context`).
    pub context: &'a ContextService<S>,
    /// Every tool's schema (`ctx.tools.describe()`), so the estimate prices what a turn would send.
    pub tools: &'a [ToolSpec],
    /// The sandbox root (`ctx.sandbox.workspaceRoot`): the instruction root for a session record that
    /// names no folder of its own.
    pub workspace_root: Option<PathBuf>,
}

/// Run one command: the answer on `out`, a failure on `err`, and the process exit code.
pub fn run<S: ContextStore<Handle = SessionHandle>>(
    command: Command,
    args: &Args,
    context: &Context<'_, S>,
    out: &mut dyn Write,
    err: &mut dyn Write,
) -> i32 {
    match command {
        Command::Context => match context_command(args, context) {
            Ok(text) => match out.write_all(text.as_bytes()) {
                Ok(()) => 0,
                Err(error) => fail(err, &error.to_string()),
            },
            Err(message) => fail(err, &message),
        },
    }
}

/// The answer's text, or the failure's message.
fn context_command<S: ContextStore<Handle = SessionHandle>>(
    args: &Args,
    context: &Context<'_, S>,
) -> Result<String, String> {
    let target = args.target.as_deref().filter(|target| !target.is_empty());
    let handle = context
        .sessions
        .start(match target {
            Some(target) => StartOptions {
                resume: Some(target.to_string()),
                ..StartOptions::default()
            },
            None => StartOptions {
                cwd: Some(context.cwd.to_string_lossy().into_owned()),
                ..StartOptions::default()
            },
        })
        .map_err(|error| error.to_string())?;

    // The directory the run resolved its instructions from, not the shell's: the session's recorded
    // folder, with the sandbox root only for a legacy record that has none. The working directory is
    // the last resort, for a composition that hands over no sandbox root.
    let folder = context
        .sessions
        .folder(&handle)
        .map(PathBuf::from)
        .or_else(|| context.workspace_root.clone())
        .unwrap_or_else(|| context.cwd.clone());

    let report = context
        .context
        .assemble(
            &handle,
            &AssembleOptions {
                cwd: &folder,
                tools: context.tools,
                system: None,
                endpoint: args.endpoint.as_deref(),
                model: args.model.as_deref(),
            },
        )
        .map_err(|error| error.to_string())?;
    let view = report.view(&handle.id);

    if args.json {
        let json = serde_json::to_string_pretty(&view).map_err(|error| error.to_string())?;
        Ok(format!("{json}\n"))
    } else {
        Ok(view.render_text())
    }
}

/// `heddle: <message>` on `err`, and exit 1.
fn fail(err: &mut dyn Write, message: &str) -> i32 {
    let _ = writeln!(err, "heddle: {message}");
    1
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};
    use std::sync::Arc;
    use std::sync::atomic::{AtomicU64, Ordering};

    use futures::executor::block_on;
    use futures::future::BoxFuture;
    use heddle_config::Env;
    use heddle_session::{SessionHandle, SessionService, SessionStore, StartOptions};
    use serde_json::{Value, json};

    use super::{Args, Command, Context, run};
    use crate::compaction::SummarizeError;
    use crate::service::{
        ContextConfig, ContextDependencies, ContextService, ModelAccess, PrepareOptions,
        SummaryRequest,
    };
    use crate::store::{AppendOptions, ContextStore};
    use crate::types::{ContentPart, Message, Role, ToolSpec, text_message};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    /// A temporary directory, removed when the case ends.
    struct Scratch(PathBuf);

    impl Scratch {
        fn new(name: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "heddle-context-command-{}-{}-{name}",
                std::process::id(),
                COUNTER.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir_all(&path).expect("the scratch directory is created");
            Self(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }

        fn folder(&self, name: &str) -> PathBuf {
            let path = self.0.join(name);
            std::fs::create_dir_all(&path).expect("the folder is created");
            path
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// A model layer whose only call is the summary, answered from a script.
    struct ScriptedModel(String);

    impl ModelAccess for ScriptedModel {
        fn endpoint_window(&self, _endpoint: &str, _model: Option<&str>) -> Option<u64> {
            None
        }

        fn complete(
            &self,
            _request: SummaryRequest,
        ) -> BoxFuture<'_, Result<String, SummarizeError>> {
            let summary = self.0.clone();
            Box::pin(async move { Ok(summary) })
        }
    }

    /// The services a booted binary would hand the command, over one store under `scratch`.
    struct Harness {
        sessions: SessionService,
        context: ContextService<SessionStore>,
    }

    impl Harness {
        fn new(scratch: &Scratch, config: ContextConfig, summary: Option<&str>) -> Self {
            let store = Arc::new(SessionStore::new(
                scratch
                    .path()
                    .join("sessions")
                    .to_str()
                    .expect("a utf-8 path"),
                &Env::from_process(),
            ));
            let model = summary.map(|summary| {
                Arc::new(ScriptedModel(summary.to_string())) as Arc<dyn ModelAccess>
            });
            Self {
                sessions: SessionService::from_store(store.clone()),
                context: ContextService::new(
                    store,
                    config,
                    ContextDependencies {
                        model,
                        heddle_home: scratch.folder("home"),
                    },
                ),
            }
        }

        fn session_in(&self, folder: &Path) -> SessionHandle {
            self.sessions
                .start(StartOptions {
                    cwd: Some(folder.to_string_lossy().into_owned()),
                    ..StartOptions::default()
                })
                .expect("the session is created")
        }

        fn message(&self, handle: &SessionHandle, message: Message) {
            ContextStore::append(
                self.sessions.store().as_ref(),
                handle,
                json!({ "type": "message", "message": message }),
                AppendOptions::default(),
            )
            .expect("the message appends");
        }

        /// Run `context` and answer with the exit code, stdout and stderr.
        fn run(
            &self,
            args: &Args,
            cwd: &Path,
            workspace_root: Option<&Path>,
        ) -> (i32, String, String) {
            let tools = [ToolSpec {
                name: "read_file".to_string(),
                description: "Read a file".to_string(),
                parameters: json!({"type": "object"}),
            }];
            let context = Context {
                cwd: cwd.to_path_buf(),
                sessions: &self.sessions,
                context: &self.context,
                tools: &tools,
                workspace_root: workspace_root.map(Path::to_path_buf),
            };
            let mut out = Vec::new();
            let mut err = Vec::new();
            let code = run(Command::Context, args, &context, &mut out, &mut err);
            (
                code,
                String::from_utf8(out).expect("utf-8 stdout"),
                String::from_utf8(err).expect("utf-8 stderr"),
            )
        }
    }

    fn json_args(target: &str) -> Args {
        Args {
            target: Some(target.to_string()),
            json: true,
            ..Args::default()
        }
    }

    fn texts(view: &Value) -> Vec<String> {
        view["messages"]
            .as_array()
            .expect("the view has messages")
            .iter()
            .map(|message| message["text"].as_str().unwrap_or_default().to_string())
            .collect()
    }

    fn no_instructions() -> ContextConfig {
        ContextConfig {
            instructions: false,
            ..ContextConfig::default()
        }
    }

    #[test]
    fn the_json_document_is_the_typescript_commands_field_for_field() {
        let scratch = Scratch::new("json");
        let harness = Harness::new(&scratch, no_instructions(), None);
        let folder = scratch.folder("work");
        let handle = harness.session_in(&folder);
        harness.message(&handle, text_message(Role::User, "hello"));

        let (code, stdout, stderr) = harness.run(&json_args(&handle.id), &folder, None);
        assert_eq!(code, 0, "{stderr}");
        assert!(stderr.is_empty());
        assert!(stdout.ends_with("}\n"), "one pretty document and a newline");
        assert!(
            stdout.starts_with("{\n  \"session\": "),
            "two-space indentation"
        );
        let view: Value = serde_json::from_str(&stdout).expect("the answer is JSON");
        let keys: Vec<&str> = view
            .as_object()
            .expect("an object")
            .keys()
            .map(String::as_str)
            .collect();
        let mut sorted = keys.clone();
        sorted.sort_unstable();
        assert_eq!(
            sorted,
            vec![
                "compacted",
                "contextWindow",
                "estimatedTokens",
                "instructions",
                "messageCount",
                "messages",
                "pruned",
                "session",
                "thresholdTokens",
            ]
        );
        assert_eq!(view["session"], json!(handle.id));
        assert_eq!(view["messageCount"], json!(1));
        assert_eq!(
            view["messages"],
            json!([{ "role": "user", "text": "hello" }])
        );
        assert_eq!(view["contextWindow"], json!(1_048_576));
        assert!(
            view["estimatedTokens"].as_u64().unwrap_or(0) > 0,
            "the tools are priced too"
        );
    }

    #[test]
    fn without_json_the_command_prints_the_typescript_text_lines() {
        let scratch = Scratch::new("text");
        let harness = Harness::new(&scratch, no_instructions(), None);
        let folder = scratch.folder("work");
        let handle = harness.session_in(&folder);
        harness.message(&handle, text_message(Role::User, "hello\nthere"));

        let args = Args {
            target: Some(handle.id.clone()),
            ..Args::default()
        };
        let (code, stdout, _) = harness.run(&args, &folder, None);
        assert_eq!(code, 0);
        let lines: Vec<&str> = stdout.lines().collect();
        assert_eq!(lines.len(), 3);
        assert!(lines[0].starts_with("heddle: 1 message(s), about "));
        assert!(lines[0].ends_with(" token(s)"));
        assert_eq!(
            lines[1],
            "heddle: budget 838860 of 1048576; pruned 0; compacted false"
        );
        assert_eq!(lines[2], "  user: hello there");
    }

    #[test]
    fn a_session_that_does_not_exist_fails_with_the_stores_sentence() {
        let scratch = Scratch::new("missing");
        let harness = Harness::new(&scratch, no_instructions(), None);
        let folder = scratch.folder("work");
        let (code, stdout, stderr) = harness.run(&json_args("session-nope"), &folder, None);
        assert_eq!(code, 1);
        assert!(stdout.is_empty());
        assert!(
            stderr.starts_with("heddle: no session 'session-nope' under "),
            "{stderr}"
        );
        assert!(stderr.ends_with('\n'));
    }

    #[test]
    fn no_target_starts_a_session_in_the_working_directory() {
        let scratch = Scratch::new("fresh");
        let harness = Harness::new(&scratch, no_instructions(), None);
        let folder = scratch.folder("work");
        let args = Args {
            json: true,
            ..Args::default()
        };
        let (code, stdout, _) = harness.run(&args, &folder, None);
        assert_eq!(code, 0);
        let view: Value = serde_json::from_str(&stdout).expect("JSON");
        let id = view["session"].as_str().expect("a session id");
        let handle = harness.sessions.open(id).expect("the session exists");
        assert_eq!(
            harness.sessions.folder(&handle).map(PathBuf::from),
            Some(folder.clone()),
            "it is filed under the working directory"
        );
        // An empty target is the same as none.
        let (code, _, _) = harness.run(&json_args(""), &folder, None);
        assert_eq!(code, 0);
    }

    #[test]
    fn the_baseline_comes_from_the_sessions_folder_not_the_sandbox_root() {
        let scratch = Scratch::new("folder");
        let harness = Harness::new(
            &scratch,
            ContextConfig {
                instructions_max_bytes: 100_000,
                ..ContextConfig::default()
            },
            None,
        );
        let workspace = scratch.folder("workspace");
        let elsewhere = scratch.folder("elsewhere");
        std::fs::write(
            workspace.join("AGENTS.md"),
            "# house rules\n\nThe safe word is ALPHA.\n",
        )
        .expect("the rules are written");
        std::fs::write(
            elsewhere.join("AGENTS.md"),
            "# another project\n\nThe safe word is ELSEWHERE.\n",
        )
        .expect("the decoy is written");
        let handle = harness.session_in(&workspace);

        let (code, stdout, _) = harness.run(&json_args(&handle.id), &elsewhere, Some(&elsewhere));
        assert_eq!(code, 0);
        let view: Value = serde_json::from_str(&stdout).expect("JSON");
        let reminders: Vec<String> = texts(&view)
            .into_iter()
            .filter(|text| text.contains("<system-reminder>"))
            .collect();
        assert_eq!(reminders.len(), 1, "one block, not one message per file");
        assert!(reminders[0].contains("ALPHA"));
        assert!(!reminders[0].contains("ELSEWHERE"));
        assert_eq!(view["instructions"].as_array().map(Vec::len), Some(1));
    }

    #[test]
    fn the_instruction_budget_drops_the_broader_file_whole() {
        let scratch = Scratch::new("budget");
        let harness = Harness::new(
            &scratch,
            ContextConfig {
                instructions_max_bytes: 500,
                ..ContextConfig::default()
            },
            None,
        );
        let workspace = scratch.folder("repo");
        std::fs::create_dir_all(workspace.join(".git")).expect("a .git directory");
        std::fs::write(workspace.join(".git/HEAD"), "ref: refs/heads/main\n").expect("HEAD");
        let nested = scratch.folder("repo/sub");
        std::fs::write(
            workspace.join("AGENTS.md"),
            format!("broad rules {}", "b".repeat(400)),
        )
        .expect("the broad file");
        std::fs::write(
            nested.join("AGENTS.md"),
            format!("narrow rules {}", "n".repeat(400)),
        )
        .expect("the narrow file");
        let handle = harness.session_in(&nested);

        let (code, stdout, _) = harness.run(&json_args(&handle.id), &nested, Some(&nested));
        assert_eq!(code, 0);
        let view: Value = serde_json::from_str(&stdout).expect("JSON");
        let baseline = texts(&view)
            .into_iter()
            .find(|text| text.contains("<system-reminder>"))
            .expect("a baseline was sent");
        assert!(baseline.contains("Workspace instruction budget"));
        assert!(
            !baseline.contains("bbbb"),
            "the broader file was dropped whole"
        );
        assert!(baseline.contains("nnnn"), "the nearest file survived");
    }

    #[test]
    fn after_a_compaction_the_checkpoint_is_read_once_and_the_span_is_gone() {
        let scratch = Scratch::new("compacted");
        let harness = Harness::new(
            &scratch,
            ContextConfig {
                context_window: Some(900),
                threshold_tokens: Some(700),
                retain_tokens: Some(100),
                instructions: false,
                ..ContextConfig::default()
            },
            Some("the briefing"),
        );
        let folder = scratch.folder("work");
        let handle = harness.session_in(&folder);
        harness.message(
            &handle,
            text_message(Role::User, format!("first {}", "y".repeat(300))),
        );
        harness.message(&handle, text_message(Role::Assistant, "x".repeat(300)));
        harness.message(
            &handle,
            text_message(Role::User, format!("second {}", "z".repeat(4000))),
        );
        let report = block_on(harness.context.prepare(
            &handle,
            &PrepareOptions {
                cwd: &folder,
                endpoint: "scripted",
                model: None,
                tools: &[],
                system: None,
                summarizer: None,
                force: false,
            },
        ))
        .expect("the round prepares");
        assert!(report.compacted, "the round compacted");

        let (code, stdout, _) = harness.run(&json_args(&handle.id), &folder, None);
        assert_eq!(code, 0);
        let view: Value = serde_json::from_str(&stdout).expect("JSON");
        let texts = texts(&view);
        assert_eq!(
            texts
                .iter()
                .filter(|text| text.contains("the briefing"))
                .count(),
            1,
            "the checkpoint is read exactly once"
        );
        assert!(
            !texts.iter().any(|text| text.contains("yyyy")),
            "and the span it shadows is not sent beside it"
        );
    }

    #[test]
    fn a_pruned_tool_result_is_sent_as_its_marker() {
        let scratch = Scratch::new("pruned");
        let harness = Harness::new(
            &scratch,
            ContextConfig {
                context_window: Some(3000),
                instructions: false,
                ..ContextConfig::default()
            },
            Some("unused"),
        );
        let folder = scratch.folder("work");
        let handle = harness.session_in(&folder);
        harness.message(
            &handle,
            text_message(Role::User, "make a big file and read it back"),
        );
        // The call the result answers: without it the request's pairing repair drops the result as
        // an orphan, which is the repair working, not the pruner.
        harness.message(
            &handle,
            Message::new(
                Role::Assistant,
                vec![ContentPart::ToolCall(crate::types::ToolCall {
                    id: "call-1".to_string(),
                    name: "read_file".to_string(),
                    arguments: "{\"path\":\"big.txt\"}".to_string(),
                })],
            ),
        );
        let mut tool = Message::new(
            Role::Tool,
            vec![ContentPart::Text {
                text: "x".repeat(30_000),
            }],
        );
        tool.tool_call_id = Some("call-1".to_string());
        harness.message(&handle, tool);
        block_on(harness.context.prepare(
            &handle,
            &PrepareOptions {
                cwd: &folder,
                endpoint: "scripted",
                model: None,
                tools: &[],
                system: None,
                summarizer: None,
                force: false,
            },
        ))
        .expect("the round prepares");

        let (code, stdout, _) = harness.run(&json_args(&handle.id), &folder, None);
        assert_eq!(code, 0);
        let view: Value = serde_json::from_str(&stdout).expect("JSON");
        let tool_texts: Vec<&str> = view["messages"]
            .as_array()
            .expect("messages")
            .iter()
            .filter(|message| message["role"] == json!("tool"))
            .map(|message| message["text"].as_str().unwrap_or_default())
            .collect();
        assert_eq!(tool_texts.len(), 1);
        assert!(tool_texts[0].contains("pruned"), "the marker, not the body");
        assert_eq!(
            view["messages"][2]["toolCallId"],
            json!("call-1"),
            "a tool message names its call"
        );
        assert_eq!(
            view["messages"][1]["text"],
            json!("→ read_file {\"path\":\"big.txt\"}"),
            "a tool call reads as describeContent renders it"
        );
    }

    #[test]
    fn a_budget_that_cannot_be_resolved_fails_with_its_sentence() {
        let scratch = Scratch::new("no-window");
        let harness = Harness::new(
            &scratch,
            ContextConfig {
                context_window: None,
                instructions: false,
                ..ContextConfig::default()
            },
            None,
        );
        let folder = scratch.folder("work");
        let handle = harness.session_in(&folder);
        let args = Args {
            target: Some(handle.id.clone()),
            json: true,
            endpoint: Some("local".to_string()),
            ..Args::default()
        };
        let (code, stdout, stderr) = harness.run(&args, &folder, None);
        assert_eq!(code, 1);
        assert!(stdout.is_empty());
        assert_eq!(
            stderr,
            "heddle: no context window for endpoint 'local': the endpoint declares none and none is configured\n"
        );
    }

    /// `PAIR_FILE` of the verifier: 6,000 characters of a repeated sentence.
    fn pair_file() -> String {
        "the quick brown fox jumps over the lazy dog, "
            .repeat(134)
            .chars()
            .take(6000)
            .collect()
    }

    fn chunk(harness: &Harness, handle: &SessionHandle, chunk: Value) {
        ContextStore::append(
            harness.sessions.store().as_ref(),
            handle,
            json!({ "type": "assistant/chunk", "chunk": chunk }),
            AppendOptions::default(),
        )
        .expect("the chunk appends");
    }

    /// The verifier's `pairConversation`, driven the way the loop drives this crate: the prompt, then
    /// per round the runtime snapshot, `prepare` with `--system 'be brief'`, and the round's answer —
    /// a `write_file` call, a `read_file` call whose result carries the whole file, then text.
    fn pair_conversation(harness: &Harness, folder: &Path) -> SessionHandle {
        let tools = [
            ToolSpec {
                name: "write_file".to_string(),
                description: "Write a file".to_string(),
                parameters: json!({"type": "object", "properties": {"path": {"type": "string"}, "content": {"type": "string"}}}),
            },
            ToolSpec {
                name: "read_file".to_string(),
                description: "Read a file".to_string(),
                parameters: json!({"type": "object", "properties": {"path": {"type": "string"}}}),
            },
            ToolSpec {
                name: "list_dir".to_string(),
                description: "List a directory".to_string(),
                parameters: json!({"type": "object", "properties": {"path": {"type": "string"}}}),
            },
        ];
        let handle = harness.session_in(folder);
        harness.message(
            &handle,
            text_message(Role::User, format!("write then read {}", "y".repeat(2000))),
        );
        let file = pair_file();
        for round in 0..3 {
            harness
                .context
                .record_runtime_context(
                    &handle,
                    &[crate::runtime::RuntimeContextSection {
                        name: "sandbox:policy".to_string(),
                        text: "Current heddle file policy: workspace-write.".to_string(),
                    }],
                )
                .expect("the snapshot is recorded");
            block_on(harness.context.prepare(
                &handle,
                &PrepareOptions {
                    cwd: folder,
                    endpoint: "scripted",
                    model: None,
                    tools: &tools,
                    system: Some("be brief"),
                    summarizer: None,
                    force: false,
                },
            ))
            .expect("the round prepares");
            match round {
                0 => {
                    let arguments =
                        serde_json::to_string(&json!({"path": "pair.txt", "content": file}))
                            .expect("arguments serialise");
                    chunk(
                        harness,
                        &handle,
                        json!({"type": "tool-call", "id": "call-write", "name": "write_file", "arguments": arguments}),
                    );
                    chunk(
                        harness,
                        &handle,
                        json!({"type": "done", "finishReason": "tool_calls"}),
                    );
                    let mut result = text_message(Role::Tool, "wrote 6000 characters to pair.txt");
                    result.tool_call_id = Some("call-write".to_string());
                    harness.message(&handle, result);
                }
                1 => {
                    chunk(
                        harness,
                        &handle,
                        json!({"type": "tool-call", "id": "call-read", "name": "read_file", "arguments": "{\"path\":\"pair.txt\"}"}),
                    );
                    chunk(
                        harness,
                        &handle,
                        json!({"type": "done", "finishReason": "tool_calls"}),
                    );
                    let mut result = text_message(Role::Tool, file.clone());
                    result.tool_call_id = Some("call-read".to_string());
                    harness.message(&handle, result);
                }
                _ => {
                    chunk(
                        harness,
                        &handle,
                        json!({"type": "text-delta", "text": "read it"}),
                    );
                    chunk(
                        harness,
                        &handle,
                        json!({"type": "done", "finishReason": "stop"}),
                    );
                }
            }
        }
        handle
    }

    fn pair_config() -> ContextConfig {
        ContextConfig {
            context_window: Some(100_000),
            threshold_tokens: Some(3200),
            retain_tokens: Some(600),
            instructions: false,
            ..ContextConfig::default()
        }
    }

    /// The seq of the `read_file` call's chunk and of its result.
    fn read_pair(harness: &Harness, handle: &SessionHandle) -> (u64, u64) {
        let events =
            ContextStore::read(harness.sessions.store().as_ref(), handle).expect("the log");
        let call = events
            .iter()
            .find(|event| {
                event.kind == "assistant/chunk"
                    && event.field("chunk").and_then(|chunk| chunk.get("name"))
                        == Some(&json!("read_file"))
            })
            .expect("the read call was recorded")
            .seq;
        let result = events
            .iter()
            .find(|event| {
                event.kind == "message"
                    && event
                        .field("message")
                        .and_then(|message| message.get("toolCallId"))
                        == Some(&json!("call-read"))
            })
            .expect("and its result")
            .seq;
        (call, result)
    }

    #[test]
    fn the_verifiers_cut_pair_scenario_backs_off_before_the_call_and_keeps_the_system_prompt() {
        let scratch = Scratch::new("cut-pair");
        let harness = Harness::new(&scratch, pair_config(), Some("the briefing"));
        let folder = scratch.folder("work");
        let handle = pair_conversation(&harness, &folder);
        let (call, result) = read_pair(&harness, &handle);

        let events =
            ContextStore::read(harness.sessions.store().as_ref(), &handle).expect("the log");
        let start = events
            .iter()
            .find(|event| event.kind == "compaction/start")
            .expect("a compaction was planned");
        let shadowed: Vec<u64> = serde_json::from_value(
            start
                .field("shadowedSeqs")
                .cloned()
                .expect("the span is recorded"),
        )
        .expect("seqs");
        assert!(
            start.seq > result,
            "the plan was made with the pair on the surface, so the aim was real"
        );
        assert!(!shadowed.is_empty(), "the plan shadowed something");
        assert_eq!(
            shadowed.contains(&call),
            shadowed.contains(&result),
            "the call and its result were taken together: {shadowed:?}, call {call}, result {result}"
        );
        assert!(
            !shadowed.contains(&result),
            "the cut backed off before the pair"
        );

        let (code, stdout, _) = harness.run(&json_args(&handle.id), &folder, None);
        assert_eq!(code, 0);
        let view: Value = serde_json::from_str(&stdout).expect("JSON");
        let messages = view["messages"].as_array().expect("messages");
        assert!(
            messages
                .iter()
                .any(|message| message["role"] == json!("system")
                    && message["text"]
                        .as_str()
                        .unwrap_or_default()
                        .contains("be brief")),
            "the model still reads the system prompt after the rewrite"
        );
        for (index, message) in messages.iter().enumerate() {
            if message["role"] != json!("tool") {
                continue;
            }
            let previous = &messages[index - 1];
            assert_eq!(
                previous["role"],
                json!("assistant"),
                "tool message {index} follows an assistant message"
            );
            assert!(
                previous["text"]
                    .as_str()
                    .unwrap_or_default()
                    .starts_with("→ "),
                "tool message {index} follows the call that asked for it"
            );
        }
    }

    #[test]
    fn the_verifiers_cut_refused_scenario_leaves_the_conversation_as_it_was() {
        let scratch = Scratch::new("cut-refused");
        let summary = "z".repeat(20_000);
        let harness = Harness::new(&scratch, pair_config(), Some(&summary));
        let folder = scratch.folder("work");
        let handle = pair_conversation(&harness, &folder);

        let events =
            ContextStore::read(harness.sessions.store().as_ref(), &handle).expect("the log");
        assert!(
            events.iter().any(|event| event.kind == "compaction/failed"
                && event.field("refused") == Some(&json!(true))),
            "the refusal is recorded rather than swallowed"
        );
        assert!(
            events
                .iter()
                .all(|event| event.kind != "compaction/summary"),
            "no summary was accepted"
        );
        assert!(
            !events.iter().any(|event| event.kind == "context/note"
                && event.field("surfaceOp").and_then(|op| op.get("op")) == Some(&json!("replace"))),
            "no replacement landed"
        );

        let (code, stdout, _) = harness.run(&json_args(&handle.id), &folder, None);
        assert_eq!(code, 0);
        let view: Value = serde_json::from_str(&stdout).expect("JSON");
        let texts = texts(&view);
        assert!(
            !texts.iter().any(|text| text.contains("zzzz")),
            "no part of the refused summary reached the model"
        );
        assert!(
            texts.iter().any(|text| text.contains("yyyy")),
            "the span it would have shadowed is still sent"
        );
    }
}
