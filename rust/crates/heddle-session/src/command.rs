//! `heddle sessions` and `heddle transcript`: the session commands, answered by the crate that owns them
//! (D-043).
//!
//! Ported from `src/cli.ts` (the `sessions` and `transcript` branches). The binary parses its own command
//! line, boots the profile, builds the [`SessionService`] from the session row and calls [`run`] with the
//! flags this crate reads; everything a command prints is written here, so the sentences
//! `70-workspaces-sessions` reads live beside the store they describe.
//!
//! `session new` is not here: it registers the branch's workspace root before it creates the session, so
//! it needs the workspace service too, and this crate cannot depend on `heddle-workspace` (that dependency
//! runs the other way). It is answered by `heddle_workspace::command`.
//!
//! # Contract
//!
//! - Exit `0` when the command answered; `1` with `heddle: <sentence>` on `err` when it refused, which is
//!   the TypeScript build's `process.exitCode = 1`. Never `2`: that is the binary's "not ported yet".
//! - `--json` is `JSON.stringify(value, null, 2)` plus a newline; text is `src/cli.ts`'s, byte for byte.
//!   `transcript` writes one compact `JSON.stringify(event)` line per event, as the TypeScript build does.
//! - No process-global reads: the working directory and the service arrive in the [`Context`].

use std::io::Write;
use std::path::PathBuf;

use serde_json::Value;

use crate::meta::SessionMeta;
use crate::service::{SessionService, StartOptions};

/// The command words this crate answers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Command {
    /// `heddle sessions [--json]`: the sessions the store holds, newest first.
    Sessions,
    /// `heddle transcript <id>`: one session's log, one JSON line per event.
    Transcript,
}

/// The flags these commands read, named after the TypeScript `Args` fields.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Args {
    /// The positional: the session id for `transcript`.
    pub target: Option<String>,
    /// `--json`.
    pub json: bool,
}

/// What a command runs against: the session service the boot built from the session row, and the
/// directory the run was started in.
pub struct Context<'a> {
    pub cwd: PathBuf,
    pub sessions: &'a SessionService,
}

/// Answer `command`, writing the answer to `out` and any refusal to `err`; return the exit code.
pub fn run(
    command: Command,
    args: &Args,
    context: &Context<'_>,
    out: &mut dyn Write,
    err: &mut dyn Write,
) -> i32 {
    match command {
        Command::Sessions => sessions(args, context, out),
        Command::Transcript => transcript(args, context, out, err),
    }
}

/// `heddle: <sentence>` on `err`, exit 1 — the TypeScript build's top-level `catch`. Public so every
/// command crate refuses in exactly this shape.
pub fn refuse(err: &mut dyn Write, sentence: impl std::fmt::Display) -> i32 {
    let _ = writeln!(err, "heddle: {sentence}");
    1
}

/// `JSON.stringify(value, null, 2)` plus a newline — what every `--json` answer is.
pub fn write_pretty(out: &mut dyn Write, value: &Value) {
    let text = serde_json::to_string_pretty(value).unwrap_or_else(|_| "null".to_string());
    let _ = writeln!(out, "{text}");
}

/// `heddle sessions`: `src/cli.ts`, `if (command === 'sessions')`.
fn sessions(args: &Args, context: &Context<'_>, out: &mut dyn Write) -> i32 {
    let all = context.sessions.list();
    if args.json {
        write_pretty(
            out,
            &Value::Array(all.iter().map(SessionMeta::to_value).collect()),
        );
        return 0;
    }
    let _ = writeln!(
        out,
        "heddle: {} session(s) in {}",
        all.len(),
        context.sessions.store().root()
    );
    for meta in all.iter().take(20) {
        let _ = writeln!(
            out,
            "  {}  {}  turns={}  {}",
            meta.id(),
            meta.created(),
            meta.turns(),
            meta.title().unwrap_or("")
        );
    }
    0
}

/// `heddle transcript <id>`: `src/cli.ts`, `if (command === 'transcript')`.
fn transcript(args: &Args, context: &Context<'_>, out: &mut dyn Write, err: &mut dyn Write) -> i32 {
    let Some(target) = args.target.as_deref() else {
        return refuse(err, "transcript needs a session id");
    };
    let handle = match context.sessions.start(StartOptions {
        resume: Some(target.to_string()),
        ..StartOptions::default()
    }) {
        Ok(handle) => handle,
        Err(error) => return refuse(err, error),
    };
    let events = match context.sessions.events(&handle) {
        Ok(events) => events,
        Err(error) => return refuse(err, error),
    };
    for event in events.iter() {
        let _ = writeln!(out, "{}", event.to_line());
    }
    0
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::service::{OpenAtOptions, SessionConfig};
    use heddle_config::Env;

    fn service(home: &std::path::Path) -> SessionService {
        SessionService::new(
            &SessionConfig {
                root: Some(home.join("sessions").to_string_lossy().into_owned()),
            },
            &Env::default(),
            None,
        )
    }

    fn answer(command: Command, args: &Args, sessions: &SessionService) -> (i32, String, String) {
        let context = Context {
            cwd: PathBuf::from("/"),
            sessions,
        };
        let mut out = Vec::new();
        let mut err = Vec::new();
        let code = run(command, args, &context, &mut out, &mut err);
        (
            code,
            String::from_utf8(out).expect("UTF-8 out"),
            String::from_utf8(err).expect("UTF-8 err"),
        )
    }

    #[test]
    fn an_empty_store_lists_no_sessions_in_both_forms() {
        let home = tempfile::tempdir().unwrap();
        let sessions = service(home.path());
        let (code, out, err) = answer(
            Command::Sessions,
            &Args {
                json: true,
                ..Args::default()
            },
            &sessions,
        );
        assert_eq!((code, out.as_str(), err.as_str()), (0, "[]\n", ""));
        let (code, out, _) = answer(Command::Sessions, &Args::default(), &sessions);
        assert_eq!(code, 0);
        assert_eq!(
            out,
            format!("heddle: 0 session(s) in {}\n", sessions.store().root())
        );
    }

    #[test]
    fn the_listing_prints_the_records_whole_and_the_text_names_each_turn_count() {
        let home = tempfile::tempdir().unwrap();
        let sessions = service(home.path());
        let folder = home.path().join("work");
        std::fs::create_dir_all(&folder).unwrap();
        let handle = sessions
            .open_at(folder.to_str().unwrap(), OpenAtOptions::default())
            .unwrap();
        sessions
            .user(&handle, "remember the word loom", None)
            .unwrap();

        let (code, out, _) = answer(
            Command::Sessions,
            &Args {
                json: true,
                ..Args::default()
            },
            &sessions,
        );
        assert_eq!(code, 0);
        assert!(out.ends_with("]\n"));
        let listed: Value = serde_json::from_str(&out).expect("the listing is JSON");
        assert_eq!(listed[0]["id"], handle.id.as_str());
        assert_eq!(listed[0]["turns"], 1);
        assert_eq!(listed[0]["title"], "remember the word loom");
        // The record is printed whole: the store's own keys, in its own order.
        assert_eq!(
            out,
            format!(
                "{}\n",
                serde_json::to_string_pretty(&Value::Array(vec![sessions.list()[0].to_value()]))
                    .unwrap()
            )
        );

        let (_, text, _) = answer(Command::Sessions, &Args::default(), &sessions);
        let meta = &sessions.list()[0];
        assert_eq!(
            text,
            format!(
                "heddle: 1 session(s) in {}\n  {}  {}  turns=1  remember the word loom\n",
                sessions.store().root(),
                meta.id(),
                meta.created()
            )
        );
    }

    #[test]
    fn a_transcript_is_one_compact_json_line_per_event() {
        let home = tempfile::tempdir().unwrap();
        let sessions = service(home.path());
        let folder = home.path().join("work");
        std::fs::create_dir_all(&folder).unwrap();
        let handle = sessions
            .open_at(folder.to_str().unwrap(), OpenAtOptions::default())
            .unwrap();
        sessions.user(&handle, "a turn", None).unwrap();

        let (code, out, err) = answer(
            Command::Transcript,
            &Args {
                target: Some(handle.id.clone()),
                ..Args::default()
            },
            &sessions,
        );
        assert_eq!((code, err.as_str()), (0, ""));
        let lines: Vec<&str> = out.lines().collect();
        let expected: Vec<String> = sessions
            .events(&handle)
            .unwrap()
            .iter()
            .map(|event| event.to_line())
            .collect();
        assert_eq!(lines, expected);
        assert!(lines[0].starts_with("{\"seq\":0,\"at\":\""));
        assert!(lines[0].contains("\"type\":\"session/created\""));
        assert!(out.ends_with('\n'));
    }

    #[test]
    fn a_transcript_refuses_a_missing_id_and_an_unknown_one_with_the_typescript_sentences() {
        let home = tempfile::tempdir().unwrap();
        let sessions = service(home.path());
        let (code, out, err) = answer(Command::Transcript, &Args::default(), &sessions);
        assert_eq!(
            (code, out.as_str(), err.as_str()),
            (1, "", "heddle: transcript needs a session id\n")
        );
        let (code, _, err) = answer(
            Command::Transcript,
            &Args {
                target: Some("session-nope".to_string()),
                ..Args::default()
            },
            &sessions,
        );
        assert_eq!(code, 1);
        assert_eq!(
            err,
            format!(
                "heddle: no session 'session-nope' under {}\n",
                sessions.store().root()
            )
        );
    }
}
