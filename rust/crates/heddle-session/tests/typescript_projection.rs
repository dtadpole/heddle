//! The model's view of a log, checked against the TypeScript build's own derivation (#173).
//!
//! A turn whose stream broke mid-answer leaves a run of chunks with no `done`, closed by an
//! `assistant/completed` whose `finishReason` is `"error"`. Both builds leave that run out of what the
//! model reads, and keep a run a Stop cut (`"aborted"`). This test folds the same logs with
//! `foldSurface` and `deriveMessage` from `src/session/store.ts`, run by the Node on this machine, and
//! with this crate's `fold_surface` and `derive_message`, and requires the same nodes and the same
//! messages, so the rule cannot drift between the builds.
//!
//! Where Node is absent the test reports skipped rather than failing: a missing oracle is not a failing
//! port, and the unit tests in `surface.rs` still hold the rule.

use std::path::PathBuf;
use std::process::Command;

use heddle_session::{SessionEvent, derive_message, fold_surface, index_by_seq};
use serde_json::{Value, json};

/// The repository's TypeScript store, resolved from this crate's source directory.
fn typescript_store() -> PathBuf {
    let mut path = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    path.pop(); // crates
    path.pop(); // rust
    path.pop(); // the repository root
    path.join("src/session/store.ts")
}

/// Every surface node of each log, with the message it derives to (`null` for none).
const DERIVER: &str = r#"
import { readFileSync } from 'node:fs'

const { foldSurface, indexBySeq, deriveMessage } = await import(process.env.HEDDLE_TS_STORE)
const logs = JSON.parse(readFileSync(process.argv[2], 'utf8'))
process.stdout.write(JSON.stringify(logs.map((events) => {
  const bySeq = indexBySeq(events)
  return foldSurface(events).nodes.map((seq) => [seq, deriveMessage(bySeq, seq)])
})) + '\n')
"#;

/// The same, by this crate.
fn derived_here(events: &[Value]) -> Value {
    let events: Vec<SessionEvent> = events
        .iter()
        .map(|event| SessionEvent::from_line(&event.to_string()).expect("a well-formed event"))
        .collect();
    let by_seq = index_by_seq(&events);
    let nodes = fold_surface(&events).expect("the log folds").nodes;
    Value::Array(
        nodes
            .into_iter()
            .map(|seq| {
                let message = derive_message(&by_seq, seq)
                    .map(|message| serde_json::to_value(message).expect("a message serializes"))
                    .unwrap_or(Value::Null);
                json!([seq, message])
            })
            .collect(),
    )
}

/// A log from its event bodies: each gets its position as its seq and one fixed time.
fn log(bodies: Vec<Value>) -> Vec<Value> {
    bodies
        .into_iter()
        .enumerate()
        .map(|(seq, body)| {
            let mut event = json!({"seq": seq, "at": "2026-11-01T20:00:00.000Z"});
            for (key, value) in body.as_object().expect("a body is an object") {
                event[key] = value.clone();
            }
            event
        })
        .collect()
}

fn user(text: &str) -> Value {
    json!({"type": "message", "message": {"role": "user", "content": [{"type": "text", "text": text}]}})
}

fn chunk(chunk: Value) -> Value {
    json!({"type": "assistant/chunk", "chunk": chunk})
}

fn request() -> Value {
    json!({"type": "model/request", "endpoint": "chat", "messages": 1, "tools": []})
}

/// The closing pair the loop writes for a turn that threw (`recordUnfinished`, heddle-agent `turn.rs`).
fn closed(how: &str, text: &str) -> [Value; 2] {
    let ended = if how == "aborted" {
        "stopped by the caller".to_string()
    } else {
        "failed: the request to 'chat' could not be read — aborted".to_string()
    };
    [
        json!({"type": "assistant/completed", "text": text, "reasoning": "thinking", "finishReason": how, "rounds": 1, "denials": 0, "ended": [ended]}),
        json!({"type": "turn/completed", "rounds": 1}),
    ]
}

fn logs() -> Vec<(&'static str, Vec<Value>)> {
    let broken = |how: &str| {
        let [completed, ended] = closed(how, "PARTIAL-99 alpha ");
        log(vec![
            json!({"type": "session/created", "cwd": "/work"}),
            user("CUT-TEXT-173 turn"),
            request(),
            chunk(json!({"type": "reasoning-delta", "text": "thinking"})),
            chunk(json!({"type": "text-delta", "text": "PARTIAL-99 "})),
            chunk(json!({"type": "text-delta", "text": "alpha "})),
            completed,
            ended,
            user("NEXT turn"),
        ])
    };
    let [completed, ended] = closed("error", "Listing.It holds a.t");
    let later_round = log(vec![
        user("list it, then explain"),
        request(),
        chunk(json!({"type": "text-delta", "text": "Listing."})),
        chunk(json!({"type": "tool-call", "id": "call-1", "name": "list_dir", "arguments": "{}"})),
        chunk(json!({"type": "done", "finishReason": "tool_calls"})),
        json!({"type": "message", "message": {"role": "tool", "toolCallId": "call-1", "content": [{"type": "text", "text": "a.txt"}]}}),
        request(),
        chunk(json!({"type": "text-delta", "text": "It holds "})),
        user("STEER be brief"),
        chunk(json!({"type": "text-delta", "text": "a.t"})),
        completed,
        ended,
    ]);
    let empty = log(vec![
        user("say nothing"),
        request(),
        chunk(json!({"type": "done", "finishReason": "stop"})),
        json!({"type": "turn/completed", "rounds": 1}),
    ]);
    let whole = log(vec![
        user("hi"),
        request(),
        chunk(json!({"type": "text-delta", "text": "hello"})),
        chunk(json!({"type": "done", "finishReason": "stop"})),
        json!({"type": "assistant/completed", "text": "hello", "reasoning": "", "finishReason": "stop", "rounds": 1, "denials": 0}),
        json!({"type": "turn/completed", "rounds": 1}),
    ]);
    vec![
        ("a failed run", broken("error")),
        ("a stopped run", broken("aborted")),
        ("a failed later round with a steer", later_round),
        ("a run of only its done", empty),
        ("a whole answer", whole),
    ]
}

#[test]
fn a_failed_runs_fragment_is_left_out_of_the_models_view_by_both_builds() {
    let store = typescript_store();
    if !store.exists() {
        eprintln!(
            "skipping: {} is not here, so the TypeScript oracle cannot be run",
            store.display()
        );
        return;
    }
    let logs = logs();

    // This build's answer first: the rule holds here whatever the oracle says.
    let here: Vec<Value> = logs
        .iter()
        .map(|(_, events)| derived_here(events))
        .collect();
    let text = |nodes: &Value| nodes.to_string();
    assert!(
        !text(&here[0]).contains("PARTIAL-99"),
        "a failed run's fragment is left out: {}",
        here[0]
    );
    assert!(
        text(&here[0]).contains("CUT-TEXT-173") && text(&here[0]).contains("NEXT turn"),
        "and the prompts stay: {}",
        here[0]
    );
    assert!(
        text(&here[1]).contains("PARTIAL-99 alpha "),
        "a stopped run keeps what streamed: {}",
        here[1]
    );
    assert!(
        text(&here[2]).contains("list_dir")
            && text(&here[2]).contains("STEER be brief")
            && !text(&here[2]).contains("It holds"),
        "the finished round and the steer stay, the broken round goes: {}",
        here[2]
    );

    let directory = tempfile::tempdir().unwrap();
    let input = directory.path().join("logs.json");
    let payload: Vec<&Vec<Value>> = logs.iter().map(|(_, events)| events).collect();
    std::fs::write(&input, serde_json::to_vec(&payload).unwrap()).unwrap();
    let script = directory.path().join("derive.mjs");
    std::fs::write(&script, DERIVER).unwrap();
    let output = match Command::new("node")
        .arg(&script)
        .arg(&input)
        .env("HEDDLE_TS_STORE", &store)
        .output()
    {
        Ok(output) => output,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            eprintln!("skipping: node is not installed, so the TypeScript oracle cannot be run");
            return;
        }
        Err(error) => panic!("running node failed: {error}"),
    };
    assert!(
        output.status.success(),
        "the oracle failed\nstdout: {}\nstderr: {}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8(output.stdout).expect("the oracle prints UTF-8");
    let there: Vec<Value> = serde_json::from_str(stdout.trim())
        .unwrap_or_else(|error| panic!("the oracle printed no JSON ({error}): {stdout}"));
    assert_eq!(there.len(), logs.len());
    for (((name, _), here), there) in logs.iter().zip(&here).zip(&there) {
        assert_eq!(
            here, there,
            "{name}: this build's nodes and messages (left) are the TypeScript build's (right)"
        );
    }
}
