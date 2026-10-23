//! The store double and the context engine, replayed against what the TypeScript build wrote.
//!
//! `fixtures/engine-oracle.json` is the TypeScript build's own record of four scenarios — the
//! verifier's aimed cut and refused summary, a landed compaction, a second compaction over
//! out-of-order seqs, and a pruning that clears the pressure — produced by
//! `fixtures/generate-engine-oracle.mjs` running `src/session/store.ts` and `src/context/` under Node.
//! Each test feeds the Rust build the same inputs and compares every event (less the clock), the
//! surface, both generations, the messages a request carries, the plan and the outcome.
//!
//! The comparison is on JSON values, so it is about fields and numbers, not key order; key order is
//! the session store's contract and is judged there.

use std::sync::atomic::{AtomicU32, Ordering};

use futures::executor::block_on;
use heddle_context::ContextError;
use heddle_context::budget::{Budget, BudgetInput, resolve_budget};
use heddle_context::compaction::{CompactOptions, CompactionEngine, SummarizeError};
use heddle_context::meter::{Measurement, MeterInput, MeteredMessage, TokenMeter};
use heddle_context::store::{AppendOptions, ContextStore};
use heddle_context::testing::{MemorySession, MemoryStore};
use heddle_context::types::{ContentPart, Message, Role};
use serde_json::{Map, Value, json};

/// One scenario of the oracle.
fn oracle(name: &str) -> Value {
    let all: Value = serde_json::from_str(include_str!("fixtures/engine-oracle.json"))
        .expect("the oracle is JSON");
    all["scenarios"][name].clone()
}

/// A store whose first event is the TypeScript store's `session/created`, so seqs line up.
fn session() -> (MemoryStore, MemorySession) {
    let store = MemoryStore::new();
    let session = store.open("oracle");
    store
        .append(
            &session,
            json!({"type": "session/created"}),
            AppendOptions::default(),
        )
        .expect("the opening event appends");
    (store, session)
}

fn text(role: Role, body: impl Into<String>) -> Message {
    Message::new(role, vec![ContentPart::Text { text: body.into() }])
}

fn measure(store: &MemoryStore, session: &MemorySession) -> Measurement {
    let surface = store.derive_surface(session).expect("the surface derives");
    let nodes: Vec<MeteredMessage<'_>> = surface
        .iter()
        .filter_map(|node| {
            node.message.as_ref().map(|message| MeteredMessage {
                seq: node.seq,
                message,
            })
        })
        .collect();
    let generation = store
        .surface(session)
        .expect("the surface folds")
        .content_generation;
    TokenMeter.measure(&MeterInput {
        nodes: &nodes,
        tools: &[],
        usage: None,
        generation,
    })
}

fn budget(window: u64) -> Budget {
    resolve_budget(&BudgetInput {
        config_window: Some(window),
        ..BudgetInput::default()
    })
    .expect("a configured window resolves")
}

/// The log as the oracle records it: each event as one object, `seq` and `type` first.
fn events(store: &MemoryStore, session: &MemorySession) -> Value {
    let log = store.read(session).expect("the log reads");
    Value::Array(
        log.into_iter()
            .map(|event| {
                let mut object = Map::new();
                object.insert("seq".to_string(), Value::from(event.seq));
                object.insert("type".to_string(), Value::String(event.kind));
                object.extend(event.fields);
                Value::Object(object)
            })
            .collect(),
    )
}

/// Every recorded fact of a scenario, compared one by one so a failure names the fact.
fn assert_agrees(expected: &Value, store: &MemoryStore, session: &MemorySession) {
    let actual = events(store, session);
    let expected_events = expected["events"]
        .as_array()
        .expect("the oracle has events");
    let actual_events = actual.as_array().expect("events are an array");
    for (index, (want, got)) in expected_events.iter().zip(actual_events).enumerate() {
        assert_eq!(
            got, want,
            "event {index} differs from the TypeScript build's"
        );
    }
    assert_eq!(
        actual_events.len(),
        expected_events.len(),
        "the two builds appended a different number of events"
    );

    let surface = store.surface(session).expect("the surface folds");
    assert_eq!(json!(surface.nodes), expected["surface"], "the surface");
    assert_eq!(
        json!(surface.content_generation),
        expected["contentGeneration"],
        "the content generation"
    );
    assert_eq!(
        json!(surface.replace_generation),
        expected["replaceGeneration"],
        "the replace generation"
    );
    let messages = store.derive_messages(session).expect("the messages derive");
    assert_eq!(
        serde_json::to_value(&messages).expect("messages serialise"),
        expected["messages"],
        "the messages a request carries"
    );
}

#[test]
fn the_aimed_cut_and_the_refused_summary_agree_with_the_typescript_build() {
    let expected = oracle("refusedAimedCut");
    let (store, session) = session();
    store.message(&session, text(Role::System, "be brief"));
    store.message(&session, text(Role::User, "do the thing"));
    store.assistant_chunk(
        &session,
        json!({"type": "tool-call", "id": "call-1", "name": "read_file", "arguments": "{\"path\":\"a\"}"}),
    );
    store.assistant_chunk(
        &session,
        json!({"type": "done", "finishReason": "tool_calls"}),
    );
    let mut tool = text(Role::Tool, "the result");
    tool.tool_call_id = Some("call-1".to_string());
    store.message(&session, tool);
    store.message(&session, text(Role::User, "and again"));
    store.message(&session, text(Role::Assistant, "done"));

    let measurement = measure(&store, &session);
    assert_eq!(
        serde_json::to_value(&measurement).expect("serialises"),
        expected["measurement"],
        "the measurement"
    );
    let retain = expected["retainTokens"].as_u64().expect("the aimed tail");
    let engine = CompactionEngine::default();
    let plan = engine
        .plan(
            &store,
            &session,
            &budget(10_000),
            &measurement,
            Some(retain),
        )
        .expect("the plan resolves")
        .expect("a plan is chosen");
    assert_eq!(
        serde_json::to_value(&plan).expect("serialises"),
        expected["plan"],
        "the plan"
    );

    let summarizer =
        |_messages: Vec<Message>| async move { Ok::<String, SummarizeError>("z".repeat(20_000)) };
    let unchanged = measurement.clone();
    let measure_fn = move || Ok::<Measurement, ContextError>(unchanged.clone());
    let outcome = block_on(engine.compact(
        &store,
        &session,
        &plan,
        &CompactOptions {
            budget: budget(10_000),
            measurement: &measurement,
            summarizer: &summarizer,
            measure: &measure_fn,
            force: false,
        },
    ))
    .expect("a refusal is a result");
    assert_eq!(
        serde_json::to_value(&outcome).expect("serialises"),
        expected["outcome"],
        "the outcome, including the refusal's exact reason"
    );
    assert_agrees(&expected, &store, &session);
}

#[test]
fn a_landed_compaction_writes_what_the_typescript_build_writes() {
    let expected = oracle("landed");
    let (store, session) = session();
    store.message(&session, text(Role::System, "be brief"));
    store.message(&session, text(Role::User, "u".repeat(600)));
    store.message(&session, text(Role::Assistant, "a".repeat(600)));

    let measurement = measure(&store, &session);
    assert_eq!(
        serde_json::to_value(&measurement).expect("serialises"),
        expected["measurement"],
        "the measurement"
    );
    let engine = CompactionEngine::default();
    let plan = engine
        .plan(&store, &session, &budget(10_000), &measurement, Some(0))
        .expect("the plan resolves")
        .expect("a plan is chosen");
    assert_eq!(
        serde_json::to_value(&plan).expect("serialises"),
        expected["plan"],
        "the plan"
    );

    let summarizer = |_messages: Vec<Message>| async move {
        Ok::<String, SummarizeError>("  the briefing \n".to_string())
    };
    let measure_fn = || Ok::<Measurement, ContextError>(measure(&store, &session));
    let outcome = block_on(engine.compact(
        &store,
        &session,
        &plan,
        &CompactOptions {
            budget: budget(10_000),
            measurement: &measurement,
            summarizer: &summarizer,
            measure: &measure_fn,
            force: false,
        },
    ))
    .expect("the compaction lands");
    assert_eq!(
        serde_json::to_value(&outcome).expect("serialises"),
        expected["outcome"],
        "the outcome"
    );
    assert_agrees(&expected, &store, &session);
}

#[test]
fn a_second_compaction_over_out_of_order_seqs_agrees() {
    let expected = oracle("repeated");
    let (store, session) = session();
    store.message(&session, text(Role::System, "be brief"));
    store.message(&session, text(Role::User, "u".repeat(600)));
    store.message(&session, text(Role::User, "v".repeat(600)));
    let engine = CompactionEngine::default();
    let summarizer =
        |_messages: Vec<Message>| async move { Ok::<String, SummarizeError>("brief".to_string()) };
    let measure_fn = || Ok::<Measurement, ContextError>(measure(&store, &session));

    let first = measure(&store, &session);
    let plan = engine
        .plan(&store, &session, &budget(10_000), &first, Some(0))
        .expect("the plan resolves")
        .expect("a plan is chosen");
    block_on(engine.compact(
        &store,
        &session,
        &plan,
        &CompactOptions {
            budget: budget(10_000),
            measurement: &first,
            summarizer: &summarizer,
            measure: &measure_fn,
            force: false,
        },
    ))
    .expect("the first compaction lands");
    store.message(&session, text(Role::User, "after"));

    let second = measure(&store, &session);
    let plan = engine
        .plan(&store, &session, &budget(10_000), &second, Some(0))
        .expect("the plan resolves")
        .expect("a plan is chosen");
    assert_eq!(
        serde_json::to_value(&plan).expect("serialises"),
        expected["plan"],
        "the plan"
    );
    let outcome = block_on(engine.compact(
        &store,
        &session,
        &plan,
        &CompactOptions {
            budget: budget(10_000),
            measurement: &second,
            summarizer: &summarizer,
            measure: &measure_fn,
            force: false,
        },
    ))
    .expect("the second compaction lands");
    assert_eq!(
        serde_json::to_value(&outcome).expect("serialises"),
        expected["outcome"],
        "the outcome"
    );
    assert_agrees(&expected, &store, &session);
}

#[test]
fn a_pruning_that_clears_the_pressure_agrees_and_asks_for_no_summary() {
    let expected = oracle("pruneClears");
    let (store, session) = session();
    store.message(&session, text(Role::System, "be brief"));
    store.message(&session, text(Role::User, "do the thing"));
    let mut tool = text(Role::Tool, "x".repeat(30_000));
    tool.tool_call_id = Some("call-1".to_string());
    store.message(&session, tool);

    let measurement = measure(&store, &session);
    let asked = AtomicU32::new(0);
    let summarizer = |_messages: Vec<Message>| {
        asked.fetch_add(1, Ordering::Relaxed);
        async move { Ok::<String, SummarizeError>("brief".to_string()) }
    };
    let measure_fn = || Ok::<Measurement, ContextError>(measure(&store, &session));
    let outcome = block_on(CompactionEngine::default().compact_if_needed(
        &store,
        &session,
        &CompactOptions {
            budget: budget(3000),
            measurement: &measurement,
            summarizer: &summarizer,
            measure: &measure_fn,
            force: false,
        },
    ))
    .expect("the round succeeds");
    assert_eq!(
        serde_json::to_value(&outcome).expect("serialises"),
        expected["outcome"],
        "the outcome"
    );
    assert_eq!(
        json!(asked.load(Ordering::Relaxed)),
        expected["asked"],
        "how often a summary was asked for"
    );
    assert_agrees(&expected, &store, &session);
}
