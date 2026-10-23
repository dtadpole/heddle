//! What the store and its service refuse, and why.
//!
//! The `Display` text of every variant is the TypeScript build's error message, word for word, because
//! the command line prints it and the HTTP routes return it, and a verifier matches on those words
//! (`no session '<id>'`, `is archived and cannot be pinned`, …).

use thiserror::Error;

/// A flag the store refuses for a reason that is not "no such session".
///
/// Pinning and archiving are mutually exclusive in the reference, and a route has to tell a `404` (no
/// session: `Ok(None)`) from a `409` (this error).
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum SessionFlagError {
    /// `session <id> is archived and cannot be pinned`
    #[error("session {id} is archived and cannot be pinned")]
    Archived { id: String },
    /// `session <id> is not archived`
    #[error("session {id} is not archived")]
    NotArchived { id: String },
}

impl SessionFlagError {
    /// The code the TypeScript error carries: `archived` or `not-archived`.
    pub fn code(&self) -> &'static str {
        match self {
            SessionFlagError::Archived { .. } => "archived",
            SessionFlagError::NotArchived { .. } => "not-archived",
        }
    }
}

/// Everything else the session crate can fail with.
#[derive(Debug, Error)]
pub enum SessionError {
    /// A file the store must read or write could not be. Carries the path.
    #[error("{path}: {source}")]
    Io {
        path: String,
        #[source]
        source: std::io::Error,
    },
    /// A transcript line that does not parse: the load fails naming its position rather than skipping it.
    /// `<transcript>:<line> is not valid JSON — <message>`
    #[error("{path}:{line} is not valid JSON — {message}")]
    InvalidLine {
        path: String,
        line: usize,
        message: String,
    },
    /// `a session id must not be empty`
    #[error("a session id must not be empty")]
    EmptyId,
    /// `no session '<id>' under <root>` — a resume that names nothing.
    #[error("no session '{id}' under {root}")]
    NoSession { id: String, root: String },
    /// An event handed to `append` that is not a JSON object with a string `type`, or that carries
    /// its own `seq` or `at` (the store assigns both).
    #[error(
        "a session event must be a JSON object with a string 'type' and no 'seq' or 'at': {reason}"
    )]
    MalformedEvent { reason: String },
    /// `session <id>: "<type>" is not surface-eligible and cannot replace a range`
    #[error("session {id}: \"{event_type}\" is not surface-eligible and cannot replace a range")]
    NotSurfaceEligible { id: String, event_type: String },
    /// `session <id>: replacement range <start>..<end> is not a span of the surface`
    #[error("session {id}: replacement range {start_seq}..{end_seq} is not a span of the surface")]
    NotASpan {
        id: String,
        start_seq: u64,
        end_seq: u64,
    },
    /// A log whose own replacement cannot be folded:
    /// `session event <seq>: a replacement names a range that is not on the surface (<start>..<end>)`
    #[error(
        "session event {seq}: a replacement names a range that is not on the surface ({start_seq}..{end_seq})"
    )]
    UnfoldableReplacement {
        seq: u64,
        start_seq: u64,
        end_seq: u64,
    },
    /// `session <id>: the surface head holds the system prompt and may be rewritten only by a system message over exactly that node`
    #[error(
        "session {id}: the surface head holds the system prompt and may be rewritten only by a system message over exactly that node"
    )]
    SystemHeadRewrite { id: String },
    /// `session <id>: a tool result may be rewritten only by a tool result for the same call, over exactly that node`
    #[error(
        "session {id}: a tool result may be rewritten only by a tool result for the same call, over exactly that node"
    )]
    ToolResultRewrite { id: String },
    /// Pin or archive refused; see [`SessionFlagError`].
    #[error(transparent)]
    Flag(#[from] SessionFlagError),
    /// A recorded access mode outside the vocabulary:
    /// `session event <seq> records access mode '<word>', which is not one of the sandbox modes`.
    /// `word` is the field as JavaScript's `String()` would print it (`undefined` when absent).
    #[error(
        "session event {seq} records access mode '{word}', which is not one of the sandbox modes"
    )]
    UnknownRecordedMode { seq: u64, word: String },
    /// `could not name a session for <base>: a hundred already exist for that minute`
    #[error("could not name a session for {base}: a hundred already exist for that minute")]
    NamesExhausted { base: String },
}

impl SessionError {
    /// Wrap an I/O failure with the path it happened on.
    pub fn io(path: impl Into<String>, source: std::io::Error) -> Self {
        SessionError::Io {
            path: path.into(),
            source,
        }
    }
}
