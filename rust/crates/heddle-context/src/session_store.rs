//! The adapter from `heddle-session`'s store to this crate's [`ContextStore`].
//!
//! This crate owns the trait, so the session crate never depends on it; the one `impl` that binds the
//! real store lives here. Everything below is a mapping and nothing else: the store still owns the
//! fold, the derivation and the refusal of a replacement it could not place, and this crate still
//! owns the policy that reads them.
//!
//! A node's message crosses without a conversion: `heddle-session` re-exports `heddle-llm`'s message
//! types, so the two crates name the same type.

use heddle_session::{SessionHandle, SessionStore};

use crate::store::{AppendOptions, ContextStore, LogEvent, StoreError, SurfaceNode, SurfaceState};
use crate::types::Message;

impl ContextStore for SessionStore {
    type Handle = SessionHandle;

    fn count(&self, session: &SessionHandle) -> Result<u64, StoreError> {
        SessionStore::count(self, session).map_err(to_store_error)
    }

    fn read(&self, session: &SessionHandle) -> Result<Vec<LogEvent>, StoreError> {
        let events = SessionStore::read(self, session).map_err(to_store_error)?;
        Ok(events
            .iter()
            .map(|event| LogEvent {
                seq: event.seq,
                kind: event.kind.clone(),
                fields: event.fields.clone(),
            })
            .collect())
    }

    fn surface(&self, session: &SessionHandle) -> Result<SurfaceState, StoreError> {
        let state = SessionStore::surface(self, session).map_err(to_store_error)?;
        Ok(SurfaceState {
            nodes: state.nodes.clone(),
            content_generation: state.content_generation,
            replace_generation: state.replace_generation,
        })
    }

    fn derive_node(
        &self,
        session: &SessionHandle,
        seq: u64,
    ) -> Result<Option<Message>, StoreError> {
        SessionStore::derive_node(self, session, seq).map_err(to_store_error)
    }

    /// One read and one index for the whole surface: `SessionStore::derive_node` indexes the log on
    /// every call, so deriving node by node would be quadratic in a long session.
    fn derive_surface(&self, session: &SessionHandle) -> Result<Vec<SurfaceNode>, StoreError> {
        let events = SessionStore::read(self, session).map_err(to_store_error)?;
        let by_seq = heddle_session::index_by_seq(events.as_slice());
        let state = SessionStore::surface(self, session).map_err(to_store_error)?;
        Ok(state
            .nodes
            .iter()
            .map(|seq| SurfaceNode {
                seq: *seq,
                message: heddle_session::derive_message(&by_seq, *seq),
            })
            .collect())
    }

    fn derive_messages(&self, session: &SessionHandle) -> Result<Vec<Message>, StoreError> {
        SessionStore::derive_messages(self, session).map_err(to_store_error)
    }

    fn append(
        &self,
        session: &SessionHandle,
        event: serde_json::Value,
        options: AppendOptions,
    ) -> Result<u64, StoreError> {
        let event = heddle_session::NewEvent::try_from(event).map_err(to_store_error)?;
        let options = heddle_session::AppendOptions {
            surface_op: options.surface_op.map(session_surface_op),
            source_event_seqs: options.source_event_seqs,
        };
        let written =
            SessionStore::append(self, session, event, options).map_err(to_store_error)?;
        Ok(written.seq)
    }
}

/// A store failure, boxed as this crate's opaque [`StoreError`].
fn to_store_error(error: heddle_session::SessionError) -> StoreError {
    StoreError(Box::new(error))
}

/// This crate's surface operation as the session store's.
fn session_surface_op(op: crate::store::SurfaceOp) -> heddle_session::SurfaceOp {
    match op {
        crate::store::SurfaceOp::Append => heddle_session::SurfaceOp::Append,
        crate::store::SurfaceOp::Replace(range) => heddle_session::SurfaceOp::Replace {
            start_seq: range.start_seq,
            end_seq: range.end_seq,
        },
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicU64, Ordering};

    use futures::executor::block_on;
    use futures::future::BoxFuture;
    use heddle_config::Env;
    use heddle_session::{CreateOptions, SessionHandle, SessionStore};
    use serde_json::json;

    use crate::compaction::SummarizeError;
    use crate::prune::ToolResultPruner;
    use crate::service::{
        ContextConfig, ContextDependencies, ContextService, ModelAccess, PrepareOptions,
        SummaryRequest,
    };
    use crate::store::{AppendOptions, ContextStore};
    use crate::types::{ContentPart, Message, Role, text_message};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    /// A session store on a fresh directory, and one session in it.
    fn session() -> (SessionStore, SessionHandle, PathBuf) {
        let root = std::env::temp_dir().join(format!(
            "heddle-context-session-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&root).expect("the scratch directory is created");
        let store = SessionStore::new(
            root.join("sessions").to_str().expect("a utf-8 path"),
            &Env::from_process(),
        );
        let handle = store
            .create(CreateOptions {
                cwd: Some(root.to_string_lossy().into_owned()),
                ..CreateOptions::default()
            })
            .expect("the session is created");
        (store, handle, root)
    }

    fn append_message(store: &SessionStore, handle: &SessionHandle, message: Message) -> u64 {
        ContextStore::append(
            store,
            handle,
            json!({ "type": "message", "message": message }),
            AppendOptions::default(),
        )
        .expect("a message appends")
    }

    fn texts(store: &SessionStore, handle: &SessionHandle) -> Vec<String> {
        ContextStore::derive_messages(store, handle)
            .expect("the messages derive")
            .into_iter()
            .map(|message| {
                message
                    .content
                    .iter()
                    .map(|part| match part {
                        ContentPart::Text { text } => text.clone(),
                        _ => String::new(),
                    })
                    .collect()
            })
            .collect()
    }

    /// A model layer that answers with one scripted summary.
    #[derive(Default)]
    struct ScriptedModel {
        summary: String,
    }

    impl ModelAccess for ScriptedModel {
        fn endpoint_window(&self, _endpoint: &str, _model: Option<&str>) -> Option<u64> {
            None
        }

        fn complete(
            &self,
            _request: SummaryRequest,
        ) -> BoxFuture<'_, Result<String, SummarizeError>> {
            let summary = self.summary.clone();
            Box::pin(async move { Ok(summary) })
        }
    }

    fn service(
        store: Arc<SessionStore>,
        window: u64,
        model: Option<Arc<dyn ModelAccess>>,
        home: &std::path::Path,
    ) -> ContextService<SessionStore> {
        ContextService::new(
            store,
            ContextConfig {
                context_window: Some(window),
                instructions: false,
                ..ContextConfig::default()
            },
            ContextDependencies {
                model,
                heddle_home: home.to_path_buf(),
            },
        )
    }

    #[test]
    fn the_adapter_reads_a_written_session_back_through_the_trait() {
        let (store, handle, root) = session();
        append_message(&store, &handle, text_message(Role::System, "be brief"));
        append_message(&store, &handle, text_message(Role::User, "hello"));
        append_message(
            &store,
            &handle,
            Message {
                role: Role::Tool,
                content: vec![ContentPart::Text {
                    text: "the result".to_string(),
                }],
                tool_call_id: Some("call-1".to_string()),
                source: None,
            },
        );

        assert_eq!(
            ContextStore::count(&store, &handle).expect("the count"),
            4,
            "session/created plus three messages"
        );
        let events = ContextStore::read(&store, &handle).expect("the log reads");
        assert_eq!(events.len(), 4);
        assert_eq!(events[0].kind, "session/created");
        assert_eq!(events[1].kind, "message");
        assert_eq!(
            events[1].message().map(|message| message.role),
            Some(Role::System)
        );

        let surface = ContextStore::surface(&store, &handle).expect("the surface folds");
        assert_eq!(surface.nodes, vec![1, 2, 3]);
        assert_eq!(surface.replace_generation, 0);
        let derived = ContextStore::derive_messages(&store, &handle).expect("the messages derive");
        assert_eq!(derived.len(), 3);
        assert_eq!(derived[2].tool_call_id.as_deref(), Some("call-1"));

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn a_replacement_lands_through_the_store_and_the_pruner_shrinks_a_tool_result() {
        let (store, handle, root) = session();
        append_message(&store, &handle, text_message(Role::System, "be brief"));
        append_message(&store, &handle, text_message(Role::User, "make a big file"));
        let tool = Message {
            role: Role::Tool,
            content: vec![ContentPart::Text {
                text: "x".repeat(30_000),
            }],
            tool_call_id: Some("call-1".to_string()),
            source: None,
        };
        let tool_seq = append_message(&store, &handle, tool);

        let outcome = ToolResultPruner::default()
            .prune_session(&store, &handle)
            .expect("the walk succeeds");
        assert_eq!(outcome.pruned, 1);

        let events = ContextStore::read(&store, &handle).expect("the log reads");
        assert!(events.iter().any(|event| event.kind == "compaction/prune"));
        let surface = ContextStore::surface(&store, &handle).expect("the surface folds");
        assert_eq!(
            surface.nodes.len(),
            3,
            "the replacement takes the tool node's position"
        );
        assert_ne!(surface.nodes[2], tool_seq);
        assert_eq!(surface.replace_generation, 1);
        assert!(
            texts(&store, &handle)
                .iter()
                .any(|text| text.contains("pruned")),
            "the model is sent the marker"
        );

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn the_service_compacts_a_real_store_session_and_the_log_keeps_the_span() {
        let (store, handle, root) = session();
        append_message(&store, &handle, text_message(Role::System, "be brief"));
        append_message(&store, &handle, text_message(Role::User, "u".repeat(1500)));
        append_message(
            &store,
            &handle,
            text_message(Role::Assistant, "a".repeat(1500)),
        );
        append_message(&store, &handle, text_message(Role::User, "q".repeat(1500)));

        let store = Arc::new(store);
        let service = service(
            store.clone(),
            900,
            Some(Arc::new(ScriptedModel {
                summary: "the briefing".to_string(),
            })),
            &root,
        );
        let report = block_on(service.prepare(
            &handle,
            &PrepareOptions {
                cwd: &root,
                endpoint: "local",
                model: None,
                tools: &[],
                system: None,
                summarizer: None,
                force: false,
            },
        ))
        .expect("the preparation succeeds");
        assert!(report.compacted, "the run compacted");
        assert!(report.estimated_tokens > 0);

        let events = ContextStore::read(store.as_ref(), &handle).expect("the log reads");
        let kinds: Vec<&str> = events.iter().map(|event| event.kind.as_str()).collect();
        for expected in [
            "compaction/start",
            "compaction/summary",
            "context/note",
            "compaction/end",
            "compaction/measured",
        ] {
            assert!(kinds.contains(&expected), "missing {expected}");
        }
        assert!(
            events.iter().any(|event| event.kind == "message"
                && event
                    .message()
                    .map(|message| serde_json::to_string(&message)
                        .unwrap_or_default()
                        .contains("uuuu"))
                    .unwrap_or(false)),
            "the shadowed span is still readable in the log"
        );
        let derived = texts(store.as_ref(), &handle);
        assert_eq!(
            derived
                .iter()
                .filter(|text| text.contains("<compacted-summary>"))
                .count(),
            1,
            "the checkpoint is read exactly once"
        );
        assert!(!derived.iter().any(|text| text.contains("uuuu")));
        assert!(!derived.iter().any(|text| text.contains("aaaa")));
        assert!(
            derived.iter().any(|text| text.contains("qqqq")),
            "the newest message is kept verbatim beside the checkpoint"
        );

        let _ = std::fs::remove_dir_all(root);
    }

    /// The log as the TypeScript oracle records it, less `session/created` (whose fields carry a
    /// temporary path and each store's own metadata).
    fn recorded(store: &SessionStore, handle: &SessionHandle) -> Vec<serde_json::Value> {
        ContextStore::read(store, handle)
            .expect("the log reads")
            .into_iter()
            .skip(1)
            .map(|event| {
                let mut object = serde_json::Map::new();
                object.insert("seq".to_string(), json!(event.seq));
                object.insert("type".to_string(), json!(event.kind));
                object.extend(event.fields);
                serde_json::Value::Object(object)
            })
            .collect()
    }

    fn oracle(name: &str) -> serde_json::Value {
        let all: serde_json::Value =
            serde_json::from_str(include_str!("../tests/fixtures/engine-oracle.json"))
                .expect("the oracle is JSON");
        all["scenarios"][name].clone()
    }

    #[test]
    fn the_real_store_and_the_engine_write_what_the_typescript_build_writes() {
        use crate::budget::{BudgetInput, resolve_budget};
        use crate::compaction::{CompactOptions, CompactionEngine};
        use crate::meter::{Measurement, MeterInput, MeteredMessage, TokenMeter};

        let expected = oracle("landed");
        let (store, handle, root) = session();
        append_message(&store, &handle, text_message(Role::System, "be brief"));
        append_message(&store, &handle, text_message(Role::User, "u".repeat(600)));
        append_message(
            &store,
            &handle,
            text_message(Role::Assistant, "a".repeat(600)),
        );

        let measure = || {
            let surface = ContextStore::derive_surface(&store, &handle).expect("the surface");
            let nodes: Vec<MeteredMessage<'_>> = surface
                .iter()
                .filter_map(|node| {
                    node.message.as_ref().map(|message| MeteredMessage {
                        seq: node.seq,
                        message,
                    })
                })
                .collect();
            let generation = ContextStore::surface(&store, &handle)
                .expect("the surface folds")
                .content_generation;
            TokenMeter.measure(&MeterInput {
                nodes: &nodes,
                tools: &[],
                usage: None,
                generation,
            })
        };
        let budget = resolve_budget(&BudgetInput {
            config_window: Some(10_000),
            ..BudgetInput::default()
        })
        .expect("the budget resolves");
        let measurement = measure();
        let engine = CompactionEngine::default();
        let plan = engine
            .plan(&store, &handle, &budget, &measurement, Some(0))
            .expect("the plan resolves")
            .expect("a plan is chosen");
        let summarizer = |_messages: Vec<Message>| async move {
            Ok::<String, SummarizeError>("  the briefing \n".to_string())
        };
        let measure_fn = || Ok::<Measurement, crate::ContextError>(measure());
        let outcome = block_on(engine.compact(
            &store,
            &handle,
            &plan,
            &CompactOptions {
                budget,
                measurement: &measurement,
                summarizer: &summarizer,
                measure: &measure_fn,
                force: false,
            },
        ))
        .expect("the compaction lands");

        let want: Vec<serde_json::Value> = expected["events"]
            .as_array()
            .expect("the oracle has events")
            .iter()
            .skip(1)
            .cloned()
            .collect();
        let got = recorded(&store, &handle);
        for (index, (want, got)) in want.iter().zip(&got).enumerate() {
            assert_eq!(
                got,
                want,
                "event {} differs from the TypeScript build's",
                index + 1
            );
        }
        assert_eq!(got.len(), want.len(), "a different number of events");
        assert_eq!(
            serde_json::to_value(&outcome).expect("serialises"),
            expected["outcome"]
        );
        assert_eq!(
            json!(
                ContextStore::surface(&store, &handle)
                    .expect("the surface")
                    .nodes
            ),
            expected["surface"]
        );

        let _ = std::fs::remove_dir_all(root);
    }
}
