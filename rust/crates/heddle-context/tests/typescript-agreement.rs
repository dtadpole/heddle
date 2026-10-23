//! Numbers measured from the TypeScript build, so the two builds agree.
//!
//! The oracle was Node 24 running `src/context/` directly (`node --input-type=module -e '…'`), not a
//! rebuild of `dist/`; each value below is what it printed on 2026-10-22. They are pinned here rather
//! than only hand-computed because the contract is agreement: an estimate, a budget or a digest that
//! one build and not the other produces would price or recognise a session differently, which is
//! exactly what a verifier through `HEDDLE_BIN` cannot see.

use heddle_context::budget::{
    BudgetInput, BudgetPolicy, BudgetSource, EndpointPolicy, resolve_budget,
};
use heddle_context::instructions::instruction_digest;
use heddle_context::meter::{estimate_message, estimate_part, estimate_tools};
use heddle_context::prune::{PruneConfig, prune_text};
use heddle_context::types::{
    ContentPart, ImageMediaType, ImagePart, Message, Role, ToolCall, ToolSpec,
};
use serde_json::json;

fn text(role: Role, text: impl Into<String>) -> Message {
    Message::new(role, vec![ContentPart::Text { text: text.into() }])
}

fn image() -> ContentPart {
    ContentPart::Image(ImagePart {
        name: "a.png".to_string(),
        mime_type: ImageMediaType::Png,
        path: "/tmp/a.png".to_string(),
        bytes: 1,
        sha256: "00".to_string(),
        data: None,
    })
}

#[test]
fn a_tool_call_and_an_image_are_priced_as_the_typescript_build_prices_them() {
    // estimatePart({type:"tool-call", id:"call-1", name:"write_file",
    //   arguments: JSON.stringify({path:"a.txt", content:"😀".repeat(5)})}) === 17
    let call = ContentPart::ToolCall(ToolCall {
        id: "call-1".to_string(),
        name: "write_file".to_string(),
        arguments: "{\"path\":\"a.txt\",\"content\":\"😀😀😀😀😀\"}".to_string(),
    });
    assert_eq!(estimate_part(&call), 17);

    // estimatePart({type:"image", name:"a.png", mimeType:"image/png", path:"/tmp/a.png",
    //   bytes:1, sha256:"00"}) === 29
    assert_eq!(estimate_part(&image()), 29);
}

#[test]
fn a_system_message_with_an_attachment_and_a_message_of_emoji_agree() {
    // estimateMessage({role:"system", content:[{type:"text",text:"abc"}, image]}) === 30
    let system = Message::new(
        Role::System,
        vec![
            ContentPart::Text {
                text: "abc".to_string(),
            },
            image(),
        ],
    );
    assert_eq!(estimate_message(&system), 30);

    // estimateMessage({role:"user", content:[{type:"text", text:"😀".repeat(8)}]}) === 12
    assert_eq!(estimate_message(&text(Role::User, "😀".repeat(8))), 12);
}

#[test]
fn a_schema_with_a_non_ascii_description_agrees() {
    // estimateTools([{name:"read", description:"Liest eine Datei 😀", parameters:{type:"object"}}]) === 25
    let tools = [ToolSpec {
        name: "read".to_string(),
        description: "Liest eine Datei 😀".to_string(),
        parameters: json!({"type": "object"}),
    }];
    assert_eq!(estimate_tools(&tools), 25);
}

#[test]
fn the_budget_rounds_down_exactly_as_javascript_does() {
    // resolveBudget({endpoint:"x", endpointWindow:1023}) ->
    //   {contextWindow:1023, thresholdTokens:818, retainTokens:163, source:"endpoint"}
    let budget = resolve_budget(&BudgetInput {
        endpoint: Some("x"),
        endpoint_window: Some(1023),
        ..BudgetInput::default()
    })
    .expect("the budget resolves");
    assert_eq!(budget.context_window, 1023);
    assert_eq!(budget.threshold_tokens, 818);
    assert_eq!(budget.retain_tokens, 163);
    assert_eq!(budget.source, BudgetSource::Endpoint);

    // resolveBudget({endpoint:"a", endpointWindow:1000,
    //   configPolicy:{thresholdRatio:0.9, retainRatio:0.05},
    //   policies:[{endpoint:"a", thresholdRatio:0.5}]}) -> 500 and 50
    let budget = resolve_budget(&BudgetInput {
        endpoint: Some("a"),
        endpoint_window: Some(1000),
        config_policy: BudgetPolicy {
            threshold_ratio: Some(0.9),
            retain_ratio: Some(0.05),
            ..BudgetPolicy::default()
        },
        policies: &[EndpointPolicy {
            endpoint: "a".to_string(),
            policy: BudgetPolicy {
                threshold_ratio: Some(0.5),
                ..BudgetPolicy::default()
            },
        }],
        ..BudgetInput::default()
    })
    .expect("the budget resolves");
    assert_eq!(budget.threshold_tokens, 500);
    assert_eq!(budget.retain_tokens, 50);
}

#[test]
fn a_pruned_text_is_the_same_text_with_the_same_count_named() {
    // pruneText("a".repeat(9000)) -> text.length 5159, and the marker says 3880 removed
    let cut = prune_text(&"a".repeat(9000), &PruneConfig::default());
    assert!(cut.pruned);
    // `text.length` in JavaScript is UTF-16 units, and the marker's ellipsis is one of them.
    assert_eq!(cut.text.encode_utf16().count(), 5159);
    assert!(
        cut.text.contains("pruned, 3880 characters removed"),
        "{}",
        &cut.text[..80]
    );
}

#[test]
fn the_instruction_digest_ignores_the_byte_order_mark_and_keeps_the_next_line_character() {
    // instructionDigest("\uFEFFabc\uFEFF") === SHA-1("abc") === a9993e36…
    assert_eq!(
        instruction_digest("\u{FEFF}abc\u{FEFF}"),
        "a9993e364706816aba3e25717850c26c9cd0d89d"
    );
    // instructionDigest("\u0085abc") === 5ee0b283… (JavaScript's trim does not remove U+0085)
    assert_eq!(
        instruction_digest("\u{0085}abc"),
        "5ee0b2835a6f9cf80e4170f0b1f6f1a72d8d4827"
    );
}
