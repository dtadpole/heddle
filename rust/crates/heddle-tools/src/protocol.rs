//! The outside-component protocol: line-delimited JSON-RPC 2.0 on a child process's stdio.
//!
//! This is the Rust shape of part 4 (`rust/ULTIMATE_GOAL.md`): the TypeScript build loads an outside tool
//! as a module from a layer file; the Rust binary runs it as a **process declared in configuration** and
//! speaks this protocol to it. Part 6 reuses the same connection for an outside hook listener, so the
//! framing and lifecycle here are generic and the tool methods are one family among them. The full
//! statement, with a worked exchange, is [`PROTOCOL.md`](../PROTOCOL.md); this module is its types.
//!
//! - **Framing**: one JSON-RPC 2.0 message per line, UTF-8, `\n`-terminated, on the child's stdin
//!   (host → component) and stdout (component → host). stderr is free text the host logs line by line.
//! - **Lifecycle**: the host sends [`methods::INITIALIZE`]; the component answers with the tools it provides
//!   (and, for part 6, the listeners); the host registers them; calls follow; [`methods::SHUTDOWN`] then
//!   [`methods::EXIT`] end it.
//! - **Calls**: [`methods::TOOLS_CALL`] carries the arguments and the call's resolved context; the answer is a
//!   [`ToolResult`](crate::ToolResult) in its JSON shape.
//! - **Back-channel**: while a call runs, the component may ask the host's sandbox about a path under that
//!   call's mode ([`methods::SANDBOX_ASSERT_WRITABLE`], [`methods::SANDBOX_ASSERT_READABLE`]) and send
//!   [`methods::LOG`] lines — what an in-process TypeScript plugin did through `ctx.sandbox` and `ctx.logger`.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::tool::ToolArgs;
use crate::upstream::{SandboxMode, ToolSpec};

/// The protocol name and version the host sends in `initialize` and in `HEDDLE_COMPONENT_PROTOCOL`.
pub const PROTOCOL: &str = "heddle-component/1";

/// The JSON-RPC version every message carries.
pub const JSONRPC: &str = "2.0";

/// The method names. Host → component unless marked otherwise.
pub mod methods {
    /// Request: the first message; answered with [`InitializeResult`](super::InitializeResult).
    pub const INITIALIZE: &str = "initialize";
    /// Request: run one tool call; answered with a `ToolResult`.
    pub const TOOLS_CALL: &str = "tools/call";
    /// Notification: stop the request named by `id` (LSP's spelling).
    pub const CANCEL: &str = "$/cancelRequest";
    /// Request: finish in-flight work; answered with `null`.
    pub const SHUTDOWN: &str = "shutdown";
    /// Notification: exit now.
    pub const EXIT: &str = "exit";
    /// Request, component → host: resolve a path for writing under a call's mode.
    pub const SANDBOX_ASSERT_WRITABLE: &str = "sandbox/assertWritable";
    /// Request, component → host: resolve a path for reading under a call's mode.
    pub const SANDBOX_ASSERT_READABLE: &str = "sandbox/assertReadable";
    /// Notification, component → host: one log line.
    pub const LOG: &str = "log";
    /// Request: deliver one hook event to an outside listener. Reserved for part 6 (`heddle-events`), which
    /// defines its params and result per hook mode.
    pub const HOOKS_CALL: &str = "hooks/call";
}

/// The error codes this protocol uses: JSON-RPC's own, plus two of its own.
pub mod error_codes {
    /// The line was not JSON.
    pub const PARSE_ERROR: i64 = -32700;
    /// The JSON was not a JSON-RPC message.
    pub const INVALID_REQUEST: i64 = -32600;
    /// No such method.
    pub const METHOD_NOT_FOUND: i64 = -32601;
    /// The params did not fit the method.
    pub const INVALID_PARAMS: i64 = -32602;
    /// The answering side failed.
    pub const INTERNAL_ERROR: i64 = -32603;
    /// The sandbox refused a path; `data` is `{ "code": "SANDBOX", "path", "mode" }`.
    pub const SANDBOX_DENIED: i64 = -32001;
    /// The request was cancelled (LSP's code).
    pub const REQUEST_CANCELLED: i64 = -32800;
}

/// A request id. The host numbers its own requests; a component may use numbers or strings for its own.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(untagged)]
pub enum RequestId {
    /// A numeric id.
    Number(i64),
    /// A string id.
    String(String),
}

/// A message that expects an answer.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Request {
    /// Always [`JSONRPC`].
    pub jsonrpc: String,
    /// Echoed by the answer.
    pub id: RequestId,
    /// One of [`methods`].
    pub method: String,
    /// The method's params; `null` when it takes none.
    #[serde(default)]
    pub params: serde_json::Value,
}

/// A message that expects no answer.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Notification {
    /// Always [`JSONRPC`].
    pub jsonrpc: String,
    /// One of [`methods`].
    pub method: String,
    /// The method's params.
    #[serde(default)]
    pub params: serde_json::Value,
}

/// An error answer.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, thiserror::Error)]
#[error("{message} ({code})")]
pub struct RpcError {
    /// One of [`error_codes`], or the component's own.
    pub code: i64,
    /// The sentence.
    pub message: String,
    /// Structured detail.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
}

/// The answer to a [`Request`]: exactly one of `result` and `error`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Response {
    /// Always [`JSONRPC`].
    pub jsonrpc: String,
    /// The request's id.
    pub id: RequestId,
    /// The answer, when it succeeded.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<serde_json::Value>,
    /// The failure, when it did not.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<RpcError>,
}

/// Any one line of the protocol.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(untagged)]
pub enum Message {
    /// Expects an answer.
    Request(Request),
    /// Expects none.
    Notification(Notification),
    /// Answers a request.
    Response(Response),
}

/// A line that is not a protocol message.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ProtocolError {
    /// Not JSON.
    #[error("not JSON: {0}")]
    Parse(String),
    /// JSON, but not a JSON-RPC 2.0 message.
    #[error("not a JSON-RPC 2.0 message: {0}")]
    Invalid(String),
}

/// Encode one message as one line, `\n` included. JSON escapes every newline inside a string, so the line
/// never contains a raw one.
pub fn encode_line(message: &Message) -> String {
    let mut line = serde_json::to_string(message).expect("a protocol message always serializes");
    line.push('\n');
    line
}

/// Decode one line (with or without its `\n`).
///
/// A line with `method` and `id` is a request, `method` alone a notification, `id` with `result` or `error`
/// a response; `jsonrpc` must be `"2.0"`.
pub fn decode_line(line: &str) -> Result<Message, ProtocolError> {
    let value: serde_json::Value = serde_json::from_str(line.trim_end_matches(['\n', '\r']))
        .map_err(|error| ProtocolError::Parse(error.to_string()))?;
    let object = value
        .as_object()
        .ok_or_else(|| ProtocolError::Invalid("not an object".into()))?;
    if object.get("jsonrpc").and_then(serde_json::Value::as_str) != Some(JSONRPC) {
        return Err(ProtocolError::Invalid("jsonrpc must be \"2.0\"".into()));
    }
    let invalid = |error: serde_json::Error| ProtocolError::Invalid(error.to_string());
    match (object.contains_key("method"), object.contains_key("id")) {
        (true, true) => serde_json::from_value(value)
            .map(Message::Request)
            .map_err(invalid),
        (true, false) => serde_json::from_value(value)
            .map(Message::Notification)
            .map_err(invalid),
        (false, true) if object.contains_key("result") || object.contains_key("error") => {
            serde_json::from_value(value)
                .map(Message::Response)
                .map_err(invalid)
        }
        _ => Err(ProtocolError::Invalid(
            "neither a request, a notification nor a response".into(),
        )),
    }
}

/// `initialize` params.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InitializeParams {
    /// [`PROTOCOL`].
    pub protocol: String,
    /// The configuration row's id, so the component can name itself in a log line.
    pub row: String,
    /// The row's `config` object, passed through unread.
    pub config: serde_json::Value,
    /// The sandbox's workspace root.
    pub workspace_root: PathBuf,
    /// The deployment's mode.
    pub mode: SandboxMode,
}

/// `initialize` result: what the component provides.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct InitializeResult {
    /// The tools, each registered through the same rule as a built-in (non-blank name and description).
    #[serde(default)]
    pub tools: Vec<ToolSpec>,
    /// The hook listeners. Reserved for part 6 (`heddle-events`), which defines the entry shape; carried
    /// unread by this crate.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub listeners: Vec<serde_json::Value>,
}

/// The resolved context a `tools/call` runs in.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CallContext {
    /// Where the effect lands.
    pub cwd: PathBuf,
    /// The mode this call was resolved under; sandbox questions sent with this call's id are judged under it.
    pub mode: SandboxMode,
    /// The session id, when the call has one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session: Option<String>,
    /// The sandbox's workspace root.
    pub workspace_root: PathBuf,
}

/// `tools/call` params. The result is a `ToolResult` (`{ output, error?, data? }`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolsCallParams {
    /// Which of the component's tools.
    pub name: String,
    /// The arguments as the model wrote them.
    pub args: ToolArgs,
    /// The call's resolved context.
    pub context: CallContext,
}

/// `$/cancelRequest` params.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CancelParams {
    /// The request to stop.
    pub id: RequestId,
}

/// `sandbox/assertWritable` and `sandbox/assertReadable` params.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SandboxAssertParams {
    /// The path, relative to the workspace or absolute.
    pub path: String,
    /// The `tools/call` this question is part of, whose mode it is judged under; the deployment mode when
    /// absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub call: Option<RequestId>,
}

/// The answer to a sandbox question that was admitted. A refusal is an [`RpcError`] with
/// [`error_codes::SANDBOX_DENIED`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SandboxAssertResult {
    /// The resolved absolute path.
    pub path: PathBuf,
}

/// `log` params.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LogParams {
    /// The line; never a secret.
    pub message: String,
    /// The call it belongs to, if any.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub call: Option<RequestId>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_request_round_trips_through_one_line() {
        let request = Message::Request(Request {
            jsonrpc: JSONRPC.into(),
            id: RequestId::Number(7),
            method: methods::TOOLS_CALL.into(),
            params: serde_json::json!({ "name": "shout", "args": { "text": "a\nb" } }),
        });
        let line = encode_line(&request);
        assert!(line.ends_with('\n'));
        assert_eq!(
            line.matches('\n').count(),
            1,
            "the embedded newline is escaped"
        );
        assert_eq!(decode_line(&line).unwrap(), request);
    }

    #[test]
    fn lines_are_told_apart_by_their_fields() {
        let notification =
            decode_line(r#"{"jsonrpc":"2.0","method":"log","params":{"message":"hi"}}"#).unwrap();
        assert!(matches!(notification, Message::Notification(ref n) if n.method == "log"));
        let response = decode_line(r#"{"jsonrpc":"2.0","id":"a","result":null}"#).unwrap();
        assert!(
            matches!(response, Message::Response(ref r) if r.id == RequestId::String("a".into()))
        );
        let error =
            decode_line(r#"{"jsonrpc":"2.0","id":1,"error":{"code":-32001,"message":"outside"}}"#)
                .unwrap();
        assert!(
            matches!(error, Message::Response(ref r) if r.error.as_ref().unwrap().code == error_codes::SANDBOX_DENIED)
        );
    }

    #[test]
    fn a_line_that_is_not_the_protocol_is_refused_with_its_reason() {
        assert!(matches!(
            decode_line("not json"),
            Err(ProtocolError::Parse(_))
        ));
        assert!(matches!(
            decode_line(r#"{"id":1,"result":1}"#),
            Err(ProtocolError::Invalid(_))
        ));
        assert!(matches!(
            decode_line(r#"{"jsonrpc":"2.0","id":1}"#),
            Err(ProtocolError::Invalid(_))
        ));
        assert!(matches!(decode_line("[1]"), Err(ProtocolError::Invalid(_))));
    }

    #[test]
    fn an_initialize_result_without_listeners_reads_and_writes_without_them() {
        let text = r#"{"tools":[{"name":"shout","description":"Shout.","parameters":{}}]}"#;
        let result: InitializeResult = serde_json::from_str(text).unwrap();
        assert_eq!(result.tools[0].name, "shout");
        assert!(result.listeners.is_empty());
        assert_eq!(serde_json::to_string(&result).unwrap(), text);
    }

    #[test]
    fn the_call_context_is_camel_case_on_the_wire() {
        let context = CallContext {
            cwd: "/w".into(),
            mode: SandboxMode::WorkspaceWrite,
            session: None,
            workspace_root: "/w".into(),
        };
        assert_eq!(
            serde_json::to_string(&context).unwrap(),
            r#"{"cwd":"/w","mode":"workspace-write","workspaceRoot":"/w"}"#
        );
    }
}
