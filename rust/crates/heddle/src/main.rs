//! `heddle` — the Rust port of the harness.
//!
//! The contract is the TypeScript build's: the same command line, the same HTTP routes and the same
//! session log, judged by the verifiers under `_verifiers_/` with `HEDDLE_BIN` pointing here
//! (`rust/ULTIMATE_GOAL.md`). Until a part is ported, the binary says so and exits non-zero, so a
//! verifier run against it fails honestly instead of passing on an empty answer.

use std::process::ExitCode;

/// What the command line asks for.
#[derive(Debug, PartialEq, Eq)]
enum Command {
    /// `-h` / `--help`: the usage text, exit 0.
    Help,
    /// No arguments: the TypeScript build boots its default profile; the port cannot yet.
    Default,
    /// Anything else: a real request the port does not handle yet, named by its first argument.
    Unported(String),
}

/// Classify the arguments after the program name.
fn parse(args: &[String]) -> Command {
    match args.first().map(String::as_str) {
        None => Command::Default,
        Some("-h" | "--help") => Command::Help,
        Some(first) => Command::Unported(first.to_owned()),
    }
}

/// The usage text: the TypeScript build's header, plus where the port stands.
fn usage() -> String {
    format!(
        "heddle — a harness and agent framework (Rust port {version}, in progress)\n\
         \n\
         usage: heddle [options] [command]\n\
         \n\
         Nothing is ported yet: every command exits 2 until its part passes its verifier.\n\
         The contract and the per-part status are in rust/ULTIMATE_GOAL.md and rust/INDEX.md.\n",
        version = env!("CARGO_PKG_VERSION")
    )
}

/// Exit code for a request the port does not handle yet — the same code a usage error gets.
const UNPORTED: u8 = 2;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match parse(&args) {
        Command::Help => {
            print!("{}", usage());
            ExitCode::SUCCESS
        }
        Command::Default => {
            eprint!("{}", usage());
            ExitCode::from(UNPORTED)
        }
        Command::Unported(first) => {
            eprintln!("heddle: not ported to Rust yet: {first}");
            ExitCode::from(UNPORTED)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| (*s).to_owned()).collect()
    }

    #[test]
    fn help_is_recognised_in_both_spellings() {
        assert_eq!(parse(&args(&["--help"])), Command::Help);
        assert_eq!(parse(&args(&["-h", "--turn", "x"])), Command::Help);
    }

    #[test]
    fn no_arguments_is_the_default_boot_not_help() {
        assert_eq!(parse(&[]), Command::Default);
    }

    #[test]
    fn any_other_request_is_unported_and_named_by_its_first_argument() {
        assert_eq!(
            parse(&args(&["--turn", "hello"])),
            Command::Unported("--turn".to_owned())
        );
        assert_eq!(
            parse(&args(&["web", "--port", "0"])),
            Command::Unported("web".to_owned())
        );
    }

    #[test]
    fn usage_names_the_contract_and_the_version() {
        let text = usage();
        assert!(text.starts_with("heddle — a harness and agent framework"));
        assert!(text.contains(env!("CARGO_PKG_VERSION")));
        assert!(text.contains("rust/ULTIMATE_GOAL.md"));
    }
}
