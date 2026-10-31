//! The turn's ports over the real crates, where they have landed.
//!
//! [`LlmModel`] is the [`ModelPort`] over `heddle-llm`'s [`ModelService`]. It converts nothing but the error:
//! the request, the chunks and the usage are the model service's own types (see [`crate::upstream`]). The
//! service already runs the `model/request` and `model/stream` hooks, drops reasoning-only assistant turns at
//! the provider boundary and projects attachments, so the loop hands it the recorded messages as they are.
//!
//! [`Sessions`] is the [`SessionPort`] and [`SessionSubagents`] the [`SubagentStore`] over `heddle-session`'s
//! [`SessionService`]; [`Context`] is the [`ContextPort`] over `heddle-context`'s [`ContextService`], generic
//! over its store as that crate is. The hook adapter lands when the binary attaches the event bus; until then
//! [`NoTurnHooks`](crate::NoTurnHooks) is the composition without listeners.
//!
//! The context port speaks the context crate's own records (its report, summary and sections), so nothing is
//! converted there. The session crate keeps its own record types and that adapter converts only at the seam, and
//! the records it writes keep the TypeScript field order (the session crate's `ModelRequestRecord` is built in
//! the loop's order, so `model/request` reads the same from either binary).

use std::path::PathBuf;
use std::sync::Arc;

use futures::StreamExt;
use futures::future::BoxFuture;
use futures::stream::BoxStream;
use tokio_util::sync::CancellationToken;

use heddle_context::{ContextService, ContextStore};
use heddle_llm::ModelService;
use heddle_session::{
    AppendOptions, CreateOptions, ModelRequestBreakdown, NewEvent, SessionOrigin, SessionService,
};

use crate::ports::{
    ContextPort, ModelError, ModelPort, ModelRequestRecord, PortError, RequestErrorAction,
    RequestErrorPayload, SessionPort, TurnHooks,
};
use crate::subagent::SubagentStore;
use crate::upstream::{
    Chunk, ContentPart, ContextReport, CreateSession, GenerateRequest, Message, PrepareOptions,
    Role, RuntimeContextSection, SandboxMode, SessionEvent, SessionHandle, SessionMeta,
    SurfaceView,
};

/// The [`ModelPort`] over a [`ModelService`].
///
/// A Stop drops the provider stream (`take_until` on the call's token), which drops the request with it — the
/// Rust form of the TypeScript `AbortSignal` passed to `fetch`. A request to an endpoint the service does not
/// know fails as one error item (`NO_ENDPOINT`) before any connection is made.
pub struct LlmModel {
    service: Arc<ModelService>,
}

impl LlmModel {
    /// Wrap the deployment's model service.
    pub fn new(service: Arc<ModelService>) -> Self {
        Self { service }
    }

    /// The service this port asks.
    pub fn service(&self) -> &Arc<ModelService> {
        &self.service
    }
}

impl LlmModel {
    /// A service stream as the port's stream: errors converted, and cut at the caller's Stop.
    fn port_stream(
        opened: Result<heddle_llm::ChunkStream, heddle_llm::ModelError>,
        cancel: Option<CancellationToken>,
    ) -> BoxStream<'static, Result<Chunk, ModelError>> {
        match opened {
            Err(error) => Box::pin(futures::stream::once(async move {
                Err(ModelError::from(error))
            })),
            Ok(stream) => {
                let stream = stream.map(|item| item.map_err(ModelError::from));
                match cancel {
                    Some(cancel) => Box::pin(stream.take_until(cancel.cancelled_owned())),
                    None => Box::pin(stream),
                }
            }
        }
    }
}

impl ModelPort for LlmModel {
    fn stream(
        &self,
        request: GenerateRequest,
        cancel: Option<CancellationToken>,
    ) -> BoxStream<'static, Result<Chunk, ModelError>> {
        Self::port_stream(self.service.stream(request), cancel)
    }

    fn resolve(&self, request: GenerateRequest) -> Result<GenerateRequest, ModelError> {
        self.service.resolve(&request).map_err(ModelError::from)
    }

    fn stream_resolved(
        &self,
        request: GenerateRequest,
        cancel: Option<CancellationToken>,
    ) -> BoxStream<'static, Result<Chunk, ModelError>> {
        Self::port_stream(self.service.stream_resolved(request), cancel)
    }

    fn default_endpoint(&self) -> Option<String> {
        self.service.default_endpoint(None)
    }
}

fn port_error(error: impl std::fmt::Display) -> PortError {
    PortError(error.to_string())
}

/// The [`SessionPort`] over a [`SessionService`]: the turn's reads and writes, each on disk before the next
/// step starts.
///
/// The three reads the port declares infallible (`count`, `surface`, `node_role`) log a store failure and
/// answer empty, so a broken read cannot invent input; every write fails the turn as [`PortError`].
pub struct Sessions {
    service: Arc<SessionService>,
}

impl Sessions {
    /// Wrap the deployment's session service.
    pub fn new(service: Arc<SessionService>) -> Self {
        Self { service }
    }

    /// The service this port asks.
    pub fn service(&self) -> &Arc<SessionService> {
        &self.service
    }
}

fn read_failed(session: &SessionHandle, what: &str, error: impl std::fmt::Display) {
    tracing::warn!(target: "heddle_agent", session = session.id.as_str(), "{what} failed: {error}");
}

impl SessionPort for Sessions {
    fn count(&self, session: &SessionHandle) -> usize {
        match self.service.store().count(session) {
            Ok(count) => usize::try_from(count).unwrap_or(usize::MAX),
            Err(error) => {
                read_failed(session, "counting the log", error);
                0
            }
        }
    }

    fn user_content(
        &self,
        session: &SessionHandle,
        content: Vec<ContentPart>,
        source: Option<serde_json::Value>,
    ) -> Result<(), PortError> {
        self.service
            .user_content(session, content, source)
            .map_err(port_error)
    }

    fn surface(&self, session: &SessionHandle) -> SurfaceView {
        match self.service.surface(session) {
            Ok(surface) => SurfaceView {
                nodes: surface.nodes.clone(),
                content_generation: surface.content_generation,
                replace_generation: surface.replace_generation,
            },
            Err(error) => {
                read_failed(session, "reading the surface", error);
                SurfaceView::default()
            }
        }
    }

    fn node_role(&self, session: &SessionHandle, seq: u64) -> Option<Role> {
        match self.service.node(session, seq) {
            Ok(message) => message.map(|message| message.role),
            Err(error) => {
                read_failed(session, "reading a surface node", error);
                None
            }
        }
    }

    fn folder(&self, session: &SessionHandle) -> Option<PathBuf> {
        self.service.folder(session).map(PathBuf::from)
    }

    fn model_request(
        &self,
        session: &SessionHandle,
        record: &ModelRequestRecord,
    ) -> Result<(), PortError> {
        let record = heddle_session::ModelRequestRecord {
            endpoint: record.endpoint.clone(),
            model: record.model.clone(),
            reasoning_effort: record.reasoning_effort.clone(),
            messages: record.messages as u64,
            tools: record.tools.clone(),
            estimated_tokens: Some(record.estimated_tokens),
            threshold_tokens: Some(record.threshold_tokens),
            pruned: Some(record.pruned),
            compacted: Some(record.compacted),
            breakdown: Some(ModelRequestBreakdown {
                system: Some(record.breakdown.system),
                tools: Some(record.breakdown.tools),
                messages: Some(record.breakdown.messages),
            }),
            generation: Some(record.generation),
        };
        self.service
            .store()
            .model_request(session, &record)
            .map(drop)
            .map_err(port_error)
    }

    fn assistant_chunk(&self, session: &SessionHandle, chunk: &Chunk) -> Result<(), PortError> {
        self.service
            .store()
            .assistant_chunk(session, chunk)
            .map(drop)
            .map_err(port_error)
    }

    fn message(&self, session: &SessionHandle, message: Message) -> Result<(), PortError> {
        self.service
            .store()
            .message(session, message)
            .map(drop)
            .map_err(port_error)
    }

    fn append(
        &self,
        session: &SessionHandle,
        kind: &str,
        fields: serde_json::Map<String, serde_json::Value>,
    ) -> Result<(), PortError> {
        self.service
            .store()
            .append(
                session,
                NewEvent {
                    kind: kind.to_owned(),
                    fields,
                },
                AppendOptions::default(),
            )
            .map(drop)
            .map_err(port_error)
    }

    fn claim_pending_input(&self, session: &SessionHandle) -> Result<usize, PortError> {
        heddle_session::inbox::claim_next_step(self.service.store(), session, |content, source| {
            self.service.user_content(session, content, source)
        })
        .map(|claimed| claimed.len())
        .map_err(port_error)
    }

    fn has_pending_input(&self, session: &SessionHandle) -> bool {
        match heddle_session::inbox::has_pending_step(self.service.store(), session) {
            Ok(pending) => pending,
            Err(error) => {
                read_failed(session, "reading the inbox", error);
                false
            }
        }
    }
}

/// The [`SubagentStore`] over a [`SessionService`]: a child is a session of its own, created with its parent,
/// origin and depth in its record, and given the parent's recorded mode.
pub struct SessionSubagents {
    service: Arc<SessionService>,
}

impl SessionSubagents {
    /// Wrap the deployment's session service.
    pub fn new(service: Arc<SessionService>) -> Self {
        Self { service }
    }
}

impl SubagentStore for SessionSubagents {
    fn meta(&self, id: &str) -> Option<SessionMeta> {
        // The record is read as the TypeScript fields; anything this crate does not read stays in `rest`.
        let meta = self.service.meta(id)?;
        serde_json::from_value(meta.to_value()).ok()
    }

    fn create(&self, options: CreateSession) -> Result<SessionHandle, PortError> {
        let origin = match options.origin.as_deref() {
            None => None,
            Some("subagent") => Some(SessionOrigin::Subagent),
            Some(other) => {
                return Err(PortError(format!(
                    "a session cannot be created with origin '{other}'"
                )));
            }
        };
        let options = CreateOptions {
            cwd: options.cwd.map(|cwd| cwd.to_string_lossy().into_owned()),
            endpoint: options.endpoint,
            model: options.model,
            reasoning_effort: options.reasoning_effort,
            title: options.title,
            parent_session: options.parent_session,
            origin,
            delegation_depth: options.delegation_depth.map(u64::from),
            team_id: options.team_id,
            id: options.id,
        };
        self.service.store().create(options).map_err(port_error)
    }

    fn read(&self, session: &SessionHandle) -> Vec<SessionEvent> {
        match self.service.events(session) {
            Ok(events) => events
                .iter()
                .map(|event| SessionEvent::clone(event))
                .collect(),
            Err(error) => {
                read_failed(session, "reading the child's log", error);
                Vec::new()
            }
        }
    }

    fn inherit_recorded_mode(
        &self,
        parent: &SessionHandle,
        child: &SessionHandle,
    ) -> Result<Option<SandboxMode>, PortError> {
        heddle_session::inherit_recorded_mode::<SandboxMode>(self.service.store(), parent, child)
            .map_err(port_error)
    }

    fn user_message(
        &self,
        session: &SessionHandle,
        content: Vec<ContentPart>,
        source: Option<serde_json::Value>,
    ) -> Result<u64, PortError> {
        let event = self
            .service
            .store()
            .message(
                session,
                Message {
                    role: Role::User,
                    tool_call_id: None,
                    content,
                    source,
                },
            )
            .map_err(port_error)?;
        Ok(event.seq)
    }
}

/// How the context service names a session, given the loop's handle.
pub type HandleMap<H> = Arc<dyn Fn(&SessionHandle) -> H + Send + Sync>;

/// The [`ContextPort`] over a [`ContextService`], generic over its store as that crate is.
///
/// The session store's binding names the same handle, so production passes [`Context::over_session_handles`];
/// a test over the context crate's in-memory store maps the id. Every call the loop makes is a policy call of
/// the service (`record_runtime_context`, `prepare`, `assemble`); the overflow recovery is not here — it is
/// the `agent/request-error` listener's, as in the TypeScript build.
pub struct Context<S: ContextStore> {
    service: Arc<ContextService<S>>,
    handle: HandleMap<S::Handle>,
}

impl<S: ContextStore> Context<S> {
    /// A port over `service`, naming each session through `handle`.
    pub fn new(service: Arc<ContextService<S>>, handle: HandleMap<S::Handle>) -> Self {
        Self { service, handle }
    }

    /// The service this port asks.
    pub fn service(&self) -> &Arc<ContextService<S>> {
        &self.service
    }
}

impl<S> Context<S>
where
    S: ContextStore<Handle = SessionHandle>,
{
    /// A port over a store whose handle is the session's own (the session store's binding).
    pub fn over_session_handles(service: Arc<ContextService<S>>) -> Self {
        Self::new(service, Arc::new(SessionHandle::clone))
    }
}

impl<S: ContextStore + 'static> ContextPort for Context<S> {
    fn record_runtime_context(
        &self,
        session: &SessionHandle,
        sections: &[RuntimeContextSection],
    ) -> Result<(), PortError> {
        // The section is the context crate's own type: nothing to convert.
        self.service
            .record_runtime_context(&(self.handle)(session), sections)
            .map_err(port_error)
    }

    fn prepare<'a>(
        &'a self,
        session: &'a SessionHandle,
        options: PrepareOptions,
    ) -> BoxFuture<'a, Result<ContextReport, PortError>> {
        Box::pin(async move {
            let handle = (self.handle)(session);
            let prepared = heddle_context::PrepareOptions {
                cwd: &options.cwd,
                endpoint: &options.endpoint,
                model: options.model.as_deref(),
                tools: &options.tools,
                system: options.system.as_deref(),
                // One model call with purpose `compaction`, the service's default summariser.
                summarizer: None,
                // An ordinary round: the trigger and the retained tail apply.
                force: false,
            };
            self.service
                .prepare(&handle, &prepared)
                .await
                .map_err(port_error)
        })
    }

    fn assemble(
        &self,
        session: &SessionHandle,
        options: PrepareOptions,
    ) -> Result<ContextReport, PortError> {
        let assembled = heddle_context::AssembleOptions {
            cwd: &options.cwd,
            tools: &options.tools,
            system: options.system.as_deref(),
            endpoint: Some(&options.endpoint),
            model: options.model.as_deref(),
        };
        self.service
            .assemble(&(self.handle)(session), &assembled)
            .map_err(port_error)
    }
}

/// The context service's listener on `agent/request-error`: overflow recovery, as the TypeScript context plugin
/// attaches it.
///
/// [`ContextService::recover_overflow`] records the decision for any code; for `CONTEXT_WINDOW_EXCEEDED` it runs
/// one forced reduction and answers [`Retry`](RequestErrorAction::Retry) only when a replacement landed, so the
/// loop re-derives the request and sends it once more (its own bound: a second refusal fails the turn). Every other
/// outcome — another code, nothing safe to reduce, a recovery that failed — passes to the next listener (`None`).
/// The recovery lives here because `heddle-context` cannot name this crate's [`TurnHooks`]; compose it with the
/// bus's listeners through [`ChainedTurnHooks`](crate::ChainedTurnHooks).
pub struct ContextRecovery<S: ContextStore> {
    service: Arc<ContextService<S>>,
    handle: HandleMap<S::Handle>,
}

impl<S: ContextStore> ContextRecovery<S> {
    /// The listener over `service`, naming each session through `handle`.
    pub fn new(service: Arc<ContextService<S>>, handle: HandleMap<S::Handle>) -> Self {
        Self { service, handle }
    }
}

impl<S> ContextRecovery<S>
where
    S: ContextStore<Handle = SessionHandle>,
{
    /// The listener over a store whose handle is the session's own (the session store's binding).
    pub fn over_session_handles(service: Arc<ContextService<S>>) -> Self {
        Self::new(service, Arc::new(SessionHandle::clone))
    }
}

impl<S: ContextStore + 'static> TurnHooks for ContextRecovery<S> {
    fn request_error<'a>(
        &'a self,
        payload: &'a RequestErrorPayload,
    ) -> BoxFuture<'a, Option<RequestErrorAction>> {
        Box::pin(async move {
            let handle = (self.handle)(&payload.session);
            let request = heddle_context::OverflowRequest {
                error_code: &payload.code,
                cwd: &payload.cwd,
                endpoint: &payload.endpoint,
                model: payload.model.as_deref(),
                tools: &payload.tools,
            };
            match self.service.recover_overflow(&handle, &request).await {
                Ok(heddle_context::RecoveryDecision::Retry) => Some(RequestErrorAction::Retry),
                Ok(heddle_context::RecoveryDecision::PassOn) => None,
                Err(error) => {
                    tracing::warn!(
                        target: "heddle_agent",
                        session = payload.session.id.as_str(),
                        "the overflow recovery failed, so the failure is passed on: {error}"
                    );
                    None
                }
            }
        })
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use std::path::PathBuf;

    use heddle_llm::EndpointConfig;
    use serde_json::json;

    use super::*;
    use crate::upstream::ContextBreakdown;
    use crate::upstream::{ContentPart, Message, Role, ToolCall};

    /// A scratch folder under the system temp folder that is removed when it is dropped, so a test that fails or
    /// panics still cleans up after itself (a helper that only cleared the folder before creating it left one
    /// behind per run: tool-developer's TMPDIR count, 2026-10-29). The name is unique per process and call.
    pub(crate) struct ScratchDir(PathBuf);

    impl ScratchDir {
        pub(crate) fn new(label: &str) -> Self {
            use std::sync::atomic::{AtomicU64, Ordering};
            static NEXT: AtomicU64 = AtomicU64::new(0);
            let n = NEXT.fetch_add(1, Ordering::SeqCst);
            let dir = std::env::temp_dir()
                .join(format!("heddle-agent-{label}-{}-{n}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }

        pub(crate) fn path(&self) -> &std::path::Path {
            &self.0
        }
    }

    impl Drop for ScratchDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// A scripted endpoint over one step file, and the scratch folder holding it: keep the guard alive for as
    /// long as the service is used.
    pub(crate) fn scripted_service(
        label: &str,
        steps: serde_json::Value,
    ) -> (Arc<ModelService>, ScratchDir) {
        let dir = ScratchDir::new(&format!("scripted-{label}"));
        let script = dir.path().join("script.json");
        std::fs::write(&script, json!({ "steps": steps }).to_string()).unwrap();
        let endpoint: EndpointConfig = serde_json::from_value(json!({
            "name": "scripted",
            "kind": "scripted",
            "baseUrl": script,
            "model": "scripted",
        }))
        .unwrap();
        let service =
            Arc::new(ModelService::from_configuration(vec![endpoint], Some("scripted")).unwrap());
        (service, dir)
    }

    fn request(round: u32) -> GenerateRequest {
        GenerateRequest {
            endpoint: "scripted".into(),
            messages: vec![Message::new(Role::User, vec![ContentPart::text("go")])],
            round: Some(round),
            ..GenerateRequest::default()
        }
    }

    async fn collect(port: &LlmModel, request: GenerateRequest) -> Vec<Result<Chunk, ModelError>> {
        port.stream(request, None).collect().await
    }

    #[tokio::test]
    async fn a_scripted_round_streams_its_tool_call_and_finishes_for_tools() {
        let (models, _scratch) = scripted_service(
            "call",
            json!([
                { "toolCall": { "name": "read_file", "arguments": { "path": "a.txt" } } },
                { "text": "done" }
            ]),
        );
        let port = LlmModel::new(models);
        let chunks: Vec<Chunk> = collect(&port, request(0))
            .await
            .into_iter()
            .map(Result::unwrap)
            .collect();
        assert!(
            chunks.contains(&Chunk::ToolCall(ToolCall {
                id: "call-read_file".into(),
                name: "read_file".into(),
                arguments: json!({ "path": "a.txt" }).to_string(),
            })),
            "{chunks:?}"
        );
        assert!(matches!(
            chunks.last(),
            Some(Chunk::Done { finish_reason, .. }) if finish_reason == "tool_calls"
        ));

        let second: Vec<Chunk> = collect(&port, request(1))
            .await
            .into_iter()
            .map(Result::unwrap)
            .collect();
        assert!(second.contains(&Chunk::TextDelta {
            text: "done".into()
        }));
    }

    #[tokio::test]
    async fn an_unknown_endpoint_fails_as_one_coded_error_item() {
        let (models, _scratch) = scripted_service("unknown", json!([]));
        let port = LlmModel::new(models);
        let mut asked = request(0);
        asked.endpoint = "nowhere".into();
        let items = collect(&port, asked).await;
        assert_eq!(items.len(), 1);
        let error = items.into_iter().next().unwrap().unwrap_err();
        assert_eq!(error.code.as_deref(), Some("NO_ENDPOINT"));
    }

    #[tokio::test]
    async fn a_scripted_failure_keeps_its_code_for_the_retry_rule() {
        let (models, _scratch) = scripted_service(
            "overflow",
            json!([{ "error": { "code": "CONTEXT_WINDOW_EXCEEDED", "message": "too long" } }]),
        );
        let port = LlmModel::new(models);
        let error = collect(&port, request(0))
            .await
            .into_iter()
            .find_map(Result::err)
            .expect("the step fails the call");
        assert_eq!(error.code.as_deref(), Some("CONTEXT_WINDOW_EXCEEDED"));
        assert!(error.message.contains("too long"), "{}", error.message);
    }

    #[tokio::test]
    async fn a_stopped_call_yields_nothing() {
        let (models, _scratch) = scripted_service("stop", json!([{ "text": "never seen" }]));
        let port = LlmModel::new(models);
        let token = CancellationToken::new();
        token.cancel();
        let items: Vec<_> = port.stream(request(0), Some(token)).collect().await;
        assert!(items.is_empty(), "{items:?}");
    }

    #[test]
    fn the_default_endpoint_is_the_nominated_one() {
        let (models, _scratch) = scripted_service("default", json!([]));
        let port = LlmModel::new(models);
        assert_eq!(port.default_endpoint().as_deref(), Some("scripted"));
    }

    // ---- The session and context adapters, against the real services. ----

    /// A session store in its own scratch folder, and the guard that removes it.
    pub(crate) fn sessions_at(label: &str) -> (Arc<SessionService>, ScratchDir) {
        let root = ScratchDir::new(&format!("sessions-{label}"));
        let config = heddle_session::SessionConfig {
            root: Some(root.path().to_str().unwrap().to_owned()),
        };
        let service = Arc::new(SessionService::new(
            &config,
            &heddle_config::Env::default(),
            None,
        ));
        (service, root)
    }

    #[test]
    fn the_session_port_records_the_prompt_and_reads_it_back_as_input() {
        let (sessions, _sessions_dir) = sessions_at("port");
        let handle = sessions.store().create(CreateOptions::default()).unwrap();
        let port = Sessions::new(Arc::clone(&sessions));
        assert_eq!(port.count(&handle), 1, "session/created is seq 0");
        port.user_content(
            &handle,
            vec![ContentPart::text("first question")],
            Some(json!({ "kind": "goal" })),
        )
        .unwrap();
        assert_eq!(port.count(&handle), 2);
        let surface = port.surface(&handle);
        let users: Vec<u64> = surface
            .nodes
            .iter()
            .copied()
            .filter(|seq| port.node_role(&handle, *seq) == Some(Role::User))
            .collect();
        assert_eq!(users.len(), 1, "{surface:?}");
        let events = sessions.events(&handle).unwrap();
        let message = events.last().unwrap();
        assert_eq!(message.kind, "message");
        assert_eq!(message.fields["message"]["role"], "user");
        assert_eq!(
            message.fields["message"]["source"],
            json!({ "kind": "goal" })
        );
    }

    #[test]
    fn the_session_port_writes_model_request_in_the_typescript_field_order() {
        let (sessions, _sessions_dir) = sessions_at("request");
        let handle = sessions.store().create(CreateOptions::default()).unwrap();
        let port = Sessions::new(Arc::clone(&sessions));
        port.model_request(
            &handle,
            &ModelRequestRecord {
                endpoint: "scripted".into(),
                model: None,
                reasoning_effort: None,
                messages: 3,
                tools: vec!["read_file".into()],
                estimated_tokens: 42,
                threshold_tokens: 800,
                pruned: 0,
                compacted: false,
                breakdown: ContextBreakdown {
                    system: 1,
                    tools: 2,
                    messages: 39,
                },
                generation: 5,
            },
        )
        .unwrap();
        let events = sessions.events(&handle).unwrap();
        let request = events.last().unwrap();
        assert_eq!(request.kind, "model/request");
        let keys: Vec<&str> = request.fields.keys().map(String::as_str).collect();
        assert_eq!(
            keys,
            [
                "endpoint",
                "messages",
                "tools",
                "estimatedTokens",
                "thresholdTokens",
                "pruned",
                "compacted",
                "breakdown",
                "generation"
            ]
        );
        assert_eq!(request.fields["estimatedTokens"], 42);
    }

    #[test]
    fn a_child_session_carries_its_parent_origin_depth_and_the_parents_mode() {
        let (sessions, _sessions_dir) = sessions_at("child");
        let parent = sessions
            .store()
            .create(CreateOptions {
                endpoint: Some("scripted".into()),
                ..CreateOptions::default()
            })
            .unwrap();
        sessions
            .set_mode(&parent, SandboxMode::ReadOnly, SandboxMode::WorkspaceWrite)
            .unwrap();
        let store = SessionSubagents::new(Arc::clone(&sessions));
        let child = store
            .create(CreateSession {
                cwd: Some("/work".into()),
                endpoint: Some("scripted".into()),
                parent_session: Some(parent.id.clone()),
                origin: Some("subagent".into()),
                delegation_depth: Some(1),
                ..CreateSession::default()
            })
            .unwrap();
        let meta = store.meta(&child.id).expect("the child's record");
        assert_eq!(meta.parent_session.as_deref(), Some(parent.id.as_str()));
        assert_eq!(meta.origin.as_deref(), Some("subagent"));
        assert_eq!(meta.delegation_depth, Some(1));
        assert_eq!(meta.endpoint.as_deref(), Some("scripted"));
        assert_eq!(
            store.inherit_recorded_mode(&parent, &child).unwrap(),
            Some(SandboxMode::ReadOnly)
        );
        assert_eq!(
            sessions
                .effective_mode(&child, SandboxMode::WorkspaceWrite)
                .unwrap(),
            SandboxMode::ReadOnly,
            "a narrowed session cannot widen itself by spawning a child"
        );
        assert!(
            store
                .read(&child)
                .iter()
                .any(|event| event.kind == "session/created")
        );
    }

    #[test]
    fn an_unknown_origin_is_refused_rather_than_written() {
        let (sessions, _sessions_dir) = sessions_at("origin");
        let store = SessionSubagents::new(sessions);
        let error = store
            .create(CreateSession {
                origin: Some("team".into()),
                ..CreateSession::default()
            })
            .unwrap_err();
        assert!(error.0.contains("team"), "{error}");
    }

    fn memory_context() -> (
        Arc<heddle_context::testing::MemoryStore>,
        Context<heddle_context::testing::MemoryStore>,
    ) {
        let store = Arc::new(heddle_context::testing::MemoryStore::new());
        let service = Arc::new(ContextService::new(
            Arc::clone(&store),
            heddle_context::ContextConfig::default(),
            heddle_context::ContextDependencies {
                model: None,
                heddle_home: std::env::temp_dir().join("heddle-agent-no-home"),
            },
        ));
        let opener = Arc::clone(&store);
        let port = Context::new(service, Arc::new(move |handle| opener.open(&handle.id)));
        (store, port)
    }

    fn context_handle() -> SessionHandle {
        SessionHandle {
            id: "ctx".into(),
            dir: "/ctx".into(),
            transcript: "/ctx/t".into(),
            meta: "/ctx/m".into(),
        }
    }

    fn options() -> PrepareOptions {
        PrepareOptions {
            cwd: std::env::temp_dir(),
            endpoint: "scripted".into(),
            model: None,
            tools: Vec::new(),
            system: None,
        }
    }

    #[tokio::test]
    async fn the_context_port_prepares_the_request_from_the_recorded_surface() {
        let (store, port) = memory_context();
        let session = store.open("ctx");
        store.message(
            &session,
            Message::new(Role::User, vec![ContentPart::text("remember a word")]),
        );
        port.record_runtime_context(
            &context_handle(),
            &[RuntimeContextSection {
                name: "sandbox:policy".into(),
                text: "sandbox: workspace-write".into(),
            }],
        )
        .unwrap();
        let report = port.prepare(&context_handle(), options()).await.unwrap();
        assert!(
            report.messages.iter().any(|message| {
                message.role == Role::User
                && message.content.iter().any(
                    |part| matches!(part, ContentPart::Text { text } if text == "remember a word")
                )
            }),
            "{:?}",
            report.messages
        );
        assert!(report.estimated_tokens > 0);
        assert!(report.threshold_tokens > 0);
        assert!(!report.compacted);

        let assembled = port.assemble(&context_handle(), options()).unwrap();
        assert_eq!(
            assembled.messages.len(),
            report.messages.len(),
            "assembling derives the same request without reducing it"
        );
    }

    /// A context double over the real session service: the request is the session's own derived messages.
    pub(crate) struct SessionMessages {
        pub(crate) sessions: Arc<heddle_session::SessionService>,
    }

    impl SessionMessages {
        fn report(&self, session: &SessionHandle) -> Result<ContextReport, PortError> {
            let messages = self
                .sessions
                .messages(session)
                .map_err(|error| PortError(error.to_string()))?;
            Ok(ContextReport {
                estimated_tokens: messages.len() as u64 * 10,
                context_window: 200_000,
                threshold_tokens: 160_000,
                messages,
                pruned: 0,
                compacted: false,
                instructions: Vec::new(),
                breakdown: Default::default(),
            })
        }
    }

    impl crate::ports::ContextPort for SessionMessages {
        fn record_runtime_context(
            &self,
            _: &SessionHandle,
            _: &[RuntimeContextSection],
        ) -> Result<(), PortError> {
            Ok(())
        }

        fn prepare<'a>(
            &'a self,
            session: &'a SessionHandle,
            _: PrepareOptions,
        ) -> BoxFuture<'a, Result<ContextReport, PortError>> {
            Box::pin(async move { self.report(session) })
        }

        fn assemble(
            &self,
            session: &SessionHandle,
            _: PrepareOptions,
        ) -> Result<ContextReport, PortError> {
            self.report(session)
        }
    }

    #[tokio::test]
    async fn the_context_port_over_the_real_session_store_prepares_what_the_session_recorded() {
        // The production binding: heddle-context's `impl ContextStore for SessionStore`, whose handle is the
        // session's own, so `over_session_handles` needs no map.
        let (sessions, _sessions_dir) = sessions_at("context-real");
        let handle = sessions.store().create(CreateOptions::default()).unwrap();
        sessions
            .user_content(&handle, vec![ContentPart::text("remember a word")], None)
            .unwrap();
        let service = Arc::new(ContextService::new(
            Arc::clone(sessions.store()),
            heddle_context::ContextConfig::default(),
            heddle_context::ContextDependencies {
                model: None,
                heddle_home: std::env::temp_dir().join("heddle-agent-no-home"),
            },
        ));
        let port = Context::over_session_handles(service);
        port.record_runtime_context(
            &handle,
            &[RuntimeContextSection {
                name: "sandbox:policy".into(),
                text: "sandbox: workspace-write".into(),
            }],
        )
        .unwrap();
        let report = port.prepare(&handle, options()).await.unwrap();
        assert!(
            report.messages.iter().any(|message| {
                message.role == Role::User
                && message.content.iter().any(
                    |part| matches!(part, ContentPart::Text { text } if text == "remember a word")
                )
            }),
            "{:?}",
            report.messages
        );
        assert!(report.estimated_tokens > 0);
        // The runtime-context note is the context crate's own `context/note` in the same log the loop reads,
        // written only when the snapshot changed: the loop records it every round, the log gains it once.
        port.record_runtime_context(
            &handle,
            &[RuntimeContextSection {
                name: "sandbox:policy".into(),
                text: "sandbox: workspace-write".into(),
            }],
        )
        .unwrap();
        let notes = sessions
            .events(&handle)
            .unwrap()
            .iter()
            .filter(|event| event.kind == "context/note")
            .count();
        assert_eq!(notes, 1, "an unchanged snapshot appends nothing");
    }

    /// A summariser that always answers, as the context crate's own overflow test uses.
    struct Briefing;

    impl heddle_context::ModelAccess for Briefing {
        fn endpoint_window(&self, _: &str, _: Option<&str>) -> Option<u64> {
            None
        }

        fn complete(
            &self,
            _: heddle_context::SummaryRequest,
        ) -> BoxFuture<'_, Result<String, heddle_context::SummarizeError>> {
            Box::pin(async { Ok("the briefing".to_owned()) })
        }
    }

    fn overflow_payload(code: &str) -> RequestErrorPayload {
        RequestErrorPayload {
            code: code.to_owned(),
            message: "maximum context length exceeded".into(),
            session: context_handle(),
            endpoint: "local".into(),
            model: None,
            cwd: std::env::temp_dir(),
            tools: Vec::new(),
        }
    }

    fn recovery(
        model: Option<Arc<dyn heddle_context::ModelAccess>>,
    ) -> (
        Arc<heddle_context::testing::MemoryStore>,
        ContextRecovery<heddle_context::testing::MemoryStore>,
    ) {
        let store = Arc::new(heddle_context::testing::MemoryStore::new());
        let service = Arc::new(ContextService::new(
            Arc::clone(&store),
            heddle_context::ContextConfig {
                context_window: Some(900),
                instructions: false,
                ..heddle_context::ContextConfig::default()
            },
            heddle_context::ContextDependencies {
                model,
                heddle_home: std::env::temp_dir().join("heddle-agent-no-home"),
            },
        ));
        let opener = Arc::clone(&store);
        let hooks = ContextRecovery::new(service, Arc::new(move |handle| opener.open(&handle.id)));
        let session = store.open("ctx");
        store.message(
            &session,
            Message::new(Role::System, vec![ContentPart::text("be brief")]),
        );
        store.message(
            &session,
            Message::new(Role::User, vec![ContentPart::text("u".repeat(1500))]),
        );
        store.message(
            &session,
            Message::new(Role::Assistant, vec![ContentPart::text("a".repeat(1500))]),
        );
        (store, hooks)
    }

    #[tokio::test]
    async fn an_overflow_that_a_forced_reduction_shrinks_grants_one_retry() {
        let (store, hooks) = recovery(Some(Arc::new(Briefing)));
        let action = hooks
            .request_error(&overflow_payload("CONTEXT_WINDOW_EXCEEDED"))
            .await;
        assert_eq!(action, Some(RequestErrorAction::Retry));
        let events = store.read(&store.open("ctx")).unwrap();
        assert!(
            events
                .iter()
                .any(|event| event.kind == "compaction/recovery"),
            "the decision was recorded by the context service"
        );
    }

    #[tokio::test]
    async fn another_failure_or_nothing_to_summarise_with_is_passed_on() {
        let (_, hooks) = recovery(Some(Arc::new(Briefing)));
        assert_eq!(
            hooks.request_error(&overflow_payload("RATE_LIMITED")).await,
            None
        );
        let (_, without_summariser) = recovery(None);
        assert_eq!(
            without_summariser
                .request_error(&overflow_payload("CONTEXT_WINDOW_EXCEEDED"))
                .await,
            None,
            "no summariser, no reduction, no retry"
        );
    }
}
