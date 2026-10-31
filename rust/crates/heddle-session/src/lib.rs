//! `heddle-session` — the append-only session log, its store layouts, transcripts and definitions.
//!
//! Ported from the TypeScript build: `src/session/` (store, transcript, layout, mode, definition,
//! service) and `src/plugins/session.ts`. The folder tree that `src/session/tree.ts` derives lives in
//! `heddle-workspace`, beside the roots it is a view of; the path rules of `src/paths.ts`
//! (`canonical_path`, `is_under`, `depth_of`) and the environment (`Env`, `heddle_home`, `expand_home`)
//! are `heddle-config`'s, and this crate uses those rather than a second copy.
//! Judged through the `heddle` binary (`HEDDLE_BIN`) by `_verifiers_/70-workspaces-sessions`.
//!
//! # The contract this crate keeps
//!
//! **A log written by either build is read by the other, byte for byte.** That fixes four things:
//!
//! - **Where**: `<root>/<workspace-key>/<session-id>.v2.jsonl.zstd` beside `<session-id>.json`, and the
//!   older `<root>/<session-id>/{session.v2.jsonl.zstd|session.jsonl, meta.json}` is read and appended
//!   to but never written fresh ([`layout`], [`store`]).
//! - **How**: one zstd frame per event, each frame one JSON line with a content checksum; a plain
//!   JSONL log stays plain ([`transcript`]).
//! - **What**: an event is `{"seq":…,"at":…,"type":…,…}` exactly as `JSON.stringify` writes it — keys in
//!   insertion order, no spaces, `at` as `Date.prototype.toISOString` prints it ([`event`], [`clock`]).
//!   The meta record and a definition are `JSON.stringify(value, null, 2)` plus a newline, and an edit
//!   keeps every key it did not change where it was ([`meta`], [`definition`]).
//! - **Which events take a position** on the surface a request is derived from ([`surface`]).
//!
//! Everything a caller needs is re-exported at the crate root.
//!
//! # Status
//!
//! Every module is ported, with the unit tests the crate's `INDEX.md` port plan names. A log whose bytes
//! Node's `zlib.zstdCompressSync` produced reads here and prints back byte for byte; a log written here is
//! read by `src/session/transcript.ts` through the `heddle` binary, which is what
//! `_verifiers_/70-workspaces-sessions` judges once the command line composes this crate.

pub mod clock;
pub mod command;
pub mod definition;
pub mod error;
pub mod event;
pub mod fsio;
pub mod inbox;
pub mod layout;
pub mod message;
pub mod meta;
pub mod mode;
pub mod search;
pub mod service;
pub mod store;
pub mod surface;
pub mod title;
pub mod transcript;
pub mod unicode61;

pub use definition::{
    CreatedDefinition, DEFINITION_FILE, DefinitionOptions, SESSIONS_FOLDER, SessionDefinition,
    SessionDefinitionFields, ensure_sessions_folder, existing_session_names,
    read_session_definition, session_name, update_session_definition, write_session_definition,
};
pub use error::{SessionError, SessionFlagError};
pub use event::{
    AppendOptions, Events, NewEvent, SessionEvent, SessionHandle, SessionId, SurfaceOp,
};
pub use fsio::write_atomic;
pub use layout::workspace_key;
pub use message::{
    Chunk, ContentPart, FilePart, ImagePart, Message, RecordedMessage, Role, text_of,
};
pub use meta::{
    CreateOptions, FlagPatch, ForkAttribution, ModelSelection, SessionMeta, SessionOrigin,
    under_archived_session,
};
pub use mode::{MODE_EVENT, effective_mode, inherit_recorded_mode, recorded_mode};
pub use search::{
    SESSION_SEARCH_QUERY_MAX_CHARS, SESSION_SEARCH_RESULT_LIMIT,
    SESSION_SEARCH_SNIPPET_MAX_CODE_POINTS, SessionSearchHit, SessionSearchIndex,
    SessionSearchPage, SessionSearchQueryError, normalize_search_query,
};
pub use service::{
    CreateAtOptions, ForkOutcome, ModeChange, OpenAtOptions, SessionConfig, SessionService,
    StartOptions, fork_title, title_from,
};
pub use store::{
    EventListener, LEGACY_TRANSCRIPT_NAME, ModelRequestBreakdown, ModelRequestRecord, SessionStore,
    TRANSCRIPT_NAME, can_compress, default_session_root, is_framed, lock_path, log_name, meta_name,
    transcript_in,
};
pub use surface::{
    SURFACE_EVENT_TYPES, SurfaceReplacement, SurfaceState, completed_prefix, derive_message,
    derive_node_message, fold_surface, index_by_seq, inherits_answer, is_surface_eligible,
};
pub use title::{
    LlmTitles, SESSION_TITLE_PURPOSE, SessionTitles, TitleAnswer, TitleDone, TitleModel,
    TitleSpawn, TitleTask, normalize_session_title, title_from_answer,
};
pub use transcript::{
    DecodedTranscript, FRAME_MAGIC, Frame, TranscriptFormat, decode_transcript, encode_frame,
    frame_end, is_compressed, looks_compressed, split_frames,
};
