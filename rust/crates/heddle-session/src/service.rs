//! The session service: the face over the store that the loop, the command line and the server call.
//!
//! Ported from `src/session/service.ts` and `src/plugins/session.ts`. The TypeScript build makes it a
//! Cordis service whose every append is re-emitted as `session/event`; here it is a plain struct built
//! from [`SessionConfig`] and an optional [`EventListener`], and the boot passes a listener that emits into
//! the event bus. The store stays usable without the service, which is what lets it be tested alone.
//!
//! The rules that live here rather than in the store: **one folder, one session** (a folder's session
//! is the newest one whose `cwd` is that folder), the **title from the first message**, the **fork
//! name** `<title> (n)`, and the **mode change** that appends nothing when nothing changes.

use std::path::Path;
use std::sync::Arc;

use heddle_config::{Env, canonical_path};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::clock::iso_now;
use crate::definition::{
    CreatedDefinition, DefinitionOptions, ensure_sessions_folder, existing_session_names,
    write_session_definition,
};
use crate::error::SessionError;
use crate::event::{Events, NewEvent, SessionEvent, SessionHandle};
use crate::message::{ContentPart, Message, Role, text_of};
use crate::meta::{CreateOptions, FlagPatch, ForkAttribution, ModelSelection, SessionMeta};
use crate::mode::{
    MODE_EVENT, effective_mode as fold_effective_mode, recorded_mode as fold_recorded_mode,
};
use crate::repair::interrupted_turn_closers;
use crate::store::{EventListener, SessionStore, default_session_root};
use crate::surface::{SurfaceState, inherits_answer};

/// The session plugin's configuration row: `{ root }`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
pub struct SessionConfig {
    /// Where sessions live; [`crate::default_session_root`] when `None`. `--session-root` restates it.
    pub root: Option<String>,
}

/// What `start` is told: resume an id, or create a session with these fields.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct StartOptions {
    pub resume: Option<String>,
    pub cwd: Option<String>,
    pub endpoint: Option<String>,
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
    pub title: Option<String>,
    /// The agent preset a new session runs under (inventory A96); ignored when resuming, since a session keeps
    /// its own.
    pub preset: Option<String>,
}

/// What `open_at` is told. `fresh` starts a new session even when the folder has one (`--new`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct OpenAtOptions {
    pub fresh: bool,
    pub endpoint: Option<String>,
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
    pub title: Option<String>,
    /// The agent preset a session this call creates runs under (inventory A96); an existing one keeps its own.
    pub preset: Option<String>,
}

/// What `create_at` is told.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CreateAtOptions {
    pub title: Option<String>,
    pub endpoint: Option<String>,
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
    /// The agent preset the new session runs under (inventory A96).
    pub preset: Option<String>,
}

/// What a fork came to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ForkOutcome {
    /// No session has that id — a `404`.
    NotFound,
    /// The source has no completed turn with an answer to inherit — a `409`.
    Unavailable,
    /// An explicit `atSeq` names no event of the source — a `409` with DSH's sentence, which cites the
    /// source's last seq (`None` for an empty log).
    NoSuchEvent { at_seq: u64, last_seq: Option<u64> },
    /// The child session, named `<title> (n)`, with its definition in the source's folder.
    Forked(CreatedDefinition),
}

/// What a mode change did.
#[derive(Debug, Clone, PartialEq)]
pub struct ModeChange<M> {
    pub mode: M,
    /// False when the mode was already in effect; nothing was appended then.
    pub changed: bool,
    /// The `permission/mode` event, when one was appended.
    pub event: Option<Arc<SessionEvent>>,
}

/// A session's name taken from its first message: whitespace runs collapsed to one space and trimmed;
/// up to 48 UTF-16 units kept whole, else cut at the last space past the 24th unit (or hard at 48) with
/// `…` appended; trailing `.,;:!?` removed. `""` for a blank text.
pub fn title_from(text: &str) -> String {
    let line = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let line = line.trim();
    if line.is_empty() {
        return String::new();
    }
    /// `/[.,;:!?]+$/` — the punctuation a sentence leaves at its end is not a name.
    fn trim_punctuation(text: &str) -> String {
        text.trim_end_matches(['.', ',', ';', ':', '!', '?'])
            .to_string()
    }
    let limit = 48usize;
    let units: Vec<u16> = line.encode_utf16().collect();
    if units.len() <= limit {
        return trim_punctuation(line);
    }
    let cut = &units[..limit];
    let at = cut.iter().rposition(|unit| *unit == u32::from(' ') as u16);
    let chosen = match at {
        Some(at) if at > limit / 2 => &cut[..at],
        _ => cut,
    };
    format!("{}…", trim_punctuation(&String::from_utf16_lossy(chosen)))
}

/// A fork's name, from its **source's** title alone: DSH's `increasedForkTitle`
/// (`dsh-api-session-controller` lib/client.js:3714-3720, applied at :3992 and :4003-4004 as
/// `manager.rename(childId, increasedForkTitle(sourceTitle))`). A title ending in `(n)` or the
/// full-width `（n）` is incremented in place; any other gains ` (1)`. No other session is consulted,
/// so a second fork of `T` is `T (1)` again (#67); the version here used to step past every title
/// the store held, which made it `T (2)`.
///
/// The number is incremented as decimal text, as DSH's `BigInt` increments it, so a long ordinal is
/// exact and cannot overflow. A blank title gives `None` and the fork stays untitled: DSH renames the
/// child only when its source has a durable title (`list.byId[id]?.title`).
pub fn fork_title(base: &str) -> Option<String> {
    let trimmed = base.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Some((prefix, digits)) = split_ordinal_suffix(trimmed, '(', ')') {
        return Some(format!("{prefix}({})", increment_decimal(&digits)));
    }
    if let Some((prefix, digits)) = split_ordinal_suffix(trimmed, '（', '）') {
        return Some(format!("{prefix}（{}）", increment_decimal(&digits)));
    }
    Some(format!("{trimmed} (1)"))
}

/// The `(n)` suffix of a title, as the TypeScript regexes read it: the **first** opening bracket whose
/// remainder is ASCII digits followed by the closing bracket and the end of the string. Answers the
/// prefix and the digits as written.
fn split_ordinal_suffix(text: &str, open: char, close: char) -> Option<(String, String)> {
    let chars: Vec<char> = text.chars().collect();
    for (index, character) in chars.iter().enumerate() {
        if *character != open {
            continue;
        }
        let rest = &chars[index + 1..];
        if rest.len() < 2 || rest.last() != Some(&close) {
            continue;
        }
        let digits = &rest[..rest.len() - 1];
        if digits.is_empty() || !digits.iter().all(char::is_ascii_digit) {
            continue;
        }
        return Some((chars[..index].iter().collect(), digits.iter().collect()));
    }
    None
}

/// `BigInt(digits) + 1n` written back in decimal: leading zeros dropped, any length exact.
fn increment_decimal(digits: &str) -> String {
    let mut out: Vec<char> = digits.trim_start_matches('0').chars().collect();
    let mut index = out.len();
    loop {
        if index == 0 {
            out.insert(0, '1');
            break;
        }
        index -= 1;
        if out[index] == '9' {
            out[index] = '0';
        } else {
            out[index] = char::from(out[index] as u8 + 1);
            break;
        }
    }
    out.into_iter().collect()
}

/// The session service. Cheap to clone; clones share one store.
#[derive(Debug, Clone)]
pub struct SessionService {
    store: Arc<SessionStore>,
}

impl SessionService {
    /// A service over a store rooted where the configuration says (else
    /// [`crate::default_session_root`]), telling `listener` about every append.
    pub fn new(config: &SessionConfig, env: &Env, listener: Option<EventListener>) -> Self {
        let root = config
            .root
            .clone()
            .unwrap_or_else(|| default_session_root(env));
        let store = match listener {
            Some(listener) => SessionStore::with_listener(&root, env, listener),
            None => SessionStore::new(&root, env),
        };
        SessionService {
            store: Arc::new(store),
        }
    }

    /// A service over an existing store.
    pub fn from_store(store: Arc<SessionStore>) -> Self {
        SessionService { store }
    }

    /// The store underneath, for the callers that append their own events.
    pub fn store(&self) -> &Arc<SessionStore> {
        &self.store
    }

    /// The folder this session belongs to — its own meta record's non-blank `cwd` — or `None` for a
    /// legacy record with none, so the caller can apply its explicit fallback.
    pub fn folder(&self, handle: &SessionHandle) -> Option<String> {
        // Read this handle's own record, so another session in the same store cannot supply the answer.
        let text = std::fs::read_to_string(&handle.meta).ok()?;
        let value: Value = serde_json::from_str(&text).ok()?;
        let cwd = value.get("cwd")?.as_str()?;
        if cwd.trim().is_empty() {
            None
        } else {
            Some(cwd.to_string())
        }
    }

    /// Open the session a run continues (`resume`), or create one. A resume that names nothing is
    /// [`SessionError::NoSession`].
    pub fn start(&self, options: StartOptions) -> Result<SessionHandle, SessionError> {
        if let Some(resume) = &options.resume {
            return self
                .store
                .open(resume)
                .ok_or_else(|| SessionError::NoSession {
                    id: resume.clone(),
                    root: self.store.root().to_string(),
                });
        }
        self.store.create(CreateOptions {
            cwd: options.cwd,
            endpoint: options.endpoint,
            model: options.model,
            reasoning_effort: options.reasoning_effort,
            title: options.title,
            preset: options.preset,
            ..Default::default()
        })
    }

    /// Start a fresh session bound to `branch` **and** write its definition into that folder.
    pub fn create_at(
        &self,
        branch: &str,
        options: CreateAtOptions,
    ) -> Result<CreatedDefinition, SessionError> {
        let canonical = canonical_path(Path::new(branch))
            .to_string_lossy()
            .into_owned();
        // The branch is written **before** the store records anything (#106): a folder heddle cannot write
        // is refused with `SessionError::Unwritable` and leaves no session behind — measured, the old order
        // recorded one, which then listed under a branch whose definition was never written.
        ensure_sessions_folder(&canonical).map_err(|error| error.unwritable_in(&canonical))?;
        let taken = existing_session_names(&canonical);
        let handle = self.open_at(
            &canonical,
            OpenAtOptions {
                fresh: true,
                endpoint: options.endpoint.clone(),
                model: options.model.clone(),
                reasoning_effort: options.reasoning_effort.clone(),
                title: options.title.clone(),
                preset: options.preset.clone(),
            },
        )?;
        let created = self
            .list()
            .into_iter()
            .find(|meta| meta.id() == handle.id)
            .map(|meta| meta.created().to_string())
            .unwrap_or_else(iso_now);
        let definition = write_session_definition(
            &handle,
            &canonical,
            &DefinitionOptions {
                created_at: created,
                title: options.title,
                endpoint: options.endpoint,
                model: options.model,
                reasoning_effort: options.reasoning_effort,
                taken,
            },
        )
        .map_err(|error| error.unwritable_in(&canonical))?;
        Ok(CreatedDefinition { handle, definition })
    }

    /// Fork a session: a child that continues from its last completed turn, recording `parentSession`,
    /// titled `<title> (n)`, with its own definition in the source's folder.
    pub fn fork(&self, id: &str) -> Result<ForkOutcome, SessionError> {
        self.fork_at(id, None)
    }

    /// [`SessionService::fork`] with DSH's `atSeq` (dsh-api-session-controller/lib/index.js:849-872):
    /// `Some(seq)` cuts at that event, inclusive, and must name an event the source has; it need not fall
    /// on a completed turn, as DSH accepts any existing seq. `None` is the last completed turn.
    pub fn fork_at(&self, id: &str, at_seq: Option<u64>) -> Result<ForkOutcome, SessionError> {
        let Some(source) = self.list().into_iter().find(|meta| meta.id() == id) else {
            return Ok(ForkOutcome::NotFound);
        };
        let Some(source_handle) = self.store.open(id) else {
            return Ok(ForkOutcome::Unavailable);
        };
        let events = self.store.read(&source_handle)?;
        match at_seq {
            Some(cut) => {
                if !events.iter().any(|event| event.seq == cut) {
                    return Ok(ForkOutcome::NoSuchEvent {
                        at_seq: cut,
                        last_seq: events.last().map(|event| event.seq),
                    });
                }
            }
            // The question is "does the inherited projection contain an assistant message", not "does
            // the log contain assistant chunks": a fork's own log holds copied messages and no chunks.
            None => {
                if !inherits_answer(events.as_slice())? {
                    return Ok(ForkOutcome::Unavailable);
                }
            }
        }
        let Some(handle) = self.store.fork_at(
            id,
            ForkAttribution {
                parent_session: Some(id.to_string()),
                ..Default::default()
            },
            at_seq,
        )?
        else {
            return Ok(ForkOutcome::Unavailable);
        };
        // A fork continues its source, so it runs under the source's preset (inventory A96).
        if let Some(preset) = source.preset() {
            self.store.record_preset(&handle.id, preset)?;
        }
        let created = self
            .list()
            .into_iter()
            .find(|meta| meta.id() == handle.id)
            .map(|meta| meta.created().to_string())
            .unwrap_or_else(iso_now);
        // Named from the source's title alone, as DSH names it (`fork_title`); an untitled source
        // leaves the fork untitled.
        let title = fork_title(source.title().unwrap_or(""));
        if let Some(title) = &title {
            self.store.rename(&handle.id, title)?;
        }
        let definition = write_session_definition(
            &handle,
            source.cwd(),
            &DefinitionOptions {
                created_at: created,
                title,
                endpoint: source.endpoint().map(str::to_string),
                model: source.model().map(str::to_string),
                reasoning_effort: source.reasoning_effort().map(str::to_string),
                taken: existing_session_names(source.cwd()),
            },
        )?;
        Ok(ForkOutcome::Forked(CreatedDefinition {
            handle,
            definition,
        }))
    }

    /// Record a user turn of plain text; see [`SessionService::user_content`].
    pub fn user(
        &self,
        handle: &SessionHandle,
        text: &str,
        source: Option<Value>,
    ) -> Result<(), SessionError> {
        self.user_content(
            handle,
            vec![ContentPart::Text {
                text: text.to_string(),
            }],
            source,
        )
    }

    /// Record a user turn whose content may carry attachments. Empty content records nothing. The first
    /// message names a session that has no title yet, from its text parts only.
    ///
    /// The name is written in the same meta write that counts the turn ([`SessionStore::user_message_named`]), so a
    /// session list read meanwhile on another thread never shows the turn on an untitled session. The TypeScript build
    /// writes the two one after the other, synchronously, which no request can come between.
    pub fn user_content(
        &self,
        handle: &SessionHandle,
        content: Vec<ContentPart>,
        source: Option<Value>,
    ) -> Result<(), SessionError> {
        if content.is_empty() {
            return Ok(());
        }
        let title = title_from(&text_of(&content));
        self.store.user_message_named(
            handle,
            Message {
                role: Role::User,
                tool_call_id: None,
                content,
                source,
            },
            &title,
        )?;
        Ok(())
    }

    /// The folder's current session: the newest whose canonical `cwd` is exactly this folder.
    pub fn current(&self, folder: &str) -> Option<SessionMeta> {
        let canonical = canonical_path(Path::new(folder));
        self.list()
            .into_iter()
            .find(|meta| canonical_path(Path::new(meta.cwd())) == canonical)
    }

    /// One session's metadata record, or `None` when this store has no such session.
    pub fn meta(&self, id: &str) -> Option<SessionMeta> {
        self.store.meta(id)
    }

    /// Whether this store holds a session with that id: a metadata record, and a log that opens.
    ///
    /// A session whose log cannot be read opens as no session ([`SessionStore::open`]), so every route that asks this
    /// first answers it as an unknown id. Measured before (#130): `POST /api/turn` into such a session passed this
    /// check on its record alone and came back `400 no session '<id>' under <store root>`, naming the store on disk,
    /// where web.ts answers `404 session/not-found`.
    pub fn exists(&self, id: &str) -> bool {
        self.store.meta(id).is_some() && self.store.open(id).is_some()
    }

    /// Open an existing session by id, in whichever layout it was written in.
    pub fn open(&self, id: &str) -> Option<SessionHandle> {
        self.store.open(id)
    }

    /// Open the session bound to a folder, creating one when it has none or when `fresh`.
    pub fn open_at(
        &self,
        folder: &str,
        options: OpenAtOptions,
    ) -> Result<SessionHandle, SessionError> {
        let canonical = canonical_path(Path::new(folder))
            .to_string_lossy()
            .into_owned();
        if !options.fresh
            && let Some(existing) = self.current(&canonical)
            && let Some(handle) = self.store.open(existing.id())
        {
            return Ok(handle);
        }
        self.store.create(CreateOptions {
            cwd: Some(canonical),
            endpoint: options.endpoint,
            model: options.model,
            reasoning_effort: options.reasoning_effort,
            title: options.title,
            preset: options.preset,
            ..Default::default()
        })
    }

    /// The messages a resumed session would send.
    pub fn messages(&self, handle: &SessionHandle) -> Result<Vec<Message>, SessionError> {
        self.store.messages(handle)
    }

    /// The surface a request is derived from.
    pub fn surface(&self, handle: &SessionHandle) -> Result<Arc<SurfaceState>, SessionError> {
        self.store.surface(handle)
    }

    /// One node's derived message.
    pub fn node(&self, handle: &SessionHandle, seq: u64) -> Result<Option<Message>, SessionError> {
        self.store.derive_node(handle, seq)
    }

    /// Every event so far, for a caller that wants to show it.
    ///
    /// A session no live writer holds reads **balanced**: a turn its writer left unfinished is followed by the
    /// closers the next write-open will append ([`crate::repair`]), and nothing is written — DSH's cold read
    /// (`readColdSessionLog`, dsh-session-query lib/index.js:26-52). So a call cut by a restart reads as
    /// interrupted at once, not as running until somebody writes the session (issue #5). The model's view is
    /// [`SessionService::messages`], which reads the log itself.
    pub fn events(&self, handle: &SessionHandle) -> Result<Events, SessionError> {
        let events = self.store.read(handle)?;
        let closers = interrupted_turn_closers(&events);
        if closers.is_empty() || self.store.writer_held(handle) {
            return Ok(events);
        }
        let mut balanced = events.as_ref().clone();
        balanced.extend(closers.into_iter().map(Arc::new));
        Ok(Arc::new(balanced))
    }

    /// Every session, newest first.
    pub fn list(&self) -> Vec<SessionMeta> {
        self.store.list()
    }

    /// Retitle a session; the log is untouched.
    ///
    /// A rename is a person naming the session, so it pins the name: an automatic title still being generated lands
    /// nowhere (DSH's `rename()` supersedes in-flight generation, dsh-session-title lib/index.js:295-311), including when
    /// the person confirms the automatic title unchanged.
    pub fn rename(&self, id: &str, title: &str) -> Result<Option<SessionMeta>, SessionError> {
        self.store.titles().supersede(id);
        self.store.rename(id, title)
    }

    /// Give this store's automatic titles their model ([`crate::title`]): from now on a session's first prompt is
    /// titled by the model the turn's own request names. The composition root calls it once, where it builds the turn
    /// runtime; without it a session keeps its plain first-message name.
    pub fn attach_titles(&self, model: Arc<dyn crate::title::TitleModel>) {
        self.store
            .titles()
            .attach(Arc::downgrade(&self.store), model);
    }

    /// Pin, unpin, archive or unarchive.
    pub fn flags(&self, id: &str, patch: FlagPatch) -> Result<Option<SessionMeta>, SessionError> {
        self.store.flags(id, patch)
    }

    /// Whether an archived session owns this one's steps: it is archived itself, or a session above it in its
    /// subagent lineage is. DSH's archived-session gate asks exactly this before every model step.
    pub fn under_archived(&self, id: &str) -> bool {
        self.store.under_archived(id)
    }

    /// Record the agent preset a session runs under, only when it has none (inventory A96); see
    /// [`SessionStore::record_preset`]. Answers the record as it now is; `Ok(None)` for an unknown session.
    pub fn record_preset(
        &self,
        id: &str,
        preset: &str,
    ) -> Result<Option<SessionMeta>, SessionError> {
        self.store.record_preset(id, preset)
    }

    /// Switch a session onto an endpoint, replacing any model override it carried.
    pub fn set_model(
        &self,
        id: &str,
        selection: ModelSelection,
    ) -> Result<Option<SessionMeta>, SessionError> {
        self.store.set_model(id, selection)
    }

    /// The last complete answer's text.
    pub fn last_answer(&self, handle: &SessionHandle) -> Result<String, SessionError> {
        self.store.last_answer(handle)
    }

    /// The access mode this session recorded; see [`crate::recorded_mode`].
    pub fn recorded_mode<M: DeserializeOwned>(
        &self,
        handle: &SessionHandle,
    ) -> Result<Option<M>, SessionError> {
        fold_recorded_mode(self.store.read(handle)?.as_slice())
    }

    /// The mode a call in this session runs under: its own record, else `fallback`.
    pub fn effective_mode<M: DeserializeOwned>(
        &self,
        handle: &SessionHandle,
        fallback: M,
    ) -> Result<M, SessionError> {
        fold_effective_mode(self.store.read(handle)?.as_slice(), fallback)
    }

    /// Record a change of access mode before it takes effect. Choosing the mode already in effect
    /// appends nothing. A typed `M` is a word of the vocabulary by construction, so the TypeScript
    /// build's `'<word>' is not a sandbox mode` refusal belongs to whoever parses the request.
    pub fn set_mode<M>(
        &self,
        handle: &SessionHandle,
        mode: M,
        fallback: M,
    ) -> Result<ModeChange<M>, SessionError>
    where
        M: Serialize + DeserializeOwned + PartialEq + Clone,
    {
        let current = self.effective_mode(handle, fallback)?;
        if current == mode {
            return Ok(ModeChange {
                mode,
                changed: false,
                event: None,
            });
        }
        let event = self.store.append(
            handle,
            NewEvent::new(MODE_EVENT).field(
                "mode",
                serde_json::to_value(&mode).expect("a mode is serializable"),
            ),
            Default::default(),
        )?;
        Ok(ModeChange {
            mode,
            changed: true,
            event: Some(event),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::message::ContentPart;
    use serde::Deserialize;
    use serde_json::json;

    #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(rename_all = "kebab-case")]
    enum Mode {
        ReadOnly,
        WorkspaceWrite,
    }

    fn service() -> (tempfile::TempDir, SessionService) {
        let dir = tempfile::tempdir().unwrap();
        let config = SessionConfig {
            root: Some(dir.path().to_str().unwrap().to_string()),
        };
        let service = SessionService::new(&config, &Env::default(), None);
        (dir, service)
    }

    fn branch() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    /// Pin a session's `created`, so "the folder's newest" is decided by the test and not by which
    /// millisecond two creations landed in.
    fn stamp(handle: &SessionHandle, created: &str) {
        let text = std::fs::read_to_string(&handle.meta).unwrap();
        let value: serde_json::Value = serde_json::from_str(&text).unwrap();
        let mut meta = SessionMeta::from_value(value).unwrap();
        meta.set("created", json!(created));
        std::fs::write(&handle.meta, meta.to_file_text()).unwrap();
    }

    #[test]
    fn a_title_is_one_trimmed_line_without_trailing_punctuation() {
        assert_eq!(
            title_from("remember the word loom"),
            "remember the word loom"
        );
        assert_eq!(title_from("  spaced \n out \t text  "), "spaced out text");
        assert_eq!(title_from("a question?"), "a question");
        assert_eq!(title_from("ends with dots..."), "ends with dots");
        assert_eq!(title_from("   "), "");
        assert_eq!(title_from(""), "");
    }

    #[test]
    fn a_title_at_or_under_forty_eight_units_is_kept_whole() {
        // Exactly the limit, in UTF-16 units: no ellipsis, no cut.
        let exact = "a".repeat(48);
        assert_eq!(title_from(&exact), exact);
        // One unit more is cut hard at 48 and marked.
        let over = "a".repeat(49);
        assert_eq!(title_from(&over), format!("{}…", "a".repeat(48)));
    }

    #[test]
    fn the_word_cut_needs_a_space_past_the_half_way_point() {
        // A space at unit 24 exactly is not past the half-way point: the cut is hard at 48.
        let mut text = "a".repeat(24);
        text.push(' ');
        text.push_str(&"b".repeat(30));
        let title = title_from(&text);
        // The space at unit 24 is *in* the cut, because the rule needs one past the half-way point to
        // prefer it; the title therefore ends where the clock says, not at that word.
        assert_eq!(title, format!("{}…", &text[..48]));
        assert!(title.contains(' '));

        // A space at unit 25 is past it, so the title ends at the word.
        let mut text = "a".repeat(25);
        text.push(' ');
        text.push_str(&"b".repeat(30));
        let title = title_from(&text);
        assert_eq!(title, format!("{}…", "a".repeat(25)));

        // Trailing punctuation is removed after the cut as well.
        let mut text = "a".repeat(25);
        text.push_str(&" b.".repeat(20));
        let title = title_from(&text);
        assert!(title.ends_with("…"), "{title}");
        assert!(!title.trim_end_matches('…').ends_with('.'), "{title}");
    }

    #[test]
    fn a_long_title_is_cut_at_a_word_past_the_half_way_point() {
        let text = "one two three four five six seven eight nine ten eleven twelve";
        let title = title_from(text);
        assert!(title.ends_with('…'), "{title}");
        let kept = title.trim_end_matches('…');
        assert!(kept.len() <= 48);
        assert!(text.starts_with(kept), "the cut is at a word, not mid-word");
        assert!(
            !kept.ends_with(' '),
            "the space the cut landed on is not kept"
        );
    }

    #[test]
    fn a_long_single_word_is_cut_hard_at_forty_eight_units() {
        let text = "a".repeat(60);
        let title = title_from(&text);
        assert_eq!(title, format!("{}…", "a".repeat(48)));
    }

    #[test]
    fn a_title_is_counted_in_utf16_units() {
        // Each emoji is two units, so only 24 of them fit.
        let text = "😀".repeat(30);
        let title = title_from(&text);
        assert_eq!(title, format!("{}…", "😀".repeat(24)));
    }

    #[test]
    fn a_fork_title_counts_up_in_place() {
        assert_eq!(fork_title("Source").as_deref(), Some("Source (1)"));
        assert_eq!(fork_title("Source (1)").as_deref(), Some("Source (2)"));
        assert_eq!(fork_title("Source (2)").as_deref(), Some("Source (3)"));
        assert_eq!(fork_title("Source （1）").as_deref(), Some("Source （2）"));
        // A blank source names nothing: DSH renames a fork only from a durable title.
        assert_eq!(fork_title(""), None);
        assert_eq!(fork_title("   "), None);
    }

    #[test]
    fn a_fork_title_is_dsh_increased_fork_title_edge_cases_included() {
        // Each pair is what DSH's two regexes and `BigInt` produce for that title.
        for (title, expected) in [
            ("T", "T (1)"),
            ("全角标题（1）", "全角标题（2）"),
            ("Plan (2023)", "Plan (2024)"),
            ("x(1)", "x(2)"),
            ("(3)", "(4)"),
            ("a (1) (2)", "a (1) (3)"),
            ("a (1) b", "a (1) b (1)"),
            ("x (1)（2）", "x (1)（3）"),
            ("x（1）(2)", "x（1）(3)"),
            ("T (01)", "T (2)"),
            ("T (x1)", "T (x1) (1)"),
            ("T ()", "T () (1)"),
            ("T (99999999999999999999)", "T (100000000000000000000)"),
            ("T (12345678901234567891)", "T (12345678901234567892)"),
            ("T (18446744073709551615)", "T (18446744073709551616)"),
        ] {
            assert_eq!(fork_title(title).as_deref(), Some(expected), "{title}");
        }
    }

    #[test]
    fn a_fork_of_a_fork_is_incremented_rather_than_appended() {
        let first = fork_title("Source").unwrap();
        let second = fork_title(&first).unwrap();
        assert_eq!(second, "Source (2)");
        assert!(!second.contains("(1) (1)"));
    }

    /// One recorded message, written to the store directly so the first-message title fallback stays out of it.
    fn say(service: &SessionService, handle: &SessionHandle, role: Role, text: &str) {
        service
            .store()
            .message(
                handle,
                Message {
                    role,
                    tool_call_id: None,
                    content: vec![ContentPart::Text {
                        text: text.to_string(),
                    }],
                    source: None,
                },
            )
            .unwrap();
    }

    /// A session in `folder` with one completed turn, so it can be forked; titled `title` when given.
    fn answered(service: &SessionService, folder: &str, title: Option<&str>) -> SessionHandle {
        let handle = service.open_at(folder, OpenAtOptions::default()).unwrap();
        say(service, &handle, Role::User, "a question worth forking");
        say(service, &handle, Role::Assistant, "the answer");
        service
            .store()
            .append(&handle, NewEvent::new("turn/completed"), Default::default())
            .unwrap();
        if let Some(title) = title {
            service.rename(&handle.id, title).unwrap();
        }
        handle
    }

    /// Fork `id`; answer the child's id and its title, after checking its definition says the same.
    fn fork_named(service: &SessionService, id: &str) -> (String, Option<String>) {
        let ForkOutcome::Forked(forked) = service.fork(id).unwrap() else {
            panic!("{id} should fork");
        };
        let title = service
            .list()
            .into_iter()
            .find(|meta| meta.id() == forked.handle.id)
            .and_then(|meta| meta.title().map(str::to_string));
        let written = crate::definition::read_session_definition(&forked.definition.dir)
            .unwrap()
            .title()
            .map(str::to_string);
        assert_eq!(
            written, title,
            "the definition names the fork as the store does"
        );
        (forked.handle.id, title)
    }

    #[test]
    fn a_second_fork_is_named_from_its_source_alone() {
        // #67, DSH's table: fork T, fork T again, fork the first fork, fork the archived T (2).
        let (_dir, service) = service();
        let folder = branch();
        let source = answered(&service, folder.path().to_str().unwrap(), Some("T"));
        let (first, first_title) = fork_named(&service, &source.id);
        let (second, second_title) = fork_named(&service, &source.id);
        let (of_first, of_first_title) = fork_named(&service, &first);
        service
            .flags(
                &of_first,
                FlagPatch {
                    archived: Some(true),
                    ..Default::default()
                },
            )
            .unwrap();
        let (_, of_archived_title) = fork_named(&service, &of_first);
        assert_eq!(
            [
                first_title.as_deref(),
                second_title.as_deref(),
                of_first_title.as_deref(),
                of_archived_title.as_deref()
            ],
            [Some("T (1)"), Some("T (1)"), Some("T (2)"), Some("T (3)")]
        );
        // The archived second fork, T (1), forks into T (2) though another session holds that name.
        service
            .flags(
                &second,
                FlagPatch {
                    archived: Some(true),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(fork_named(&service, &second).1.as_deref(), Some("T (2)"));
    }

    #[test]
    fn a_fork_of_an_untitled_session_is_left_untitled() {
        let (_dir, service) = service();
        let folder = branch();
        let source = answered(&service, folder.path().to_str().unwrap(), None);
        assert_eq!(service.meta(&source.id).unwrap().title(), None);
        let (_, title) = fork_named(&service, &source.id);
        assert_eq!(
            title, None,
            "DSH renames a fork only from its source's title"
        );
    }

    #[test]
    fn one_folder_holds_one_session_and_fresh_starts_another() {
        let (_dir, service) = service();
        let folder = branch();
        let folder_path = folder.path().to_str().unwrap();

        let first = service
            .open_at(folder_path, OpenAtOptions::default())
            .unwrap();
        service
            .user(&first, "the first conversation", None)
            .unwrap();
        stamp(&first, "2026-10-22T10:00:00.000Z");
        let again = service
            .open_at(folder_path, OpenAtOptions::default())
            .unwrap();
        assert_eq!(again.id, first.id, "asking twice continues one session");

        let second = service
            .open_at(
                folder_path,
                OpenAtOptions {
                    fresh: true,
                    ..Default::default()
                },
            )
            .unwrap();
        // `--new` can land in the same millisecond as the first session; the record's clock is what
        // "the folder's newest" reads, so pin it rather than depend on the wall clock.
        stamp(&second, "2026-10-22T11:00:00.000Z");
        assert_ne!(second.id, first.id);
        assert_eq!(
            service.list().len(),
            2,
            "the new one did not replace the old"
        );
        assert_eq!(
            service.current(folder_path).unwrap().id(),
            second.id.as_str()
        );

        // The first conversation is still readable.
        let first_text: String = service
            .events(&first)
            .unwrap()
            .iter()
            .filter(|event| event.kind == "message")
            .map(|event| {
                text_of(
                    &serde_json::from_value::<Message>(event.get("message").unwrap().clone())
                        .unwrap()
                        .content,
                )
            })
            .collect();
        assert_eq!(first_text, "the first conversation");
    }

    #[test]
    fn the_first_message_names_the_session_and_a_later_one_does_not() {
        let (_dir, service) = service();
        let folder = branch();
        let handle = service
            .open_at(folder.path().to_str().unwrap(), OpenAtOptions::default())
            .unwrap();
        service
            .user(&handle, "remember the word loom?", None)
            .unwrap();
        let titled = service.list()[0].clone();
        assert_eq!(titled.title(), Some("remember the word loom"));

        service.user(&handle, "what did I ask", None).unwrap();
        assert_eq!(
            service.list()[0].title(),
            Some("remember the word loom"),
            "the first message keeps the title"
        );
    }

    /// A first message's turn and the name it gives land in **one** meta write, so no reader ever sees the turn counted
    /// on an untitled session. The web server lists sessions on another thread, without the store's lock, while a
    /// delegated child records its first message on the child's own task: with the count and the name written one
    /// after the other, a list in between showed the child with `turns: 1` and no `title` (80's check-subagents, three
    /// failures in six on the Rust build; Node runs no request between the TypeScript build's two synchronous writes).
    #[test]
    fn a_first_message_counts_its_turn_and_names_the_session_in_one_write() {
        let (_dir, service) = service();
        let folder = branch();
        let fresh = || OpenAtOptions {
            fresh: true,
            ..OpenAtOptions::default()
        };
        let folder_path = folder.path().to_str().unwrap();
        // Other sessions in the store, as a server holds them: naming used to list every one between the two writes.
        for _ in 0..20 {
            service.open_at(folder_path, fresh()).unwrap();
        }
        let mut untitled = Vec::new();
        for round in 0..40 {
            let handle = service.open_at(folder_path, fresh()).unwrap();
            let meta = handle.meta.clone();
            let ready = Arc::new(std::sync::Barrier::new(2));
            let reader = {
                let ready = Arc::clone(&ready);
                std::thread::spawn(move || {
                    ready.wait();
                    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
                    // The first record that counts the turn, as a session list polling the store would read it.
                    while std::time::Instant::now() < deadline {
                        let Ok(text) = std::fs::read_to_string(&meta) else {
                            continue;
                        };
                        let Ok(value) = serde_json::from_str::<Value>(&text) else {
                            continue;
                        };
                        if value["turns"].as_u64().unwrap_or(0) >= 1 {
                            return Some(value.get("title").cloned());
                        }
                    }
                    None
                })
            };
            ready.wait();
            service
                .user(&handle, "child task for the sidebar", None)
                .unwrap();
            let seen = reader.join().unwrap().expect("the turn was counted");
            if seen != Some(json!("child task for the sidebar")) {
                untitled.push((round, seen));
            }
        }
        assert!(
            untitled.is_empty(),
            "a reader saw the first turn counted before the session was named, in {} of 40 rounds: {untitled:?}",
            untitled.len()
        );
    }

    #[test]
    fn resume_that_names_nothing_says_so() {
        let (_dir, service) = service();
        let error = service
            .start(StartOptions {
                resume: Some("session-nope".to_string()),
                ..Default::default()
            })
            .unwrap_err();
        assert_eq!(
            error.to_string(),
            format!("no session 'session-nope' under {}", service.store().root())
        );
    }

    #[test]
    fn create_at_writes_a_definition_into_the_branch() {
        let (_dir, service) = service();
        let folder = branch();
        let folder_path = folder.path().to_str().unwrap();
        let created = service
            .create_at(folder_path, CreateAtOptions::default())
            .unwrap();
        assert!(!created.definition.name.is_empty());
        assert!(Path::new(&created.definition.file).exists());
        assert!(Path::new(&created.definition.dir).join("INDEX.md").exists());
        assert!(
            Path::new(folder_path)
                .join(crate::definition::SESSIONS_FOLDER)
                .join("INDEX.md")
                .exists()
        );
        let fields = crate::definition::read_session_definition(&created.definition.dir).unwrap();
        assert_eq!(fields.id(), created.handle.id.as_str());
        assert_eq!(
            fields.cwd(),
            Some(canonical_path(folder.path()).to_str().unwrap())
        );
        // The session is in the store too, so a resume finds it.
        assert_eq!(service.list().len(), 1);
    }

    /// Issue #106: a branch heddle cannot write failed with the I/O error and the definition's absolute path,
    /// after the store had already recorded the session. It is refused by code, in words, naming the folder by
    /// its name, and before anything is recorded.
    #[test]
    fn create_at_in_a_branch_heddle_cannot_write_is_refused_by_code_without_the_path() {
        use std::os::unix::fs::PermissionsExt;
        let (_dir, service) = service();
        let folder = branch();
        let folder_path = folder.path().to_str().unwrap();
        let mode = |bits: u32| {
            std::fs::set_permissions(folder.path(), std::fs::Permissions::from_mode(bits)).unwrap()
        };
        mode(0o000);
        // File modes do not stop the superuser, so a run as root cannot judge this.
        if std::fs::read_dir(folder.path()).is_ok() {
            mode(0o755);
            return;
        }
        let error = service
            .create_at(folder_path, CreateAtOptions::default())
            .unwrap_err();
        mode(0o755);
        let name = folder.path().file_name().unwrap().to_string_lossy();
        assert_eq!(error.code(), Some("session/unwritable"));
        assert_eq!(
            error.to_string(),
            format!("cannot write to \"{name}\": permission denied")
        );
        assert!(
            !error.to_string().contains(folder_path),
            "no absolute path in the sentence"
        );
        assert!(
            service.list().is_empty(),
            "the store holds no session for the refused branch"
        );
        let created = service
            .create_at(folder_path, CreateAtOptions::default())
            .unwrap();
        assert!(
            Path::new(&created.definition.file).exists(),
            "once writable, the branch takes one"
        );
    }

    #[test]
    fn a_fork_needs_an_answer_and_then_copies_the_conversation() {
        let (_dir, service) = service();
        let folder = branch();
        let folder_path = folder.path().to_str().unwrap();

        let unanswered = service
            .open_at(folder_path, OpenAtOptions::default())
            .unwrap();
        service
            .user(&unanswered, "a question with no answer", None)
            .unwrap();
        assert_eq!(
            service.fork(&unanswered.id).unwrap(),
            ForkOutcome::Unavailable
        );
        assert_eq!(service.fork("session-nope").unwrap(), ForkOutcome::NotFound);

        // Give it a completed answer, then fork.
        service
            .store()
            .message(
                &unanswered,
                Message {
                    role: Role::Assistant,
                    tool_call_id: None,
                    content: vec![ContentPart::Text {
                        text: "the answer".to_string(),
                    }],
                    source: None,
                },
            )
            .unwrap();
        service
            .store()
            .append(
                &unanswered,
                NewEvent::new("turn/completed"),
                Default::default(),
            )
            .unwrap();
        service.rename(&unanswered.id, "Source").unwrap();

        let ForkOutcome::Forked(forked) = service.fork(&unanswered.id).unwrap() else {
            panic!("the fork should have been made");
        };
        assert_ne!(forked.handle.id, unanswered.id);
        assert_eq!(
            service
                .list()
                .into_iter()
                .find(|meta| meta.id() == forked.handle.id)
                .unwrap()
                .title(),
            Some("Source (1)")
        );
        assert_eq!(
            service
                .list()
                .into_iter()
                .find(|meta| meta.id() == forked.handle.id)
                .unwrap()
                .parent_session(),
            Some(unanswered.id.as_str())
        );
        // The child carries the conversation and its own definition in the source's folder.
        let carried: Vec<String> = service
            .messages(&forked.handle)
            .unwrap()
            .iter()
            .map(|message| text_of(&message.content))
            .collect();
        assert_eq!(carried, vec!["a question with no answer", "the answer"]);
        assert!(Path::new(&forked.definition.file).exists());
        assert_eq!(
            crate::definition::read_session_definition(&forked.definition.dir)
                .unwrap()
                .title(),
            Some("Source (1)")
        );
    }

    /// Inventory A96: a session is created with the preset it is given (start, open_at, create_at), a folder's existing
    /// session keeps its own, a fork runs under its source's, and `record_preset` never replaces one.
    #[test]
    fn a_session_is_created_with_its_preset_keeps_it_and_a_fork_copies_it() {
        let (_dir, service) = service();
        let preset_of = |id: &str| {
            service
                .meta(id)
                .and_then(|meta| meta.preset().map(str::to_string))
        };

        let started = service
            .start(StartOptions {
                preset: Some("reader".to_string()),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(preset_of(&started.id).as_deref(), Some("reader"));
        let resumed = service
            .start(StartOptions {
                resume: Some(started.id.clone()),
                preset: Some("standard".to_string()),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(
            preset_of(&resumed.id).as_deref(),
            Some("reader"),
            "a resumed session keeps its own"
        );

        let folder = branch();
        let folder_path = folder.path().to_str().unwrap();
        let opened = service
            .open_at(
                folder_path,
                OpenAtOptions {
                    preset: Some("reader".to_string()),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(preset_of(&opened.id).as_deref(), Some("reader"));
        let again = service
            .open_at(
                folder_path,
                OpenAtOptions {
                    preset: Some("standard".to_string()),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(again.id, opened.id);
        assert_eq!(preset_of(&again.id).as_deref(), Some("reader"));

        let other = branch();
        let created = service
            .create_at(
                other.path().to_str().unwrap(),
                CreateAtOptions {
                    preset: Some("reader".to_string()),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(preset_of(&created.handle.id).as_deref(), Some("reader"));

        // A fork of a session under `reader` runs under `reader`.
        service.user(&opened, "a question", None).unwrap();
        service
            .store()
            .message(
                &opened,
                Message {
                    role: Role::Assistant,
                    tool_call_id: None,
                    content: vec![ContentPart::Text {
                        text: "an answer".to_string(),
                    }],
                    source: None,
                },
            )
            .unwrap();
        service
            .store()
            .append(&opened, NewEvent::new("turn/completed"), Default::default())
            .unwrap();
        let ForkOutcome::Forked(forked) = service.fork(&opened.id).unwrap() else {
            panic!("the fork should have been made");
        };
        assert_eq!(preset_of(&forked.handle.id).as_deref(), Some("reader"));

        // A session with none takes one once, and keeps it.
        let plain = service.start(StartOptions::default()).unwrap();
        assert_eq!(preset_of(&plain.id), None);
        let recorded = service
            .record_preset(&plain.id, "standard")
            .unwrap()
            .unwrap();
        assert_eq!(recorded.preset(), Some("standard"));
        service.record_preset(&plain.id, "reader").unwrap();
        assert_eq!(preset_of(&plain.id).as_deref(), Some("standard"));
    }

    #[test]
    fn a_fork_at_a_turn_end_holds_the_turns_up_to_it() {
        // DSH's `session/fork` with `atSeq` (R-developer-eight-16): an inclusive cut at an existing event.
        let (_dir, service) = service();
        let folder = branch();
        let source = service
            .open_at(folder.path().to_str().unwrap(), OpenAtOptions::default())
            .unwrap();
        service.rename(&source.id, "Long").unwrap();
        let mut ends = Vec::new();
        for prompt in ["turn one", "turn two", "turn three"] {
            service.user(&source, prompt, None).unwrap();
            service
                .store()
                .message(
                    &source,
                    Message {
                        role: Role::Assistant,
                        tool_call_id: None,
                        content: vec![ContentPart::Text {
                            text: format!("answer to {prompt}"),
                        }],
                        source: None,
                    },
                )
                .unwrap();
            let end = service
                .store()
                .append(&source, NewEvent::new("turn/completed"), Default::default())
                .unwrap();
            ends.push(end.seq);
        }

        let ForkOutcome::Forked(forked) = service.fork_at(&source.id, Some(ends[1])).unwrap()
        else {
            panic!("the cut at the second turn's end forks");
        };
        let carried: Vec<String> = service
            .messages(&forked.handle)
            .unwrap()
            .iter()
            .map(|message| text_of(&message.content))
            .collect();
        assert_eq!(
            carried,
            vec![
                "turn one",
                "answer to turn one",
                "turn two",
                "answer to turn two"
            ],
            "the child ends after turn two"
        );
        assert_eq!(
            service
                .list()
                .into_iter()
                .find(|meta| meta.id() == forked.handle.id)
                .unwrap()
                .title(),
            Some("Long (1)")
        );

        let last = service
            .store()
            .read(&source)
            .unwrap()
            .last()
            .map(|event| event.seq);
        assert_eq!(
            service.fork_at(&source.id, Some(9999)).unwrap(),
            ForkOutcome::NoSuchEvent {
                at_seq: 9999,
                last_seq: last
            },
            "a seq past the log is refused with the last seq"
        );
        // An explicit seq need not fall on a completed turn: DSH accepts any existing event.
        let untouched = service
            .open_at(
                folder.path().to_str().unwrap(),
                OpenAtOptions {
                    fresh: true,
                    ..OpenAtOptions::default()
                },
            )
            .unwrap();
        assert_eq!(
            service.fork(&untouched.id).unwrap(),
            ForkOutcome::Unavailable
        );
        assert!(matches!(
            service.fork_at(&untouched.id, Some(0)).unwrap(),
            ForkOutcome::Forked(_)
        ));
    }

    #[test]
    fn a_mode_change_that_changes_nothing_appends_nothing() {
        let (_dir, service) = service();
        let folder = branch();
        let handle = service
            .open_at(folder.path().to_str().unwrap(), OpenAtOptions::default())
            .unwrap();
        let before = service.store().count(&handle).unwrap();

        let unchanged = service
            .set_mode(&handle, Mode::ReadOnly, Mode::ReadOnly)
            .unwrap();
        assert!(!unchanged.changed);
        assert_eq!(unchanged.event, None);
        assert_eq!(service.store().count(&handle).unwrap(), before);

        let changed = service
            .set_mode(&handle, Mode::WorkspaceWrite, Mode::ReadOnly)
            .unwrap();
        assert!(changed.changed);
        assert_eq!(service.store().count(&handle).unwrap(), before + 1);
        assert_eq!(
            service.recorded_mode::<Mode>(&handle).unwrap(),
            Some(Mode::WorkspaceWrite)
        );
        assert_eq!(
            service.effective_mode(&handle, Mode::ReadOnly).unwrap(),
            Mode::WorkspaceWrite
        );

        // And a recorded mode survives a resumed read.
        let resumed = service
            .start(StartOptions {
                resume: Some(handle.id.clone()),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(
            service.recorded_mode::<Mode>(&resumed).unwrap(),
            Some(Mode::WorkspaceWrite)
        );
    }

    #[test]
    fn a_session_is_looked_up_by_id_and_answers_for_an_unknown_one() {
        let (_dir, service) = service();
        let folder = branch();
        let handle = service
            .open_at(folder.path().to_str().unwrap(), OpenAtOptions::default())
            .unwrap();
        assert!(service.exists(&handle.id));
        assert_eq!(service.meta(&handle.id).unwrap().id(), handle.id);
        assert_eq!(
            service.open(&handle.id).unwrap().transcript,
            handle.transcript
        );
        assert!(!service.exists("session-nope"));
        assert_eq!(service.meta("session-nope"), None);
        assert_eq!(service.open("session-nope"), None);
    }

    #[test]
    fn the_folder_is_read_from_this_sessions_own_record() {
        let (_dir, service) = service();
        let folder = branch();
        let handle = service
            .open_at(folder.path().to_str().unwrap(), OpenAtOptions::default())
            .unwrap();
        assert_eq!(
            service.folder(&handle),
            Some(canonical_path(folder.path()).to_str().unwrap().to_string())
        );
    }

    #[test]
    fn an_empty_message_records_nothing() {
        let (_dir, service) = service();
        let folder = branch();
        let handle = service
            .open_at(folder.path().to_str().unwrap(), OpenAtOptions::default())
            .unwrap();
        let before = service.store().count(&handle).unwrap();
        service.user_content(&handle, vec![], None).unwrap();
        assert_eq!(service.store().count(&handle).unwrap(), before);
    }

    #[test]
    fn a_message_with_only_an_attachment_names_nothing() {
        use crate::message::{ContentPart as Part, FilePart};
        let (_dir, service) = service();
        let folder = branch();
        let handle = service
            .open_at(folder.path().to_str().unwrap(), OpenAtOptions::default())
            .unwrap();
        service
            .user_content(
                &handle,
                vec![Part::File(FilePart {
                    name: "notes.txt".to_string(),
                    path: "/tmp/notes.txt".to_string(),
                    bytes: 2,
                    sha256: "abc".to_string(),
                })],
                None,
            )
            .unwrap();
        assert_eq!(service.list()[0].title(), None);
    }

    #[test]
    fn a_goal_source_is_carried_into_the_log() {
        let (_dir, service) = service();
        let folder = branch();
        let handle = service
            .open_at(folder.path().to_str().unwrap(), OpenAtOptions::default())
            .unwrap();
        service
            .user(
                &handle,
                "automatic round",
                Some(json!({"kind": "goal", "goalId": "g", "revision": 1, "round": 2})),
            )
            .unwrap();
        let events = service.events(&handle).unwrap();
        let message = events.iter().find(|event| event.kind == "message").unwrap();
        assert_eq!(message.kind, "message");
        assert!(message.to_line().contains("\"source\":{\"kind\":\"goal\""));
    }
}
