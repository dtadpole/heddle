//! A turn cut by a restart is closed when its session is next opened for writing (issue #5).
//!
//! DSH appends closers to a log whose tail turn is still open before anything else runs on attach for
//! writing (`dsh-agent-loop` lib/index.js:1992-1993, `interruptedTurnClosers`): an error result for every
//! call still open, then the step's end and the turn's end (`openTurnClosers`, dsh-session
//! lib/types/repair.js:35-78). Its cold read appends the same closers virtually, so a log whose writer
//! crashed reads balanced before anyone writes it (`readColdSessionLog`, dsh-session-query
//! lib/index.js:26-52). Before this, the log ended at the call, the view drew it running forever, and the
//! turn never ended. The twin of `test/session-turn-closers.test.ts`, through the public API only.

#![cfg(unix)]

use std::path::Path;

use heddle_config::Env;
use heddle_session::{
    AppendOptions, CreateOptions, NewEvent, SessionConfig, SessionEvent, SessionHandle,
    SessionService, SessionStore, decode_transcript, lock_path,
};
use serde_json::{Value, json};

/// The words heddle's request-time repair answers an unanswered call with (`repairToolPairing`).
const INTERRUPTED_RESULT: &str = "error (INTERRUPTED): the turn ended before this call answered";

fn append(store: &SessionStore, handle: &SessionHandle, value: Value) -> SessionEvent {
    let event = NewEvent::try_from(value).expect("a well-formed event");
    SessionEvent::clone(
        &store
            .append(handle, event, AppendOptions::default())
            .unwrap(),
    )
}

/// One turn up to a running tool call, recorded the way the loop records it: the prompt, the model request,
/// the streamed reasoning, text and call, and the round's `done`.
fn open_turn(store: &SessionStore, handle: &SessionHandle, call: &str) {
    for value in [
        json!({"type": "message", "message": {"role": "user", "content": [{"type": "text", "text": "run the slow command"}]}}),
        json!({"type": "model/request", "endpoint": "scripted", "messages": 1, "tools": ["bash"]}),
        json!({"type": "assistant/chunk", "chunk": {"type": "reasoning-delta", "text": "it takes a while"}}),
        json!({"type": "assistant/chunk", "chunk": {"type": "text-delta", "text": "Running it."}}),
        json!({"type": "assistant/chunk", "chunk": {"type": "tool-call", "id": call, "name": "bash", "arguments": "{\"command\":\"sleep 25\"}"}}),
        json!({"type": "assistant/chunk", "chunk": {"type": "done", "finishReason": "tool_calls"}}),
    ] {
        append(store, handle, value);
    }
}

fn on_disk(handle: &SessionHandle) -> Vec<SessionEvent> {
    decode_transcript(&std::fs::read(&handle.transcript).unwrap())
        .lines
        .iter()
        .map(|line| SessionEvent::from_line(line).unwrap())
        .collect()
}

/// The tool messages among some events, as (call id, text).
fn tool_results<'a>(events: impl IntoIterator<Item = &'a SessionEvent>) -> Vec<(String, String)> {
    events
        .into_iter()
        .filter(|event| event.kind == "message")
        .filter_map(|event| event.get("message"))
        .filter(|message| message["role"] == "tool")
        .map(|message| {
            let text = message["content"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|part| part["text"].as_str())
                .collect::<String>();
            (
                message["toolCallId"].as_str().unwrap_or("").to_string(),
                text,
            )
        })
        .collect()
}

#[test]
fn a_turn_its_process_left_at_a_running_call_reads_as_interrupted_and_is_closed_before_the_next_write()
 {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_str().unwrap().to_string();
    // The writer: it records the turn up to the call, and then its process is gone without letting go.
    let handle = {
        let writer = SessionStore::new(&root, &Env::default());
        let handle = writer
            .create(CreateOptions {
                cwd: Some("/home/me/work".to_string()),
                ..Default::default()
            })
            .unwrap();
        open_turn(&writer, &handle, "call-slow");
        handle
    };
    let lock = lock_path(&handle);
    let service = SessionService::new(
        &SessionConfig {
            root: Some(root.clone()),
        },
        &Env::default(),
        None,
    );

    // While a live process holds the lock, its turn may still be running there: a reader adds nothing.
    let mut holder = std::process::Command::new("sleep")
        .arg("30")
        .spawn()
        .expect("a second process");
    std::fs::write(&lock, format!("{}\n", holder.id())).unwrap();
    let live = service.events(&handle).unwrap();
    assert_eq!(
        live.last().unwrap().kind,
        "assistant/chunk",
        "a live writer's turn is read as written"
    );
    assert!(tool_results(live.iter().map(|event| event.as_ref())).is_empty());

    // The holder dies without letting go: its lock names a pid that no longer exists.
    holder.kill().unwrap();
    holder.wait().unwrap();
    let before = std::fs::read(&handle.transcript).unwrap();
    let raw = service.store().read(&handle).unwrap();
    let last = raw.last().unwrap().clone();

    let read = service.events(&handle).unwrap();
    let closers: Vec<SessionEvent> = read[raw.len()..]
        .iter()
        .map(|event| SessionEvent::clone(event))
        .collect();
    assert_eq!(
        closers
            .iter()
            .map(|event| event.kind.as_str())
            .collect::<Vec<_>>(),
        vec!["message", "assistant/completed", "turn/completed"],
        "the read closes the open call, then the turn: {closers:?}"
    );
    assert_eq!(
        tool_results(&closers),
        vec![("call-slow".to_string(), INTERRUPTED_RESULT.to_string())],
        "the call is answered in the words the request-time repair uses"
    );
    let n = raw.len() as u64;
    assert_eq!(
        closers.iter().map(|event| event.seq).collect::<Vec<_>>(),
        vec![n, n + 1, n + 2]
    );
    assert!(
        closers.iter().all(|event| event.at == last.at),
        "the closers reuse the last real event's time"
    );
    assert_eq!(closers[1].get("text"), Some(&json!("Running it.")));
    assert_eq!(
        closers[1].get("reasoning"),
        Some(&json!("it takes a while"))
    );
    assert_eq!(closers[1].get("rounds"), Some(&json!(1)));
    assert_eq!(
        closers[2].get("reason"),
        Some(&json!({"kind": "interrupted"}))
    );
    assert_eq!(
        std::fs::read(&handle.transcript).unwrap(),
        before,
        "a read writes nothing"
    );

    // The first write after the restart: the closers land first, exactly as the read showed them.
    append(
        service.store(),
        &handle,
        json!({"type": "message", "message": {"role": "user", "content": [{"type": "text", "text": "did the command finish?"}]}}),
    );
    let written = on_disk(&handle);
    assert_eq!(
        written.iter().map(|event| event.seq).collect::<Vec<_>>(),
        (0..written.len() as u64).collect::<Vec<_>>(),
        "every seq is written once, in order"
    );
    assert_eq!(
        written[raw.len()..raw.len() + 3]
            .iter()
            .map(SessionEvent::to_line)
            .collect::<Vec<_>>(),
        closers
            .iter()
            .map(SessionEvent::to_line)
            .collect::<Vec<_>>(),
        "the closers on disk are byte for byte what the read showed"
    );
    assert_eq!(
        written.last().unwrap().get("message").unwrap()["role"],
        "user"
    );
    let now = service.events(&handle).unwrap();
    assert_eq!(
        now.len(),
        written.len(),
        "this process writes the session now, so a read adds nothing"
    );
    assert_eq!(
        tool_results(now.iter().map(|event| event.as_ref())).len(),
        1
    );
    assert_eq!(
        std::fs::read_to_string(Path::new(&lock)).unwrap(),
        format!("{}\n", std::process::id())
    );
}

#[test]
fn a_turn_that_is_live_in_this_process_is_never_closed() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_str().unwrap().to_string();
    let config = SessionConfig {
        root: Some(root.clone()),
    };
    let service = SessionService::new(&config, &Env::default(), None);
    let handle = service.store().create(CreateOptions::default()).unwrap();
    open_turn(service.store(), &handle, "call-live");

    // The call is running now, in this process.
    let read = service.events(&handle).unwrap();
    assert!(
        tool_results(read.iter().map(|event| event.as_ref())).is_empty(),
        "the holder's own read adds nothing"
    );

    // A second service over the same root in this process shares the process's hold: its read adds nothing,
    // and its claim is not a write-open, so it closes nothing.
    let other = SessionService::new(&config, &Env::default(), None);
    let same = other.store().open(&handle.id).unwrap();
    let theirs = other.events(&same).unwrap();
    assert!(tool_results(theirs.iter().map(|event| event.as_ref())).is_empty());
    let count = on_disk(&handle).len();
    other.store().claim(&same).unwrap();
    assert_eq!(
        on_disk(&handle).len(),
        count,
        "a second claim in this process appends nothing"
    );

    // The turn goes on and answers its own call.
    append(
        service.store(),
        &handle,
        json!({"type": "message", "message": {"role": "tool", "toolCallId": "call-live", "content": [{"type": "text", "text": "slept"}]}}),
    );
    let written = on_disk(&handle);
    assert_eq!(
        tool_results(&written),
        vec![("call-live".to_string(), "slept".to_string())],
        "the only answer is the tool's own"
    );
    assert!(
        !written
            .iter()
            .any(|event| event.kind == "turn/completed" || event.kind == "assistant/completed"),
        "and no closer ended the live turn"
    );
}
