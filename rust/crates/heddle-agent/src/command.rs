//! The `--turn` command, in the owning crate (D-043).
//!
//! Ported from the turn path of `main` in `src/cli.ts`. The binary boots the tree, waits for it to settle,
//! reports pending entries, and dispatches here once `--turn` names a prompt, with the composed
//! [`AgentRuntime`], the model and session services, and the rows that failed to load. From there, in the
//! TypeScript order:
//!
//! 1. the allow list is applied, and a configuration that names a failed row or a tool nothing registered
//!    fails the run: `heddle: the configuration names <problems>, which nothing registered`;
//! 2. the endpoint is `--endpoint` or the model service's default, and must be one it knows;
//! 3. the session is `--resume <id>`, or this folder's current session (a fresh one with `--new`), titled
//!    with the prompt's first sixty characters; the folder it is bound to registers as a workspace;
//! 4. the live `--stream` view starts for that session, the turn runs, a goal driver joins its chain, and the view
//!    is disposed;
//! 5. the result is printed — the answer, one line per tool call and per denial, and the session line; or
//!    with `--json` the TypeScript record, key for key — and the run exits `1` when any denial is not
//!    `UNKNOWN_TOOL`.
//!
//! A failure along the way is `heddle: <sentence>` on the error stream and exit `1`, as the TypeScript `main`'s
//! catch prints it. The entry point reads nothing from the process: the binary passes the folder and streams.

use std::io::Write;
use std::path::PathBuf;
use std::sync::Arc;

use futures::future::BoxFuture;
use serde::Serialize;

use heddle_llm::ModelService;
use heddle_session::{OpenAtOptions, SessionService, StartOptions};

use crate::turn::{AgentRuntime, ContextSummary, Denial, RoundLimit, RunTurnOptions, run_turn};
use crate::upstream::{SessionEvent, SessionHandle};

/// The command words this crate answers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Command {
    /// `heddle --turn <prompt>`: one agent turn in this folder's session.
    Turn,
}

/// The flags the turn reads, named after the TypeScript `Args` fields.
#[derive(Clone, Debug, Default)]
pub struct Args {
    /// `--turn`: the prompt.
    pub turn: Option<String>,
    /// `--endpoint`.
    pub endpoint: Option<String>,
    /// `--model`.
    pub model: Option<String>,
    /// `--system`.
    pub system: Option<String>,
    /// `--max-rounds`; the loop's own default (eight) when absent.
    pub max_rounds: Option<u32>,
    /// `--max-output-tokens`.
    pub max_output_tokens: Option<u32>,
    /// `--resume <id>`: continue that session from anywhere.
    pub resume: Option<String>,
    /// `--new`: start another session in this folder (`fresh` in the TypeScript `Args`).
    pub fresh: bool,
    /// `--json`.
    pub json: bool,
}

/// The live `--stream` view (`heddle-llm`'s printer), fed every session event as it is appended. The turn only
/// ends it and reads its summary.
pub trait StreamView: Send + Sync {
    /// Stop printing.
    fn dispose(&self);
    /// What the view saw, for `--json`'s `stream` key.
    fn summary(&self) -> serde_json::Value;
}

/// `heddle-llm`'s own view is the one the binary passes: it owns `--stream` (D-043), and its methods are `&self`, so
/// the session store's listener can feed it while the turn holds it.
impl StreamView for heddle_llm::command::StreamView {
    fn dispose(&self) {
        heddle_llm::command::StreamView::dispose(self);
    }

    fn summary(&self) -> serde_json::Value {
        heddle_llm::command::StreamView::summary(self)
    }
}

/// Starts the live view for the turn's session, once that session is open and before the turn runs — the
/// TypeScript `printStream(ctx, { session: handle.id })`. The binary's factory also hands the view to the session
/// store's listener, so the first delta reaches standard error while the turn is still running.
pub type StreamStarter<'a> = &'a (dyn Fn(&SessionHandle) -> Arc<dyn StreamView> + Send + Sync);

/// What a goal driver's join answered.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GoalAdvanced {
    /// Rounds the goal continued for after the turn.
    pub rounds: u64,
    /// Why it stopped, in the driver's words.
    pub stopped: String,
}

/// The goal driver (`heddle-goal`): a goal continues itself, and the one-shot process joins its chain.
pub trait GoalAdvance: Send + Sync {
    /// Join the chain the turn's own `turn/completed` started.
    fn advance<'a>(&'a self, session: &'a SessionHandle) -> BoxFuture<'a, GoalAdvanced>;
}

/// What the turn runs against.
pub struct Context<'a> {
    /// The folder the process runs in; this folder's session is the one a turn continues.
    pub cwd: PathBuf,
    /// The composed turn services.
    pub runtime: &'a AgentRuntime,
    /// The model service, which knows the endpoints and the default.
    pub models: &'a ModelService,
    /// The session service.
    pub sessions: &'a SessionService,
    /// Rows that failed to load, worded as `row '<id>' (<name>) failed to load`.
    pub failed_rows: Vec<String>,
    /// Register a folder as a workspace (`workspace.ensureOwner`), when the profile has the workspace row.
    pub ensure_workspace: Option<&'a (dyn Fn(&str) + Send + Sync)>,
    /// Starts the live view, when `--stream` asked for one.
    pub stream: Option<StreamStarter<'a>>,
    /// The goal driver, when the profile has one.
    pub goal: Option<&'a dyn GoalAdvance>,
    /// Background delegation, when the profile has the `subagent-tool` row: the one-shot process waits for the
    /// session's children and the turns their notices start before it prints its answer.
    pub subagents: Option<&'a crate::SubagentService>,
}

/// The sentence a turn fails with when nothing names an endpoint (`heddle-llm`'s, which owns `--endpoint`).
pub use heddle_llm::command::NO_ENDPOINT_CONFIGURED;

/// One tool call as `--json` reports it.
#[derive(Serialize)]
struct CallJson<'a> {
    name: &'a str,
    ok: bool,
}

/// The `--json` record, in the TypeScript key order.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TurnJson<'a> {
    session: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    stream: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    context: Option<ContextSummary>,
    endpoint: &'a str,
    text: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    subagent_notices: Option<usize>,
    finish_reason: &'a str,
    rounds: u32,
    tool_calls: Vec<CallJson<'a>>,
    denials: &'a [Denial],
    transcript: &'a str,
}

/// Run one command; the process exit code.
pub async fn run(
    command: Command,
    args: &Args,
    context: &Context<'_>,
    out: &mut dyn Write,
    err: &mut dyn Write,
) -> i32 {
    match command {
        Command::Turn => match turn(args, context, out, err).await {
            Ok(code) => code,
            Err(sentence) => {
                let _ = writeln!(err, "heddle: {sentence}");
                1
            }
        },
    }
}

/// The endpoint a turn runs on: `--endpoint`, else the configuration's nominated default, else the first
/// configured endpoint — `heddle-llm`'s [`turn_endpoint`](heddle_llm::command::turn_endpoint), which owns
/// `--endpoint` (D-043), over this service's names and nomination. One implementation, two sentences.
pub fn resolve_endpoint(requested: Option<&str>, models: &ModelService) -> Result<String, String> {
    heddle_llm::command::turn_endpoint(requested, &models.names(), models.nominated().as_deref())
}

async fn turn(
    args: &Args,
    context: &Context<'_>,
    out: &mut dyn Write,
    err: &mut dyn Write,
) -> Result<i32, String> {
    let io = |error: std::io::Error| error.to_string();
    let Some(prompt) = args.turn.as_deref() else {
        return Err("--turn needs a prompt".to_owned());
    };
    let tools = &context.runtime.tools;

    // The allow list is applied now, after every plugin has registered; the finished tree is then asked
    // whether the configuration was satisfied.
    tools.filter_to(tools.allow_list());
    let problems: Vec<String> = context
        .failed_rows
        .iter()
        .cloned()
        .chain(tools.missing())
        .collect();
    if !problems.is_empty() {
        writeln!(
            err,
            "heddle: the configuration names {}, which nothing registered",
            problems.join(", ")
        )
        .map_err(io)?;
        return Ok(1);
    }

    let endpoint = resolve_endpoint(args.endpoint.as_deref(), context.models)?;

    // A turn asks this folder's session; `--resume` addresses one by id from anywhere. A new session is born
    // untitled, as the turn route's is (#68): its first message writes the fallback name and the session layer asks
    // the model for the title (heddle_session::title).
    let folder = context.cwd.to_string_lossy().into_owned();
    let handle = match &args.resume {
        Some(resume) => context.sessions.start(StartOptions {
            resume: Some(resume.clone()),
            ..StartOptions::default()
        }),
        None => context.sessions.open_at(
            &folder,
            OpenAtOptions {
                fresh: args.fresh,
                endpoint: Some(endpoint.clone()),
                model: args.model.clone(),
                ..OpenAtOptions::default()
            },
        ),
    }
    .map_err(|error| error.to_string())?;

    // A session always has a workspace when the profile has one at all.
    if let Some(ensure_workspace) = context.ensure_workspace {
        let bound = context
            .sessions
            .meta(&handle.id)
            .map(|meta| meta.cwd().to_owned())
            .filter(|cwd| !cwd.is_empty())
            .unwrap_or_else(|| folder.clone());
        ensure_workspace(&bound);
    }

    // The live view, started before the turn so nothing that arrives is missed.
    let view = context.stream.map(|start| start(&handle));

    let mut options = RunTurnOptions::new(handle.clone(), endpoint.clone(), prompt);
    options.system = args.system.clone();
    options.model = args.model.clone();
    if let Some(rounds) = args.max_rounds {
        options.max_rounds = RoundLimit::Rounds(rounds);
    }
    options.max_output_tokens = args.max_output_tokens;
    let result = run_turn(context.runtime, options)
        .await
        .map_err(|error| error.to_string())?;

    // Background children report back by notice, so a one-shot process waits for them — DSH's headless host
    // waits for its children before its final answer. `settle` returns once no child of this session is running
    // and every notice has been answered; the answer printed is then the session's last one.
    let mut notices = match context.subagents {
        Some(subagents) => subagents.settle(&handle.id).await,
        None => 0,
    };

    // A goal continues itself; joining its chain keeps a one-shot process alive until its rounds are done.
    if let Some(goal) = context.goal {
        let driven = goal.advance(&handle).await;
        if !args.json && driven.rounds > 0 {
            writeln!(
                out,
                "heddle: the goal continued for {} round(s); {}",
                driven.rounds, driven.stopped
            )
            .map_err(io)?;
        }
        if let Some(subagents) = context.subagents {
            notices = subagents.settle(&handle.id).await;
        }
    }
    let final_text = if notices > 0 {
        let events = context
            .sessions
            .events(&handle)
            .map_err(|error| error.to_string())?;
        let events: Vec<SessionEvent> = events
            .iter()
            .map(|event| SessionEvent::clone(event))
            .collect();
        crate::final_assistant_text(&events)
    } else {
        result.text.clone()
    };
    if !args.json && notices > 0 {
        writeln!(out, "heddle: answered {notices} subagent notice(s)").map_err(io)?;
    }
    let streamed = view.map(|view| {
        view.dispose();
        view.summary()
    });

    if args.json {
        let record = TurnJson {
            session: &handle.id,
            stream: streamed,
            context: result.context,
            endpoint: &endpoint,
            text: &final_text,
            subagent_notices: (notices > 0).then_some(notices),
            finish_reason: &result.finish_reason,
            rounds: result.rounds,
            tool_calls: result
                .tool_calls
                .iter()
                .map(|call| CallJson {
                    name: &call.name,
                    ok: call.result.error.is_none(),
                })
                .collect(),
            denials: &result.denials,
            transcript: &handle.transcript,
        };
        let text = serde_json::to_string_pretty(&record).map_err(|error| error.to_string())?;
        writeln!(out, "{text}").map_err(io)?;
    } else {
        writeln!(out, "{final_text}").map_err(io)?;
        for call in &result.tool_calls {
            match &call.result.error {
                Some(error) => writeln!(
                    out,
                    "heddle: tool {} refused ({}) — {}",
                    call.name, error.code, error.message
                ),
                None => writeln!(out, "heddle: tool {} ok", call.name),
            }
            .map_err(io)?;
        }
        for denial in &result.denials {
            writeln!(out, "heddle: denied {} — {}", denial.tool, denial.message).map_err(io)?;
        }
        writeln!(out, "heddle: session {} — {}", handle.id, handle.transcript).map_err(io)?;
    }

    let refused = result
        .denials
        .iter()
        .any(|denial| denial.code != heddle_tools::codes::UNKNOWN_TOOL);
    Ok(i32::from(refused))
}

#[cfg(test)]
mod tests {
    use std::path::Path;
    use std::sync::Arc;

    use heddle_sandbox::{
        ApprovalService, ApprovalsConfig, BackendChoice, Platform, SandboxConfig, SandboxHost,
        SandboxMode, SandboxService,
    };
    use heddle_tools::{ToolRegistry, ToolsConfig, adapters::gates_over};
    use serde_json::json;

    use super::*;
    use crate::adapters::tests::{ScratchDir, SessionMessages, scripted_service, sessions_at};
    use crate::adapters::{LlmModel, Sessions};
    use crate::ports::NoTurnHooks;
    use crate::turns::TurnRegistry;

    /// One composed harness: a scratch workspace, a real sandbox, approvals and session store, the real
    /// built-ins, and a scripted model.
    struct Harness {
        work: PathBuf,
        models: Arc<ModelService>,
        sessions: Arc<SessionService>,
        runtime: AgentRuntime,
        /// The scratch folders behind `work`, the step file and the sessions, removed when the harness drops.
        _scratch: Vec<ScratchDir>,
    }

    /// A scratch workspace (its canonical path) and the guard that removes it.
    fn scratch(label: &str) -> (PathBuf, ScratchDir) {
        let dir = ScratchDir::new(&format!("command-{label}"));
        (dir.path().canonicalize().unwrap(), dir)
    }

    fn sandbox_at(root: &Path) -> Arc<SandboxService> {
        let config = SandboxConfig {
            mode: SandboxMode::WorkspaceWrite,
            workspace_root: Some(root.to_path_buf()),
            backend: BackendChoice::Disabled,
            ..SandboxConfig::default()
        };
        let host = SandboxHost {
            cwd: root.to_path_buf(),
            harness_home: root.join(".heddle"),
            platform: Platform::current(),
        };
        Arc::new(SandboxService::with_backend(&config, &host, None))
    }

    fn harness(label: &str, steps: serde_json::Value, allow: &[&str]) -> Harness {
        let (work, work_dir) = scratch(label);
        let (sessions, sessions_dir) = sessions_at(label);
        let (models, models_dir) = scripted_service(label, steps);
        let gates = gates_over(
            sandbox_at(&work),
            Arc::new(ApprovalService::new(ApprovalsConfig::default())),
            Arc::clone(&sessions),
        );
        let tools = ToolRegistry::from_config(
            gates,
            &ToolsConfig {
                allow: allow.iter().map(|name| (*name).to_owned()).collect(),
                ..ToolsConfig::default()
            },
        );
        let runtime = AgentRuntime {
            model: Arc::new(LlmModel::new(Arc::clone(&models))),
            session: Arc::new(Sessions::new(Arc::clone(&sessions))),
            context: Arc::new(SessionMessages {
                sessions: Arc::clone(&sessions),
            }),
            tools: Arc::new(tools),
            hooks: Arc::new(NoTurnHooks),
            turns: Some(TurnRegistry::new()),
            presets: None,
        };
        Harness {
            work,
            models,
            sessions,
            runtime,
            _scratch: vec![work_dir, sessions_dir, models_dir],
        }
    }

    impl Harness {
        fn context(&self) -> Context<'_> {
            Context {
                cwd: self.work.clone(),
                runtime: &self.runtime,
                models: &self.models,
                sessions: &self.sessions,
                failed_rows: Vec::new(),
                ensure_workspace: None,
                stream: None,
                goal: None,
                subagents: None,
            }
        }

        async fn run(&self, args: &Args) -> (i32, String, String) {
            self.run_with(args, &self.context()).await
        }

        async fn run_with(&self, args: &Args, context: &Context<'_>) -> (i32, String, String) {
            let mut out = Vec::new();
            let mut err = Vec::new();
            let code = run(Command::Turn, args, context, &mut out, &mut err).await;
            (
                code,
                String::from_utf8(out).unwrap(),
                String::from_utf8(err).unwrap(),
            )
        }

        fn only_session(&self) -> SessionHandle {
            let list = self.sessions.list();
            assert_eq!(list.len(), 1, "exactly one session");
            self.sessions.open(list[0].id()).unwrap()
        }
    }

    fn turn(prompt: &str) -> Args {
        Args {
            turn: Some(prompt.to_owned()),
            ..Args::default()
        }
    }

    fn tool_texts(sessions: &SessionService, handle: &SessionHandle) -> Vec<String> {
        sessions
            .events(handle)
            .unwrap()
            .iter()
            .filter(|event| event.kind == "message" && event.fields["message"]["role"] == "tool")
            .map(|event| {
                event.fields["message"]["content"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter_map(|part| part["text"].as_str())
                    .collect::<String>()
            })
            .collect()
    }

    #[tokio::test]
    async fn a_multi_step_task_writes_reads_and_prints_the_answer_with_each_call() {
        let h = harness(
            "multi",
            json!([
                { "toolCall": { "name": "write_file", "arguments": { "path": "one.txt", "content": "first" } } },
                { "toolCall": { "name": "read_file", "arguments": { "path": "one.txt" } } },
                { "text": "finished the task" }
            ]),
            &[],
        );
        let (code, out, err) = h.run(&turn("write a file then read it")).await;
        assert_eq!(code, 0, "{out}{err}");
        let session = h.only_session();
        let lines: Vec<&str> = out.lines().collect();
        assert_eq!(lines[0], "finished the task");
        assert_eq!(lines[1], "heddle: tool write_file ok");
        assert_eq!(lines[2], "heddle: tool read_file ok");
        assert_eq!(
            lines[3],
            format!("heddle: session {} — {}", session.id, session.transcript)
        );
        assert_eq!(lines.len(), 4);
        assert_eq!(
            std::fs::read_to_string(h.work.join("one.txt")).unwrap(),
            "first"
        );
        let texts = tool_texts(&h.sessions, &session);
        assert!(texts.join("\n").contains("first"), "{texts:?}");
    }

    #[tokio::test]
    async fn the_json_record_keeps_the_typescript_keys_in_order() {
        let h = harness(
            "json",
            json!([
                { "toolCall": { "name": "list_dir", "arguments": {} } },
                { "text": "listed" }
            ]),
            &[],
        );
        let (code, out, _) = h
            .run(&Args {
                json: true,
                ..turn("list it")
            })
            .await;
        assert_eq!(code, 0);
        let record: serde_json::Value = serde_json::from_str(&out).unwrap();
        let keys: Vec<&str> = record
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(
            keys,
            [
                "session",
                "context",
                "endpoint",
                "text",
                "finishReason",
                "rounds",
                "toolCalls",
                "denials",
                "transcript"
            ]
        );
        assert_eq!(record["endpoint"], "scripted");
        assert_eq!(record["text"], "listed");
        assert_eq!(record["rounds"], 2);
        assert_eq!(
            record["toolCalls"],
            json!([{ "name": "list_dir", "ok": true }])
        );
        assert_eq!(record["denials"], json!([]));
        assert!(out.ends_with("}\n") && out.starts_with("{\n  \"session\""));
    }

    #[tokio::test]
    async fn an_unknown_tool_is_refused_by_name_and_does_not_fail_the_run() {
        let h = harness(
            "unknown",
            json!([
                { "toolCall": { "name": "write_file", "arguments": { "path": "x.txt", "content": "no" } } },
                { "text": "understood" }
            ]),
            &["read_file"],
        );
        let (code, out, _) = h.run(&turn("write something")).await;
        assert_eq!(code, 0, "an UNKNOWN_TOOL denial alone exits 0\n{out}");
        assert!(out.contains("heddle: tool write_file refused (UNKNOWN_TOOL) — no tool named 'write_file'; known: read_file"), "{out}");
        assert!(out.contains("heddle: denied write_file — "), "{out}");
        assert!(!h.work.join("x.txt").exists());
        let session = h.only_session();
        assert!(
            tool_texts(&h.sessions, &session)
                .join("\n")
                .contains("UNKNOWN_TOOL")
        );
    }

    #[tokio::test]
    async fn a_failing_tool_is_answered_and_the_run_exits_one() {
        let h = harness(
            "failure",
            json!([
                { "toolCall": { "name": "read_file", "arguments": { "path": "not-here.txt" } } },
                { "text": "it was missing" }
            ]),
            &[],
        );
        let (code, out, _) = h.run(&turn("read a file that is not there")).await;
        assert_eq!(
            code, 1,
            "a refusal other than UNKNOWN_TOOL makes the run exit 1"
        );
        assert!(out.starts_with("it was missing\n"), "{out}");
        let session = h.only_session();
        assert!(
            tool_texts(&h.sessions, &session)[0].starts_with("error ("),
            "the failure came back as the tool result"
        );
    }

    #[tokio::test]
    async fn a_configuration_naming_a_tool_nothing_registered_fails_where_it_is_written() {
        let h = harness(
            "missing",
            json!([{ "text": "never asked" }]),
            &["read_file", "definitely_not_a_tool"],
        );
        let (code, out, err) = h.run(&turn("say something")).await;
        assert_eq!(code, 1);
        assert_eq!(
            err,
            "heddle: the configuration names definitely_not_a_tool, which nothing registered\n"
        );
        assert!(out.is_empty());
        assert!(h.sessions.list().is_empty(), "no session was started");
    }

    #[tokio::test]
    async fn failed_rows_and_missing_tools_are_named_on_one_line() {
        let h = harness("rows", json!([]), &["definitely_not_a_tool"]);
        let mut context = h.context();
        context.failed_rows = vec!["row 'plugin-1' (./bad.ts) failed to load".to_owned()];
        let (code, _, err) = h.run_with(&turn("go"), &context).await;
        assert_eq!(code, 1);
        assert_eq!(
            err,
            "heddle: the configuration names row 'plugin-1' (./bad.ts) failed to load, definitely_not_a_tool, which nothing registered\n"
        );
    }

    #[tokio::test]
    async fn an_endpoint_nothing_configures_is_refused_with_the_configured_names() {
        let h = harness("endpoint", json!([]), &[]);
        let (code, _, err) = h
            .run(&Args {
                endpoint: Some("nowhere".into()),
                ..turn("go")
            })
            .await;
        assert_eq!(code, 1);
        assert_eq!(
            err,
            "heddle: no endpoint named 'nowhere'; configured: scripted\n"
        );
        assert!(h.sessions.list().is_empty());
    }

    #[tokio::test]
    async fn a_turn_continues_the_folders_session_and_resume_reaches_it_from_anywhere() {
        let h = harness("resume", json!([{ "text": "an answer" }]), &[]);
        let (first, _, _) = h.run(&turn("first question")).await;
        assert_eq!(first, 0);
        let session = h.only_session();
        let before = h.sessions.events(&session).unwrap().len();

        let (second, _, _) = h.run(&turn("second question")).await;
        assert_eq!(second, 0);
        assert_eq!(
            h.sessions.list().len(),
            1,
            "the folder's session was continued"
        );

        let (third, _, _) = h
            .run(&Args {
                resume: Some(session.id.clone()),
                ..turn("third question")
            })
            .await;
        assert_eq!(third, 0);
        let events = h.sessions.events(&session).unwrap();
        assert!(events.len() > before, "the record grew");
        let users: Vec<String> = events
            .iter()
            .filter(|event| event.kind == "message" && event.fields["message"]["role"] == "user")
            .map(|event| {
                event.fields["message"]["content"][0]["text"]
                    .as_str()
                    .unwrap()
                    .to_owned()
            })
            .collect();
        assert_eq!(
            users,
            ["first question", "second question", "third question"]
        );

        let (fresh, _, _) = h
            .run(&Args {
                fresh: true,
                ..turn("another conversation")
            })
            .await;
        assert_eq!(fresh, 0);
        assert_eq!(h.sessions.list().len(), 2, "--new started another session");
    }

    #[tokio::test]
    async fn resuming_a_session_that_does_not_exist_fails_and_starts_nothing() {
        let h = harness("noresume", json!([]), &[]);
        let (code, _, err) = h
            .run(&Args {
                resume: Some("nope".into()),
                ..turn("go")
            })
            .await;
        assert_eq!(code, 1);
        assert!(err.starts_with("heddle: "), "{err}");
        assert!(err.contains("nope"), "{err}");
        assert!(h.sessions.list().is_empty());
    }

    #[tokio::test]
    async fn the_round_limit_is_respected_and_recorded() {
        let h = harness(
            "limit",
            json!([
                { "toolCall": { "name": "list_dir", "arguments": {} } },
                { "toolCall": { "name": "list_dir", "arguments": {} } },
                { "toolCall": { "name": "list_dir", "arguments": {} } }
            ]),
            &[],
        );
        let (code, _, _) = h
            .run(&Args {
                max_rounds: Some(2),
                ..turn("keep going")
            })
            .await;
        assert_eq!(code, 0);
        let session = h.only_session();
        let events = h.sessions.events(&session).unwrap();
        let requests = events
            .iter()
            .filter(|event| event.kind == "model/request")
            .count();
        assert_eq!(requests, 2);
        let completed = events
            .iter()
            .find(|event| event.kind == "assistant/completed")
            .unwrap();
        assert!(
            completed.fields["ended"]
                .to_string()
                .contains("round limit of 2"),
            "{}",
            completed.fields["ended"]
        );
    }

    struct Goal;

    impl GoalAdvance for Goal {
        fn advance<'a>(&'a self, _: &'a SessionHandle) -> BoxFuture<'a, GoalAdvanced> {
            Box::pin(async {
                GoalAdvanced {
                    rounds: 2,
                    stopped: "the goal was met".to_owned(),
                }
            })
        }
    }

    struct Registered {
        folders: std::sync::Mutex<Vec<String>>,
    }

    #[tokio::test]
    async fn the_goal_driver_is_joined_and_the_bound_folder_registers_as_a_workspace() {
        let h = harness("goal", json!([{ "text": "done" }]), &[]);
        let registered = Arc::new(Registered {
            folders: std::sync::Mutex::new(Vec::new()),
        });
        let sink = Arc::clone(&registered);
        let ensure = move |folder: &str| sink.folders.lock().unwrap().push(folder.to_owned());
        let goal = Goal;
        let mut context = h.context();
        context.ensure_workspace = Some(&ensure);
        context.goal = Some(&goal);
        let (code, out, _) = h.run_with(&turn("pursue it"), &context).await;
        assert_eq!(code, 0);
        assert!(
            out.contains("heddle: the goal continued for 2 round(s); the goal was met\n"),
            "{out}"
        );
        assert_eq!(
            registered.folders.lock().unwrap().as_slice(),
            [h.work.to_string_lossy().into_owned()]
        );
    }

    /// A title model that answers at once, as the scripted endpoint's `session-title` step would, or fails.
    struct AnsweringTitles(Result<&'static str, &'static str>);

    impl heddle_session::TitleModel for AnsweringTitles {
        fn generate(&self, request: heddle_llm::GenerateRequest, done: heddle_session::TitleDone) {
            assert_eq!(
                request.purpose.as_deref(),
                Some(heddle_session::SESSION_TITLE_PURPOSE)
            );
            done(match self.0 {
                Ok(text) => Ok(heddle_session::TitleAnswer {
                    text: text.to_owned(),
                    finish_reason: "stop".to_owned(),
                    tool_calls: 0,
                }),
                Err(message) => Err(message.to_owned()),
            });
        }
    }

    #[tokio::test]
    async fn a_new_turn_session_is_titled_from_its_first_prompt_as_a_blank_one_is() {
        // #68: DSH writes no title when a session is created; dsh-session-title writes the fallback from the first
        // eligible human message (lib/index.js:396-403, 620-648) and asks the first-prompt provider only for a session
        // with no title yet (:387). `--turn` opened its session titled with the prompt's first sixty characters, so the
        // coordinator saw a named session and asked nothing.
        const PROMPT: &str = "Please summarise the quarterly revenue figures for the northern region and compare them with last year, thanks.";
        let titled = harness("title", json!([{ "text": "an answer" }]), &[]);
        titled.sessions.attach_titles(Arc::new(AnsweringTitles(Ok(
            "**Northern revenue year on year**",
        ))));
        let (code, out, err) = titled
            .run(&Args {
                fresh: true,
                ..turn(PROMPT)
            })
            .await;
        assert_eq!(code, 0, "{out}{err}");
        let meta = &titled.sessions.list()[0];
        assert_eq!(
            meta.title(),
            Some("Northern revenue year on year"),
            "the generated title replaced the fallback"
        );

        let failed = harness("title-failed", json!([{ "text": "an answer" }]), &[]);
        failed
            .sessions
            .attach_titles(Arc::new(AnsweringTitles(Err("the title model is down"))));
        let (code, _, _) = failed
            .run(&Args {
                fresh: true,
                ..turn(PROMPT)
            })
            .await;
        assert_eq!(code, 0);
        let title = failed.sessions.list()[0].title().map(str::to_owned);
        assert_eq!(
            title.as_deref(),
            Some(heddle_session::title_from(PROMPT).as_str()),
            "a failed call leaves the fallback the first message wrote, cut at a word"
        );
        assert_ne!(
            title,
            Some(PROMPT.chars().take(60).collect::<String>()),
            "not the prompt cut mid-word at sixty characters"
        );
    }

    /// A writer whose bytes the test can read after the view wrote them.
    #[derive(Clone, Default)]
    struct Captured(Arc<std::sync::Mutex<Vec<u8>>>);

    impl std::io::Write for Captured {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[tokio::test]
    async fn stream_starts_the_view_for_the_turns_session_and_reports_it_after_session() {
        // The binary's wiring: the store's listener forwards each appended event to the view in the slot, and
        // the starter builds heddle-llm's real view for the session the turn opened.
        type Slot = Arc<std::sync::Mutex<Option<Arc<heddle_llm::command::StreamView>>>>;
        let slot: Slot = Arc::default();
        let feed = Arc::clone(&slot);
        let listener: heddle_session::EventListener = Arc::new(move |handle, event| {
            if let Some(view) = feed.lock().unwrap().as_ref() {
                view.observe_value(&handle.id, &serde_json::to_value(event).unwrap());
            }
        });
        let mut h = harness(
            "stream",
            json!([{ "reasoning": "thinking", "text": "streamed answer" }]),
            &[],
        );
        let root = ScratchDir::new("command-stream-store");
        let config = heddle_session::SessionConfig {
            root: Some(root.path().to_str().unwrap().to_owned()),
        };
        let sessions = Arc::new(SessionService::new(
            &config,
            &heddle_config::Env::default(),
            Some(listener),
        ));
        h.runtime.session = Arc::new(Sessions::new(Arc::clone(&sessions)));
        h.runtime.context = Arc::new(SessionMessages {
            sessions: Arc::clone(&sessions),
        });
        h.sessions = sessions;

        let stderr = Captured::default();
        let written = stderr.clone();
        let install = Arc::clone(&slot);
        let start = move |handle: &SessionHandle| -> Arc<dyn StreamView> {
            let view = Arc::new(heddle_llm::command::print_stream(
                &handle.id,
                Box::new(written.clone()),
            ));
            *install.lock().unwrap() = Some(Arc::clone(&view));
            view
        };
        let mut context = h.context();
        context.stream = Some(&start);
        let (code, out, err) = h
            .run_with(
                &Args {
                    json: true,
                    ..turn("stream it")
                },
                &context,
            )
            .await;
        assert_eq!(code, 0, "{out}{err}");
        let record: serde_json::Value = serde_json::from_str(&out).unwrap();
        let keys: Vec<&str> = record
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(&keys[..3], ["session", "stream", "context"], "{keys:?}");
        assert!(
            record["stream"]["textDeltas"].as_u64().unwrap() >= 1,
            "{}",
            record["stream"]
        );
        assert_eq!(record["stream"]["completed"], true);
        let printed = String::from_utf8(stderr.0.lock().unwrap().clone()).unwrap();
        assert!(
            printed.contains("streamed answer"),
            "the view wrote the delta: {printed:?}"
        );
    }
}
