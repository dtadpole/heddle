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
    if args.help {
        out.out(&usage::usage(usage::SERVED));
        return Exit::Success;
    }
    let mut args = args;
    if let Err(exit) = use_default_profile(&mut args, invocation, out) {
        return exit;
    }
    if let Some(template) = &args.from_default_profile {
        // DSH's `--profile <name> --from-default-profile <template>`: the named profile is replaced by a fresh copy of
        // a shipped template, then the command boots it as usual. A profile named by a directory is not one this can
        // replace, so the flag needs a plain name. The template is the checkout this binary was built from.
        let Some(name) = args
            .profile
            .as_deref()
            .filter(|name| !name.starts_with('/'))
        else {
            return out.fail("--from-default-profile needs --profile <name>, a profile under $HEDDLE_HOME/profiles");
        };
        let checkout = shipped_checkout();
        if let Err(error) =
            heddle_config::reset_profile_from_template(name, template, &checkout, &invocation.env)
        {
            return out.fail(&error.problems().join("; "));
        }
        out.err(&format!(
            "heddle: profile '{name}' replaced by a fresh copy of the '{template}' template\n"
        ));
    }
    commands::dispatch(&args, invocation, out)
}

/// The checkout this binary was built from, whose tree is the shipped `default` template.
fn shipped_checkout() -> std::path::PathBuf {
    let checkout = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    checkout.canonicalize().unwrap_or(checkout)
}

/// The profile a run boots when it names none (issue #74), as `useDefaultProfile` in `src/cli.ts`.
///
/// A run that boots (`web`, a command, or a `--turn`) and names no profile, no `--config` and no `--patch`, from a
/// folder with no project tree (`cordis.yml`), used to boot nothing: on a fresh home the page had no session, model or
/// workspace service, and `--session-root` failed outright (its patch named a row no layer inserted). DSH
/// auto-initializes its shipped profiles from their templates on first use; such a run boots
/// `$HEDDLE_HOME/profiles/default`, created from the shipped template the first time, and says so on stderr. A profile
/// a person already keeps under that name is booted as it is. `profiles` lists what exists and creates nothing.
fn use_default_profile(
    args: &mut cli::Args,
    invocation: &Invocation,
    out: &mut output::Output<'_>,
) -> Result<(), Exit> {
    if args.profile.is_some() || args.config.is_some() || !args.patch.is_empty() {
        return Ok(());
    }
    // `--from-default-profile` replaces a profile, so it must name one: the check after this refuses it without
    // `--profile`. Choosing `default` here first would turn that refusal into a reset of the default profile.
    if args.from_default_profile.is_some() {
        return Ok(());
    }
    if args.command.is_none() && args.turn.is_none() {
        return Ok(());
    }
    if args.command == Some(cli::CommandWord::Profiles) {
        return Ok(());
    }
    if invocation.cwd.join("cordis.yml").exists() {
        return Ok(());
    }
    let dir = heddle_config::profiles_dir(&invocation.env).join("default");
    if !dir.exists() {
        if let Err(error) = heddle_config::reset_profile_from_template(
            "default",
            "default",
            &shipped_checkout(),
            &invocation.env,
        ) {
            return Err(out.fail(&error.problems().join("; ")));
        }
        out.err(&format!(
            "heddle: created profile 'default' from the shipped template at {}\n",
            dir.display()
        ));
    }
    args.profile = Some("default".to_owned());
    Ok(())
}
