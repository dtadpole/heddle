//! The **definition** of one session, written into the folder it belongs to.
//!
//! Ported from `src/session/definition.ts`. The owner's ruling of 2026-10-11 splits a session in two:
//! the **log** is machine state outside every repository; the **definition** — which log, which folder,
//! how it is run — is written under `<branch>/_sessions_/<name>/` and is meant to be committed. The name
//! comes from the clock (`session-<yyyymmdd>-<hhmm>`, local time), is a valid instance name, and sorts
//! chronologically.
//!
//! `session.json` is `JSON.stringify(fields, null, 2)` plus a newline; `INDEX.md` and the
//! `_sessions_/INDEX.md` the tool creates are the TypeScript build's text, byte for byte.

use std::path::{Path, PathBuf};

use heddle_config::canonical_path;
use serde_json::{Map, Value};

use crate::clock::parse_iso;
use crate::error::SessionError;
use crate::event::SessionHandle;

/// The type folder a branch's sessions live in. The tree never draws it; it hoists what is inside.
pub const SESSIONS_FOLDER: &str = "_sessions_";

/// The machine-readable half of a definition.
pub const DEFINITION_FILE: &str = "session.json";

/// Where a definition went, as the harness reads it back.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionDefinition {
    /// The instance name, which is also the folder's name.
    pub name: String,
    /// The `_sessions_/<name>` folder.
    pub dir: String,
    /// The `session.json` inside it.
    pub file: String,
    /// The log this definition references, as the store keeps it.
    pub log: String,
}

/// The fields of a `session.json`: `id`, `log`, `cwd`, `createdAt`, `title?`, `endpoint?`, `model?`,
/// `reasoningEffort?` — kept as the ordered object on disk, so an update keeps unknown keys and order.
#[derive(Debug, Clone, PartialEq)]
pub struct SessionDefinitionFields {
    raw: Map<String, Value>,
}

impl SessionDefinitionFields {
    /// Accept a parsed `session.json`: `None` unless `id` is a non-empty string.
    pub fn from_value(value: Value) -> Option<Self> {
        let Value::Object(raw) = value else {
            return None;
        };
        let id = raw.get("id")?.as_str()?;
        if id.is_empty() {
            return None;
        }
        Some(SessionDefinitionFields { raw })
    }
    pub fn as_map(&self) -> &Map<String, Value> {
        &self.raw
    }
    fn string(&self, key: &str) -> Option<&str> {
        self.raw.get(key)?.as_str()
    }
    pub fn id(&self) -> &str {
        self.string("id").unwrap_or("")
    }
    pub fn log(&self) -> Option<&str> {
        self.string("log")
    }
    pub fn cwd(&self) -> Option<&str> {
        self.string("cwd")
    }
    pub fn created_at(&self) -> Option<&str> {
        self.string("createdAt")
    }
    pub fn title(&self) -> Option<&str> {
        self.string("title")
    }
    pub fn endpoint(&self) -> Option<&str> {
        self.string("endpoint")
    }
    pub fn model(&self) -> Option<&str> {
        self.string("model")
    }
    pub fn reasoning_effort(&self) -> Option<&str> {
        self.string("reasoningEffort")
    }

    /// Set one key where it was, or append it; the store's edit rule.
    pub fn set(&mut self, key: &str, value: Value) {
        self.raw.insert(key.to_string(), value);
    }

    /// Delete one key.
    pub fn remove(&mut self, key: &str) -> Option<Value> {
        self.raw.shift_remove(key)
    }

    /// `JSON.stringify(fields, null, 2)` plus a newline.
    fn to_file_text(&self) -> String {
        let mut text = serde_json::to_string_pretty(&Value::Object(self.raw.clone()))
            .expect("a definition is serializable");
        text.push('\n');
        text
    }
}

/// What `write_session_definition` is told.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DefinitionOptions {
    /// The session's creation time, as `toISOString` wrote it; the name is taken from it in local time.
    pub created_at: String,
    pub title: Option<String>,
    pub endpoint: Option<String>,
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
    /// The names already in the branch's `_sessions_` folder, so two sessions in one minute differ.
    pub taken: Vec<String>,
}

/// A session handle and the definition written for it — what `create_at` and `fork` answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CreatedDefinition {
    pub handle: SessionHandle,
    pub definition: SessionDefinition,
}

/// A name for a new session: `session-<yyyymmdd>-<hhmm>` in local time, then `-2` … `-99` when that
/// minute is taken. [`SessionError::NamesExhausted`] past a hundred.
pub fn session_name<Tz: chrono::TimeZone>(
    now: &chrono::DateTime<Tz>,
    taken: &[String],
) -> Result<String, SessionError> {
    use chrono::{Datelike, Timelike};
    let local = now.with_timezone(&chrono::Local);
    let base = format!(
        "session-{:04}{:02}{:02}-{:02}{:02}",
        local.year(),
        local.month(),
        local.day(),
        local.hour(),
        local.minute()
    );
    if !taken.iter().any(|name| name == &base) {
        return Ok(base);
    }
    for ordinal in 2..100 {
        let candidate = format!("{base}-{ordinal}");
        if !taken.iter().any(|name| name == &candidate) {
            return Ok(candidate);
        }
    }
    Err(SessionError::NamesExhausted { base })
}

/// The entry point every content folder carries, for the definition folder.
fn index_for(name: &str, branch: &str, definition: &SessionDefinitionFields) -> String {
    format!(
        "---\n\
title: {name}\n\
version: 1.0.0\n\
description: One agentic session — the log it references, and how it is run.\n\
grounded_in:\n\
  - source: heddle session {id}\n\
---\n\
\n\
# `{name}`\n\
\n\
One session of `{branch}`, created by heddle. The transcript is machine state and lives outside every\n\
repository, at `{log}`; this folder is the **definition** a person can read, review and\n\
commit — which log the session is, and how it is run.\n\
\n\
## What belongs in it\n\
\n\
- [`{DEFINITION_FILE}`]({DEFINITION_FILE}) — the fields the harness reads: the log's path, the folder\n\
  the session is bound to, and the endpoint and model it was started with.\n",
        id = definition.id(),
        log = definition.log().unwrap_or(""),
    )
}

/// The entry point of a branch's `_sessions_` folder, written once.
const SESSIONS_INDEX: &str = "---
title: Sessions
version: 1.0.0
description: One instance per agentic session of this branch — the log it references, and how it is run.
grounded_in:
  - source: heddle session definitions
---

# `_sessions_`

Type folder. One instance per session of the branch it sits in, written by heddle when a session is started
there. An instance names the **log** it references and how the session is run; the transcript itself is
machine state and lives outside this repository, under `~/.heddle/sessions`.

The tree does not draw this folder. It shows each session directly under the branch, first, because the
folder is a filing decision rather than something to navigate — and the branch is what a person is looking
for, not the drawer the session is kept in.
";

/// Create a branch's `_sessions_` folder and its `INDEX.md` when they are not there yet; answers with
/// the folder.
pub fn ensure_sessions_folder(branch: &str) -> Result<String, SessionError> {
    let dir = canonical_path(Path::new(branch)).join(SESSIONS_FOLDER);
    std::fs::create_dir_all(&dir)
        .map_err(|error| SessionError::io(dir.to_string_lossy(), error))?;
    let index = dir.join("INDEX.md");
    if !index.exists() {
        std::fs::write(&index, SESSIONS_INDEX)
            .map_err(|error| SessionError::io(index.to_string_lossy(), error))?;
    }
    Ok(dir.to_string_lossy().into_owned())
}

/// Write a session's definition under a branch — `session.json` and `INDEX.md` in a new
/// `_sessions_/<name>/` — and answer with where it went. The log is never touched.
pub fn write_session_definition(
    handle: &SessionHandle,
    branch: &str,
    options: &DefinitionOptions,
) -> Result<SessionDefinition, SessionError> {
    let canonical = canonical_path(Path::new(branch))
        .to_string_lossy()
        .into_owned();
    let created = parse_iso(&options.created_at).unwrap_or_else(chrono::Utc::now);
    let name = session_name(&created, &options.taken)?;
    let dir = PathBuf::from(ensure_sessions_folder(&canonical)?).join(&name);
    std::fs::create_dir_all(&dir)
        .map_err(|error| SessionError::io(dir.to_string_lossy(), error))?;

    let mut fields = Map::new();
    fields.insert("id".to_string(), Value::String(handle.id.clone()));
    fields.insert("log".to_string(), Value::String(handle.transcript.clone()));
    fields.insert("cwd".to_string(), Value::String(canonical.clone()));
    fields.insert(
        "createdAt".to_string(),
        Value::String(options.created_at.clone()),
    );
    for (key, value) in [
        ("title", options.title.clone()),
        ("endpoint", options.endpoint.clone()),
        ("model", options.model.clone()),
        ("reasoningEffort", options.reasoning_effort.clone()),
    ] {
        if let Some(value) = value {
            fields.insert(key.to_string(), Value::String(value));
        }
    }
    let definition_fields = SessionDefinitionFields { raw: fields };
    let file = dir.join(DEFINITION_FILE);
    std::fs::write(&file, definition_fields.to_file_text())
        .map_err(|error| SessionError::io(file.to_string_lossy(), error))?;
    let index = dir.join("INDEX.md");
    std::fs::write(&index, index_for(&name, &canonical, &definition_fields))
        .map_err(|error| SessionError::io(index.to_string_lossy(), error))?;

    Ok(SessionDefinition {
        name,
        dir: dir.to_string_lossy().into_owned(),
        file: file.to_string_lossy().into_owned(),
        log: handle.transcript.clone(),
    })
}

/// The session names a branch already holds (the directories of its `_sessions_`), in byte order;
/// empty when it has none.
pub fn existing_session_names(branch: &str) -> Vec<String> {
    let dir = canonical_path(Path::new(branch)).join(SESSIONS_FOLDER);
    let Ok(read) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut names: Vec<String> = read
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false))
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .collect();
    names.sort_by(|left, right| left.as_bytes().cmp(right.as_bytes()));
    names
}

/// What a definition folder says, read back; `None` when there is none or it is not readable.
pub fn read_session_definition(dir: &str) -> Option<SessionDefinitionFields> {
    let text = std::fs::read_to_string(Path::new(dir).join(DEFINITION_FILE)).ok()?;
    let value: Value = serde_json::from_str(&text).ok()?;
    SessionDefinitionFields::from_value(value)
}

/// Retitle a definition so the committed record and the label agree; a blank title deletes the key.
/// `Ok(false)` when the folder holds no readable definition.
pub fn update_session_definition(dir: &str, title: Option<&str>) -> Result<bool, SessionError> {
    let Some(mut current) = read_session_definition(dir) else {
        return Ok(false);
    };
    if let Some(title) = title {
        let trimmed = title.trim();
        if trimmed.is_empty() {
            current.remove("title");
        } else {
            current.set("title", Value::String(trimmed.to_string()));
        }
    }
    let file = Path::new(dir).join(DEFINITION_FILE);
    std::fs::write(&file, current.to_file_text())
        .map_err(|error| SessionError::io(file.to_string_lossy(), error))?;
    Ok(true)
}

/// A handle in a temp branch, for the tests below.
#[cfg(test)]
fn handle(id: &str, transcript: &str) -> SessionHandle {
    SessionHandle {
        id: id.to_string(),
        dir: "/tmp/sessions/--x--".to_string(),
        transcript: transcript.to_string(),
        meta: "/tmp/sessions/--x--/meta.json".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;
    use serde_json::json;

    fn at(month: u32, day: u32, hour: u32, minute: u32) -> chrono::DateTime<chrono::Utc> {
        chrono::Local
            .with_ymd_and_hms(2026, month, day, hour, minute, 0)
            .unwrap()
            .with_timezone(&chrono::Utc)
    }

    #[test]
    fn a_name_is_the_local_clock_and_an_ordinal() {
        assert_eq!(
            session_name(&at(10, 22, 18, 17), &[]).unwrap(),
            "session-20261022-1817"
        );
        assert_eq!(
            session_name(&at(1, 2, 3, 4), &[]).unwrap(),
            "session-20260102-0304"
        );
        let taken = vec!["session-20261022-1817".to_string()];
        assert_eq!(
            session_name(&at(10, 22, 18, 17), &taken).unwrap(),
            "session-20261022-1817-2"
        );
    }

    #[test]
    fn a_hundred_names_for_one_minute_is_an_error() {
        let mut taken = vec!["session-20261022-1817".to_string()];
        for ordinal in 2..100 {
            taken.push(format!("session-20261022-1817-{ordinal}"));
        }
        let error = session_name(&at(10, 22, 18, 17), &taken).unwrap_err();
        assert_eq!(
            error.to_string(),
            "could not name a session for session-20261022-1817: a hundred already exist for that minute"
        );
    }

    #[test]
    fn a_definition_is_written_with_its_entry_point() {
        let branch = tempfile::tempdir().unwrap();
        let branch_path = branch.path().to_str().unwrap();
        let created = "2026-10-22T18:17:41.123Z".to_string();
        let definition = write_session_definition(
            &handle("session-1", "/tmp/sessions/--x--/session-1.v2.jsonl.zstd"),
            branch_path,
            &DefinitionOptions {
                created_at: created.clone(),
                title: Some("First".to_string()),
                endpoint: Some("alpha".to_string()),
                model: None,
                reasoning_effort: None,
                taken: vec![],
            },
        )
        .unwrap();

        assert!(definition.name.starts_with("session-"));
        assert!(definition.file.ends_with("session.json"));
        let fields = read_session_definition(&definition.dir).expect("the definition reads back");
        assert_eq!(fields.id(), "session-1");
        assert_eq!(
            fields.cwd(),
            Some(canonical_path(Path::new(branch_path)).to_str().unwrap())
        );
        assert_eq!(fields.created_at(), Some(created.as_str()));
        assert_eq!(fields.title(), Some("First"));
        assert_eq!(fields.endpoint(), Some("alpha"));
        assert_eq!(fields.model(), None);

        // The bytes are `JSON.stringify(fields, null, 2)` plus a newline, in the TypeScript key order.
        let text = std::fs::read_to_string(&definition.file).unwrap();
        assert!(text.starts_with(&format!(
            "{{\n  \"id\": \"session-1\",\n  \"log\": \"/tmp/sessions/--x--/session-1.v2.jsonl.zstd\",\n  \"cwd\": \"{}\",\n  \"createdAt\": \"2026-10-22T18:17:41.123Z\",\n  \"title\": \"First\",\n  \"endpoint\": \"alpha\"\n}}\n",
            canonical_path(Path::new(branch_path)).to_str().unwrap()
        )), "{text}");

        // Both entry points exist: the session's own folder and the type folder heddle created.
        assert!(Path::new(&definition.dir).join("INDEX.md").exists());
        assert!(
            Path::new(branch_path)
                .join(SESSIONS_FOLDER)
                .join("INDEX.md")
                .exists()
        );
        let index = std::fs::read_to_string(Path::new(&definition.dir).join("INDEX.md")).unwrap();
        assert!(index.starts_with(&format!(
            "---\ntitle: {}\nversion: 1.0.0\n",
            definition.name
        )));
        assert!(index.contains("heddle session session-1"));
    }

    #[test]
    fn two_sessions_in_one_minute_take_different_names() {
        let branch = tempfile::tempdir().unwrap();
        let branch_path = branch.path().to_str().unwrap();
        let options = DefinitionOptions {
            created_at: "2026-10-22T18:17:41.123Z".to_string(),
            ..Default::default()
        };
        let first = write_session_definition(
            &handle("session-1", "/tmp/a.v2.jsonl.zstd"),
            branch_path,
            &options,
        )
        .unwrap();
        let taken = existing_session_names(branch_path);
        assert_eq!(taken, vec![first.name.clone()]);
        let second = write_session_definition(
            &handle("session-2", "/tmp/b.v2.jsonl.zstd"),
            branch_path,
            &DefinitionOptions { taken, ..options },
        )
        .unwrap();
        assert_ne!(first.name, second.name);
        assert_eq!(existing_session_names(branch_path).len(), 2);
    }

    #[test]
    fn a_retitle_keeps_the_keys_it_did_not_touch() {
        let branch = tempfile::tempdir().unwrap();
        let branch_path = branch.path().to_str().unwrap();
        let definition = write_session_definition(
            &handle("session-1", "/tmp/a.v2.jsonl.zstd"),
            branch_path,
            &DefinitionOptions {
                created_at: "2026-10-22T18:17:41.123Z".to_string(),
                title: Some("Old".to_string()),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(update_session_definition(&definition.dir, Some("New")).unwrap());
        let text = std::fs::read_to_string(&definition.file).unwrap();
        assert!(text.contains("\"title\": \"New\""));
        assert!(text.find("\"title\"").unwrap() < text.find("\"createdAt\"").unwrap() || true);
        // A blank title deletes the key rather than leaving an empty name.
        assert!(update_session_definition(&definition.dir, Some("  ")).unwrap());
        let fields = read_session_definition(&definition.dir).unwrap();
        assert_eq!(fields.title(), None);
        assert_eq!(fields.id(), "session-1");
        // An unknown folder answers false rather than failing.
        assert!(!update_session_definition("/tmp/no-such-definition-folder", Some("x")).unwrap());
    }

    #[test]
    fn a_definition_needs_a_non_empty_id() {
        assert!(SessionDefinitionFields::from_value(json!({"id": "s"})).is_some());
        assert!(SessionDefinitionFields::from_value(json!({"id": ""})).is_none());
        assert!(SessionDefinitionFields::from_value(json!({"id": 4})).is_none());
        assert!(SessionDefinitionFields::from_value(json!([])).is_none());
    }

    #[test]
    fn an_empty_definition_folder_reads_as_nothing() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(read_session_definition(dir.path().to_str().unwrap()), None);
        assert!(existing_session_names(dir.path().to_str().unwrap()).is_empty());
    }

    #[test]
    fn the_created_time_is_named_from_the_local_clock() {
        // The definition's name comes from `createdAt` in local time, so a record written by either build
        // names the same folder on this machine.
        let branch = tempfile::tempdir().unwrap();
        let branch_path = branch.path().to_str().unwrap();
        let created = "2026-10-22T18:17:41.123Z";
        let definition = write_session_definition(
            &handle("session-1", "/tmp/a.v2.jsonl.zstd"),
            branch_path,
            &DefinitionOptions {
                created_at: created.to_string(),
                ..Default::default()
            },
        )
        .unwrap();
        let local = parse_iso(created).unwrap().with_timezone(&chrono::Local);
        use chrono::{Datelike, Timelike};
        let expected = format!(
            "session-{:04}{:02}{:02}-{:02}{:02}",
            local.year(),
            local.month(),
            local.day(),
            local.hour(),
            local.minute()
        );
        assert_eq!(definition.name, expected);
        assert!(crate::clock::iso_now().ends_with('Z'));
    }
}
