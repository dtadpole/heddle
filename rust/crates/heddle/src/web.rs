//! `heddle web`: the server over the booted tree — `heddle-server`'s entry point, given the harness.
//!
//! The command boots the tree the command line names and refuses a tree with an entry still pending
//! (the TypeScript build's one check before serving), reports each row it could not start, then hands
//! `heddle_server::command::run` the [`Harness`] and serves until SIGINT or SIGTERM.
//!
//! The harness takes each service the boot provided — the session store through `heddle-server`'s own
//! adapter, the model and the sandbox through the small views below — and keeps the server's
//! *unavailable* stand-in for every service not composed yet, which answers an empty list or the
//! sentence naming the missing service, never an invented session or answer.

use std::path::PathBuf;
use std::sync::Arc;

use heddle_server::Harness;
use heddle_server::services::{
    ModelService as ServerModels, SandboxService as ServerSandbox, ServiceError, TurnOutcome,
    TurnRequest, TurnRunner,
};
use serde_json::Value;

use crate::boot::Boot;
use crate::cli::Args;
use crate::output::Output;
use crate::{Exit, Invocation};

/// The harness a booted tree gives the server.
pub fn harness(boot: &Boot, cwd: PathBuf) -> Harness {
    let mut harness = Harness::unavailable(cwd);
    if let Some(sessions) = boot
        .services
        .get::<Arc<heddle_session::SessionService>>("session")
    {
        harness.sessions = Arc::new(heddle_server::adapters::StoreSessions::new(
            heddle_session::SessionService::from_store(Arc::clone(sessions.store())),
        ));
    }
    if let (Some(runtime), Some(sessions)) = (
        boot.services
            .get::<Arc<heddle_agent::AgentRuntime>>("agent-runtime")
            .or_else(|| {
                crate::runtime::agent_runtime(&boot.services)
                    .ok()
                    .map(Arc::new)
            }),
        boot.services
            .get::<Arc<heddle_session::SessionService>>("session"),
    ) {
        harness.turns = Arc::new(Turns { runtime, sessions });
    }
    if let Some(service) = boot.services.get::<Arc<heddle_llm::ModelService>>("model") {
        harness.models = Arc::new(Models { service });
    }
    if let Some(service) = boot
        .services
        .get::<Arc<heddle_sandbox::SandboxService>>("sandbox")
    {
        harness.sandbox = Arc::new(Sandbox { service });
    }
    harness
}

/// Where the page's vendored assets are looked for: the base layer's directory and the working one.
pub fn asset_roots(anchor: &std::path::Path, cwd: &std::path::Path) -> Vec<PathBuf> {
    let mut roots = vec![anchor.to_path_buf()];
    if cwd != anchor {
        roots.push(cwd.to_path_buf());
    }
    roots
}

/// `heddle web`.
pub fn web(args: &Args, invocation: &Invocation, boot: Boot, out: &mut Output<'_>) -> Exit {
    let pending = crate::boot::settle(&boot);
    if !pending.is_empty() {
        boot.dispose();
        return out.fail(&format!(
            "{} entr(y/ies) are still pending: {}",
            pending.len(),
            pending.join(", ")
        ));
    }
    for (id, name) in crate::boot::failed_entries(&boot) {
        out.err(&format!("heddle web: row '{id}' ({name}) did not load\n"));
    }
    let harness = harness(&boot, invocation.cwd.clone());
    let shutdown = heddle_tools::CancellationToken::new();
    let context = heddle_server::command::Context {
        cwd: invocation.cwd.clone(),
        harness: &harness,
        events: None,
        routers: Vec::new(),
        views: Vec::new(),
        asset_roots: asset_roots(&boot.anchor, &invocation.cwd),
        secret_path: Some(heddle_config::heddle_home(&invocation.env).join("web-secret")),
        notes: Vec::new(),
        shutdown: shutdown.clone(),
    };
    let web_args = heddle_server::command::Args {
        host: args.host.clone(),
        port: args.port,
        endpoint: args.endpoint.clone(),
        max_rounds: args.max_rounds,
        dry_run: args.dry_run,
        json: args.json,
    };
    let runtime = crate::runtime::tokio();
    // The only honest lifetime for a server: until it is interrupted.
    runtime.spawn(async move {
        wait_for_stop().await;
        shutdown.cancel();
    });
    let (stdout, stderr) = out.writers();
    let code = runtime.block_on(heddle_server::command::run(
        heddle_server::command::Command::Web,
        &web_args,
        &context,
        stdout,
        stderr,
    ));
    boot.dispose();
    if code == 0 {
        Exit::Success
    } else {
        Exit::Failure
    }
}

/// Resolve on SIGINT or SIGTERM, whichever comes first.
async fn wait_for_stop() {
    use tokio::signal::unix::{SignalKind, signal};
    let (Ok(mut interrupt), Ok(mut terminate)) = (
        signal(SignalKind::interrupt()),
        signal(SignalKind::terminate()),
    ) else {
        let _ = tokio::signal::ctrl_c().await;
        return;
    };
    tokio::select! {
        _ = interrupt.recv() => {}
        _ = terminate.recv() => {}
    }
}

/// A turn the page posts, on the run's shared agent runtime: the session's events reach the page through
/// the store's listener, and the request's token is the turn's, so `/stop` cancels exactly it.
struct Turns {
    runtime: Arc<heddle_agent::AgentRuntime>,
    sessions: Arc<heddle_session::SessionService>,
}

impl TurnRunner for Turns {
    fn run_turn(
        &self,
        request: TurnRequest,
    ) -> futures::future::BoxFuture<'static, Result<TurnOutcome, ServiceError>> {
        let runtime = Arc::clone(&self.runtime);
        let sessions = Arc::clone(&self.sessions);
        Box::pin(async move {
            let handle = sessions
                .open(&request.session)
                .ok_or_else(|| ServiceError::new(format!("no session '{}'", request.session)))?;
            let mut options =
                heddle_agent::RunTurnOptions::new(handle, request.endpoint, request.prompt);
            options.attachments = request
                .attachments
                .into_iter()
                .filter_map(|part| serde_json::from_value(part).ok())
                .collect();
            options.model = request.model;
            options.reasoning_effort = request.reasoning_effort;
            // The page's rule is DSH's: no round cap unless the server was started with one.
            options.max_rounds = match request.max_rounds {
                Some(rounds) => heddle_agent::RoundLimit::Rounds(rounds),
                None => heddle_agent::RoundLimit::Unbounded,
            };
            options.cancel = Some(request.cancel);
            let result = heddle_agent::run_turn(&runtime, options)
                .await
                .map_err(|error| ServiceError::new(error.to_string()))?;
            Ok(TurnOutcome {
                text: result.text,
                finish_reason: result.finish_reason,
                rounds: u64::from(result.rounds),
                denials: result
                    .denials
                    .iter()
                    .filter_map(|denial| serde_json::to_value(denial).ok())
                    .collect(),
                ended: Some(result.ended),
                usage: serde_json::to_value(result.usage).ok(),
            })
        })
    }
}

/// The server's view of `heddle-llm`'s service.
struct Models {
    service: Arc<heddle_llm::ModelService>,
}

impl ServerModels for Models {
    fn names(&self) -> Vec<String> {
        self.service.names()
    }

    fn default_endpoint(&self) -> Option<String> {
        self.service.nominated()
    }

    fn declares_level(&self, endpoint: &str, model: Option<&str>, effort: &str) -> bool {
        self.service
            .endpoint(endpoint)
            .and_then(|config| config.reasoning_level_for(model, effort))
            .is_some()
    }
}

/// The server's view of `heddle-sandbox`'s service.
struct Sandbox {
    service: Arc<heddle_sandbox::SandboxService>,
}

impl ServerSandbox for Sandbox {
    fn default_mode(&self) -> String {
        self.service.mode().to_string()
    }

    fn workspace_root(&self) -> String {
        self.service.workspace_root().display().to_string()
    }

    fn transition(
        &self,
        current: &str,
        requested: Option<&Value>,
        confirm: Option<&Value>,
    ) -> Result<String, String> {
        let current = heddle_sandbox::SandboxMode::parse(current).unwrap_or(self.service.mode());
        heddle_sandbox::permission_transition(current, requested, confirm)
            .map(|change| change.mode.to_string())
            .map_err(|refusal| refusal.reason().to_owned())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::Services;
    use serde_json::json;

    fn empty_boot() -> Boot {
        Boot {
            rows: Vec::new(),
            entries: Vec::new(),
            services: Services::new(),
            anchor: PathBuf::from("/repo"),
        }
    }

    #[test]
    fn the_asset_roots_are_the_checkout_then_the_working_directory() {
        assert_eq!(
            asset_roots(std::path::Path::new("/repo"), std::path::Path::new("/work")),
            vec![PathBuf::from("/repo"), PathBuf::from("/work")]
        );
        assert_eq!(
            asset_roots(std::path::Path::new("/repo"), std::path::Path::new("/repo")),
            vec![PathBuf::from("/repo")]
        );
    }

    #[test]
    fn a_tree_with_a_pending_entry_is_refused_before_serving() {
        let mut boot = empty_boot();
        boot.entries.push(crate::boot::Entry {
            id: "announce".to_owned(),
            name: "./src/plugins/announce.ts".to_owned(),
            component: crate::builtins::ComponentRef::Unresolved("announce".to_owned()),
            requires: vec!["greeting".to_owned()],
            state: crate::boot::FiberState::Pending,
            error: None,
        });
        let mut captured = crate::output::Captured::default();
        let invocation = Invocation {
            argv: Vec::new(),
            env: heddle_config::Env::default(),
            cwd: PathBuf::from("/repo"),
        };
        let argv: Vec<String> = ["web", "--dry-run"]
            .iter()
            .map(|w| (*w).to_owned())
            .collect();
        let args = crate::cli::parse_args(&argv).expect("parses");
        let exit = {
            let mut out = captured.output();
            web(&args, &invocation, boot, &mut out)
        };
        assert_eq!(exit, Exit::Failure);
        assert_eq!(
            captured.stderr_text(),
            "heddle: 1 entr(y/ies) are still pending: announce\n"
        );
    }

    #[test]
    fn the_harness_takes_the_model_and_sandbox_the_boot_provided() {
        let mut services = Services::new();
        let models = heddle_llm::ModelService::from_configuration(
            heddle_config::default_endpoints(),
            Some("scripted"),
        )
        .expect("the offline default composes");
        services.provide("model", Arc::new(models));
        let host = heddle_sandbox::SandboxHost {
            cwd: PathBuf::from("/work"),
            harness_home: PathBuf::from("/home/.heddle"),
            platform: heddle_sandbox::Platform::current(),
        };
        let config = heddle_sandbox::SandboxConfig {
            mode: heddle_sandbox::SandboxMode::ReadOnly,
            ..heddle_sandbox::SandboxConfig::default()
        };
        services.provide(
            "sandbox",
            Arc::new(heddle_sandbox::SandboxService::new(&config, &host)),
        );
        let mut boot = empty_boot();
        boot.services = services;
        let harness = harness(&boot, PathBuf::from("/work"));
        assert_eq!(harness.models.names(), vec!["scripted".to_owned()]);
        assert_eq!(harness.sandbox.default_mode(), "read-only");
        assert_eq!(
            harness
                .sandbox
                .transition("read-only", Some(&json!("workspace-write")), None),
            Ok("workspace-write".to_owned())
        );
        assert!(
            harness
                .sandbox
                .transition("read-only", Some(&json!("danger-full-access")), None)
                .is_err(),
            "full access needs the confirmation"
        );
    }
}
