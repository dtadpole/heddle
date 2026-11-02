//! The session writer lock's protocol: what `<id>.lock` says, and when the lock it is belongs to nobody (#202).
//!
//! Ported from `src/session/writer-lock.ts`; both builds speak it byte for byte, and
//! `test/session-lock.fixtures.json` holds lock files both test suites read. The file is one line:
//!
//! ```text
//! <pid> boot=<boot id> start=<start>\n
//! ```
//!
//! - `pid` is the holder's process id, in decimal. A file that is a pid and nothing else is the **pid-only** form
//!   every build before #202 wrote, and still the form written where the holder's start cannot be read.
//! - `boot` is the boot the lock was written in: `/proc/sys/kernel/random/boot_id` on Linux,
//!   `kern.bootsessionuuid` on macOS. Both are a random id the kernel draws once per boot, so a lock from an earlier
//!   boot never matches, and no clock correction moves them (`kern.boottime` does move when the clock is set).
//! - `start` is the holder's start as the kernel keeps it: on Linux field 22 of `/proc/<pid>/stat`, clock ticks
//!   after boot; on macOS the start second, UTC, as `ps -o lstart` prints it (`LC_ALL=C TZ=UTC0`), written as
//!   seconds since 1970. Either build reads the same source on the same system, so the two values compare exactly.
//!
//! A boot that cannot be read is left out (a start that cannot be read makes the line pid-only), and a reader
//! ignores a part it does not know.
//!
//! DSH takes a kernel `flock(2)` on `session.lock` instead (dsh-session-persistence-jsonl lib/index.js:692-716),
//! which the kernel drops when the holder dies. The TypeScript build cannot take one without a native addon, and a
//! flock taken here alone would not be seen by it, so both builds tell a lock that outlived its holder apart by hand,
//! with [`judge_lock`]. This crate forbids `unsafe`, so every fact is read from `/proc` or from `ps` and `sysctl`.

use std::path::Path;
use std::sync::OnceLock;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// What a lock file says: the holder's pid and, since #202, which process that pid named.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LockContent {
    pub pid: u32,
    /// The boot the lock was written in; `None` in a pid-only lock.
    pub boot: Option<String>,
    /// The holder's start, in this system's terms (see the module comment); `None` in a pid-only lock.
    pub start: Option<String>,
}

impl LockContent {
    /// Whether the lock carries any identity, rather than being the pid-only form.
    pub fn has_identity(&self) -> bool {
        self.boot.is_some() || self.start.is_some()
    }
}

/// A token `boot` or `start` may hold: printable ASCII with no `=`, so the line splits back the way it was written.
fn is_token(value: &str) -> bool {
    !value.is_empty()
        && value
            .bytes()
            .all(|byte| (0x21..=0x7e).contains(&byte) && byte != b'=')
}

/// Read a lock file's text; `None` when it names no process (empty, half-written, or not a lock).
pub fn parse_lock(text: &str) -> Option<LockContent> {
    let mut tokens = text.split_ascii_whitespace();
    let first = tokens.next()?;
    if !first.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let pid = first.parse::<u32>().ok().filter(|pid| *pid > 0)?;
    let (mut boot, mut start) = (None, None);
    for token in tokens {
        let Some((key, value)) = token.split_once('=') else {
            continue;
        };
        if key.is_empty() || !is_token(value) {
            continue;
        }
        match key {
            "boot" if boot.is_none() => boot = Some(value.to_string()),
            "start" if start.is_none() => start = Some(value.to_string()),
            _ => {}
        }
    }
    Some(LockContent { pid, boot, start })
}

/// The bytes of a lock file: `<pid>[ boot=<boot>][ start=<start>]\n`, the pid-only form when neither is known.
pub fn format_lock(content: &LockContent) -> String {
    let mut line = content.pid.to_string();
    if let Some(boot) = content.boot.as_deref().filter(|boot| is_token(boot)) {
        line.push_str(" boot=");
        line.push_str(boot);
    }
    if let Some(start) = content.start.as_deref().filter(|start| is_token(start)) {
        line.push_str(" start=");
        line.push_str(start);
    }
    line.push('\n');
    line
}

/// The modification time a lock with identity is given: 2037-12-31T00:00:00Z, in seconds since 1970.
///
/// A build from before #202 reads a pid out of a lock only when the file is digits and nothing else; any other lock
/// it takes for one still being written while it is younger than five seconds, and removes as debris after that. So
/// it would have removed a live holder's lock five seconds after it was written. A time in the future reads as young
/// to both builds (`Date.now() - mtimeMs < 5000`; here `elapsed()` fails, which was mapped to young on purpose), so
/// such a build refuses the session rather than taking it. A reader of this protocol never asks a lock with identity
/// for its age. The date is below 2038-01-19, the last second a 32-bit file time holds.
pub const IDENTIFIED_LOCK_MTIME_S: u64 = 2_145_830_400;

/// How long a lock file with no pid in it is taken to be one being written rather than debris: the holder creates
/// the file and writes it in the next call.
pub const UNWRITTEN_LOCK_GRACE_S: f64 = 5.0;

/// How much later than a pid-only lock's modification time its pid's process must have started for the lock to be
/// another process's: a few seconds, so a clock corrected by a second or two never makes a live holder look younger
/// than its own lock. A pid comes round again minutes after its holder died at the soonest.
pub const PID_ONLY_START_MARGIN_S: f64 = 5.0;

/// What the system says about a live process. A field this system cannot read is `None`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ProcessFacts {
    /// Its start in this system's terms: the value a lock records (see the module comment).
    pub start: Option<String>,
    /// When it started, in seconds since 1970, for the pid-only rule.
    pub started_at: Option<f64>,
    /// The user it runs as (effective uid).
    pub uid: Option<u32>,
    /// Its command name, for a person: `ucomm` on macOS, `/proc/<pid>/comm` on Linux.
    pub name: Option<String>,
}

/// How [`judge_lock`] asks the system; tests hand it a made-up one.
pub trait LockProbe {
    /// The facts of the process with this pid, or `None` when no process has it.
    fn facts(&self, pid: u32) -> Option<ProcessFacts>;
    /// This boot's id, when this system says one.
    fn boot(&self) -> Option<String>;
}

/// A lock file as a reader found it: its text, its modification time and the user who owns it.
#[derive(Debug, Clone, PartialEq)]
pub struct LockFile {
    pub text: String,
    /// Seconds since 1970; negative before it.
    pub modified_s: f64,
    pub uid: Option<u32>,
}

/// Whether the lock still belongs to a live process, which is then named; or it belongs to nobody, and why.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LockVerdict {
    Held {
        pid: Option<u32>,
        name: Option<String>,
    },
    Stale {
        reason: String,
    },
}

/// Judge a lock that names another process than the reader: is its holder alive, or is the lock stale?
///
/// A lock is **stale** when its pid names no process; when it was written in another boot; when its pid names a
/// process that started at another time than the lock records; or, for a pid-only lock, which records no start,
/// when its pid names a process that started after the lock was written. It is stale too when its pid's process
/// runs as another user than the one who owns the file: the file belongs to the user whose process created it. That
/// is the case of a pid that now names a process this user may not signal (`EPERM`, pid 1): such a process exists,
/// so it is judged by these rules rather than taken to be the holder for as long as it lives. A lock that names no
/// pid is being written while it is younger than [`UNWRITTEN_LOCK_GRACE_S`], and debris after that.
///
/// Anything else is **held**: a fact that cannot be read never makes a lock stale, so a live writer is never
/// expropriated on a guess, and there is no expiry. `judgeLock` in `src/session/writer-lock.ts`, rule for rule.
pub fn judge_lock(file: &LockFile, probe: &dyn LockProbe, now_s: f64) -> LockVerdict {
    let Some(content) = parse_lock(&file.text) else {
        // A modification time in the future reads as young, as `Date.now() - mtimeMs` does.
        return if now_s - file.modified_s < UNWRITTEN_LOCK_GRACE_S {
            LockVerdict::Held {
                pid: None,
                name: None,
            }
        } else {
            LockVerdict::Stale {
                reason: "it names no process".to_string(),
            }
        };
    };
    let pid = content.pid;
    if let Some(written) = &content.boot
        && let Some(boot) = probe.boot()
        && *written != boot
    {
        return LockVerdict::Stale {
            reason: format!("it was written in another boot ({written}, now {boot})"),
        };
    }
    let Some(facts) = probe.facts(pid) else {
        return LockVerdict::Stale {
            reason: format!("process {pid} is gone"),
        };
    };
    match (&content.start, &facts.start, facts.started_at) {
        (Some(recorded), Some(actual), _) if recorded != actual => {
            return LockVerdict::Stale {
                reason: format!(
                    "process {pid} started at {actual}, not at {recorded} as the lock records"
                ),
            };
        }
        (None, _, Some(started_at)) if started_at > file.modified_s + PID_ONLY_START_MARGIN_S => {
            return LockVerdict::Stale {
                reason: format!("process {pid} started after the lock was written"),
            };
        }
        _ => {}
    }
    if let (Some(runs_as), Some(owner)) = (facts.uid, file.uid)
        && runs_as != owner
    {
        return LockVerdict::Stale {
            reason: format!("process {pid} runs as user {runs_as}, and the lock is user {owner}'s"),
        };
    }
    LockVerdict::Held {
        pid: Some(pid),
        name: facts.name,
    }
}

/// The refusal of a write to a session another process holds, in the same words in both builds
/// (`ownedSentence` in `src/session/writer-lock.ts`).
///
/// It opens with DSH's `SessionAlreadyOwnedError` sentence, then names the process (its pid, and its command name
/// when the system says it) and the lock file, and says how to clear the lock when that process is not heddle. The
/// lock is named by its file name and where it is, never by its absolute path: the sentence reaches HTTP answers,
/// and an absolute path would put the store root, home directory included, into them (#130).
pub fn owned_sentence(
    id: &str,
    pid: Option<u32>,
    name: Option<&str>,
    lock: Option<&str>,
) -> String {
    let process = match (pid, name) {
        (Some(pid), Some(name)) => format!(" (process {pid}, {name})"),
        (Some(pid), None) => format!(" (process {pid})"),
        (None, _) => String::new(),
    };
    let owned = format!("session \"{id}\" is already owned by an active write handle{process}");
    let Some(lock) = lock else {
        return owned;
    };
    let who = match pid {
        Some(pid) => format!("if process {pid} is not heddle"),
        None => "if no heddle is writing this session".to_string(),
    };
    format!(
        "{owned}. Its lock file is {lock}, beside the session's log; {who}, delete that file and try again."
    )
}

// -----------------------------------------------------------------------------------------------------------------
// The system's answers

const MONTHS: [&str; 12] = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/// Whether every byte is an ASCII digit and there are between `min` and `max` of them.
fn digits(text: &str, min: usize, max: usize) -> bool {
    (min..=max).contains(&text.len()) && text.bytes().all(|byte| byte.is_ascii_digit())
}

/// One line of `ps -o uid=,lstart=,ucomm=` under `LC_ALL=C TZ=UTC0`: `  501 Sun Nov  1 19:53:07 2026  sleep`.
/// `None` fields are the ones the line did not hold. `parsePsLine` in the TypeScript build.
pub fn parse_ps_line(line: &str) -> ProcessFacts {
    let tokens: Vec<&str> = line.split_whitespace().collect();
    let token = |index: usize| tokens.get(index).copied().unwrap_or("");
    let uid = digits(token(0), 1, 10)
        .then(|| token(0).parse::<u32>().ok())
        .flatten();
    let month = MONTHS.iter().position(|month| *month == token(2));
    let clock: Vec<&str> = token(4).split(':').collect();
    let clock_ok = clock.len() == 3
        && digits(clock[0], 1, 2)
        && digits(clock[1], 2, 2)
        && digits(clock[2], 2, 2);
    let started_at = match month {
        Some(month) if clock_ok && digits(token(3), 1, 2) && digits(token(5), 4, 4) => {
            let number = |text: &str| text.parse::<u32>().unwrap_or(0);
            chrono::NaiveDate::from_ymd_opt(
                token(5).parse::<i32>().unwrap_or(0),
                month as u32 + 1,
                number(token(3)),
            )
            .and_then(|date| date.and_hms_opt(number(clock[0]), number(clock[1]), number(clock[2])))
            .map(|moment| moment.and_utc().timestamp())
        }
        _ => None,
    };
    let name = tokens
        .get(6..)
        .map(|rest| rest.join(" "))
        .unwrap_or_default();
    ProcessFacts {
        start: started_at.map(|seconds| seconds.to_string()),
        started_at: started_at.map(|seconds| seconds as f64),
        uid,
        name: (!name.is_empty()).then_some(name),
    }
}

/// One `/proc/<pid>/stat` line's start (field 22) and command name; `parseProcStat` in the TypeScript build. The
/// name is in brackets and may hold spaces and brackets itself, so the fields are counted from the last `)`.
pub fn parse_proc_stat(text: &str) -> (Option<String>, Option<String>) {
    let (Some(open), Some(close)) = (text.find('('), text.rfind(')')) else {
        return (None, None);
    };
    if close < open {
        return (None, None);
    }
    let name = &text[open + 1..close];
    let start = text[close + 1..]
        .split_whitespace()
        .nth(19)
        .filter(|start| !start.is_empty() && start.bytes().all(|byte| byte.is_ascii_digit()))
        .map(str::to_string);
    (start, (!name.is_empty()).then(|| name.to_string()))
}

/// Clock ticks per second in `/proc/<pid>/stat`: `USER_HZ`, 100 on every architecture Linux runs on today. Neither
/// build can ask `sysconf(_SC_CLK_TCK)`; the value only dates a pid-only lock's process, never compares two starts.
#[cfg(target_os = "linux")]
const LINUX_TICKS_PER_SECOND: f64 = 100.0;

/// A process's facts on Linux, from `/proc`; `None` when there is no `/proc/<pid>`.
#[cfg(target_os = "linux")]
fn system_facts(pid: u32) -> Option<ProcessFacts> {
    let stat = match std::fs::read_to_string(format!("/proc/{pid}/stat")) {
        Ok(stat) => stat,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return None,
        Err(_) => return Some(ProcessFacts::default()),
    };
    let (start, name) = parse_proc_stat(&stat);
    let uid = std::fs::read_to_string(format!("/proc/{pid}/status"))
        .ok()
        .and_then(|status| {
            status
                .lines()
                .find(|line| line.starts_with("Uid:"))
                .and_then(|line| line.split_whitespace().nth(2))
                .and_then(|uid| uid.parse::<u32>().ok())
        });
    let btime = std::fs::read_to_string("/proc/stat").ok().and_then(|stat| {
        stat.lines()
            .find_map(|line| line.strip_prefix("btime "))
            .and_then(|seconds| seconds.trim().parse::<u64>().ok())
    });
    let started_at = match (&start, btime) {
        (Some(ticks), Some(btime)) => ticks
            .parse::<u64>()
            .ok()
            .map(|ticks| btime as f64 + ticks as f64 / LINUX_TICKS_PER_SECOND),
        _ => None,
    };
    Some(ProcessFacts {
        start,
        started_at,
        uid,
        name,
    })
}

/// A process's facts on macOS, from `ps`; `None` when `ps` finds no such process. When `ps` cannot be run, `kill
/// -0` still says whether the pid is alive (a process this user may not signal is), with no facts beside.
#[cfg(target_os = "macos")]
fn system_facts(pid: u32) -> Option<ProcessFacts> {
    let output = std::process::Command::new("/bin/ps")
        .args(["-o", "uid=,lstart=,ucomm=", "-p", &pid.to_string()])
        .env_clear()
        .env("LC_ALL", "C")
        .env("TZ", "UTC0")
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output();
    let Ok(output) = output else {
        return signal_alive(pid).then(ProcessFacts::default);
    };
    let out = String::from_utf8_lossy(&output.stdout);
    if !output.status.success() {
        // `ps` exits 1 with nothing printed when no process has the pid; any other failure says nothing.
        let none = output.status.code() == Some(1) && out.trim().is_empty();
        return (!none).then(ProcessFacts::default);
    }
    (!out.trim().is_empty()).then(|| parse_ps_line(&out))
}

/// A process's facts elsewhere: only whether it is alive.
#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn system_facts(pid: u32) -> Option<ProcessFacts> {
    signal_alive(pid).then(ProcessFacts::default)
}

/// Whether a process with this pid exists, by `kill -0`: one this user may not signal exists, and when the answer
/// cannot be had the holder is taken to be alive.
#[cfg(all(unix, not(target_os = "linux")))]
fn signal_alive(pid: u32) -> bool {
    // `kill -0` is what Node's `process.kill(pid, 0)` asks; the crate forbids the unsafe a direct call needs.
    match std::process::Command::new("kill")
        .arg("-0")
        .arg(pid.to_string())
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .output()
    {
        Ok(output) => {
            output.status.success()
                || String::from_utf8_lossy(&output.stderr).contains("not permitted")
        }
        Err(_) => true,
    }
}

/// Whether a process with this pid exists, asked of `tasklist`; alive when the answer cannot be had.
#[cfg(not(unix))]
fn signal_alive(pid: u32) -> bool {
    match std::process::Command::new("tasklist")
        .args(["/FI", &format!("PID eq {pid}"), "/NH"])
        .output()
    {
        Ok(output) => String::from_utf8_lossy(&output.stdout).contains(&format!(" {pid} ")),
        Err(_) => true,
    }
}

/// The facts of a live process on this system; `None` when no process has the pid.
pub fn process_facts(pid: u32) -> Option<ProcessFacts> {
    system_facts(pid)
}

/// This boot's id: Linux's `boot_id`, macOS's `kern.bootsessionuuid`; `None` where the system has neither.
fn read_boot() -> Option<String> {
    let text = if cfg!(target_os = "linux") {
        std::fs::read_to_string("/proc/sys/kernel/random/boot_id").ok()?
    } else if cfg!(target_os = "macos") {
        let output = std::process::Command::new("/usr/sbin/sysctl")
            .args(["-n", "kern.bootsessionuuid"])
            .env_clear()
            .env("LC_ALL", "C")
            .stdin(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .output()
            .ok()?;
        String::from_utf8_lossy(&output.stdout).into_owned()
    } else {
        return None;
    };
    let boot = text.trim();
    (!boot.is_empty()
        && boot
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-'))
    .then(|| boot.to_string())
}

/// This boot's id, read once per process: it cannot change while the process runs.
pub fn current_boot() -> Option<String> {
    static BOOT: OnceLock<Option<String>> = OnceLock::new();
    BOOT.get_or_init(read_boot).clone()
}

/// The system as [`judge_lock`] asks it by default.
pub struct SystemProbe;

impl LockProbe for SystemProbe {
    fn facts(&self, pid: u32) -> Option<ProcessFacts> {
        process_facts(pid)
    }

    fn boot(&self) -> Option<String> {
        current_boot()
    }
}

/// The lock this process writes: its pid, this boot, and its own start, read once per process (`ownLock` in the
/// TypeScript build).
///
/// Without its start (the system would not say it) the lock is the pid-only form: a build from before #202 reads
/// that one, and it keeps the time it was written, which is what the pid-only rule dates a reused pid by. The start
/// is asked again at the next lock rather than given up on.
pub fn own_lock() -> LockContent {
    static OWN: OnceLock<LockContent> = OnceLock::new();
    if let Some(own) = OWN.get() {
        return own.clone();
    }
    let pid = std::process::id();
    let Some(start) = process_facts(pid).and_then(|facts| facts.start) else {
        return LockContent {
            pid,
            boot: None,
            start: None,
        };
    };
    OWN.get_or_init(|| LockContent {
        pid,
        boot: current_boot(),
        start: Some(start),
    })
    .clone()
}

/// Whether a lock file's text names this process: its pid, and, where both the line and this process say them, its
/// start and its boot (`namesThisProcess` in the TypeScript build). Letting go removes a lock only then, so a lock
/// another process wrote is never removed, whatever happened to this one's (#248).
pub fn names_this_process(text: &str) -> bool {
    let Some(lock) = parse_lock(text) else {
        return false;
    };
    let own = own_lock();
    let agrees = |written: &Option<String>, mine: &Option<String>| match (written, mine) {
        (Some(written), Some(mine)) => written == mine,
        _ => true,
    };
    lock.pid == own.pid && agrees(&lock.start, &own.start) && agrees(&lock.boot, &own.boot)
}

/// Give a lock just written with identity its modification time, [`IDENTIFIED_LOCK_MTIME_S`]; a pid-only lock keeps
/// the time it was written, which is what the pid-only rule reads. A file system that refuses the time still holds
/// the lock; only a build from before #202 reads it differently.
pub fn stamp_lock(file: &std::fs::File, content: &LockContent) {
    if content.has_identity() {
        let _ = file.set_modified(UNIX_EPOCH + Duration::from_secs(IDENTIFIED_LOCK_MTIME_S));
    }
}

/// Seconds since 1970 of a moment, negative before it.
pub fn epoch_seconds(moment: SystemTime) -> f64 {
    match moment.duration_since(UNIX_EPOCH) {
        Ok(after) => after.as_secs_f64(),
        Err(before) => -before.duration().as_secs_f64(),
    }
}

/// A lock file as it is now, for [`judge_lock`]; `Ok(None)` when there is none.
pub fn read_lock_file(path: &Path) -> std::io::Result<Option<LockFile>> {
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    let meta = match std::fs::metadata(path) {
        Ok(meta) => meta,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    #[cfg(unix)]
    let uid = Some(std::os::unix::fs::MetadataExt::uid(&meta));
    #[cfg(not(unix))]
    let uid = None;
    Ok(Some(LockFile {
        text,
        modified_s: meta.modified().map(epoch_seconds).unwrap_or(0.0),
        uid,
    }))
}

#[cfg(test)]
mod tests {
    //! The rules over a made-up system, the twin of `test/session-lock-protocol.test.ts`. The shared lock files and
    //! the real processes are `tests/writer_lock.rs`'s.

    use std::collections::HashMap;

    use super::*;

    struct Fake {
        boot: Option<String>,
        processes: HashMap<u32, ProcessFacts>,
    }

    impl LockProbe for Fake {
        fn facts(&self, pid: u32) -> Option<ProcessFacts> {
            self.processes.get(&pid).cloned()
        }
        fn boot(&self) -> Option<String> {
            self.boot.clone()
        }
    }

    const NOW: f64 = 1_793_563_380.0;
    const BOOT: &str = "A16D6C9D-EDEC-4146-9050-6215AF208215";
    const ME: u32 = 501;

    fn system(boot: Option<&str>, processes: &[(u32, ProcessFacts)]) -> Fake {
        Fake {
            boot: boot.map(str::to_string),
            processes: processes.iter().cloned().collect(),
        }
    }

    fn started(start: f64, uid: u32, name: Option<&str>) -> ProcessFacts {
        ProcessFacts {
            start: Some(format!("{start}")),
            started_at: Some(start),
            uid: Some(uid),
            name: name.map(str::to_string),
        }
    }

    fn file(text: &str, modified_s: f64, uid: Option<u32>) -> LockFile {
        LockFile {
            text: text.to_string(),
            modified_s,
            uid,
        }
    }

    fn stale(verdict: LockVerdict) -> bool {
        matches!(verdict, LockVerdict::Stale { .. })
    }

    #[test]
    fn a_lock_is_stale_when_its_pid_is_gone_its_boot_is_another_or_its_pid_names_another_start() {
        let fake = system(
            Some(BOOT),
            &[(700, started(1_793_560_000.0, ME, Some("heddle")))],
        );
        let at = |text: &str| file(text, NOW - 60.0, Some(ME));
        assert_eq!(
            judge_lock(
                &at(&format!("700 boot={BOOT} start=1793560000\n")),
                &fake,
                NOW
            ),
            LockVerdict::Held {
                pid: Some(700),
                name: Some("heddle".to_string())
            }
        );
        assert!(
            stale(judge_lock(
                &at(&format!("701 boot={BOOT} start=1793560000\n")),
                &fake,
                NOW
            )),
            "its pid is gone"
        );
        assert!(
            stale(judge_lock(&at("700 boot=B start=1793560000\n"), &fake, NOW)),
            "another boot"
        );
        assert!(
            stale(judge_lock(
                &at(&format!("700 boot={BOOT} start=1793559999\n")),
                &fake,
                NOW
            )),
            "another start"
        );
        assert!(
            !stale(judge_lock(&at(&format!("700 boot={BOOT}\n")), &fake, NOW)),
            "a lock with no start and a mtime after its process started belongs to it"
        );
        let no_boot = system(
            None,
            &[(
                700,
                ProcessFacts {
                    start: Some("1793560000".to_string()),
                    uid: Some(ME),
                    ..Default::default()
                },
            )],
        );
        assert!(
            !stale(judge_lock(
                &at("700 boot=B start=1793560000\n"),
                &no_boot,
                NOW
            )),
            "a boot the system cannot say decides nothing"
        );
    }

    #[test]
    fn a_pid_only_lock_is_stale_when_its_pid_names_a_process_that_started_after_the_lock_was_written()
     {
        let written = NOW - 3600.0;
        let lock = file("700\n", written, Some(ME));
        let at = |start: f64| system(Some(BOOT), &[(700, started(start, ME, None))]);
        assert!(
            stale(judge_lock(&lock, &at(written + 600.0), NOW)),
            "started ten minutes after the lock"
        );
        assert!(
            !stale(judge_lock(&lock, &at(written - 600.0), NOW)),
            "started before the lock: its holder"
        );
        assert!(
            !stale(judge_lock(&lock, &at(written + 4.0), NOW)),
            "within the margin a corrected clock may need"
        );
        let unknown = system(
            Some(BOOT),
            &[(
                700,
                ProcessFacts {
                    uid: Some(ME),
                    ..Default::default()
                },
            )],
        );
        assert!(
            !stale(judge_lock(&lock, &unknown, NOW)),
            "a start the system cannot say decides nothing"
        );
    }

    #[test]
    fn a_lock_whose_pid_names_a_process_of_another_user_is_stale() {
        let fake = system(
            Some(BOOT),
            &[(1, started(1_791_095_069.0, 0, Some("launchd")))],
        );
        assert!(
            stale(judge_lock(&file("1\n", NOW, Some(ME)), &fake, NOW)),
            "pid 1, root's, in this user's lock"
        );
        assert!(
            !stale(judge_lock(&file("1\n", NOW, Some(0)), &fake, NOW)),
            "root's lock naming root's process"
        );
        assert!(
            !stale(judge_lock(&file("1\n", NOW, None), &fake, NOW)),
            "an owner the system cannot say decides nothing"
        );
    }

    #[test]
    fn a_lock_that_names_no_process_is_being_written_for_five_seconds_and_a_future_time_is_young() {
        let fake = system(Some(BOOT), &[]);
        let unwritten = LockVerdict::Held {
            pid: None,
            name: None,
        };
        assert_eq!(
            judge_lock(&file("", NOW - 1.0, None), &fake, NOW),
            unwritten
        );
        assert!(stale(judge_lock(&file("", NOW - 6.0, None), &fake, NOW)));
        assert_eq!(
            judge_lock(&file("x", IDENTIFIED_LOCK_MTIME_S as f64, None), &fake, NOW),
            unwritten
        );
    }

    #[test]
    fn the_refusal_names_the_process_and_the_lock_file_in_the_typescript_builds_words() {
        assert_eq!(
            owned_sentence(
                "session-a",
                Some(46183),
                Some("sleep"),
                Some("session-a.lock")
            ),
            "session \"session-a\" is already owned by an active write handle (process 46183, sleep). Its lock file \
             is session-a.lock, beside the session's log; if process 46183 is not heddle, delete that file and try \
             again."
        );
        assert_eq!(
            owned_sentence("session-a", Some(46183), None, Some("session-a.lock")),
            "session \"session-a\" is already owned by an active write handle (process 46183). Its lock file is \
             session-a.lock, beside the session's log; if process 46183 is not heddle, delete that file and try \
             again."
        );
        assert_eq!(
            owned_sentence("session-a", None, None, Some("session.lock")),
            "session \"session-a\" is already owned by an active write handle. Its lock file is session.lock, \
             beside the session's log; if no heddle is writing this session, delete that file and try again."
        );
        assert_eq!(
            owned_sentence("session-a", None, None, None),
            "session \"session-a\" is already owned by an active write handle"
        );
    }

    /// `test/session-lock.fixtures.json`, the lock files `test/session-lock-protocol.test.ts` reads too.
    fn fixtures() -> serde_json::Value {
        let mut root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        root.pop(); // crates
        root.pop(); // rust
        root.pop(); // the repository root
        let text = std::fs::read_to_string(root.join("test/session-lock.fixtures.json"))
            .expect("the lock files both suites read");
        serde_json::from_str(&text).unwrap()
    }

    #[test]
    fn every_shared_lock_file_reads_as_the_typescript_build_reads_it_and_a_written_one_is_the_same_bytes()
     {
        let all = fixtures();
        let text = |value: &serde_json::Value| value.as_str().map(str::to_string);
        for lock in all["locks"].as_array().unwrap() {
            let name = lock["name"].as_str().unwrap();
            let bytes = lock["bytes"].as_str().unwrap();
            let parsed = parse_lock(bytes);
            let Some(pid) = lock["pid"].as_u64() else {
                assert_eq!(parsed, None, "{name}: names no process");
                continue;
            };
            let expected = LockContent {
                pid: pid as u32,
                boot: text(&lock["boot"]),
                start: text(&lock["start"]),
            };
            assert_eq!(parsed.as_ref(), Some(&expected), "{name}");
            if lock["written"].as_bool() == Some(true) {
                assert_eq!(
                    format_lock(&expected),
                    bytes,
                    "{name}: written byte for byte"
                );
            }
        }
        for line in all["ps"].as_array().unwrap() {
            let facts = parse_ps_line(line["line"].as_str().unwrap());
            let start = line["start"].as_str().unwrap();
            assert_eq!(facts.start.as_deref(), Some(start), "{}", line["name"]);
            assert_eq!(
                facts.started_at,
                start.parse::<f64>().ok(),
                "{}",
                line["name"]
            );
            assert_eq!(
                facts.uid,
                line["uid"].as_u64().map(|uid| uid as u32),
                "{}",
                line["name"]
            );
            assert_eq!(
                facts.name.as_deref(),
                line["command"].as_str(),
                "{}",
                line["name"]
            );
        }
        for line in all["procStat"].as_array().unwrap() {
            let (start, name) = parse_proc_stat(line["line"].as_str().unwrap());
            assert_eq!(start.as_deref(), line["start"].as_str(), "{}", line["name"]);
            assert_eq!(
                name.as_deref(),
                line["command"].as_str(),
                "{}",
                line["name"]
            );
        }
    }

    #[test]
    fn this_process_writes_its_pid_its_boot_and_its_start() {
        let own = own_lock();
        assert_eq!(own.pid, std::process::id());
        if cfg!(any(target_os = "linux", target_os = "macos")) {
            assert!(own.boot.is_some(), "this boot's id is read");
            assert!(own.start.is_some(), "this process's start is read");
            assert_eq!(
                process_facts(own.pid).and_then(|facts| facts.start),
                own.start,
                "and it is the start a reader reads"
            );
        }
        assert_eq!(parse_lock(&format_lock(&own)), Some(own));
    }

    #[test]
    fn a_lock_names_this_process_only_with_its_pid_and_its_identity() {
        let own = own_lock();
        assert!(
            names_this_process(&format_lock(&own)),
            "the lock this process writes"
        );
        assert!(
            names_this_process(&format!("{}\n", own.pid)),
            "a pid-only lock naming this pid: no other live process can hold it"
        );
        assert!(
            !names_this_process(&format!("{}\n", own.pid + 1)),
            "another pid"
        );
        assert!(!names_this_process(""), "no pid");
        if own.start.is_some() {
            let earlier = LockContent {
                start: Some("1".to_string()),
                ..own.clone()
            };
            assert!(
                !names_this_process(&format_lock(&earlier)),
                "this pid with another start: an earlier process's lock"
            );
        }
        if own.boot.is_some() {
            let other_boot = LockContent {
                boot: Some("other".to_string()),
                ..own.clone()
            };
            assert!(
                !names_this_process(&format_lock(&other_boot)),
                "this pid in another boot"
            );
        }
    }
}
