//! Issue #130: one session log that is not a readable log, and the rest of the store.
//!
//! DSH's JSONL backend judges a session by its header before it lists it: "Unreadable or unsupported headers,
//! including corrupt Zstandard header frames, are omitted from discovery and `list()`. Direct access to a corrupt
//! compressed header still rejects." (dsh-session-persistence-jsonl README; `listArtifacts`, lib/index.js:3102-3138).
//! heddle's log has no header line, so its first record is the one judged. Measured before the fix: this build listed a
//! log holding 64 random bytes, or the line `{"not":"zstd"}`, while its routes answered `404 no session` for it, and
//! nothing named the file. The twin of `test/session-unreadable-log.test.ts`, through the public API only.

use std::sync::{Arc, Mutex};

use heddle_config::Env;
use heddle_session::{
    AppendOptions, CreateOptions, NewEvent, SessionConfig, SessionHandle, SessionService,
    SessionStore, frame_end,
};
use serde_json::json;

/// A store with three sessions in one folder (one with two messages, two blank).
fn fixture(root: &str, work: &str) -> (SessionHandle, SessionHandle, SessionHandle) {
    let writer = SessionStore::new(root, &Env::default());
    let create = || {
        writer
            .create(CreateOptions {
                cwd: Some(work.to_string()),
                ..Default::default()
            })
            .unwrap()
    };
    let turned = create();
    for (role, text) in [("user", "hello"), ("assistant", "a remembered answer")] {
        let event = NewEvent::try_from(json!({"type": "message", "message": {"role": role, "content": [{"type": "text", "text": text}]}})).unwrap();
        writer
            .append(&turned, event, AppendOptions::default())
            .unwrap();
    }
    let blank = create();
    let damaged = create();
    for handle in [&turned, &blank, &damaged] {
        writer.release(handle);
    }
    (turned, blank, damaged)
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

fn ids(store: &SessionStore) -> Vec<String> {
    store
        .list()
        .iter()
        .map(|meta| meta.id().to_string())
        .collect()
}

fn scratch() -> (tempfile::TempDir, String, String) {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("sessions").to_str().unwrap().to_string();
    let work = dir.path().join("work").to_str().unwrap().to_string();
    (dir, root, work)
}

fn left_out_and_named_once(bytes: &[u8], reason: &str) {
    let (_dir, root, work) = scratch();
    let (turned, blank, damaged) = fixture(&root, &work);
    std::fs::write(&damaged.transcript, bytes).unwrap();
    let (store, lines) = restarted(&root);

    let listed = ids(&store);
    assert!(
        listed.contains(&turned.id) && listed.contains(&blank.id),
        "every healthy session is listed: {listed:?}"
    );
    assert!(
        !listed.contains(&damaged.id),
        "the session whose log cannot be read is not"
    );
    assert!(
        store.open(&damaged.id).is_none(),
        "and direct access to it is refused: it opens as no session"
    );

    let opened = store.open(&turned.id).expect("a healthy session opens");
    let kinds: Vec<String> = store
        .read(&opened)
        .unwrap()
        .iter()
        .map(|event| event.kind.clone())
        .collect();
    assert_eq!(
        kinds,
        ["session/created", "message", "message"],
        "and reads whole"
    );
    assert!(
        store.open(&blank.id).is_some(),
        "so does the healthy blank one"
    );

    ids(&store);
    ids(&store);
    assert_eq!(
        *lines.lock().unwrap(),
        [format!(
            "heddle session: skipped unreadable log {}: {reason}",
            damaged.transcript
        )],
        "one line names the file, however often the store is listed"
    );
    assert_eq!(
        std::fs::read(&damaged.transcript).unwrap(),
        bytes,
        "and the file is left as it was"
    );
}

#[test]
fn a_log_holding_random_bytes_is_left_out_of_the_list_opens_as_no_session_and_is_named_once() {
    let bytes: Vec<u8> = (0..64u32).map(|index| (index * 37 + 0x79) as u8).collect();
    assert_ne!(bytes[0], 0x28, "the bytes do not begin like a zstd frame");
    left_out_and_named_once(&bytes, "its first record is not valid JSON");
}

#[test]
fn a_log_holding_a_plain_json_line_is_left_out_of_the_list_opens_as_no_session_and_is_named_once() {
    left_out_and_named_once(
        b"{\"not\":\"zstd\"}\n",
        "its first record is not a session event",
    );
}

#[test]
fn a_first_zstd_frame_that_is_complete_but_fails_its_checksum_is_left_out_and_not_cut_back() {
    // DSH: a header frame that fails validation is corruption, omitted from `list()` (`readFirstZstdLine`,
    // lib/index.js:3403). Before, the store read it as a torn tail at byte 0 and a write-open cut the log to nothing.
    let (_dir, root, work) = scratch();
    let (turned, _blank, damaged) = fixture(&root, &work);
    let mut corrupt = std::fs::read(&turned.transcript).unwrap();
    let first = frame_end(&corrupt, 0).expect("the first frame is whole");
    corrupt[first - 1] ^= 0xff;
    std::fs::write(&damaged.transcript, &corrupt).unwrap();
    let (store, lines) = restarted(&root);

    assert!(
        !ids(&store).contains(&damaged.id),
        "the session is not listed"
    );
    assert!(store.open(&damaged.id).is_none(), "and does not open");
    assert_eq!(
        *lines.lock().unwrap(),
        [format!(
            "heddle session: skipped unreadable log {}: its first zstd frame does not decode",
            damaged.transcript
        )]
    );
    assert_eq!(
        std::fs::read(&damaged.transcript).unwrap(),
        corrupt,
        "the log keeps every byte"
    );
}

#[test]
fn the_shapes_the_store_always_tolerated_still_list_and_open() {
    // An empty log, a missing one, a torn tail, a torn first frame.
    let (_dir, root, work) = scratch();
    let (turned, blank, damaged) = fixture(&root, &work);
    for handle in [&turned, &blank] {
        let bytes = std::fs::read(&handle.transcript).unwrap();
        std::fs::write(&handle.transcript, &bytes[..bytes.len() - 7]).unwrap();
    }
    std::fs::write(&damaged.transcript, b"").unwrap();
    let (store, lines) = restarted(&root);

    let mut listed = ids(&store);
    listed.sort();
    let mut all = vec![turned.id.clone(), blank.id.clone(), damaged.id.clone()];
    all.sort();
    assert_eq!(listed, all, "all three are listed");
    for handle in [&turned, &blank, &damaged] {
        assert!(store.open(&handle.id).is_some(), "{} opens", handle.id);
    }
    std::fs::remove_file(&damaged.transcript).unwrap();
    assert!(
        ids(&store).contains(&damaged.id),
        "a session whose log is missing entirely is still listed"
    );
    assert!(store.open(&damaged.id).is_some(), "and still opens");
    assert!(
        lines.lock().unwrap().is_empty(),
        "and nothing is reported as skipped"
    );
}

#[test]
fn the_service_answers_a_session_whose_log_cannot_be_read_as_no_session() {
    // Every route asks `exists` before it acts on a session. Measured on #130 (developer-six): POST /api/turn into
    // such a session passed it on its record alone and answered `400 no session '<id>' under <store root>`, naming
    // the store on disk; web.ts answered `404 session/not-found`.
    let (_dir, root, work) = scratch();
    let (turned, _blank, damaged) = fixture(&root, &work);
    std::fs::write(&damaged.transcript, b"{\"not\":\"zstd\"}\n").unwrap();
    let service = SessionService::new(
        &SessionConfig {
            root: Some(root.clone()),
        },
        &Env::default(),
        None,
    );
    service.store().set_warn(Arc::new(|_: &str| {}));
    assert!(service.exists(&turned.id), "a healthy session exists");
    assert!(
        !service.exists(&damaged.id),
        "the session whose log cannot be read does not"
    );
}

#[test]
fn a_log_that_does_not_read_names_only_its_file_in_the_error_never_the_store_root() {
    // The error reaches HTTP answers (a turn's `error` frame); the absolute path put the home directory in them.
    let (_dir, root, work) = scratch();
    let (_turned, _blank, damaged) = fixture(&root, &work);
    let head =
        json!({"seq": 0, "at": "2026-10-31T12:00:00.000Z", "type": "session/created", "cwd": work});
    std::fs::write(&damaged.transcript, format!("{head}\nnot json\n")).unwrap();
    let (store, _lines) = restarted(&root);
    let handle = store.open(&damaged.id).expect("its first record reads");
    let message = store.read(&handle).unwrap_err().to_string();
    assert!(
        message.starts_with(&format!("{}.v2.jsonl.zstd:2 is not valid JSON", damaged.id)),
        "the message names the log by its file name: {message}"
    );
    assert!(!message.contains(&root), "and nothing above it: {message}");
}
