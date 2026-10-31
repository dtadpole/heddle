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
    /// `<transcript file name>:<line> is not valid JSON — <message>`. The log is named by its file name alone, as the
    /// TypeScript store names it (`SessionLogUnreadableError`): the text reaches HTTP answers, and the absolute path put the
    /// store root, home directory included, into a turn's `error` frame (#130). `path` keeps the whole path.
    #[error("{}:{line} is not valid JSON — {message}", file_name(.path))]
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
    /// A write refused because another process holds the session's writer lock (`SessionOwnedError` in the
    /// TypeScript build): DSH's `SessionAlreadyOwnedError` sentence, with the holder's pid in brackets when
    /// the lock names one. `session "<id>" is already owned by an active write handle (process <pid>)`
    #[error("session \"{id}\" is already owned by an active write handle{}", holder_suffix(.pid))]
    AlreadyOwned { id: String, pid: Option<u32> },
    /// A branch heddle may not write, so a session cannot be filed in it (#106):
    /// `cannot write to "<folder>": permission denied`, the folder by its name and never its absolute path
    /// (the I/O error carried the definition's path). DSH files no session in the folder, so the code is
    /// heddle's, `session/unwritable`, in DSH's `session/` family; the sentence follows DSH's file backend
    /// (`cannot write "<path>": …`, dsh-fs-local lib/index.js:495).
    #[error("cannot write to \"{folder}\": permission denied")]
    Unwritable { folder: String },
    /// A session's folder that is no longer there — deleted or moved outside heddle, or now a file (#56) —
    /// refused rather than recreated: `This workspace's folder no longer exists: "<folder>"`, the folder by its
    /// name and never its absolute path, as [`SessionError::Unwritable`] names it. The code is heddle's,
    /// `session/folder-missing`, in DSH's `session/` family: DSH has no such refusal (its turn fails with
    /// `working-directory: directory does not exist: "<path>"`, dsh-working-directory lib/index.js:123-131, and its
    /// create makes the folder). `MissingFolderError` in the TypeScript build, word for word.
    #[error("This workspace's folder no longer exists: \"{folder}\"")]
    MissingFolder { folder: String },
}

/// The last component of a path, or the path itself when it has none.
fn file_name(path: &str) -> String {
    std::path::Path::new(path).file_name().map_or_else(
        || path.to_string(),
        |name| name.to_string_lossy().into_owned(),
    )
}

/// ` (process <pid>)` when the lock named its holder, nothing otherwise.
fn holder_suffix(pid: &Option<u32>) -> String {
    pid.map(|pid| format!(" (process {pid})"))
        .unwrap_or_default()
}

impl SessionError {
    /// The code DSH's session controller answers a held session with (`session/writer-held`), for
    /// [`SessionError::AlreadyOwned`]; heddle's `session/unwritable` for [`SessionError::Unwritable`] and
    /// `session/folder-missing` for [`SessionError::MissingFolder`]; `None` for every other error.
    pub fn code(&self) -> Option<&'static str> {
        match self {
            SessionError::AlreadyOwned { .. } => Some("session/writer-held"),
            SessionError::Unwritable { .. } => Some("session/unwritable"),
            SessionError::MissingFolder { .. } => Some("session/folder-missing"),
            _ => None,
        }
    }

    /// [`SessionError::MissingFolder`] for the folder at `path`, named by its last component (#56).
    pub fn missing_folder(path: &str) -> Self {
        SessionError::MissingFolder {
            folder: file_name(path),
        }
    }

    /// [`SessionError::Unwritable`] for a permission error met writing into `branch`, naming the folder by
    /// its name; any other error as it is.
    pub fn unwritable_in(self, branch: &str) -> Self {
        if let SessionError::Io { source, .. } = &self
            && source.kind() == std::io::ErrorKind::PermissionDenied
        {
            let folder = std::path::Path::new(branch)
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_else(|| branch.to_string());
            return SessionError::Unwritable { folder };
        }
        self
    }

    /// Wrap an I/O failure with the path it happened on.
    pub fn io(path: impl Into<String>, source: std::io::Error) -> Self {
        SessionError::Io {
            path: path.into(),
            source,
        }
    }
}
