//! Outside tools as processes: start a declared component, register its tools, forward their calls.
//!
//! The Rust shape of the TypeScript build's out-of-repository plugin (`_verifiers_/40-pluggable-tools`,
//! "a tool written outside this repository can be plugged in and used"). The configuration crate resolves
//! a row that names an outside component into an [`OutsideComponentSpec`]; the binary starts it, and every
//! tool it declares lands in the [`ToolRegistry`] through the same [`ToolRegistry::register`] rule as a
//! built-in — so a blank name fails the row, a name already taken displaces the earlier tool, and the allow
//! list judges it like any other. The wire is [`crate::protocol`].

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use tokio_util::sync::CancellationToken;

use crate::gates::SandboxGate;
use crate::protocol::RpcError;
use crate::registry::{RegistrationError, ToolRegistry};
use crate::tool::{Tool, ToolArgs, ToolFuture, ToolRunContext};
use crate::upstream::ToolSpec;

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
    #[error("outside component '{row}' answered with an error: {error}")]
    Rpc {
        /// The row.
        row: String,
        /// Its error.
        error: RpcError,
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

/// The live connection to one component process. Private: its fields (the child, the line writer, the table
/// of pending requests, the modes of in-flight calls for the sandbox back-channel) land with the port.
struct Connection {
    _private: (),
}

/// A started outside component.
pub struct OutsideComponent {
    row: String,
    tools: Vec<ToolSpec>,
    listeners: Vec<serde_json::Value>,
    #[expect(dead_code, reason = "read once the connection is ported")]
    connection: Arc<Connection>,
}

impl OutsideComponent {
    /// Spawn the process, send `initialize`, and read what it provides.
    ///
    /// `sandbox` answers the component's `sandbox/assert*` questions under the mode of the call each names.
    pub async fn start(
        spec: OutsideComponentSpec,
        sandbox: Arc<dyn SandboxGate>,
    ) -> Result<Self, OutsideError> {
        todo!("spawn, initialize with a timeout, start the line reader")
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
        todo!("one ProcessTool per spec")
    }

    /// Register every declared tool; the first refusal fails the whole component and is returned.
    pub fn register_into(&self, registry: &ToolRegistry) -> Result<usize, OutsideError> {
        todo!("register each ProcessTool, mapping a refusal to OutsideError::Registration")
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
        todo!("number the request, write its line, await the matching response")
    }

    /// `shutdown`, then `exit`, then a kill after [`SHUTDOWN_GRACE`].
    pub async fn shutdown(&self) -> Result<(), OutsideError> {
        todo!("graceful stop, then kill")
    }
}

/// A tool that lives in an outside component.
///
/// `run` sends `tools/call` with the call's resolved [`CallContext`](crate::protocol::CallContext) and reads
/// the answer as a `ToolResult`. An error answer whose `data.code` is `"SANDBOX"` becomes a `SANDBOX`
/// refusal; any other error, a dead process or a malformed answer becomes `TOOL_FAILED` naming the row.
pub struct ProcessTool {
    spec: ToolSpec,
    #[expect(dead_code, reason = "read once the forwarding is ported")]
    row: String,
    #[expect(dead_code, reason = "read once the forwarding is ported")]
    connection: Arc<Connection>,
}

impl Tool for ProcessTool {
    fn spec(&self) -> &ToolSpec {
        &self.spec
    }

    fn run<'a>(&'a self, args: ToolArgs, context: ToolRunContext) -> ToolFuture<'a> {
        todo!("forward as tools/call over the connection")
    }
}
