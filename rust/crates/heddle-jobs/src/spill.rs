//! A background command's complete output streams, kept in private spill files once they outgrow the in-memory
//! tail: the spill half of DSH's `OutputCollector` (`dsh-subprocess-local/lib/output.js:7-237`), which DSH's bash
//! provider gives every stream (`dsh-bash-local`: `maxOutputBytes` 64 000, `maxSpillBytes` 64 MiB).
//! `src/jobs/spill.ts` is the TypeScript twin.
//!
//! A job's ring keeps a bounded tail, so a model that falls behind reads a lossy delta. DSH's notice then names the
//! files holding the whole stream (`[some output was dropped from memory; full output: <paths>]`); without them the
//! notice could only say `(unavailable)`. The rules:
//!
//! - the file opens at the stream's **first overflow** of the in-memory tail, with the held chunks written first,
//!   so it holds the stream from byte 0;
//! - every later chunk is appended until the stream passes the spill cap; then the file is removed and spilling
//!   stops for good, because it could no longer hold the complete stream;
//! - an open or write failure discards the spill and is reported once; collection never stops for it;
//! - files live in a private (0700) per-process directory under the OS temp dir, named
//!   `heddle-jobs-<pid>-<n>-<hex>-<stream>.log`, created on the first spill, and kept after the job as
//!   full-output recovery artifacts.
//!
//! The producer still appends every chunk itself; the spill reaches the job as a pull source that answers no text,
//! only its path (`JobView.output.spill_paths`).

use std::fs::{DirBuilder, File, OpenOptions};
use std::io::Write;
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use crate::registry::{PullRead, PullSource};

/// The in-memory tail a stream keeps before it spills: DSH's bash `maxOutputBytes` default.
pub const DEFAULT_STREAM_TAIL_BYTES: u64 = 64_000;

/// The most a spill file holds: DSH's bash `maxSpillBytes` default (per stream).
pub const DEFAULT_MAX_SPILL_BYTES: u64 = 64 * 1024 * 1024;

/// Told once per stream when a spill fails.
pub type SpillFailure = Arc<dyn Fn(&std::io::Error, &str) + Send + Sync>;

/// Where and when a job's streams spill.
#[derive(Clone, Default)]
pub struct SpillSettings {
    /// Bytes a stream keeps in memory before it spills; [`DEFAULT_STREAM_TAIL_BYTES`] when absent.
    pub tail_bytes: Option<u64>,
    /// The most one spill file holds; [`DEFAULT_MAX_SPILL_BYTES`] when absent.
    pub max_bytes: Option<u64>,
    /// Where spill files go; the private per-process directory when absent.
    pub dir: Option<PathBuf>,
    /// Told once per stream when a spill fails; a stderr line when absent.
    pub on_failure: Option<SpillFailure>,
}

static SPILL_COUNTER: AtomicU64 = AtomicU64::new(0);
static DEFAULT_DIR: OnceLock<Result<PathBuf, String>> = OnceLock::new();

/// The private per-process spill directory, created on first use (`privateSpillDir`, OUTPUT:20-30).
pub fn private_spill_dir() -> std::io::Result<PathBuf> {
    DEFAULT_DIR
        .get_or_init(|| {
            let base = std::env::temp_dir();
            for _ in 0..16 {
                let dir = base.join(format!("heddle-jobs-{}", random_hex(6)));
                match DirBuilder::new().mode(0o700).create(&dir) {
                    Ok(()) => return Ok(dir),
                    Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                    Err(error) => return Err(error.to_string()),
                }
            }
            Err("could not create a private spill directory".to_owned())
        })
        .clone()
        .map_err(std::io::Error::other)
}

fn random_hex(bytes: usize) -> String {
    uuid::Uuid::new_v4().simple().to_string()[..bytes * 2].to_owned()
}

/// One stream's spill (`OutputCollector.push` / `spillAll` / `discardSpill` / `seal`, OUTPUT:115-224).
pub struct StreamSpill {
    label: String,
    tail_bytes: u64,
    max_bytes: u64,
    dir: Option<PathBuf>,
    on_failure: Option<SpillFailure>,
    /// The chunks a first overflow writes before itself; dropped once the file is open.
    held: Vec<Vec<u8>>,
    held_bytes: u64,
    file: Option<File>,
    path: Option<PathBuf>,
    disabled: bool,
    /// Bytes the stream has carried.
    pub total: u64,
}

impl StreamSpill {
    /// A spill for the stream called `label` (`stdout`, `stderr`).
    pub fn new(label: impl Into<String>, settings: &SpillSettings) -> Self {
        StreamSpill {
            label: label.into(),
            tail_bytes: settings.tail_bytes.unwrap_or(DEFAULT_STREAM_TAIL_BYTES),
            max_bytes: settings.max_bytes.unwrap_or(DEFAULT_MAX_SPILL_BYTES),
            dir: settings.dir.clone(),
            on_failure: settings.on_failure.clone(),
            held: Vec::new(),
            held_bytes: 0,
            file: None,
            path: None,
            disabled: false,
            total: 0,
        }
    }

    /// The complete-stream file, while it is intact.
    pub fn path(&self) -> Option<&PathBuf> {
        self.path.as_ref()
    }

    /// Take one raw chunk of the stream.
    pub fn push(&mut self, chunk: &[u8]) {
        if chunk.is_empty() {
            return;
        }
        self.total += chunk.len() as u64;
        if self.disabled {
            return;
        }
        if self.file.is_none() && self.held_bytes + chunk.len() as u64 <= self.tail_bytes {
            self.held.push(chunk.to_vec());
            self.held_bytes += chunk.len() as u64;
            return;
        }
        if self.total > self.max_bytes {
            self.discard();
            return;
        }
        if let Err(error) = self.spill(chunk) {
            self.discard();
            match &self.on_failure {
                Some(report) => report(&error, &self.label),
                None => eprintln!(
                    "heddle jobs: {} spill failed; only the in-memory tail is retained: {error}",
                    self.label
                ),
            }
        }
    }

    fn spill(&mut self, chunk: &[u8]) -> std::io::Result<()> {
        if self.file.is_none() {
            let dir = match &self.dir {
                Some(dir) => dir.clone(),
                None => private_spill_dir()?,
            };
            let n = SPILL_COUNTER.fetch_add(1, Ordering::SeqCst) + 1;
            let path = dir.join(format!(
                "heddle-jobs-{}-{n}-{}-{}.log",
                std::process::id(),
                random_hex(6),
                self.label
            ));
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&path)?;
            self.path = Some(path);
            for prior in std::mem::take(&mut self.held) {
                file.write_all(&prior)?;
            }
            self.held_bytes = 0;
            self.file = Some(file);
        }
        if let Some(file) = self.file.as_mut() {
            file.write_all(chunk)?;
        }
        Ok(())
    }

    /// Close the file once the stream ended. A failed flush stops advertising it: it may miss its tail. Idempotent.
    pub fn seal(&mut self) {
        self.held.clear();
        self.held_bytes = 0;
        if let Some(mut file) = self.file.take()
            && file.flush().and_then(|()| file.sync_data()).is_err()
        {
            self.path = None;
        }
    }

    /// Stop spilling and remove the file: it can no longer hold the complete stream, or nobody will ever name it.
    pub fn discard(&mut self) {
        self.file = None;
        self.disabled = true;
        self.held.clear();
        self.held_bytes = 0;
        if let Some(path) = self.path.take() {
            let _ = std::fs::remove_file(path);
        }
    }
}

/// A command's two streams' spills, shared between the producer that feeds them and the sources that report them.
#[derive(Clone)]
pub struct ProcessSpills {
    pub stdout: Arc<Mutex<StreamSpill>>,
    pub stderr: Arc<Mutex<StreamSpill>>,
}

impl ProcessSpills {
    /// Both streams' spills under one set of settings.
    pub fn new(settings: &SpillSettings) -> Self {
        ProcessSpills {
            stdout: Arc::new(Mutex::new(StreamSpill::new("stdout", settings))),
            stderr: Arc::new(Mutex::new(StreamSpill::new("stderr", settings))),
        }
    }

    /// Seal both, once the process ended.
    pub fn seal(&self) {
        lock(&self.stdout).seal();
        lock(&self.stderr).seal();
    }

    /// Remove both: a call that answered in the foreground names no file.
    pub fn discard(&self) {
        lock(&self.stdout).discard();
        lock(&self.stderr).discard();
    }

    /// The spills as the job's pull sources: no text (the producer appends every chunk itself), only each stream's
    /// current file, which the registry advertises as `output.spill_paths`.
    pub fn sources(&self) -> Vec<Box<dyn PullSource>> {
        vec![
            Box::new(SpillSource(Arc::clone(&self.stdout))),
            Box::new(SpillSource(Arc::clone(&self.stderr))),
        ]
    }
}

fn lock(spill: &Mutex<StreamSpill>) -> std::sync::MutexGuard<'_, StreamSpill> {
    spill
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

struct SpillSource(Arc<Mutex<StreamSpill>>);

impl PullSource for SpillSource {
    fn read(&mut self, from_byte: u64) -> Result<PullRead, String> {
        Ok(PullRead {
            text: String::new(),
            next_offset: from_byte,
            lossy: false,
            spill_path: lock(&self.0).path().map(|path| path.display().to_string()),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("heddle-jobs-spill-test-{}", random_hex(6)));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn settings(dir: &std::path::Path, tail: u64, max: Option<u64>) -> SpillSettings {
        SpillSettings {
            tail_bytes: Some(tail),
            max_bytes: max,
            dir: Some(dir.to_path_buf()),
            on_failure: None,
        }
    }

    #[test]
    fn the_defaults_are_dsh_bash_providers() {
        assert_eq!(DEFAULT_STREAM_TAIL_BYTES, 64_000);
        assert_eq!(DEFAULT_MAX_SPILL_BYTES, 64 * 1024 * 1024);
    }

    #[test]
    fn a_stream_within_its_tail_never_spills() {
        let dir = dir();
        let mut spill = StreamSpill::new("stdout", &settings(&dir, 10, None));
        spill.push(b"12345");
        spill.push(b"67890");
        spill.seal();
        assert!(spill.path().is_none());
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 0);
        assert_eq!(spill.total, 10);
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn the_first_overflow_writes_the_held_chunks_first_and_later_chunks_append() {
        let dir = dir();
        let mut spill = StreamSpill::new("stderr", &settings(&dir, 8, None));
        spill.push(b"abcd");
        spill.push(b"efgh");
        assert!(
            spill.path().is_none(),
            "exactly at the cap is not an overflow"
        );
        spill.push(b"ijkl");
        let path = spill
            .path()
            .cloned()
            .expect("the first overflow opens the file");
        let name = path.file_name().unwrap().to_string_lossy().into_owned();
        assert!(
            name.starts_with(&format!("heddle-jobs-{}-", std::process::id()))
                && name.ends_with("-stderr.log"),
            "{name}"
        );
        spill.push(b"mnop");
        spill.seal();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "abcdefghijklmnop");
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "private to the user");
        assert_eq!(
            spill.path(),
            Some(&path),
            "a sealed file is still advertised"
        );
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn past_the_spill_cap_the_file_is_removed_and_spilling_stops() {
        let dir = dir();
        let mut spill = StreamSpill::new("stdout", &settings(&dir, 4, Some(12)));
        spill.push(b"aaaa");
        spill.push(b"bbbb");
        let path = spill.path().cloned().expect("spilled");
        spill.push(b"cccc");
        assert_eq!(
            spill.path(),
            Some(&path),
            "exactly at the cap is still complete"
        );
        spill.push(b"d");
        assert!(spill.path().is_none());
        assert!(!path.exists(), "removed once it can no longer be complete");
        spill.push(b"eeee");
        assert!(spill.path().is_none(), "it never reopens");
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn a_spill_that_cannot_open_is_reported_once_and_collection_goes_on() {
        let failures = Arc::new(Mutex::new(Vec::<String>::new()));
        let seen = Arc::clone(&failures);
        let mut spill = StreamSpill::new(
            "stdout",
            &SpillSettings {
                tail_bytes: Some(2),
                max_bytes: None,
                dir: Some(std::env::temp_dir().join("heddle-jobs-no-such-dir-for-spill")),
                on_failure: Some(Arc::new(move |_error, label| {
                    seen.lock().unwrap().push(label.to_owned());
                })),
            },
        );
        spill.push(b"aa");
        spill.push(b"bb");
        spill.push(b"cc");
        assert_eq!(*failures.lock().unwrap(), vec!["stdout".to_owned()]);
        assert!(spill.path().is_none());
        assert_eq!(spill.total, 6);
    }

    #[test]
    fn the_default_directory_is_private_and_one_per_process() {
        let dir = private_spill_dir().unwrap();
        assert!(
            dir.file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("heddle-jobs-")
        );
        let mode = std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o700);
        assert_eq!(private_spill_dir().unwrap(), dir);
    }

    #[test]
    fn the_sources_report_each_streams_path_and_no_text() {
        let dir = dir();
        let spills = ProcessSpills::new(&settings(&dir, 2, None));
        lock(&spills.stdout).push(b"abc");
        let mut sources = spills.sources();
        let stdout = sources[0].read(7).unwrap();
        assert_eq!(stdout.text, "");
        assert_eq!(stdout.next_offset, 7);
        assert!(stdout.spill_path.unwrap().ends_with("-stdout.log"));
        assert_eq!(sources[1].read(0).unwrap().spill_path, None);
        spills.discard();
        assert_eq!(sources[0].read(7).unwrap().spill_path, None);
        std::fs::remove_dir_all(dir).ok();
    }
}
