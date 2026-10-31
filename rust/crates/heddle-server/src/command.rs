//! `heddle web`'s entry point, in the owning crate (D-043).
//!
//! The binary keeps the command line, the gated help, the boot and the dispatch; this module is the
//! behaviour of `web`, ported from `runWeb` in `src/cli.ts`. It reads no process globals: the binary
//! passes the composed [`Harness`], the working directory, the feature routers and a shutdown token in
//! [`Context`], and every line is written to the `out` and `err` it is handed.
//!
//! What it prints, byte for byte as the TypeScript build does:
//!
//! - `--dry-run`: `heddle web: would serve <url>` with the placeholder token, then, with `--json`, the
//!   compact `{"url","host","port","dryRun":true}`. Nothing is bound.
//! - a start: any boot notes the binary passes (team recovery, goal resumption), then
//!   `heddle web: <url>` — the line the verifiers wait for — and
//!   `heddle web: serving on <host>:<port>; pass --port to change it`, then, with `--json`, the compact
//!   `{"url","host","port","token"}`. It serves until the shutdown token is cancelled, then closes.
//! - a failure (a non-loopback host, a port that cannot be bound, an unreadable secret):
//!   `heddle: <sentence>` on `err`, exit `1`.

use std::io::Write;
use std::path::PathBuf;
use std::sync::Arc;

use tokio_util::sync::CancellationToken;

use crate::server::{DryRunPlan, ServerBuilder, ServerOptions, SessionView};
use crate::services::Harness;
use crate::stream::EventHub;

/// The command words this crate answers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Command {
    /// `heddle web`.
    Web,
}

/// The flags `web` reads, named after the TypeScript `Args` fields.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Args {
    /// `--host`; `127.0.0.1` when absent. Anything that is not loopback is refused.
    pub host: Option<String>,
    /// `--port`; `3082` when absent, `0` for any free port.
    pub port: Option<u16>,
    /// `--endpoint`: the endpoint a turn uses when neither the request nor the session names one.
    pub endpoint: Option<String>,
    /// `--max-rounds`: a cap on one interactive turn; unbounded when absent.
    pub max_rounds: Option<u32>,
    /// `--dry-run`: print what would be served and bind nothing.
    pub dry_run: bool,
    /// `--json`: add the machine-readable line.
    pub json: bool,
}

/// What `web` runs against, composed by the binary.
pub struct Context<'a> {
    /// The process's working directory.
    pub cwd: PathBuf,
    /// The services the routes call. [`Harness::unavailable`] serves the door before the real
    /// adapters exist; a `--dry-run` never consults it.
    pub harness: &'a Harness,
    /// The hub the session store was given its listener over (see
    /// [`crate::adapters::session_event_listener`]); `None` lets the server create its own.
    pub events: Option<EventHub>,
    /// Feature routers whose state is already applied (`heddle-web-files`, `heddle-web-composer`,
    /// `heddle-web-trajectory`), mounted behind the door with [`ServerBuilder::mount_router`].
    pub routers: Vec<axum::Router>,
    /// `?view=<name>` projections of `GET /api/sessions/{id}`, e.g. `("ledger", view)`.
    pub views: Vec<(String, Arc<dyn SessionView>)>,
    /// Where `/vendor/purify.js` is looked for (the repository root and the working directory).
    pub asset_roots: Vec<PathBuf>,
    /// The cookie-signing secret's path, `<heddle home>/web-secret` as the boot's environment resolves
    /// it (`token::secret_path_for`). Pass it: `None` falls back to the server reading `HEDDLE_HOME` and
    /// `HOME` from the process itself.
    pub secret_path: Option<PathBuf>,
    /// Lines the boot reports once the server is up and before the URL (team recovery, goal
    /// resumption), each written as `heddle web: <line>`.
    pub notes: Vec<String>,
    /// Cancelled by the binary on SIGINT or SIGTERM; the server then closes, streams and all.
    pub shutdown: CancellationToken,
}

/// Run `command`. Returns the process exit code: `0` done, `1` with `heddle: <sentence>` on `err`.
pub async fn run(
    command: Command,
    args: &Args,
    context: &Context<'_>,
    out: &mut dyn Write,
    err: &mut dyn Write,
) -> i32 {
    match command {
        Command::Web => web(args, context, out, err).await,
    }
}

/// The server options `web`'s flags and context describe.
pub fn options_for(args: &Args, context: &Context<'_>) -> ServerOptions {
    ServerOptions {
        host: args.host.clone(),
        port: args.port,
        max_rounds: args.max_rounds,
        secret_path: context.secret_path.clone(),
        token: None,
        default_endpoint: args.endpoint.clone(),
        asset_roots: context.asset_roots.clone(),
    }
}

/// Write a line, reporting a closed stream as a failure of the command rather than a panic.
fn line(stream: &mut dyn Write, text: &str) -> std::io::Result<()> {
    stream.write_all(text.as_bytes())?;
    stream.write_all(b"\n")?;
    stream.flush()
}

async fn web(args: &Args, context: &Context<'_>, out: &mut dyn Write, err: &mut dyn Write) -> i32 {
    let options = options_for(args, context);

    if args.dry_run {
        let plan = DryRunPlan::for_options(&options);
        let mut written = line(out, &plan.announce());
        if written.is_ok() && args.json {
            let json = serde_json::to_string(&plan).expect("the plan is serializable");
            written = line(out, &json);
        }
        return if written.is_ok() { 0 } else { 1 };
    }

    let mut builder = ServerBuilder::new(context.harness.clone(), options);
    if let Some(hub) = context.events.clone() {
        builder = builder.with_event_hub(hub);
    }
    for router in &context.routers {
        builder = builder.mount_router(router.clone());
    }
    for (name, view) in &context.views {
        builder = builder.session_view(name.clone(), Arc::clone(view));
    }

    let server = match builder.start().await {
        Ok(server) => server,
        Err(error) => {
            let _ = line(err, &format!("heddle: {error}"));
            return 1;
        }
    };

    let mut lines: Vec<String> = context
        .notes
        .iter()
        .map(|note| format!("heddle web: {note}"))
        .collect();
    lines.extend(server.announce());
    if args.json {
        lines.push(server.announce_json());
    }
    for text in &lines {
        if line(out, text).is_err() {
            server.close().await;
            return 1;
        }
    }

    context.shutdown.cancelled().await;
    server.close().await;
    0
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// A folder a test made under the system temp dir, removed when it is dropped.
    struct TempFolder(PathBuf);

    impl Drop for TempFolder {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    thread_local! {
        /// The temp folders of the test on this thread, dropped (and removed) when the test's thread ends, after a
        /// panic too; see server.rs's `temp_secret`.
        static TEMP_FOLDERS: std::cell::RefCell<Vec<TempFolder>> = const { std::cell::RefCell::new(Vec::new()) };
    }

    fn secret(label: &str) -> PathBuf {
        let folder = std::env::temp_dir().join(format!(
            "heddle-command-{label}-{}-{}",
            std::process::id(),
            crate::token::now_ms()
        ));
        TEMP_FOLDERS.with(|folders| folders.borrow_mut().push(TempFolder(folder.clone())));
        folder.join("web-secret")
    }

    fn context<'a>(harness: &'a Harness, label: &str) -> Context<'a> {
        Context {
            cwd: PathBuf::from("/work"),
            harness,
            events: None,
            routers: Vec::new(),
            views: Vec::new(),
            asset_roots: Vec::new(),
            secret_path: Some(secret(label)),
            notes: Vec::new(),
            shutdown: CancellationToken::new(),
        }
    }

    async fn run_to_end(args: &Args, context: &Context<'_>) -> (i32, String, String) {
        let mut out = Vec::new();
        let mut err = Vec::new();
        let code = run(Command::Web, args, context, &mut out, &mut err).await;
        (
            code,
            String::from_utf8(out).unwrap(),
            String::from_utf8(err).unwrap(),
        )
    }

    #[tokio::test]
    async fn a_dry_run_names_the_default_port_and_binds_nothing() {
        let harness = Harness::unavailable(PathBuf::from("/work"));
        let ctx = context(&harness, "dry");
        let (code, out, err) = run_to_end(
            &Args {
                dry_run: true,
                ..Args::default()
            },
            &ctx,
        )
        .await;
        assert_eq!(code, 0);
        assert_eq!(err, "");
        assert_eq!(
            out,
            "heddle web: would serve http://127.0.0.1:3082/?token=generated-at-start\n"
        );
    }

    #[tokio::test]
    async fn a_json_dry_run_adds_the_compact_plan() {
        let harness = Harness::unavailable(PathBuf::from("/work"));
        let ctx = context(&harness, "dry-json");
        let (code, out, _) = run_to_end(
            &Args {
                dry_run: true,
                json: true,
                host: Some("127.0.0.1".into()),
                endpoint: Some("double".into()),
                ..Args::default()
            },
            &ctx,
        )
        .await;
        assert_eq!(code, 0);
        let lines: Vec<&str> = out.lines().collect();
        assert_eq!(lines.len(), 2, "{out}");
        assert_eq!(
            lines[1],
            r#"{"url":"http://127.0.0.1:3082/?token=generated-at-start","host":"127.0.0.1","port":3082,"dryRun":true}"#
        );
        // 80-web-ui reads the plan with JSON.parse and asserts the documented port.
        let plan: serde_json::Value = serde_json::from_str(lines[1]).unwrap();
        assert_eq!(plan["port"], 3082);
        assert!(plan["url"].as_str().unwrap().contains(":3082/"));
    }

    #[tokio::test]
    async fn a_non_loopback_host_is_refused_with_the_typescript_sentence() {
        let harness = Harness::unavailable(PathBuf::from("/work"));
        let ctx = context(&harness, "bind-refused");
        let (code, out, err) = run_to_end(
            &Args {
                host: Some("0.0.0.0".into()),
                port: Some(0),
                ..Args::default()
            },
            &ctx,
        )
        .await;
        assert_eq!(code, 1);
        assert_eq!(out, "");
        assert_eq!(
            err,
            "heddle: refusing to bind 0.0.0.0: the Web UI runs tools, so exposing it is remote code execution behind a token. Use 127.0.0.1.\n"
        );
    }

    #[tokio::test]
    async fn a_port_already_taken_is_a_failure_not_a_hang() {
        let taken = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = taken.local_addr().unwrap().port();
        let harness = Harness::unavailable(PathBuf::from("/work"));
        let ctx = context(&harness, "taken");
        let (code, out, err) = run_to_end(
            &Args {
                port: Some(port),
                ..Args::default()
            },
            &ctx,
        )
        .await;
        assert_eq!(code, 1);
        assert_eq!(out, "");
        assert!(
            err.starts_with("heddle: cannot listen on 127.0.0.1:"),
            "{err}"
        );
    }

    /// A writer the test can read while `run` still holds it.
    #[derive(Clone, Default)]
    struct Shared(Arc<Mutex<Vec<u8>>>);

    impl Write for Shared {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    impl Shared {
        fn text(&self) -> String {
            String::from_utf8(self.0.lock().unwrap().clone()).unwrap()
        }
    }

    /// One raw HTTP/1.1 GET, because the verifiers reach the server over a socket.
    async fn get(port: u16, path: &str) -> String {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .unwrap();
        let request =
            format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
        stream.write_all(request.as_bytes()).await.unwrap();
        let mut buffer = Vec::new();
        let _ = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            stream.read_to_end(&mut buffer),
        )
        .await;
        String::from_utf8_lossy(&buffer).into_owned()
    }

    #[tokio::test]
    async fn a_start_announces_the_url_serves_and_stops_on_shutdown() {
        let harness = Harness::unavailable(PathBuf::from("/work"));
        let mut ctx = context(&harness, "start");
        ctx.notes = vec!["recovered 1 team(s) (1 settled, 0 delivered)".into()];
        let shutdown = ctx.shutdown.clone();
        let args = Args {
            port: Some(0),
            endpoint: Some("double".into()),
            json: true,
            ..Args::default()
        };
        let out = Shared::default();
        let err = Shared::default();
        let (mut out_writer, mut err_writer) = (out.clone(), err.clone());

        let serving = run(Command::Web, &args, &ctx, &mut out_writer, &mut err_writer);
        let control = async {
            // Wait for the line 80 and 90 wait for: /heddle web: (http:\/\/\S+)/.
            let url = loop {
                if let Some(url) = out
                    .text()
                    .lines()
                    .find_map(|line| line.strip_prefix("heddle web: http://"))
                {
                    break format!("http://{url}");
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            };
            let port: u16 = url
                .trim_start_matches("http://127.0.0.1:")
                .split('/')
                .next()
                .unwrap()
                .parse()
                .unwrap();
            let health = get(port, "/healthz").await;
            assert!(health.starts_with("HTTP/1.1 200"), "{health}");
            assert!(health.contains(&format!("\"port\":{port}")), "{health}");
            let refused = get(port, "/api/sessions").await;
            assert!(refused.starts_with("HTTP/1.1 401"), "{refused}");
            shutdown.cancel();
            url
        };
        let (code, url) = tokio::join!(serving, control);
        assert_eq!(code, 0);
        assert_eq!(err.text(), "");

        let text = out.text();
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines.len(), 4, "{text}");
        assert_eq!(
            lines[0],
            "heddle web: recovered 1 team(s) (1 settled, 0 delivered)"
        );
        assert_eq!(lines[1], format!("heddle web: {url}"));
        assert!(url.contains("/?token="), "{url}");
        assert!(
            lines[2].starts_with("heddle web: serving on 127.0.0.1:")
                && lines[2].ends_with("; pass --port to change it"),
            "{}",
            lines[2]
        );
        let announced: serde_json::Value = serde_json::from_str(lines[3]).unwrap();
        assert_eq!(announced["url"], url.as_str());
        assert_eq!(announced["host"], "127.0.0.1");
        assert!(
            announced["token"]
                .as_str()
                .is_some_and(|token| token.len() == 43)
        );
    }

    #[test]
    fn the_flags_become_the_server_options() {
        let harness = Harness::unavailable(PathBuf::from("/work"));
        let mut ctx = context(&harness, "options");
        ctx.asset_roots = vec![PathBuf::from("/repo")];
        let options = options_for(
            &Args {
                host: Some("localhost".into()),
                port: Some(4000),
                endpoint: Some("double".into()),
                max_rounds: Some(3),
                ..Args::default()
            },
            &ctx,
        );
        assert_eq!(options.host(), "localhost");
        assert_eq!(options.port(), 4000);
        assert_eq!(options.default_endpoint.as_deref(), Some("double"));
        assert_eq!(options.max_rounds, Some(3));
        assert_eq!(options.asset_roots, vec![PathBuf::from("/repo")]);
        assert_eq!(
            options.token, None,
            "the launch token is minted per process"
        );
    }
}
