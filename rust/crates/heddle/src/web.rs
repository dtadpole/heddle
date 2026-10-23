//! `heddle web`: the server over the booted tree. Port of `runWeb` in `src/cli.ts`.
//!
//! The command boots the tree the command line names, refuses a tree with an entry still pending (the
//! TypeScript build's one check before serving), and then either prints the plan (`--dry-run`) or
//! starts `heddle-server` and serves until SIGINT or SIGTERM.
//!
//! The server takes a [`Harness`]: the services a route calls. It is assembled from what the boot
//! provided — the model and sandbox rows through their adapters — and every service the boot did not
//! provide is the server's own *unavailable* stand-in, which answers an empty list or the sentence
//! naming the missing service, never an invented session or answer. As each crate's adapter lands, its
//! service replaces the stand-in here and nothing else changes.

use std::path::PathBuf;
use std::sync::Arc;

use heddle_server::services::{ModelService as ServerModels, SandboxService as ServerSandbox};
use heddle_server::{DryRunPlan, Harness, ServerBuilder, ServerOptions};
use serde_json::Value;

use crate::boot::Boot;
use crate::cli::Args;
use crate::output::Output;
use crate::{Exit, Invocation};

/// The server's options from the command line: port of the option object `runWeb` builds.
pub fn server_options(args: &Args, asset_roots: Vec<PathBuf>) -> ServerOptions {
    ServerOptions {
        host: args.host.clone(),
        port: args.port,
        max_rounds: args.max_rounds,
        default_endpoint: args.endpoint.clone(),
        asset_roots,
        ..ServerOptions::default()
    }
}

/// Where the page's vendored assets are looked for: the base layer's directory (a checkout's own
/// `cordis.yml` sits at its root) and the working directory, without repeats.
pub fn asset_roots(anchor: &std::path::Path, cwd: &std::path::Path) -> Vec<PathBuf> {
    let mut roots = vec![anchor.to_path_buf()];
    if cwd != anchor {
        roots.push(cwd.to_path_buf());
    }
    roots
}

/// The harness a booted tree gives the server: each service the boot provided, the server's
/// unavailable stand-in for each it did not.
pub fn harness(boot: &Boot, cwd: PathBuf) -> Harness {
    let mut harness = Harness::unavailable(cwd);
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

/// The lines `--dry-run` prints: the plan, and with `--json` the plan as one compact object, which is
/// what `JSON.stringify` (with no indent) writes.
pub fn dry_run_lines(plan: &DryRunPlan, json: bool) -> String {
    let mut text = format!("{}\n", plan.announce());
    if json {
        text.push_str(&serde_json::to_string(plan).unwrap_or_default());
        text.push('\n');
    }
    text
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
    // A row this build cannot start yet is reported, as the TypeScript loader logs a plugin that failed,
    // and the server still starts: its routes answer for that service with the sentence naming it.
    for entry in boot
        .entries
        .iter()
        .filter(|entry| entry.state == crate::boot::FiberState::Failed)
    {
        out.err(&format!(
            "heddle web: row '{}' ({}) did not load: {}\n",
            entry.id,
            entry.name,
            entry.error.as_deref().unwrap_or("its start was refused")
        ));
    }

    let options = server_options(args, asset_roots(&boot.anchor, &invocation.cwd));
    if args.dry_run {
        out.out(&dry_run_lines(
            &DryRunPlan::for_options(&options),
            args.json,
        ));
        boot.dispose();
        return Exit::Success;
    }

    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            boot.dispose();
            return out.fail(&format!("cannot start the server's runtime: {error}"));
        }
    };
    let harness = harness(&boot, invocation.cwd.clone());
    let exit = runtime.block_on(async {
        let server = match ServerBuilder::new(harness, options).start().await {
            Ok(server) => server,
            Err(error) => return out.fail(&error.to_string()),
        };
        let [url_line, serving_line] = server.announce();
        out.out(&format!("{url_line}\n{serving_line}\n"));
        if args.json {
            out.out(&format!("{}\n", server.announce_json()));
        }
        out.flush();
        // Run until interrupted, which is the only honest lifetime for a server.
        wait_for_stop().await;
        server.close().await;
        Exit::Success
    });
    boot.dispose();
    exit
}

/// Resolve on SIGINT or SIGTERM, whichever comes first.
async fn wait_for_stop() {
    #[cfg(unix)]
    {
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
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
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
        requested: &Value,
        confirm: &Value,
    ) -> Result<String, String> {
        // An absent body field arrives as `null`; the crate reads it as absent, which is what its
        // sentence names (`'undefined' is not one of ...`).
        let present = |value: &Value| (!value.is_null()).then(|| value.clone());
        let current = heddle_sandbox::SandboxMode::parse(current).unwrap_or(self.service.mode());
        heddle_sandbox::permission_transition(
            current,
            present(requested).as_ref(),
            present(confirm).as_ref(),
        )
        .map(|change| change.mode.to_string())
        .map_err(|refusal| refusal.reason().to_owned())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::boot::Boot;
    use crate::services::Services;
    use serde_json::json;

    fn args(list: &[&str]) -> Args {
        let argv: Vec<String> = list.iter().map(|word| (*word).to_owned()).collect();
        crate::cli::parse_args(&argv).expect("the command line parses")
    }

    fn empty_boot() -> Boot {
        Boot {
            rows: Vec::new(),
            entries: Vec::new(),
            services: Services::new(),
            anchor: PathBuf::from("/repo"),
        }
    }

    #[test]
    fn the_flags_become_the_servers_options() {
        let options = server_options(
            &args(&[
                "web",
                "--host",
                "127.0.0.1",
                "--port",
                "0",
                "--max-rounds",
                "4",
                "--endpoint",
                "double",
            ]),
            vec![PathBuf::from("/repo")],
        );
        assert_eq!(options.host(), "127.0.0.1");
        assert_eq!(options.port(), 0, "0 asks for an ephemeral port");
        assert_eq!(options.max_rounds, Some(4));
        assert_eq!(options.default_endpoint.as_deref(), Some("double"));
        assert_eq!(options.asset_roots, vec![PathBuf::from("/repo")]);
        assert!(options.token.is_none(), "the token is minted at start");
    }

    #[test]
    fn without_a_port_the_documented_default_is_planned() {
        let options = server_options(&args(&["web"]), Vec::new());
        assert_eq!(options.port(), 3082);
        assert_eq!(options.host(), "127.0.0.1");
    }

    #[test]
    fn a_dry_run_prints_the_plan_and_its_compact_json() {
        let plan = DryRunPlan::for_options(&server_options(&args(&["web"]), Vec::new()));
        let text = dry_run_lines(&plan, true);
        let mut lines = text.lines();
        assert_eq!(
            lines.next(),
            Some("heddle web: would serve http://127.0.0.1:3082/?token=generated-at-start")
        );
        let value: Value =
            serde_json::from_str(lines.next().expect("the JSON line")).expect("one JSON object");
        assert_eq!(
            value,
            json!({
                "url": "http://127.0.0.1:3082/?token=generated-at-start",
                "host": "127.0.0.1",
                "port": 3082,
                "dryRun": true,
            })
        );
        assert!(
            !text.lines().nth(1).unwrap_or_default().contains('\n'),
            "the JSON is one line"
        );
        assert_eq!(lines.next(), None);
        assert_eq!(dry_run_lines(&plan, false).lines().count(), 1);
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
    fn a_dry_run_through_the_command_prints_without_binding() {
        let mut captured = crate::output::Captured::default();
        let invocation = Invocation {
            argv: Vec::new(),
            env: heddle_config::Env::default(),
            cwd: PathBuf::from("/repo"),
        };
        let exit = {
            let mut out = captured.output();
            web(
                &args(&["web", "--dry-run", "--port", "3099", "--json"]),
                &invocation,
                empty_boot(),
                &mut out,
            )
        };
        assert_eq!(exit, Exit::Success);
        let stdout = captured.stdout_text();
        assert!(
            stdout.starts_with(
                "heddle web: would serve http://127.0.0.1:3099/?token=generated-at-start\n"
            ),
            "{stdout}"
        );
        assert!(stdout.contains("\"dryRun\":true"), "{stdout}");
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
        let exit = {
            let mut out = captured.output();
            web(&args(&["web", "--dry-run"]), &invocation, boot, &mut out)
        };
        assert_eq!(exit, Exit::Failure);
        assert_eq!(
            captured.stderr_text(),
            "heddle: 1 entr(y/ies) are still pending: announce\n"
        );
        assert!(captured.stdout.is_empty());
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
        assert_eq!(
            harness.models.default_endpoint(),
            Some("scripted".to_owned())
        );
        assert!(!harness.models.declares_level("scripted", None, "high"));
        assert_eq!(harness.sandbox.default_mode(), "read-only");
        assert_eq!(
            harness
                .sandbox
                .transition("read-only", &json!("workspace-write"), &Value::Null),
            Ok("workspace-write".to_owned())
        );
        assert!(
            harness
                .sandbox
                .transition("read-only", &json!("danger-full-access"), &Value::Null)
                .is_err(),
            "full access needs the confirmation"
        );
        assert_eq!(
            harness
                .sandbox
                .transition("read-only", &Value::Null, &Value::Null),
            Err(
                "'undefined' is not one of read-only, workspace-write, danger-full-access"
                    .to_owned()
            )
        );
    }

    #[test]
    fn a_service_the_boot_did_not_provide_stays_the_servers_stand_in() {
        let harness = harness(&empty_boot(), PathBuf::from("/work"));
        assert!(harness.models.names().is_empty());
        assert!(harness.workspaces.is_none());
        assert_eq!(harness.cwd, PathBuf::from("/work"));
    }
}
