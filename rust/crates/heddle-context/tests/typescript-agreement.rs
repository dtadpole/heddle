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
use std::path::{Path, PathBuf};

use heddle_context::instructions::{
    INSTRUCTIONS_MAX_BYTES, InstructionFile, instruction_digest,
    render_instruction_baseline_with_home,
};
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

fn instruction(path: &str, text: &str) -> InstructionFile {
    InstructionFile {
        path: PathBuf::from(path),
        text: text.to_string(),
    }
}

/// `renderInstructionBaseline` under Node with `HOME=/home/u`. The identity is what a session
/// compares to decide whether to re-send the baseline, so a session one build wrote is recognised by
/// the other only if the rendered text is the same to the byte.
#[test]
fn an_instruction_baseline_renders_to_the_typescript_builds_identity() {
    let home = Some(Path::new("/home/u"));

    // A cut inside a two-byte character: Node decodes the partial byte as one U+FFFD.
    let cut = render_instruction_baseline_with_home(
        &[instruction("/p/AGENTS.md", &"é".repeat(300))],
        401,
        home,
    );
    assert_eq!(cut.identity, "ba57a66c1a715c02ff665db9d4390b965c9b9631");
    assert_eq!(cut.text.encode_utf16().count(), 336);

    // A cut inside a four-byte character: one U+FFFD as well.
    let emoji = render_instruction_baseline_with_home(
        &[instruction("/p/AGENTS.md", &"😀".repeat(100))],
        402,
        home,
    );
    assert_eq!(emoji.identity, "87ee0dbfc6f164cfec92f7b5bcc5c029b2a0840e");

    // Two files dropped whole, broadest first, the nearest cut, paths under home shown with `~`.
    let dropped = render_instruction_baseline_with_home(
        &[
            instruction(
                "/home/u/.heddle/AGENTS.md",
                &format!("global {}", "x".repeat(300)),
            ),
            instruction("/home/u/proj/AGENTS.md", "root rules\n"),
            instruction(
                "/home/u/proj/sub/AGENTS.md",
                &format!("narrow {}", "ü".repeat(200)),
            ),
        ],
        600,
        home,
    );
    assert_eq!(dropped.identity, "601e6d6ce33c88d4c424712f16de2e514bfc49b9");
    assert_eq!(
        dropped.omitted,
        vec![
            PathBuf::from("/home/u/.heddle/AGENTS.md"),
            PathBuf::from("/home/u/proj/AGENTS.md"),
        ]
    );
    assert!(dropped.truncated);
    assert_eq!(dropped.text.encode_utf16().count(), 501);

    // Nothing dropped: the guidance notice, each body trimmed the JavaScript way (U+FEFF included).
    let whole = render_instruction_baseline_with_home(
        &[
            instruction("/home/u/.heddle/AGENTS.md", "  global rules  \n"),
            instruction("/elsewhere/AGENTS.md", "\u{FEFF}outside rules"),
        ],
        INSTRUCTIONS_MAX_BYTES,
        home,
    );
    assert_eq!(whole.identity, "464f7234a15376b84069162c4825febe0c78a4de");
    assert!(!whole.truncated);
    assert_eq!(whole.text.encode_utf16().count(), 341);
}
