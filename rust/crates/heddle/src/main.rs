//! `heddle` — the Rust port of the harness.
//!
//! The contract is the TypeScript build's: the same command line, the same HTTP routes and the same
//! session log, judged by the verifiers under `_verifiers_/` with `HEDDLE_BIN` pointing here
//! (`rust/ULTIMATE_GOAL.md`). This file is only the process shell: it hands the library the
//! arguments, the environment, the working directory and the two streams, and turns the [`Exit`] it
//! returns into a process exit code. Every command lives in the library, where a unit test runs it
//! in-process against a captured [`Output`].

use std::io::Write;
use std::process::ExitCode;

use heddle::output::Output;
use heddle::{Env, Invocation, run};

fn main() -> ExitCode {
    let invocation = Invocation {
        argv: std::env::args().skip(1).collect(),
        env: Env::from_process(),
        cwd: std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("/")),
    };
    let mut stdout = std::io::stdout();
    let mut stderr = std::io::stderr();
    let exit = {
        let mut out = Output::new(&mut stdout, &mut stderr);
        run(&invocation, &mut out)
    };
    // The library reports a closed pipe as no error; a failed flush is no worse than that.
    let _ = stdout.flush();
    let _ = stderr.flush();
    ExitCode::from(exit.code())
}

#[cfg(test)]
mod tests {
    use super::*;
    use heddle::Exit;

    fn invocation(argv: &[&str]) -> Invocation {
        Invocation {
            argv: argv.iter().map(|word| (*word).to_owned()).collect(),
            env: Env::from_pairs(Vec::<(String, String)>::new()),
            cwd: std::path::PathBuf::from("/nonexistent"),
        }
    }

    fn run_captured(argv: &[&str]) -> (Exit, String, String) {
        let mut captured = heddle::output::Captured::default();
        let exit = {
            let mut out = captured.output();
            run(&invocation(argv), &mut out)
        };
        (exit, captured.stdout_text(), captured.stderr_text())
    }

    #[test]
    fn help_exits_zero_with_the_gated_usage_text() {
        let (exit, stdout, stderr) = run_captured(&["--help"]);
        assert_eq!(exit, Exit::Success);
        assert_eq!(stderr, "");
        assert!(stdout.starts_with("heddle — a harness and agent framework built on Cordis\n"));
        assert!(stdout.contains("  -h, --help                 show this message\n"));
        // `usage(SERVED)` serves the configuration commands, so `05-config-system`'s gate word is
        // there; a part whose crate is not wired keeps its word out.
        assert!(stdout.contains(
            "      --profile <name>       boot a named profile from $HEDDLE_HOME/profiles\n"
        ));
        assert!(!stdout.contains("  web "));
        // The session, workspace and goal commands answer through their crates, so the help lists them.
        for line in [
            "  sessions ",
            "  workspaces ",
            "  tree [<path>] ",
            "  goal [<session-id>] ",
        ] {
            assert!(stdout.contains(line), "{line} in the help");
        }
    }

    #[test]
    fn help_wins_over_another_command_because_parse_args_does() {
        let (exit, stdout, _) = run_captured(&["-h", "web"]);
        assert_eq!(exit, Exit::Success);
        assert!(stdout.contains("usage: heddle [options] [command]"));
    }

    #[test]
    fn a_usage_error_prints_the_typescript_prefix_and_exits_one() {
        let (exit, stdout, stderr) = run_captured(&["--bogus"]);
        assert_eq!(exit, Exit::Failure);
        assert_eq!(stdout, "");
        assert_eq!(stderr, "heddle: unknown argument: --bogus\n");
    }

    #[test]
    fn an_unwired_command_says_so_on_stderr_and_exits_two() {
        let (exit, stdout, stderr) = run_captured(&["web"]);
        assert_eq!(exit, Exit::Unported);
        assert_eq!(exit.code(), 2);
        assert_eq!(stdout, "");
        assert_eq!(stderr, "heddle: not ported to Rust yet: web\n");
    }
}
