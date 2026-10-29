//! The `plan` service: the mode's fold, the `/plan` command, the `plan:policy` section on every request of a session
//! in plan mode, and `exit_plan_mode`.
//!
//! Ported from `src/plan/service.ts`. The TypeScript plugin registers its pieces itself (`ctx.commands.registry`,
//! `ctx.on('model/request')`, `ctx.tools`); here [`PlanService`] hands each one to the composition root, which
//! registers it where the binary keeps that seam: [`PlanService::command`] in the command registry,
//! [`PlanService::model_hooks`] on the model service's `model/request` waterfall, [`PlanService::exit_tool`] in the
//! tool registry and [`PlanService::router`] behind the server's door.

use std::sync::{Arc, PoisonError, RwLock};

use heddle_commands::{
    CommandAction, CommandDefinition, CommandInput, CommandResult, CommandSection,
};
use heddle_llm::{GenerateRequest, ModelError, ModelHooks, ModelService};
use heddle_session::{SessionHandle, SessionStore};
use heddle_tools::Tool;

use crate::mode::{PlanChange, PlanLog, PlanSessions, plan_active, set_plan_mode};
use crate::policy::with_plan_policy;
use crate::routes::{self, PlanRouteHost};
use crate::tool::{PlanReviewChannel, PlanToolHost, exit_plan_mode_tool};

/// The service's name, as the profile's row provides it.
pub const NAME: &str = "plan";

/// `/plan`'s description in the menu.
pub const PLAN_DESCRIPTION: &str = "Enter or leave plan mode";

/// `/plan`: enter plan mode, leave it with `/plan off`, or enter it and hand a message to the model.
///
/// DSH's command and sentences. The mode event is appended at once and every request reads the log, so a change
/// made while a turn runs is picked up by that turn's next model call — DSH's "applies from the next step" without
/// a pending state to keep. The words after `/plan` (anything but `off`) become a `prompt` action: the page sends
/// them as the ordinary message DSH steers into the session. A store that refuses the write is the run's error.
pub fn plan_command(log: Arc<dyn PlanLog>) -> CommandDefinition {
    CommandDefinition::sync(NAME, PLAN_DESCRIPTION, move |context| {
        if context.args == "off" {
            return Ok(
                match set_plan_mode(log.as_ref(), &context.session, false)? {
                    PlanChange::Committed => CommandResult::success_text("Plan mode off."),
                    PlanChange::Noop => {
                        CommandResult::success_text("Plan mode is already inactive.")
                    }
                },
            );
        }
        set_plan_mode(log.as_ref(), &context.session, true)?;
        let entered = CommandResult::success_text("Plan mode on. Use /plan off to leave.");
        Ok(if context.args.is_empty() {
            entered
        } else {
            entered.with_action(CommandAction::Prompt { text: context.args })
        })
    })
    .label("Plan")
    .section(CommandSection::Add)
    .input(CommandInput {
        hint: "[off|message]".to_owned(),
        attachments: Some(true),
    })
}

/// A request as it leaves for the model: with the plan-mode section when its session is in plan mode, unchanged
/// when it names no session, an unknown one, or one in the default mode.
///
/// A log that cannot be read counts as the default mode: the turn that sent the request has just read the same log
/// to assemble it, so this is a race with a damaged file, and the request goes out as it was built.
pub fn apply_plan_policy(store: &dyn PlanSessions, request: GenerateRequest) -> GenerateRequest {
    let Some(id) = request.session_id.as_deref() else {
        return request;
    };
    let Some(handle) = store.open(id) else {
        return request;
    };
    let active = store
        .read(&handle)
        .is_ok_and(|events| plan_active(events.as_slice()));
    if active {
        with_plan_policy(request)
    } else {
        request
    }
}

/// The `model/request` hook: the section rides every request of a session in plan mode, whichever loop sent it.
///
/// It runs the rest of the chain first and then applies the policy to what came back, as the TypeScript listener
/// (`(request, next) => applyPlanPolicy(store, next())`) does.
pub struct PlanPolicyHook {
    sessions: Arc<dyn PlanSessions>,
}

impl PlanPolicyHook {
    /// The hook over a session store.
    pub fn new(sessions: Arc<dyn PlanSessions>) -> Self {
        Self { sessions }
    }
}

impl ModelHooks for PlanPolicyHook {
    fn request(
        &self,
        _service: &ModelService,
        _request: &GenerateRequest,
        next: &mut dyn FnMut() -> Result<GenerateRequest, ModelError>,
    ) -> Result<GenerateRequest, ModelError> {
        Ok(apply_plan_policy(self.sessions.as_ref(), next()?))
    }
}

/// The plan service over a session store.
///
/// The review channel is looked up per call, as the TypeScript `ctx.get('planReview')` is: a user-question row that
/// can review a plan provides one with [`PlanService::provide_review_channel`], and until one does `exit_plan_mode`
/// answers with DSH's sentence telling the model to ask the person to switch the mode.
pub struct PlanService {
    store: Arc<SessionStore>,
    review: RwLock<Option<Arc<dyn PlanReviewChannel>>>,
}

impl std::fmt::Debug for PlanService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PlanService")
            .field("review_channel", &self.channel().is_some())
            .finish_non_exhaustive()
    }
}

impl PlanService {
    /// The service over the session store every row shares.
    pub fn new(store: Arc<SessionStore>) -> Arc<Self> {
        Arc::new(Self {
            store,
            review: RwLock::new(None),
        })
    }

    /// The session store the mode is folded from.
    pub fn store(&self) -> &Arc<SessionStore> {
        &self.store
    }

    /// Whether a session is in plan mode; a log that cannot be read is the default mode.
    pub fn active(&self, session: &SessionHandle) -> bool {
        PlanLog::read(self.store.as_ref(), session)
            .is_ok_and(|events| plan_active(events.as_slice()))
    }

    /// Switch a session into or out of plan mode ([`set_plan_mode`]).
    pub fn set_mode(&self, session: &SessionHandle, active: bool) -> Result<PlanChange, String> {
        set_plan_mode(self.store.as_ref(), session, active)
    }

    /// `/plan`, for the command registry.
    pub fn command(&self) -> CommandDefinition {
        plan_command(Arc::clone(&self.store) as Arc<dyn PlanLog>)
    }

    /// The `model/request` hook, for the model service's waterfall.
    pub fn model_hooks(&self) -> Arc<dyn ModelHooks> {
        Arc::new(PlanPolicyHook::new(
            Arc::clone(&self.store) as Arc<dyn PlanSessions>
        ))
    }

    /// A request with the section when its session is in plan mode ([`apply_plan_policy`]).
    pub fn apply(&self, request: GenerateRequest) -> GenerateRequest {
        apply_plan_policy(self.store.as_ref(), request)
    }

    /// `exit_plan_mode`, for the tool registry.
    pub fn exit_tool(self: &Arc<Self>) -> Arc<dyn Tool> {
        exit_plan_mode_tool(Arc::clone(self) as Arc<dyn PlanToolHost>)
    }

    /// `GET /api/sessions/{id}/plan`, ready to merge behind the server's door.
    pub fn router(self: &Arc<Self>) -> axum::Router {
        routes::router(Arc::clone(self) as Arc<dyn PlanRouteHost>)
    }

    /// Provide the channel plans are reviewed through, replacing any earlier one.
    pub fn provide_review_channel(&self, channel: Arc<dyn PlanReviewChannel>) {
        *self.review.write().unwrap_or_else(PoisonError::into_inner) = Some(channel);
    }

    /// Withdraw the review channel, as a row that provided it leaves.
    pub fn withdraw_review_channel(&self) {
        *self.review.write().unwrap_or_else(PoisonError::into_inner) = None;
    }

    fn channel(&self) -> Option<Arc<dyn PlanReviewChannel>> {
        self.review
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }
}

impl PlanToolHost for PlanService {
    fn active(&self, session: &SessionHandle) -> bool {
        PlanService::active(self, session)
    }

    fn leave(&self, session: &SessionHandle) -> Result<(), String> {
        self.set_mode(session, false).map(|_| ())
    }

    fn channel(&self) -> Option<Arc<dyn PlanReviewChannel>> {
        PlanService::channel(self)
    }
}

impl PlanRouteHost for PlanService {
    fn open(&self, id: &str) -> Option<SessionHandle> {
        self.store.open(id)
    }

    fn active(&self, session: &SessionHandle) -> bool {
        PlanService::active(self, session)
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use futures::StreamExt;
    use futures::future::BoxFuture;
    use heddle_commands::{CommandLog, CommandRegistry};
    use heddle_llm::{ChunkStream, ContentPart, Message, Role};
    use heddle_tools::{CancellationToken, SandboxMode, ToolArgs, ToolContext, ToolRunContext};
    use serde_json::json;

    use super::*;
    use crate::mode::{PLAN_EVENT, PLAN_ON_NOTICE};
    use crate::policy::PLAN_POLICY_SECTION;
    use crate::test_support::{Fixture, body_text, call};
    use crate::tool::{PlanForReview, PlanReviewAnswer};

    fn user(text: &str) -> Message {
        Message::new(Role::User, vec![ContentPart::text(text)])
    }

    fn request(messages: Vec<Message>, session_id: Option<&str>) -> GenerateRequest {
        GenerateRequest {
            endpoint: "scripted".to_owned(),
            messages,
            session_id: session_id.map(str::to_owned),
            ..GenerateRequest::default()
        }
    }

    #[test]
    fn a_request_carries_the_section_only_while_its_session_is_in_plan_mode() {
        let fixture = Fixture::new("apply");
        let store = fixture.store.as_ref();
        let plain = request(vec![user("hello")], Some(&fixture.handle.id));
        assert_eq!(
            apply_plan_policy(store, plain.clone()),
            plain,
            "default mode: the request is untouched"
        );
        set_plan_mode(store, &fixture.handle, true).unwrap();
        let planned = apply_plan_policy(store, plain.clone());
        assert_eq!(planned.messages.len(), 2);
        assert_eq!(planned.messages[0].role, Role::System);
        assert_eq!(
            planned.messages[0].content,
            vec![ContentPart::text(PLAN_POLICY_SECTION)]
        );
        assert_eq!(
            apply_plan_policy(store, request(vec![user("hello")], None))
                .messages
                .len(),
            1,
            "a request naming no session is untouched"
        );
        assert_eq!(
            apply_plan_policy(
                store,
                request(
                    vec![user("hello")],
                    Some("session-00000000-0000-4000-8000-000000000000")
                )
            )
            .messages
            .len(),
            1,
            "an unknown session too"
        );
    }

    #[test]
    fn the_hook_applies_the_policy_to_what_the_rest_of_the_chain_answers() {
        let fixture = Fixture::new("hook");
        let plan = PlanService::new(fixture.store.clone());
        let hook = plan.model_hooks();
        let service = ModelService::new(Vec::new()).unwrap();
        let sent = request(vec![user("hello")], Some(&fixture.handle.id));
        // The rest of the chain retargets the request; the section is added to its answer, not to the original.
        let retargeted = GenerateRequest {
            endpoint: "elsewhere".to_owned(),
            ..sent.clone()
        };
        let mut next = || Ok(retargeted.clone());
        assert_eq!(
            hook.request(&service, &sent, &mut next).unwrap(),
            retargeted
        );
        plan.set_mode(&fixture.handle, true).unwrap();
        let answered = hook.request(&service, &sent, &mut next).unwrap();
        assert_eq!(answered.endpoint, "elsewhere");
        assert_eq!(answered.messages.len(), 2);
        assert_eq!(answered.messages[0].role, Role::System);
        // A failure further in the chain is the call's failure.
        let mut failing = || Err(ModelError::new("refused", "scripted", "HOOK_REFUSED"));
        assert!(hook.request(&service, &sent, &mut failing).is_err());
    }

    /// A `model/stream` hook that records the request an adapter would be sent, and sends nothing.
    struct Recorder(Arc<Mutex<Vec<GenerateRequest>>>);

    impl ModelHooks for Recorder {
        fn stream(
            &self,
            request: &GenerateRequest,
            _next: Box<dyn FnOnce() -> ChunkStream + Send>,
        ) -> ChunkStream {
            self.0.lock().unwrap().push(request.clone());
            Box::pin(futures::stream::empty())
        }
    }

    #[test]
    fn through_the_model_service_the_adapter_is_sent_the_section_in_plan_mode() {
        let fixture = Fixture::new("hook-service");
        let script = fixture.root.join("script.json");
        std::fs::write(&script, json!({ "steps": [] }).to_string()).unwrap();
        let endpoint: heddle_llm::EndpointConfig = serde_json::from_value(json!({
            "name": "scripted",
            "kind": "scripted",
            "baseUrl": script,
            "model": "scripted",
        }))
        .unwrap();
        let service = ModelService::new(vec![endpoint]).unwrap();
        let plan = PlanService::new(fixture.store.clone());
        service.add_hooks(plan.model_hooks());
        let sent = Arc::new(Mutex::new(Vec::new()));
        service.add_hooks(Arc::new(Recorder(Arc::clone(&sent))));
        let send = |request: GenerateRequest| {
            futures::executor::block_on(async {
                let mut stream = service.stream(request).unwrap();
                while stream.next().await.is_some() {}
            });
        };
        let ask = request(vec![user("hello")], Some(&fixture.handle.id));
        send(ask.clone());
        plan.set_mode(&fixture.handle, true).unwrap();
        send(ask.clone());
        plan.set_mode(&fixture.handle, false).unwrap();
        send(ask);
        let sent = sent.lock().unwrap();
        let systems: Vec<usize> = sent
            .iter()
            .map(|request| {
                request
                    .messages
                    .iter()
                    .filter(|message| message.role == Role::System)
                    .count()
            })
            .collect();
        assert_eq!(
            systems,
            [0, 1, 0],
            "the section rides only the plan-mode request"
        );
    }

    async fn run(registry: &CommandRegistry, fixture: &Fixture, line: &str) -> serde_json::Value {
        let execution = registry
            .execute(
                fixture.store.as_ref() as &dyn CommandLog,
                &fixture.handle,
                line,
            )
            .await
            .unwrap()
            .expect("a /plan line is a command");
        let result = execution.result;
        let mut answer = json!({ "kind": result.kind() });
        if let Some(text) = result.text() {
            answer["text"] = json!(text);
        }
        if let Some(action) = result.action() {
            answer["action"] = serde_json::to_value(action).unwrap();
        }
        answer
    }

    #[tokio::test]
    async fn plan_enters_plan_off_leaves_and_words_after_plan_go_to_the_model_as_a_message() {
        let fixture = Fixture::new("command");
        let plan = PlanService::new(fixture.store.clone());
        let registry = CommandRegistry::new();
        registry.register(plan.command()).unwrap();
        assert_eq!(
            serde_json::to_value(registry.list()).unwrap(),
            json!([
                { "name": "plan", "label": "Plan", "description": "Enter or leave plan mode", "section": "add", "input": { "hint": "[off|message]", "attachments": true } },
            ])
        );
        assert_eq!(
            run(&registry, &fixture, "/plan off").await,
            json!({ "kind": "success", "text": "Plan mode is already inactive." })
        );
        assert_eq!(
            run(&registry, &fixture, "/plan").await,
            json!({ "kind": "success", "text": "Plan mode on. Use /plan off to leave." })
        );
        assert!(plan.active(&fixture.handle));
        assert_eq!(
            run(&registry, &fixture, "/plan off").await,
            json!({ "kind": "success", "text": "Plan mode off." })
        );
        assert!(!plan.active(&fixture.handle));
        assert_eq!(
            run(&registry, &fixture, "/plan design the slash menu").await,
            json!({
                "kind": "success",
                "text": "Plan mode on. Use /plan off to leave.",
                "action": { "kind": "prompt", "text": "design the slash menu" },
            })
        );
        assert!(plan.active(&fixture.handle));
        // Already on: `/plan <words>` writes no second mode event and still hands the words on.
        assert_eq!(
            run(&registry, &fixture, "/plan   and the menu  ").await["action"],
            json!({ "kind": "prompt", "text": "and the menu" })
        );
        let modes = fixture
            .events()
            .iter()
            .filter(|event| event.kind == PLAN_EVENT)
            .count();
        assert_eq!(modes, 3, "on, off, on");
    }

    /// A channel that approves and records what it was shown.
    struct Approving(Mutex<Vec<PlanForReview>>);

    impl PlanReviewChannel for Approving {
        fn review(
            &self,
            _session: &SessionHandle,
            plan: PlanForReview,
            _cancel: Option<CancellationToken>,
        ) -> BoxFuture<'static, Result<PlanReviewAnswer, String>> {
            self.0.lock().unwrap().push(plan);
            Box::pin(async { Ok(PlanReviewAnswer::Approve) })
        }
    }

    #[tokio::test]
    async fn the_service_looks_its_review_channel_up_per_call() {
        let fixture = Fixture::new("service-channel");
        let plan = PlanService::new(fixture.store.clone());
        let tool = plan.exit_tool();
        let call_tool = || {
            let context = ToolRunContext::new(
                ToolContext::new(fixture.root.clone()).with_session(fixture.handle.clone()),
                SandboxMode::WorkspaceWrite,
            );
            let args = ToolArgs::from_iter([("plan".to_owned(), json!("# Ship it\n\nsteps"))]);
            tool.run(args, context)
        };
        plan.set_mode(&fixture.handle, true).unwrap();
        let refused = call_tool().await.unwrap();
        assert_eq!(refused.error.unwrap().code, "PLAN_NO_REVIEW_CHANNEL");
        assert!(format!("{plan:?}").contains("review_channel: false"));

        let channel = Arc::new(Approving(Mutex::new(Vec::new())));
        plan.provide_review_channel(channel.clone());
        let approved = call_tool().await.unwrap();
        assert_eq!(approved.error, None);
        assert!(!plan.active(&fixture.handle), "approval leaves plan mode");
        assert_eq!(channel.0.lock().unwrap()[0].title, "Ship it");

        plan.withdraw_review_channel();
        plan.set_mode(&fixture.handle, true).unwrap();
        assert_eq!(
            call_tool().await.unwrap().error.unwrap().code,
            "PLAN_NO_REVIEW_CHANNEL"
        );
    }

    #[tokio::test]
    async fn the_services_router_reads_the_same_log() {
        let fixture = Fixture::new("service-route");
        let plan = PlanService::new(fixture.store.clone());
        let path = format!("/api/sessions/{}/plan", fixture.handle.id);
        plan.set_mode(&fixture.handle, true).unwrap();
        let answer = body_text(call(plan.router(), axum::http::Method::GET, &path).await).await;
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&answer).unwrap(),
            json!({ "session": fixture.handle.id, "active": true })
        );
        assert_eq!(
            plan.apply(request(vec![user("x")], Some(&fixture.handle.id)))
                .messages
                .len(),
            2
        );
        // A notice is written only once the model has answered in the session, as the mode module says.
        assert!(!fixture.events().iter().any(|event| {
            event
                .get("message")
                .is_some_and(|message| message.to_string().contains(PLAN_ON_NOTICE))
        }));
    }
}
