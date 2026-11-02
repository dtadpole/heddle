//! A process that has begun to end writes no session log any more, and only then lets go of its writer locks (#248).
//!
//! `release_held_writer_locks` runs when the `heddle` binary is ending, and a turn a server started can outlive the
//! server's graceful close. Had it gone on appending after its lock file was removed, another process could have taken
//! the lock and both would have written the log. So the release first sets the process-wide exiting state, under the
//! lock every log write holds, and every later append is refused in words and writes nothing.
//!
//! This file holds one test on purpose: the exiting state is process-wide and cannot be undone, and each file under
//! `tests/` is its own process, so no other test sees it.

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use heddle_config::Env;
use heddle_session::{
    AppendOptions, CreateOptions, NewEvent, SessionError, SessionStore, decode_transcript,
    lock_path,
};

#[test]
fn once_the_process_is_exiting_a_write_is_refused_in_words_and_the_lock_is_gone() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_str().unwrap().to_string();
    let store = Arc::new(SessionStore::new(&root, &Env::default()));
    let handle = store
        .create(CreateOptions {
            cwd: Some(root.clone()),
            ..Default::default()
        })
        .unwrap();
    let lock = lock_path(&handle);
    assert!(Path::new(&lock).exists(), "the writer holds the session");

    // A writer that keeps appending, as a turn outliving the server's close would, until it is refused.
    let writer = {
        let store = Arc::clone(&store);
        let handle = handle.clone();
        std::thread::spawn(move || {
            let mut written = 0u64;
            loop {
                match store.append(
                    &handle,
                    NewEvent::new("test/still-running"),
                    AppendOptions::default(),
                ) {
                    Ok(_) => written += 1,
                    Err(error) => return (written, error),
                }
            }
        })
    };
    std::thread::sleep(Duration::from_millis(30));
    heddle_session::store::release_held_writer_locks();
    let (written, refusal) = writer.join().unwrap();

    assert!(written > 0, "the writer was writing while the release came");
    assert!(
        matches!(refusal, SessionError::Exiting),
        "its next append was refused: {refusal}"
    );
    assert_eq!(
        refusal.to_string(),
        "the session could not be saved: the process is exiting"
    );
    assert_eq!(refusal.code(), Some("session/exiting"));
    assert!(!Path::new(&lock).exists(), "the lock is gone");
    assert!(heddle_session::store::exiting());

    // Every append that was answered is on disk whole, and nothing else: no write landed after the gate closed.
    let bytes = std::fs::read(&handle.transcript).unwrap();
    let decoded = decode_transcript(&bytes);
    assert!(!decoded.torn, "no half-written frame");
    assert_eq!(
        decoded.lines.len() as u64,
        1 + written,
        "session/created and each answered append"
    );

    // A later append, from this store or a new one, is refused and writes nothing; so is a new session.
    let later = store.append(
        &handle,
        NewEvent::new("test/after"),
        AppendOptions::default(),
    );
    assert!(matches!(later, Err(SessionError::Exiting)));
    let fresh = SessionStore::new(&root, &Env::default());
    let reopened = fresh
        .open(&handle.id)
        .expect("the session is still readable");
    assert_eq!(
        fresh.read(&reopened).unwrap().len() as u64,
        1 + written,
        "reading still works"
    );
    assert!(matches!(
        fresh.append(
            &reopened,
            NewEvent::new("test/after"),
            AppendOptions::default()
        ),
        Err(SessionError::Exiting)
    ));
    assert!(!Path::new(&lock).exists(), "and took no new lock");
    assert!(matches!(
        fresh.create(CreateOptions {
            cwd: Some(root.clone()),
            ..Default::default()
        }),
        Err(SessionError::Exiting)
    ));
    assert_eq!(
        std::fs::read(&handle.transcript).unwrap(),
        bytes,
        "the log is as the release left it"
    );
}
