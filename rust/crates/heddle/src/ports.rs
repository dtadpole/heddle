//! What the binary calls on each crate: the consumer side of the composition, one trait per service.
//!
//! Each trait is the **narrowest view the commands need**, read off the call sites in `src/cli.ts`, so an
//! owning crate sees in one place what the binary will ask of it. They are not a second API for those
//! crates: an adapter in [`builtins`](crate::builtins) implements each trait over the crate's own public
//! types once they land, and where a crate's shape differs from what is written here, **the crate's shape
//! wins** and the adapter absorbs the difference. Until then the commands are built and unit-tested
//! against doubles of these traits.
//!
//! Records that a command prints whole with `--json` cross as [`Record`] — the object exactly as the
//! owning crate serializes it, which is the TypeScript shape field for field — and the commands read the
//! few fields their text output names. Requests the binary builds, and results it computes with, are
//! typed here.

use std::any::Any;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use futures::future::BoxFuture;
use serde_json::Value;

/// A record as its owning crate serializes it: a `SessionMeta`, a `WorkspaceRecord`, a `TreeNode`, …
pub type Record = Value;

/// A refusal from a crate, carrying the sentence the TypeScript build throws, which the binary prints
/// as `heddle: <message>`.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct PortError {
    /// The sentence, verbatim.
    pub message: String,
}

impl PortError {
    /// A refusal with this sentence.
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

/// What every port method returns.
pub type PortResult<T> = Result<T, PortError>;

/// An open session, as the commands pass it between crates.
///
/// `id` and `transcript` are what the commands print; `inner` is the session crate's own handle, which
/// the adapters of the other crates (goal, context, agent) downcast to call their crate with it.
#[derive(Clone)]
pub struct SessionHandle {
    /// The session id.
    pub id: String,
    /// The path of its log, printed after a turn.
    pub transcript: PathBuf,
    /// The owning crate's handle.
    pub inner: Arc<dyn Any + Send + Sync>,
}

impl std::fmt::Debug for SessionHandle {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("SessionHandle")
            .field("id", &self.id)
            .field("transcript", &self.transcript)
            .finish_non_exhaustive()
    }
}

// ---------------------------------------------------------------------------------------------------
// heddle-session. `src/session/service.ts`, `store.ts`, `tree.ts`.
// ---------------------------------------------------------------------------------------------------

/// `session.openAt(folder, …)` options: the folder's own session, created on its first turn.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenAt {
    /// `--new`: start another session in the folder, which becomes its current one.
    pub fresh: bool,
    /// The endpoint the turn runs on, recorded when the session is new.
    pub endpoint: String,
    /// `--model`, recorded when the session is new.
    pub model: Option<String>,
    /// The first 60 characters of the prompt.
    pub title: String,
}

/// `session.createAt(branch, …)` options (`session new`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CreateAt {
    /// A title, when one was given.
    pub title: Option<String>,
    /// `--endpoint`.
    pub endpoint: Option<String>,
    /// `--model`.
    pub model: Option<String>,
}

/// Where `session new` wrote the session's definition and where its log will be.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionDefinition {
    /// The definition's name.
    pub name: String,
    /// The folder the definition was written in.
    pub dir: PathBuf,
    /// The definition file.
    pub file: PathBuf,
    /// The session's log.
    pub log: PathBuf,
}

/// A workspace root as the tree takes it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TreeRoot {
    /// Canonical absolute path.
    pub path: PathBuf,
    /// The root's title.
    pub title: String,
    /// How the root came to exist (`added`, `auto`, `bootstrap`), when recorded.
    pub origin: Option<String>,
}

/// `ctx.session`, plus the two free functions of `src/session/tree.ts` the commands call.
pub trait SessionPort: Send + Sync {
    /// `session.store.root`: where the sessions live (`sessions`).
    fn root(&self) -> PathBuf;
    /// `session.list()`: every `SessionMeta`, newest first (`sessions`, `workspaces`, `tree`, `web`).
    fn list(&self) -> Vec<Record>;
    /// `session.store.open(id)`: an existing session, or `None` (`web`'s goal and team recovery).
    fn open(&self, id: &str) -> Option<SessionHandle>;
    /// `session.start({ resume })` (`transcript`, `goal <id>`, `context <id>`, `--resume`).
    fn resume(&self, id: &str) -> PortResult<SessionHandle>;
    /// `session.start({ cwd })`: the folder's current session (`goal`, `context` without an id).
    fn current(&self, cwd: &Path) -> PortResult<SessionHandle>;
    /// `session.openAt(folder, …)`: the folder's session for a turn.
    fn open_at(&self, folder: &Path, options: OpenAt) -> PortResult<SessionHandle>;
    /// `session.createAt(branch, …)` (`session new`).
    fn create_at(
        &self,
        branch: &Path,
        options: CreateAt,
    ) -> PortResult<(SessionHandle, SessionDefinition)>;
    /// `session.events(handle)`: the log's events in order (`transcript`, one JSON line each).
    fn events(&self, handle: &SessionHandle) -> PortResult<Vec<Record>>;
    /// `session.folder(handle)`: the folder the session is bound to (`context`).
    fn folder(&self, handle: &SessionHandle) -> Option<PathBuf>;
    /// `tree(wanted, { roots, sessions, generated })`: a `TreeNode` one level deep (`tree`).
    fn tree(
        &self,
        wanted: Option<&Path>,
        roots: &[TreeRoot],
        sessions: &[Record],
        generated: &[String],
    ) -> PortResult<Record>;
    /// `readFileText(path)`: a `FileReading` (`file`).
    fn read_file_text(&self, path: &Path) -> PortResult<Record>;
}

// ---------------------------------------------------------------------------------------------------
// heddle-workspace. `src/workspace/service.ts`.
// ---------------------------------------------------------------------------------------------------

/// `ctx.workspace`.
pub trait WorkspacePort: Send + Sync {
    /// `workspace.file`: where the records are kept.
    fn file(&self) -> PathBuf;
    /// `workspace.list()`: every `WorkspaceRecord`.
    fn list(&self) -> Vec<Record>;
    /// `workspace.sessions(record, all)`: the sessions a root owns.
    fn sessions(&self, record: &Record, all: &[Record]) -> Vec<Record>;
    /// `workspace.add(path, name)`: the record, and whether it was created rather than already there.
    fn add(&self, path: &str, name: Option<&str>) -> PortResult<(Record, bool)>;
    /// `workspace.rename(target, name)`: the renamed record, or `None` when no root matches.
    fn rename(&self, target: &str, name: &str) -> PortResult<Option<Record>>;
    /// `workspace.remove(target, { all, force })`: the outcome (`removed`, `adoptedBy`, `ownedSessions`).
    fn remove(&self, target: &str, all: &[Record], force: bool) -> PortResult<Record>;
    /// `workspace.owner(path)`: the root a canonical path is under, if any — the fence of `tree` and `file`.
    fn owner(&self, path: &Path) -> Option<Record>;
    /// `workspace.ensureOwner(path)`: register the folder when no root is above it.
    fn ensure_owner(&self, path: &Path) -> PortResult<()>;
    /// `workspace.generated`: the folders the profile names as generated.
    fn generated(&self) -> Vec<String>;
}

// ---------------------------------------------------------------------------------------------------
// heddle-llm. `src/plugins/model.ts`, `src/stream/printer.ts`; `describeEndpoint`
// of `src/endpoints.ts` comes from heddle-config.
// ---------------------------------------------------------------------------------------------------

/// `ctx.model`.
pub trait ModelPort: Send + Sync {
    /// `model.list().map(describeEndpoint)`: each endpoint described without its credential (`models`).
    fn describe(&self) -> Vec<Record>;
    /// `model.names()`.
    fn names(&self) -> Vec<String>;
    /// `model.defaultEndpoint()`: the configured default, else the first by name.
    fn default_endpoint(&self) -> Option<String>;
}

/// A running `--stream` printer.
pub trait StreamPrinter: Send {
    /// Stop printing.
    fn dispose(&mut self);
    /// The `StreamSummary`, printed under `stream` in a turn's `--json`.
    fn summary(&self) -> Record;
}

/// `printStream(ctx, { session })`.
pub trait StreamPort: Send + Sync {
    /// Start printing the session's reasoning and content deltas to `stderr` as they arrive.
    fn print_stream(&self, session: &str, stderr: Box<dyn Write + Send>) -> Box<dyn StreamPrinter>;
}

// ---------------------------------------------------------------------------------------------------
// heddle-tools. `src/plugins/tools.ts`, `src/tools/`.
// ---------------------------------------------------------------------------------------------------

/// `ctx.tools`.
pub trait ToolsPort: Send + Sync {
    /// `tools.describe()`: each tool's descriptor (`name`, `description`, schema), after the allow list.
    fn describe(&self) -> Vec<Record>;
    /// `tools.describeCommands()`: each command's `name` and `description`.
    fn describe_commands(&self) -> Vec<Record>;
    /// `tools.allowList()`: the configured allow list.
    fn allow_list(&self) -> Vec<String>;
    /// `tools.filterTo(allow)`: applied once, after every row has loaded.
    fn filter_to(&self, allow: &[String]);
    /// `tools.missing()`: the allowed names nothing registered, each a configuration problem.
    fn missing(&self) -> Vec<String>;
}

// ---------------------------------------------------------------------------------------------------
// heddle-context. `src/context/service.ts`.
// ---------------------------------------------------------------------------------------------------

/// `context.assemble(handle, …)` options.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct AssembleOptions {
    /// The folder instructions resolve from: the session's own, else the sandbox root.
    pub cwd: Option<PathBuf>,
    /// The tool descriptors, from [`ToolsPort::describe`].
    pub tools: Vec<Record>,
    /// `--endpoint`.
    pub endpoint: Option<String>,
    /// `--model`.
    pub model: Option<String>,
}

/// `ctx.context`.
pub trait ContextPort: Send + Sync {
    /// The `ContextReport` (`estimatedTokens`, `thresholdTokens`, `contextWindow`, `pruned`, `compacted`,
    /// `instructions`), with each of its `messages` already described as `{ role, toolCallId?, text }` —
    /// `describeContent` of heddle-llm applied by the adapter.
    fn assemble(&self, handle: &SessionHandle, options: AssembleOptions) -> PortResult<Record>;
}

// ---------------------------------------------------------------------------------------------------
// heddle-sandbox. `src/sandbox/service.ts`.
// ---------------------------------------------------------------------------------------------------

/// `ctx.sandbox`.
pub trait SandboxPort: Send + Sync {
    /// `sandbox.workspaceRoot`: the fallback folder for `context` when a session records none.
    fn workspace_root(&self) -> PathBuf;
}

// ---------------------------------------------------------------------------------------------------
// heddle-goal. `src/goal/service.ts`, `src/goal/driver.ts`.
// ---------------------------------------------------------------------------------------------------

/// `ctx.goal`.
pub trait GoalPort: Send + Sync {
    /// `goal.get(handle)`: the current `GoalView` (`id`, `revision`, `phase`, `activation`, `objective`,
    /// `roundsStarted`, `maxGoalRounds`, `blockedReason`), or `None`.
    fn get(&self, handle: &SessionHandle) -> PortResult<Option<Record>>;
}

/// What `goalDriver.advance` did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Driven {
    /// Rounds the goal continued for.
    pub rounds: u64,
    /// Why it stopped, as a sentence.
    pub stopped: String,
}

/// `ctx.goalDriver`.
pub trait GoalDriverPort: Send + Sync {
    /// `goalDriver.advance(handle)`: join the chain this turn's `turn/completed` started.
    fn advance<'a>(&'a self, handle: &'a SessionHandle) -> BoxFuture<'a, PortResult<Driven>>;
    /// `goalDriver.resumeAtStart(handles)`: how many active goals the server asked to resume.
    fn resume_at_start<'a>(
        &'a self,
        handles: &'a [SessionHandle],
    ) -> BoxFuture<'a, PortResult<u64>>;
}

// ---------------------------------------------------------------------------------------------------
// heddle-team. `src/plugins/team.ts`, `src/team/`.
// ---------------------------------------------------------------------------------------------------

/// What `team.recoverAll` did at server start.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Recovered {
    /// Teams recovered.
    pub recovered: u64,
    /// Members a previous process left provisioning, now settled.
    pub settled: u64,
    /// Undelivered messages offered again.
    pub delivered: u64,
    /// Teams that could not be recovered.
    pub failed: u64,
}

/// `ctx.team`.
pub trait TeamPort: Send + Sync {
    /// `team.recoverAll(handles)`.
    fn recover_all<'a>(
        &'a self,
        handles: &'a [SessionHandle],
    ) -> BoxFuture<'a, PortResult<Recovered>>;
}

// ---------------------------------------------------------------------------------------------------
// heddle-agent. `runTurn` of `src/agent/loop.ts`.
// ---------------------------------------------------------------------------------------------------

/// `runTurn(ctx, …)` options.
#[derive(Debug, Clone)]
pub struct TurnRequest {
    /// The session the turn is recorded in.
    pub session: SessionHandle,
    /// The endpoint that answers.
    pub endpoint: String,
    /// `--turn`.
    pub prompt: String,
    /// `--system`.
    pub system: Option<String>,
    /// `--model`.
    pub model: Option<String>,
    /// `--max-rounds`; the loop's own default (8) when absent.
    pub max_rounds: Option<u32>,
    /// `--max-output-tokens`.
    pub max_output_tokens: Option<u32>,
}

/// A tool's refusal inside a turn.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolFailure {
    /// The error code (`UNKNOWN_TOOL`, `SANDBOX_DENIED`, …).
    pub code: String,
    /// The sentence.
    pub message: String,
}

/// One tool call a turn made.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolCallOutcome {
    /// The tool's name.
    pub name: String,
    /// The refusal, when the call did not succeed.
    pub error: Option<ToolFailure>,
}

/// A refused action, the sandbox's evidence.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Denial {
    /// The tool refused.
    pub tool: String,
    /// The refusal code; anything but `UNKNOWN_TOOL` makes the run exit 1.
    pub code: String,
    /// The sentence.
    pub message: String,
}

/// What a turn did: the fields of `TurnResult` the command prints.
#[derive(Debug, Clone, PartialEq)]
pub struct TurnOutcome {
    /// The answer's text.
    pub text: String,
    /// The finish reason.
    pub finish_reason: String,
    /// Rounds of model-plus-tools.
    pub rounds: u64,
    /// Every tool call, in order.
    pub tool_calls: Vec<ToolCallOutcome>,
    /// Every refusal, in order.
    pub denials: Vec<Denial>,
    /// The last context preparation (estimate, budget, pruned, compacted), when there was one.
    pub context: Option<Record>,
}

/// `runTurn`.
pub trait AgentPort: Send + Sync {
    /// Run one turn to completion.
    fn run_turn(&self, request: TurnRequest) -> BoxFuture<'_, PortResult<TurnOutcome>>;
}

// ---------------------------------------------------------------------------------------------------
// heddle-server. `startWebServer` of `src/server/web.ts`.
// ---------------------------------------------------------------------------------------------------

/// The port `web` serves on when `--port` is not given: `DEFAULT_PORT` of `src/server/web.ts`.
pub const DEFAULT_WEB_PORT: u16 = 3082;

/// `startWebServer(ctx, …)` options.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WebOptions {
    /// `--port`, else [`DEFAULT_WEB_PORT`]; `0` asks for an ephemeral port.
    pub port: u16,
    /// `--host`, else the server's loopback default.
    pub host: Option<String>,
    /// `--max-rounds` for turns posted to the server; uncapped when absent.
    pub max_rounds: Option<u32>,
    /// `--endpoint`, which becomes the server's default endpoint.
    pub default_endpoint: Option<String>,
}

/// Where a started server listens and the token it minted, as `web` prints them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WebServerInfo {
    /// The page URL, token included.
    pub url: String,
    /// The bound host.
    pub host: String,
    /// The bound port (the real one when `0` was asked for).
    pub port: u16,
    /// The launch token.
    pub token: String,
}

/// A running server.
pub trait WebServer: Send {
    /// Where it listens.
    fn info(&self) -> WebServerInfo;
    /// Stop it: stop accepting, end the live streams, and resolve once the socket is closed.
    fn close(self: Box<Self>) -> BoxFuture<'static, ()>;
}

/// `startWebServer`, composed by the boot over every booted service rather than loaded as a row.
pub trait ServerPort: Send + Sync {
    /// Bind and start serving.
    fn start(&self, options: WebOptions) -> BoxFuture<'_, PortResult<Box<dyn WebServer>>>;
}
