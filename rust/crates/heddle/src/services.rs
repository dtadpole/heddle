//! The service registry a booted tree hangs off: the Rust shape of Cordis's `ctx.<service>`.
//!
//! A service is a **name** (`session`, `model`, `tools`, …, the names rows `inject`) with any number of
//! **typed views** registered under it. A built-in registers its crate's concrete handle, which is what
//! another built-in's adapter takes to construct itself, and the [`ports`](crate::ports) view the commands
//! read. A row stays pending until every name it injects is provided, exactly as a Cordis fiber does.
//!
//! The registry is typed at runtime rather than at compile time on purpose: a profile decides which rows
//! exist, so "this profile does not load the workspace plugin" must be an answer at run time
//! (`requireWorkspace` in `src/cli.ts`), not a build error.

use std::any::{Any, TypeId};
use std::collections::HashMap;
use std::sync::Arc;

use crate::ports::{
    AgentPort, ContextPort, GoalDriverPort, GoalPort, ModelPort, SandboxPort, ServerPort,
    SessionPort, StreamPort, TeamPort, ToolsPort, WorkspacePort,
};

/// Every service a booted tree provides, by name and view type.
#[derive(Default)]
pub struct Services {
    views: HashMap<(String, TypeId), Box<dyn Any + Send + Sync>>,
}

impl std::fmt::Debug for Services {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("Services")
            .field("names", &self.names())
            .finish()
    }
}

impl Services {
    /// An empty registry.
    pub fn new() -> Self {
        Self::default()
    }

    /// Register `view` under `name`. A second view of the same type under the same name replaces the first.
    pub fn provide<T: Any + Send + Sync + Clone>(&mut self, name: &str, view: T) {
        self.views
            .insert((name.to_owned(), TypeId::of::<T>()), Box::new(view));
    }

    /// The view of type `T` registered under `name`, if any.
    pub fn get<T: Any + Send + Sync + Clone>(&self, name: &str) -> Option<T> {
        self.views
            .get(&(name.to_owned(), TypeId::of::<T>()))
            .and_then(|view| view.downcast_ref::<T>())
            .cloned()
    }

    /// Whether anything is registered under `name`: the injection gate.
    pub fn provides(&self, name: &str) -> bool {
        self.views.keys().any(|(provided, _)| provided == name)
    }

    /// The names provided, sorted and without repeats.
    pub fn names(&self) -> Vec<String> {
        let mut names: Vec<String> = self.views.keys().map(|(name, _)| name.clone()).collect();
        names.sort();
        names.dedup();
        names
    }

    /// Remove every view under `name`, as a fiber's disposal removes what it provided.
    pub fn withdraw(&mut self, name: &str) {
        self.views.retain(|(provided, _), _| provided != name);
    }

    /// `ctx.session`.
    pub fn session(&self) -> Option<Arc<dyn SessionPort>> {
        self.get("session")
    }

    /// `ctx.model`.
    pub fn model(&self) -> Option<Arc<dyn ModelPort>> {
        self.get("model")
    }

    /// `ctx.tools`.
    pub fn tools(&self) -> Option<Arc<dyn ToolsPort>> {
        self.get("tools")
    }

    /// `ctx.workspace`.
    pub fn workspace(&self) -> Option<Arc<dyn WorkspacePort>> {
        self.get("workspace")
    }

    /// `ctx.context`.
    pub fn context(&self) -> Option<Arc<dyn ContextPort>> {
        self.get("context")
    }

    /// `ctx.sandbox`.
    pub fn sandbox(&self) -> Option<Arc<dyn SandboxPort>> {
        self.get("sandbox")
    }

    /// `ctx.goal`.
    pub fn goal(&self) -> Option<Arc<dyn GoalPort>> {
        self.get("goal")
    }

    /// `ctx.goalDriver`.
    pub fn goal_driver(&self) -> Option<Arc<dyn GoalDriverPort>> {
        self.get("goalDriver")
    }

    /// `ctx.team`.
    pub fn team(&self) -> Option<Arc<dyn TeamPort>> {
        self.get("team")
    }

    /// `runTurn(ctx, …)`: composed by the boot once the services a turn needs exist, not a row.
    pub fn agent(&self) -> Option<Arc<dyn AgentPort>> {
        self.get("agent")
    }

    /// `printStream(ctx, …)`: composed by the boot from the event bus, not a row.
    pub fn stream(&self) -> Option<Arc<dyn StreamPort>> {
        self.get("stream")
    }

    /// `startWebServer(ctx, …)`: composed by the boot over every booted service, not a row.
    pub fn server(&self) -> Option<Arc<dyn ServerPort>> {
        self.get("server")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Clone, Debug, PartialEq)]
    struct Concrete(u32);

    #[test]
    fn a_view_is_found_by_name_and_type() {
        let mut services = Services::new();
        services.provide("session", Concrete(7));
        assert_eq!(services.get::<Concrete>("session"), Some(Concrete(7)));
        assert_eq!(
            services.get::<Concrete>("model"),
            None,
            "another name is another service"
        );
        assert_eq!(
            services.get::<String>("session"),
            None,
            "another type is another view"
        );
    }

    #[test]
    fn a_name_is_provided_once_any_view_is_registered() {
        let mut services = Services::new();
        assert!(!services.provides("session"));
        services.provide("session", Concrete(1));
        services.provide("session", String::from("second view"));
        assert!(services.provides("session"));
        assert_eq!(
            services.names(),
            vec!["session".to_owned()],
            "two views, one name"
        );
    }

    #[test]
    fn withdrawing_a_name_removes_every_view_of_it() {
        let mut services = Services::new();
        services.provide("session", Concrete(1));
        services.provide("session", String::from("view"));
        services.provide("model", Concrete(2));
        services.withdraw("session");
        assert!(!services.provides("session"));
        assert_eq!(
            services.get::<Concrete>("model"),
            Some(Concrete(2)),
            "other names are untouched"
        );
    }

    #[test]
    fn a_missing_port_reads_as_none_rather_than_a_panic() {
        let services = Services::new();
        assert!(
            services.workspace().is_none(),
            "requireWorkspace turns this into a sentence"
        );
        assert!(services.goal_driver().is_none());
    }
}
