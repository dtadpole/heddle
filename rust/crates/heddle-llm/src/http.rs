//! The one HTTP client every adapter and the model-list reader share.
//!
//! Ported from `src/llm/http.ts`, on `reqwest` (rustls). What carries over, each measured on the TypeScript side:
//!
//! - **Header names go out in Title-Case** (`Content-Type`, `Content-Length`): a local signing proxy forwards a
//!   duplicate `Content-Length` when the caller's copy is not Title-Case, and Cloudflare answers that with a bare
//!   `400`. The client is built with `http1_title_case_headers`, and [`title_case_headers`] normalises configured
//!   names so a configured header and a default one cannot both be sent.
//! - **A plain product `User-Agent`** ([`USER_AGENT`]): Cloudflare's integrity check answers `403` to an absent or
//!   synthetic one.
//! - **What the answer is decides how it is read**, not what was asked for: `text/event-stream` is a stream; an
//!   unlabelled answer to a streaming request is a stream unless its first bytes open a JSON object, and that first
//!   read is replayed so a stream is at most one read behind.
//! - **A forwarding proxy** is `http:` only, to an `http:` target, sent in the proxy's absolute form; anything else
//!   is refused with `PROXY` by name rather than connecting somewhere nobody asked for.
//! - **A non-2xx answer** is a [`ModelError`] carrying the status and the first 400 characters of the body, coded
//!   by [`failure_code`].

use std::pin::Pin;

use bytes::Bytes;
use futures::Stream;

use crate::error::ModelError;

/// A response body as it arrives.
pub type ByteStream = Pin<Box<dyn Stream<Item = Result<Bytes, ModelError>> + Send + 'static>>;

/// Socket inactivity, in milliseconds, before a request is abandoned with `TIMEOUT`.
pub const DEFAULT_TIMEOUT_MS: u64 = 120_000;

/// The user agent every request carries.
pub const USER_AGENT: &str = "heddle/0.0.1";

/// The method of one request.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Method {
    #[default]
    Post,
    Get,
}

/// What one call needs to say.
#[derive(Debug, Clone, Default)]
pub struct WireRequest {
    pub url: String,
    pub method: Method,
    /// Sent as JSON when present.
    pub body: Option<serde_json::Value>,
    /// Extra headers, merged over the defaults after Title-Casing.
    pub headers: Vec<(String, String)>,
    /// Sent as `Authorization: Bearer …` when present.
    pub api_key: Option<String>,
    /// Ask for an event stream (`Accept: text/event-stream`).
    pub stream: bool,
    /// Socket inactivity before abandoning; [`DEFAULT_TIMEOUT_MS`] when absent.
    pub timeout_ms: Option<u64>,
    /// The endpoint's name, for the error a person reads.
    pub endpoint: String,
    /// An `http:` forwarding proxy, as a URL.
    pub proxy: Option<String>,
}

/// One response: a buffered JSON body (`null` for an empty one), or a streamed body with its status.
pub enum WireResponse {
    Json(serde_json::Value),
    Stream { body: ByteStream, status: u16 },
}

impl std::fmt::Debug for WireResponse {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Json(value) => f.debug_tuple("Json").field(value).finish(),
            Self::Stream { status, .. } => f
                .debug_struct("Stream")
                .field("status", status)
                .finish_non_exhaustive(),
        }
    }
}

/// Send one request and resolve with its response, buffered or streamed (`wire`).
///
/// Errors: `TRANSPORT` (could not send), `TIMEOUT` (socket idle), `PROXY` (refused proxy form), `HTTP` or
/// `CONTEXT_WINDOW_EXCEEDED` (non-2xx), `BAD_BODY` (a JSON answer that is not JSON).
pub async fn wire(request: WireRequest) -> Result<WireResponse, ModelError> {
    let _ = request;
    todo!("port wire on reqwest")
}

/// Header names in Title-Case (`titleCaseHeaders`): each letter after the start or a `-` is upper-cased; values and
/// order are kept.
pub fn title_case_headers(headers: &[(String, String)]) -> Vec<(String, String)> {
    let _ = headers;
    todo!("port titleCaseHeaders")
}

/// The code one failed response deserves (`failureCode`): `CONTEXT_WINDOW_EXCEEDED` for a `400`, `413` or `422`
/// whose body says the request did not fit (OpenAI's `context_length_exceeded`, "maximum context length",
/// "context window", "too many tokens", "reduce the length of the messages", "exceeds the model's context"),
/// otherwise `HTTP`. Case-insensitive.
pub fn failure_code(status: u16, body: &str) -> &'static str {
    let _ = (status, body);
    todo!("port failureCode")
}
