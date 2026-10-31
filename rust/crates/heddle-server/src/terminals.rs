//! Interactive shell terminals for the page's right sidebar (live-testing issue #85, slice 1: the server half).
//!
//! The port of `src/server/terminals.ts`. DSH's `dsh-api-terminal-controller` opens the execution environment's
//! shell in a session's folder. A browser reload reconnects to it and gets the screen back, and closing it ends
//! the process. Terminal output never reaches the agent's transcript. The routes in [`crate::server`] expose it
//! as REST plus one event stream per terminal.
//!
//! The stated differences from DSH are the TypeScript module's:
//! - **Confined like bash.** The shell runs under the session's sandbox mode (developer-ten's condition). DSH
//!   runs user terminals with the user's own permissions.
//! - **PTY through `script(1)`**: no native PTY and no `unsafe`. BSD takes `script -q /dev/null <cmd>`,
//!   util-linux takes `script -qfec <cmd> /dev/null`. Resize is `stty -f` (BSD) or `stty -F` (Linux) on the
//!   shell's own tty. Tokio hands the child a real pipe, which BSD `script` accepts for stdin, so this build
//!   needs no `cat` in front of it.
//! - **Replay is the raw output tail** (`replay_bytes`, DSH's 2 MiB), not a screen redrawn by a headless xterm.
//! - **Reclaimed when unattended**: no stream attached and no input or output for `unattended_ms` (two hours).
//! - **One default shell**: `$SHELL` when it is an absolute, executable path, else `/bin/sh`.

use std::collections::{HashMap, VecDeque};
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, Weak};
use std::time::{Duration, Instant};

use serde::Serialize;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::process::{ChildStdin, Command};
use tokio::sync::{OnceCell, mpsc, watch};

/// DSH's defaults where it has one (`maxTerminals`, `maxCols`, `maxRows`, `maxBufferedBytes`, `maxInputBytes`,
/// `disposeGraceMs`, `unattendedTimeoutMs`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalLimits {
    pub max_terminals: usize,
    pub max_cols: u32,
    pub max_rows: u32,
    pub replay_bytes: usize,
    pub max_input_bytes: usize,
    pub dispose_grace_ms: u64,
    pub unattended_ms: u64,
}

pub const TERMINAL_LIMITS: TerminalLimits = TerminalLimits {
    max_terminals: 8,
    max_cols: 500,
    max_rows: 200,
    replay_bytes: 2 * 1024 * 1024,
    max_input_bytes: 65_536,
    dispose_grace_ms: 1_000,
    unattended_ms: 2 * 60 * 60 * 1_000,
};

impl TerminalLimits {
    /// Whether a size is one a PTY may take here: whole numbers from 1 to the caps.
    pub fn fits(&self, cols: f64, rows: f64) -> bool {
        let whole =
            |value: f64, max: u32| value.fract() == 0.0 && value >= 1.0 && value <= f64::from(max);
        whole(cols, self.max_cols) && whole(rows, self.max_rows)
    }
}

/// What a listing shows for one terminal. Its screen is not included; a stream carries that.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalInfo {
    pub id: String,
    pub session: String,
    pub shell: String,
    pub cwd: String,
    pub mode: String,
    pub cols: u32,
    pub rows: u32,
    pub created: String,
    pub exited: bool,
    pub exit_code: Option<i32>,
}

/// What a stream receives after its snapshot. `seq` is the count of output bytes so far, so it only grows.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum TerminalEvent {
    Output { seq: u64, data: String },
    Exit { code: Option<i32> },
}

/// The opening frame of a stream: the retained output tail, and whether older output was dropped.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSnapshot {
    pub seq: u64,
    pub data: String,
    pub truncated: bool,
    pub exited: bool,
    pub exit_code: Option<i32>,
}

/// Why a terminal was not created.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CreateRefusal {
    /// The session already holds `max_terminals` (exited ones count, as in DSH).
    Limit,
    /// The session's mode cannot be confined on this host; the sandbox's own sentence.
    Sandbox(String),
    /// The PTY could not be started.
    Spawn(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InputResult {
    Ok,
    Missing,
    Exited,
    TooLarge,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResizeResult {
    Ok,
    Missing,
    Exited,
    OutOfRange,
    Unavailable,
}

/// What one new terminal needs.
pub struct TerminalSpawn {
    pub session: String,
    pub cwd: PathBuf,
    pub mode: String,
    pub cols: u32,
    pub rows: u32,
    /// The shell to start; the default shell when `None`.
    pub shell: Option<String>,
}

/// The shell a new terminal runs: `$SHELL` when it names an executable by absolute path, else `/bin/sh`.
pub fn default_shell(shell: Option<&str>) -> String {
    if let Some(shell) = shell
        && Path::new(shell).is_absolute()
        && is_executable(Path::new(shell))
    {
        return shell.to_owned();
    }
    "/bin/sh".to_owned()
}

#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path)
        .map(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn is_executable(path: &Path) -> bool {
    path.is_file()
}

/// The shell's own argv before confinement: set the PTY size, then become the interactive shell.
pub fn shell_argv(shell: &str, cols: u32, rows: u32) -> Vec<OsString> {
    [
        "/bin/sh",
        "-c",
        "stty cols \"$1\" rows \"$2\" 2>/dev/null; SHELL=$3; export SHELL; exec \"$3\" -i",
        "heddle-terminal-shell",
        &cols.to_string(),
        &rows.to_string(),
        shell,
    ]
    .into_iter()
    .map(OsString::from)
    .collect()
}

fn sh_quote(word: &OsString) -> String {
    format!("'{}'", word.to_string_lossy().replace('\'', "'\\''"))
}

/// The PTY argv around the confined shell: BSD `script -q /dev/null <cmd>`, util-linux `script -qfec <cmd> /dev/null`.
pub fn pty_argv(bsd: bool, confined: &[OsString]) -> Vec<OsString> {
    if bsd {
        let mut argv: Vec<OsString> = ["/usr/bin/script", "-q", "/dev/null"]
            .into_iter()
            .map(OsString::from)
            .collect();
        argv.extend(confined.iter().cloned());
        argv
    } else {
        let command = confined.iter().map(sh_quote).collect::<Vec<_>>().join(" ");
        vec![
            OsString::from("script"),
            OsString::from("-qfec"),
            OsString::from(command),
            OsString::from("/dev/null"),
        ]
    }
}

#[derive(Debug, Clone)]
struct ProcessRow {
    pid: u32,
    ppid: u32,
    tty: String,
}

impl ProcessRow {
    fn has_tty(&self) -> bool {
        !self.tty.is_empty() && !self.tty.starts_with('?') && self.tty != "-"
    }
}

async fn process_table() -> Vec<ProcessRow> {
    let output = Command::new("ps")
        .args(["-A", "-o", "pid=,ppid=,tty="])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .await;
    let Ok(output) = output else {
        return Vec::new();
    };
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            let pid = fields.next()?.parse().ok()?;
            let ppid = fields.next()?.parse().ok()?;
            let tty = fields.next().unwrap_or("").to_owned();
            Some(ProcessRow { pid, ppid, tty })
        })
        .collect()
}

/// Every live descendant of `root` in `table`, nearest first.
fn descendants_in(root: u32, table: &[ProcessRow]) -> Vec<ProcessRow> {
    let mut found: Vec<ProcessRow> = Vec::new();
    let mut frontier = vec![root];
    while !frontier.is_empty() {
        let mut next = Vec::new();
        for row in table {
            if frontier.contains(&row.ppid)
                && row.pid != root
                && !found.iter().any(|seen| seen.pid == row.pid)
            {
                found.push(row.clone());
                next.push(row.pid);
            }
        }
        frontier = next;
    }
    found
}

async fn descendants(root: u32) -> Vec<ProcessRow> {
    descendants_in(root, &process_table().await)
}

#[cfg(unix)]
mod signals {
    use rustix::process::{Pid, Signal, kill_process, kill_process_group, test_kill_process};

    fn pid(raw: u32) -> Option<Pid> {
        i32::try_from(raw)
            .ok()
            .filter(|raw| *raw > 1)
            .and_then(Pid::from_raw)
    }

    pub fn hangup_and_terminate(raw: u32) {
        if let Some(pid) = pid(raw) {
            let _ = kill_process(pid, Signal::HUP);
            let _ = kill_process(pid, Signal::TERM);
        }
    }

    pub fn kill(raw: u32) {
        if let Some(pid) = pid(raw) {
            let _ = kill_process(pid, Signal::KILL);
        }
    }

    pub fn group(raw: u32, terminate: bool) {
        if let Some(pid) = pid(raw) {
            let _ = kill_process_group(
                pid,
                if terminate {
                    Signal::TERM
                } else {
                    Signal::KILL
                },
            );
        }
    }

    pub fn alive(raw: u32) -> bool {
        pid(raw).is_some_and(|pid| test_kill_process(pid).is_ok())
    }
}

#[cfg(not(unix))]
mod signals {
    pub fn hangup_and_terminate(_raw: u32) {}
    pub fn kill(_raw: u32) {}
    pub fn group(_raw: u32, _terminate: bool) {}
    pub fn alive(_raw: u32) -> bool {
        false
    }
}

/// UTF-8 decoding across chunks: a character split between two reads is kept whole.
#[derive(Default)]
struct Utf8Stream {
    pending: Vec<u8>,
}

impl Utf8Stream {
    fn write(&mut self, chunk: &[u8]) -> String {
        self.pending.extend_from_slice(chunk);
        let mut text = String::new();
        loop {
            match std::str::from_utf8(&self.pending) {
                Ok(valid) => {
                    text.push_str(valid);
                    self.pending.clear();
                    return text;
                }
                Err(error) => {
                    let valid = error.valid_up_to();
                    text.push_str(&String::from_utf8_lossy(&self.pending[..valid]));
                    match error.error_len() {
                        // An incomplete character at the end waits for the next chunk.
                        None => {
                            self.pending.drain(..valid);
                            return text;
                        }
                        Some(bad) => {
                            text.push('\u{fffd}');
                            self.pending.drain(..valid + bad);
                        }
                    }
                }
            }
        }
    }

    fn end(&mut self) -> String {
        let rest = String::from_utf8_lossy(&self.pending).into_owned();
        self.pending.clear();
        rest
    }
}

struct State {
    cols: u32,
    rows: u32,
    exited: bool,
    exit_code: Option<i32>,
    chunks: VecDeque<String>,
    held: usize,
    seq: u64,
    truncated: bool,
    last_activity: Instant,
    tty: Option<String>,
    listeners: HashMap<u64, mpsc::UnboundedSender<TerminalEvent>>,
    stderr_line: String,
}

/// One shell in one PTY, owned by one session.
struct Terminal {
    id: String,
    session: String,
    shell: String,
    cwd: String,
    mode: String,
    created: String,
    pid: Option<u32>,
    bsd: bool,
    limits: TerminalLimits,
    state: Mutex<State>,
    stdin: tokio::sync::Mutex<Option<ChildStdin>>,
    done: watch::Receiver<bool>,
    closing: OnceCell<()>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

impl Terminal {
    fn info(&self) -> TerminalInfo {
        let state = lock(&self.state);
        TerminalInfo {
            id: self.id.clone(),
            session: self.session.clone(),
            shell: self.shell.clone(),
            cwd: self.cwd.clone(),
            mode: self.mode.clone(),
            cols: state.cols,
            rows: state.rows,
            created: self.created.clone(),
            exited: state.exited,
            exit_code: state.exit_code,
        }
    }

    fn push(&self, text: &str) {
        if text.is_empty() {
            return;
        }
        let mut state = lock(&self.state);
        state.seq += text.len() as u64;
        state.last_activity = Instant::now();
        state.chunks.push_back(text.to_owned());
        state.held += text.len();
        while state.held > self.limits.replay_bytes && state.chunks.len() > 1 {
            let dropped = state.chunks.pop_front().map_or(0, |chunk| chunk.len());
            state.held -= dropped;
            state.truncated = true;
        }
        if state.held > self.limits.replay_bytes
            && let Some(only) = state.chunks.front()
        {
            let mut start = only.len() - self.limits.replay_bytes;
            // Never start inside a character.
            while !only.is_char_boundary(start) {
                start += 1;
            }
            let kept = only[start..].to_owned();
            state.held = kept.len();
            state.chunks = VecDeque::from([kept]);
            state.truncated = true;
        }
        let event = TerminalEvent::Output {
            seq: state.seq,
            data: text.to_owned(),
        };
        state
            .listeners
            .retain(|_, listener| listener.send(event.clone()).is_ok());
    }

    /// A stderr line from `script` itself (its own failure, say) joins the output, as the TypeScript build does.
    fn stderr(&self, text: &str) {
        let lines = {
            let mut state = lock(&self.state);
            state.stderr_line.push_str(text);
            let mut lines = Vec::new();
            while let Some(newline) = state.stderr_line.find('\n') {
                let line: String = state.stderr_line.drain(..=newline).collect();
                lines.push(format!("{}\r\n", line.trim_end_matches('\n')));
            }
            lines
        };
        for line in lines {
            self.push(&line);
        }
    }

    fn finish(&self, code: Option<i32>) {
        let rest = std::mem::take(&mut lock(&self.state).stderr_line);
        self.push(&rest);
        let mut state = lock(&self.state);
        if state.exited {
            return;
        }
        state.exited = true;
        state.exit_code = code;
        state.last_activity = Instant::now();
        let event = TerminalEvent::Exit { code };
        state
            .listeners
            .retain(|_, listener| listener.send(event.clone()).is_ok());
    }

    async fn input(&self, data: &str) -> InputResult {
        if data.len() > self.limits.max_input_bytes {
            return InputResult::TooLarge;
        }
        if lock(&self.state).exited {
            return InputResult::Exited;
        }
        let mut stdin = self.stdin.lock().await;
        let Some(pipe) = stdin.as_mut() else {
            return InputResult::Exited;
        };
        if pipe.write_all(data.as_bytes()).await.is_err() || pipe.flush().await.is_err() {
            return InputResult::Exited;
        }
        lock(&self.state).last_activity = Instant::now();
        InputResult::Ok
    }

    async fn resize(&self, cols: u32, rows: u32) -> ResizeResult {
        if lock(&self.state).exited {
            return ResizeResult::Exited;
        }
        let Some(tty) = self.tty_path().await else {
            return ResizeResult::Unavailable;
        };
        let flag = if self.bsd { "-f" } else { "-F" };
        let status = Command::new("stty")
            .args([
                flag,
                tty.as_str(),
                "cols",
                &cols.to_string(),
                "rows",
                &rows.to_string(),
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .await;
        if !status.is_ok_and(|status| status.success()) {
            return ResizeResult::Unavailable;
        }
        let mut state = lock(&self.state);
        state.cols = cols;
        state.rows = rows;
        state.last_activity = Instant::now();
        ResizeResult::Ok
    }

    async fn tty_path(&self) -> Option<String> {
        if let Some(tty) = lock(&self.state).tty.clone() {
            return Some(tty);
        }
        let row = descendants(self.pid?)
            .await
            .into_iter()
            .find(ProcessRow::has_tty)?;
        let tty = format!("/dev/{}", row.tty);
        lock(&self.state).tty = Some(tty.clone());
        Some(tty)
    }

    async fn wait_done(&self) {
        let mut done = self.done.clone();
        let _ = done.wait_for(|finished| *finished).await;
    }

    /// Close the terminal and everything it started; returns once the process has ended and its output is drained.
    async fn close(&self) {
        self.closing.get_or_init(|| self.terminate()).await;
    }

    /// End the PTY's processes, softly and then for good.
    ///
    /// The descendants are collected first, while the tree is whole. The shell leads its own session inside the
    /// PTY, so the `script` process group alone would miss it and its jobs. Each one gets SIGHUP, as closing a
    /// terminal window sends, and SIGTERM. Whatever is still alive after DSH's `disposeGraceMs` gets SIGKILL,
    /// along with the `script` group and the shell's group.
    async fn terminate(&self) {
        let grace = Duration::from_millis(self.limits.dispose_grace_ms);
        let Some(leader) = self.pid else {
            return;
        };
        if lock(&self.state).exited {
            let _ = tokio::time::timeout(grace * 2, self.wait_done()).await;
            return;
        }
        let tree = descendants(leader).await;
        let mut groups = vec![leader];
        groups.extend(tree.iter().filter(|row| row.has_tty()).map(|row| row.pid));
        for row in &tree {
            signals::hangup_and_terminate(row.pid);
        }
        signals::group(leader, true);
        let graceful = tokio::time::timeout(grace, self.wait_done()).await.is_ok();
        let remaining = descendants(leader).await;
        if !graceful || !remaining.is_empty() || tree.iter().any(|row| signals::alive(row.pid)) {
            for row in tree.iter().chain(remaining.iter()) {
                signals::kill(row.pid);
            }
            for group in &groups {
                signals::group(*group, false);
            }
        }
        let _ = tokio::time::timeout(grace * 2, self.wait_done()).await;
    }
}

fn new_terminal_id() -> String {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).expect("the operating system entropy source");
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    format!(
        "terminal-{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

fn now_iso() -> String {
    let ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis() as u64);
    crate::runs::iso_time(ms)
}

/// Read one pipe into the terminal until it closes.
async fn pump(pipe: Option<impl AsyncRead + Unpin>, terminal: Arc<Terminal>, stderr: bool) {
    let Some(mut pipe) = pipe else {
        return;
    };
    let mut decoder = Utf8Stream::default();
    let mut buffer = vec![0u8; 16 * 1024];
    loop {
        match pipe.read(&mut buffer).await {
            Ok(0) | Err(_) => break,
            Ok(read) => {
                let text = decoder.write(&buffer[..read]);
                if stderr {
                    terminal.stderr(&text);
                } else {
                    terminal.push(&text);
                }
            }
        }
    }
    let rest = decoder.end();
    if stderr {
        terminal.stderr(&rest);
    } else {
        terminal.push(&rest);
    }
}

struct Inner {
    limits: TerminalLimits,
    bsd: bool,
    poll: Duration,
    sessions: Mutex<Vec<(String, Vec<Arc<Terminal>>)>>,
    reaper: AtomicBool,
    next_listener: AtomicU64,
}

/// Every session's terminals, with the limits and the clean-up paths: close, archive, idle and shutdown.
#[derive(Clone)]
pub struct TerminalRegistry {
    inner: Arc<Inner>,
}

impl Default for TerminalRegistry {
    fn default() -> Self {
        TerminalRegistry::new(TERMINAL_LIMITS, Duration::from_secs(30))
    }
}

/// A stream's hold on a terminal; dropping it detaches the listener.
pub struct Attachment {
    terminal: Weak<Terminal>,
    listener: u64,
}

impl Drop for Attachment {
    fn drop(&mut self) {
        if let Some(terminal) = self.terminal.upgrade() {
            let mut state = lock(&terminal.state);
            state.listeners.remove(&self.listener);
            state.last_activity = Instant::now();
        }
    }
}

impl TerminalRegistry {
    pub fn new(limits: TerminalLimits, poll: Duration) -> Self {
        TerminalRegistry {
            inner: Arc::new(Inner {
                limits,
                bsd: cfg!(any(
                    target_os = "macos",
                    target_os = "freebsd",
                    target_os = "openbsd",
                    target_os = "netbsd"
                )),
                poll,
                sessions: Mutex::new(Vec::new()),
                reaper: AtomicBool::new(false),
                next_listener: AtomicU64::new(1),
            }),
        }
    }

    pub fn limits(&self) -> TerminalLimits {
        self.inner.limits
    }

    fn find(&self, session: &str, id: &str) -> Option<Arc<Terminal>> {
        lock(&self.inner.sessions)
            .iter()
            .find(|(owner, _)| owner == session)
            .and_then(|(_, terminals)| terminals.iter().find(|terminal| terminal.id == id).cloned())
    }

    pub fn list(&self, session: &str) -> Vec<TerminalInfo> {
        let terminals: Vec<Arc<Terminal>> = lock(&self.inner.sessions)
            .iter()
            .find(|(owner, _)| owner == session)
            .map(|(_, terminals)| terminals.clone())
            .unwrap_or_default();
        terminals.iter().map(|terminal| terminal.info()).collect()
    }

    fn held_by(&self, session: &str) -> usize {
        lock(&self.inner.sessions)
            .iter()
            .find(|(owner, _)| owner == session)
            .map_or(0, |(_, terminals)| terminals.len())
    }

    /// Start a terminal. The cap is judged before `confine`, so a full session is told so even on a host that
    /// cannot confine.
    pub fn create(
        &self,
        spec: TerminalSpawn,
        confine: impl FnOnce(&[OsString]) -> Result<Vec<OsString>, String>,
    ) -> Result<TerminalInfo, CreateRefusal> {
        if self.held_by(&spec.session) >= self.inner.limits.max_terminals {
            return Err(CreateRefusal::Limit);
        }
        let shell = spec
            .shell
            .clone()
            .unwrap_or_else(|| default_shell(std::env::var("SHELL").ok().as_deref()));
        let confined =
            confine(&shell_argv(&shell, spec.cols, spec.rows)).map_err(CreateRefusal::Sandbox)?;
        let argv = pty_argv(self.inner.bsd, &confined);
        let mut command = Command::new(&argv[0]);
        command
            .args(&argv[1..])
            .current_dir(&spec.cwd)
            .env("TERM", "xterm-256color")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(unix)]
        command.process_group(0);
        let mut child = command
            .spawn()
            .map_err(|error| CreateRefusal::Spawn(error.to_string()))?;
        let (done_tx, done_rx) = watch::channel(false);
        let terminal = Arc::new(Terminal {
            id: new_terminal_id(),
            session: spec.session.clone(),
            shell,
            cwd: spec.cwd.display().to_string(),
            mode: spec.mode,
            created: now_iso(),
            pid: child.id(),
            bsd: self.inner.bsd,
            limits: self.inner.limits,
            state: Mutex::new(State {
                cols: spec.cols,
                rows: spec.rows,
                exited: false,
                exit_code: None,
                chunks: VecDeque::new(),
                held: 0,
                seq: 0,
                truncated: false,
                last_activity: Instant::now(),
                tty: None,
                listeners: HashMap::new(),
                stderr_line: String::new(),
            }),
            stdin: tokio::sync::Mutex::new(child.stdin.take()),
            done: done_rx,
            closing: OnceCell::new(),
        });
        let stdout = tokio::spawn(pump(child.stdout.take(), terminal.clone(), false));
        let stderr = tokio::spawn(pump(child.stderr.take(), terminal.clone(), true));
        let watched = terminal.clone();
        tokio::spawn(async move {
            let status = child.wait().await;
            // The pipes close when `script` exits; a process that escaped with them open is not waited for.
            let _ = tokio::time::timeout(Duration::from_secs(1), async {
                let _ = stdout.await;
                let _ = stderr.await;
            })
            .await;
            watched.finish(status.ok().and_then(|status| status.code()));
            let _ = done_tx.send(true);
        });
        let info = terminal.info();
        {
            let mut sessions = lock(&self.inner.sessions);
            match sessions
                .iter_mut()
                .find(|(owner, _)| *owner == spec.session)
            {
                Some((_, terminals)) => terminals.push(terminal),
                None => sessions.push((spec.session, vec![terminal])),
            }
        }
        self.start_reaper();
        Ok(info)
    }

    /// The unattended sweep, started with the first terminal so a registry built outside a runtime never spawns.
    fn start_reaper(&self) {
        if self.inner.reaper.swap(true, Ordering::SeqCst) {
            return;
        }
        let weak = Arc::downgrade(&self.inner);
        let poll = self.inner.poll;
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(poll);
            ticker.tick().await;
            loop {
                ticker.tick().await;
                let Some(inner) = weak.upgrade() else {
                    return;
                };
                TerminalRegistry { inner }.reclaim().await;
            }
        });
    }

    pub async fn input(&self, session: &str, id: &str, data: &str) -> InputResult {
        match self.find(session, id) {
            Some(terminal) => terminal.input(data).await,
            None => InputResult::Missing,
        }
    }

    pub async fn resize(&self, session: &str, id: &str, cols: f64, rows: f64) -> ResizeResult {
        let Some(terminal) = self.find(session, id) else {
            return ResizeResult::Missing;
        };
        if !self.inner.limits.fits(cols, rows) {
            return ResizeResult::OutOfRange;
        }
        terminal.resize(cols as u32, rows as u32).await
    }

    /// Attach a listener: the snapshot to draw first, the events after it, and the hold that detaches on drop.
    pub fn attach(
        &self,
        session: &str,
        id: &str,
    ) -> Option<(
        TerminalSnapshot,
        mpsc::UnboundedReceiver<TerminalEvent>,
        Attachment,
    )> {
        let terminal = self.find(session, id)?;
        let (sender, receiver) = mpsc::unbounded_channel();
        let listener = self.inner.next_listener.fetch_add(1, Ordering::SeqCst);
        let snapshot = {
            let mut state = lock(&terminal.state);
            state.listeners.insert(listener, sender);
            state.last_activity = Instant::now();
            TerminalSnapshot {
                seq: state.seq,
                data: state.chunks.iter().map(String::as_str).collect(),
                truncated: state.truncated,
                exited: state.exited,
                exit_code: state.exit_code,
            }
        };
        Some((
            snapshot,
            receiver,
            Attachment {
                terminal: Arc::downgrade(&terminal),
                listener,
            },
        ))
    }

    /// Close one terminal and wait for its processes to end.
    pub async fn close(&self, session: &str, id: &str) -> bool {
        let Some(terminal) = self.find(session, id) else {
            return false;
        };
        terminal.close().await;
        let mut sessions = lock(&self.inner.sessions);
        if let Some(index) = sessions.iter().position(|(owner, _)| owner == session) {
            sessions[index].1.retain(|held| held.id != id);
            if sessions[index].1.is_empty() {
                sessions.remove(index);
            }
        }
        true
    }

    /// Close every terminal a session holds: archiving a session ends its terminals.
    pub async fn close_session(&self, session: &str) -> usize {
        let ids: Vec<String> = self.list(session).into_iter().map(|info| info.id).collect();
        futures::future::join_all(ids.iter().map(|id| self.close(session, id))).await;
        ids.len()
    }

    /// Close everything, for server shutdown, so a restart leaves no orphan shells.
    pub async fn close_all(&self) {
        let sessions: Vec<String> = lock(&self.inner.sessions)
            .iter()
            .map(|(owner, _)| owner.clone())
            .collect();
        futures::future::join_all(sessions.iter().map(|session| self.close_session(session))).await;
    }

    /// Close terminals nobody is watching that have been quiet for `unattended_ms`.
    pub async fn reclaim(&self) -> usize {
        let limit = Duration::from_millis(self.inner.limits.unattended_ms);
        let due: Vec<(String, String)> = lock(&self.inner.sessions)
            .iter()
            .flat_map(|(owner, terminals)| {
                terminals.iter().filter_map(move |terminal| {
                    let state = lock(&terminal.state);
                    (state.listeners.is_empty() && state.last_activity.elapsed() >= limit)
                        .then(|| (owner.clone(), terminal.id.clone()))
                })
            })
            .collect();
        futures::future::join_all(due.iter().map(|(session, id)| self.close(session, id))).await;
        due.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_character_split_across_reads_is_decoded_whole() {
        let bytes = "你好🙂".as_bytes();
        let mut stream = Utf8Stream::default();
        let text: String = bytes.iter().map(|byte| stream.write(&[*byte])).collect();
        assert_eq!(text + &stream.end(), "你好🙂");
        let mut bad = Utf8Stream::default();
        assert_eq!(bad.write(&[b'a', 0xff, b'b']), "a\u{fffd}b");
    }

    #[test]
    fn the_size_rule_is_dshs_caps() {
        assert!(TERMINAL_LIMITS.fits(500.0, 200.0));
        assert!(!TERMINAL_LIMITS.fits(501.0, 24.0));
        assert!(!TERMINAL_LIMITS.fits(80.0, 0.0));
        assert!(!TERMINAL_LIMITS.fits(80.5, 24.0));
    }

    #[test]
    fn the_pty_argv_is_bsd_or_util_linux() {
        let shell = shell_argv("/bin/zsh", 80, 24);
        let bsd = pty_argv(true, &shell);
        assert_eq!(
            &bsd[..3],
            &["/usr/bin/script", "-q", "/dev/null"].map(OsString::from)
        );
        let linux = pty_argv(false, &shell);
        assert_eq!(linux[1], OsString::from("-qfec"));
        assert_eq!(linux[3], OsString::from("/dev/null"));
        assert!(linux[2].to_string_lossy().starts_with("'/bin/sh' '-c' "));
    }

    #[test]
    fn descendants_walk_the_whole_tree_and_nothing_else() {
        let row = |pid, ppid| ProcessRow {
            pid,
            ppid,
            tty: String::new(),
        };
        let table = vec![
            row(10, 1),
            row(11, 10),
            row(12, 11),
            row(13, 1),
            row(14, 12),
        ];
        let found: Vec<u32> = descendants_in(10, &table)
            .iter()
            .map(|row| row.pid)
            .collect();
        assert_eq!(found, vec![11, 12, 14]);
    }

    #[test]
    fn the_default_shell_is_an_executable_absolute_shell_or_bin_sh() {
        assert_eq!(default_shell(Some("zsh")), "/bin/sh");
        assert_eq!(default_shell(Some("/no/such/shell")), "/bin/sh");
        assert_eq!(default_shell(None), "/bin/sh");
        assert_eq!(default_shell(Some("/bin/sh")), "/bin/sh");
    }

    #[cfg(target_os = "macos")]
    mod pty {
        use super::*;

        fn scratch(label: &str) -> PathBuf {
            let root =
                std::env::temp_dir().join(format!("heddle-terminal-{label}-{}", new_terminal_id()));
            std::fs::create_dir_all(&root).expect("a scratch folder");
            root
        }

        fn spawn(registry: &TerminalRegistry, session: &str, cwd: &Path) -> TerminalInfo {
            registry
                .create(
                    TerminalSpawn {
                        session: session.to_owned(),
                        cwd: cwd.to_path_buf(),
                        mode: "danger-full-access".to_owned(),
                        cols: 90,
                        rows: 25,
                        shell: Some("/bin/sh".to_owned()),
                    },
                    |argv| Ok(argv.to_vec()),
                )
                .expect("a terminal starts")
        }

        async fn until(
            receiver: &mut mpsc::UnboundedReceiver<TerminalEvent>,
            seen: &mut String,
            needle: &str,
        ) {
            let deadline = Instant::now() + Duration::from_secs(8);
            while !seen.contains(needle) {
                let left = deadline.saturating_duration_since(Instant::now());
                match tokio::time::timeout(left, receiver.recv()).await {
                    Ok(Some(TerminalEvent::Output { data, .. })) => seen.push_str(&data),
                    Ok(Some(TerminalEvent::Exit { .. })) | Ok(None) => break,
                    Err(_) => break,
                }
            }
            assert!(seen.contains(needle), "no {needle:?}; saw {seen:?}");
        }

        #[tokio::test]
        async fn a_terminal_takes_input_a_resize_and_closes_with_its_jobs() {
            let cwd = scratch("io");
            let registry = TerminalRegistry::default();
            let info = spawn(&registry, "a", &cwd);
            let (_, mut events, _hold) = registry.attach("a", &info.id).expect("attached");
            let mut seen = String::new();
            assert_eq!(
                registry
                    .input("a", &info.id, "stty size; echo SUM-$((6*7))\n")
                    .await,
                InputResult::Ok
            );
            until(&mut events, &mut seen, "SUM-42").await;
            assert!(
                seen.contains("25 90"),
                "the PTY starts at the asked size: {seen:?}"
            );
            assert_eq!(
                registry.resize("a", &info.id, 120.0, 40.0).await,
                ResizeResult::Ok
            );
            registry
                .input("a", &info.id, "stty size; sleep 300 & echo BG=$!\n")
                .await;
            until(&mut events, &mut seen, "40 120").await;
            until(&mut events, &mut seen, "BG=").await;
            let mut digits = String::new();
            let deadline = Instant::now() + Duration::from_secs(3);
            while Instant::now() < deadline {
                let tail = seen.split("BG=").last().unwrap_or("");
                digits = tail.chars().take_while(char::is_ascii_digit).collect();
                if tail.len() > digits.len() && !digits.is_empty() {
                    break;
                }
                if let Ok(Some(TerminalEvent::Output { data, .. })) =
                    tokio::time::timeout(Duration::from_millis(200), events.recv()).await
                {
                    seen.push_str(&data);
                }
            }
            let job: u32 = digits.parse().expect("the job's pid");
            assert!(signals::alive(job));
            assert_eq!(
                registry.input("b", &info.id, "echo nope\n").await,
                InputResult::Missing
            );
            assert!(registry.attach("b", &info.id).is_none());
            assert!(registry.close("a", &info.id).await);
            tokio::time::sleep(Duration::from_millis(200)).await;
            assert!(!signals::alive(job), "the job ended with its terminal");
            assert!(registry.list("a").is_empty());
            let _ = std::fs::remove_dir_all(cwd);
        }

        #[tokio::test]
        async fn the_cap_holds_and_an_exit_is_reported() {
            let cwd = scratch("cap");
            let registry = TerminalRegistry::new(
                TerminalLimits {
                    max_terminals: 1,
                    ..TERMINAL_LIMITS
                },
                Duration::from_secs(60),
            );
            let info = spawn(&registry, "a", &cwd);
            let refused = registry.create(
                TerminalSpawn {
                    session: "a".to_owned(),
                    cwd: cwd.clone(),
                    mode: "danger-full-access".to_owned(),
                    cols: 80,
                    rows: 24,
                    shell: None,
                },
                |_| Err("never asked".to_owned()),
            );
            assert_eq!(
                refused,
                Err(CreateRefusal::Limit),
                "the cap is judged before confinement"
            );
            let (_, mut events, _hold) = registry.attach("a", &info.id).expect("attached");
            registry.input("a", &info.id, "exit 3\n").await;
            let mut code = None;
            while let Ok(Some(event)) =
                tokio::time::timeout(Duration::from_secs(8), events.recv()).await
            {
                if let TerminalEvent::Exit { code: exit } = event {
                    code = Some(exit);
                    break;
                }
            }
            assert_eq!(code, Some(Some(3)));
            assert!(registry.list("a")[0].exited);
            assert_eq!(
                registry.input("a", &info.id, "echo late\n").await,
                InputResult::Exited
            );
            registry.close_all().await;
            let _ = std::fs::remove_dir_all(cwd);
        }

        #[tokio::test]
        async fn the_replay_is_bounded_and_unattended_terminals_are_reclaimed() {
            let cwd = scratch("replay");
            let registry = TerminalRegistry::new(
                TerminalLimits {
                    replay_bytes: 1000,
                    unattended_ms: 300,
                    ..TERMINAL_LIMITS
                },
                Duration::from_secs(60),
            );
            let info = spawn(&registry, "a", &cwd);
            {
                let (_, mut events, _hold) = registry.attach("a", &info.id).expect("attached");
                let mut seen = String::new();
                registry
                    .input(
                        "a",
                        &info.id,
                        "i=0; while [ $i -lt 400 ]; do printf '你好'; i=$((i+1)); done; echo; echo REPLAY-$((40+2))\n",
                    )
                    .await;
                until(&mut events, &mut seen, "REPLAY-42").await;
                tokio::time::sleep(Duration::from_millis(400)).await;
                assert_eq!(registry.reclaim().await, 0, "a watched terminal is kept");
            }
            let (snapshot, _, hold) = registry.attach("a", &info.id).expect("attached");
            drop(hold);
            assert!(snapshot.data.len() <= 1000, "bounded in bytes");
            assert!(snapshot.truncated);
            assert!(snapshot.data.contains("REPLAY-42"));
            assert!(!snapshot.data.contains('\u{fffd}'));
            tokio::time::sleep(Duration::from_millis(400)).await;
            assert_eq!(
                registry.reclaim().await,
                1,
                "an unwatched, quiet one is closed"
            );
            assert!(registry.list("a").is_empty());
            let _ = std::fs::remove_dir_all(cwd);
        }
    }
}
