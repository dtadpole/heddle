//! Issue #195: a session whose `<id>.json` record is cut or missing while its log is intact.
//!
//! Measured before (developer-six, J175): the session vanished without a word — gone from the list, search, Rename and
//! Pin, no server line — and this build's turn route answered it `404 no session`, which the page showed as the raw JSON
//! body. The record is rebuilt from the log now, written back whole and named once; one its log cannot rebuild is left
//! out and named once, and opens as no session. The twin of `test/session-record-safe.test.ts`, through the public API
//! only.

use std::sync::{Arc, Mutex};

use heddle_config::Env;
use heddle_session::{
    ContentPart, CreateOptions, DefinitionOptions, FlagPatch, Message, RecordedMessage, Role,
    SessionHandle, SessionMeta, SessionStore, existing_session_names, title_from,
    write_session_definition,
};
use serde_json::{Value, json};

fn scratch() -> (tempfile::TempDir, String, String) {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("sessions").to_str().unwrap().to_string();
    let work = dir.path().join("work");
    std::fs::create_dir_all(&work).unwrap();
    let work = std::fs::canonicalize(work)
        .unwrap()
        .to_str()
        .unwrap()
        .to_string();
    (dir, root, work)
}

fn message(role: Role, text: &str, source: Option<Value>) -> RecordedMessage {
    Message {
        role,
        tool_call_id: None,
        content: vec![ContentPart::Text {
            text: text.to_string(),
        }],
        source,
    }
}

fn record(handle: &SessionHandle) -> Value {
    serde_json::from_str(&std::fs::read_to_string(&handle.meta).unwrap()).unwrap()
}

fn leftovers(dir: &str) -> Vec<String> {
    std::fs::read_dir(dir)
        .unwrap()
        .filter_map(Result::ok)
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| name.ends_with(".tmp"))
        .collect()
}

/// A fresh store over the same root, as a restarted server has, collecting the lines it prints.
fn restarted(root: &str) -> (SessionStore, Arc<Mutex<Vec<String>>>) {
    let store = SessionStore::new(root, &Env::default());
    let lines = Arc::new(Mutex::new(Vec::new()));
    let sink = lines.clone();
    store.set_warn(Arc::new(move |line: &str| {
        sink.lock().unwrap().push(line.to_string())
    }));
    (store, lines)
}

struct Fixture {
    writer: SessionStore,
    bravo: SessionHandle,
    echo: SessionHandle,
    charlie: SessionHandle,
}

/// Three sessions in one folder: bravo named by a person (definition and record), echo by its first message, charlie
/// pinned.
fn fixture(root: &str, work: &str) -> Fixture {
    let writer = SessionStore::new(root, &Env::default());
    let create = || {
        writer
            .create(CreateOptions {
                cwd: Some(work.to_string()),
                ..Default::default()
            })
            .unwrap()
    };
    let bravo = create();
    write_session_definition(
        &bravo,
        work,
        &DefinitionOptions {
            created_at: "2026-11-01T10:00:00.000Z".to_string(),
            title: Some("bravo note".to_string()),
            taken: existing_session_names(work),
            ..Default::default()
        },
    )
    .unwrap();
    writer.rename(&bravo.id, "bravo note").unwrap();
    writer
        .message(&bravo, message(Role::User, "tell me about herons", None))
        .unwrap();
    writer
        .message(&bravo, message(Role::Assistant, "herons wade", None))
        .unwrap();
    let echo = create();
    let prompt = "echo: what do herons eat?";
    writer
        .user_message_named(
            &echo,
            message(Role::User, prompt, None),
            &title_from(prompt),
        )
        .unwrap();
    writer
        .message(&echo, message(Role::Assistant, "fish", None))
        .unwrap();
    writer
        .message(
            &echo,
            message(
                Role::User,
                "a goal round",
                Some(json!({"kind": "goal", "goalId": "g", "revision": 1, "round": 1})),
            ),
        )
        .unwrap();
    let charlie = create();
    writer
        .flags(
            &charlie.id,
            FlagPatch {
                pinned: Some(true),
                archived: None,
            },
        )
        .unwrap();
    for handle in [&bravo, &echo, &charlie] {
        writer.release(handle);
    }
    Fixture {
        writer,
        bravo,
        echo,
        charlie,
    }
}

/// What the log says a rebuilt record must hold: id, created, title, turns and updated.
fn expected(writer: &SessionStore, handle: &SessionHandle, title: &str) -> Value {
    let events = writer.read(handle).unwrap();
    let prompts: Vec<_> = events
        .iter()
        .filter(|event| {
            event.kind == "message"
                && event.get("message").and_then(|m| m.get("role")) == Some(&json!("user"))
        })
        .collect();
    let person = prompts
        .iter()
        .rfind(|event| event.get("message").and_then(|m| m.get("source")).is_none())
        .unwrap();
    json!({
        "id": handle.id,
        "created": events[0].at,
        "title": title,
        "turns": prompts.len(),
        "updated": person.at,
    })
}

fn facts(meta: &SessionMeta) -> Value {
    json!({
        "id": meta.id(),
        "created": meta.created(),
        "title": meta.title(),
        "turns": meta.turns(),
        "updated": meta.updated(),
    })
}

#[test]
fn a_cut_record_and_a_missing_one_are_rebuilt_from_the_log_listed_and_named_once() {
    let (_dir, root, work) = scratch();
    let Fixture {
        writer,
        bravo,
        echo,
        charlie,
    } = fixture(&root, &work);
    let charlie_before = std::fs::read_to_string(&charlie.meta).unwrap();
    let bravo_text = std::fs::read_to_string(&bravo.meta).unwrap();
    std::fs::write(&bravo.meta, &bravo_text[..bravo_text.len() / 2]).unwrap();
    std::fs::remove_file(&echo.meta).unwrap();
    let (store, lines) = restarted(&root);

    let listed = store.list();
    for (handle, title) in [(&bravo, "bravo note"), (&echo, "echo: what do herons eat")] {
        let meta = listed
            .iter()
            .find(|meta| meta.id() == handle.id)
            .unwrap_or_else(|| panic!("{} is listed: {listed:?}", handle.id));
        assert_eq!(
            meta.cwd(),
            work,
            "with the folder its session/created names"
        );
        assert_eq!(
            facts(meta),
            expected(&writer, handle, title),
            "with its creation time, its title, its turns and its last prompt, from the log"
        );
        assert_eq!(
            record(handle),
            meta.to_value(),
            "and its record is written back whole, holding what the list shows"
        );
        assert!(leftovers(&handle.dir).is_empty(), "with no temporary file");
    }
    assert!(
        listed
            .iter()
            .any(|meta| meta.id() == charlie.id && meta.pinned()),
        "a healthy session keeps its own record"
    );
    assert_eq!(
        std::fs::read_to_string(&charlie.meta).unwrap(),
        charlie_before,
        "untouched"
    );

    let said = lines.lock().unwrap().clone();
    assert_eq!(said.len(), 2, "one line for each rebuilt record: {said:#?}");
    let bravo_line = said.iter().find(|line| line.contains(&bravo.meta)).unwrap();
    let echo_line = said.iter().find(|line| line.contains(&echo.meta)).unwrap();
    assert!(
        bravo_line.starts_with(&format!(
            "heddle session: rebuilt the record {} from its log {} (the record could not be read): ",
            bravo.meta, bravo.transcript
        )),
        "the cut record is named, with its log: {bravo_line}"
    );
    assert!(bravo_line.contains("title from its definition in the folder"));
    assert!(
        echo_line.starts_with(&format!(
            "heddle session: rebuilt the record {} from its log {} (the record was missing): ",
            echo.meta, echo.transcript
        )),
        "the missing record is named, with its log: {echo_line}"
    );
    assert!(echo_line.contains("title from its first message"));
    for line in &said {
        assert!(
            line.ends_with("not in the log, so as a new session has them: endpoint, model, preset, pin, archive, parent session, team"),
            "saying what the log could not give: {line}"
        );
    }

    store.list();
    assert!(store.open(&bravo.id).is_some() && store.open(&echo.id).is_some());
    assert!(store.meta(&bravo.id).is_some() && store.meta(&echo.id).is_some());
    assert_eq!(
        lines.lock().unwrap().len(),
        2,
        "however often they are listed or opened, each is named once"
    );

    let (again, again_lines) = restarted(&root);
    let ids: Vec<String> = again.list().iter().map(|m| m.id().to_string()).collect();
    assert!(
        ids.contains(&bravo.id) && ids.contains(&echo.id),
        "after a restart both are still listed"
    );
    assert!(
        again_lines.lock().unwrap().is_empty(),
        "with nothing to repair"
    );
}

#[test]
fn a_session_whose_record_is_missing_opens_and_takes_a_turn_before_anything_lists_it() {
    let (_dir, root, work) = scratch();
    let Fixture { echo, .. } = fixture(&root, &work);
    std::fs::remove_file(&echo.meta).unwrap();
    let (store, lines) = restarted(&root);
    let handle = store
        .open(&echo.id)
        .expect("it opens: its record is rebuilt from its log");
    assert_eq!(lines.lock().unwrap().len(), 1, "and the repair is named");
    store
        .message(&handle, message(Role::User, "one more", None))
        .unwrap();
    let meta = store
        .list()
        .into_iter()
        .find(|m| m.id() == echo.id)
        .unwrap();
    assert_eq!(meta.turns(), 3, "the turn is counted on the rebuilt record");
    assert_eq!(lines.lock().unwrap().len(), 1, "with no second line");
}

#[test]
fn a_record_cut_while_its_session_is_open_is_rebuilt_by_the_next_prompt_which_it_counts() {
    let (_dir, root, work) = scratch();
    let (store, lines) = restarted(&root);
    let handle = store
        .create(CreateOptions {
            cwd: Some(work.clone()),
            ..Default::default()
        })
        .unwrap();
    store
        .message(&handle, message(Role::User, "first", None))
        .unwrap();
    std::fs::write(&handle.meta, "{\n  \"id\": \"sess").unwrap();
    let second = store
        .message(&handle, message(Role::User, "second", None))
        .unwrap();
    let meta = record(&handle);
    assert_eq!(meta["id"], json!(handle.id), "the record reads again");
    assert_eq!(meta["turns"], json!(2), "and counts both prompts");
    assert_eq!(
        meta["updated"],
        json!(second.at),
        "and is dated by the latest one"
    );
    assert_eq!(lines.lock().unwrap().len(), 1, "one line names the repair");
}

#[test]
fn a_record_its_log_cannot_rebuild_leaves_the_session_out_and_is_named_once() {
    let (_dir, root, work) = scratch();
    let writer = SessionStore::new(&root, &Env::default());
    let create = || {
        writer
            .create(CreateOptions {
                cwd: Some(work.clone()),
                ..Default::default()
            })
            .unwrap()
    };
    let (empty, loose, healthy) = (create(), create(), create());
    for handle in [&empty, &loose, &healthy] {
        writer.release(handle);
    }
    std::fs::write(&empty.meta, "{\"id\": \"ses").unwrap();
    std::fs::write(&empty.transcript, "").unwrap();
    std::fs::write(&loose.meta, "").unwrap();
    std::fs::remove_file(&loose.transcript).unwrap();
    let (store, lines) = restarted(&root);

    let ids: Vec<String> = store.list().iter().map(|m| m.id().to_string()).collect();
    assert!(ids.contains(&healthy.id), "a healthy session is listed");
    assert!(
        !ids.contains(&empty.id) && !ids.contains(&loose.id),
        "the two that cannot be rebuilt are not"
    );
    assert!(
        store.open(&empty.id).is_none(),
        "and they open as no session"
    );
    assert!(store.open(&loose.id).is_none());
    store.list();
    let mut said = lines.lock().unwrap().clone();
    said.sort();
    let mut want = vec![
        format!(
            "heddle session: skipped session {}: its record {} cannot be read, and its log {} holds no session/created to rebuild it from",
            empty.id, empty.meta, empty.transcript
        ),
        format!(
            "heddle session: skipped session {}: its record {} cannot be read, and it has no log to rebuild it from",
            loose.id, loose.meta
        ),
    ];
    want.sort();
    assert_eq!(said, want, "each is named once");
    assert_eq!(
        std::fs::read_to_string(&empty.meta).unwrap(),
        "{\"id\": \"ses"
    );
}

#[cfg(unix)]
#[test]
fn a_record_write_that_fails_leaves_the_old_record_whole() {
    use std::os::unix::fs::PermissionsExt;
    let (_dir, root, work) = scratch();
    let store = SessionStore::new(&root, &Env::default());
    let handle = store
        .create(CreateOptions {
            cwd: Some(work),
            title: Some("before".to_string()),
            ..Default::default()
        })
        .unwrap();
    store.release(&handle);
    let before = record(&handle);
    // A folder no file can be created in: the temporary file fails, as a full disk fails a write.
    std::fs::set_permissions(&handle.dir, std::fs::Permissions::from_mode(0o555)).unwrap();
    let renamed = store.rename(&handle.id, "after");
    std::fs::set_permissions(&handle.dir, std::fs::Permissions::from_mode(0o755)).unwrap();
    assert!(renamed.is_err(), "the rename reports the failed write");
    assert_eq!(
        record(&handle),
        before,
        "and the record holds what it held, whole"
    );
    assert!(leftovers(&handle.dir).is_empty());
}
