//! The tool registry: what exists, and the one gate every call crosses.
//!
//! Ported from `src/tools/service.ts` (`ToolRegistry`) and `src/plugins/tools.ts` (`ToolsPlugin`). Tools
//! are **registered** rather than imported by the code that needs them, which is what makes a tool
//! removable by configuration and addable from outside the project. The registry owns the order of the
//! gates, and the order is not arbitrary:
//!
//! 1. **unknown** — no tool by that name: `UNKNOWN_TOOL`, naming the known ones;
//! 2. **approval** — whether the action may be taken at all: `DENIED`;
//! 3. **`tools/pre-execute`** — a listener may refuse: `HOOKED`;
//! 4. **escalation** — a call carrying `sandbox_permissions`/`justification` is resolved before it runs:
//!    `BAD_ARGS` or `ESCALATION_REFUSED`;
//! 5. **mode** — resolved once, here, from the session's record or the deployment default, never from the
//!    arguments;
//! 6. **run**, then **`tools/post-execute`** over the result; a [`SandboxDenial`](crate::SandboxDenial)
//!    thrown by the tool is `SANDBOX`, any other failure `TOOL_FAILED`.
//!
//! [`ToolRegistry::call`] never fails: every refusal is a [`ToolResult`] with `error` set, because the
//! caller is a model turn that must be told what happened.

use std::sync::{Arc, RwLock};

use serde::Serialize;

use crate::builtin::{BuiltinOptions, builtin_tools};
use crate::config::ToolsConfig;
use crate::gates::{
    EscalationError, EscalationRequest, PreExecute, SandboxGate, ToolCall, ToolGates, ToolHookError,
};
use crate::tool::{
    Command, Tool, ToolArgs, ToolContext, ToolFailure, ToolResult, ToolRunContext, codes,
};
use crate::upstream::{EscalationSubject, SandboxMode, SessionHandle, ToolSpec};

/// A registration the registry refused, because a model could not be told about the tool.
///
/// The messages are the TypeScript build's, and they name what is missing — the verifier for part 4
/// matches `name|description` in the failure.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum RegistrationError {
    /// The spec's name is empty or blank.
    #[error("a tool must be registered with a name")]
    MissingName,
    /// The spec's description is empty or blank.
    #[error("the tool '{0}' must be registered with a description")]
    MissingDescription(String),
}

/// One command as `heddle commands` lists it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CommandSummary {
    /// The name a person types.
    pub name: String,
    /// What it does.
    pub description: String,
}

/// The tool registry.
///
/// Shared behind an `Arc`: plugins (and outside components) register into it after construction, so the
/// tables use interior mutability. Order is registration order, and replacing a name keeps the original
/// position — the TypeScript `Map.set` behaviour, which `heddle tools` prints.
pub struct ToolRegistry {
    tools: RwLock<Vec<Arc<dyn Tool>>>,
    commands: RwLock<Vec<Arc<dyn Command>>>,
    gates: ToolGates,
    allow: Vec<String>,
}

impl ToolRegistry {
    /// An empty registry with no allow list.
    pub fn new(gates: ToolGates) -> Self {
        Self::with_allow_list(gates, Vec::new())
    }

    /// An empty registry that remembers the configured allow list (applied later by [`Self::filter_to`]).
    pub fn with_allow_list(gates: ToolGates, allow: Vec<String>) -> Self {
        Self {
            tools: RwLock::new(Vec::new()),
            commands: RwLock::new(Vec::new()),
            gates,
            allow,
        }
    }

    /// The registry a `tools` configuration row builds — the TypeScript `ToolsPlugin` constructor.
    ///
    /// Registers the four built-ins unless `include_builtins` is false, **whether or not** the allow list
    /// names them, and keeps the allow list for the caller: a plugin may replace a built-in under the same
    /// name, and a filter applied here would drop it before it existed. The caller applies
    /// [`Self::filter_to`] with [`Self::allow_list`] once the whole tree has loaded and fails the run on
    /// [`Self::missing`].
    pub fn from_config(gates: ToolGates, config: &ToolsConfig) -> Self {
        let registry = Self::with_allow_list(gates, config.allow.clone());
        if config.include_builtins {
            let options = BuiltinOptions {
                bash_timeout_ms: config.bash_timeout_ms,
            };
            for tool in builtin_tools(Arc::clone(&registry.gates.sandbox), options) {
                registry
                    .register(tool)
                    .expect("a built-in carries a name and a description");
            }
        }
        registry
    }

    /// Add or replace a tool.
    ///
    /// Refused here, at the line that caused it, when the name or description is blank: an unnamed tool
    /// cannot be called and an undescribed one cannot be chosen.
    pub fn register(&self, tool: Arc<dyn Tool>) -> Result<(), RegistrationError> {
        let spec = tool.spec();
        if spec.name.trim().is_empty() {
            return Err(RegistrationError::MissingName);
        }
        if spec.description.trim().is_empty() {
            return Err(RegistrationError::MissingDescription(spec.name.clone()));
        }
        let mut tools = self
            .tools
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        match tools
            .iter()
            .position(|existing| existing.spec().name == spec.name)
        {
            Some(index) => tools[index] = tool,
            None => tools.push(tool),
        }
        Ok(())
    }

    /// Drop every tool `allow` does not name; an empty list keeps everything.
    pub fn filter_to(&self, allow: &[String]) {
        if allow.is_empty() {
            return;
        }
        let mut tools = self
            .tools
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        tools.retain(|tool| allow.iter().any(|name| *name == tool.spec().name));
    }

    /// Add or replace a command.
    pub fn register_command(&self, command: Arc<dyn Command>) {
        let mut commands = self
            .commands
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        match commands
            .iter()
            .position(|existing| existing.name() == command.name())
        {
            Some(index) => commands[index] = command,
            None => commands.push(command),
        }
    }

    /// The names a caller may ask for, in registration order.
    pub fn names(&self) -> Vec<String> {
        self.read_tools()
            .iter()
            .map(|tool| tool.spec().name.clone())
            .collect()
    }

    /// Configured names that nothing registered; empty when the configuration is satisfied.
    pub fn missing(&self) -> Vec<String> {
        self.allow
            .iter()
            .filter(|name| !self.has(name))
            .cloned()
            .collect()
    }

    /// The configured allow list, empty when the configuration named none.
    pub fn allow_list(&self) -> &[String] {
        &self.allow
    }

    /// Every tool's spec, which is what `heddle tools` prints and what the model is told.
    ///
    /// Each root is shown open, as DSH's `defineTool` compiles it ([`open_root`](crate::open_root)): an unknown
    /// top-level argument is accepted, so a root that said `additionalProperties: false` would promise a refusal
    /// that never comes. Nested nodes keep what they declare. R-developer-five-6, coordinator ruling (a).
    pub fn describe(&self) -> Vec<ToolSpec> {
        self.read_tools()
            .iter()
            .map(|tool| {
                let spec = tool.spec();
                ToolSpec {
                    parameters: crate::open_root(&spec.parameters),
                    ..spec.clone()
                }
            })
            .collect()
    }

    /// Every command, for `heddle commands`.
    pub fn describe_commands(&self) -> Vec<CommandSummary> {
        let commands = self
            .commands
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        commands
            .iter()
            .map(|command| CommandSummary {
                name: command.name().to_owned(),
                description: command.description().to_owned(),
            })
            .collect()
    }

    /// Whether a tool exists, so a caller can tell unknown from refused.
    pub fn has(&self, name: &str) -> bool {
        self.read_tools()
            .iter()
            .any(|tool| tool.spec().name == name)
    }

    /// The tool registered under `name`.
    pub fn get(&self, name: &str) -> Option<Arc<dyn Tool>> {
        self.read_tools()
            .iter()
            .find(|tool| tool.spec().name == name)
            .cloned()
    }

    /// Run one tool call through every gate, in the order the module documentation states.
    ///
    /// Never fails: a refusal, a sandbox denial and a tool's own failure all come back as a [`ToolResult`]
    /// with `error` set. A failing `tools/pre-execute` listener comes back as `INTERRUPTED` with its sentence,
    /// which is what the TypeScript loop's catch answers; [`Self::try_call`] keeps it apart for a caller
    /// that words it differently.
    pub async fn call(&self, name: &str, args: ToolArgs, context: ToolContext) -> ToolResult {
        match self.try_call(name, args, context).await {
            Ok(result) => result,
            Err(failure) => ToolResult::refused(codes::INTERRUPTED, failure.message),
        }
    }

    /// [`Self::call`], with a failing `tools/pre-execute` listener as an error rather than a result — the
    /// TypeScript `call`'s one throw, which escapes before the tool's own `try`.
    pub async fn try_call(
        &self,
        name: &str,
        args: ToolArgs,
        context: ToolContext,
    ) -> Result<ToolResult, ToolHookError> {
        let Some(tool) = self.get(name) else {
            let known = self.names();
            let known = if known.is_empty() {
                "(none)".to_owned()
            } else {
                known.join(", ")
            };
            return Ok(ToolResult::refused(
                codes::UNKNOWN_TOOL,
                format!("no tool named '{name}'; known: {known}"),
            ));
        };

        let decision = self.gates.approvals.check(name);
        if !decision.allowed {
            context.log(&format!(
                "denied {name}: {}",
                decision.reason.as_deref().unwrap_or("no reason given")
            ));
            return Ok(ToolResult::refused(
                codes::DENIED,
                decision
                    .reason
                    .unwrap_or_else(|| format!("the approval policy refused '{name}'")),
            ));
        }

        if let PreExecute::Refused { reason } = self
            .gates
            .hooks
            .pre_execute(&ToolCall { name, args: &args })?
        {
            context.log(&format!(
                "hooked {name}: {}",
                reason.as_deref().unwrap_or("refused by a hook")
            ));
            return Ok(ToolResult::refused(
                codes::HOOKED,
                reason.unwrap_or_else(|| format!("a hook refused '{name}'")),
            ));
        }

        let mut mode = self.effective_mode(context.session.as_ref());
        let requested_mode = args.get("sandbox_permissions").cloned();
        let justification = args.get("justification").cloned();
        if requested_mode.is_some() || justification.is_some() {
            let request = EscalationRequest {
                tool: name.to_owned(),
                requested_mode,
                justification,
                effective_mode: mode,
                subject: if name == "bash" {
                    EscalationSubject::Command
                } else {
                    EscalationSubject::Operation
                },
                session: context.session.as_ref().map(|session| session.id.clone()),
                cancel: context.cancel.clone(),
            };
            match self.gates.approvals.escalate(request).await {
                Ok(granted) => mode = granted,
                Err(EscalationError::BadArgs(message)) => {
                    return Ok(ToolResult::refused(codes::BAD_ARGS, message));
                }
                Err(EscalationError::Refused(refusal)) => {
                    context.log(&format!(
                        "refused escalation of {name}: {}",
                        refusal.message
                    ));
                    let data = serde_json::Map::from_iter([(
                        "sandbox".to_owned(),
                        serde_json::json!({ "mode": mode, "denied": false }),
                    )]);
                    return Ok(
                        ToolResult::refused(codes::ESCALATION_REFUSED, refusal.message)
                            .with_data(data),
                    );
                }
            }
        }

        // The arguments are checked against the tool's declared parameters before it runs, as DSH's `defineTool`
        // does inside `execute`: a violation is `INVALID_ARGS` in DSH's words and the tool never sees the call. The
        // root is open, so an unknown top-level key passes; arguments that were not valid JSON arrive as
        // `{"__unparsed": ...}` and are, in DSH's terms, not an object (`src/tools/service.ts`).
        let violations = if args.contains_key("__unparsed") {
            crate::argument_violations(&serde_json::json!({ "type": "object" }), &serde_json::Value::Null, "")
        } else {
            crate::argument_violations(
                &crate::open_root(&tool.spec().parameters),
                &serde_json::Value::Object(args.clone()),
                "",
            )
        };
        if !violations.is_empty() {
            let message = crate::invalid_arguments(&violations);
            context.log(&format!("refused {name}: {message}"));
            return Ok(ToolResult::refused(codes::INVALID_ARGS, message));
        }

        let result = match tool
            .run(args.clone(), ToolRunContext::new(context.clone(), mode))
            .await
        {
            Ok(result) => result,
            Err(ToolFailure::Sandbox(denial)) => {
                context.log(&format!("denied {name}: {}", denial.message));
                return Ok(ToolResult::refused(codes::SANDBOX, denial.message));
            }
            Err(ToolFailure::Failed(message)) => {
                return Ok(ToolResult::refused(codes::TOOL_FAILED, message));
            }
        };
        Ok(self
            .gates
            .hooks
            .post_execute(&ToolCall { name, args: &args }, result))
    }

    /// Run one command, which shares the approval gate (as `command:<name>`) and the result shape.
    pub async fn run_command(
        &self,
        name: &str,
        args: Vec<String>,
        context: ToolContext,
    ) -> ToolResult {
        let Some(command) = self.find_command(name) else {
            return ToolResult::refused(
                codes::UNKNOWN_COMMAND,
                format!("no command named '{name}'"),
            );
        };
        let decision = self.gates.approvals.check(&format!("command:{name}"));
        if !decision.allowed {
            return ToolResult::refused(
                codes::DENIED,
                decision
                    .reason
                    .unwrap_or_else(|| format!("the approval policy refused '{name}'")),
            );
        }
        command.run(args, context).await
    }

    /// The sandbox this registry gates against, so the loop can resolve the workspace and the policy text.
    pub fn sandbox(&self) -> &Arc<dyn SandboxGate> {
        &self.gates.sandbox
    }

    /// The execution policy of the deployment's mode, for the status route.
    pub fn sandbox_policy(&self) -> serde_json::Value {
        self.gates.sandbox.policy(self.gates.sandbox.default_mode())
    }

    /// The mode a call in `session` runs under: its own record, else the deployment default; a call with
    /// no session runs under the default. Public because the HTTP status route reports the same resolution.
    pub fn effective_mode(&self, session: Option<&SessionHandle>) -> SandboxMode {
        let default = self.gates.sandbox.default_mode();
        match session {
            Some(session) => self.gates.modes.effective_mode(session, default),
            None => default,
        }
    }

    /// The line the TypeScript build logs once the tree has loaded:
    /// `tools: <n> registered, <m> command(s) — <names>`.
    pub fn summary_line(&self) -> String {
        format!(
            "tools: {} registered, {} command(s) — {}",
            self.names().len(),
            self.describe_commands().len(),
            self.names().join(", ")
        )
    }

    fn read_tools(&self) -> std::sync::RwLockReadGuard<'_, Vec<Arc<dyn Tool>>> {
        self.tools
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn find_command(&self, name: &str) -> Option<Arc<dyn Command>> {
        let commands = self
            .commands
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        commands
            .iter()
            .find(|command| command.name() == name)
            .cloned()
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use std::path::{Path, PathBuf};

    use futures::future::BoxFuture;

    use super::*;
    use crate::gates::{
        ApprovalGate, DefaultModes, EscalationError, EscalationRequest, ModeResolver, NoToolHooks,
        ToolHooks,
    };
    use crate::tool::{ToolRunContext, tool_fn};
    use crate::upstream::{
        ApprovalDecision, ConfinedArgv, SandboxDenial, SandboxOutcome, SandboxUnavailable,
    };

    /// An approval gate that allows everything and never escalates.
    pub(crate) struct AllowAll;

    impl ApprovalGate for AllowAll {
        fn check(&self, _action: &str) -> ApprovalDecision {
            ApprovalDecision {
                allowed: true,
                mode: heddle_sandbox::ApprovalMode::Allow,
                reason: None,
            }
        }

        fn escalate<'a>(
            &'a self,
            request: EscalationRequest,
        ) -> BoxFuture<'a, Result<SandboxMode, EscalationError>> {
            Box::pin(async move { Ok(request.effective_mode) })
        }
    }

    /// A sandbox rooted at `root` that admits everything under it in every mode and confines nothing.
    pub(crate) struct OpenSandbox {
        pub(crate) root: PathBuf,
        pub(crate) mode: SandboxMode,
    }

    impl SandboxGate for OpenSandbox {
        fn workspace_root(&self) -> &Path {
            &self.root
        }
        fn default_mode(&self) -> SandboxMode {
            self.mode
        }
        fn escalation_targets(&self) -> Vec<SandboxMode> {
            Vec::new()
        }
        fn policy(&self, mode: SandboxMode) -> serde_json::Value {
            serde_json::json!({ "mode": mode })
        }
        fn policy_statement(&self, mode: SandboxMode) -> String {
            format!("sandbox: {mode}")
        }
        fn assert_writable(
            &self,
            path: &str,
            _mode: SandboxMode,
        ) -> Result<PathBuf, SandboxDenial> {
            Ok(self.root.join(path))
        }
        fn assert_readable(
            &self,
            path: &str,
            _mode: SandboxMode,
        ) -> Result<PathBuf, SandboxDenial> {
            Ok(self.root.join(path))
        }
        fn confine(
            &self,
            argv: &[String],
            mode: SandboxMode,
        ) -> Result<ConfinedArgv, SandboxUnavailable> {
            let _ = argv;
            Err(SandboxUnavailable { mode, detail: None })
        }
        fn classify_outcome(
            &self,
            _code: i32,
            _stderr: &str,
            _confined: Option<&ConfinedArgv>,
        ) -> SandboxOutcome {
            SandboxOutcome::Exited
        }
    }

    pub(crate) fn gates(mode: SandboxMode) -> ToolGates {
        ToolGates {
            approvals: Arc::new(AllowAll),
            sandbox: Arc::new(OpenSandbox {
                root: PathBuf::from("/w"),
                mode,
            }),
            modes: Arc::new(DefaultModes),
            hooks: Arc::new(NoToolHooks),
        }
    }

    fn named(name: &str, description: &str) -> Arc<dyn Tool> {
        let spec = ToolSpec {
            name: name.into(),
            description: description.into(),
            parameters: serde_json::json!({}),
        };
        let answer = description.to_owned();
        tool_fn(spec, move |_args, _ctx: ToolRunContext| {
            let answer = answer.clone();
            Box::pin(async move { Ok(ToolResult::ok(answer)) })
        })
    }

    #[test]
    fn a_tool_without_a_name_is_refused_at_registration() {
        let registry = ToolRegistry::new(gates(SandboxMode::WorkspaceWrite));
        let error = registry.register(named("  ", "does things")).unwrap_err();
        assert_eq!(error, RegistrationError::MissingName);
        assert!(error.to_string().contains("name"));
        assert!(registry.names().is_empty());
    }

    #[test]
    fn a_tool_without_a_description_is_refused_and_named() {
        let registry = ToolRegistry::new(gates(SandboxMode::WorkspaceWrite));
        let error = registry.register(named("shout", "")).unwrap_err();
        assert_eq!(
            error.to_string(),
            "the tool 'shout' must be registered with a description"
        );
    }

    #[test]
    fn a_later_registration_of_a_name_displaces_the_first_and_keeps_its_place() {
        let registry = ToolRegistry::new(gates(SandboxMode::WorkspaceWrite));
        registry
            .register(named("read_file", "the built-in"))
            .unwrap();
        registry.register(named("list_dir", "lists")).unwrap();
        registry
            .register(named(
                "read_file",
                "the project's own read_file, which wins",
            ))
            .unwrap();
        let specs = registry.describe();
        assert_eq!(
            specs
                .iter()
                .map(|spec| spec.name.as_str())
                .collect::<Vec<_>>(),
            ["read_file", "list_dir"]
        );
        assert!(specs[0].description.contains("wins"));
    }

    #[test]
    fn the_allow_list_filters_and_reports_what_nothing_registered() {
        let allow = vec!["read_file".to_owned(), "definitely_not_a_tool".to_owned()];
        let registry =
            ToolRegistry::with_allow_list(gates(SandboxMode::WorkspaceWrite), allow.clone());
        registry.register(named("read_file", "reads")).unwrap();
        registry.register(named("write_file", "writes")).unwrap();
        registry.filter_to(registry.allow_list().to_vec().as_slice());
        assert_eq!(registry.names(), ["read_file"]);
        assert_eq!(registry.missing(), ["definitely_not_a_tool"]);
    }

    #[test]
    fn an_empty_allow_list_keeps_every_tool() {
        let registry = ToolRegistry::new(gates(SandboxMode::WorkspaceWrite));
        registry.register(named("a", "first")).unwrap();
        registry.register(named("b", "second")).unwrap();
        registry.filter_to(&[]);
        assert_eq!(registry.names(), ["a", "b"]);
        assert!(registry.missing().is_empty());
    }

    #[test]
    fn a_call_without_a_session_runs_under_the_deployment_mode() {
        struct Narrow;
        impl ModeResolver for Narrow {
            fn effective_mode(
                &self,
                _session: &SessionHandle,
                _default: SandboxMode,
            ) -> SandboxMode {
                SandboxMode::ReadOnly
            }
        }
        struct Quiet;
        impl ToolHooks for Quiet {}
        let mut gates = gates(SandboxMode::WorkspaceWrite);
        gates.modes = Arc::new(Narrow);
        gates.hooks = Arc::new(Quiet);
        let registry = ToolRegistry::new(gates);
        let session = SessionHandle {
            id: "s".into(),
            dir: "/s".into(),
            transcript: "/s/t".into(),
            meta: "/s/m".into(),
        };
        assert_eq!(registry.effective_mode(None), SandboxMode::WorkspaceWrite);
        assert_eq!(
            registry.effective_mode(Some(&session)),
            SandboxMode::ReadOnly
        );
    }

    #[test]
    fn the_summary_line_counts_tools_and_commands() {
        let registry = ToolRegistry::new(gates(SandboxMode::WorkspaceWrite));
        registry.register(named("a", "first")).unwrap();
        registry.register(named("b", "second")).unwrap();
        assert_eq!(
            registry.summary_line(),
            "tools: 2 registered, 0 command(s) — a, b"
        );
    }

    /// A log sink that keeps the lines a call wrote, so a test can assert what a person is told.
    struct RecordingLog {
        lines: Arc<std::sync::Mutex<Vec<String>>>,
    }

    impl RecordingLog {
        fn new() -> Arc<Self> {
            Arc::new(Self {
                lines: Arc::new(std::sync::Mutex::new(Vec::new())),
            })
        }

        fn lines(&self) -> Vec<String> {
            self.lines.lock().unwrap().clone()
        }

        fn sink(&self) -> crate::tool::LogSink {
            let lines = Arc::clone(&self.lines);
            Arc::new(move |message: &str| lines.lock().unwrap().push(message.to_owned()))
        }
    }

    /// An approval gate that refuses every action with this reason (or the default sentence).
    struct DenyAll {
        reason: Option<String>,
    }

    impl ApprovalGate for DenyAll {
        fn check(&self, _: &str) -> ApprovalDecision {
            ApprovalDecision {
                allowed: false,
                mode: heddle_sandbox::ApprovalMode::Allow,
                reason: self.reason.clone(),
            }
        }

        fn escalate<'a>(
            &'a self,
            request: EscalationRequest,
        ) -> BoxFuture<'a, Result<SandboxMode, EscalationError>> {
            Box::pin(async move { Ok(request.effective_mode) })
        }
    }

    /// What an escalation double does, and what it was asked.
    enum Escalate {
        Grant(SandboxMode),
        Malformed(String),
        Refused(crate::upstream::EscalationRefusal),
    }

    struct Escalation {
        behavior: Escalate,
        requests: std::sync::Mutex<Vec<EscalationRequest>>,
    }

    impl Escalation {
        fn new(behavior: Escalate) -> Arc<Self> {
            Arc::new(Self {
                behavior,
                requests: std::sync::Mutex::new(Vec::new()),
            })
        }

        fn requests(&self) -> Vec<EscalationRequest> {
            self.requests.lock().unwrap().clone()
        }
    }

    impl ApprovalGate for Escalation {
        fn check(&self, _: &str) -> ApprovalDecision {
            ApprovalDecision {
                allowed: true,
                mode: heddle_sandbox::ApprovalMode::Allow,
                reason: None,
            }
        }

        fn escalate<'a>(
            &'a self,
            request: EscalationRequest,
        ) -> BoxFuture<'a, Result<SandboxMode, EscalationError>> {
            self.requests.lock().unwrap().push(request.clone());
            let answer = match &self.behavior {
                Escalate::Grant(mode) => Ok(*mode),
                Escalate::Malformed(message) => Err(EscalationError::BadArgs(message.clone())),
                Escalate::Refused(refusal) => Err(EscalationError::Refused(refusal.clone())),
            };
            Box::pin(async move { answer })
        }
    }

    /// Hooks that record every call they saw, refuse when told to and replace results when told to.
    struct RecordingHooks {
        pre: PreExecute,
        replace_with: Option<String>,
        seen: std::sync::Mutex<Vec<String>>,
    }

    impl RecordingHooks {
        fn new(pre: PreExecute, replace_with: Option<String>) -> Arc<Self> {
            Arc::new(Self {
                pre,
                replace_with,
                seen: std::sync::Mutex::new(Vec::new()),
            })
        }

        fn seen(&self) -> Vec<String> {
            self.seen.lock().unwrap().clone()
        }
    }

    impl ToolHooks for RecordingHooks {
        fn pre_execute(&self, call: &ToolCall<'_>) -> Result<PreExecute, ToolHookError> {
            self.seen.lock().unwrap().push(format!("pre:{}", call.name));
            Ok(self.pre.clone())
        }

        fn post_execute(&self, call: &ToolCall<'_>, result: ToolResult) -> ToolResult {
            self.seen
                .lock()
                .unwrap()
                .push(format!("post:{}", call.name));
            match &self.replace_with {
                Some(output) => ToolResult::ok(output.clone()),
                None => result,
            }
        }
    }

    /// A tool that records that it ran, and answers with its own output.
    fn recording_tool(ran: Arc<std::sync::atomic::AtomicBool>) -> Arc<dyn Tool> {
        let spec = ToolSpec {
            name: "write_file".into(),
            description: "writes".into(),
            parameters: serde_json::json!({}),
        };
        tool_fn(spec, move |_args, _ctx: ToolRunContext| {
            let ran = Arc::clone(&ran);
            Box::pin(async move {
                ran.store(true, std::sync::atomic::Ordering::SeqCst);
                Ok(ToolResult::ok("ran"))
            })
        })
    }

    /// A command that answers with its arguments joined by spaces.
    struct EchoCommand(&'static str);

    impl Command for EchoCommand {
        fn name(&self) -> &str {
            self.0
        }
        fn description(&self) -> &str {
            "echoes its arguments"
        }
        fn run<'a>(&'a self, args: Vec<String>, _: ToolContext) -> BoxFuture<'a, ToolResult> {
            Box::pin(async move { ToolResult::ok(args.join(" ")) })
        }
    }

    fn with_hooks(hooks: Arc<dyn ToolHooks>) -> ToolGates {
        let mut gates = gates(SandboxMode::WorkspaceWrite);
        gates.hooks = hooks;
        gates
    }

    /// A tool with a declared schema that records whether it ran (R-developer-five-6).
    fn probe(ran: Arc<std::sync::atomic::AtomicBool>) -> Arc<dyn Tool> {
        let spec = ToolSpec {
            name: "probe".into(),
            description: "records whether it ran".into(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": { "path": { "type": "string" } },
                "required": ["path"],
                "additionalProperties": false,
            }),
        };
        tool_fn(spec, move |_args, _ctx: ToolRunContext| {
            let ran = Arc::clone(&ran);
            Box::pin(async move {
                ran.store(true, std::sync::atomic::Ordering::SeqCst);
                Ok(ToolResult::ok("ran"))
            })
        })
    }

    fn args_of(value: serde_json::Value) -> ToolArgs {
        value.as_object().cloned().unwrap_or_default()
    }

    #[tokio::test]
    async fn a_call_that_breaks_its_schema_is_refused_before_the_tool_runs() {
        let ran = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let registry = ToolRegistry::new(gates(SandboxMode::WorkspaceWrite));
        registry.register(probe(Arc::clone(&ran))).unwrap();
        let wrong = registry
            .call("probe", args_of(serde_json::json!({ "path": 7 })), ToolContext::new("/w"))
            .await;
        let error = wrong.error.unwrap();
        assert_eq!(error.code, codes::INVALID_ARGS);
        assert_eq!(error.message, "invalid arguments: \"path\" must be a string");
        let missing = registry
            .call("probe", ToolArgs::new(), ToolContext::new("/w"))
            .await;
        assert_eq!(
            missing.error.unwrap().message,
            "invalid arguments: missing required property \"path\""
        );
        let unparsed = registry
            .call(
                "probe",
                args_of(serde_json::json!({ "__unparsed": "{\"path\":" })),
                ToolContext::new("/w"),
            )
            .await;
        assert_eq!(
            unparsed.error.unwrap().message,
            "invalid arguments: \"arguments\" must be an object",
            "malformed JSON is not an object"
        );
        assert!(!ran.load(std::sync::atomic::Ordering::SeqCst), "the tool never ran");
    }

    #[tokio::test]
    async fn an_unknown_top_level_argument_reaches_the_tool_and_roots_are_shown_open() {
        let ran = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let registry = ToolRegistry::new(gates(SandboxMode::WorkspaceWrite));
        registry.register(probe(Arc::clone(&ran))).unwrap();
        let result = registry
            .call(
                "probe",
                args_of(serde_json::json!({ "path": "a", "run_in_background": true })),
                ToolContext::new("/w"),
            )
            .await;
        assert_eq!(result.error, None);
        assert!(ran.load(std::sync::atomic::Ordering::SeqCst));
        let shown = registry.describe();
        assert!(
            shown[0].parameters.get("additionalProperties").is_none(),
            "the model is shown an open root"
        );
    }

    #[tokio::test]
    async fn an_unknown_tool_is_refused_by_name_and_lists_the_known_ones() {
        let registry = ToolRegistry::new(gates(SandboxMode::WorkspaceWrite));
        registry.register(named("read_file", "reads")).unwrap();
        let result = registry
            .call("shout", ToolArgs::new(), ToolContext::new("/w"))
            .await;
        let error = result.error.unwrap();
        assert_eq!(error.code, codes::UNKNOWN_TOOL);
        assert!(error.message.contains("shout"), "{}", error.message);
        assert!(error.message.contains("read_file"), "{}", error.message);
    }

    #[tokio::test]
    async fn a_denied_tool_is_the_denied_refusal_and_never_runs() {
        let ran = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let mut gates = gates(SandboxMode::WorkspaceWrite);
        gates.approvals = Arc::new(DenyAll {
            reason: Some("the policy says no".into()),
        });
        let registry = ToolRegistry::new(gates);
        registry.register(recording_tool(Arc::clone(&ran))).unwrap();
        let log = RecordingLog::new();
        let result = registry
            .call(
                "write_file",
                ToolArgs::new(),
                ToolContext::new("/w").with_log(log.sink()),
            )
            .await;
        assert_eq!(result.error.unwrap().code, codes::DENIED);
        assert!(!ran.load(std::sync::atomic::Ordering::SeqCst));
        assert_eq!(log.lines(), ["denied write_file: the policy says no"]);
    }

    #[tokio::test]
    async fn a_pre_execute_refusal_is_hooked_and_keeps_its_reason() {
        let ran = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let hooks = RecordingHooks::new(
            PreExecute::Refused {
                reason: Some("not this one".into()),
            },
            None,
        );
        let registry = ToolRegistry::new(with_hooks(hooks));
        registry.register(recording_tool(Arc::clone(&ran))).unwrap();
        let result = registry
            .call("write_file", ToolArgs::new(), ToolContext::new("/w"))
            .await;
        assert_eq!(result.error.as_ref().unwrap().code, codes::HOOKED);
        assert_eq!(result.error.unwrap().message, "not this one");
        assert!(!ran.load(std::sync::atomic::Ordering::SeqCst));
    }

    #[tokio::test]
    async fn a_hook_refusal_with_no_reason_names_the_tool() {
        let hooks = RecordingHooks::new(PreExecute::Refused { reason: None }, None);
        let registry = ToolRegistry::new(with_hooks(hooks));
        registry.register(named("read_file", "reads")).unwrap();
        let result = registry
            .call("read_file", ToolArgs::new(), ToolContext::new("/w"))
            .await;
        assert_eq!(result.error.unwrap().message, "a hook refused 'read_file'");
    }

    #[tokio::test]
    async fn approval_is_checked_before_the_hook() {
        let hooks = RecordingHooks::new(PreExecute::Allowed, None);
        let mut gates = gates(SandboxMode::WorkspaceWrite);
        gates.approvals = Arc::new(DenyAll { reason: None });
        let gates = ToolGates {
            hooks: Arc::clone(&hooks) as Arc<dyn ToolHooks>,
            ..gates
        };
        let registry = ToolRegistry::new(gates);
        registry.register(named("read_file", "reads")).unwrap();
        let result = registry
            .call("read_file", ToolArgs::new(), ToolContext::new("/w"))
            .await;
        assert_eq!(result.error.unwrap().code, codes::DENIED);
        assert!(hooks.seen().is_empty(), "the hook never saw the call");
    }

    #[tokio::test]
    async fn the_hook_is_checked_before_the_escalation() {
        let hooks = RecordingHooks::new(
            PreExecute::Refused {
                reason: Some("no".into()),
            },
            None,
        );
        let escalation = Escalation::new(Escalate::Grant(SandboxMode::DangerFullAccess));
        let mut gates = gates(SandboxMode::WorkspaceWrite);
        gates.hooks = Arc::clone(&hooks) as Arc<dyn ToolHooks>;
        gates.approvals = Arc::clone(&escalation) as Arc<dyn ApprovalGate>;
        let registry = ToolRegistry::new(gates);
        registry.register(named("bash", "runs")).unwrap();
        let result = registry
            .call(
                "bash",
                args_with_escalation("danger-full-access", "needed"),
                ToolContext::new("/w"),
            )
            .await;
        assert_eq!(result.error.unwrap().code, codes::HOOKED);
        assert!(escalation.requests().is_empty(), "the escalation never ran");
    }

    fn args_with_escalation(mode: &str, justification: &str) -> ToolArgs {
        ToolArgs::from_iter([
            (
                "sandbox_permissions".to_owned(),
                serde_json::Value::String(mode.to_owned()),
            ),
            (
                "justification".to_owned(),
                serde_json::Value::String(justification.to_owned()),
            ),
        ])
    }

    #[tokio::test]
    async fn a_malformed_escalation_is_bad_arguments_and_the_tool_does_not_run() {
        let ran = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let mut gates = gates(SandboxMode::WorkspaceWrite);
        gates.approvals = Escalation::new(Escalate::Malformed(
            "sandbox_permissions must be a string".into(),
        ));
        let registry = ToolRegistry::new(gates);
        registry.register(recording_tool(Arc::clone(&ran))).unwrap();
        let result = registry
            .call(
                "write_file",
                args_with_escalation("danger-full-access", "needed"),
                ToolContext::new("/w"),
            )
            .await;
        assert_eq!(result.error.as_ref().unwrap().code, codes::BAD_ARGS);
        assert!(
            result
                .error
                .unwrap()
                .message
                .contains("sandbox_permissions")
        );
        assert!(!ran.load(std::sync::atomic::Ordering::SeqCst));
    }

    #[tokio::test]
    async fn a_refused_escalation_carries_the_sandbox_facts() {
        let refusal = crate::upstream::EscalationRefusal {
            code: crate::upstream::EscalationRefusalCode::Rejected,
            message: "a person said no".into(),
        };
        let mut gates = gates(SandboxMode::ReadOnly);
        gates.approvals = Escalation::new(Escalate::Refused(refusal));
        let registry = ToolRegistry::new(gates);
        registry.register(named("write_file", "writes")).unwrap();
        let result = registry
            .call(
                "write_file",
                args_with_escalation("workspace-write", "needed"),
                ToolContext::new("/w"),
            )
            .await;
        assert_eq!(
            result.error.as_ref().unwrap().code,
            codes::ESCALATION_REFUSED
        );
        let data = result.data.expect("the sandbox facts");
        assert_eq!(data["sandbox"]["mode"], "read-only");
        assert_eq!(data["sandbox"]["denied"], false);
    }

    #[tokio::test]
    async fn a_granted_escalation_applies_to_that_call_only() {
        let seen = Arc::new(std::sync::Mutex::new(Vec::new()));
        let spec = ToolSpec {
            name: "write_file".into(),
            description: "writes".into(),
            parameters: serde_json::json!({}),
        };
        let record = Arc::clone(&seen);
        let tool = tool_fn(spec, move |_args, ctx: ToolRunContext| {
            let record = Arc::clone(&record);
            Box::pin(async move {
                record.lock().unwrap().push(ctx.mode());
                Ok(ToolResult::ok("ran"))
            })
        });
        let mut gates = gates(SandboxMode::ReadOnly);
        gates.approvals = Escalation::new(Escalate::Grant(SandboxMode::DangerFullAccess));
        let registry = ToolRegistry::new(gates);
        registry.register(tool).unwrap();
        registry
            .call(
                "write_file",
                args_with_escalation("danger-full-access", "needed"),
                ToolContext::new("/w"),
            )
            .await;
        registry
            .call("write_file", ToolArgs::new(), ToolContext::new("/w"))
            .await;
        assert_eq!(
            *seen.lock().unwrap(),
            [SandboxMode::DangerFullAccess, SandboxMode::ReadOnly],
            "the grant was this call's; the next call is back under the deployment mode"
        );
    }

    #[tokio::test]
    async fn the_mode_comes_from_the_resolved_escalation_and_never_from_the_arguments() {
        struct Narrow;
        impl ModeResolver for Narrow {
            fn effective_mode(&self, _: &SessionHandle, _: SandboxMode) -> SandboxMode {
                SandboxMode::ReadOnly
            }
        }
        let seen = Arc::new(std::sync::Mutex::new(Vec::new()));
        let spec = ToolSpec {
            name: "bash".into(),
            description: "runs".into(),
            parameters: serde_json::json!({}),
        };
        let record = Arc::clone(&seen);
        let tool = tool_fn(spec, move |_args, ctx: ToolRunContext| {
            let record = Arc::clone(&record);
            Box::pin(async move {
                record.lock().unwrap().push(ctx.mode());
                Ok(ToolResult::ok("ran"))
            })
        });
        let escalation = Escalation::new(Escalate::Grant(SandboxMode::ReadOnly));
        let mut gates = gates(SandboxMode::WorkspaceWrite);
        gates.modes = Arc::new(Narrow);
        gates.approvals = Arc::clone(&escalation) as Arc<dyn ApprovalGate>;
        let registry = ToolRegistry::new(gates);
        registry.register(tool).unwrap();
        let session = SessionHandle {
            id: "s".into(),
            dir: "/s".into(),
            transcript: "/s/t".into(),
            meta: "/s/m".into(),
        };
        registry
            .call(
                "bash",
                args_with_escalation("danger-full-access", "needed"),
                ToolContext::new("/w").with_session(session),
            )
            .await;
        assert_eq!(*seen.lock().unwrap(), [SandboxMode::ReadOnly]);
        let requests = escalation.requests();
        assert_eq!(requests.len(), 1);
        assert_eq!(
            requests[0].requested_mode,
            Some(serde_json::json!("danger-full-access")),
            "the raw argument reaches the gate, judged there"
        );
        assert_eq!(requests[0].effective_mode, SandboxMode::ReadOnly);
        assert_eq!(
            requests[0].subject,
            crate::upstream::EscalationSubject::Command
        );
        assert_eq!(requests[0].session.as_deref(), Some("s"));
    }

    #[tokio::test]
    async fn a_tool_failure_is_tool_failed_and_a_sandbox_denial_is_sandbox() {
        fn exploding(name: &str, denial: bool) -> Arc<dyn Tool> {
            let spec = ToolSpec {
                name: name.into(),
                description: name.into(),
                parameters: serde_json::json!({}),
            };
            tool_fn(spec, move |_args, _ctx| {
                Box::pin(async move {
                    if denial {
                        Err(crate::tool::ToolFailure::Sandbox(SandboxDenial {
                            message: "outside".into(),
                            path: "/etc/x".into(),
                            mode: SandboxMode::WorkspaceWrite,
                            workspace_root: "/w".into(),
                        }))
                    } else {
                        Err(crate::tool::ToolFailure::Failed("boom".into()))
                    }
                })
            })
        }
        let registry = ToolRegistry::new(gates(SandboxMode::WorkspaceWrite));
        registry.register(exploding("explode", false)).unwrap();
        registry.register(exploding("denied", true)).unwrap();
        let failed = registry
            .call("explode", ToolArgs::new(), ToolContext::new("/w"))
            .await;
        assert_eq!(failed.error.unwrap().code, codes::TOOL_FAILED);
        let denial = registry
            .call("denied", ToolArgs::new(), ToolContext::new("/w"))
            .await;
        assert_eq!(denial.error.unwrap().code, codes::SANDBOX);
    }

    #[tokio::test]
    async fn post_execute_replaces_the_result() {
        let hooks = RecordingHooks::new(PreExecute::Allowed, Some("redacted".into()));
        let registry = ToolRegistry::new(with_hooks(Arc::clone(&hooks) as Arc<dyn ToolHooks>));
        registry.register(named("read_file", "reads")).unwrap();
        let result = registry
            .call("read_file", ToolArgs::new(), ToolContext::new("/w"))
            .await;
        assert_eq!(result.output, "redacted");
        assert_eq!(hooks.seen(), ["pre:read_file", "post:read_file"]);
    }

    #[test]
    fn from_config_registers_the_built_ins_and_keeps_the_allow_list_for_the_caller() {
        let config = ToolsConfig {
            allow: vec!["read_file".into(), "absent".into()],
            include_builtins: true,
            bash_timeout_ms: 5,
        };
        let registry = ToolRegistry::from_config(gates(SandboxMode::WorkspaceWrite), &config);
        assert_eq!(
            registry.names(),
            ["write_file", "read_file", "list_dir", "bash"]
        );
        assert_eq!(registry.allow_list(), ["read_file", "absent"]);
        assert_eq!(
            registry.missing(),
            ["absent"],
            "the allow list is a check, not a filter"
        );
        registry.filter_to(&config.allow);
        assert_eq!(registry.names(), ["read_file"]);
    }

    #[test]
    fn from_config_can_leave_the_built_ins_out() {
        let config = ToolsConfig {
            allow: Vec::new(),
            include_builtins: false,
            bash_timeout_ms: 0,
        };
        let registry = ToolRegistry::from_config(gates(SandboxMode::WorkspaceWrite), &config);
        assert!(registry.names().is_empty());
    }

    #[test]
    fn the_listing_serializes_as_the_tools_command_and_the_verifier_read_it() {
        let registry =
            ToolRegistry::from_config(gates(SandboxMode::WorkspaceWrite), &ToolsConfig::default());
        let listing: Vec<serde_json::Value> =
            serde_json::from_str(&serde_json::to_string(&registry.describe()).unwrap()).unwrap();
        assert_eq!(listing.len(), 4);
        for tool in &listing {
            assert!(
                tool["name"].as_str().is_some_and(|name| !name.is_empty()),
                "{tool}"
            );
            assert!(
                tool["description"]
                    .as_str()
                    .is_some_and(|description| description.len() > 10),
                "{tool}"
            );
            assert!(tool["parameters"].is_object(), "{tool}");
        }
        assert_eq!(
            listing
                .iter()
                .map(|tool| tool["name"].as_str().unwrap())
                .collect::<Vec<_>>(),
            ["write_file", "read_file", "list_dir", "bash"]
        );
    }

    #[tokio::test]
    async fn a_command_shares_the_approval_gate_under_the_command_name() {
        struct CommandDenier;
        impl ApprovalGate for CommandDenier {
            fn check(&self, action: &str) -> ApprovalDecision {
                ApprovalDecision {
                    allowed: !action.starts_with("command:"),
                    mode: heddle_sandbox::ApprovalMode::Allow,
                    reason: Some("commands are closed".into()),
                }
            }
            fn escalate<'a>(
                &'a self,
                request: EscalationRequest,
            ) -> BoxFuture<'a, Result<SandboxMode, EscalationError>> {
                Box::pin(async move { Ok(request.effective_mode) })
            }
        }
        let mut gates = gates(SandboxMode::WorkspaceWrite);
        gates.approvals = Arc::new(CommandDenier);
        let registry = ToolRegistry::new(gates);
        registry.register_command(Arc::new(EchoCommand("echo")));
        let refused = registry
            .run_command("echo", vec!["hi".into()], ToolContext::new("/w"))
            .await;
        assert_eq!(refused.error.unwrap().code, codes::DENIED);
        let unknown = registry
            .run_command("absent", Vec::new(), ToolContext::new("/w"))
            .await;
        assert_eq!(unknown.error.unwrap().code, codes::UNKNOWN_COMMAND);
    }

    #[tokio::test]
    async fn an_allowed_command_runs_and_keeps_its_result_shape() {
        let registry = ToolRegistry::new(gates(SandboxMode::WorkspaceWrite));
        registry.register_command(Arc::new(EchoCommand("echo")));
        let result = registry
            .run_command(
                "echo",
                vec!["hi".into(), "there".into()],
                ToolContext::new("/w"),
            )
            .await;
        assert_eq!(result.output, "hi there");
        assert_eq!(result.error, None);
    }

    struct BrokenHook;

    impl ToolHooks for BrokenHook {
        fn pre_execute(&self, _: &ToolCall<'_>) -> Result<PreExecute, ToolHookError> {
            Err(ToolHookError::new(
                "a hook failed at tools/pre-execute (policy) — typo",
            ))
        }
    }

    #[tokio::test]
    async fn a_failing_pre_execute_listener_stops_the_call_and_is_kept_apart_by_try_call() {
        let ran = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let registry = ToolRegistry::new(with_hooks(Arc::new(BrokenHook)));
        registry.register(recording_tool(Arc::clone(&ran))).unwrap();
        let failure = registry
            .try_call("write_file", ToolArgs::new(), ToolContext::new("/w"))
            .await
            .unwrap_err();
        assert!(failure.message.contains("tools/pre-execute"), "{failure}");
        let result = registry
            .call("write_file", ToolArgs::new(), ToolContext::new("/w"))
            .await;
        let error = result.error.unwrap();
        assert_eq!(
            error.code,
            codes::INTERRUPTED,
            "the TypeScript loop's catch"
        );
        assert_eq!(error.message, failure.message);
        assert!(
            !ran.load(std::sync::atomic::Ordering::SeqCst),
            "the tool never ran"
        );
    }
}
