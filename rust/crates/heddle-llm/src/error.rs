//! The one failure every model call reports: [`ModelError`], with the endpoint, a code and the HTTP status.
//!
//! Ported from `ModelError` and `CONTEXT_WINDOW_EXCEEDED` in `src/llm/types.ts`. The code is a **string**, not an
//! enum, because a scripted step may fail a call with any code a check wants to exercise; the codes this crate
//! itself produces are the constants in [`code`].

use std::error::Error;
use std::fmt;

/// The codes this crate produces. A consumer compares [`ModelError::code`] against these.
pub mod code {
    /// A request named an endpoint the service does not hold.
    pub const NO_ENDPOINT: &str = "NO_ENDPOINT";
    /// The provider refused the request because it did not fit the window — the one HTTP failure the harness
    /// recovers from (the loop offers it on `agent/request-error`, compaction answers with a reduction and a retry).
    pub const CONTEXT_WINDOW_EXCEEDED: &str = "CONTEXT_WINDOW_EXCEEDED";
    /// Any other non-2xx answer.
    pub const HTTP: &str = "HTTP";
    /// The socket was idle past the endpoint's `timeoutMs`.
    pub const TIMEOUT: &str = "TIMEOUT";
    /// The request could not be sent or its body could not be read.
    pub const TRANSPORT: &str = "TRANSPORT";
    /// A proxy configuration the client refuses: an `https` proxy, or an `https` target behind a proxy.
    pub const PROXY: &str = "PROXY";
    /// The provider answered with a body that is not what the route promises.
    pub const BAD_BODY: &str = "BAD_BODY";
    /// The provider reported a failure inside its event stream.
    pub const REMOTE: &str = "REMOTE";
    /// The scripted endpoint's file could not be read, or a step failed the call without naming a code.
    pub const SCRIPT: &str = "SCRIPT";
    /// The call was abandoned by its caller.
    pub const ABORTED: &str = "ABORTED";
    /// An endpoint `kind` no adapter speaks.
    pub const UNKNOWN_KIND: &str = "UNKNOWN_KIND";
    /// A publisher route without its cloud project.
    pub const NO_PROJECT: &str = "NO_PROJECT";
    /// A publisher route without its region.
    pub const NO_REGION: &str = "NO_REGION";
    /// A publisher route whose request and endpoint name no model.
    pub const NO_MODEL: &str = "NO_MODEL";
    /// A request named a reasoning level the model does not declare.
    pub const UNSUPPORTED_REASONING_EFFORT: &str = "UNSUPPORTED_REASONING_EFFORT";
}

pub use code::CONTEXT_WINDOW_EXCEEDED;

/// A failed model call, with what a person needs to diagnose it.
///
/// `message` is the whole sentence a person reads (it names the endpoint and, for an HTTP failure, the status and
/// an excerpt of the body); `Display` prints exactly it. A credential never appears in it.
#[derive(Debug)]
pub struct ModelError {
    /// The sentence a person reads.
    pub message: String,
    /// The endpoint the call was addressed to.
    pub endpoint: String,
    /// One of [`code`], or whatever a scripted step named.
    pub code: String,
    /// The HTTP status, when the provider answered with one.
    pub status: Option<u16>,
    source: Option<Box<dyn Error + Send + Sync + 'static>>,
}

impl ModelError {
    /// A failure with no status and no cause.
    pub fn new(
        message: impl Into<String>,
        endpoint: impl Into<String>,
        code: impl Into<String>,
    ) -> Self {
        Self {
            message: message.into(),
            endpoint: endpoint.into(),
            code: code.into(),
            status: None,
            source: None,
        }
    }

    /// The same failure, carrying the HTTP status the provider answered with.
    #[must_use]
    pub fn with_status(mut self, status: u16) -> Self {
        self.status = Some(status);
        self
    }

    /// The same failure, carrying the error that caused it.
    #[must_use]
    pub fn with_source(mut self, source: impl Error + Send + Sync + 'static) -> Self {
        self.source = Some(Box::new(source));
        self
    }

    /// Whether this is the window refusal compaction recovers from.
    pub fn is_context_window_exceeded(&self) -> bool {
        self.code == CONTEXT_WINDOW_EXCEEDED
    }
}

impl fmt::Display for ModelError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl Error for ModelError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        self.source
            .as_deref()
            .map(|source| source as &(dyn Error + 'static))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn display_is_the_message_and_the_fields_are_kept() {
        let error = ModelError::new("'chat' answered 503", "chat", code::HTTP).with_status(503);
        assert_eq!(error.to_string(), "'chat' answered 503");
        assert_eq!(error.endpoint, "chat");
        assert_eq!(error.code, "HTTP");
        assert_eq!(error.status, Some(503));
        assert!(!error.is_context_window_exceeded());
    }

    #[test]
    fn the_window_refusal_is_recognised_by_its_code() {
        let error = ModelError::new("too long", "chat", CONTEXT_WINDOW_EXCEEDED);
        assert!(error.is_context_window_exceeded());
    }

    #[test]
    fn a_cause_is_reachable_through_source() {
        let cause = std::io::Error::other("connection reset");
        let error =
            ModelError::new("could not be sent", "chat", code::TRANSPORT).with_source(cause);
        assert_eq!(
            error.source().map(ToString::to_string).as_deref(),
            Some("connection reset")
        );
    }
}
