//! A session's writer lock whose holder is gone never blocks the session, in either build's words (#202).
//!
//! J178: after a crash every lock the server held names its dead pid, and when the system gives that pid to another
//! live process — or the lock names pid 1, which this user may not signal — every later turn was refused with
//! `already owned by an active write handle (process N)` for as long as that process lived. DSH's flock dies with its
//! holder (dsh-session-persistence-jsonl lib/index.js:692-716). The twin of `test/session-lock.test.ts`, through the
//! public API, and, where Node is installed, with a lock the TypeScript store holds and one it meets.
//!
//! What a check needs to know about this system — this boot's id, a process's start and command name — is read
//! **here**, from the sources the protocol names, rather than through `heddle_session::writer_lock`, so a check cannot
//! agree with the code it judges by construction. The shared lock files are `writer_lock.rs`'s unit tests'.

#![cfg(unix)]

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, SystemTime};

use heddle_config::Env;
use heddle_session::{AppendOptions, CreateOptions, NewEvent, SessionHandle, SessionStore};
use serde_json::Value;

/// The repository root, from this crate's directory.
fn repository() -> PathBuf {
    let mut path = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    path.pop(); // crates
    path.pop(); // rust
    path.pop(); // the repository root
    path
}

/// Whether this system says a process's start and its boot, which the identity checks need.
fn identity_readable() -> bool {
    cfg!(any(target_os = "linux", target_os = "macos"))
}

fn output(program: &str, args: &[&str]) -> Option<String> {
    let out = Command::new(program)
        .args(args)
        .env_clear()
        .env("LC_ALL", "C")
        .env("TZ", "UTC0")
        .stderr(Stdio::null())
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (out.status.success() && !text.is_empty()).then_some(text)
}

/// This boot's id: Linux's `boot_id`, macOS's `kern.bootsessionuuid`.
fn boot_id() -> Option<String> {
    if cfg!(target_os = "linux") {
        std::fs::read_to_string("/proc/sys/kernel/random/boot_id")
            .ok()
            .map(|boot| boot.trim().to_string())
    } else {
        output("/usr/sbin/sysctl", &["-n", "kern.bootsessionuuid"])
    }
}

/// A process's start: field 22 of `/proc/<pid>/stat` on Linux; on macOS its `lstart`, UTC, as seconds since 1970,
/// converted by `date` rather than by this crate.
fn process_start(pid: u32) -> Option<String> {
    if cfg!(target_os = "linux") {
        let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
        stat[stat.rfind(')')? + 1..]
            .split_whitespace()
            .nth(19)
            .map(str::to_string)
    } else {
        let lstart = output("/bin/ps", &["-o", "lstart=", "-p", &pid.to_string()])?;
        let lstart = lstart.split_whitespace().collect::<Vec<_>>().join(" ");
        output(
            "/bin/date",
            &["-j", "-u", "-f", "%a %b %e %T %Y", &lstart, "+%s"],
        )
    }
}

/// A process's command name: `/proc/<pid>/comm` on Linux, `ucomm` on macOS.
fn command_name(pid: u32) -> Option<String> {
    if cfg!(target_os = "linux") {
        std::fs::read_to_string(format!("/proc/{pid}/comm"))
            .ok()
            .map(|name| name.trim().to_string())
    } else {
        output("/bin/ps", &["-o", "ucomm=", "-p", &pid.to_string()])
    }
}

/// A lock file's bytes for a pid, a boot and a start.
fn lock_bytes(pid: u32, boot: Option<&str>, start: Option<&str>) -> String {
    let mut line = pid.to_string();
    if let Some(boot) = boot {
        line.push_str(&format!(" boot={boot}"));
    }
    if let Some(start) = start {
        line.push_str(&format!(" start={start}"));
    }
    line + "\n"
}

/// The lock a process writes, by its pid.
fn lock_of(pid: u32) -> String {
    lock_bytes(pid, boot_id().as_deref(), process_start(pid).as_deref())
}

/// The refusal, word for word: DSH's sentence, the process, the lock file, and how to clear it.
fn refusal(id: &str, pid: u32, name: Option<&str>, lock: &str) -> String {
    let process = match name {
        Some(name) => format!("process {pid}, {name}"),
        None => format!("process {pid}"),
    };
    format!(
        "session \"{id}\" is already owned by an active write handle ({process}). Its lock file is {lock}, beside \
         the session's log; if process {pid} is not heddle, delete that file and try again."
    )
}

/// A live process that is not heddle, standing in for one the system gave a dead holder's pid to (J178's `sleep`).
struct Unrelated(Child);

impl Unrelated {
    fn spawn() -> Self {
        Unrelated(
            Command::new("sleep")
                .arg("30")
                .spawn()
                .expect("a second process"),
        )
    }
    fn pid(&self) -> u32 {
        self.0.id()
    }
}

impl Drop for Unrelated {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// A session this process created and let go of, so its lock file can be written as another process left it.
fn released_session(root: &Path) -> (SessionHandle, PathBuf) {
    let store = SessionStore::new(root.to_str().unwrap(), &Env::default());
    let handle = store
        .create(CreateOptions {
            cwd: Some(root.to_string_lossy().into_owned()),
            ..Default::default()
        })
        .unwrap();
    store.release(&handle);
    let lock = Path::new(&handle.dir).join(format!("{}.lock", handle.id));
    (handle, lock)
}

/// Append once from a fresh store, as the next server would after a restart: the lock it then holds, or the refusal.
fn append_fresh(root: &Path, handle: &SessionHandle) -> Result<String, String> {
    let store = SessionStore::new(root.to_str().unwrap(), &Env::default());
    let reopened = store.open(&handle.id).expect("the session is on disk");
    match store.append(
        &reopened,
        NewEvent::new("test/after-a-crash"),
        AppendOptions::default(),
    ) {
        Ok(_) => {
            let lock = std::fs::read_to_string(heddle_session::lock_path(&reopened)).unwrap();
            store.release(&reopened);
            Ok(lock)
        }
        Err(error) => Err(error.to_string()),
    }
}

/// Whether a fresh store's reader sees the session held.
fn held_for_readers(root: &Path, handle: &SessionHandle) -> bool {
    let store = SessionStore::new(root.to_str().unwrap(), &Env::default());
    let reopened = store.open(&handle.id).expect("the session is on disk");
    store.writer_held(&reopened)
}

fn set_modified(path: &Path, when: SystemTime) {
    std::fs::OpenOptions::new()
        .write(true)
        .open(path)
        .unwrap()
        .set_modified(when)
        .unwrap();
}

#[test]
fn a_pid_only_lock_whose_pid_now_names_a_process_that_started_after_it_was_written_is_taken_over() {
    let dir = tempfile::tempdir().unwrap();
    let (handle, lock) = released_session(dir.path());
    let other = Unrelated::spawn();
    // The lock a build before #202 left an hour ago; its pid is now the unrelated process's.
    std::fs::write(&lock, format!("{}\n", other.pid())).unwrap();
    set_modified(&lock, SystemTime::now() - Duration::from_secs(3600));
    assert!(
        !held_for_readers(dir.path(), &handle),
        "a reader does not take the unrelated process for the writer"
    );
    let taken = append_fresh(dir.path(), &handle).expect("the next writer takes the lock");
    assert_eq!(
        taken,
        lock_of(std::process::id()),
        "and the lock now names this process, its boot and its start"
    );
}

#[test]
fn a_lock_that_records_another_start_than_its_pid_now_has_is_taken_over() {
    if !identity_readable() {
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let (handle, lock) = released_session(dir.path());
    let other = Unrelated::spawn();
    std::fs::write(
        &lock,
        lock_bytes(other.pid(), boot_id().as_deref(), Some("1")),
    )
    .unwrap();
    assert!(!held_for_readers(dir.path(), &handle));
    let taken = append_fresh(dir.path(), &handle).expect("the next writer takes the lock");
    assert_eq!(taken, lock_of(std::process::id()));
}

#[test]
fn a_lock_written_in_another_boot_is_taken_over_even_when_its_pid_and_start_match_a_live_process() {
    if !identity_readable() {
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let (handle, lock) = released_session(dir.path());
    let other = Unrelated::spawn();
    let start = process_start(other.pid());
    assert!(start.is_some());
    std::fs::write(
        &lock,
        lock_bytes(
            other.pid(),
            Some("00000000-0000-4000-8000-000000000000"),
            start.as_deref(),
        ),
    )
    .unwrap();
    assert!(!held_for_readers(dir.path(), &handle));
    let taken = append_fresh(dir.path(), &handle).expect("the next writer takes the lock");
    assert_eq!(taken, lock_of(std::process::id()));
}

#[test]
fn a_pid_only_lock_naming_pid_1_a_process_this_user_may_not_signal_is_taken_over() {
    if !identity_readable() {
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let (handle, lock) = released_session(dir.path());
    let me = std::os::unix::fs::MetadataExt::uid(&std::fs::metadata(&handle.transcript).unwrap());
    if me == 0 {
        return; // pid 1 is this user's here
    }
    // Written just now, so pid 1 started long before it: the rule that decides is the user, not the start.
    std::fs::write(&lock, "1\n").unwrap();
    assert!(
        !held_for_readers(dir.path(), &handle),
        "a reader does not take pid 1 for the writer"
    );
    let taken = append_fresh(dir.path(), &handle).expect("the next writer takes the lock");
    assert_eq!(taken, lock_of(std::process::id()));
}

#[test]
fn a_lock_whose_holder_is_alive_and_is_the_process_it_records_is_refused_naming_the_process_and_the_file()
 {
    if !identity_readable() {
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let (handle, lock) = released_session(dir.path());
    let lock_name = format!("{}.lock", handle.id);
    {
        let holder = Unrelated::spawn();
        let name = command_name(holder.pid());
        let written = lock_of(holder.pid());
        std::fs::write(&lock, &written).unwrap();
        assert!(
            held_for_readers(dir.path(), &handle),
            "a reader sees the session held"
        );
        let refused =
            append_fresh(dir.path(), &handle).expect_err("a live holder is never expropriated");
        assert_eq!(
            refused,
            refusal(&handle.id, holder.pid(), name.as_deref(), &lock_name)
        );
        assert_eq!(
            std::fs::read_to_string(&lock).unwrap(),
            written,
            "and its lock is left as it was"
        );
        // A pid-only lock written after its process started is that process's too.
        std::fs::write(&lock, format!("{}\n", holder.pid())).unwrap();
        let again = append_fresh(dir.path(), &handle)
            .expect_err("a pid-only lock naming a live process that started before it");
        assert_eq!(
            again,
            refusal(&handle.id, holder.pid(), name.as_deref(), &lock_name)
        );
    }
    // Once it is gone, the lock is taken.
    append_fresh(dir.path(), &handle).expect("the next writer takes the lock");
}

/// A Node script over the TypeScript store: `hold` creates a session in `root`, appends, prints `{"ready":…}` and
/// waits; `append <id>` opens the session, appends once and prints `{"ok":…}` or `{"error":"<message>"}`.
const TYPESCRIPT_WRITER: &str = r#"
const { SessionStore } = await import(process.env.HEDDLE_TS_STORE)
const [mode, root, id] = process.argv.slice(1)
const store = new SessionStore(root)
if (mode === 'hold') {
  const handle = store.create({ cwd: root })
  store.append(handle, { type: 'test/typescript-holder' })
  process.stdout.write(JSON.stringify({ ready: true, id: handle.id, pid: process.pid }) + '\n')
  setInterval(() => {}, 1000)
} else {
  try {
    const event = store.append(store.open(id), { type: 'test/typescript-writer' })
    process.stdout.write(JSON.stringify({ ok: true, seq: event.seq }) + '\n')
  } catch (error) {
    process.stdout.write(JSON.stringify({ error: error.message }) + '\n')
  }
  process.exit(0)
}
"#;

/// The TypeScript writer as a command, or `None` when Node is not installed.
fn typescript_writer(args: &[&str]) -> Option<Command> {
    Command::new("node").arg("--version").output().ok()?;
    let mut command = Command::new("node");
    command
        .args(["--input-type=module", "-e", TYPESCRIPT_WRITER])
        .args(args)
        .env("HEDDLE_TS_STORE", repository().join("src/session/store.ts"));
    Some(command)
}

#[test]
fn a_lock_the_typescript_store_holds_is_refused_here_and_a_lock_held_here_is_refused_there_in_the_same_words()
 {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_str().unwrap();
    let Some(mut hold) = typescript_writer(&["hold", root]) else {
        eprintln!("node is not installed; the shared lock files still pin the bytes");
        return;
    };
    let mut node = hold
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut line = String::new();
    std::io::BufRead::read_line(
        &mut std::io::BufReader::new(node.stdout.take().unwrap()),
        &mut line,
    )
    .unwrap();
    let ready: Value = serde_json::from_str(&line).expect("the TypeScript store created a session");
    let id = ready["id"].as_str().unwrap().to_string();
    let pid = ready["pid"].as_u64().unwrap() as u32;
    let lock_name = format!("{id}.lock");

    // The TypeScript store's lock, read here: the protocol's line, and refused, naming the Node process.
    let store = SessionStore::new(root, &Env::default());
    let handle = store
        .open(&id)
        .expect("the session the TypeScript store wrote");
    assert_eq!(
        std::fs::read_to_string(heddle_session::lock_path(&handle)).unwrap(),
        lock_of(pid),
        "the TypeScript store's lock is the line this build writes for that process"
    );
    let refused = store
        .append(
            &handle,
            NewEvent::new("test/rust-intruder"),
            AppendOptions::default(),
        )
        .expect_err("a lock the TypeScript store holds is held here");
    assert_eq!(
        refused.to_string(),
        refusal(&id, pid, command_name(pid).as_deref(), &lock_name)
    );

    // It dies without letting go: this store takes the lock, and the TypeScript store meets this one's.
    node.kill().unwrap();
    node.wait().unwrap();
    store
        .append(
            &handle,
            NewEvent::new("test/rust-successor"),
            AppendOptions::default(),
        )
        .expect("a lock whose holder is gone is taken");
    let own = std::process::id();
    let answer = typescript_writer(&["append", root, &id])
        .unwrap()
        .output()
        .unwrap();
    let answer: Value =
        serde_json::from_slice(&answer.stdout).expect("the TypeScript writer answered");
    assert_eq!(
        answer["error"].as_str(),
        Some(refusal(&id, own, command_name(own).as_deref(), &lock_name).as_str()),
        "the TypeScript store refuses a lock this build holds, in the same words"
    );
    store.release(&handle);
}
