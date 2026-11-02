//! Appending to a session's log **whole or not at all** (#221); `src/session/append.ts` in the TypeScript build.
//!
//! A log is a run of zstd frames, one per event, and the reader walks them and stops at the first one that is not
//! whole. An append that failed part-way — a full disk (ENOSPC) takes what fits and refuses the rest — left its partial
//! frame in the file, and the process went on: the next append, once the disk had room again, landed **after** it. The
//! open-time repair, right for a crash-torn tail (J155), then cut the file at the tear and dropped every later turn,
//! including the ones answered after the space came back (J183, measured on both builds).
//!
//! So an append records the file's length first, and when a write fails it cuts the file back to that length before it
//! reports the failure: the log ends in whole frames again, and the next append lands right after them. DSH does the
//! same (dsh-session-persistence-jsonl lib/index.js:3299-3335: `appendLines` takes the size before it writes and
//! `rollbackAppend` truncates back to it, then the error is rethrown). Neither build fsyncs an append, so the write is
//! the only step that can fail after bytes reached the file. The bytes are a whole frame — or, for a seed or the turn
//! closers, a whole batch of frames — encoded in memory first ([`crate::encode_frame`]), so the rollback covers all of
//! them.
//!
//! When even the cut fails, the file ends in bytes no reader can use, and an append after them would be lost on the next
//! open. The failure is then **poisoned** ([`AppendFailure::poisoned`]): the store refuses every later append of that
//! session with the same error until the session is opened again, and that open re-reads the file and cuts the torn tail
//! as J155 always has.
//!
//! The failure reaches a person in words, [`crate::SessionError::Unsaved`]: `the session could not be saved: no space
//! left on device`, the sentence the turn's error frame and its verdict carry. DSH has the same outcome for its
//! compaction ("Compaction finished, but the session could not be saved.", dsh-command-compact lib/index.js:40-43), and
//! its checkpoint policy fails a step closed when the session cannot be flushed (dsh-session-checkpoint-policy
//! lib/index.js:26-31, :66-75).

use std::io::{self, ErrorKind, Write};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

/// What a write that took no bytes is called, in both builds.
pub const NOTHING_WRITTEN: &str = "nothing was written";

/// The file one append writes to, so a test can fail any step: the real file is one.
pub trait AppendTarget {
    /// The file's length now.
    fn length(&mut self) -> io::Result<u64>;
    /// Write part of `bytes`; answers how many were taken.
    fn write_some(&mut self, bytes: &[u8]) -> io::Result<usize>;
    /// Cut the file back to `length` bytes.
    fn cut(&mut self, length: u64) -> io::Result<()>;
}

impl AppendTarget for std::fs::File {
    fn length(&mut self) -> io::Result<u64> {
        self.metadata().map(|meta| meta.len())
    }

    fn write_some(&mut self, bytes: &[u8]) -> io::Result<usize> {
        Write::write(self, bytes)
    }

    fn cut(&mut self, length: u64) -> io::Result<()> {
        self.set_len(length)
    }
}

/// An append that did not reach the log: why, in words, and whether the partial bytes are still in the file.
#[derive(Debug)]
pub struct AppendFailure {
    /// [`unsaved_reason`] of the error that stopped the write.
    pub reason: String,
    /// The partial bytes could not be cut away: the session's writer must refuse every later append.
    pub poisoned: bool,
    /// The error that stopped the write.
    pub source: io::Error,
}

impl AppendFailure {
    fn new(source: io::Error, poisoned: bool) -> Self {
        AppendFailure {
            reason: unsaved_reason(&source),
            poisoned,
            source,
        }
    }
}

/// `EDQUOT`, which is numbered differently on Linux than on macOS and the BSDs.
#[cfg(any(target_os = "linux", target_os = "android"))]
const EDQUOT: i32 = 122;
#[cfg(all(unix, not(any(target_os = "linux", target_os = "android"))))]
const EDQUOT: i32 = 69;

/// The words for a failed save, the same words `unsavedReason` in `src/session/append.ts` answers for the same codes:
/// ENOSPC (the one J183 met) is `no space left on device`. An error with no known code is described by its own text,
/// without the ` (os error N)` suffix. Never a path: the sentence reaches the page, and a path would put the store's
/// location, home directory included, into a turn's error frame (#130).
pub fn unsaved_reason(error: &io::Error) -> String {
    #[cfg(unix)]
    if let Some(code) = error.raw_os_error() {
        let known = match code {
            28 => Some("no space left on device"),
            EDQUOT => Some("disk quota exceeded"),
            30 => Some("read-only file system"),
            13 => Some("permission denied"),
            1 => Some("operation not permitted"),
            5 => Some("input/output error"),
            27 => Some("file too large"),
            2 => Some("no such file or directory"),
            _ => None,
        };
        if let Some(words) = known {
            return words.to_owned();
        }
    }
    let known = match error.kind() {
        ErrorKind::StorageFull => Some("no space left on device"),
        ErrorKind::ReadOnlyFilesystem => Some("read-only file system"),
        ErrorKind::PermissionDenied => Some("permission denied"),
        ErrorKind::FileTooLarge => Some("file too large"),
        ErrorKind::NotFound => Some("no such file or directory"),
        ErrorKind::WriteZero => Some(NOTHING_WRITTEN),
        _ => None,
    };
    if let Some(words) = known {
        return words.to_owned();
    }
    let text = error.to_string();
    let text = text
        .rfind(" (os error ")
        .map_or(text.as_str(), |at| &text[..at])
        .trim();
    let mut characters = text.chars();
    match characters.next() {
        Some(first) => first.to_lowercase().chain(characters).collect(),
        None => "an unknown error".to_owned(),
    }
}

/// Append `bytes` to `target` whole, or cut it back to the length it had and answer why.
///
/// The length is read before the first write; a write that fails, or takes no bytes, is followed by a cut back to that
/// length. A cut that fails too answers a **poisoned** failure carrying the write's reason.
pub fn append_to(target: &mut dyn AppendTarget, bytes: &[u8]) -> Result<(), AppendFailure> {
    let before = target
        .length()
        .map_err(|error| AppendFailure::new(error, false))?;
    let mut offset = 0;
    while offset < bytes.len() {
        let error = match target.write_some(&bytes[offset..]) {
            Ok(0) => io::Error::new(ErrorKind::WriteZero, NOTHING_WRITTEN),
            Ok(taken) => {
                offset += taken;
                continue;
            }
            Err(error) if error.kind() == ErrorKind::Interrupted => continue,
            Err(error) => error,
        };
        let poisoned = target.cut(before).is_err();
        return Err(AppendFailure::new(error, poisoned));
    }
    Ok(())
}

/// Append `bytes` to the file at `path` whole, creating it, or leave it as it was ([`append_to`]).
pub fn append_whole(path: &str, bytes: &[u8]) -> Result<(), AppendFailure> {
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|error| AppendFailure::new(error, false))?;
    #[cfg(test)]
    if faults::armed() {
        return append_to(&mut faults::Faulty(file), bytes);
    }
    append_to(&mut file, bytes)
}

static REPLACEMENTS: AtomicU64 = AtomicU64::new(0);

/// Replace the file at `path` with `bytes` in one step: a temporary file beside it, written whole and synced, then
/// renamed over it, so a crash leaves the old file or the new one and never a mix. A failure removes the temporary file
/// and leaves `path` as it was.
///
/// The repair of a log torn in the middle ([`crate::transcript::recover_transcript`]) is the one caller; it syncs because
/// it replaces the whole record rather than adding to it. `replaceWhole` in the TypeScript build.
pub fn replace_whole(path: &str, bytes: &[u8]) -> io::Result<()> {
    let target = Path::new(path);
    let name = target
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let unique = REPLACEMENTS.fetch_add(1, Ordering::Relaxed) + 1;
    let temporary = target.with_file_name(format!(".{name}.{}.{unique}.tmp", std::process::id()));
    let written = (|| {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&temporary, target)
    })();
    if written.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    written
}

/// A disk that fills up, for the tests of this crate: while armed on a thread, the appends made on it take `room` bytes
/// in all and then fail with ENOSPC, and a cut fails with EIO when `cut_fails` says so.
#[cfg(test)]
pub(crate) mod faults {
    use std::cell::Cell;
    use std::io;

    use super::AppendTarget;

    thread_local! {
        static ROOM: Cell<Option<usize>> = const { Cell::new(None) };
        static CUT_FAILS: Cell<bool> = const { Cell::new(false) };
    }

    /// Disarms the fault when dropped.
    pub(crate) struct Armed;

    impl Drop for Armed {
        fn drop(&mut self) {
            ROOM.with(|room| room.set(None));
            CUT_FAILS.with(|fails| fails.set(false));
        }
    }

    /// Fill the disk: the appends on this thread take `room` more bytes, then fail.
    pub(crate) fn full_disk(room: usize, cut_fails: bool) -> Armed {
        ROOM.with(|cell| cell.set(Some(room)));
        CUT_FAILS.with(|cell| cell.set(cut_fails));
        Armed
    }

    pub(super) fn armed() -> bool {
        ROOM.with(Cell::get).is_some()
    }

    /// The real file behind a disk with `room` bytes left.
    pub(super) struct Faulty(pub(super) std::fs::File);

    impl AppendTarget for Faulty {
        fn length(&mut self) -> io::Result<u64> {
            self.0.length()
        }

        fn write_some(&mut self, bytes: &[u8]) -> io::Result<usize> {
            let room = ROOM.with(Cell::get).unwrap_or(usize::MAX);
            if room == 0 {
                return Err(io::Error::from_raw_os_error(28));
            }
            let taken = self.0.write_some(&bytes[..bytes.len().min(room)])?;
            ROOM.with(|cell| cell.set(Some(room - taken)));
            Ok(taken)
        }

        fn cut(&mut self, length: u64) -> io::Result<()> {
            if CUT_FAILS.with(Cell::get) {
                return Err(io::Error::from_raw_os_error(5));
            }
            self.0.cut(length)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A file in memory whose disk takes `room` bytes, and whose cut fails when asked to.
    struct Memory {
        bytes: Vec<u8>,
        room: usize,
        cut_fails: bool,
        zero: bool,
    }

    impl AppendTarget for Memory {
        fn length(&mut self) -> io::Result<u64> {
            Ok(self.bytes.len() as u64)
        }

        fn write_some(&mut self, bytes: &[u8]) -> io::Result<usize> {
            if self.zero {
                return Ok(0);
            }
            if self.room == 0 {
                return Err(io::Error::from_raw_os_error(28));
            }
            let taken = bytes.len().min(self.room).min(7);
            self.bytes.extend_from_slice(&bytes[..taken]);
            self.room -= taken;
            Ok(taken)
        }

        fn cut(&mut self, length: u64) -> io::Result<()> {
            if self.cut_fails {
                return Err(io::Error::from_raw_os_error(5));
            }
            self.bytes.truncate(length as usize);
            Ok(())
        }
    }

    fn memory(room: usize) -> Memory {
        Memory {
            bytes: b"whole".to_vec(),
            room,
            cut_fails: false,
            zero: false,
        }
    }

    #[test]
    fn an_append_in_short_writes_lands_whole() {
        let mut file = memory(usize::MAX);
        append_to(&mut file, b" and twenty more bytes").unwrap();
        assert_eq!(file.bytes, b"whole and twenty more bytes");
    }

    #[test]
    fn a_write_the_disk_refuses_part_way_is_cut_back_and_says_why_in_words() {
        let mut file = memory(9);
        let failure = append_to(&mut file, b" and twenty more bytes").unwrap_err();
        assert_eq!(
            file.bytes, b"whole",
            "the partial bytes are gone: the file ends where it ended"
        );
        assert_eq!(failure.reason, "no space left on device");
        assert!(!failure.poisoned);
        assert_eq!(failure.source.raw_os_error(), Some(28));
    }

    #[test]
    fn a_cut_that_fails_too_is_poisoned_and_keeps_the_writes_reason() {
        let mut file = memory(9);
        file.cut_fails = true;
        let failure = append_to(&mut file, b" and twenty more bytes").unwrap_err();
        assert!(failure.poisoned);
        assert_eq!(failure.reason, "no space left on device");
        assert_eq!(
            file.bytes.len(),
            5 + 9,
            "the partial bytes stay: this is why the writer must refuse"
        );
    }

    #[test]
    fn a_write_that_takes_nothing_is_a_failure_and_is_cut_back() {
        let mut file = memory(usize::MAX);
        file.zero = true;
        let failure = append_to(&mut file, b"more").unwrap_err();
        assert_eq!(failure.reason, NOTHING_WRITTEN);
        assert_eq!(file.bytes, b"whole");
    }

    #[cfg(unix)]
    #[test]
    fn every_known_code_has_the_typescript_builds_words() {
        let words = |code: i32| unsaved_reason(&io::Error::from_raw_os_error(code));
        assert_eq!(words(28), "no space left on device");
        assert_eq!(words(EDQUOT), "disk quota exceeded");
        assert_eq!(words(30), "read-only file system");
        assert_eq!(words(13), "permission denied");
        assert_eq!(words(1), "operation not permitted");
        assert_eq!(words(5), "input/output error");
        assert_eq!(words(27), "file too large");
        assert_eq!(words(2), "no such file or directory");
        assert_eq!(
            unsaved_reason(&io::Error::other("Something Odd")),
            "something Odd",
            "an unknown error is its own text, first letter lowered"
        );
        assert!(
            !words(18).contains("os error"),
            "an unmapped code drops the os error suffix: {}",
            words(18)
        );
    }

    #[test]
    fn a_replaced_file_holds_the_new_bytes_and_nothing_is_left_beside_it() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("session-x.v2.jsonl.zstd");
        std::fs::write(&path, b"old bytes").unwrap();
        replace_whole(path.to_str().unwrap(), b"new").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"new");
        let names: Vec<String> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec!["session-x.v2.jsonl.zstd".to_owned()]);
    }
}

/// The store over a disk that fills up ([`faults`]): the failed append is cut back, a later one lands right after the
/// whole frames, a reopen reads every event, and a cut that fails poisons the writer until the session is reopened.
#[cfg(test)]
mod store_tests {
    use std::sync::Arc;

    use heddle_config::Env;

    use super::faults;
    use crate::event::{AppendOptions, NewEvent, SessionEvent, SessionHandle};
    use crate::meta::CreateOptions;
    use crate::{SessionError, SessionStore, decode_transcript};

    fn store(dir: &std::path::Path) -> SessionStore {
        SessionStore::new(dir.to_str().unwrap(), &Env::default())
    }

    fn session(store: &SessionStore, dir: &std::path::Path) -> SessionHandle {
        store
            .create(CreateOptions {
                cwd: Some(dir.to_string_lossy().into_owned()),
                ..CreateOptions::default()
            })
            .unwrap()
    }

    fn note(
        store: &SessionStore,
        handle: &SessionHandle,
        text: &str,
    ) -> Result<Arc<SessionEvent>, SessionError> {
        store.append(
            handle,
            NewEvent::new("note").field("text", text),
            AppendOptions::default(),
        )
    }

    fn texts(events: &[Arc<SessionEvent>]) -> Vec<String> {
        events
            .iter()
            .filter(|event| event.kind == "note")
            .map(|event| {
                event
                    .get("text")
                    .and_then(|text| text.as_str())
                    .unwrap_or("")
                    .to_owned()
            })
            .collect()
    }

    fn seqs(events: &[Arc<SessionEvent>]) -> Vec<u64> {
        events.iter().map(|event| event.seq).collect()
    }

    /// Text that compresses poorly, so its frame is far larger than the room the disk has left.
    fn long(label: &str) -> String {
        let mut state = 0x2545_f491_u32;
        let tail: String = (0..4000)
            .map(|_| {
                state ^= state << 13;
                state ^= state >> 17;
                state ^= state << 5;
                char::from(b'!' + (state % 90) as u8)
            })
            .collect();
        format!("{label} {tail}")
    }

    #[test]
    fn an_append_the_full_disk_refuses_mid_frame_is_cut_back_and_the_next_lands_after_the_whole_frames()
     {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        let handle = session(&store, dir.path());
        note(&store, &handle, "t1").unwrap();
        note(&store, &handle, "t2").unwrap();
        let whole = std::fs::read(&handle.transcript).unwrap();
        let count = store.count(&handle).unwrap();

        let error = {
            let _full = faults::full_disk(100, false);
            note(&store, &handle, &long("t4")).unwrap_err()
        };
        assert_eq!(
            error.to_string(),
            "the session could not be saved: no space left on device"
        );
        assert!(matches!(error, SessionError::Unsaved { .. }));
        assert_eq!(
            std::fs::read(&handle.transcript).unwrap(),
            whole,
            "the partial frame is gone: the log ends in the whole frames it had"
        );
        assert_eq!(
            store.count(&handle).unwrap(),
            count,
            "and the fold never took the event"
        );

        let t6 = note(&store, &handle, "t6").unwrap();
        assert_eq!(t6.seq, count, "the next append takes the failed one's seq");
        let after = std::fs::read(&handle.transcript).unwrap();
        assert_eq!(
            &after[..whole.len()],
            &whole[..],
            "and lands right after the whole frames"
        );
        assert!(!decode_transcript(&after).torn);

        let reopened = store_reopened(dir.path(), &store, &handle);
        let events = reopened.read(&handle).unwrap();
        assert_eq!(
            texts(&events),
            ["t1", "t2", "t6"],
            "a reopen reads every whole event"
        );
        assert_eq!(seqs(&events), (0..events.len() as u64).collect::<Vec<_>>());
        assert!(
            !events
                .iter()
                .any(|event| event.kind == "transcript/repaired"),
            "and has nothing to repair"
        );
    }

    /// A second store over the same root, after the first let go: a reopen, as the next process would do it.
    fn store_reopened(
        dir: &std::path::Path,
        first: &SessionStore,
        handle: &SessionHandle,
    ) -> SessionStore {
        first.release(handle);
        let second = store(dir);
        second.claim(handle).unwrap();
        second
    }

    #[test]
    fn a_cut_that_fails_poisons_the_writer_until_the_session_is_reopened() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        let handle = session(&store, dir.path());
        note(&store, &handle, "t1").unwrap();
        let whole = std::fs::read(&handle.transcript).unwrap().len();

        let error = {
            let _full = faults::full_disk(100, true);
            note(&store, &handle, &long("t4")).unwrap_err()
        };
        assert_eq!(
            error.to_string(),
            "the session could not be saved: no space left on device"
        );
        let torn = std::fs::read(&handle.transcript).unwrap();
        assert_eq!(
            torn.len(),
            whole + 100,
            "the partial bytes stayed: the cut failed"
        );

        let refused = note(&store, &handle, "t5").unwrap_err();
        assert_eq!(
            refused.to_string(),
            error.to_string(),
            "a later append is refused with the same sentence, though the disk has room again"
        );
        assert_eq!(
            std::fs::read(&handle.transcript).unwrap(),
            torn,
            "and writes nothing after the torn bytes"
        );

        let reopened = store_reopened(dir.path(), &store, &handle);
        note(&reopened, &handle, "t6").unwrap();
        let events = reopened.read(&handle).unwrap();
        assert_eq!(
            texts(&events),
            ["t1", "t6"],
            "the reopen cut the torn tail and writes again"
        );
        let repaired: Vec<_> = events
            .iter()
            .filter(|event| event.kind == "transcript/repaired")
            .collect();
        assert_eq!(repaired.len(), 1);
        assert_eq!(
            repaired[0].get("droppedBytes"),
            Some(&serde_json::json!(100))
        );
        assert!(!decode_transcript(&std::fs::read(&handle.transcript).unwrap()).torn);
    }

    #[test]
    fn a_log_an_older_build_tore_in_the_middle_keeps_the_turns_after_the_tear_on_reopen() {
        // J183's log, as the builds before the rollback left it: t4's partial frame, then t6 appended after it with
        // the seqs that continue the whole frames before the tear.
        let dir = tempfile::tempdir().unwrap();
        let first = store(dir.path());
        let handle = session(&first, dir.path());
        note(&first, &handle, "t1").unwrap();
        let next = first.count(&handle).unwrap();
        first.release(&handle);
        drop(first);
        let line = |seq: u64, text: &str| {
            crate::encode_frame(&format!(
                "{{\"seq\":{seq},\"at\":\"2026-11-01T00:00:00.000Z\",\"type\":\"note\",\"text\":\"{text}\"}}\n"
            ))
        };
        let torn = line(next, &long("t4"));
        let mut bytes = std::fs::read(&handle.transcript).unwrap();
        let whole = bytes.len();
        bytes.extend_from_slice(&torn[..torn.len() / 3]);
        bytes.extend_from_slice(&line(next, "t6"));
        bytes.extend_from_slice(&line(next + 1, "t6 answered"));
        std::fs::write(&handle.transcript, &bytes).unwrap();

        let reopened = store(dir.path());
        reopened.claim(&handle).unwrap();
        let events = reopened.read(&handle).unwrap();
        assert_eq!(
            texts(&events),
            ["t1", "t6", "t6 answered"],
            "the turns after the tear are kept"
        );
        assert_eq!(seqs(&events), (0..events.len() as u64).collect::<Vec<_>>());
        let repaired = events.last().unwrap();
        assert_eq!(repaired.kind, "transcript/repaired");
        assert_eq!(
            repaired.get("droppedBytes"),
            Some(&serde_json::json!(torn.len() / 3))
        );
        assert_eq!(
            repaired.get("droppedRanges"),
            Some(&serde_json::json!([{"offset": whole, "length": torn.len() / 3}])),
            "and the repair names the bytes it took out"
        );
        let on_disk = decode_transcript(&std::fs::read(&handle.transcript).unwrap());
        assert!(!on_disk.torn, "the log is written again whole");
        assert_eq!(on_disk.lines.len(), events.len());
        drop(reopened);
        let again = store(dir.path());
        assert_eq!(
            texts(&again.read(&handle).unwrap()),
            ["t1", "t6", "t6 answered"],
            "and a later open reads the same"
        );
    }

    #[test]
    fn a_fork_seed_the_disk_refuses_part_way_leaves_only_whole_frames() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        let source = session(&store, dir.path());
        for index in 0..6 {
            note(&store, &source, &long(&format!("source {index}"))).unwrap();
        }
        let error = {
            // Room for the child's `session/created`, then part of the seed batch.
            let _full = faults::full_disk(2_000, false);
            store
                .fork(&source.id, crate::meta::ForkAttribution::default())
                .unwrap_err()
        };
        assert_eq!(
            error.to_string(),
            "the session could not be saved: no space left on device"
        );
        let child = store
            .list()
            .into_iter()
            .map(|meta| meta.id().to_owned())
            .find(|id| id != &source.id)
            .expect("the child was created before its seed failed");
        let child = store.open(&child).unwrap();
        let bytes = std::fs::read(&child.transcript).unwrap();
        let decoded = decode_transcript(&bytes);
        assert!(!decoded.torn, "the seed's partial batch is gone");
        assert_eq!(
            decoded.lines.len(),
            1,
            "the child holds its own session/created alone"
        );
    }
}
