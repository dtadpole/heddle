//! #157: a request that names no reasoning effort runs at its model's declared default, as DSH's dsh-llm
//! `resolveCallWithInfo` does, and is marked as a default. A model with levels but no default sends nothing.

use heddle_config::EndpointConfig;
use heddle_llm::{GenerateRequest, with_default_effort};

fn endpoint() -> EndpointConfig {
    let levels = serde_json::json!([
        { "id": "low", "name": "Low", "value": "low" },
        { "id": "high", "name": "High", "value": "high" },
        { "id": "xhigh", "name": "XHigh", "value": "xhigh" }
    ]);
    serde_json::from_value(serde_json::json!({
        "name": "claude",
        "kind": "anthropic-messages",
        "baseUrl": "http://127.0.0.1:9/v1",
        "model": "opus",
        "models": [
            { "id": "opus", "reasoning": { "default": "xhigh", "levels": levels } },
            { "id": "sonnet", "reasoning": { "levels": levels } }
        ]
    }))
    .expect("an endpoint")
}

fn ask(model: Option<&str>, effort: Option<&str>) -> GenerateRequest {
    GenerateRequest {
        endpoint: "claude".into(),
        model: model.map(str::to_owned),
        reasoning_effort: effort.map(str::to_owned),
        ..GenerateRequest::default()
    }
}

#[test]
fn a_request_with_no_effort_takes_the_model_default_and_is_marked_as_one() {
    let endpoint = endpoint();
    let resolved = with_default_effort(Some(&endpoint), ask(None, None));
    assert_eq!(resolved.reasoning_effort.as_deref(), Some("xhigh"));
    assert_eq!(resolved.reasoning_effort_default, Some(true));
    let empty = with_default_effort(Some(&endpoint), ask(Some("opus"), Some("")));
    assert_eq!(
        empty.reasoning_effort.as_deref(),
        Some("xhigh"),
        "an empty level is none"
    );
    let wire = serde_json::to_value(&resolved).unwrap();
    assert_eq!(
        wire["reasoningEffortDefault"],
        serde_json::json!(true),
        "recorded as a default"
    );
}

#[test]
fn a_named_effort_is_the_requests_own_and_a_model_without_a_default_sends_nothing() {
    let endpoint = endpoint();
    assert_eq!(
        with_default_effort(Some(&endpoint), ask(None, Some("low"))),
        ask(None, Some("low"))
    );
    assert_eq!(
        with_default_effort(Some(&endpoint), ask(Some("sonnet"), None)),
        ask(Some("sonnet"), None)
    );
    assert_eq!(with_default_effort(None, ask(None, None)), ask(None, None));
    let plain = serde_json::to_value(ask(None, Some("low"))).unwrap();
    assert!(
        plain.get("reasoningEffortDefault").is_none(),
        "absent unless defaulted"
    );
}
