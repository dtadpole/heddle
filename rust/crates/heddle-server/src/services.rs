//! The seam to the harness: what the server calls instead of a Cordis context.
//!
//! The TypeScript routes reach into `ctx.session`, `ctx.workspace`, `ctx.model`, `ctx.sandbox`, `ctx.goal`,
//! `ctx.todo`, `ctx.team`, `ctx.get('approvals')` and `runTurn`. Each is a trait here, sized to what the
//! routes actually use, so this crate builds and is tested with doubles while the crates that own those
//! services are written. The binary (or an adapter module, once a service crate's API lands) implements
//! them over the real services.
//!
//! **Data the server only passes through is JSON** ([`serde_json::Value`]): a session event, a tree node, a
//! workspace record, a goal view. The server reads a handful of fields and forwards the rest unchanged,
//! which is what `{ ...entry, running }` did. Fields the routes *read* are typed.
//!
//! A service the boot did not load is `None` in [`Harness`], and its routes answer
//! `503 this profile does not load the <name> plugin`, as the TypeScript routes did.
//!
//! Implementors in other crates:
//!
//! | Trait | Implemented over | Owner |
//! |---|---|---|
//! | [`SessionService`] | the session store and its definitions | `heddle-session` |
//! | [`WorkspaceService`] | the workspace registry and the session tree | `heddle-workspace`, `heddle-session` |
//! | [`ModelService`] | the configured endpoints and their models' levels | `heddle-llm`, `heddle-config` |
//! | [`TurnRunner`] | the agentic loop | `heddle-agent` |
//! | [`SandboxService`] | the deployment's mode and the permission transition | `heddle-sandbox` |
//! | [`ApprovalService`] | the approval service | `heddle-sandbox` |
//! | [`GoalService`], [`TodoService`] | the goal and todo services | `heddle-goal`, `heddle-todo` |
//! | [`TeamService`] | the team service | `heddle-team` |
//! | [`AttachmentReader`], [`MarkdownRenderer`] | attachments and the markdown renderer | `heddle-web-files` |
//! | [`SessionStatsProjector`] | the ledger's session statistics | `heddle-web-trajectory` |

use std::path::{Path, PathBuf};
use std::sync::Arc;

use futures::future::BoxFuture;
use futures::stream::BoxStream;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tokio_util::sync::CancellationToken;

use crate::selection::SessionSelection;

/// A failure a service reports, with an optional stable code a route maps to a status.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct ServiceError {
    pub message: String,
    pub code: Option<String>,
}

impl ServiceError {
    pub fn new(message: impl Into<String>) -> Self {
        ServiceError {
            message: message.into(),
            code: None,
        }
    }

    pub fn with_code(message: impl Into<String>, code: impl Into<String>) -> Self {
        ServiceError {
            message: message.into(),
            code: Some(code.into()),
        }
    }
}

// ---------------------------------------------------------------------------------------------------------
// Sessions

/// A session's meta record as the store lists it.
///
/// The fields the routes read are typed; every other field (`created`, `updated`, `pinned`, `archived`,
/// `parentSession`, …) is kept in `rest` and serialized back unchanged, so a listing carries whatever the
/// store wrote.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionMeta {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub endpoint: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default)]
    pub turns: u64,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

impl SessionMeta {
    /// The selection this record carries.
    pub fn selection(&self) -> SessionSelection {
        crate::selection::session_request_selection(Some(self))
    }

    /// The agent preset the session runs under (inventory A96), read from `rest` so a listing keeps the store's key
    /// order; `None` until a turn records one.
    pub fn preset(&self) -> Option<&str> {
        self.rest.get("preset").and_then(Value::as_str)
    }
}

/// How `/api/turn` opens the session a turn runs in, when it names no folder.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct StartSession {
    /// Continue this session (`body.session`).
    pub resume: Option<String>,
    /// Start a fresh session here (the server's working directory).
    pub cwd: Option<PathBuf>,
    /// A name for a session this request creates. The turn route gives none (#68): a new session is born untitled,
    /// and its first message writes the fallback name the session layer's title coordinator replaces.
    pub title: Option<String>,
    /// What a session created by this request is born with.
    pub selection: SessionSelection,
    /// The agent preset a session created by this request runs under (inventory A96); a resumed one keeps its own.
    pub preset: Option<String>,
}

/// How a folder's session is opened (`openAt`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct OpenAt {
    /// Start another session for the folder instead of continuing its current one.
    pub fresh: bool,
    pub title: Option<String>,
    pub selection: SessionSelection,
    /// The agent preset a session this call creates runs under (inventory A96); the folder's existing one keeps its
    /// own.
    pub preset: Option<String>,
}

/// A session created at a branch with its definition written there.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CreatedSession {
    pub session: String,
    /// The definition's name.
    pub name: String,
    /// The definition file.
    pub definition: String,
    /// The log the definition points at.
    pub log: String,
}

/// What forking a session came to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ForkOutcome {
    NotFound,
    /// Refused — a session with no completed turn to cut at. Answered `409` with the code.
    Unavailable {
        code: String,
    },
    Forked(CreatedSession),
}

/// A change to a session's reading flags.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct FlagPatch {
    pub pinned: Option<bool>,
    pub archived: Option<bool>,
}

/// What writing a session's mode did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModeWrite {
    pub mode: String,
    pub changed: bool,
    /// The sequence number of the mode event, when one was written.
    pub seq: Option<u64>,
}

/// The session store, as the routes use it. Ids are strings the routes have already validated.
pub trait SessionService: Send + Sync {
    /// Every session's meta, in the store's order.
    fn list(&self) -> Vec<SessionMeta>;

    /// One session's meta.
    fn meta(&self, id: &str) -> Option<SessionMeta> {
        self.list().into_iter().find(|meta| meta.id == id)
    }

    /// Whether the store holds the session (`store.open(id) !== null`).
    fn exists(&self, id: &str) -> bool;

    /// The session's recorded events, in order; `None` when there is no such session.
    fn events(&self, id: &str) -> Option<Vec<Value>>;

    /// Open the session a turn runs in when it names no folder: resume one, or start a fresh one.
    fn start(&self, options: StartSession) -> Result<String, ServiceError>;

    /// The session a folder is bound to, created when it has none (or when `fresh`).
    fn open_at(&self, folder: &Path, options: OpenAt) -> Result<String, ServiceError>;

    /// Start a session at a branch and write its definition there, under `preset` when one is named (inventory A96).
    fn create_at(
        &self,
        branch: &Path,
        title: Option<&str>,
        preset: Option<&str>,
    ) -> Result<CreatedSession, ServiceError>;

    /// Fork a session at its last completed turn.
    fn fork(&self, id: &str) -> ForkOutcome;

    /// Pin, unpin, archive or unarchive. `Ok(None)` is an unknown session; `Err` is a refusal answered
    /// `409` with its code (`archived` when the store gave none).
    fn set_flags(&self, id: &str, patch: FlagPatch) -> Result<Option<SessionMeta>, ServiceError>;

    /// Retitle; the empty string clears the title. `None` is an unknown session.
    fn rename(&self, id: &str, title: &str) -> Option<SessionMeta>;

    /// The id of the session whose definition lives in `folder`, if any.
    fn definition_id(&self, folder: &Path) -> Option<String>;

    /// Rewrite the title in the definition that lives in `folder`.
    fn update_definition_title(&self, folder: &Path, title: &str) -> Result<(), ServiceError>;

    /// Record how the session is run, replacing the previous selection. `None` is an unknown session.
    fn set_model(&self, id: &str, selection: &SessionSelection) -> Option<SessionMeta>;

    /// The session's effective access mode: its own record over `fallback`, the deployment default.
    fn effective_mode(&self, id: &str, fallback: &str) -> String;

    /// Write the session's mode as one append-only event.
    fn set_mode(&self, id: &str, mode: &str, fallback: &str) -> Result<ModeWrite, ServiceError>;

    /// Append a user message with the given content parts — the delivery of a steer.
    fn user_content(&self, id: &str, content: Vec<Value>) -> Result<(), ServiceError>;

    /// The folder the session belongs to, if it has one.
    fn folder(&self, id: &str) -> Option<PathBuf>;

    /// Record the agent preset a session runs under, **only when it has none** (`recordPreset`, inventory A96), and
    /// answer the record as it now is; `None` for an unknown session. The default records nothing, for a store that
    /// keeps no presets.
    fn record_preset(&self, id: &str, preset: &str) -> Option<SessionMeta> {
        let _ = (id, preset);
        None
    }

    /// Content search (`GET /api/sessions/search`): the sessions whose user or assistant messages hold the query
    /// as a phrase, ranked, at most 20, with snippets (`heddle_session::SessionSearchIndex`). The route has already
    /// refused a query DSH refuses; `Err` is a failure it answers `500`. A store without search says so.
    fn search(&self, query: &str) -> Result<heddle_session::SessionSearchPage, ServiceError> {
        let _ = query;
        Err(ServiceError::new("session search is unavailable"))
    }
}

// ---------------------------------------------------------------------------------------------------------
// Workspaces

/// The `archived` filter of `/api/tree`: `only`, `show` (or the legacy `1`), else `hide`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ArchivedFilter {
    #[default]
    Hide,
    Show,
    Only,
}

impl ArchivedFilter {
    /// Read the query parameter: `only`, `show` (or the legacy `1`), else hide.
    pub fn from_query(value: Option<&str>) -> Self {
        match value {
            Some("only") => ArchivedFilter::Only,
            Some("show") | Some("1") => ArchivedFilter::Show,
            _ => ArchivedFilter::Hide,
        }
    }
}

/// DSH's refusal of a workspace the registry does not hold (dsh-api-workspace-controller lib/index.js:358-360):
/// code `workspace/not-found`, sentence `Workspace "<id>" not found`.
pub fn workspace_not_found(id: &str) -> ServiceError {
    ServiceError::with_code(
        format!("Workspace \"{id}\" not found"),
        "workspace/not-found",
    )
}

/// The workspace registry and the tree, as the routes use them. Paths are canonical when they arrive.
pub trait WorkspaceService: Send + Sync {
    /// Whether some registered root owns `path` (is it under a workspace root).
    fn owns(&self, path: &Path) -> bool;

    /// One level of the folder tree: the roots when `path` is `None`, else the children of `path`.
    fn tree(
        &self,
        path: Option<&Path>,
        archived: ArchivedFilter,
        sessions: &[SessionMeta],
    ) -> Result<Value, ServiceError>;

    /// Register a folder as a root. Answers the record and whether it was created (idempotent).
    fn add(&self, path: &Path, name: Option<&str>) -> Result<(Value, bool), ServiceError>;

    /// Whether a root with this id exists.
    fn find(&self, id: &str) -> bool;

    /// Unregister a root — the registration only; its folder and sessions stay, and the sessions move to
    /// the nearest root above it or to Ungrouped (DSH's Delete workspace). An `Err` is answered `409`.
    fn remove(&self, id: &str, sessions: &[SessionMeta]) -> Result<Value, ServiceError>;

    /// Retitle a root. `Ok(None)` is an unknown id; `Err` with code `workspace/name-conflict` (another
    /// workspace carries the title) is answered `409`, any other `Err` (an empty title) `400`.
    fn rename(&self, id: &str, title: &str) -> Result<Option<Value>, ServiceError>;

    /// Make sure the folder a turn ran in has an owner, adopting it when none does.
    fn ensure_owner(&self, folder: &Path);

    /// Every workspace with its parent and its sessions — `GET /api/workspaces`, `{workspaces: [...]}`'s
    /// array (`WorkspaceService.views` in `src/workspace/service.ts`). The default answers no workspace,
    /// for doubles that do not model the registry.
    fn views(&self, sessions: &[SessionMeta]) -> Result<Value, ServiceError> {
        let _ = sessions;
        Ok(Value::Array(Vec::new()))
    }

    /// Move a workspace in the stored order, before `before` or last without it (ids or paths) — DSH's
    /// `workspace/insertBefore`, `POST /api/workspaces/insertBefore` (`WorkspaceService.insertBefore` in
    /// `src/workspace/service.ts`). Answers the complete order; `Err` with code `workspace/not-found` and
    /// DSH's sentence, `Workspace "<id>" not found` (the workspace or the anchor is not in the order), is
    /// answered `404`. The default knows no workspace, for doubles that do not model the registry.
    fn insert_before(&self, id: &str, before: Option<&str>) -> Result<Vec<String>, ServiceError> {
        let _ = before;
        Err(workspace_not_found(id))
    }
}

// ---------------------------------------------------------------------------------------------------------
// Models

/// The configured endpoints, as far as the server's selection rules need them.
pub trait ModelService: Send + Sync {
    /// The configured endpoint names.
    fn names(&self) -> Vec<String>;

    /// The configuration's nominated default endpoint.
    fn default_endpoint(&self) -> Option<String>;

    /// Whether `effort` is a reasoning level the endpoint's `model` (or its configured model when `None`)
    /// declares — `reasoningLevelFor(...) !== undefined`.
    fn declares_level(&self, endpoint: &str, model: Option<&str>, effort: &str) -> bool;

    fn has(&self, endpoint: &str) -> bool {
        self.names().iter().any(|name| name == endpoint)
    }
}

// ---------------------------------------------------------------------------------------------------------
// Turns

/// One interactive turn, as `/api/turn` asks for it.
#[derive(Debug, Clone)]
pub struct TurnRequest {
    pub session: String,
    pub endpoint: String,
    pub prompt: String,
    /// Content parts the attachment reader produced, recorded with the user message.
    pub attachments: Vec<Value>,
    /// Cancelled by a stop; the runner ends the provider request rather than waiting it out.
    pub cancel: CancellationToken,
    /// Rounds the turn may take; `None` is unbounded, the interactive default.
    pub max_rounds: Option<u32>,
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
}

/// What a finished turn reports on its `done` frame.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnOutcome {
    pub text: String,
    pub finish_reason: String,
    pub rounds: u64,
    /// The refusals, `{tool, code, message}` each.
    pub denials: Vec<Value>,
    /// Why the turn stopped early, when it did.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ended: Option<Vec<String>>,
    /// What the provider said the turn cost.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<Value>,
}

/// The agentic loop. The turn's session events reach readers through the event bus and the
/// [`crate::stream::EventHub`] it is bridged into, not through this call.
pub trait TurnRunner: Send + Sync {
    fn run_turn(
        &self,
        request: TurnRequest,
    ) -> BoxFuture<'static, Result<TurnOutcome, ServiceError>>;
}

// ---------------------------------------------------------------------------------------------------------
// Sandbox and approvals

/// The deployment's access mode and the rule for changing a session's.
pub trait SandboxService: Send + Sync {
    /// The deployment default mode (`read-only`, `workspace-write` or `danger-full-access`).
    fn default_mode(&self) -> String;

    /// The sandbox's workspace root, reported by `/api/status` as `cwd`.
    fn workspace_root(&self) -> String;

    /// `permissionTransition(current, requested, confirm)`: the mode to write, or the refusal reason
    /// (an unknown mode, or an escalation to full access without `confirm: "full-access"`).
    ///
    /// `requested` and `confirm` are the body's fields as they arrived: `None` when absent, so an
    /// absent mode is refused as `'undefined' is not one of …`, the sentence JavaScript's `String()`
    /// writes and `heddle_sandbox::permission_transition` reproduces.
    fn transition(
        &self,
        current: &str,
        requested: Option<&Value>,
        confirm: Option<&Value>,
    ) -> Result<String, String>;
}

/// How a person answered an approval question.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ApprovalOutcome {
    AllowedOnce,
    Rejected,
    Cancelled,
}

/// The approval service. While the server runs it is attached as the answerer, which turns an `ask`
/// policy from "nobody can answer, so deny" into a card a person can answer.
pub trait ApprovalService: Send + Sync {
    /// Attach the Web UI as the answerer; the returned function detaches it.
    fn attach_answerer(&self) -> Box<dyn FnOnce() + Send>;

    /// The questions waiting for a person.
    fn pending_requests(&self) -> Vec<Value>;

    /// Settle one question exactly once; `false` when it is no longer waiting.
    fn answer(&self, id: &str, outcome: ApprovalOutcome) -> bool;

    /// Every question published from now on, as its JSON (`{id, tool, reason, displayReason, session?,
    /// at}`). While the server runs it relays each one to `/api/events` as an `approval` frame, which is
    /// how a card appears without a reload.
    ///
    /// `heddle-sandbox` publishes questions on a broadcast channel (`ApprovalService::subscribe`), so
    /// its adapter returns that receiver as a stream here. `None`, the default, means the questions
    /// reach the server some other way — the binary forwards the bus's `approval/request` with
    /// [`crate::stream::approval_request_forwarder`] — and the server relays nothing itself.
    fn subscribe(&self) -> Option<BoxStream<'static, Value>> {
        None
    }
}

// ---------------------------------------------------------------------------------------------------------
// Goals, todos, teams

/// Which goal a verb acts on, and the revision the caller saw.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct GoalRef {
    pub id: String,
    pub revision: u64,
}

/// The person's side of the goal verbs, from `POST /api/goal`.
#[derive(Debug, Clone, PartialEq)]
pub enum GoalAction {
    Create {
        objective: String,
        max_goal_rounds: Option<u64>,
    },
    Edit {
        goal: GoalRef,
        objective: Option<String>,
        max_goal_rounds: Option<u64>,
    },
    Pause(GoalRef),
    /// Only a person may resume; the model's tool refuses.
    Resume(GoalRef),
    Complete(GoalRef),
    Blocked {
        goal: GoalRef,
        reason: Value,
    },
    Clear(GoalRef),
}

/// What a goal verb answered: `{goal: view}`, or `{cleared}` for a clear.
#[derive(Debug, Clone, PartialEq)]
pub enum GoalAnswer {
    Goal(Value),
    Cleared(Value),
}

/// The goal service. Errors carry its stable code: `GOAL_NOT_FOUND` is a `404`, `GOAL_STALE_REVISION` a
/// `409`, anything else a `400`.
pub trait GoalService: Send + Sync {
    fn get(&self, session: &str) -> Option<Value>;
    fn act(&self, session: &str, action: GoalAction) -> Result<GoalAnswer, ServiceError>;
}

/// The todo service: the session's list as its current fold, `None` when never written.
pub trait TodoService: Send + Sync {
    fn get(&self, session: &str) -> Option<Value>;
}

/// The turns a session runs besides the server's own, which a Stop must reach as well (#93): a goal round, a
/// reminder's turn and a background job's notice turn are started by their rows through the agent runtime, which
/// registers each with its live-turn registry. The binary supplies it from that registry.
pub trait TurnInterrupter: Send + Sync {
    /// Stop every turn in flight for `session`; whether there was one to stop.
    fn interrupt(&self, session: &str) -> bool;
}

/// One Lead session's team as the view shows it — the same state the tools see.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct TeamView {
    pub lead: Value,
    pub members: Value,
    pub tasks: Value,
    pub messages: Value,
    pub delivered: Value,
}

pub trait TeamService: Send + Sync {
    /// The session's team as one fold. `Err` when the team log refuses to fold (a member active without
    /// provisioning, a skipped task revision, a foreign team id, …); the route answers it as the
    /// TypeScript server's catch-all does, `500 internal error: <message>`, rather than hiding a broken
    /// team behind an empty panel.
    fn view(&self, session: &str) -> Result<TeamView, ServiceError>;
}

// ---------------------------------------------------------------------------------------------------------
// Pieces other ui-lane crates provide

/// `readAttachments`: the composer's attachment references (paths into the upload directory) read into
/// typed content parts; `Err` carries the sentence a `400` answers with.
pub trait AttachmentReader: Send + Sync {
    fn read(&self, raw: Option<&Value>) -> Result<Vec<Value>, String>;
}

/// `renderMarkdown`: an answer's text as an allow-listed document.
pub trait MarkdownRenderer: Send + Sync {
    fn render(&self, text: &str) -> String;
}

/// The composer's bottom statistics for one session, projected from its events (with the context
/// breakdown fallback), as the `stats` field of `GET /api/sessions/<id>`.
pub trait SessionStatsProjector: Send + Sync {
    fn stats(&self, session: &str, events: &[Value]) -> Value;
}

// ---------------------------------------------------------------------------------------------------------
// The harness

/// Every service the server calls. The four required ones are always present; the rest are `None` when the
/// boot did not load them.
#[derive(Clone)]
pub struct Harness {
    pub sessions: Arc<dyn SessionService>,
    pub models: Arc<dyn ModelService>,
    pub turns: Arc<dyn TurnRunner>,
    pub sandbox: Arc<dyn SandboxService>,
    pub workspaces: Option<Arc<dyn WorkspaceService>>,
    pub approvals: Option<Arc<dyn ApprovalService>>,
    pub goals: Option<Arc<dyn GoalService>>,
    pub todos: Option<Arc<dyn TodoService>>,
    pub team: Option<Arc<dyn TeamService>>,
    pub attachments: Option<Arc<dyn AttachmentReader>>,
    pub markdown: Option<Arc<dyn MarkdownRenderer>>,
    pub stats: Option<Arc<dyn SessionStatsProjector>>,
    /// The agent presets (inventory A96), from the optional `presets` row: `GET /api/presets` answers them, and a
    /// session a request creates runs under the one it names or the default. `None` — a profile without the row —
    /// answers the implicit roster (`heddle_config::preset_roster(None)`) and creates sessions with no preset.
    pub presets: Option<Arc<heddle_config::PresetRoster>>,
    /// The live-turn registry a Stop also asks; `None`: the server's own runs are the only turns it stops.
    pub interrupter: Option<Arc<dyn TurnInterrupter>>,
    /// The server process's working directory: where a turn with no folder starts its session, and where
    /// `POST /api/sessions` creates one when no branch is named.
    pub cwd: PathBuf,
}

impl Harness {
    /// A harness with the four required services and nothing optional.
    pub fn new(
        sessions: Arc<dyn SessionService>,
        models: Arc<dyn ModelService>,
        turns: Arc<dyn TurnRunner>,
        sandbox: Arc<dyn SandboxService>,
        cwd: PathBuf,
    ) -> Self {
        Harness {
            sessions,
            models,
            turns,
            sandbox,
            workspaces: None,
            approvals: None,
            goals: None,
            todos: None,
            team: None,
            attachments: None,
            markdown: None,
            stats: None,
            presets: None,
            interrupter: None,
            cwd,
        }
    }

    /// Start a [`HarnessBuilder`] with the four required services. The optional services are attached
    /// with its methods, so a binary's composition reads as the profile it booted.
    pub fn builder(
        sessions: Arc<dyn SessionService>,
        models: Arc<dyn ModelService>,
        turns: Arc<dyn TurnRunner>,
        sandbox: Arc<dyn SandboxService>,
        cwd: PathBuf,
    ) -> HarnessBuilder {
        HarnessBuilder {
            harness: Harness::new(sessions, models, turns, sandbox, cwd),
        }
    }
}

impl Harness {
    /// A harness whose plugins have **not loaded yet**: the door answers, and every route that needs a
    /// service answers that service's own refusal.
    ///
    /// This is what lets `heddle web` bind and print its URL while the session, model, turn and sandbox
    /// adapters are still landing, so `/healthz` and the token handshake have something honest to talk
    /// to. It is not a fake: the lists are empty, a start or a turn is an error naming the missing
    /// service, and no route invents a session or an answer. A boot with the real services uses
    /// [`Harness::new`] or [`Harness::builder`] instead.
    pub fn unavailable(cwd: PathBuf) -> Self {
        Harness {
            sessions: Arc::new(UnavailableSessions),
            models: Arc::new(UnavailableModels),
            turns: Arc::new(UnavailableTurns),
            sandbox: Arc::new(UnavailableSandbox {
                root: cwd.display().to_string(),
            }),
            workspaces: None,
            approvals: None,
            goals: None,
            todos: None,
            team: None,
            attachments: None,
            markdown: None,
            stats: None,
            presets: None,
            interrupter: None,
            cwd,
        }
    }
}

/// The sentence every unavailable service answers with.
const NOT_LOADED: &str = "this service is not loaded yet";

struct UnavailableSessions;

impl SessionService for UnavailableSessions {
    fn list(&self) -> Vec<SessionMeta> {
        Vec::new()
    }
    fn exists(&self, _id: &str) -> bool {
        false
    }
    fn events(&self, _id: &str) -> Option<Vec<Value>> {
        None
    }
    fn start(&self, _options: StartSession) -> Result<String, ServiceError> {
        Err(ServiceError::new(NOT_LOADED))
    }
    fn open_at(&self, _folder: &Path, _options: OpenAt) -> Result<String, ServiceError> {
        Err(ServiceError::new(NOT_LOADED))
    }
    fn create_at(
        &self,
        _branch: &Path,
        _title: Option<&str>,
        _preset: Option<&str>,
    ) -> Result<CreatedSession, ServiceError> {
        Err(ServiceError::new(NOT_LOADED))
    }
    fn fork(&self, _id: &str) -> ForkOutcome {
        ForkOutcome::NotFound
    }
    fn set_flags(&self, _id: &str, _patch: FlagPatch) -> Result<Option<SessionMeta>, ServiceError> {
        Err(ServiceError::new(NOT_LOADED))
    }
    fn rename(&self, _id: &str, _title: &str) -> Option<SessionMeta> {
        None
    }
    fn definition_id(&self, _folder: &Path) -> Option<String> {
        None
    }
    fn update_definition_title(&self, _folder: &Path, _title: &str) -> Result<(), ServiceError> {
        Err(ServiceError::new(NOT_LOADED))
    }
    fn set_model(&self, _id: &str, _selection: &SessionSelection) -> Option<SessionMeta> {
        None
    }
    fn effective_mode(&self, _id: &str, fallback: &str) -> String {
        fallback.to_owned()
    }
    fn set_mode(&self, _id: &str, _mode: &str, _fallback: &str) -> Result<ModeWrite, ServiceError> {
        Err(ServiceError::new(NOT_LOADED))
    }
    fn user_content(&self, _id: &str, _content: Vec<Value>) -> Result<(), ServiceError> {
        Err(ServiceError::new(NOT_LOADED))
    }
    fn folder(&self, _id: &str) -> Option<PathBuf> {
        None
    }
}

struct UnavailableModels;

impl ModelService for UnavailableModels {
    fn names(&self) -> Vec<String> {
        Vec::new()
    }
    fn default_endpoint(&self) -> Option<String> {
        None
    }
    fn declares_level(&self, _endpoint: &str, _model: Option<&str>, _effort: &str) -> bool {
        false
    }
}

struct UnavailableTurns;

impl TurnRunner for UnavailableTurns {
    fn run_turn(
        &self,
        _request: TurnRequest,
    ) -> BoxFuture<'static, Result<TurnOutcome, ServiceError>> {
        Box::pin(async { Err(ServiceError::new(NOT_LOADED)) })
    }
}

struct UnavailableSandbox {
    root: String,
}

impl SandboxService for UnavailableSandbox {
    fn default_mode(&self) -> String {
        "read-only".to_owned()
    }
    fn workspace_root(&self) -> String {
        self.root.clone()
    }
    fn transition(
        &self,
        _current: &str,
        _requested: Option<&Value>,
        _confirm: Option<&Value>,
    ) -> Result<String, String> {
        Err(NOT_LOADED.to_owned())
    }
}

/// Assembles a [`Harness`] service by service.
///
/// The binary knows which plugins a profile loaded; this type is where it says so, once, in the order
/// the routes read them. A service left unattached is `None`, and its routes answer
/// [`crate::respond::plugin_missing`], which is the TypeScript boot's behaviour for a profile that did
/// not load that plugin.
pub struct HarnessBuilder {
    harness: Harness,
}

impl HarnessBuilder {
    /// A builder whose four required services are already attached.
    pub fn new(
        sessions: Arc<dyn SessionService>,
        models: Arc<dyn ModelService>,
        turns: Arc<dyn TurnRunner>,
        sandbox: Arc<dyn SandboxService>,
        cwd: PathBuf,
    ) -> Self {
        HarnessBuilder {
            harness: Harness::new(sessions, models, turns, sandbox, cwd),
        }
    }

    pub fn sessions(mut self, service: Arc<dyn SessionService>) -> Self {
        self.harness.sessions = service;
        self
    }

    pub fn models(mut self, service: Arc<dyn ModelService>) -> Self {
        self.harness.models = service;
        self
    }

    pub fn turns(mut self, service: Arc<dyn TurnRunner>) -> Self {
        self.harness.turns = service;
        self
    }

    pub fn sandbox(mut self, service: Arc<dyn SandboxService>) -> Self {
        self.harness.sandbox = service;
        self
    }

    pub fn workspaces(mut self, service: Arc<dyn WorkspaceService>) -> Self {
        self.harness.workspaces = Some(service);
        self
    }

    pub fn approvals(mut self, service: Arc<dyn ApprovalService>) -> Self {
        self.harness.approvals = Some(service);
        self
    }

    pub fn goals(mut self, service: Arc<dyn GoalService>) -> Self {
        self.harness.goals = Some(service);
        self
    }

    pub fn todos(mut self, service: Arc<dyn TodoService>) -> Self {
        self.harness.todos = Some(service);
        self
    }

    pub fn team(mut self, service: Arc<dyn TeamService>) -> Self {
        self.harness.team = Some(service);
        self
    }

    pub fn attachments(mut self, service: Arc<dyn AttachmentReader>) -> Self {
        self.harness.attachments = Some(service);
        self
    }

    pub fn markdown(mut self, service: Arc<dyn MarkdownRenderer>) -> Self {
        self.harness.markdown = Some(service);
        self
    }

    pub fn stats(mut self, service: Arc<dyn SessionStatsProjector>) -> Self {
        self.harness.stats = Some(service);
        self
    }

    /// The profile's agent presets (inventory A96).
    pub fn presets(mut self, roster: Arc<heddle_config::PresetRoster>) -> Self {
        self.harness.presets = Some(roster);
        self
    }

    pub fn interrupter(mut self, service: Arc<dyn TurnInterrupter>) -> Self {
        self.harness.interrupter = Some(service);
        self
    }

    /// The working directory a turn with no folder starts in.
    pub fn cwd(mut self, cwd: PathBuf) -> Self {
        self.harness.cwd = cwd;
        self
    }

    pub fn build(self) -> Harness {
        self.harness
    }
}

// ---------------------------------------------------------------------------------------------------------
// Closure adapters
//
// A binary that already has a function for one optional service should not have to declare a type for
// it. These adapters are also what this crate's own tests and a deployment use to attach behaviour
// without depending on another crate's internals.

/// An [`AttachmentReader`] over a function.
pub struct FnAttachmentReader<F>(pub F);

impl<F> AttachmentReader for FnAttachmentReader<F>
where
    F: Fn(Option<&Value>) -> Result<Vec<Value>, String> + Send + Sync,
{
    fn read(&self, raw: Option<&Value>) -> Result<Vec<Value>, String> {
        (self.0)(raw)
    }
}

/// Wrap a function as an [`AttachmentReader`].
pub fn attachment_reader<F>(read: F) -> Arc<dyn AttachmentReader>
where
    F: Fn(Option<&Value>) -> Result<Vec<Value>, String> + Send + Sync + 'static,
{
    Arc::new(FnAttachmentReader(read))
}

/// A [`MarkdownRenderer`] over a function.
pub struct FnMarkdownRenderer<F>(pub F);

impl<F> MarkdownRenderer for FnMarkdownRenderer<F>
where
    F: Fn(&str) -> String + Send + Sync,
{
    fn render(&self, text: &str) -> String {
        (self.0)(text)
    }
}

/// Wrap a function as a [`MarkdownRenderer`].
pub fn markdown_renderer<F>(render: F) -> Arc<dyn MarkdownRenderer>
where
    F: Fn(&str) -> String + Send + Sync + 'static,
{
    Arc::new(FnMarkdownRenderer(render))
}

/// A [`SessionStatsProjector`] over a function.
pub struct FnSessionStatsProjector<F>(pub F);

impl<F> SessionStatsProjector for FnSessionStatsProjector<F>
where
    F: Fn(&str, &[Value]) -> Value + Send + Sync,
{
    fn stats(&self, session: &str, events: &[Value]) -> Value {
        (self.0)(session, events)
    }
}

/// Wrap a function as a [`SessionStatsProjector`].
pub fn stats_projector<F>(project: F) -> Arc<dyn SessionStatsProjector>
where
    F: Fn(&str, &[Value]) -> Value + Send + Sync + 'static,
{
    Arc::new(FnSessionStatsProjector(project))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_function_becomes_an_attachment_reader() {
        let reader = attachment_reader(|raw| match raw {
            Some(value) => Ok(vec![json!({"type": "file", "path": value})]),
            None => Ok(Vec::new()),
        });
        assert!(reader.read(None).unwrap().is_empty());
        let parts = reader.read(Some(&json!("/u/a.txt"))).unwrap();
        assert_eq!(parts, vec![json!({"type": "file", "path": "/u/a.txt"})]);
    }

    #[test]
    fn a_function_becomes_a_markdown_renderer_and_a_stats_projector() {
        let renderer = markdown_renderer(|text| format!("<p>{text}</p>"));
        assert_eq!(renderer.render("hi"), "<p>hi</p>");

        let projector =
            stats_projector(|session, events| json!({"session": session, "events": events.len()}));
        assert_eq!(
            projector.stats("session-1", &[json!({"type": "message"})]),
            json!({"session": "session-1", "events": 1})
        );
    }

    #[test]
    fn an_unavailable_harness_answers_the_door_and_refuses_the_services() {
        let harness = Harness::unavailable(PathBuf::from("/work"));
        assert!(harness.sessions.list().is_empty());
        assert!(!harness.sessions.exists("session-1"));
        assert!(harness.models.names().is_empty());
        assert_eq!(harness.sandbox.default_mode(), "read-only");
        assert_eq!(harness.sandbox.workspace_root(), "/work");
        assert_eq!(
            harness.sessions.start(StartSession::default()),
            Err(ServiceError::new("this service is not loaded yet"))
        );
        assert_eq!(
            harness
                .sandbox
                .transition("read-only", Some(&json!("full")), None),
            Err("this service is not loaded yet".to_owned())
        );
    }

    #[test]
    fn service_error_keeps_its_code() {
        assert_eq!(
            ServiceError::new("nope"),
            ServiceError {
                message: "nope".into(),
                code: None
            }
        );
        assert_eq!(
            ServiceError::with_code("nope", "GOAL_NOT_FOUND"),
            ServiceError {
                message: "nope".into(),
                code: Some("GOAL_NOT_FOUND".into())
            }
        );
    }
}
