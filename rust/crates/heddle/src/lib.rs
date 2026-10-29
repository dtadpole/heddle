//! `heddle` — the Rust port of the harness, as a library the binary is a thin shell over.
//!
//! The contract is the TypeScript build's: the same command line, the same HTTP routes and the same
//! session log, judged by the verifiers under `_verifiers_/` with `HEDDLE_BIN` pointing at the built
//! binary (`rust/ULTIMATE_GOAL.md`). This crate is the **composition root**: it parses the command line
//! ([`cli`]), boots the configured tree ([`boot`]) from the rows `heddle-config` composes, starts each row
//! as a built-in from the other crates or as an outside process ([`builtins`]), and answers every command
//! ([`commands`]) through the narrow views of those crates it declares in [`ports`].
//!
//! Ported from `src/cli.ts`, `src/boot.ts`, `src/app.ts` and the three plugins `createApp` loads
//! (`src/plugins/console-exporter.ts`, `greeting.ts`, `announce.ts`). The port plan, and what each
//! other crate is asked to provide, is in this crate's `INDEX.md`.

pub mod adapters;
pub mod boot;
pub mod builtins;
pub mod cli;
pub mod commands;
pub mod output;
pub mod ports;
pub mod runtime;
pub mod services;
pub mod usage;
pub mod web;

use std::path::PathBuf;

/// The environment one invocation sees, passed explicitly so a test never reads the process's own:
/// `heddle-config`'s, which every crate reads `HEDDLE_HOME`, `HOME` and references from.
pub use heddle_config::Env;

/// Everything one run of the binary is given: its arguments, its environment and its working directory.
///
/// `main` builds it from the process; a unit test builds it from literals, which is what lets every
/// command be tested in-process against a fixture home instead of through a spawned binary.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Invocation {
    /// The arguments after the program name.
    pub argv: Vec<String>,
    /// The environment variables, for `HEDDLE_HOME`, `HEDDLE_CONFIG` and `${NAME}` references.
    pub env: Env,
    /// The working directory: the project base `cordis.yml`, the folder's session, relative paths.
    pub cwd: PathBuf,
}

/// How a run ends, as the process exit code the verifiers read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum Exit {
    /// The command did what it was asked.
    Success = 0,
    /// The TypeScript build's `process.exitCode = 1`: a usage error, a broken tree, a refused action.
    Failure = 1,
    /// A request the port does not handle yet. Rust-only, and gone once every part is ported.
    Unported = 2,
}

impl Exit {
    /// The process exit code.
    pub fn code(self) -> u8 {
        self as u8
    }
}

/// Run one invocation to completion, writing to `out`, and say how it ended.
///
/// The port of `main()` in `src/cli.ts`: `--help` first, then `web`, then the commands answered from the
/// configuration alone (`profiles`, `config`), then the commands that boot, then the bare boot and the
/// turn. An error anywhere is printed as `heddle: <message>` on stderr with [`Exit::Failure`], exactly as
/// the TypeScript build's top-level `catch` does.
pub fn run(invocation: &Invocation, out: &mut output::Output<'_>) -> Exit {
    let args = match cli::parse_args(&invocation.argv) {
        Ok(args) => args,
        Err(error) => return out.fail(&error.0),
    };
    // DSH's `-V, --version`: the release alone on one line, exit 0 (DSH parity S74).
    if args.version {
        out.out(concat!(env!("CARGO_PKG_VERSION"), "\n"));
        return Exit::Success;
    }
    if args.help {
        out.out(&usage::usage(usage::SERVED));
        return Exit::Success;
    }
    commands::dispatch(&args, invocation, out)
}
