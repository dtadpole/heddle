//! The team's command entry point (D-043): the team half of the `web` command's startup edge.
//!
//! The TypeScript build has no `team` subcommand. A team is reached through its profile row (the service and the
//! nine tools), `GET /api/team`, and this: when `web` starts, after active goals resume and before the URL line,
//! it settles the members a previous process left provisioning and offers every undelivered message to its
//! target again, then prints one line when there was a team to recover (`src/cli.ts`, the `app.ctx.team` block of
//! the web command). Only the server does this — a one-shot command must not start turns for teams it is not
//! working on — so the binary calls [`run`] from `web` and from nowhere else, and only when the `team` row loaded.
//!
//! The shape is the binary's convention for an entry point in the owning crate: a [`Command`], the [`Args`] it
//! reads (none), a [`Context`] holding the composed service, and [`run`] writing to the given streams and
//! answering an exit code. It reads no environment and prints nothing on its own.
//!
//! The server's `web` entry point prints the boot's lines itself, from a list of notes it is handed before it
//! starts (`heddle_server::command::Context::notes`, each written as `heddle web: <note>`). For that seam,
//! [`web_start_note`] does the same recovery and answers the note instead of writing the line; [`run`] is
//! that note written out.

use std::io::Write;
use std::path::PathBuf;

use crate::service::TeamService;

/// The command words this crate answers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Command {
    /// The team half of `web`'s startup edge: recover every team in the store and report it.
    RecoverAtWebStart,
}

/// The flags the team's entry point reads: none. Present so every entry point has the same shape.
#[derive(Clone, Debug, Default)]
pub struct Args {}

/// What the entry point runs against.
pub struct Context<'a> {
    /// The directory the command was started in. Recovery does not depend on it: a team is found by its log
    /// wherever the session store keeps it.
    pub cwd: PathBuf,
    /// The service the `team` row composed — the handle the boot registers under `team`.
    pub team: &'a TeamService,
}

/// Run one command. Exit `0` when done; `1` with a `heddle: <sentence>` line on `err` when the output cannot be
/// written. Recovery itself never fails the command: a team whose log the fold refuses is counted in the line
/// and reported through the service's `warn`, and every other team is still recovered.
///
/// The line is byte for byte the TypeScript one, written only when a team was recovered or refused:
/// `heddle web: recovered N team(s) (S settled, D delivered[, F failed])` and a newline.
pub async fn run(
    command: Command,
    _args: &Args,
    context: &Context<'_>,
    out: &mut dyn Write,
    err: &mut dyn Write,
) -> i32 {
    match command {
        Command::RecoverAtWebStart => {
            let Some(note) = web_start_note(context.team).await else {
                return 0;
            };
            match writeln!(out, "heddle web: {note}") {
                Ok(()) => 0,
                Err(error) => {
                    let _ = writeln!(
                        err,
                        "heddle: could not write the team recovery line: {error}"
                    );
                    1
                }
            }
        }
    }
}

/// Recover every team in the store and answer the boot note — `recovered N team(s) (S settled, D delivered[, F
/// failed])`, without the `heddle web: ` prefix — or `None` when there was no team. For a `web` that prints its
/// boot notes itself: the binary pushes this after the goal-resumption note, so the lines keep the TypeScript
/// order (goals, teams, then the URL).
pub async fn web_start_note(team: &TeamService) -> Option<String> {
    team.recover_store().await.boot_note()
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use serde_json::{Value, json};

    use super::*;
    use crate::ports::{ChildSession, SessionMetaView, TeamRunner, TeamStore};
    use crate::service::{TeamDeps, TeamLimits, TeamWarn};
    use crate::testing::{MemoryStore, RecordingRunner, SequentialIds};

    struct Harness {
        store: Arc<MemoryStore>,
        service: TeamService,
        warnings: Arc<Mutex<Vec<String>>>,
    }

    fn harness() -> Harness {
        let store = Arc::new(MemoryStore::new());
        let runner = Arc::new(RecordingRunner::new(Arc::clone(&store), None));
        let warnings = Arc::new(Mutex::new(Vec::new()));
        let warn: TeamWarn = {
            let warnings = Arc::clone(&warnings);
            Arc::new(move |message: &str| {
                warnings
                    .lock()
                    .expect("the warnings lock")
                    .push(message.to_owned());
            })
        };
        let store_dependency: Arc<dyn TeamStore> = store.clone();
        let runner_dependency: Arc<dyn TeamRunner> = runner;
        let service = TeamService::new(TeamDeps {
            store: store_dependency,
            runner: runner_dependency,
            live: None,
            limits: TeamLimits::default(),
            notify: None,
            warn: Some(warn),
            ids: Arc::new(SequentialIds::new()),
        });
        Harness {
            store,
            service,
            warnings,
        }
    }

    fn session(store: &MemoryStore, id: &str) {
        store.add_session(SessionMetaView {
            id: id.to_owned(),
            cwd: Some("/work".to_owned()),
            endpoint: Some("scripted".to_owned()),
            model: Some("scripted".to_owned()),
            team_id: None,
        });
    }

    fn child(store: &MemoryStore, lead: &str, id: &str) {
        store
            .create(&ChildSession {
                id: id.to_owned(),
                cwd: Some("/work".to_owned()),
                endpoint: None,
                model: None,
                parent_session: lead.to_owned(),
                origin: "subagent",
                delegation_depth: 1,
                team_id: lead.to_owned(),
                title: "teammate".to_owned(),
            })
            .expect("the member session");
    }

    fn journal(store: &MemoryStore, lead: &str, event: Value) {
        store
            .append(lead, event)
            .expect("the team event is journaled");
    }

    fn provisioning(store: &MemoryStore, lead: &str, id: &str, name: &str) {
        journal(
            store,
            lead,
            json!({ "type": "team/member", "version": 2, "teamId": lead, "member": { "id": id, "name": name, "description": "left over", "context": "fresh", "phase": "provisioning" } }),
        );
    }

    /// The shape of check-teams' recorded store: a resumable member, a member that never accepted a prompt, and
    /// one queued message to the resumable one.
    fn recorded_team(store: &MemoryStore) {
        let lead = "session-recover-lead";
        session(store, lead);
        child(store, lead, "session-recover-active");
        store
            .user_message(
                "session-recover-active",
                vec![json!({ "type": "text", "text": "the prompt that made it resumable" })],
                Value::Null,
            )
            .expect("the resumable prompt");
        child(store, lead, "session-recover-ghost");
        provisioning(store, lead, "session-recover-active", "alpha");
        provisioning(store, lead, "session-recover-ghost", "ghost");
        journal(
            store,
            lead,
            json!({ "type": "team/message/queued", "version": 2, "teamId": lead, "message": { "id": "team-message-left-1", "senderId": lead, "senderName": "lead", "targetId": "session-recover-active", "content": [{ "type": "text", "text": "left over mail" }] } }),
        );
    }

    /// A team the fold refuses: a member active without ever being provisioning.
    fn corrupt_team(store: &MemoryStore) {
        let lead = "session-broken";
        session(store, lead);
        journal(
            store,
            lead,
            json!({ "type": "team/member", "version": 2, "teamId": lead, "member": { "id": "session-broken-child", "name": "broken", "description": "x", "context": "fresh", "phase": "active" } }),
        );
    }

    async fn run_recovery(h: &Harness) -> (i32, String, String) {
        let context = Context {
            cwd: PathBuf::from("/work"),
            team: &h.service,
        };
        let mut out = Vec::new();
        let mut err = Vec::new();
        let code = run(
            Command::RecoverAtWebStart,
            &Args::default(),
            &context,
            &mut out,
            &mut err,
        )
        .await;
        (
            code,
            String::from_utf8(out).expect("the output is text"),
            String::from_utf8(err).expect("the error output is text"),
        )
    }

    #[tokio::test]
    async fn a_previous_processs_team_is_recovered_and_reported_in_the_line_check_teams_waits_for()
    {
        let h = harness();
        recorded_team(&h.store);
        let (code, out, err) = run_recovery(&h).await;
        assert_eq!(code, 0);
        assert_eq!(
            out,
            "heddle web: recovered 1 team(s) (2 settled, 1 delivered)\n"
        );
        assert!(err.is_empty(), "{err}");
        assert!(
            h.store
                .events("session-recover-active")
                .iter()
                .any(|event| { event["message"]["source"]["messageId"] == "team-message-left-1" })
        );

        // The next start finds the team settled and still reports it, which is what the restart half of the
        // first check waits for (`recovered 1 team(s)`).
        let (code, out, _) = run_recovery(&h).await;
        assert_eq!(code, 0);
        assert_eq!(
            out,
            "heddle web: recovered 1 team(s) (0 settled, 0 delivered)\n"
        );
    }

    #[tokio::test]
    async fn the_note_for_the_servers_boot_notes_is_the_line_without_its_prefix() {
        // Two identical stores, because recovery changes what it recovers.
        let by_note = harness();
        recorded_team(&by_note.store);
        let note = web_start_note(&by_note.service).await;
        assert_eq!(
            note.as_deref(),
            Some("recovered 1 team(s) (2 settled, 1 delivered)")
        );

        let by_line = harness();
        recorded_team(&by_line.store);
        let (_, out, _) = run_recovery(&by_line).await;
        assert_eq!(
            format!("heddle web: {}\n", note.unwrap_or_default()),
            out,
            "the server writing the note prints exactly what run prints"
        );

        let empty = harness();
        assert_eq!(web_start_note(&empty.service).await, None);
    }

    #[tokio::test]
    async fn a_store_without_a_team_prints_nothing() {
        let h = harness();
        session(&h.store, "session-plain");
        h.store
            .user_message(
                "session-plain",
                vec![json!({ "type": "text", "text": "hello" })],
                Value::Null,
            )
            .expect("an ordinary conversation");
        let (code, out, err) = run_recovery(&h).await;
        assert_eq!((code, out.as_str(), err.as_str()), (0, "", ""));
    }

    #[tokio::test]
    async fn a_refused_team_is_counted_and_warned_and_does_not_stop_the_others() {
        let h = harness();
        recorded_team(&h.store);
        corrupt_team(&h.store);
        let (code, out, err) = run_recovery(&h).await;
        assert_eq!(
            code, 0,
            "a broken team never keeps the server from starting"
        );
        assert_eq!(
            out,
            "heddle web: recovered 1 team(s) (2 settled, 1 delivered, 1 failed)\n"
        );
        assert!(
            err.is_empty(),
            "the refusal goes to the service's warn, not to err"
        );
        let warnings = h.warnings.lock().expect("the warnings lock").clone();
        assert_eq!(warnings.len(), 1);
        assert!(warnings[0].contains("session-broken"), "{warnings:?}");

        let only_broken = harness();
        corrupt_team(&only_broken.store);
        let (code, out, _) = run_recovery(&only_broken).await;
        assert_eq!(code, 0);
        assert_eq!(
            out,
            "heddle web: recovered 0 team(s) (0 settled, 0 delivered, 1 failed)\n"
        );
    }

    struct BrokenPipe;

    impl Write for BrokenPipe {
        fn write(&mut self, _buf: &[u8]) -> std::io::Result<usize> {
            Err(std::io::Error::new(
                std::io::ErrorKind::BrokenPipe,
                "the reader went away",
            ))
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[tokio::test]
    async fn an_unwritable_line_answers_one_with_a_heddle_sentence() {
        let h = harness();
        recorded_team(&h.store);
        let context = Context {
            cwd: PathBuf::from("/work"),
            team: &h.service,
        };
        let mut err = Vec::new();
        let code = run(
            Command::RecoverAtWebStart,
            &Args::default(),
            &context,
            &mut BrokenPipe,
            &mut err,
        )
        .await;
        assert_eq!(code, 1);
        let err = String::from_utf8(err).expect("the error output is text");
        assert!(
            err.starts_with("heddle: could not write the team recovery line"),
            "{err}"
        );
    }
}
