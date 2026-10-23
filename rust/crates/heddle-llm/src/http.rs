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
    headers
        .iter()
        .map(|(name, value)| {
            let mut titled = String::with_capacity(name.len());
            let mut boundary = true;
            for letter in name.chars() {
                if boundary {
                    titled.extend(letter.to_uppercase());
                } else {
                    titled.push(letter);
                }
                boundary = letter == '-';
            }
            (titled, value.clone())
        })
        .collect()
}

/// Whether a body says the request did not fit the model's window. The provider wordings differ, so the matching
/// happens once, here, and everything above reads the code.
fn says_context_too_long(body: &str) -> bool {
    let body = body.to_lowercase();
    const PHRASES: [&str; 6] = [
        "context_length_exceeded",
        "context length exceeded",
        "maximum context length",
        "context window",
        "too many tokens",
        "reduce the length of the messages",
    ];
    if PHRASES.iter().any(|phrase| body.contains(phrase)) {
        return true;
    }
    let mut rest = body.as_str();
    while let Some(at) = rest.find("exceeds the ") {
        let tail = &rest[at + "exceeds the ".len()..];
        let tail = tail
            .strip_prefix("model's ")
            .or_else(|| tail.strip_prefix("models "))
            .unwrap_or(tail);
        let tail = tail.strip_prefix("maximum ").unwrap_or(tail);
        if tail.starts_with("context") {
            return true;
        }
        rest = &rest[at + 1..];
    }
    false
}

/// The code one failed response deserves (`failureCode`): `CONTEXT_WINDOW_EXCEEDED` for a `400`, `413` or `422`
/// whose body says the request did not fit (OpenAI's `context_length_exceeded`, "maximum context length",
/// "context window", "too many tokens", "reduce the length of the messages", "exceeds the model's context"),
/// otherwise `HTTP`. Case-insensitive.
pub fn failure_code(status: u16, body: &str) -> &'static str {
    if matches!(status, 400 | 413 | 422) && says_context_too_long(body) {
        crate::error::CONTEXT_WINDOW_EXCEEDED
    } else {
        crate::error::code::HTTP
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::CONTEXT_WINDOW_EXCEEDED;

    fn headers(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs
            .iter()
            .map(|(name, value)| ((*name).to_string(), (*value).to_string()))
            .collect()
    }

    #[test]
    fn header_names_go_out_in_title_case_with_their_values_and_order_kept() {
        assert_eq!(
            title_case_headers(&headers(&[
                ("content-type", "application/json"),
                ("content-length", "3"),
                ("x-api-version", "2024-01-01"),
            ])),
            headers(&[
                ("Content-Type", "application/json"),
                ("Content-Length", "3"),
                ("X-Api-Version", "2024-01-01"),
            ])
        );
        // Names that are already titled are unchanged, and an odd name keeps what it has.
        assert_eq!(
            title_case_headers(&headers(&[("Authorization", "Bearer x"), ("x-", "y")])),
            headers(&[("Authorization", "Bearer x"), ("X-", "y")])
        );
        assert_eq!(title_case_headers(&[]), Vec::new());
    }

    #[test]
    fn a_window_refusal_is_recognised_by_the_code_the_harness_recovers_on() {
        assert_eq!(
            failure_code(400, r#"{"error":{"code":"context_length_exceeded"}}"#),
            CONTEXT_WINDOW_EXCEEDED
        );
        assert_eq!(
            failure_code(400, "This model's maximum context length is 8192 tokens"),
            CONTEXT_WINDOW_EXCEEDED
        );
        assert_eq!(
            failure_code(413, "the request would exceed the context window"),
            CONTEXT_WINDOW_EXCEEDED
        );
        assert_eq!(
            failure_code(422, "Please reduce the length of the messages"),
            CONTEXT_WINDOW_EXCEEDED
        );
        assert_eq!(
            failure_code(400, "too many tokens in the request"),
            CONTEXT_WINDOW_EXCEEDED
        );
        assert_eq!(
            failure_code(400, "request exceeds the model's context limit"),
            CONTEXT_WINDOW_EXCEEDED
        );
        // Case does not matter.
        assert_eq!(
            failure_code(400, "CONTEXT_LENGTH_EXCEEDED"),
            CONTEXT_WINDOW_EXCEEDED
        );
    }

    #[test]
    fn every_other_failure_is_an_http_failure() {
        assert_eq!(failure_code(400, "bad request"), "HTTP");
        assert_eq!(
            failure_code(401, "context window"),
            "HTTP",
            "the status decides too"
        );
        assert_eq!(failure_code(500, "context window"), "HTTP");
        assert_eq!(failure_code(503, ""), "HTTP");
        // A phrase that is not the window refusal stays HTTP.
        assert_eq!(
            failure_code(400, "the tool exceeded its output budget"),
            "HTTP"
        );
    }
}
