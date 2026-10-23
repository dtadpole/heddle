//! The other half of the interop claim: a log written here is read by the TypeScript build's own
//! decoder.
//!
//! The forward half — a transcript whose frames Node's `zlib` wrote reads here — is a unit test with
//! recorded bytes (`store.rs`). This one runs the oracle itself: `src/session/transcript.ts`'s
//! `decodeTranscript`, imported by the Node that is on this machine, over a transcript this crate just
//! wrote. It is the claim `heddle-session`'s port plan calls step 9.
//!
//! Node 23.6 and later strip TypeScript types by default, and `transcript.ts` imports only `node:zlib`,
//! so the module loads without a build step. When Node is not installed the test says so and returns:
//! a missing oracle is not a failing port, and the forward half still holds.

use std::path::PathBuf;
use std::process::Command;

use heddle_config::Env;
use heddle_session::{AppendOptions, NewEvent, SessionConfig, SessionService, StartOptions};

/// The repository's TypeScript decoder, resolved from this crate's source directory.
fn typescript_transcript() -> PathBuf {
    let mut path = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    path.pop(); // crates
    path.pop(); // rust
    path.pop(); // the repository root
    path.join("src/session/transcript.ts")
}

/// A script that decodes one transcript with the TypeScript module and prints the result as JSON.
const DECODER: &str = r#"
import { readFileSync } from 'node:fs'

const { decodeTranscript } = await import(process.env.HEDDLE_TS_TRANSCRIPT)
const decoded = decodeTranscript(readFileSync(process.argv[2]))
process.stdout.write(JSON.stringify(decoded) + '\n')
"#;

#[test]
fn the_typescript_decoder_reads_what_we_write() {
    let transcript = typescript_transcript();
    if !transcript.exists() {
        eprintln!(
            "skipping: {} is not here, so the TypeScript oracle cannot be run",
            transcript.display()
        );
        return;
    }

    // A real session: the creation event, a user message and a turn boundary — three frames.
    let home = tempfile::tempdir().unwrap();
    let service = SessionService::new(
        &SessionConfig {
            root: Some(home.path().join("sessions").to_string_lossy().into_owned()),
        },
        &Env::default(),
        None,
    );
    let handle = service
        .start(StartOptions {
            cwd: Some("/home/me/work".to_string()),
            ..Default::default()
        })
        .unwrap();
    service
        .user(&handle, "remember the word loom", None)
        .unwrap();
    service
        .store()
        .append(
            &handle,
            NewEvent::new("turn/completed"),
            AppendOptions::default(),
        )
        .unwrap();

    let bytes = service.store().bytes(&handle);
    assert!(!bytes.is_empty());

    let script = home.path().join("decode.mjs");
    std::fs::write(&script, DECODER).unwrap();
    let output = match Command::new("node")
        .arg(&script)
        .arg(&handle.transcript)
        .env("HEDDLE_TS_TRANSCRIPT", &transcript)
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
        "the TypeScript decoder failed\nstdout: {}\nstderr: {}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );

    let stdout = String::from_utf8(output.stdout).expect("the decoder prints UTF-8");
    let decoded: serde_json::Value = serde_json::from_str(stdout.trim())
        .unwrap_or_else(|error| panic!("the decoder printed no JSON ({error}): {stdout}"));
    assert_eq!(decoded["format"], "zstd-frames");
    assert_eq!(decoded["torn"], false, "the TypeScript reader sees no tear");
    assert_eq!(
        decoded["readableBytes"].as_u64().unwrap() as usize,
        bytes.len(),
        "the TypeScript reader consumed the whole file"
    );
    assert_eq!(decoded["frames"], 3);

    let lines: Vec<String> = decoded["lines"]
        .as_array()
        .expect("the decoder answers with lines")
        .iter()
        .map(|line| line.as_str().expect("a line is a string").to_string())
        .collect();
    let expected: Vec<String> = service
        .events(&handle)
        .unwrap()
        .iter()
        .map(|event| event.to_line())
        .collect();
    assert_eq!(
        lines, expected,
        "the TypeScript reader derives the same events this build wrote"
    );
    assert!(
        lines
            .iter()
            .any(|line| line.contains("remember the word loom")),
        "and the user's words are in them"
    );
}
