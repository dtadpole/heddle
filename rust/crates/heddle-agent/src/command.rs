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
//! 4. the turn runs, a goal driver joins its chain, the live stream view is disposed;
//! 5. the result is printed — the answer, one line per tool call and per denial, and the session line; or
//!    with `--json` the TypeScript record, key for key — and the run exits `1` when any denial is not
//!    `UNKNOWN_TOOL`.
//!
//! A failure along the way is `heddle: <sentence>` on the error stream and exit `1`, as the TypeScript `main`'s
//! catch prints it. The entry point reads nothing from the process: the binary passes the folder and streams.

use std::io::Write;
use std::path::PathBuf;

use futures::future::BoxFuture;
use serde::Serialize;

use heddle_llm::ModelService;
use heddle_session::{OpenAtOptions, SessionService, StartOptions};

use crate::turn::{AgentRuntime, ContextSummary, Denial, RoundLimit, RunTurnOptions, run_turn};
use crate::upstream::SessionHandle;

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

/// The live `--stream` view, which the binary starts before the turn and feeds every session event as it is
/// appended (`heddle-llm`'s printer). The turn only ends it and reads its summary.
pub trait StreamView: Send + Sync {
    /// Stop printing.
    fn dispose(&self);
    /// What the view saw, for `--json`'s `stream` key.
    fn summary(&self) -> serde_json::Value;
}

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
    /// The live view, when `--stream` asked for one.
    pub stream: Option<&'a dyn StreamView>,
    /// The goal driver, when the profile has one.
    pub goal: Option<&'a dyn GoalAdvance>,
}

/// The sentence a turn fails with when nothing names an endpoint.
pub const NO_ENDPOINT_CONFIGURED: &str = "no endpoint is configured; write ~/.heddle/heddle.json or pass --endpoint after configuring one";

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

/// The endpoint a turn runs on: `--endpoint`, else the service's default, and one the service knows.
pub fn resolve_endpoint(requested: Option<&str>, models: &ModelService) -> Result<String, String> {
    let names = models.names();
    let endpoint = match requested {
        Some(endpoint) => endpoint.to_owned(),
        None => models
            .default_endpoint(None)
            .ok_or_else(|| NO_ENDPOINT_CONFIGURED.to_owned())?,
    };
    if !names.contains(&endpoint) {
        return Err(format!(
            "no endpoint named '{endpoint}'; configured: {}",
            names.join(", ")
        ));
    }
    Ok(endpoint)
}

/// The prompt's first sixty characters, the title a new session is given.
fn title_of(prompt: &str) -> String {
    prompt.chars().take(60).collect()
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

    // A turn asks this folder's session; `--resume` addresses one by id from anywhere.
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
                title: Some(title_of(prompt)),
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
    }
    let streamed = context.stream.map(|view| {
        view.dispose();
        view.summary()
    });

    if args.json {
        let record = TurnJson {
            session: &handle.id,
            stream: streamed,
            context: result.context,
            endpoint: &endpoint,
            text: &result.text,
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
        writeln!(out, "{}", result.text).map_err(io)?;
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
    use crate::adapters::tests::{SessionMessages, scripted_service, sessions_at};
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
    }

    fn scratch(label: &str) -> PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let n = NEXT.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!(
            "heddle-agent-command-{label}-{}-{n}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir.canonicalize().unwrap()
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
        let work = scratch(label);
        let sessions = sessions_at(label);
        let models = scripted_service(label, steps);
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
        };
        Harness {
            work,
            models,
            sessions,
            runtime,
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

    #[test]
    fn a_new_sessions_title_is_the_prompts_first_sixty_characters() {
        assert_eq!(title_of("short"), "short");
        assert_eq!(title_of(&"é".repeat(70)).chars().count(), 60);
    }
}
