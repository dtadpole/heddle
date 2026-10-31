//! Background `bash`: the job producer and the `run_in_background` half of the tool (`src/jobs/bash.ts`, from
//! `dsh-tool-bash/lib/index.js`, cited `BASH:n`; the process mechanics from `dsh-bash-local`).
//!
//! The command is confined by the same sandbox path a foreground call takes ([`heddle_tools::launch_shell`]), runs
//! in the call's folder with the same environment, and is spawned in a **process group of its own**, so a kill
//! reaches the whole tree: SIGTERM to the group, then SIGKILL after a grace period (DSH's 3000 ms).

use std::ffi::OsString;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures::future::BoxFuture;
use heddle_session::{Events, SessionHandle};
use heddle_tools::{
    BashBackground, ConfinedArgv, ForegroundRun, SandboxGate, SandboxMode, SandboxOutcome,
    ShellEnd, ToolArgs, ToolFailure, ToolResult, ToolRunContext,
};
use serde_json::{Value, json};
use tokio::io::AsyncReadExt;

use crate::registry::{
    JobHooks, JobOutcome, JobRegistry, JobSpec, JobStatus, JobToolCall, OutcomeStatus,
};
use crate::ring::{AppendOptions, JobChannel};

pub use heddle_tools::RUN_IN_BACKGROUND_DESCRIPTION;

/// How long a killed command's group has between SIGTERM and SIGKILL (DSH's 3000 ms).
pub const DEFAULT_KILL_GRACE_MS: u64 = 3_000;

/// Stderr kept for the sandbox classification at exit: the tail is where a denial or a runner failure is written.
const STDERR_CLASSIFY_CHARS: usize = 256 * 1024;

/// DSH's sandbox markers (`dsh-sandbox/lib/index.js:64-78`).
fn denial_marker(mode: SandboxMode) -> String {
    format!("[sandbox: file access denied under {mode} mode]")
}

const ESCALATION_HINT: &str = "[sandbox: escalation available — retry this exact command once with sandbox_permissions (the narrowest wider mode that suffices) + justification; the approval prompt asks the user]";

fn runner_failure_marker(mode: SandboxMode) -> String {
    format!(
        "[sandbox: the sandbox runner itself failed under {mode} mode — the command did not run; this is a sandbox problem, not a command failure]"
    )
}

/// The sandbox's reading of a confined command's end.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SandboxReading {
    pub mode: SandboxMode,
    pub denied: bool,
    pub runner_failed: bool,
}

/// What a settled process reports, before it becomes a job outcome.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcessEnd {
    /// Whether a kill was asked for, or the process died of a signal.
    pub killed: bool,
    pub exit_code: Option<i32>,
    /// The signal's name (`SIGTERM`), when it died of one.
    pub signal: Option<String>,
    pub sandbox: Option<SandboxReading>,
}

/// Map a settled process onto the job vocabulary (BASH:42-55): killed stays `killed` with the signal, or `killed
/// before exit`; every other end — a nonzero exit included — is `completed` with `exit code: <n>`. Sandbox notes join
/// the detail with "; ".
pub fn process_outcome(end: &ProcessEnd, escalation_modes: &[SandboxMode]) -> JobOutcome {
    let (status, detail) = if end.killed {
        (
            OutcomeStatus::Killed,
            match &end.signal {
                Some(signal) => format!("signal: {signal}"),
                None => "killed before exit".to_owned(),
            },
        )
    } else {
        (
            OutcomeStatus::Completed,
            format!("exit code: {}", end.exit_code.unwrap_or(0)),
        )
    };
    let mut notes: Vec<String> = Vec::new();
    match end.sandbox {
        Some(reading) if reading.runner_failed => notes.push(runner_failure_marker(reading.mode)),
        Some(reading) if reading.denied => {
            notes.push(denial_marker(reading.mode));
            if !escalation_modes.is_empty() {
                notes.push(ESCALATION_HINT.to_owned());
            }
        }
        _ => {}
    }
    let detail = if notes.is_empty() {
        detail
    } else {
        format!("{detail}; {}", notes.join(" "))
    };
    JobOutcome {
        status,
        detail: Some(detail),
        result: None,
    }
}

/// The name Node gives a signal number (`os.constants.signals`), or `SIG<n>` for one it would not know.
pub fn signal_name(number: i32) -> String {
    use rustix::process::Signal;
    let known = [
        (Signal::HUP, "SIGHUP"),
        (Signal::INT, "SIGINT"),
        (Signal::QUIT, "SIGQUIT"),
        (Signal::ILL, "SIGILL"),
        (Signal::TRAP, "SIGTRAP"),
        (Signal::ABORT, "SIGABRT"),
        (Signal::BUS, "SIGBUS"),
        (Signal::FPE, "SIGFPE"),
        (Signal::KILL, "SIGKILL"),
        (Signal::USR1, "SIGUSR1"),
        (Signal::SEGV, "SIGSEGV"),
        (Signal::USR2, "SIGUSR2"),
        (Signal::PIPE, "SIGPIPE"),
        (Signal::ALARM, "SIGALRM"),
        (Signal::TERM, "SIGTERM"),
        (Signal::CHILD, "SIGCHLD"),
        (Signal::CONT, "SIGCONT"),
        (Signal::STOP, "SIGSTOP"),
        (Signal::TSTP, "SIGTSTP"),
        (Signal::TTIN, "SIGTTIN"),
        (Signal::TTOU, "SIGTTOU"),
        (Signal::URG, "SIGURG"),
        (Signal::XCPU, "SIGXCPU"),
        (Signal::XFSZ, "SIGXFSZ"),
        (Signal::VTALARM, "SIGVTALRM"),
        (Signal::PROF, "SIGPROF"),
        (Signal::WINCH, "SIGWINCH"),
        (Signal::IO, "SIGIO"),
        (Signal::SYS, "SIGSYS"),
    ];
    known
        .iter()
        .find(|(signal, _)| signal.as_raw() == number)
        .map_or_else(|| format!("SIG{number}"), |(_, name)| (*name).to_owned())
}

/// Signal a whole process group through the sandbox's one group helper (`heddle_sandbox::signal_process_group`,
/// which a foreground `bash` stops its group with), a group already gone counting as signalled.
pub fn signal_group(pgid: i32, signal: rustix::process::Signal) {
    let Ok(leader) = u32::try_from(pgid) else {
        return;
    };
    if let Err(error) = heddle_sandbox::signal_process_group(leader, signal) {
        tracing::warn!(%error, leader, "a background job's process group could not be signalled");
    }
}

/// Whether any process is left in a process group.
pub fn group_alive(pgid: i32) -> bool {
    rustix::process::Pid::from_raw(pgid)
        .is_some_and(|pid| rustix::process::test_kill_process_group(pid).is_ok())
}

/// The name Node's spawn error carries (`spawn /bin/sh ENOENT`).
fn spawn_error(program: &OsString, error: &std::io::Error) -> String {
    let code = match error.raw_os_error() {
        Some(1) => Some("EPERM"),
        Some(2) => Some("ENOENT"),
        Some(7) => Some("E2BIG"),
        Some(8) => Some("ENOEXEC"),
        Some(12) => Some("ENOMEM"),
        Some(13) => Some("EACCES"),
        Some(20) => Some("ENOTDIR"),
        _ => None,
    };
    let program = program.to_string_lossy();
    match code {
        Some(code) => format!("spawn {program} {code}"),
        None => format!("spawn {program} {error}"),
    }
}

/// Where a producer's decoded output goes, chunk by chunk.
pub type AppendOutput = Arc<dyn Fn(&str, JobChannel) + Send + Sync>;

/// Told a job's id and its process id once it is spawned.
pub type SpawnObserver = Arc<dyn Fn(&str, i32) + Send + Sync>;

/// Everything one background command needs to run.
pub struct BackgroundProcess {
    pub argv: Vec<OsString>,
    pub cwd: PathBuf,
    pub confined: Option<ConfinedArgv>,
    pub mode: SandboxMode,
    /// The gate the settled command is classified by.
    pub sandbox: Arc<dyn SandboxGate>,
    pub escalation_modes: Vec<SandboxMode>,
    pub kill_grace_ms: Option<u64>,
    /// Told the process id once it is spawned, so a caller (a test) can watch the group.
    pub on_spawn: Option<Box<dyn FnOnce(i32) + Send>>,
    /// Told the exit code (`None` for a signal) before the job settles: a promoting foreground call renders its own
    /// answer from it.
    pub on_end: Option<Box<dyn FnOnce(Option<i32>) + Send>>,
}

/// Decodes a byte stream as UTF-8 across chunk boundaries, as Node's `StringDecoder` does: an incomplete sequence
/// waits for the next chunk, an invalid one is U+FFFD.
#[derive(Default)]
struct Utf8Stream {
    pending: Vec<u8>,
}

impl Utf8Stream {
    fn write(&mut self, bytes: &[u8]) -> String {
        self.pending.extend_from_slice(bytes);
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
                    text.push_str(std::str::from_utf8(&self.pending[..valid]).unwrap_or_default());
                    match error.error_len() {
                        None => {
                            self.pending.drain(..valid);
                            return text;
                        }
                        Some(invalid) => {
                            text.push('\u{FFFD}');
                            self.pending.drain(..valid + invalid);
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

/// Run one command as a job's producer: stdout and stderr appended to the job as they arrive, a cancel that stops
/// the group, and a `done` that always resolves — a spawn failure settles `failed` with the error's message.
pub fn run_process(spec: BackgroundProcess, append: AppendOutput) -> JobHooks {
    let cancelled = Arc::new(AtomicBool::new(false));
    let closed = Arc::new(AtomicBool::new(false));
    let grace = Duration::from_millis(spec.kill_grace_ms.unwrap_or(DEFAULT_KILL_GRACE_MS));
    let BackgroundProcess {
        argv,
        cwd,
        confined,
        mode,
        sandbox,
        escalation_modes,
        on_spawn,
        on_end,
        ..
    } = spec;
    let mut command = tokio::process::Command::new(&argv[0]);
    command
        .args(&argv[1..])
        .current_dir(&cwd)
        .env("NO_COLOR", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0)
        .kill_on_drop(false);
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            let detail = spawn_error(&argv[0], &error);
            return JobHooks {
                cancel: Box::new(|_: Option<&str>| Ok(())),
                done: Box::pin(async move { JobOutcome::failed(detail) }),
            };
        }
    };
    let pid = child.id().map(|pid| pid as i32);
    if let (Some(pid), Some(on_spawn)) = (pid, on_spawn) {
        on_spawn(pid);
    }
    let stderr_tail = Arc::new(Mutex::new(String::new()));
    let reader = |stream: Option<Box<dyn tokio::io::AsyncRead + Send + Unpin>>,
                  channel: JobChannel| {
        let append = Arc::clone(&append);
        let tail = Arc::clone(&stderr_tail);
        tokio::spawn(async move {
            let Some(mut stream) = stream else {
                return;
            };
            let mut decoder = Utf8Stream::default();
            let mut buffer = vec![0u8; 16 * 1024];
            let take = |text: String| {
                if text.is_empty() {
                    return;
                }
                if channel == JobChannel::Stderr {
                    let mut tail = tail.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
                    tail.push_str(&text);
                    if tail.len() > STDERR_CLASSIFY_CHARS {
                        let count = tail.chars().count();
                        if count > STDERR_CLASSIFY_CHARS {
                            let cut: String =
                                tail.chars().skip(count - STDERR_CLASSIFY_CHARS).collect();
                            *tail = cut;
                        }
                    }
                }
                append(&text, channel);
            };
            loop {
                match stream.read(&mut buffer).await {
                    Ok(0) | Err(_) => break,
                    Ok(read) => take(decoder.write(&buffer[..read])),
                }
            }
            take(decoder.end());
        })
    };
    let stdout = reader(
        child
            .stdout
            .take()
            .map(|stream| Box::new(stream) as Box<dyn tokio::io::AsyncRead + Send + Unpin>),
        JobChannel::Stdout,
    );
    let stderr = reader(
        child
            .stderr
            .take()
            .map(|stream| Box::new(stream) as Box<dyn tokio::io::AsyncRead + Send + Unpin>),
        JobChannel::Stderr,
    );
    let (finish, finished) = tokio::sync::oneshot::channel::<JobOutcome>();
    {
        let cancelled = Arc::clone(&cancelled);
        let closed = Arc::clone(&closed);
        tokio::spawn(async move {
            let status = child.wait().await;
            let _ = stdout.await;
            let _ = stderr.await;
            closed.store(true, Ordering::SeqCst);
            let outcome = match status {
                Err(error) => JobOutcome::failed(error.to_string()),
                Ok(status) => {
                    use std::os::unix::process::ExitStatusExt;
                    let code = status.code();
                    if let Some(on_end) = on_end {
                        on_end(code);
                    }
                    let signal = status.signal().map(signal_name);
                    let reading = confined.as_ref().map(|confined| {
                        let tail = stderr_tail
                            .lock()
                            .unwrap_or_else(|poisoned| poisoned.into_inner())
                            .clone();
                        match sandbox.classify_outcome(code.unwrap_or(1), &tail, Some(confined)) {
                            SandboxOutcome::Denied => SandboxReading {
                                mode,
                                denied: true,
                                runner_failed: false,
                            },
                            SandboxOutcome::RunnerFailure { .. } => SandboxReading {
                                mode,
                                denied: false,
                                runner_failed: true,
                            },
                            SandboxOutcome::Exited => SandboxReading {
                                mode,
                                denied: false,
                                runner_failed: false,
                            },
                        }
                    });
                    process_outcome(
                        &ProcessEnd {
                            killed: cancelled.load(Ordering::SeqCst) || signal.is_some(),
                            exit_code: code,
                            signal,
                            sandbox: reading,
                        },
                        &escalation_modes,
                    )
                }
            };
            let _ = finish.send(outcome);
        });
    }
    JobHooks {
        cancel: Box::new(move |_reason: Option<&str>| {
            if cancelled.swap(true, Ordering::SeqCst) {
                return Ok(());
            }
            let Some(group) = pid else {
                return Ok(());
            };
            if closed.load(Ordering::SeqCst) {
                return Ok(());
            }
            signal_group(group, rustix::process::Signal::TERM);
            // A killed group's stragglers still get their SIGKILL after the grace period.
            let timer = async move {
                tokio::time::sleep(grace).await;
                signal_group(group, rustix::process::Signal::KILL);
            };
            match tokio::runtime::Handle::try_current() {
                Ok(runtime) => {
                    runtime.spawn(timer);
                }
                Err(_) => {
                    std::thread::spawn(move || {
                        std::thread::sleep(grace);
                        signal_group(group, rustix::process::Signal::KILL);
                    });
                }
            }
            Ok(())
        }),
        done: Box::pin(async move {
            finished.await.unwrap_or_else(|_| {
                JobOutcome::failed("the process watcher ended without an outcome")
            })
        }),
    }
}

/// The tool call that is running, read from the session log.
///
/// Heddle's tool context carries no call id, and `bash` is an exclusive tool: every call before it in the step has
/// already been answered in the log when it runs. So the running call is the first `bash` tool call of the current
/// model answer that has no tool result yet and whose arguments are these. `None` when the log cannot say.
pub fn running_tool_call(
    events: &[Arc<heddle_session::SessionEvent>],
    name: &str,
    args: &ToolArgs,
) -> Option<JobToolCall> {
    let mut answered: Vec<&str> = Vec::new();
    let mut candidates: Vec<(&str, &str)> = Vec::new();
    for event in events.iter().rev() {
        if event.kind == "model/request" {
            break;
        }
        if event.kind == "message" {
            let message = event.get("message");
            if message.and_then(|m| m.get("role")).and_then(Value::as_str) == Some("tool")
                && let Some(id) = message
                    .and_then(|m| m.get("toolCallId"))
                    .and_then(Value::as_str)
            {
                answered.push(id);
            }
            continue;
        }
        if event.kind != "assistant/chunk" {
            continue;
        }
        let Some(chunk) = event.get("chunk") else {
            continue;
        };
        if chunk.get("type").and_then(Value::as_str) == Some("tool-call")
            && chunk.get("name").and_then(Value::as_str) == Some(name)
            && let (Some(id), Some(arguments)) = (
                chunk.get("id").and_then(Value::as_str),
                chunk.get("arguments").and_then(Value::as_str),
            )
        {
            candidates.insert(0, (id, arguments));
        }
    }
    let wanted = serde_json::to_string(args).ok()?;
    candidates
        .into_iter()
        .filter(|(id, _)| !answered.contains(id))
        .find(|(_, arguments)| {
            serde_json::from_str::<Value>(arguments)
                .ok()
                .and_then(|parsed| serde_json::to_string(&parsed).ok())
                .is_some_and(|parsed| parsed == wanted)
        })
        .map(|(id, _)| JobToolCall {
            call_id: id.to_owned(),
            root_call_id: id.to_owned(),
        })
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Reads a session's log, to find the tool call that started a job.
pub type ReadLog = Arc<dyn Fn(&SessionHandle) -> Option<Events> + Send + Sync>;

/// What background `bash` is built with.
#[derive(Clone, Default)]
pub struct BashBackgroundOptions {
    pub read_log: Option<ReadLog>,
    pub kill_grace_ms: Option<u64>,
    pub on_spawn: Option<SpawnObserver>,
    /// Run every foreground call as a job, so one that outlives its wall time moves to the background instead of
    /// being killed: DSH's `promoteOnTimeout`, default true (BASH:181-183, 386-491). `Some(false)` leaves the
    /// foreground run, and its wall-time kill, to the tool.
    pub promote_on_timeout: Option<bool>,
}

/// The promoted call's answer, DSH's `renderPromoted` verbatim (BASH:181-183).
pub fn render_promoted(output: &str, timeout_ms: u64, job_id: &str) -> String {
    let lead = if output.is_empty() {
        String::new()
    } else if output.ends_with('\n') {
        output.to_owned()
    } else {
        format!("{output}\n")
    };
    format!(
        "{lead}[still running after {timeout_ms}ms; moved to background job {job_id}]\nThe command keeps running in the background. You will be notified when it finishes; read newer output with job_output, stop it with job_kill."
    )
}

/// A promoting call's output, kept for its foreground answer until it stops waiting.
#[derive(Default)]
struct Captured {
    stdout: String,
    stderr: String,
    /// Set once the call answered promoted: the job's output is then the ring's alone.
    promoted: bool,
    /// The exit code once the process ended (`Some(None)` for a signal).
    ended: Option<Option<i32>>,
}

/// The runner the jobs row attaches to `bash` ([`heddle_tools::attach_bash_background`]): register the command as a
/// `bash` job owned by the calling session and answer `started background job <id>` at once (BASH:651, 673-685).
pub struct BashRunner {
    jobs: JobRegistry,
    options: BashBackgroundOptions,
}

impl BashRunner {
    /// The runner over one registry.
    pub fn new(jobs: JobRegistry, options: BashBackgroundOptions) -> Self {
        Self { jobs, options }
    }
}

fn command_of(args: &ToolArgs) -> String {
    match args.get("command") {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(text)) => text.clone(),
        Some(other) => other.to_string(),
    }
}

impl BashBackground for BashRunner {
    fn start(
        &self,
        args: ToolArgs,
        context: ToolRunContext,
        sandbox: Arc<dyn SandboxGate>,
    ) -> BoxFuture<'static, Result<ToolResult, ToolFailure>> {
        let jobs = self.jobs.clone();
        let options = self.options.clone();
        Box::pin(async move {
            let command = command_of(&args);
            if context.is_cancelled() {
                return Ok(ToolResult::refused("TOOL_ABORTED", "tool call aborted"));
            }
            let launch = match heddle_tools::launch_shell(sandbox.as_ref(), &command, &context) {
                Ok(launch) => launch,
                Err(refusal) => return Ok(*refusal),
            };
            let tool_call = match (&context.session, &options.read_log) {
                (Some(session), Some(read_log)) => {
                    read_log(session).and_then(|events| running_tool_call(&events, "bash", &args))
                }
                _ => None,
            };
            let cwd = context.cwd.clone();
            let mode = context.mode();
            let escalation_modes = sandbox.escalation_targets();
            let kill_grace_ms = options.kill_grace_ms;
            let on_spawn = options.on_spawn.clone();
            let mut spec = JobSpec::new("bash", command, move |handle| {
                let job_id = handle.id().to_owned();
                let append_handle = handle.clone();
                run_process(
                    BackgroundProcess {
                        argv: launch.argv,
                        cwd,
                        confined: launch.confined,
                        mode,
                        sandbox,
                        escalation_modes,
                        kill_grace_ms,
                        on_spawn: on_spawn.map(|notify| {
                            Box::new(move |pid: i32| notify(&job_id, pid))
                                as Box<dyn FnOnce(i32) + Send>
                        }),
                        on_end: None,
                    },
                    Arc::new(move |text: &str, channel: JobChannel| {
                        append_handle.append(text, AppendOptions::channel(channel));
                    }),
                )
            });
            spec.owner = context.session.as_ref().map(|session| session.id.clone());
            spec.tool_call = tool_call;
            let id = match jobs.start(spec) {
                Ok(id) => id,
                Err(error) => return Ok(ToolResult::refused(error.code, error.message)),
            };
            context.log(&format!("started background job {id}"));
            let data = serde_json::Map::from_iter([
                ("jobId".to_owned(), json!(id)),
                ("cwd".to_owned(), json!(context.cwd.display().to_string())),
            ]);
            Ok(ToolResult::ok(format!("started background job {id}")).with_data(data))
        })
    }

    fn promotes(&self) -> bool {
        self.options.promote_on_timeout != Some(false)
    }

    /// A foreground call as a job (BASH:386-491, `waitOnJob`). The job is registered at the call's start and waited
    /// on for the wall time. Ended in time: the record is removed (the wait collected the settle, so no notice
    /// follows) and the call answers as a foreground one would. Still running: nothing is killed; the call answers
    /// the output so far (one consuming read, so `job_output` goes on after it) and the promoted marker. Stopped: the
    /// job is killed with `tool call aborted`, waited on and removed, and the call answers stopped.
    fn run_foreground(
        &self,
        run: ForegroundRun,
    ) -> BoxFuture<'static, Option<Result<ToolResult, ToolFailure>>> {
        let jobs = self.jobs.clone();
        let options = self.options.clone();
        Box::pin(async move {
            let ForegroundRun {
                args,
                context,
                sandbox,
                launch,
                limit_ms,
                render,
            } = run;
            let command = command_of(&args);
            let owner = context.session.as_ref().map(|session| session.id.clone());
            let tool_call = match (&context.session, &options.read_log) {
                (Some(session), Some(read_log)) => {
                    read_log(session).and_then(|events| running_tool_call(&events, "bash", &args))
                }
                _ => None,
            };
            let captured = Arc::new(Mutex::new(Captured::default()));
            let cwd = context.cwd.clone();
            let mode = context.mode();
            let escalation_modes = sandbox.escalation_targets();
            let kill_grace_ms = options.kill_grace_ms;
            let on_spawn = options.on_spawn.clone();
            let producer_captured = Arc::clone(&captured);
            let mut spec = JobSpec::new("bash", command, move |handle| {
                let job_id = handle.id().to_owned();
                let append_handle = handle.clone();
                let ended = Arc::clone(&producer_captured);
                let appended = Arc::clone(&producer_captured);
                run_process(
                    BackgroundProcess {
                        argv: launch.argv,
                        cwd,
                        confined: launch.confined,
                        mode,
                        sandbox,
                        escalation_modes,
                        kill_grace_ms,
                        on_spawn: on_spawn.map(|notify| {
                            Box::new(move |pid: i32| notify(&job_id, pid))
                                as Box<dyn FnOnce(i32) + Send>
                        }),
                        on_end: Some(Box::new(move |code: Option<i32>| {
                            lock(&ended).ended = Some(code);
                        })),
                    },
                    Arc::new(move |text: &str, channel: JobChannel| {
                        append_handle.append(text, AppendOptions::channel(channel));
                        let mut kept = lock(&appended);
                        if !kept.promoted {
                            if channel == JobChannel::Stderr {
                                kept.stderr.push_str(text);
                            } else {
                                kept.stdout.push_str(text);
                            }
                        }
                    }),
                )
            });
            spec.owner = owner.clone();
            spec.tool_call = tool_call;
            let id = match jobs.start(spec) {
                Ok(id) => id,
                Err(error) => {
                    context.log(&format!(
                        "bash: job registration refused, running in the foreground with the wall-time kill instead: {}",
                        error.message
                    ));
                    return None;
                }
            };
            let caller = owner.as_deref();
            let end = |stopped: bool| {
                let kept = lock(&captured);
                ShellEnd {
                    stdout: kept.stdout.clone(),
                    stderr: kept.stderr.clone(),
                    code: kept.ended.flatten(),
                    stopped,
                    timed_out: false,
                    limit_ms,
                }
            };
            let live =
                |status: JobStatus| matches!(status, JobStatus::Running | JobStatus::Stopping);
            match jobs
                .wait(&id, limit_ms as f64, caller, context.cancel.clone())
                .await
            {
                Err(_) => {
                    let _ = jobs.kill(&id, caller, Some("tool call aborted"));
                    let grace = kill_grace_ms.unwrap_or(DEFAULT_KILL_GRACE_MS);
                    let settle = limit_ms.max(grace + 1_000) as f64;
                    if let Ok(view) = jobs.wait(&id, settle, caller, None).await
                        && !live(view.status)
                    {
                        let _ = jobs.remove(&id, caller);
                    }
                    Some(Ok(render(end(true))))
                }
                Ok(view) if live(view.status) => {
                    lock(&captured).promoted = true;
                    let output = match jobs.read(&id, caller) {
                        Ok(read) => crate::tools::render_model_delta(
                            &read.chunks,
                            read.lossy,
                            read.job.output.spill_paths.as_deref().unwrap_or_default(),
                        ),
                        Err(_) => String::new(),
                    };
                    context.log(&format!(
                        "moved the command to background job {id} after {limit_ms}ms"
                    ));
                    let data = serde_json::Map::from_iter([
                        ("jobId".to_owned(), json!(id)),
                        ("promoted".to_owned(), json!(true)),
                        ("cwd".to_owned(), json!(context.cwd.display().to_string())),
                    ]);
                    Some(Ok(
                        ToolResult::ok(render_promoted(&output, limit_ms, &id)).with_data(data)
                    ))
                }
                Ok(view) => {
                    let _ = jobs.remove(&id, caller);
                    if view.status == JobStatus::Failed {
                        let detail = view
                            .detail
                            .unwrap_or_else(|| "the command could not start".to_owned());
                        return Some(Ok(ToolResult::refused("TOOL_FAILED", detail)));
                    }
                    Some(Ok(render(end(false))))
                }
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn end(killed: bool, exit_code: Option<i32>, signal: Option<&str>) -> ProcessEnd {
        ProcessEnd {
            killed,
            exit_code,
            signal: signal.map(str::to_owned),
            sandbox: None,
        }
    }

    fn detail(outcome: &JobOutcome) -> &str {
        outcome.detail.as_deref().unwrap_or("")
    }

    #[test]
    fn process_outcome_maps_a_settled_process_as_dsh_does_with_sandbox_notes_joined() {
        let killed = process_outcome(&end(true, None, Some("SIGTERM")), &[]);
        assert_eq!(killed.status, OutcomeStatus::Killed);
        assert_eq!(detail(&killed), "signal: SIGTERM");
        let before = process_outcome(&end(true, Some(143), None), &[]);
        assert_eq!(
            (before.status, detail(&before)),
            (OutcomeStatus::Killed, "killed before exit")
        );
        let exited = process_outcome(&end(false, Some(2), None), &[]);
        assert_eq!(
            (exited.status, detail(&exited)),
            (OutcomeStatus::Completed, "exit code: 2")
        );
        let denied = ProcessEnd {
            sandbox: Some(SandboxReading {
                mode: SandboxMode::ReadOnly,
                denied: true,
                runner_failed: false,
            }),
            ..end(false, Some(1), None)
        };
        assert_eq!(
            detail(&process_outcome(&denied, &[])),
            "exit code: 1; [sandbox: file access denied under read-only mode]"
        );
        assert_eq!(
            detail(&process_outcome(&denied, &[SandboxMode::WorkspaceWrite])),
            "exit code: 1; [sandbox: file access denied under read-only mode] [sandbox: escalation available — retry this exact command once with sandbox_permissions (the narrowest wider mode that suffices) + justification; the approval prompt asks the user]"
        );
        let runner = ProcessEnd {
            sandbox: Some(SandboxReading {
                mode: SandboxMode::WorkspaceWrite,
                denied: false,
                runner_failed: true,
            }),
            ..end(false, Some(71), None)
        };
        assert_eq!(
            detail(&process_outcome(&runner, &[])),
            "exit code: 71; [sandbox: the sandbox runner itself failed under workspace-write mode — the command did not run; this is a sandbox problem, not a command failure]"
        );
        assert_eq!(
            signal_name(rustix::process::Signal::TERM.as_raw()),
            "SIGTERM"
        );
        assert_eq!(
            signal_name(rustix::process::Signal::KILL.as_raw()),
            "SIGKILL"
        );
    }

    fn event(seq: u64, kind: &str, fields: Value) -> Arc<heddle_session::SessionEvent> {
        Arc::new(heddle_session::SessionEvent {
            seq,
            at: String::new(),
            kind: kind.into(),
            fields: fields.as_object().cloned().unwrap_or_default(),
        })
    }

    #[test]
    fn running_tool_call_skips_answered_calls_and_matches_arguments() {
        let log = [
            event(0, "model/request", json!({})),
            event(
                1,
                "assistant/chunk",
                json!({ "chunk": { "type": "tool-call", "id": "c1", "name": "bash", "arguments": "{\"command\":\"a\"}" } }),
            ),
            event(
                2,
                "assistant/chunk",
                json!({ "chunk": { "type": "tool-call", "id": "c2", "name": "bash", "arguments": "{\"command\":\"a\"}" } }),
            ),
            event(
                3,
                "message",
                json!({ "message": { "role": "tool", "toolCallId": "c1", "content": [] } }),
            ),
        ];
        let args = |command: &str| json!({ "command": command }).as_object().cloned().unwrap();
        assert_eq!(
            running_tool_call(&log, "bash", &args("a")),
            Some(JobToolCall {
                call_id: "c2".into(),
                root_call_id: "c2".into()
            })
        );
        assert_eq!(running_tool_call(&log, "bash", &args("b")), None);
    }

    #[test]
    fn the_stream_decoder_holds_a_split_character_and_replaces_an_invalid_byte() {
        let mut decoder = Utf8Stream::default();
        let euro = "€".as_bytes();
        assert_eq!(decoder.write(&euro[..1]), "");
        assert_eq!(decoder.write(&euro[1..]), "€");
        assert_eq!(decoder.write(b"a\xffb"), "a\u{FFFD}b");
        assert_eq!(decoder.write(&euro[..2]), "");
        assert_eq!(decoder.end(), "\u{FFFD}");
    }
}
