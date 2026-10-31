//! Adapters from the server's service traits to the crates that implement them.
//!
//! The routes call the traits in [`crate::services`] so the server builds and is tested without the
//! harness; these adapters are the other half, written against each crate's published API once it is on
//! `main`. A binary composes them into a [`crate::Harness`].
//!
//! | Adapter | Implements | Over |
//! |---|---|---|
//! | [`StoreSessions`] | [`crate::services::SessionService`] | `heddle_session::SessionService` |
//! | [`session_event_listener`] | the store's `EventListener` | [`crate::EventHub`] |

use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::selection::SessionSelection;
use crate::services::{
    CreatedSession, FlagPatch, ForkOutcome, ModeWrite, OpenAt, ServiceError, SessionMeta,
    SessionService, StartSession,
};
use crate::stream::EventHub;

/// The listener a binary passes to `heddle_session::SessionService::new` (or
/// `SessionStore::with_listener`), so every event the store writes reaches `/api/events` and a running
/// turn's own response.
///
/// It forwards everything the store emits, transient tool-call deltas included, which is what the
/// TypeScript `session/event` listener does: the page draws a call's arguments as they stream.
///
/// The store needs its listener when it is built, before the server exists, so create the hub first and
/// hand the same one to [`crate::ServerBuilder::with_event_hub`].
pub fn session_event_listener(hub: EventHub) -> heddle_session::EventListener {
    std::sync::Arc::new(move |handle, event| {
        hub.publish_session_event(&handle.id, &event.to_value());
    })
}

/// The server's [`SessionService`] over the session store.
#[derive(Clone)]
pub struct StoreSessions {
    service: heddle_session::SessionService,
    /// Content search's prepared documents, shared by every clone so repeated queries reuse what earlier ones read.
    search: std::sync::Arc<heddle_session::SessionSearchIndex>,
}

impl StoreSessions {
    pub fn new(service: heddle_session::SessionService) -> Self {
        StoreSessions {
            service,
            search: std::sync::Arc::new(heddle_session::SessionSearchIndex::new()),
        }
    }

    /// The store's own service, for the parts of the binary that use it directly.
    pub fn inner(&self) -> &heddle_session::SessionService {
        &self.service
    }

    fn handle(&self, id: &str) -> Option<heddle_session::SessionHandle> {
        self.service.open(id)
    }
}

/// The store's meta record as the server lists it. The record is read through its JSON so every field
/// the store wrote travels in `rest`, unchanged.
fn meta_of(meta: &heddle_session::SessionMeta) -> SessionMeta {
    serde_json::from_value(meta.to_value()).unwrap_or_else(|_| SessionMeta {
        id: meta.id().to_owned(),
        ..SessionMeta::default()
    })
}

fn path_text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn failure(error: heddle_session::SessionError) -> ServiceError {
    match error {
        // A pin or archive refusal is a 409 the page reads by its code.
        heddle_session::SessionError::Flag(refusal) => {
            ServiceError::with_code(refusal.to_string(), refusal.code())
        }
        // A branch heddle cannot write is a 400 the page reads by its code (#106).
        unwritable @ heddle_session::SessionError::Unwritable { .. } => {
            ServiceError::with_code(unwritable.to_string(), "session/unwritable")
        }
        other => ServiceError::new(other.to_string()),
    }
}

impl SessionService for StoreSessions {
    fn record(&self, id: &str, kind: &str, fields: Value) -> Result<(), ServiceError> {
        let Some(handle) = self.service.open(id) else {
            return Err(ServiceError::new(format!("no session {id}")));
        };
        let mut event = heddle_session::NewEvent::new(kind);
        if let Value::Object(map) = fields {
            event.fields = map;
        }
        self.service
            .store()
            .append(&handle, event, heddle_session::AppendOptions::default())
            .map(|_| ())
            .map_err(failure)
    }

    fn list(&self) -> Vec<SessionMeta> {
        self.service.list().iter().map(meta_of).collect()
    }

    fn meta(&self, id: &str) -> Option<SessionMeta> {
        self.service.meta(id).as_ref().map(meta_of)
    }

    fn exists(&self, id: &str) -> bool {
        self.service.exists(id)
    }

    fn events(&self, id: &str) -> Option<Vec<Value>> {
        let handle = self.handle(id)?;
        // A log that cannot be read is not a session the route can draw; the route answers 404.
        let events = self.service.events(&handle).ok()?;
        Some(events.iter().map(|event| event.to_value()).collect())
    }

    fn start(&self, options: StartSession) -> Result<String, ServiceError> {
        self.service
            .start(heddle_session::StartOptions {
                resume: options.resume,
                cwd: options.cwd.as_deref().map(path_text),
                endpoint: options.selection.endpoint,
                model: options.selection.model,
                reasoning_effort: options.selection.reasoning_effort,
                title: options.title,
                preset: options.preset,
            })
            .map(|handle| handle.id)
            .map_err(failure)
    }

    fn open_at(&self, folder: &Path, options: OpenAt) -> Result<String, ServiceError> {
        self.service
            .open_at(
                &path_text(folder),
                heddle_session::OpenAtOptions {
                    fresh: options.fresh,
                    endpoint: options.selection.endpoint,
                    model: options.selection.model,
                    reasoning_effort: options.selection.reasoning_effort,
                    title: options.title,
                    preset: options.preset,
                },
            )
            .map(|handle| handle.id)
            .map_err(failure)
    }

    fn create_at(
        &self,
        branch: &Path,
        title: Option<&str>,
        preset: Option<&str>,
    ) -> Result<CreatedSession, ServiceError> {
        self.service
            .create_at(
                &path_text(branch),
                heddle_session::CreateAtOptions {
                    title: title.map(str::to_owned),
                    preset: preset.map(str::to_owned),
                    ..Default::default()
                },
            )
            .map(|created| CreatedSession {
                session: created.handle.id,
                name: created.definition.name,
                definition: created.definition.file,
                log: created.definition.log,
            })
            .map_err(failure)
    }

    fn fork(&self, id: &str, at_seq: Option<u64>) -> ForkOutcome {
        match self.service.fork_at(id, at_seq) {
            Ok(heddle_session::ForkOutcome::NotFound) => ForkOutcome::NotFound,
            Ok(heddle_session::ForkOutcome::NoSuchEvent { at_seq, last_seq }) => {
                ForkOutcome::NoSuchEvent { at_seq, last_seq }
            }
            Ok(heddle_session::ForkOutcome::Unavailable) | Err(_) => ForkOutcome::Unavailable {
                code: "unavailable".to_owned(),
            },
            // The fork route answers the child's transcript as `log`, as web.ts does.
            Ok(heddle_session::ForkOutcome::Forked(created)) => {
                ForkOutcome::Forked(CreatedSession {
                    session: created.handle.id,
                    name: created.definition.name,
                    definition: created.definition.file,
                    log: created.handle.transcript,
                })
            }
        }
    }

    fn set_flags(&self, id: &str, patch: FlagPatch) -> Result<Option<SessionMeta>, ServiceError> {
        self.service
            .flags(
                id,
                heddle_session::FlagPatch {
                    pinned: patch.pinned,
                    archived: patch.archived,
                },
            )
            .map(|meta| meta.as_ref().map(meta_of))
            .map_err(failure)
    }

    fn rename(&self, id: &str, title: &str) -> Option<SessionMeta> {
        self.service
            .rename(id, title)
            .ok()
            .flatten()
            .as_ref()
            .map(meta_of)
    }

    /// The store announces every title it writes (#33): the rename route's own, the first message's fallback, a fork's
    /// name and the title model's answer.
    fn on_renamed(&self, listener: crate::services::TitleListener) -> bool {
        self.service.store().on_renamed(listener);
        true
    }

    fn definition_id(&self, folder: &Path) -> Option<String> {
        heddle_session::read_session_definition(&path_text(folder))
            .map(|definition| definition.id().to_owned())
    }

    fn update_definition_title(&self, folder: &Path, title: &str) -> Result<(), ServiceError> {
        heddle_session::update_session_definition(&path_text(folder), Some(title))
            .map(|_| ())
            .map_err(failure)
    }

    fn set_model(&self, id: &str, selection: &SessionSelection) -> Option<SessionMeta> {
        let endpoint = selection.endpoint.clone()?;
        self.service
            .set_model(
                id,
                heddle_session::ModelSelection {
                    endpoint,
                    model: selection.model.clone(),
                    reasoning_effort: selection.reasoning_effort.clone(),
                },
            )
            .ok()
            .flatten()
            .as_ref()
            .map(meta_of)
    }

    fn effective_mode(&self, id: &str, fallback: &str) -> String {
        let Some(handle) = self.handle(id) else {
            return fallback.to_owned();
        };
        self.service
            .effective_mode::<String>(&handle, fallback.to_owned())
            .unwrap_or_else(|_| fallback.to_owned())
    }

    fn set_mode(&self, id: &str, mode: &str, fallback: &str) -> Result<ModeWrite, ServiceError> {
        let handle = self
            .handle(id)
            .ok_or_else(|| ServiceError::new(format!("no session {id}")))?;
        let change = self
            .service
            .set_mode::<String>(&handle, mode.to_owned(), fallback.to_owned())
            .map_err(failure)?;
        Ok(ModeWrite {
            mode: change.mode,
            changed: change.changed,
            seq: change.event.map(|event| event.seq),
        })
    }

    fn user_content(&self, id: &str, content: Vec<Value>) -> Result<(), ServiceError> {
        let handle = self
            .handle(id)
            .ok_or_else(|| ServiceError::new(format!("no session {id}")))?;
        let parts = content
            .into_iter()
            .map(serde_json::from_value::<heddle_session::ContentPart>)
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| ServiceError::new(format!("a content part is malformed: {error}")))?;
        self.service
            .user_content(&handle, parts, None)
            .map_err(failure)
    }

    fn folder(&self, id: &str) -> Option<PathBuf> {
        let handle = self.handle(id)?;
        self.service.folder(&handle).map(PathBuf::from)
    }

    fn record_preset(&self, id: &str, preset: &str) -> Option<SessionMeta> {
        self.service
            .record_preset(id, preset)
            .ok()
            .flatten()
            .as_ref()
            .map(meta_of)
    }

    fn search(&self, query: &str) -> Result<heddle_session::SessionSearchPage, ServiceError> {
        self.search
            .search(self.service.store(), query)
            .map_err(|refusal| ServiceError::with_code(refusal.message.clone(), refusal.code()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// A scratch directory removed when the test ends.
    struct Scratch(PathBuf);

    impl Scratch {
        fn new(label: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "heddle-server-adapter-{label}-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            std::fs::create_dir_all(&path).unwrap();
            Scratch(std::fs::canonicalize(&path).unwrap())
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.0).ok();
        }
    }

    fn store_at(root: &Path, hub: Option<EventHub>) -> StoreSessions {
        let config = heddle_session::SessionConfig {
            root: Some(path_text(root)),
        };
        let env = heddle_config::Env::default();
        StoreSessions::new(heddle_session::SessionService::new(
            &config,
            &env,
            hub.map(session_event_listener),
        ))
    }

    fn selection(endpoint: &str) -> SessionSelection {
        SessionSelection {
            endpoint: Some(endpoint.to_owned()),
            model: None,
            reasoning_effort: None,
        }
    }

    #[test]
    fn a_started_session_is_listed_with_its_record() {
        let scratch = Scratch::new("start");
        let sessions = store_at(&scratch.0.join("sessions"), None);
        let id = sessions
            .start(StartSession {
                resume: None,
                cwd: Some(scratch.0.clone()),
                title: Some("first".into()),
                selection: selection("double"),
                preset: None,
            })
            .expect("a session starts");
        assert!(crate::respond::SessionId::parse(&id).is_some(), "{id}");
        assert!(sessions.exists(&id));

        let meta = sessions.meta(&id).expect("its record");
        assert_eq!(meta.id, id);
        assert_eq!(meta.endpoint.as_deref(), Some("double"));
        assert_eq!(meta.title.as_deref(), Some("first"));
        assert_eq!(meta.cwd.as_deref(), Some(path_text(&scratch.0).as_str()));
        // Fields the server does not type still travel with the record.
        assert!(meta.rest.contains_key("created"), "{:?}", meta.rest);
        assert_eq!(sessions.list().len(), 1);

        // Resuming names the same session; resuming nothing is an error, not a new session.
        let resumed = sessions
            .start(StartSession {
                resume: Some(id.clone()),
                ..StartSession::default()
            })
            .unwrap();
        assert_eq!(resumed, id);
        let missing = sessions.start(StartSession {
            resume: Some("no-such-session".into()),
            ..StartSession::default()
        });
        assert!(missing.is_err());
        assert_eq!(sessions.list().len(), 1);
    }

    #[test]
    fn a_user_message_is_recorded_and_folds_into_the_chat_view() {
        let scratch = Scratch::new("user");
        let sessions = store_at(&scratch.0.join("sessions"), None);
        let id = sessions
            .start(StartSession {
                cwd: Some(scratch.0.clone()),
                ..StartSession::default()
            })
            .unwrap();
        sessions
            .user_content(
                &id,
                vec![json!({"type": "text", "text": "remember the word loom"})],
            )
            .expect("the message is recorded");

        let events = sessions.events(&id).expect("its log");
        let turns = crate::transcript::transcript_turns(&events);
        assert!(
            turns
                .iter()
                .any(|turn| turn.kind == crate::transcript::TurnKind::User
                    && turn.text == "remember the word loom"),
            "{turns:?}"
        );
        // The first message names an untitled session, as the store does.
        assert_eq!(
            sessions.meta(&id).unwrap().title.as_deref(),
            Some("remember the word loom")
        );
        // A part the store cannot read is refused rather than dropped.
        assert!(
            sessions
                .user_content(&id, vec![json!({"type": 7})])
                .is_err()
        );
    }

    #[test]
    fn the_store_events_reach_the_hub() {
        let scratch = Scratch::new("listener");
        let hub = EventHub::new();
        let mut frames = hub.subscribe();
        let sessions = store_at(&scratch.0.join("sessions"), Some(hub.clone()));
        let id = sessions
            .start(StartSession {
                cwd: Some(scratch.0.clone()),
                ..StartSession::default()
            })
            .unwrap();
        sessions
            .user_content(&id, vec![json!({"type": "text", "text": "hi"})])
            .unwrap();

        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let mut saw_message = false;
        runtime.block_on(async {
            while let Ok(Some(frame)) =
                tokio::time::timeout(std::time::Duration::from_millis(200), frames.next_frame())
                    .await
            {
                assert_eq!(frame.session_id().as_deref(), Some(id.as_str()));
                let data: Value = serde_json::from_str(&frame.data).unwrap();
                if data["event"]["type"] == "message" {
                    saw_message = true;
                }
            }
        });
        assert!(saw_message, "the recorded message was published");
    }

    #[test]
    fn a_folder_has_one_session_until_a_fresh_one_is_asked_for() {
        let scratch = Scratch::new("open-at");
        let sessions = store_at(&scratch.0.join("sessions"), None);
        let folder = scratch.0.join("project");
        std::fs::create_dir_all(&folder).unwrap();
        let first = sessions.open_at(&folder, OpenAt::default()).unwrap();
        let again = sessions.open_at(&folder, OpenAt::default()).unwrap();
        assert_eq!(first, again, "one folder, one session");
        let fresh = sessions
            .open_at(
                &folder,
                OpenAt {
                    fresh: true,
                    ..OpenAt::default()
                },
            )
            .unwrap();
        assert_ne!(fresh, first);
        assert_eq!(sessions.folder(&first).as_deref(), Some(folder.as_path()));
    }

    /// Inventory A96: a session is started under the preset it is given, and `record_preset` writes one only when it
    /// has none.
    #[test]
    fn a_session_runs_under_its_preset_and_records_one_only_when_it_has_none() {
        let scratch = Scratch::new("preset");
        let sessions = store_at(&scratch.0.join("sessions"), None);
        let reader = sessions
            .start(StartSession {
                cwd: Some(scratch.0.clone()),
                preset: Some("reader".into()),
                ..StartSession::default()
            })
            .unwrap();
        assert_eq!(sessions.meta(&reader).unwrap().preset(), Some("reader"));
        let plain = sessions
            .start(StartSession {
                cwd: Some(scratch.0.clone()),
                ..StartSession::default()
            })
            .unwrap();
        assert_eq!(sessions.meta(&plain).unwrap().preset(), None);
        assert_eq!(
            sessions
                .record_preset(&plain, "standard")
                .and_then(|meta| meta.preset().map(str::to_owned))
                .as_deref(),
            Some("standard")
        );
        assert_eq!(
            sessions
                .record_preset(&reader, "standard")
                .and_then(|meta| meta.preset().map(str::to_owned))
                .as_deref(),
            Some("reader"),
            "a session keeps its preset"
        );
        assert_eq!(sessions.record_preset("session-nobody", "standard"), None);
    }

    #[test]
    fn a_session_created_at_a_branch_writes_its_definition_there() {
        let scratch = Scratch::new("create-at");
        let sessions = store_at(&scratch.0.join("sessions"), None);
        let branch = scratch.0.join("branch");
        std::fs::create_dir_all(&branch).unwrap();
        let created = sessions.create_at(&branch, Some("planning"), None).unwrap();
        assert!(sessions.exists(&created.session));
        assert!(
            Path::new(&created.definition).is_file(),
            "{}",
            created.definition
        );

        // The definition folder names the session, so the title route can reach both halves.
        let folder = Path::new(&created.definition).parent().unwrap();
        assert_eq!(
            sessions.definition_id(folder).as_deref(),
            Some(created.session.as_str())
        );
        sessions.update_definition_title(folder, "renamed").unwrap();
        let renamed = sessions.rename(&created.session, "renamed").unwrap();
        assert_eq!(renamed.title.as_deref(), Some("renamed"));
    }

    #[test]
    fn mode_writes_are_recorded_once_and_read_back() {
        let scratch = Scratch::new("mode");
        let sessions = store_at(&scratch.0.join("sessions"), None);
        let id = sessions
            .start(StartSession {
                cwd: Some(scratch.0.clone()),
                ..StartSession::default()
            })
            .unwrap();
        assert_eq!(
            sessions.effective_mode(&id, "workspace-write"),
            "workspace-write"
        );
        let written = sessions
            .set_mode(&id, "read-only", "workspace-write")
            .unwrap();
        assert_eq!(written.mode, "read-only");
        assert!(written.changed);
        assert!(written.seq.is_some());
        assert_eq!(sessions.effective_mode(&id, "workspace-write"), "read-only");
        let again = sessions
            .set_mode(&id, "read-only", "workspace-write")
            .unwrap();
        assert!(!again.changed, "the mode already in effect appends nothing");
        assert_eq!(again.seq, None);
        // An unknown session has no record to write to.
        assert!(
            sessions
                .set_mode("no-such-session", "read-only", "workspace-write")
                .is_err()
        );
    }

    #[test]
    fn flags_and_the_model_switch_rewrite_the_record() {
        let scratch = Scratch::new("flags");
        let sessions = store_at(&scratch.0.join("sessions"), None);
        let id = sessions
            .start(StartSession {
                cwd: Some(scratch.0.clone()),
                ..StartSession::default()
            })
            .unwrap();
        let pinned = sessions
            .set_flags(
                &id,
                FlagPatch {
                    pinned: Some(true),
                    archived: None,
                },
            )
            .unwrap()
            .expect("a known session");
        assert_eq!(pinned.rest.get("pinned"), Some(&json!(true)));
        assert!(
            sessions
                .set_flags("no-such-session", FlagPatch::default())
                .unwrap()
                .is_none()
        );

        let switched = sessions.set_model(&id, &selection("other")).unwrap();
        assert_eq!(switched.endpoint.as_deref(), Some("other"));
        // A selection without an endpoint names nothing to switch onto.
        assert!(
            sessions
                .set_model(&id, &SessionSelection::default())
                .is_none()
        );
    }

    #[test]
    fn a_session_with_no_answer_cannot_be_forked() {
        let scratch = Scratch::new("fork");
        let sessions = store_at(&scratch.0.join("sessions"), None);
        let id = sessions
            .start(StartSession {
                cwd: Some(scratch.0.clone()),
                ..StartSession::default()
            })
            .unwrap();
        assert_eq!(
            sessions.fork(&id, None),
            ForkOutcome::Unavailable {
                code: "unavailable".into()
            }
        );
        assert_eq!(
            sessions.fork("no-such-session", None),
            ForkOutcome::NotFound
        );
    }

    #[test]
    fn an_unknown_session_has_no_events_and_the_fallback_mode() {
        let scratch = Scratch::new("unknown");
        let sessions = store_at(&scratch.0.join("sessions"), None);
        let id = "no-such-session";
        assert!(!sessions.exists(id));
        assert_eq!(sessions.events(id), None);
        assert_eq!(sessions.meta(id), None);
        assert_eq!(sessions.effective_mode(id, "read-only"), "read-only");
        assert_eq!(sessions.folder(id), None);
    }
}
