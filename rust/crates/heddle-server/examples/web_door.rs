//! A minimal `web` boot for development and verifier plumbing — **not the harness**.
//!
//! `heddle web` belongs to the binary crate; this example exists so the server crate can be driven
//! as a real process (a printed URL, a token handshake, `/healthz`) before the binary wires it. It
//! composes [`Harness::unavailable`], so the door answers and every service route refuses honestly:
//! it invents no session and no answer. A verifier that needs a turn needs the real harness.
//!
//! ```sh
//! cargo build --example web -p heddle-server
//! HEDDLE_BIN="$PWD/rust/target/debug/examples/web" sh _verifiers_/90-web-ui-token/verify.sh
//! ```

use std::path::PathBuf;
use std::process::ExitCode;

use heddle_server::{DryRunPlan, Harness, ServerBuilder, ServerOptions};

fn usage() -> &'static str {
    "usage: heddle web [--host <host>] [--port <port>] [--endpoint <name>] [--max-rounds <n>]\n\
     \x20                 [--token <token>] [--session-root <dir>] [--sandbox-root <dir>]\n\
     \x20                 [--dry-run] [--json]\n\
     \n\
     The example boots the door with a Harness::unavailable profile: /healthz, the token handshake\n\
     and the page answer; a turn or a session start refuses with 'this service is not loaded yet'.\n"
}

#[tokio::main]
async fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if matches!(args.first().map(String::as_str), Some("-h" | "--help")) {
        print!("{}", usage());
        return ExitCode::SUCCESS;
    }
    if args.first().map(String::as_str) != Some("web") {
        eprint!("{}", usage());
        return ExitCode::from(2);
    }

    let mut options = ServerOptions::default();
    let mut dry_run = false;
    let mut json = false;
    let mut index = 1;
    while index < args.len() {
        match args[index].as_str() {
            "--host" => {
                options.host = args.get(index + 1).cloned();
                index += 2;
            }
            "--port" => {
                options.port = args.get(index + 1).and_then(|port| port.parse().ok());
                index += 2;
            }
            "--endpoint" => {
                options.default_endpoint = args.get(index + 1).cloned();
                index += 2;
            }
            "--max-rounds" => {
                options.max_rounds = args.get(index + 1).and_then(|rounds| rounds.parse().ok());
                index += 2;
            }
            "--token" => {
                options.token = args.get(index + 1).cloned();
                index += 2;
            }
            // The boot's own concerns, accepted so the same command line reaches this example and
            // the binary; the door-only harness has nothing to read them with.
            "--session-root" | "--sandbox-root" | "--config" | "--patch" | "--secret-path" => {
                if args[index].as_str() == "--secret-path" {
                    options.secret_path = args.get(index + 1).map(PathBuf::from);
                }
                index += 2;
            }
            "--dry-run" => {
                dry_run = true;
                index += 1;
            }
            "--json" => {
                json = true;
                index += 1;
            }
            other => {
                eprintln!("heddle web: unknown option {other}");
                return ExitCode::from(2);
            }
        }
    }

    // `/vendor/purify.js` is found under the repository and the working directory.
    options.asset_roots = vec![
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../.."),
        std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")),
    ];

    if dry_run {
        let plan = DryRunPlan::for_options(&options);
        if json {
            println!(
                "{}",
                serde_json::to_string(&plan).expect("the plan is serializable")
            );
        } else {
            println!("{}", plan.announce());
        }
        return ExitCode::SUCCESS;
    }

    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let server = match ServerBuilder::new(Harness::unavailable(cwd), options)
        .start()
        .await
    {
        Ok(server) => server,
        Err(error) => {
            eprintln!("heddle web: {error}");
            return ExitCode::from(2);
        }
    };
    for line in server.announce() {
        println!("{line}");
    }
    if json {
        println!("{}", server.announce_json());
    }
    let _ = tokio::signal::ctrl_c().await;
    server.close().await;
    ExitCode::SUCCESS
}
