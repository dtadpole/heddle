//! Token metering: what a request costs, and which number to believe.
//!
//! A port of `src/context/meter.ts`, itself a port of DSH's `dsh-token-meter` estimate:
//!
//! - **The estimate is deterministic and deliberately low** — four characters per token plus fixed
//!   per-block and per-role overhead. Deterministic is what lets it be a budget trigger; a lower
//!   bound is what makes a provider number below it meaningless.
//! - **Provider usage is a cross-check, never a correction downwards.** It is adopted only for the
//!   same envelope (the surface's content generation is unchanged) and only when it is no lower
//!   than the estimate.
//! - **Route pricing and the heuristic are two fields.** Nothing is route-priced yet, so they agree.
//!
//! Characters are JavaScript characters — UTF-16 code units — so an estimate equals the
//! TypeScript build's for the same request.

use serde::Serialize;

use crate::text::utf16_len;
use crate::types::{ContentPart, Message, Role, ToolSpec};

/// Four characters per token, the density DSH's fixed estimate assumes.
pub const CHARS_PER_TOKEN: u64 = 4;
/// Fixed cost of one content block: JSON framing and the type tag.
pub const BLOCK_OVERHEAD: u64 = 4;
/// Fixed cost of one message's role framing.
pub const ROLE_OVERHEAD: u64 = 4;

/// `value.div_ceil(CHARS_PER_TOKEN)`, the token price of a character count.
fn ceil_div(value: u64, by: u64) -> u64 {
    value.div_ceil(by)
}

/// The length `JSON.stringify(value).length` reports: the UTF-16 units of the serialisation.
fn json_len(value: &(impl Serialize + ?Sized)) -> u64 {
    let text =
        serde_json::to_string(value).expect("a content part or tool schema serialises as JSON");
    utf16_len(&text) as u64
}

/// The token price of one JSON serialisation.
fn json_tokens(value: &(impl Serialize + ?Sized)) -> u64 {
    ceil_div(json_len(value), CHARS_PER_TOKEN)
}

/// Price one content part.
///
/// Text and reasoning cost `ceil(len / 4) + 4`. A tool call is priced with **two** ceilings, one
/// over the name and one over the arguments, because the halves are framed separately on the wire.
/// Any other block is priced by its JSON serialisation, the honest floor.
pub fn estimate_part(part: &ContentPart) -> u64 {
    match part {
        ContentPart::Text { text } | ContentPart::Reasoning { text } => {
            ceil_div(utf16_len(text) as u64, CHARS_PER_TOKEN) + BLOCK_OVERHEAD
        }
        ContentPart::ToolCall(call) => {
            ceil_div(utf16_len(&call.name) as u64, CHARS_PER_TOKEN)
                + ceil_div(utf16_len(&call.arguments) as u64, CHARS_PER_TOKEN)
                + BLOCK_OVERHEAD
        }
        // A block this crate does not price specially is still priced rather than ignored:
        // its JSON structure is the honest floor.
        ContentPart::Image(_) | ContentPart::File(_) => BLOCK_OVERHEAD + json_tokens(part),
    }
}

/// Price a message's content, block by block, including per-block overhead.
pub fn estimate_content(parts: &[ContentPart]) -> u64 {
    parts.iter().map(estimate_part).sum()
}

/// Price one model-visible message.
///
/// A system message pays no per-block framing — an adapter renders the prompt as one string — and
/// an empty one prices zero; every other message is its content plus [`ROLE_OVERHEAD`].
pub fn estimate_message(message: &Message) -> u64 {
    if message.role == Role::System {
        if message.content.is_empty() {
            return 0;
        }
        let characters: u64 = message
            .content
            .iter()
            .map(|part| match part {
                ContentPart::Text { text } => utf16_len(text) as u64,
                other => json_len(other),
            })
            .sum();
        return ceil_div(characters, CHARS_PER_TOKEN) + ROLE_OVERHEAD;
    }
    estimate_content(&message.content) + ROLE_OVERHEAD
}

/// Price the tool schemas a request carries: one JSON serialisation plus one block of framing.
/// No tools prices zero.
pub fn estimate_tools(tools: &[ToolSpec]) -> u64 {
    if tools.is_empty() {
        return 0;
    }
    json_tokens(tools) + BLOCK_OVERHEAD
}

/// One priced surface node.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeterNode {
    /// The session event this node derives from.
    pub seq: u64,
    /// The price actually used, which is route-priced where a route prices.
    pub tokens: u64,
    /// The fixed-heuristic price, kept even when `tokens` disagrees with it.
    pub heuristic_tokens: u64,
}

/// Where a measurement's total came from.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum BaselineKind {
    /// The provider's usage for the same envelope, at or above the estimate.
    Usage,
    /// The deterministic estimate.
    Estimated,
    /// Nothing to price: no nodes and no tools.
    None,
}

/// The baseline a total rests on.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct Baseline {
    /// Where it came from.
    pub kind: BaselineKind,
    /// Its value.
    pub tokens: u64,
}

/// One coherent snapshot of a surface's cost.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Measurement {
    /// The number to budget against: the adopted baseline, never below the estimate.
    pub total_tokens: u64,
    /// Where `total_tokens` came from.
    pub baseline: Baseline,
    /// The surface in order, each node priced.
    pub nodes: Vec<MeterNode>,
    /// The part of the estimate that is system prompts.
    pub system_tokens: u64,
    /// The part of the estimate that is the tool schemas.
    pub tools_tokens: u64,
    /// The part of the estimate that is every other message.
    pub message_tokens: u64,
}

/// A provider's usage for the last call, with the surface generation its request was built at.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct UsageAnchor {
    /// Input tokens the provider reported.
    pub input_tokens: Option<u64>,
    /// Output tokens the provider reported.
    pub output_tokens: Option<u64>,
    /// The `generation` the `model/request` event recorded.
    pub generation: u64,
}

/// One surface node to price: its seq and the message it derives to.
#[derive(Clone, Copy, Debug)]
pub struct MeteredMessage<'a> {
    /// The node's seq.
    pub seq: u64,
    /// Its message.
    pub message: &'a Message,
}

/// What to measure: the surface, its tools, and any usage for the same envelope.
#[derive(Clone, Copy, Debug)]
pub struct MeterInput<'a> {
    /// The surface in order; nodes that derive to no message are left out by the caller.
    pub nodes: &'a [MeteredMessage<'a>],
    /// The tool schemas the request offers.
    pub tools: &'a [ToolSpec],
    /// The last call's usage, when there is one.
    pub usage: Option<UsageAnchor>,
    /// The surface's current content generation.
    pub generation: u64,
}

/// The meter. A plain value: `measure` is a pure function of its input.
#[derive(Clone, Copy, Debug, Default)]
pub struct TokenMeter;

impl TokenMeter {
    /// Measure one surface, choosing the baseline the total rests on.
    pub fn measure(&self, input: &MeterInput<'_>) -> Measurement {
        let mut nodes = Vec::with_capacity(input.nodes.len());
        let mut system_tokens = 0;
        let mut message_tokens = 0;
        for node in input.nodes {
            let heuristic_tokens = estimate_message(node.message);
            // Route pricing does not exist here yet, so the used price is the estimate; the
            // fields stay apart because a future adapter must be able to price a node without
            // this interface moving.
            nodes.push(MeterNode {
                seq: node.seq,
                tokens: heuristic_tokens,
                heuristic_tokens,
            });
            if node.message.role == Role::System {
                system_tokens += heuristic_tokens;
            } else {
                message_tokens += heuristic_tokens;
            }
        }
        let tools_tokens = estimate_tools(input.tools);
        let estimated_total = system_tokens + message_tokens + tools_tokens;

        // Usage is reused only for the same envelope: the generation must match, so nothing has
        // been added or replaced since the call it reports on. And it must be no lower than the
        // estimate — a provider total below a deterministic lower bound is either a different
        // envelope or a bad report, and adopting it would hide pressure exactly when the surface
        // is over budget.
        if let Some(usage) = input.usage
            && usage.generation == input.generation
        {
            let usage_total = usage.input_tokens.unwrap_or(0) + usage.output_tokens.unwrap_or(0);
            if usage_total >= estimated_total {
                return Measurement {
                    total_tokens: usage_total,
                    baseline: Baseline {
                        kind: BaselineKind::Usage,
                        tokens: usage_total,
                    },
                    nodes,
                    system_tokens,
                    tools_tokens,
                    message_tokens,
                };
            }
        }

        // Nothing to price and no usable usage is the one case with no number at all, which is
        // what lets a caller distinguish "empty request" from "cheap request".
        if input.nodes.is_empty() && input.tools.is_empty() {
            return Measurement {
                total_tokens: 0,
                baseline: Baseline {
                    kind: BaselineKind::None,
                    tokens: 0,
                },
                nodes,
                system_tokens,
                tools_tokens,
                message_tokens,
            };
        }

        Measurement {
            total_tokens: estimated_total,
            baseline: Baseline {
                kind: BaselineKind::Estimated,
                tokens: estimated_total,
            },
            nodes,
            system_tokens,
            tools_tokens,
            message_tokens,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        BLOCK_OVERHEAD, BaselineKind, CHARS_PER_TOKEN, MeterInput, MeteredMessage, ROLE_OVERHEAD,
        TokenMeter, UsageAnchor, estimate_message, estimate_part, estimate_tools,
    };
    use crate::types::{
        ContentPart, FilePart, ImageMediaType, ImagePart, Message, Role, ToolCall, ToolSpec,
        text_message,
    };
    use serde_json::json;

    /// One user message carrying a single text block, which is what most cases need.
    fn user_message(text: &str) -> Message {
        text_message(Role::User, text)
    }

    /// The one tool schema the pricing cases share, whose serialisation is 76 characters.
    fn tool() -> ToolSpec {
        ToolSpec {
            name: "read".to_string(),
            description: "Read a file".to_string(),
            parameters: json!({ "type": "object" }),
        }
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
    fn a_tool_call_is_priced_with_two_ceilings_not_one_over_the_concatenation() {
        let part = ContentPart::ToolCall(ToolCall {
            id: "call-1".to_string(),
            name: "ab".to_string(),
            arguments: "cd".to_string(),
        });
        assert_eq!(estimate_part(&part), 1 + 1 + BLOCK_OVERHEAD);
        // The four concatenated characters round to one token, so the naive price is a token
        // cheaper — this is the difference the two ceilings exist to keep.
        assert_ne!(estimate_part(&part), 1 + BLOCK_OVERHEAD);
    }

    #[test]
    fn a_block_with_no_special_price_is_priced_by_its_json_structure() {
        // The price is the serialisation plus framing, exactly as JSON.stringify would count it.
        let part = image();
        let serialised = serde_json::to_string(&part).expect("an image part serialises");
        assert_eq!(serialised.len(), 98);
        assert_eq!(
            estimate_part(&part),
            BLOCK_OVERHEAD + ((serialised.len() as u64).div_ceil(CHARS_PER_TOKEN))
        );
    }

    #[test]
    fn a_file_part_is_priced_by_its_json_like_an_image() {
        let part = ContentPart::File(FilePart {
            name: "b.txt".to_string(),
            path: "/tmp/b.txt".to_string(),
            bytes: 2,
            sha256: "00".to_string(),
        });
        assert_eq!(
            estimate_part(&part),
            BLOCK_OVERHEAD
                + ((serde_json::to_string(&part)
                    .expect("a file part serialises")
                    .len() as u64)
                    .div_ceil(CHARS_PER_TOKEN))
        );
    }

    #[test]
    fn an_empty_system_message_prices_zero_while_an_empty_user_message_prices_its_role() {
        let system = Message {
            role: Role::System,
            content: Vec::new(),
            tool_call_id: None,
            source: None,
        };
        assert_eq!(estimate_message(&system), 0);
        let empty_user = Message {
            role: Role::User,
            content: Vec::new(),
            tool_call_id: None,
            source: None,
        };
        assert_eq!(estimate_message(&empty_user), ROLE_OVERHEAD);
    }

    #[test]
    fn a_system_message_pays_no_per_block_overhead_and_a_user_message_does() {
        let text = "a".repeat(40);
        let system = text_message(Role::System, text.clone());
        assert_eq!(estimate_message(&system), 10 + ROLE_OVERHEAD);
        assert_eq!(
            estimate_message(&user_message(&text)),
            10 + BLOCK_OVERHEAD + ROLE_OVERHEAD
        );
    }

    #[test]
    fn a_system_message_counts_a_non_text_block_by_its_json() {
        let part = image();
        let system = Message {
            role: Role::System,
            content: vec![
                ContentPart::Text {
                    text: "abc".to_string(),
                },
                part.clone(),
            ],
            tool_call_id: None,
            source: None,
        };
        let characters = 3 + serde_json::to_string(&part)
            .expect("an image part serialises")
            .len() as u64;
        assert_eq!(
            estimate_message(&system),
            characters.div_ceil(CHARS_PER_TOKEN) + ROLE_OVERHEAD
        );
    }

    #[test]
    fn tools_price_zero_when_absent_or_empty_and_the_schema_otherwise() {
        assert_eq!(estimate_tools(&[]), 0);
        assert_eq!(
            serde_json::to_string(&[tool()])
                .expect("a tool schema serialises")
                .len(),
            76
        );
        assert_eq!(estimate_tools(&[tool()]), 19 + BLOCK_OVERHEAD);
    }

    #[test]
    fn pricing_counts_utf16_units_so_it_agrees_with_the_typescript_build() {
        // An emoji outside the BMP is two JavaScript characters, so it rounds to one token; in
        // bytes or Rust characters it would price differently.
        assert_eq!(
            estimate_part(&ContentPart::Text {
                text: "😀".to_string()
            }),
            1 + BLOCK_OVERHEAD
        );
        assert_eq!(
            estimate_part(&ContentPart::Text {
                text: "abcdefgh😀".to_string()
            }),
            3 + BLOCK_OVERHEAD
        );
    }

    #[test]
    fn usage_below_the_estimate_is_ignored_while_usage_at_or_above_it_is_adopted() {
        let meter = TokenMeter;
        let message = user_message("hello world");
        // Three tokens of text, one block of framing, one role of framing.
        let estimated = estimate_message(&message);
        assert_eq!(estimated, 3 + BLOCK_OVERHEAD + ROLE_OVERHEAD);

        let below = meter.measure(&MeterInput {
            nodes: &[MeteredMessage {
                seq: 1,
                message: &message,
            }],
            tools: &[],
            usage: Some(UsageAnchor {
                input_tokens: Some(3),
                output_tokens: Some(4),
                generation: 1,
            }),
            generation: 1,
        });
        assert_eq!(below.baseline.kind, BaselineKind::Estimated);
        assert_eq!(below.baseline.tokens, estimated);
        assert_eq!(below.total_tokens, estimated);

        let equal = meter.measure(&MeterInput {
            nodes: &[MeteredMessage {
                seq: 1,
                message: &message,
            }],
            tools: &[],
            usage: Some(UsageAnchor {
                input_tokens: Some(5),
                output_tokens: Some(6),
                generation: 1,
            }),
            generation: 1,
        });
        assert_eq!(equal.baseline.kind, BaselineKind::Usage);
        assert_eq!(equal.total_tokens, estimated);

        let above = meter.measure(&MeterInput {
            nodes: &[MeteredMessage {
                seq: 1,
                message: &message,
            }],
            tools: &[],
            usage: Some(UsageAnchor {
                input_tokens: Some(100),
                output_tokens: Some(50),
                generation: 1,
            }),
            generation: 1,
        });
        assert_eq!(above.baseline.kind, BaselineKind::Usage);
        assert_eq!(above.total_tokens, 150);
    }

    #[test]
    fn usage_from_a_different_surface_generation_is_ignored() {
        let message = user_message("hello world");
        let measurement = TokenMeter.measure(&MeterInput {
            nodes: &[MeteredMessage {
                seq: 1,
                message: &message,
            }],
            tools: &[],
            usage: Some(UsageAnchor {
                input_tokens: Some(100),
                output_tokens: Some(50),
                generation: 1,
            }),
            generation: 2,
        });
        assert_eq!(measurement.baseline.kind, BaselineKind::Estimated);
        assert_eq!(measurement.total_tokens, estimate_message(&message));
    }

    #[test]
    fn measure_splits_the_surface_into_system_message_and_tool_prices() {
        let system = text_message(Role::System, "you are a harness");
        let message = user_message("hello world");
        let measurement = TokenMeter.measure(&MeterInput {
            nodes: &[
                MeteredMessage {
                    seq: 1,
                    message: &system,
                },
                MeteredMessage {
                    seq: 2,
                    message: &message,
                },
            ],
            tools: &[tool()],
            usage: None,
            generation: 0,
        });

        assert_eq!(
            measurement
                .nodes
                .iter()
                .map(|node| node.seq)
                .collect::<Vec<_>>(),
            vec![1, 2]
        );
        // No route pricing exists yet, so the used price and the heuristic agree.
        for node in &measurement.nodes {
            assert_eq!(node.tokens, node.heuristic_tokens);
        }
        assert_eq!(measurement.system_tokens, estimate_message(&system));
        assert_eq!(measurement.message_tokens, estimate_message(&message));
        assert_eq!(measurement.tools_tokens, estimate_tools(&[tool()]));
        assert_eq!(measurement.baseline.kind, BaselineKind::Estimated);
        assert_eq!(
            measurement.total_tokens,
            measurement.system_tokens + measurement.message_tokens + measurement.tools_tokens
        );
    }

    #[test]
    fn a_session_with_no_nodes_no_tools_and_no_usage_reports_nothing_to_measure() {
        let measurement = TokenMeter.measure(&MeterInput {
            nodes: &[],
            tools: &[],
            usage: None,
            generation: 0,
        });
        assert_eq!(measurement.baseline.kind, BaselineKind::None);
        assert_eq!(measurement.baseline.tokens, 0);
        assert_eq!(measurement.total_tokens, 0);
        assert!(measurement.nodes.is_empty());
        assert_eq!(
            measurement.system_tokens + measurement.message_tokens + measurement.tools_tokens,
            0
        );
    }

    #[test]
    fn tools_alone_are_enough_to_make_the_baseline_an_estimate() {
        let measurement = TokenMeter.measure(&MeterInput {
            nodes: &[],
            tools: &[tool()],
            usage: None,
            generation: 3,
        });
        assert_eq!(measurement.baseline.kind, BaselineKind::Estimated);
        assert_eq!(measurement.baseline.tokens, measurement.tools_tokens);
        assert_eq!(measurement.total_tokens, measurement.tools_tokens);
    }
}
