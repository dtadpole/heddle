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

use crate::config::ToolsConfig;
use crate::gates::{SandboxGate, ToolGates};
use crate::tool::{Command, Tool, ToolArgs, ToolContext, ToolResult};
use crate::upstream::{SandboxMode, SessionHandle, ToolSpec};

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
        todo!("port ToolsPlugin's constructor: builtins per config, allow list kept for the caller")
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
    pub fn describe(&self) -> Vec<ToolSpec> {
        self.read_tools()
            .iter()
            .map(|tool| tool.spec().clone())
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
    /// with `error` set.
    pub async fn call(&self, name: &str, args: ToolArgs, context: ToolContext) -> ToolResult {
        todo!(
            "port ToolRegistry.call: unknown, approval, pre-execute, escalation, mode, run, post-execute"
        )
    }

    /// Run one command, which shares the approval gate (as `command:<name>`) and the result shape.
    pub async fn run_command(
        &self,
        name: &str,
        args: Vec<String>,
        context: ToolContext,
    ) -> ToolResult {
        todo!("port ToolRegistry.runCommand")
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
            Err(SandboxUnavailable {
                mode,
                message: "no backend in the test double".into(),
            })
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
}
