//! Outside tools as processes: start a declared component, register its tools, forward their calls.
//!
//! The Rust shape of the TypeScript build's out-of-repository plugin (`_verifiers_/40-pluggable-tools`,
//! "a tool written outside this repository can be plugged in and used"). The configuration crate resolves
//! a row that names an outside component into an [`OutsideComponentSpec`]; the binary starts it, and every
//! tool it declares lands in the [`ToolRegistry`] through the same [`ToolRegistry::register`] rule as a
//! built-in — so a blank name fails the row, a name already taken displaces the earlier tool, and the allow
//! list judges it like any other. The wire is [`crate::protocol`].

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStderr, ChildStdin, ChildStdout};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

use crate::gates::SandboxGate;
use crate::protocol::{
    self, CallContext, InitializeParams, InitializeResult, JSONRPC, LogParams, Message,
    Notification, PROTOCOL, Request, RequestId, Response, RpcError, SandboxAssertParams,
    SandboxAssertResult, ToolsCallParams, error_codes, methods,
};
use crate::registry::{RegistrationError, ToolRegistry};
use crate::tool::{Tool, ToolArgs, ToolFuture, ToolResult, ToolRunContext, codes};
use crate::upstream::{SandboxMode, ToolSpec};

/// How long a component has to answer `initialize` before its row fails.
pub const DEFAULT_INIT_TIMEOUT: Duration = Duration::from_secs(10);

/// How long `shutdown` waits for the answer, and then for the exit, before the process is killed.
pub const SHUTDOWN_GRACE: Duration = Duration::from_secs(2);

/// One outside component, as configuration declares it.
#[derive(Debug, Clone, PartialEq)]
pub struct OutsideComponentSpec {
    /// The configuration row's id; every error and log line names it.
    pub row: String,
    /// The program to run: an executable (a script with a shebang is enough).
    pub program: PathBuf,
    /// Its arguments.
    pub args: Vec<String>,
    /// Its working directory: the folder of the layer file that declared it.
    pub cwd: PathBuf,
    /// Variables added to the inherited environment.
    pub env: Vec<(String, String)>,
    /// The row's `config` object, passed to the component in `initialize`.
    pub config: serde_json::Value,
    /// How long `initialize` may take.
    pub init_timeout: Duration,
}

impl OutsideComponentSpec {
    /// A spec with no arguments, no extra environment, a `null` config and the default timeout.
    pub fn new(
        row: impl Into<String>,
        program: impl Into<PathBuf>,
        cwd: impl Into<PathBuf>,
    ) -> Self {
        Self {
            row: row.into(),
            program: program.into(),
            args: Vec::new(),
            cwd: cwd.into(),
            env: Vec::new(),
            config: serde_json::Value::Null,
            init_timeout: DEFAULT_INIT_TIMEOUT,
        }
    }
}

/// Why an outside component did not start, or a request to it did not complete. Every message names the row.
#[derive(Debug, Clone, thiserror::Error)]
pub enum OutsideError {
    /// The process could not be spawned.
    #[error("outside component '{row}' could not start: {message}")]
    Spawn {
        /// The row.
        row: String,
        /// The OS's reason.
        message: String,
    },
    /// `initialize` was not answered in time.
    #[error("outside component '{row}' did not answer initialize within {seconds}s")]
    InitTimeout {
        /// The row.
        row: String,
        /// The timeout.
        seconds: u64,
    },
    /// The component broke the protocol.
    #[error("outside component '{row}' broke the protocol: {message}")]
    Protocol {
        /// The row.
        row: String,
        /// What was wrong.
        message: String,
    },
    /// The process exited while the host needed it.
    #[error("outside component '{row}' exited ({status})")]
    Exited {
        /// The row.
        row: String,
        /// The exit status as the OS reported it.
        status: String,
    },
    /// The component answered a request with an error.
    ///
    /// The error is boxed so this variant, and therefore every `Result` these functions return, stays small:
    /// clippy's `result_large_err` refuses a function whose error is 128 bytes or more, and `RpcError` carries
    /// a code, a message and optional structured data. The shape a caller matches on is unchanged.
    #[error("outside component '{row}' answered with an error: {error}")]
    Rpc {
        /// The row.
        row: String,
        /// Its error.
        error: Box<RpcError>,
    },
    /// The request was cancelled by the caller.
    #[error("the request to outside component '{row}' was cancelled")]
    Cancelled {
        /// The row.
        row: String,
    },
    /// One of its tools was refused at registration.
    #[error("outside component '{row}': {source}")]
    Registration {
        /// The row.
        row: String,
        /// The registry's reason, which names what was missing.
        source: RegistrationError,
    },
}

/// One answer waiting for its request: a value, or why it did not arrive.
type Waiter = oneshot::Sender<Result<serde_json::Value, OutsideError>>;

/// The live connection to one component process: the line writer, the table of pending requests, the modes
/// of in-flight calls for the sandbox back-channel, and the fact that it is gone once it is gone.
struct Connection {
    row: String,
    sandbox: Arc<dyn SandboxGate>,
    stdin: tokio::sync::Mutex<ChildStdin>,
    pending: Mutex<HashMap<RequestId, Waiter>>,
    /// The mode of each in-flight `tools/call`, so a `sandbox/assert*` question is judged under its call.
    modes: Mutex<HashMap<RequestId, SandboxMode>>,
    next_id: AtomicU64,
    /// `None` while the process is usable; the reason it stopped otherwise.
    closed: Mutex<Option<String>>,
}

impl Connection {
    async fn write_message(&self, message: Message) -> std::io::Result<()> {
        let line = protocol::encode_line(&message);
        let mut stdin = self.stdin.lock().await;
        stdin.write_all(line.as_bytes()).await?;
        stdin.flush().await
    }

    fn closed_reason(&self) -> Option<String> {
        self.closed.lock().unwrap().clone()
    }

    /// Mark the process gone, answer every pending request with why, and wake anything waiting.
    fn close(&self, reason: String) {
        {
            let mut closed = self.closed.lock().unwrap();
            if closed.is_some() {
                return;
            }
            *closed = Some(reason.clone());
        }
        let waiters: Vec<Waiter> = self
            .pending
            .lock()
            .unwrap()
            .drain()
            .map(|(_, waiter)| waiter)
            .collect();
        for waiter in waiters {
            let _ = waiter.send(Err(OutsideError::Exited {
                row: self.row.clone(),
                status: reason.clone(),
            }));
        }
        self.log(&format!("stopped: {reason}"));
    }

    fn exited_error(&self) -> Option<OutsideError> {
        self.closed_reason().map(|status| OutsideError::Exited {
            row: self.row.clone(),
            status,
        })
    }

    /// One request and its answer; `cancel` sends `$/cancelRequest` and stops waiting.
    async fn request_with_mode(
        &self,
        method: &str,
        params: serde_json::Value,
        cancel: Option<CancellationToken>,
        mode: Option<SandboxMode>,
    ) -> Result<serde_json::Value, OutsideError> {
        if let Some(error) = self.exited_error() {
            return Err(error);
        }
        let id = RequestId::Number(self.next_id.fetch_add(1, Ordering::SeqCst) as i64);
        let (sender, receiver) = oneshot::channel();
        self.pending.lock().unwrap().insert(id.clone(), sender);
        if let Some(mode) = mode {
            self.modes.lock().unwrap().insert(id.clone(), mode);
        }
        let message = Message::Request(Request {
            jsonrpc: JSONRPC.to_owned(),
            id: id.clone(),
            method: method.to_owned(),
            params,
        });
        if let Err(error) = self.write_message(message).await {
            self.pending.lock().unwrap().remove(&id);
            self.modes.lock().unwrap().remove(&id);
            self.close(error.to_string());
            return Err(OutsideError::Exited {
                row: self.row.clone(),
                status: error.to_string(),
            });
        }

        let response = match cancel {
            None => receiver.await,
            Some(token) => tokio::select! {
                response = receiver => response,
                () = token.cancelled() => {
                    self.pending.lock().unwrap().remove(&id);
                    self.modes.lock().unwrap().remove(&id);
                    let cancelled = Message::Notification(Notification {
                        jsonrpc: JSONRPC.to_owned(),
                        method: methods::CANCEL.to_owned(),
                        params: serde_json::json!({ "id": id }),
                    });
                    let _ = self.write_message(cancelled).await;
                    return Err(OutsideError::Cancelled { row: self.row.clone() });
                }
            },
        };
        self.modes.lock().unwrap().remove(&id);
        match response {
            Ok(result) => result,
            Err(_) => Err(OutsideError::Exited {
                row: self.row.clone(),
                status: "the connection closed".to_owned(),
            }),
        }
    }

    /// Answer one of the component's own requests: the sandbox back-channel, `log`, or nothing.
    async fn answer(
        &self,
        method: &str,
        params: &serde_json::Value,
    ) -> (Option<serde_json::Value>, Option<RpcError>) {
        match method {
            methods::SANDBOX_ASSERT_WRITABLE | methods::SANDBOX_ASSERT_READABLE => {
                let Ok(question) = serde_json::from_value::<SandboxAssertParams>(params.clone())
                else {
                    return (
                        None,
                        Some(rpc_error(
                            error_codes::INVALID_PARAMS,
                            "the sandbox question's params did not fit",
                        )),
                    );
                };
                let mode = question
                    .call
                    .as_ref()
                    .and_then(|id| self.modes.lock().unwrap().get(id).copied())
                    .unwrap_or_else(|| self.sandbox.default_mode());
                let outcome = if method == methods::SANDBOX_ASSERT_WRITABLE {
                    self.sandbox.assert_writable(&question.path, mode)
                } else {
                    self.sandbox.assert_readable(&question.path, mode)
                };
                match outcome {
                    Ok(path) => {
                        let result = SandboxAssertResult { path };
                        (serde_json::to_value(result).ok(), None)
                    }
                    Err(denial) => (
                        None,
                        Some(RpcError {
                            code: error_codes::SANDBOX_DENIED,
                            message: denial.message,
                            data: Some(serde_json::json!({
                                "code": "SANDBOX",
                                "path": denial.path,
                                "mode": denial.mode,
                            })),
                        }),
                    ),
                }
            }
            methods::LOG => {
                if let Ok(log) = serde_json::from_value::<LogParams>(params.clone()) {
                    self.log(&log.message);
                }
                (Some(serde_json::Value::Null), None)
            }
            other => (
                None,
                Some(rpc_error(
                    error_codes::METHOD_NOT_FOUND,
                    format!("no method named '{other}'"),
                )),
            ),
        }
    }

    fn log(&self, message: &str) {
        tracing::info!(target: "heddle_tools", "outside {}: {message}", self.row);
    }
}

fn rpc_error(code: i64, message: impl Into<String>) -> RpcError {
    RpcError {
        code,
        message: message.into(),
        data: None,
    }
}

/// Read the component's stdout line by line: answer its requests, resolve its responses, log it, and notice
/// when it is gone.
async fn read_stdout(connection: Arc<Connection>, stdout: ChildStdout) {
    let mut lines = BufReader::new(stdout).lines();
    loop {
        let line = match lines.next_line().await {
            Ok(Some(line)) => line,
            Ok(None) => break,
            Err(error) => {
                connection.log(&format!("stdout read failed: {error}"));
                break;
            }
        };
        if line.trim().is_empty() {
            continue;
        }
        match protocol::decode_line(&line) {
            Ok(Message::Response(response)) => {
                let waiter = connection.pending.lock().unwrap().remove(&response.id);
                match waiter {
                    Some(waiter) => {
                        let answer = match (response.result, response.error) {
                            (_, Some(error)) => Err(OutsideError::Rpc {
                                row: connection.row.clone(),
                                error: Box::new(error),
                            }),
                            (Some(result), None) => Ok(result),
                            (None, None) => Ok(serde_json::Value::Null),
                        };
                        let _ = waiter.send(answer);
                    }
                    None => connection.log(&format!(
                        "an answer to request {} arrived after it was dropped",
                        request_id(&response.id)
                    )),
                }
            }
            Ok(Message::Request(request)) => {
                let (result, error) = connection.answer(&request.method, &request.params).await;
                let response = Message::Response(Response {
                    jsonrpc: JSONRPC.to_owned(),
                    id: request.id,
                    result,
                    error,
                });
                if let Err(error) = connection.write_message(response).await {
                    connection.log(&format!("could not answer {}: {error}", request.method));
                }
            }
            Ok(Message::Notification(notification)) => match notification.method.as_str() {
                methods::LOG => {
                    if let Ok(log) = serde_json::from_value::<LogParams>(notification.params) {
                        connection.log(&log.message);
                    }
                }
                methods::EXIT => connection.close("the component asked to exit".to_owned()),
                _ => {}
            },
            Err(error) => connection.log(&format!("a line was not the protocol: {error}")),
        }
    }
    connection.close("the process closed its stdout".to_owned());
}

/// Log the component's stderr line by line; it is never parsed.
async fn log_stderr(connection: Arc<Connection>, stderr: ChildStderr) {
    let mut lines = BufReader::new(stderr).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        connection.log(&line);
    }
}

fn request_id(id: &RequestId) -> String {
    match id {
        RequestId::Number(number) => number.to_string(),
        RequestId::String(text) => text.clone(),
    }
}

/// A started outside component.
pub struct OutsideComponent {
    row: String,
    tools: Vec<ToolSpec>,
    listeners: Vec<serde_json::Value>,
    child: Mutex<Option<Child>>,
    connection: Arc<Connection>,
}

impl std::fmt::Debug for OutsideComponent {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OutsideComponent")
            .field("row", &self.row)
            .field(
                "tools",
                &self
                    .tools
                    .iter()
                    .map(|tool| tool.name.as_str())
                    .collect::<Vec<_>>(),
            )
            .finish_non_exhaustive()
    }
}

impl OutsideComponent {
    /// Spawn the process, send `initialize`, and read what it provides.
    ///
    /// `sandbox` answers the component's `sandbox/assert*` questions under the mode of the call each names.
    pub async fn start(
        spec: OutsideComponentSpec,
        sandbox: Arc<dyn SandboxGate>,
    ) -> Result<Self, OutsideError> {
        let row = spec.row.clone();
        let mut child = tokio::process::Command::new(&spec.program)
            .args(&spec.args)
            .current_dir(&spec.cwd)
            .envs(spec.env.iter().cloned())
            .env("HEDDLE_COMPONENT_PROTOCOL", PROTOCOL)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|error| OutsideError::Spawn {
                row: row.clone(),
                message: error.to_string(),
            })?;
        let missing_pipe = || OutsideError::Spawn {
            row: row.clone(),
            message: "the process has no stdio pipe".to_owned(),
        };
        let stdin = child.stdin.take().ok_or_else(missing_pipe)?;
        let stdout = child.stdout.take().ok_or_else(missing_pipe)?;
        let stderr = child.stderr.take().ok_or_else(missing_pipe)?;

        let connection = Arc::new(Connection {
            row: row.clone(),
            sandbox: Arc::clone(&sandbox),
            stdin: tokio::sync::Mutex::new(stdin),
            pending: Mutex::new(HashMap::new()),
            modes: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
            closed: Mutex::new(None),
        });
        tokio::spawn(read_stdout(Arc::clone(&connection), stdout));
        tokio::spawn(log_stderr(Arc::clone(&connection), stderr));

        let answered = tokio::time::timeout(
            spec.init_timeout,
            connection.request_with_mode(
                methods::INITIALIZE,
                serde_json::to_value(InitializeParams {
                    protocol: PROTOCOL.to_owned(),
                    row: row.clone(),
                    config: spec.config.clone(),
                    workspace_root: sandbox.workspace_root().to_path_buf(),
                    mode: sandbox.default_mode(),
                })
                .expect("initialize params always serialize"),
                None,
                None,
            ),
        )
        .await;
        let value = match answered {
            Err(_) => {
                let _ = child.start_kill();
                return Err(OutsideError::InitTimeout {
                    row,
                    seconds: spec.init_timeout.as_secs(),
                });
            }
            Ok(Err(error)) => {
                let _ = child.start_kill();
                return Err(error);
            }
            Ok(Ok(value)) => value,
        };
        let initialized: InitializeResult =
            serde_json::from_value(value).map_err(|error| OutsideError::Protocol {
                row: row.clone(),
                message: format!("initialize answered something else: {error}"),
            })?;

        Ok(Self {
            row,
            tools: initialized.tools.into_iter().map(ToolSpec::from).collect(),
            listeners: initialized.listeners,
            child: Mutex::new(Some(child)),
            connection,
        })
    }

    /// The configuration row this component came from.
    pub fn row(&self) -> &str {
        &self.row
    }

    /// The tool specs the component declared, as it declared them (not yet validated).
    pub fn specs(&self) -> &[ToolSpec] {
        &self.tools
    }

    /// The hook listeners the component declared — reserved for part 6, carried unread.
    pub fn listeners(&self) -> &[serde_json::Value] {
        &self.listeners
    }

    /// One [`ProcessTool`] per declared spec, each forwarding its calls over this connection.
    pub fn tools(&self) -> Vec<Arc<dyn Tool>> {
        self.tools
            .iter()
            .map(|spec| {
                Arc::new(ProcessTool {
                    spec: spec.clone(),
                    row: self.row.clone(),
                    connection: Arc::clone(&self.connection),
                }) as Arc<dyn Tool>
            })
            .collect()
    }

    /// Register every declared tool; the first refusal fails the whole component and is returned.
    pub fn register_into(&self, registry: &ToolRegistry) -> Result<usize, OutsideError> {
        let tools = self.tools();
        for tool in &tools {
            registry
                .register(Arc::clone(tool))
                .map_err(|source| OutsideError::Registration {
                    row: self.row.clone(),
                    source,
                })?;
        }
        Ok(tools.len())
    }

    /// Send one request and wait for its answer; `cancel` sends `$/cancelRequest` and stops waiting.
    ///
    /// Public so part 6 can send `hooks/call` over the same connection rather than a second process.
    pub async fn request(
        &self,
        method: &str,
        params: serde_json::Value,
        cancel: Option<CancellationToken>,
    ) -> Result<serde_json::Value, OutsideError> {
        self.connection
            .request_with_mode(method, params, cancel, None)
            .await
    }

    /// Send one notification: a message that expects no answer, such as an `emit` hook point (`session/event`)
    /// delivered to an outside listener over this connection.
    ///
    /// Fails, naming the row, when the process is gone or the line cannot be written.
    pub async fn notify(
        &self,
        method: &str,
        params: serde_json::Value,
    ) -> Result<(), OutsideError> {
        if let Some(error) = self.connection.exited_error() {
            return Err(error);
        }
        let message = Message::Notification(Notification {
            jsonrpc: JSONRPC.to_owned(),
            method: method.to_owned(),
            params,
        });
        if let Err(error) = self.connection.write_message(message).await {
            self.connection.close(error.to_string());
            return Err(OutsideError::Exited {
                row: self.row.clone(),
                status: error.to_string(),
            });
        }
        Ok(())
    }

    /// `shutdown`, then `exit`, then a kill after [`SHUTDOWN_GRACE`].
    pub async fn shutdown(&self) -> Result<(), OutsideError> {
        let _ = tokio::time::timeout(
            SHUTDOWN_GRACE,
            self.connection.request_with_mode(
                methods::SHUTDOWN,
                serde_json::Value::Null,
                None,
                None,
            ),
        )
        .await;
        let exit = Message::Notification(Notification {
            jsonrpc: JSONRPC.to_owned(),
            method: methods::EXIT.to_owned(),
            params: serde_json::Value::Null,
        });
        let _ = self.connection.write_message(exit).await;
        let child = self.child.lock().unwrap().take();
        let Some(mut child) = child else {
            return Ok(());
        };
        match tokio::time::timeout(SHUTDOWN_GRACE, child.wait()).await {
            Ok(Ok(_status)) => Ok(()),
            _ => {
                let _ = child.start_kill();
                let _ = child.wait().await;
                Ok(())
            }
        }
    }
}

/// A tool that lives in an outside component.
///
/// `run` sends `tools/call` with the call's resolved [`CallContext`](crate::protocol::CallContext) and reads
/// the answer as a `ToolResult`. An error answer whose `data.code` is `"SANDBOX"` becomes a `SANDBOX`
/// refusal; any other error, a dead process or a malformed answer becomes `TOOL_FAILED` naming the row.
pub struct ProcessTool {
    spec: ToolSpec,
    row: String,
    connection: Arc<Connection>,
}

impl Tool for ProcessTool {
    fn spec(&self) -> &ToolSpec {
        &self.spec
    }

    fn run<'a>(&'a self, args: ToolArgs, context: ToolRunContext) -> ToolFuture<'a> {
        Box::pin(async move {
            let params = ToolsCallParams {
                name: self.spec.name.clone(),
                args,
                context: CallContext {
                    cwd: context.cwd.clone(),
                    mode: context.mode(),
                    session: context.session.as_ref().map(|session| session.id.clone()),
                    workspace_root: self.connection.sandbox.workspace_root().to_path_buf(),
                },
            };
            let params = match serde_json::to_value(params) {
                Ok(params) => params,
                Err(error) => {
                    return Ok(ToolResult::refused(
                        codes::TOOL_FAILED,
                        format!(
                            "a call to outside component '{}' could not be encoded: {error}",
                            self.row
                        ),
                    ));
                }
            };
            match self
                .connection
                .request_with_mode(
                    methods::TOOLS_CALL,
                    params,
                    context.cancel.clone(),
                    Some(context.mode()),
                )
                .await
            {
                Ok(value) => match serde_json::from_value::<ToolResult>(value) {
                    Ok(result) => Ok(result),
                    Err(error) => Ok(ToolResult::refused(
                        codes::TOOL_FAILED,
                        format!(
                            "outside component '{}' answered a tool result this host cannot read: {error}",
                            self.row
                        ),
                    )),
                },
                Err(OutsideError::Rpc { row, error }) => {
                    if error
                        .data
                        .as_ref()
                        .and_then(|data| data.get("code"))
                        .and_then(serde_json::Value::as_str)
                        == Some("SANDBOX")
                    {
                        Ok(ToolResult::refused(codes::SANDBOX, error.message))
                    } else {
                        Ok(ToolResult::refused(
                            codes::TOOL_FAILED,
                            format!("outside component '{row}' answered with an error: {error}"),
                        ))
                    }
                }
                Err(OutsideError::Cancelled { row }) => Ok(ToolResult::refused(
                    codes::INTERRUPTED,
                    format!("the request to outside component '{row}' was cancelled"),
                )),
                Err(error) => Ok(ToolResult::refused(codes::TOOL_FAILED, error.to_string())),
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use std::io::{BufRead, Write};
    use std::path::{Path, PathBuf};

    use futures::future::BoxFuture;
    use serde_json::json;

    use super::*;
    use crate::gates::{DefaultModes, NoToolHooks};
    use crate::tool::ToolContext;
    use crate::upstream::{
        ApprovalDecision, ConfinedArgv, SandboxDenial, SandboxOutcome, SandboxUnavailable,
    };

    /// A sandbox double rooted at a fresh folder: relative paths are admitted there and an absolute path
    /// outside it is denied, which is what the back-channel test asks about.
    struct TestSandbox {
        root: PathBuf,
    }

    impl TestSandbox {
        fn new(root: PathBuf) -> Self {
            Self { root }
        }

        fn resolve(&self, path: &str) -> Result<PathBuf, SandboxDenial> {
            let resolved = self.root.join(path);
            if Path::new(path).is_absolute() && !resolved.starts_with(&self.root) {
                return Err(SandboxDenial {
                    message: format!("'{path}' is outside the workspace"),
                    path: PathBuf::from(path),
                    mode: SandboxMode::WorkspaceWrite,
                    workspace_root: self.root.clone(),
                });
            }
            Ok(resolved)
        }
    }

    impl SandboxGate for TestSandbox {
        fn workspace_root(&self) -> &Path {
            &self.root
        }
        fn default_mode(&self) -> SandboxMode {
            SandboxMode::WorkspaceWrite
        }
        fn escalation_targets(&self) -> Vec<SandboxMode> {
            Vec::new()
        }
        fn policy(&self, mode: SandboxMode) -> serde_json::Value {
            json!({ "mode": mode })
        }
        fn policy_statement(&self, mode: SandboxMode) -> String {
            format!("sandbox: {mode}")
        }
        fn assert_writable(&self, path: &str, _: SandboxMode) -> Result<PathBuf, SandboxDenial> {
            self.resolve(path)
        }
        fn assert_readable(&self, path: &str, _: SandboxMode) -> Result<PathBuf, SandboxDenial> {
            self.resolve(path)
        }
        fn confine(
            &self,
            _: &[String],
            mode: SandboxMode,
        ) -> Result<ConfinedArgv, SandboxUnavailable> {
            Err(SandboxUnavailable { mode, detail: None })
        }
        fn classify_outcome(&self, _: i32, _: &str, _: Option<&ConfinedArgv>) -> SandboxOutcome {
            SandboxOutcome::Exited
        }
    }

    struct AllowAll;

    impl crate::gates::ApprovalGate for AllowAll {
        fn check(&self, _: &str) -> ApprovalDecision {
            ApprovalDecision {
                allowed: true,
                mode: heddle_sandbox::ApprovalMode::Allow,
                reason: None,
            }
        }
        fn escalate<'a>(
            &'a self,
            request: crate::gates::EscalationRequest,
        ) -> BoxFuture<'a, Result<SandboxMode, crate::gates::EscalationError>> {
            Box::pin(async move { Ok(request.effective_mode) })
        }
    }

    fn registry(sandbox: Arc<dyn SandboxGate>) -> ToolRegistry {
        ToolRegistry::new(crate::gates::ToolGates {
            approvals: Arc::new(AllowAll),
            sandbox,
            modes: Arc::new(DefaultModes),
            hooks: Arc::new(NoToolHooks),
        })
    }

    fn workspace(label: &str) -> PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let n = NEXT.fetch_add(1, Ordering::SeqCst);
        let path =
            std::env::temp_dir().join(format!("heddle-outside-{label}-{}-{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    /// The component this test binary becomes when the parent starts it: a JSON-RPC peer on stdio.
    ///
    /// The parent re-executes this same test binary and filters to this test, so the protocol never needs a
    /// second program. Without the environment variable the test is a no-op.
    #[test]
    fn serves_as_an_outside_component() {
        let Ok(mode) = std::env::var("HEDDLE_TEST_COMPONENT") else {
            return;
        };
        let stdin = std::io::stdin();
        let mut lines = stdin.lock().lines();
        let mut stdout = std::io::stdout();
        let reply = |stdout: &mut std::io::Stdout, message: Message| {
            let _ = stdout.write_all(protocol::encode_line(&message).as_bytes());
            let _ = stdout.flush();
        };

        let mut notified = 0usize;
        while let Some(Ok(line)) = lines.next() {
            let request = match protocol::decode_line(&line) {
                Ok(Message::Request(request)) => request,
                Ok(Message::Notification(notification)) => {
                    if notification.method == methods::EXIT {
                        return;
                    }
                    notified += 1;
                    continue;
                }
                _ => continue,
            };
            match request.method.as_str() {
                methods::INITIALIZE => {
                    if mode == "silent" {
                        continue;
                    }
                    let tools = match mode.as_str() {
                        "blank" => json!([{ "name": "", "description": "" }]),
                        // `dead` declares a real tool and then exits: the row loads, then everything fails.
                        _ => json!([{
                            "name": "shout",
                            "description": "Write a shout file containing the text, uppercased.",
                            "parameters": { "type": "object", "properties": { "text": { "type": "string" } } }
                        }]),
                    };
                    reply(
                        &mut stdout,
                        Message::Response(Response {
                            jsonrpc: JSONRPC.to_owned(),
                            id: request.id,
                            result: Some(json!({ "tools": tools })),
                            error: None,
                        }),
                    );
                    if mode == "dead" {
                        std::process::exit(0);
                    }
                }
                methods::TOOLS_CALL => {
                    if mode == "slow" {
                        std::thread::sleep(Duration::from_secs(10));
                    }
                    if mode == "deny" {
                        // Ask the host's sandbox about a path it will refuse, then report that as the call.
                        let question = RequestId::String("s1".to_owned());
                        reply(
                            &mut stdout,
                            Message::Request(Request {
                                jsonrpc: JSONRPC.to_owned(),
                                id: question.clone(),
                                method: methods::SANDBOX_ASSERT_WRITABLE.to_owned(),
                                params: json!({ "path": "/etc/passwd", "call": request.id.clone() }),
                            }),
                        );
                        while let Some(Ok(line)) = lines.next() {
                            if let Ok(Message::Response(answer)) = protocol::decode_line(&line)
                                && answer.id == question
                            {
                                let error = answer.error.unwrap_or_else(|| {
                                    rpc_error(
                                        error_codes::INTERNAL_ERROR,
                                        "the host admitted the path",
                                    )
                                });
                                reply(
                                    &mut stdout,
                                    Message::Response(Response {
                                        jsonrpc: JSONRPC.to_owned(),
                                        id: request.id,
                                        result: None,
                                        error: Some(error),
                                    }),
                                );
                                break;
                            }
                        }
                        continue;
                    }
                    let output = if mode == "count" {
                        format!("notified: {notified}")
                    } else {
                        "wrote shout.txt".to_owned()
                    };
                    reply(
                        &mut stdout,
                        Message::Response(Response {
                            jsonrpc: JSONRPC.to_owned(),
                            id: request.id,
                            result: Some(json!({ "output": output })),
                            error: None,
                        }),
                    );
                }
                methods::SHUTDOWN => {
                    reply(
                        &mut stdout,
                        Message::Response(Response {
                            jsonrpc: JSONRPC.to_owned(),
                            id: request.id,
                            result: Some(serde_json::Value::Null),
                            error: None,
                        }),
                    );
                }
                methods::EXIT => return,
                _ => {}
            }
        }
    }

    fn component_args() -> Vec<String> {
        vec![
            "serves_as_an_outside_component".to_owned(),
            "--nocapture".to_owned(),
        ]
    }

    fn spec(mode: &str) -> OutsideComponentSpec {
        let mut spec = OutsideComponentSpec::new(
            "fixture",
            std::env::current_exe().expect("the test binary"),
            workspace("component"),
        );
        spec.args = component_args();
        spec.env = vec![("HEDDLE_TEST_COMPONENT".to_owned(), mode.to_owned())];
        spec.init_timeout = Duration::from_secs(10);
        spec
    }

    fn sandbox_at(root: PathBuf) -> Arc<dyn SandboxGate> {
        Arc::new(TestSandbox::new(root))
    }

    #[tokio::test]
    async fn a_component_registers_its_tools_and_answers_a_call() {
        let root = workspace("call");
        let component = OutsideComponent::start(spec("shout"), sandbox_at(root.clone()))
            .await
            .unwrap();
        assert_eq!(component.row(), "fixture");
        assert_eq!(component.specs().len(), 1);
        assert_eq!(component.specs()[0].name, "shout");

        let registry = registry(sandbox_at(root.clone()));
        assert_eq!(component.register_into(&registry).unwrap(), 1);
        assert_eq!(registry.names(), ["shout"]);
        let result = registry
            .call(
                "shout",
                json!({ "text": "from the plugin" })
                    .as_object()
                    .cloned()
                    .unwrap(),
                ToolContext::new(&root),
            )
            .await;
        assert_eq!(result.error, None);
        assert_eq!(result.output, "wrote shout.txt");
        component.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn a_blank_declared_spec_fails_the_whole_row() {
        let root = workspace("blank");
        let component = OutsideComponent::start(spec("blank"), sandbox_at(root.clone()))
            .await
            .unwrap();
        let registry = registry(sandbox_at(root));
        let error = component.register_into(&registry).unwrap_err();
        match error {
            OutsideError::Registration { row, source } => {
                assert_eq!(row, "fixture");
                assert_eq!(source, RegistrationError::MissingName);
            }
            other => panic!("expected a registration refusal, got {other}"),
        }
        assert!(registry.names().is_empty());
        let _ = component.shutdown().await;
    }

    #[tokio::test]
    async fn a_dead_process_fails_its_calls_rather_than_hanging() {
        let root = workspace("dead");
        let component = OutsideComponent::start(spec("dead"), sandbox_at(root.clone()))
            .await
            .unwrap();
        // The component exited after initialize; the close is noticed by the reader task.
        tokio::time::sleep(Duration::from_millis(200)).await;
        let tools = component.tools();
        let result = tools[0]
            .run(
                ToolArgs::new(),
                ToolRunContext::new(ToolContext::new(&root), SandboxMode::WorkspaceWrite),
            )
            .await
            .unwrap();
        assert_eq!(result.error.as_ref().unwrap().code, codes::TOOL_FAILED);
        assert!(result.error.unwrap().message.contains("fixture"));
        let _ = component.shutdown().await;
    }

    #[tokio::test]
    async fn a_back_channel_denial_becomes_the_sandbox_refusal() {
        let root = workspace("deny");
        let component = OutsideComponent::start(spec("deny"), sandbox_at(root.clone()))
            .await
            .unwrap();
        let tools = component.tools();
        let result = tools[0]
            .run(
                ToolArgs::new(),
                ToolRunContext::new(ToolContext::new(&root), SandboxMode::WorkspaceWrite),
            )
            .await
            .unwrap();
        assert_eq!(result.error.as_ref().unwrap().code, codes::SANDBOX);
        assert!(
            result
                .error
                .as_ref()
                .unwrap()
                .message
                .contains("outside the workspace"),
            "{:?}",
            result.error
        );
        let _ = component.shutdown().await;
    }

    #[tokio::test]
    async fn a_cancelled_call_stops_waiting_and_reports_interrupted() {
        let root = workspace("cancel");
        let component = OutsideComponent::start(spec("slow"), sandbox_at(root.clone()))
            .await
            .unwrap();
        let token = CancellationToken::new();
        let tools = component.tools();
        let run = tools[0].run(
            ToolArgs::new(),
            ToolRunContext::new(
                ToolContext::new(&root).with_cancel(token.clone()),
                SandboxMode::WorkspaceWrite,
            ),
        );
        let stopper = async move {
            tokio::time::sleep(Duration::from_millis(150)).await;
            token.cancel();
        };
        let started = std::time::Instant::now();
        let (result, ()) = tokio::join!(run, stopper);
        assert_eq!(result.unwrap().error.unwrap().code, codes::INTERRUPTED);
        assert!(started.elapsed() < Duration::from_secs(3));
        let _ = component.shutdown().await;
    }

    #[tokio::test]
    async fn a_component_that_never_answers_initialize_fails_the_row() {
        let mut spec = spec("silent");
        spec.init_timeout = Duration::from_millis(300);
        let error = OutsideComponent::start(spec, sandbox_at(workspace("silent")))
            .await
            .unwrap_err();
        match error {
            OutsideError::InitTimeout { row, .. } => assert_eq!(row, "fixture"),
            other => panic!("expected an initialize timeout, got {other}"),
        }
    }

    #[tokio::test]
    async fn a_notification_reaches_the_component_and_expects_no_answer() {
        let root = workspace("notify");
        let component = OutsideComponent::start(spec("count"), sandbox_at(root.clone()))
            .await
            .unwrap();
        component
            .notify(
                "hooks/call",
                json!({ "point": "session/event", "mode": "emit" }),
            )
            .await
            .unwrap();
        component
            .notify(
                "hooks/call",
                json!({ "point": "session/event", "mode": "emit" }),
            )
            .await
            .unwrap();
        // A request after the notifications is answered after them: the component read both lines first.
        let tools = component.tools();
        let result = tools[0]
            .run(
                ToolArgs::new(),
                ToolRunContext::new(ToolContext::new(&root), SandboxMode::WorkspaceWrite),
            )
            .await
            .unwrap();
        assert_eq!(result.output, "notified: 2");
        component.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn a_notification_to_a_dead_process_fails_naming_the_row() {
        let root = workspace("notify-dead");
        let component = OutsideComponent::start(spec("dead"), sandbox_at(root.clone()))
            .await
            .unwrap();
        tokio::time::sleep(Duration::from_millis(200)).await;
        let error = component.notify("hooks/call", json!({})).await.unwrap_err();
        assert!(error.to_string().contains("fixture"), "{error}");
    }
}
