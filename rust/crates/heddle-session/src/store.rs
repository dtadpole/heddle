//! The session store: an append-only event log per session, filed under its workspace folder.
//!
//! Ported from `SessionStore` in `src/session/store.ts`, modelled on `@deepseek-ai/dsh-session`.
//!
//! - **An event is on disk before the thing it describes happens.** `append` writes synchronously and
//!   only then tells the listener, so a listener never sees an event the file does not have.
//! - **A torn tail is cut off when the session is opened**, and the repair is recorded as a
//!   `transcript/repaired` event carrying `droppedBytes`. Without it, every event appended after a tear
//!   sits in the file unread.
//! - **A process that has opened a session reads it from memory.** The file is decoded once; every
//!   later read, count and derivation is served from that fold, and the surface is cached by event count.
//! - **One process writes a session at a time.** The first append takes a writer lock beside the log
//!   ([`lock_path`]: `<id>.lock`, or `session.lock` in an old-layout directory, holding the holder's pid and
//!   a newline — the TypeScript build's file, byte for byte) and keeps it until [`SessionStore::release`] or
//!   the store is dropped. Another process's append is refused with [`SessionError::AlreadyOwned`], DSH's
//!   `session "<id>" is already owned by an active write handle`; a lock whose holder is dead is taken over.
//!   Taking the lock drops the fold, so the first write re-reads what a previous holder appended. Without
//!   it, a `heddle web` server and a `heddle --resume <id> --turn` each appended from their own count and
//!   the log held the same seqs twice (R-developer-eight-27).
//! - **Two layouts are read, one is written**: `<root>/<workspace-key>/<id>.v2.jsonl.zstd` + `<id>.json`
//!   for a new session; `<root>/<id>/{session.v2.jsonl.zstd|session.jsonl, meta.json}` for an old one,
//!   which keeps the shape and the format it was born with.
//!
//! # Threads
//!
//! The store is `Send + Sync` and every method takes `&self`; share it as `Arc<SessionStore>`. One
//! internal lock serializes the fold and the file writes, so a seq is assigned and written atomically.
//! The listener is called **after** the lock is released, so it may read the store.

use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex, PoisonError};
use std::time::Duration;

use heddle_config::{Env, expand_home, heddle_home};
use serde::Serialize;
use serde_json::{Map, Value};

use crate::clock::iso_now;
use crate::error::{SessionError, SessionFlagError};
use crate::event::{AppendOptions, Events, NewEvent, SessionEvent, SessionHandle, SurfaceOp};
use crate::layout::workspace_key;
use crate::message::{Chunk, Message, RecordedMessage, Role};
use crate::meta::{CreateOptions, FlagPatch, ForkAttribution, ModelSelection, SessionMeta};
use crate::surface::{
    SurfaceState, completed_prefix, derive_message, derive_node_message, fold_surface,
    index_by_seq, is_surface_eligible,
};
use crate::transcript::{TranscriptFormat, decode_transcript, encode_frame};

/// The transcript file name inside an **old-layout** session directory, current format.
pub const TRANSCRIPT_NAME: &str = "session.v2.jsonl.zstd";
/// The transcript file name inside an old-layout session directory, plain JSONL (v1).
pub const LEGACY_TRANSCRIPT_NAME: &str = "session.jsonl";

/// Told about every event after it is on disk, and about every live-only tool-call fragment.
///
/// This is the seam the command line's printer and the Web UI's stream listen on; the boot wires it to
/// the `session/event` hook (`{ session: handle.id, event }`).
pub type EventListener = Arc<dyn Fn(&SessionHandle, &SessionEvent) + Send + Sync>;

/// The default store root: `heddle_home(env)/sessions` — `$HEDDLE_HOME/sessions`, else
/// `~/.heddle/sessions`.
pub fn default_session_root(env: &Env) -> String {
    heddle_home(env)
        .join("sessions")
        .to_string_lossy()
        .into_owned()
}

/// Whether a transcript path is one of the zstd-framed ones — asked of the suffix `.v2.jsonl.zstd`,
/// because both `session.v2.jsonl.zstd` and `<id>.v2.jsonl.zstd` are.
pub fn is_framed(path: &str) -> bool {
    path.ends_with(".v2.jsonl.zstd")
}

/// Whether this build can compress. Always true in Rust; kept so a caller ported from the TypeScript
/// build reads the same.
pub fn can_compress() -> bool {
    true
}

/// The log's file name for one session id in the workspace-folder layout: `<id>.v2.jsonl.zstd`.
pub fn log_name(id: &str) -> String {
    format!("{id}.v2.jsonl.zstd")
}

/// The metadata's file name for one session id, beside its log: `<id>.json`.
pub fn meta_name(id: &str) -> String {
    format!("{id}.json")
}

/// The transcript an old-layout session directory holds, preferring the current format, and the
/// current format's name when it holds neither.
pub fn transcript_in(dir: &str) -> String {
    for name in [TRANSCRIPT_NAME, LEGACY_TRANSCRIPT_NAME] {
        let path = Path::new(dir).join(name);
        if path.exists() {
            return path.to_string_lossy().into_owned();
        }
    }
    Path::new(dir)
        .join(TRANSCRIPT_NAME)
        .to_string_lossy()
        .into_owned()
}

/// Where a session's writer lock is: `<id>.lock` beside its log, or `session.lock` inside an old-layout
/// session directory — DSH's `session.lock`, named the way this layout names everything else of one
/// session. The TypeScript store (`lockPath`) uses the same path and the same contents.
pub fn lock_path(handle: &SessionHandle) -> String {
    let legacy = Path::new(&handle.meta)
        .file_name()
        .is_some_and(|name| name == "meta.json");
    let name = if legacy {
        "session.lock".to_string()
    } else {
        format!("{}.lock", handle.id)
    };
    Path::new(&handle.dir)
        .join(name)
        .to_string_lossy()
        .into_owned()
}

/// How long a lock file with no pid in it is taken to be one being written rather than debris: the holder
/// creates the file and writes its pid in the next call.
const UNWRITTEN_LOCK_GRACE: Duration = Duration::from_secs(5);

/// The lock files this process holds, and how many stores in it hold each; the last to let go removes it.
static HELD_BY_PROCESS: LazyLock<Mutex<HashMap<PathBuf, usize>>> = LazyLock::new(Default::default);

/// The pid a lock file names: decimal digits, surrounding whitespace ignored, above zero.
fn lock_holder(text: &str) -> Option<u32> {
    let trimmed = text.trim();
    if trimmed.is_empty() || !trimmed.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    trimmed.parse::<u32>().ok().filter(|pid| *pid > 0)
}

/// Whether a process with this pid exists. A process this user may not signal exists, and when the
/// answer cannot be had the holder is taken to be alive: a live writer is never expropriated.
#[cfg(target_os = "linux")]
fn process_alive(pid: u32) -> bool {
    Path::new("/proc").join(pid.to_string()).exists()
}

/// Whether a process with this pid exists. A process this user may not signal exists, and when the
/// answer cannot be had the holder is taken to be alive: a live writer is never expropriated.
#[cfg(all(unix, not(target_os = "linux")))]
fn process_alive(pid: u32) -> bool {
    // `kill -0` is what Node's `process.kill(pid, 0)` asks; the crate forbids the unsafe a direct call needs.
    match std::process::Command::new("kill")
        .arg("-0")
        .arg(pid.to_string())
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .output()
    {
        Ok(output) => {
            output.status.success()
                || String::from_utf8_lossy(&output.stderr).contains("not permitted")
        }
        Err(_) => true,
    }
}

/// Whether a process with this pid exists, asked of `tasklist`; alive when the answer cannot be had.
#[cfg(not(unix))]
fn process_alive(pid: u32) -> bool {
    match std::process::Command::new("tasklist")
        .args(["/FI", &format!("PID eq {pid}"), "/NH"])
        .output()
    {
        Ok(output) => String::from_utf8_lossy(&output.stdout).contains(&format!(" {pid} ")),
        Err(_) => true,
    }
}

/// Remove a lock file only if it still names this process, so letting go never removes another's lock.
fn remove_own_lock(path: &Path) {
    if let Ok(text) = std::fs::read_to_string(path)
        && lock_holder(&text) == Some(std::process::id())
    {
        let _ = std::fs::remove_file(path);
    }
}

/// Take a session's writer lock for this process, or fail with [`SessionError::AlreadyOwned`].
///
/// DSH arbitrates with a kernel `flock(2)` on `session.lock`; the TypeScript build cannot take one without a
/// native addon, so both builds share a lock file created exclusively and naming its holder's pid. What flock
/// gives for free is supplied by hand: a holder that died without letting go leaves a file naming a pid that no
/// longer exists, and that lock is removed and taken rather than blocking the session forever. A live holder is
/// never expropriated: there is no expiry that could let a stalled writer's resumed appends tear the log.
fn acquire_writer_lock(path: &Path, id: &str) -> Result<(), SessionError> {
    let mut held = HELD_BY_PROCESS
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    if let Some(count) = held.get_mut(path) {
        *count += 1;
        return Ok(());
    }
    let own = std::process::id();
    let shown = path.to_string_lossy().into_owned();
    let refused = |pid: Option<u32>| SessionError::AlreadyOwned {
        id: id.to_string(),
        pid,
    };
    for _ in 0..3 {
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)
        {
            Ok(mut file) => {
                if let Err(error) = file.write_all(format!("{own}\n").as_bytes()) {
                    drop(file);
                    let _ = std::fs::remove_file(path);
                    return Err(SessionError::io(shown, error));
                }
                held.insert(path.to_path_buf(), 1);
                return Ok(());
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(SessionError::io(shown, error)),
        }
        let text = match std::fs::read_to_string(path) {
            Ok(text) => text,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(SessionError::io(shown, error)),
        };
        let holder = lock_holder(&text);
        if holder == Some(own) {
            held.insert(path.to_path_buf(), 1);
            return Ok(());
        }
        if let Some(pid) = holder
            && process_alive(pid)
        {
            return Err(refused(Some(pid)));
        }
        if holder.is_none() {
            // A modification time in the future reads as young, as `Date.now() - mtimeMs` does.
            let young = std::fs::metadata(path)
                .and_then(|meta| meta.modified())
                .map(|modified| {
                    modified
                        .elapsed()
                        .map(|age| age < UNWRITTEN_LOCK_GRACE)
                        .unwrap_or(true)
                })
                .unwrap_or(false);
            if young {
                return Err(refused(None));
            }
        }
        match std::fs::remove_file(path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(SessionError::io(shown, error)),
        }
    }
    Err(refused(None))
}

/// Let go of one store's hold on a lock; the last hold in this process removes the file.
fn release_writer_lock(path: &Path) {
    let mut held = HELD_BY_PROCESS
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    match held.get_mut(path) {
        None => return,
        Some(count) if *count > 1 => {
            *count -= 1;
            return;
        }
        Some(_) => {}
    }
    held.remove(path);
    remove_own_lock(path);
}

/// The meter sections of one request.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct ModelRequestBreakdown {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub system: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tools: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub messages: Option<u64>,
}

/// Which model call produced an answer, recorded before it is made as a `model/request` event.
///
/// Written in field order after `type`, absent fields omitted.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelRequestRecord {
    pub endpoint: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<String>,
    /// How many messages the request carries.
    pub messages: u64,
    /// The tool names offered.
    pub tools: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub estimated_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub threshold_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pruned: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compacted: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub breakdown: Option<ModelRequestBreakdown>,
    /// The surface generation the request was built at.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub generation: Option<u64>,
}

/// The session store. See the module documentation.
pub struct SessionStore {
    root: String,
    listener: Option<EventListener>,
    state: Mutex<StoreState>,
}

/// One session's fold: its events, and whether its transcript is stored as frames.
struct Loaded {
    events: Arc<Vec<Arc<SessionEvent>>>,
    framed: bool,
}

/// The fold and the surface cache, behind the store's one lock.
#[derive(Default)]
struct StoreState {
    /// Parsed events per session. A snapshot handed out through [`SessionStore::read`] shares the
    /// `Arc`, so a later append copies this vector of pointers rather than waiting for the reader.
    loaded: HashMap<String, Loaded>,
    /// Folded surfaces, keyed by session and the log length they were folded at.
    surface_cache: HashMap<String, (usize, Arc<SurfaceState>)>,
    /// The sessions this store holds the writer lock for, and where each lock is.
    held: HashMap<String, PathBuf>,
}

impl Drop for SessionStore {
    /// A store that goes away lets go of every session it holds, so the next process may write them.
    fn drop(&mut self) {
        let state = self.state.get_mut().unwrap_or_else(PoisonError::into_inner);
        for path in state.held.values() {
            release_writer_lock(path);
        }
        state.held.clear();
    }
}

impl std::fmt::Debug for SessionStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SessionStore")
            .field("root", &self.root)
            .finish_non_exhaustive()
    }
}

/// Write a file whole, replacing what was there atomically, so a concurrent reader never sees it half-done.
fn write_text(path: &str, text: &str) -> Result<(), SessionError> {
    crate::fsio::write_atomic(path, text).map_err(|error| SessionError::io(path, error))
}

/// The entries of a directory, in byte order — which is what Node's `readdirSync` returns, and the
/// order the TypeScript store's listing depends on.
fn entries_sorted(dir: &Path) -> Vec<String> {
    let Ok(read) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut names: Vec<String> = read
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .collect();
    names.sort_by(|left, right| left.as_bytes().cmp(right.as_bytes()));
    names
}

/// Add one parsed metadata file to a listing, first occurrence winning. A file that is not metadata is
/// skipped rather than failing the list.
fn remember_meta(
    text: Result<String, std::io::Error>,
    metas: &mut Vec<SessionMeta>,
    seen: &mut Vec<String>,
) {
    let Ok(text) = text else {
        return;
    };
    let Ok(value) = serde_json::from_str::<Value>(&text) else {
        return;
    };
    let Some(meta) = SessionMeta::from_value(value) else {
        return;
    };
    let id = meta.id().to_string();
    if seen.contains(&id) {
        return;
    }
    seen.push(id);
    metas.push(meta);
}

impl SessionStore {
    /// A store rooted at `root`: a leading `~` expanded with `heddle_config::expand_home`, then resolved
    /// to an absolute path. Nothing is created until the first session is.
    pub fn new(root: &str, env: &Env) -> Self {
        SessionStore {
            root: resolve_root(root, env),
            listener: None,
            state: Mutex::new(StoreState::default()),
        }
    }

    /// A store whose appends are also handed to `listener`.
    pub fn with_listener(root: &str, env: &Env, listener: EventListener) -> Self {
        SessionStore {
            root: resolve_root(root, env),
            listener: Some(listener),
            state: Mutex::new(StoreState::default()),
        }
    }

    /// The absolute root every session is filed under.
    pub fn root(&self) -> &str {
        &self.root
    }

    /// Create a session filed under its workspace folder: write `<id>.json`, create the empty log, and
    /// append `session/created` with the `cwd`.
    pub fn create(&self, options: CreateOptions) -> Result<SessionHandle, SessionError> {
        let id = options
            .id
            .clone()
            .unwrap_or_else(|| format!("session-{}", uuid::Uuid::new_v4()));
        if id.trim().is_empty() {
            return Err(SessionError::EmptyId);
        }
        let cwd = options.cwd.clone().unwrap_or_else(|| {
            std::env::current_dir()
                .unwrap_or_else(|_| std::path::PathBuf::from("."))
                .to_string_lossy()
                .into_owned()
        });
        let dir = Path::new(&self.root)
            .join(workspace_key(&cwd))
            .to_string_lossy()
            .into_owned();
        std::fs::create_dir_all(&dir).map_err(|error| SessionError::io(&dir, error))?;
        let handle = SessionHandle {
            id: id.clone(),
            dir: dir.clone(),
            transcript: Path::new(&dir)
                .join(log_name(&id))
                .to_string_lossy()
                .into_owned(),
            meta: Path::new(&dir)
                .join(meta_name(&id))
                .to_string_lossy()
                .into_owned(),
        };

        // The record's key order is the TypeScript literal's: an absent option is not written.
        let mut record = Map::new();
        record.insert("id".to_string(), Value::String(id.clone()));
        record.insert("created".to_string(), Value::String(iso_now()));
        record.insert("cwd".to_string(), Value::String(cwd.clone()));
        for (key, value) in [
            ("endpoint", options.endpoint.clone()),
            ("model", options.model.clone()),
            ("reasoningEffort", options.reasoning_effort.clone()),
            ("title", options.title.clone()),
            ("parentSession", options.parent_session.clone()),
        ] {
            if let Some(value) = value {
                record.insert(key.to_string(), Value::String(value));
            }
        }
        if let Some(origin) = options.origin {
            record.insert(
                "origin".to_string(),
                serde_json::to_value(origin).expect("an origin is a word"),
            );
        }
        if let Some(depth) = options.delegation_depth {
            record.insert("delegationDepth".to_string(), Value::from(depth));
        }
        if let Some(team) = options.team_id.clone() {
            record.insert("teamId".to_string(), Value::String(team));
        }
        record.insert("turns".to_string(), Value::from(0u64));
        let meta = SessionMeta::from_value(Value::Object(record)).expect("the record has an id");
        write_text(&handle.meta, &meta.to_file_text())?;

        // `appendFileSync(path, '')`: the empty log exists before the first event is written to it.
        std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&handle.transcript)
            .map_err(|error| SessionError::io(&handle.transcript, error))?;

        self.append(
            &handle,
            NewEvent::new("session/created").field("cwd", cwd),
            AppendOptions::default(),
        )?;
        Ok(handle)
    }

    /// Retitle a session; a blank title deletes the key. `Ok(None)` when there is no such session.
    pub fn rename(&self, id: &str, title: &str) -> Result<Option<SessionMeta>, SessionError> {
        let Some(current) = self.list().into_iter().find(|meta| meta.id() == id) else {
            return Ok(None);
        };
        let trimmed = title.trim();
        let mut next = current;
        if trimmed.is_empty() {
            next.remove("title");
        } else {
            next.set("title", Value::String(trimmed.to_string()));
        }
        let Some(meta_path) = self.meta_file(id) else {
            return Ok(None);
        };
        write_text(&meta_path, &next.to_file_text())?;
        Ok(Some(next))
    }

    /// Set or clear pinned and archived in one write, answering with the record as it now is.
    /// `Ok(None)` for an unknown session; [`SessionError::Flag`] for a refused pin.
    pub fn flags(&self, id: &str, patch: FlagPatch) -> Result<Option<SessionMeta>, SessionError> {
        let Some(current) = self.list().into_iter().find(|meta| meta.id() == id) else {
            return Ok(None);
        };
        let mut next = current.clone();
        if let Some(pinned) = patch.pinned {
            if pinned {
                // Archived and pinned are exclusive in the reference.
                if current.archived() {
                    return Err(SessionError::Flag(SessionFlagError::Archived {
                        id: id.to_string(),
                    }));
                }
                next.set("pinned", Value::Bool(true));
                next.set("pinnedAt", Value::String(iso_now()));
            } else {
                next.remove("pinned");
                next.remove("pinnedAt");
            }
        }
        if let Some(archived) = patch.archived {
            if archived {
                next.set("archived", Value::Bool(true));
                // Archiving drops the pin in the same write, as DSH's archive does.
                next.remove("pinned");
                next.remove("pinnedAt");
            } else {
                next.remove("archived");
            }
        }
        let Some(meta_path) = self.meta_file(id) else {
            return Ok(None);
        };
        write_text(&meta_path, &next.to_file_text())?;
        Ok(Some(next))
    }

    /// Copy a session's **projected** messages, cut at its last completed turn and without system
    /// messages, into a new session that inherits its `cwd`, endpoint, model and reasoning level.
    /// `Ok(None)` when the source does not exist.
    pub fn fork(
        &self,
        source: &str,
        attribution: ForkAttribution,
    ) -> Result<Option<SessionHandle>, SessionError> {
        let Some(from) = self.open(source) else {
            return Ok(None);
        };
        let meta = self.list().into_iter().find(|meta| meta.id() == source);
        let handle = self.create(CreateOptions {
            cwd: meta.as_ref().map(|meta| meta.cwd().to_string()),
            endpoint: meta
                .as_ref()
                .and_then(|meta| meta.endpoint().map(str::to_string)),
            model: meta
                .as_ref()
                .and_then(|meta| meta.model().map(str::to_string)),
            reasoning_effort: meta
                .as_ref()
                .and_then(|meta| meta.reasoning_effort().map(str::to_string)),
            title: attribution.title.clone(),
            parent_session: attribution.parent_session.clone(),
            origin: attribution.origin,
            delegation_depth: attribution.delegation_depth,
            team_id: attribution.team_id.clone(),
            id: attribution.id.clone(),
        })?;

        // The fork inherits what the source had **finished**: a dangling user message is not carried.
        let events = self.read(&from)?;
        let inherited = completed_prefix(events.as_slice());
        let by_seq = index_by_seq(&inherited);
        for seq in fold_surface(&inherited)?.nodes {
            let Some(message) = derive_message(&by_seq, seq) else {
                continue;
            };
            if message.role == Role::System {
                continue;
            }
            if let Some(node) = by_seq.get(&seq).filter(|node| node.kind == "context/note") {
                // A note the harness wrote stays a **note**, as DSH's fork seed keeps the source's own
                // events (dsh-session/lib/types/fork.js:18-27): re-appended as a `message`, a runtime-context
                // snapshot became a user bubble and one turn too many in the child (R-developer-eight-15).
                // Origin and identity come along; the source's surface positions name seqs the child lacks.
                let mut fields = node.fields.clone();
                fields.shift_remove("surfaceOp");
                fields.shift_remove("sourceEventSeqs");
                self.append(
                    &handle,
                    NewEvent {
                        kind: node.kind.clone(),
                        fields,
                    },
                    AppendOptions::default(),
                )?;
                continue;
            }
            self.message(&handle, message)?;
        }
        Ok(Some(handle))
    }

    /// Record which endpoint and model a session runs with, replacing the previous selection.
    /// `Ok(None)` for an unknown session or a blank endpoint.
    pub fn set_model(
        &self,
        id: &str,
        selection: ModelSelection,
    ) -> Result<Option<SessionMeta>, SessionError> {
        let Some(current) = self.list().into_iter().find(|meta| meta.id() == id) else {
            return Ok(None);
        };
        let endpoint = selection.endpoint.trim();
        if endpoint.is_empty() {
            return Ok(None);
        }
        let mut next = current;
        next.set("endpoint", Value::String(endpoint.to_string()));
        match selection.model.as_deref().map(str::trim) {
            Some(model) if !model.is_empty() => {
                next.set("model", Value::String(model.to_string()));
            }
            _ => {
                next.remove("model");
            }
        }
        match selection.reasoning_effort.as_deref().map(str::trim) {
            Some(effort) if !effort.is_empty() => {
                next.set("reasoningEffort", Value::String(effort.to_string()));
            }
            _ => {
                next.remove("reasoningEffort");
            }
        }
        let Some(meta_path) = self.meta_file(id) else {
            return Ok(None);
        };
        write_text(&meta_path, &next.to_file_text())?;
        Ok(Some(next))
    }

    /// Where a session's metadata is, in whichever layout it was written in.
    fn meta_file(&self, id: &str) -> Option<String> {
        let legacy = Path::new(&self.root).join(id).join("meta.json");
        if legacy.exists() {
            return Some(legacy.to_string_lossy().into_owned());
        }
        for name in entries_sorted(Path::new(&self.root)) {
            let candidate = Path::new(&self.root).join(&name).join(meta_name(id));
            if candidate.exists() {
                return Some(candidate.to_string_lossy().into_owned());
            }
        }
        None
    }

    /// Open an existing session by id, in whichever layout it was written in.
    pub fn open(&self, id: &str) -> Option<SessionHandle> {
        let meta = self.meta_file(id)?;
        let dir = Path::new(&meta)
            .parent()
            .map(|parent| parent.to_string_lossy().into_owned())?;
        let candidate = Path::new(&dir).join(log_name(id));
        let transcript = if candidate.exists() {
            candidate.to_string_lossy().into_owned()
        } else {
            transcript_in(&dir)
        };
        Some(SessionHandle {
            id: id.to_string(),
            dir,
            transcript,
            meta,
        })
    }

    /// One session's metadata record, read straight from its file: no directory walk beyond locating it
    /// and no log load. `None` when there is no such session or the file is not metadata.
    pub fn meta(&self, id: &str) -> Option<SessionMeta> {
        let path = self.meta_file(id)?;
        let text = std::fs::read_to_string(path).ok()?;
        let value: Value = serde_json::from_str(&text).ok()?;
        SessionMeta::from_value(value)
    }

    /// Whether the session or a subagent ancestor is archived ([`crate::under_archived_session`]), read from the
    /// records **now**: the agent loop asks before every step, so an archive written by another process stops the
    /// next step too.
    pub fn under_archived(&self, id: &str) -> bool {
        crate::under_archived_session(|one| self.meta(one), id)
    }

    /// Open the newest session (by `created`), if there is one.
    pub fn open_newest(&self) -> Option<SessionHandle> {
        let newest = self.list().into_iter().next()?;
        self.open(newest.id())
    }

    /// Every session, newest `created` first, from both layouts, none twice. A file that is not
    /// metadata is skipped rather than failing the list. Directory entries are visited in byte order,
    /// as Node's `readdirSync` returns them.
    pub fn list(&self) -> Vec<SessionMeta> {
        let mut metas: Vec<SessionMeta> = Vec::new();
        let mut seen: Vec<String> = Vec::new();

        for name in entries_sorted(Path::new(&self.root)) {
            let at = Path::new(&self.root).join(&name);
            if name.starts_with("session-") {
                remember_meta(
                    std::fs::read_to_string(at.join("meta.json")),
                    &mut metas,
                    &mut seen,
                );
                continue;
            }
            for entry in entries_sorted(&at) {
                if !entry.starts_with("session-") || !entry.ends_with(".json") {
                    continue;
                }
                remember_meta(
                    std::fs::read_to_string(at.join(&entry)),
                    &mut metas,
                    &mut seen,
                );
            }
        }

        // Newest first. The TypeScript comparator answers `1` or `-1` and never `0`, so an equal pair
        // keeps the order it was found in — which a stable sort with `Less` reproduces.
        metas.sort_by(|left, right| {
            if left.created() < right.created() {
                std::cmp::Ordering::Greater
            } else {
                std::cmp::Ordering::Less
            }
        });
        metas
    }

    /// Append one event and answer with it as recorded.
    ///
    /// A `Replace` op is validated first: the event must be surface-eligible; the range must be a span
    /// of current positions; a system prompt at the surface head may be rewritten only by a system
    /// message over exactly that node; a tool result may be rewritten by a tool message only for the
    /// same call, over exactly that node. `turn/completed`, `assistant/completed` and `context/note`
    /// also touch the meta record's `updated`.
    pub fn append(
        &self,
        handle: &SessionHandle,
        event: NewEvent,
        options: AppendOptions,
    ) -> Result<Arc<SessionEvent>, SessionError> {
        let written = {
            let mut state = self.state.lock().expect("the store lock is never poisoned");
            // Before anything is read for the write: taking the lock is what makes the seq the file's next one.
            self.claim_locked(&mut state, handle)?;
            self.load_locked(&mut state, handle)?;
            self.append_locked(&mut state, handle, event, options)?
        };
        // A turn boundary is activity: the row's age moves while an answer is produced, not only when a
        // message is typed. This happens outside the lock, as the TypeScript build does.
        if matches!(
            written.kind.as_str(),
            "turn/completed" | "assistant/completed" | "context/note"
        ) {
            self.touch(handle, false);
        }
        // After the write, never before: a listener that saw an event the file does not have would be a
        // second truth.
        if let Some(listener) = &self.listener {
            listener(handle, &written);
        }
        Ok(written)
    }

    /// Take this session's writer lock, or fail with [`SessionError::AlreadyOwned`] while another process
    /// holds it.
    ///
    /// [`SessionStore::append`] calls it, so a caller only needs it to be refused **before** doing anything
    /// else. Taking the lock drops this store's fold of the session: the previous holder may have appended
    /// and let go since it was read, and a write counted from a stale fold is the duplicate seq this lock
    /// exists to prevent. Holding it again is free.
    pub fn claim(&self, handle: &SessionHandle) -> Result<(), SessionError> {
        let mut state = self.state.lock().expect("the store lock is never poisoned");
        self.claim_locked(&mut state, handle)
    }

    /// Whether this store holds the session's writer lock.
    pub fn holds(&self, handle: &SessionHandle) -> bool {
        self.state
            .lock()
            .expect("the store lock is never poisoned")
            .held
            .contains_key(&handle.id)
    }

    /// Let go of the session's writer lock, so another process may write it. Nothing has to call this:
    /// dropping the store lets go of every lock, and a lock whose holder died is taken over by the next
    /// writer. A later append takes the lock again.
    pub fn release(&self, handle: &SessionHandle) {
        let path = self
            .state
            .lock()
            .expect("the store lock is never poisoned")
            .held
            .remove(&handle.id);
        if let Some(path) = path {
            release_writer_lock(&path);
        }
    }

    fn claim_locked(
        &self,
        state: &mut StoreState,
        handle: &SessionHandle,
    ) -> Result<(), SessionError> {
        if state.held.contains_key(&handle.id) {
            return Ok(());
        }
        let path = PathBuf::from(lock_path(handle));
        acquire_writer_lock(&path, &handle.id)?;
        state.held.insert(handle.id.clone(), path);
        state.loaded.remove(&handle.id);
        state.surface_cache.remove(&handle.id);
        Ok(())
    }

    /// Append with the lock already held, and without touching the meta or the listener.
    fn append_locked(
        &self,
        state: &mut StoreState,
        handle: &SessionHandle,
        event: NewEvent,
        options: AppendOptions,
    ) -> Result<Arc<SessionEvent>, SessionError> {
        if let Some(op @ SurfaceOp::Replace { .. }) = options.surface_op {
            self.assert_replacement_locked(state, handle, &event, op)?;
        }
        let (seq, framed) = {
            let loaded = state
                .loaded
                .get(&handle.id)
                .expect("the log is loaded before an append");
            (loaded.events.len() as u64, loaded.framed)
        };
        let mut fields = event.fields;
        if let Some(op) = options.surface_op {
            fields.insert(
                "surfaceOp".to_string(),
                serde_json::to_value(op).expect("a surface operation is serializable"),
            );
        }
        if let Some(seqs) = options.source_event_seqs {
            fields.insert(
                "sourceEventSeqs".to_string(),
                serde_json::to_value(seqs).expect("a list of seqs is serializable"),
            );
        }
        let record = Arc::new(SessionEvent {
            seq,
            at: iso_now(),
            kind: event.kind,
            fields,
        });

        // One event, one frame, appended. The frame is the unit of appendability: a compressed file
        // cannot be added to in the middle, and a frame is the smallest thing that can be added at the
        // end, so every earlier byte is untouched.
        let line = format!("{}\n", record.to_line());
        let bytes = if framed {
            encode_frame(&line)
        } else {
            line.into_bytes()
        };
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&handle.transcript)
            .map_err(|error| SessionError::io(&handle.transcript, error))?;
        file.write_all(&bytes)
            .map_err(|error| SessionError::io(&handle.transcript, error))?;

        if let Some(loaded) = state.loaded.get_mut(&handle.id) {
            Arc::make_mut(&mut loaded.events).push(record.clone());
        }
        Ok(record)
    }

    /// Load a session's log once, repairing a torn tail, and record it in the fold.
    fn load_locked(
        &self,
        state: &mut StoreState,
        handle: &SessionHandle,
    ) -> Result<(), SessionError> {
        if state.loaded.contains_key(&handle.id) {
            return Ok(());
        }
        let mut bytes = std::fs::read(&handle.transcript).unwrap_or_default();
        let mut decoded = decode_transcript(&bytes);
        let torn = bytes.len() > decoded.readable_bytes;

        // A torn tail is cut off before anything is appended. What is dropped is a frame that was never
        // written whole, so no event that existed as an event is lost.
        //
        // Only the session's writer cuts. A half frame at the end of a session another process holds may be
        // that process's append in progress, so a reader that cannot take the lock reads the whole frames and
        // leaves the file alone; one that can re-reads under the lock before it cuts, because the frame may
        // have been finished by the holder it just replaced.
        let mut dropped = 0;
        if torn {
            match self.claim_locked(state, handle) {
                Ok(()) => {
                    bytes = std::fs::read(&handle.transcript).unwrap_or_default();
                    decoded = decode_transcript(&bytes);
                    dropped = bytes.len().saturating_sub(decoded.readable_bytes);
                    if dropped > 0
                        && let Ok(file) = std::fs::OpenOptions::new()
                            .write(true)
                            .open(&handle.transcript)
                    {
                        let _ = file.set_len(decoded.readable_bytes as u64);
                    }
                }
                Err(SessionError::AlreadyOwned { .. }) => {}
                Err(error) => return Err(error),
            }
        }

        let mut events = Vec::with_capacity(decoded.lines.len());
        for (index, line) in decoded.lines.iter().enumerate() {
            match SessionEvent::from_line(line) {
                Ok(event) => events.push(Arc::new(event)),
                Err(error) => {
                    return Err(SessionError::InvalidLine {
                        path: handle.transcript.clone(),
                        line: index + 1,
                        message: error.to_string(),
                    });
                }
            }
        }
        let framed = decoded.format == TranscriptFormat::ZstdFrames
            || ((torn || decoded.lines.is_empty()) && is_framed(&handle.transcript));
        state.loaded.insert(
            handle.id.clone(),
            Loaded {
                events: Arc::new(events),
                framed,
            },
        );
        if dropped > 0 {
            // The repair is recorded on the session rather than done silently.
            self.append_locked(
                state,
                handle,
                NewEvent::new("transcript/repaired").field("droppedBytes", dropped as u64),
                AppendOptions::default(),
            )?;
        }
        Ok(())
    }

    /// Reject a replacement the surface could not fold or that would erase something it must not.
    fn assert_replacement_locked(
        &self,
        state: &mut StoreState,
        handle: &SessionHandle,
        event: &NewEvent,
        op: SurfaceOp,
    ) -> Result<(), SessionError> {
        let SurfaceOp::Replace { start_seq, end_seq } = op else {
            return Ok(());
        };
        if !is_surface_eligible(&event.kind) {
            return Err(SessionError::NotSurfaceEligible {
                id: handle.id.clone(),
                event_type: event.kind.clone(),
            });
        }
        let surface = self.surface_locked(state, handle)?;
        let start_idx = surface.nodes.iter().position(|seq| *seq == start_seq);
        let end_idx = surface.nodes.iter().position(|seq| *seq == end_seq);
        let (Some(start_idx), Some(end_idx)) = (start_idx, end_idx) else {
            return Err(SessionError::NotASpan {
                id: handle.id.clone(),
                start_seq,
                end_seq,
            });
        };
        if end_idx < start_idx {
            return Err(SessionError::NotASpan {
                id: handle.id.clone(),
                start_seq,
                end_seq,
            });
        }
        let shadowed_seqs = surface.nodes[start_idx..=end_idx].to_vec();
        let events = state
            .loaded
            .get(&handle.id)
            .expect("the surface was folded")
            .events
            .clone();
        let replacement = event
            .get("message")
            .and_then(|value| serde_json::from_value::<Message>(value.clone()).ok());

        let head = shadowed_seqs.first().copied();
        let head_message = head.and_then(|seq| derive_node_message(events.as_slice(), seq));
        if start_idx == 0 && head_message.as_ref().map(|message| message.role) == Some(Role::System)
        {
            let head_rewritten = replacement
                .as_ref()
                .map(|message| message.role == Role::System)
                .unwrap_or(false);
            if !head_rewritten || shadowed_seqs.len() != 1 {
                return Err(SessionError::SystemHeadRewrite {
                    id: handle.id.clone(),
                });
            }
        }
        for seq in &shadowed_seqs {
            let original = derive_node_message(events.as_slice(), *seq);
            if original.as_ref().map(|message| message.role) != Some(Role::Tool) {
                continue;
            }
            if replacement.as_ref().map(|message| message.role) != Some(Role::Tool) {
                continue;
            }
            let same_call = replacement
                .as_ref()
                .and_then(|message| message.tool_call_id.clone())
                == original
                    .as_ref()
                    .and_then(|message| message.tool_call_id.clone());
            if shadowed_seqs.len() != 1 || !same_call {
                return Err(SessionError::ToolResultRewrite {
                    id: handle.id.clone(),
                });
            }
        }
        Ok(())
    }

    /// How many events the session holds, which is also the next event's seq.
    pub fn count(&self, handle: &SessionHandle) -> Result<u64, SessionError> {
        let mut state = self.state.lock().expect("the store lock is never poisoned");
        self.load_locked(&mut state, handle)?;
        Ok(state
            .loaded
            .get(&handle.id)
            .map(|loaded| loaded.events.len() as u64)
            .unwrap_or(0))
    }

    /// Every event, in order, from the fold. Fails naming the line when one does not parse.
    pub fn read(&self, handle: &SessionHandle) -> Result<Events, SessionError> {
        let mut state = self.state.lock().expect("the store lock is never poisoned");
        self.load_locked(&mut state, handle)?;
        Ok(state
            .loaded
            .get(&handle.id)
            .expect("the log was just loaded")
            .events
            .clone())
    }

    /// Whether this session's transcript is stored as frames.
    pub fn framed(&self, handle: &SessionHandle) -> Result<bool, SessionError> {
        let mut state = self.state.lock().expect("the store lock is never poisoned");
        self.load_locked(&mut state, handle)?;
        Ok(state
            .loaded
            .get(&handle.id)
            .map(|loaded| loaded.framed)
            .unwrap_or(false))
    }

    /// The transcript's bytes on disk, empty when there is no file yet.
    pub fn bytes(&self, handle: &SessionHandle) -> Vec<u8> {
        std::fs::read(&handle.transcript).unwrap_or_default()
    }

    /// The surface, folded from the log and cached until the log grows.
    pub fn surface(&self, handle: &SessionHandle) -> Result<Arc<SurfaceState>, SessionError> {
        let mut state = self.state.lock().expect("the store lock is never poisoned");
        self.surface_locked(&mut state, handle)
    }

    fn surface_locked(
        &self,
        state: &mut StoreState,
        handle: &SessionHandle,
    ) -> Result<Arc<SurfaceState>, SessionError> {
        self.load_locked(state, handle)?;
        let count = state
            .loaded
            .get(&handle.id)
            .map(|loaded| loaded.events.len())
            .unwrap_or(0);
        if let Some((cached_count, cached)) = state.surface_cache.get(&handle.id)
            && *cached_count == count
        {
            return Ok(cached.clone());
        }
        let events = state
            .loaded
            .get(&handle.id)
            .expect("the log was just loaded")
            .events
            .clone();
        let folded = Arc::new(fold_surface(events.as_slice())?);
        state
            .surface_cache
            .insert(handle.id.clone(), (count, folded.clone()));
        Ok(folded)
    }

    /// One node's derived message, or `None` when the node produces none.
    pub fn derive_node(
        &self,
        handle: &SessionHandle,
        seq: u64,
    ) -> Result<Option<Message>, SessionError> {
        let events = self.read(handle)?;
        Ok(derive_node_message(events.as_slice(), seq))
    }

    /// The messages a request carries: every surface node, derived, in surface order.
    pub fn derive_messages(&self, handle: &SessionHandle) -> Result<Vec<Message>, SessionError> {
        let events = self.read(handle)?;
        let by_seq = index_by_seq(events.as_slice());
        let mut messages = Vec::new();
        for seq in self.surface(handle)?.nodes.iter().copied() {
            if let Some(message) = derive_message(&by_seq, seq) {
                messages.push(message);
            }
        }
        Ok(messages)
    }

    /// The messages a resumed session would send — the same as [`SessionStore::derive_messages`].
    pub fn messages(&self, handle: &SessionHandle) -> Result<Vec<Message>, SessionError> {
        self.derive_messages(handle)
    }

    /// Record a `message` event, and in the same meta write move `updated` and count a user turn.
    pub fn message(
        &self,
        handle: &SessionHandle,
        message: RecordedMessage,
    ) -> Result<Arc<SessionEvent>, SessionError> {
        let event = self.append(
            handle,
            NewEvent::new("message").field(
                "message",
                serde_json::to_value(&message).expect("a message is serializable"),
            ),
            AppendOptions::default(),
        )?;
        // One write for both facts: the age moved, and a user message is a turn.
        self.touch(handle, message.role == Role::User);
        Ok(event)
    }

    /// Record one streamed chunk as an `assistant/chunk` event.
    ///
    /// A `tool-call-delta` is **published, never recorded**: the listener gets a transient event
    /// (`transient: true`, the next real seq) and the log does not grow. `Ok(None)` in that case.
    pub fn assistant_chunk(
        &self,
        handle: &SessionHandle,
        chunk: &Chunk,
    ) -> Result<Option<Arc<SessionEvent>>, SessionError> {
        if matches!(chunk, Chunk::ToolCallDelta { .. }) {
            // Live-only: the complete call follows as one `tool-call` chunk, and that is the record.
            let seq = self.count(handle)?;
            let mut fields = Map::new();
            fields.insert(
                "chunk".to_string(),
                serde_json::to_value(chunk).expect("a chunk is serializable"),
            );
            fields.insert("transient".to_string(), Value::Bool(true));
            let transient = Arc::new(SessionEvent {
                seq,
                at: iso_now(),
                kind: "assistant/chunk".to_string(),
                fields,
            });
            if let Some(listener) = &self.listener {
                listener(handle, &transient);
            }
            return Ok(None);
        }
        let event = self.append(
            handle,
            NewEvent::new("assistant/chunk").field(
                "chunk",
                serde_json::to_value(chunk).expect("a chunk is serializable"),
            ),
            AppendOptions::default(),
        )?;
        Ok(Some(event))
    }

    /// Record which model call produced the answer, before it is made, as `model/request`.
    pub fn model_request(
        &self,
        handle: &SessionHandle,
        request: &ModelRequestRecord,
    ) -> Result<Arc<SessionEvent>, SessionError> {
        let Value::Object(fields) =
            serde_json::to_value(request).expect("a request record is serializable")
        else {
            unreachable!("a struct serializes to an object");
        };
        self.append(
            handle,
            NewEvent {
                kind: "model/request".to_string(),
                fields,
            },
            AppendOptions::default(),
        )
    }

    /// The `text` of the last `assistant/completed` event, `""` when there is none.
    pub fn last_answer(&self, handle: &SessionHandle) -> Result<String, SessionError> {
        let events = self.read(handle)?;
        for event in events.iter().rev() {
            if event.kind == "assistant/completed" {
                return Ok(match event.get("text") {
                    Some(Value::String(text)) => text.clone(),
                    Some(other) => other.to_string(),
                    None => String::new(),
                });
            }
        }
        Ok(String::new())
    }

    /// Record that the session was written to (`updated`), optionally counting a user turn in the same
    /// write. A meta file that cannot be read or written is ignored: losing the count must never lose
    /// the event that was just appended.
    pub fn touch(&self, handle: &SessionHandle, bump_turns: bool) {
        let Ok(text) = std::fs::read_to_string(&handle.meta) else {
            return;
        };
        let Ok(value) = serde_json::from_str::<Value>(&text) else {
            return;
        };
        let Some(mut meta) = SessionMeta::from_value(value) else {
            return;
        };
        meta.set("updated", Value::String(iso_now()));
        if bump_turns {
            meta.set("turns", Value::from(meta.turns() + 1));
        }
        let _ = crate::fsio::write_atomic(&handle.meta, meta.to_file_text());
    }
}

/// A root path with `~` expanded and made absolute, as the TypeScript constructor does.
fn resolve_root(root: &str, env: &Env) -> String {
    let expanded = expand_home(root, env);
    heddle_config::paths::resolve_from_cwd(&expanded)
        .to_string_lossy()
        .into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::Mutex as StdMutex;

    fn store() -> (tempfile::TempDir, Arc<SessionStore>) {
        let dir = tempfile::tempdir().expect("a temp directory");
        let store = Arc::new(SessionStore::new(
            dir.path().to_str().unwrap(),
            &Env::default(),
        ));
        (dir, store)
    }

    fn read_text(path: &str) -> String {
        std::fs::read_to_string(path).expect("the file is readable")
    }

    fn stamp(path: &str, created: &str) {
        let text = read_text(path);
        let value: Value = serde_json::from_str(&text).unwrap();
        let mut meta = SessionMeta::from_value(value).unwrap();
        meta.set("created", json!(created));
        std::fs::write(path, meta.to_file_text()).unwrap();
    }

    fn user(text: &str) -> RecordedMessage {
        Message {
            role: Role::User,
            tool_call_id: None,
            content: vec![crate::message::ContentPart::Text {
                text: text.to_string(),
            }],
            source: None,
        }
    }

    #[test]
    fn a_reader_never_sees_a_session_vanish_while_its_meta_is_rewritten() {
        // The server's goal route asks `meta(id)` while a resumed round rewrites the same file; a write that
        // truncates first let about 4% of those reads see no session (measured by developer-ten, 377 of 8658).
        use std::sync::atomic::{AtomicBool, Ordering};
        let (_dir, store) = store();
        let handle = store
            .create(CreateOptions {
                cwd: Some("/home/me/work".to_string()),
                ..CreateOptions::default()
            })
            .unwrap();
        let done = Arc::new(AtomicBool::new(false));
        let writer = {
            let store = Arc::clone(&store);
            let id = handle.id.clone();
            let done = Arc::clone(&done);
            std::thread::spawn(move || {
                for n in 0..1500 {
                    store.rename(&id, &format!("title {n}")).unwrap();
                }
                done.store(true, Ordering::SeqCst);
            })
        };
        let (mut reads, mut missing) = (0u64, 0u64);
        while !done.load(Ordering::SeqCst) {
            reads += 1;
            if store.meta(&handle.id).is_none() {
                missing += 1;
            }
        }
        writer.join().unwrap();
        assert!(reads > 0);
        assert_eq!(
            missing, 0,
            "{missing} of {reads} reads saw no session while its meta was rewritten"
        );
    }

    #[test]
    fn create_writes_a_record_and_an_empty_then_created_log() {
        let (_dir, store) = store();
        let handle = store
            .create(CreateOptions {
                cwd: Some("/home/me/work".to_string()),
                title: Some("First".to_string()),
                ..Default::default()
            })
            .unwrap();

        assert_eq!(handle.dir, format!("{}/--home-me-work--", store.root()));
        assert!(Path::new(&handle.meta).exists());
        assert!(Path::new(&handle.transcript).exists());
        assert!(handle.transcript.ends_with(".v2.jsonl.zstd"));

        // The record's keys are written in the TypeScript literal's order, and the time is a millisecond
        // toISOString.
        let meta_text = read_text(&handle.meta);
        let expected_start = format!("{{\n  \"id\": \"{}\",\n  \"created\": \"", handle.id);
        assert!(meta_text.starts_with(&expected_start), "{meta_text}");
        assert!(meta_text.contains(
            "\",\n  \"cwd\": \"/home/me/work\",\n  \"title\": \"First\",\n  \"turns\": 0\n}\n"
        ));

        let events = store.read(&handle).unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].kind, "session/created");
        assert_eq!(events[0].seq, 0);
        assert_eq!(events[0].get("cwd"), Some(&json!("/home/me/work")));
        assert!(store.framed(&handle).unwrap());
    }

    #[test]
    fn create_refuses_an_empty_id() {
        let (_dir, store) = store();
        let error = store
            .create(CreateOptions {
                id: Some("   ".to_string()),
                ..Default::default()
            })
            .unwrap_err();
        assert_eq!(error.to_string(), "a session id must not be empty");
    }

    #[test]
    fn an_append_leaves_every_earlier_byte_identical() {
        let (_dir, store) = store();
        let handle = store.create(CreateOptions::default()).unwrap();
        let before = store.bytes(&handle);
        store
            .message(&handle, user("remember the word loom"))
            .unwrap();
        let after = store.bytes(&handle);
        assert!(after.len() > before.len());
        assert_eq!(&after[..before.len()], &before[..]);
    }

    #[test]
    fn a_torn_tail_is_repaired_once_and_the_next_turn_is_readable() {
        let (_dir, store) = store();
        let root = store.root().to_string();
        let handle = store.create(CreateOptions::default()).unwrap();
        store
            .message(&handle, user("before the interruption"))
            .unwrap();

        // A crash stopped writing partway through the newest frame: cut five bytes off the end, inside
        // the checksum, so the walk cannot see a whole frame.
        let bytes = store.bytes(&handle);
        let first_end = crate::transcript::frame_end(&bytes, 0).expect("the first frame is whole");
        std::fs::OpenOptions::new()
            .write(true)
            .open(&handle.transcript)
            .unwrap()
            .set_len(bytes.len() as u64 - 5)
            .unwrap();
        let expected_dropped = (bytes.len() - 5 - first_end) as u64;
        assert!(expected_dropped > 0);

        // A fresh process opens the session: it decodes the file once, so the repair happens here.
        let fresh = SessionStore::new(&root, &Env::default());
        let reopened = fresh
            .open(&handle.id)
            .expect("the session is still on disk");
        let events = fresh.read(&reopened).unwrap();
        assert_eq!(
            events
                .iter()
                .map(|event| event.kind.as_str())
                .collect::<Vec<_>>(),
            vec!["session/created", "transcript/repaired"],
            "the torn frame is gone and the repair is recorded in its place"
        );
        let repaired = &events[1];
        assert_eq!(repaired.get("droppedBytes"), Some(&json!(expected_dropped)));
        // The tear is gone and the file now holds the whole first frame plus the repair event.
        let after_repair = decode_transcript(&fresh.bytes(&reopened));
        assert!(!after_repair.torn);
        assert_eq!(after_repair.frames, 2);
        assert_eq!(after_repair.readable_bytes, fresh.bytes(&reopened).len());

        // And the next turn lands and reads back, with the repair still in front of it.
        fresh
            .append(
                &reopened,
                NewEvent::new("turn/completed"),
                AppendOptions::default(),
            )
            .unwrap();
        let events = fresh.read(&reopened).unwrap();
        assert_eq!(events.last().unwrap().kind, "turn/completed");
        let decoded = decode_transcript(&fresh.bytes(&reopened));
        assert!(
            !decoded.torn,
            "the record no longer ends in a half-written frame"
        );
        assert_eq!(decoded.readable_bytes, fresh.bytes(&reopened).len());
    }

    #[test]
    fn a_legacy_plain_log_is_read_and_still_appended_plain() {
        let (dir, store) = store();
        // The old layout: <root>/<id>/{meta.json, session.jsonl}, written by an older build.
        let id = "session-legacy";
        let legacy_dir = Path::new(dir.path()).join(id);
        std::fs::create_dir_all(&legacy_dir).unwrap();
        let created = "2026-10-22T18:17:41.123Z";
        std::fs::write(
            legacy_dir.join("meta.json"),
            format!(
                "{{\n  \"id\": \"{id}\",\n  \"created\": \"{created}\",\n  \"cwd\": \"/old/folder\",\n  \"turns\": 1\n}}\n"
            ),
        )
        .unwrap();
        std::fs::write(
            legacy_dir.join("session.jsonl"),
            "{\"seq\":0,\"at\":\"2026-10-22T18:17:41.123Z\",\"type\":\"session/created\",\"cwd\":\"/old/folder\"}\n",
        )
        .unwrap();

        let handle = store.open(id).expect("the legacy session opens");
        assert!(handle.transcript.ends_with("session.jsonl"));
        assert_eq!(store.read(&handle).unwrap().len(), 1);
        assert!(!store.framed(&handle).unwrap());

        store
            .append(
                &handle,
                NewEvent::new("turn/completed"),
                AppendOptions::default(),
            )
            .unwrap();
        let text = String::from_utf8(store.bytes(&handle)).expect("the log is still plain text");
        assert!(text.ends_with("\"type\":\"turn/completed\"}\n"));
    }

    #[test]
    fn the_list_holds_both_layouts_newest_first_without_duplicates() {
        let (_dir, store) = store();
        let older = store
            .create(CreateOptions {
                cwd: Some("/a".to_string()),
                id: Some("session-older".to_string()),
                ..Default::default()
            })
            .unwrap();
        let newer = store
            .create(CreateOptions {
                cwd: Some("/b".to_string()),
                id: Some("session-newer".to_string()),
                ..Default::default()
            })
            .unwrap();
        // Make the order unambiguous, because two creations can share a millisecond.
        stamp(&older.meta, "2026-10-22T18:00:00.000Z");
        stamp(&newer.meta, "2026-10-22T19:00:00.000Z");

        let listed = store.list();
        let ids: Vec<&str> = listed.iter().map(SessionMeta::id).collect();
        assert_eq!(ids, vec!["session-newer", "session-older"]);
        assert_eq!(
            store
                .list()
                .iter()
                .filter(|meta| meta.id() == "session-newer")
                .count(),
            1
        );
    }

    #[test]
    fn a_record_that_is_not_metadata_is_skipped() {
        let (dir, store) = store();
        store.create(CreateOptions::default()).unwrap();
        let junk = Path::new(dir.path()).join("--junk--");
        std::fs::create_dir_all(&junk).unwrap();
        std::fs::write(junk.join("session-nope.json"), "not json").unwrap();
        std::fs::write(junk.join("session-also-nope.json"), "{\"no\":\"id\"}").unwrap();
        assert_eq!(store.list().len(), 1);
    }

    #[test]
    fn pinning_records_a_time_and_unpinning_removes_both() {
        let (_dir, store) = store();
        let handle = store.create(CreateOptions::default()).unwrap();
        let pinned = store
            .flags(
                &handle.id,
                FlagPatch {
                    pinned: Some(true),
                    archived: None,
                },
            )
            .unwrap()
            .expect("the session exists");
        assert!(pinned.pinned());
        assert!(pinned.pinned_at().is_some());
        assert!(read_text(&handle.meta).contains("\"pinnedAt\""));

        let unpinned = store
            .flags(
                &handle.id,
                FlagPatch {
                    pinned: Some(false),
                    archived: None,
                },
            )
            .unwrap()
            .unwrap();
        assert!(!unpinned.pinned());
        assert!(!read_text(&handle.meta).contains("pinned"));
    }

    #[test]
    fn archiving_drops_the_pin_and_a_pin_on_an_archived_session_is_refused() {
        let (_dir, store) = store();
        let handle = store.create(CreateOptions::default()).unwrap();
        store
            .flags(
                &handle.id,
                FlagPatch {
                    pinned: Some(true),
                    archived: None,
                },
            )
            .unwrap();
        let archived = store
            .flags(
                &handle.id,
                FlagPatch {
                    pinned: None,
                    archived: Some(true),
                },
            )
            .unwrap()
            .unwrap();
        assert!(archived.archived());
        assert!(!archived.pinned());
        assert_eq!(archived.pinned_at(), None);

        let error = store
            .flags(
                &handle.id,
                FlagPatch {
                    pinned: Some(true),
                    archived: None,
                },
            )
            .unwrap_err();
        assert_eq!(
            error.to_string(),
            format!("session {} is archived and cannot be pinned", handle.id)
        );
    }

    #[test]
    fn the_model_selection_replaces_the_previous_one() {
        let (_dir, store) = store();
        let handle = store.create(CreateOptions::default()).unwrap();
        store
            .set_model(
                &handle.id,
                ModelSelection {
                    endpoint: "alpha".to_string(),
                    model: Some("m1".to_string()),
                    reasoning_effort: Some("high".to_string()),
                },
            )
            .unwrap()
            .unwrap();
        let switched = store
            .set_model(
                &handle.id,
                ModelSelection {
                    endpoint: "beta".to_string(),
                    model: None,
                    reasoning_effort: Some("  ".to_string()),
                },
            )
            .unwrap()
            .unwrap();
        assert_eq!(switched.endpoint(), Some("beta"));
        assert_eq!(
            switched.model(),
            None,
            "the old model belonged to the old endpoint"
        );
        assert_eq!(switched.reasoning_effort(), None);
        let text = read_text(&handle.meta);
        assert!(!text.contains("\"model\""));
        assert!(!text.contains("reasoningEffort"));
    }

    fn note(role: &str, text: &str) -> NewEvent {
        NewEvent::new("context/note").field(
            "message",
            json!({"role": role, "content": [{"type": "text", "text": text}]}),
        )
    }

    #[test]
    fn a_replacement_may_not_rewrite_the_system_head_with_a_user_message() {
        let (_dir, store) = store();
        let handle = store.create(CreateOptions::default()).unwrap();
        store
            .append(&handle, note("system", "prompt"), AppendOptions::default())
            .unwrap();
        let error = store
            .append(
                &handle,
                NewEvent::new("message").field(
                    "message",
                    json!({"role": "user", "content": [{"type": "text", "text": "hijack"}]}),
                ),
                AppendOptions {
                    surface_op: Some(SurfaceOp::Replace {
                        start_seq: 1,
                        end_seq: 1,
                    }),
                    source_event_seqs: None,
                },
            )
            .unwrap_err();
        assert!(matches!(error, SessionError::SystemHeadRewrite { .. }));
        // Nothing was written: the failed append left the log as it was.
        assert_eq!(store.count(&handle).unwrap(), 2);
    }

    #[test]
    fn a_system_message_may_rewrite_exactly_the_head() {
        let (_dir, store) = store();
        let handle = store.create(CreateOptions::default()).unwrap();
        store
            .append(&handle, note("system", "prompt"), AppendOptions::default())
            .unwrap();
        let rewritten = store
            .append(
                &handle,
                note("system", "better prompt"),
                AppendOptions {
                    surface_op: Some(SurfaceOp::Replace {
                        start_seq: 1,
                        end_seq: 1,
                    }),
                    source_event_seqs: None,
                },
            )
            .unwrap();
        assert_eq!(rewritten.seq, 2);
        let surface = store.surface(&handle).unwrap();
        assert_eq!(surface.nodes, vec![2]);
        assert!(matches!(
            surface.replacements.as_slice(),
            [only] if only.shadowed_seqs == vec![1]
        ));
    }

    #[test]
    fn a_replacement_is_written_after_the_fields_it_shadows() {
        let (_dir, store) = store();
        let handle = store.create(CreateOptions::default()).unwrap();
        store
            .append(&handle, note("system", "prompt"), AppendOptions::default())
            .unwrap();
        store
            .append(
                &handle,
                note("system", "better prompt"),
                AppendOptions {
                    surface_op: Some(SurfaceOp::Replace {
                        start_seq: 1,
                        end_seq: 1,
                    }),
                    source_event_seqs: Some(vec![1]),
                },
            )
            .unwrap();
        let line = store.read(&handle).unwrap().last().unwrap().to_line();
        // `surfaceOp` and `sourceEventSeqs` are written after the event's own fields, as the store does.
        assert!(line.contains("\"message\":{"));
        assert!(line.contains("\"surfaceOp\":{\"op\":\"replace\",\"startSeq\":1,\"endSeq\":1}"));
        assert!(line.ends_with(",\"sourceEventSeqs\":[1]}"));
    }

    #[test]
    fn a_tool_result_may_be_rewritten_only_by_the_same_call() {
        let (_dir, store) = store();
        let handle = store.create(CreateOptions::default()).unwrap();
        let tool = |id: &str| json!({"role": "tool", "toolCallId": id, "content": [{"type": "text", "text": "ok"}]});
        store
            .append(
                &handle,
                NewEvent::new("message").field("message", tool("call-1")),
                AppendOptions::default(),
            )
            .unwrap();
        let replace = || AppendOptions {
            surface_op: Some(SurfaceOp::Replace {
                start_seq: 1,
                end_seq: 1,
            }),
            source_event_seqs: None,
        };

        let mismatched = store
            .append(
                &handle,
                NewEvent::new("message").field("message", tool("call-2")),
                replace(),
            )
            .unwrap_err();
        assert!(matches!(mismatched, SessionError::ToolResultRewrite { .. }));

        let same = store
            .append(
                &handle,
                NewEvent::new("message").field("message", tool("call-1")),
                replace(),
            )
            .unwrap();
        assert_eq!(same.seq, 2);
    }

    #[test]
    fn a_range_that_is_not_a_span_is_refused_before_anything_is_written() {
        let (_dir, store) = store();
        let handle = store.create(CreateOptions::default()).unwrap();
        let error = store
            .append(
                &handle,
                NewEvent::new("message").field(
                    "message",
                    json!({"role": "user", "content": [{"type": "text", "text": "x"}]}),
                ),
                AppendOptions {
                    surface_op: Some(SurfaceOp::Replace {
                        start_seq: 1,
                        end_seq: 9,
                    }),
                    source_event_seqs: None,
                },
            )
            .unwrap_err();
        assert_eq!(
            error.to_string(),
            format!(
                "session {}: replacement range 1..9 is not a span of the surface",
                handle.id
            )
        );
        assert_eq!(store.count(&handle).unwrap(), 1);
    }

    #[test]
    fn only_a_surface_eligible_event_can_replace_a_range() {
        let (_dir, store) = store();
        let handle = store.create(CreateOptions::default()).unwrap();
        let error = store
            .append(
                &handle,
                NewEvent::new("turn/completed"),
                AppendOptions {
                    surface_op: Some(SurfaceOp::Replace {
                        start_seq: 0,
                        end_seq: 0,
                    }),
                    source_event_seqs: None,
                },
            )
            .unwrap_err();
        assert_eq!(
            error.to_string(),
            format!(
                "session {}: \"turn/completed\" is not surface-eligible and cannot replace a range",
                handle.id
            )
        );
    }

    #[test]
    fn a_user_message_counts_a_turn_and_moves_the_age() {
        let (_dir, store) = store();
        let handle = store.create(CreateOptions::default()).unwrap();
        assert_eq!(store.list()[0].turns(), 0);
        store.message(&handle, user("one")).unwrap();
        let meta = store.list().into_iter().next().unwrap();
        assert_eq!(meta.turns(), 1);
        assert!(meta.updated().is_some());

        // An assistant message moves the age but is not a user turn.
        store
            .message(
                &handle,
                Message {
                    role: Role::Assistant,
                    tool_call_id: None,
                    content: vec![crate::message::ContentPart::Text {
                        text: "two".to_string(),
                    }],
                    source: None,
                },
            )
            .unwrap();
        assert_eq!(store.list()[0].turns(), 1);
    }

    #[test]
    fn the_listener_hears_an_event_only_after_it_is_on_disk() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap().to_string();
        let seen: Arc<StdMutex<Vec<(u64, usize)>>> = Arc::new(StdMutex::new(Vec::new()));
        let recorder = seen.clone();
        let listener: EventListener = Arc::new(move |handle, event| {
            // The file already has the event by the time this runs.
            let bytes = std::fs::read(&handle.transcript).unwrap_or_default();
            recorder.lock().unwrap().push((event.seq, bytes.len()));
        });
        let store = SessionStore::with_listener(&root, &Env::default(), listener);
        store.create(CreateOptions::default()).unwrap();
        let seen_now = seen.lock().unwrap().clone();
        assert_eq!(seen_now.len(), 1);
        assert_eq!(seen_now[0].0, 0);
        assert!(seen_now[0].1 > 0);
    }

    #[test]
    fn a_tool_call_delta_is_published_but_never_recorded() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap().to_string();
        let seen: Arc<StdMutex<Vec<(u64, bool)>>> = Arc::new(StdMutex::new(Vec::new()));
        let recorder = seen.clone();
        let listener: EventListener = Arc::new(move |_, event| {
            recorder
                .lock()
                .unwrap()
                .push((event.seq, event.is_transient()));
        });
        let store = SessionStore::with_listener(&root, &Env::default(), listener);
        let handle = store.create(CreateOptions::default()).unwrap();
        let wrote = store
            .assistant_chunk(
                &handle,
                &Chunk::ToolCallDelta {
                    index: 0,
                    id: None,
                    name: None,
                    arguments_delta: "{\"pa".to_string(),
                },
            )
            .unwrap();
        assert!(wrote.is_none(), "it is not recorded");
        assert_eq!(store.count(&handle).unwrap(), 1, "the log did not grow");
        let seen_now = seen.lock().unwrap().clone();
        assert_eq!(
            seen_now.len(),
            2,
            "the created event and the delta both reached the listener"
        );
        assert!(seen_now[1].1, "the delta is marked transient");
        assert_eq!(seen_now[1].0, 1, "its seq is the next real one");
    }

    #[test]
    fn a_chunk_run_reads_back_as_one_assistant_message() {
        let (_dir, store) = store();
        let handle = store.create(CreateOptions::default()).unwrap();
        for chunk in [
            Chunk::TextDelta {
                text: "loom".to_string(),
            },
            Chunk::Done {
                finish_reason: "stop".to_string(),
                usage: None,
            },
        ] {
            store.assistant_chunk(&handle, &chunk).unwrap();
        }
        let messages = store.messages(&handle).unwrap();
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].role, Role::Assistant);
        assert_eq!(crate::message::text_of(&messages[0].content), "loom");
    }

    #[test]
    fn the_last_answer_is_the_last_completed_one() {
        let (_dir, store) = store();
        let handle = store.create(CreateOptions::default()).unwrap();
        store
            .append(
                &handle,
                NewEvent::new("assistant/completed").field("text", "first"),
                AppendOptions::default(),
            )
            .unwrap();
        assert_eq!(store.last_answer(&handle).unwrap(), "first");
        store
            .append(
                &handle,
                NewEvent::new("assistant/completed").field("text", "second"),
                AppendOptions::default(),
            )
            .unwrap();
        assert_eq!(store.last_answer(&handle).unwrap(), "second");
    }

    #[test]
    fn a_fork_copies_the_projection_and_records_its_parent() {
        let (_dir, store) = store();
        let source = store
            .create(CreateOptions {
                cwd: Some("/work".to_string()),
                title: Some("Source".to_string()),
                model: Some("m".to_string()),
                ..Default::default()
            })
            .unwrap();
        store.message(&source, user("question")).unwrap();
        store
            .message(
                &source,
                Message {
                    role: Role::Assistant,
                    tool_call_id: None,
                    content: vec![crate::message::ContentPart::Text {
                        text: "answer".to_string(),
                    }],
                    source: None,
                },
            )
            .unwrap();
        store
            .append(
                &source,
                NewEvent::new("turn/completed"),
                AppendOptions::default(),
            )
            .unwrap();
        // A dangling prompt after the boundary is not inherited.
        store.message(&source, user("dangling")).unwrap();

        let fork = store
            .fork(
                &source.id,
                ForkAttribution {
                    parent_session: Some(source.id.clone()),
                    title: Some("Source (1)".to_string()),
                    ..Default::default()
                },
            )
            .unwrap()
            .expect("the source exists");
        assert_ne!(fork.id, source.id);

        let meta = store
            .list()
            .into_iter()
            .find(|meta| meta.id() == fork.id)
            .unwrap();
        assert_eq!(meta.cwd(), "/work");
        assert_eq!(meta.model(), Some("m"));
        assert_eq!(meta.parent_session(), Some(source.id.as_str()));
        assert_eq!(meta.title(), Some("Source (1)"));

        let messages = store.messages(&fork).unwrap();
        let texts: Vec<String> = messages
            .iter()
            .map(|message| crate::message::text_of(&message.content))
            .collect();
        assert_eq!(
            texts,
            vec!["question", "answer"],
            "the dangling prompt is not copied"
        );
    }

    #[test]
    fn a_fork_keeps_a_harness_note_a_note_and_counts_the_same_turns() {
        // R-developer-eight-15: the fork re-appended the runtime-context snapshot as a user `message`, so the
        // child's chat drew it as a bubble and counted one turn more than its source. DSH's fork seed keeps
        // the source's own events (dsh-session/lib/types/fork.js:18-27).
        const SNAPSHOT: &str =
            "Current runtime context. This snapshot supersedes earlier runtime-context snapshots.";
        let (_dir, store) = store();
        let source = store
            .create(CreateOptions {
                title: Some("Source".to_string()),
                ..Default::default()
            })
            .unwrap();
        let appended = || AppendOptions {
            surface_op: Some(SurfaceOp::Append),
            ..Default::default()
        };
        let answer = |text: &str| Message {
            role: Role::Assistant,
            ..user(text)
        };
        store
            .append(
                &source,
                NewEvent::new("context/note")
                    .field(
                        "message",
                        json!({"role": "system", "content": [{"type": "text", "text": "you are heddle"}]}),
                    )
                    .field("origin", "system-prompt"),
                appended(),
            )
            .unwrap();
        store.message(&source, user("first question")).unwrap();
        store
            .append(
                &source,
                NewEvent::new("context/note")
                    .field(
                        "message",
                        json!({"role": "user", "content": [{"type": "text", "text": SNAPSHOT}], "source": {"kind": "runtime-context"}}),
                    )
                    .field("origin", "runtime-context")
                    .field("identity", SNAPSHOT),
                appended(),
            )
            .unwrap();
        store.message(&source, answer("answer one")).unwrap();
        store
            .append(
                &source,
                NewEvent::new("turn/completed"),
                AppendOptions::default(),
            )
            .unwrap();
        store.message(&source, user("second question")).unwrap();
        store.message(&source, answer("answer two")).unwrap();
        store
            .append(
                &source,
                NewEvent::new("turn/completed"),
                AppendOptions::default(),
            )
            .unwrap();

        let fork = store
            .fork(
                &source.id,
                ForkAttribution {
                    parent_session: Some(source.id.clone()),
                    ..Default::default()
                },
            )
            .unwrap()
            .expect("the source exists");
        let events = store.read(&fork).unwrap();

        let prompts: Vec<String> = events
            .iter()
            .filter(|event| event.kind == "message")
            .filter(|event| {
                event.get("message").and_then(|m| m.get("role")) == Some(&json!("user"))
            })
            .map(|event| event.get("message").unwrap()["content"][0]["text"].to_string())
            .collect();
        assert_eq!(
            prompts,
            vec!["\"first question\"", "\"second question\""],
            "no message carries the snapshot"
        );
        let turns = |id: &str| {
            store
                .list()
                .into_iter()
                .find(|meta| meta.id() == id)
                .unwrap()
                .turns()
        };
        assert_eq!(
            turns(&fork.id),
            turns(&source.id),
            "the child counts as many turns"
        );

        let notes: Vec<&Arc<SessionEvent>> = events
            .iter()
            .filter(|event| event.kind == "context/note")
            .collect();
        assert_eq!(notes.len(), 1, "the snapshot came across as one note");
        assert_eq!(notes[0].get("origin"), Some(&json!("runtime-context")));
        assert_eq!(notes[0].get("identity"), Some(&json!(SNAPSHOT)));
        assert_eq!(
            notes[0].get("surfaceOp"),
            None,
            "the source's positions stay behind"
        );
        assert!(
            !events
                .iter()
                .any(|event| event.to_line().contains("you are heddle")),
            "the system prompt is not inherited"
        );

        let texts: Vec<String> = store
            .messages(&fork)
            .unwrap()
            .iter()
            .map(|message| crate::message::text_of(&message.content))
            .collect();
        assert_eq!(
            texts,
            vec![
                "first question",
                SNAPSHOT,
                "answer one",
                "second question",
                "answer two"
            ],
            "the model still reads what the source's model read"
        );
    }

    #[test]
    fn a_snapshot_handed_out_before_an_append_does_not_grow() {
        let (_dir, store) = store();
        let handle = store.create(CreateOptions::default()).unwrap();
        let snapshot = store.read(&handle).unwrap();
        store
            .append(
                &handle,
                NewEvent::new("turn/completed"),
                AppendOptions::default(),
            )
            .unwrap();
        assert_eq!(snapshot.len(), 1, "a snapshot is a snapshot");
        assert_eq!(store.read(&handle).unwrap().len(), 2);
    }

    #[test]
    fn the_surface_is_cached_until_the_log_grows() {
        let (_dir, store) = store();
        let handle = store.create(CreateOptions::default()).unwrap();
        let first = store.surface(&handle).unwrap();
        let again = store.surface(&handle).unwrap();
        assert!(Arc::ptr_eq(&first, &again));
        store
            .append(
                &handle,
                NewEvent::new("turn/completed"),
                AppendOptions::default(),
            )
            .unwrap();
        let after = store.surface(&handle).unwrap();
        assert!(!Arc::ptr_eq(&first, &after));
        assert_eq!(
            *after,
            SurfaceState::default(),
            "the boundary takes no position"
        );
    }

    #[test]
    fn the_record_is_read_straight_from_its_file() {
        let (_dir, store) = store();
        let handle = store.create(CreateOptions::default()).unwrap();
        let meta = store.meta(&handle.id).expect("the record exists");
        assert_eq!(meta.id(), handle.id);
        assert_eq!(meta.turns(), 0);
        store.rename(&handle.id, "Named").unwrap();
        assert_eq!(
            store.meta(&handle.id).unwrap().title(),
            Some("Named"),
            "the accessor reads what is on disk now"
        );
        assert!(store.meta("session-nope").is_none());
    }

    #[test]
    fn appends_from_several_threads_keep_one_contiguous_sequence() {
        let (_dir, store) = store();
        let handle = store.create(CreateOptions::default()).unwrap();
        let threads: Vec<std::thread::JoinHandle<()>> = (0..4)
            .map(|worker| {
                let store = store.clone();
                let handle = handle.clone();
                std::thread::spawn(move || {
                    for round in 0..25u64 {
                        store
                            .append(
                                &handle,
                                NewEvent::new("turn/retry")
                                    .field("worker", worker)
                                    .field("round", round),
                                AppendOptions::default(),
                            )
                            .expect("an append inside the lock");
                    }
                })
            })
            .collect();
        for thread in threads {
            thread.join().expect("a writer thread");
        }

        // 1 creation + 4 x 25, with no hole and no duplicate, because the seq is assigned and written
        // under the store's one lock.
        let events = store.read(&handle).unwrap();
        assert_eq!(events.len(), 101);
        let seqs: Vec<u64> = events.iter().map(|event| event.seq).collect();
        assert_eq!(seqs, (0..=100u64).collect::<Vec<_>>());
        // And the file has every one of them, whole: a concurrent writer cannot tear a frame.
        let decoded = decode_transcript(&store.bytes(&handle));
        assert_eq!(decoded.frames, 101);
        assert!(!decoded.torn);
        assert_eq!(decoded.readable_bytes, store.bytes(&handle).len());
    }

    /// R-developer-eight-27: a `heddle web` server held a session while `heddle --resume <id> --turn` appended
    /// to it from another process, and the log got seqs 14-19 twice. The other process here is a real one,
    /// named in the lock file exactly as either build writes it (`<pid>\n`), and its append is written to the
    /// log the way its store would write it.
    #[cfg(unix)]
    #[test]
    fn a_second_process_cannot_append_while_the_holder_lives_and_takes_over_once_it_is_gone() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap().to_string();
        let handle = {
            let first = SessionStore::new(&root, &Env::default());
            let handle = first
                .create(CreateOptions {
                    cwd: Some("/home/me/work".to_string()),
                    ..Default::default()
                })
                .unwrap();
            first
                .message(&handle, user("remember the word loom"))
                .unwrap();
            handle
        };
        let lock = Path::new(&handle.dir).join(format!("{}.lock", handle.id));

        // The other process: alive, and named in the session's lock file.
        let mut holder = std::process::Command::new("sleep")
            .arg("30")
            .spawn()
            .expect("a second process");
        std::fs::write(&lock, format!("{}\n", holder.id())).unwrap();

        // This process reads the session first, so its fold is loaded before the holder writes again.
        let store = SessionStore::new(&root, &Env::default());
        let reopened = store.open(&handle.id).expect("the session is on disk");
        assert_eq!(store.read(&reopened).unwrap().len(), 2);

        // The holder appends seq 2, as its own store would.
        let theirs = SessionEvent {
            seq: 2,
            at: iso_now(),
            kind: "test/holder".to_string(),
            fields: Map::new(),
        };
        std::fs::OpenOptions::new()
            .append(true)
            .open(&handle.transcript)
            .unwrap()
            .write_all(&encode_frame(&format!("{}\n", theirs.to_line())))
            .unwrap();
        let before = store.bytes(&reopened);

        // The defect: this append used to succeed with seq 2, a seq the holder had already written.
        let refused = store.append(
            &reopened,
            NewEvent::new("test/intruder"),
            AppendOptions::default(),
        );
        let message = refused
            .expect_err("a second writer is refused while the holder is alive")
            .to_string();
        assert_eq!(
            message,
            format!(
                "session \"{}\" is already owned by an active write handle (process {})",
                handle.id,
                holder.id()
            )
        );
        assert_eq!(
            store.bytes(&reopened),
            before,
            "and the refusal wrote nothing to the log"
        );

        // The holder dies without letting go: its lock names a pid that no longer exists.
        holder.kill().unwrap();
        holder.wait().unwrap();
        let taken = store
            .append(
                &reopened,
                NewEvent::new("test/successor"),
                AppendOptions::default(),
            )
            .expect("a lock whose holder is gone does not block the next writer");
        assert_eq!(
            taken.seq, 3,
            "the successor continues after the holder's last event, not from its own stale count"
        );
        let seqs: Vec<u64> = decode_transcript(&store.bytes(&reopened))
            .lines
            .iter()
            .map(|line| SessionEvent::from_line(line).unwrap().seq)
            .collect();
        assert_eq!(seqs, vec![0, 1, 2, 3], "no seq is written twice");
        assert_eq!(
            store
                .read(&reopened)
                .unwrap()
                .iter()
                .map(|event| event.kind.as_str())
                .collect::<Vec<_>>(),
            vec![
                "session/created",
                "message",
                "test/holder",
                "test/successor"
            ],
            "and this process now sees the history the file holds"
        );
        assert_eq!(
            std::fs::read_to_string(&lock).unwrap(),
            format!("{}\n", std::process::id()),
            "the stale lock was replaced by one naming this process"
        );
    }

    #[test]
    fn the_lock_is_a_file_beside_the_log_naming_its_holder_and_letting_go_removes_it() {
        let (_dir, store) = store();
        let handle = store.create(CreateOptions::default()).unwrap();
        let lock = Path::new(&handle.dir).join(format!("{}.lock", handle.id));
        assert_eq!(lock_path(&handle), lock.to_string_lossy());
        assert!(store.holds(&handle), "the first append took the lock");
        // The TypeScript build's contents, byte for byte: the holder's pid and a newline.
        assert_eq!(
            std::fs::read_to_string(&lock).unwrap(),
            format!("{}\n", std::process::id())
        );
        store.release(&handle);
        assert!(!store.holds(&handle));
        assert!(!lock.exists(), "letting go removes the lock");

        // A later append takes it again, and a store that goes away lets go of what it held.
        store
            .append(
                &handle,
                NewEvent::new("turn/completed"),
                AppendOptions::default(),
            )
            .unwrap();
        assert!(lock.exists());
        drop(store);
        assert!(!lock.exists(), "dropping the store let go");

        // An old-layout session keeps DSH's own name inside its directory.
        let legacy = SessionHandle {
            id: "session-old".to_string(),
            dir: "/tmp/sessions/session-old".to_string(),
            transcript: "/tmp/sessions/session-old/session.jsonl".to_string(),
            meta: "/tmp/sessions/session-old/meta.json".to_string(),
        };
        assert_eq!(lock_path(&legacy), "/tmp/sessions/session-old/session.lock");
    }

    #[test]
    fn open_newest_answers_the_newest_record() {
        let (_dir, store) = store();
        let older = store
            .create(CreateOptions {
                id: Some("session-older".to_string()),
                ..Default::default()
            })
            .unwrap();
        let newer = store
            .create(CreateOptions {
                id: Some("session-newer".to_string()),
                ..Default::default()
            })
            .unwrap();
        stamp(&older.meta, "2026-10-22T18:00:00.000Z");
        stamp(&newer.meta, "2026-10-22T19:00:00.000Z");
        assert_eq!(
            store.open_newest().map(|handle| handle.id),
            Some("session-newer".to_string())
        );
    }

    #[test]
    fn the_default_root_follows_heddle_home() {
        let env = Env::from_pairs([("HEDDLE_HOME", "/tmp/hd-home")]);
        assert_eq!(default_session_root(&env), "/tmp/hd-home/sessions");
        let env = Env::from_pairs([("HOME", "/tmp/hd-user")]);
        assert_eq!(default_session_root(&env), "/tmp/hd-user/.heddle/sessions");
    }

    /// Bytes produced by **Node 24's `zlib.zstdCompressSync`** with `ZSTD_c_checksumFlag`, one frame per
    /// event, from `JSON.stringify(event) + "\n"` — i.e. exactly what the TypeScript store writes.
    const TS_FRAMES: [&str; 3] = [
        "28b52ffd2459a502009205141a604bdcb31854036cb87bb938e092404b1aba4bf6076408fc583cc8e389c61ef2425eec80dfab975eaed8216e09150cd1cdfd3d2f1aeee506806692811de412b2a06a4e1a811efddea197b36770df1100b5323edc",
        "28b52ffd2491ad030042c7181c606d73e0e928ec8758946e30270e53142c60bab534e38553a2b2200f8028424466aa4f5a348da43736b527d8d99b7325df77482ff4855461e5760779b4f9a5f2198e73674edf31592b1b1a01134026072b09ab80a82c4b697041a7d7b15ae9c79d5f0500aa0047084456147e06a82dca1eb5079677",
        "28b52ffd24421102007b22736571223a322c226174223a22323032362d31302d32325431383a31373a34332e3738395a222c2274797065223a227475726e2f636f6d706c65746564227d0a46606e66",
    ];

    /// The three lines the TypeScript build wrote into those frames.
    const TS_LINES: [&str; 3] = [
        r#"{"seq":0,"at":"2026-10-22T18:17:41.123Z","type":"session/created","cwd":"/home/me/work"}"#,
        r#"{"seq":1,"at":"2026-10-22T18:17:42.456Z","type":"message","message":{"role":"user","content":[{"type":"text","text":"remember the word loom"}]}}"#,
        r#"{"seq":2,"at":"2026-10-22T18:17:43.789Z","type":"turn/completed"}"#,
    ];

    fn unhex(text: &str) -> Vec<u8> {
        assert!(text.len().is_multiple_of(2));
        (0..text.len())
            .step_by(2)
            .map(|at| u8::from_str_radix(&text[at..at + 2], 16).unwrap())
            .collect()
    }

    #[test]
    fn a_log_written_by_the_typescript_build_reads_here() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap().to_string();
        // The workspace-folder layout, as the TypeScript store files it.
        let folder = Path::new(&root).join("--home-me-work--");
        std::fs::create_dir_all(&folder).unwrap();
        let mut bytes = Vec::new();
        for frame in TS_FRAMES {
            bytes.extend(unhex(frame));
        }
        std::fs::write(folder.join("session-ts.v2.jsonl.zstd"), &bytes).unwrap();
        std::fs::write(
            folder.join("session-ts.json"),
            "{\n  \"id\": \"session-ts\",\n  \"created\": \"2026-10-22T18:17:41.123Z\",\n  \"cwd\": \"/home/me/work\",\n  \"turns\": 1\n}\n",
        )
        .unwrap();

        let store = SessionStore::new(&root, &Env::default());
        let handle = store.open("session-ts").expect("the TypeScript log opens");
        assert!(
            store.framed(&handle).unwrap(),
            "the log is frames, not plain text"
        );
        let events = store.read(&handle).unwrap();
        assert_eq!(
            events
                .iter()
                .map(|event| event.kind.as_str())
                .collect::<Vec<_>>(),
            vec!["session/created", "message", "turn/completed"]
        );
        assert_eq!(
            events[0].to_line(),
            TS_LINES[0],
            "the bytes are unchanged by a read"
        );
        assert_eq!(events[1].to_line(), TS_LINES[1]);
        assert_eq!(events[2].to_line(), TS_LINES[2]);
        assert_eq!(
            crate::message::text_of(
                &serde_json::from_value::<Message>(events[1].get("message").unwrap().clone())
                    .unwrap()
                    .content
            ),
            "remember the word loom"
        );
        // The surface sees the message and gives the turn boundary no position.
        assert_eq!(store.surface(&handle).unwrap().nodes, vec![1]);

        // Appending leaves the TypeScript bytes as an untouched prefix.
        store
            .append(
                &handle,
                NewEvent::new("turn/completed"),
                AppendOptions::default(),
            )
            .unwrap();
        let after = store.bytes(&handle);
        assert!(after.len() > bytes.len());
        assert_eq!(&after[..bytes.len()], &bytes[..]);
        assert_eq!(decode_transcript(&after).frames, 4);
        assert!(!decode_transcript(&after).torn);
    }

    #[test]
    fn every_typescript_line_prints_back_unchanged() {
        for line in TS_LINES {
            let event = SessionEvent::from_line(line).expect("a line the TypeScript build wrote");
            assert_eq!(
                event.to_line(),
                line,
                "an event survives the round trip byte for byte"
            );
        }
    }

    #[test]
    fn a_root_with_a_tilde_is_expanded_and_made_absolute() {
        let env = Env::from_pairs([("HOME", "/tmp/hd-user")]);
        let store = SessionStore::new("~/sessions", &env);
        assert_eq!(store.root(), "/tmp/hd-user/sessions");
    }
}
